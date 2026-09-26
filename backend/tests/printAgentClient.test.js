// The real agent against the real server. No test doubles on either side.
//
// printJobs.test.js proves the queue. agent/test/*.test.js prove the consumer.
// Neither proves the seam, and the seam is where a protocol drifts: a client
// that serialises a field the server's zod schema rejects, a response field the
// agent reads that the server never emits, a job that reaches CONFIRMED in a
// unit test and 400s in a store. So this file runs the shipped
// PrintAgentClient and Runner — over real HTTP, against createApp() on a real
// port, with a real TCP printer at the other end — and asserts the database
// rows and the bytes on the socket at the same time.
//
// It creates a uniquely-named company and deletes only the rows it created. No
// global wipe: several lanes point at one database, and a file that truncates
// tenant tables can only be run alone.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('printAgentClient.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

// The shipped agent, imported from source. If these paths move, this file
// fails — which is the point: the acceptance evidence must be about the
// artefact that installs, not a copy of it.
const { PrintAgentClient, newClaimToken } = await import('../../agent/src/client.js');
const { Runner } = await import('../../agent/src/runner.js');
const { Journal } = await import('../../agent/src/journal.js');
const { DEFAULTS } = await import('../../agent/src/config.js');
const { money } = await import('../../agent/src/text.js');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PW = 'test-password-1';
// Unique per run so a crashed run cannot collide with the next one on the
// company slug or the branch publicId, both unique columns.
const TAG = `w6e2e${Date.now().toString(36)}`;

let http;            // the listening server the agent's fetch() talks to
let baseUrl;
let company, branch, tempDir;
let productId;
const tokens = {};
const orderIds = [];

// A printer. 'clean' reads everything and closes politely; 'rst' reads 200
// bytes and resets the connection, which is a printer power-cycled mid-ticket
// and the only way to produce a genuinely uncertain delivery on purpose.
const printerSink = async (mode = 'clean') => {
  const received = [];
  let connections = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    connections += 1;
    const chunks = [];
    socket.on('data', (c) => {
      chunks.push(c);
      if (mode === 'rst' && Buffer.concat(chunks).length >= 200) socket.resetAndDestroy();
    });
    socket.on('end', () => {
      received.push(Buffer.concat(chunks));
      socket.end();
    });
    socket.on('error', () => { /* an RST we caused ourselves */ });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    received,
    get connections() { return connections; },
    paper: () => Buffer.concat(received).toString('latin1'),
    close: () => new Promise((r) => server.close(r)),
  };
};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// A live agent: enrolled through the real one-time code, with a real journal.
const liveAgent = async ({ name, targets }) => {
  const created = await request(app).post('/api/print-agents').set(auth(tokens.owner)).send({ name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const agentId = created.body.agent.id;

  const targetIds = {};
  for (const [key, body] of Object.entries(targets)) {
    const res = await request(app).post(`/api/print-agents/${agentId}/targets`)
      .set(auth(tokens.owner)).send(body);
    expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(201);
    targetIds[key] = res.body.target.id;
  }

  // Enrolment through the shipped client: unauthenticated POST, credential kept
  // in memory only for the length of this test.
  const client = new PrintAgentClient({ serverUrl: baseUrl });
  expect(client.authorized).toBe(false);
  const out = await client.enrol(created.body.enrolCode, {
    platform: `${process.platform}-${process.arch}`, hostname: os.hostname(),
  });
  expect(out.agentId).toBe(agentId);
  expect(client.authorized).toBe(true);

  const journalPath = path.join(tempDir, `${name.replace(/\W+/g, '-')}.jsonl`);
  const journal = await new Journal(journalPath).open();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const runner = new Runner({
    client, journal, log,
    config: { ...DEFAULTS, serverUrl: baseUrl, closeGraceMs: 300 },
  });
  return { agentId, targetIds, client, runner, journal, journalPath };
};

// The phases the agent wrote down locally, in order.
const journalPhases = async (journalPath) =>
  (await fsp.readFile(journalPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).phase);

const billedOrder = async () => {
  const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', items: [{ productId, qty: 2 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  orderIds.push(created.body.order.id);
  const kot = await request(app).post(`/api/orders/${created.body.order.id}/kot`)
    .set(auth(tokens.cashier)).send({});
  expect(kot.status, JSON.stringify(kot.body)).toBe(201);
  const bill = await request(app).post(`/api/orders/${created.body.order.id}/bill`)
    .set(auth(tokens.cashier)).send({});
  expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  return { order: bill.body.order, kotId: kot.body.kot.id };
};

const enqueue = (body) =>
  request(app).post('/api/print-jobs').set(auth(tokens.cashier)).send(body);

const jobRow = (id) => prisma.printJob.findUnique({ where: { id } });

beforeAll(async () => {
  http = app.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  baseUrl = `http://127.0.0.1:${http.address().port}`;
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'w6-e2e-'));

  const passwordHash = await hashPassword(PW);
  company = await prisma.company.create({
    data: {
      name: `W6 E2E ${TAG}`, slug: `w6-e2e-${TAG}`,
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  branch = await prisma.branch.create({
    data: { companyId: company.id, publicId: `VC-W6-${TAG.slice(-6)}`, name: 'Till', code: 'W6' },
  });
  const mk = (email, fullName, role) => prisma.posUser.create({
    data: { email, fullName, role, companyId: company.id, branchId: branch.id, passwordHash },
  });
  await mk(`owner@${TAG}.test`, 'E2E Owner', 'CUSTOMER_OWNER');
  await mk(`till@${TAG}.test`, 'E2E Till', 'CASHIER');

  const tax = await prisma.taxRate.create({
    data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const cat = await prisma.category.create({
    data: { companyId: company.id, name: 'Coffee', sortOrder: 1 },
  });
  productId = (await prisma.product.create({
    data: { companyId: company.id, categoryId: cat.id, name: 'Cappuccino', basePrice: '180.00', taxRateId: tax.id },
  })).id;

  tokens.owner = await login(`owner@${TAG}.test`);
  tokens.cashier = await login(`till@${TAG}.test`);
});

afterAll(async () => {
  // Only this run's rows, innermost first. Nothing here is a deleteMany over a
  // whole table, so this file is safe beside a populated database.
  if (company) {
    const items = await prisma.orderItem.findMany({
      where: { orderId: { in: orderIds } }, select: { id: true },
    });
    await prisma.printJob.deleteMany({ where: { companyId: company.id } });
    await prisma.printTarget.deleteMany({ where: { companyId: company.id } });
    await prisma.printAgent.deleteMany({ where: { companyId: company.id } });
    await prisma.kitchenItem.deleteMany({ where: { companyId: company.id } });
    await prisma.kitchenRoute.deleteMany({ where: { companyId: company.id } });
    await prisma.kitchenStation.deleteMany({ where: { branchId: branch.id } });
    await prisma.kitchenCursor.deleteMany({ where: { branchId: branch.id } });
    await prisma.orderItemModifier.deleteMany({ where: { orderItemId: { in: items.map((i) => i.id) } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.kot.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { companyId: company.id } });
    await prisma.invoiceCounter.deleteMany({ where: { branchId: branch.id } });
    await prisma.product.deleteMany({ where: { companyId: company.id } });
    await prisma.category.deleteMany({ where: { companyId: company.id } });
    await prisma.taxRate.deleteMany({ where: { companyId: company.id } });
    await prisma.posAuditLog.deleteMany({ where: { companyId: company.id } });
    await prisma.license.deleteMany({ where: { companyId: company.id } });
    await prisma.posUser.deleteMany({ where: { companyId: company.id } });
    await prisma.branch.deleteMany({ where: { companyId: company.id } });
    await prisma.company.delete({ where: { id: company.id } });
  }
  if (http) await new Promise((r) => http.close(r));
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('the shipped agent consumes authorised jobs end to end', () => {
  it('enrols, beats, claims, prints the server\'s own document and reaches CONFIRMED', async () => {
    const sink = await printerSink();
    try {
      const { agentId, targetIds, client, runner } = await liveAgent({
        name: 'Counter till',
        targets: {
          receipt: {
            name: 'Front receipt', purpose: 'RECEIPT', transport: 'TCP',
            host: '127.0.0.1', port: sink.port, widthChars: 48,
          },
        },
      });

      // Heartbeat first, exactly as `run()` does, so the health the server
      // stores is the health the agent actually reports.
      await client.heartbeat(runner.health());
      const beaten = await prisma.printAgent.findUnique({ where: { id: agentId } });
      expect(beaten.lastSeenAt).not.toBeNull();
      expect(beaten.health.protocolVersion).toBe(runner.health().protocolVersion);

      const { order } = await billedOrder();
      const queued = await enqueue({ orderId: order.id, kind: 'RECEIPT' });
      expect(queued.status, JSON.stringify(queued.body)).toBe(201);
      const jobId = queued.body.jobs[0].id;
      expect((await jobRow(jobId)).status).toBe('QUEUED');

      expect(await runner.pollJobs()).toBe(1);

      const done = await jobRow(jobId);
      expect(done.status).toBe('CONFIRMED');
      expect(done.completedAt).not.toBeNull();
      expect(done.lastReport.ok).toBe(true);
      // The lease is released on a confirmed job, so a replay of the same token
      // cannot hand the ticket out a second time.
      expect(done.claimToken).toBeNull();
      expect(done.targetId).toBe(targetIds.receipt);

      // Paper, not just rows: the invoice number the server minted and the total
      // it computed are on the socket, and the agent added neither.
      const paper = sink.paper();
      expect(sink.connections).toBe(1);
      expect(paper).toContain(done.document.invoiceNumber);
      expect(paper).toContain('TOTAL');
      expect(paper).toContain(money(done.document.total));
      expect(paper).toContain('Cappuccino');
      // ESC @ opens the stream and GS V ends it: a complete document, not a
      // truncated one that happened to close cleanly.
      expect(paper.startsWith('\x1b@')).toBe(true);
      expect(paper).toContain('\x1dV');
    } finally {
      await sink.close();
    }
  });

  it('prints a KOT to a station printer with no money on it', async () => {
    const sink = await printerSink();
    try {
      const { agentId, client, runner } = await liveAgent({
        name: 'Kitchen till',
        targets: {
          pass: {
            name: 'Pass KOT', purpose: 'KOT', transport: 'TCP',
            host: '127.0.0.1', port: sink.port, widthChars: 48,
          },
        },
      });
      await client.heartbeat(runner.health());

      const { order, kotId } = await billedOrder();
      const queued = await enqueue({ orderId: order.id, kind: 'KOT', kotId });
      expect(queued.status, JSON.stringify(queued.body)).toBe(201);
      const jobId = queued.body.jobs[0].id;

      expect(await runner.pollJobs()).toBe(1);
      expect((await jobRow(jobId)).status).toBe('CONFIRMED');

      const paper = sink.paper();
      expect(paper).toContain('KOT');
      expect(paper).toContain('Cappuccino');
      expect(paper).not.toContain('Rs.');
      expect(agentId).toBeTruthy();
    } finally {
      await sink.close();
    }
  });

  it('replaying a claim token hands back the same jobs and prints one copy', async () => {
    const sink = await printerSink();
    try {
      const { client, runner } = await liveAgent({
        name: 'Replay till',
        targets: {
          receipt: {
            name: 'Replay receipt', purpose: 'RECEIPT', transport: 'TCP',
            host: '127.0.0.1', port: sink.port,
          },
        },
      });
      const { order } = await billedOrder();
      const jobId = (await enqueue({ orderId: order.id, kind: 'RECEIPT' })).body.jobs[0].id;

      // The response the agent never saw.
      const token = newClaimToken();
      const first = await client.claimJobs(token, 3);
      expect(first.replayed).toBe(false);
      expect(first.jobs.map((j) => j.id)).toEqual([jobId]);

      const again = await client.claimJobs(token, 3);
      expect(again.replayed).toBe(true);
      expect(again.jobs.map((j) => j.id)).toEqual([jobId]);

      // One delivery for the two claims: the lease is the same lease.
      await runner.deliverJob(again.jobs[0]);
      expect(sink.connections).toBe(1);
      expect((await jobRow(jobId)).status).toBe('CONFIRMED');
    } finally {
      await sink.close();
    }
  });
});

describe('honest delivery semantics against the real queue', () => {
  it('an uncertain delivery is reported to nobody and is never re-sent', async () => {
    // The printer resets the connection 200 bytes into the ticket. Some of the
    // ticket may be on the roll; nothing in software can say how much.
    const sink = await printerSink('rst');
    try {
      const { client, runner, journalPath } = await liveAgent({
        name: 'Uncertain till',
        targets: {
          receipt: {
            name: 'Flaky receipt', purpose: 'RECEIPT', transport: 'TCP',
            host: '127.0.0.1', port: sink.port,
          },
        },
      });
      const { order } = await billedOrder();
      const jobId = (await enqueue({ orderId: order.id, kind: 'RECEIPT' })).body.jobs[0].id;

      expect(await runner.pollJobs()).toBe(1);
      expect(runner.stats.uncertain).toBe(1);

      // The server was told nothing at all. ok:false would re-queue it and put a
      // second copy of this bill in a customer's hand; ok:true would be a lie.
      const held = await jobRow(jobId);
      expect(held.status).toBe('DISPATCHED');
      expect(held.lastReport).toBeNull();
      expect(held.completedAt).toBeNull();

      // The journal is the local record that something was in flight, which is
      // what stops the agent re-delivering it after a restart.
      const phases = await journalPhases(journalPath);
      expect(phases).toContain('WRITING');
      expect(phases).toContain('ABANDONED');
      expect(phases).not.toContain('REPORTED');

      // Time passes. The next claim sweeps the dead lease — to UNCERTAIN, not
      // back to QUEUED — so the job is never handed out again.
      await prisma.printJob.update({
        where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });
      const next = await client.claimJobs(newClaimToken(), 3);
      expect(next.jobs).toEqual([]);
      expect((await jobRow(jobId)).status).toBe('UNCERTAIN');

      // And the agent never touched the printer a second time.
      expect(sink.connections).toBe(1);
      expect(await runner.pollJobs()).toBe(0);
      expect(sink.connections).toBe(1);
    } finally {
      await sink.close();
    }
  });

  it('a printer that refuses the connection is a clean failure the server re-queues', async () => {
    // Port 1 on loopback: nothing listens, and the refusal arrives before a byte
    // is written, so "not sent" is a fact rather than an inference.
    const { client, runner } = await liveAgent({
      name: 'Refused till',
      targets: {
        receipt: {
          name: 'Absent receipt', purpose: 'RECEIPT', transport: 'TCP',
          host: '127.0.0.1', port: 1,
        },
      },
    });
    const { order } = await billedOrder();
    const jobId = (await enqueue({ orderId: order.id, kind: 'RECEIPT' })).body.jobs[0].id;

    expect(await runner.pollJobs()).toBe(1);

    const requeued = await jobRow(jobId);
    expect(requeued.status).toBe('QUEUED');
    expect(requeued.attempts).toBe(1);
    expect(requeued.lastError).toContain('NOT_SENT');
    // Backoff is the server's, not the agent's: the job is not due yet.
    expect(requeued.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect((await client.claimJobs(newClaimToken(), 3)).jobs).toEqual([]);
  });

  it('a clean delivery reported after the lease expired stays UNCERTAIN, and the report is kept', async () => {
    // The paper is real and the server still says UNCERTAIN. That is correct: by
    // the time the report arrived the server had already told a human to go and
    // look. What matters is that the agent's evidence is not thrown away.
    const sink = await printerSink();
    try {
      const { client, runner } = await liveAgent({
        name: 'Late till',
        targets: {
          receipt: {
            name: 'Slow receipt', purpose: 'RECEIPT', transport: 'TCP',
            host: '127.0.0.1', port: sink.port,
          },
        },
      });
      const { order } = await billedOrder();
      const jobId = (await enqueue({ orderId: order.id, kind: 'RECEIPT' })).body.jobs[0].id;

      const claimed = await client.claimJobs(newClaimToken(), 3);
      expect(claimed.jobs).toHaveLength(1);

      // The lease dies while the ticket is on the roll, and the next claim
      // sweeps it.
      await prisma.printJob.update({
        where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });
      expect((await client.claimJobs(newClaimToken(), 3)).jobs).toEqual([]);
      expect((await jobRow(jobId)).status).toBe('UNCERTAIN');

      const outcome = await runner.deliverJob(claimed.jobs[0]);
      expect(outcome).toBe('DELIVERED');

      const late = await jobRow(jobId);
      expect(late.status).toBe('UNCERTAIN');
      // The agent's own account of the delivery, stored on the job a human is
      // about to resolve. Without it the operator is resolving blind.
      expect(late.lastReport.ok).toBe(true);
      expect(late.lastReport.detail).toMatch(/bytes/);
      expect(sink.paper()).toContain(late.document.invoiceNumber);
    } finally {
      await sink.close();
    }
  });

  it('a revoked credential stops the agent claiming, without failing a job', async () => {
    const sink = await printerSink();
    try {
      const { agentId, client, runner } = await liveAgent({
        name: 'Revoked till',
        targets: {
          receipt: {
            name: 'Revoked receipt', purpose: 'RECEIPT', transport: 'TCP',
            host: '127.0.0.1', port: sink.port,
          },
        },
      });
      const { order } = await billedOrder();
      const jobId = (await enqueue({ orderId: order.id, kind: 'RECEIPT' })).body.jobs[0].id;

      const revoked = await request(app).post(`/api/print-agents/${agentId}/revoke`)
        .set(auth(tokens.owner)).send({});
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(204);

      // The claim 401s. pollJobs swallows it into a warning and returns 0: a
      // revoked till must not mark a queued ticket failed, because the ticket is
      // still perfectly printable by the next agent enrolled at this store.
      expect(await runner.pollJobs()).toBe(0);
      expect(sink.connections).toBe(0);
      expect((await jobRow(jobId)).status).toBe('QUEUED');
      await expect(client.heartbeat({})).rejects.toThrow();
    } finally {
      await sink.close();
    }
  });
});
