// LANE reporting — the exception worklist, and the two lies it must not tell.
//
// The first lie is a zero. A detector this build cannot run must say so and never
// report "0 found", because on a screen those look identical and only one of them
// means nobody has to act. Every test naming an undetectable kind asserts
// `found: null` and the sentence beside it, not a count.
//
// The second lie is a false clear. Re-scanning must not re-open what somebody has
// acknowledged, must not auto-close a historical fact, and when it does auto-close
// a condition that genuinely went away it must not put a person's name against
// it. Those three are asserted separately because they fail separately.
//
// Detector arithmetic is asserted on fixtures placed either side of the declared
// threshold, in pairs. A single over-threshold fixture would pass against a
// detector that raised everything.
//
// Runs ONLY against a database whose name ends in _test — this suite truncates.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('reportingExceptions.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { EXCEPTION_THRESHOLDS, DETECTOR_KINDS } = await import('../src/lib/reporting/exceptions.js');
const { REPORTING_DEFAULTS, businessDateOf, addDays } = await import('../src/lib/reporting/period.js');

const app = createApp();

const wipe = async () => {
  await prisma.reportDelivery.deleteMany();
  await prisma.reportScheduleRecipient.deleteMany();
  await prisma.reportSchedule.deleteMany();
  await prisma.reportRecipient.deleteMany();
  await prisma.reportingException.deleteMany();
  await prisma.reportingSetting.deleteMany();
  // A correcting closing points at the one it replaces, so the chain has to be
  // broken before the rows can go.
  await prisma.dayClose.updateMany({ data: { supersededById: null } });
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.kitchenItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.kitchenCursor.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
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
  await prisma.supportAccessGrant.deleteMany();
  await prisma.permissionRule.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.device.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.branchBrand.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.gstRegistration.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.region.deleteMany({ where: { parentId: { not: null } } });
  await prisma.region.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'reporting-password-1';
const DAY = 86400e3;
const MIN = 60e3;

// The four detectors this build has no data source for. Named here so the tests
// below assert against a list rather than a count: adding a seventh runnable
// detector must not quietly turn one of these green.
const UNDETECTABLE = ['LOW_STOCK', 'NEAR_EXPIRY', 'OVERDUE_REQUEST', 'SETTLEMENT_MISMATCH'];

let companyX, companyY;
let x1, x2, x3, x4, y1;
let ownerXId, coffeeId;
const tokens = {};
const ids = {};

const S = REPORTING_DEFAULTS;
const TODAY = () => businessDateOf(S, new Date());
// Three finished days plus today. Wide enough that every fixture below sits
// inside it, narrow enough that the unclosed-day assertions name known dates.
const RANGE = () => `preset=CUSTOM&from=${addDays(TODAY(), -3)}&to=${TODAY()}`;

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};
const post = (p, token, body) => request(app).post(p).set(auth(token)).send(body ?? {});
const get = (p, token) => request(app).get(p).set(auth(token));

const scan = async (token = tokens.ownerX) => {
  const res = await post(`/api/reporting/exceptions/scan?${RANGE()}`, token);
  expect(res.status, `scan: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};
const rollOf = (body) => Object.fromEntries(body.detectors.map((d) => [d.kind, d]));

const listOpen = async (token = tokens.ownerX) => {
  const res = await get(`/api/reporting/exceptions?${RANGE()}`, token);
  expect(res.status, `list: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};
const ofKind = (body, kind) => body.exceptions.filter((e) => e.kind === kind);

// `menuValue` is the price on the menu, before any discount — the figure a
// discount rate is a share of. The rest follows computeOrderTotals exactly:
// lineSubtotal is net of the line's own discount and the order subtotal is their
// sum. Writing a gross lineSubtotal next to a lineDiscount would produce a row
// the POS cannot create, and a fixture like that tests nothing — it invents an
// order shape and then measures the detector against the invention.
const bill = async ({
  branchId,
  billedAt,
  menuValue,
  discountAmount = 0,
  lineDiscount = 0,
  items = 1,
  invoiceNumber = null,
  // The till records an order when it is opened. Backdated with billedAt because
  // STALE_BRANCH_DATA asks when a store last recorded anything, and an order
  // created now would make every store in this fixture look like it is trading.
  createdAt,
}) => {
  const per = menuValue / items;
  const subtotal = menuValue - lineDiscount;
  const order = await prisma.order.create({
    data: {
      companyId: companyX.id,
      branchId,
      type: 'DINE_IN',
      status: 'PAID',
      openedById: ownerXId,
      createdAt: createdAt ?? billedAt,
      billedAt,
      invoiceNumber,
      subtotal: subtotal / 100,
      discountAmount: discountAmount / 100,
      taxAmount: 0,
      total: (subtotal - discountAmount) / 100,
      items: {
        create: Array.from({ length: items }, (_, i) => {
          const lineDisc = i === 0 ? lineDiscount : 0;
          return {
            productId: coffeeId,
            name: `Line ${i + 1}`,
            qty: 1,
            unitPrice: per / 100,
            lineDiscount: lineDisc / 100,
            lineSubtotal: (per - lineDisc) / 100,
            discountShare: 0,
            lineTax: 0,
            lineTotal: (per - lineDisc) / 100,
            status: 'ACTIVE',
          };
        }),
      },
    },
    include: { items: { orderBy: { name: 'asc' } } },
  });
  return order;
};

const close = async ({ branchId, businessDate, variancePaise, note = null, closedAt }) => {
  const expected = 500000;
  return prisma.dayClose.create({
    data: {
      companyId: companyX.id,
      branchId,
      businessDate,
      countedCashPaise: expected + variancePaise,
      openingFloatPaise: 0,
      expectedCashPaise: expected,
      cashSalesPaise: expected,
      cashRefundsPaise: 0,
      variancePaise,
      ordersBilled: 1,
      note,
      closedById: ownerXId,
      closedAt,
    },
  });
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyX = await prisma.company.create({
    data: {
      name: 'Exception Alpha',
      slug: 'exception-alpha',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 9, expiresAt: new Date(Date.now() + DAY) },
      },
    },
  });
  companyY = await prisma.company.create({
    data: {
      name: 'Exception Bravo',
      slug: 'exception-bravo',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + DAY) },
      },
    },
  });

  // EX = exceptions; no other suite uses this publicId prefix.
  const mkBranch = (companyId, publicId, name, code) =>
    prisma.branch.create({ data: { companyId, publicId, name, code } });
  x1 = await mkBranch(companyX.id, 'VC-EX-0001', 'Exc One', 'EX1');
  x2 = await mkBranch(companyX.id, 'VC-EX-0002', 'Exc Two', 'EX2');
  // Never trades. The store that proves "silent" is not the same as "new".
  x3 = await mkBranch(companyX.id, 'VC-EX-0003', 'Exc Three', 'EX3');
  // Traded minutes ago. The control for staleness.
  x4 = await mkBranch(companyX.id, 'VC-EX-0004', 'Exc Four', 'EX4');
  y1 = await mkBranch(companyY.id, 'VC-EX-0005', 'Bravo Store', 'EX5');

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  const ownerX = await mk({
    email: 'owner.x@exception.test.local',
    fullName: 'Owner X',
    role: 'CUSTOMER_OWNER',
    companyId: companyX.id,
  });
  ownerXId = ownerX.id;
  await mk({
    email: 'mgr.x1@exception.test.local',
    fullName: 'Mgr X1',
    role: 'BRANCH_MANAGER',
    companyId: companyX.id,
    branchId: x1.id,
  });
  await mk({
    email: 'auditor.x@exception.test.local',
    fullName: 'Auditor X',
    role: 'AUDITOR',
    companyId: companyX.id,
  });
  await mk({
    email: 'cashier.x1@exception.test.local',
    fullName: 'Cashier X1',
    role: 'CASHIER',
    companyId: companyX.id,
    branchId: x1.id,
  });
  const ownerY = await mk({
    email: 'owner.y@exception.test.local',
    fullName: 'Owner Y',
    role: 'CUSTOMER_OWNER',
    companyId: companyY.id,
  });

  const cat = await prisma.category.create({ data: { companyId: companyX.id, name: 'Drinks' } });
  const coffee = await prisma.product.create({
    data: {
      companyId: companyX.id,
      categoryId: cat.id,
      name: 'Filter Coffee',
      sku: 'EX-SKU-COFFEE',
      basePrice: 50,
    },
  });
  coffeeId = coffee.id;

  const yesterday = addDays(TODAY(), -1);
  const twoDaysAgo = addDays(TODAY(), -2);
  const at = (isoDate, hour) => new Date(`${isoDate}T${String(hour).padStart(2, '0')}:30:00+05:30`);

  // -- Trade ---------------------------------------------------------------
  // x1 traded on both finished days, x2 on yesterday, x4 minutes ago.
  const x1TwoDaysAgo = await bill({
    branchId: x1.id,
    billedAt: at(twoDaysAgo, 13),
    menuValue: 200000,
  });
  const x1Yesterday = await bill({
    branchId: x1.id,
    billedAt: at(yesterday, 13),
    menuValue: 300000,
    items: 3,
    invoiceNumber: 'EX1-0001',
  });
  await bill({ branchId: x4.id, billedAt: new Date(Date.now() - 10 * MIN), menuValue: 50000 });

  // -- CASH_DIFFERENCE -----------------------------------------------------
  // Two days ago at x1, over the threshold: raised. Closed 30 hours ago, so its
  // 24-hour due time has already passed and `overdue` is true without waiting.
  const shortClose = await close({
    branchId: x1.id,
    businessDate: twoDaysAgo,
    variancePaise: -45_000,
    closedAt: new Date(Date.now() - 30 * 3600e3),
  });
  ids.shortCloseId = shortClose.id;
  // Yesterday at x2, under the threshold: not raised. The pair is what proves the
  // threshold is applied rather than every closing being flagged.
  await close({
    branchId: x2.id,
    businessDate: yesterday,
    variancePaise: EXCEPTION_THRESHOLDS.cashVariancePaise - 1,
    closedAt: at(yesterday, 23),
  });
  // Two days ago at x2, far over the CRITICAL threshold — then superseded by a
  // correction. A withdrawn figure must not be raised: asking somebody to explain
  // a number they already corrected is how a worklist loses its credibility.
  const wrong = await close({
    branchId: x2.id,
    businessDate: twoDaysAgo,
    variancePaise: -800_000,
    closedAt: at(twoDaysAgo, 23),
  });
  const corrected = await close({
    branchId: x2.id,
    businessDate: twoDaysAgo,
    variancePaise: 0,
    note: 'Recount: the float had not been deducted.',
    closedAt: at(twoDaysAgo, 23),
  });
  await prisma.dayClose.update({ where: { id: corrected.id }, data: { supersededById: wrong.id } });
  ids.supersededCloseId = wrong.id;

  // x1 yesterday is deliberately NOT closed — that is the UNCLOSED_SHIFT fixture.

  // -- UNUSUAL_REFUND ------------------------------------------------------
  await prisma.refund.create({
    data: {
      orderId: x1Yesterday.id,
      amount: EXCEPTION_THRESHOLDS.refundPaise / 100 + 500,
      reason: 'Party cancelled after the food went out',
      status: 'SUCCEEDED',
      byId: ownerXId,
      createdAt: at(yesterday, 20),
    },
  });
  // Under the threshold, same day, same store.
  await prisma.refund.create({
    data: {
      orderId: x1TwoDaysAgo.id,
      amount: 100,
      reason: 'One cold coffee',
      status: 'SUCCEEDED',
      byId: ownerXId,
      createdAt: at(twoDaysAgo, 20),
    },
  });

  // -- UNUSUAL_DISCOUNT ---------------------------------------------------
  // ₹600 off a ₹1,000 menu value: 60%, over the 40% rate threshold and under the
  // ₹1,000 value one, so WARNING rather than CRITICAL.
  await bill({
    branchId: x2.id,
    billedAt: at(yesterday, 14),
    menuValue: 100000,
    lineDiscount: 60000,
    invoiceNumber: 'EX2-0001',
  });
  // 10%: raised by neither threshold.
  await bill({
    branchId: x2.id,
    billedAt: at(yesterday, 15),
    menuValue: 100000,
    lineDiscount: 10000,
    invoiceNumber: 'EX2-0002',
  });

  // -- DELAYED_KITCHEN_ORDER ----------------------------------------------
  const station = await prisma.kitchenStation.create({
    data: {
      companyId: companyX.id,
      branchId: x1.id,
      name: 'Hot pass',
      targetPrepSeconds: 600,
      defaultForBranch: x1.id,
    },
  });
  const kot = await prisma.kot.create({ data: { orderId: x1Yesterday.id, seq: 1 } });
  const [lineA, lineB, lineC] = x1Yesterday.items;
  const queued = at(yesterday, 13);
  const kitchen = (orderItemId, seq, extra) =>
    prisma.kitchenItem.create({
      data: {
        companyId: companyX.id,
        branchId: x1.id,
        orderId: x1Yesterday.id,
        kotId: kot.id,
        orderItemId,
        stationId: station.id,
        changeSeq: seq,
        targetSeconds: 600,
        queuedAt: queued,
        ...extra,
      },
    });
  // 25 minutes against a 10 minute target: over the 2× factor, and it went out.
  await kitchen(lineA.id, 1, { state: 'SERVED', readyAt: new Date(queued.getTime() + 25 * MIN) });
  // Never marked ready. Measured against now, so CRITICAL — somebody may still
  // be sitting at the table.
  await kitchen(lineB.id, 2, { state: 'IN_PREP' });
  // 8 minutes: inside the target, raised by nothing.
  await kitchen(lineC.id, 3, { state: 'SERVED', readyAt: new Date(queued.getTime() + 8 * MIN) });

  // -- The other tenant ----------------------------------------------------
  // A cash difference of its own, so company X's scan has something it must not
  // touch and company Y has something of its own to find. Backdated like X's
  // trade so Y also owns a transient STALE_BRANCH_DATA row: the cross-tenant test
  // below claims the auto-clear does not reach across tenants, and with no
  // transient row at Y that claim would pass without being tested.
  const yOrder = await prisma.order.create({
    data: {
      companyId: companyY.id,
      branchId: y1.id,
      type: 'DINE_IN',
      status: 'PAID',
      openedById: ownerY.id,
      createdAt: at(yesterday, 13),
      billedAt: at(yesterday, 13),
      subtotal: 9999.99,
      discountAmount: 0,
      taxAmount: 0,
      total: 9999.99,
    },
  });
  ids.yOrderId = yOrder.id;
  await prisma.dayClose.create({
    data: {
      companyId: companyY.id,
      branchId: y1.id,
      businessDate: twoDaysAgo,
      countedCashPaise: 100000,
      openingFloatPaise: 0,
      expectedCashPaise: 900000,
      cashSalesPaise: 900000,
      cashRefundsPaise: 0,
      variancePaise: -800000,
      ordersBilled: 1,
      closedById: ownerY.id,
      closedAt: at(twoDaysAgo, 23),
    },
  });

  ids.yesterday = yesterday;
  ids.twoDaysAgo = twoDaysAgo;

  tokens.ownerX = await login('owner.x@exception.test.local');
  tokens.mgrX1 = await login('mgr.x1@exception.test.local');
  tokens.auditorX = await login('auditor.x@exception.test.local');
  tokens.cashierX1 = await login('cashier.x1@exception.test.local');
  tokens.ownerY = await login('owner.y@exception.test.local');
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('reporting exceptions: what the detectors find', () => {
  it('finds a cash difference over the threshold and leaves the one under it alone', async () => {
    const body = await scan();
    const roll = rollOf(body);
    expect(roll.CASH_DIFFERENCE.state).toBe('AVAILABLE');
    expect(roll.CASH_DIFFERENCE.found).toBe(1);
    expect(roll.CASH_DIFFERENCE.responsibleRole).toBe('BRANCH_MANAGER');

    const list = await listOpen();
    const cash = ofKind(list, 'CASH_DIFFERENCE');
    expect(cash).toHaveLength(1);
    const e = cash[0];
    expect(e.branchId).toBe(x1.id);
    expect(e.storeName).toBe('Exc One');
    expect(e.severity).toBe('WARNING');
    expect(e.detail.variance.paise).toBe(-45000);
    // The threshold that made it an exception travels with it. An owner asking
    // "why is this here" is owed the number, not a policy document.
    expect(e.detail.threshold.paise).toBe(EXCEPTION_THRESHOLDS.cashVariancePaise);
    // Closed 30 hours ago against a 24-hour clock that starts at the closing, so
    // it is already overdue. Computed on the server, so two clients cannot
    // disagree about it.
    expect(e.dueAt).toBeTruthy();
    expect(e.overdue).toBe(true);
    expect(e.responsibleRole).toBe('BRANCH_MANAGER');

    // The under-threshold closing is absent, so the threshold is real.
    expect(cash.map((c) => c.detail.businessDate)).toEqual([ids.twoDaysAgo]);
  });

  it('never raises a closing that has been superseded by a correction', async () => {
    const list = await listOpen();
    const titles = ofKind(list, 'CASH_DIFFERENCE').map((e) => e.title);
    // ₹8,000 short would be CRITICAL if it were raised at all. Its absence is the
    // assertion, and the amount is distinctive so the absence cannot be accidental.
    expect(titles.join(' ')).not.toContain('8000');
    const raised = await prisma.reportingException.findMany({
      where: { kind: 'CASH_DIFFERENCE', companyId: companyX.id },
      select: { dedupeKey: true },
    });
    expect(raised.map((r) => r.dedupeKey)).toEqual([`CASH_DIFFERENCE:${ids.shortCloseId}`]);
    expect(raised.map((r) => r.dedupeKey)).not.toContain(
      `CASH_DIFFERENCE:${ids.supersededCloseId}`,
    );
  });

  it('finds a business day that traded and was never closed, and spares today', async () => {
    const list = await listOpen();
    const unclosed = ofKind(list, 'UNCLOSED_SHIFT');
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0].branchId).toBe(x1.id);
    expect(unclosed[0].detail.businessDate).toBe(ids.yesterday);
    expect(unclosed[0].detail.billsTaken).toBe(1);
    // Today has traded at x4 and is not closed either. It is the evening, not an
    // exception, and raising it would put a permanent unfixable row on the list.
    expect(unclosed.map((u) => u.detail.businessDate)).not.toContain(TODAY());
    // x2 closed yesterday, so it is not on the list despite having traded.
    expect(unclosed.map((u) => u.branchId)).not.toContain(x2.id);
  });

  it('finds the large refund and not the small one', async () => {
    const list = await listOpen();
    const refunds = ofKind(list, 'UNUSUAL_REFUND');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].detail.amount.paise).toBe(EXCEPTION_THRESHOLDS.refundPaise + 50000);
    expect(refunds[0].severity).toBe('WARNING');
    expect(refunds[0].detail.reason).toMatch(/Party cancelled/);
    expect(refunds[0].responsibleRole).toBe('FINANCE');
  });

  it('finds the heavily discounted bill by rate, and states the rate it used', async () => {
    const list = await listOpen();
    const discounts = ofKind(list, 'UNUSUAL_DISCOUNT');
    expect(discounts).toHaveLength(1);
    expect(discounts[0].detail.invoiceNumber).toBe('EX2-0001');
    expect(discounts[0].detail.discountRatePercent).toBe(60);
    expect(discounts[0].detail.discount.paise).toBe(60000);
    // Over the rate threshold but under the value one, so WARNING not CRITICAL.
    expect(discounts[0].severity).toBe('WARNING');
    // The 10% bill is absent.
    expect(discounts.map((d) => d.detail.invoiceNumber)).not.toContain('EX2-0002');
  });

  it('separates an item that went out late from one still in the pass', async () => {
    const list = await listOpen();
    const late = ofKind(list, 'DELAYED_KITCHEN_ORDER');
    expect(late).toHaveLength(2);

    const served = late.find((e) => e.detail.stillWaiting === false);
    const waiting = late.find((e) => e.detail.stillWaiting === true);
    expect(served.detail.takenSeconds).toBe(25 * 60);
    expect(served.detail.overrunFactor).toBe(2.5);
    expect(served.severity).toBe('WARNING');
    expect(served.detail.basis).toMatch(/queuedAt to readyAt/);

    // Still waiting is worse, and measured against now rather than against a
    // readyAt it does not have. Stated relative to the served line rather than as
    // a number of hours: both were queued at the same moment, so the only way the
    // waiting one can be measured against anything but the clock is to be smaller,
    // and a fixed threshold here would make the suite's result depend on the time
    // of day it ran.
    expect(waiting.severity).toBe('CRITICAL');
    expect(waiting.detail.takenSeconds).toBeGreaterThan(served.detail.takenSeconds);
    expect(waiting.detail.basis).toMatch(/has not been marked ready/);

    // The 8-minute line is inside its target and absent from both.
    expect(late.every((e) => e.detail.takenSeconds > e.detail.targetSeconds * 2)).toBe(true);
  });

  it('calls a silent store stale and a store that never traded neither stale nor fine', async () => {
    const list = await listOpen();
    const stale = ofKind(list, 'STALE_BRANCH_DATA');
    const branchIds = stale.map((e) => e.branchId);
    // x1 and x2 last recorded something yesterday, well past the 180-minute
    // default.
    expect(branchIds).toContain(x1.id);
    expect(branchIds).toContain(x2.id);
    // x4 traded ten minutes ago: nothing has stopped.
    expect(branchIds).not.toContain(x4.id);
    // x3 has never recorded anything. Nothing has stopped there either, and
    // paging a regional manager hourly about a store that opens next month is how
    // alerting gets switched off.
    expect(branchIds).not.toContain(x3.id);

    const e = stale.find((s) => s.branchId === x1.id);
    expect(e.detail.staleAfterMinutes).toBe(S.staleAfterMinutes);
    expect(e.detail.silentMinutes).toBeGreaterThan(S.staleAfterMinutes);
    expect(e.responsibleRole).toBe('REGIONAL_MANAGER');
  });
});

describe('reporting exceptions: what cannot be detected here says so', () => {
  it('reports found: null and a reason for every detector this build cannot run', async () => {
    const body = await scan();
    const roll = rollOf(body);
    for (const kind of UNDETECTABLE) {
      const d = roll[kind];
      expect(d, kind).toBeTruthy();
      // The whole point. `0` would read as "looked, found none".
      expect(d.found, kind).toBe(null);
      expect(d.state, kind).not.toBe('AVAILABLE');
      expect(typeof d.note, kind).toBe('string');
      expect(d.note.length, kind).toBeGreaterThan(20);
    }
    // Stock is UNAVAILABLE because the model is absent; settlement is
    // PENDING_INTEGRATION because no provider is connected. Two different asks of
    // the owner, so they must not be collapsed into one state.
    expect(roll.LOW_STOCK.state).toBe('UNAVAILABLE');
    expect(roll.LOW_STOCK.note).toMatch(/not a statement that stock is sufficient/i);
    expect(roll.SETTLEMENT_MISMATCH.state).toBe('PENDING_INTEGRATION');
    expect(roll.SETTLEMENT_MISMATCH.note).toMatch(/no payment provider/i);

    // And they are listed, not silently dropped: a screen showing six kinds when
    // there are ten is the failure this replaces.
    expect(body.summary.undetectable.map((u) => u.kind).sort()).toEqual([...UNDETECTABLE].sort());
    expect(DETECTOR_KINDS).toHaveLength(10);
  });

  it('the list route publishes the kinds and thresholds so a screen need not guess', async () => {
    const list = await listOpen();
    expect(list.kinds).toEqual(DETECTOR_KINDS);
    expect(list.thresholds.cashVariancePaise).toBe(EXCEPTION_THRESHOLDS.cashVariancePaise);
    expect(list.thresholds.discountRatePercent).toBe(EXCEPTION_THRESHOLDS.discountRatePercent);
  });
});

describe('reporting exceptions: scanning twice', () => {
  it('raises once and refreshes thereafter', async () => {
    const before = await prisma.reportingException.count({ where: { companyId: companyX.id } });
    expect(before).toBeGreaterThan(0);

    const again = await scan();
    expect(again.raised).toBe(0);
    expect(again.refreshed).toBe(before);
    const after = await prisma.reportingException.count({ where: { companyId: companyX.id } });
    // Idempotent. Three schedules scanning at once must not leave three copies of
    // one drawer shortage.
    expect(after).toBe(before);
  });

  it('does not re-open something a person has already acknowledged', async () => {
    const list = await listOpen();
    const cash = ofKind(list, 'CASH_DIFFERENCE')[0];
    const ack = await post(`/api/reporting/exceptions/${cash.id}`, tokens.ownerX, {
      status: 'ACKNOWLEDGED',
    });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('ACKNOWLEDGED');
    expect(ack.body.acknowledgedAt).toBeTruthy();

    await scan();
    const row = await prisma.reportingException.findUnique({ where: { id: cash.id } });
    // Re-opening it would make the acknowledgement meaningless and the list
    // unfinishable.
    expect(row.status).toBe('ACKNOWLEDGED');
    expect(row.acknowledgedById).toBeTruthy();
  });

  it('refreshes the title of a finding whose underlying figure was corrected', async () => {
    const list = await listOpen();
    const cash = ofKind(list, 'CASH_DIFFERENCE')[0];
    const titleBefore = cash.title;
    await prisma.dayClose.update({
      where: { id: ids.shortCloseId },
      data: { variancePaise: -46_000, countedCashPaise: 500000 - 46_000 },
    });
    await scan();
    const row = await prisma.reportingException.findUnique({ where: { id: cash.id } });
    expect(row.title).not.toBe(titleBefore);
    expect(row.detail.variance.paise).toBe(-46000);
    // Same row, same detectedAt: the finding is the same finding, described
    // accurately. A new row would double-count one drawer.
    expect(row.detectedAt.toISOString()).toBe(cash.detectedAt);
  });
});

describe('reporting exceptions: clearing', () => {
  it('a condition that went away is cleared by the scan, with nobody’s name on it', async () => {
    const before = await listOpen();
    const unclosed = ofKind(before, 'UNCLOSED_SHIFT')[0];
    expect(unclosed).toBeTruthy();

    // The manager closes the day. The exception is now a description of something
    // that used to be wrong.
    await close({
      branchId: x1.id,
      businessDate: ids.yesterday,
      variancePaise: 0,
      closedAt: new Date(),
    });

    const rescan = await scan();
    expect(rescan.cleared).toBeGreaterThanOrEqual(1);

    const row = await prisma.reportingException.findUnique({ where: { id: unclosed.id } });
    expect(row.status).toBe('RESOLVED');
    expect(row.resolvedAt).toBeTruthy();
    // Deliberately nobody. The person who ran the scan did not close the till,
    // and naming them would be a false audit trail.
    expect(row.resolvedById).toBe(null);
    expect(row.resolutionNote).toMatch(/^Cleared automatically/);

    const after = await listOpen();
    expect(ofKind(after, 'UNCLOSED_SHIFT')).toHaveLength(0);
    // And the payload says which of the two it was, so "somebody fixed it" and
    // "it stopped being true" stay distinguishable.
    const closedRow = await get(`/api/reporting/exceptions?status=RESOLVED&${RANGE()}`, tokens.ownerX);
    const cleared = closedRow.body.exceptions.find((e) => e.id === unclosed.id);
    expect(cleared.clearedBySystem).toBe(true);
  });

  it('a historical fact is never cleared by a scan', async () => {
    // The cash difference happened. It stays until a person signs it off, even
    // after the drawer has long since been recounted.
    const row = await prisma.reportingException.findFirst({
      where: { kind: 'CASH_DIFFERENCE', companyId: companyX.id },
    });
    expect(['OPEN', 'ACKNOWLEDGED']).toContain(row.status);
    await scan();
    const after = await prisma.reportingException.findUnique({ where: { id: row.id } });
    expect(after.status).toBe(row.status);
    expect(after.resolvedAt).toBe(null);
  });

  it('resolving records who did it, and dismissing needs a reason', async () => {
    const list = await listOpen();
    const refund = ofKind(list, 'UNUSUAL_REFUND')[0];

    const noReason = await post(`/api/reporting/exceptions/${refund.id}`, tokens.ownerX, {
      status: 'DISMISSED',
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.field).toBe('note');

    const dismissed = await post(`/api/reporting/exceptions/${refund.id}`, tokens.ownerX, {
      status: 'DISMISSED',
      note: 'Checked with the manager: the customer paid by card and was refunded to card.',
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe('DISMISSED');
    // A human closed this, so it is NOT a system clear. Reading one as the other
    // is what turns "we checked and it was fine" into "we fixed it".
    expect(dismissed.body.clearedBySystem).toBe(false);
    expect(dismissed.body.resolutionNote).toMatch(/paid by card/);
    // Resolving implies acknowledgement — otherwise the worklist looks as though
    // nobody ever picked it up.
    expect(dismissed.body.acknowledgedAt).toBeTruthy();

    const row = await prisma.reportingException.findUnique({ where: { id: refund.id } });
    expect(row.resolvedById).toBeTruthy();
  });

  it('a dismissed exception leaves the open list and does not come back on re-scan', async () => {
    const list = await listOpen();
    expect(ofKind(list, 'UNUSUAL_REFUND')).toHaveLength(0);
    await scan();
    const after = await listOpen();
    expect(ofKind(after, 'UNUSUAL_REFUND')).toHaveLength(0);
  });
});

describe('reporting exceptions: authority and reach', () => {
  it('a cashier holds no exception action at all', async () => {
    const read = await get('/api/reporting/exceptions', tokens.cashierX1);
    expect(read.status).toBe(403);
    const write = await post('/api/reporting/exceptions/scan', tokens.cashierX1);
    expect(write.status).toBe(403);
  });

  it('an auditor reads and scans the worklist but closes nothing', async () => {
    const read = await get(`/api/reporting/exceptions?${RANGE()}`, tokens.auditorX);
    expect(read.status).toBe(200);
    expect(read.body.exceptions.length).toBeGreaterThan(0);
    // Scanning is part of reading a worklist. Deciding something has been dealt
    // with is not.
    const scanned = await post(`/api/reporting/exceptions/scan?${RANGE()}`, tokens.auditorX);
    expect(scanned.status).toBe(200);

    const close = await post(`/api/reporting/exceptions/${read.body.exceptions[0].id}`, tokens.auditorX, {
      status: 'RESOLVED',
    });
    expect(close.status).toBe(403);
  });

  it('a store manager sees and closes only their own store’s exceptions', async () => {
    const mine = await get(`/api/reporting/exceptions?${RANGE()}`, tokens.mgrX1);
    expect(mine.status).toBe(200);
    const branchIds = new Set(mine.body.exceptions.map((e) => e.branchId).filter(Boolean));
    expect(branchIds.has(x1.id)).toBe(true);
    expect(branchIds.has(x2.id)).toBe(false);

    // Naming an exception at a store they do not hold. 404, the same answer a
    // nonexistent id gets — signing off a cash difference at somebody else's
    // store is exactly what naming a responsible role is meant to prevent.
    const theirs = await prisma.reportingException.findFirst({
      where: { companyId: companyX.id, branchId: x2.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });
    expect(theirs).toBeTruthy();
    const refused = await post(`/api/reporting/exceptions/${theirs.id}`, tokens.mgrX1, {
      status: 'RESOLVED',
    });
    expect(refused.status).toBe(404);
    const unchanged = await prisma.reportingException.findUnique({ where: { id: theirs.id } });
    expect(unchanged.status).toBe(theirs.status);

    // Their own store's, they may close.
    const ownStore = mine.body.exceptions.find((e) => e.branchId === x1.id);
    const allowed = await post(`/api/reporting/exceptions/${ownStore.id}`, tokens.mgrX1, {
      status: 'ACKNOWLEDGED',
    });
    expect(allowed.status).toBe(200);
  });

  it('a scan by one tenant never touches another tenant’s exceptions', async () => {
    const before = await prisma.reportingException.count({ where: { companyId: companyY.id } });
    const yScan = await post(`/api/reporting/exceptions/scan?${RANGE()}`, tokens.ownerY);
    expect(yScan.status).toBe(200);
    const afterY = await prisma.reportingException.count({ where: { companyId: companyY.id } });
    // Y found its own drawer shortage.
    expect(afterY).toBeGreaterThan(before);

    const yList = await get(`/api/reporting/exceptions?${RANGE()}`, tokens.ownerY);
    expect(yList.body.exceptions.every((e) => e.storeName === 'Bravo Store' || e.branchId === null)).toBe(
      true,
    );
    expect(JSON.stringify(yList.body)).not.toContain('Exc One');
    expect(JSON.stringify(yList.body)).not.toContain('Exc Two');

    // And X cannot close Y's.
    const theirs = await prisma.reportingException.findFirst({ where: { companyId: companyY.id } });
    const refused = await post(`/api/reporting/exceptions/${theirs.id}`, tokens.ownerX, {
      status: 'RESOLVED',
    });
    expect(refused.status).toBe(404);

    // X's own scan, run after Y's, must not have resolved or re-raised anything of
    // Y's — the transient auto-clear is the branch most likely to reach across.
    const yOpenBefore = await prisma.reportingException.count({
      where: { companyId: companyY.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });
    await scan();
    const yOpenAfter = await prisma.reportingException.count({
      where: { companyId: companyY.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });
    expect(yOpenAfter).toBe(yOpenBefore);
  });
});

describe('reporting exceptions: on the dashboard', () => {
  it('the dashboard carries the worklist summary for somebody who may read it', async () => {
    const res = await get(`/api/reporting/dashboard?${RANGE()}`, tokens.ownerX);
    expect(res.status).toBe(200);
    expect(res.body.exceptions).toBeTruthy();
    expect(res.body.exceptions.open).toBeGreaterThan(0);
    expect(res.body.exceptions.bySeverity.CRITICAL).toBeGreaterThanOrEqual(1);
    expect(res.body.exceptions.overdue).toBeGreaterThanOrEqual(0);
  });

  it('the counts on the dashboard are the counts in the list', async () => {
    const dash = await get(`/api/reporting/dashboard?${RANGE()}`, tokens.ownerX);
    const list = await listOpen();
    // The two screens must not disagree about how many things need doing.
    expect(dash.body.exceptions.open).toBe(list.summary.open);
    expect(list.exceptions).toHaveLength(list.summary.open);
  });

  it('a manager’s dashboard summary counts only their own stores', async () => {
    const owner = await get(`/api/reporting/dashboard?${RANGE()}`, tokens.ownerX);
    const mgr = await get(`/api/reporting/dashboard?${RANGE()}`, tokens.mgrX1);
    expect(mgr.status).toBe(200);
    expect(mgr.body.exceptions.open).toBeGreaterThan(0);
    // Strictly fewer, not merely different: the owner reaches four stores and the
    // manager one, and x2 has open exceptions of its own.
    expect(mgr.body.exceptions.open).toBeLessThan(owner.body.exceptions.open);
  });
});
