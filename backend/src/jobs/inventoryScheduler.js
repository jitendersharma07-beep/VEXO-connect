// ENTITLEMENT(INVENTORY)
//
// The inventory scheduler: everything that has to happen because time passed,
// rather than because somebody pressed a button.
//
// Four things live here and nothing else does:
//
//   plan cycles   an order cutoff arriving is not an event any request raises,
//                 so the plan's own clock has to raise it
//   time-driven   a delivery becoming overdue, a batch coming up on its expiry,
//   reminders     a container left open past its use-by
//   escalation    a reminder nobody answered moving up a rung
//   delivery      a notification that failed getting another attempt, with its
//                 attempt count and its error kept rather than reset
//
// Everything the REQUEST lifecycle raises — pending approval, dispatch due,
// receipt pending, unresolved shortage — is raised by the route that caused it
// and dropped by the route that resolved it. The scheduler deliberately does
// not duplicate that: a reminder raised in two places is a reminder that only
// gets dropped in one.
//
// RESTART RECOVERY IS STRUCTURAL, NOT REMEMBERED. Every unit of work here is
// keyed on something the database already holds unique:
//
//   ReplenishmentRun   (planId, cycleDate)          one run per delivery cycle
//   StoreRequest       (companyId, requirementKey)  one order per cycle
//   InventoryReminder  (companyId, dedupeKey)       one live reminder per subject
//
// so a process killed halfway through a tick resumes at the row it had not
// written yet, and a process that runs an entire tick twice writes the same
// rows twice to the same effect. Nothing decides what is outstanding by
// reading a cursor. `cursorAt` records when the job last finished cleanly; it
// is an observation, not an input, which is why a wrong one cannot skip work.
//
// NOTHING HERE SENDS AN EXTERNAL MESSAGE. Delivery goes through
// reminders.js#queueNotification, which is in-app unless a transport is
// configured, and a transport with no adapter records FAILED with its reason
// instead of pretending to have sent something.

import { randomUUID } from 'node:crypto';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { nextCycle, requirementKeyFor, suggestForPlan } from '../lib/inventory/replenish.js';
import { escalateReminder, notifyReminder, raiseReminder, responsibleUsers } from '../lib/inventory/reminders.js';
import { attemptDelivery } from '../lib/inventory/notifyTransport.js';
import { nextDocNumber } from '../lib/inventory/docnum.js';
import { BASE_UNIT_NAME, MILLI } from '../lib/inventory/units.js';

export const JOB_NAME = 'inventory';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// How long a claim is good for. Long enough that a slow tick does not lose its
// own lease mid-run, short enough that a process killed with the lease held
// does not lock the job out for the rest of the afternoon.
const LEASE_MS = 5 * MINUTE;

// A plan starts working on a cycle this long before its cutoff, so that a
// SUBMISSION_CUTOFF reminder arrives while there is still time to act on it.
const CUTOFF_LEAD_MS = 12 * HOUR;

// Stock this close to its expiry is worth telling somebody about. One number
// for every company on purpose: it is a warning threshold, not a policy, and
// a per-company setting for it would be a column nobody ever changes.
const EXPIRY_WARN_DAYS = 7;
const OPENED_WARN_MS = 12 * HOUR;

// A run that keeps failing stops being retried and starts being reported. The
// cap exists so a plan with one bad item does not re-attempt for ever and bury
// the failure in a thousand identical rows.
const MAX_RUN_ATTEMPTS = 5;
const MAX_NOTIFY_ATTEMPTS = 5;

// Per-tick bounds. A tick is a background job, not a report: it is better for
// it to take the oldest few hundred and come back in a minute than to hold a
// lease open reading a year of batches.
const BATCH_SCAN_LIMIT = 500;
const REMINDER_SCAN_LIMIT = 500;
const NOTIFY_SCAN_LIMIT = 200;

/* --------------------------------------------------------------- the lease */

// The lease is what stops two processes ticking the same job. It is one
// updateMany with the expiry in the WHERE clause, which under Postgres read
// committed makes the second writer re-check the row after the first commits
// and find it taken — so the mutual exclusion is the database's, not a flag we
// set and hope about.
export const claimLease = async (client, { name = JOB_NAME, owner, ttlMs = LEASE_MS, now = new Date() }) => {
  await client.inventorySchedulerState.create({ data: { name } }).catch((e) => {
    // Losing the race to create the row is not a failure. The row it wanted is
    // the row it is about to compete for.
    if (e?.code !== 'P2002') throw e;
  });

  const claimed = await client.inventorySchedulerState.updateMany({
    where: { name, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
    data: { lockedBy: owner, lockedUntil: new Date(now.getTime() + ttlMs), lastTickAt: now },
  });
  return claimed.count === 1;
};

// Only the holder releases. A process whose lease expired while it was still
// working must not stamp its outcome over whoever holds the job now, so the
// owner is part of the WHERE clause and a lost lease releases nothing.
export const releaseLease = async (client, { name = JOB_NAME, owner, ok, error = null, cursorAt = null }) => {
  const released = await client.inventorySchedulerState.updateMany({
    where: { name, lockedBy: owner },
    data: {
      lockedBy: null,
      lockedUntil: null,
      ...(ok
        ? {
            lastOkAt: new Date(),
            runCount: { increment: 1 },
            lastError: null,
            ...(cursorAt ? { cursorAt } : {}),
          }
        : {
            failCount: { increment: 1 },
            lastError: String(error ?? 'unknown').slice(0, 1000),
          }),
    },
  });
  return released.count === 1;
};

/* ------------------------------------------------------------- plan cycles */

const planRaiser = async (client, plan) => {
  // The plan's author signs its orders. A request raised by a machine still
  // has to be attributable to a person, and the person who set the schedule up
  // is the one who chose these quantities.
  if (plan.createdById) {
    const author = await client.posUser.findUnique({ where: { id: plan.createdById }, select: { id: true, status: true } });
    if (author?.status === 'ACTIVE') return author.id;
  }
  const owner = await client.posUser.findFirst({
    where: { companyId: plan.companyId, role: 'CUSTOMER_OWNER', status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return owner?.id ?? null;
};

const raisePlanRequest = async (client, { plan, suggestion, cycle, run, raisedById, now }) => {
  const key = requirementKeyFor(plan, cycle.cycleDate);
  const lines = suggestion.lines.filter((l) => l.suggestMilli > 0);
  if (!lines.length) return { request: null, duplicate: false };

  const submitting = plan.autoSubmit;
  try {
    const request = await client.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, plan.companyId, 'REQUEST');
      const created = await tx.storeRequest.create({
        data: {
          companyId: plan.companyId,
          number,
          destinationLocationId: plan.destinationLocationId,
          sourceLocationId: plan.sourceLocationId,
          status: submitting ? 'SUBMITTED' : 'DRAFT',
          priority: 'NORMAL',
          requiredBy: cycle.requiredBy,
          reason: `Raised by replenishment plan "${plan.name}"`,
          raisedById,
          submittedAt: submitting ? now : null,
          originPlanId: plan.id,
          originRunId: run.id,
          requirementKey: key,
          lines: {
            create: lines.map((l) => ({
              itemId: l.itemId,
              // The plan works in base units, so base units are what is
              // recorded as entered. Claiming a unit nobody typed would freeze
              // a conversion factor onto the line for a conversion that never
              // happened, and every later report reading that factor would be
              // reading a fiction.
              enteredQty: l.suggestedQty,
              enteredUnit: BASE_UNIT_NAME[l.item?.baseUnit ?? 'PCS'],
              enteredFactorMilli: MILLI,
              requestedQty: l.suggestedQty,
              outstandingQty: l.suggestedQty,
            })),
          },
        },
        include: { lines: true },
      });
      await tx.storeRequestEvent.create({
        data: {
          requestId: created.id,
          action: submitting ? 'PLAN_SUBMIT' : 'PLAN_DRAFT',
          fromStatus: null,
          toStatus: created.status,
          actorId: raisedById,
          actorRole: 'SYSTEM',
          detail: { planId: plan.id, planName: plan.name, runId: run.id, cycleDate: cycle.cycleDate, lines: lines.length },
        },
      });
      return created;
    });
    return { request, duplicate: false };
  } catch (e) {
    if (e?.code === 'P2002') {
      // Another tick, a restarted process, or a manager who did not wait has
      // already raised this cycle's order. That is the unique index doing the
      // job it exists for, not an error to report.
      const existing = await client.storeRequest.findFirst({
        where: { companyId: plan.companyId, requirementKey: key },
      });
      return { request: existing, duplicate: true };
    }
    throw e;
  }
};

// One plan, one cycle. Exported because the portal's per-plan "run now" must
// be the same code the 6pm pass runs — a second implementation of this is a
// second set of rules about when an order gets raised.
export const runPlanCycle = async (client, plan, now, out, { force = false } = {}) => {
  const cycle = nextCycle(plan, now);
  if (!cycle) {
    await client.replenishmentPlan.update({ where: { id: plan.id }, data: { nextRunAt: null } });
    return;
  }

  // Keep the plan's own clock honest whether or not this cycle is due yet, so
  // the portal's "next run" is never stale by a week.
  const startAt = new Date(cycle.cutoffAt.getTime() - CUTOFF_LEAD_MS);
  if (plan.nextRunAt?.getTime() !== startAt.getTime()) {
    await client.replenishmentPlan.update({ where: { id: plan.id }, data: { nextRunAt: startAt } });
  }
  // `force` is a person pressing "run now" before the window opens. It skips
  // the wait and nothing else: the cycle, its run row and its requirement key
  // are the same ones the scheduled pass would have used, so running early
  // cannot produce a second order for the same delivery.
  if (!force && now.getTime() < startAt.getTime()) return;

  // The run row is written BEFORE any work, not after it. A process that dies
  // between here and the order finds this row on restart and resumes; a
  // process that wrote the row afterwards would find nothing and order again.
  let run = await client.replenishmentRun.findUnique({
    where: { planId_cycleDate: { planId: plan.id, cycleDate: cycle.cycleDate } },
  });
  if (run?.outcome && run.outcome !== 'FAILED') return;
  if (run && run.attempts >= MAX_RUN_ATTEMPTS) return;

  if (!run) {
    try {
      run = await client.replenishmentRun.create({
        data: { companyId: plan.companyId, planId: plan.id, cycleDate: cycle.cycleDate },
      });
    } catch (e) {
      // Two ticks reached the same cycle at once. The loser reads the winner's
      // row and leaves it alone rather than racing it.
      if (e?.code !== 'P2002') throw e;
      return;
    }
  } else {
    run = await client.replenishmentRun.update({
      where: { id: run.id },
      data: { attempts: { increment: 1 }, outcome: null, finishedAt: null, startedAt: now },
    });
  }

  out.plans += 1;

  try {
    const suggestion = await suggestForPlan(client, plan, { asOf: now });
    const wanted = suggestion.lines.filter((l) => l.suggestMilli > 0);

    const key = requirementKeyFor(plan, cycle.cycleDate);
    const covered = await client.storeRequest.findFirst({
      where: { companyId: plan.companyId, requirementKey: key },
      select: { id: true, number: true, status: true },
    });

    if (covered) {
      await client.replenishmentRun.update({
        where: { id: run.id },
        data: {
          outcome: 'SKIPPED_ALREADY_COVERED',
          finishedAt: new Date(),
          lastError: null,
          detail: { requestId: covered.id, number: covered.number, status: covered.status },
        },
      });
      await client.replenishmentPlan.update({ where: { id: plan.id }, data: { lastRunAt: now } });
      return;
    }

    if (!wanted.length) {
      // Stock is fine. Recorded as a decision, not as silence: "the plan did
      // not order" and "the plan did not run" look identical in a log and
      // lead to opposite investigations.
      await client.replenishmentRun.update({
        where: { id: run.id },
        data: {
          outcome: 'SKIPPED_NOTHING_NEEDED',
          finishedAt: new Date(),
          lastError: null,
          detail: {
            lines: suggestion.lines.length,
            suppressed: suggestion.lines.filter((l) => l.suppressed).map((l) => ({ itemId: l.itemId, why: l.suppressed })),
          },
        },
      });
      await client.replenishmentPlan.update({ where: { id: plan.id }, data: { lastRunAt: now } });
      return;
    }

    const raisedById = await planRaiser(client, plan);
    if (!raisedById) {
      throw new Error('This plan has nobody to raise its request as: its author is gone and the company has no active owner');
    }

    const { request, duplicate } = await raisePlanRequest(client, {
      plan,
      suggestion,
      cycle,
      run,
      raisedById,
      now,
    });
    if (request && !duplicate) out.requestsRaised += 1;

    if (request && plan.autoSubmit) {
      // Auto-submitted means the store has done its part; the decision is now
      // the approver's, which is the reminder that gets raised.
      const r = await raiseReminder(client, {
        companyId: plan.companyId,
        kind: 'PENDING_APPROVAL',
        requestId: request.id,
        locationId: plan.sourceLocationId,
        dueAt: cycle.cutoffAt,
        subject: `Request ${request.number} was raised by plan "${plan.name}" and is waiting for a decision`,
      });
      if (r) out.reminders += 1;
    } else if (request) {
      // Left in DRAFT deliberately: somebody at the store has to look at it
      // and submit it before the cutoff, and this is what tells them so.
      const r = await raiseReminder(client, {
        companyId: plan.companyId,
        kind: 'SUBMISSION_CUTOFF',
        requestId: request.id,
        locationId: plan.destinationLocationId,
        // The subject is the CYCLE, not the plan: next Tuesday's silence is a
        // separate fact from this Tuesday's, and collapsing them would let one
        // acknowledgement close a reminder for an order never placed.
        subjectType: 'ReplenishmentCycle',
        subjectId: requirementKeyFor(plan, cycle.cycleDate),
        dueAt: cycle.cutoffAt,
        subject: `Draft request ${request.number} for plan "${plan.name}" must be submitted before the cutoff`,
      });
      if (r) out.reminders += 1;
    }

    await client.replenishmentRun.update({
      where: { id: run.id },
      data: {
        outcome: 'COMPLETED',
        finishedAt: new Date(),
        lastError: null,
        detail: {
          requestId: request?.id ?? null,
          number: request?.number ?? null,
          duplicate,
          autoSubmit: plan.autoSubmit,
          lines: wanted.map((l) => ({ itemId: l.itemId, qty: l.suggestedQty })),
          cappedByCapacity: suggestion.cappedByCapacity,
        },
      },
    });
    await client.replenishmentPlan.update({ where: { id: plan.id }, data: { lastRunAt: now } });
  } catch (err) {
    // The failure is written onto the run, with its attempt count, so it is
    // visible in the portal rather than only in a log file nobody opens.
    await client.replenishmentRun
      .update({
        where: { id: run.id },
        data: { outcome: 'FAILED', finishedAt: new Date(), lastError: String(err?.message ?? err).slice(0, 1000) },
      })
      .catch(() => {});
    out.errors.push(`plan ${plan.id}: ${err?.message ?? err}`);
    logger.error({ err, planId: plan.id }, 'inventory scheduler: plan cycle failed');
  }
};

const runPlans = async (client, { companyId, now }, out) => {
  const plans = await client.replenishmentPlan.findMany({
    where: { status: 'ACTIVE', ...(companyId ? { companyId } : {}) },
    include: { lines: { where: { active: true }, include: { item: { select: { id: true, name: true, baseUnit: true } } } } },
    orderBy: { id: 'asc' },
  });
  for (const plan of plans) {
    // One plan's failure is one plan's failure. It must not stop the next
    // store's order or anybody's expiry warnings.
    await runPlanCycle(client, plan, now, out);
  }
};

/* ------------------------------------------------------- time-driven chase */

const chaseOverdueDeliveries = async (client, { companyId, now }, out) => {
  const transfers = await client.stockTransfer.findMany({
    where: {
      status: 'DISPATCHED',
      ...(companyId ? { companyId } : {}),
      storeRequest: { is: { requiredBy: { lt: now } } },
    },
    include: { storeRequest: { select: { id: true, number: true, requiredBy: true } } },
    take: REMINDER_SCAN_LIMIT,
    orderBy: { dispatchedAt: 'asc' },
  });

  for (const t of transfers) {
    const r = await raiseReminder(client, {
      companyId: t.companyId,
      kind: 'DELIVERY_OVERDUE',
      requestId: t.storeRequestId,
      // Chased at the SOURCE. A delivery that has not arrived is the sender's
      // problem to answer for; the receiving store is the one waiting.
      locationId: t.fromLocationId,
      subjectType: 'StockTransfer',
      subjectId: t.id,
      dueAt: t.storeRequest.requiredBy,
      subject: `Transfer ${t.number} for request ${t.storeRequest.number} was due and has not been received`,
    });
    if (r) out.reminders += 1;
  }
};

const chaseExpiringBatches = async (client, { companyId, now }, out) => {
  const horizon = new Date(now.getTime() + EXPIRY_WARN_DAYS * DAY);
  const positions = await client.stockBatchBalance.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      qty: { gt: 0 },
      batch: { is: { expiryDate: { not: null, lte: horizon } } },
    },
    include: {
      batch: { select: { id: true, batchCode: true, expiryDate: true, state: true } },
      item: { select: { id: true, name: true, baseUnit: true } },
      location: { select: { id: true, name: true } },
    },
    take: BATCH_SCAN_LIMIT,
    orderBy: { id: 'asc' },
  });

  for (const p of positions) {
    const expired = p.batch.expiryDate.getTime() < now.getTime();
    const r = await raiseReminder(client, {
      companyId: p.companyId,
      kind: 'BATCH_EXPIRING',
      locationId: p.locationId,
      // Per location AND batch: the same batch split across two stores is two
      // people's problem, and one of them acknowledging it must not silence
      // the other.
      subjectType: 'StockBatchBalance',
      subjectId: `${p.locationId}:${p.batchId}`,
      dueAt: p.batch.expiryDate,
      subject: expired
        ? `${p.item.name} batch ${p.batch.batchCode} at ${p.location.name} has expired with ${p.qty} still on hand`
        : `${p.item.name} batch ${p.batch.batchCode} at ${p.location.name} expires on ${p.batch.expiryDate.toISOString().slice(0, 10)} with ${p.qty} on hand`,
    });
    if (r) out.reminders += 1;
  }
};

const chaseOpenedContainers = async (client, { companyId, now }, out) => {
  const openings = await client.stockBatchOpening.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      closedAt: null,
      useByAt: { lte: new Date(now.getTime() + OPENED_WARN_MS) },
    },
    include: {
      batch: { select: { batchCode: true, itemId: true, item: { select: { name: true } } } },
      location: { select: { id: true, name: true } },
    },
    take: BATCH_SCAN_LIMIT,
    orderBy: { useByAt: 'asc' },
  });

  for (const o of openings) {
    const r = await raiseReminder(client, {
      companyId: o.companyId,
      kind: 'OPENED_CONTAINER_EXPIRING',
      locationId: o.locationId,
      subjectType: 'StockBatchOpening',
      subjectId: o.id,
      dueAt: o.useByAt,
      subject: `An opened container of ${o.batch.item.name} (batch ${o.batch.batchCode}) at ${o.location.name} must be used by ${o.useByAt.toISOString()}`,
    });
    if (r) out.reminders += 1;
  }
};

/* ------------------------------------------------- notify and then escalate */

// A reminder raised when nobody held the right grant has no assignee. It is
// not dropped — it is retried here, because the person who should answer it
// may have been given the grant five minutes later.
const notifyUnassigned = async (client, { companyId, now }, out) => {
  const pending = await client.inventoryReminder.findMany({
    where: {
      state: 'PENDING',
      ...(companyId ? { companyId } : {}),
    },
    take: REMINDER_SCAN_LIMIT,
    orderBy: { dueAt: 'asc' },
  });

  for (const reminder of pending) {
    let target = reminder;
    if (!target.assigneeId) {
      const candidates = await responsibleUsers(client, {
        companyId: target.companyId,
        locationId: target.locationId,
        need: null,
      });
      const assignee = candidates[0]?.id ?? null;
      if (!assignee) continue;
      target = await client.inventoryReminder.update({ where: { id: target.id }, data: { assigneeId: assignee } });
    }
    if (await notifyReminder(client, target)) out.notified += 1;
  }
};

const escalateDue = async (client, { companyId, now }, out) => {
  const due = await client.inventoryReminder.findMany({
    where: {
      state: { in: ['PENDING', 'NOTIFIED', 'ESCALATED'] },
      escalateAt: { not: null, lte: now },
      ...(companyId ? { companyId } : {}),
    },
    // Oldest first, so the thing that has been waiting longest moves up first
    // when a tick hits its limit.
    orderBy: [{ escalateAt: 'asc' }],
    take: REMINDER_SCAN_LIMIT,
  });

  for (const reminder of due) {
    const reached = await escalateReminder(client, reminder);
    out.escalated += 1;
    out.escalationRecipients += reached;
  }
};

/* ------------------------------------------------------------- redelivery */

// Retry what did not get through. Attempts and the last error are carried
// forward, never reset: a notification that failed four times and then
// succeeded is a different fact from one that succeeded first time, and the
// difference is the only evidence that the transport is sick.
// Pick up notifications that have not been delivered and try again.
//
// QUEUED is a notification whose first attempt never finished — the process
// died mid-send, or the row was written and the transport call never returned.
// FAILED is one that was tried and refused. Both are worth another go.
//
// UNDELIVERABLE is deliberately absent from the scan: it means the transport
// said retrying cannot help, and re-asking an address that does not exist
// whether it exists yet produces a portal full of rows that look like they are
// still being worked on. Exhausting MAX_NOTIFY_ATTEMPTS leaves a row FAILED
// rather than UNDELIVERABLE, and that distinction is honest — we stopped
// trying, but we never established that it could not arrive.
const retryNotifications = async (client, { companyId, now }, out) => {
  const stuck = await client.inventoryNotification.findMany({
    where: {
      state: { in: ['QUEUED', 'FAILED'] },
      attempts: { lt: MAX_NOTIFY_ATTEMPTS },
      ...(companyId ? { companyId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: NOTIFY_SCAN_LIMIT,
  });

  for (const n of stuck) {
    const attempt = n.attempts + 1;
    const outcome = await attemptDelivery({
      notificationId: n.id,
      companyId: n.companyId,
      recipientId: n.recipientId,
      channel: n.channel,
      title: n.title,
      body: n.body,
      attempt,
    });

    await client.inventoryNotification.update({
      where: { id: n.id },
      data: { ...outcome, attempts: attempt },
    });

    if (outcome.state === 'DELIVERED') out.redelivered += 1;
    else if (outcome.state === 'UNDELIVERABLE') out.abandoned += 1;
    else out.deliveryFailures += 1;
  }
};

/* -------------------------------------------------------------- the tick */

const STEPS = [
  ['plans', runPlans],
  ['deliveries', chaseOverdueDeliveries],
  ['batches', chaseExpiringBatches],
  ['openings', chaseOpenedContainers],
  ['notify', notifyUnassigned],
  ['escalate', escalateDue],
  ['redeliver', retryNotifications],
];

// One pass. Returns what it did, including what it failed to do.
//
// `companyId` scopes the whole tick to one tenant and takes its own lease, so
// an owner pressing "run now" in the portal cannot be blocked by, or block,
// another company's scheduled pass.
export const emptyTickResult = (name, now) => ({
  job: name,
  at: now,
  plans: 0,
  requestsRaised: 0,
  reminders: 0,
  notified: 0,
  escalated: 0,
  escalationRecipients: 0,
  redelivered: 0,
  deliveryFailures: 0,
  // Counted apart from deliveryFailures because they mean different things to
  // whoever reads the tick: a failure is something that may yet work, an
  // abandonment is something that will not. A tick reporting 40 failures is a
  // mail server having a bad hour; one reporting 40 abandonments is 40 people
  // whose contact details are wrong.
  abandoned: 0,
  errors: [],
});

export const tickInventory = async (
  client = defaultPrisma,
  { companyId = null, now = new Date(), owner = `${process.pid}-${randomUUID().slice(0, 8)}`, leaseMs = LEASE_MS } = {},
) => {
  const name = companyId ? `${JOB_NAME}:${companyId}` : JOB_NAME;
  const out = emptyTickResult(name, now);

  if (!(await claimLease(client, { name, owner, ttlMs: leaseMs, now }))) {
    // Somebody else is already ticking this job. Not an error and not worth
    // retrying — the holder is about to do exactly the work this call wanted.
    return { ...out, skipped: 'LOCKED' };
  }

  for (const [label, step] of STEPS) {
    try {
      await step(client, { companyId, now }, out);
    } catch (err) {
      out.errors.push(`${label}: ${err?.message ?? err}`);
      logger.error({ err, step: label, job: name }, 'inventory scheduler: step failed');
    }
  }

  await releaseLease(client, {
    name,
    owner,
    ok: out.errors.length === 0,
    error: out.errors[0] ?? null,
    cursorAt: now,
  });
  return out;
};

/* ------------------------------------------------------------ the process */

let timer = null;

// Opt-in, and off by default. Importing the app must not start a timer: a test
// run that ticks a scheduler in the background is a test run whose failures
// depend on how long it took.
export const startInventoryScheduler = ({ intervalMs = MINUTE, client = defaultPrisma } = {}) => {
  if (timer) return timer;
  const run = () => {
    tickInventory(client).catch((err) => logger.error({ err }, 'inventory scheduler: tick threw'));
  };
  timer = setInterval(run, intervalMs);
  // Never the reason the process stays alive.
  timer.unref?.();
  logger.info({ intervalMs }, 'inventory scheduler started');
  return timer;
};

export const stopInventoryScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
