// Covers (pax) and waiter attribution — LANE tables, spec §B "Tables (Pro)".
//
// This file is a verification matrix, not a smoke test. Most of what follows is
// a negative control, and each one asserts the REASON for the refusal: a test
// that only checks "not 200" passes just as happily when the request died on a
// typo in the URL.
//
// Two claims are proved twice on purpose — once through the API and once by
// writing straight to Postgres with the Prisma client. A route guard can be
// forgotten by the next endpoint somebody adds; a CHECK constraint and a
// composite foreign key cannot. Where both exist, both are demonstrated.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('tablesService.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { scopeKeyFor } = await import('../src/lib/permissions.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const wipe = async () => {
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.qrSubmission.deleteMany();
  await prisma.order.deleteMany();
  await prisma.diningVisitGuest.deleteMany();
  await prisma.diningVisit.deleteMany();
  await prisma.tableQrCode.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.permissionRule.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const tokens = {};
const staff = {};
let companyA, companyB, branchA1, branchA2, branchB1;
let tableA1, tableA1b, tableA2, tableB1;
let productA, productB;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

/** A dine-in order with one taxed line, opened at `tableId`. */
const openBill = async (token, { tableId, branchId, productId }) => {
  // Independence, not tidiness. One open order per table is an application rule,
  // so a bill some earlier test left behind answers 409 here and the failure is
  // then reported against the fixture instead of against whatever this test was
  // actually proving. Clearing first makes every test start from an empty table
  // regardless of what happened before it.
  await clearTable(tableId);
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ type: 'DINE_IN', tableId, branchId, items: [{ productId, qty: 2 }] });
  expect(res.status, `open bill: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.order;
};

/**
 * Removes one order and everything that points at it, in dependency order.
 *
 * Each test tidies up after itself because the application rule is ONE OPEN
 * ORDER PER TABLE — a bill left behind turns the next test's 201 into a 409, and
 * the failure then lands on the fixture rather than on whatever was being
 * proved. A plain order.deleteMany() cannot do it: OrderItem, Kot and Payment
 * point at Order with Restrict, which is correct — a sale must not be erasable
 * by deleting its header — and is exactly why this helper exists.
 */
const dropOrder = async (orderId) => {
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true } });
  const itemIds = items.map((i) => i.id);
  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.orderItemModifier.deleteMany({ where: { orderItemId: { in: itemIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.kot.deleteMany({ where: { orderId } });
  await prisma.payment.deleteMany({ where: { orderId } });
  await prisma.qrSubmission.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
};

/** Every bill ever opened at this table, gone. */
const clearTable = async (tableId) => {
  const orders = await prisma.order.findMany({ where: { tableId }, select: { id: true } });
  for (const o of orders) await dropOrder(o.id);
};

const serviceOf = (orderId) =>
  prisma.order.findUnique({
    where: { id: orderId },
    select: {
      pax: true,
      waiterId: true,
      waiterSetAt: true,
      waiterSetById: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      status: true,
    },
  });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Dhaba',
      slug: 'alpha-svc',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Cafe',
      slug: 'bravo-svc',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SV-0001', name: 'Alpha One', code: 'A1', city: 'Delhi' },
  });
  branchA2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SV-0002', name: 'Alpha Two', code: 'A2', city: 'Jaipur' },
  });
  branchB1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-SV-0003', name: 'Bravo One', code: 'B1', city: 'Pune' },
  });

  tableA1 = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T1', capacity: 4 } });
  tableA1b = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T2', capacity: 2 } });
  tableA2 = await prisma.diningTable.create({ data: { branchId: branchA2.id, name: 'T1', capacity: 4 } });
  tableB1 = await prisma.diningTable.create({ data: { branchId: branchB1.id, name: 'T1', capacity: 4 } });

  const mkUser = (key, data) =>
    prisma.posUser.create({ data: { passwordHash, ...data } }).then((u) => {
      staff[key] = u;
      return u;
    });

  await mkUser('ownerA', {
    email: 'owner.a@svc.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id,
  });
  await mkUser('managerA1', {
    email: 'manager.a1@svc.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('cashierA1', {
    email: 'cashier.a1@svc.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('captainA1', {
    email: 'captain.a1@svc.local', fullName: 'Meera Captain', role: 'CAPTAIN', companyId: companyA.id, branchId: branchA1.id,
  });
  // Same company, the OTHER store. The centrepiece of the isolation matrix.
  await mkUser('captainA2', {
    email: 'captain.a2@svc.local', fullName: 'Ravi Captain', role: 'CAPTAIN', companyId: companyA.id, branchId: branchA2.id,
  });
  // Works at A1, but their account has been switched off.
  await mkUser('captainDisabled', {
    email: 'captain.off@svc.local', fullName: 'Suspended Captain', role: 'CAPTAIN', companyId: companyA.id, branchId: branchA1.id, status: 'DISABLED',
  });
  // At A1 and cannot take an order at all.
  await mkUser('kitchenA1', {
    email: 'kitchen.a1@svc.local', fullName: 'Kitchen A1', role: 'KITCHEN', companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('ownerB', {
    email: 'owner.b@svc.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id,
  });
  await mkUser('captainB1', {
    email: 'captain.b1@svc.local', fullName: 'Bravo Captain', role: 'CAPTAIN', companyId: companyB.id, branchId: branchB1.id,
  });
  await prisma.posUser.create({
    data: { email: 'atc@svc.local', fullName: 'ATC Operator', role: 'POS_SUPER_ADMIN', passwordHash },
  });

  tokens.ownerA = await login('owner.a@svc.local');
  tokens.managerA1 = await login('manager.a1@svc.local');
  tokens.cashierA1 = await login('cashier.a1@svc.local');
  tokens.captainA1 = await login('captain.a1@svc.local');
  tokens.ownerB = await login('owner.b@svc.local');
  tokens.atc = await login('atc@svc.local');

  const taxA = await prisma.taxRate.create({
    data: { companyId: companyA.id, name: 'GST5-A', ratePercent: '5.000' },
  });
  const catA = await prisma.category.create({
    data: { companyId: companyA.id, name: 'Mains A', sortOrder: 1 },
  });
  productA = await prisma.product.create({
    data: { companyId: companyA.id, categoryId: catA.id, name: 'Thali A', basePrice: '200.00', taxRateId: taxA.id },
  });
  const catB = await prisma.category.create({
    data: { companyId: companyB.id, name: 'Mains B', sortOrder: 1 },
  });
  productB = await prisma.product.create({
    data: { companyId: companyB.id, categoryId: catB.id, name: 'Thali B', basePrice: '150.00' },
  });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('covers and server, recorded against the table s open bill', () => {
  it('records both, returns them, and leaves every amount on the bill alone', async () => {
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });
    const before = await serviceOf(order.id);
    expect(before.pax).toBeNull();
    expect(before.waiterId).toBeNull();

    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4, waiterId: staff.captainA1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.service.pax).toBe(4);
    expect(res.body.service.waiterId).toBe(staff.captainA1.id);
    expect(res.body.service.waiterName).toBe('Meera Captain');
    expect(res.body.service.waiterSetById).toBe(staff.managerA1.id);
    expect(res.body.service.waiterSetAt).toBeTruthy();

    const after = await serviceOf(order.id);
    // Covers and attribution are not money. The single evaluator was not asked
    // to run and no amount moved by a paisa.
    expect(String(after.subtotal)).toBe(String(before.subtotal));
    expect(String(after.taxAmount)).toBe(String(before.taxAmount));
    expect(String(after.total)).toBe(String(before.total));

    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'TABLE_SERVICE_SET', entityId: order.id },
      orderBy: { at: 'desc' },
    });
    expect(log).toBeTruthy();
    expect(log.actorId).toBe(staff.managerA1.id);
    expect(log.meta).toMatchObject({ pax: 4, waiterId: staff.captainA1.id });

    await dropOrder(order.id);
  });

  it('lets a captain run their own floor, and refuses the platform operator', async () => {
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });

    const captain = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.captainA1))
      .send({ pax: 2, waiterId: staff.captainA1.id });
    expect(captain.status, JSON.stringify(captain.body)).toBe(200);
    expect(captain.body.service.pax).toBe(2);

    // ATC is read-only in this router. The refusal must come from the ROLE gate,
    // not from a missing licence, a 404, or "which company did you mean?" — this
    // endpoint exists for customers and a platform operator is not one.
    //
    // The tenant header is supplied on purpose. Without it resolveCompanyScope
    // answers 400 before the role gate is ever consulted, and a test satisfied by
    // that 400 would still pass on the day somebody adds POS_SUPER_ADMIN to the
    // role list. Naming the company correctly is what makes the 403 mean
    // something: refused on the merits, with nothing left to get right.
    const atc = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.atc))
      .set('X-Pos-Company', companyA.id)
      .send({ pax: 6 });
    expect(atc.status, JSON.stringify(atc.body)).toBe(403);
    expect((await serviceOf(order.id)).pax).toBe(2);

    await dropOrder(order.id);
  });

  it('clears covers and server, and nulls all three attribution columns together', async () => {
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });
    await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4, waiterId: staff.captainA1.id })
      .expect(200);

    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: null, waiterId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await serviceOf(order.id);
    expect(row.pax).toBeNull();
    // Order_waiter_attribution_complete would have refused a partial clear, so
    // this asserts the three moved as one rather than that the route was tidy.
    expect(row.waiterId).toBeNull();
    expect(row.waiterSetAt).toBeNull();
    expect(row.waiterSetById).toBeNull();

    await dropOrder(order.id);
  });

  it('refuses an empty body rather than writing nothing and reporting success', async () => {
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });
    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(res.status).toBe(400);
    await dropOrder(order.id);
  });

  it('refuses when the table has no open bill, and says so', async () => {
    const res = await request(app)
      .post(`/api/tables/${tableA1b.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no open bill/i);
  });

  it('refuses once the bill has been issued: covers and server are part of it now', async () => {
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });
    await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4, waiterId: staff.captainA1.id })
      .expect(200);
    const billed = await request(app)
      .post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);

    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 9, waiterId: staff.cashierA1.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already billed/i);

    const row = await serviceOf(order.id);
    expect(row.pax).toBe(4);
    expect(row.waiterId).toBe(staff.captainA1.id);

    await dropOrder(order.id);
  });
});

describe('covers are a count of people, and the database says so too', () => {
  let order;
  beforeAll(async () => {
    order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });
  });
  afterAll(async () => {
    await dropOrder(order.id);
  });

  it('refuses zero, negative and fractional covers at the route', async () => {
    for (const pax of [0, -3, 2.5]) {
      const res = await request(app)
        .post(`/api/tables/${tableA1.id}/service`)
        .set(auth(tokens.managerA1))
        .send({ pax });
      expect(res.status, `pax=${pax} should be refused`).toBe(400);
    }
    expect((await serviceOf(order.id)).pax).toBeNull();
  });

  it('refuses an implausible count, so a slipped keystroke is not a banquet', async () => {
    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4000 });
    expect(res.status).toBe(400);
  });

  it('refuses zero covers written straight to Postgres, past every route', async () => {
    // The route guard above can be forgotten by the next endpoint somebody adds.
    // This is the constraint that cannot be.
    await expect(
      prisma.order.update({ where: { id: order.id }, data: { pax: 0 } }),
    ).rejects.toThrow(/Order_pax_positive/);
    expect((await serviceOf(order.id)).pax).toBeNull();
  });
});

describe('who may be credited with a table', () => {
  let order;
  beforeAll(async () => {
    order = await openBill(tokens.managerA1, {
      tableId: tableA1.id, branchId: branchA1.id, productId: productA.id,
    });
  });
  afterAll(async () => {
    await dropOrder(order.id);
  });

  const attempt = (waiterId, token = tokens.managerA1) =>
    request(app).post(`/api/tables/${tableA1.id}/service`).set(auth(token)).send({ waiterId });

  it('refuses another company s staff, and says nothing about whether they exist', async () => {
    const res = await attempt(staff.captainB1.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not in this business/i);
    // The same message for an id that is not a user at all: the reply cannot be
    // used to discover that someone else's account exists.
    const absent = await attempt('ckzzzzzzzzzzzzzzzzzzzzzzzz');
    expect(absent.status).toBe(400);
    expect(absent.body.error.message).toBe(res.body.error.message);
    expect((await serviceOf(order.id)).waiterId).toBeNull();
  });

  it('refuses another company s staff written straight to Postgres, past every route', async () => {
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { waiterId: staff.captainB1.id, waiterSetAt: new Date(), waiterSetById: staff.managerA1.id },
      }),
    ).rejects.toThrow();
    expect((await serviceOf(order.id)).waiterId).toBeNull();
  });

  it('refuses a colleague who works at the company s other store', async () => {
    const res = await attempt(staff.captainA2.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/does not work in this store/i);
    expect((await serviceOf(order.id)).waiterId).toBeNull();
  });

  it('accepts that same colleague once they are assigned to this store', async () => {
    // An explicit store assignment WIDENS a store-pinned role's reach — the rule
    // stated in lib/permissions.js. Eligibility here is resolved through the same
    // function, so it widens here too, and nobody has to remember to teach this
    // route about assignments.
    const assignment = await prisma.userStoreAssignment.create({
      data: { userId: staff.captainA2.id, companyId: companyA.id, branchId: branchA1.id },
    });
    try {
      const res = await attempt(staff.captainA2.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.service.waiterName).toBe('Ravi Captain');
    } finally {
      await prisma.order.update({
        where: { id: order.id },
        data: { waiterId: null, waiterSetAt: null, waiterSetById: null },
      });
      await prisma.userStoreAssignment.delete({ where: { id: assignment.id } });
    }
  });

  it('refuses a switched-off account, so a leaver stops accruing sales', async () => {
    const res = await attempt(staff.captainDisabled.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/disabled/i);
    expect((await serviceOf(order.id)).waiterId).toBeNull();
  });

  it('refuses somebody who cannot take an order at all', async () => {
    const res = await attempt(staff.kitchenA1.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not allowed to take orders/i);
    expect((await serviceOf(order.id)).waiterId).toBeNull();
  });

  it('honours a tenant rule that takes order.create away from a role', async () => {
    // The business, not the role baseline, has the last word: a captain whose
    // order.create is denied is no longer a candidate server either. Proves the
    // eligibility check reads the tenant's own rules rather than a hardcoded list.
    const rule = await prisma.permissionRule.create({
      data: {
        companyId: companyA.id,
        level: 'USER',
        userId: staff.captainA1.id,
        scopeKey: scopeKeyFor('USER', { userId: staff.captainA1.id }),
        action: 'order.create',
        effect: 'DENY',
      },
    });
    try {
      const res = await attempt(staff.captainA1.id);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not allowed to take orders/i);
    } finally {
      await prisma.permissionRule.delete({ where: { id: rule.id } });
    }
  });

  it('honours a tenant rule that takes the floor action away from the caller', async () => {
    const rule = await prisma.permissionRule.create({
      data: {
        companyId: companyA.id,
        level: 'USER',
        userId: staff.cashierA1.id,
        scopeKey: scopeKeyFor('USER', { userId: staff.cashierA1.id }),
        action: 'table.service',
        effect: 'DENY',
      },
    });
    try {
      const res = await attempt(staff.captainA1.id, tokens.cashierA1);
      expect(res.status).toBe(403);
      expect((await serviceOf(order.id)).waiterId).toBeNull();
    } finally {
      await prisma.permissionRule.delete({ where: { id: rule.id } });
    }
  });
});

describe('another tenant s table is indistinguishable from one that is not there', () => {
  it('answers 404, never 403, for a table in a company the caller is not in', async () => {
    const bOrder = await openBill(tokens.ownerB, {
      tableId: tableB1.id, branchId: branchB1.id, productId: productB.id,
    });
    const res = await request(app)
      .post(`/api/tables/${tableB1.id}/service`)
      .set(auth(tokens.ownerA))
      .send({ pax: 4 });
    // 403 would confirm the table exists. It must read exactly like an id that
    // was never issued.
    expect(res.status).toBe(404);
    const absent = await request(app)
      .post('/api/tables/ckzzzzzzzzzzzzzzzzzzzzzzzz/service')
      .set(auth(tokens.ownerA))
      .send({ pax: 4 });
    expect(absent.status).toBe(404);
    expect(res.body.error.message).toBe(absent.body.error.message);
    expect((await serviceOf(bOrder.id)).pax).toBeNull();
    await dropOrder(bOrder.id);
  });

  it('refuses a store-pinned caller reaching into their company s other store', async () => {
    const a2Order = await openBill(tokens.ownerA, {
      tableId: tableA2.id, branchId: branchA2.id, productId: productA.id,
    });
    const res = await request(app)
      .post(`/api/tables/${tableA2.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4 });
    expect(res.status).toBe(404);
    expect((await serviceOf(a2Order.id)).pax).toBeNull();
    await dropOrder(a2Order.id);
  });
});

// MUST REMAIN THE LAST describe IN THIS FILE. It calls wipe(), which is
// unscoped and empties every table, so anything declared after it would find
// no fixtures. afterAll() runs wipe() again on the emptied database, which is
// harmless.
//
// WHY THIS EXISTS. wipe() clears UserInvitation immediately before PosUser.
// UserInvitation.createdById and .acceptedById both reference PosUser under
// onDelete: Restrict, so an unscoped posUser.deleteMany() throws
// UserInvitation_createdById_fkey while any invitation still points at a user
// being deleted. cf9c4a0 added that line to fourteen files; this file arrived
// later, with the x/tables merge, and needed it too.
//
// WHY IT SEEDS ITS OWN INVITATION. The obvious way to test this is to let an
// earlier file leave an invitation behind and watch this file's wipe() trip
// over it. That test would be worthless. Every file that seats invitations —
// invitations, platformAdmin, authTenantIsolation, foundation — clears them in
// its own afterAll, so nothing is left behind, and a five-file run of this
// suite passed identically with the fix REMOVED. A regression case that depends
// on another file's residue therefore proves nothing about this file and
// silently stops testing anything the moment run order changes.
describe('the cleanup can remove a user an invitation still points at', () => {
  it('clears the invitation first, so wipe() deletes the user instead of throwing', async () => {
    // Both RESTRICT paths in one row: created by one user, accepted by another.
    const invitation = await prisma.userInvitation.create({
      data: {
        companyId: companyA.id,
        email: 'cleanup.probe@svc.local',
        fullName: 'Cleanup Probe',
        role: 'BRANCH_MANAGER',
        tokenHash: 'tablesService-cleanup-regression-tokenhash',
        expiresAt: new Date(Date.now() + 86400e3),
        createdById: staff.ownerA.id,
        acceptedById: staff.managerA1.id,
      },
    });

    // Assert the hazard is real before asserting it is handled. Without this,
    // a silently failed create would leave wipe() with nothing to trip over and
    // the test would pass while testing nothing.
    expect(invitation.createdById).toBe(staff.ownerA.id);
    expect(invitation.acceptedById).toBe(staff.managerA1.id);
    expect(await prisma.userInvitation.count()).toBe(1);
    expect(await prisma.posUser.count()).toBeGreaterThan(0);

    // The subject under test: this file's own cleanup, unmodified. wipe()
    // returns undefined, so resolving to undefined is exactly "it completed";
    // a rejection fails here with the Prisma error as the reason.
    await expect(wipe()).resolves.toBeUndefined();

    // The user is gone, which is the thing the FK was blocking.
    expect(await prisma.posUser.count()).toBe(0);
    expect(await prisma.userInvitation.count()).toBe(0);
  });
});
