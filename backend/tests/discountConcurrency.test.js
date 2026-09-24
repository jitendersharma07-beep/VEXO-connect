// Can two requests that are each legal end up in a state that is not?
//
// discounts.test.js already covers the easy replay: the same order discount
// fired ten times concurrently. That one is safe by construction, because
// "set the order discount to 30%" is idempotent — ten of them leave 30%.
//
// This file exists for the case that is NOT idempotent by luck. A bill has two
// lines. Two requests arrive at the same instant, each discounting a different
// line, each on its own comfortably inside the operator's ceiling. The guard
// measures the order, decides, and only then writes — so if both measure before
// either writes, both see an undiscounted bill and both say yes.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('discountConcurrency.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { resetApprovalThrottle } = await import('../src/lib/discountGuard.js');

const app = createApp();

const wipe = async () => {
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
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
const users = {};
let hotel, h1, coffee, chai;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// Two lines, ₹500 each — a ₹1000 gross, so a percentage and a rupee figure are
// the same number and the arithmetic below stays readable.
const twoLineOrder = async (token) => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({
      type: 'TAKEAWAY',
      branchId: h1.id,
      items: [{ productId: coffee, qty: 1 }, { productId: chai, qty: 1 }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.order.items).toHaveLength(2);
  return res.body.order;
};

const getOrder = async (token, id) => {
  const res = await request(app).get(`/api/orders/${id}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
};

const lineDiscount = (token, order, idx, value, approval) =>
  request(app)
    .patch(`/api/orders/${order.id}/items/${order.items[idx].id}`)
    .set(auth(token))
    .send({ lineDiscount: value, ...(approval ? { approval } : {}) });

const orderDiscount = (token, id, body) =>
  request(app).post(`/api/orders/${id}/discount`).set(auth(token)).send(body);

// What the bill actually gives away, as a share of gross, read back from the
// database rather than from any response body.
const combinedShare = async (orderId) => {
  const row = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  const active = row.items.filter((i) => i.status === 'ACTIVE');
  const gross = active.reduce((n, i) => n + Math.round(Number(i.unitPrice) * 100) * i.qty, 0);
  const lineOff = active.reduce((n, i) => n + Math.round(Number(i.lineDiscount) * 100), 0);
  const net = gross - lineOff;
  let orderOff = 0;
  if (row.discountType === 'FLAT') orderOff = Math.round(Number(row.discountValue) * 100);
  else if (row.discountType === 'PERCENT') {
    orderOff = Math.round((net * Math.round(Number(row.discountValue) * 1000)) / 100000);
  }
  const combined = lineOff + orderOff;
  return { gross, combined, pct: gross === 0 ? 0 : (combined / gross) * 100 };
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);

  hotel = await prisma.company.create({
    data: {
      name: 'Hotel Halt',
      slug: 'hotel-halt',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  h1 = await prisma.branch.create({ data: { companyId: hotel.id, publicId: 'VC-DK-0001', name: 'Hotel One', code: 'H1' } });

  const mk = async (key, data) => {
    users[key] = await prisma.posUser.create({ data: { passwordHash, ...data } });
    tokens[key] = await login(data.email);
  };
  await mk('ownerH', {
    email: 'owner.h@test.local', fullName: 'Owner H', role: 'CUSTOMER_OWNER', companyId: hotel.id,
  });
  await mk('mgrH1', {
    email: 'mgr.h1@test.local', fullName: 'Manager H1', role: 'BRANCH_MANAGER', companyId: hotel.id, branchId: h1.id,
  });
  await mk('cashierH1', {
    email: 'cashier.h1@test.local', fullName: 'Cashier H1', role: 'CASHIER', companyId: hotel.id, branchId: h1.id,
  });

  await prisma.discountPolicy.create({
    data: {
      companyId: hotel.id, level: 'COMPANY', scopeKey: 'company',
      allowLineDiscount: true, allowOrderDiscount: true,
      maxPercent: '10.000', note: 'A tenth of the bill, and no more',
    },
  });
  await prisma.discountPolicy.create({
    data: {
      companyId: hotel.id, level: 'USER', scopeKey: `user:${users.mgrH1.id}`, userId: users.mgrH1.id,
      canApprove: true, maxApprovalPercent: '50.000', note: 'May sign for half',
    },
  });

  const tax = await prisma.taxRate.create({
    data: { companyId: hotel.id, name: 'GST 5', ratePercent: '5.000' },
  });
  const cat = await prisma.category.create({ data: { companyId: hotel.id, name: 'Drinks' } });
  coffee = (await prisma.product.create({
    data: {
      companyId: hotel.id, categoryId: cat.id, taxRateId: tax.id,
      name: 'Filter Coffee', basePrice: '500.00',
    },
  })).id;
  chai = (await prisma.product.create({
    data: {
      companyId: hotel.id, categoryId: cat.id, taxRateId: tax.id,
      name: 'Masala Chai', basePrice: '500.00',
    },
  })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// A race is won or lost on scheduling, so one attempt proves very little: with
// the lock deliberately removed, a single pair slipped through on roughly one
// run in three. Repeating the race on ROUNDS fresh orders raises that, but only
// so far — measured against the unlocked build the per-round breach rate is
// itself unstable, and at forty rounds one of the three cases below caught
// nothing at all. Under load the two requests stop overlapping: whichever wins
// the event loop finishes before the other measures, and the race quietly
// stops being a race. More rounds make that worse, not better, because they
// make the machine busier.
//
// So these three are a backstop, not the guard. They answer "does this happen
// against the real routes, with nothing instrumented" — worth having, and worth
// nothing as a proof of absence. The proof is the deterministic test at the
// bottom of this file, which holds the row itself and cannot miss.
//
// Twelve rounds is the compromise: enough to catch a regression most of the
// time, quick enough that the suite stays usable.
const ROUNDS = 12;

// Each race case gets an explicit, generous timeout. At forty rounds these
// overran vitest's 20s default and reported as failures — which looked exactly
// like a caught breach in the summary line and was nothing of the kind. A race
// test that goes red when it is merely slow is worse than no test, because it
// reads as proof.
const RACE_TIMEOUT_MS = 90_000;

const raceRounds = async (label, ceiling, attempt) => {
  const breaches = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const order = await twoLineOrder(tokens.cashierH1);
    const statuses = (await attempt(order)).map((r) => r.status);
    const { pct, combined } = await combinedShare(order.id);
    if (pct > ceiling) breaches.push({ round: i, pct, combined, statuses });
  }
  resetApprovalThrottle();
  expect(
    breaches,
    `${label}: ${breaches.length}/${ROUNDS} rounds exceeded the ${ceiling}% ceiling — ` +
      JSON.stringify(breaches),
  ).toEqual([]);
};

describe('two legal discounts arriving at the same instant', () => {
  it('cannot combine into one that is over the ceiling', async () =>
    // ₹100 off one line and ₹100 off the other. Each is 10% of a ₹1000 bill
    // and each, measured alone against an undiscounted order, is exactly at
    // the cashier's limit. Together they are 20% — which the cashier may not
    // give and nobody approved.
    raceRounds('two line discounts', 10, (order) =>
      Promise.all([
        lineDiscount(tokens.cashierH1, order, 0, 100),
        lineDiscount(tokens.cashierH1, order, 1, 100),
      ]),
    ), RACE_TIMEOUT_MS);

  it('cannot stack a line discount and an order discount past the ceiling', async () =>
    // The same race across two DIFFERENT endpoints, which is the harder case:
    // they do not contend on one row, so nothing about the write path forces
    // them to serialise.
    raceRounds('line against order discount', 10, (order) =>
      Promise.all([
        lineDiscount(tokens.cashierH1, order, 0, 100),
        orderDiscount(tokens.cashierH1, order.id, { type: 'FLAT', value: 100 }),
      ]),
    ), RACE_TIMEOUT_MS);

  it('cannot spend one approval on two different lines at once', async () => {
    // One manager password, two requests. Even at the approver's own 50%
    // ceiling the pair must not exceed what was actually signed for on each.
    const approval = {
      approverEmail: 'mgr.h1@test.local', password: PW, reason: 'Spillage on both',
    };
    await raceRounds('one approval, two lines', 50, (order) =>
      Promise.all([
        lineDiscount(tokens.cashierH1, order, 0, 300, approval),
        lineDiscount(tokens.cashierH1, order, 1, 300, approval),
      ]),
    );
  }, RACE_TIMEOUT_MS);
});

// The deterministic half. Instead of firing two requests and hoping they
// collide, this test BECOMES the competing request: it takes the order row
// itself, writes the other line's discount, and holds the lock until the real
// request has had time to arrive and queue behind it.
//
// That makes the ordering a fact rather than a coin toss, and it is the only
// test here that distinguishes the two builds every single time:
//
//   with the lock — the request waits, re-reads the bill AFTER acquiring the
//   row, sees the 10% already given away, and refuses with a 409.
//
//   without it — the request's re-read runs before this transaction commits,
//   so it still sees an undiscounted bill, says yes, and then blocks at its
//   own write instead. The lock it eventually waits on is the wrong one: by
//   then the decision is already made. It commits a second 10% on top.
//
// The distinction being measured is not "does it block" — both builds block,
// which is why the obvious version of this test proves nothing. It is whether
// the re-measurement happens on the near side of the lock or the far side.
describe('a request that is overtaken while it waits', () => {
  it('re-reads the bill after taking the lock, not before', async () => {
    const order = await twoLineOrder(tokens.cashierH1);

    let commitNow;
    const proceed = new Promise((resolve) => {
      commitNow = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
        // ₹100 off the other line: exactly the cashier's whole 10% allowance,
        // committed by somebody else while this request is in the air.
        await tx.orderItem.update({
          where: { id: order.items[1].id },
          data: { lineDiscount: '100.00' },
        });
        await proceed;
      },
      { timeout: 30000 },
    );

    // Let the holder actually take the row before the request goes near it.
    await new Promise((r) => setTimeout(r, 250));

    // supertest requests are lazy — they do not leave until something subscribes,
    // so the .then() is what puts this one on the wire. Without it the request
    // would not exist yet and the wait below would be waiting on nothing.
    const inFlight = lineDiscount(tokens.cashierH1, order, 0, 100).then((r) => r);

    // Long enough for the request to reach the lock and queue.
    await new Promise((r) => setTimeout(r, 600));
    commitNow();
    await holder;

    const res = await inFlight;
    const { pct, combined } = await combinedShare(order.id);

    expect(
      pct,
      `the bill gave away ${combined} paise (${pct}%) against a 10% ceiling; ` +
        `the overtaken request answered ${res.status}`,
    ).toBeLessThanOrEqual(10);
    expect(
      res.status,
      `expected the overtaken request to be refused as a conflict, got ${res.status}: ` +
        JSON.stringify(res.body),
    ).toBe(409);
  }, 60_000);
});

describe('a captured approved request, sent again later', () => {
  it('does not add a second helping of the item it approved', async () => {
    // Sequential replay, not a race: the till got its answer, and the same
    // bytes are sent again a second later. For a route with add semantics
    // that is a second item, not a second copy of the same decision.
    const order = await twoLineOrder(tokens.cashierH1);
    const body = {
      items: [{ productId: coffee, qty: 1 }],
      approval: { approverEmail: 'mgr.h1@test.local', password: PW, reason: 'Comped' },
    };
    const first = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set(auth(tokens.cashierH1))
      .send(body);
    const second = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set(auth(tokens.cashierH1))
      .send(body);
    resetApprovalThrottle();

    const row = await prisma.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    const coffees = row.items
      .filter((i) => i.status === 'ACTIVE' && i.productId === coffee)
      .reduce((n, i) => n + i.qty, 0);
    expect(
      coffees,
      `replay left ${coffees} coffees; responses were ${first.status} and ${second.status}`,
    ).toBe(1);
  });
});
