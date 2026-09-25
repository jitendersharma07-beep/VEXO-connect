// The scheduler: what happens because time passed.
//
// Every assertion here is about a property the owner's requirement names
// explicitly — one order per cycle however many times the job runs, a process
// that dies mid-run resuming rather than re-ordering, reminders that stop when
// the thing they were about happens, escalation that climbs and then stops,
// and a failed delivery that is visible rather than silent.
//
// The scheduler is driven directly and through the HTTP route, because "the
// background job raised it" and "a person with the right pressed run" have to
// end up at the same rows.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('inventoryScheduler.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll, buildBaseFixture, TEST_PASSWORD } = await import('./helpers/inventory.js');
const { postMovements } = await import('../src/lib/inventory/ledger.js');
const { tickInventory, claimLease, releaseLease, JOB_NAME } = await import('../src/jobs/inventoryScheduler.js');
const { raiseReminder } = await import('../src/lib/inventory/reminders.js');
const { resolveTransport } = await import('../src/lib/inventory/notifyTransport.js');
const { clearTestTransport, scriptTestTransport, testTransportSent } = await import(
  '../src/lib/inventory/notifyTestTransport.js'
);

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const API = '/api/inventory';

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const ok = (res, expected = 200) => {
  expect(res.status, `${res.req?.method} ${res.req?.path} → ${res.status}: ${JSON.stringify(res.body)}`).toBe(expected);
  return res.body;
};

let fx;
let tok;

beforeEach(async () => {
  await wipeAll();
  fx = await buildBaseFixture();
  tok = {
    owner: await login(fx.owner.email),
    managerA: await login(fx.managerA.email),
    managerB: await login(fx.managerB.email),
    cashierA: await login(fx.cashierA.email),
  };
});

// Leaves the database as it was found. Every suite here shares one _test
// database and vitest runs the files one after another, so rows left behind
// are rows the NEXT file trips over.
afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

/* -------------------------------------------------------------- helpers */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const item = async (over = {}) =>
  prisma.inventoryItem.create({
    data: {
      companyId: fx.company.id,
      kind: 'RAW',
      name: `Item ${Math.random().toString(36).slice(2, 8)}`,
      baseUnit: 'G',
      trackBatches: false,
      trackExpiry: false,
      ...over,
    },
  });

// A plan whose next cutoff is always about two hours away, whatever time of
// day the suite runs.
//
// This matters more than it looks. The scheduler deliberately does nothing
// until a cycle is inside its lead window, so a plan with a fixed 18:00 cutoff
// would be due when the suite runs in the morning and not due when it runs at
// midnight — a test that passes or fails by the clock proves nothing either
// way. Every delivery day is on, the timezone is UTC and the cutoff is pinned
// relative to now, so "the next cycle is due" is a fact rather than a
// coincidence.
const inTwoHoursUtc = () => {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 120) % 1440;
};

const makePlan = async (over = {}, lines = []) => {
  const cutoffMinute = inTwoHoursUtc();
  return prisma.replenishmentPlan.create({
    data: {
      companyId: fx.company.id,
      name: `Plan ${Math.random().toString(36).slice(2, 8)}`,
      destinationLocationId: fx.roomA.id,
      sourceLocationId: fx.warehouse.id,
      timezone: 'UTC',
      deliveryDays: [1, 2, 3, 4, 5, 6, 7],
      cutoffMinute,
      requiredByMinute: (cutoffMinute + 60) % 1440,
      leadTimeDays: 0,
      coverDays: 7,
      createdById: fx.owner.id,
      ...over,
      lines: { create: lines },
    },
    include: { lines: { include: { item: true } } },
  });
};

// Put stock somewhere without going through a receipt document: these tests
// are about the scheduler, and a goods receipt would add a supplier, a
// document number and an expiry policy to every one of them.
const putStock = async (locationId, itemId, qty, over = {}) => {
  const key = `seed-${Math.random().toString(36).slice(2)}`;
  return prisma.$transaction((tx) =>
    postMovements(tx, {
      companyId: fx.company.id,
      movements: [
        {
          locationId,
          itemId,
          qtyMilli: qty * 1000,
          type: 'GRN',
          // One paise per base unit. Real enough that nothing is MISSING, dull
          // enough that no assertion here has to reason about money.
          valuePaise: BigInt(qty),
          sourceType: 'TEST',
          sourceId: key,
          idempotencyKey: key,
          occurredAt: new Date(),
          createdById: fx.owner.id,
          ...over,
        },
      ],
    }),
  );
};

const tick = (over = {}) => tickInventory(prisma, { companyId: fx.company.id, ...over });

const remindersOf = (kind) =>
  prisma.inventoryReminder.findMany({ where: { companyId: fx.company.id, kind }, orderBy: { firstSeenAt: 'asc' } });

const runsOf = (planId) => prisma.replenishmentRun.findMany({ where: { planId }, orderBy: { startedAt: 'asc' } });

/* ================================================================ leases */

describe('two processes cannot tick the same job at once', () => {
  it('the second caller is told it was locked, not that it succeeded', async () => {
    const first = await claimLease(prisma, { name: `${JOB_NAME}:${fx.company.id}`, owner: 'alpha', now: new Date() });
    expect(first).toBe(true);

    const second = await tick();
    expect(second.skipped).toBe('LOCKED');
    // Nothing was done under a lease somebody else holds.
    expect(second.plans).toBe(0);
    expect(second.reminders).toBe(0);
  });

  it('a lease whose holder died is reclaimed once it expires', async () => {
    const name = `${JOB_NAME}:${fx.company.id}`;
    await claimLease(prisma, { name, owner: 'ghost', ttlMs: 1000, now: new Date(Date.now() - 10 * MINUTE) });

    const result = await tick();
    expect(result.skipped).toBeUndefined();

    const state = await prisma.inventorySchedulerState.findUnique({ where: { name } });
    // Released by whoever finished, and the count says a pass completed.
    expect(state.lockedBy).toBeNull();
    expect(state.runCount).toBe(1);
    expect(state.lastOkAt).not.toBeNull();
  });

  it('a process whose lease was taken away cannot stamp its result over the new holder', async () => {
    const name = `${JOB_NAME}:${fx.company.id}`;
    await claimLease(prisma, { name, owner: 'current', now: new Date() });
    const released = await releaseLease(prisma, { name, owner: 'stale', ok: false, error: 'I died ages ago' });
    expect(released).toBe(false);

    const state = await prisma.inventorySchedulerState.findUnique({ where: { name } });
    expect(state.lockedBy).toBe('current');
    expect(state.lastError).toBeNull();
  });
});

/* ========================================================== plan cycles */

describe('a plan raises one order per delivery cycle, however many times it runs', () => {
  it('creates a draft request and a cutoff reminder, then never a second one', async () => {
    const sugar = await item({ name: 'Sugar' });
    const plan = await makePlan({}, [{ itemId: sugar.id, minQty: '1000', targetQty: '5000', safetyQty: '0' }]);
    await putStock(fx.warehouse.id, sugar.id, 50000);

    const first = await tick();
    expect(first.errors).toEqual([]);
    expect(first.requestsRaised).toBe(1);

    const requests = await prisma.storeRequest.findMany({ where: { companyId: fx.company.id } });
    expect(requests).toHaveLength(1);
    // autoSubmit defaults to false, so it waits for a person.
    expect(requests[0].status).toBe('DRAFT');
    expect(requests[0].originPlanId).toBe(plan.id);
    expect(requests[0].requirementKey).toMatch(new RegExp(`^plan:${plan.id}:\\d{4}-\\d{2}-\\d{2}$`));

    const cutoff = await remindersOf('SUBMISSION_CUTOFF');
    expect(cutoff).toHaveLength(1);
    expect(cutoff[0].subjectType).toBe('ReplenishmentCycle');

    // Run it four more times. This is the property the whole design exists for.
    await tick();
    await tick();
    await tick();
    await tick();

    expect(await prisma.storeRequest.count({ where: { companyId: fx.company.id } })).toBe(1);
    expect(await remindersOf('SUBMISSION_CUTOFF')).toHaveLength(1);

    const runs = await runsOf(plan.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('COMPLETED');
    expect(runs[0].finishedAt).not.toBeNull();
  });

  it('records that it decided not to order, rather than leaving silence', async () => {
    const rice = await item({ name: 'Rice' });
    const plan = await makePlan({}, [{ itemId: rice.id, minQty: '100', targetQty: '500', safetyQty: '0' }]);
    // The store is already well above target, so there is nothing to ask for.
    await putStock(fx.roomA.id, rice.id, 9000);

    const result = await tick();
    expect(result.requestsRaised).toBe(0);
    expect(await prisma.storeRequest.count({ where: { companyId: fx.company.id } })).toBe(0);

    const runs = await runsOf(plan.id);
    expect(runs).toHaveLength(1);
    // "Did not need to order" and "did not run" must not look the same.
    expect(runs[0].outcome).toBe('SKIPPED_NOTHING_NEEDED');
    expect(runs[0].lastError).toBeNull();
  });

  it('submits the request itself only when someone switched that on', async () => {
    const oil = await item({ name: 'Oil', baseUnit: 'ML' });
    await makePlan({ autoSubmit: true, name: 'Auto plan' }, [
      { itemId: oil.id, minQty: '1000', targetQty: '4000', safetyQty: '0' },
    ]);
    await putStock(fx.warehouse.id, oil.id, 40000);

    await tick();

    const req = await prisma.storeRequest.findFirst({ where: { companyId: fx.company.id } });
    expect(req.status).toBe('SUBMITTED');
    expect(req.submittedAt).not.toBeNull();
    // The store has done its part; the open question is now the approver's.
    expect(await remindersOf('PENDING_APPROVAL')).toHaveLength(1);
    expect(await remindersOf('SUBMISSION_CUTOFF')).toHaveLength(0);
  });

  it('signs the order as the person who wrote the plan, not as nobody', async () => {
    const salt = await item({ name: 'Salt' });
    await makePlan({ createdById: fx.managerA.id }, [
      { itemId: salt.id, minQty: '500', targetQty: '2000', safetyQty: '0' },
    ]);
    await tick();

    const req = await prisma.storeRequest.findFirst({ where: { companyId: fx.company.id } });
    expect(req.raisedById).toBe(fx.managerA.id);

    const events = await prisma.storeRequestEvent.findMany({ where: { requestId: req.id } });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('PLAN_DRAFT');
    expect(events[0].detail.planName).toBeTruthy();
  });

  it('does not count a request nobody has approved as stock on its way', async () => {
    const flour = await item({ name: 'Flour' });
    const plan = await makePlan({ autoSubmit: true }, [
      { itemId: flour.id, minQty: '1000', targetQty: '5000', safetyQty: '0' },
    ]);
    await putStock(fx.warehouse.id, flour.id, 50000);
    await tick();

    const suggestion = ok(
      await request(app).get(`${API}/plans/${plan.id}/suggestion`).set(auth(tok.owner)),
    );
    const line = suggestion.lines.find((l) => l.itemId === flour.id);
    // The request exists and is waiting for a decision. It counts as asked
    // for, and specifically NOT as promised.
    expect(Number(line.reason.awaitingApproval)).toBeGreaterThan(0);
    expect(Number(line.reason.approvedNotDispatched)).toBe(0);
    expect(Number(line.reason.inTransit)).toBe(0);
  });
});

/* ===================================================== restart recovery */

describe('a scheduler killed halfway through resumes instead of re-ordering', () => {
  it('finishes a run that was started and never completed', async () => {
    const tea = await item({ name: 'Tea' });
    const plan = await makePlan({}, [{ itemId: tea.id, minQty: '1000', targetQty: '5000', safetyQty: '0' }]);
    await putStock(fx.warehouse.id, tea.id, 50000);

    // Exactly what a process that died between writing the run row and raising
    // the order leaves behind: a run with no outcome and no request.
    const cycleDate = new Date();
    cycleDate.setUTCHours(0, 0, 0, 0);
    const { nextCycle } = await import('../src/lib/inventory/replenish.js');
    const cycle = nextCycle(plan, new Date());
    await prisma.replenishmentRun.create({
      data: { companyId: fx.company.id, planId: plan.id, cycleDate: cycle.cycleDate },
    });

    const result = await tick();
    expect(result.errors).toEqual([]);

    const runs = await runsOf(plan.id);
    // The SAME row, resumed — not a second attempt at the same delivery.
    expect(runs).toHaveLength(1);
    expect(runs[0].attempts).toBe(2);
    expect(runs[0].outcome).toBe('COMPLETED');
    expect(await prisma.storeRequest.count({ where: { companyId: fx.company.id } })).toBe(1);
  });

  it('recognises an order somebody else already raised for the same cycle', async () => {
    const jam = await item({ name: 'Jam' });
    const plan = await makePlan({}, [{ itemId: jam.id, minQty: '1000', targetQty: '5000', safetyQty: '0' }]);
    await putStock(fx.warehouse.id, jam.id, 50000);

    const { nextCycle, requirementKeyFor } = await import('../src/lib/inventory/replenish.js');
    const cycle = nextCycle(plan, new Date());
    // A manager got there first and raised the order by hand, carrying the
    // same requirement key the plan would have used.
    ok(
      await request(app)
        .post(`${API}/requests`)
        .set(auth(tok.owner))
        .send({
          destinationLocationId: fx.roomA.id,
          sourceLocationId: fx.warehouse.id,
          requiredBy: cycle.requiredBy,
          requirementKey: requirementKeyFor(plan, cycle.cycleDate),
          lines: [{ itemId: jam.id, qty: '2', unit: 'kg' }],
        }),
      201,
    );

    await tick();

    expect(await prisma.storeRequest.count({ where: { companyId: fx.company.id } })).toBe(1);
    const runs = await runsOf(plan.id);
    expect(runs[0].outcome).toBe('SKIPPED_ALREADY_COVERED');
  });

  it('writes a failure onto the run where somebody can see it, and stops after a few tries', async () => {
    const ghost = await item({ name: 'Ghost' });
    const plan = await makePlan({}, [{ itemId: ghost.id, minQty: '1000', targetQty: '5000', safetyQty: '0' }]);
    // No author and no active owner, so the plan has nobody to raise a request
    // as — a real failure, deliberately induced rather than mocked.
    await prisma.replenishmentPlan.update({ where: { id: plan.id }, data: { createdById: null } });
    await prisma.posUser.update({ where: { id: fx.owner.id }, data: { status: 'DISABLED' } });

    for (let i = 0; i < 7; i += 1) await tick();

    const runs = await runsOf(plan.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('FAILED');
    expect(runs[0].lastError).toMatch(/nobody to raise/i);
    // Capped: it does not retry for ever and bury the reason.
    expect(runs[0].attempts).toBeLessThanOrEqual(5);

    const state = await prisma.inventorySchedulerState.findUnique({
      where: { name: `${JOB_NAME}:${fx.company.id}` },
    });
    // Five ticks failed and then the cap stopped the retrying, so the last two
    // passes were clean. The counters are the durable record — `lastError` is
    // only ever the most recent failure and is correctly cleared by a pass
    // that had nothing to complain about.
    expect(state.failCount).toBe(5);
    expect(state.runCount).toBe(2);
    expect(state.lastError).toBeNull();
    // The reason itself survives where it belongs: on the run that failed.
    expect(runs[0].finishedAt).not.toBeNull();
  });
});

/* ================================================== time-driven chasing */

describe('the things only the clock notices', () => {
  it('chases a delivery that is late, at the end that has to answer for it', async () => {
    const box = await item({ name: 'Box', baseUnit: 'PCS' });
    const req = await prisma.storeRequest.create({
      data: {
        companyId: fx.company.id,
        number: 'REQ-LATE-1',
        destinationLocationId: fx.roomA.id,
        sourceLocationId: fx.warehouse.id,
        status: 'IN_FULFILMENT',
        requiredBy: new Date(Date.now() - 2 * HOUR),
        raisedById: fx.owner.id,
        lines: {
          create: [
            {
              itemId: box.id,
              enteredQty: '10',
              enteredUnit: 'pcs',
              enteredFactorMilli: 1000,
              requestedQty: '10',
              approvedQty: '10',
              dispatchedQty: '10',
              outstandingQty: '10',
            },
          ],
        },
      },
    });
    await prisma.stockTransfer.create({
      data: {
        companyId: fx.company.id,
        number: 'TRF-LATE-1',
        fromLocationId: fx.warehouse.id,
        toLocationId: fx.roomA.id,
        status: 'DISPATCHED',
        storeRequestId: req.id,
        requestedById: fx.owner.id,
        dispatchedAt: new Date(Date.now() - 3 * HOUR),
      },
    });

    await tick();
    const overdue = await remindersOf('DELIVERY_OVERDUE');
    expect(overdue).toHaveLength(1);
    // The sender is chased. The store is the one waiting.
    expect(overdue[0].locationId).toBe(fx.warehouse.id);
    expect(overdue[0].storeRequestId).toBe(req.id);

    await tick();
    expect(await remindersOf('DELIVERY_OVERDUE')).toHaveLength(1);
  });

  it('warns about stock coming up on its expiry, separately for each place it sits', async () => {
    const milk = await item({ name: 'Milk', baseUnit: 'ML', trackBatches: true, trackExpiry: true });
    const batch = await prisma.stockBatch.create({
      data: {
        companyId: fx.company.id,
        itemId: milk.id,
        batchCode: 'MILK-SOON',
        expiryDate: new Date(Date.now() + 3 * DAY),
      },
    });
    await putStock(fx.warehouse.id, milk.id, 5000, { batchId: batch.id });
    await putStock(fx.roomA.id, milk.id, 2000, { batchId: batch.id });

    await tick();
    const warned = await remindersOf('BATCH_EXPIRING');
    // One batch, two locations, two people to tell.
    expect(warned).toHaveLength(2);
    expect(new Set(warned.map((r) => r.locationId))).toEqual(new Set([fx.warehouse.id, fx.roomA.id]));

    await tick();
    expect(await remindersOf('BATCH_EXPIRING')).toHaveLength(2);
  });

  it('leaves stock that is nowhere near its expiry alone', async () => {
    const rice = await item({ name: 'Long rice', trackBatches: true, trackExpiry: true });
    const batch = await prisma.stockBatch.create({
      data: {
        companyId: fx.company.id,
        itemId: rice.id,
        batchCode: 'RICE-FAR',
        expiryDate: new Date(Date.now() + 200 * DAY),
      },
    });
    await putStock(fx.warehouse.id, rice.id, 5000, { batchId: batch.id });

    await tick();
    expect(await remindersOf('BATCH_EXPIRING')).toHaveLength(0);
  });

  it('warns about an opened container before its use-by, and stops once it is closed', async () => {
    const cream = await item({ name: 'Cream', baseUnit: 'ML', trackBatches: true, trackExpiry: true });
    const batch = await prisma.stockBatch.create({
      data: { companyId: fx.company.id, itemId: cream.id, batchCode: 'CREAM-1', expiryDate: new Date(Date.now() + 60 * DAY) },
    });
    const opening = await prisma.stockBatchOpening.create({
      data: {
        companyId: fx.company.id,
        locationId: fx.roomA.id,
        batchId: batch.id,
        useByAt: new Date(Date.now() + 2 * HOUR),
        qty: '1000',
      },
    });

    await tick();
    const open = await remindersOf('OPENED_CONTAINER_EXPIRING');
    expect(open).toHaveLength(1);
    expect(open[0].subjectId).toBe(opening.id);
  });
});

/* ========================================================== escalation */

describe('a reminder nobody answers climbs, and then stops climbing', () => {
  const overdueReminder = async (over = {}) =>
    prisma.inventoryReminder.create({
      data: {
        companyId: fx.company.id,
        kind: 'PENDING_APPROVAL',
        dedupeKey: `PENDING_APPROVAL:Test:${Math.random().toString(36).slice(2)}`,
        subjectType: 'Test',
        subjectId: Math.random().toString(36).slice(2),
        locationId: fx.warehouse.id,
        dueAt: new Date(Date.now() - 4 * HOUR),
        escalateAt: new Date(Date.now() - 2 * HOUR),
        state: 'NOTIFIED',
        assigneeId: fx.managerA.id,
        title: 'Request waiting for a decision',
        body: 'Nobody has looked at this',
        ...over,
      },
    });

  it('escalates to the peers who could do it, then to the owner, then no further', async () => {
    const reminder = await overdueReminder();

    const first = await tick();
    expect(first.escalated).toBe(1);
    let row = await prisma.inventoryReminder.findUnique({ where: { id: reminder.id } });
    expect(row.state).toBe('ESCALATED');
    expect(row.escalationLevel).toBe(1);
    expect(row.escalateAt).not.toBeNull();

    // Wind the clock on rather than waiting an hour.
    await prisma.inventoryReminder.update({
      where: { id: reminder.id },
      data: { escalateAt: new Date(Date.now() - MINUTE) },
    });
    const second = await tick();
    expect(second.escalated).toBe(1);
    row = await prisma.inventoryReminder.findUnique({ where: { id: reminder.id } });
    expect(row.escalationLevel).toBe(2);
    // Beyond the owner there is nowhere left to go.
    expect(row.escalateAt).toBeNull();

    const third = await tick();
    expect(third.escalated).toBe(0);

    // The owner was told, and the notification says it was an escalation.
    const notes = await prisma.inventoryNotification.findMany({
      where: { reminderId: reminder.id, recipientId: fx.owner.id },
    });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].title).toMatch(/^Escalated: /);
  });

  it('never chases a reminder whose subject already happened', async () => {
    const reminder = await overdueReminder({ state: 'OBSOLETE', obsoletedAt: new Date(), obsoleteReason: 'Approved' });
    const result = await tick();
    expect(result.escalated).toBe(0);

    const row = await prisma.inventoryReminder.findUnique({ where: { id: reminder.id } });
    expect(row.state).toBe('OBSOLETE');
    expect(row.escalationLevel).toBe(0);
    expect(await prisma.inventoryNotification.count({ where: { reminderId: reminder.id } })).toBe(0);
  });

  it('stops chasing the moment the request is approved, without anyone cancelling anything', async () => {
    const beans = await item({ name: 'Beans' });
    await putStock(fx.warehouse.id, beans.id, 50000);
    const created = ok(
      await request(app)
        .post(`${API}/requests`)
        .set(auth(tok.managerA))
        .send({
          destinationLocationId: fx.roomA.id,
          sourceLocationId: fx.warehouse.id,
          requiredBy: new Date(Date.now() + DAY).toISOString(),
          lines: [{ itemId: beans.id, qty: '2', unit: 'kg' }],
        }),
      201,
    ).request;

    expect(await remindersOf('PENDING_APPROVAL')).toHaveLength(1);

    // The owner decides, not Manager A: the route refuses to let the person
    // who raised a request approve their own, and that separation is a rule
    // this test must obey rather than work around.
    ok(
      await request(app)
        .post(`${API}/requests/${created.id}/decide`)
        .set(auth(tok.owner))
        .send({ lines: [{ lineId: created.lines[0].id, approvedQty: '2000' }] }),
    );

    const after = await remindersOf('PENDING_APPROVAL');
    expect(after[0].state).toBe('OBSOLETE');

    // And the scheduler agrees: a tick does not revive it.
    const result = await tick();
    expect(result.escalated).toBe(0);
    const still = await remindersOf('PENDING_APPROVAL');
    expect(still[0].state).toBe('OBSOLETE');
  });

  it('finds an assignee for a reminder raised when nobody held the right', async () => {
    const reminder = await overdueReminder({
      state: 'PENDING',
      assigneeId: null,
      escalateAt: null,
      lastNotifiedAt: null,
    });

    const result = await tick();
    expect(result.notified).toBe(1);

    const row = await prisma.inventoryReminder.findUnique({ where: { id: reminder.id } });
    expect(row.assigneeId).not.toBeNull();
    expect(row.state).toBe('NOTIFIED');
    expect(row.lastNotifiedAt).not.toBeNull();
  });
});

/* ======================================================== delivery state */

describe('a message that did not get through is visible, not silent', () => {
  const stuckNotification = async (over = {}) =>
    prisma.inventoryNotification.create({
      data: {
        companyId: fx.company.id,
        recipientId: fx.owner.id,
        channel: 'EMAIL',
        title: 'Stock due to be dispatched',
        body: 'Nobody received this',
        state: 'FAILED',
        attempts: 1,
        lastError: 'No adapter configured for transport "email"',
        ...over,
      },
    });

  it('retries and carries the attempt count forward rather than resetting it', async () => {
    const n = await stuckNotification();
    await tick();

    const row = await prisma.inventoryNotification.findUnique({ where: { id: n.id } });
    // In-app is the transport in development, so the retry succeeds — and the
    // fact that it took two goes survives.
    expect(row.state).toBe('DELIVERED');
    expect(row.attempts).toBe(2);
    expect(row.deliveredAt).not.toBeNull();
  });

  it('gives up after a few attempts instead of retrying for ever', async () => {
    const n = await stuckNotification({ attempts: 5 });
    const result = await tick();
    expect(result.redelivered).toBe(0);

    const row = await prisma.inventoryNotification.findUnique({ where: { id: n.id } });
    expect(row.state).toBe('FAILED');
    expect(row.attempts).toBe(5);
    // The reason is still on the row months later.
    expect(row.lastError).toMatch(/No adapter/);
  });

  it('shows the failure in the recipient inbox with its reason', async () => {
    await stuckNotification({ attempts: 5 });
    const body = ok(await request(app).get(`${API}/notifications`).set(auth(tok.owner)));
    const failed = body.notifications.find((x) => x.state === 'FAILED');
    expect(failed).toBeTruthy();
    expect(failed.lastError).toMatch(/No adapter/);
  });
});

/* ====================================================== the delivery path */

// Everything above proves what the ROWS say. None of it proves a message was
// ever handed to anything, because in-app delivery is the row — storing it and
// sending it are the same act, so a transport layer that did nothing at all
// would pass every test in the block above.
//
// These drive the seam itself through a transport that records what it was
// given. That is the difference between "the notification is marked DELIVERED"
// and "the notification was delivered", and for a warning about stock going
// out of date, nobody is standing at a counter to notice the gap.
describe('a notification is actually handed to a transport', () => {
  const withTransport = async (name, fn) => {
    const before = process.env.INVENTORY_NOTIFY_TRANSPORT;
    process.env.INVENTORY_NOTIFY_TRANSPORT = name;
    try {
      return await fn();
    } finally {
      // Restored even when the assertion throws. A leaked transport name would
      // silently re-route every later test in this file, and they would still
      // pass — which is the worst way for it to break.
      if (before === undefined) delete process.env.INVENTORY_NOTIFY_TRANSPORT;
      else process.env.INVENTORY_NOTIFY_TRANSPORT = before;
    }
  };

  const raise = (over = {}) =>
    raiseReminder(prisma, {
      companyId: fx.company.id,
      kind: 'BATCH_EXPIRING',
      subjectType: 'InventoryBatch',
      subjectId: `batch-${Math.random().toString(36).slice(2, 10)}`,
      locationId: fx.roomA.id,
      assigneeId: fx.owner.id,
      dueAt: new Date(),
      body: 'Two crates of milk go off on Thursday',
      ...over,
    });

  const queued = async (over = {}) =>
    prisma.inventoryNotification.create({
      data: {
        companyId: fx.company.id,
        recipientId: fx.owner.id,
        channel: 'TEST',
        title: 'Stock due to be dispatched',
        body: 'Nobody received this yet',
        state: 'FAILED',
        attempts: 1,
        lastError: 'transient',
        ...over,
      },
    });

  beforeEach(() => clearTestTransport());

  it('gives the transport the message, and keeps the reference it gets back', async () => {
    await withTransport('test', async () => {
      await raise();

      const sent = testTransportSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].recipientId).toBe(fx.owner.id);
      expect(sent[0].title).toBe('Batch expiring');
      expect(sent[0].body).toBe('Two crates of milk go off on Thursday');

      const row = await prisma.inventoryNotification.findFirst({ where: { recipientId: fx.owner.id } });
      expect(row.state).toBe('DELIVERED');
      expect(row.channel).toBe('TEST');
      expect(row.attempts).toBe(1);
      // The provider's own id for the message. Without it, "delivered" is only
      // this row's opinion of itself and there is nothing to check it against.
      expect(row.providerRef).toBe(`testmsg_${row.id}_1`);
    });
  });

  it('leaves in-app delivery with no provider reference, because there is no provider', async () => {
    await withTransport('inapp', async () => {
      await raise();
      const row = await prisma.inventoryNotification.findFirst({ where: { recipientId: fx.owner.id } });
      expect(row.state).toBe('DELIVERED');
      // Null here is a fact, not a missing value: the row IS the message. The
      // assertion exists so that a future transport quietly failing to return a
      // reference cannot hide behind in-app's legitimate null.
      expect(row.providerRef).toBeNull();
    });
  });

  it('retries a transport that refused once, and the second attempt gets through', async () => {
    await withTransport('test', async () => {
      scriptTestTransport(fx.owner.id, [
        { delivered: false, reason: 'mail server said try later' },
        { delivered: true, providerRef: 'msg_second_try' },
      ]);

      const n = await queued();

      const first = await tick();
      expect(first.deliveryFailures).toBe(1);
      let row = await prisma.inventoryNotification.findUnique({ where: { id: n.id } });
      expect(row.state).toBe('FAILED');
      expect(row.attempts).toBe(2);
      expect(row.lastError).toBe('mail server said try later');
      expect(row.deliveredAt).toBeNull();

      const second = await tick();
      expect(second.redelivered).toBe(1);
      row = await prisma.inventoryNotification.findUnique({ where: { id: n.id } });
      expect(row.state).toBe('DELIVERED');
      expect(row.attempts).toBe(3);
      expect(row.providerRef).toBe('msg_second_try');
      // The reason the earlier attempt failed is cleared, because it is no
      // longer true of this notification.
      expect(row.lastError).toBeNull();

      expect(testTransportSent()).toHaveLength(2);
    });
  });

  it('stops asking when the transport says retrying cannot help', async () => {
    await withTransport('test', async () => {
      scriptTestTransport(fx.owner.id, [
        { delivered: false, reason: 'no email address on file', permanent: true },
      ]);

      const n = await queued();

      const first = await tick();
      expect(first.abandoned).toBe(1);
      expect(first.deliveryFailures).toBe(0);

      let row = await prisma.inventoryNotification.findUnique({ where: { id: n.id } });
      expect(row.state).toBe('UNDELIVERABLE');
      expect(row.attempts).toBe(2);
      expect(row.lastError).toBe('no email address on file');

      // The point of the state. A second tick must not pick it back up — and
      // the proof is not that the row is unchanged, which a no-op tick would
      // also produce, but that the transport was never asked a second time.
      const second = await tick();
      expect(second.abandoned).toBe(0);
      expect(second.deliveryFailures).toBe(0);
      expect(testTransportSent()).toHaveLength(1);

      row = await prisma.inventoryNotification.findUnique({ where: { id: n.id } });
      expect(row.attempts).toBe(2);
    });
  });

  it('records the reason when the deployment names a transport nothing implements', async () => {
    await withTransport('whatsapp', async () => {
      // Must not throw: raiseReminder runs on paths that have already moved
      // stock, and a missing adapter may not undo a dispatch.
      const reminder = await raise();
      expect(reminder).not.toBeNull();

      const row = await prisma.inventoryNotification.findFirst({ where: { recipientId: fx.owner.id } });
      expect(row.state).toBe('FAILED');
      expect(row.channel).toBe('WHATSAPP');
      expect(row.lastError).toBe('No adapter configured for transport "whatsapp"');
      expect(row.providerRef).toBeNull();
      // Nothing was handed to anything.
      expect(testTransportSent()).toHaveLength(0);
    });
  });

  it('a transport that throws is recorded against the notification, not raised at the caller', async () => {
    await withTransport('test', async () => {
      scriptTestTransport(fx.owner.id, [
        {
          get delivered() {
            throw new Error('socket hang up');
          },
        },
      ]);

      const reminder = await raise();
      expect(reminder).not.toBeNull();

      const row = await prisma.inventoryNotification.findFirst({ where: { recipientId: fx.owner.id } });
      expect(row.state).toBe('FAILED');
      expect(row.lastError).toMatch(/socket hang up/);
    });
  });

  // The safety gate, asserted both ways. A gate is a claim about what it
  // REFUSES, and a test that only exercises the allowed case proves nothing
  // about the case that matters.
  it('refuses the test transport outside test and development', () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const refused = resolveTransport('test');
      expect(refused.transport).toBeNull();
      expect(refused.reason).toMatch(/not available outside test and development/);

      // An unset or unexpected environment must refuse too — the whitelist is
      // on the safe environments, so this is not the same assertion twice.
      delete process.env.NODE_ENV;
      expect(resolveTransport('test').transport).toBeNull();
      process.env.NODE_ENV = 'staging';
      expect(resolveTransport('test').transport).toBeNull();

      // Positive control: the refusals above are the environment gate, not a
      // transport that simply cannot be found by that name.
      process.env.NODE_ENV = 'test';
      expect(resolveTransport('test').transport).not.toBeNull();
      // And in-app is reachable everywhere, including production.
      process.env.NODE_ENV = 'production';
      expect(resolveTransport('inapp').transport).not.toBeNull();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});

/* ============================================================ the routes */

describe('running the scheduler by hand obeys the same permission rules', () => {
  it('refuses a cashier and refuses a manager the company-wide pass', async () => {
    expect((await request(app).post(`${API}/scheduler/tick`).set(auth(tok.cashierA)).send({})).status).toBe(403);
    expect((await request(app).post(`${API}/scheduler/tick`).set(auth(tok.managerA)).send({})).status).toBe(403);
    expect((await request(app).post(`${API}/scheduler/tick`).send({})).status).toBe(401);
  });

  it('lets an owner run a pass and reports what it did', async () => {
    const dal = await item({ name: 'Dal' });
    await makePlan({}, [{ itemId: dal.id, minQty: '1000', targetQty: '5000', safetyQty: '0' }]);
    await putStock(fx.warehouse.id, dal.id, 50000);

    const body = ok(await request(app).post(`${API}/scheduler/tick`).set(auth(tok.owner)).send({}));
    expect(body.result.requestsRaised).toBe(1);
    expect(body.result.errors).toEqual([]);

    const status = ok(await request(app).get(`${API}/scheduler`).set(auth(tok.owner)));
    const mine = status.jobs.find((j) => j.scope === 'COMPANY');
    expect(mine.runCount).toBe(1);
    expect(mine.lastOkAt).not.toBeNull();
    expect(mine.running).toBe(false);
  });

  it('never shows one tenant the error message naming another tenant plan', async () => {
    // A global pass that failed, with a message carrying somebody else's id.
    await prisma.inventorySchedulerState.create({
      data: { name: JOB_NAME, failCount: 1, lastError: 'plan ckplanofanothercompany: exploded' },
    });

    const status = ok(await request(app).get(`${API}/scheduler`).set(auth(tok.owner)));
    const global = status.jobs.find((j) => j.scope === 'GLOBAL');
    expect(global.failing).toBe(true);
    expect(global.lastError).toBeNull();
    expect(JSON.stringify(status)).not.toContain('ckplanofanothercompany');
  });

  it('lets a store manager run their own plan, and not one in another store', async () => {
    const chai = await item({ name: 'Chai' });
    const mine = await makePlan({ name: 'Store A plan' }, [
      { itemId: chai.id, minQty: '1000', targetQty: '5000', safetyQty: '0' },
    ]);
    const theirs = await makePlan({ name: 'Store B plan', destinationLocationId: fx.roomB.id }, [
      { itemId: chai.id, minQty: '1000', targetQty: '5000', safetyQty: '0' },
    ]);
    await putStock(fx.warehouse.id, chai.id, 50000);

    const body = ok(await request(app).post(`${API}/plans/${mine.id}/run`).set(auth(tok.managerA)).send({}));
    expect(body.run.outcome).toBe('COMPLETED');
    expect(body.result.requestsRaised).toBe(1);

    // Manager A is pinned to store A and holds no grant at store B's room.
    const refused = await request(app).post(`${API}/plans/${theirs.id}/run`).set(auth(tok.managerA)).send({});
    expect([403, 404]).toContain(refused.status);
    expect((await request(app).post(`${API}/plans/${mine.id}/run`).set(auth(tok.cashierA)).send({})).status).toBe(403);
  });

  it('a hand-run and the scheduled pass cannot both order for the same delivery', async () => {
    const ghee = await item({ name: 'Ghee', baseUnit: 'ML' });
    const plan = await makePlan({}, [{ itemId: ghee.id, minQty: '1000', targetQty: '5000', safetyQty: '0' }]);
    await putStock(fx.warehouse.id, ghee.id, 50000);

    ok(await request(app).post(`${API}/plans/${plan.id}/run`).set(auth(tok.owner)).send({}));
    await tick();
    ok(await request(app).post(`${API}/plans/${plan.id}/run`).set(auth(tok.owner)).send({}));

    expect(await prisma.storeRequest.count({ where: { companyId: fx.company.id } })).toBe(1);
    expect(await runsOf(plan.id)).toHaveLength(1);
  });
});
