// VC-103 kitchen backend: KOT routing (product rule beats category rule
// beats default station), the forward-only state machine with distinct
// timestamps, cancellation attribution, version-based duplicate protection
// (a replayed decision converges, a stale one is a 409), sinceSeq reconnect
// recovery off the per-store cursor, derived whole-order readiness and the
// supervisor overview. Nothing here touches printers: kitchen state is
// software state; paper stays with the hardware checklist.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('kitchen.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const wipe = async () => {
  await prisma.printJob.deleteMany();
  await prisma.printTarget.deleteMany();
  await prisma.printAgent.deleteMany();
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.kitchenCursor.deleteMany();
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  // Integration wipe-UNION, 2026-09-25. This file came from the kitchen lane,
  // whose schema carried no promotions or modifiers, so its wipe has no
  // statement for them. On the shared test database that is not optional:
  // OrderItemModifier_orderItemId_fkey is RESTRICT, so a single residue row
  // left by promotions or catalogModifiers makes the orderItem delete below
  // throw inside beforeAll and takes every test in this file with it.
  //
  // It has not fired here yet only because vitest orders files by size
  // descending and this one lands late in the run, behind the files that
  // clean up after themselves. That is placement luck, not a contract — the
  // same gap already fired in printJobs.test.js once two new tests grew that
  // file and moved it up behind promotions. Completed here for the same
  // reason: the wipe must not depend on where the file sorts.
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
let company, branch, coffeeId, dosaId, teaId;
let barId, hotId; // stations: Hot kitchen (default), Barista bar
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const newOrderWithKot = async (productIds) => {
  const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', items: productIds.map((productId) => ({ productId, qty: 1 })) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const kot = await request(app).post(`/api/orders/${created.body.order.id}/kot`)
    .set(auth(tokens.cashier)).send({});
  expect(kot.status, JSON.stringify(kot.body)).toBe(201);
  return { order: created.body.order, kot: kot.body.kot };
};

const itemsOf = (kotId) =>
  prisma.kitchenItem.findMany({
    where: { kotId },
    orderBy: { changeSeq: 'asc' },
    include: { orderItem: { select: { productId: true } } },
  });

const move = (id, body, token = tokens.cashier) =>
  request(app).post(`/api/kitchen/items/${id}/state`).set(auth(token)).send(body);

const walkTo = async (id, target) => {
  const ladder = ['IN_PREP', 'READY', 'SERVED'];
  let item = await prisma.kitchenItem.findUnique({ where: { id } });
  for (const to of ladder) {
    const res = await move(id, { to, version: item.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    item = { version: res.body.item.version };
    if (to === target) break;
  }
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  company = await prisma.company.create({
    data: {
      name: 'Kitchen Cafe',
      slug: 'kitchen-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  // publicId is required and unique since the foundation lane landed — the
  // store identity a human reads out over the phone. This lane's fixtures were
  // written before that column existed, so they are given one here rather than
  // the column being made optional.
  branch = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-KI-0001', name: 'Main', code: 'M1' },
  });
  const mk = (email, fullName, role) =>
    prisma.posUser.create({ data: { email, fullName, role, companyId: company.id, branchId: branch.id, passwordHash } });
  await mk('owner@k.test', 'Kitchen Owner', 'CUSTOMER_OWNER');
  await mk('till@k.test', 'Kitchen Till', 'CASHIER');

  const tax = await prisma.taxRate.create({
    data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const drinks = await prisma.category.create({ data: { companyId: company.id, name: 'Drinks', sortOrder: 1 } });
  const food = await prisma.category.create({ data: { companyId: company.id, name: 'Food', sortOrder: 2 } });
  const mkProduct = async (name, categoryId) =>
    (await prisma.product.create({
      data: { companyId: company.id, categoryId, name, basePrice: '100.00', taxRateId: tax.id },
    })).id;
  coffeeId = await mkProduct('Coffee', drinks.id);
  teaId = await mkProduct('Tea', drinks.id);
  dosaId = await mkProduct('Dosa', food.id);

  tokens.owner = await login('owner@k.test');
  tokens.cashier = await login('till@k.test');

  // Stations via the API: Hot kitchen is the store default; Barista bar takes
  // the Drinks category, but a product rule pins Tea back to Hot kitchen.
  const hot = await request(app).post('/api/kitchen/stations').set(auth(tokens.owner))
    .send({ name: 'Hot kitchen', isDefault: true, sortOrder: 0 });
  expect(hot.status, JSON.stringify(hot.body)).toBe(201);
  hotId = hot.body.station.id;
  const bar = await request(app).post('/api/kitchen/stations').set(auth(tokens.owner))
    .send({ name: 'Barista bar', sortOrder: 1 });
  expect(bar.status).toBe(201);
  barId = bar.body.station.id;
  expect((await request(app).post('/api/kitchen/routes').set(auth(tokens.owner))
    .send({ stationId: barId, categoryId: drinks.id })).status).toBe(201);
  expect((await request(app).post('/api/kitchen/routes').set(auth(tokens.owner))
    .send({ stationId: hotId, productId: teaId })).status).toBe(201);
});

afterAll(async () => {
  // Leave nothing behind: kitchen/print rows RESTRICT station deletion, so a
  // later file's branch wipe would fail on this file's leftovers.
  await wipe();
  await prisma.$disconnect();
});

describe('routing on KOT creation', () => {
  it('product rule beats category rule beats the default station, one row per line', async () => {
    const { kot } = await newOrderWithKot([coffeeId, teaId, dosaId]);
    const rows = await itemsOf(kot.id);
    expect(rows).toHaveLength(3);
    const byProduct = Object.fromEntries(rows.map((r) => [r.orderItem.productId, r]));
    expect(byProduct[coffeeId].stationId).toBe(barId); // category rule
    expect(byProduct[teaId].stationId).toBe(hotId); // product rule wins
    expect(byProduct[dosaId].stationId).toBe(hotId); // unmapped -> default
    for (const r of rows) {
      expect(r.state).toBe('QUEUED');
      expect(r.queuedAt).toBeTruthy();
      expect(r.targetSeconds).toBe(600);
    }
  });

  it('a second KOT on the same order routes only the new lines', async () => {
    const { order } = await newOrderWithKot([coffeeId]);
    const add = await request(app).post(`/api/orders/${order.id}/items`).set(auth(tokens.cashier))
      .send({ productId: dosaId, qty: 1 });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const kot2 = await request(app).post(`/api/orders/${order.id}/kot`).set(auth(tokens.cashier)).send({});
    expect(kot2.status).toBe(201);
    const rows = await itemsOf(kot2.body.kot.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].stationId).toBe(hotId);
  });
});

describe('state machine', () => {
  it('QUEUED→IN_PREP→READY→SERVED sets three distinct timestamps in order', async () => {
    const { kot } = await newOrderWithKot([coffeeId]);
    const [row] = await itemsOf(kot.id);
    await walkTo(row.id, 'SERVED');
    const done = await prisma.kitchenItem.findUnique({ where: { id: row.id } });
    expect(done.state).toBe('SERVED');
    expect(done.startedAt && done.readyAt && done.servedAt).toBeTruthy();
    expect(done.startedAt <= done.readyAt).toBe(true);
    expect(done.readyAt <= done.servedAt).toBe(true);
    expect(done.lastActorId).toBeTruthy();
  });

  it('regressions and skips off the ladder are 409s, never writes', async () => {
    const { kot } = await newOrderWithKot([coffeeId]);
    const [row] = await itemsOf(kot.id);
    // Skip QUEUED→READY
    expect((await move(row.id, { to: 'READY', version: 1 })).status).toBe(409);
    await walkTo(row.id, 'READY');
    const ready = await prisma.kitchenItem.findUnique({ where: { id: row.id } });
    // Regression READY→IN_PREP
    expect((await move(row.id, { to: 'IN_PREP', version: ready.version })).status).toBe(409);
    expect((await prisma.kitchenItem.findUnique({ where: { id: row.id } })).state).toBe('READY');
  });

  it('CANCELLED needs a reason, records actor+time, and is unreachable from READY', async () => {
    const { kot } = await newOrderWithKot([coffeeId, dosaId]);
    const [a, b] = await itemsOf(kot.id);
    expect((await move(a.id, { to: 'CANCELLED', version: 1 })).status).toBe(400);
    const ok = await move(a.id, { to: 'CANCELLED', version: 1, reason: 'out of stock' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const cancelled = await prisma.kitchenItem.findUnique({ where: { id: a.id } });
    expect(cancelled.cancelledAt).toBeTruthy();
    expect(cancelled.lastActorId).toBeTruthy();
    const audit = await prisma.posAuditLog.findFirst({
      where: { action: 'KITCHEN_ITEM_STATE', entityId: a.id },
      orderBy: { at: 'desc' },
    });
    expect(audit.meta).toMatchObject({ to: 'CANCELLED', reason: 'out of stock' });
    expect(audit.actorEmail).toBe('till@k.test');
    // READY item cannot be kitchen-cancelled — that is a till void.
    await walkTo(b.id, 'READY');
    const readyRow = await prisma.kitchenItem.findUnique({ where: { id: b.id } });
    expect((await move(b.id, { to: 'CANCELLED', version: readyRow.version, reason: 'x' })).status).toBe(409);
  });
});

describe('duplicate protection', () => {
  it('replaying the SAME decision converges: 200, replayed:true, one write', async () => {
    const { kot } = await newOrderWithKot([coffeeId]);
    const [row] = await itemsOf(kot.id);
    const first = await move(row.id, { to: 'IN_PREP', version: 1 });
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    const seqAfterFirst = first.body.item.changeSeq;
    const replay = await move(row.id, { to: 'IN_PREP', version: 1 });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.item.changeSeq).toBe(seqAfterFirst); // nothing written
    expect(replay.body.item.version).toBe(2);
  });

  it('a DIFFERENT decision on a consumed version is a 409', async () => {
    const { kot } = await newOrderWithKot([coffeeId]);
    const [row] = await itemsOf(kot.id);
    expect((await move(row.id, { to: 'IN_PREP', version: 1 })).status).toBe(200);
    expect((await move(row.id, { to: 'CANCELLED', version: 1, reason: 'x' })).status).toBe(409);
  });
});

describe('board + reconnect recovery', () => {
  it('snapshot carries live states and the cursor; sinceSeq replays changes after N, terminal rows included', async () => {
    const { kot } = await newOrderWithKot([teaId, dosaId]); // both → Hot kitchen
    const snap = await request(app).get(`/api/kitchen/stations/${hotId}/board`).set(auth(tokens.cashier));
    expect(snap.status).toBe(200);
    const mark = snap.body.seq;
    const mine = snap.body.items.filter((i) => i.kotId === kot.id);
    expect(mine).toHaveLength(2);

    await walkTo(mine[0].id, 'READY');
    const inc = await request(app)
      .get(`/api/kitchen/stations/${hotId}/board?sinceSeq=${mark}`)
      .set(auth(tokens.cashier));
    expect(inc.status).toBe(200);
    expect(inc.body.seq).toBeGreaterThan(mark);
    const changed = inc.body.items.filter((i) => i.kotId === kot.id);
    expect(changed.map((i) => i.id)).toContain(mine[0].id);
    expect(changed.find((i) => i.id === mine[1].id)).toBeUndefined();

    const caughtUp = await request(app)
      .get(`/api/kitchen/stations/${hotId}/board?sinceSeq=${inc.body.seq}`)
      .set(auth(tokens.cashier));
    expect(caughtUp.body.items).toHaveLength(0);
  });
});

describe('derived readiness + overview', () => {
  it('an order is kitchen-READY only when every non-cancelled line is READY or later', async () => {
    await wipeOrdersOnly();
    const { order, kot } = await newOrderWithKot([coffeeId, dosaId]);
    const [a, b] = await itemsOf(kot.id);
    const readyCount = async () =>
      (await request(app).get('/api/kitchen/overview').set(auth(tokens.owner))).body.ordersKitchenReady;
    expect(await readyCount()).toBe(0);
    await walkTo(a.id, 'READY');
    expect(await readyCount()).toBe(0); // one line still QUEUED
    const bRow = await prisma.kitchenItem.findUnique({ where: { id: b.id } });
    expect((await move(b.id, { to: 'CANCELLED', version: bRow.version, reason: '86ed' })).status).toBe(200);
    expect(await readyCount()).toBe(1); // cancelled line no longer counts
    void order;
  });

  it('overview is manager+; a cashier gets 403', async () => {
    expect((await request(app).get('/api/kitchen/overview').set(auth(tokens.cashier))).status).toBe(403);
  });
});

const wipeOrdersOnly = async () => {
  await prisma.kitchenItem.deleteMany();
  // Same RESTRICT foreign key as in wipe() above: OrderItemModifier must go
  // before the order lines it points at, or this helper throws mid-file.
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
};

describe('tenancy', () => {
  it('a foreign company sees no stations, no board, no items', async () => {
    const passwordHash = await hashPassword(PW);
    const other = await prisma.company.create({
      data: {
        name: 'Other Diner', slug: 'other-diner',
        licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
      },
    });
    const otherBranch = await prisma.branch.create({
      data: { companyId: other.id, publicId: 'VC-KI-0002', name: 'Other', code: 'O1' },
    });
    await prisma.posUser.create({
      data: { email: 'till@o.test', fullName: 'Other Till', role: 'CASHIER', companyId: other.id, branchId: otherBranch.id, passwordHash },
    });
    const t = await login('till@o.test');
    expect((await request(app).get(`/api/kitchen/stations/${hotId}/board`).set(auth(t))).status).toBe(404);
    const { kot } = await newOrderWithKot([coffeeId]);
    const [row] = await itemsOf(kot.id);
    expect((await move(row.id, { to: 'IN_PREP', version: 1 }, t)).status).toBe(404);
  });
});
