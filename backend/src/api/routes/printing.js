// Store Agent printing — agents, targets, the job queue and its truth rules.
// Mounted at /api/print-agents (agent+admin) and /api/print-jobs (staff).
//
// Delivery uncertainty is explicit and load-bearing:
//   QUEUED → DISPATCHED → CONFIRMED | FAILED | UNCERTAIN
// CONFIRMED means the agent wrote every byte and the connection closed clean
// — it is the CEILING; nothing in software observes paper, so there is no
// "PRINTED" anywhere and UI copy must say "sent to printer". A DISPATCHED
// job whose lease expires becomes UNCERTAIN and is NEVER retried
// automatically: a second copy of a KOT is a second dish. A human resolves
// it — reprint (with reason, audited), confirm-by-eyes, or dismiss.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { ORDER_INCLUDE, buildReceipt } from '../../lib/orders.js';
import {
  requirePrintAgent, sha256, newEnrolCode, newAgentSecret,
} from '../../lib/print/agentAuth.js';

// Exported because the drawer channel runs on the SAME agents and must not
// reach its own verdict about which of them are alive.
export const HEARTBEAT_STALE_SEC = 90; // agent OFFLINE when silent 3× its 30 s beat
const LEASE_SEC = 60;
const RETRY_BACKOFF_SEC = [5, 15, 45];

export const printAgentsRouter = Router();
export const printJobsRouter = Router();

const staff = [requirePosAuth, resolveCompanyScope];
const managerUp = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'), requireUsableLicense];
const operate = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER', 'CASHIER'), requireUsableLicense];

// A DISPATCHED job whose lease ran out: the agent took it and went silent.
// Truth, not tidiness: UNCERTAIN, never back to QUEUED.
const sweepExpiredLeases = async (where = {}) => {
  await prisma.printJob.updateMany({
    where: { ...where, status: 'DISPATCHED', leaseExpiresAt: { lt: new Date() } },
    data: { status: 'UNCERTAIN' },
  });
};

const publicAgent = (a) => ({
  id: a.id, name: a.name, status: a.status, branchId: a.branchId,
  platform: a.platform, agentVersion: a.agentVersion, hostname: a.hostname,
  lastSeenAt: a.lastSeenAt,
  online: !!a.lastSeenAt && Date.now() - a.lastSeenAt.getTime() < HEARTBEAT_STALE_SEC * 1000,
  health: a.health ?? null,
});

const publicJob = (j) => ({
  id: j.id, kind: j.kind, status: j.status,
  targetId: j.targetId, agentId: j.agentId,
  attempts: j.attempts, maxAttempts: j.maxAttempts,
  lastError: j.lastError ?? null,
  sourceOrderId: j.sourceOrderId, sourceKotId: j.sourceKotId,
  reprintOfId: j.reprintOfId ?? null, reason: j.reason ?? null,
  resolution: j.resolution ?? null,
  createdAt: j.createdAt, dispatchedAt: j.dispatchedAt, completedAt: j.completedAt,
});

// --- admin: agents & targets (manager+) ------------------------------------

printAgentsRouter.post('/', ...staff, ...managerUp, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(80),
    branchId: z.string().optional(),
  }).parse(req.body);
  const branchId = req.user.branchId ?? body.branchId;
  if (!branchId) throw badRequest('branchId is required', 'branchId');
  const branch = await prisma.branch.findFirst({
    where: { id: branchId, companyId: req.companyScope.id },
  });
  if (!branch) throw notFound('Branch not found');
  const enrolCode = newEnrolCode();
  const agent = await prisma.printAgent.create({
    data: {
      companyId: req.companyScope.id,
      branchId: branch.id,
      name: body.name,
      enrolCodeHash: sha256(enrolCode),
      enrolCodeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      createdById: req.user.id,
    },
  });
  await audit(req, {
    action: 'PRINT_AGENT_CREATED', entity: 'PrintAgent', entityId: agent.id,
    companyId: req.companyScope.id, meta: { name: agent.name, branchId: branch.id },
  });
  // The one and only time the code leaves the server.
  res.status(201).json({ agent: publicAgent(agent), enrolCode });
}));

printAgentsRouter.get('/', ...staff, ...managerUp, asyncHandler(async (req, res) => {
  await sweepExpiredLeases({ companyId: req.companyScope.id });
  const agents = await prisma.printAgent.findMany({
    where: { companyId: req.companyScope.id, status: { not: 'REVOKED' } },
    orderBy: { createdAt: 'asc' },
  });
  const uncertain = await prisma.printJob.count({
    where: { companyId: req.companyScope.id, status: 'UNCERTAIN', resolution: null },
  });
  res.json({ agents: agents.map(publicAgent), uncertainJobs: uncertain });
}));

printAgentsRouter.post('/:id/revoke', ...staff, ...managerUp, asyncHandler(async (req, res) => {
  const agent = await prisma.printAgent.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!agent) throw notFound('Agent not found');
  await prisma.printAgent.update({
    where: { id: agent.id },
    data: { status: 'REVOKED', revokedAt: new Date(), credentialHash: null, enrolCodeHash: null },
  });
  await audit(req, {
    action: 'PRINT_AGENT_REVOKED', entity: 'PrintAgent', entityId: agent.id,
    companyId: req.companyScope.id, meta: { name: agent.name },
  });
  res.status(204).end();
}));

printAgentsRouter.post('/:id/targets', ...staff, ...managerUp, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(80),
    purpose: z.enum(['KOT', 'RECEIPT']),
    stationId: z.string().optional(),
    transport: z.enum(['TCP', 'FILE']),
    host: z.string().max(200).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    widthChars: z.number().int().min(20).max(96).optional(),
    cut: z.boolean().optional(),
    drawerKick: z.boolean().optional(),
  }).parse(req.body);
  if (body.transport === 'TCP' && !body.host) throw badRequest('TCP target needs a host', 'host');
  if (body.stationId && body.purpose !== 'KOT') throw badRequest('Only KOT targets bind a station', 'stationId');
  const agent = await prisma.printAgent.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!agent) throw notFound('Agent not found');
  if (body.stationId) {
    const station = await prisma.kitchenStation.findFirst({
      where: { id: body.stationId, branchId: agent.branchId },
    });
    if (!station) throw notFound('Station not found');
  }
  const target = await prisma.printTarget.create({
    data: {
      companyId: req.companyScope.id, branchId: agent.branchId, agentId: agent.id,
      name: body.name, purpose: body.purpose, stationId: body.stationId ?? null,
      transport: body.transport, host: body.host ?? null,
      port: body.port ?? (body.transport === 'TCP' ? 9100 : null),
      widthChars: body.widthChars ?? 48,
      cut: body.cut ?? true, drawerKick: body.drawerKick ?? false,
    },
  });
  res.status(201).json({ target: { id: target.id, name: target.name, purpose: target.purpose, stationId: target.stationId } });
}));

// --- agent endpoints (agent credential, no staff session) ------------------

printAgentsRouter.post('/enrol', asyncHandler(async (req, res) => {
  const body = z.object({
    code: z.string().min(8).max(200),
    platform: z.string().max(80).optional(),
    agentVersion: z.string().max(40).optional(),
    hostname: z.string().max(120).optional(),
  }).parse(req.body);
  const agent = await prisma.printAgent.findUnique({
    where: { enrolCodeHash: sha256(body.code) },
  });
  if (!agent || agent.status !== 'PENDING'
    || !agent.enrolCodeExpiresAt || agent.enrolCodeExpiresAt < new Date()) {
    throw badRequest('Enrolment code invalid or expired');
  }
  const secret = newAgentSecret();
  // Code cleared in the same write: it works exactly once.
  await prisma.printAgent.update({
    where: { id: agent.id },
    data: {
      status: 'ACTIVE',
      credentialHash: sha256(secret),
      enrolCodeHash: null,
      enrolCodeExpiresAt: null,
      enrolledAt: new Date(),
      lastSeenAt: new Date(),
      platform: body.platform ?? null,
      agentVersion: body.agentVersion ?? null,
      hostname: body.hostname ?? null,
    },
  });
  // Shown once, stored only as a hash.
  res.status(201).json({ agentId: agent.id, secret });
}));

printAgentsRouter.post('/heartbeat', requirePrintAgent, asyncHandler(async (req, res) => {
  const body = z.object({ health: z.unknown().optional() }).parse(req.body);
  await prisma.printAgent.update({
    where: { id: req.printAgent.id },
    data: {
      lastSeenAt: new Date(),
      lastIp: req.ip ?? null,
      ...(body.health !== undefined ? { health: body.health } : {}),
    },
  });
  res.status(204).end();
}));

// Claim: atomically QUEUED→DISPATCHED with a lease. The claimToken makes the
// claim itself replayable — an agent that lost the response repeats the same
// token and gets the same jobs back instead of leasing a second batch.
printAgentsRouter.post('/jobs/claim', requirePrintAgent, asyncHandler(async (req, res) => {
  const body = z.object({
    claimToken: z.string().min(8).max(100),
    max: z.number().int().min(1).max(20).optional(),
  }).parse(req.body);
  const agent = req.printAgent;
  await sweepExpiredLeases({ agentId: agent.id });

  const replay = await prisma.printJob.findMany({
    where: { agentId: agent.id, claimToken: body.claimToken, status: 'DISPATCHED' },
    include: { target: true },
  });
  if (replay.length > 0) {
    return res.json({ jobs: replay.map(agentJob), replayed: true });
  }

  const jobs = await prisma.$transaction(async (tx) => {
    const due = await tx.printJob.findMany({
      where: { agentId: agent.id, status: 'QUEUED', nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: body.max ?? 5,
    });
    if (due.length === 0) return [];
    await tx.printJob.updateMany({
      where: { id: { in: due.map((j) => j.id) }, status: 'QUEUED' },
      data: {
        status: 'DISPATCHED',
        claimToken: body.claimToken,
        dispatchedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + LEASE_SEC * 1000),
        attempts: { increment: 1 },
      },
    });
    // Only rows THIS token actually moved: a concurrent claim that won the
    // updateMany race keeps its batch, and this caller gets [] rather than a
    // copy of somebody else's lease — a duplicated batch is a duplicated dish.
    return tx.printJob.findMany({
      where: { id: { in: due.map((j) => j.id) }, claimToken: body.claimToken, status: 'DISPATCHED' },
      include: { target: true },
      orderBy: { createdAt: 'asc' },
    });
  });
  res.json({ jobs: jobs.map(agentJob), replayed: false });
}));

const agentJob = (j) => ({
  id: j.id, kind: j.kind, document: j.document,
  target: {
    id: j.target.id, transport: j.target.transport, host: j.target.host,
    port: j.target.port, widthChars: j.target.widthChars,
    cut: j.target.cut, drawerKick: j.target.drawerKick,
  },
  attempts: j.attempts, maxAttempts: j.maxAttempts,
});

printAgentsRouter.post('/jobs/:id/report', requirePrintAgent, asyncHandler(async (req, res) => {
  const body = z.object({
    ok: z.boolean(),
    error: z.string().max(2000).optional(),
    detail: z.unknown().optional(),
  }).parse(req.body);
  const job = await prisma.printJob.findFirst({
    where: { id: req.params.id, agentId: req.printAgent.id },
  });
  if (!job) throw notFound('Job not found');
  const report = { ok: body.ok, error: body.error ?? null, detail: body.detail ?? null, at: new Date().toISOString() };
  if (job.status !== 'DISPATCHED') {
    // Too late to change anything (lease expired → UNCERTAIN, or already
    // final) — but keep the report: it is exactly what a person resolving an
    // UNCERTAIN job wants to see. Replays land here too and change nothing.
    await prisma.printJob.update({ where: { id: job.id }, data: { lastReport: report } });
    return res.status(200).json({ status: job.status, recorded: true });
  }
  let data;
  if (body.ok) {
    data = { status: 'CONFIRMED', completedAt: new Date(), lastReport: report, claimToken: null };
  } else if (job.attempts < job.maxAttempts) {
    const backoff = RETRY_BACKOFF_SEC[Math.min(job.attempts - 1, RETRY_BACKOFF_SEC.length - 1)];
    data = {
      status: 'QUEUED',
      nextAttemptAt: new Date(Date.now() + backoff * 1000),
      lastError: body.error ?? 'agent reported failure',
      lastReport: report,
      claimToken: null,
      leaseExpiresAt: null,
    };
  } else {
    data = { status: 'FAILED', completedAt: new Date(), lastError: body.error ?? 'retries exhausted', lastReport: report, claimToken: null };
  }
  const updated = await prisma.printJob.update({ where: { id: job.id }, data });
  res.json({ status: updated.status });
}));

// --- staff: enqueue, list, reprint, resolve --------------------------------

const renderDocument = async (req, order, kind, kotId) => {
  if (kind === 'RECEIPT') {
    const full = await prisma.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE });
    const branch = await prisma.branch.findUnique({ where: { id: order.branchId } });
    return buildReceipt(req.companyScope, branch, full);
  }
  const kot = await prisma.kot.findFirst({
    where: { id: kotId, orderId: order.id },
    // note rides along: the cashier's "no onions" belongs on the station
    // ticket, not only on a screen. Null when nothing was typed.
    include: { items: { select: { name: true, qty: true, note: true } } },
  });
  if (!kot) throw notFound('KOT not found');
  return {
    seq: kot.seq,
    type: order.type,
    note: order.note ?? null,
    items: kot.items,
    createdAt: kot.createdAt,
  };
};

const targetsFor = async (order, kind, kotId) => {
  if (kind === 'RECEIPT') {
    return prisma.printTarget.findMany({
      where: { branchId: order.branchId, purpose: 'RECEIPT', status: 'ACTIVE', agent: { status: 'ACTIVE' } },
    });
  }
  const all = await prisma.printTarget.findMany({
    where: { branchId: order.branchId, purpose: 'KOT', status: 'ACTIVE', agent: { status: 'ACTIVE' } },
  });
  if (all.length === 0) return [];
  const lines = await prisma.kitchenItem.findMany({
    where: { kotId }, select: { stationId: true },
  });
  const stationsInKot = new Set(lines.map((l) => l.stationId));
  // Pass printers (no station) always print; station printers only when the
  // KOT has a line for their station. Unrouted KOTs fall to pass printers.
  return all.filter((t) => t.stationId === null || stationsInKot.has(t.stationId));
};

printJobsRouter.use(...staff);

printJobsRouter.post('/', ...operate, asyncHandler(async (req, res) => {
  const body = z.object({
    orderId: z.string().min(1),
    kind: z.enum(['RECEIPT', 'KOT']),
    kotId: z.string().optional(),
  }).parse(req.body);
  if (body.kind === 'KOT' && !body.kotId) throw badRequest('KOT jobs need kotId', 'kotId');
  const order = await prisma.order.findFirst({
    where: { id: body.orderId, companyId: req.companyScope.id },
  });
  if (!order) throw notFound('Order not found');
  if (body.kind === 'RECEIPT' && !['BILLED', 'PAID', 'REFUNDED'].includes(order.status)) {
    throw conflict('Receipts exist only after billing');
  }

  const targets = await targetsFor(order, body.kind, body.kotId);
  if (targets.length === 0) {
    // No managed printer for this document — the browser print path remains
    // the Core fallback; nothing to queue is not an error.
    return res.json({ jobs: [], queued: 0 });
  }
  const document = await renderDocument(req, order, body.kind, body.kotId);

  const jobs = [];
  for (const target of targets) {
    // Same document to the same printer = one job, however often a till
    // retries the request. A deliberate second copy goes through /reprint.
    const idempotencyKey = `${body.kind}:${order.id}:${body.kotId ?? ''}:${target.id}`;
    const existing = await prisma.printJob.findUnique({
      where: { branchId_idempotencyKey: { branchId: order.branchId, idempotencyKey } },
    });
    if (existing) {
      jobs.push({ ...publicJob(existing), deduped: true });
      continue;
    }
    try {
      const job = await prisma.printJob.create({
        data: {
          companyId: req.companyScope.id, branchId: order.branchId,
          agentId: target.agentId, targetId: target.id,
          kind: body.kind, idempotencyKey, document,
          sourceOrderId: order.id, sourceKotId: body.kotId ?? null,
          requestedById: req.user.id,
        },
      });
      jobs.push({ ...publicJob(job), deduped: false });
    } catch (e) {
      // Two tills firing the identical request at the same instant: the
      // loser of the unique race dedupes exactly like a sequential retry
      // instead of surfacing a 500.
      if (e?.code !== 'P2002') throw e;
      const raced = await prisma.printJob.findUnique({
        where: { branchId_idempotencyKey: { branchId: order.branchId, idempotencyKey } },
      });
      jobs.push({ ...publicJob(raced), deduped: true });
    }
  }
  await audit(req, {
    action: 'PRINT_JOB_QUEUED', entity: 'Order', entityId: order.id,
    companyId: req.companyScope.id,
    meta: { kind: body.kind, kotId: body.kotId ?? null, jobs: jobs.map((j) => j.id) },
  });
  res.status(201).json({ jobs, queued: jobs.filter((j) => !j.deduped).length });
}));

printJobsRouter.get('/', ...managerUp, asyncHandler(async (req, res) => {
  await sweepExpiredLeases({ companyId: req.companyScope.id });
  const where = { companyId: req.companyScope.id };
  if (req.query.status) where.status = req.query.status;
  const jobs = await prisma.printJob.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json({ jobs: jobs.map(publicJob) });
}));

// Deliberate reprint: a NEW job pointing at the one it replaces, reason
// required, actor from the session, audited. This is the ONLY way a second
// copy of the same document reaches a printer.
printJobsRouter.post('/:id/reprint', ...operate, asyncHandler(async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
  const job = await prisma.printJob.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!job) throw notFound('Job not found');
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const reprint = await tx.printJob.create({
        data: {
          companyId: job.companyId, branchId: job.branchId,
          agentId: job.agentId, targetId: job.targetId,
          kind: job.kind, document: job.document,
          idempotencyKey: `reprint:${job.id}`,
          sourceOrderId: job.sourceOrderId, sourceKotId: job.sourceKotId,
          reprintOfId: job.id, reason: body.reason,
          requestedById: req.user.id,
        },
      });
      if (['UNCERTAIN', 'FAILED'].includes(job.status) && !job.resolution) {
        await tx.printJob.update({
          where: { id: job.id },
          data: { resolution: 'REPRINTED', resolvedById: req.user.id, resolvedAt: new Date() },
        });
      }
      return reprint;
    });
  } catch (e) {
    // The same reprint asked for twice (double-tap, replayed request): hand
    // back the job the first ask created instead of a unique-key 500. A
    // deliberate FURTHER copy is a reprint of the newest job in the chain,
    // so every extra paper stays its own audited decision.
    if (e?.code !== 'P2002') throw e;
    const existing = await prisma.printJob.findUnique({
      where: { branchId_idempotencyKey: { branchId: job.branchId, idempotencyKey: `reprint:${job.id}` } },
    });
    if (!existing) throw e;
    return res.json({ job: publicJob(existing) });
  }
  await audit(req, {
    action: 'PRINT_JOB_REPRINT', entity: 'PrintJob', entityId: created.id,
    companyId: req.companyScope.id,
    meta: { reprintOf: job.id, kind: job.kind, orderId: job.sourceOrderId, reason: body.reason },
  });
  res.status(201).json({ job: publicJob(created) });
}));

// A person looked at the printer (or decided no copy is needed): record the
// human judgement on an UNCERTAIN/FAILED job. CONFIRMED_BY_STAFF is still a
// statement about a person's eyes, not a software observation of paper.
printJobsRouter.post('/:id/resolve', ...managerUp, asyncHandler(async (req, res) => {
  const body = z.object({
    resolution: z.enum(['CONFIRMED_BY_STAFF', 'DISMISSED']),
  }).parse(req.body);
  const job = await prisma.printJob.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id },
  });
  if (!job) throw notFound('Job not found');
  if (!['UNCERTAIN', 'FAILED'].includes(job.status)) {
    throw conflict(`Only UNCERTAIN or FAILED jobs are resolvable (this one is ${job.status})`);
  }
  if (job.resolution) throw conflict(`Already resolved: ${job.resolution}`);
  const updated = await prisma.printJob.update({
    where: { id: job.id },
    data: { resolution: body.resolution, resolvedById: req.user.id, resolvedAt: new Date() },
  });
  await audit(req, {
    action: 'PRINT_JOB_RESOLVED', entity: 'PrintJob', entityId: job.id,
    companyId: req.companyScope.id, meta: { resolution: body.resolution },
  });
  res.json({ job: publicJob(updated) });
}));
