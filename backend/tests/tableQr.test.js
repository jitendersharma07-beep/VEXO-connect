// Table QR generation, mapping and guest ordering (TQ-3/TQ-4).
//
// This file is the verification matrix, not a smoke test. Every `it` below is
// one of the claims the workstream has to be able to demonstrate, and several of
// them are negative controls: they invert a guard and assert the REASON for the
// refusal, because a test that only asserts "not 200" passes just as happily
// when the refusal comes from a typo in the URL.
//
// The QR symbols are checked by decoding them with tests/fixtures/qrDecoder.js,
// which shares no code with src/lib/qr — so a matching answer is two independent
// implementations agreeing, not one implementation agreeing with itself.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('tableQr.test.js requires a DATABASE_URL ending in _test');
}

// Set BEFORE app.js is imported: config/env.js reads process.env at module load
// and app.js only mounts the guest router when a customer-facing origin is
// configured. Stating it here rather than in the runner keeps the test honest
// about the contract it depends on.
const BASE = 'http://qr.test.local:5631';
process.env.POS_QR_BASE_URL = BASE;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { decodePng } = await import('./fixtures/qrDecoder.js');
const { parsePdf, textsOf, gridsOf } = await import('./fixtures/pdfProbe.js');
const { decodeMatrix } = await import('./fixtures/qrDecoder.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const guestHdr = (t) => ({ 'X-Guest-Token': t });

const wipeFloorplan = async () => {
  await prisma.floorLayoutTable.deleteMany();
  await prisma.floorLayoutObject.deleteMany();
  await prisma.floorLayout.deleteMany();
  await prisma.diningArea.deleteMany();
  await prisma.floor.deleteMany();
};

const wipe = async () => {
  await wipeFloorplan();
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  // Every QR foreign key is ON DELETE RESTRICT, deliberately: an order placed on
  // a card keeps pointing at the card, the visit and the submission that produced
  // it, which is the §7 promise to preserve history. So the teardown runs in
  // dependency order, and the two references between Order and QrSubmission point
  // opposite ways — a line names its submission, a submission names its order —
  // which is why these four deletes are interleaved with the order deletes rather
  // than grouped.
  await prisma.qrSubmission.deleteMany();
  await prisma.order.deleteMany();
  await prisma.diningVisitGuest.deleteMany();
  await prisma.diningVisit.deleteMany();
  await prisma.tableQrCode.deleteMany();
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

const tokens = {};
let companyA, companyB, branchA1, branchA2, branchB1;
// "T1" exists in all three stores. The whole point: one printed label, three
// different tables, and a card must resolve to its own.
const tbl = {};
let menuA, menuB;
let floorA1;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

/** A minimal orderable menu: one taxed product with a variant and a topping. */
const seedMenu = async (companyId, label) => {
  const taxRate = await prisma.taxRate.create({
    data: { companyId, name: `GST5-${label}`, ratePercent: '5.000' },
  });
  const category = await prisma.category.create({
    data: { companyId, name: `Mains ${label}`, sortOrder: 1 },
  });
  const product = await prisma.product.create({
    data: {
      companyId,
      categoryId: category.id,
      name: `Biryani ${label}`,
      basePrice: '200.00',
      taxRateId: taxRate.id,
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, name: 'Full', price: '300.00' },
  });
  const group = await prisma.modifierGroup.create({
    data: { productId: product.id, name: 'Extras', minSelect: 0, maxSelect: 2 },
  });
  const option = await prisma.modifierOption.create({
    data: { groupId: group.id, name: 'Extra raita', price: '40.00' },
  });
  const archived = await prisma.product.create({
    data: {
      companyId,
      categoryId: category.id,
      name: `Discontinued ${label}`,
      basePrice: '99.00',
      status: 'ARCHIVED',
    },
  });
  return { taxRate, category, product, variant, group, option, archived };
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Diner',
      slug: 'alpha-qr',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Bistro',
      slug: 'bravo-qr',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });

  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-QR-0001', name: 'Alpha One', code: 'A1', city: 'Delhi' },
  });
  branchA2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-QR-0002', name: 'Alpha Two', code: 'A2', city: 'Jaipur' },
  });
  branchB1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-QR-0003', name: 'Bravo One', code: 'B1', city: 'Pune' },
  });

  // The same human-readable label in three different stores.
  tbl.a1 = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T1', capacity: 4 } });
  tbl.a1b = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T2', capacity: 2 } });
  tbl.a2 = await prisma.diningTable.create({ data: { branchId: branchA2.id, name: 'T1', capacity: 4 } });
  tbl.b1 = await prisma.diningTable.create({ data: { branchId: branchB1.id, name: 'T1', capacity: 4 } });

  await prisma.posUser.create({
    data: { email: 'owner.a@qr.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id, passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'manager.a1@qr.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id, passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'cashier.a1@qr.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id, passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'owner.b@qr.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id, passwordHash },
  });

  tokens.ownerA = await login('owner.a@qr.local');
  tokens.managerA1 = await login('manager.a1@qr.local');
  tokens.cashierA1 = await login('cashier.a1@qr.local');
  tokens.ownerB = await login('owner.b@qr.local');

  menuA = await seedMenu(companyA.id, 'A');
  menuB = await seedMenu(companyB.id, 'B');

  // A published layout, so a card can be printed with a real floor/section line.
  const floor = await request(app)
    .post('/api/floors')
    .set(auth(tokens.ownerA))
    .send({ name: 'Ground Floor', branchId: branchA1.id });
  expect(floor.status, JSON.stringify(floor.body)).toBe(201);
  floorA1 = floor.body.floor.id;
  const area = await request(app)
    .post(`/api/floors/${floorA1}/areas`)
    .set(auth(tokens.ownerA))
    .send({ name: 'Window Row', kind: 'INDOOR' });
  expect(area.status).toBe(201);
  const draft = await request(app).post(`/api/floors/${floorA1}/draft`).set(auth(tokens.ownerA)).send({});
  expect(draft.status).toBe(201);
  const save = await request(app)
    .put(`/api/floors/${floorA1}/draft`)
    .set(auth(tokens.ownerA))
    .send({
      revision: draft.body.layout.revision,
      tables: [
        { tableId: tbl.a1.id, areaId: area.body.area.id, shape: 'SQUARE', x: 20, y: 20, width: 80, height: 80, rotation: 0 },
        { tableId: tbl.a1b.id, areaId: area.body.area.id, shape: 'SQUARE', x: 140, y: 20, width: 80, height: 80, rotation: 0 },
      ],
      objects: [],
    });
  expect(save.status, JSON.stringify(save.body)).toBe(200);
  const pub = await request(app)
    .post(`/api/floors/${floorA1}/draft/publish`)
    .set(auth(tokens.ownerA))
    .send({ revision: save.body.layout.revision });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

// --------------------------------------------------------------------------
// Issuing, and the label collision the requirement names explicitly
// --------------------------------------------------------------------------

const issue = async (token, body) =>
  request(app).post('/api/table-qr/issue').set(auth(token)).send(body);

// Every card the call touched, minted or already live. The route keeps the two
// apart on purpose ("issued 4 of 6" is what an operator needs to read), so a
// test that only wants "the card for this table" says so here once.
const cardsIn = (res) => [...(res.body.issued ?? []), ...(res.body.skipped ?? [])];

const cards = {};

describe('issuing cards', () => {
  it('issues one card per table and refuses to mint a second for the same table', async () => {
    const first = await issue(tokens.ownerA, { tableIds: [tbl.a1.id] });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.issued).toHaveLength(1);
    expect(first.body.summary).toEqual({ requested: 1, issued: 1, skipped: 0 });
    cards.a1 = first.body.issued[0];
    expect(cards.a1.rotation).toBe(1);
    expect(cards.a1.url.startsWith(`${BASE}/t/`)).toBe(true);

    // Without regenerate the second call is a no-op, not a second live card:
    // two live cards for one table is the thing the unique activeTableId
    // column exists to make impossible. 200, not 201 — nothing was created.
    const again = await issue(tokens.ownerA, { tableIds: [tbl.a1.id] });
    expect(again.status).toBe(200);
    expect(again.body.issued).toHaveLength(0);
    expect(again.body.skipped[0].id).toBe(cards.a1.id);
    expect(await prisma.tableQrCode.count({ where: { tableId: tbl.a1.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('prints the store, floor and section the card will claim', async () => {
    const card = await prisma.tableQrCode.findUnique({ where: { id: cards.a1.id } });
    expect(card.printedPlace).toBe('Ground Floor · Window Row');
  });

  it('the same table label in different stores gets different cards that resolve to their own store', async () => {
    const a2 = await issue(tokens.ownerA, { tableIds: [tbl.a2.id] });
    expect(a2.status).toBe(201);
    cards.a2 = a2.body.issued[0];
    const b1 = await issue(tokens.ownerB, { tableIds: [tbl.b1.id] });
    expect(b1.status).toBe(201);
    cards.b1 = b1.body.issued[0];

    expect(new Set([cards.a1.url, cards.a2.url, cards.b1.url]).size).toBe(3);

    // The label is identical in all three. Only the resolved store differs.
    const seen = [];
    for (const c of [cards.a1, cards.a2, cards.b1]) {
      const token = c.url.split('/t/')[1];
      const res = await request(app).get(`/api/guest/qr/t/${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.store.tableName).toBe('T1');
      seen.push(res.body.store.name);
    }
    expect(seen).toEqual(['Alpha One', 'Alpha Two', 'Bravo One']);
  });

  it('a guest is served the menu of the card’s own tenant and no other', async () => {
    const aRes = await request(app).get(`/api/guest/qr/t/${cards.a1.url.split('/t/')[1]}`);
    const bRes = await request(app).get(`/api/guest/qr/t/${cards.b1.url.split('/t/')[1]}`);
    const namesOf = (r) => r.body.menu.categories.flatMap((c) => c.products.map((p) => p.name));
    expect(namesOf(aRes)).toContain('Biryani A');
    expect(namesOf(aRes)).not.toContain('Biryani B');
    expect(namesOf(bRes)).toContain('Biryani B');
    expect(namesOf(bRes)).not.toContain('Biryani A');
  });

  it('the menu hides archived products, because submitting one would be refused', async () => {
    const res = await request(app).get(`/api/guest/qr/t/${cards.a1.url.split('/t/')[1]}`);
    const names = res.body.menu.categories.flatMap((c) => c.products.map((p) => p.name));
    expect(names).not.toContain('Discontinued A');
    // And it says what "availability" can honestly mean here rather than
    // implying a per-store stock system this schema does not have.
    expect(res.body.menu.availability).toBe('MENU_STATUS_ONLY');
  });

  it('a cashier cannot mint or revoke a card', async () => {
    const mint = await issue(tokens.cashierA1, { tableIds: [tbl.a1b.id] });
    expect(mint.status).toBe(403);
    const revoke = await request(app)
      .post(`/api/table-qr/${cards.a1.id}/revoke`)
      .set(auth(tokens.cashierA1))
      .send({ reason: 'nope' });
    expect(revoke.status).toBe(403);
  });

  it('bulk export issues for a whole store in one call', async () => {
    // No tableIds: the whole store. T1 already has a live card and is skipped,
    // T2 is minted — and the summary says which was which.
    const res = await issue(tokens.ownerA, { branchId: branchA1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary).toEqual({ requested: 2, issued: 1, skipped: 1 });
    const ids = cardsIn(res).map((c) => c.tableId).sort();
    expect(ids).toEqual([tbl.a1.id, tbl.a1b.id].sort());
    expect(res.body.skipped[0].id).toBe(cards.a1.id);
    cards.a1b = res.body.issued.find((c) => c.tableId === tbl.a1b.id);
    expect(cards.a1b).toBeTruthy();
  });
});

// --------------------------------------------------------------------------
// Refusals. Each one asserts the REASON, not merely that it failed.
// --------------------------------------------------------------------------

describe('invalid, revoked and cross-store requests', () => {
  it('an unknown token is refused with POS_QR_NOT_USABLE', async () => {
    const res = await request(app).get('/api/guest/qr/t/not-a-real-token-at-all');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('POS_QR_NOT_USABLE');
  });

  it('a revoked card stops resolving, and its replacement works', async () => {
    const issued = await issue(tokens.ownerA, { tableIds: [tbl.a2.id], regenerate: true });
    expect(issued.status).toBe(201);
    const fresh = issued.body.issued[0];
    expect(fresh.rotation).toBe(2);

    // The old token is dead …
    const old = await request(app).get(`/api/guest/qr/t/${cards.a2.url.split('/t/')[1]}`);
    expect(old.status).toBe(404);
    expect(old.body.error.code).toBe('POS_QR_NOT_USABLE');
    // … and the new one points at the same table.
    const now = await request(app).get(`/api/guest/qr/t/${fresh.url.split('/t/')[1]}`);
    expect(now.status).toBe(200);
    expect(now.body.store.name).toBe('Alpha Two');

    // Rotation lineage is recorded, so an order taken on the dead card can
    // still be traced forward to the card now on the table.
    const dead = await prisma.tableQrCode.findFirst({ where: { id: cards.a2.id } });
    expect(dead.status).toBe('REVOKED');
    expect(dead.replacedById).toBe(fresh.id);
    expect(dead.activeTableId).toBeNull();
    cards.a2 = fresh;
  });

  it('an explicit revoke also kills the token', async () => {
    const made = await issue(tokens.ownerB, { tableIds: [tbl.b1.id], regenerate: true });
    const victim = made.body.issued[0];
    const res = await request(app)
      .post(`/api/table-qr/${victim.id}/revoke`)
      .set(auth(tokens.ownerB))
      .send({ reason: 'card damaged' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await request(app).get(`/api/guest/qr/t/${victim.url.split('/t/')[1]}`);
    expect(after.status).toBe(404);
    expect(after.body.error.code).toBe('POS_QR_NOT_USABLE');
  });

  it('another tenant cannot see, print or revoke a card — and gets 404, never 403', async () => {
    // 403 would confirm the row exists. 404 is indistinguishable from absent.
    const png = await request(app).get(`/api/table-qr/${cards.a1.id}/png`).set(auth(tokens.ownerB));
    expect(png.status).toBe(404);
    const revoke = await request(app)
      .post(`/api/table-qr/${cards.a1.id}/revoke`)
      .set(auth(tokens.ownerB))
      .send({ reason: 'not mine' });
    expect(revoke.status).toBe(404);
  });

  it('a caller cannot issue for another tenant’s table', async () => {
    const res = await issue(tokens.ownerB, { tableIds: [tbl.a1.id] });
    expect(res.status).toBe(404);
  });

  it('a caller cannot name a base URL, a host or a company', async () => {
    // Offered every override an attacker would want. The printed URL must come
    // from configuration alone.
    const res = await issue(tokens.ownerA, {
      tableIds: [tbl.a1b.id],
      regenerate: true,
      baseUrl: 'https://evil.example',
      host: 'evil.example',
      companyId: companyB.id,
      branchId: branchB1.id,
    });
    expect(res.status).toBe(201);
    for (const c of cardsIn(res)) {
      expect(c.url.startsWith(`${BASE}/t/`)).toBe(true);
      expect(c.url).not.toContain('evil.example');
    }
    const row = await prisma.tableQrCode.findUnique({ where: { id: res.body.issued[0].id } });
    expect(row.companyId).toBe(companyA.id);
    // The branchId override was ignored too: the card belongs to the table's own
    // store, not the one the body asked for.
    expect(row.branchId).toBe(branchA1.id);
    cards.a1b = res.body.issued[0];
  });

  it('a retired table’s card stops resolving', async () => {
    const t = await prisma.diningTable.create({ data: { branchId: branchA1.id, name: 'T9', capacity: 2 } });
    const made = await issue(tokens.ownerA, { tableIds: [t.id] });
    const token = made.body.issued[0].url.split('/t/')[1];
    expect((await request(app).get(`/api/guest/qr/t/${token}`)).status).toBe(200);

    await prisma.diningTable.update({ where: { id: t.id }, data: { status: 'RETIRED' } });
    const after = await request(app).get(`/api/guest/qr/t/${token}`);
    expect(after.status).toBe(404);
    expect(after.body.error.code).toBe('POS_QR_NOT_USABLE');

    // Order history survives deactivation: the card row and its table are still
    // there to be reported on, not deleted.
    expect(await prisma.tableQrCode.count({ where: { tableId: t.id } })).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Visits: sharing, joining, and isolation between parties
// --------------------------------------------------------------------------

const tokenOf = (card) => card.url.split('/t/')[1];

describe('table visits', () => {
  let host, second;

  it('a scan writes nothing at all — no visit, no guest, no order', async () => {
    const before = {
      visits: await prisma.diningVisit.count(),
      guests: await prisma.diningVisitGuest.count(),
      orders: await prisma.order.count(),
    };
    const res = await request(app).get(`/api/guest/qr/t/${tokenOf(cards.a1)}`);
    expect(res.status).toBe(200);
    expect({
      visits: await prisma.diningVisit.count(),
      guests: await prisma.diningVisitGuest.count(),
      orders: await prisma.order.count(),
    }).toEqual(before);
    expect(res.body.table.occupied).toBe(false);
  });

  it('the first phone opens the visit and is given the join code', async () => {
    const res = await request(app).post(`/api/guest/qr/t/${tokenOf(cards.a1)}/session`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    host = res.body;
    expect(host.guestToken).toBeTruthy();
    expect(host.visit.guest.isHost).toBe(true);
    expect(host.visit.joinCode).toMatch(/^\d{4}$/);
    expect(host.store.tableName).toBe('T1');
    expect(host.store.place).toBe('Ground Floor · Window Row');
  });

  it('the plaintext guest token is never stored', async () => {
    const rows = await prisma.diningVisitGuest.findMany();
    for (const g of rows) expect(g.tokenHash).not.toBe(host.guestToken);
    expect(await prisma.diningVisitGuest.count({ where: { tokenHash: host.guestToken } })).toBe(0);
  });

  it('a guest row holds no personal data at all', async () => {
    const g = await prisma.diningVisitGuest.findFirst({ where: { isHost: true } });
    // If a name, phone or email column is ever added, this fails and the
    // privacy claim gets re-decided deliberately instead of by accident.
    expect(Object.keys(g).sort()).toEqual(
      ['createdAt', 'id', 'isHost', 'lastSeenAt', 'seq', 'tokenHash', 'visitId'].sort(),
    );
  });

  it('a second phone is refused without the code, and the refusal names the reason', async () => {
    const res = await request(app).post(`/api/guest/qr/t/${tokenOf(cards.a1)}/session`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_QR_JOIN_CODE_REQUIRED');
    // Merely asking must not spend an attempt, or one honest guest could lock
    // the table out for the rest of the party.
    const v = await prisma.diningVisit.findFirst({ where: { openTableId: tbl.a1.id } });
    expect(v.joinAttempts).toBe(0);
  });

  it('a wrong code is refused and IS counted, even though the request fails', async () => {
    const wrong = String((Number(host.visit.joinCode) + 1) % 10000).padStart(4, '0');
    const res = await request(app)
      .post(`/api/guest/qr/t/${tokenOf(cards.a1)}/session`)
      .send({ joinCode: wrong });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_QR_JOIN_CODE_WRONG');
    // The negative control that matters: if the counter were incremented on the
    // transaction that then throws, it would roll back and a guesser would get
    // unlimited free attempts at a four-digit code.
    const v = await prisma.diningVisit.findFirst({ where: { openTableId: tbl.a1.id } });
    expect(v.joinAttempts).toBe(1);
  });

  it('the right code joins the party and shares the basket', async () => {
    const res = await request(app)
      .post(`/api/guest/qr/t/${tokenOf(cards.a1)}/session`)
      .send({ joinCode: host.visit.joinCode });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    second = res.body;
    expect(second.visit.guest.seq).toBe(2);
    expect(second.visit.guest.isHost).toBe(false);
    // A joiner is not handed the code to pass on again.
    expect(second.visit.joinCode).toBeNull();
    expect(second.visit.visitId).toBe(host.visit.visitId);
  });

  it('guessing is capped for the life of the visit', async () => {
    const v = await prisma.diningVisit.findFirst({ where: { openTableId: tbl.a1.id } });
    await prisma.diningVisit.update({ where: { id: v.id }, data: { joinAttempts: 10 } });
    const res = await request(app)
      .post(`/api/guest/qr/t/${tokenOf(cards.a1)}/session`)
      .send({ joinCode: '0000' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_QR_JOIN_LOCKED');
    await prisma.diningVisit.update({ where: { id: v.id }, data: { joinAttempts: 1 } });
  });

  it('a guest token from one table cannot be replayed at another', async () => {
    const res = await request(app)
      .get(`/api/guest/qr/t/${tokenOf(cards.a1b)}/order`)
      .set(guestHdr(host.guestToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_QR_SESSION_OVER');
  });

  it('no guest token means no read of the table’s order', async () => {
    const res = await request(app).get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('POS_QR_GUEST_REQUIRED');
  });

  it('a forged guest token is refused', async () => {
    const res = await request(app)
      .get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`)
      .set(guestHdr('a'.repeat(43)));
    expect(res.status).toBe(401);
  });

  // The party's state is carried into the ordering block below.
  it('exposes the host and joiner for the ordering tests', () => {
    expect(host.guestToken && second.guestToken).toBeTruthy();
    party.host = host;
    party.second = second;
  });
});

const party = {};

// --------------------------------------------------------------------------
// Submitting, idempotency, and the gap between "sent" and "accepted"
// --------------------------------------------------------------------------

const submit = (card, guestToken, body) =>
  request(app).post(`/api/guest/qr/t/${tokenOf(card)}/order`).set(guestHdr(guestToken)).send(body);

describe('guest submissions', () => {
  let firstSubmission;

  it('a submission creates the order but cuts NO KOT', async () => {
    const res = await submit(cards.a1, party.host.guestToken, {
      idempotencyKey: 'sub-key-0001',
      items: [{ productId: menuA.product.id, variantId: menuA.variant.id, qty: 2, modifierOptionIds: [menuA.option.id] }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    firstSubmission = res.body.submission;
    expect(firstSubmission.status).toBe('SUBMITTED');

    const order = await prisma.order.findFirst({
      where: { visitId: party.host.visit.visitId },
      include: { items: true, kots: true },
    });
    expect(order.source).toBe('QR');
    expect(order.tableId).toBe(tbl.a1.id);
    expect(order.branchId).toBe(branchA1.id);
    expect(order.companyId).toBe(companyA.id);
    // The §6 promise, asserted: the kitchen has not been told.
    expect(order.kots).toHaveLength(0);
    expect(order.items.every((i) => i.kotId === null)).toBe(true);
    expect(await prisma.kitchenItem.count({ where: { orderId: order.id } })).toBe(0);
    party.orderId = order.id;
  });

  it('prices come from the catalog, not from the phone', async () => {
    const order = await prisma.order.findUnique({
      where: { id: party.orderId },
      include: { items: true },
    });
    // 300.00 variant + 40.00 topping = 340.00 a unit, whatever the phone said.
    expect(Number(order.items[0].unitPrice)).toBe(340);
    expect(Number(order.subtotal)).toBe(680);
  });

  it('a price sent by the phone is ignored outright', async () => {
    const res = await submit(cards.a1, party.second.guestToken, {
      idempotencyKey: 'sub-key-price',
      items: [{ productId: menuA.product.id, qty: 1, unitPrice: '0.01', price: 0, basePrice: 0 }],
    });
    expect(res.status).toBe(201);
    const line = await prisma.orderItem.findFirst({
      where: { orderId: party.orderId, variantId: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(Number(line.unitPrice)).toBe(200);
  });

  it('a duplicate submission creates no second order and no second line', async () => {
    const body = {
      idempotencyKey: 'sub-key-0001',
      items: [{ productId: menuA.product.id, variantId: menuA.variant.id, qty: 2, modifierOptionIds: [menuA.option.id] }],
    };
    const before = {
      orders: await prisma.order.count(),
      items: await prisma.orderItem.count(),
      subs: await prisma.qrSubmission.count(),
    };
    const res = await submit(cards.a1, party.host.guestToken, body);
    // 200, not 201: this is the original answered again.
    expect(res.status).toBe(200);
    expect(res.body.submission.id).toBe(firstSubmission.id);
    expect({
      orders: await prisma.order.count(),
      items: await prisma.orderItem.count(),
      subs: await prisma.qrSubmission.count(),
    }).toEqual(before);
  });

  it('simultaneous duplicates settle to exactly one submission', async () => {
    const body = {
      idempotencyKey: 'sub-key-race',
      items: [{ productId: menuA.product.id, qty: 1 }],
    };
    const before = await prisma.order.count();
    const results = await Promise.all([
      submit(cards.a1, party.host.guestToken, body),
      submit(cards.a1, party.host.guestToken, body),
      submit(cards.a1, party.host.guestToken, body),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.submission.id)).size).toBe(1);
    expect(await prisma.qrSubmission.count({ where: { idempotencyKey: 'sub-key-race' } })).toBe(1);
    expect(await prisma.order.count()).toBe(before);
  });

  it('two phones sending first at the same instant still produce ONE bill', async () => {
    // Different keys, so idempotency cannot save this: these are two genuinely
    // different baskets arriving together on a visit that has no order yet. The
    // shared-order policy says the party gets one bill, and a plain
    // find-then-create both finds nothing and creates two at READ COMMITTED.
    const t3 = await prisma.diningTable.create({
      data: { branchId: branchA1.id, name: 'T3', capacity: 4 },
    });
    const card = (await issue(tokens.ownerA, { tableIds: [t3.id] })).body.issued[0];
    const one = await request(app).post(`/api/guest/qr/t/${tokenOf(card)}/session`).send({});
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await request(app)
      .post(`/api/guest/qr/t/${tokenOf(card)}/session`)
      .send({ joinCode: one.body.visit.joinCode });
    expect(two.status, JSON.stringify(two.body)).toBe(200);

    const results = await Promise.all([
      submit(card, one.body.guestToken, {
        idempotencyKey: 'sub-key-t3-host',
        items: [{ productId: menuA.product.id, qty: 1 }],
      }),
      submit(card, two.body.guestToken, {
        idempotencyKey: 'sub-key-t3-joiner',
        items: [{ productId: menuA.product.id, variantId: menuA.variant.id, qty: 1 }],
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const orders = await prisma.order.findMany({ where: { visitId: one.body.visit.visitId } });
    expect(orders).toHaveLength(1);
    // Both baskets landed on it, so nothing was lost to make that true.
    expect(await prisma.orderItem.count({ where: { orderId: orders[0].id } })).toBe(2);
  });

  it('the same key with a different basket is refused, not answered with the wrong order', async () => {
    const res = await submit(cards.a1, party.host.guestToken, {
      idempotencyKey: 'sub-key-0001',
      items: [{ productId: menuA.product.id, qty: 9 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_QR_KEY_REUSED');
  });

  it('a guest cannot order another tenant’s product', async () => {
    const res = await submit(cards.a1, party.host.guestToken, {
      idempotencyKey: 'sub-key-cross',
      items: [{ productId: menuB.product.id, qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('a guest cannot order an archived product', async () => {
    const res = await submit(cards.a1, party.host.guestToken, {
      idempotencyKey: 'sub-key-archived',
      items: [{ productId: menuA.archived.id, qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('both phones see the shared basket, and each knows which lines are its own', async () => {
    const hostView = await request(app)
      .get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`)
      .set(guestHdr(party.host.guestToken));
    expect(hostView.status).toBe(200);
    const secondView = await request(app)
      .get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`)
      .set(guestHdr(party.second.guestToken));
    expect(secondView.status).toBe(200);

    // Same shared bill …
    expect(hostView.body.order.total).toBe(secondView.body.order.total);
    expect(hostView.body.order.lines.length).toBe(secondView.body.order.lines.length);
    // … opposite ownership, and nothing identifying anybody.
    const hostMine = hostView.body.order.lines.filter((l) => l.mine).length;
    const secondMine = secondView.body.order.lines.filter((l) => l.mine).length;
    expect(hostMine).toBeGreaterThan(0);
    expect(secondMine).toBeGreaterThan(0);
    expect(hostMine).not.toBe(hostView.body.order.lines.length);
    for (const l of hostView.body.order.lines) expect(l.by).toMatch(/^(Guest \d+|Staff)$/);
    // Nothing is in the kitchen yet, and the phone is told so.
    expect(hostView.body.order.lines.every((l) => l.sentToKitchen === false)).toBe(true);
    expect(hostView.body.awaitingStaff).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// Acceptance: where the kitchen finally hears about it
// --------------------------------------------------------------------------

describe('staff acceptance', () => {
  let stationId;

  beforeAll(async () => {
    const st = await request(app)
      .post('/api/kitchen/stations')
      .set(auth(tokens.ownerA))
      .send({ branchId: branchA1.id, name: 'Hot kitchen' });
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    stationId = st.body.station.id;
    const rt = await request(app)
      .post('/api/kitchen/routes')
      .set(auth(tokens.ownerA))
      .send({ branchId: branchA1.id, stationId, categoryId: menuA.category.id });
    expect(rt.status, JSON.stringify(rt.body)).toBe(201);
  });

  it('a pending submission is visible to staff at the right table', async () => {
    const res = await request(app).get('/api/table-qr/submissions').set(auth(tokens.cashierA1));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mine = res.body.submissions.filter((s) => s.tableId === tbl.a1.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].tableName).toBe('T1');
    expect(mine[0].lines.length).toBeGreaterThan(0);
    party.pending = res.body.submissions.filter((s) => s.status === 'SUBMITTED').map((s) => s.id);
  });

  it('accepting cuts exactly one KOT and routes it to the station', async () => {
    const id = party.pending[0];
    const res = await request(app)
      .post(`/api/table-qr/submissions/${id}/accept`)
      .set(auth(tokens.cashierA1))
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.kotId).toBeTruthy();

    const kots = await prisma.kot.findMany({ where: { orderId: party.orderId } });
    expect(kots).toHaveLength(1);
    // Routed by the till's own routeKotItems, so a QR order reaches the same
    // stations by the same rules.
    const ki = await prisma.kitchenItem.findMany({ where: { orderId: party.orderId } });
    expect(ki.length).toBeGreaterThan(0);
    expect(ki.every((k) => k.stationId === stationId)).toBe(true);
  });

  it('accepting twice is refused and cuts no second KOT', async () => {
    const id = party.pending[0];
    const res = await request(app)
      .post(`/api/table-qr/submissions/${id}/accept`)
      .set(auth(tokens.cashierA1))
      .send({});
    expect(res.status).toBe(409);
    expect(await prisma.kot.count({ where: { orderId: party.orderId } })).toBe(1);
  });

  it('two cashiers accepting at the same instant cut one KOT between them', async () => {
    // A submission of its own, sent after the last acceptance, so its lines are
    // genuinely unsent. Racing an older one would prove nothing: a KOT sends
    // everything unsent on the order, so the earlier acceptance already covered
    // those lines and "no second KOT" would be true for the wrong reason.
    const sent = await submit(cards.a1, party.host.guestToken, {
      idempotencyKey: 'sub-key-accept-race',
      items: [{ productId: menuA.product.id, qty: 1 }],
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const subId = sent.body.submission.id;
    const before = await prisma.kot.count({ where: { orderId: party.orderId } });

    const results = await Promise.all([
      request(app).post(`/api/table-qr/submissions/${subId}/accept`).set(auth(tokens.cashierA1)).send({}),
      request(app).post(`/api/table-qr/submissions/${subId}/accept`).set(auth(tokens.ownerA)).send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser.body.error.message).toMatch(/already decided|already accepted/i);
    // Exactly one new KOT. Two would mean the kitchen cooked the same thing
    // twice, which a SELECT-then-UPDATE guard permits at READ COMMITTED and a
    // guarded UPDATE does not.
    expect(await prisma.kot.count({ where: { orderId: party.orderId } })).toBe(before + 1);
    const winner = results.find((r) => r.status === 200);
    expect(winner.body.kotId).toBeTruthy();
  });

  it('a rejection voids that submission’s own lines and nothing else', async () => {
    const res = await submit(cards.a1, party.second.guestToken, {
      idempotencyKey: 'sub-key-reject',
      items: [{ productId: menuA.product.id, qty: 3 }],
    });
    expect(res.status).toBe(201);
    const subId = res.body.submission.id;
    const activeBefore = await prisma.orderItem.count({
      where: { orderId: party.orderId, status: 'ACTIVE' },
    });

    const rej = await request(app)
      .post(`/api/table-qr/submissions/${subId}/reject`)
      .set(auth(tokens.cashierA1))
      .send({ reason: 'Kitchen out of it' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.submission.status).toBe('REJECTED');
    expect(rej.body.submission.rejectedReason).toBe('Kitchen out of it');

    // Exactly the rejected submission's line went, and order history kept it.
    const mine = await prisma.orderItem.findMany({ where: { qrSubmissionId: subId } });
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('VOIDED');
    expect(mine[0].voidReason).toBe('Kitchen out of it');
    const activeAfter = await prisma.orderItem.count({
      where: { orderId: party.orderId, status: 'ACTIVE' },
    });
    expect(activeAfter).toBe(activeBefore - 1);
  });

  it('the guest is told what the kitchen now knows', async () => {
    // Every submission this party sent, decided. Draining the queue rather than
    // asserting a number is what makes `awaitingStaff === 0` mean "nothing is
    // waiting" instead of "I guessed the count right".
    for (;;) {
      const open = await prisma.qrSubmission.findFirst({
        where: { visitId: party.host.visit.visitId, status: 'SUBMITTED' },
      });
      if (!open) break;
      const res = await request(app)
        .post(`/api/table-qr/submissions/${open.id}/accept`)
        .set(auth(tokens.cashierA1))
        .send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    const view = await request(app)
      .get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`)
      .set(guestHdr(party.host.guestToken));
    expect(view.status).toBe(200);
    expect(view.body.order.lines.some((l) => l.sentToKitchen === true)).toBe(true);
    expect(view.body.awaitingStaff).toBe(0);
    // And now that nothing is undecided, every remaining line really is in a
    // kitchen — the state the floor plan will read as IN_KITCHEN.
    expect(view.body.order.lines.every((l) => l.sentToKitchen === true)).toBe(true);
  });

  it('a QR order appears at the correct POS table on the staff order list', async () => {
    const res = await request(app)
      .get('/api/orders')
      .query({ branchId: branchA1.id, status: 'OPEN' })
      .set(auth(tokens.cashierA1));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mine = res.body.orders.find((o) => o.id === party.orderId);
    expect(mine, 'the QR order should be on the till list').toBeTruthy();
    expect(mine.tableName).toBe('T1');
  });
});

// --------------------------------------------------------------------------
// The database's own refusals. These are the checks a route bug cannot bypass.
// --------------------------------------------------------------------------

describe('constraints that bite even if a route forgets', () => {
  it('an order marked QR without a card is refused by the database', async () => {
    // The probe that matters: run against a REAL order row, because an UPDATE
    // matching zero rows raises no error and proves nothing.
    const order = await prisma.order.findUnique({ where: { id: party.orderId } });
    expect(order, 'a real QR order must exist for this probe to mean anything').toBeTruthy();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Order" SET "qrCodeId" = NULL WHERE id = '${order.id}'`),
    ).rejects.toThrow(/Order_qr_needs_code/);

    // And the positive control: the row is untouched, so the refusal was the
    // constraint and not a connection that died.
    const after = await prisma.order.findUnique({ where: { id: party.orderId } });
    expect(after.qrCodeId).toBe(order.qrCodeId);
    expect(after.source).toBe('QR');
  });

  it('a TILL order carrying a card is refused too — the check binds both ways', async () => {
    const till = await prisma.order.create({
      data: { companyId: companyA.id, branchId: branchA1.id, type: 'TAKEAWAY', openedById: (await prisma.posUser.findFirst({ where: { email: 'cashier.a1@qr.local' } })).id },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Order" SET "qrCodeId" = '${cards.a1.id}' WHERE id = '${till.id}'`,
      ),
    ).rejects.toThrow(/Order_qr_needs_code/);
    await prisma.order.delete({ where: { id: till.id } });
  });

  it('two live cards for one table are impossible', async () => {
    const live = await prisma.tableQrCode.findFirst({
      where: { tableId: tbl.a1.id, status: 'ACTIVE' },
    });
    await expect(
      prisma.tableQrCode.create({
        data: {
          companyId: companyA.id,
          branchId: branchA1.id,
          tableId: tbl.a1.id,
          token: 'a-second-live-token-for-one-table',
          rotation: 99,
          activeTableId: tbl.a1.id,
          issuedById: live.issuedById,
        },
      }),
    ).rejects.toThrow();
  });

  it('a card cannot claim to be live for a table that is not its own', async () => {
    const live = await prisma.tableQrCode.findFirst({ where: { tableId: tbl.a1.id, status: 'ACTIVE' } });
    await expect(
      prisma.tableQrCode.create({
        data: {
          companyId: companyA.id,
          branchId: branchA1.id,
          tableId: tbl.a1b.id,
          token: 'a-card-pointing-at-someone-elses-table',
          rotation: 98,
          activeTableId: tbl.a1.id,
          issuedById: live.issuedById,
        },
      }),
    ).rejects.toThrow();
  });

  it('a card cannot reference a table in another store', async () => {
    const live = await prisma.tableQrCode.findFirst({ where: { tableId: tbl.a1.id, status: 'ACTIVE' } });
    // branchA1 with companyB's table: the composite foreign key refuses it, so a
    // cross-store card cannot be written even by a route that forgot to scope.
    await expect(
      prisma.tableQrCode.create({
        data: {
          companyId: companyA.id,
          branchId: branchA1.id,
          tableId: tbl.b1.id,
          token: 'a-cross-store-card',
          rotation: 97,
          issuedById: live.issuedById,
        },
      }),
    ).rejects.toThrow();
  });

  it('two open visits for one table are impossible', async () => {
    await expect(
      prisma.diningVisit.create({
        data: {
          companyId: companyA.id,
          branchId: branchA1.id,
          tableId: tbl.a1.id,
          openTableId: tbl.a1.id,
          joinCode: '1234',
        },
      }),
    ).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// Floor plan status, driven only by things that really happened
// --------------------------------------------------------------------------

const serviceOf = async (tableId) => {
  const res = await request(app)
    .get(`/api/floors/${floorA1}/layout`)
    .set(auth(tokens.managerA1));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const t = res.body.layout.tables.find((x) => x.tableId === tableId);
  return t.service;
};

describe('floor plan reflects real events', () => {
  it('an untouched table is FREE', async () => {
    expect((await serviceOf(tbl.a1b.id)).state).toBe('FREE');
  });

  it('scanning alone leaves the table FREE', async () => {
    const res = await request(app).get(`/api/guest/qr/t/${tokenOf(cards.a1b)}`);
    expect(res.status).toBe(200);
    expect((await serviceOf(tbl.a1b.id)).state).toBe('FREE');
  });

  it('starting a table order makes it SEATED, not ordered', async () => {
    const s = await request(app).post(`/api/guest/qr/t/${tokenOf(cards.a1b)}/session`).send({});
    expect(s.status).toBe(201);
    party.t2 = s.body;
    const st = await serviceOf(tbl.a1b.id);
    expect(st.state).toBe('SEATED');
    expect(st.guests).toBe(1);
  });

  it('a submitted-but-undecided basket is ORDERING', async () => {
    const res = await submit(cards.a1b, party.t2.guestToken, {
      idempotencyKey: 'sub-key-t2-a',
      items: [{ productId: menuA.product.id, qty: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    party.t2Submission = res.body.submission.id;
    const st = await serviceOf(tbl.a1b.id);
    // Not IN_KITCHEN: nobody has accepted it.
    expect(st.state).toBe('ORDERING');
    expect(st.awaitingStaff).toBe(1);
  });

  it('acceptance moves it to IN_KITCHEN', async () => {
    const res = await request(app)
      .post(`/api/table-qr/submissions/${party.t2Submission}/accept`)
      .set(auth(tokens.cashierA1))
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const st = await serviceOf(tbl.a1b.id);
    expect(st.state).toBe('IN_KITCHEN');
    expect(st.awaitingStaff).toBe(0);
  });

  it('SERVED comes from the kitchen saying so, not from the order existing', async () => {
    const items = await prisma.kitchenItem.findMany({
      where: { orderId: (await prisma.order.findFirst({ where: { tableId: tbl.a1b.id } })).id },
    });
    expect(items.length).toBeGreaterThan(0);
    for (const k of items) {
      for (const state of ['IN_PREP', 'READY', 'SERVED']) {
        const cur = await prisma.kitchenItem.findUnique({ where: { id: k.id } });
        const res = await request(app)
          .post(`/api/kitchen/items/${k.id}/state`)
          .set(auth(tokens.cashierA1))
          .send({ to: state, version: cur.version });
        expect(res.status, `${state}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    }
    expect((await serviceOf(tbl.a1b.id)).state).toBe('SERVED');
  });

  it('BILLED is the bill being raised, and PAID is money arriving', async () => {
    const order = await prisma.order.findFirst({ where: { tableId: tbl.a1b.id, status: 'OPEN' } });
    const bill = await request(app)
      .post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.cashierA1))
      .send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const billed = await serviceOf(tbl.a1b.id);
    expect(billed.state).toBe('BILLED');
    expect(billed.amountDue).toBeGreaterThan(0);

    const pay = await request(app)
      .post(`/api/orders/${order.id}/payments`)
      .set(auth(tokens.cashierA1))
      .send({ method: 'CASH', amount: billed.amountDue, idempotencyKey: 'pay-key-t2-0001' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const paid = await serviceOf(tbl.a1b.id);
    expect(paid.state).toBe('PAID');
    expect(paid.amountDue).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Closing a visit, and isolating the party that sits down next
// --------------------------------------------------------------------------

describe('visit isolation', () => {
  it('a visit with money owing cannot be closed', async () => {
    const visit = await prisma.diningVisit.findFirst({ where: { openTableId: tbl.a1.id } });
    const res = await request(app)
      .post(`/api/table-qr/visits/${visit.id}/close`)
      .set(auth(tokens.cashierA1))
      .send({ reason: 'party left' });
    expect(res.status).toBe(409);
  });

  it('settling then closing releases the table and keeps the card usable', async () => {
    const order = await prisma.order.findFirst({ where: { id: party.orderId } });
    const bill = await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.cashierA1)).send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const due = Number(bill.body.order.total);
    const pay = await request(app)
      .post(`/api/orders/${order.id}/payments`)
      .set(auth(tokens.cashierA1))
      .send({ method: 'CASH', amount: due, idempotencyKey: 'pay-key-t1-0001' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);

    const visit = await prisma.diningVisit.findFirst({ where: { openTableId: tbl.a1.id } });
    const res = await request(app)
      .post(`/api/table-qr/visits/${visit.id}/close`)
      .set(auth(tokens.cashierA1))
      .send({ reason: 'party left' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const closed = await prisma.diningVisit.findUnique({ where: { id: visit.id } });
    expect(closed.status).toBe('CLOSED');
    expect(closed.openTableId).toBeNull();
    expect(closed.closedAt).toBeTruthy();

    // The printed card is untouched — that is the point of the visit being a
    // separate row from the card.
    const card = await prisma.tableQrCode.findFirst({ where: { tableId: tbl.a1.id, status: 'ACTIVE' } });
    expect(card.id).toBe(cards.a1.id);
    const scan = await request(app).get(`/api/guest/qr/t/${tokenOf(cards.a1)}`);
    expect(scan.status).toBe(200);
    expect(scan.body.table.occupied).toBe(false);
  });

  it('the old party’s tokens stop working the moment the visit closes', async () => {
    for (const t of [party.host.guestToken, party.second.guestToken]) {
      const res = await request(app)
        .get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`)
        .set(guestHdr(t));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('POS_QR_SESSION_OVER');
    }
  });

  it('an old token cannot submit into the next party’s basket either', async () => {
    const res = await submit(cards.a1, party.host.guestToken, {
      idempotencyKey: 'sub-key-after-close',
      items: [{ productId: menuA.product.id, qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_QR_SESSION_OVER');
  });

  it('the next party gets a clean basket and never sees the last one’s order', async () => {
    const fresh = await request(app).post(`/api/guest/qr/t/${tokenOf(cards.a1)}/session`).send({});
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(fresh.body.visit.visitId).not.toBe(party.host.visit.visitId);
    expect(fresh.body.visit.guest.seq).toBe(1);
    expect(fresh.body.visit.joinCode).not.toBe(party.host.visit.joinCode);

    const view = await request(app)
      .get(`/api/guest/qr/t/${tokenOf(cards.a1)}/order`)
      .set(guestHdr(fresh.body.guestToken));
    expect(view.status).toBe(200);
    expect(view.body.order).toBeNull();
    expect(view.body.awaitingStaff).toBe(0);
  });

  it('the closed visit keeps its history — nothing was deleted to isolate it', async () => {
    const old = await prisma.diningVisit.findUnique({
      where: { id: party.host.visit.visitId },
      include: { guests: true, orders: true, submissions: true },
    });
    expect(old.guests.length).toBe(2);
    expect(old.orders.length).toBe(1);
    expect(old.submissions.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// The printed artefacts. Decoded, not eyeballed.
// --------------------------------------------------------------------------

describe('printed cards decode to the configured URL', () => {
  it('the PNG a manager downloads decodes to the card’s own URL', async () => {
    const res = await request(app)
      .get(`/api/table-qr/${cards.a1.id}/png`)
      .set(auth(tokens.managerA1))
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // A card is a credential printed on paper; a shared cache holding it would
    // hand the next reader an ordering URL.
    expect(res.headers['cache-control']).toBe('private, no-store');

    const decoded = decodePng(res.body).text;
    expect(decoded).toBe(cards.a1.url);
    expect(decoded.startsWith(`${BASE}/t/`)).toBe(true);
    // The negative control for the whole decode claim: the same reader must NOT
    // return this URL for a different card.
    const other = await request(app)
      .get(`/api/table-qr/${cards.a1b.id}/png`)
      .set(auth(tokens.managerA1))
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(decodePng(other.body).text).toBe(cards.a1b.url);
    expect(decodePng(other.body).text).not.toBe(cards.a1.url);
  });

  it('the print-ready PDF is structurally valid and every symbol on it decodes', async () => {
    const res = await request(app)
      .get('/api/table-qr/export.pdf')
      .query({ branchId: branchA1.id })
      .set(auth(tokens.managerA1))
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status, res.text?.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');

    // parsePdf follows startxref -> xref -> each object offset and throws if any
    // recorded byte offset does not land on that object's header, so a file that
    // merely opens in a forgiving reader still fails here.
    const pdf = parsePdf(res.body);
    expect(pdf.pages.length).toBeGreaterThan(0);

    // Live cards on tables that are still in service. A card for a RETIRED table
    // stays in the database — order history depends on it — but must not be
    // printed onto a sheet a manager is about to stick on furniture.
    const expected = new Set();
    for (const t of await prisma.tableQrCode.findMany({
      where: { branchId: branchA1.id, status: 'ACTIVE', table: { status: 'ACTIVE' } },
    })) {
      expected.add(`${BASE}/t/${t.token}`);
    }
    expect(expected.size).toBeGreaterThan(1);

    const decoded = [];
    for (const page of pdf.pages) {
      const texts = textsOf(page.content);
      expect(texts.some((t) => t.includes('Alpha One'))).toBe(true);
      for (const grid of gridsOf(page.content)) decoded.push(decodeMatrix(grid).text);
    }
    expect(decoded.length).toBe(expected.size);
    expect(new Set(decoded)).toEqual(expected);
    for (const url of decoded) expect(url.startsWith(`${BASE}/t/`)).toBe(true);
  });

  it('the card carries the store, the floor/section and the table label as text', async () => {
    const res = await request(app)
      .get('/api/table-qr/export.pdf')
      .query({ branchId: branchA1.id, layout: 'single' })
      .set(auth(tokens.managerA1))
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const pdf = parsePdf(res.body);
    const all = pdf.pages.flatMap((p) => textsOf(p.content));
    expect(all).toContain('Alpha One');
    expect(all).toContain('Ground Floor · Window Row');
    expect(all).toContain('T1');
  });

  it('prints the whole URL in the footer, never a truncated one', async () => {
    // The footer exists so a guest whose camera will not focus can type the
    // address, and so a card found loose can be traced back. Both need every
    // character: a URL with an ellipsis in it is not a URL. This is the
    // assertion a fixed character cap failed — BASE plus "/t/" plus a 32-
    // character token is 60, which is the length a real https origin has too.
    const res = await request(app)
      .get('/api/table-qr/export.pdf')
      .query({ branchId: branchA1.id })
      .set(auth(tokens.managerA1))
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const pdf = parsePdf(res.body);
    const all = pdf.pages.flatMap((p) => textsOf(p.content));
    const footers = all.filter((t) => t.startsWith(BASE));
    expect(footers.length).toBeGreaterThan(1);
    for (const line of footers) {
      expect(line).not.toContain('…');
      expect(line).toMatch(new RegExp(`^${BASE}/t/[\\w-]{32}$`));
    }
    // The rotation marker rides on the instruction line, and is what tells an
    // old card from its reprint by eye, so it must survive too.
    expect(all.some((t) => /^Scan to see the menu and order\s+·\s+v\d+$/.test(t))).toBe(true);
  });

  it('a moved table is reported as needing a reprint, not silently mislabelled', async () => {
    const before = await request(app)
      .get('/api/table-qr')
      .query({ branchId: branchA1.id })
      .set(auth(tokens.managerA1));
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const row = before.body.tables.find((t) => t.tableId === tbl.a1.id);
    expect(row.qr.placeStale).toBe(false);

    // Move the table to a new section and publish, exactly as a manager would.
    const area = await request(app)
      .post(`/api/floors/${floorA1}/areas`)
      .set(auth(tokens.ownerA))
      .send({ name: 'Terrace', kind: 'OUTDOOR' });
    expect(area.status).toBe(201);
    const draft = await request(app).post(`/api/floors/${floorA1}/draft`).set(auth(tokens.ownerA)).send({});
    expect(draft.status).toBe(201);
    const save = await request(app)
      .put(`/api/floors/${floorA1}/draft`)
      .set(auth(tokens.ownerA))
      .send({
        revision: draft.body.layout.revision,
        tables: draft.body.layout.tables.map((t) => ({
          tableId: t.tableId,
          areaId: t.tableId === tbl.a1.id ? area.body.area.id : t.areaId,
          shape: t.shape,
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
          rotation: t.rotation,
        })),
        objects: [],
      });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    const pub = await request(app)
      .post(`/api/floors/${floorA1}/draft/publish`)
      .set(auth(tokens.ownerA))
      .send({ revision: save.body.layout.revision });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);

    const after = await request(app)
      .get('/api/table-qr')
      .query({ branchId: branchA1.id })
      .set(auth(tokens.managerA1));
    const moved = after.body.tables.find((t) => t.tableId === tbl.a1.id);
    // The card still resolves to the right table — only the text is now wrong.
    expect(moved.qr.placeStale).toBe(true);
    expect(moved.qr.printedPlace).toBe('Ground Floor · Window Row');
    expect(moved.qr.currentPlace).toBe('Ground Floor · Terrace');
    const scan = await request(app).get(`/api/guest/qr/t/${tokenOf(cards.a1)}`);
    expect(scan.status).toBe(200);
    expect(scan.body.store.tableName).toBe('T1');
  });
});

// Re-imports the module graph under a temporarily altered environment.
// config/env.js reads process.env once at load, which is exactly what this has
// to defeat. The values captured at the top of this file — app, prisma — are
// already-created objects and are unaffected.
const withEnv = async (overrides, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
};

const bootWith = (overrides) => withEnv(overrides, () => import('../src/config/env.js'));

// Every test above takes POS_QR_BASE_URL on trust, because line 27 sets it to
// something that works. These tests are about the variable itself, which is the
// only thing standing between a deployment and a stack of printed cards pointing
// at a host no guest's phone can resolve. A card is printed once and glued to
// furniture, so the check runs at BOOT: the claim asserted is that importing
// config/env.js REJECTS, not that some route later answers 400.
//
// Note what this suite's own BASE is: http, on a .local host. It is precisely
// the kind of origin these tests prove a real deployment refuses.
describe('the origin printed on the card', () => {
  it('refuses to boot on plain http outside test and development', async () => {
    await expect(
      bootWith({ NODE_ENV: 'staging', POS_QR_BASE_URL: 'http://order.saffron.example' }),
    ).rejects.toThrow(/POS_QR_BASE_URL must be an https:\/\/ origin/);
  });

  it('refuses a host a guest on mobile data cannot reach', async () => {
    // https, so the protocol rule cannot be what refuses these — each has to be
    // caught for being unreachable. The addresses are the ones a hurried
    // deployment actually pastes: the dev default, and the LAN name of the
    // machine the console runs on.
    for (const host of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'pos.saffron.local']) {
      await expect(
        bootWith({ NODE_ENV: 'production', POS_QR_BASE_URL: `https://${host}:5631` }),
      ).rejects.toThrow(/is not reachable from a customer's phone/);
    }
  });

  it('refuses a base URL carrying a query string or fragment, in every environment', async () => {
    // qrUrlFor appends "/t/<token>", so a base with a query or a fragment
    // produces ".../?utm=x/t/abc" — a URL that resolves to the wrong thing, or
    // to nothing. Refused even in test and development, because the malformed
    // card is identical there and a developer scanning it would be chasing the
    // token, not the base.
    for (const nodeEnv of ['test', 'development', 'production']) {
      await expect(
        bootWith({ NODE_ENV: nodeEnv, POS_QR_BASE_URL: 'https://order.saffron.example/?src=qr' }),
      ).rejects.toThrow(/must not carry a query string or fragment/);
      await expect(
        bootWith({ NODE_ENV: nodeEnv, POS_QR_BASE_URL: 'https://order.saffron.example/#table' }),
      ).rejects.toThrow(/must not carry a query string or fragment/);
    }
  });

  it('refuses a value that is not a URL at all', async () => {
    await expect(
      bootWith({ NODE_ENV: 'production', POS_QR_BASE_URL: 'order.saffron.example' }),
    ).rejects.toThrow(/must be an absolute URL/);
  });

  // Positive control for all four refusals above: the rule is "https on a host
  // that resolves", not "always refuse". Without this, deleting the URL parsing
  // and throwing unconditionally would pass every test in this block.
  it('boots on an https origin at a public host, and prints exactly that', async () => {
    const url = await withEnv(
      { NODE_ENV: 'production', POS_QR_BASE_URL: 'https://order.saffron.example/' },
      async () => {
        const { qrOrderingEnabled } = await import('../src/config/env.js');
        expect(qrOrderingEnabled).toBe(true);
        const { qrUrlFor } = await import('../src/lib/qr/cards.js');
        return qrUrlFor('TOKEN123');
      },
    );
    // The trailing slash the operator typed is absorbed, not doubled.
    expect(url).toBe('https://order.saffron.example/t/TOKEN123');
  });

  it('still allows http on localhost in development, so a laptop can scan its own cards', async () => {
    const { qrOrderingEnabled } = await withEnv(
      { NODE_ENV: 'development', POS_QR_BASE_URL: 'http://127.0.0.1:5631' },
      () => import('../src/config/env.js'),
    );
    expect(qrOrderingEnabled).toBe(true);
  });

  it('exposes no guest endpoint at all when no origin is configured', async () => {
    await withEnv({ POS_QR_BASE_URL: undefined }, async () => {
      const { createApp: createBare } = await import('../src/app.js');
      const res = await request(createBare()).get('/api/guest/qr/t/anything');
      // Not 501 and not 404-from-the-handler: with no configured origin there is
      // no such route to probe, so an unconfigured deployment has no public
      // surface for a scanner to find.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('POS_NOT_FOUND');
    });
  });
});
