// Captain, floor state, and the refusals that must leave no trace (W5).
//
// Three things are checked here and they are different in kind:
//
//  1. THE JOURNEY. Opening an order, changing its draft lines and sending the
//     KOT, over HTTP, against a real database. The screen at
//     frontend/src/pages/Captain.jsx makes exactly these calls in exactly this
//     order, so a green run here is the evidence that the sequence is real.
//
//  2. THE REFUSALS. Every one asserts the status AND the absence of the row.
//     A gate that answers 403 after writing is a worse defect than one that
//     answers 200, because nothing on any screen will ever show it — and a test
//     that stops at `expect(res.status).toBe(403)` passes on both.
//
//  3. THE STATES. tableStateOf had no test at all before this file. It is the
//     single derivation behind the floor plan, the captain's board and the
//     manager's status screen, and the two distinctions the requirement turns
//     on — READY is not SERVED, PAID is not FREE — live nowhere else.
//
// Recorded rather than fixed, because the routes belong to another window and
// the requests are written up in WINDOW-5-BACKEND-REQUEST.md:
//
//   §1  a CAPTAIN is refused on every order-taking route, so the role cannot
//       do the job it is sold as doing. Asserted below as it stands today.
//   §3  order.item.void is in CASHIER's and CAPTAIN's baselines and the route
//       is manager-only, so neither holder can reach it. Asserted below.
//   §4  no idempotency key on the three order writes, so a retry duplicates.
//       Asserted below as a negative control — it is why the captain's screen
//       reconciles instead of retrying.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('captainWorkflow.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { tableStateOf, TABLE_STATE_INCLUDE } = await import('../src/lib/qr/tableState.js');

const app = createApp();
const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const wipe = async () => {
  await prisma.floorLayoutTable.deleteMany();
  await prisma.floorLayoutObject.deleteMany();
  await prisma.floorLayout.deleteMany();
  await prisma.diningArea.deleteMany();
  await prisma.floor.deleteMany();
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.qrSubmission.deleteMany();
  await prisma.order.deleteMany();
  await prisma.diningVisitGuest.deleteMany();
  await prisma.diningVisit.deleteMany();
  await prisma.tableQrCode.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const tokens = {};
let companyA, branchA1, branchA2;
let tableA1, tableA1b, tableA2;
let menu;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

/** Every business row a refusal must not have created. */
const records = async () => ({
  orders: await prisma.order.count(),
  items: await prisma.orderItem.count(),
  kots: await prisma.kot.count(),
  payments: await prisma.payment.count(),
  voided: await prisma.orderItem.count({ where: { status: 'VOIDED' } }),
});

/** Reads one table back the only way a state may be derived from. */
const stateOf = async (tableId) => {
  const t = await prisma.diningTable.findUnique({
    where: { id: tableId },
    include: TABLE_STATE_INCLUDE,
  });
  return tableStateOf(t);
};

const openVisit = (tableId, branchId, joinCode) =>
  prisma.diningVisit.create({
    data: {
      companyId: companyA.id,
      branchId,
      tableId,
      openTableId: tableId,
      joinCode,
    },
  });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Diner',
      slug: 'alpha-captain',
      licenses: {
        create: {
          plan: 'MULTI_STORE',
          baseBranchLimit: 3,
          expiresAt: new Date(Date.now() + 86400e3),
        },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-CP-0001', name: 'Alpha One', code: 'A1', city: 'Delhi' },
  });
  branchA2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-CP-0002', name: 'Alpha Two', code: 'A2', city: 'Jaipur' },
  });

  tableA1 = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T1', capacity: 4 } });
  tableA1b = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T2', capacity: 2 } });
  tableA2 = await prisma.diningTable.create({ data: { branchId: branchA2.id, name: 'T1', capacity: 4 } });

  const mk = (d) => prisma.posUser.create({ data: { companyId: companyA.id, passwordHash, ...d } });
  await mk({ email: 'owner@cp.local', fullName: 'Owner', role: 'CUSTOMER_OWNER' });
  await mk({ email: 'manager@cp.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', branchId: branchA1.id });
  await mk({ email: 'cashier@cp.local', fullName: 'Cashier A1', role: 'CASHIER', branchId: branchA1.id });
  await mk({ email: 'captain@cp.local', fullName: 'Captain A1', role: 'CAPTAIN', branchId: branchA1.id });
  await mk({ email: 'captain2@cp.local', fullName: 'Captain A2', role: 'CAPTAIN', branchId: branchA2.id });
  await prisma.posUser.create({
    data: {
      email: 'atc@cp.local',
      fullName: 'ATC Operator',
      role: 'POS_SUPER_ADMIN',
      companyId: null,
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  tokens.owner = await login('owner@cp.local');
  tokens.manager = await login('manager@cp.local');
  tokens.cashier = await login('cashier@cp.local');
  tokens.captain = await login('captain@cp.local');
  tokens.captain2 = await login('captain2@cp.local');
  tokens.atc = await login('atc@cp.local');

  const taxRate = await prisma.taxRate.create({
    data: { companyId: companyA.id, name: 'GST5', ratePercent: '5.000' },
  });
  const category = await prisma.category.create({
    data: { companyId: companyA.id, name: 'Mains', sortOrder: 1 },
  });
  const product = await prisma.product.create({
    data: { companyId: companyA.id, categoryId: category.id, name: 'Biryani', basePrice: '200.00', taxRateId: taxRate.id },
  });
  const second = await prisma.product.create({
    data: { companyId: companyA.id, categoryId: category.id, name: 'Dal', basePrice: '120.00', taxRateId: taxRate.id },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, name: 'Full', price: '300.00' },
  });
  menu = { product, second, variant };
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('the order-taking journey, over HTTP', () => {
  let orderId;

  it('opens a dine-in order on a table with one line', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashier))
      .send({
        type: 'DINE_IN',
        tableId: tableA1.id,
        items: [{ productId: menu.product.id, variantId: menu.variant.id, qty: 1 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    orderId = res.body.order.id;
    expect(res.body.order.status).toBe('OPEN');
    expect(res.body.order.items).toHaveLength(1);
    // The client never sends a price. This is the server's, from the catalog.
    expect(Number(res.body.order.items[0].unitPrice)).toBe(300);
  });

  it('adds a second line, changes a quantity, and removes one again', async () => {
    const added = await request(app)
      .post(`/api/orders/${orderId}/items`)
      .set(auth(tokens.cashier))
      .send({ productId: menu.second.id, qty: 1 });
    expect(added.status, JSON.stringify(added.body)).toBe(200);

    const line = added.body.order.items.find((i) => i.name.includes('Dal'));
    const bumped = await request(app)
      .patch(`/api/orders/${orderId}/items/${line.id}`)
      .set(auth(tokens.cashier))
      .send({ qty: 3 });
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
    expect(bumped.body.order.items.find((i) => i.id === line.id).qty).toBe(3);

    const removed = await request(app)
      .delete(`/api/orders/${orderId}/items/${line.id}`)
      .set(auth(tokens.cashier));
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const active = removed.body.order.items.filter((i) => i.status === 'ACTIVE');
    expect(active).toHaveLength(1);
  });

  it('sends the KOT, and every line it sent now carries its number', async () => {
    const res = await request(app).post(`/api/orders/${orderId}/kot`).set(auth(tokens.cashier)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.kot.seq).toBeGreaterThan(0);

    const after = await request(app).get(`/api/orders/${orderId}`).set(auth(tokens.cashier));
    const active = after.body.order.items.filter((i) => i.status === 'ACTIVE');
    expect(active.length).toBeGreaterThan(0);
    for (const line of active) expect(line.kotSeq).toBe(res.body.kot.seq);
  });

  it('refuses a second KOT when nothing new has been added, and cuts no ticket', async () => {
    // The captain's Send button is disabled when no line is unsent. This is the
    // server saying the same thing, which is what makes the button a hint and
    // not the rule.
    const before = await prisma.kot.count();
    const res = await request(app).post(`/api/orders/${orderId}/kot`).set(auth(tokens.cashier)).send({});
    expect(res.status).toBe(409);
    expect(await prisma.kot.count()).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe('a captain is refused on every order-taking route, and nothing is written', () => {
  // WINDOW-5-BACKEND-REQUEST.md §1. `operate` in api/routes/orders.js is
  // requireRole('CUSTOMER_OWNER','BRANCH_MANAGER','CASHIER') — the role whose
  // whole job this is was left out, so ROLE_ACTIONS.CAPTAIN's order.create is
  // unreachable. This block is the evidence, and it is expected to be DELETED
  // and replaced by its opposite when the request lands.
  let existing;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashier))
      .send({ type: 'DINE_IN', tableId: tableA1b.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(res.status).toBe(201);
    existing = res.body.order;
  });

  it('403 on POST /orders, with no order row created', async () => {
    const before = await records();
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain))
      .send({ type: 'DINE_IN', tableId: tableA1.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await records()).toEqual(before);
  });

  it('403 on adding, changing and removing a line, with the order untouched', async () => {
    const before = await records();
    const lineId = existing.items[0].id;

    const add = await request(app)
      .post(`/api/orders/${existing.id}/items`)
      .set(auth(tokens.captain))
      .send({ productId: menu.second.id, qty: 1 });
    const patch = await request(app)
      .patch(`/api/orders/${existing.id}/items/${lineId}`)
      .set(auth(tokens.captain))
      .send({ qty: 9 });
    const del = await request(app)
      .delete(`/api/orders/${existing.id}/items/${lineId}`)
      .set(auth(tokens.captain));

    expect([add.status, patch.status, del.status]).toEqual([403, 403, 403]);
    expect(await records()).toEqual(before);
    const line = await prisma.orderItem.findUnique({ where: { id: lineId } });
    expect(line.qty).toBe(1);
    expect(line.status).toBe('ACTIVE');
  });

  it('403 on POST /kot, with no ticket cut', async () => {
    const before = await records();
    const res = await request(app)
      .post(`/api/orders/${existing.id}/kot`)
      .set(auth(tokens.captain))
      .send({});
    expect(res.status).toBe(403);
    expect(await records()).toEqual(before);
  });

  it('but CAN read — the order, the tickets and the floor are open to the role', async () => {
    // Which is why the captain's screen can reconcile a write whose reply was
    // lost: reading back is the one thing the role has always been able to do.
    const order = await request(app).get(`/api/orders/${existing.id}`).set(auth(tokens.captain));
    const kots = await request(app).get(`/api/orders/${existing.id}/kots`).set(auth(tokens.captain));
    const floors = await request(app).get('/api/floors').set(auth(tokens.captain));
    expect([order.status, kots.status, floors.status]).toEqual([200, 200, 200]);
  });
});

// ---------------------------------------------------------------------------

describe('money, voids and other stores: refused, and no business record moves', () => {
  let order;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashier))
      .send({ type: 'DINE_IN', tableId: tableA2.id, branchId: branchA2.id, items: [{ productId: menu.product.id, qty: 1 }] })
      .then((r) => (r.status === 201 ? r : request(app)
        .post('/api/orders')
        .set(auth(tokens.owner))
        .send({ type: 'DINE_IN', tableId: tableA2.id, branchId: branchA2.id, items: [{ productId: menu.product.id, qty: 1 }] })));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    order = res.body.order;
  });

  it('a captain cannot raise a bill, apply a discount or record a payment', async () => {
    const before = await records();
    const bill = await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.captain)).send({});
    const disc = await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.captain))
      .send({ type: 'PERCENT', value: 10, reason: 'friend of the house' });
    const pay = await request(app)
      .post(`/api/orders/${order.id}/payments`)
      .set(auth(tokens.captain))
      .send({ method: 'CASH', amount: 100 });

    expect([bill.status, disc.status, pay.status]).toEqual([403, 403, 403]);
    expect(await records()).toEqual(before);
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe('OPEN');
  });

  it('a CASHIER holds order.item.void in its baseline and is still refused the route', async () => {
    // WINDOW-5-BACKEND-REQUEST.md §3. lib/permissions.js:319 grants CASHIER
    // [...SELL, 'order.item.void']; orders.js:678 gates the route managerUp.
    // The permission screen advertises an authority that cannot be exercised.
    const { baselineAllows } = await import('../src/lib/permissions.js');
    expect(baselineAllows('CASHIER', 'order.item.void')).toBe(true);
    expect(baselineAllows('CAPTAIN', 'order.item.void')).toBe(true);

    const before = await records();
    const lineId = order.items[0].id;
    const res = await request(app)
      .post(`/api/orders/${order.id}/items/${lineId}/void`)
      .set(auth(tokens.cashier))
      .send({ reason: 'sent back by the table' });
    expect(res.status).toBe(403);
    expect(await records()).toEqual(before);
    expect((await prisma.orderItem.findUnique({ where: { id: lineId } })).status).toBe('ACTIVE');
  });

  it('a manager pinned to Alpha One cannot touch an Alpha Two order', async () => {
    const before = await records();
    const read = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.manager));
    const write = await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set(auth(tokens.manager))
      .send({ productId: menu.second.id, qty: 1 });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(await records()).toEqual(before);
  });

  it('an ATC operator is read-only inside a tenant: 403 on every order write', async () => {
    // orders.js states this in its own header. POS_SUPER_ADMIN's baseline is
    // every action key, so the ONLY thing holding this fence is the explicit
    // requireRole list — which is why §1 asks for requireAction *behind*
    // requireRole rather than instead of it.
    const before = await records();
    const scope = { ...auth(tokens.atc), 'x-pos-company': companyA.id };
    const create = await request(app)
      .post('/api/orders')
      .set(scope)
      .send({ type: 'DINE_IN', tableId: tableA1.id, items: [{ productId: menu.product.id, qty: 1 }] });
    const kot = await request(app).post(`/api/orders/${order.id}/kot`).set(scope).send({});
    expect(create.status).toBe(403);
    expect(kot.status).toBe(403);
    expect(await records()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

describe('a reply that never arrives', () => {
  // The screen cannot tell a request that failed from one that succeeded with a
  // lost reply. These tests establish which of the two recoveries is safe.
  let tableForLoss;

  beforeAll(async () => {
    tableForLoss = await prisma.diningTable.create({
      data: { branchId: branchA1.id, name: 'T9', capacity: 2 },
    });
  });

  it('a resent POST /orders cannot open a second order: the TABLE is the idempotency key', async () => {
    // Order carries no idempotencyKey column, so the first guess was that an
    // identical resend would duplicate. It cannot, for DINE_IN: orders.js
    // refuses a table that already holds an OPEN or BILLED order. The table
    // occupancy rule is doing idempotency's job for the captain's whole
    // workload, which is why WINDOW-5-BACKEND-REQUEST.md §4 is scoped to the
    // writes that genuinely lack it rather than to order creation.
    const body = {
      type: 'DINE_IN',
      tableId: tableForLoss.id,
      items: [{ productId: menu.product.id, qty: 1 }],
    };
    const first = await request(app).post('/api/orders').set(auth(tokens.cashier)).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await request(app).post('/api/orders').set(auth(tokens.cashier)).send(body);
    expect(second.status, JSON.stringify(second.body)).toBe(409);

    const onTable = await prisma.order.count({
      where: { tableId: tableForLoss.id, status: { in: ['OPEN', 'BILLED'] } },
    });
    expect(onTable).toBe(1);
  });

  it('a resent add-line silently DOUBLES the quantity — the one write that still needs a key', async () => {
    // The honest scope of §4, and the reason it is not "no harm done": the
    // route merges an identical line into the existing one, so a resend does
    // not appear as a suspicious second row a captain might spot. It appears
    // as 2 Dal, which is indistinguishable from a guest who asked for two.
    // Nothing in the request says "this is the same request", and the server
    // is right not to guess — so the screen must not resend, and after a lost
    // reply it re-reads instead.
    const state = await stateOf(tableForLoss.id);
    const line = { productId: menu.second.id, qty: 1 };
    const a = await request(app).post(`/api/orders/${state.orderId}/items`).set(auth(tokens.cashier)).send(line);
    const b = await request(app).post(`/api/orders/${state.orderId}/items`).set(auth(tokens.cashier)).send(line);
    expect([a.status, b.status]).toEqual([200, 200]);

    const dal = b.body.order.items.filter((i) => i.name.includes('Dal') && i.status === 'ACTIVE');
    expect(dal).toHaveLength(1);
    expect(dal[0].qty).toBe(2);

    await request(app).delete(`/api/orders/${state.orderId}/items/${dal[0].id}`).set(auth(tokens.cashier));
  });

  it('reconciling instead finds the one order that exists, by asking the table', async () => {
    // What Captain.jsx does when a POST /orders reply is lost: the id it never
    // received is recoverable because the TABLE knows which order is open on it.
    const state = await stateOf(tableForLoss.id);
    expect(state.orderId).toBeTruthy();
    const order = await prisma.order.findUnique({ where: { id: state.orderId } });
    expect(order.tableId).toBe(tableForLoss.id);
    expect(await prisma.order.count({ where: { tableId: tableForLoss.id, status: 'OPEN' } })).toBe(1);
  });

  it('a lost KOT reply cannot cut a second ticket, because the retry is refused', async () => {
    // The KOT route is naturally safe under retry: it sends the lines that have
    // not been sent, and after the first call there are none. So §4 matters for
    // order and item creation, and not for this one.
    const state = await stateOf(tableForLoss.id);
    const first = await request(app).post(`/api/orders/${state.orderId}/kot`).set(auth(tokens.cashier)).send({});
    expect(first.status).toBe(201);
    const kotsAfterFirst = await prisma.kot.count({ where: { orderId: state.orderId } });

    const retry = await request(app).post(`/api/orders/${state.orderId}/kot`).set(auth(tokens.cashier)).send({});
    expect(retry.status).toBe(409);
    expect(await prisma.kot.count({ where: { orderId: state.orderId } })).toBe(kotsAfterFirst);
    expect(kotsAfterFirst).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('what a table is doing: every state, and the two that must not merge', () => {
  let t;

  const freshTable = async (name) => {
    const row = await prisma.diningTable.create({
      data: { branchId: branchA1.id, name, capacity: 4 },
    });
    return row;
  };

  it('FREE is the absence of everything, and is the only state with no evidence', async () => {
    t = await freshTable('S1');
    const s = await stateOf(t.id);
    expect(s.state).toBe('FREE');
    expect(s.orderId).toBe(null);
    expect(s.visitId).toBe(null);
    expect(s.amountDue).toBe(null);
  });

  it('a scan does not create an order or change the state', async () => {
    // The §6 promise, checked here from the state side: an open visit with no
    // order is SEATED, which is the same thing staff seating a party produces.
    // Nothing about a scan is distinguishable, by construction.
    await openVisit(t.id, branchA1.id, '1111');
    const s = await stateOf(t.id);
    expect(s.state).toBe('SEATED');
    expect(s.orderId).toBe(null);
    expect(s.visitId).toBeTruthy();
  });

  it('lines that no kitchen has seen are still SEATED, not IN_KITCHEN', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashier))
      .send({ type: 'DINE_IN', tableId: t.id, items: [{ productId: menu.product.id, qty: 2 }] });
    expect(res.status).toBe(201);
    const s = await stateOf(t.id);
    expect(s.state).toBe('SEATED');
    expect(s.orderId).toBe(res.body.order.id);
    expect(Number(s.amountDue)).toBeGreaterThan(0);
  });

  it('a submitted basket is ORDERING — the kitchen has not been told', async () => {
    const s0 = await stateOf(t.id);
    const visit = await prisma.diningVisit.findFirst({ where: { tableId: t.id, status: 'OPEN' } });
    // Issued through the real endpoint: a hand-written row would prove nothing
    // about the card a restaurant actually gets.
    const issued = await request(app)
      .post('/api/table-qr/issue')
      .set(auth(tokens.owner))
      .send({ tableId: t.id });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const qr = await prisma.tableQrCode.findFirst({ where: { tableId: t.id, status: 'ACTIVE' } });
    expect(qr).toBeTruthy();
    await prisma.qrSubmission.create({
      data: {
        companyId: companyA.id,
        branchId: branchA1.id,
        tableId: t.id,
        qrCodeId: qr.id,
        visitId: visit.id,
        orderId: s0.orderId,
        status: 'SUBMITTED',
        idempotencyKey: 'captain-state-key-1',
        requestHash: 'h'.repeat(16),
        lineCount: 1,
        payload: { lines: [{ name: 'Biryani', qty: 1 }] },
      },
    });
    const s = await stateOf(t.id);
    expect(s.state).toBe('ORDERING');
    expect(s.awaitingStaff).toBe(1);
    // And no ticket exists for it.
    expect(await prisma.kot.count({ where: { orderId: s.orderId } })).toBe(0);

    await prisma.qrSubmission.deleteMany({ where: { tableId: t.id } });
  });

  it('a KOT with no station configured reads SERVED, not IN_KITCHEN', async () => {
    // Documented behaviour in lib/qr/tableState.js, and worth pinning: a line
    // no station ever received cannot be "unserved", so zero-station setups do
    // not strand every table in IN_KITCHEN forever. It also means a floor plan
    // in such a restaurant never shows IN_KITCHEN at all — which is honest, not
    // a defect, and is why the next test configures a station first.
    const s0 = await stateOf(t.id);
    expect(await prisma.kitchenStation.count({ where: { branchId: branchA1.id } })).toBe(0);
    const res = await request(app).post(`/api/orders/${s0.orderId}/kot`).set(auth(tokens.cashier)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await stateOf(t.id)).state).toBe('SERVED');
  });

  it('with a station configured, a fresh KOT routes and the table is IN_KITCHEN', async () => {
    await prisma.kitchenStation.create({
      data: { companyId: companyA.id, branchId: branchA1.id, name: 'Hot kitchen' },
    });
    const s0 = await stateOf(t.id);
    // A new line, so there is something unsent for the ticket to carry.
    const added = await request(app)
      .post(`/api/orders/${s0.orderId}/items`)
      .set(auth(tokens.cashier))
      .send({ productId: menu.second.id, qty: 1 });
    expect(added.status, JSON.stringify(added.body)).toBe(200);

    const res = await request(app).post(`/api/orders/${s0.orderId}/kot`).set(auth(tokens.cashier)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Routed by the server, not inserted by the test.
    const routed = await prisma.kitchenItem.findMany({ where: { orderId: s0.orderId } });
    expect(routed.length).toBeGreaterThan(0);
    expect((await stateOf(t.id)).state).toBe('IN_KITCHEN');
  });

  it('READY is not SERVED: food on the pass leaves the table IN_KITCHEN', async () => {
    // The distinction the requirement names. A station marking an item READY
    // means it is cooked, not that anybody carried it to the table — and a
    // floor plan that turned green here would tell a manager the party had
    // been looked after when nobody had walked over yet.
    const s0 = await stateOf(t.id);
    await prisma.kitchenItem.updateMany({
      where: { orderId: s0.orderId },
      data: { state: 'READY' },
    });
    expect((await stateOf(t.id)).state).toBe('IN_KITCHEN');

    // One served and one still ready is still IN_KITCHEN: a server is owed
    // something, and the most advanced true thing must not win here.
    const kis = await prisma.kitchenItem.findMany({ where: { orderId: s0.orderId } });
    if (kis.length > 1) {
      await prisma.kitchenItem.update({ where: { id: kis[0].id }, data: { state: 'SERVED' } });
      expect((await stateOf(t.id)).state).toBe('IN_KITCHEN');
    }

    await prisma.kitchenItem.updateMany({
      where: { orderId: s0.orderId },
      data: { state: 'SERVED' },
    });
    expect((await stateOf(t.id)).state).toBe('SERVED');
  });

  it('BILLED is not PAID: a bill raised with money still owing stays BILLED', async () => {
    const s0 = await stateOf(t.id);
    const res = await request(app).post(`/api/orders/${s0.orderId}/bill`).set(auth(tokens.cashier)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = await stateOf(t.id);
    expect(s.state).toBe('BILLED');
    expect(Number(s.amountDue)).toBeGreaterThan(0);
  });

  it('PAID is not FREE: the money arrived and the table is still not available', async () => {
    // The other distinction the requirement names. Settling does not clear a
    // table — the party is still sitting there. A plan that freed the table on
    // payment would seat the next party on top of this one.
    const s0 = await stateOf(t.id);
    const due = Number(s0.amountDue);

    // A settled order leaves the OPEN/BILLED include entirely, so the ONLY
    // evidence left for PAID is the order hanging off the visit. The guest-QR
    // path is what normally attaches it (lib/qr/visits.js); nothing in
    // orders.js does. Attached here so this test measures tableStateOf and not
    // the gap, which the next test measures on its own.
    const visit = await prisma.diningVisit.findFirst({ where: { tableId: t.id, status: 'OPEN' } });
    await prisma.order.update({ where: { id: s0.orderId }, data: { visitId: visit.id } });

    const pay = await request(app)
      .post(`/api/orders/${s0.orderId}/payments`)
      .set(auth(tokens.cashier))
      .send({ method: 'CASH', tendered: due });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);

    const s = await stateOf(t.id);
    expect(s.state).toBe('PAID');
    expect(s.state).not.toBe('FREE');
    expect(Number(s.amountDue)).toBe(0);
    // The visit is what says the party has not got up yet.
    expect(s.visitId).toBeTruthy();
  });

  it('GAP: with no visit, paying frees the table immediately', async () => {
    // WINDOW-5-BACKEND-REQUEST.md §7, for the visits owner. DiningVisit is
    // created in exactly one place — openOrJoinVisit in lib/qr/visits.js, which
    // needs a scanned card — and orders.js never sets Order.visitId. So on a
    // floor run from the handheld with no guest scans there is no visit, the
    // settled order drops out of the OPEN/BILLED include, and the table reads
    // FREE the instant the money lands. That is the hazard the requirement
    // names in as many words, and it is NOT a defect in tableStateOf: the
    // evidence it needs was never written. Recorded rather than fixed, because
    // visits belong to another window.
    const bare = await freshTable('S-NOVISIT');
    const created = await request(app)
      .post('/api/orders')
      .set(auth(tokens.cashier))
      .send({ type: 'DINE_IN', tableId: bare.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await prisma.diningVisit.count({ where: { tableId: bare.id } })).toBe(0);

    const billed = await request(app)
      .post(`/api/orders/${created.body.order.id}/bill`)
      .set(auth(tokens.cashier))
      .send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    expect((await stateOf(bare.id)).state).toBe('BILLED');

    const due = Number((await stateOf(bare.id)).amountDue);
    const pay = await request(app)
      .post(`/api/orders/${created.body.order.id}/payments`)
      .set(auth(tokens.cashier))
      .send({ method: 'CASH', tendered: due });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);

    // The documented intent is PAID. What actually happens today is FREE.
    expect((await stateOf(bare.id)).state).toBe('FREE');
  });

  it('and closing the visit — through the endpoint staff use — is what finally frees it', async () => {
    const visit = await prisma.diningVisit.findFirst({ where: { tableId: t.id, status: 'OPEN' } });
    const res = await request(app)
      .post(`/api/table-qr/visits/${visit.id}/close`)
      .set(auth(tokens.cashier))
      .send({ reason: 'party left' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const s = await stateOf(t.id);
    expect(s.state).toBe('FREE');
    expect(s.visitId).toBe(null);
  });

  it('refuses to derive a state from a partial read rather than answering FREE', async () => {
    // A missing include and an idle table both look like "no rows". Answering
    // FREE for the first would put a party on an occupied table.
    const bare = await prisma.diningTable.findUnique({ where: { id: t.id } });
    expect(() => tableStateOf(bare)).toThrow(/TABLE_STATE_INCLUDE/);
  });
});

// ---------------------------------------------------------------------------

describe('the floor layout carries the state, with its own evidence', () => {
  it('GET /floors/:id/layout reports a service state per table, readable by a captain', async () => {
    const floor = await request(app)
      .post('/api/floors')
      .set(auth(tokens.owner))
      .send({ name: 'Ground', branchId: branchA1.id });
    expect(floor.status).toBe(201);
    const area = await request(app)
      .post(`/api/floors/${floor.body.floor.id}/areas`)
      .set(auth(tokens.owner))
      .send({ name: 'Window Row', kind: 'INDOOR' });
    const draft = await request(app)
      .post(`/api/floors/${floor.body.floor.id}/draft`)
      .set(auth(tokens.owner))
      .send({});
    const saved = await request(app)
      .put(`/api/floors/${floor.body.floor.id}/draft`)
      .set(auth(tokens.owner))
      .send({
        revision: draft.body.layout.revision,
        tables: [
          { tableId: tableA1.id, areaId: area.body.area.id, shape: 'SQUARE', x: 20, y: 20, width: 80, height: 80, rotation: 0 },
        ],
        objects: [],
      });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const published = await request(app)
      .post(`/api/floors/${floor.body.floor.id}/draft/publish`)
      .set(auth(tokens.owner))
      .send({ revision: saved.body.layout.revision });
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const layout = await request(app)
      .get(`/api/floors/${floor.body.floor.id}/layout`)
      .set(auth(tokens.captain));
    expect(layout.status, JSON.stringify(layout.body)).toBe(200);
    const placed = layout.body.layout.tables.find((x) => x.tableId === tableA1.id);
    expect(placed).toBeTruthy();
    expect(placed.service).toBeTruthy();
    expect(placed.service.state).toBeTruthy();
    // occupied is the older boolean and is kept; the state is the finer answer
    // and the two must not contradict each other.
    expect(typeof placed.occupied).toBe('boolean');
  });
});
