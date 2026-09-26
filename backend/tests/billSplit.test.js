// Split bill — one cheque becomes two. LANE tables, spec §B "Tables (Pro):
// ... split bill".
//
// THE ONLY TEST THAT REALLY MATTERS IS THAT THE PAISE ADD UP, and it is asserted
// on every positive path here rather than once in a dedicated case. A split that
// balances for round numbers and loses a paise on 33.33 at 18% GST is a till
// that does not balance, and the basket in front of a real guest is never the
// round one.
//
// Prices and rates are therefore chosen to be awkward on purpose: 33.33, 66.67
// and 199.99 across 0%, 5% and 18%, so per-line round-half-up actually has
// something to disagree about. Round prices would make every policy look
// correct — including the three that lose thousands of rupees (see
// WINDOW-1-HANDOFF-TABLES §5.1).
//
// The refusals are the other half of the feature, and each asserts the REASON
// and THE ABSENCE OF THE WRITE. A route that answers 409 after having already
// moved the lines passes a status-only assertion, which is exactly the bug shape
// this lane has already shipped once (see storeScopeGate.test.js).
//
// A 404 here is checked BY MESSAGE, never by status alone. notFoundHandler
// answers an unrouted path with 404 and the same POS_NOT_FOUND code that
// loadOrder's notFound('Order not found') uses, so a status-only negative
// control passes against an endpoint that was never mounted. That mistake was
// made in tablesTransfer.test.js and caught on review; it is not repeated here.
//
// CLEANUP IS SCOPED TO THIS SUITE'S OWN COMPANIES. 23 RESTRICT foreign keys
// point at PosUser, so an unscoped posUser.deleteMany() only survives in a file
// that already deletes most of the database in dependency order — a pattern that
// has failed twice in this lane. See WINDOW-1-HANDOFF-TABLES §3.2.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('billSplit.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const paise = (d) => Math.round(Number(d) * 100);

const COMPANY_SLUGS = ['alpha-split', 'bravo-split'];

const wipe = async () => {
  // The platform operator belongs to no company, so every company-scoped delete
  // below steps straight over it — and PosUser.email is globally @unique, so a
  // second beforeAll would collide on the address. globalSetup TRUNCATEs before
  // each run, which is the only reason this has never bitten; removing it by
  // email is what makes the suite re-runnable on a live database, e.g. when
  // iterating with -t. PosSession.userId is a real FK, so the session goes first;
  // PosAuditLog.actorId is a plain String with none, so it needs nothing.
  const atc = await prisma.posUser.findUnique({
    where: { email: 'atc@split.local' },
    select: { id: true },
  });
  if (atc) {
    await prisma.posSession.deleteMany({ where: { userId: atc.id } });
    await prisma.posUser.delete({ where: { id: atc.id } });
  }

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
  const orderItemId = { in: items.map((i) => i.id) };

  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.kitchenItem.deleteMany({ where: { orderItemId } });
  await prisma.promotionRedemption.deleteMany({ where: { orderId } });
  await prisma.orderItemModifier.deleteMany({ where: { orderItemId } });
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
  await prisma.printTarget.deleteMany({ where: { station: { companyId } } });
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
let companyA, companyB, branchA1, branchB1, tableA1, tableA2, stationA1;
// Three rates and three awkward prices. p0 is zero-rated so one line's tax
// cannot mask another's rounding.
let p0, p5, p18, productB1;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const dropOrder = async (orderId) => {
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true } });
  const orderItemId = { in: items.map((i) => i.id) };
  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.kitchenItem.deleteMany({ where: { orderItemId } });
  await prisma.promotionRedemption.deleteMany({ where: { orderId } });
  await prisma.orderItemModifier.deleteMany({ where: { orderItemId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.kot.deleteMany({ where: { orderId } });
  await prisma.payment.deleteMany({ where: { orderId } });
  await prisma.qrSubmission.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
};

/** Every bill at this table, gone. Each test starts from an empty floor. */
const clearTable = async (tableId) => {
  const orders = await prisma.order.findMany({ where: { tableId }, select: { id: true } });
  for (const o of orders) await dropOrder(o.id);
  await prisma.diningVisitGuest.deleteMany({ where: { visit: { tableId } } });
  await prisma.diningVisit.deleteMany({ where: { tableId } });
};

/** A dine-in bill with the given lines. Returns the created order with items. */
const openBill = async (token, lines, tableId) => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ type: 'DINE_IN', tableId: tableId ?? tableA1.id, branchId: branchA1.id, items: lines });
  expect(res.status, `open bill: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.order;
};

/** The three-line mixed-rate bill most tests split. */
const openMixedBill = (token = tokens.managerA1) =>
  openBill(token, [
    { productId: p5.id, qty: 3 },
    { productId: p18.id, qty: 2 },
    { productId: p0.id, qty: 1 },
  ]);

const orderRow = (id) =>
  prisma.order.findUnique({
    where: { id },
    select: {
      id: true, status: true, tableId: true, branchId: true, companyId: true,
      visitId: true, pax: true, waiterId: true, invoiceNumber: true,
      openedById: true, discountType: true,
      subtotal: true, discountAmount: true, taxAmount: true, total: true,
    },
  });

const lineIdsOf = async (orderId) => {
  const items = await prisma.orderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, productId: true, orderId: true },
  });
  return items;
};

const split = (token, orderId, body) =>
  request(app).post(`/api/orders/${orderId}/split`).set(auth(token)).send(body);

/**
 * The assertion the feature exists to satisfy. Compared in integer paise, not
 * in rupees or floats, because the whole question is whether a single paise
 * went missing.
 */
const expectConserved = async (originalId, chequeId, totalBefore) => {
  const a = await orderRow(originalId);
  const b = await orderRow(chequeId);
  expect(paise(a.total) + paise(b.total)).toBe(totalBefore);
  // And each side has to be internally consistent too — a cheque whose own
  // subtotal − discount + tax does not equal its own total would still pass the
  // sum check if the other side were wrong by the opposite amount.
  for (const o of [a, b]) {
    expect(paise(o.subtotal) - paise(o.discountAmount) + paise(o.taxAmount)).toBe(paise(o.total));
  }
  return { a, b };
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Split',
      slug: 'alpha-split',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Split',
      slug: 'bravo-split',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-SP-0001', name: 'Alpha One', code: 'S1', city: 'Delhi' },
  });
  branchB1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-SP-0002', name: 'Bravo One', code: 'S2', city: 'Pune' },
  });

  tableA1 = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'S1', capacity: 6 },
  });
  // A second table, because POST /api/orders refuses a second open bill on a
  // table that already has one ('Table "S1" already has an open order'). Any
  // test that needs TWO simultaneous bills needs somewhere to seat the second.
  tableA2 = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'S2', capacity: 4 },
  });

  // ACTIVE and defaultForBranch, so POST /:id/kot actually routes lines and
  // creates KitchenItem rows. Without a station the kitchen feature is dormant
  // and the KitchenItem.orderId test below would pass vacuously on zero rows.
  stationA1 = await prisma.kitchenStation.create({
    data: {
      companyId: companyA.id,
      branchId: branchA1.id,
      name: 'Hot Pass',
      defaultForBranch: branchA1.id,
      status: 'ACTIVE',
    },
  });

  const mkUser = (key, data) =>
    prisma.posUser.create({ data: { passwordHash, ...data } }).then((u) => {
      staff[key] = u;
      return u;
    });

  await mkUser('ownerA', {
    email: 'owner.a@split.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id,
  });
  await mkUser('managerA1', {
    email: 'manager.a1@split.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('cashierA1', {
    email: 'cashier.a1@split.local', fullName: 'Cashier A1', role: 'CASHIER',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('captainA1', {
    email: 'captain.a1@split.local', fullName: 'Meera Captain', role: 'CAPTAIN',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('kitchenA1', {
    email: 'kitchen.a1@split.local', fullName: 'Kitchen A1', role: 'KITCHEN',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('ownerB', {
    email: 'owner.b@split.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id,
  });
  await prisma.posUser.create({
    data: { email: 'atc@split.local', fullName: 'ATC Operator', role: 'POS_SUPER_ADMIN', passwordHash },
  });

  tokens.ownerA = await login('owner.a@split.local');
  tokens.managerA1 = await login('manager.a1@split.local');
  tokens.cashierA1 = await login('cashier.a1@split.local');
  tokens.captainA1 = await login('captain.a1@split.local');
  tokens.kitchenA1 = await login('kitchen.a1@split.local');
  tokens.ownerB = await login('owner.b@split.local');
  tokens.atc = await login('atc@split.local');

  const rate = (name, pct) =>
    prisma.taxRate.create({ data: { companyId: companyA.id, name, ratePercent: pct } });
  const t0 = await rate('GST0-S', '0.000');
  const t5 = await rate('GST5-S', '5.000');
  const t18 = await rate('GST18-S', '18.000');

  const catA = await prisma.category.create({
    data: { companyId: companyA.id, name: 'Mains S', sortOrder: 1 },
  });
  const product = (name, price, taxRateId) =>
    prisma.product.create({
      data: { companyId: companyA.id, categoryId: catA.id, name, basePrice: price, taxRateId },
    });
  // Deliberately awkward: none of these divides cleanly by its tax rate.
  p0 = await product('Water S', '33.33', t0.id);
  p5 = await product('Thali S', '66.67', t5.id);
  p18 = await product('Cola S', '199.99', t18.id);

  const catB = await prisma.category.create({
    data: { companyId: companyB.id, name: 'Mains B', sortOrder: 1 },
  });
  productB1 = await prisma.product.create({
    data: { companyId: companyB.id, categoryId: catB.id, name: 'Other B', basePrice: '100.00' },
  });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('splitting a bill into separate cheques', () => {
  it('adds up to the paise, and neither cheque invents money', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const before = await orderRow(order.id);
    const totalBefore = paise(before.total);
    // Guard the fixture itself: a bill of zero would make conservation trivial.
    expect(totalBefore).toBeGreaterThan(0);

    const lines = await lineIdsOf(order.id);
    expect(lines).toHaveLength(3);

    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const { a, b } = await expectConserved(order.id, res.body.split.chequeId, totalBefore);
    // The original kept its id and is still open — nothing was emptied, which is
    // the whole reason split does not need the terminal OrderStatus merge needs.
    expect(a.id).toBe(order.id);
    expect(a.status).toBe('OPEN');
    expect(b.status).toBe('OPEN');
    expect(b.id).not.toBe(a.id);
  });

  it('conserves across every way of cutting the same bill', async () => {
    // One line moved, then two, then the middle one — the same basket split
    // three different ways. A policy that is only right for a balanced cut
    // fails here, and this is where per-line GST rounding gets its chance.
    for (const pick of [[0], [1], [0, 1], [1, 2], [0, 2]]) {
      await clearTable(tableA1.id);
      const order = await openMixedBill();
      const totalBefore = paise((await orderRow(order.id)).total);
      const lines = await lineIdsOf(order.id);

      const res = await split(tokens.managerA1, order.id, {
        itemIds: pick.map((i) => lines[i].id),
      });
      expect(res.status, `pick ${pick}: ${JSON.stringify(res.body)}`).toBe(200);
      const { a, b } = await expectConserved(order.id, res.body.split.chequeId, totalBefore);
      // Both sides must be non-empty — a cheque with no lines and a zero total
      // would satisfy the sum while being a broken split.
      expect(paise(a.total)).toBeGreaterThan(0);
      expect(paise(b.total)).toBeGreaterThan(0);
    }
  });

  it('moves the chosen lines and only the chosen lines', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const moved = lines[1].id;

    const res = await split(tokens.managerA1, order.id, { itemIds: [moved] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const chequeId = res.body.split.chequeId;

    const stayed = await lineIdsOf(order.id);
    const went = await lineIdsOf(chequeId);
    expect(stayed.map((i) => i.id).sort()).toEqual([lines[0].id, lines[2].id].sort());
    expect(went.map((i) => i.id)).toEqual([moved]);
  });

  it('copies the server but leaves the covers on the original', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const svc = await request(app)
      .post(`/api/tables/${tableA1.id}/service`)
      .set(auth(tokens.managerA1))
      .send({ pax: 4, waiterId: staff.captainA1.id });
    expect(svc.status, JSON.stringify(svc.body)).toBe(200);

    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cheque = await orderRow(res.body.split.chequeId);
    const original = await orderRow(order.id);

    // Meera sold both cheques, so sales-per-waiter has to see both —
    // Order has @@index([companyId, waiterId, billedAt]) for exactly that query.
    expect(cheque.waiterId).toBe(staff.captainA1.id);
    expect(original.waiterId).toBe(staff.captainA1.id);

    // But there are still only four people at the table. Copying pax would
    // report eight the first time anything SUMs it, and splitting it 2/2 would
    // invent a fact nobody observed.
    expect(original.pax).toBe(4);
    expect(cheque.pax).toBeNull();
    expect(paise(original.pax === null ? 0 : 1)).toBeGreaterThanOrEqual(0); // fixture sanity
  });

  it('keeps both cheques on the same table, visit, store and tenant', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[0].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const a = await orderRow(order.id);
    const b = await orderRow(res.body.split.chequeId);
    expect(b.tableId).toBe(a.tableId);
    expect(b.visitId).toBe(a.visitId);
    expect(b.branchId).toBe(a.branchId);
    expect(b.companyId).toBe(a.companyId);
    // The new cheque has not been billed, so it must not have borrowed an
    // invoice number — @@unique([companyId, invoiceNumber]) would refuse a copy
    // and a silently shared number would be worse than a refusal.
    expect(b.invoiceNumber).toBeNull();
  });

  it('re-points the kitchen item but leaves the ticket it was cooked on', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const sent = await request(app)
      .post(`/api/orders/${order.id}/kot`)
      .set(auth(tokens.managerA1))
      .send({});
    // 201, not 200: sending a KOT creates a ticket.
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const lines = await lineIdsOf(order.id);
    const moving = lines[1].id;
    const kiBefore = await prisma.kitchenItem.findUnique({
      where: { orderItemId: moving },
      select: { id: true, orderId: true, kotId: true, changeSeq: true },
    });
    // The test is only meaningful if a kitchen row actually exists. Without the
    // ACTIVE default station in beforeAll this would be null and every
    // assertion below would pass against nothing.
    expect(kiBefore, 'no KitchenItem — is the station ACTIVE?').not.toBeNull();
    expect(kiBefore.orderId).toBe(order.id);

    const res = await split(tokens.managerA1, order.id, { itemIds: [moving] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const chequeId = res.body.split.chequeId;

    const kiAfter = await prisma.kitchenItem.findUnique({
      where: { orderItemId: moving },
      select: { orderId: true, kotId: true, changeSeq: true },
    });
    // KitchenItem.orderId is a denormalised String with NO foreign key, so
    // nothing in the database would have caught it going stale. Left alone, a
    // live QUEUED item would keep naming the bill it is no longer on.
    expect(kiAfter.orderId).toBe(chequeId);
    // Bumped, so a connected kitchen screen re-reads the row instead of
    // trusting its cached copy.
    expect(kiAfter.changeSeq).toBeGreaterThan(kiBefore.changeSeq);
    // But the ticket itself is history: the kitchen really did cook this as part
    // of that one send, and rewriting it would falsify the past to tidy the
    // present. Same rule as the QR card that stays glued to the table.
    expect(kiAfter.kotId).toBe(kiBefore.kotId);
    const item = await prisma.orderItem.findUnique({
      where: { id: moving },
      select: { orderId: true, kotId: true },
    });
    expect(item.orderId).toBe(chequeId);
    expect(item.kotId).toBe(kiBefore.kotId);
  });

  it('writes an audit row naming who split what', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Scoped to THIS bill's id, not just to the action. Earlier tests in this
    // file split successfully too, so a take:1 ordered only by createdAt would
    // be reading whichever row won a millisecond tie.
    const rows = await prisma.posAuditLog.findMany({
      where: { companyId: companyA.id, action: 'BILL_SPLIT', entityId: order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(order.id);
    expect(rows[0].meta.chequeId).toBe(res.body.split.chequeId);
    expect(rows[0].meta.movedItemIds).toEqual([lines[1].id]);
  });

  it('gives each cheque its own invoice number at billing', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const chequeId = res.body.split.chequeId;

    // A split happens before billing, so neither side carries a number yet.
    expect((await orderRow(order.id)).invoiceNumber).toBeNull();
    expect((await orderRow(chequeId)).invoiceNumber).toBeNull();

    const billOne = await request(app)
      .post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(billOne.status, JSON.stringify(billOne.body)).toBe(200);
    const billTwo = await request(app)
      .post(`/api/orders/${chequeId}/bill`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(billTwo.status, JSON.stringify(billTwo.body)).toBe(200);

    const a = await orderRow(order.id);
    const b = await orderRow(chequeId);
    expect(a.invoiceNumber).toBeTruthy();
    expect(b.invoiceNumber).toBeTruthy();
    // Order carries @@unique([companyId, invoiceNumber]). This is why chequeFrom
    // leaves invoiceNumber unset rather than copying it: two cheques off one bill
    // must each be billed in their own right, and a copied number would either
    // violate that constraint or put one number on two documents.
    expect(a.invoiceNumber).not.toBe(b.invoiceNumber);
  });

  it('discounts each cheque on its own subtotal, not the other’s', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const chequeId = res.body.split.chequeId;
    const originalBefore = await orderRow(order.id);

    // The discount split refuses to divide is applied AFTER the split instead —
    // which is exactly what the refusal message tells staff to do, so the advice
    // has to actually work.
    const disc = await request(app)
      .post(`/api/orders/${chequeId}/discount`)
      .set(auth(tokens.ownerA))
      .send({ type: 'PERCENT', value: 10 });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);

    const cheque = await orderRow(chequeId);
    const original = await orderRow(order.id);
    // 10% of the CHEQUE's subtotal, not of the bill they came from.
    expect(paise(cheque.discountAmount)).toBe(
      Math.floor((paise(cheque.subtotal) * 10000 + 50000) / 100000),
    );
    expect(paise(cheque.subtotal) - paise(cheque.discountAmount) + paise(cheque.taxAmount)).toBe(
      paise(cheque.total),
    );
    // And the other cheque is untouched — no shared discount column, no
    // recomputation reaching across.
    expect(paise(original.total)).toBe(paise(originalBefore.total));
    expect(paise(original.discountAmount)).toBe(0);
  });
});

describe('the splits a bill may not have', () => {
  it('refuses a discounted bill and tells staff what to do instead', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const before = await orderRow(order.id);
    // Set the column directly. Going through POST /:id/discount would drag in
    // the approval flow, discount policy and an approver PIN — none of which
    // this guard reads. It reads one column, so one column is what the test
    // sets, and the refusal is what is under test.
    await prisma.order.update({
      where: { id: order.id },
      data: { discountType: 'FLAT', discountValue: '50.00' },
    });

    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toMatch(/Remove the discount before splitting/i);

    // And nothing moved. Copying a FLAT discount onto both cheques was measured
    // at 4000/4000 wrong, worst case −₹10,016, so a refusal that had already
    // written would be the worst of both.
    const after = await lineIdsOf(order.id);
    expect(after).toHaveLength(3);
    expect(await prisma.order.count({ where: { tableId: tableA1.id } })).toBe(1);
    expect(String((await orderRow(order.id)).total)).toBe(String(before.total));
  });

  it('refuses once money has been taken against the bill', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    // The Payment row is written DIRECTLY, and that is the point of the test.
    // Billing first and paying through the API would leave the order BILLED, so
    // the 409 would come from the status refusal above — this test would pass
    // while the money guard it names was never reached. The payments route
    // refuses anything that is not BILLED ("Payments are recorded on billed
    // orders only"), so OPEN-with-a-payment is a state the API cannot produce
    // and the guard is a backstop. A backstop still has to be shown to work.
    await prisma.payment.create({
      data: {
        orderId: order.id,
        branchId: branchA1.id,
        method: 'CASH',
        amount: 10,
        receivedById: staff.managerA1.id,
      },
    });

    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // Names the money, not the status — proof the branch under test is the one
    // that fired.
    expect(res.body.error.message).toMatch(/money has already been taken/i);
    expect(await orderRow(order.id)).toMatchObject({ status: 'OPEN' });
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses a bill that has already been issued', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const billed = await request(app)
      .post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);

    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toMatch(/billed/i);
    const after = await orderRow(order.id);
    expect(after.status).toBe('BILLED');
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses to move every line, because that is not a split', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);

    const res = await split(tokens.managerA1, order.id, { itemIds: lines.map((l) => l.id) });
    // Moving everything leaves an empty original behind, which is exactly the
    // emptied-bill problem that blocks merge and would need the terminal
    // OrderStatus that does not exist. Refused so split cannot back into it.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/at least one line/i);
    expect(await lineIdsOf(order.id)).toHaveLength(3);
    expect(await prisma.order.count({ where: { tableId: tableA1.id } })).toBe(1);
  });

  it('refuses a line that belongs to a different bill', async () => {
    await clearTable(tableA1.id);
    await clearTable(tableA2.id);
    const mine = await openMixedBill();
    // Seated at the OTHER table: two open bills cannot share one table.
    const other = await openBill(tokens.managerA1, [{ productId: p5.id, qty: 1 }], tableA2.id);
    const theirs = await lineIdsOf(other.id);

    const res = await split(tokens.managerA1, mine.id, { itemIds: [theirs[0].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/not on this bill/i);
    // The other bill is untouched too — a refusal must not half-move anything.
    expect((await lineIdsOf(other.id)).map((l) => l.id)).toEqual([theirs[0].id]);
    expect(await lineIdsOf(mine.id)).toHaveLength(3);
  });

  it('refuses the same line listed twice', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.managerA1, order.id, {
      itemIds: [lines[0].id, lines[0].id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses an empty selection', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const res = await split(tokens.managerA1, order.id, { itemIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses a voided line', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    // Void is only for lines the kitchen has already seen — without a KOT the
    // route answers 'Line was never sent to the kitchen; delete it instead', and
    // this test would be asserting against an unvoided line.
    const sent = await request(app)
      .post(`/api/orders/${order.id}/kot`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const lines = await lineIdsOf(order.id);
    const voided = await request(app)
      .post(`/api/orders/${order.id}/items/${lines[2].id}/void`)
      .set(auth(tokens.managerA1))
      .send({ reason: 'guest changed their mind' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[2].id] });
    // A voided line carries no money and is not on the bill to be divided. Same
    // message as a line from another order, so the reply cannot be used to tell
    // "voided here" from "belongs elsewhere".
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/not on this bill/i);
  });

  it('refuses an aggregator bill, which the provider settles', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    // Written directly, because the aggregator intake path belongs to another
    // lane and this test is about what split does when it meets one — not about
    // how one is created. These three columns are written together in exactly
    // one place (lib/integrations/aggregatorOrders.js), so this is the shape a
    // real provider order has.
    await prisma.order.update({
      where: { id: order.id },
      data: { channel: 'AGGREGATOR', channelProvider: 'SWIGGY', externalOrderId: 'SW-TEST-1' },
    });

    const res = await split(tokens.managerA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toMatch(/aggregator/i);
    // Nothing moved, and no second cheque exists to disagree with the provider.
    expect(await lineIdsOf(order.id)).toHaveLength(3);
    expect(
      await prisma.order.count({ where: { companyId: companyA.id, externalOrderId: 'SW-TEST-1' } }),
    ).toBe(1);
  });

  it('refuses a bill the caller cannot see, by message and not just by status', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);

    const res = await split(tokens.ownerB, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    // loadOrder's own words, on a route that exists. Status alone would also be
    // satisfied by an unrouted path — see the mounted-route control below.
    expect(res.body.error.message).toBe('Order not found');
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('is actually a mounted route, and not a 404 the controls mistook', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);

    const unrouted = await request(app)
      .post(`/api/orders/${order.id}/split-does-not-exist`)
      .set(auth(tokens.managerA1))
      .send({ itemIds: [lines[1].id] });
    expect(unrouted.status).toBe(404);
    expect(unrouted.body.error.message).toBe('Not found');

    const routed = await split(tokens.ownerB, order.id, { itemIds: [lines[1].id] });
    expect(routed.status).toBe(404);
    expect(routed.body.error.message).toBe('Order not found');
    // If these two ever read the same, the refusal test above has stopped
    // testing anything at all.
    expect(routed.body.error.message).not.toBe(unrouted.body.error.message);
  });
});

describe('who may split a bill', () => {
  it('lets a cashier do it, because settling is the till’s job', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const totalBefore = paise((await orderRow(order.id)).total);
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.cashierA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectConserved(order.id, res.body.split.chequeId, totalBefore);
  });

  it('refuses the kitchen', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.kitchenA1, order.id, { itemIds: [lines[1].id] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses a captain, who may seat a party but not divide its money', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await split(tokens.captainA1, order.id, { itemIds: [lines[1].id] });
    // Deliberate, and recorded as such at lib/permissions.js:358 — a captain gets
    // table.service and table.transfer because covers and the server are their own
    // observations, and is withheld bill.split because dividing money is the
    // till's job. The captain IS in the route's role list, so this 403 comes from
    // requireAction and not from requireRole: an owner who grants bill.split
    // through customPermissions gets a captain who can split.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses the platform operator, who may look but not divide a bill', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const res = await request(app)
      .post(`/api/orders/${order.id}/split`)
      .set(auth(tokens.atc))
      .query({ companyId: companyA.id })
      .send({ itemIds: [lines[1].id] });
    // ROLE_ACTIONS gives POS_SUPER_ADMIN every action key, and bill.split is NOT
    // in SUPPORT_GRANT_REQUIRED, so requireAction alone would have let VEXO
    // divide a customer's bill. The explicit role list is what refuses it, and
    // this file's header contract — "ATC operators are read-only here" — is why
    // that list exists.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await lineIdsOf(order.id)).toHaveLength(3);
  });

  it('refuses a manager from another store in the same company', async () => {
    await clearTable(tableA1.id);
    const order = await openMixedBill();
    const lines = await lineIdsOf(order.id);
    const branchA2 = await prisma.branch.create({
      data: { companyId: companyA.id, publicId: 'VC-SP-0009', name: 'Alpha Two', code: 'S9', city: 'Agra' },
    });
    const passwordHash = await hashPassword(PW);
    await prisma.posUser.create({
      data: {
        email: 'manager.a2@split.local', fullName: 'Manager A2', role: 'BRANCH_MANAGER',
        companyId: companyA.id, branchId: branchA2.id, passwordHash,
      },
    });
    const token = await login('manager.a2@split.local');

    const res = await split(token, order.id, { itemIds: [lines[1].id] });
    // loadOrder refuses a branch-pinned user reaching another store's bill.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await lineIdsOf(order.id)).toHaveLength(3);

    await prisma.posSession.deleteMany({ where: { user: { branchId: branchA2.id } } });
    await prisma.posUser.deleteMany({ where: { branchId: branchA2.id } });
    await prisma.branch.deleteMany({ where: { id: branchA2.id } });
  });
});
