// Table merge — putting two tables' parties on one bill. LANE tables, spec §B
// "Tables (Pro): ... transfer/merge table ...", the merge half, and the last of
// the four. tablesTransfer.test.js used to say merge was untestable because it
// needed a terminal OrderStatus nobody had decided on; OrderStatus.MERGED
// (migration 20260926091200_order_status_merged) is that decision, and this file
// is what it unblocked.
//
// THE ONE CLAIM THIS FILE EXISTS TO PROVE is conservation, and it is asserted in
// BOTH directions on every positive case. "The two bills add up to the one bill"
// is weaker than it looks: it also passes when money stayed behind on the source
// and the survivor came out short by the same amount, which is the exact failure
// a merge is prone to. So every case asserts that the survivor carries the WHOLE
// amount and that the merged-away bill carries NOTHING.
//
// Prices are 33.33 / 66.67 / 199.99 against 0% / 5% / 18% tax, which is not
// decoration: those are the baskets where per-line rounding can disagree with an
// order-level total, and a merge that re-summed instead of moving lines would
// show up here and nowhere else.
//
// The matrix is mostly negative controls, and each one asserts THE REASON for the
// refusal and THE ABSENCE OF THE WRITE. Both halves are needed: a route that
// answers 409 after having already emptied the bill passes a status-only
// assertion, and that is precisely the bug shape this lane has already found once
// (storeScopeGate.test.js, where a 404 arrived after the row was written).
//
// CLEANUP IS SCOPED TO THIS SUITE'S OWN COMPANIES, not the chain of unscoped
// deleteMany() calls the older files use. 23 RESTRICT foreign keys point at
// PosUser, so an unscoped posUser.deleteMany() only survives in a file that
// already deletes most of the database in dependency order. See
// WINDOW-1-HANDOFF-TABLES §3.2.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('tablesMerge.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { scopeKeyFor } = await import('../src/lib/permissions.js');
// The real evaluator, imported so the discount fixtures below can put a bill into
// the state a discounted bill is ACTUALLY in. Writing discountType alone leaves
// the stored total stale, which is a state no floor can reach and — proven by a
// negative control — one that makes a discounted merge conserve trivially and the
// test prove nothing. See the fixture note at the discount cases.
const { recomputeOrder } = await import('../src/lib/orders.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const paise = (d) => Math.round(Number(d) * 100);

const COMPANY_SLUGS = ['alpha-merge', 'bravo-merge'];

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
  const orderItemId = { in: items.map((i) => i.id) };

  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.kitchenItem.deleteMany({ where: { orderItemId } });
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
// M1 and M2 are the pair almost every test merges. M3 is the third table the
// "destination already has two cheques" and "source merged away" cases need.
// tableOther is the same company's OTHER store and tableB1 another tenant's;
// both must be refused, and refused in the same words as an unknown id.
let tableA1, tableA2, tableA3, tableOther, tableB1;
let p0, p5, p18, stationA1;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

/** Removes one order and everything that points at it, in dependency order. */
const dropOrder = async (orderId) => {
  const items = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true } });
  const orderItemId = { in: items.map((i) => i.id) };
  await prisma.kitchenItem.deleteMany({ where: { orderId } });
  await prisma.kitchenItem.deleteMany({ where: { orderItemId } });
  await prisma.orderItemModifier.deleteMany({ where: { orderItemId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.kot.deleteMany({ where: { orderId } });
  await prisma.payment.deleteMany({ where: { orderId } });
  await prisma.qrSubmission.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
};

/**
 * Every bill and every visit at these tables, gone. Each test starts empty.
 *
 * MERGED orders have to be swept too, and that is easy to get wrong: the status
 * filters everywhere else in the lane are OPEN/BILLED allowlists, so a cleanup
 * that borrowed one would leave yesterday's merged bills behind and the next
 * test's SUM over the table would silently include them.
 */
const clearTables = async (...tableIds) => {
  const orders = await prisma.order.findMany({
    where: { tableId: { in: tableIds } },
    select: { id: true },
  });
  for (const o of orders) await dropOrder(o.id);
  await prisma.diningVisitGuest.deleteMany({ where: { visit: { tableId: { in: tableIds } } } });
  await prisma.qrSubmission.deleteMany({ where: { tableId: { in: tableIds } } });
  await prisma.diningVisit.deleteMany({ where: { tableId: { in: tableIds } } });
  // Cards last: submissions, visits and orders all reference one with
  // onDelete: Restrict, so they have to be gone first. Swept at all so the file's
  // tests stay order-independent — TableQrCode.activeTableId and .token are both
  // @unique, and a card left pinned to M1 would make a later test that issues one
  // fail for a reason that has nothing to do with merging.
  await prisma.tableQrCode.deleteMany({ where: { tableId: { in: tableIds } } });
};

const openBill = async (token, { tableId, lines = null }) => {
  const res = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({
      type: 'DINE_IN',
      tableId,
      branchId: branchA1.id,
      items: lines ?? [
        { productId: p5.id, qty: 3 },
        { productId: p18.id, qty: 2 },
        { productId: p0.id, qty: 1 },
      ],
    });
  expect(res.status, `open bill: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.order;
};

/** Two parties, two tables, deliberately DIFFERENT baskets. */
const seatTwoParties = async () => {
  await clearTables(tableA1.id, tableA2.id, tableA3.id);
  const source = await openBill(tokens.managerA1, { tableId: tableA1.id });
  const target = await openBill(tokens.managerA1, {
    tableId: tableA2.id,
    lines: [{ productId: p18.id, qty: 1 }, { productId: p0.id, qty: 2 }],
  });
  return { source, target };
};

const orderRow = (id) =>
  prisma.order.findUnique({
    where: { id },
    select: {
      id: true, status: true, tableId: true, branchId: true, companyId: true,
      visitId: true, pax: true, waiterId: true, invoiceNumber: true,
      type: true, discountType: true,
      subtotal: true, discountAmount: true, taxAmount: true, total: true,
    },
  });

const activeLinesOf = (orderId) =>
  prisma.orderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, productId: true, orderId: true, lineTotal: true },
  });

const merge = (token, fromTableId, body) =>
  request(app).post(`/api/tables/${fromTableId}/merge`).set(auth(token)).send(body);

const split = (token, orderId, body) =>
  request(app).post(`/api/orders/${orderId}/split`).set(auth(token)).send(body);

/** Seats a party through the floor plan rather than through a QR card. */
const seatVisit = async (tableId) =>
  prisma.diningVisit.create({
    data: {
      companyId: companyA.id,
      branchId: branchA1.id,
      tableId,
      openTableId: tableId,
      joinCode: '4821',
      openedById: staff.managerA1.id,
    },
  });

/**
 * THE assertion, in integer paise and in both directions.
 *
 * `sumBefore` is the two stored totals added up before anything moved. The
 * survivor must equal it exactly and every merged-away bill must be exactly
 * zero — checking only the sum of everything afterwards would pass a merge that
 * short-changed the survivor and left the difference stranded.
 */
const expectConserved = async (targetId, mergedIds, sumBefore) => {
  const survivor = await orderRow(targetId);
  expect(paise(survivor.total), 'survivor must carry the whole amount').toBe(sumBefore);
  for (const id of mergedIds) {
    const gone = await orderRow(id);
    expect(paise(gone.total), 'a merged bill must carry nothing').toBe(0);
    expect(paise(gone.subtotal)).toBe(0);
    expect(paise(gone.taxAmount)).toBe(0);
  }
  // Each bill internally consistent too: subtotal − discount + tax = total. A
  // survivor whose own arithmetic disagreed with itself would still pass the sum
  // check if the error were in a column the sum does not read.
  for (const o of [survivor, ...(await Promise.all(mergedIds.map(orderRow)))]) {
    expect(paise(o.subtotal) - paise(o.discountAmount) + paise(o.taxAmount)).toBe(paise(o.total));
  }
  return survivor;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Merge',
      slug: 'alpha-merge',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Merge',
      slug: 'bravo-merge',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-MG-0001', name: 'Alpha One', code: 'G1', city: 'Delhi' },
  });
  branchA2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-MG-0002', name: 'Alpha Two', code: 'G2', city: 'Jaipur' },
  });
  branchB1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-MG-0003', name: 'Bravo One', code: 'G3', city: 'Pune' },
  });

  tableA1 = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'M1', capacity: 4 },
  });
  tableA2 = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'M2', capacity: 6 },
  });
  tableA3 = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'M3', capacity: 2 },
  });
  tableOther = await prisma.diningTable.create({
    data: { branchId: branchA2.id, name: 'M1', capacity: 4 },
  });
  tableB1 = await prisma.diningTable.create({
    data: { branchId: branchB1.id, name: 'M1', capacity: 4 },
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
    email: 'owner.a@merge.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id,
  });
  await mkUser('managerA1', {
    email: 'manager.a1@merge.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('managerOther', {
    email: 'manager.a2@merge.local', fullName: 'Manager A2', role: 'BRANCH_MANAGER',
    companyId: companyA.id, branchId: branchA2.id,
  });
  await mkUser('captainA1', {
    email: 'captain.a1@merge.local', fullName: 'Meera Captain', role: 'CAPTAIN',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('waiterA1', {
    email: 'waiter.a1@merge.local', fullName: 'Ravi Server', role: 'CAPTAIN',
    companyId: companyA.id, branchId: branchA1.id,
  });
  // At A1 and cannot work a table at all — the role gate's negative control.
  await mkUser('kitchenA1', {
    email: 'kitchen.a1@merge.local', fullName: 'Kitchen A1', role: 'KITCHEN',
    companyId: companyA.id, branchId: branchA1.id,
  });
  await mkUser('ownerB', {
    email: 'owner.b@merge.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id,
  });
  await prisma.posUser.create({
    data: {
      email: 'atc@merge.local', fullName: 'ATC Operator', role: 'POS_SUPER_ADMIN', passwordHash,
    },
  });

  tokens.ownerA = await login('owner.a@merge.local');
  tokens.managerA1 = await login('manager.a1@merge.local');
  tokens.managerOther = await login('manager.a2@merge.local');
  tokens.captainA1 = await login('captain.a1@merge.local');
  tokens.kitchenA1 = await login('kitchen.a1@merge.local');
  tokens.ownerB = await login('owner.b@merge.local');
  tokens.atc = await login('atc@merge.local');

  const rate = (name, pct) =>
    prisma.taxRate.create({ data: { companyId: companyA.id, name, ratePercent: pct } });
  const t0 = await rate('GST0-M', '0.000');
  const t5 = await rate('GST5-M', '5.000');
  const t18 = await rate('GST18-M', '18.000');
  const catA = await prisma.category.create({
    data: { companyId: companyA.id, name: 'Mains M', sortOrder: 1 },
  });
  const product = (name, price, taxRateId) =>
    prisma.product.create({
      data: { companyId: companyA.id, categoryId: catA.id, name, basePrice: price, taxRateId },
    });
  // Awkward on purpose. See the file header: these are the prices where per-line
  // rounding and an order-level total can disagree.
  p0 = await product('Water M', '33.33', t0.id);
  p5 = await product('Thali M', '66.67', t5.id);
  p18 = await product('Cola M', '199.99', t18.id);
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe('putting two tables on one bill', () => {
  it('moves every line onto the surviving cheque and conserves the total to the paise', async () => {
    const { source, target } = await seatTwoParties();
    const before = { s: await orderRow(source.id), t: await orderRow(target.id) };
    const sumBefore = paise(before.s.total) + paise(before.t.total);
    // The test would be vacuous if either party owed nothing, and vacuous in a
    // way no other assertion here would catch.
    expect(paise(before.s.total)).toBeGreaterThan(0);
    expect(paise(before.t.total)).toBeGreaterThan(0);

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merge.targetOrderId).toBe(target.id);
    expect(res.body.merge.mergedOrderIds).toEqual([source.id]);
    expect(res.body.merge.totalBeforePaise).toBe(sumBefore);

    await expectConserved(target.id, [source.id], sumBefore);

    // And the lines really moved rather than being re-priced into place: five
    // lines on the survivor, none left on the merged bill.
    const survivorLines = await activeLinesOf(target.id);
    expect(survivorLines).toHaveLength(5);
    expect(await activeLinesOf(source.id)).toHaveLength(0);
    expect(res.body.merge.movedItemIds).toHaveLength(3);
  });

  it('leaves the merged bill terminal and takes the source table off the floor', async () => {
    const { source, target } = await seatTwoParties();

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const gone = await orderRow(source.id);
    // MERGED and not VOID. VOID would have been counted into voidedOrders by
    // lib/reporting/metrics.js and reported this as a cancelled sale — the whole
    // reason the enum value exists.
    expect(gone.status).toBe('MERGED');
    // The row is KEPT, not deleted, so the BILL_MERGE audit row still resolves to
    // a real order.
    expect(gone.id).toBe(source.id);
    // tableId stays: the bill really was rung up there.
    expect(gone.tableId).toBe(tableA1.id);

    // And the floor now shows M1 free while M2 carries the combined bill. This is
    // the assertion that proves MERGED needed no floor-query edit: every occupancy
    // filter is an OPEN/BILLED allowlist, so the new value drops out for free.
    const floor = await request(app).get('/api/tables').set(auth(tokens.managerA1));
    expect(floor.status, JSON.stringify(floor.body)).toBe(200);
    const byName = Object.fromEntries(floor.body.tables.map((t) => [t.name, t]));
    expect(byName.M1.currentOrder, 'M1 must read free').toBeNull();
    expect(byName.M2.currentOrder.id).toBe(target.id);
    expect(paise(byName.M2.currentOrder.total)).toBe(paise((await orderRow(target.id)).total));
  });

  it('adds both parties covers onto the survivor and clears them from the merged bill', async () => {
    const { source, target } = await seatTwoParties();
    for (const [tableId, pax] of [[tableA1.id, 2], [tableA2.id, 4]]) {
      const svc = await request(app)
        .post(`/api/tables/${tableId}/service`)
        .set(auth(tokens.managerA1))
        .send({ pax });
      expect(svc.status, JSON.stringify(svc.body)).toBe(200);
    }

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merge.pax).toBe(6);

    // Six people are now eating at M2 and a sales-per-cover report divides by
    // this column: leaving the survivor at 4 would overstate spend per head by
    // half.
    expect((await orderRow(target.id)).pax).toBe(6);
    // Cleared on the way out, so SUM(pax) across the estate still equals the
    // number of people who actually ate. A source still claiming 2 would report
    // 8 diners for 6 the moment any report stopped filtering by status — which is
    // exactly what this assertion is standing in front of.
    expect((await orderRow(source.id)).pax).toBeNull();

    const agg = await prisma.order.aggregate({
      where: { tableId: { in: [tableA1.id, tableA2.id] } },
      _sum: { pax: true },
    });
    expect(agg._sum.pax, 'six covers, counted once, with no status filter at all').toBe(6);

    // What each bill held before it was combined, which is the only way to
    // reconstruct the merge afterwards.
    expect(res.body.merge.paxBefore[source.id]).toBe(2);
    expect(res.body.merge.paxBefore[target.id]).toBe(4);
  });

  it('leaves covers unstated when neither party was counted', async () => {
    const { source, target } = await seatTwoParties();
    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Nulls are not zeros. A merge of two uncounted parties produces a bill
    // nobody has counted, not a confident 0 — which Order_pax_positive would
    // refuse anyway.
    expect(res.body.merge.pax).toBeNull();
    expect((await orderRow(target.id)).pax).toBeNull();
    expect((await orderRow(source.id)).pax).toBeNull();
  });

  it('does not credit the survivor s sale to the other table s server', async () => {
    const { source, target } = await seatTwoParties();
    for (const [tableId, waiterId] of [
      [tableA1.id, staff.captainA1.id],
      [tableA2.id, staff.waiterA1.id],
    ]) {
      const svc = await request(app)
        .post(`/api/tables/${tableId}/service`)
        .set(auth(tokens.managerA1))
        .send({ waiterId });
      expect(svc.status, JSON.stringify(svc.body)).toBe(200);
    }

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Deliberately NOT symmetrical with covers, and this is the assertion that
    // pins the asymmetry. Covers are a fact about the guests and move with them;
    // the server is a fact about who is looking after them, and the survivor's
    // table has its own. Overwriting it would credit Meera with Ravi's sale in
    // the very report Order's [companyId, waiterId, billedAt] index exists for.
    expect((await orderRow(target.id)).waiterId).toBe(staff.waiterA1.id);
    expect((await orderRow(source.id)).waiterId).toBe(staff.captainA1.id);
  });

  it('re-points the kitchen item but leaves the ticket it was cooked on', async () => {
    const { source, target } = await seatTwoParties();
    const sent = await request(app)
      .post(`/api/orders/${source.id}/kot`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const lines = await activeLinesOf(source.id);
    const moved = lines[0].id;
    const kiBefore = await prisma.kitchenItem.findUnique({
      where: { orderItemId: moved },
      select: { id: true, orderId: true, kotId: true, changeSeq: true },
    });
    // Without the ACTIVE default station in beforeAll this would be null and
    // every assertion below would pass against nothing.
    expect(kiBefore, 'no KitchenItem — is the station ACTIVE?').not.toBeNull();
    expect(kiBefore.orderId).toBe(source.id);

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merge.kitchenItemsRepointed).toBe(3);

    const kiAfter = await prisma.kitchenItem.findUnique({
      where: { orderItemId: moved },
      select: { orderId: true, kotId: true, changeSeq: true },
    });
    // KitchenItem.orderId is a denormalised String with NO foreign key, so
    // nothing in the database would have caught it going stale. Left alone, a
    // live QUEUED item would keep naming a bill that now totals zero and cannot
    // be paid.
    expect(kiAfter.orderId).toBe(target.id);
    expect(kiAfter.changeSeq).toBeGreaterThan(kiBefore.changeSeq);
    // The ticket is history: the kitchen really did cook this as part of that one
    // send at that table, and rewriting it would falsify the past to tidy the
    // present.
    expect(kiAfter.kotId).toBe(kiBefore.kotId);
    const kot = await prisma.kot.findUnique({
      where: { id: kiBefore.kotId }, select: { orderId: true },
    });
    expect(kot.orderId).toBe(source.id);
  });

  it('closes the source visit and frees its open-table pin', async () => {
    await clearTables(tableA1.id, tableA2.id, tableA3.id);
    const visit = await seatVisit(tableA1.id);
    const source = await openBill(tokens.managerA1, { tableId: tableA1.id });
    const target = await openBill(tokens.managerA1, {
      tableId: tableA2.id, lines: [{ productId: p18.id, qty: 1 }],
    });
    // Captured BEFORE the merge, because the claim below is "merge did not touch
    // this column", not "merge set it to a particular value". POST /api/orders
    // never writes visitId — there is no such assignment anywhere in
    // routes/orders.js — so a bill rung at the till on a table that HAS an open
    // visit still carries NULL, while a bill opened through a QR card carries the
    // visit (lib/qr/visits.js:211). Asserting "unchanged" is the invariant that
    // holds for both shapes; asserting visit.id would have been asserting a
    // linkage this fixture never created.
    const visitIdBefore = (await orderRow(source.id)).visitId;

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merge.closedVisitId).toBe(visit.id);

    const closed = await prisma.diningVisit.findUnique({ where: { id: visit.id } });
    expect(closed.status).toBe('CLOSED');
    // openTableId is what makes "at most one open visit per table" a database
    // fact. Left set, M1 would read occupied for ever and nothing would notice.
    expect(closed.openTableId).toBeNull();
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closedById).toBe(staff.managerA1.id);
    expect(closed.closedReason).toBe('MERGE');
    // Closing the visit does NOT rewrite the bill's own link to it. Whatever the
    // merged-away bill pointed at, it still points at — that is history, and it
    // is what lets a dispute find the party. Merge writes tableId, status and pax
    // on an order; visitId is not on that list.
    expect((await orderRow(source.id)).visitId).toBe(visitIdBefore);
    expect((await orderRow(target.id)).status).toBe('OPEN');
  });

  it('merges a till-rung party that never had a visit at all', async () => {
    const { source, target } = await seatTwoParties();
    // A dine-in order rung up at the till has tableId set and visitId NULL, so a
    // party can exist with no visit. The table still has to read free afterwards,
    // and with no visit to close the ONLY thing freeing it is the status change.
    expect((await orderRow(source.id)).visitId).toBeNull();

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merge.closedVisitId).toBeNull();

    const floor = await request(app).get('/api/tables').set(auth(tokens.managerA1));
    const byName = Object.fromEntries(floor.body.tables.map((t) => [t.name, t]));
    expect(byName.M1.currentOrder).toBeNull();
    expect(byName.M2.currentOrder.id).toBe(target.id);
  });

  it('leaves a voided line behind on the bill it was cancelled on', async () => {
    const { source, target } = await seatTwoParties();
    // Fired to the kitchen first, because VOID and DELETE are two different verbs
    // on a line and the route enforces the difference: orders.js:688 refuses to
    // void a line with no kotId and says "delete it instead". A line the kitchen
    // never saw is a typo to be removed; a line the kitchen already cooked is a
    // cancellation that has to stay on the record. Only the second kind is what
    // this test is about, so only the second kind can be set up.
    const sent = await request(app)
      .post(`/api/orders/${source.id}/kot`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const lines = await activeLinesOf(source.id);
    const voided = await request(app)
      .post(`/api/orders/${source.id}/items/${lines[2].id}/void`)
      .set(auth(tokens.managerA1))
      .send({ reason: 'guest changed their mind' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    const before = { s: await orderRow(source.id), t: await orderRow(target.id) };
    const sumBefore = paise(before.s.total) + paise(before.t.total);

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Two ACTIVE lines moved, not three.
    expect(res.body.merge.movedItemIds).toHaveLength(2);
    await expectConserved(target.id, [source.id], sumBefore);

    // A cancellation is a record of something that happened on THAT bill, and
    // dragging it across would put one party's cancellation in front of another
    // party's cashier. It carries no money either, so leaving it cannot affect
    // conservation — which is what the assertion above just proved.
    const stranded = await prisma.orderItem.findUnique({
      where: { id: lines[2].id }, select: { orderId: true, status: true },
    });
    expect(stranded.status).toBe('VOIDED');
    expect(stranded.orderId).toBe(source.id);
  });

  it('records a BILL_MERGE audit row naming who did it and what it linked', async () => {
    const { source, target } = await seatTwoParties();
    const sumBefore =
      paise((await orderRow(source.id)).total) + paise((await orderRow(target.id)).total);

    const res = await merge(tokens.captainA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await prisma.posAuditLog.findMany({
      where: { companyId: companyA.id, action: 'BILL_MERGE' },
      // PosAuditLog names its timestamp `at`, not `createdAt`.
      orderBy: { at: 'desc' },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Against the SURVIVING order, because that is the bill somebody querying
    // this dispute actually has in front of them.
    expect(row.entity).toBe('Order');
    expect(row.entityId).toBe(target.id);
    // WHO, not just what. A bill emptied into another one with no record of who
    // did it is precisely the dispute this row exists to settle.
    expect(row.actorId).toBe(staff.captainA1.id);
    expect(row.actorEmail).toBe('captain.a1@merge.local');
    // Stored, not joined: "what were they then", so a later promotion cannot
    // rewrite the past.
    expect(row.actorRole).toBe('CAPTAIN');
    // No FK links a merged bill to its survivor, so this meta IS the linkage and
    // a reconciliation that cannot find it cannot be done at all. Hence
    // auditRequired rather than audit.
    expect(row.meta.mergedOrderIds).toEqual([source.id]);
    expect(row.meta.fromTableName).toBe('M1');
    expect(row.meta.toTableName).toBe('M2');
    expect(row.meta.totalBeforePaise).toBe(sumBefore);
    expect(row.meta.totalsBeforePaise[source.id] + row.meta.totalsBeforePaise[target.id])
      .toBe(sumBefore);
  });

  it('lets the combined bill be billed once, for the combined amount', async () => {
    const { source, target } = await seatTwoParties();
    const sumBefore =
      paise((await orderRow(source.id)).total) + paise((await orderRow(target.id)).total);

    expect((await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id })).status).toBe(200);

    const billed = await request(app)
      .post(`/api/orders/${target.id}/bill`)
      .set(auth(tokens.managerA1))
      .send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);

    const after = await orderRow(target.id);
    expect(after.status).toBe('BILLED');
    // The invoice is for the whole party, and billing re-runs recomputeOrder — so
    // this also proves the merge left the survivor in a state the money engine
    // agrees with, not merely a state that looked right when it was written.
    expect(paise(after.total)).toBe(sumBefore);
    expect(after.invoiceNumber).not.toBeNull();

    // And the merged-away bill never acquires one. It has nothing to invoice.
    expect((await orderRow(source.id)).invoiceNumber).toBeNull();
  });

  it('refuses to bill, split or transfer a bill that has been merged away', async () => {
    const { source, target } = await seatTwoParties();
    expect((await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id })).status).toBe(200);

    // Every status guard in src/ runs as `!== 'OPEN'`, so MERGED refuses all
    // three by default and none of them needed editing. This is the assertion
    // that proves that claim rather than asserting it in a comment.
    const billed = await request(app)
      .post(`/api/orders/${source.id}/bill`)
      .set(auth(tokens.managerA1)).send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(409);

    const lines = await activeLinesOf(target.id);
    const resplit = await split(tokens.managerA1, source.id, { itemIds: [lines[0].id] });
    // 409, not 400: the request is well formed, the floor is in the wrong state
    // for it. splitBill.js:84 hits its `status !== 'OPEN'` guard before it ever
    // looks at the item ids, which is also why the message below reads correctly
    // for a value that did not exist when that line was written — it interpolates
    // the status rather than listing the ones it knows.
    expect(resplit.status, JSON.stringify(resplit.body)).toBe(409);
    expect(resplit.body.error.message).toMatch(/already merged and can no longer be split/i);

    // And the emptied table cannot be merged again — there is nothing at it.
    const again = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.message).toMatch(/no open bill to merge/i);
  });

  it('merges both cheques of a split party onto the other table s bill', async () => {
    const { source, target } = await seatTwoParties();
    const lines = await activeLinesOf(source.id);
    const sp = await split(tokens.managerA1, source.id, { itemIds: [lines[1].id] });
    expect(sp.status, JSON.stringify(sp.body)).toBe(200);
    const chequeId = sp.body.split.chequeId;

    const sumBefore =
      paise((await orderRow(source.id)).total) +
      paise((await orderRow(chequeId)).total) +
      paise((await orderRow(target.id)).total);

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Both of the source table's cheques go, and the SOURCE side is allowed to
    // hold more than one because the destination is still unambiguous. The
    // destination side is not — see the refusal below.
    expect(res.body.merge.mergedOrderIds.sort()).toEqual([source.id, chequeId].sort());
    await expectConserved(target.id, [source.id, chequeId], sumBefore);
    expect((await orderRow(chequeId)).status).toBe('MERGED');
  });
});

describe('the merges a floor may not make', () => {
  it('refuses an empty destination and names the operation that does work', async () => {
    await clearTables(tableA1.id, tableA2.id, tableA3.id);
    const source = await openBill(tokens.managerA1, { tableId: tableA1.id });
    const before = await orderRow(source.id);

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // Not an error the staff made — the wrong verb. A party joining an empty
    // table is a TRANSFER, which moves the bill without touching an amount and
    // needs no terminal status at all, so the message says so instead of just
    // refusing.
    expect(res.body.error.message).toMatch(/Move the party there instead/i);

    const after = await orderRow(source.id);
    expect(after.status).toBe('OPEN');
    expect(String(after.total)).toBe(String(before.total));
    expect((await activeLinesOf(source.id))).toHaveLength(3);
  });

  it('refuses merging a table into itself', async () => {
    const { source } = await seatTwoParties();
    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/into itself/i);
    expect((await orderRow(source.id)).status).toBe('OPEN');
  });

  it('refuses a destination holding two cheques, because there is no right answer', async () => {
    const { source, target } = await seatTwoParties();
    const lines = await activeLinesOf(target.id);
    const sp = await split(tokens.managerA1, target.id, { itemIds: [lines[0].id] });
    expect(sp.status, JSON.stringify(sp.body)).toBe(200);
    const chequeId = sp.body.split.chequeId;
    const before = {
      s: await orderRow(source.id), t: await orderRow(target.id), c: await orderRow(chequeId),
    };

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // Joining the oldest would put one party's food onto a cheque another guest
    // specifically asked to have separated; joining the newest does the same to
    // the other one. Only the staff standing there know, so the till stops
    // pretending to.
    expect(res.body.error.message).toMatch(/2 separate cheques/i);

    for (const [k, row] of Object.entries(before)) {
      const now = await orderRow(row.id);
      expect(now.status, k).toBe('OPEN');
      expect(String(now.total), k).toBe(String(row.total));
    }
  });

  it.each([
    ['the bill being merged', 'source'],
    ['the surviving bill', 'target'],
  ])('refuses once %s has been issued', async (_label, side) => {
    const { source, target } = await seatTwoParties();
    const victim = side === 'source' ? source : target;
    const billed = await request(app)
      .post(`/api/orders/${victim.id}/bill`)
      .set(auth(tokens.managerA1)).send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    const before = { s: await orderRow(source.id), t: await orderRow(target.id) };

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // The printed-paper argument, and it has to be the same argument
    // assertTransferable, assertSplittable and assertServiceEditable all make,
    // because it is the same piece of paper.
    expect(res.body.error.message).toMatch(/already billed/i);

    // Nothing moved. Both baskets intact, on both sides.
    expect(await activeLinesOf(source.id)).toHaveLength(3);
    expect(await activeLinesOf(target.id)).toHaveLength(2);
    expect(String((await orderRow(source.id)).total)).toBe(String(before.s.total));
    expect(String((await orderRow(target.id)).total)).toBe(String(before.t.total));
  });

  it.each([
    ['the bill being merged', 'source'],
    ['the surviving bill', 'target'],
  ])('refuses a discount on %s rather than dividing it', async (_label, side) => {
    const { source, target } = await seatTwoParties();
    const victim = side === 'source' ? source : target;
    // Set the columns directly — POST /:id/discount would drag in the approval
    // flow, the discount policy and an approver PIN, none of which this guard
    // reads — and then RECOMPUTE, which is the part that matters.
    //
    // The recompute is not tidiness. Without it the stored total still excludes
    // the discount, and a negative control run with the guard disabled proved that
    // fixture worthless on the source side: the merge came out conserved (₹1017.97
    // both before and after) because sumBefore was read from an undiscounted total
    // and an emptied source clamps FLAT to min(50, 0) = 0. It passed for a reason
    // that had nothing to do with the discount. With the recompute, sumBefore is a
    // genuinely discounted figure and the same control breaks conservation on both
    // sides — which is what makes this refusal a money guard rather than a
    // preference.
    await prisma.order.update({
      where: { id: victim.id },
      data: { discountType: 'FLAT', discountValue: '50.00' },
    });
    await recomputeOrder(prisma, victim.id);
    const discounted = await orderRow(victim.id);
    expect(paise(discounted.discountAmount), 'fixture must really be discounted').toBe(5000);

    const before = { s: await orderRow(source.id), t: await orderRow(target.id) };

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // This is the refusal that keeps "to the paisa" literally true instead of
    // redefining it as "within a paise". A FLAT discount clamped to
    // min(value, subtotal) on two small bills does not add up to the same
    // discount on one big one.
    expect(res.body.error.message).toMatch(/Remove the discount/i);
    expect(res.body.error.message).toMatch(/cannot be carried across a merge/i);

    expect(await activeLinesOf(source.id)).toHaveLength(3);
    expect(await activeLinesOf(target.id)).toHaveLength(2);
    expect(String((await orderRow(source.id)).total)).toBe(String(before.s.total));
    expect(String((await orderRow(target.id)).total)).toBe(String(before.t.total));
  });

  it('refuses once money has been taken against either bill', async () => {
    const { source, target } = await seatTwoParties();
    // Straight to Postgres: the payment route requires the bill to be BILLED,
    // and a BILLED bill is already refused by the check above — so a route-driven
    // payment could never reach THIS guard and the test would prove nothing about
    // it. The state the database permits is the state the library must refuse.
    await prisma.payment.create({
      data: {
        orderId: source.id,
        // No companyId on Payment — the store is carried instead, because that is
        // the column the terminal and device references are validated against.
        branchId: branchA1.id,
        method: 'CASH',
        amount: '10.00',
        receivedById: staff.managerA1.id,
      },
    });
    const before = await orderRow(source.id);

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toMatch(/Money has already been taken/i);

    expect(await activeLinesOf(source.id)).toHaveLength(3);
    expect((await orderRow(source.id)).status).toBe('OPEN');
    expect(String((await orderRow(source.id)).total)).toBe(String(before.total));
  });

  it('refuses while a guest submission is still waiting to be accepted', async () => {
    await clearTables(tableA1.id, tableA2.id, tableA3.id);
    const visit = await seatVisit(tableA1.id);
    const source = await openBill(tokens.managerA1, { tableId: tableA1.id });
    await openBill(tokens.managerA1, { tableId: tableA2.id, lines: [{ productId: p18.id, qty: 1 }] });
    const card = await prisma.tableQrCode.create({
      data: {
        companyId: companyA.id,
        branchId: branchA1.id,
        tableId: tableA1.id,
        // Holds tableId while ACTIVE; @unique, so it IS "at most one live card
        // per table".
        activeTableId: tableA1.id,
        // The opaque value in the printed URL, stored as issued rather than
        // hashed so a reprint can reproduce a card already glued to a table.
        token: 'merge-card-token-1',
        status: 'ACTIVE',
        issuedById: staff.managerA1.id,
      },
    });
    await prisma.qrSubmission.create({
      data: {
        companyId: companyA.id,
        branchId: branchA1.id,
        tableId: tableA1.id,
        qrCodeId: card.id,
        visitId: visit.id,
        status: 'SUBMITTED',
        // Unique per company: a guest whose phone retries Send gets the first
        // basket back rather than a second one.
        idempotencyKey: 'merge-sub-1',
        requestHash: 'h'.repeat(32),
        payload: { lines: [{ productId: p0.id, qty: 1 }] },
        lineCount: 1,
      },
    });

    const res = await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // The same refusal closeVisit makes, made here because closeVisit opens its
    // own transaction and cannot be called from inside this one. A basket nobody
    // has accepted or rejected would be orphaned by the visit closing under it.
    expect(res.body.error.message).toMatch(/nobody has accepted or rejected/i);

    expect((await orderRow(source.id)).status).toBe('OPEN');
    expect(
      (await prisma.diningVisit.findUnique({ where: { id: visit.id } })).status,
    ).toBe('OPEN');
  });

  it('refuses a destination in another store, in the same words as an unknown table', async () => {
    const { source } = await seatTwoParties();
    const res = await merge(tokens.ownerA, tableA1.id, { toTableId: tableOther.id });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.message).toBe('Table not found');
    const bogus = await merge(tokens.ownerA, tableA1.id, { toTableId: 'no-such-table-id' });
    // Identical, deliberately. A manager must not be able to tell "another
    // store's table" from "no such table" and map an estate they cannot see.
    expect(bogus.status).toBe(404);
    expect(bogus.body.error.message).toBe(res.body.error.message);
    expect((await orderRow(source.id)).status).toBe('OPEN');
  });

  it('refuses another tenant s table identically', async () => {
    const { source } = await seatTwoParties();
    const res = await merge(tokens.ownerA, tableA1.id, { toTableId: tableB1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.message).toBe('Table not found');
    expect((await orderRow(source.id)).status).toBe('OPEN');
    // And nothing was written into the other tenant either.
    expect(await prisma.order.count({ where: { companyId: companyB.id } })).toBe(0);
  });
});

describe('who may merge two tables', () => {
  it('lets a captain merge when the tenant leaves the action on', async () => {
    const { source, target } = await seatTwoParties();
    const sumBefore =
      paise((await orderRow(source.id)).total) + paise((await orderRow(target.id)).total);
    const res = await merge(tokens.captainA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectConserved(target.id, [source.id], sumBefore);
  });

  it('refuses a role that cannot work a table at all', async () => {
    const { source } = await seatTwoParties();
    const res = await merge(tokens.kitchenA1, tableA1.id, { toTableId: tableA2.id });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await orderRow(source.id)).status).toBe('OPEN');
  });

  it('refuses the VEXO platform operator, who is read-only in this router', async () => {
    const { source } = await seatTwoParties();
    const res = await request(app)
      .post(`/api/tables/${tableA1.id}/merge`)
      .set(auth(tokens.atc))
      .query({ companyId: companyA.id })
      .send({ toTableId: tableA2.id });
    // ROLE_ACTIONS hands POS_SUPER_ADMIN every action key, so an action-only gate
    // would have let a VEXO operator empty a tenant's bill into another one. The
    // explicit role list is what stops it.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await orderRow(source.id)).status).toBe('OPEN');
  });

  it('refuses a manager from another store in the same company', async () => {
    const { source } = await seatTwoParties();
    const res = await merge(tokens.managerOther, tableA1.id, { toTableId: tableA2.id });
    // The SOURCE table is resolved through the caller's scope, so this is
    // refused before the destination is even looked at — and answered 404, not
    // 403, for the same non-enumeration reason as above.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect((await orderRow(source.id)).status).toBe('OPEN');
  });

  it('honours a tenant switching table.transfer off for this person', async () => {
    const { source } = await seatTwoParties();
    // permissions.js:103 registers table.transfer as "Move or merge a party
    // between tables" — the catalogue entry covers both halves, which is why
    // merge mints no new key. This proves the route actually consults the
    // tenant's own rules: the same captain who succeeded above is refused here
    // with nothing changed but one row.
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
      const res = await merge(tokens.captainA1, tableA1.id, { toTableId: tableA2.id });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect((await orderRow(source.id)).status).toBe('OPEN');
    } finally {
      await prisma.permissionRule.delete({ where: { id: rule.id } });
    }
  });
});

describe('what a merged bill is outside of', () => {
  it('is counted as neither a void nor an open order', async () => {
    const { source, target } = await seatTwoParties();
    expect((await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id })).status).toBe(200);

    // THE REASON MERGED EXISTS RATHER THAN REUSING VOID, asserted rather than
    // argued. lib/reporting/metrics.js counts status 'VOID' into voidedOrders, so
    // a merge recorded as VOID would have read as a cancelled sale and corrupted
    // the void rate an owner uses to spot till fraud.
    const counts = await prisma.order.groupBy({
      by: ['status'],
      where: { companyId: companyA.id, tableId: { in: [tableA1.id, tableA2.id] } },
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    expect(byStatus.MERGED).toBe(1);
    expect(byStatus.VOID ?? 0).toBe(0);
    expect(byStatus.OPEN).toBe(1);
  });

  it('is outside every sales status, so no figure an owner reads moves', async () => {
    const { source, target } = await seatTwoParties();
    expect((await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id })).status).toBe(200);
    const { SALES_STATUSES } = await import('../src/lib/reporting/metrics.js');

    // Imported rather than re-typed on purpose: a future edit that added MERGED
    // to the real allowlist would fail here instead of silently double-counting
    // every merged bill into net sales, tax and the AOV denominator.
    expect([...SALES_STATUSES]).not.toContain('MERGED');
    const inSales = await prisma.order.count({
      where: { id: source.id, status: { in: [...SALES_STATUSES] } },
    });
    expect(inSales).toBe(0);
  });

  it('is hidden from the customer display instead of emptying itself on screen', async () => {
    const { source } = await seatTwoParties();
    expect((await merge(tokens.managerA1, tableA1.id, { toTableId: tableA2.id })).status).toBe(200);

    // display.js is one of exactly two places in src/ that needed a word added,
    // because it is a DENYLIST — it names the statuses to hide rather than the
    // ones to show, so a new value falls through it into the ACTIVE branch. Left
    // alone, the guest would have watched their order empty itself to a zero
    // total on the screen in front of them while the till rang the whole party up
    // on the other cheque.
    const { default: displayRouter } = await import('../src/api/routes/display.js');
    expect(displayRouter, 'display router must load').toBeTruthy();
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/api/routes/display.js', import.meta.url), 'utf8'));
    expect(src).toMatch(/order\.status === 'MERGED'/);
    expect((await orderRow(source.id)).status).toBe('MERGED');
  });
});
