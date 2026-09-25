// ENTITLEMENT(DRAWER)
//
// Cash-drawer control (contract §5). Mounted at /api/drawer for staff and at
// /api/print-agents for the Store Agent, which is deliberately the SAME agent,
// the same credential and the same claim/lease protocol as printing. A shop
// runs one agent process; a second one to open a drawer would be a second thing
// to enrol, monitor and revoke for no gain.
//
// WHAT A DRAWER COMMAND IS. A row saying "drive pin 2 on this printer for 50 ms,
// on behalf of this person, because of this committed money, and only in the
// next 30 seconds". It carries no bytes and no host: the agent already knows how
// to reach its own printer, and the only variables are a pin and two durations,
// both bounded in lib/peripherals/drawer.js. There is no raw-command field and
// no shell — see that file for why.
//
// WHAT OPENS A DRAWER. Cash moving, or a person taking responsibility:
//   CASH_RECEIPT  names a committed Payment whose method is CASH
//   CASH_REFUND   names a SUCCEEDED manual Refund whose method is CASH
//   MANUAL        names nobody, so it needs a typed reason AND the separate
//                 drawer.open.manual permission a cashier does not have
// A card or UPI payment does not open the drawer, and neither does printing a
// KOT or reprinting a receipt. Those paths never call this router; the cause
// enum and the DeviceCommand_cause_evidence CHECK are what make that structural
// rather than a habit.
//
// WHAT "IT OPENED" MEANS. Nothing in software watches a drawer. An agent report
// says the pulse went out and the port did not complain, which is a claim about
// SOFTWARE — a jammed mechanism, an unplugged RJ-11 and a drawer somebody is
// leaning on all acknowledge identically. Only a target whose technician has
// declared drawerSensor may ever say OPENED. Every status this router returns
// carries the sentence that goes with it, so a screen cannot accidentally
// promote "acknowledged" into "opened".
//
// WHAT NEVER HAPPENS. A command is never retried automatically and never
// re-queued. A QUEUED command that outlives its 30 s window becomes EXPIRED and
// no agent may take it; a DISPATCHED one whose lease runs out becomes UNCERTAIN
// and stays there until a person looks at the till. Re-firing a pulse that may
// already have fired is how a drawer ends up standing open in a shop.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { deviceContext, assertDeviceStore, deviceStamp } from '../../middleware/device.js';
import {
  loadPermissionContext,
  requireAction,
  resolveStoreInScope,
  scopedBranchIdWhere,
} from '../../middleware/permissions.js';
import { requirePrintAgent } from '../../lib/print/agentAuth.js';
import { HEARTBEAT_STALE_SEC } from './printing.js';
import {
  COMMAND_LEASE_SEC,
  COMMAND_TTL_SEC,
  DRAWER_CLAIM_TEXT,
  DRAWER_OFF_MS,
  DRAWER_ON_MS,
  DRAWER_PINS,
  DrawerProfileError,
  commandPayload,
  drawerClaim,
  profileOfTarget,
  validateDrawerProfile,
} from '../../lib/peripherals/drawer.js';

export const drawerRouter = Router();
export const deviceCommandsRouter = Router();

const operate = [requireUsableLicense, requireAction('drawer.open')];

// Two rules, and they are not the same rule.
//
// A QUEUED command that ran out of time was never handed to anybody, so nothing
// reached the hardware: EXPIRED, and the agent-side claim refuses it a second
// time on its own where clause.
//
// A DISPATCHED command whose LEASE ran out was handed over and then met silence.
// The pulse may have fired. That is UNCERTAIN, never back to QUEUED — the whole
// point of the state is that software stops guessing here.
//
// Note which clock each arm reads: expiresAt for the first, leaseExpiresAt for
// the second. A dispatched command that outlives expiresAt is NOT expired; it
// was taken in time and the agent still owes an answer.
const sweepCommands = async (where = {}) => {
  const now = new Date();
  await prisma.deviceCommand.updateMany({
    where: { ...where, status: 'QUEUED', expiresAt: { lt: now } },
    data: { status: 'EXPIRED', completedAt: now },
  });
  await prisma.deviceCommand.updateMany({
    where: { ...where, status: 'DISPATCHED', leaseExpiresAt: { lt: now } },
    data: { status: 'UNCERTAIN', completedAt: now },
  });
};

const publicCommand = (c) => {
  const claim = drawerClaim(c, c.target);
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    cause: c.cause,
    causeRefId: c.causeRefId ?? null,
    reason: c.reason ?? null,
    targetId: c.targetId,
    targetName: c.target?.name ?? null,
    agentId: c.agentId,
    terminalId: c.terminalId ?? null,
    deviceId: c.deviceId ?? null,
    drawerPin: c.drawerPin,
    drawerOnMs: c.drawerOnMs,
    drawerOffMs: c.drawerOffMs,
    expiresAt: c.expiresAt,
    attempts: c.attempts,
    dispatchedAt: c.dispatchedAt,
    completedAt: c.completedAt,
    ackAt: c.ackAt,
    lastError: c.lastError ?? null,
    // The physical claim and the sentence that goes with it travel together, so
    // a screen showing one without the other has to do it deliberately.
    claim,
    claimText: DRAWER_CLAIM_TEXT[claim],
    // Whether this drawer can ever say OPENED at all. A UI that hides the
    // distinction when the answer is "no" is the failure this column prevents.
    sensorEquipped: c.target?.drawerSensor ?? false,
    createdAt: c.createdAt,
  };
};

const COMMAND_INCLUDE = {
  target: { select: { id: true, name: true, drawerSensor: true } },
};

const agentOnline = (agent) =>
  !!agent?.lastSeenAt && Date.now() - agent.lastSeenAt.getTime() < HEARTBEAT_STALE_SEC * 1000;

// --- staff ------------------------------------------------------------------

drawerRouter.use(requirePosAuth, resolveCompanyScope, deviceContext, loadPermissionContext);

// Which printers in this store can actually kick a drawer, and which of them
// can report whether it moved.
//
// drawerKick is the capability check, and it is a real one: a receipt printer
// with nothing plugged into its RJ-11 accepts the pulse and reports success
// forever. The owner ticks this box when a drawer is wired, and a store where
// nobody has is a store where this feature honestly does not exist yet.
drawerRouter.get(
  '/targets',
  requireAction('drawer.open'),
  asyncHandler(async (req, res) => {
    const targets = await prisma.printTarget.findMany({
      where: {
        companyId: req.companyScope.id,
        ...scopedBranchIdWhere(req),
        drawerKick: true,
        status: 'ACTIVE',
      },
      include: { agent: { select: { id: true, name: true, status: true, lastSeenAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({
      targets: targets.map((t) => ({
        id: t.id,
        name: t.name,
        branchId: t.branchId,
        drawerPin: t.drawerPin,
        drawerOnMs: t.drawerOnMs,
        drawerOffMs: t.drawerOffMs,
        // Surfaced so an operator screen can tell the truth without asking: a
        // false here means this till will only ever report "acknowledged".
        drawerSensor: t.drawerSensor,
        agentId: t.agentId,
        agentName: t.agent.name,
        agentOnline: t.agent.status === 'ACTIVE' && agentOnline(t.agent),
      })),
    });
  }),
);

// The drawer half of a printer's configuration, and nothing else: purpose,
// host, port and station stay where they are, so this route cannot be used to
// re-point a printer at another machine.
//
// Manager-and-up, matching who may create the target in the first place. The
// numbers go through the same validator the command path uses, so a profile
// that cannot be stored is refused here with the hardware reason rather than as
// a CHECK violation at the moment somebody presses Open.
const profileSchema = z.object({
  drawerKick: z.boolean().optional(),
  drawerPin: z.number().int().optional(),
  drawerOnMs: z.number().int().optional(),
  drawerOffMs: z.number().int().optional(),
  // The switch that licenses the word "opened" anywhere in this product. False
  // everywhere until a technician has confirmed a sensor is wired, and turning
  // it on is audited under its own action for exactly that reason.
  drawerSensor: z.boolean().optional(),
});

drawerRouter.patch(
  '/targets/:id',
  requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body);
    const before = await prisma.printTarget.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id, ...scopedBranchIdWhere(req) },
    });
    if (!before) throw notFound('Printer not found');

    const profile = {
      drawerPin: body.drawerPin ?? before.drawerPin,
      drawerOnMs: body.drawerOnMs ?? before.drawerOnMs,
      drawerOffMs: body.drawerOffMs ?? before.drawerOffMs,
    };
    try {
      validateDrawerProfile(profile);
    } catch (e) {
      if (!(e instanceof DrawerProfileError)) throw e;
      throw badRequest(e.message, e.field);
    }

    const target = await prisma.printTarget.update({
      where: { id: before.id },
      data: {
        ...profile,
        ...(body.drawerKick !== undefined ? { drawerKick: body.drawerKick } : {}),
        ...(body.drawerSensor !== undefined ? { drawerSensor: body.drawerSensor } : {}),
      },
    });

    await audit(req, {
      // A separate action when the sensor flag moves. Every "the drawer opened"
      // this product will ever print traces back to somebody flipping this, and
      // that decision has to be findable without reading diffs of a general
      // update row.
      action:
        body.drawerSensor !== undefined && body.drawerSensor !== before.drawerSensor
          ? 'DRAWER_SENSOR_DECLARED'
          : 'DRAWER_PROFILE_UPDATED',
      entity: 'PrintTarget',
      entityId: target.id,
      companyId: req.companyScope.id,
      meta: {
        name: target.name,
        before: {
          drawerKick: before.drawerKick,
          drawerSensor: before.drawerSensor,
          drawerPin: before.drawerPin,
          drawerOnMs: before.drawerOnMs,
          drawerOffMs: before.drawerOffMs,
        },
        after: {
          drawerKick: target.drawerKick,
          drawerSensor: target.drawerSensor,
          drawerPin: target.drawerPin,
          drawerOnMs: target.drawerOnMs,
          drawerOffMs: target.drawerOffMs,
        },
      },
    });

    res.json({
      target: {
        id: target.id,
        name: target.name,
        drawerKick: target.drawerKick,
        drawerSensor: target.drawerSensor,
        drawerPin: target.drawerPin,
        drawerOnMs: target.drawerOnMs,
        drawerOffMs: target.drawerOffMs,
      },
      // The documented envelope, returned so an operator screen can render the
      // limits instead of hard-coding a second copy that drifts.
      limits: { pins: DRAWER_PINS, onMs: DRAWER_ON_MS, offMs: DRAWER_OFF_MS },
    });
  }),
);

// The printer whose drawer port this request drives.
//
// Resolved server-side from the store, never taken as a host or an address, so a
// command cannot be addressed at another shop's hardware by naming it. A
// targetId belonging to a different store is simply not found — the same answer
// as one that does not exist, so ids cannot be probed to map somebody's estate.
const resolveDrawerTarget = async (req, branch, targetId) => {
  const targets = await prisma.printTarget.findMany({
    where: {
      ...(targetId ? { id: targetId } : {}),
      branchId: branch.id,
      companyId: req.companyScope.id,
      drawerKick: true,
      status: 'ACTIVE',
      agent: { status: 'ACTIVE' },
    },
    include: { agent: { select: { id: true, name: true, lastSeenAt: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (targets.length === 0) {
    if (targetId) throw notFound('That printer is not a cash drawer in this store');
    throw conflict(
      'No cash drawer is set up in this store. A drawer opens through a receipt printer, ' +
        'so the owner has to enable the drawer kick on one before this will work.',
    );
  }
  // Two drawers on one counter is a real layout, and picking for the operator
  // means opening the wrong till in front of a customer. Name it.
  if (targets.length > 1) {
    throw badRequest(
      `This store has ${targets.length} cash drawers — say which one to open`,
      'targetId',
    );
  }
  return targets[0];
};

// A drawer-open needs money that actually moved, and the row that proves it.
//
// Both arms check the evidence belongs to THIS store. Scoping through the order
// rather than trusting the caller's branch is what stops a cashier in one shop
// using another shop's cash sale as the justification for opening their own till.
const resolveCause = async (req, branch, body) => {
  if (body.cause === 'CASH_RECEIPT') {
    const payment = await prisma.payment.findFirst({
      where: {
        id: body.paymentId,
        branchId: branch.id,
        order: { companyId: req.companyScope.id },
      },
      select: { id: true, method: true },
    });
    if (!payment) throw notFound('Payment not found in this store');
    // §5, stated as code: a card or UPI payment does not open the drawer. The
    // money for those never entered the till, so opening it has no cause.
    if (payment.method !== 'CASH') {
      throw conflict(
        `That payment was taken by ${payment.method}, not cash — nothing went into the drawer, so it does not open for it`,
      );
    }
    return { causeRefId: payment.id, reason: null };
  }

  if (body.cause === 'CASH_REFUND') {
    const refund = await prisma.refund.findFirst({
      where: {
        id: body.refundId,
        order: { companyId: req.companyScope.id, branchId: branch.id },
      },
      select: { id: true, channel: true, status: true, method: true },
    });
    if (!refund) throw notFound('Refund not found in this store');
    if (refund.channel !== 'MANUAL') {
      throw conflict(
        'That refund goes back through the payment provider. No cash leaves the till for it.',
      );
    }
    // A refund that is only requested has returned nothing yet. Opening a till
    // for it invites the notes out before the money is authorised to leave.
    if (refund.status !== 'SUCCEEDED') {
      throw conflict(`That refund is ${refund.status}, not completed — the drawer opens once it is`);
    }
    // Null covers manual refunds written before the tender column existed. They
    // are read as cash for day-close continuity, but "probably cash" is not a
    // reason to open a till: the operator can open it manually and say so.
    if (refund.method !== 'CASH') {
      throw conflict(
        refund.method === null
          ? 'That refund does not record which tender it went back on, so the drawer cannot be opened for it'
          : `That refund went back by ${refund.method}, not cash`,
      );
    }
    return { causeRefId: refund.id, reason: null };
  }

  // MANUAL. No money to point at, so a person takes responsibility instead: a
  // separate permission the cashier role does not carry, plus a typed reason
  // that goes on the row and into the audit trail.
  if (!req.perm.can('drawer.open.manual')) {
    throw forbidden(
      'Opening the till without a sale needs the separate "open the cash drawer without a sale" permission',
    );
  }
  return { causeRefId: null, reason: body.reason };
};

const openSchema = z
  .object({
    cause: z.enum(['CASH_RECEIPT', 'CASH_REFUND', 'MANUAL']),
    paymentId: z.string().trim().min(1).optional(),
    refundId: z.string().trim().min(1).optional(),
    // Free text, and it has to be: "float top-up", "counted the till", "customer
    // dropped a coin behind the counter". A dropdown would only teach people to
    // pick whichever option gets the drawer open fastest.
    reason: z.string().trim().min(3).max(200).optional(),
    targetId: z.string().trim().min(1).optional(),
    // Only read when neither the signed-in user nor the till is bound to one
    // store, and still proved against the caller's scope before it is used.
    branchId: z.string().trim().min(1).optional(),
    // Only MANUAL uses this, and it is required there — see the key derivation
    // below for why the other two causes ignore whatever the caller sends.
    idempotencyKey: z.string().trim().min(8).max(64).optional(),
  })
  .superRefine((v, ctx) => {
    const need = (field, when) => {
      if (!v[field]) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for ${when}` });
      }
    };
    if (v.cause === 'CASH_RECEIPT') need('paymentId', 'a cash receipt');
    if (v.cause === 'CASH_REFUND') need('refundId', 'a cash refund');
    if (v.cause === 'MANUAL') {
      need('reason', 'a manual open');
      need('idempotencyKey', 'a manual open');
    }
  });

// The identity of a REQUEST, not of a click.
//
// For a cash receipt or refund the server derives it and ignores anything the
// caller sent: "open the drawer for THIS payment" is the request, so a till that
// double-clicks, retries on a flaky link, or regenerates a key on re-render
// still produces exactly one command. A caller cannot opt out of that by
// inventing a key, because there is no key argument on this path.
//
// MANUAL has no such natural identity — two float top-ups an hour apart are two
// genuine requests — so the caller must supply one per button press, and a
// retried request with the same key dedupes exactly like the other two causes.
const causeKeyBase = (cause, causeRefId, body, targetId) =>
  cause === 'MANUAL'
    ? `manual:${body.idempotencyKey}:${targetId}`
    : `${cause === 'CASH_RECEIPT' ? 'receipt' : 'refund'}:${causeRefId}:${targetId}`;

// States in which NOTHING can have reached the hardware, so a fresh click may
// raise a fresh command against the same evidence.
//
// EXPIRED means no agent ever claimed it. FAILED means an agent claimed it and
// reported it could not reach the printer. Both are definite negatives, and
// refusing to reissue after them would leave a cashier with cash owed, a shut
// drawer and no route to it short of a manager's manual-open permission.
//
// This is NOT a replay: the old row keeps its status forever and is never
// dispatched again. A new row is created, freshly authorised by a person, with
// its own 30 s window and its own audit entry. UNCERTAIN and CONFIRMED are
// absent on purpose — after those the pulse may have fired or did fire, and the
// honest recovery is a person looking at the till, not another pulse.
const REISSUABLE = new Set(['FAILED', 'EXPIRED']);

drawerRouter.post(
  '/open',
  ...operate,
  asyncHandler(async (req, res) => {
    const body = openSchema.parse(req.body);
    const branchId = req.user.branchId ?? req.device?.branchId ?? body.branchId;
    const branch = await resolveStoreInScope(req, branchId);
    // A till enrolled at one store cannot drive another store's drawer even
    // inside the same tenant, and even when the operator's own scope spans both.
    assertDeviceStore(req, branch.id);

    const target = await resolveDrawerTarget(req, branch, body.targetId);
    const { causeRefId, reason } = await resolveCause(req, branch, body);
    const base = causeKeyBase(body.cause, causeRefId, body, target.id);

    // Ordinal, not a bare key: every reissue after a definite negative keeps its
    // own row, so "this drawer was asked to open four times for one sale" stays
    // visible instead of being collapsed into one record.
    const prior = await prisma.deviceCommand.findMany({
      where: { branchId: branch.id, idempotencyKey: { startsWith: `${base}#` } },
      include: COMMAND_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    const live = prior.find((c) => !REISSUABLE.has(c.status));
    if (live) {
      return res.status(200).json({
        command: publicCommand(live),
        deduped: true,
        agentOnline: agentOnline(target.agent),
        // Said plainly because the cashier is standing at a shut drawer. The
        // route out is a manual open with a reason, which is permissioned and
        // audited — not a second automatic pulse.
        advice:
          live.status === 'UNCERTAIN'
            ? 'Nobody can say whether that pulse reached the drawer. Look at the till before asking again.'
            : null,
      });
    }

    const profile = profileOfTarget(target);
    const idempotencyKey = `${base}#${prior.length + 1}`;
    let command;
    try {
      command = await prisma.deviceCommand.create({
        data: {
          companyId: req.companyScope.id,
          branchId: branch.id,
          agentId: target.agentId,
          targetId: target.id,
          kind: 'DRAWER_OPEN',
          cause: body.cause,
          causeRefId,
          reason,
          // Frozen from the target now, so an owner editing the profile while
          // this command is in flight cannot change what it does to the coil.
          ...profile,
          idempotencyKey,
          expiresAt: new Date(Date.now() + COMMAND_TTL_SEC * 1000),
          requestedById: req.user.id,
          // WHICH counter asked. A drawer variance is only answerable with this
          // on the row, the same reason Payment carries it.
          ...deviceStamp(req),
        },
        include: COMMAND_INCLUDE,
      });
    } catch (e) {
      // Two tills, or two clicks, landing on the same ordinal at the same
      // instant. The loser reads back the winner's row and reports a dedupe,
      // which is what a sequential double-click already gets.
      if (e?.code !== 'P2002') throw e;
      const raced = await prisma.deviceCommand.findUnique({
        where: { branchId_idempotencyKey: { branchId: branch.id, idempotencyKey } },
        include: COMMAND_INCLUDE,
      });
      if (!raced) throw e;
      return res.status(200).json({
        command: publicCommand(raced),
        deduped: true,
        agentOnline: agentOnline(target.agent),
        advice: null,
      });
    }

    await audit(req, {
      action: 'DRAWER_OPEN_REQUESTED',
      entity: 'DeviceCommand',
      entityId: command.id,
      companyId: req.companyScope.id,
      meta: {
        cause: body.cause,
        causeRefId,
        reason,
        targetId: target.id,
        branchId: branch.id,
        ...profile,
      },
    });

    res.status(201).json({
      command: publicCommand(command),
      deduped: false,
      // Not a refusal. The command still queues and still expires in 30 s, which
      // is the honest behaviour for an agent that is reconnecting right now. The
      // flag lets the till say "the store agent is offline" instead of leaving
      // the cashier watching a spinner resolve into nothing.
      agentOnline: agentOnline(target.agent),
      advice: null,
    });
  }),
);

// Poll one command. The till calls this until the status settles; the sweep runs
// first so a caller reading an abandoned command sees EXPIRED or UNCERTAIN
// rather than a QUEUED row that no agent will ever take.
drawerRouter.get(
  '/commands/:id',
  requireAction('drawer.open'),
  asyncHandler(async (req, res) => {
    await sweepCommands({ companyId: req.companyScope.id });
    const command = await prisma.deviceCommand.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id, ...scopedBranchIdWhere(req) },
      include: COMMAND_INCLUDE,
    });
    if (!command) throw notFound('Command not found');
    res.json({ command: publicCommand(command) });
  }),
);

drawerRouter.get(
  '/commands',
  requireAction('drawer.open'),
  asyncHandler(async (req, res) => {
    await sweepCommands({ companyId: req.companyScope.id });
    const where = { companyId: req.companyScope.id, ...scopedBranchIdWhere(req) };
    if (req.query.status) where.status = String(req.query.status);
    const commands = await prisma.deviceCommand.findMany({
      where,
      include: COMMAND_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ commands: commands.map(publicCommand) });
  }),
);

// --- agent (agent credential, no staff session) -----------------------------
//
// Mounted alongside the print-agent routes so an agent has one base URL and one
// secret. Nothing here trusts a branch, a company or a target from the request:
// every command is already addressed to exactly one agent, and the agent can
// only ever see and report its own.

// Claim: atomically QUEUED→DISPATCHED with a lease, exactly as jobs/claim does,
// with one addition that carries the whole §5 rule about stale commands — the
// where clause requires expiresAt to still be in the future. An agent that was
// offline for four hours and reconnects finds nothing to take, because every
// command raised in that window expired where it sat.
deviceCommandsRouter.post(
  '/commands/claim',
  requirePrintAgent,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        claimToken: z.string().min(8).max(100),
        max: z.number().int().min(1).max(10).optional(),
      })
      .parse(req.body);
    const agent = req.printAgent;
    await sweepCommands({ agentId: agent.id });

    // The claim itself is replayable: an agent that lost the response repeats
    // its token and gets the same commands back instead of leasing a second
    // batch. A second batch of drawer pulses is a till opening twice.
    const replay = await prisma.deviceCommand.findMany({
      where: { agentId: agent.id, claimToken: body.claimToken, status: 'DISPATCHED' },
      orderBy: { createdAt: 'asc' },
    });
    if (replay.length > 0) {
      return res.json({ commands: replay.map(commandPayload), replayed: true });
    }

    const claimed = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const due = await tx.deviceCommand.findMany({
        where: { agentId: agent.id, status: 'QUEUED', expiresAt: { gt: now } },
        orderBy: { createdAt: 'asc' },
        take: body.max ?? 5,
        select: { id: true },
      });
      if (due.length === 0) return [];
      const ids = due.map((c) => c.id);
      await tx.deviceCommand.updateMany({
        // status and expiresAt repeated from the read: between the two
        // statements another claim may have taken these rows, or the window may
        // have closed. Both are re-checked where it counts, in the write.
        where: { id: { in: ids }, status: 'QUEUED', expiresAt: { gt: now } },
        data: {
          status: 'DISPATCHED',
          claimToken: body.claimToken,
          dispatchedAt: now,
          leaseExpiresAt: new Date(now.getTime() + COMMAND_LEASE_SEC * 1000),
          attempts: { increment: 1 },
        },
      });
      // Only the rows THIS token actually moved. A concurrent claim that won the
      // race keeps its batch and this caller gets [], rather than a copy of
      // somebody else's lease — two agents driving one pin is two pulses.
      return tx.deviceCommand.findMany({
        where: { id: { in: ids }, claimToken: body.claimToken, status: 'DISPATCHED' },
        orderBy: { createdAt: 'asc' },
      });
    });
    res.json({ commands: claimed.map(commandPayload), replayed: false });
  }),
);

deviceCommandsRouter.post(
  '/commands/:id/report',
  requirePrintAgent,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        // "I drove the pin and the port did not complain." A claim about
        // software, and the ONLY thing an agent is able to claim.
        ok: z.boolean(),
        error: z.string().max(2000).optional(),
        detail: z.unknown().optional(),
        // The drawer's own sensor, when the printer has one wired. Honoured only
        // where the target declares drawerSensor — an agent cannot grant itself
        // the right to assert a drawer opened by sending true.
        drawerOpen: z.boolean().optional(),
      })
      .parse(req.body);
    const command = await prisma.deviceCommand.findFirst({
      where: { id: req.params.id, agentId: req.printAgent.id },
      include: COMMAND_INCLUDE,
    });
    if (!command) throw notFound('Command not found');

    const report = {
      ok: body.ok,
      error: body.error ?? null,
      detail: body.detail ?? null,
      drawerOpen: body.drawerOpen ?? null,
      at: new Date().toISOString(),
    };

    if (command.status !== 'DISPATCHED') {
      // Too late to change the outcome — the lease ran out and the row is
      // UNCERTAIN, or it is already final, or this is a replayed report. Keep
      // the report anyway: it is exactly what the person resolving an UNCERTAIN
      // till wants to read. Nothing else moves, and in particular an UNCERTAIN
      // command never becomes CONFIRMED on a late "ok".
      const stored = await prisma.deviceCommand.update({
        where: { id: command.id },
        data: { lastReport: report },
        include: COMMAND_INCLUDE,
      });
      return res.status(200).json({
        status: stored.status,
        recorded: true,
        claim: drawerClaim(stored, stored.target),
      });
    }

    const now = new Date();
    const data = body.ok
      ? {
          status: 'CONFIRMED',
          // CONFIRMED is about DELIVERY. ackAt records that the agent drove the
          // pin; sensorConfirmed is the only field that says the drawer moved,
          // and it needs both a target that has a sensor and a reading from it.
          // A sensor-equipped drawer that reports shut stays CONFIRMED and
          // claims ACKNOWLEDGED_NOT_OPENED, which is the true pair of facts.
          ackAt: now,
          sensorConfirmed: command.target?.drawerSensor === true && body.drawerOpen === true,
          completedAt: now,
          lastReport: report,
          claimToken: null,
        }
      : {
          // Final. There is no backoff and no re-queue here, unlike a print job:
          // a second copy of a receipt wastes paper, a second pulse opens a till
          // nobody is standing at. A cashier who still needs the drawer asks
          // again, which raises a NEW command a person is accountable for.
          status: 'FAILED',
          completedAt: now,
          lastError: body.error ?? 'agent reported failure',
          lastReport: report,
          claimToken: null,
        };

    const updated = await prisma.deviceCommand.update({
      where: { id: command.id },
      data,
      include: COMMAND_INCLUDE,
    });
    const claim = drawerClaim(updated, updated.target);
    res.json({ status: updated.status, claim, claimText: DRAWER_CLAIM_TEXT[claim] });
  }),
);
