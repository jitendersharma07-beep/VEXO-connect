// Discount permissions: what the customer's own admin configured, and what
// the till does when somebody asks for more than that.
//
// The fixture is a two-branch company whose admin has written a real
// configuration — a company default, a branch that is allowed more, and two
// managers with different delegated approval ceilings — plus a second company
// with nothing configured at all, which is the state every company starts in
// and which must discount nothing.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('discounts.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { resetApprovalThrottle } = await import('../src/lib/discountGuard.js');
const { mergeDiscountPolicyRows } = await import('../src/lib/discountPolicy.js');

const app = createApp();

const wipe = async () => {
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  // DiscountPolicy's foreign keys are RESTRICT, so it goes before the branch,
  // user and company rows it points at.
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
const users = {};
let delta, echo, d1, d2, e1, coffee, chai;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// Every order in this file is two coffees at ₹500 — a ₹1000 gross, so a
// percentage and a rupee figure are the same number and the assertions below
// stay readable.
const newOrder = async (token, branchId) => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ type: 'TAKEAWAY', branchId, items: [{ productId: coffee, qty: 2 }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order;
};

const getOrder = async (token, id) => {
  const res = await request(app).get(`/api/orders/${id}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
};

const setOrderDiscount = (token, id, body) =>
  request(app).post(`/api/orders/${id}/discount`).set(auth(token)).send(body);

const setLineDiscount = (token, order, lineDiscount, approval) =>
  request(app)
    .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
    .set(auth(token))
    .send({ lineDiscount, ...(approval ? { approval } : {}) });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);

  delta = await prisma.company.create({
    data: {
      name: 'Delta Diner',
      slug: 'delta-diner',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inADay } },
    },
  });
  echo = await prisma.company.create({
    data: {
      name: 'Echo Eatery',
      slug: 'echo-eatery',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  d1 = await prisma.branch.create({ data: { companyId: delta.id, name: 'Delta One', code: 'D1' } });
  d2 = await prisma.branch.create({ data: { companyId: delta.id, name: 'Delta Two', code: 'D2' } });
  e1 = await prisma.branch.create({ data: { companyId: echo.id, name: 'Echo One', code: 'E1' } });

  const mk = async (key, data) => {
    users[key] = await prisma.posUser.create({ data: { passwordHash, ...data } });
    tokens[key] = await login(data.email);
  };
  await mk('ownerD', {
    email: 'owner.d@test.local', fullName: 'Owner D', role: 'CUSTOMER_OWNER', companyId: delta.id,
  });
  await mk('mgrD1', {
    email: 'mgr.d1@test.local', fullName: 'Manager D1', role: 'BRANCH_MANAGER', companyId: delta.id, branchId: d1.id,
  });
  await mk('mgrD2', {
    email: 'mgr.d2@test.local', fullName: 'Manager D2', role: 'BRANCH_MANAGER', companyId: delta.id, branchId: d2.id,
  });
  await mk('cashierD1', {
    email: 'cashier.d1@test.local', fullName: 'Cashier D1', role: 'CASHIER', companyId: delta.id, branchId: d1.id,
  });
  await mk('cashierD2', {
    email: 'cashier.d2@test.local', fullName: 'Cashier D2', role: 'CASHIER', companyId: delta.id, branchId: d2.id,
  });
  await mk('ownerE', {
    email: 'owner.e@test.local', fullName: 'Owner E', role: 'CUSTOMER_OWNER', companyId: echo.id,
  });
  await mk('cashierE1', {
    email: 'cashier.e1@test.local', fullName: 'Cashier E1', role: 'CASHIER', companyId: echo.id, branchId: e1.id,
  });

  // --- what Delta's admin configured -----------------------------------------
  // Echo's admin has configured NOTHING, on purpose. That is the state every
  // company is created in, and the floor it implies is under test below.
  const policy = (data) => prisma.discountPolicy.create({ data: { companyId: delta.id, ...data } });

  // Company default: staff may discount, up to a tenth of the bill. No rupee
  // cap — the admin chose to bound this as a share.
  await policy({
    level: 'COMPANY', scopeKey: 'company',
    allowLineDiscount: true, allowOrderDiscount: true,
    maxPercent: '10.000', note: 'Company default',
  });
  // Delta Two is the airport branch and is allowed more.
  await policy({
    level: 'BRANCH', scopeKey: `branch:${d2.id}`, branchId: d2.id,
    maxPercent: '20.000', note: 'Airport branch',
  });
  // Two managers, two different delegated ceilings — the point being that
  // "manager" is not itself an authority here; the row is.
  await policy({
    level: 'USER', scopeKey: `user:${users.mgrD1.id}`, userId: users.mgrD1.id,
    canApprove: true, maxApprovalPercent: '50.000',
  });
  await policy({
    level: 'USER', scopeKey: `user:${users.mgrD2.id}`, userId: users.mgrD2.id,
    canApprove: true, maxApprovalPercent: '25.000',
  });

  const tax = await prisma.taxRate.create({
    data: { companyId: delta.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const cat = await prisma.category.create({
    data: { companyId: delta.id, name: 'Coffee', sortOrder: 1 },
  });
  const product = await prisma.product.create({
    data: { companyId: delta.id, categoryId: cat.id, name: 'Filter Coffee', basePrice: '500.00', taxRateId: tax.id },
  });
  coffee = product.id;
  // A second ₹500 product, so an order can be built from two removable lines
  // rather than one line of two.
  const second = await prisma.product.create({
    data: { companyId: delta.id, categoryId: cat.id, name: 'Masala Chai', basePrice: '500.00', taxRateId: tax.id },
  });
  chai = second.id;

  // Echo needs a catalog of its own to order from, since catalogs are
  // company-scoped and the deny-by-default test has to place a real order.
  const taxE = await prisma.taxRate.create({
    data: { companyId: echo.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const catE = await prisma.category.create({
    data: { companyId: echo.id, name: 'Coffee', sortOrder: 1 },
  });
  const productE = await prisma.product.create({
    data: { companyId: echo.id, categoryId: catE.id, name: 'Filter Coffee', basePrice: '500.00', taxRateId: taxE.id },
  });
  users.echoCoffee = productE.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- the floor --------------------------------------------------------------

describe('a company that has configured nothing', () => {
  it('lets its cashier discount nothing at all, and says a manager could', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashierE1))
      .send({ type: 'TAKEAWAY', items: [{ productId: users.echoCoffee, qty: 2 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = res.body.order;

    const denied = await setOrderDiscount(tokens.cashierE1, order.id, { type: 'PERCENT', value: 5 });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.code).toBe('POS_DISCOUNT_NOT_PERMITTED');
    expect(denied.body.error.details.approvalRequired).toBe(true);
    expect(denied.body.error.details.breach.kind).toBe('ORDER_NOT_ALLOWED');
    expect(denied.body.error.details.yourLimit.allowOrderDiscount).toBe(false);

    // The control. Without it this passes just as well when the route
    // returned 403 AFTER writing the discount.
    const after = await getOrder(tokens.cashierE1, order.id);
    expect(after.discountAmount).toBe(0);
    expect(after.total).toBe(1050);
  });

  it('still lets its owner discount, because the owner is who would grant it', async () => {
    const created = await request(app)
      .post('/api/orders')
      .set(auth(tokens.ownerE))
      .send({ type: 'TAKEAWAY', branchId: e1.id, items: [{ productId: users.echoCoffee, qty: 2 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const ok = await setOrderDiscount(tokens.ownerE, created.body.order.id, { type: 'PERCENT', value: 30 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.order.discountAmount).toBe(300);
  });
});

// --- the configured ceiling -------------------------------------------------

describe('the ceiling the admin typed', () => {
  it('allows a discount inside the company default', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const ok = await setOrderDiscount(tokens.cashierD1, order.id, { type: 'PERCENT', value: 10 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.order.discountAmount).toBe(100);
    // Nobody was needed, so nothing is recorded as approved.
    const row = await prisma.order.findUnique({ where: { id: order.id } });
    expect(row.discountApprovedById).toBeNull();
    expect(row.discountReason).toBeNull();
  });

  it('refuses one over it, and reports the real numbers', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const denied = await setOrderDiscount(tokens.cashierD1, order.id, { type: 'PERCENT', value: 11 });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.code).toBe('POS_DISCOUNT_NOT_PERMITTED');
    expect(denied.body.error.details.breach).toMatchObject({
      kind: 'PERCENT', limitPctMilli: 10000, actualPctMilli: 11000, actualPaise: 11000,
    });
    expect(denied.body.error.details.yourLimit.maxPctMilli).toBe(10000);
    expect((await getOrder(tokens.cashierD1, order.id)).discountAmount).toBe(0);
  });

  it('gives the airport branch the wider ceiling its override configures', async () => {
    // Same company, same role, same request — different branch, different
    // answer. This is the whole point of a branch override.
    const atD2 = await newOrder(tokens.cashierD2, d2.id);
    const ok = await setOrderDiscount(tokens.cashierD2, atD2.id, { type: 'PERCENT', value: 20 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.order.discountAmount).toBe(200);

    const atD1 = await newOrder(tokens.cashierD1, d1.id);
    const denied = await setOrderDiscount(tokens.cashierD1, atD1.id, { type: 'PERCENT', value: 20 });
    expect(denied.status).toBe(403);
  });

  it('counts the item and order discounts as one discount, which is the whole point', async () => {
    // Each half is inside Delta Two's 20%. Together they are 23.5% off,
    // because the order discount applies to a subtotal the line discount
    // already reduced. A rule that looked at either number alone would have
    // called this two legal discounts.
    const order = await newOrder(tokens.cashierD2, d2.id);
    const line = await setLineDiscount(tokens.cashierD2, order, 150);
    expect(line.status, JSON.stringify(line.body)).toBe(200);
    expect(line.body.order.subtotal).toBe(850);

    const both = await setOrderDiscount(tokens.cashierD2, order.id, { type: 'PERCENT', value: 10 });
    expect(both.status, JSON.stringify(both.body)).toBe(403);
    expect(both.body.error.details.breach.kind).toBe('PERCENT');
    // 150 + 85 = 235 of a 1000 gross.
    expect(both.body.error.details.breach.actualPaise).toBe(23500);
    expect(both.body.error.details.breach.actualPctMilli).toBe(23500);

    // And the 15% line discount it was added to is untouched.
    const after = await getOrder(tokens.cashierD2, order.id);
    expect(after.subtotal).toBe(850);
    expect(after.discountAmount).toBe(0);
  });
});

// --- approval ---------------------------------------------------------------

describe('an above-limit discount and the approver who signs for it', () => {
  it('goes through on the approver own password, and records who and why', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const res = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT',
      value: 30,
      approval: {
        approverEmail: 'mgr.d1@test.local',
        password: PW,
        reason: 'Spilled the first tray',
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.discountAmount).toBe(300);

    const row = await prisma.order.findUnique({ where: { id: order.id } });
    expect(row.discountApprovedById).toBe(users.mgrD1.id);
    expect(row.discountReason).toBe('Spilled the first tray');
    expect(row.discountApprovedAt).toBeInstanceOf(Date);

    // The audit trail: who rang it up, who signed, why, which branch, and
    // what the bill looked like on each side of the change.
    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_DISCOUNT_SET', entityId: order.id },
      orderBy: { at: 'desc' },
    });
    expect(log.actorId).toBe(users.cashierD1.id);
    expect(log.actorEmail).toBe('cashier.d1@test.local');
    // The role is on the row, not fetched from PosUser. If this cashier is
    // promoted next month, this line must still read CASHIER.
    expect(log.actorRole).toBe('CASHIER');
    expect(log.meta.branchId).toBe(d1.id);
    // The ceiling this was measured against, as it stood at this instant.
    // Without it, "30% off" cannot be judged later — the policy row is
    // editable and today's copy of it may describe a different company.
    expect(log.meta.actorLimit).toMatchObject({
      allowOrderDiscount: true, maxPctMilli: 10000, maxFlatPaise: null,
    });
    // The discount that was asked for, in the terms it was asked in.
    expect(log.meta.type).toBe('PERCENT');
    expect(log.meta.value).toBe(30);
    expect(log.meta.approvedBy).toMatchObject({
      id: users.mgrD1.id, email: 'mgr.d1@test.local', role: 'BRANCH_MANAGER', selfApproved: false,
    });
    expect(log.meta.approvalReason).toBe('Spilled the first tray');
    expect(log.meta.before).toMatchObject({ grossPaise: 100000, combinedDiscountPaise: 0 });
    expect(log.meta.after).toMatchObject({
      grossPaise: 100000, combinedDiscountPaise: 30000, combinedPctMilli: 30000,
    });
    // Whatever else it carries, it does not carry the password.
    expect(JSON.stringify(log.meta)).not.toContain(PW);
  });

  it('is refused on a wrong password, and the discount does not move', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const res = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { approverEmail: 'mgr.d1@test.local', password: 'not-the-password', reason: 'Trying it on' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('POS_DISCOUNT_APPROVAL_REFUSED');
    expect(res.body.error.details.refusal).toBe('BAD_PASSWORD');
    expect((await getOrder(tokens.cashierD1, order.id)).discountAmount).toBe(0);
    resetApprovalThrottle();
  });

  it('answers an account that does not exist in the same words as a wrong password', async () => {
    // Otherwise the approval prompt is a way to find out who works here, and
    // at which company, from a till in the dining room.
    const order = await newOrder(tokens.cashierD1, d1.id);
    const approval = { password: PW, reason: 'Checking the dark' };

    const wrongPassword = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { ...approval, approverEmail: 'mgr.d1@test.local', password: 'wrong' },
    });
    const noSuchAccount = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { ...approval, approverEmail: 'nobody@test.local' },
    });
    // Another company's real manager must look exactly like nobody at all.
    const otherCompany = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { ...approval, approverEmail: 'owner.e@test.local' },
    });

    expect(wrongPassword.status).toBe(403);
    expect(noSuchAccount.body.error.message).toBe(wrongPassword.body.error.message);
    expect(otherCompany.body.error.message).toBe(wrongPassword.body.error.message);
    expect(otherCompany.body.error.code).toBe(wrongPassword.body.error.code);
    resetApprovalThrottle();
  });

  it('will not let a manager sign for a discount at somebody else branch', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const res = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { approverEmail: 'mgr.d2@test.local', password: PW, reason: 'Wrong branch manager' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.details.refusal).toBe('APPROVER_WRONG_BRANCH');
    expect(res.body.error.message).toContain('Delta Two');
    expect((await getOrder(tokens.cashierD1, order.id)).discountAmount).toBe(0);
    resetApprovalThrottle();
  });

  it('will not let an approver sign for more than they were delegated', async () => {
    // Manager D2 may approve to 25%. 60% is beyond them, and being a manager
    // is not the thing that decides it — the row is.
    const order = await newOrder(tokens.cashierD2, d2.id);
    const res = await setOrderDiscount(tokens.cashierD2, order.id, {
      type: 'PERCENT', value: 60,
      approval: { approverEmail: 'mgr.d2@test.local', password: PW, reason: 'Over their head' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.details.refusal).toBe('APPROVER_OVER_LIMIT');
    expect(res.body.error.details.approverLimit.maxPctMilli).toBe(25000);
    expect((await getOrder(tokens.cashierD2, order.id)).discountAmount).toBe(0);
    resetApprovalThrottle();
  });

  it('records a manager who signed for their own discount as having done so', async () => {
    // Legitimate — a manager alone on a late shift has nobody else to ask —
    // but "who signed for this" and "who rang it up" being the same person is
    // the first thing anybody reviewing a discount wants to know.
    const order = await newOrder(tokens.mgrD1, d1.id);
    const res = await setOrderDiscount(tokens.mgrD1, order.id, {
      type: 'PERCENT', value: 40,
      approval: { approverEmail: 'mgr.d1@test.local', password: PW, reason: 'Alone on the late shift' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_DISCOUNT_SET', entityId: order.id },
      orderBy: { at: 'desc' },
    });
    expect(log.actorId).toBe(users.mgrD1.id);
    expect(log.meta.approvedBy.selfApproved).toBe(true);
  });

  it('stops somebody guessing a manager password at the till', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const guess = (password) =>
      setOrderDiscount(tokens.cashierD1, order.id, {
        type: 'PERCENT', value: 30,
        approval: { approverEmail: 'mgr.d1@test.local', password, reason: 'Guessing all evening' },
      });

    for (let i = 0; i < 5; i += 1) {
      const res = await guess(`guess-${i}`);
      expect(res.body.error.details.refusal).toBe('BAD_PASSWORD');
    }
    // The sixth is refused before the password is even looked at — so the
    // RIGHT password is refused too, which is what makes this a throttle
    // rather than a message.
    const correct = await guess(PW);
    expect(correct.status).toBe(403);
    expect(correct.body.error.message).toContain('Too many failed approval attempts');
    expect((await getOrder(tokens.cashierD1, order.id)).discountAmount).toBe(0);

    const throttled = await prisma.posAuditLog.count({
      where: { action: 'ORDER_DISCOUNT_APPROVAL_THROTTLED', entityId: order.id },
    });
    expect(throttled).toBe(1);

    resetApprovalThrottle();
    const afterReset = await guess(PW);
    expect(afterReset.status, JSON.stringify(afterReset.body)).toBe(200);
  });

  it('writes every refusal down, including the ones nobody was there to see', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    await setOrderDiscount(tokens.cashierD1, order.id, { type: 'PERCENT', value: 30 });
    const denied = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_DISCOUNT_DENIED', entityId: order.id },
    });
    expect(denied.actorId).toBe(users.cashierD1.id);
    expect(denied.meta.branchId).toBe(d1.id);
    expect(denied.meta.attemptedAction).toBe('ORDER_DISCOUNT_SET');
    expect(denied.meta.actorLimit.maxPctMilli).toBe(10000);
    expect(denied.meta.after.combinedPaise).toBe(30000);
  });
});

// --- changes that move a discount without touching the discount -------------

describe('shrinking the bill', () => {
  it('is refused when dropping a quantity pushes a fixed discount past the ceiling', async () => {
    // A ₹200 discount on a ₹1000 order is exactly Delta Two's 20%. Take one
    // of the two coffees off and the same ₹200 is 40% of what is left,
    // without anybody having touched a discount field. This is the hole that
    // guarding only the two discount endpoints would have left open.
    const order = await newOrder(tokens.cashierD2, d2.id);
    const set = await setOrderDiscount(tokens.cashierD2, order.id, { type: 'FLAT', value: 200 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.order.discountAmount).toBe(200);

    const qtyDown = await request(app)
      .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(auth(tokens.cashierD2))
      .send({ qty: 1 });
    expect(qtyDown.status, JSON.stringify(qtyDown.body)).toBe(403);
    expect(qtyDown.body.error.details.breach.kind).toBe('PERCENT');
    expect(qtyDown.body.error.details.breach.actualPctMilli).toBe(40000);

    const after = await getOrder(tokens.cashierD2, order.id);
    expect(after.items[0].qty).toBe(2);
    expect(after.discountAmount).toBe(200);
  });

  it('is refused when removing a line does the same thing', async () => {
    const created = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashierD2))
      .send({
        type: 'TAKEAWAY',
        branchId: d2.id,
        items: [{ productId: coffee }, { productId: chai }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.order;
    expect(order.subtotal).toBe(1000);

    await setOrderDiscount(tokens.cashierD2, order.id, { type: 'FLAT', value: 200 });
    const removed = await request(app)
      .delete(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(auth(tokens.cashierD2))
      .send({});
    expect(removed.status, JSON.stringify(removed.body)).toBe(403);
    expect(removed.body.error.details.breach.actualPctMilli).toBe(40000);
    expect((await getOrder(tokens.cashierD2, order.id)).items).toHaveLength(2);
  });

  it('goes through when somebody with the authority signs for the result', async () => {
    // Manager D2 may approve to 25%, and this result is 40% — so the person
    // who can sign for it is the owner, who is not pinned to a branch. Being
    // a manager is not the thing that decides this; the delegated ceiling is.
    const order = await newOrder(tokens.cashierD2, d2.id);
    await setOrderDiscount(tokens.cashierD2, order.id, { type: 'FLAT', value: 200 });

    const tooSmall = await request(app)
      .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(auth(tokens.cashierD2))
      .send({
        qty: 1,
        approval: { approverEmail: 'mgr.d2@test.local', password: PW, reason: 'One coffee went back' },
      });
    expect(tooSmall.status).toBe(403);
    expect(tooSmall.body.error.details.refusal).toBe('APPROVER_OVER_LIMIT');

    const signed = await request(app)
      .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(auth(tokens.cashierD2))
      .send({
        qty: 1,
        approval: { approverEmail: 'owner.d@test.local', password: PW, reason: 'One coffee went back' },
      });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.order.discountAmount).toBe(200);
    expect(signed.body.order.subtotal).toBe(500);
  });

  it('may empty an order entirely, but the discount cannot come back on its own', async () => {
    // Nothing is discounted on an order with no items, so there is nothing
    // for a ceiling to refuse. The stored ₹200 is still on the order though,
    // and the route that would bring it back to life is the one that adds an
    // item — which is why that route is guarded too.
    const order = await newOrder(tokens.cashierD2, d2.id);
    await setOrderDiscount(tokens.cashierD2, order.id, { type: 'FLAT', value: 200 });
    const emptied = await request(app)
      .delete(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(auth(tokens.cashierD2))
      .send({});
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
    expect(emptied.body.order.discountAmount).toBe(0);

    const readd = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set(auth(tokens.cashierD2))
      .send({ productId: coffee, qty: 1 });
    expect(readd.status, JSON.stringify(readd.body)).toBe(403);
    expect(readd.body.error.details.breach.actualPctMilli).toBe(40000);
  });
});

describe('taking a discount back off', () => {
  it('is allowed to anybody, even one they could never have granted', async () => {
    // A cashier who cannot give 30% must still be able to correct one. The
    // ceiling exists to stop money leaving, not to trap it once it has.
    const order = await newOrder(tokens.cashierD1, d1.id);
    const approved = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { approverEmail: 'mgr.d1@test.local', password: PW, reason: 'Approved first' },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const reduced = await setOrderDiscount(tokens.cashierD1, order.id, { type: 'PERCENT', value: 5 });
    expect(reduced.status, JSON.stringify(reduced.body)).toBe(200);
    expect(reduced.body.order.discountAmount).toBe(50);

    const cleared = await request(app)
      .delete(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.cashierD1));
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.order.discountAmount).toBe(0);

    // The approval went with it. Nothing is approved any more, because
    // nothing is discounted.
    const row = await prisma.order.findUnique({ where: { id: order.id } });
    expect(row.discountApprovedById).toBeNull();
  });
});

// --- history ----------------------------------------------------------------

describe('a bill that has already been issued', () => {
  it('is not rewritten when the policy tightens underneath it', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const approved = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 30,
      approval: { approverEmail: 'mgr.d1@test.local', password: PW, reason: 'Regular customer' },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const billed = await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.cashierD1)).send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    const invoiceNumber = billed.body.order.invoiceNumber;
    expect(invoiceNumber).toBeTruthy();
    expect(billed.body.order.total).toBe(735);

    // The admin now decides 30% was too generous and cuts the company
    // default to 1%. Nothing about the bill above may change.
    await prisma.discountPolicy.update({
      where: { companyId_scopeKey: { companyId: delta.id, scopeKey: 'company' } },
      data: { maxPercent: '1.000' },
    });
    try {
      const after = await getOrder(tokens.cashierD1, order.id);
      expect(after.total).toBe(735);
      expect(after.discountAmount).toBe(300);
      expect(after.invoiceNumber).toBe(invoiceNumber);
      expect(after.status).toBe('BILLED');

      const row = await prisma.order.findUnique({ where: { id: order.id } });
      expect(row.discountApprovedById).toBe(users.mgrD1.id);
      expect(row.discountReason).toBe('Regular customer');

      // And the new ceiling does bind the next order, so the test above is
      // not passing merely because the change never took effect.
      const next = await newOrder(tokens.cashierD1, d1.id);
      const denied = await setOrderDiscount(tokens.cashierD1, next.id, { type: 'PERCENT', value: 5 });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.yourLimit.maxPctMilli).toBe(1000);
    } finally {
      await prisma.discountPolicy.update({
        where: { companyId_scopeKey: { companyId: delta.id, scopeKey: 'company' } },
        data: { maxPercent: '10.000' },
      });
    }
  });

  it('cannot be discounted any further, approval or not', async () => {
    const order = await newOrder(tokens.cashierD1, d1.id);
    const billed = await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.cashierD1)).send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    const res = await setOrderDiscount(tokens.cashierD1, order.id, {
      type: 'PERCENT', value: 5,
      approval: { approverEmail: 'mgr.d1@test.local', password: PW, reason: 'Too late' },
    });
    expect(res.status).toBe(409);
  });
});

// --- how the three levels combine -------------------------------------------

describe('resolving company, branch and staff rows', () => {
  const rows = (...r) => r;

  it('takes the most specific answer field by field, not row by row', () => {
    // The branch only raises the cash cap. It must not silently drop the
    // percentage cap the company set, which is what picking one winning row
    // would have done.
    const merged = mergeDiscountPolicyRows(
      rows(
        { maxFlatPaise: 50000 },
        { allowLineDiscount: true, allowOrderDiscount: true, maxPercent: '10.000' },
      ),
      'CASHIER',
    );
    expect(merged.maxPctMilli).toBe(10000);
    expect(merged.maxFlatPaise).toBe(50000);
    expect(merged.allowOrderDiscount).toBe(true);
  });

  it('does not read a ceiling the admin left blank as a ceiling of zero', () => {
    // "Cashiers may give 10%" must not resolve to "10%, and also ₹0.00" —
    // an explicit grant that refuses everything and reports a limit nobody
    // typed.
    const merged = mergeDiscountPolicyRows(
      rows({ allowLineDiscount: true, allowOrderDiscount: true, maxPercent: '10.000' }),
      'CASHIER',
    );
    expect(merged.maxPctMilli).toBe(10000);
    expect(merged.maxFlatPaise).toBeNull();
  });

  it('keeps the deny floor for a company that has configured neither', () => {
    const merged = mergeDiscountPolicyRows(rows(), 'CASHIER');
    expect(merged).toMatchObject({
      allowLineDiscount: false, allowOrderDiscount: false,
      maxPctMilli: 0, maxFlatPaise: 0, canApprove: false,
    });
  });

  it('lets a staff row narrow one person below their branch', () => {
    const merged = mergeDiscountPolicyRows(
      rows(
        { allowOrderDiscount: false },
        { maxPercent: '20.000' },
        { allowLineDiscount: true, allowOrderDiscount: true, maxPercent: '10.000' },
      ),
      'CASHIER',
    );
    expect(merged.allowLineDiscount).toBe(true);
    expect(merged.allowOrderDiscount).toBe(false);
    expect(merged.maxPctMilli).toBe(20000);
  });

  it('gives ATC operators no discount authority in anybody tenant', () => {
    const merged = mergeDiscountPolicyRows(rows(), 'POS_SUPER_ADMIN');
    expect(merged.allowLineDiscount).toBe(false);
    expect(merged.canApprove).toBe(false);
  });
});
