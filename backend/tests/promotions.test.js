// VC-102 promotions: campaigns the owner writes once, and a till that can
// only spend them exactly as written.
//
// The fixture is Alpha, a two-branch company with a small catalog split
// across two categories, and Beta, a second company whose owner must see
// none of it. Every order is built from ₹500 coffees and ₹200 cakes so the
// paise arithmetic in the assertions stays legible.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('promotions.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { scheduleRefusal, eligibleLines, evaluatePromotion, clampBenefits } = await import(
  '../src/lib/promotions.js'
);

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
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
const users = {};
let alpha, beta, a1, a2, b1;
let coffee, chai, cake, betaCoffee;
let coffeeCat, dessertCat;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);

  alpha = await prisma.company.create({
    data: {
      name: 'Alpha Cafe',
      slug: 'alpha-cafe',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inADay } },
    },
  });
  beta = await prisma.company.create({
    data: {
      name: 'Beta Bistro',
      slug: 'beta-bistro',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  a1 = await prisma.branch.create({ data: { companyId: alpha.id, publicId: 'VC-PR-0001', name: 'Alpha One', code: 'A1' } });
  a2 = await prisma.branch.create({ data: { companyId: alpha.id, publicId: 'VC-PR-0002', name: 'Alpha Two', code: 'A2' } });
  b1 = await prisma.branch.create({ data: { companyId: beta.id, publicId: 'VC-PR-0003', name: 'Beta One', code: 'B1' } });

  const mk = async (key, data) => {
    users[key] = await prisma.posUser.create({ data: { passwordHash, ...data } });
    tokens[key] = await login(data.email);
  };
  await mk('ownerA', { email: 'owner.a@promo.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: alpha.id });
  await mk('mgrA1', { email: 'mgr.a1@promo.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: alpha.id, branchId: a1.id });
  await mk('cashierA1', { email: 'cashier.a1@promo.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: alpha.id, branchId: a1.id });
  await mk('cashierA2', { email: 'cashier.a2@promo.local', fullName: 'Cashier A2', role: 'CASHIER', companyId: alpha.id, branchId: a2.id });
  await mk('ownerB', { email: 'owner.b@promo.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: beta.id });

  // Taxless catalog on purpose: total = subtotal − discount, so every
  // assertion below is about the promotion and nothing else.
  coffeeCat = await prisma.category.create({ data: { companyId: alpha.id, name: 'Coffee', sortOrder: 1 } });
  dessertCat = await prisma.category.create({ data: { companyId: alpha.id, name: 'Desserts', sortOrder: 2 } });
  coffee = (await prisma.product.create({
    data: { companyId: alpha.id, categoryId: coffeeCat.id, name: 'Filter Coffee', basePrice: '500.00' },
  })).id;
  chai = (await prisma.product.create({
    data: { companyId: alpha.id, categoryId: coffeeCat.id, name: 'Masala Chai', basePrice: '500.00' },
  })).id;
  cake = (await prisma.product.create({
    data: { companyId: alpha.id, categoryId: dessertCat.id, name: 'Tea Cake', basePrice: '200.00' },
  })).id;

  const catB = await prisma.category.create({ data: { companyId: beta.id, name: 'Coffee', sortOrder: 1 } });
  betaCoffee = (await prisma.product.create({
    data: { companyId: beta.id, categoryId: catB.id, name: 'Filter Coffee', basePrice: '500.00' },
  })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- helpers ------------------------------------------------------------------

const newOrder = async (token, branchId, items) => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ type: 'TAKEAWAY', branchId, items: items ?? [{ productId: coffee, qty: 2 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order;
};

const getOrder = async (token, id) => {
  const res = await request(app).get(`/api/orders/${id}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
};

// Creates AND publishes a campaign as Alpha's owner, with optional store and
// item targeting, and returns the promotion as the API reports it.
const publishPromo = async (body, { branchIds, rules } = {}) => {
  const created = await request(app).post('/api/promotions').set(auth(tokens.ownerA)).send(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.promotion.id;
  if (branchIds) {
    const res = await request(app).put(`/api/promotions/${id}/stores`).set(auth(tokens.ownerA)).send({ branchIds });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  if (rules) {
    const res = await request(app).put(`/api/promotions/${id}/rules`).set(auth(tokens.ownerA)).send({ rules });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const published = await request(app).post(`/api/promotions/${id}/publish`).set(auth(tokens.ownerA)).send({});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body.promotion;
};

const applyPromo = (token, orderId, body) =>
  request(app).post(`/api/orders/${orderId}/promotions`).set(auth(token)).send(body);

const removePromo = (token, orderId, promotionId) =>
  request(app).delete(`/api/orders/${orderId}/promotions/${promotionId}`).set(auth(token));

let seq = 0;
const flat = (paise, extra = {}) => ({
  name: `Flat ${paise} #${(seq += 1)}`,
  benefitType: 'FLAT',
  flatPaise: paise,
  ...extra,
});
const percent = (pct, extra = {}) => ({
  name: `Percent ${pct} #${(seq += 1)}`,
  benefitType: 'PERCENT',
  percent: pct,
  ...extra,
});

// --- boundary arithmetic, no database ------------------------------------------

describe('the schedule, at its exact edges', () => {
  // 2026-01-05 is a Monday. 09:00 IST is 03:30 UTC.
  const istMonday = (h, m) => new Date(Date.UTC(2026, 0, 5, h - 5, m - 30));
  const windowed = { startsAt: null, endsAt: null, weekdayMask: null, startMinute: 9 * 60, endMinute: 17 * 60 };

  it('admits the first minute of the window and refuses the last', () => {
    // Start inclusive, end exclusive — the documented boundary semantics.
    expect(scheduleRefusal(windowed, istMonday(9, 0))).toBeNull();
    expect(scheduleRefusal(windowed, istMonday(8, 59))).toBe('BEFORE_WINDOW');
    expect(scheduleRefusal(windowed, istMonday(16, 59))).toBeNull();
    expect(scheduleRefusal(windowed, istMonday(17, 0))).toBe('AFTER_WINDOW');
  });

  it('treats startsAt as inclusive and endsAt as exclusive', () => {
    const start = new Date('2026-02-01T00:00:00Z');
    const end = new Date('2026-03-01T00:00:00Z');
    const dated = { startsAt: start, endsAt: end, weekdayMask: null, startMinute: null, endMinute: null };
    expect(scheduleRefusal(dated, new Date(start.getTime() - 1))).toBe('NOT_STARTED');
    expect(scheduleRefusal(dated, start)).toBeNull();
    expect(scheduleRefusal(dated, new Date(end.getTime() - 1))).toBeNull();
    expect(scheduleRefusal(dated, end)).toBe('ENDED');
  });

  it('reads the weekday in IST, not UTC', () => {
    // 23:30 IST Monday is 18:00 UTC Monday; 01:00 IST Tuesday is 19:30 UTC
    // Monday. A UTC weekday would call both Monday.
    const mondayOnly = { startsAt: null, endsAt: null, weekdayMask: 1 << 1, startMinute: null, endMinute: null };
    expect(scheduleRefusal(mondayOnly, new Date(Date.UTC(2026, 0, 5, 18, 0)))).toBeNull();
    expect(scheduleRefusal(mondayOnly, new Date(Date.UTC(2026, 0, 5, 19, 30)))).toBe('WRONG_DAY');
  });
});

describe('item rules, resolved line by line', () => {
  const lines = [
    { productId: 'p-coffee', categoryId: 'c-coffee', lineSubtotalPaise: 50000 },
    { productId: 'p-cake', categoryId: 'c-dessert', lineSubtotalPaise: 20000 },
  ];

  it('lets a product rule outrank its own category rule, both ways round', () => {
    const included = eligibleLines(lines, [
      { kind: 'EXCLUDE_CATEGORY', categoryId: 'c-coffee', productId: null },
      { kind: 'INCLUDE_PRODUCT', categoryId: null, productId: 'p-coffee' },
    ]);
    expect(included.map((l) => l.productId)).toContain('p-coffee');

    const excluded = eligibleLines(lines, [
      { kind: 'INCLUDE_CATEGORY', categoryId: 'c-coffee', productId: null },
      { kind: 'EXCLUDE_PRODUCT', categoryId: null, productId: 'p-coffee' },
    ]);
    expect(excluded.map((l) => l.productId)).not.toContain('p-coffee');
  });

  it('turns an include list into a whitelist, and no rules into everything', () => {
    const only = eligibleLines(lines, [{ kind: 'INCLUDE_CATEGORY', categoryId: 'c-dessert', productId: null }]);
    expect(only.map((l) => l.productId)).toEqual(['p-cake']);
    expect(eligibleLines(lines, [])).toHaveLength(2);
  });
});

describe('the clamp, when benefits outgrow the bill', () => {
  it('takes money back from the highest precedence number first, ties by id', () => {
    const granted = clampBenefits(
      [
        { redemptionId: 'r1', promotionId: 'pB', precedence: 100, benefitPaise: 40000 },
        { redemptionId: 'r2', promotionId: 'pA', precedence: 200, benefitPaise: 40000 },
      ],
      60000,
      0,
    );
    expect(granted.get('r1')).toBe(40000);
    expect(granted.get('r2')).toBe(20000);
  });

  it('gives promotions only what the manual discount left behind', () => {
    const granted = clampBenefits(
      [{ redemptionId: 'r1', promotionId: 'pA', precedence: 100, benefitPaise: 40000 }],
      50000,
      30000,
    );
    expect(granted.get('r1')).toBe(20000);
  });
});

// --- the admin surface ----------------------------------------------------------

describe('who may write a campaign', () => {
  it('refuses a cashier the create route outright', async () => {
    const res = await request(app).post('/api/promotions').set(auth(tokens.cashierA1)).send(flat(10000));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('shows each company its own campaigns and nobody else', async () => {
    await publishPromo(flat(5000, { code: `TENANT-${seq}` }));
    const mine = await request(app).get('/api/promotions').set(auth(tokens.ownerA));
    expect(mine.status).toBe(200);
    expect(mine.body.promotions.length).toBeGreaterThan(0);
    const theirs = await request(app).get('/api/promotions').set(auth(tokens.ownerB));
    expect(theirs.status).toBe(200);
    expect(theirs.body.promotions).toHaveLength(0);
  });

  it('refuses a benefit that names both a percentage and a cash figure', async () => {
    const res = await request(app)
      .post('/api/promotions')
      .set(auth(tokens.ownerA))
      .send({ name: 'Both', benefitType: 'FLAT', flatPaise: 5000, percent: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('refuses a time window that wraps midnight', async () => {
    const res = await request(app)
      .post('/api/promotions')
      .set(auth(tokens.ownerA))
      .send(flat(5000, { startMinute: 22 * 60, endMinute: 2 * 60 }));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('bumps the version on an edit only once the campaign has been published', async () => {
    const created = await request(app).post('/api/promotions').set(auth(tokens.ownerA)).send(flat(5000));
    expect(created.status).toBe(201);
    const id = created.body.promotion.id;
    expect(created.body.promotion.version).toBe(1);

    // Drafts are still being written; editing one is not a new version.
    const draftEdit = await request(app).patch(`/api/promotions/${id}`).set(auth(tokens.ownerA)).send(flat(6000));
    expect(draftEdit.status, JSON.stringify(draftEdit.body)).toBe(200);
    expect(draftEdit.body.promotion.version).toBe(1);

    await request(app).post(`/api/promotions/${id}/publish`).set(auth(tokens.ownerA)).send({});
    const liveEdit = await request(app).patch(`/api/promotions/${id}`).set(auth(tokens.ownerA)).send(flat(7000));
    expect(liveEdit.status, JSON.stringify(liveEdit.body)).toBe(200);
    expect(liveEdit.body.promotion.version).toBe(2);
  });
});

// --- the till -------------------------------------------------------------------

describe('applying an offer to an order', () => {
  it('grants a percentage of the eligible base and snapshots what it did', async () => {
    const promo = await publishPromo(percent(10, { code: `TEN-${seq}` }));
    const order = await newOrder(tokens.cashierA1, a1.id); // ₹1000
    const res = await applyPromo(tokens.cashierA1, order.id, { code: promo.code });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(100);
    expect(res.body.order.total).toBe(900);
    const [red] = res.body.order.promotions;
    expect(red).toMatchObject({
      promotionId: promo.id,
      name: promo.name,
      code: promo.code,
      version: 1,
      amount: 100,
      status: 'APPLIED',
    });
    expect(red.appliedBy.id).toBe(users.cashierA1.id);

    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_PROMO_APPLY', entityId: order.id },
    });
    expect(log.actorId).toBe(users.cashierA1.id);
    expect(log.meta).toMatchObject({ promotionId: promo.id, version: 1, branchId: a1.id });
  });

  it('answers another tenant and an unpublished draft in the same words as nothing', async () => {
    const promo = await publishPromo(flat(5000));
    const orderB = await request(app)
      .post('/api/orders')
      .set(auth(tokens.ownerB))
      .send({ type: 'TAKEAWAY', branchId: b1.id, items: [{ productId: betaCoffee, qty: 2 }] });
    expect(orderB.status).toBe(201);
    const crossTenant = await applyPromo(tokens.ownerB, orderB.body.order.id, { promotionId: promo.id });
    expect(crossTenant.status, JSON.stringify(crossTenant.body)).toBe(404);

    const draft = await request(app).post('/api/promotions').set(auth(tokens.ownerA)).send(flat(5000));
    const order = await newOrder(tokens.cashierA1, a1.id);
    const unpublished = await applyPromo(tokens.cashierA1, order.id, { promotionId: draft.body.promotion.id });
    expect(unpublished.status, JSON.stringify(unpublished.body)).toBe(404);
    expect(unpublished.body.error.message).toBe(crossTenant.body.error.message);
  });

  it('honours store targeting: the other branch has no such offer', async () => {
    const promo = await publishPromo(flat(5000), { branchIds: [a2.id] });
    const atA1 = await newOrder(tokens.cashierA1, a1.id);
    const refused = await applyPromo(tokens.cashierA1, atA1.id, { promotionId: promo.id });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);

    const atA2 = await newOrder(tokens.cashierA2, a2.id);
    const ok = await applyPromo(tokens.cashierA2, atA2.id, { promotionId: promo.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.order.discountAmount).toBe(50);
  });

  it('refuses a basket under the spend threshold, and says why', async () => {
    const promo = await publishPromo(flat(5000, { minSpendPaise: 200000 }));
    const order = await newOrder(tokens.cashierA1, a1.id); // ₹1000 < ₹2000
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toContain('BELOW_MIN_SPEND');
    expect((await getOrder(tokens.cashierA1, order.id)).discountAmount).toBe(0);
  });

  it('refuses a basket whose every line the rules exclude', async () => {
    const promo = await publishPromo(flat(5000), {
      rules: [{ kind: 'EXCLUDE_CATEGORY', categoryId: coffeeCat.id }],
    });
    const order = await newOrder(tokens.cashierA1, a1.id); // coffee only
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toContain('NO_ELIGIBLE_ITEMS');
  });

  it('measures a percentage against the eligible lines only, not the bill', async () => {
    const promo = await publishPromo(percent(10), {
      rules: [{ kind: 'INCLUDE_CATEGORY', categoryId: dessertCat.id }],
    });
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 2 }, // ₹1000, not eligible
      { productId: cake, qty: 1 }, // ₹200, eligible
    ]);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(20); // 10% of ₹200
  });

  it('refuses a campaign that has not started yet', async () => {
    const promo = await publishPromo(flat(5000, { startsAt: new Date(Date.now() + 86400e3).toISOString() }));
    const order = await newOrder(tokens.cashierA1, a1.id);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toContain('NOT_STARTED');
  });

  it('applies the same offer to one order once', async () => {
    const promo = await publishPromo(flat(5000));
    const order = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);
    const again = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect((await getOrder(tokens.cashierA1, order.id)).discountAmount).toBe(50);
  });
});

// --- stacking ---------------------------------------------------------------------

describe('two offers on one bill', () => {
  it('lets stackables combine, each computed on the undiscounted base', async () => {
    const ten = await publishPromo(percent(10, { stackable: true }));
    const twenty = await publishPromo(percent(20, { stackable: true }));
    const order = await newOrder(tokens.cashierA1, a1.id); // ₹1000
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: ten.id })).status).toBe(200);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: twenty.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 100 + 200, NOT 100 + 180 — the second is not computed on a shrunk base.
    expect(res.body.order.discountAmount).toBe(300);
    const amounts = res.body.order.promotions.map((p) => p.amount).sort((x, y) => x - y);
    expect(amounts).toEqual([100, 200]);
  });

  it('keeps a non-stackable alone, whichever side arrives second', async () => {
    const alone = await publishPromo(flat(5000)); // stackable defaults false
    const friendly = await publishPromo(flat(3000, { stackable: true }));

    const first = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, first.id, { promotionId: alone.id })).status).toBe(200);
    const blocked = await applyPromo(tokens.cashierA1, first.id, { promotionId: friendly.id });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);

    const second = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, second.id, { promotionId: friendly.id })).status).toBe(200);
    const refused = await applyPromo(tokens.cashierA1, second.id, { promotionId: alone.id });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((await getOrder(tokens.cashierA1, second.id)).discountAmount).toBe(30);
  });
});

// --- the campaign budget ------------------------------------------------------------

describe('a campaign with one redemption left', () => {
  it('gives it to exactly one of two tills asking at the same instant', async () => {
    const promo = await publishPromo(flat(5000, { totalLimit: 1 }));
    const orderOne = await newOrder(tokens.cashierA1, a1.id);
    const orderTwo = await newOrder(tokens.cashierA2, a2.id);
    const [r1, r2] = await Promise.all([
      applyPromo(tokens.cashierA1, orderOne.id, { promotionId: promo.id }),
      applyPromo(tokens.cashierA2, orderTwo.id, { promotionId: promo.id }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses, JSON.stringify([r1.body, r2.body])).toEqual([200, 409]);

    const row = await prisma.promotion.findUnique({ where: { id: promo.id } });
    expect(row.redemptionCount).toBe(1);

    // And a third ask, alone, meets the same refusal — the budget is spent.
    const orderThree = await newOrder(tokens.cashierA1, a1.id);
    const r3 = await applyPromo(tokens.cashierA1, orderThree.id, { promotionId: promo.id });
    expect(r3.status).toBe(409);
    expect(r3.body.error.message).toContain('redemption limit');
  });
});

// --- reversal -------------------------------------------------------------------------

describe('taking an offer back off', () => {
  it('reverses the row, zeroes its amount and releases the campaign slot', async () => {
    const promo = await publishPromo(flat(5000, { totalLimit: 10 }));
    const order = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);

    const res = await removePromo(tokens.cashierA1, order.id, promo.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(0);
    expect(res.body.order.total).toBe(1000);
    const [red] = res.body.order.promotions;
    expect(red).toMatchObject({ status: 'REVERSED', reversedReason: 'REMOVED', amount: 0 });
    expect((await prisma.promotion.findUnique({ where: { id: promo.id } })).redemptionCount).toBe(0);

    // Removing it a second time: it is not on the order any more.
    expect((await removePromo(tokens.cashierA1, order.id, promo.id)).status).toBe(404);
  });

  it('re-applies as a revival of the same row, at the campaign as it NOW reads', async () => {
    const promo = await publishPromo(flat(5000));
    const order = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);
    expect((await removePromo(tokens.cashierA1, order.id, promo.id)).status).toBe(200);

    // The owner edits the live campaign in between: ₹50 becomes ₹80, v2.
    const edited = await request(app)
      .patch(`/api/promotions/${promo.id}`)
      .set(auth(tokens.ownerA))
      .send({ name: promo.name, benefitType: 'FLAT', flatPaise: 8000 });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.promotion.version).toBe(2);

    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(80);
    expect(res.body.order.promotions).toHaveLength(1); // revived, not duplicated
    expect(res.body.order.promotions[0]).toMatchObject({ status: 'APPLIED', version: 2, amount: 80 });
  });

  it('reverses in full on a void, and the row keeps the amount the void undid', async () => {
    const promo = await publishPromo(flat(5000));
    const order = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);
    const before = (await prisma.promotion.findUnique({ where: { id: promo.id } })).redemptionCount;

    const voided = await request(app)
      .post(`/api/orders/${order.id}/void`)
      .set(auth(tokens.mgrA1))
      .send({ reason: 'Customer walked out' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const [red] = voided.body.order.promotions;
    expect(red.status).toBe('REVERSED');
    expect(red.reversedReason).toBe('ORDER_VOID');
    // NOT zeroed: the granted benefit is part of what the void undid.
    expect(red.amount).toBe(50);
    expect((await prisma.promotion.findUnique({ where: { id: promo.id } })).redemptionCount).toBe(before - 1);
  });
});

// --- the basket moves under the offer --------------------------------------------------

describe('a basket edited after the offer went on', () => {
  it('re-decides the benefit when a quantity changes', async () => {
    const promo = await publishPromo(percent(10, { code: `REEVAL-${seq}` }));
    const order = await newOrder(tokens.cashierA1, a1.id); // ₹1000 → ₹100 off
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);

    const res = await request(app)
      .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(auth(tokens.cashierA1))
      .send({ qty: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.subtotal).toBe(500);
    expect(res.body.order.discountAmount).toBe(50);
    expect(res.body.order.promotions[0].amount).toBe(50);
  });

  it('reverses an offer whose only eligible line left the basket', async () => {
    const promo = await publishPromo(flat(2000), {
      rules: [{ kind: 'INCLUDE_CATEGORY', categoryId: dessertCat.id }],
    });
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 2 },
      { productId: cake, qty: 1 },
    ]);
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);

    const cakeLine = order.items.find((i) => i.productId === cake) ??
      (await getOrder(tokens.cashierA1, order.id)).items.find((i) => i.productId === cake);
    const res = await request(app)
      .delete(`/api/orders/${order.id}/items/${cakeLine.id}`)
      .set(auth(tokens.cashierA1))
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(0);
    expect(res.body.order.promotions[0]).toMatchObject({
      status: 'REVERSED',
      reversedReason: 'BASKET_CHANGE',
      amount: 0,
    });
    expect((await prisma.promotion.findUnique({ where: { id: promo.id } })).redemptionCount).toBe(0);
  });
});

// --- history ------------------------------------------------------------------------------

describe('a bill that has already been issued', () => {
  it('keeps the version and amount it was computed under, however the campaign moves on', async () => {
    const promo = await publishPromo(percent(10, { code: `FROZEN-${seq}` }));
    const order = await newOrder(tokens.cashierA1, a1.id);
    expect((await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id })).status).toBe(200);
    const billed = await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.cashierA1)).send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    expect(billed.body.order.total).toBe(900);

    // The owner rewrites the campaign to 50% — version 2 — and pauses it.
    const edited = await request(app)
      .patch(`/api/promotions/${promo.id}`)
      .set(auth(tokens.ownerA))
      .send({ name: promo.name, benefitType: 'PERCENT', percent: 50 });
    expect(edited.status).toBe(200);
    expect(edited.body.promotion.version).toBe(2);
    await request(app).post(`/api/promotions/${promo.id}/pause`).set(auth(tokens.ownerA)).send({});

    const after = await getOrder(tokens.cashierA1, order.id);
    expect(after.total).toBe(900);
    expect(after.discountAmount).toBe(100);
    expect(after.promotions[0]).toMatchObject({ version: 1, amount: 100, status: 'APPLIED' });
  });

  it('cannot take a new offer once billed', async () => {
    const promo = await publishPromo(flat(5000));
    const order = await newOrder(tokens.cashierA1, a1.id);
    const billed = await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.cashierA1)).send({});
    expect(billed.status).toBe(200);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });
});

describe('per-customer redemption limits', () => {
  it('refuses an apply that names no customer when a limit is set', async () => {
    const promo = await publishPromo(flat(5000, { perCustomerLimit: 1 }));
    const order = await newOrder(tokens.cashierA1, a1.id);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/phone/i);
    // the refused apply consumed no campaign slot
    const list = await request(app).get('/api/promotions').set(auth(tokens.ownerA));
    expect(list.body.promotions.find((p) => p.id === promo.id).redemptionCount).toBe(0);
  });

  it('normalises the phone and enforces the cap across orders, not within one', async () => {
    const promo = await publishPromo(flat(5000, { perCustomerLimit: 1 }));
    const first = await newOrder(tokens.cashierA1, a1.id);
    const ok = await applyPromo(tokens.cashierA1, first.id, {
      promotionId: promo.id,
      customerPhone: '+91 98765-43210',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // Same human, differently formatted number, new order: refused.
    const second = await newOrder(tokens.cashierA1, a1.id);
    const dup = await applyPromo(tokens.cashierA1, second.id, {
      promotionId: promo.id,
      customerPhone: '919876543210',
    });
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
    expect(dup.body.error.message).toMatch(/customer has reached/i);

    // A different customer still gets the offer.
    const other = await applyPromo(tokens.cashierA1, second.id, {
      promotionId: promo.id,
      customerPhone: '9811111111',
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
  });

  it('a reversed redemption releases the customer slot; re-apply retakes it', async () => {
    const promo = await publishPromo(flat(5000, { perCustomerLimit: 1 }));
    const first = await newOrder(tokens.cashierA1, a1.id);
    const ok = await applyPromo(tokens.cashierA1, first.id, {
      promotionId: promo.id,
      customerPhone: '9822222222',
    });
    expect(ok.status).toBe(200);
    await removePromo(tokens.cashierA1, first.id, promo.id).expect(200);

    const second = await newOrder(tokens.cashierA1, a1.id);
    const again = await applyPromo(tokens.cashierA1, second.id, {
      promotionId: promo.id,
      customerPhone: '(98) 2222-2222',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it('two concurrent redemptions by the same customer cannot both pass', async () => {
    const promo = await publishPromo(flat(5000, { perCustomerLimit: 1 }));
    const o1 = await newOrder(tokens.cashierA1, a1.id);
    const o2 = await newOrder(tokens.cashierA2, a2.id);
    const [r1, r2] = await Promise.all([
      applyPromo(tokens.cashierA1, o1.id, { promotionId: promo.id, customerPhone: '9833333333' }),
      applyPromo(tokens.cashierA2, o2.id, { promotionId: promo.id, customerPhone: '9833333333' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const rows = await prisma.promotionRedemption.findMany({
      where: { promotionId: promo.id, customerKey: 'ph:9833333333' },
    });
    // ONE row total — the loser's rollback left no REVERSED residue either.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('APPLIED');

    // The rejected apply consumed nothing: campaign capacity counts only the
    // winner, and the losing order's money is untouched.
    const after = await prisma.promotion.findUnique({ where: { id: promo.id } });
    expect(after.redemptionCount).toBe(1);
    const winner = r1.status === 200 ? o1 : o2;
    const loser = winner.id === o1.id ? o2 : o1;
    const loserToken = winner.id === o1.id ? tokens.cashierA2 : tokens.cashierA1;
    const loserOrder = await getOrder(loserToken, loser.id);
    expect(loserOrder.discountAmount).toBe(0);
    expect(loserOrder.total).toBe(loser.total);
    expect(loserOrder.promotions).toHaveLength(0);
  });

  it('a rejected phone shape is a 400 before any slot moves', async () => {
    const promo = await publishPromo(flat(5000, { perCustomerLimit: 2 }));
    const order = await newOrder(tokens.cashierA1, a1.id);
    const res = await applyPromo(tokens.cashierA1, order.id, {
      promotionId: promo.id,
      customerPhone: '12-34',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });
});

// --- modifiers in the eligible base ---------------------------------------------

describe('modifier treatment', () => {
  // Extras on the coffee: syrup ₹50, cream ₹30 — group allows 0..2.
  let group, syrup, cream;

  beforeAll(async () => {
    group = await prisma.modifierGroup.create({
      data: { productId: coffee, name: 'Extras', minSelect: 0, maxSelect: 2 },
    });
    syrup = await prisma.modifierOption.create({
      data: { groupId: group.id, name: 'Syrup', price: '50.00' },
    });
    cream = await prisma.modifierOption.create({
      data: { groupId: group.id, name: 'Cream', price: '30.00' },
    });
  });

  it('folds modifier prices into the unit price and prints the breakdown', async () => {
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 2, modifierOptionIds: [syrup.id, cream.id] },
    ]);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].unitPrice).toBe(580); // 500 + 50 + 30
    expect(order.items[0].modifiers.map((m) => m.name).sort()).toEqual(['Cream', 'Syrup']);
    expect(order.subtotal).toBe(1160);
    expect(order.total).toBe(1160);
  });

  it('computes a percent promotion on the modifier-inclusive base', async () => {
    const promo = await publishPromo(percent(10));
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 2, modifierOptionIds: [syrup.id] }, // 2 × 550
    ]);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(110); // 10% of 1100, not of 1000
    expect(res.body.order.total).toBe(990);
  });

  it('excluding the product excludes its modifiers with it', async () => {
    const promo = await publishPromo(percent(10), {
      rules: [{ kind: 'EXCLUDE_PRODUCT', productId: coffee }],
    });
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 1, modifierOptionIds: [syrup.id, cream.id] },
      { productId: cake, qty: 1 },
    ]);
    const res = await applyPromo(tokens.cashierA1, order.id, { promotionId: promo.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 10% of the ₹200 cake only — the coffee AND its ₹80 of extras stay out.
    expect(res.body.order.discountAmount).toBe(20);
    expect(res.body.order.total).toBe(760);
  });

  it('same product with different modifiers stays two lines; identical merges', async () => {
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 1, modifierOptionIds: [syrup.id] },
      { productId: coffee, qty: 1 },
      { productId: coffee, qty: 1, modifierOptionIds: [syrup.id] },
    ]);
    expect(order.items).toHaveLength(2);
    const withSyrup = order.items.find((i) => i.modifiers.length === 1);
    expect(withSyrup.qty).toBe(2);
  });

  it('enforces the group selection bounds', async () => {
    const required = await prisma.modifierGroup.create({
      data: { productId: chai, name: 'Milk', minSelect: 1, maxSelect: 1 },
    });
    const full = await prisma.modifierOption.create({
      data: { groupId: required.id, name: 'Full cream', price: '0.00' },
    });
    const toned = await prisma.modifierOption.create({
      data: { groupId: required.id, name: 'Toned', price: '0.00' },
    });

    const none = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', branchId: a1.id, items: [{ productId: chai, qty: 1 }] });
    expect(none.status, JSON.stringify(none.body)).toBe(400);
    expect(none.body.error.message).toMatch(/at least 1/);

    const both = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashierA1))
      .send({
        type: 'TAKEAWAY',
        branchId: a1.id,
        items: [{ productId: chai, qty: 1, modifierOptionIds: [full.id, toned.id] }],
      });
    expect(both.status, JSON.stringify(both.body)).toBe(400);
    expect(both.body.error.message).toMatch(/at most 1/);

    const ok = await newOrder(tokens.cashierA1, a1.id, [
      { productId: chai, qty: 1, modifierOptionIds: [full.id] },
    ]);
    expect(ok.items[0].unitPrice).toBe(500);

    // Retire the requirement so later orders of chai stay valid.
    await prisma.modifierGroup.update({ where: { id: required.id }, data: { status: 'ARCHIVED' } });
  });

  it('bills modifier-inclusive totals onto the receipt, immune to later catalog edits', async () => {
    const order = await newOrder(tokens.cashierA1, a1.id, [
      { productId: coffee, qty: 2, modifierOptionIds: [cream.id] }, // 2 × 530
    ]);
    expect(order.subtotal).toBe(1060); // once per unit, twice for qty 2

    const billed = await request(app)
      .post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.cashierA1))
      .send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);

    const before = await request(app).get(`/api/orders/${order.id}/receipt`).set(auth(tokens.cashierA1));
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const item = before.body.receipt.items[0];
    expect(item.unitPrice).toBe(530);
    expect(item.amount).toBe(1060);
    expect(item.modifiers).toEqual([{ name: 'Cream', price: 30 }]);
    expect(before.body.receipt.total).toBe(1060);

    // Reprice and retire the option: the billed snapshot must not move.
    await prisma.modifierOption.update({ where: { id: cream.id }, data: { price: '99.00', status: 'ARCHIVED' } });
    const after = await request(app).get(`/api/orders/${order.id}/receipt`).set(auth(tokens.cashierA1));
    expect(after.status).toBe(200);
    expect(after.body.receipt.items[0].unitPrice).toBe(530);
    expect(after.body.receipt.items[0].modifiers).toEqual([{ name: 'Cream', price: 30 }]);
    expect(after.body.receipt.total).toBe(1060);
    const row = await prisma.order.findUnique({ where: { id: order.id } });
    expect(Number(row.total)).toBe(1060);
    // Restore for any later use.
    await prisma.modifierOption.update({ where: { id: cream.id }, data: { price: '30.00', status: 'ACTIVE' } });
  });

  it("refuses another product's modifier option", async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashierA1))
      .send({
        type: 'TAKEAWAY',
        branchId: a1.id,
        items: [{ productId: cake, qty: 1, modifierOptionIds: [syrup.id] }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/modifier/i);
  });
});

// --- D-6: what archiving a campaign costs ------------------------------------

// Recorded, not asserted as desirable. `POST /:id/archive` had no test of any
// kind before this block — it is the one lifecycle route the suite never drove
// — so what follows pins the behaviour that is actually shipped, so that a
// later policy decision changes a test on purpose rather than by accident.
// See D-6 in docs/VC104-BACKEND-DEFECTS.md. The open question is whether
// permanent code reservation is intended; these tests take no position on it.
const archive = (token, id) =>
  request(app).post(`/api/promotions/${id}/archive`).set(auth(token)).send({});

describe('archiving a campaign (D-6)', () => {
  it('is reachable from every live state, and is the end of the line', async () => {
    const draft = await request(app).post('/api/promotions').set(auth(tokens.ownerA)).send(flat(1000));
    expect((await archive(tokens.ownerA, draft.body.promotion.id)).status).toBe(200);

    const published = await publishPromo(flat(1000));
    expect((await archive(tokens.ownerA, published.id)).status).toBe(200);

    const paused = await publishPromo(flat(1000));
    expect((await request(app).post(`/api/promotions/${paused.id}/pause`).set(auth(tokens.ownerA)).send({})).status).toBe(200);
    const done = await archive(tokens.ownerA, paused.id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.promotion.status).toBe('ARCHIVED');
  });

  it('closes every move that could free the code, and there is no fourth', async () => {
    const code = `BURN-${seq + 1}`;
    const promo = await publishPromo(flat(2500, { code }));
    expect((await archive(tokens.ownerA, promo.id)).status).toBe(200);

    // 1. It cannot be edited, so the code cannot be changed off it.
    const edited = await request(app)
      .patch(`/api/promotions/${promo.id}`)
      .set(auth(tokens.ownerA))
      .send({ code: `${code}-OLD` });
    expect(edited.status, JSON.stringify(edited.body)).toBe(409);
    expect(edited.body.error.message).toMatch(/archived promotion cannot be edited/);

    // 2. It cannot come back, so the code cannot be put to work again.
    const republished = await request(app)
      .post(`/api/promotions/${promo.id}/publish`)
      .set(auth(tokens.ownerA))
      .send({});
    expect(republished.status, JSON.stringify(republished.body)).toBe(409);
    expect((await request(app).post(`/api/promotions/${promo.id}/pause`).set(auth(tokens.ownerA)).send({})).status).toBe(409);
    expect((await archive(tokens.ownerA, promo.id)).status).toBe(409);

    // 3. Nobody else can take it. The unique index is on (companyId, code) with
    //    no partial predicate, and the create route's duplicate check has no
    //    status filter, so the archived row still answers for the code.
    const reused = await request(app)
      .post('/api/promotions')
      .set(auth(tokens.ownerA))
      .send(flat(2500, { code }));
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.message).toMatch(new RegExp(`Code ${code} is already in use`));

    // The row is still there holding it — this is reservation, not deletion.
    const held = await prisma.promotion.findFirst({ where: { companyId: alpha.id, code } });
    expect(held).toMatchObject({ id: promo.id, status: 'ARCHIVED', code });
  });

  it('leaves a discount that was already applied exactly as it was', async () => {
    const promo = await publishPromo(percent(10, { code: `KEEP-${seq + 1}` }));
    const order = await newOrder(tokens.cashierA1, a1.id); // ₹1000
    expect((await applyPromo(tokens.cashierA1, order.id, { code: promo.code })).status).toBe(200);

    expect((await archive(tokens.ownerA, promo.id)).status).toBe(200);

    // The redemption snapshots name, code, version and amount at apply time, so
    // archiving the campaign afterwards cannot re-price a bill that is already
    // out. This is why D-6 is a lifecycle problem and not a money problem.
    const after = await getOrder(tokens.cashierA1, order.id);
    expect(after.discountAmount).toBe(100);
    expect(after.total).toBe(900);
    expect(after.promotions[0]).toMatchObject({
      promotionId: promo.id,
      code: promo.code,
      amount: 100,
      status: 'APPLIED',
    });
  });

  it('does not reserve anything when the campaign had no code', async () => {
    // `code` is nullable and Postgres allows many NULLs under a unique index, so
    // an uncoded campaign cannot burn anything. Worth pinning: it bounds D-6 to
    // coded campaigns, which is most of why the severity is Medium.
    const first = await publishPromo(flat(700));
    expect(first.code).toBeNull();
    expect((await archive(tokens.ownerA, first.id)).status).toBe(200);

    const second = await request(app).post('/api/promotions').set(auth(tokens.ownerA)).send(flat(700));
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.promotion.code).toBeNull();
  });

  it('is not a move a cashier can make', async () => {
    const promo = await publishPromo(flat(300));
    expect((await archive(tokens.cashierA1, promo.id)).status).toBe(403);
    expect((await archive(tokens.mgrA1, promo.id)).status).toBe(403);
    const still = await request(app).get('/api/promotions').set(auth(tokens.ownerA));
    expect(still.body.promotions.find((p) => p.id === promo.id).status).toBe('PUBLISHED');
  });
});
