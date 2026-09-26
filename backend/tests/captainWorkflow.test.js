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
// State of the three requests this file was written to record
// (WINDOW-5-BACKEND-REQUEST.md):
//
//   §1  FIXED. A CAPTAIN was refused on every order-taking route, so the role
//       could not do the job it is sold as doing. orders.js and tableQr.js now
//       gate on the ACTION (requireAction) instead of a hard-coded role list,
//       and the block that asserted the refusal has been replaced by its
//       opposite — the journey, asserted to succeed AND to write the row.
//       Two things came with it and are asserted here too: an ATC operator is
//       still refused (denyPlatformSelling, because POS_SUPER_ADMIN's baseline
//       is every action there is), and a captain reaches only the store its
//       scope names (branchInScope, because CAPTAIN is absent from auth.js's
//       BRANCH_PINNED_ROLES and the legacy pinning does not constrain it).
//   §3  OPEN, deliberately. order.item.void is in CASHIER's and CAPTAIN's
//       baselines and no route consults it; the route that voids a sent line is
//       manager-only. Wiring the action would GRANT a revenue-affecting
//       authority, so the mismatch is documented in docs/completion/
//       W3-CAPTAIN.md §2 and asserted below as it stands.
//   §4  OPEN. No idempotency key on the three order writes, so a retry
//       duplicates. Asserted below as a negative control — it is why the
//       captain's screen reconciles instead of retrying.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('captainWorkflow.test.js requires a DATABASE_URL ending in _test');
}

// Set BEFORE app.js is imported: config/env.js reads process.env at module load
// and app.js mounts the guest QR router only when a customer-facing origin is
// configured. tableQr.test.js:27 sets the same variable at its own top level —
// and vitest.config.js has fileParallelism:false, so every file shares one Node
// process. This file therefore passed inside a full-suite run and failed when
// run alone: no origin, no guest router, 501 instead of 201 on issuing a code.
// Measured on this file, 2026-09-26: 33/35 without the line, 35/35 with it
// (/tmp/w3-repro-noqrbase.log). Found by Window 1 on the PR head; the W3
// runners hid it because w3test.sh/w3gate.sh source a lane .env that exports
// POS_QR_BASE_URL, so no green run of mine could have caught it.
//
// `||`, not a bare assignment, for two reasons: it leaves a runner that sets its
// own origin alone, and gateway.test.js:724 deliberately CLEARS this variable
// inside a scoped withEnv — clobbering it here would break that file instead.
process.env.POS_QR_BASE_URL = process.env.POS_QR_BASE_URL || 'http://qr.test.local:5631';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { tableStateOf, TABLE_STATE_INCLUDE } = await import('../src/lib/qr/tableState.js');
// Dynamic like the four above, not a static `import`, so it loads AFTER the
// POS_QR_BASE_URL line: a static import is hoisted above it, and this helper
// pulls in src/lib/prisma.js, which is the same module graph app.js reads the
// environment through.
const { wipeAll } = await import('./helpers/inventory.js');

const app = createApp();
const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

// A hand-written delete list, which is what this was, cannot survive the suite.
// It has to name every model any SIBLING file might have left behind, in
// dependency order, and it silently rots every time another window adds a
// table. Twice now it has taken this whole file down, and each time the file
// still passed in isolation, which is the worst way for a test to break:
//
//   UserInvitation  — .createdById/.acceptedById are ON DELETE RESTRICT, so one
//                     invitation row from a sibling made posUser.deleteMany()
//                     throw. `cf9c4a0` added that line to 14 other suites; this
//                     file did not exist on main yet, so it was missed.
//   ModifierGroup   — ModifierGroup_productId_fkey, left by catalogModifiers,
//                     made product.deleteMany() throw. MEASURED on the pinned
//                     gate of d7108cf: the beforeAll threw at line 98 and vitest
//                     reported "35 tests | 35 skipped" — a green-looking file
//                     that asserted nothing. Reduced to a two-file repro
//                     (catalogModifiers + this file) in /tmp/w3-order-repro.log.
//
// So: truncate every table instead of listing some of them. `wipeAll()` is the
// helper the five inventory suites already use — one
// `truncate <139 tables> restart identity cascade`, which has no ordering to
// get wrong and cannot be outdated by a model added tomorrow. It costs seconds,
// and it is called twice in this file, not per test.
const wipe = wipeAll;

const tokens = {};
let companyA, branchA1, branchA2;
let tableA1, tableA1b, tableA2, tableCaptain;
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
  // One table per journey, at branchA1. The cashier journey above opens T1 and
  // never settles it, and a table may hold only ONE open order — so a captain
  // test aimed at T1 drew 409 POS_CONFLICT and read as "the captain is refused",
  // which is the precise misreading this file exists to prevent. The 409 was the
  // app behaving correctly about an occupied table and said nothing about the
  // role. Each block that opens an order gets its own table for that reason.
  tableCaptain = await prisma.diningTable.create({
    data: { branchId: branchA1.id, name: 'T3 captain journey', capacity: 4 },
  });

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

describe('the captain journey, end to end: store, table, order, guest basket, KOT', () => {
  // WINDOW-5-BACKEND-REQUEST.md §1, LANDED. `operate` in api/routes/orders.js
  // was requireRole('CUSTOMER_OWNER','BRANCH_MANAGER','CASHIER') — the role
  // whose whole job this is was left out, so ROLE_ACTIONS.CAPTAIN's
  // order.create was unreachable. The route now gates on the action, so this
  // block is the inverse of the one it replaces: the same five calls, each
  // asserted to SUCCEED and to have written the row.
  //
  // Read it as the server-side transcript of frontend/src/pages/Captain.jsx.
  // Every assertion here is a call that screen makes, in the order it makes it,
  // which is what lets a green run stand in for the journey rather than for a
  // build.
  let existing;
  let lineId;

  it('opens a dine-in order on its own table WITHOUT naming a branch', async () => {
    // The captain does not send branchId. A CAPTAIN is store-pinned
    // (permissions.js STORE_PINNED_ROLES), so storeScopeFor resolves the one
    // store on PosUser.branchId and the route takes it from the scope. This is
    // the "select an authorised store" half of the requirement: the captain
    // cannot pick the wrong one because the captain does not pick at all.
    const before = await records();
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain))
      .send({ type: 'DINE_IN', tableId: tableCaptain.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    existing = res.body.order;
    expect(existing.branchId).toBe(branchA1.id);

    // The row, not just the status. A 201 that wrote nothing is the mirror of
    // the 403-after-writing this file was built to catch.
    const row = await prisma.order.findUnique({ where: { id: existing.id } });
    expect(row).toBeTruthy();
    expect(row.branchId).toBe(branchA1.id);
    expect(row.status).toBe('OPEN');
    expect((await records()).orders).toBe(before.orders + 1);
  });

  it('adds, changes and removes draft lines', async () => {
    const add = await request(app)
      .post(`/api/orders/${existing.id}/items`)
      .set(auth(tokens.captain))
      .send({ productId: menu.second.id, qty: 1 });
    expect(add.status, JSON.stringify(add.body)).toBe(200);

    const dal = add.body.order.items.find((i) => i.productId === menu.second.id);
    expect(dal).toBeTruthy();

    const patch = await request(app)
      .patch(`/api/orders/${existing.id}/items/${dal.id}`)
      .set(auth(tokens.captain))
      .send({ qty: 3 });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await prisma.orderItem.findUnique({ where: { id: dal.id } })).qty).toBe(3);

    const del = await request(app)
      .delete(`/api/orders/${existing.id}/items/${dal.id}`)
      .set(auth(tokens.captain));
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    // An UNSENT line is removed outright — that is the counterpart route to the
    // void the captain may not use, and the whole reason the two are separate.
    expect(await prisma.orderItem.findUnique({ where: { id: dal.id } })).toBe(null);

    const fresh = await prisma.orderItem.findMany({ where: { orderId: existing.id } });
    expect(fresh.length).toBe(1);
    lineId = fresh[0].id;
  });

  it('sends the order to the kitchen, and the ticket exists', async () => {
    const before = await prisma.kot.count({ where: { orderId: existing.id } });
    const res = await request(app)
      .post(`/api/orders/${existing.id}/kot`)
      .set(auth(tokens.captain))
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await prisma.kot.count({ where: { orderId: existing.id } })).toBe(before + 1);
    // The line is now the kitchen's business, which is what makes the void
    // negative below meaningful rather than incidental.
    expect((await prisma.orderItem.findUnique({ where: { id: lineId } })).kotId).toBeTruthy();
  });

  it('accepts a guest QR basket, and the acceptance is what cuts the KOT', async () => {
    // "Accept a guest QR submission where policy permits." The staff half of
    // the guest flow is gated `canOperate` in tableQr.js, which is now
    // requireAction('order.create') — the same authority as taking the order by
    // hand, because it is the same act. The guest-side scan/join/submit path is
    // covered in tests/tableQr.test.js; the submission row here is built
    // directly so this test measures the gate and the acceptance, not the scan.
    const guestOrder = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain))
      .send({ type: 'DINE_IN', tableId: tableA1b.id, items: [{ productId: menu.product.id, qty: 2 }] });
    expect(guestOrder.status, JSON.stringify(guestOrder.body)).toBe(201);

    const visit = await openVisit(tableA1b.id, branchA1.id, '4242');
    const issued = await request(app)
      .post('/api/table-qr/issue')
      .set(auth(tokens.owner))
      .send({ tableId: tableA1b.id });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const qr = await prisma.tableQrCode.findFirst({
      where: { tableId: tableA1b.id, status: 'ACTIVE' },
    });
    expect(qr).toBeTruthy();

    const submission = await prisma.qrSubmission.create({
      data: {
        companyId: companyA.id,
        branchId: branchA1.id,
        tableId: tableA1b.id,
        qrCodeId: qr.id,
        visitId: visit.id,
        orderId: guestOrder.body.order.id,
        status: 'SUBMITTED',
        idempotencyKey: 'captain-accept-key-1',
        requestHash: 'a'.repeat(16),
        lineCount: 1,
        payload: { lines: [{ name: 'Biryani', qty: 2 }] },
      },
    });

    // Visible to the captain's inbox first — a screen cannot accept what it
    // cannot list.
    const inbox = await request(app)
      .get('/api/table-qr/submissions')
      .set(auth(tokens.captain));
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.submissions.map((s) => s.id)).toContain(submission.id);

    const kotsBefore = await prisma.kot.count({ where: { orderId: guestOrder.body.order.id } });
    expect(kotsBefore).toBe(0);

    const accepted = await request(app)
      .post(`/api/table-qr/submissions/${submission.id}/accept`)
      .set(auth(tokens.captain))
      .send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.kotId).toBeTruthy();
    expect(await prisma.kot.count({ where: { orderId: guestOrder.body.order.id } })).toBe(1);
    expect((await prisma.qrSubmission.findUnique({ where: { id: submission.id } })).status)
      .toBe('ACCEPTED');
  });

  it('and CAN read — the order, the tickets and the floor are open to the role', async () => {
    // Which is why the captain's screen can reconcile a write whose reply was
    // lost: reading back is the one thing the role has always been able to do.
    const order = await request(app).get(`/api/orders/${existing.id}`).set(auth(tokens.captain));
    const kots = await request(app).get(`/api/orders/${existing.id}/kots`).set(auth(tokens.captain));
    const floors = await request(app).get('/api/floors').set(auth(tokens.captain));
    expect([order.status, kots.status, floors.status]).toEqual([200, 200, 200]);
  });
});

// ---------------------------------------------------------------------------

describe('the action is not a passport: a captain reaches only its own store', () => {
  // Enabling the action without a scope check would have been the worse bug.
  // CAPTAIN is in permissions.js STORE_PINNED_ROLES but was NOT in auth.js
  // BRANCH_PINNED_ROLES, so branchIdFilterFor(captain) is `{}` — the legacy
  // pinning does not constrain this role at all. orders.js therefore checks
  // req.perm.scope itself (branchInScope), and this block is that check's
  // evidence. captain2 holds exactly the same actions as captain; only the
  // store differs.
  let alphaTwoOrder;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain2))
      .send({ type: 'DINE_IN', tableId: tableA2.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.order.branchId).toBe(branchA2.id);
    alphaTwoOrder = res.body.order;
  });

  it('cannot open an order at a store outside its scope, and writes nothing', async () => {
    const before = await records();
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain2))
      .send({
        type: 'DINE_IN',
        branchId: branchA1.id,
        tableId: tableA1.id,
        items: [{ productId: menu.product.id, qty: 1 }],
      });
    // 404, not 403: a store this principal may not see is a store that does not
    // exist as far as the answer is concerned, which is the same shape the
    // route already used for another tenant's branch.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await records()).toEqual(before);
  });

  it('cannot read or modify an order belonging to the other store', async () => {
    const before = await records();
    const read = await request(app)
      .get(`/api/orders/${alphaTwoOrder.id}`)
      .set(auth(tokens.captain));
    const write = await request(app)
      .post(`/api/orders/${alphaTwoOrder.id}/items`)
      .set(auth(tokens.captain))
      .send({ productId: menu.second.id, qty: 1 });
    const kot = await request(app)
      .post(`/api/orders/${alphaTwoOrder.id}/kot`)
      .set(auth(tokens.captain))
      .send({});
    expect([read.status, write.status, kot.status]).toEqual([404, 404, 404]);
    expect(await records()).toEqual(before);
  });

  it('and the QR inbox is scoped the same way, not just the order routes', async () => {
    // tableQr.js takes scopedBranchIdWhere(req) alongside the legacy
    // branchIdFilterFor in an explicit AND — two `where` objects each carrying
    // `branchId` would have had the second silently overwrite the first.
    const mine = await request(app).get('/api/table-qr/submissions').set(auth(tokens.captain2));
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const foreign = mine.body.submissions.filter((s) => s.tableId === tableA1b.id);
    expect(foreign).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('money, voids and other stores: refused, and no business record moves', () => {
  let order;
  let tableForMoney, tableForVoid, tableForeign;

  beforeAll(async () => {
    // Two tables in the captain's OWN store, so the money refusals below are
    // measured with the scope correct and the action the only thing left.
    tableForMoney = await prisma.diningTable.create({
      data: { branchId: branchA1.id, name: 'M1', capacity: 2 },
    });
    tableForVoid = await prisma.diningTable.create({
      data: { branchId: branchA1.id, name: 'M2', capacity: 2 },
    });
    // And a THIRD, in the other store, for the cross-store refusals. It used to
    // reuse tableA2, which the "not a passport" block above seats and leaves
    // open — so this beforeAll drew 409 POS_CONFLICT and took the whole describe
    // down with it. One table per opener; occupancy is not what is under test.
    tableForeign = await prisma.diningTable.create({
      data: { branchId: branchA2.id, name: 'M3 other store', capacity: 2 },
    });

    // The OWNER opens it, named outright. This was a cashier attempt with an
    // owner fallback chained behind it, which is worse than it looks: the
    // cashier is pinned to Alpha One and can never open at Alpha Two, so the
    // first call was always dead and the row's real author was whichever arm
    // happened to answer 201. A fixture whose principal is decided by a race is
    // not a fixture. A CUSTOMER_OWNER is company-wide, so it is the correct and
    // only principal here.
    const res = await request(app)
      .post('/api/orders')
      .set(auth(tokens.owner))
      .send({
        type: 'DINE_IN',
        tableId: tableForeign.id,
        branchId: branchA2.id,
        items: [{ productId: menu.product.id, qty: 1 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    order = res.body.order;
    expect(order.branchId).toBe(branchA2.id);
  });

  it('a captain cannot raise a bill, apply a discount or record a payment', async () => {
    // IN ITS OWN STORE, deliberately. Run against the Alpha Two order these
    // would now answer 404 on scope and prove nothing about authority — the
    // captain would be refused for the wrong reason. Here the scope is right,
    // the licence is usable, the order is the captain's own, and the ONLY thing
    // refusing is the action.
    const mine = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain))
      .send({ type: 'DINE_IN', tableId: tableForMoney.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    const mineId = mine.body.order.id;

    const before = await records();
    const bill = await request(app).post(`/api/orders/${mineId}/bill`).set(auth(tokens.captain)).send({});
    const disc = await request(app)
      .post(`/api/orders/${mineId}/discount`)
      .set(auth(tokens.captain))
      .send({ type: 'PERCENT', value: 10, reason: 'friend of the house' });
    const pay = await request(app)
      .post(`/api/orders/${mineId}/payments`)
      .set(auth(tokens.captain))
      .send({ method: 'CASH', amount: 100 });
    const refund = await request(app)
      .post(`/api/orders/${mineId}/refunds`)
      .set(auth(tokens.captain))
      .send({ amount: 50, reason: 'guest unhappy with the biryani' });

    expect([bill.status, pay.status, refund.status], JSON.stringify({
      bill: bill.body, pay: pay.body, refund: refund.body,
    })).toEqual([403, 403, 403]);
    // The discount route is gated order.create, which the captain HOLDS, so it
    // gets PAST the gate — and is refused by the money engine instead. The error
    // CODE is the evidence for which of the two refused: POS_DISCOUNT_NOT_
    // PERMITTED comes from guardDiscountChange, and ROLE_FLOOR[CAPTAIN] being
    // undefined is why (lib/discountPolicy.js resolves an unlisted role to
    // DENY). That is deliberate, not an oversight: discount authority is not an
    // action key, it is a money ceiling a tenant grants per user.
    expect(disc.status, JSON.stringify(disc.body)).toBe(403);
    expect(disc.body.error.code).toBe('POS_DISCOUNT_NOT_PERMITTED');
    expect(await records()).toEqual(before);
    const fresh = await prisma.order.findUnique({ where: { id: mineId } });
    expect(fresh.status).toBe('OPEN');
    expect(Number(fresh.discountAmount ?? 0)).toBe(0);
  });

  it('a captain cannot void a line the kitchen has already been told about', async () => {
    // The distinction the whole void argument turns on. An UNSENT line the
    // captain removes outright (proved in the journey block); a SENT one is the
    // kitchen's business and is manager-only. order.item.void sits in CAPTAIN's
    // baseline and no route consults it — see docs/completion/W3-CAPTAIN.md §2.
    const opened = await request(app)
      .post('/api/orders')
      .set(auth(tokens.captain))
      .send({ type: 'DINE_IN', tableId: tableForVoid.id, items: [{ productId: menu.product.id, qty: 1 }] });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const sent = await request(app)
      .post(`/api/orders/${opened.body.order.id}/kot`)
      .set(auth(tokens.captain))
      .send({});
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const lineId = opened.body.order.items[0].id;
    const line = await prisma.orderItem.findUnique({ where: { id: lineId } });
    expect(line.kotId, 'the line must be SENT for this test to mean anything').toBeTruthy();

    const before = await records();
    const voided = await request(app)
      .post(`/api/orders/${opened.body.order.id}/items/${lineId}/void`)
      .set(auth(tokens.captain))
      .send({ reason: 'sent back by the table' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(403);
    // And the DELETE that works on a draft line does not become a back door.
    const deleted = await request(app)
      .delete(`/api/orders/${opened.body.order.id}/items/${lineId}`)
      .set(auth(tokens.captain));
    expect([400, 409]).toContain(deleted.status);
    expect(await records()).toEqual(before);
    expect((await prisma.orderItem.findUnique({ where: { id: lineId } })).status).toBe('ACTIVE');
  });

  it('and no ALLOW rule can grant the money actions: the role ceiling is hard', async () => {
    // "Unless that action is explicitly authorised" — this is what authorising
    // would have to get past. can() consults baselineAllows BEFORE any
    // PermissionRule row, so a COMPANY-level ALLOW on order.bill is inert for a
    // CAPTAIN. Granting a captain the till is a ROLE change or a different
    // login, never a toggle on the permissions screen. Asserted here so nobody
    // ships that toggle believing it does something.
    const { baselineAllows, can } = await import('../src/lib/permissions.js');
    for (const action of ['order.bill', 'payment.record', 'refund.issue', 'order.void']) {
      expect(baselineAllows('CAPTAIN', action), action).toBe(false);
      const withAllow = new Map([[action, { effect: 'ALLOW' }]]);
      expect(can({ role: 'CAPTAIN', resolved: withAllow }, action), `ALLOW on ${action}`).toBe(false);
    }
    // The discount engine says the same thing from the money side: a role absent
    // from ROLE_FLOOR resolves to DENY, so the captain's authority is zero until
    // a tenant writes them a DiscountPolicy row on purpose.
    const { ROLE_FLOOR } = await import('../src/lib/discountPolicy.js');
    expect(ROLE_FLOOR.CAPTAIN).toBeUndefined();
  });

  it('a CASHIER holds order.item.void in its baseline and is still refused the route', async () => {
    // WINDOW-5-BACKEND-REQUEST.md §3, and docs/completion/W3-CAPTAIN.md §2.
    // lib/permissions.js grants CASHIER [...SELL, 'order.item.void']; the
    // void-a-sent-line route is gated managerUp. The permission screen
    // advertises an authority that cannot be exercised — left standing on
    // purpose, because closing the gap by wiring the action would hand every
    // cashier and captain a revenue-affecting power nobody asked for.
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
    // The trap in §1, and the reason the fix is not a straight swap.
    // POS_SUPER_ADMIN's baseline is [...ACTION_KEYS] — every action there is —
    // and order.create / order.bill / payment.record are not in
    // SUPPORT_GRANT_REQUIRED. So requireAction ALONE would have handed a
    // platform operator a working till, which the old role list refused only by
    // never naming the role. middleware/rbac.js denyPlatformSelling states the
    // rule instead of leaving it to an omission, and this test is its evidence.
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
