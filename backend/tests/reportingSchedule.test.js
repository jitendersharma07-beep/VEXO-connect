// LANE reporting — scheduled delivery, over HTTP and at the boundaries.
//
// A schedule is the only part of this lane that acts with nobody watching, so
// the things asserted here are the ones nobody would notice going wrong:
//
//   EXACTLY ONCE. Two runs of the same period produce one delivery. Proved by
//   pressing /run twice and by ticking after a run, because a retry, a double
//   tick and an impatient owner are the same event to the database.
//
//   REACH AT SEND TIME. A schedule's authority is re-resolved from stored state
//   every run. The tests that matter are the ones where the owner has since been
//   demoted or disabled: the screen would refuse them, and so must the timer.
//
//   HONEST STATUS. Nothing may read SENT unless something was written. A build
//   with no mail transport records what it withheld, and a run that could not
//   produce anything records SKIPPED with the sentence explaining why — never
//   FAILED, which invites retries that can never succeed.
//
// Runs ONLY against a database whose name ends in _test — this suite truncates.

import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('reportingSchedule.test.js requires a DATABASE_URL ending in _test');
}

// Set before the app is imported: config/env.js freezes its view of the
// environment at module load, so a spool directory assigned afterwards would be
// ignored and the suite would write artifacts into the repository.
const SPOOL = mkdtempSync(path.join(tmpdir(), 'reporting-spool-test-'));
process.env.REPORTING_SPOOL_DIR = SPOOL;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { lastFiringDate, runKeyOf, tick } = await import('../src/lib/reporting/schedule.js');
const { partitionRecipients } = await import('../src/lib/reporting/delivery.js');
const { actionsFor } = await import('../src/api/routes/reporting.js');

const app = createApp();

const PW = 'reporting-password-1';
const DAY = 86400e3;

let companyA, companyB;
let a1, a2, b1;
let ownerAId, financeA1Id;
const tokens = {};
const recipients = {};

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const post = (p, token, body) => request(app).post(p).set(auth(token)).send(body ?? {});
const get = (p, token) => request(app).get(p).set(auth(token));

// A settled bill on a given store, dated inside yesterday's business day so the
// DAILY cadence — which always reports a COMPLETED period — has rows to render.
const bill = async ({ branchId, companyId, billedAt, subtotal, productId, openedById }) => {
  const order = await prisma.order.create({
    data: {
      companyId,
      branchId,
      type: 'DINE_IN',
      status: 'PAID',
      openedById: openedById ?? ownerAId,
      billedAt,
      subtotal: subtotal / 100,
      discountAmount: 0,
      taxAmount: 0,
      total: subtotal / 100,
      items: {
        create: [
          {
            productId,
            name: 'Filter Coffee',
            qty: 1,
            unitPrice: subtotal / 100,
            lineDiscount: 0,
            lineSubtotal: subtotal / 100,
            discountShare: 0,
            lineTax: 0,
            lineTotal: subtotal / 100,
            status: 'ACTIVE',
          },
        ],
      },
    },
  });
  await prisma.payment.create({
    data: {
      orderId: order.id,
      branchId,
      method: 'CASH',
      amount: subtotal / 100,
      receivedById: openedById ?? ownerAId,
      createdAt: billedAt,
    },
  });
  return order;
};

const yesterdayAfternoon = () => new Date(Date.now() - DAY + 6 * 3600e3);

// A schedule that has always already fired today, whatever hour the gate runs at.
// sendAtMinutes 0 removes the one thing about these tests that would otherwise
// depend on the clock: a suite that passes in the morning and fails after
// midnight is worse than no suite.
const SEND_AT_MIDNIGHT = 0;

const makeSchedule = async (token, overrides = {}) => {
  const res = await post('/api/reporting/schedules', token, {
    name: 'Daily sales',
    reportKey: 'sales',
    cadence: 'DAILY',
    format: 'CSV',
    sendAtMinutes: SEND_AT_MIDNIGHT,
    recipientIds: [recipients.test.id],
    ...overrides,
  });
  expect(res.status, `create schedule: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body;
};

const activate = async (token, id) => {
  const res = await post(`/api/reporting/schedules/${id}/state`, token, { state: 'ACTIVE' });
  expect(res.status, `activate: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Schedule Alpha',
      slug: 'schedule-alpha',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 5, expiresAt: new Date(Date.now() + DAY) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Schedule Bravo',
      slug: 'schedule-bravo',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + DAY) },
      },
    },
  });

  // SC = schedule; no other suite uses this publicId prefix.
  a1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SC-0001', name: 'Sched One', code: 'SC1' },
  });
  a2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SC-0002', name: 'Sched Two', code: 'SC2' },
  });
  b1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-SC-0003', name: 'Bravo Store', code: 'SC3' },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  const ownerA = await mk({
    email: 'owner.a@schedule.test.local',
    fullName: 'Owner A',
    role: 'CUSTOMER_OWNER',
    companyId: companyA.id,
  });
  ownerAId = ownerA.id;
  // The principal both store-narrowing tests need: somebody who may write a
  // schedule and whose reach is one store. No default role is both — FINANCE
  // holds report.schedule.write and reaches the whole company, BRANCH_MANAGER
  // reaches one store and holds no schedule action — and a rule cannot widen a
  // role, only narrow it. So the reach is narrowed instead, with an assignment
  // row, which is how a real deployment gives Finance one outlet.
  const financeA1 = await mk({
    email: 'finance.a1@schedule.test.local',
    fullName: 'Finance A1',
    role: 'FINANCE',
    companyId: companyA.id,
  });
  financeA1Id = financeA1.id;
  await prisma.userStoreAssignment.create({
    data: { userId: financeA1.id, companyId: companyA.id, branchId: a1.id },
  });
  // And one report withdrawn from them, so "you cannot schedule what you cannot
  // read" is testable at all: every role that can write a schedule can otherwise
  // read every report.
  await prisma.permissionRule.create({
    data: {
      companyId: companyA.id,
      level: 'USER',
      userId: financeA1.id,
      scopeKey: `user:${financeA1.id}`,
      action: 'report.inventory.read',
      effect: 'DENY',
      note: 'Test fixture: proves the schedule route checks the report’s own action.',
    },
  });
  // Demoted mid-suite to prove the send-time authority re-check. Given its own
  // account so no other test depends on its role staying put.
  await mk({
    email: 'demote.a@schedule.test.local',
    fullName: 'Demote A',
    role: 'CUSTOMER_OWNER',
    companyId: companyA.id,
  });
  // Disabled mid-suite, same reasoning.
  await mk({
    email: 'disable.a@schedule.test.local',
    fullName: 'Disable A',
    role: 'CUSTOMER_OWNER',
    companyId: companyA.id,
  });
  await mk({
    email: 'auditor.a@schedule.test.local',
    fullName: 'Auditor A',
    role: 'AUDITOR',
    companyId: companyA.id,
  });
  const ownerB = await mk({
    email: 'owner.b@schedule.test.local',
    fullName: 'Owner B',
    role: 'CUSTOMER_OWNER',
    companyId: companyB.id,
  });

  const cat = await prisma.category.create({ data: { companyId: companyA.id, name: 'Drinks' } });
  const coffee = await prisma.product.create({
    data: {
      companyId: companyA.id,
      categoryId: cat.id,
      name: 'Filter Coffee',
      sku: 'SC-SKU-COFFEE',
      basePrice: 50,
    },
  });
  const catB = await prisma.category.create({ data: { companyId: companyB.id, name: 'Drinks' } });
  const coffeeB = await prisma.product.create({
    data: {
      companyId: companyB.id,
      categoryId: catB.id,
      name: 'Bravo Coffee',
      sku: 'SC-SKU-BRAVO',
      basePrice: 50,
    },
  });

  const at = yesterdayAfternoon();
  await bill({ companyId: companyA.id, branchId: a1.id, billedAt: at, subtotal: 120000, productId: coffee.id });
  await bill({ companyId: companyA.id, branchId: a2.id, billedAt: at, subtotal: 80000, productId: coffee.id });
  await bill({
    companyId: companyB.id,
    branchId: b1.id,
    billedAt: at,
    subtotal: 999999,
    productId: coffeeB.id,
    openedById: ownerB.id,
  });

  tokens.ownerA = await login('owner.a@schedule.test.local');
  tokens.financeA1 = await login('finance.a1@schedule.test.local');
  tokens.demoteA = await login('demote.a@schedule.test.local');
  tokens.disableA = await login('disable.a@schedule.test.local');
  tokens.auditorA = await login('auditor.a@schedule.test.local');
  tokens.ownerB = await login('owner.b@schedule.test.local');

  // Two approved addresses: one this build may write to, one it may not. Every
  // withholding assertion below rests on the pair existing.
  const test = await post('/api/reporting/recipients', tokens.ownerA, {
    email: 'reports-test@schedule.test.local',
    label: 'Deployment test address',
    isTestAddress: true,
  });
  expect(test.status, JSON.stringify(test.body)).toBe(201);
  recipients.test = test.body;

  const real = await post('/api/reporting/recipients', tokens.ownerA, {
    email: 'finance-director@schedule.test.local',
    label: 'Finance director',
  });
  expect(real.status, JSON.stringify(real.body)).toBe(201);
  recipients.real = real.body;
});

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Firing times. Pure functions, fixed dates — the one part of scheduling that
// can be asserted without a database and the part most likely to be wrong.
// ---------------------------------------------------------------------------

describe('reporting schedules: when a schedule fires', () => {
  const tz = 'Asia/Kolkata';
  // 2026-02-18 is a Wednesday (weekday 3). 09:30 IST = 04:00 UTC.
  const wedMorning = new Date('2026-02-18T04:00:00.000Z');

  it('a daily schedule fires today once its send time has passed, and yesterday before', () => {
    const base = { cadence: 'DAILY', timezone: tz };
    expect(lastFiringDate({ schedule: { ...base, sendAtMinutes: 8 * 60 }, now: wedMorning })).toBe(
      '2026-02-18',
    );
    expect(lastFiringDate({ schedule: { ...base, sendAtMinutes: 11 * 60 }, now: wedMorning })).toBe(
      '2026-02-17',
    );
  });

  it('weekday 0 means Sunday — the numbering weekStartDay and weekdayOf already use', () => {
    // The defect this pins: the column was documented as ISO 1..7 while every
    // other weekday in the lane is 0..6. Under ISO, "weekday 0" is nothing and
    // "weekday 1" is Monday; under this convention 1 IS Monday and 0 is the
    // Sunday before it. Asserting both arms is what makes the two readings
    // distinguishable.
    const base = { cadence: 'WEEKLY', timezone: tz, sendAtMinutes: 8 * 60 };
    expect(lastFiringDate({ schedule: { ...base, weekday: 0 }, now: wedMorning })).toBe('2026-02-15');
    expect(lastFiringDate({ schedule: { ...base, weekday: 1 }, now: wedMorning })).toBe('2026-02-16');
    // Its own day, before its send time: last week's, not today's.
    expect(
      lastFiringDate({ schedule: { ...base, weekday: 3, sendAtMinutes: 23 * 60 }, now: wedMorning }),
    ).toBe('2026-02-11');
    expect(lastFiringDate({ schedule: { ...base, weekday: 3 }, now: wedMorning })).toBe('2026-02-18');
  });

  it('a monthly schedule on the 31st still fires in February', () => {
    const base = { cadence: 'MONTHLY', timezone: tz, sendAtMinutes: 8 * 60 };
    // Asked for the 31st, in a 28-day month, after the send time: the 28th.
    // Without the clamp this schedule would skip February in silence.
    expect(
      lastFiringDate({ schedule: { ...base, dayOfMonth: 31 }, now: new Date('2026-02-28T04:00:00Z') }),
    ).toBe('2026-02-28');
    // Mid-month, before this month's day has come round: last month's.
    expect(lastFiringDate({ schedule: { ...base, dayOfMonth: 25 }, now: wedMorning })).toBe('2026-01-25');
    expect(lastFiringDate({ schedule: { ...base, dayOfMonth: 1 }, now: wedMorning })).toBe('2026-02-01');
  });

  it('the run key names the period, not the attempt', () => {
    const period = { from: '2026-02-17', to: '2026-02-17' };
    expect(runKeyOf({ cadence: 'DAILY' }, period)).toBe('DAILY:2026-02-17');
    // Same window, two cadences: different keys, because a weekly report of a
    // Monday is not the daily report of that Monday.
    expect(runKeyOf({ cadence: 'WEEKLY' }, period)).toBe('WEEKLY:2026-02-17');
  });
});

// ---------------------------------------------------------------------------
// Creating one
// ---------------------------------------------------------------------------

describe('reporting schedules: what may be scheduled, and by whom', () => {
  it('a new schedule is born DRAFT and refuses to run', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'Born draft' });
    expect(s.state).toBe('DRAFT');
    expect(s.lastDelivery).toBe(null);

    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.status).toBe(400);
    expect(run.body.error.message).toMatch(/draft/i);
    // And nothing was written on the way to being refused.
    const rows = await prisma.reportDelivery.count({ where: { scheduleId: s.id } });
    expect(rows).toBe(0);
  });

  it('you cannot schedule a report you may not read', async () => {
    // An AUDITOR reads every report and writes nothing, so they are refused the
    // schedule write outright — the gate a timer must not be able to walk round.
    const denied = await post('/api/reporting/schedules', tokens.auditorA, {
      name: 'Auditor tries',
      reportKey: 'sales',
      cadence: 'DAILY',
    });
    expect(denied.status).toBe(403);

    // And a principal who holds report.schedule.write is still refused for the
    // one report they may not read. The pair is the assertion: same route, same
    // caller, two report keys, two answers — so it is the report being checked
    // and not the route.
    const allowed = await post('/api/reporting/schedules', tokens.financeA1, {
      name: 'Finance sales',
      reportKey: 'sales',
      cadence: 'DAILY',
      recipientIds: [recipients.test.id],
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    const forReport = await post('/api/reporting/schedules', tokens.financeA1, {
      name: 'Finance consumption',
      reportKey: 'consumption',
      cadence: 'DAILY',
      recipientIds: [recipients.test.id],
    });
    expect(forReport.status).toBe(403);
    expect(forReport.body.error.message).toMatch(/permission to read the report/i);

    // Profitability needs sales AND inventory. Holding one of the two is not
    // enough, which is the case a single-action gate would have let through.
    const bothNeeded = await post('/api/reporting/schedules', tokens.financeA1, {
      name: 'Finance food margin',
      reportKey: 'profitability',
      cadence: 'DAILY',
      recipientIds: [recipients.test.id],
    });
    expect(bothNeeded.status).toBe(403);
  });

  it('naming another tenant store answers "not found", identically to a store that never existed', async () => {
    const other = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'Cross tenant',
      reportKey: 'sales',
      cadence: 'DAILY',
      storeIds: [b1.id],
      recipientIds: [recipients.test.id],
    });
    expect(other.status).toBe(404);
    expect(other.body.error.message).toBe('Store not found');

    const nonexistent = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'Nonexistent',
      reportKey: 'sales',
      cadence: 'DAILY',
      storeIds: ['no-such-branch-id'],
      recipientIds: [recipients.test.id],
    });
    expect(nonexistent.status).toBe(404);
    expect(nonexistent.body.error.message).toBe('Store not found');

    // A sibling store in the caller's own company, outside their assignments,
    // gets the same answer as the other tenant's store. Identical on purpose: a
    // 403 here would confirm the id exists and let somebody map an estate one
    // guess at a time.
    const sibling = await post('/api/reporting/schedules', tokens.financeA1, {
      name: 'Reaches sideways',
      reportKey: 'sales',
      cadence: 'DAILY',
      storeIds: [a2.id],
      recipientIds: [recipients.test.id],
    });
    expect(sibling.status).toBe(404);
    expect(sibling.body.error.message).toBe('Store not found');

    // The store they do hold is accepted, so the refusal above is the scope and
    // not the route refusing every storeIds value it is given.
    const own = await post('/api/reporting/schedules', tokens.financeA1, {
      name: 'Reaches its own store',
      reportKey: 'sales',
      cadence: 'DAILY',
      storeIds: [a1.id],
      recipientIds: [recipients.test.id],
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
  });

  it('a recipient must be an approved, unrevoked address of this company', async () => {
    const typed = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'Typed address',
      reportKey: 'sales',
      cadence: 'DAILY',
      recipientIds: ['someone@example.com'],
    });
    expect(typed.status).toBe(400);
    expect(typed.body.error.message).toMatch(/approved, unrevoked/i);

    // Company B may not attach company A's approved address to its own schedule.
    const crossed = await post('/api/reporting/schedules', tokens.ownerB, {
      name: 'Borrowed recipient',
      reportKey: 'sales',
      cadence: 'DAILY',
      recipientIds: [recipients.test.id],
    });
    expect(crossed.status).toBe(400);
  });

  it('a weekly schedule needs its weekday and a monthly one its day of month', async () => {
    const weekly = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'Weekly no day',
      reportKey: 'sales',
      cadence: 'WEEKLY',
      recipientIds: [recipients.test.id],
    });
    expect(weekly.status).toBe(400);
    expect(weekly.body.error.field).toBe('weekday');

    const monthly = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'Monthly no day',
      reportKey: 'sales',
      cadence: 'MONTHLY',
      recipientIds: [recipients.test.id],
    });
    expect(monthly.status).toBe(400);
    expect(monthly.body.error.field).toBe('dayOfMonth');

    // 7 is a valid ISO weekday and not a valid one here. Rejecting it is what
    // stops the two conventions coexisting.
    const iso = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'ISO Sunday',
      reportKey: 'sales',
      cadence: 'WEEKLY',
      weekday: 7,
      recipientIds: [recipients.test.id],
    });
    expect(iso.status).toBe(400);
  });

  it('refuses activation of a schedule with nobody to send to', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'Nobody', recipientIds: [] });
    const res = await post(`/api/reporting/schedules/${s.id}/state`, tokens.ownerA, { state: 'ACTIVE' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no approved recipient/i);
    const after = await prisma.reportSchedule.findUnique({ where: { id: s.id } });
    expect(after.state).toBe('DRAFT');
  });

  it('an unknown timezone is refused rather than silently defaulted', async () => {
    const res = await post('/api/reporting/schedules', tokens.ownerA, {
      name: 'Bad zone',
      reportKey: 'sales',
      cadence: 'DAILY',
      timezone: 'Mars/Olympus_Mons',
      recipientIds: [recipients.test.id],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('timezone');
  });
});

// ---------------------------------------------------------------------------
// Delivering one
// ---------------------------------------------------------------------------

describe('reporting schedules: delivery happens exactly once', () => {
  it('running the same period twice sends once and says so the second time', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'Once only' });
    await activate(tokens.ownerA, s.id);

    const first = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.deduplicated).toBe(false);
    expect(first.body.delivery.status).toBe('SENT');
    expect(first.body.runKey).toBe(`DAILY:${first.body.period.from}`);

    const second = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.runKey).toBe(first.body.runKey);
    expect(second.body.reason).toMatch(/already been delivered/i);

    // One row, one send. The count is the assertion: a second SENT row would be
    // a second morning email for the same day's trade.
    const rows = await prisma.reportDelivery.findMany({ where: { scheduleId: s.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SENT');
    expect(rows.filter((r) => r.sentAt).length).toBe(1);

    // A tick arriving after a manual run is the same collision by another route.
    const ticked = await tick({ actionsFor, companyId: companyA.id });
    const mine = ticked.results.find((r) => r.scheduleId === s.id);
    expect(mine.deduplicated).toBe(true);
    expect(await prisma.reportDelivery.count({ where: { scheduleId: s.id } })).toBe(1);
  });

  it('a delivery names the transport that carried it and the artifact it wrote', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'Artifact' });
    await activate(tokens.ownerA, s.id);
    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.body.delivery.status).toBe('SENT');
    // FILE, not an empty string and not "EMAIL". This is the field that stops
    // SENT being read as "it reached their inbox".
    expect(run.body.delivery.transport).toBe('FILE');
    expect(run.body.delivery.bytes).toBeGreaterThan(0);

    const row = await prisma.reportDelivery.findFirst({ where: { scheduleId: s.id } });
    expect(row.artifactPath).toBeTruthy();
    expect(row.artifactPath.startsWith(SPOOL)).toBe(true);
    // The file exists and holds the report. A delivery log that cannot be
    // verified against an artifact is the thing this design was chosen to avoid.
    expect(existsSync(row.artifactPath)).toBe(true);
    const csv = readFileSync(row.artifactPath, 'utf8');
    expect(csv).toContain('Sched One');
    // Against the file on disk, not against the string's length: a CSV of rupee
    // figures is full of multi-byte characters, and a recorded size that counted
    // characters would understate every artifact it ever described.
    expect(statSync(row.artifactPath).size).toBe(row.bytes);
    // Spooled under the company and schedule, so one tenant's artifacts are not
    // interleaved with another's on disk.
    expect(row.artifactPath).toContain(`/${companyA.id}/`);
    expect(row.artifactPath).toContain(`/${s.id}/`);
    // And not a hint of the other tenant's trade in it.
    expect(csv).not.toContain('Bravo');
    expect(csv).not.toContain('9999.99');
  });

  it('an approved address this build cannot reach is withheld, never reported as sent', async () => {
    const s = await makeSchedule(tokens.ownerA, {
      name: 'Mixed recipients',
      recipientIds: [recipients.test.id, recipients.real.id],
    });
    await activate(tokens.ownerA, s.id);
    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);

    const d = run.body.delivery;
    expect(d.status).toBe('SENT');
    expect(d.sentTo).toEqual(['reports-test@schedule.test.local']);
    expect(d.withheld).toEqual(['finance-director@schedule.test.local']);
    // The reason travels with the row. "Sent to 1 of 2" is a sentence somebody
    // has to be able to finish months later.
    expect(d.note).toMatch(/no delivery transport/i);
    // The withheld address is nowhere in the sent list, whichever way it is read.
    expect(d.sentTo).not.toContain('finance-director@schedule.test.local');
  });

  it('a schedule with only unreachable recipients records SKIPPED and writes nothing', async () => {
    const s = await makeSchedule(tokens.ownerA, {
      name: 'Real only',
      recipientIds: [recipients.real.id],
    });
    await activate(tokens.ownerA, s.id);
    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);

    const d = run.body.delivery;
    // SKIPPED, not FAILED: nothing went wrong, and a FAILED row would be retried
    // forever against a transport that does not exist.
    expect(d.status).toBe('SKIPPED');
    expect(d.sentTo).toEqual([]);
    expect(d.withheld).toEqual(['finance-director@schedule.test.local']);
    expect(d.artifact).toBe(null);
    expect(d.note).toMatch(/withheld rather than recorded as sent/i);
    // It still knows how big the report would have been, so an owner can see the
    // report was produced and only the delivery was withheld.
    expect(d.rowCount).toBeGreaterThan(0);
  });

  it('revoking the last approved address stops the schedule and says why', async () => {
    const extra = await post('/api/reporting/recipients', tokens.ownerA, {
      email: 'temp-test@schedule.test.local',
      isTestAddress: true,
    });
    const s = await makeSchedule(tokens.ownerA, {
      name: 'Revoked',
      recipientIds: [extra.body.id],
    });
    await activate(tokens.ownerA, s.id);

    const revoked = await post(`/api/reporting/recipients/${extra.body.id}/revoke`, tokens.ownerA);
    expect(revoked.status).toBe(200);

    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.body.delivery.status).toBe('SKIPPED');
    expect(run.body.delivery.note).toMatch(/no approved recipient/i);
    // Withdrawing an address stops every schedule that used it without anybody
    // editing them — the point of an approval list.
    expect(run.body.delivery.sentTo).toEqual([]);
  });

  it('partitionRecipients withholds anything not marked as a test address', () => {
    // Asserted directly as well as through HTTP: this one predicate decides
    // whether a customer's address is written to, and a default that flipped to
    // "deliverable" would be invisible in a payload that happened to contain
    // only test addresses.
    const { deliverable, withheld, withheldReason } = partitionRecipients([
      { email: 'a@x', isTestAddress: true },
      { email: 'b@x', isTestAddress: false },
      { email: 'c@x' },
    ]);
    expect(deliverable.map((r) => r.email)).toEqual(['a@x']);
    expect(withheld.map((r) => r.email)).toEqual(['b@x', 'c@x']);
    expect(withheldReason).toMatch(/test addresses/);
    expect(partitionRecipients([{ email: 'a@x', isTestAddress: true }]).withheldReason).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Authority, re-read at send time
// ---------------------------------------------------------------------------

describe('reporting schedules: the timer is held to its owner’s current authority', () => {
  it('a demoted owner’s schedule stops sending', async () => {
    const s = await makeSchedule(tokens.demoteA, { name: 'Demoted owner' });
    await activate(tokens.demoteA, s.id);

    // Prove it worked first. Without this the test would pass on a schedule that
    // never worked at all, which proves nothing about the demotion.
    const before = await post(`/api/reporting/schedules/${s.id}/run`, tokens.demoteA);
    expect(before.body.delivery.status).toBe('SENT');

    await prisma.posUser.update({
      where: { email: 'demote.a@schedule.test.local' },
      data: { role: 'CASHIER', branchId: a1.id },
    });

    // A different period, so the deduplication is not what stops it. The timer
    // is asked to send a window it has never sent.
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    const schedule = await prisma.reportSchedule.findUnique({ where: { id: s.id } });
    const ticked = await tick({ now: twoDaysAgo, actionsFor, companyId: companyA.id });
    const mine = ticked.results.find((r) => r.scheduleId === schedule.id);
    expect(mine.status).toBe('SKIPPED');
    expect(mine.reason).toMatch(/no longer has permission to read sales/i);

    const sent = await prisma.reportDelivery.count({
      where: { scheduleId: s.id, status: 'SENT' },
    });
    expect(sent).toBe(1);
  });

  it('a disabled owner’s schedule stops sending', async () => {
    const s = await makeSchedule(tokens.disableA, { name: 'Disabled owner' });
    await activate(tokens.disableA, s.id);

    await prisma.posUser.update({
      where: { email: 'disable.a@schedule.test.local' },
      data: { status: 'DISABLED' },
    });

    const ticked = await tick({ actionsFor, companyId: companyA.id });
    const mine = ticked.results.find((r) => r.scheduleId === s.id);
    expect(mine.status).toBe('SKIPPED');
    // Disabling an account is meant to stop exactly this.
    expect(mine.reason).toMatch(/disabled/i);
    expect(await prisma.reportDelivery.count({ where: { scheduleId: s.id, status: 'SENT' } })).toBe(0);
  });

  it('both stores appear when the owner reaches both — the control for the test below', async () => {
    // Without this, "the artifact does not mention Sched Two" would pass just as
    // well on an artifact that mentions no store at all, which is the shape of
    // vacuous pass that makes an isolation suite worthless.
    const s = await makeSchedule(tokens.ownerA, { name: 'Both stores', storeIds: [a1.id, a2.id] });
    await activate(tokens.ownerA, s.id);
    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.body.delivery.status).toBe('SENT');
    const row = await prisma.reportDelivery.findFirst({ where: { scheduleId: s.id } });
    const csv = readFileSync(row.artifactPath, 'utf8');
    expect(csv).toContain('Sched One');
    expect(csv).toContain('Sched Two');
  });

  it('a schedule reports only the stores its owner can still reach', async () => {
    // Created by the owner over both stores, then handed to the principal who
    // holds one. The schedule's own store list is untouched; its owner's reach is
    // what changed — which is exactly what happens when somebody is moved.
    const s = await makeSchedule(tokens.ownerA, {
      name: 'Narrowed by reach',
      storeIds: [a1.id, a2.id],
    });
    await activate(tokens.ownerA, s.id);
    await prisma.reportSchedule.update({ where: { id: s.id }, data: { createdById: financeA1Id } });

    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.body.delivery.status).toBe('SENT');
    const row = await prisma.reportDelivery.findFirst({ where: { scheduleId: s.id } });
    const csv = readFileSync(row.artifactPath, 'utf8');
    expect(csv).toContain('Sched One');
    // The store the manager cannot reach is absent from the artifact, not merely
    // from the screen. An intersection, never a grant.
    expect(csv).not.toContain('Sched Two');
  });

  it('a schedule naming only a store its owner has lost sends nothing', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'Lost store', storeIds: [a2.id] });
    await activate(tokens.ownerA, s.id);
    await prisma.reportSchedule.update({ where: { id: s.id }, data: { createdById: financeA1Id } });

    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.body.delivery.status).toBe('SKIPPED');
    expect(run.body.delivery.note).toMatch(/still inside its owner/i);
  });

  it('a report this deployment cannot produce is SKIPPED with the reason, not FAILED', async () => {
    // Ingredient consumption needs recipes and stock movements, neither of which
    // exists in this build. A FAILED row would be retried nightly for ever.
    const s = await makeSchedule(tokens.ownerA, { name: 'Unavailable report', reportKey: 'wastage' });
    await activate(tokens.ownerA, s.id);
    const run = await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    expect(run.body.delivery.status).toBe('SKIPPED');
    expect(run.body.delivery.note).toMatch(/deployment|does not build/i);
    expect(run.body.delivery.sentTo).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Isolation and the tick
// ---------------------------------------------------------------------------

describe('reporting schedules: tenancy and the tick', () => {
  it('a tenant cannot see, edit, run or read the deliveries of another tenant’s schedule', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'Alpha private' });
    await activate(tokens.ownerA, s.id);
    await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);

    for (const attempt of [
      get(`/api/reporting/schedules/${s.id}/deliveries`, tokens.ownerB),
      post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerB),
      post(`/api/reporting/schedules/${s.id}/state`, tokens.ownerB, { state: 'PAUSED' }),
      request(app).patch(`/api/reporting/schedules/${s.id}`).set(auth(tokens.ownerB)).send({ name: 'Mine now' }),
    ]) {
      const res = await attempt;
      expect(res.status).toBe(404);
    }

    const list = await get('/api/reporting/schedules', tokens.ownerB);
    expect(list.status).toBe(200);
    expect(list.body.schedules.map((x) => x.id)).not.toContain(s.id);
    expect(JSON.stringify(list.body)).not.toContain('Alpha private');
  });

  it('a tick fires only ACTIVE schedules, and only the caller’s own company', async () => {
    const draft = await makeSchedule(tokens.ownerA, { name: 'Stays draft' });
    const paused = await makeSchedule(tokens.ownerA, { name: 'Stays paused' });
    await activate(tokens.ownerA, paused.id);
    await post(`/api/reporting/schedules/${paused.id}/state`, tokens.ownerA, { state: 'PAUSED' });

    const res = await post('/api/reporting/schedules/tick', tokens.ownerA);
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r) => r.scheduleId);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(paused.id);
    expect(await prisma.reportDelivery.count({ where: { scheduleId: draft.id } })).toBe(0);
    expect(await prisma.reportDelivery.count({ where: { scheduleId: paused.id } })).toBe(0);

    // Company B ticking touches nothing of company A's, however many of A's
    // schedules are due.
    const activeA = await prisma.reportSchedule.count({
      where: { companyId: companyA.id, state: 'ACTIVE' },
    });
    expect(activeA).toBeGreaterThan(0);
    const bTick = await post('/api/reporting/schedules/tick', tokens.ownerB);
    expect(bTick.status).toBe(200);
    expect(bTick.body.considered).toBe(0);
  });

  it('the schedules screen says the scheduler is off, because it is', async () => {
    const res = await get('/api/reporting/schedules', tokens.ownerA);
    expect(res.status).toBe(200);
    // Deploying this lane must not start sending anything on its own, and the
    // person configuring a schedule cannot see that from the form.
    expect(res.body.scheduler.enabled).toBe(false);
    expect(res.body.scheduler.note).toMatch(/switched off/i);
  });

  it('the recipients screen states that this build writes to a file, not an inbox', async () => {
    const res = await get('/api/reporting/recipients', tokens.ownerA);
    expect(res.status).toBe(200);
    expect(res.body.delivery.transport).toBe('FILE');
    expect(res.body.delivery.note).toMatch(/no mail or messaging transport/i);
    // Revoked addresses stay listed. "Who received the March figures" has to
    // remain answerable after somebody is taken off the list.
    const revokedRows = res.body.recipients.filter((r) => r.revokedAt);
    expect(revokedRows.length).toBeGreaterThan(0);
  });

  it('every delivery of a schedule is listed with its attempts and outcome', async () => {
    const s = await makeSchedule(tokens.ownerA, { name: 'History' });
    await activate(tokens.ownerA, s.id);
    await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);
    await post(`/api/reporting/schedules/${s.id}/run`, tokens.ownerA);

    const res = await get(`/api/reporting/schedules/${s.id}/deliveries`, tokens.ownerA);
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    const d = res.body.deliveries[0];
    expect(d.status).toBe('SENT');
    // The second press is visible as an attempt, not as a second delivery. Both
    // halves matter: the owner sees it was asked for twice and sent once.
    expect(d.attempts).toBe(1);
    expect(d.sentAt).toBeTruthy();
    expect(d.transport).toBe('FILE');
  });
});
