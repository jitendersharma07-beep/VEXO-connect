// VC-104 opening hours, in the business timezone.
//
// WHY THIS FILE EXISTS
//
// phoneOrders.test.js opens every store 00:00-23:59 on all seven days so that
// hours never decide a test that is about something else. That is the right
// call there, and it means the only closure that suite ever exercises is the
// `closed` BOOLEAN, flipped on all seven rows at once (its two hours tests, at
// "reports a closed store as closed at the requested time" and the matching
// submit refusal). Time-independent input cannot test time-dependent code: the
// minute fields, the IST conversion, the past-midnight row and the
// opens-inclusive/closes-exclusive boundary are all unexercised, and a suite
// that is green with `withinRow` returning a constant is not evidence about
// opening hours.
//
// Everything here is deterministic. The hours matrix is driven through
// POST /branch-options, which takes `scheduledFor` verbatim as the instant to
// judge and does NOT require it to be in the future — so an exact IST wall
// clock can be named rather than waited for, with no fake timers and no
// dependence on when the suite happens to run. The submit and reassign paths do
// require a future time, so those tests compute the next future occurrence of a
// named IST weekday and minute (nextIst below) and assert, through the
// product's own istParts, that the instant they built really is the one they
// meant.
//
// Every store here is asked about with fulfilment PICKUP and no items. That is
// deliberate: with no address there is no serviceability, with no basket there
// is no minimum-order, and the tenant's menu is not consulted — so hours and
// capacity are the only things left that can make a store unavailable, and a
// red result cannot be some other rule wearing an hours costume.
//
// Runs ONLY against a database whose name ends in _test — the guard below
// refuses anything else, because the suite truncates every table.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('branchHours.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { istParts, slotBoundsFor } = await import('../src/lib/phoneOrders.js');

const app = createApp();

// Same order and same reasoning as phoneOrders.test.js's wipe: this lane's
// tables reference Order, PosUser, Branch and Company, and every FK added since
// this lane branched is RESTRICT, so the children go first.
const wipe = async () => {
  await prisma.phoneOrderEvent.deleteMany();
  await prisma.phoneOrder.deleteMany();
  await prisma.customerAddress.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.branchServiceArea.deleteMany();
  await prisma.branchHours.deleteMany();
  await prisma.branchPrepCapacity.deleteMany();

  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.printJob.deleteMany();
  await prisma.printTarget.deleteMany();
  await prisma.printAgent.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.modifierOption.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'Str0ng-Passw0rd!';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let company, primary, other, unconfigured, product, customer, token;

// --- the clock this file reasons in -----------------------------------------

const IST_OFFSET_MIN = 330; // UTC+05:30, the business timezone (lib/orders.js)
const DAY_MS = 86400000;
const MIN_MS = 60000;

// The instant whose IST wall clock is (y-m-d) at `minute` past IST midnight.
// Built from Date.UTC and an explicit offset so it never reads the host's
// timezone. That matters more than it looks: this box runs UTC, so a
// getHours() here would agree with IST-by-accident nowhere and with UTC
// everywhere, and the test would pass while measuring the wrong clock.
const istInstant = (y, m, d, minute) =>
  new Date(Date.UTC(y, m - 1, d) + (minute - IST_OFFSET_MIN) * MIN_MS);

// The earliest instant strictly in the future whose IST weekday and minute of
// day are the ones named. Used by the submit and reassign paths, which refuse a
// time that is not in the future; the options path names instants directly.
// The 5-minute margin is so a slow request cannot overtake its own deadline.
const nextIst = (dayOfWeek, minute, fromMs = Date.now()) => {
  const shifted = fromMs + IST_OFFSET_MIN * MIN_MS;
  const istMidnightUtc = Date.UTC(
    new Date(shifted).getUTCFullYear(),
    new Date(shifted).getUTCMonth(),
    new Date(shifted).getUTCDate(),
  );
  for (let i = 0; i < 9; i += 1) {
    const day = istMidnightUtc + i * DAY_MS;
    if (new Date(day).getUTCDay() !== dayOfWeek) continue;
    const at = new Date(day + (minute - IST_OFFSET_MIN) * MIN_MS);
    if (at.getTime() > fromMs + 5 * MIN_MS) return at;
  }
  throw new Error(`nextIst(${dayOfWeek}, ${minute}): no candidate within nine days`);
};

// Tomorrow in IST. Whatever the run's wall clock, this weekday is never today's
// — which is what lets the reassignment tests below be unconditional.
const tomorrowIstDow = () => (istParts(new Date()).dayOfWeek + 1) % 7;

// --- fixtures ----------------------------------------------------------------

const DAYS = [0, 1, 2, 3, 4, 5, 6];

// closesMinute 1440, not 1439. 1439 is the value phoneOrders.test.js and this
// lane's browser-QA seed both use for "open all day", and the first test below
// measures what it actually does.
const allWeek = (over = {}) =>
  DAYS.map((d) => ({ dayOfWeek: d, opensMinute: 0, closesMinute: 1440, ...over }));

const setHours = async (branch, rows) => {
  await prisma.branchHours.deleteMany({ where: { branchId: branch.id } });
  if (rows.length === 0) return;
  await prisma.branchHours.createMany({
    data: rows.map((r) => ({
      companyId: company.id,
      branchId: branch.id,
      closed: false,
      ...r,
    })),
  });
};

const setCapacity = async (branch, cap) => {
  await prisma.branchPrepCapacity.deleteMany({ where: { branchId: branch.id } });
  if (!cap) return;
  await prisma.branchPrepCapacity.create({
    data: { companyId: company.id, branchId: branch.id, ...cap },
  });
};

// One store's entry in the options response at a named instant.
const optionAt = async (branch, when) => {
  const res = await request(app)
    .post('/api/phone-orders/branch-options')
    .set(auth(token))
    .send({ fulfilment: 'PICKUP', scheduledFor: when.toISOString() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const opt = res.body.options.find((o) => o.branchId === branch.id);
  expect(opt, `no option returned for ${branch.name}`).toBeTruthy();
  return opt;
};

const reasonsAt = async (branch, when) =>
  (await optionAt(branch, when)).unavailableReasons.map((r) => r.code);

let keySeq = 0;
const submit = (over = {}) =>
  request(app)
    .post('/api/phone-orders')
    .set(auth(token))
    .send({
      idempotencyKey: `bh-key-${(keySeq += 1)}-${Date.now()}`,
      customerId: customer.id,
      fulfilment: 'PICKUP',
      branchId: primary.id,
      items: [{ productId: product.id, qty: 1 }],
      ...over,
    });

const reassign = (id, branchId) =>
  request(app)
    .post(`/api/phone-orders/${id}/reassign`)
    .set(auth(token))
    .send({ branchId, reason: 'hours coverage' });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  company = await prisma.company.create({
    data: {
      name: 'Hours Co',
      slug: 'hours-co',
      licenses: {
        create: {
          plan: 'MULTI_STORE',
          baseBranchLimit: 4,
          expiresAt: new Date(Date.now() + 30 * DAY_MS),
        },
      },
    },
  });

  primary = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-BH-0001', name: 'Primary', code: 'BH1' },
  });
  other = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-BH-0002', name: 'Other', code: 'BH2' },
  });
  // Deliberately never given a BranchHours row — the documented "no hours
  // configured means open" default, and the negative control for it.
  unconfigured = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-BH-0003', name: 'Unconfigured', code: 'BH3' },
  });

  await prisma.posUser.create({
    data: {
      email: 'owner@hours.local',
      fullName: 'Hours Owner',
      role: 'CUSTOMER_OWNER',
      companyId: company.id,
      passwordHash,
    },
  });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'owner@hours.local', password: PW });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  token = login.body.token;

  const tax = await prisma.taxRate.create({
    data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.000' },
  });
  const category = await prisma.category.create({
    data: { companyId: company.id, name: 'Coffee' },
  });
  product = await prisma.product.create({
    data: {
      companyId: company.id,
      categoryId: category.id,
      name: 'Filter Coffee',
      basePrice: '100.00',
      taxRateId: tax.id,
    },
  });
  customer = await prisma.customer.create({
    data: { companyId: company.id, name: 'Hours Caller', phone: '+919876512345' },
  });

  await setHours(primary, allWeek());
  await setHours(other, allWeek());
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

// -----------------------------------------------------------------------------

describe('the clock these tests reason in', () => {
  it('names an IST wall clock the product agrees with', () => {
    // 2026-01-01 was a Thursday in IST. istParts is the product's own reader,
    // so agreement here is agreement with the thing under test, not with a
    // second implementation of it.
    const at = istInstant(2026, 1, 1, 9 * 60 + 30);
    expect(istParts(at)).toEqual({ dayOfWeek: 4, minute: 570 });
  });

  it('is measurably NOT the UTC clock', () => {
    // The control for the test above. An instant at IST 00:30 Friday is still
    // Thursday 19:00 in UTC; if this file were accidentally reasoning in UTC —
    // the timezone this host actually runs in — these two would agree and every
    // date-change assertion below would be vacuous.
    const at = istInstant(2026, 1, 2, 30);
    expect(istParts(at)).toEqual({ dayOfWeek: 5, minute: 30 });
    expect(at.getUTCDay()).toBe(4);
    expect(at.getUTCHours()).toBe(19);
  });

  it('builds a future instant on the IST weekday and minute it was asked for', () => {
    for (const dayOfWeek of DAYS) {
      const at = nextIst(dayOfWeek, 11 * 60);
      expect(istParts(at), `nextIst(${dayOfWeek}, 660)`).toEqual({ dayOfWeek, minute: 660 });
      expect(at.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('never proposes today as "tomorrow in IST"', () => {
    expect(tomorrowIstDow()).not.toBe(istParts(new Date()).dayOfWeek);
  });
});

describe('the "open all day" fixture this lane trusts', () => {
  // The finding this file was written around. phoneOrders.test.js's openAllWeek
  // and frontend/qa/run-seed.mjs both wrote closesMinute 1439, reading it as
  // "open until 23:59". withinRow is [opens, closes), so 1439 means "open until
  // 23:58:59" and the store is shut for the last minute of every day. Nothing
  // caught it because nothing ever asked at a specific minute.
  it('closes a 00:00-23:59 store for the final minute of every day', async () => {
    await setHours(primary, allWeek({ closesMinute: 1439 }));
    const day = [2026, 6, 10]; // a Wednesday in IST; the day does not matter here

    expect(await reasonsAt(primary, istInstant(...day, 23 * 60 + 58))).toEqual([]);
    expect(await reasonsAt(primary, istInstant(...day, 23 * 60 + 59)))
      .toContain('CLOSED_AT_FULFILMENT');
  });

  it('stays open through midnight when the day ends at 1440', async () => {
    await setHours(primary, allWeek());
    const day = [2026, 6, 10];
    expect(await reasonsAt(primary, istInstant(...day, 23 * 60 + 59))).toEqual([]);
    expect(await reasonsAt(primary, istInstant(...day, 0))).toEqual([]);
  });
});

describe('the opening and closing boundary', () => {
  // 09:00-17:00 on Monday only. Every other day has no row at all, so only the
  // Monday row can produce an "open" answer.
  beforeAll(async () => {
    await setHours(primary, [{ dayOfWeek: 1, opensMinute: 540, closesMinute: 1020 }]);
  });

  const monday = (minute) => istInstant(2026, 6, 8, minute); // 2026-06-08 is a Monday

  it('is shut one minute before it opens', async () => {
    expect(await reasonsAt(primary, monday(539))).toContain('CLOSED_AT_FULFILMENT');
  });

  it('is open on the opening minute itself — opensMinute is inclusive', async () => {
    expect(await reasonsAt(primary, monday(540))).toEqual([]);
  });

  it('is open one minute before it closes', async () => {
    expect(await reasonsAt(primary, monday(1019))).toEqual([]);
  });

  it('is shut on the closing minute itself — closesMinute is exclusive', async () => {
    // The half-open interval is the whole point: 17:00-21:00 on a second row
    // must be able to abut this one without both claiming 17:00.
    expect(await reasonsAt(primary, monday(1020))).toContain('CLOSED_AT_FULFILMENT');
  });

  it('tells the operator the time it was judged at, not just "closed"', async () => {
    const shut = await optionAt(primary, monday(1020));
    const message = shut.unavailableReasons.find((r) => r.code === 'CLOSED_AT_FULFILMENT').message;
    expect(message).toBe('Closed at 17:00 on Monday');
    expect(shut.hours).toEqual({ opensAt: '09:00', closesAt: '17:00', openAtFulfilment: false });
  });

  it('says "closed on <day>" for a day with no row, which reads differently on purpose', async () => {
    const sunday = istInstant(2026, 6, 7, 12 * 60); // 2026-06-07 is a Sunday
    const shut = await optionAt(primary, sunday);
    const message = shut.unavailableReasons.find((r) => r.code === 'CLOSED_AT_FULFILMENT').message;
    expect(message).toBe('Closed on Sunday');
    // No row for the day means no advertised hours either, which the operator's
    // screen renders as a blank rather than a wrong time.
    expect(shut.hours).toEqual({ opensAt: null, closesAt: null, openAtFulfilment: false });
  });
});

describe('each IST weekday is judged by its own row', () => {
  beforeAll(async () => {
    await setHours(primary, [
      { dayOfWeek: 1, opensMinute: 540, closesMinute: 1020 }, // Mon 09:00-17:00
      { dayOfWeek: 2, opensMinute: 540, closesMinute: 1020, closed: true }, // Tue, shut
      { dayOfWeek: 3, opensMinute: 1080, closesMinute: 1380 }, // Wed 18:00-23:00
    ]);
  });

  it('opens Monday lunchtime', async () => {
    expect(await reasonsAt(primary, istInstant(2026, 6, 8, 12 * 60))).toEqual([]);
  });

  it('refuses the same clock time on the day marked closed', async () => {
    const shut = await optionAt(primary, istInstant(2026, 6, 9, 12 * 60));
    expect(shut.unavailableReasons.map((r) => r.code)).toContain('CLOSED_AT_FULFILMENT');
    expect(shut.unavailableReasons[0].message).toBe('Closed on Tuesday');
    // A closed day advertises no hours even though its row carries minutes —
    // otherwise the screen would print "09:00-17:00" beside "closed".
    expect(shut.hours).toEqual({ opensAt: null, closesAt: null, openAtFulfilment: false });
  });

  it('refuses Wednesday lunchtime but takes Wednesday evening', async () => {
    expect(await reasonsAt(primary, istInstant(2026, 6, 10, 12 * 60)))
      .toContain('CLOSED_AT_FULFILMENT');
    expect(await reasonsAt(primary, istInstant(2026, 6, 10, 19 * 60))).toEqual([]);
  });
});

describe('the IST date change, which UTC does not share', () => {
  // The case that a UTC-reasoning implementation gets wrong and no all-week
  // fixture can reach: two instants sixty minutes apart in UTC that fall on
  // DIFFERENT IST weekdays.
  beforeAll(async () => {
    await setHours(primary, [
      { dayOfWeek: 4, opensMinute: 540, closesMinute: 1020 }, // Thu 09:00-17:00
      { dayOfWeek: 5, opensMinute: 0, closesMinute: 120 }, // Fri 00:00-02:00
    ]);
  });

  it('judges 18:00 UTC Thursday as 23:30 IST Thursday, and shuts it', async () => {
    const at = istInstant(2026, 6, 11, 23 * 60 + 30); // Thursday IST
    expect(at.getUTCDay()).toBe(4);
    expect(at.getUTCHours()).toBe(18);
    expect(await reasonsAt(primary, at)).toContain('CLOSED_AT_FULFILMENT');
  });

  it('judges 19:00 UTC on that SAME Thursday as 00:30 IST Friday, and opens it', async () => {
    const at = istInstant(2026, 6, 12, 30); // Friday IST
    // Still Thursday in UTC — this is the whole test. A getUTCDay()-based
    // lookup would read Thursday's 09:00-17:00 row, find 19:00 outside it, and
    // refuse an order the store is open for.
    expect(at.getUTCDay()).toBe(4);
    expect(at.getUTCHours()).toBe(19);
    expect(await reasonsAt(primary, at)).toEqual([]);
  });

  it('shuts again at 02:00 IST Friday, which is still Thursday in UTC', async () => {
    const at = istInstant(2026, 6, 12, 120);
    expect(at.getUTCDay()).toBe(4);
    expect(await reasonsAt(primary, at)).toContain('CLOSED_AT_FULFILMENT');
  });
});

describe('a store that trades past midnight', () => {
  // The schema's own reason for storing minutes rather than clock strings:
  // 23:00-02:00 is ONE row on the day it opened, with closesMinute over 1440.
  beforeAll(async () => {
    await setHours(primary, [{ dayOfWeek: 5, opensMinute: 1380, closesMinute: 1560 }]);
  });

  it('is open at 23:30 on the Friday the row belongs to', async () => {
    expect(await reasonsAt(primary, istInstant(2026, 6, 12, 23 * 60 + 30))).toEqual([]);
  });

  it('is still open at 01:30 on Saturday, from Friday\'s row', async () => {
    // Saturday has no row of its own, so the only way to answer "open" here is
    // the yesterday branch testing minute + 1440 against Friday.
    expect(await reasonsAt(primary, istInstant(2026, 6, 13, 90))).toEqual([]);
  });

  it('shuts at 02:00 Saturday, where the overnight row ends', async () => {
    expect(await reasonsAt(primary, istInstant(2026, 6, 13, 120)))
      .toContain('CLOSED_AT_FULFILMENT');
    expect(await reasonsAt(primary, istInstant(2026, 6, 13, 180)))
      .toContain('CLOSED_AT_FULFILMENT');
  });

  it('advertises no hours at 01:30 even though it is open — a known rough edge', async () => {
    // Pinning current behaviour, not endorsing it. hoursSummary looks up the
    // row for the CURRENT IST day; on Saturday there is none, so the operator's
    // screen shows the store as open with a blank opening time. Harmless today
    // because openAtFulfilment is what gates the submission, and worth knowing
    // before anyone renders opensAt as authoritative.
    const open = await optionAt(primary, istInstant(2026, 6, 13, 90));
    expect(open.available).toBe(true);
    expect(open.hours).toEqual({ opensAt: null, closesAt: null, openAtFulfilment: true });
  });
});

describe('a store with no hours configured at all', () => {
  it('is open at an hour the configured store next to it is shut', async () => {
    // Both halves matter. The default alone could be green because the whole
    // response is available at that instant; the configured store in the SAME
    // response, refused at the SAME instant, is what makes it an hours answer.
    await setHours(primary, [{ dayOfWeek: 1, opensMinute: 540, closesMinute: 1020 }]);
    const deadOfNight = istInstant(2026, 6, 8, 3 * 60);

    expect(await reasonsAt(unconfigured, deadOfNight)).toEqual([]);
    expect(await reasonsAt(primary, deadOfNight)).toContain('CLOSED_AT_FULFILMENT');
  });

  it('reports blank hours rather than inventing a window', async () => {
    const opt = await optionAt(unconfigured, istInstant(2026, 6, 8, 3 * 60));
    expect(opt.hours).toEqual({ opensAt: null, closesAt: null, openAtFulfilment: true });
  });
});

describe('scheduling an order for a time the store is shut', () => {
  const dow = 3; // judged below against the order's own IST weekday

  beforeAll(async () => {
    // Primary open 09:00-17:00 every day; Other shut on Wednesdays.
    await setHours(primary, allWeek({ opensMinute: 540, closesMinute: 1020 }));
    await setHours(
      other,
      DAYS.map((d) => ({
        dayOfWeek: d,
        opensMinute: 540,
        closesMinute: 1020,
        closed: d === dow,
      })),
    );
  });

  it('takes a future order inside the store\'s hours', async () => {
    const at = nextIst(1, 10 * 60); // a future Monday, 10:00 IST
    expect(istParts(at).minute).toBe(600);
    const res = await submit({ scheduledFor: at.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.phoneOrder.scheduledFor).toBe(at.toISOString());
  });

  it('refuses a future order outside them, with the same code the selector showed', async () => {
    const at = nextIst(1, 20 * 60); // a future Monday, 20:00 IST — after 17:00
    // The selector and the submission must agree, or an operator can be shown a
    // store as open and then refused by it.
    expect(await reasonsAt(primary, at)).toContain('CLOSED_AT_FULFILMENT');

    const res = await submit({ scheduledFor: at.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('POS_BRANCH_UNAVAILABLE');
    expect(res.body.error.details.unavailableReasons.map((r) => r.code))
      .toContain('CLOSED_AT_FULFILMENT');
  });

  it('refuses a future order on a day the store is closed, at an hour it otherwise trades', async () => {
    const at = nextIst(dow, 12 * 60); // a future Wednesday, midday
    const res = await submit({ branchId: other.id, scheduledFor: at.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.details.unavailableReasons.map((r) => r.code))
      .toContain('CLOSED_AT_FULFILMENT');

    // Control: the same store, same clock time, a day it is not closed.
    const openDay = await submit({
      branchId: other.id,
      scheduledFor: nextIst((dow + 1) % 7, 12 * 60).toISOString(),
    });
    expect(openDay.status, JSON.stringify(openDay.body)).toBe(201);
  });

  it('refuses a scheduled time that has already passed', async () => {
    const res = await submit({ scheduledFor: new Date(Date.now() - 60 * MIN_MS).toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('scheduledFor');
  });

  it('refuses a scheduled time one second in the past, not only an obviously stale one', async () => {
    const res = await submit({ scheduledFor: new Date(Date.now() - 1000).toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('scheduledFor');
  });
});

describe('reassignment is judged at the order\'s own time, not at the moment it is moved', () => {
  // This is the pair that separates the two clocks. Both requests are made at
  // the same instant, to the same store, with the same hours in the database —
  // and they must get opposite answers, because one order is for tomorrow and
  // the other is for now.
  let shutTomorrow;

  beforeAll(async () => {
    shutTomorrow = tomorrowIstDow();
    await setHours(primary, allWeek());
    await setHours(
      other,
      DAYS.map((d) => ({ dayOfWeek: d, opensMinute: 0, closesMinute: 1440, closed: d === shutTomorrow })),
    );
  });

  it('refuses a move to a store that is shut on the day the order is FOR', async () => {
    const at = nextIst(shutTomorrow, 12 * 60);
    const created = await submit({ scheduledFor: at.toISOString() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const res = await reassign(created.body.phoneOrder.id, other.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('POS_BRANCH_UNAVAILABLE');
    expect(res.body.error.details.unavailableReasons.map((r) => r.code))
      .toContain('CLOSED_AT_FULFILMENT');
  });

  it('allows a move to that very same store for an order wanted now', async () => {
    // The control for the test above, and the reason it is not merely asserting
    // that `other` is unreachable: `other` is open every day except tomorrow,
    // and an ASAP order is judged at today's clock.
    const created = await submit({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.phoneOrder.scheduledFor).toBeNull();

    const res = await reassign(created.body.phoneOrder.id, other.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.phoneOrder.routedBranchId).toBe(other.id);
  });
});

describe('preparation slots, and where their edges actually fall', () => {
  const SLOT_MIN = 15;
  const SLOT_MS = SLOT_MIN * MIN_MS;

  beforeAll(async () => {
    await setHours(primary, allWeek());
    await setHours(other, allWeek());
    await setCapacity(other, { slotMinutes: SLOT_MIN, maxOrdersPerSlot: 1 });
  });

  afterAll(async () => {
    await setCapacity(other, null);
  });

  it('counts a booking against its own slot and not the next one', async () => {
    // The slot floor is computed here by plain arithmetic rather than by
    // calling slotBoundsFor, so this is a second opinion about where the edge
    // is and not the implementation agreeing with itself.
    const base = Math.ceil((Date.now() + 2 * 3600e3) / SLOT_MS) * SLOT_MS;
    const inSlot = new Date(base + 2 * MIN_MS);
    const lateInSlot = new Date(base + 14 * MIN_MS);
    const nextSlot = new Date(base + 16 * MIN_MS);

    const booked = await submit({ branchId: other.id, scheduledFor: inSlot.toISOString() });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);

    const full = await optionAt(other, lateInSlot);
    expect(full.unavailableReasons.map((r) => r.code)).toContain('AT_CAPACITY');
    expect(full.capacity).toEqual({ slotMinutes: SLOT_MIN, maxOrdersPerSlot: 1, booked: 1 });

    const free = await optionAt(other, nextSlot);
    expect(free.unavailableReasons).toEqual([]);
    expect(free.capacity).toEqual({ slotMinutes: SLOT_MIN, maxOrdersPerSlot: 1, booked: 0 });
  });

  it('puts an hourly slot boundary at half past the IST hour — a UTC/IST seam', async () => {
    // Pinning current behaviour, not endorsing it. slotBoundsFor floors the
    // epoch, so slots align to UTC. IST is +05:30, so any slot size that 330
    // does not divide lands off the IST clock: a 60-minute prep slot configured
    // as "the 10 o'clock hour" actually runs 09:30-10:30 IST. 15 and 30 minute
    // slots divide 330 and are unaffected, which is why the default of 15 has
    // never shown this.
    const hourly = slotBoundsFor(istInstant(2026, 6, 8, 10 * 60), 60);
    expect(istParts(hourly.start).minute).toBe(9 * 60 + 30);
    expect(istParts(hourly.end).minute).toBe(10 * 60 + 30);

    for (const size of [15, 30]) {
      const aligned = slotBoundsFor(istInstant(2026, 6, 8, 10 * 60), size);
      expect(istParts(aligned.start).minute % size, `${size}-minute slot`).toBe(0);
    }
  });
});
