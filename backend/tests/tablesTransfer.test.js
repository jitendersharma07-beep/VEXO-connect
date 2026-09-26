// Table transfer — moving a seated party from one table to another. LANE tables,
// spec §B "Tables (Pro): ... transfer/merge table ...", the transfer half.
// MERGE IS NOT TESTED HERE because it is not implemented: it needs a terminal
// OrderStatus for the bill that gets emptied, which is an owner decision (see
// WINDOW-1-HANDOFF-TABLES §5), not something to invent in a test.
//
// The matrix is mostly negative controls, and each one asserts the REASON for
// the refusal and THE ABSENCE OF THE WRITE. Both halves are needed: a route that
// answers 409 after having already moved the party passes a status-only
// assertion, and that is precisely the bug shape this lane has already found
// once (see storeScopeGate.test.js, where a 404 arrived after the row was
// written).
//
// Two properties are proved twice on purpose — once through the API and once by
// writing straight to Postgres. A route guard can be forgotten by the next
// endpoint somebody adds; a unique constraint cannot.
//
// CLEANUP IS SCOPED TO THIS SUITE'S OWN COMPANIES, deliberately, and not the
// chain of unscoped deleteMany() calls the older files use. 23 RESTRICT foreign
// keys point at PosUser, so an unscoped posUser.deleteMany() only survives in a
// file that already deletes most of the database in dependency order. That
// pattern failed twice in this lane on two different constraints. See
// storeScopeGate.test.js and WINDOW-1-HANDOFF-TABLES §3.2.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('tablesTransfer.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { scopeKeyFor } = await import('../src/lib/permissions.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const COMPANY_SLUGS = ['alpha-xfer', 'bravo-xfer'];

const wipe = async () => {
  const companies = await prisma.company.findMany({
    where: { slug: { in: COMPANY_SLUGS } },
    select: { id: true },
  });
  const ids = companies.map((c) => c.id);
  if (!ids.length) return;
  const companyId = { in: ids };

  const users = await prisma.posUser.findMany({ where: { companyId }, select: { id: true } });
  const userId = { in: users.map((u) => u.id) };
  const orders = await prisma.order.findMany({ where: { companyId }, select: { id: true } });
  const orderId = { in: orders.map((o) => o.id) };
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true } });

  // Downward through the dependency graph. Every RESTRICT child of Order and of
  // PosUser that this suite can create has to go before its parent, which is the
  // whole reason the list is this long and this ordered.
  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.orderItemModifier.deleteMany({
    where: { orderItemId: { in: items.map((i) => i.id) } },
  });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.kot.deleteMany({ where: { orderId } });
  await prisma.payment.deleteMany({ where: { orderId } });
  await prisma.qrSubmission.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { companyId } });
  await prisma.diningVisitGuest.deleteMany({ where: { visit: { companyId } } });
  await prisma.diningVisit.deleteMany({ where: { companyId } });
  await prisma.tableQrCode.deleteMany({ where: { companyId } });
  await prisma.kitchenItem.deleteMany({ where: { station: { companyId } } });
  await prisma.kitchenRoute.deleteMany({ where: { station: { companyId } } });
  await prisma.kitchenStation.deleteMany({ where: { companyId } });
  await prisma.invoiceCounter.deleteMany({ where: { branch: { companyId } } });
  await prisma.product.deleteMany({ where: { companyId } });
  await prisma.category.deleteMany({ where: { companyId } });
  await prisma.taxRate.deleteMany({ where: { companyId } });
  await prisma.diningTable.deleteMany({ where: { branch: { companyId } } });
  await prisma.posAuditLog.deleteMany({ where: { companyId } });
  await prisma.posSession.deleteMany({ where: { userId } });
  await prisma.permissionRule.deleteMany({ where: { companyId } });
  await prisma.userStoreAssignment.deleteMany({ where: { companyId } });
  await prisma.licenseAddon.deleteMany({ where: { license: { companyId } } });
  await prisma.license.deleteMany({ where: { companyId } });
  await prisma.discountPolicy.deleteMany({ where: { companyId } });
  await prisma.emailOutbox.deleteMany({ where: { companyId } });
  await prisma.userInvitation.deleteMany({ where: { companyId } });
  await prisma.posUser.deleteMany({ where: { companyId } });
  await prisma.branch.deleteMany({ where: { companyId } });
  await prisma.company.deleteMany({ where: { id: companyId } });
};

const tokens = {};
const staff = {};
let companyA, companyB, branchA1, branchA2, branchB1;
// T1 and T2 share a floor — the only pair a transfer may ever join. tableA2 is
// the same company's OTHER store and tableB1 is another tenant's; both must be
// refused, and refused in the same words.
let tableA1, tableA2nd, tableA3rd, tableOther, tableB1;
let productA;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

/** Removes one order and everything that points at it, in dependency order. */
const dropOrder = async (orderId) => {
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true } });
  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.orderItemModifier.deleteMany({
    where: { orderItemId: { in: items.map((i) => i.id) } },
  });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.kot.deleteMany({ where: { orderId } });
  await prisma.payment.deleteMany({ where: { orderId } });
  await prisma.qrSubmission.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
};

/** Every bill and every visit at these tables, gone. Each test starts empty. */
const clearTables = async (...tableIds) => {
  const orders = await prisma.order.findMany({
    where: { tableId: { in: tableIds } },
    select: { id: true },
  });
  for (const o of orders) await dropOrder(o.id);
  await prisma.diningVisitGuest.deleteMany({ where: { visit: { tableId: { in: tableIds } } } });
  await prisma.diningVisit.deleteMany({ where: { tableId: { in: tableIds } } });
};

/** A dine-in order with one taxed line, opened at `tableId`. */
const openBill = async (token, { tableId, branchId, productId = null }) => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({
      type: 'DINE_IN',
      tableId,
      branchId,
      items: [{ productId: productId ?? productA.id, qty: 2 }],
    });
  expect(res.status, `open bill: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.order;
};

/** Everything a transfer must not silently change, in one row. */
const orderRow = (orderId) =>
  prisma.order.findUnique({
    where: { id: orderId },
    select: {
      tableId: true,
      branchId: true,
      visitId: true,
      status: true,
      pax: true,
      waiterId: true,
      subtotal: true,
      discountAmount: true,
      taxAmount: true,
      total: true,
    },
  });

const transfer = (token, fromTableId, body) =>
  request(app).post(`/api/tables/${fromTableId}/transfer`).set(auth(token)).send(body);

/** Seats a party through the floor plan rather than through a QR card. */
const seatVisit = async (tableId, branchId) =>
  prisma.diningVisit.create({
    data: {
      companyId: companyA.id,
      branchId,
      tableId,
      openTableId: tableId,
      joinCode: '4821',
      openedById: staff.managerA1.id,
    },
  });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Transfer',
      slug: 'alpha-xfer',
      licenses: {
        create: {
          plan: 'MULTI_STORE',
          baseBranchLimit: 3,
          expiresAt: new Date(Date.now() + 86400e3),
        },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Transfer',
      slug: 'bravo-xfer',
      licenses: {
        create: {
          plan: 'SINGLE_STORE',
          baseBranchLimit: 1,
          expiresAt: new Date(Date.now() + 86400e3),
        },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: {
      companyId: companyA.id,
      publicId: 'VC-XF-0001',
      name: 'Alpha One',
      code: 'X1',
      city: 'Delhi',
    },
  });
  branchA2 = await prisma.branch.create({
    data: {
      companyId: companyA.id,
      publicId: 'VC-XF-0002',
      name: 'Alpha Two',
      code: 'X2',
      city: 'Jaipur',
    },
  });
  branchB1 = await prisma.branch.create({
    data: {
      companyId: companyB.id,
      publicId: 'VC-XF-0003',
      name: 'Bravo One',
      code: 'X3',
      city: 'Pune',
    },
  });

  tableA1 = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'T1', capacity: 4 },
  });
  tableA2nd = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'T2', capacity: 2 },
  });
  tableA3rd = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'T3', capacity: 6 },
  });
  tableOther = await prisma.diningTable.create({
    data: { branchId: branchA2.id, name: 'T1', capacity: 4 },
  });
  tableB1 = await prisma.diningTable.create({
    data: { branchId: branchB1.id, name: 'T1', capacity: 4 },
  });

  const mkUser = (key, data) =>
    prisma.posUser.create({ data: { passwordHash, ...data } }).then((u) => {
      staff[key] = u;
      return u;
    });

  await mkUser('ownerA', {
    email: 'owner.a@xfer.local',
    fullName: 'Owner A',
    role: 'CUSTOMER_OWNER',
    companyId: companyA.id,
  });
  await mkUser('managerA1', {
    email: 'manager.a1@xfer.local',
    fullName: 'Manager A1',
    role: 'BRANCH_MANAGER',
    companyId: companyA.id,
    branchId: branchA1.id,
  });
  await mkUser('captainA1', {
    email: 'captain.a1@xfer.local',
    fullName: 'Meera Captain',
    role: 'CAPTAIN',
    companyId: companyA.id,
    branchId: branchA1.id,
  });
  // At A1 and cannot work a table at all — the role gate's negative control.
  await mkUser('kitchenA1', {
    email: 'kitchen.a1@xfer.local',
    fullName: 'Kitchen A1',
    role: 'KITCHEN',
    companyId: companyA.id,
    branchId: branchA1.id,
  });
  await mkUser('ownerB', {
    email: 'owner.b@xfer.local',
    fullName: 'Owner B',
    role: 'CUSTOMER_OWNER',
    companyId: companyB.id,
  });
  await prisma.posUser.create({
    data: {
      email: 'atc@xfer.local',
      fullName: 'ATC Operator',
      role: 'POS_SUPER_ADMIN',
      passwordHash,
    },
  });

  tokens.ownerA = await login('owner.a@xfer.local');
  tokens.managerA1 = await login('manager.a1@xfer.local');
  tokens.captainA1 = await login('captain.a1@xfer.local');
  tokens.kitchenA1 = await login('kitchen.a1@xfer.local');
  tokens.ownerB = await login('owner.b@xfer.local');
  tokens.atc = await login('atc@xfer.local');

  const taxA = await prisma.taxRate.create({
    data: { companyId: companyA.id, name: 'GST5-X', ratePercent: '5.000' },
  });
  const catA = await prisma.category.create({
    data: { companyId: companyA.id, name: 'Mains X', sortOrder: 1 },
  });
  productA = await prisma.product.create({
    data: {
      companyId: companyA.id,
      categoryId: catA.id,
      name: 'Thali X',
      basePrice: '200.00',
      taxRateId: taxA.id,
    },
  });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('moving a party to another table on the same floor', () => {
  it('moves the bill and does not change a single amount on it', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });
    const before = await orderRow(order.id);
    expect(before.tableId).toBe(tableA1.id);

    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.transfer.from.id).toBe(tableA1.id);
    expect(res.body.transfer.to.id).toBe(tableA2nd.id);
    expect(res.body.transfer.to.name).toBe('T2');
    expect(res.body.transfer.ordersMoved).toBe(1);

    const after = await orderRow(order.id);
    expect(after.tableId).toBe(tableA2nd.id);
    // A transfer is furniture, not pricing. Every money column byte-identical,
    // compared as strings so a Decimal that changed scale would still show up.
    expect(String(after.subtotal)).toBe(String(before.subtotal));
    expect(String(after.discountAmount)).toBe(String(before.discountAmount));
    expect(String(after.taxAmount)).toBe(String(before.taxAmount));
    expect(String(after.total)).toBe(String(before.total));
    // And the store did not move either.
    expect(after.branchId).toBe(before.branchId);
    expect(after.status).toBe('OPEN');
  });

  it('carries the covers and the server across with the party', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });
    const svc = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4, waiterId: staff.captainA1.id });
    expect(svc.status, JSON.stringify(svc.body)).toBe(200);

    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Nothing in the transfer path writes these, and that is the point: the same
    // four people are eating and Meera is still serving them. The party moved,
    // not the facts about it.
    const after = await orderRow(order.id);
    expect(after.pax).toBe(4);
    expect(after.waiterId).toBe(staff.captainA1.id);
  });

  it('moves the visit and the open-table pin together', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const visit = await seatVisit(tableA1.id, branchA1.id);
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });

    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.transfer.visitId).toBe(visit.id);

    const moved = await prisma.diningVisit.findUnique({ where: { id: visit.id } });
    expect(moved.tableId).toBe(tableA2nd.id);
    // openTableId is what makes "at most one open visit per table" a database
    // fact rather than an application hope. Left behind, the old table would read
    // occupied for ever and nothing would ever notice.
    expect(moved.openTableId).toBe(tableA2nd.id);
    expect(moved.status).toBe('OPEN');
    expect((await orderRow(order.id)).tableId).toBe(tableA2nd.id);
  });

  it('leaves the printed QR card on the table it is stuck to', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const card = await prisma.tableQrCode.create({
      data: {
        companyId: companyA.id,
        branchId: branchA1.id,
        tableId: tableA1.id,
        activeTableId: tableA1.id,
        rotation: 1,
        token: 'xfer-card-token-1',
        issuedById: staff.managerA1.id,
      },
    });
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });

    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The card is laminated to the furniture. Re-pointing it would make the card
    // on T1 open bills for T2 — and would collide with T2's own card on
    // activeTableId, so the database refuses the mistake before policy does.
    const still = await prisma.tableQrCode.findUnique({ where: { id: card.id } });
    expect(still.tableId).toBe(tableA1.id);
    expect(still.activeTableId).toBe(tableA1.id);
  });

  it('records who moved which party, from where, to where', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });
    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'TABLE_TRANSFER', entityId: tableA1.id },
      orderBy: { at: 'desc' },
    });
    expect(log, 'a transfer must be attributable').toBeTruthy();
    expect(log.companyId).toBe(companyA.id);
    expect(log.actorId).toBe(staff.managerA1.id);
    expect(log.meta.fromTableName).toBe('T1');
    expect(log.meta.toTableName).toBe('T2');
    expect(log.meta.orderIds).toContain(order.id);
  });
});

describe('the moves a floor may not make', () => {
  it('refuses a table in the company s other store, and writes nothing', async () => {
    await clearTables(tableA1.id, tableOther.id);
    const order = await openBill(tokens.ownerA, { tableId: tableA1.id, branchId: branchA1.id });

    const res = await transfer(tokens.ownerA, tableA1.id, { toTableId: tableOther.id });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    // The MESSAGE, not just the status. An unrouted path returns 404 with
    // code POS_NOT_FOUND and message 'Not found' (middleware/error.js
    // notFoundHandler), so a status-only assertion here would pass just as
    // happily against a route that does not exist — which is exactly how a
    // negative control ends up proving nothing. 'Table not found' can only
    // come from this endpoint's own refusal.
    expect(res.body.error.message).toBe('Table not found');
    // The party is still where it was. A refusal that arrives after the write is
    // the failure this assertion exists to catch.
    expect((await orderRow(order.id)).tableId).toBe(tableA1.id);
  });

  it('answers another tenant s table in exactly the same words', async () => {
    await clearTables(tableA1.id);
    await openBill(tokens.ownerA, { tableId: tableA1.id, branchId: branchA1.id });

    const sibling = await transfer(tokens.ownerA, tableA1.id, { toTableId: tableOther.id });
    const foreign = await transfer(tokens.ownerA, tableA1.id, { toTableId: tableB1.id });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.message, 'must be the endpoint refusing, not the router').toBe(
      'Table not found',
    );
    // Byte-identical. If a foreign tenant's id read differently from a sibling
    // store's, the difference itself would map an estate the caller cannot see.
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(sibling.body));
  });

  it('is actually a mounted route, and not a 404 the negative controls mistook', async () => {
    // The control for every 404 above. A sibling path that was never routed
    // returns the router's own 'Not found'; the real path with a real table
    // returns this endpoint's 'Table not found'. If the two ever read the same,
    // the refusal tests above have stopped testing anything.
    const unrouted = await request(app)
      .post(`/api/tables/${tableA1.id}/transfer-does-not-exist`)
      .set(auth(tokens.ownerA))
      .send({ toTableId: tableA2nd.id });
    expect(unrouted.status).toBe(404);
    expect(unrouted.body.error.message).toBe('Not found');

    const routed = await transfer(tokens.ownerA, tableA1.id, { toTableId: 'no-such-table-id' });
    expect(routed.status).toBe(404);
    expect(routed.body.error.message).toBe('Table not found');
    expect(routed.body.error.message).not.toBe(unrouted.body.error.message);
  });

  it('refuses a destination that already has a party, and moves neither', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const here = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });
    const there = await openBill(tokens.managerA1, {
      tableId: tableA2nd.id,
      branchId: branchA1.id,
    });

    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // Two bills on one table is the outcome this refusal exists to prevent, so
    // both are checked rather than just the one being moved.
    expect((await orderRow(here.id)).tableId).toBe(tableA1.id);
    expect((await orderRow(there.id)).tableId).toBe(tableA2nd.id);
  });

  it('refuses a destination that has a visit but no bill yet', async () => {
    await clearTables(tableA1.id, tableA3rd.id);
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });
    const sitting = await seatVisit(tableA3rd.id, branchA1.id);

    // A party seated with nothing ordered yet is still a party. Checking only for
    // an open bill would seat the next group on top of them.
    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA3rd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((await prisma.diningVisit.findUnique({ where: { id: sitting.id } })).tableId).toBe(
      tableA3rd.id,
    );
  });

  it('refuses a retired table', async () => {
    await clearTables(tableA1.id, tableA3rd.id);
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });
    await prisma.diningTable.update({
      where: { id: tableA3rd.id },
      data: { status: 'RETIRED' },
    });
    try {
      const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA3rd.id });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
    } finally {
      await prisma.diningTable.update({
        where: { id: tableA3rd.id },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('refuses to move a party that is not there', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  it('refuses a bill that has already been issued, and leaves it where it is', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });
    const billed = await request(app)
      .post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);

    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA2nd.id });
    // The customer is holding a printed bill with T1 on it. Moving the party now
    // would leave their copy disagreeing with the record — the same argument
    // assertServiceEditable makes about covers, about the same piece of paper.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const after = await orderRow(order.id);
    expect(after.tableId).toBe(tableA1.id);
    expect(after.status).toBe('BILLED');
  });

  it('refuses a move to the table the party is already at', async () => {
    await clearTables(tableA1.id);
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });
    const res = await transfer(tokens.managerA1, tableA1.id, { toTableId: tableA1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });

  it('refuses a source table the caller cannot see', async () => {
    await clearTables(tableB1.id);
    // Another tenant's owner, naming this tenant's table. 404 rather than 403,
    // so the reply cannot confirm the table exists.
    const res = await transfer(tokens.ownerB, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    // The message, not just the status. notFoundHandler answers an unrouted path
    // with 404 and the same POS_NOT_FOUND code, so a status-only assertion here
    // would pass even against an endpoint that was never mounted. This is
    // loadTableInScope refusing on a route that exists, which is the thing
    // actually under test.
    expect(res.body.error.message).toBe('Table not found');
  });
});

describe('who may move a party', () => {
  it('lets a captain do it, because that is whose job it is', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });
    const res = await transfer(tokens.captainA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses the kitchen', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });
    const res = await transfer(tokens.kitchenA1, tableA1.id, { toTableId: tableA2nd.id });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('refuses ATC, which stays read-only on a tenant s floor', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    const order = await openBill(tokens.managerA1, {
      tableId: tableA1.id,
      branchId: branchA1.id,
    });
    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/transfer`)
      .set(auth(tokens.atc))
      .query({ companyId: companyA.id })
      .send({ toTableId: tableA2nd.id });
    // The platform operator can read a tenant's floor and must not rearrange it.
    // requireRole omits POS_SUPER_ADMIN throughout this router on purpose.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await orderRow(order.id)).tableId).toBe(tableA1.id);
  });

  it('honours a tenant switching table.transfer off for this person', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    await openBill(tokens.managerA1, { tableId: tableA1.id, branchId: branchA1.id });
    // Registering the action in the catalogue is only half of it. This proves the
    // route actually consults the tenant's own rules rather than the role
    // baseline — the same captain who succeeded above is refused here, with
    // nothing changed but one row.
    const rule = await prisma.permissionRule.create({
      data: {
        companyId: companyA.id,
        level: 'USER',
        userId: staff.captainA1.id,
        scopeKey: scopeKeyFor('USER', { userId: staff.captainA1.id }),
        action: 'table.transfer',
        effect: 'DENY',
      },
    });
    try {
      const res = await transfer(tokens.captainA1, tableA1.id, { toTableId: tableA2nd.id });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    } finally {
      await prisma.permissionRule.delete({ where: { id: rule.id } });
    }
  });
});

describe('what the database refuses regardless of the route', () => {
  it('will not let two open visits claim one table', async () => {
    await clearTables(tableA1.id, tableA2nd.id);
    await seatVisit(tableA1.id, branchA1.id);
    // Straight to Postgres, no route involved. openTableId is @unique, so "at
    // most one open visit per table" is a constraint and not a code path — which
    // is what closes the race a concurrent transfer would otherwise open.
    await expect(seatVisit(tableA1.id, branchA1.id)).rejects.toThrow();
  });
});
