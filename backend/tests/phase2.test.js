// Phase-2 suite (contract §12): catalog/tables RBAC + isolation, the full
// cashier flow reproducing the §6 worked example over the API, order/payment
// state transitions, invoice uniqueness under concurrency, licence blocks and
// the sales report. Pure money math lives in money.test.js.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('phase2.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { istDateOf, MANUAL_PAYMENT_LABEL } = await import('../src/lib/orders.js');

const app = createApp();

const wipe = async () => {
  // Shared test database: another suite's kitchen/print rows RESTRICT the
  // station delete inside this wipe's Branch cascade.
  await prisma.printJob.deleteMany();
  await prisma.printTarget.deleteMany();
  await prisma.printAgent.deleteMany();
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.kitchenCursor.deleteMany();
  // Before PosUser and Branch, which it references. The self-relation is
  // ON DELETE SET NULL so a bulk delete needs no ordering of its own.
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  // Before Order: PaymentIntent references it ON DELETE RESTRICT, so an
  // order delete fails outright once any intent exists.
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
  // DiscountPolicy's foreign keys are RESTRICT, so it goes before the branch,
  // user and company rows it points at.
  await prisma.discountPolicy.deleteMany();
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
let companyA, companyB, companyC, branchA1, branchA2, branchB1;
const tokens = {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Cafe', slug: 'alpha-cafe',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inADay } },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Cafe', slug: 'bravo-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  companyC = await prisma.company.create({
    data: {
      name: 'Charlie Expired', slug: 'charlie-expired',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() - 86400e3) } },
    },
  });
  branchA1 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-PH-0001', name: 'Alpha One', code: 'A1' } });
  branchA2 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-PH-0002', name: 'Alpha Two', code: 'A2' } });
  branchB1 = await prisma.branch.create({ data: { companyId: companyB.id, publicId: 'VC-PH-0003', name: 'Bravo One', code: 'B1' } });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'atc@test.local', fullName: 'ATC Admin', role: 'POS_SUPER_ADMIN' });
  await mk({ email: 'owner.a@test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  await mk({ email: 'manager.a1@test.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id });
  await mk({ email: 'cashier.a1@test.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id });
  await mk({ email: 'owner.b@test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });
  await mk({ email: 'owner.c@test.local', fullName: 'Owner C', role: 'CUSTOMER_OWNER', companyId: companyC.id });

  // Alpha Cafe's admin has configured a company discount default. Without a
  // row like this nobody below the owner may discount anything, which is the
  // product's deny-by-default floor — Bravo Cafe is deliberately left with no
  // rows at all so that floor stays under test. The §6 worked example below
  // takes 13.7% combined, comfortably inside this.
  await prisma.discountPolicy.create({
    data: {
      companyId: companyA.id,
      level: 'COMPANY',
      scopeKey: 'company',
      allowLineDiscount: true,
      allowOrderDiscount: true,
      maxPercent: '20.000',
      maxFlatPaise: 50000,
      note: 'Company default',
    },
  });

  tokens.atc = await login('atc@test.local');
  tokens.ownerA = await login('owner.a@test.local');
  tokens.managerA1 = await login('manager.a1@test.local');
  tokens.cashierA1 = await login('cashier.a1@test.local');
  tokens.ownerB = await login('owner.b@test.local');
  tokens.ownerC = await login('owner.c@test.local');
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Catalog ids filled by the catalog describe, used by every later flow.
const cat = {};
const line = (order, name) => order.items.find((i) => i.name === name);

describe('catalog', () => {
  it('owner creates tax rates, categories, products and variants', async () => {
    const gst5 = await request(app).post('/api/catalog/tax-rates').set(auth(tokens.ownerA)).send({ name: 'GST 5%', ratePercent: 5 });
    expect(gst5.status).toBe(201);
    const gst12 = await request(app).post('/api/catalog/tax-rates').set(auth(tokens.ownerA)).send({ name: 'GST 12%', ratePercent: 12 });
    expect(gst12.status, JSON.stringify(gst12.body)).toBe(201);
    expect(gst12.body.taxRate.ratePercent).toBe(12);
    cat.gst5 = gst5.body.taxRate.id;
    cat.gst12 = gst12.body.taxRate.id;

    const coffee = await request(app).post('/api/catalog/categories').set(auth(tokens.ownerA)).send({ name: 'Coffee', sortOrder: 1 });
    const food = await request(app).post('/api/catalog/categories').set(auth(tokens.ownerA)).send({ name: 'Food', sortOrder: 2 });
    expect(coffee.status).toBe(201);
    expect(food.status).toBe(201);
    cat.coffee = coffee.body.category.id;
    cat.food = food.body.category.id;

    const capp = await request(app).post('/api/catalog/products').set(auth(tokens.ownerA))
      .send({ categoryId: cat.coffee, name: 'Cappuccino', sku: 'CAP-01', basePrice: 180, taxRateId: cat.gst5 });
    expect(capp.status, JSON.stringify(capp.body)).toBe(201);
    expect(capp.body.product.taxRate.name).toBe('GST 5%');
    cat.cappuccino = capp.body.product.id;

    const sand = await request(app).post('/api/catalog/products').set(auth(tokens.ownerA))
      .send({ categoryId: cat.food, name: 'Veg Sandwich', basePrice: 150, taxRateId: cat.gst5 });
    expect(sand.status).toBe(201);
    cat.sandwich = sand.body.product.id;

    const brew = await request(app).post('/api/catalog/products').set(auth(tokens.ownerA))
      .send({ categoryId: cat.coffee, name: 'Cold Brew', basePrice: 180, taxRateId: cat.gst12 });
    expect(brew.status).toBe(201);
    cat.coldBrew = brew.body.product.id;

    const large = await request(app).post(`/api/catalog/products/${cat.coldBrew}/variants`).set(auth(tokens.ownerA))
      .send({ name: 'Large', price: 220 });
    expect(large.status).toBe(201);
    cat.large = large.body.product.variants.find((v) => v.name === 'Large').id;
  });

  it('cashier cannot write the catalog', async () => {
    const res = await request(app).post('/api/catalog/categories').set(auth(tokens.cashierA1)).send({ name: 'Rogue' });
    expect(res.status).toBe(403);
  });

  it('catalog is company-isolated; cross-company product answers 404', async () => {
    const listB = await request(app).get('/api/catalog/products').set(auth(tokens.ownerB));
    expect(listB.status).toBe(200);
    expect(listB.body.products).toEqual([]);
    const cross = await request(app).get(`/api/catalog/products/${cat.cappuccino}`).set(auth(tokens.ownerB));
    const absent = await request(app).get('/api/catalog/products/nonexistent-id').set(auth(tokens.ownerB));
    expect(cross.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(cross.body.error.code).toBe(absent.body.error.code);
  });

  it('ATC needs a company scope, then may write catalog', async () => {
    const missing = await request(app).get('/api/catalog/products').set(auth(tokens.atc));
    expect(missing.status).toBe(400);
    const scoped = await request(app).get(`/api/catalog/products?companyId=${companyA.id}&q=capp`).set(auth(tokens.atc));
    expect(scoped.status).toBe(200);
    expect(scoped.body.products.map((p) => p.name)).toEqual(['Cappuccino']);
    const write = await request(app).post(`/api/catalog/tax-rates?companyId=${companyA.id}`).set(auth(tokens.atc))
      .send({ name: 'GST 18%', ratePercent: 18 });
    expect(write.status).toBe(201);
  });

  it('a category with products cannot be hard-deleted', async () => {
    const res = await request(app).delete(`/api/catalog/categories/${cat.coffee}`).set(auth(tokens.ownerA));
    expect(res.status).toBe(409);
  });

  it('an expired licence blocks catalog writes but not reads', async () => {
    const write = await request(app).post('/api/catalog/categories').set(auth(tokens.ownerC)).send({ name: 'Blocked' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('POS_LICENSE_EXPIRED');
    const read = await request(app).get('/api/catalog/categories').set(auth(tokens.ownerC));
    expect(read.status).toBe(200);
  });
});

describe('tables', () => {
  it('manager creates tables in their own branch; client branchId is ignored', async () => {
    const t1 = await request(app).post('/api/tables').set(auth(tokens.managerA1))
      .send({ name: 'T1', capacity: 4, branchId: branchA2.id });
    expect(t1.status, JSON.stringify(t1.body)).toBe(201);
    expect(t1.body.table.branchId).toBe(branchA1.id);
    cat.t1 = t1.body.table.id;
    const t2 = await request(app).post('/api/tables').set(auth(tokens.managerA1)).send({ name: 'T2', capacity: 2 });
    expect(t2.status).toBe(201);
    cat.t2 = t2.body.table.id;
  });

  it('owner must name a branch; duplicate names conflict', async () => {
    const missing = await request(app).post('/api/tables').set(auth(tokens.ownerA)).send({ name: 'TX' });
    expect(missing.status).toBe(400);
    const ok = await request(app).post('/api/tables').set(auth(tokens.ownerA)).send({ name: 'T1', branchId: branchA2.id });
    expect(ok.status).toBe(201);
    const dup = await request(app).post('/api/tables').set(auth(tokens.managerA1)).send({ name: 'T1' });
    expect(dup.status).toBe(409);
  });

  it('cashier reads tables but cannot write; ATC cannot write', async () => {
    const list = await request(app).get('/api/tables').set(auth(tokens.cashierA1));
    expect(list.status).toBe(200);
    expect(list.body.tables.every((t) => t.branchId === branchA1.id)).toBe(true);
    const write = await request(app).post('/api/tables').set(auth(tokens.cashierA1)).send({ name: 'T9' });
    expect(write.status).toBe(403);
    const atc = await request(app).post(`/api/tables?companyId=${companyA.id}`).set(auth(tokens.atc)).send({ name: 'T9' });
    expect(atc.status).toBe(403);
  });
});

describe('cashier flow — §6 worked example over the API', () => {
  let orderId;

  it('creates a DINE_IN order with snapshot pricing', async () => {
    const res = await request(app).post('/api/orders').set(auth(tokens.cashierA1)).send({
      type: 'DINE_IN',
      tableId: cat.t1,
      items: [
        { productId: cat.cappuccino, qty: 2 },
        { productId: cat.sandwich, qty: 1 },
        { productId: cat.coldBrew, variantId: cat.large, qty: 1 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const o = res.body.order;
    orderId = o.id;
    expect(o.status).toBe('OPEN');
    expect(o.subtotal).toBe(730);
    expect(line(o, 'Cold Brew (Large)').unitPrice).toBe(220);
    expect(line(o, 'Cappuccino').taxRate).toEqual({ name: 'GST 5%', percent: 5 });
  });

  it('rejects a second order on the occupied table and bad type/table combos', async () => {
    const occupied = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'DINE_IN', tableId: cat.t1, items: [{ productId: cat.cappuccino }] });
    expect(occupied.status).toBe(409);
    const takeawayTable = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', tableId: cat.t2, items: [{ productId: cat.cappuccino }] });
    expect(takeawayTable.status).toBe(400);
    const dineNoTable = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'DINE_IN', items: [{ productId: cat.cappuccino }] });
    expect(dineNoTable.status).toBe(400);
    expect(dineNoTable.body.error.code).toBe('POS_BAD_REQUEST');
  });

  it('line discount + order discount reproduce every §6 figure', async () => {
    const o1 = await request(app).get(`/api/orders/${orderId}`).set(auth(tokens.cashierA1));
    const sandwichLine = line(o1.body.order, 'Veg Sandwich');
    const ld = await request(app).patch(`/api/orders/${orderId}/items/${sandwichLine.id}`)
      .set(auth(tokens.cashierA1)).send({ lineDiscount: 30 });
    expect(ld.status, JSON.stringify(ld.body)).toBe(200);
    expect(ld.body.order.subtotal).toBe(700);

    const od = await request(app).post(`/api/orders/${orderId}/discount`)
      .set(auth(tokens.cashierA1)).send({ type: 'PERCENT', value: 10 });
    expect(od.status).toBe(200);
    const o = od.body.order;
    expect(o.subtotal).toBe(700);
    expect(o.discountAmount).toBe(70);
    expect(o.taxAmount).toBe(45.36);
    expect(o.total).toBe(675.36);
    expect(line(o, 'Cappuccino').lineTax).toBe(16.2);
    expect(line(o, 'Veg Sandwich').lineTax).toBe(5.4);
    expect(line(o, 'Cold Brew (Large)').lineTax).toBe(23.76);
    expect(line(o, 'Cappuccino').lineTotal).toBe(340.2);
    expect(line(o, 'Veg Sandwich').lineTotal).toBe(113.4);
    expect(line(o, 'Cold Brew (Large)').lineTotal).toBe(221.76);
  });

  it('discount caps are enforced', async () => {
    const flat = await request(app).post(`/api/orders/${orderId}/discount`)
      .set(auth(tokens.cashierA1)).send({ type: 'FLAT', value: 9999 });
    expect(flat.status).toBe(400);
    const pct = await request(app).post(`/api/orders/${orderId}/discount`)
      .set(auth(tokens.cashierA1)).send({ type: 'PERCENT', value: 101 });
    expect(pct.status).toBe(400);
    // Restore the worked-example discount.
    const od = await request(app).post(`/api/orders/${orderId}/discount`)
      .set(auth(tokens.cashierA1)).send({ type: 'PERCENT', value: 10 });
    expect(od.body.order.total).toBe(675.36);
  });

  it('KOT batches unsent lines; pre-KOT edits close after sending', async () => {
    const kot = await request(app).post(`/api/orders/${orderId}/kot`).set(auth(tokens.cashierA1)).send({});
    expect(kot.status, JSON.stringify(kot.body)).toBe(201);
    expect(kot.body.kot.seq).toBe(1);
    expect(kot.body.kot.tableName).toBe('T1');
    expect(kot.body.kot.items).toHaveLength(3);
    expect(kot.body.order.items.every((i) => i.kotSeq === 1)).toBe(true);

    const empty = await request(app).post(`/api/orders/${orderId}/kot`).set(auth(tokens.cashierA1)).send({});
    expect(empty.status).toBe(409);

    const capp = line(kot.body.order, 'Cappuccino');
    const qtyEdit = await request(app).patch(`/api/orders/${orderId}/items/${capp.id}`)
      .set(auth(tokens.cashierA1)).send({ qty: 5 });
    expect(qtyEdit.status).toBe(409);
    const del = await request(app).delete(`/api/orders/${orderId}/items/${capp.id}`).set(auth(tokens.cashierA1));
    expect(del.status).toBe(409);
  });

  it('KOT-sent line void is manager-only and leaves totals', async () => {
    const add = await request(app).post(`/api/orders/${orderId}/items`).set(auth(tokens.cashierA1))
      .send({ productId: cat.cappuccino, qty: 1 });
    expect(add.status).toBe(200);
    expect(add.body.order.subtotal).toBe(880);
    const extra = add.body.order.items.filter((i) => i.name === 'Cappuccino').find((i) => i.kotSeq === null);
    expect(extra).toBeTruthy();

    const kot2 = await request(app).post(`/api/orders/${orderId}/kot`).set(auth(tokens.cashierA1)).send({});
    expect(kot2.body.kot.seq).toBe(2);
    expect(kot2.body.kot.items).toHaveLength(1);

    const denied = await request(app).post(`/api/orders/${orderId}/items/${extra.id}/void`)
      .set(auth(tokens.cashierA1)).send({ reason: 'spilled' });
    expect(denied.status).toBe(403);
    const voided = await request(app).post(`/api/orders/${orderId}/items/${extra.id}/void`)
      .set(auth(tokens.managerA1)).send({ reason: 'spilled at the counter' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(line(voided.body.order, 'Veg Sandwich')).toBeTruthy();
    expect(voided.body.order.subtotal).toBe(700);
    expect(voided.body.order.total).toBe(675.36);
    const voidedLine = voided.body.order.items.find((i) => i.id === extra.id);
    expect(voidedLine.status).toBe('VOIDED');
  });

  it('bill freezes the order and assigns a branch/FY invoice number', async () => {
    const res = await request(app).post(`/api/orders/${orderId}/bill`).set(auth(tokens.cashierA1)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = res.body.order;
    expect(o.status).toBe('BILLED');
    expect(o.billedAt).toBeTruthy();
    expect(o.invoiceNumber).toMatch(/^A1\/\d{2}-\d{2}\/00001$/);
    expect(o.total).toBe(675.36);

    const receipt = res.body.receipt;
    expect(receipt.invoiceNumber).toBe(o.invoiceNumber);
    expect(receipt.taxBreakup).toEqual(
      expect.arrayContaining([
        { name: 'GST 5%', percent: 5, taxable: 432, tax: 21.6 },
        { name: 'GST 12%', percent: 12, taxable: 198, tax: 23.76 },
      ]),
    );

    const lateItem = await request(app).post(`/api/orders/${orderId}/items`).set(auth(tokens.cashierA1))
      .send({ productId: cat.cappuccino });
    expect(lateItem.status).toBe(409);
    const lateDiscount = await request(app).post(`/api/orders/${orderId}/discount`)
      .set(auth(tokens.cashierA1)).send({ type: 'FLAT', value: 5 });
    expect(lateDiscount.status).toBe(409);
  });

  it('cash payment applies min(tendered, due) and returns the change', async () => {
    const res = await request(app).post(`/api/orders/${orderId}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CASH', tendered: 700 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.changeDue).toBe(24.64);
    expect(res.body.payment.amount).toBe(675.36);
    expect(res.body.payment.channel).toBe('MANUAL');
    const o = res.body.order;
    expect(o.status).toBe('PAID');
    expect(o.amountPaid).toBe(675.36);
    expect(o.amountDue).toBe(0);
    expect(o.closedAt).toBeTruthy();
  });

  it('the receipt carries the manual-payment label verbatim', async () => {
    const res = await request(app).get(`/api/orders/${orderId}/receipt`).set(auth(tokens.cashierA1));
    expect(res.status).toBe(200);
    expect(res.body.receipt.payments[0].label).toBe('MANUAL PAYMENT RECORD — not gateway-verified');
    expect(res.body.receipt.payments[0].label).toBe(MANUAL_PAYMENT_LABEL);
    expect(res.body.receipt.amountDue).toBe(0);
    expect(res.body.receipt.order.cashier).toBe('Cashier A1');
  });

  it('paying the order frees the table for the next one', async () => {
    const tables = await request(app).get('/api/tables').set(auth(tokens.cashierA1));
    const t1 = tables.body.tables.find((t) => t.id === cat.t1);
    expect(t1.currentOrder).toBeNull();
    const again = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'DINE_IN', tableId: cat.t1, items: [{ productId: cat.cappuccino }] });
    expect(again.status).toBe(201);
    cat.secondDineIn = again.body.order.id;
  });
});

describe('transitions, refunds and voids', () => {
  const takeaway = async (items = [{ productId: cat.cappuccino, qty: 1 }]) => {
    const res = await request(app).post('/api/orders').set(auth(tokens.cashierA1)).send({ type: 'TAKEAWAY', items });
    expect(res.status).toBe(201);
    return res.body.order;
  };
  const bill = async (id) => {
    const res = await request(app).post(`/api/orders/${id}/bill`).set(auth(tokens.cashierA1)).send({});
    expect(res.status).toBe(200);
    return res.body.order;
  };

  it('duplicate product+variant merges into one line (create and add)', async () => {
    const o = await takeaway([
      { productId: cat.cappuccino, qty: 1 },
      { productId: cat.cappuccino, qty: 1 },
    ]);
    expect(o.items).toHaveLength(1);
    expect(o.items[0].qty).toBe(2);
    const add = await request(app).post(`/api/orders/${o.id}/items`).set(auth(tokens.cashierA1))
      .send({ productId: cat.cappuccino });
    expect(add.body.order.items).toHaveLength(1);
    expect(add.body.order.items[0].qty).toBe(3);
  });

  // The merge above is product+variant only, which was the whole of the rule
  // until VC-102 added modifiers. The till's key was updated for them and the
  // phone centre's copy was not — that is D-3. The key is one shared function
  // now, but a shared function is only as good as both call sites still using
  // it, so this pins the till's end of it; phoneOrders.test.js pins the other.
  it('a different modifier keeps the lines apart, the same one merges them', async () => {
    const p = await request(app).post('/api/catalog/products').set(auth(tokens.ownerA))
      .send({ categoryId: cat.food, name: 'Toastie', basePrice: 100, taxRateId: cat.gst5 });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const g = await request(app).post(`/api/catalog/products/${p.body.product.id}/modifier-groups`)
      .set(auth(tokens.ownerA)).send({ name: 'Bread', maxSelect: 1 });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const groupId = g.body.product.modifierGroups.find((x) => x.name === 'Bread').id;
    const optionId = async (name, price) => {
      const res = await request(app)
        .post(`/api/catalog/products/${p.body.product.id}/modifier-groups/${groupId}/options`)
        .set(auth(tokens.ownerA)).send({ name, price });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.product.modifierGroups.find((x) => x.id === groupId).options.find((o) => o.name === name).id;
    };
    const rye = await optionId('Rye', 20);
    const sourdough = await optionId('Sourdough', 30);

    const o = await takeaway([
      { productId: p.body.product.id, qty: 1, modifierOptionIds: [rye] },
      { productId: p.body.product.id, qty: 1, modifierOptionIds: [sourdough] },
      { productId: p.body.product.id, qty: 1, modifierOptionIds: [rye] },
    ]);
    expect(o.items).toHaveLength(2);
    expect(o.items.map((i) => [Number(i.unitPrice), i.qty]).sort((a, b) => a[0] - b[0]))
      .toEqual([[120, 2], [130, 1]]);
  });

  it('payments only on BILLED; overpay by amount is refused', async () => {
    const o = await takeaway();
    const early = await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CASH', tendered: 500 });
    expect(early.status).toBe(409);
    await bill(o.id);
    const over = await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CARD', amount: 500 });
    expect(over.status).toBe(400);
    const both = await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CASH', tendered: 100, amount: 100 });
    expect(both.status).toBe(400);
    // Split: CARD 100, then CASH for the exact remainder (189 − 100).
    const card = await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CARD', amount: 100 });
    expect(card.status).toBe(201);
    expect(card.body.order.status).toBe('BILLED');
    expect(card.body.order.amountDue).toBe(89);
    const cash = await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CASH', tendered: 89 });
    expect(cash.status).toBe(201);
    expect(cash.body.order.status).toBe('PAID');
  });

  it('refunds are manager-only, capped, and drive PAID → REFUNDED', async () => {
    const o = await takeaway();
    await bill(o.id);
    await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'UPI', amount: 189 }).expect(201);

    const denied = await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(tokens.cashierA1))
      .send({ amount: 50, reason: 'cold coffee' });
    expect(denied.status).toBe(403);
    const noReason = await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(tokens.managerA1))
      .send({ amount: 50 });
    expect(noReason.status).toBe(400);
    const over = await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(tokens.managerA1))
      .send({ amount: 500, reason: 'cold coffee' });
    expect(over.status).toBe(400);

    const part = await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(tokens.managerA1))
      .send({ amount: 50, reason: 'cold coffee' });
    expect(part.status).toBe(201);
    expect(part.body.order.status).toBe('PAID');
    expect(part.body.order.amountRefunded).toBe(50);

    const rest = await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(tokens.managerA1))
      .send({ amount: 139, reason: 'order cancelled entirely' });
    expect(rest.status).toBe(201);
    expect(rest.body.order.status).toBe('REFUNDED');
  });

  it('void needs manager, zero net collections, and OPEN/BILLED state', async () => {
    const o = await takeaway();
    const cashierVoid = await request(app).post(`/api/orders/${o.id}/void`).set(auth(tokens.cashierA1))
      .send({ reason: 'test' });
    expect(cashierVoid.status).toBe(403);

    await bill(o.id);
    await request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CASH', tendered: 100 }).expect(201);
    const collected = await request(app).post(`/api/orders/${o.id}/void`).set(auth(tokens.managerA1))
      .send({ reason: 'wrong order' });
    expect(collected.status).toBe(409);

    await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(tokens.managerA1))
      .send({ amount: 100, reason: 'returning part payment' }).expect(201);
    const voided = await request(app).post(`/api/orders/${o.id}/void`).set(auth(tokens.managerA1))
      .send({ reason: 'wrong order entirely' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.order.status).toBe('VOID');
    expect(voided.body.order.invoiceNumber).toBeTruthy();

    const receipt = await request(app).get(`/api/orders/${o.id}/receipt`).set(auth(tokens.cashierA1));
    expect(receipt.status).toBe(409);
    const again = await request(app).post(`/api/orders/${o.id}/void`).set(auth(tokens.managerA1))
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);
  });

  it('concurrent bills never share an invoice number', async () => {
    const orders = [];
    for (let i = 0; i < 5; i += 1) orders.push(await takeaway());
    const results = await Promise.all(
      orders.map((o) =>
        request(app).post(`/api/orders/${o.id}/bill`).set(auth(tokens.cashierA1)).send({}),
      ),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const numbers = results.map((r) => r.body.order.invoiceNumber);
    expect(new Set(numbers).size).toBe(5);
    for (const n of numbers) expect(n).toMatch(/^A1\/\d{2}-\d{2}\/\d{5}$/);
  });

  // Regression. A double-clicked "Record payment" used to collect the bill
  // TWICE — both requests answered 201 and the order held two full payment
  // rows, because at READ COMMITTED each transaction read a snapshot without
  // the other's row, so both computed the whole total as still due.
  //
  // It is worth stating why this needs a real database: the due-amount check
  // was present and correct the whole time. Nothing about the logic was wrong
  // in isolation, which is exactly why a mocked Prisma — no MVCC, no second
  // connection — reports it green. The bug only exists between two live
  // transactions, so only two live transactions can show it is gone.
  //
  // The damage is quiet: the customer is charged once in the real world and
  // twice in the till, and nobody finds out until the day-end count is over
  // by one bill with no way to tell which.
  it('a double-clicked payment collects the bill once', async () => {
    const o = await takeaway();
    const { total } = await bill(o.id);

    const [a, b] = await Promise.all([
      request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
        .send({ method: 'CASH', amount: total }),
      request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
        .send({ method: 'CASH', amount: total }),
    ]);

    const accepted = [a, b].filter((r) => r.status === 201);
    expect(accepted.length, `statuses ${a.status}/${b.status}`).toBe(1);

    // The loser must be refused for a reason the cashier can act on. This
    // asserts the message because the first version of the fix passed the
    // count check while answering "payments are recorded on billed orders
    // only" — true of the state machine, useless at a counter, and the kind
    // of message that makes someone re-bill an order that is already paid.
    const loser = [a, b].find((r) => r.status !== 201);
    expect(loser.status).toBe(409);
    expect(loser.body.error.message).toMatch(/already paid in full/i);

    const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
    expect(rows.length).toBe(1);
    const after = await prisma.order.findUnique({ where: { id: o.id } });
    expect(after.status).toBe('PAID');
    expect(Number(rows[0].amount)).toBeCloseTo(Number(total), 2);
  });

  // The lock must serialise collection without forbidding it. Split tender —
  // one guest paying cash and another card against the same bill — is normal
  // café behaviour, and a guard that turned the second half into a 409 would
  // be a worse bug than the one above, because the cashier would hit it every
  // day rather than occasionally.
  it('two partial payments on one bill are both kept', async () => {
    const o = await takeaway();
    const total = Number((await bill(o.id)).total);
    const half = Math.round(total * 50) / 100; // half, to 2dp
    const rest = Math.round((total - half) * 100) / 100;

    const [a, b] = await Promise.all([
      request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
        .send({ method: 'CASH', amount: half }),
      request(app).post(`/api/orders/${o.id}/payments`).set(auth(tokens.cashierA1))
        .send({ method: 'CARD', amount: rest }),
    ]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);

    const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
    expect(rows.length).toBe(2);
    const collected = rows.reduce((s, p) => s + Number(p.amount), 0);
    expect(collected).toBeCloseTo(total, 2);
    const after = await prisma.order.findUnique({ where: { id: o.id } });
    expect(after.status).toBe('PAID');
  });

  // The till retries a payment whose response never arrived. The request
  // reached the server and was committed; only the answer was lost, so the
  // cashier is looking at an error for money that has already been taken and
  // the only sane thing they can do is press the button again.
  //
  // Found in a browser against the deployed build, not reasoned about: on
  // BSC-CP/26-27/00011 a ₹47.25 card payment was committed, its response
  // dropped, the payment retried, and the ₹94.50 bill came out PAID on two
  // ₹47.25 rows 1.2 s apart. The drawer is short by a full tender at day
  // close and nothing on any screen says why.
  describe('a retried payment collects once', () => {
    const half = (total) => Math.round(total * 50) / 100;
    const pay = (orderId, body) =>
      request(app).post(`/api/orders/${orderId}/payments`).set(auth(tokens.cashierA1)).send(body);

    // NEGATIVE CONTROL. Everything below passes trivially if the route simply
    // stopped accepting second payments, so this proves the opposite first:
    // with no key the double-collection is still reachable, exactly as it was
    // before the fix. If someone later makes partial payments unrepeatable
    // for an unrelated reason, this test goes red and says so, rather than
    // letting the rest of the block claim credit for a guard it did not add.
    it('CONTROL: without a key the same partial payment is still taken twice', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const part = half(total);

      const first = await pay(o.id, { method: 'CARD', amount: part });
      const second = await pay(o.id, { method: 'CARD', amount: part });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
      expect(rows.length, 'the unprotected path still double-collects').toBe(2);
      expect(rows.reduce((s, p) => s + Number(p.amount), 0)).toBeCloseTo(total, 2);
    });

    it('with a key the retry returns the first payment and takes nothing more', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const part = half(total);
      const key = 'retry-partial-0001';

      const first = await pay(o.id, { method: 'CARD', amount: part, idempotencyKey: key });
      expect(first.status).toBe(201);
      expect(first.body.replayed).toBe(false);

      const retry = await pay(o.id, { method: 'CARD', amount: part, idempotencyKey: key });
      // 200, not 201: nothing was created. The body is still a whole payment
      // so a till that retries blind renders the same receipt either way.
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.payment.id).toBe(first.body.payment.id);

      const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
      expect(rows.length, 'one tender, one row').toBe(1);
      expect(Number(rows[0].amount)).toBeCloseTo(part, 2);
      // Still BILLED with the other half outstanding — the retry must not
      // have closed the order either.
      const after = await prisma.order.findUnique({ where: { id: o.id } });
      expect(after.status).toBe('BILLED');
    });

    // The full-amount case was already covered, by accident, by the PAID
    // guard — but it answered 409 "already paid in full", which tells a
    // cashier that something is wrong when in fact their payment worked.
    // With a key the honest answer is the payment itself.
    it('a retried FULL payment answers with the payment, not a 409', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const key = 'retry-full-0001';

      const first = await pay(o.id, { method: 'CARD', amount: total, idempotencyKey: key });
      expect(first.status).toBe(201);
      const retry = await pay(o.id, { method: 'CARD', amount: total, idempotencyKey: key });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.payment.id).toBe(first.body.payment.id);
      expect(retry.body.order.status).toBe('PAID');

      expect((await prisma.payment.findMany({ where: { orderId: o.id } })).length).toBe(1);
    });

    // A double-click sends both requests before either answers, so the replay
    // lookup has to happen under the same row lock as the insert. If it were
    // outside, both would look, both would miss, and both would write.
    it('two simultaneous requests with one key produce one payment', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const part = half(total);
      const key = 'retry-concurrent-0001';
      const body = { method: 'UPI', amount: part, idempotencyKey: key };

      const [a, b] = await Promise.all([pay(o.id, body), pay(o.id, body)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, `${a.status}/${b.status}`).toEqual([200, 201]);
      expect(a.body.payment.id).toBe(b.body.payment.id);

      const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
      expect(rows.length).toBe(1);
      expect(Number(rows[0].amount)).toBeCloseTo(part, 2);
    });

    // The regression this fix could most easily cause, and the one that would
    // cost the café real money: an evenly split bill is two different tenders
    // with identical fields. They must both be collected, so the key has to
    // be per tender and not per order — which is why the Sell screen rolls it
    // in startAnother rather than only when the dialog opens.
    it('an even split under two keys is still two payments', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const part = half(total);
      const rest = Math.round((total - part) * 100) / 100;

      const a = await pay(o.id, { method: 'CASH', amount: part, idempotencyKey: 'split-guest-a' });
      const b = await pay(o.id, { method: 'CASH', amount: rest, idempotencyKey: 'split-guest-b' });
      expect(a.status).toBe(201);
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      expect(a.body.payment.id).not.toBe(b.body.payment.id);

      const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
      expect(rows.length).toBe(2);
      expect(rows.reduce((s, p) => s + Number(p.amount), 0)).toBeCloseTo(total, 2);
      expect((await prisma.order.findUnique({ where: { id: o.id } })).status).toBe('PAID');
    });

    // Reusing a key for a genuinely different tender is a fault in the
    // caller. Answering with the first payment would report money that was
    // never taken and silently drop money that was, so it is refused instead.
    it('the same key for a different amount is refused, and the first payment stands', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const part = half(total);
      const key = 'reused-key-0001';

      const first = await pay(o.id, { method: 'CARD', amount: part, idempotencyKey: key });
      expect(first.status).toBe(201);

      const wrong = await pay(o.id, { method: 'CARD', amount: total, idempotencyKey: key });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.message).toMatch(/already used for a different payment/i);

      const method = await pay(o.id, { method: 'UPI', amount: part, idempotencyKey: key });
      expect(method.status).toBe(409);

      const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
      expect(rows.length, 'the refusals wrote nothing').toBe(1);
      expect(rows[0].id).toBe(first.body.payment.id);
    });

    // Change is derived from the stored row, so a replay has to quote the
    // same figure. A cashier who retries after a lost response is standing at
    // an open drawer; a second, different number is the one thing that must
    // not happen.
    it('a replayed CASH payment reports the same change due', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const tendered = Math.ceil(total / 100) * 100 || 100;
      const key = 'retry-cash-0001';

      const first = await pay(o.id, { method: 'CASH', tendered, idempotencyKey: key });
      expect(first.status).toBe(201);
      expect(first.body.changeDue).toBeCloseTo(tendered - total, 2);

      const retry = await pay(o.id, { method: 'CASH', tendered, idempotencyKey: key });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body.changeDue).toBeCloseTo(first.body.changeDue, 2);
      expect(retry.body.payment.tendered).toBeCloseTo(tendered, 2);

      expect((await prisma.payment.findMany({ where: { orderId: o.id } })).length).toBe(1);
    });

    // One key, two bills. Scoping the uniqueness to the order is what keeps a
    // till that reuses keys — a reset clock, a cloned device image — from
    // suppressing a real payment on somebody else's tab.
    it('the same key on a different order is a different payment', async () => {
      const o1 = await takeaway();
      const t1 = Number((await bill(o1.id)).total);
      const o2 = await takeaway();
      const t2 = Number((await bill(o2.id)).total);
      const key = 'shared-key-across-orders';

      const a = await pay(o1.id, { method: 'CARD', amount: t1, idempotencyKey: key });
      const b = await pay(o2.id, { method: 'CARD', amount: t2, idempotencyKey: key });
      expect(a.status).toBe(201);
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      expect(a.body.payment.id).not.toBe(b.body.payment.id);
      expect((await prisma.payment.findMany({ where: { orderId: o2.id } })).length).toBe(1);
    });

    // The key is stored per order, not per tenant, so the isolation has to come
    // from the order lookup — and that is worth proving rather than reading.
    // A neighbouring company presenting company A's order id and A's key must
    // be refused at the door. The dangerous failure is not a 500: it is a 200
    // carrying A's payment row, which would hand one tenant another tenant's
    // takings and the customer's tender with it.
    it('a neighbouring tenant cannot use the key to read a payment', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const key = 'cross-tenant-probe-01';
      const mine = await pay(o.id, { method: 'CARD', amount: total, idempotencyKey: key });
      expect(mine.status).toBe(201);

      const theirs = await request(app)
        .post(`/api/orders/${o.id}/payments`)
        .set(auth(tokens.ownerB))
        .send({ method: 'CARD', amount: total, idempotencyKey: key });

      expect(theirs.status).toBe(404);
      expect(JSON.stringify(theirs.body)).not.toContain(mine.body.payment.id);
      // and company A's money is untouched by the attempt
      const rows = await prisma.payment.findMany({ where: { orderId: o.id } });
      expect(rows.length).toBe(1);
      expect(Number(rows[0].amount)).toBeCloseTo(total, 2);
    });

    // A replay collected nothing, so it must not leave a row that a report
    // would add up as a collection. The retry is still recorded — a till
    // retrying is worth seeing — under an action of its own.
    it('a replay is audited as a replay, not as a second collection', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const key = 'retry-audit-0001';
      await pay(o.id, { method: 'CARD', amount: total, idempotencyKey: key });
      await pay(o.id, { method: 'CARD', amount: total, idempotencyKey: key });

      const logs = await prisma.posAuditLog.findMany({
        where: { entityId: o.id, action: { in: ['ORDER_PAYMENT', 'ORDER_PAYMENT_REPLAY'] } },
      });
      const collected = logs.filter((l) => l.action === 'ORDER_PAYMENT');
      const replays = logs.filter((l) => l.action === 'ORDER_PAYMENT_REPLAY');
      expect(collected.length, 'one collection audited').toBe(1);
      expect(replays.length, 'the retry is visible').toBe(1);
      expect(replays[0].meta.amount, 'a replay carries no amount to sum').toBeUndefined();
    });

    // The route's replay lookup is what makes a retry pleasant. This is what
    // makes it safe: the database refuses the second row outright, so a bug
    // in that lookup costs the cashier an error message, not the customer a
    // second charge. Verified by disabling the lookup and re-running this
    // block — the partial retry came back 500 with one row in the table
    // instead of 201 with two — and asserted here so the backstop cannot be
    // dropped by a later schema edit without something going red.
    it('the database itself refuses a second row under one key', async () => {
      const o = await takeaway();
      const total = Number((await bill(o.id)).total);
      const first = await pay(o.id, {
        method: 'CARD',
        amount: half(total),
        idempotencyKey: 'db-backstop-0001',
      });
      expect(first.status).toBe(201);

      await expect(
        prisma.payment.create({
          data: {
            orderId: o.id,
            branchId: branchA1.id,
            method: 'CARD',
            amount: '1.00',
            idempotencyKey: 'db-backstop-0001',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      // …while NULL keys stay exempt, which is what lets every pre-existing
      // row and every gateway payment go on coexisting.
      const a = await prisma.payment.create({
        data: { orderId: o.id, branchId: branchA1.id, method: 'CASH', amount: '1.00' },
      });
      const b = await prisma.payment.create({
        data: { orderId: o.id, branchId: branchA1.id, method: 'CASH', amount: '1.00' },
      });
      expect(a.idempotencyKey).toBeNull();
      expect(b.idempotencyKey).toBeNull();
    });
  });
});

describe('order isolation and ATC read-only', () => {
  let a1Order;

  it('pinned roles are forced onto their own branch', async () => {
    const res = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', branchId: branchA2.id, items: [{ productId: cat.cappuccino }] });
    expect(res.status).toBe(201);
    expect(res.body.order.branchId).toBe(branchA1.id);
    a1Order = res.body.order.id;
  });

  it('cross-company order ids answer 404, same as absent', async () => {
    const cross = await request(app).get(`/api/orders/${a1Order}`).set(auth(tokens.ownerB));
    const absent = await request(app).get('/api/orders/nonexistent-id').set(auth(tokens.ownerB));
    expect(cross.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(cross.body.error.code).toBe(absent.body.error.code);
  });

  it('a sibling-branch order is forbidden for pinned roles, and hidden from their lists', async () => {
    const a2 = await request(app).post('/api/orders').set(auth(tokens.ownerA))
      .send({ type: 'TAKEAWAY', branchId: branchA2.id, items: [{ productId: cat.cappuccino }] });
    expect(a2.status).toBe(201);
    const denied = await request(app).get(`/api/orders/${a2.body.order.id}`).set(auth(tokens.cashierA1));
    expect(denied.status).toBe(403);
    const list = await request(app).get('/api/orders?pageSize=100').set(auth(tokens.cashierA1));
    expect(list.status).toBe(200);
    expect(list.body.orders.every((o) => o.branchId === branchA1.id)).toBe(true);
    const ownerList = await request(app).get('/api/orders?pageSize=100').set(auth(tokens.ownerA));
    expect(ownerList.body.orders.some((o) => o.branchId === branchA2.id)).toBe(true);
  });

  it('ATC reads orders with a company scope but cannot operate', async () => {
    const list = await request(app).get(`/api/orders?companyId=${companyA.id}`).set(auth(tokens.atc));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThan(0);
    const create = await request(app).post(`/api/orders?companyId=${companyA.id}`).set(auth(tokens.atc))
      .send({ type: 'TAKEAWAY', branchId: branchA1.id, items: [{ productId: cat.cappuccino }] });
    expect(create.status).toBe(403);
    const pay = await request(app).post(`/api/orders/${a1Order}/payments?companyId=${companyA.id}`)
      .set(auth(tokens.atc)).send({ method: 'CASH', tendered: 100 });
    expect(pay.status).toBe(403);
  });
});

describe('sales report', () => {
  it('cashier is refused', async () => {
    const res = await request(app).get('/api/reports/sales?from=2026-01-01&to=2026-01-02').set(auth(tokens.cashierA1));
    expect(res.status).toBe(403);
  });

  it('manager report covers today and carries the manual-payments note', async () => {
    const today = istDateOf(new Date());
    const res = await request(app).get(`/api/reports/sales?from=${today}&to=${today}`).set(auth(tokens.managerA1));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body.report;
    expect(report.branchId).toBe(branchA1.id);
    expect(report.currency).toBe('INR');
    // The §6 flagship order (675.36) is PAID and billed today.
    expect(report.sales.netSales).toBeGreaterThanOrEqual(675.36);
    expect(report.sales.collected).toBeGreaterThanOrEqual(675.36);
    expect(report.sales.refunds).toBeGreaterThanOrEqual(289);
    expect(report.orders.paid).toBeGreaterThanOrEqual(2);
    expect(report.orders.voided).toBeGreaterThanOrEqual(1);
    const cash = report.byMethod.find((m) => m.method === 'CASH');
    expect(cash.channel).toBe('MANUAL');
    expect(cash.count).toBeGreaterThanOrEqual(2);
    const coffee = report.byCategory.find((c) => c.name === 'Coffee');
    expect(coffee.qty).toBeGreaterThanOrEqual(3);
    expect(report.byDay.some((d) => d.date === today)).toBe(true);
    // This suite runs with no provider configured, which is the shipped state.
    expect(report.note).toBe(
      'All payments are manual records: no payment provider is configured on this deployment.',
    );
    expect(report.byChannel).toEqual([
      expect.objectContaining({ channel: 'MANUAL' }),
    ]);
  });

  it('owner scopes by branch; unknown branch answers 404', async () => {
    const today = istDateOf(new Date());
    const res = await request(app).get(`/api/reports/sales?from=${today}&to=${today}&branchId=${branchA2.id}`)
      .set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.report.branchId).toBe(branchA2.id);
    const foreign = await request(app).get(`/api/reports/sales?from=${today}&to=${today}&branchId=${branchB1.id}`)
      .set(auth(tokens.ownerA));
    expect(foreign.status).toBe(404);
  });
});

// Daily closing. The one report that carries a number the POS did not
// compute, so it is the only one that can contradict the POS.
describe('daily closing', () => {
  const today = istDateOf(new Date());
  const preview = (token, qs = '') =>
    request(app).get(`/api/reports/day-close/preview?date=${today}${qs}`).set(auth(token));

  it('a cashier may see the expected drawer but may not close the day', async () => {
    const seen = await preview(tokens.cashierA1);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.preview.branchId).toBe(branchA1.id);

    const closed = await request(app).post('/api/reports/day-close').set(auth(tokens.cashierA1))
      .send({ date: today, countedCash: 100 });
    expect(closed.status).toBe(403);
  });

  it('expected cash counts manual cash only, never card, UPI or gateway', async () => {
    const res = await preview(tokens.managerA1);
    expect(res.status).toBe(200);
    const p = res.body.preview;
    // The §6 flagship order was settled in cash and partly refunded, and the
    // transitions block added more cash. The exact figure is not the point —
    // what matters is that expected = cash in − cash refunds out, and that
    // the non-cash buckets are reported beside it rather than folded into it.
    expect(p.expectedCash).toBeCloseTo(p.cashSales - p.cashRefunds, 2);
    expect(p.cashSales).toBeGreaterThan(0);
    expect(typeof p.openOrders).toBe('number');
    expect(p.note).toMatch(/opening float/i);

    // Asserting gatewaySales === 0 here would pass with the channel test
    // inverted, because this suite configures no provider. So plant a
    // GATEWAY payment and a GATEWAY refund on a real order and check they
    // land in the buckets that do NOT touch the drawer. Getting this wrong
    // is not a reporting nicety: it would tell a cashier to produce card
    // money in cash, every evening, and call them short when they could not.
    const o = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', items: [{ productId: cat.cappuccino, qty: 1 }] });
    const orderId = o.body.order.id;
    await request(app).post(`/api/orders/${orderId}/bill`).set(auth(tokens.cashierA1)).send({}).expect(200);
    await prisma.payment.create({
      data: {
        orderId, branchId: branchA1.id, method: 'CARD', channel: 'GATEWAY',
        // Stated because the database now requires channel and entrySource to
        // agree. A GATEWAY row is one the provider confirmed; leaving it at
        // the MANUAL_ENTRY default would have the row claim a cashier typed a
        // payment nobody typed.
        entrySource: 'PROVIDER_CONFIRMED',
        amount: '500.00', providerRef: `pay_probe_${Date.now()}`,
      },
    });
    const mgr = await prisma.posUser.findFirst({ where: { branchId: branchA1.id, role: 'BRANCH_MANAGER' } });
    await prisma.refund.create({
      data: { orderId, amount: '100.00', channel: 'GATEWAY', status: 'SUCCEEDED', reason: 'probe', byId: mgr.id },
    });

    const after = (await preview(tokens.managerA1)).body.preview;
    expect(after.gatewaySales).toBeCloseTo(p.gatewaySales + 500, 2);
    expect(after.cashSales).toBeCloseTo(p.cashSales, 2);
    expect(after.cardSales).toBeCloseTo(p.cardSales, 2);
    // The gateway refund did not come out of this till either.
    expect(after.cashRefunds).toBeCloseTo(p.cashRefunds, 2);
    expect(after.expectedCash).toBeCloseTo(p.expectedCash, 2);
  });

  const billedCappuccino = async () => {
    const o = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', items: [{ productId: cat.cappuccino, qty: 1 }] });
    const billed = await request(app).post(`/api/orders/${o.body.order.id}/bill`)
      .set(auth(tokens.cashierA1)).send({}).expect(200);
    return billed.body.order;
  };
  const payOn = (orderId, body) =>
    request(app).post(`/api/orders/${orderId}/payments`).set(auth(tokens.cashierA1)).send(body);
  const refundOn = (orderId, body) =>
    request(app).post(`/api/orders/${orderId}/refunds`).set(auth(tokens.managerA1)).send(body);

  it('a refund goes back the way the bill was paid, and a split bill has to say which way', async () => {
    const card = await billedCappuccino();
    await payOn(card.id, { method: 'CARD', amount: card.total }).expect(201);
    const inferred = await refundOn(card.id, { amount: 10, reason: 'froth was cold' });
    expect(inferred.status, JSON.stringify(inferred.body)).toBe(201);
    expect(inferred.body.refund.method).toBe('CARD');
    // A card bill can still be settled in notes when the terminal cannot
    // reverse it; the manager says so and the record says what happened.
    const overridden = await refundOn(card.id, { amount: 5, reason: 'terminal offline', method: 'CASH' });
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(201);
    expect(overridden.body.refund.method).toBe('CASH');

    const split = await billedCappuccino();
    const part = await payOn(split.id, { method: 'CARD', amount: 50 });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    await payOn(split.id, { method: 'CASH', tendered: part.body.order.amountDue }).expect(201);
    const unsaid = await refundOn(split.id, { amount: 10, reason: 'wrong milk' });
    expect(unsaid.status, JSON.stringify(unsaid.body)).toBe(400);
    expect(unsaid.body.error.field).toBe('method');
    // Nothing was written on the refusal.
    expect(await prisma.refund.count({ where: { orderId: split.id } })).toBe(0);
    const said = await refundOn(split.id, { amount: 10, reason: 'wrong milk', method: 'CASH' });
    expect(said.status, JSON.stringify(said.body)).toBe(201);
    expect(said.body.refund.method).toBe('CASH');
  });

  // The drawer only loses what was handed back in notes. Before Refund.method,
  // every manual refund was subtracted here, so reversing a card bill on the
  // terminal made an honest count read "over" by the refunded amount.
  it('only a refund handed back in cash comes out of the expected drawer', async () => {
    const p = (await preview(tokens.managerA1)).body.preview;

    const card = await billedCappuccino();
    await payOn(card.id, { method: 'CARD', amount: card.total }).expect(201);
    await refundOn(card.id, { amount: card.total, reason: 'reversed on the terminal' }).expect(201);
    const afterCard = (await preview(tokens.managerA1)).body.preview;
    expect(afterCard.cardSales).toBeCloseTo(p.cardSales + card.total, 2);
    expect(afterCard.cashRefunds).toBeCloseTo(p.cashRefunds, 2);
    expect(afterCard.expectedCash).toBeCloseTo(p.expectedCash, 2);

    const cash = await billedCappuccino();
    await payOn(cash.id, { method: 'CASH', tendered: cash.total }).expect(201);
    await refundOn(cash.id, { amount: 40, reason: 'spilled the cup' }).expect(201);
    const afterCash = (await preview(tokens.managerA1)).body.preview;
    expect(afterCash.cashRefunds).toBeCloseTo(afterCard.cashRefunds + 40, 2);
    expect(afterCash.expectedCash).toBeCloseTo(afterCard.expectedCash + cash.total - 40, 2);

    // A manual refund written before the column existed has no method. It is
    // read as cash — what every closing filed before this change assumed — so
    // no past figure moves.
    const mgr = await prisma.posUser.findFirst({ where: { branchId: branchA1.id, role: 'BRANCH_MANAGER' } });
    await prisma.refund.create({
      data: { orderId: cash.id, amount: '15.00', channel: 'MANUAL', status: 'SUCCEEDED', reason: 'legacy row', byId: mgr.id },
    });
    const afterLegacy = (await preview(tokens.managerA1)).body.preview;
    expect(afterLegacy.cashRefunds).toBeCloseTo(afterCash.cashRefunds + 15, 2);
    expect(afterLegacy.expectedCash).toBeCloseTo(afterCash.expectedCash - 15, 2);
  });

  it('a variance must be explained before it can be filed', async () => {
    const p = (await preview(tokens.managerA1)).body.preview;
    const short = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({ date: today, countedCash: p.expectedCash - 50 });
    expect(short.status).toBe(400);
    expect(short.body.error.field).toBe('note');
    expect(short.body.error.message).toMatch(/short/i);

    const over = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({ date: today, countedCash: p.expectedCash + 50 });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/over/i);
  });

  it('a balanced count is filed, and the float is not mistaken for a surplus', async () => {
    const p = (await preview(tokens.managerA1)).body.preview;
    // Counting the float along with the takings is what actually happens at a
    // till. Declared separately, it must not register as money found.
    const res = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({ date: today, countedCash: p.expectedCash + 2000, openingFloat: 2000 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.close.variance).toBe(0);
    expect(res.body.close.expectedCash).toBeCloseTo(p.expectedCash, 2);
    expect(res.body.close.closedBy.id).toBeTruthy();
    expect(res.body.close.isCorrection).toBe(false);
  });

  it('a second closing needs to say which one it corrects', async () => {
    const p = (await preview(tokens.managerA1)).body.preview;
    const blind = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({ date: today, countedCash: p.expectedCash });
    expect(blind.status).toBe(409);
    expect(blind.body.error.message).toMatch(/already closed/i);

    const existing = (await preview(tokens.managerA1)).body.existingClose;
    expect(existing).toBeTruthy();
    const stale = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({ date: today, countedCash: p.expectedCash, correctsId: 'some-other-id' });
    expect(stale.status).toBe(409);

    const fixed = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({
        date: today,
        countedCash: p.expectedCash - 100,
        note: 'recount: 100 was still in the tip jar',
        correctsId: existing.id,
      });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(201);
    expect(fixed.body.close.isCorrection).toBe(true);
    expect(fixed.body.close.variance).toBeCloseTo(-100, 2);
  });

  it('history shows the correction and hides what it replaced, unless asked', async () => {
    const list = await request(app).get(`/api/reports/day-close?from=${today}&to=${today}`)
      .set(auth(tokens.managerA1));
    expect(list.status).toBe(200);
    expect(list.body.closes.length).toBe(1);
    expect(list.body.closes[0].isCorrection).toBe(true);
    expect(list.body.totals.shortDays).toBe(1);

    const all = await request(app).get(`/api/reports/day-close?from=${today}&to=${today}&includeSuperseded=true`)
      .set(auth(tokens.managerA1));
    expect(all.body.closes.length).toBe(2);
    // The replaced row is still readable, and says so.
    expect(all.body.closes.some((c) => c.superseded)).toBe(true);
  });

  it('ATC may read a closing but may never declare one', async () => {
    const read = await request(app)
      .get(`/api/reports/day-close?from=${today}&to=${today}&companyId=${companyA.id}`)
      .set(auth(tokens.atc));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.closes.length).toBeGreaterThan(0);
    const write = await request(app).post(`/api/reports/day-close?companyId=${companyA.id}`)
      .set(auth(tokens.atc))
      .send({ date: today, branchId: branchA1.id, countedCash: 0 });
    expect(write.status).toBe(403);
  });

  it('an owner must name a branch, and cannot reach another company\'s', async () => {
    const vague = await request(app).get(`/api/reports/day-close/preview?date=${today}`).set(auth(tokens.ownerA));
    expect(vague.status).toBe(400);
    expect(vague.body.error.field).toBe('branchId');

    const foreign = await request(app)
      .get(`/api/reports/day-close/preview?date=${today}&branchId=${branchB1.id}`).set(auth(tokens.ownerA));
    expect(foreign.status).toBe(404);
  });

  it('a day that has not happened cannot be closed', async () => {
    const future = istDateOf(new Date(Date.now() + 3 * 86400e3));
    const res = await request(app).post('/api/reports/day-close').set(auth(tokens.managerA1))
      .send({ date: future, countedCash: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('date');
  });

  // A closing is a snapshot taken at a moment; the IST day runs to midnight
  // regardless. So money taken after the count lands on a day already
  // declared, and because the stored figures are frozen on purpose, the
  // closing quietly stops describing its own day.
  //
  // Nothing below is blocked. Refusing a payment at 22:05 teaches a cashier to
  // take the cash and not record it, and unrecorded cash is the worse failure
  // by a distance. The closing is only made to say what happened after it.
  it('a closing says when money landed on the day after it was counted', async () => {
    // Negative control FIRST, and it is the whole reason this test is worth
    // anything: the correction filed above is the current closing and nothing
    // has happened since, so a clean day must report nothing. Without it,
    // "postClose is present" would pass for code that always reports activity.
    const before = (await preview(tokens.managerA1)).body.existingClose;
    expect(before).toBeTruthy();
    expect(before.postClose).toBe(null);
    const quiet = await request(app).get(`/api/reports/day-close?from=${today}&to=${today}`)
      .set(auth(tokens.managerA1));
    expect(quiet.body.closes[0].postClose).toBe(null);
    expect(quiet.body.totals.staleDays).toBe(0);

    // Now take cash after the count, the way a late customer does.
    const o = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', items: [{ productId: cat.cappuccino, qty: 1 }] });
    const orderId = o.body.order.id;
    const billed = await request(app).post(`/api/orders/${orderId}/bill`)
      .set(auth(tokens.cashierA1)).send({});
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    const paid = await request(app).post(`/api/orders/${orderId}/payments`)
      .set(auth(tokens.cashierA1)).send({ method: 'CASH', tendered: 1000 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const took = Number(paid.body.payment.amount);
    expect(took).toBeGreaterThan(0);

    const after = (await preview(tokens.managerA1)).body.existingClose;
    expect(after.postClose).toBeTruthy();
    expect(after.postClose.payments).toBe(1);
    expect(after.postClose.ordersBilled).toBe(1);
    // The number a person acts on: the drawer now holds this much more than
    // the filed closing says it should.
    expect(after.postClose.expectedCashDelta).toBeCloseTo(took, 2);
    expect(after.postClose.cashTaken).toBeCloseTo(took, 2);
    expect(new Date(after.postClose.lastAt).getTime())
      .toBeGreaterThan(new Date(after.closedAt).getTime());

    // The filed record itself must NOT have moved. Freezing the figures is the
    // whole point of a closing — if these drifted, the correction trail would
    // be rewriting history rather than recording it, and this check is what
    // separates "reported the drift" from "absorbed the drift".
    expect(after.expectedCash).toBeCloseTo(before.expectedCash, 2);
    expect(after.variance).toBeCloseTo(before.variance, 2);
    expect(after.id).toBe(before.id);

    const stale = await request(app).get(`/api/reports/day-close?from=${today}&to=${today}`)
      .set(auth(tokens.managerA1));
    expect(stale.body.totals.staleDays).toBe(1);
  });

  it('a gateway payment after the count does not move the expected drawer', async () => {
    // The channel-before-method rule, which dayFigures already guards. This
    // code repeats that rule in a second place, and a rule stated twice is a
    // rule that can disagree with itself — so it needs its own check. Getting
    // it wrong here would tell a manager to find card money in the till.
    const start = (await preview(tokens.managerA1)).body.existingClose.postClose;
    const o = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', items: [{ productId: cat.cappuccino, qty: 1 }] });
    const orderId = o.body.order.id;
    await request(app).post(`/api/orders/${orderId}/bill`).set(auth(tokens.cashierA1)).send({}).expect(200);
    await prisma.payment.create({
      data: {
        orderId, branchId: branchA1.id, method: 'CARD', channel: 'GATEWAY',
        entrySource: 'PROVIDER_CONFIRMED',
        amount: '250.00', providerRef: `pay_post_${Date.now()}`,
      },
    });

    const p = (await preview(tokens.managerA1)).body.existingClose.postClose;
    expect(p.payments).toBe(start.payments + 1);
    expect(p.nonCashTaken).toBeCloseTo(start.nonCashTaken + 250, 2);
    // The drawer is untouched: this money never entered it.
    expect(p.expectedCashDelta).toBeCloseTo(start.expectedCashDelta, 2);
    expect(p.cashTaken).toBeCloseTo(start.cashTaken, 2);
  });

  // The refund half of postCloseFor had no test until this one, and it is the
  // half where being wrong costs money in a specific direction:
  // expectedCashDelta is `cashTaken - cashRefunded`, so flipping that one
  // operator reports the drawer as UP after cash was handed back, and sends a
  // manager hunting for money that was paid out. The screens render whatever
  // this returns, and the render harness feeds itself a fixture — so nothing
  // else in the project would catch it.
  //
  // Every assertion is a DELTA against the step before it. Two earlier tests
  // in this block have already left activity on this day, so an absolute
  // figure here would be asserting the fixture rather than the behaviour.
  it('a refund after the count moves the drawer DOWN, and only a settled one counts', async () => {
    const pc = async () => (await preview(tokens.managerA1)).body.existingClose.postClose;
    const manager = await prisma.posUser.findUnique({ where: { email: 'manager.a1@test.local' } });

    const o = await request(app).post('/api/orders').set(auth(tokens.cashierA1))
      .send({ type: 'TAKEAWAY', items: [{ productId: cat.cappuccino, qty: 1 }] });
    const orderId = o.body.order.id;
    await request(app).post(`/api/orders/${orderId}/bill`).set(auth(tokens.cashierA1)).send({}).expect(200);
    const paid = await request(app).post(`/api/orders/${orderId}/payments`)
      .set(auth(tokens.cashierA1)).send({ method: 'CASH', tendered: 1000 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const took = Number(paid.body.payment.amount);
    const afterPay = await pc();

    // 1. Cash handed back across the counter.
    const back = 40;
    expect(took).toBeGreaterThan(back);
    const refunded = await request(app).post(`/api/orders/${orderId}/refunds`)
      .set(auth(tokens.managerA1)).send({ amount: back, reason: 'spilled the cup' });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);
    const afterRefund = await pc();

    expect(afterRefund.refunds).toBe(afterPay.refunds + 1);
    expect(afterRefund.cashRefunded).toBeCloseTo(afterPay.cashRefunded + back, 2);
    // The sign, stated twice on purpose: once as an exact figure, once as a
    // direction. The exact form alone would still pass if both sides were
    // negated together.
    expect(afterRefund.expectedCashDelta).toBeCloseTo(afterPay.expectedCashDelta - back, 2);
    expect(afterRefund.expectedCashDelta).toBeLessThan(afterPay.expectedCashDelta);
    // Money taken and money returned are separate figures. A refund must not
    // quietly reduce takings — the day still sold what it sold.
    expect(afterRefund.cashTaken).toBeCloseTo(afterPay.cashTaken, 2);

    // 2. A gateway refund returns money that was never in this drawer. It is
    //    real activity, so it counts, but it must not move a cash figure.
    await prisma.refund.create({
      data: {
        orderId, amount: '30.00', reason: 'reversed at the provider', channel: 'GATEWAY',
        status: 'SUCCEEDED', byId: manager.id, providerRef: `rfnd_post_${Date.now()}`,
      },
    });
    const afterGateway = await pc();
    expect(afterGateway.refunds).toBe(afterRefund.refunds + 1);
    expect(afterGateway.cashRefunded).toBeCloseTo(afterRefund.cashRefunded, 2);
    expect(afterGateway.expectedCashDelta).toBeCloseTo(afterRefund.expectedCashDelta, 2);

    // 3. A PENDING refund is a request the provider has not honoured yet.
    //    schema.prisma says in prose that such a row "must never be shown,
    //    totalled or reported as money returned". This is the line that makes
    //    that prose enforceable: nothing may move, not even the count.
    await prisma.refund.create({
      data: {
        orderId, amount: '25.00', reason: 'awaiting the provider', channel: 'GATEWAY',
        status: 'PENDING', byId: manager.id,
      },
    });
    const afterPending = await pc();
    expect(afterPending.refunds).toBe(afterGateway.refunds);
    expect(afterPending.cashRefunded).toBeCloseTo(afterGateway.cashRefunded, 2);
    expect(afterPending.expectedCashDelta).toBeCloseTo(afterGateway.expectedCashDelta, 2);
  });
});

// The activity report. "PosAuditLog" has been written since the first release
// and, until this route, read by nothing in the product — so the handover pack
// could say discounts are recorded against the person who applied them, which
// sounds like a control an owner can check, while no owner could check it.
//
// These tests are the difference between recorded and visible, and the two
// that matter most are the ones that produce a WRONG NUMBER rather than an
// error when they break: counting a quantity edit as a discount, and matching
// refunds against a list of names instead of a prefix.
describe('activity report — who discounted, who voided, who refunded', () => {
  const today = istDateOf(new Date());
  const activity = (token, qs = '') =>
    request(app)
      .get(`/api/reports/activity?from=${today}&to=${today}${qs}`)
      .set(auth(token));

  // An order on Alpha's OTHER branch, so the same fixture proves both the
  // discount/quantity split and the branch filter.
  let a2Order, a2Item;

  it('cashier is refused, exactly as on the sales report', async () => {
    const res = await activity(tokens.cashierA1);
    expect(res.status).toBe(403);
  });

  it('a quantity change is not a discount, though both write the same action', async () => {
    const created = await request(app).post('/api/orders').set(auth(tokens.ownerA))
      .send({ type: 'TAKEAWAY', branchId: branchA2.id, items: [{ productId: cat.cappuccino, qty: 2 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    a2Order = created.body.order.id;
    a2Item = created.body.order.items[0].id;

    // Two edits through the same endpoint, emitting the same ORDER_ITEM_UPDATE.
    // Only the second one gave money away.
    const qtyEdit = await request(app).patch(`/api/orders/${a2Order}/items/${a2Item}`)
      .set(auth(tokens.ownerA)).send({ qty: 3 });
    expect(qtyEdit.status, JSON.stringify(qtyEdit.body)).toBe(200);
    const discountEdit = await request(app).patch(`/api/orders/${a2Order}/items/${a2Item}`)
      .set(auth(tokens.ownerA)).send({ lineDiscount: 15 });
    expect(discountEdit.status, JSON.stringify(discountEdit.body)).toBe(200);

    // The control. Without it this test still passes when NEITHER edit is
    // recorded, which is the failure that would matter most.
    expect(
      await prisma.posAuditLog.count({ where: { action: 'ORDER_ITEM_UPDATE', entityId: a2Order } }),
    ).toBe(2);

    const res = await activity(tokens.ownerA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mine = res.body.events.filter((e) => e.orderId === a2Order);
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe('discount');
    expect(mine[0].detail.lineDiscount).toBe(15);
    expect(mine[0].actorEmail).toBe('owner.a@test.local');
    expect(mine[0].actorName).toBe('Owner A');
  });

  it('taking a discount back off is not giving another one', async () => {
    // Set an order discount, then remove it. Nothing was given away, but both
    // edits carry the same name. Folded together they read as two discounts —
    // inflating the one figure an owner acts on, and inflating it against the
    // person who CORRECTED the mistake. deploy/audit-queries.sql keeps
    // `cleared` in its own column; this holds the screen to the same shape.
    const set = await request(app).post(`/api/orders/${a2Order}/discount`)
      .set(auth(tokens.ownerA)).send({ type: 'PERCENT', value: 10 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const undo = await request(app).delete(`/api/orders/${a2Order}/discount`)
      .set(auth(tokens.ownerA));
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);

    const res = await activity(tokens.ownerA, `&branchId=${branchA2.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const kinds = res.body.events.filter((e) => e.orderId === a2Order).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'cleared')).toHaveLength(1);
    // The line discount from the previous test, plus the order discount just
    // set. The removal is NOT among them.
    expect(kinds.filter((k) => k === 'discount')).toHaveLength(2);

    // The summary has to agree with the list it summarises. This pair is what
    // reddens if the removal is folded back into `discounts`.
    const owner = res.body.byActor.find((x) => x.actorEmail === 'owner.a@test.local');
    expect(owner.cleared).toBe(1);
    expect(owner.discounts).toBe(2);
  });

  it('a manager sees their own branch; the owner sees both', async () => {
    const manager = await activity(tokens.managerA1);
    expect(manager.status, JSON.stringify(manager.body)).toBe(200);
    expect(manager.body.range.branchId).toBe(branchA1.id);
    // The branch came from the token, not the query string: asking for the
    // sibling branch must not move a pinned role off their own.
    const pushed = await activity(tokens.managerA1, `&branchId=${branchA2.id}`);
    expect(pushed.body.range.branchId).toBe(branchA1.id);
    expect(pushed.body.events.some((e) => e.orderId === a2Order)).toBe(false);

    // Positive control: the manager is not simply seeing nothing.
    expect(manager.body.events.length).toBeGreaterThan(0);
    expect(manager.body.events.some((e) => e.orderId === a2Order)).toBe(false);

    const scoped = await activity(tokens.ownerA, `&branchId=${branchA2.id}`);
    expect(scoped.body.events.some((e) => e.orderId === a2Order)).toBe(true);
    expect(scoped.body.events.every((e) => e.orderId === a2Order)).toBe(true);

    const foreign = await activity(tokens.ownerA, `&branchId=${branchB1.id}`);
    expect(foreign.status).toBe(404);
  });

  it('one company never appears in another, in either direction', async () => {
    // Bravo has no orders of its own, so without a row of its own this would
    // compare an empty list against a full one and pass for the wrong reason.
    const strayB = await prisma.posAuditLog.create({
      data: {
        companyId: companyB.id, action: 'ORDER_VOID', entity: 'Order',
        entityId: 'bravo-order-not-in-alpha', actorEmail: 'owner.b@test.local',
        meta: { reason: 'wrong table', invoiceNumber: 'B1-000001' },
      },
    });

    const a = await activity(tokens.ownerA);
    const b = await activity(tokens.ownerB);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.events.length).toBeGreaterThan(0);

    const bIds = b.body.events.map((e) => e.id);
    expect(bIds).toContain(strayB.id);
    expect(a.body.events.map((e) => e.id)).not.toContain(strayB.id);
    expect(a.body.events.some((e) => bIds.includes(e.id))).toBe(false);
    // Alpha's cashier and manager are not named anywhere in Bravo's answer.
    expect(b.body.byActor.map((x) => x.actorEmail)).toEqual(['owner.b@test.local']);
  });

  it('counts every stage of a gateway refund, not only the name production has emitted', async () => {
    // The same defect this fixed in deploy/audit-queries.sql, pinned here so it
    // cannot come back. A refund emits a different action per channel and per
    // stage — ORDER_REFUND manually, then _REQUESTED / _SETTLED / _FAILED /
    // _RECONCILED through a gateway. Production has never produced the gateway
    // ones, so no amount of looking at real data would reveal a filter that
    // drops them; the rows are written directly for that reason.
    const stages = [
      'ORDER_REFUND_REQUESTED',
      'ORDER_REFUND_SETTLED',
      'ORDER_REFUND_FAILED',
      'ORDER_REFUND_RECONCILED',
    ];
    for (const action of stages) {
      await prisma.posAuditLog.create({
        data: {
          companyId: companyA.id, action, entity: 'Order', entityId: a2Order,
          actorEmail: 'manager.a1@test.local',
          meta: { amount: '10.00', channel: 'GATEWAY', status: 'PENDING', providerConfirmed: false },
        },
      });
    }

    const res = await activity(tokens.ownerA, `&branchId=${branchA2.id}`);
    expect(res.status).toBe(200);
    const seen = res.body.events.filter((e) => e.kind === 'refund').map((e) => e.action);
    expect(seen.sort()).toEqual([...stages].sort());
    // providerConfirmed survives to the screen: a refund a person asserted is
    // not the same fact as one a provider confirmed.
    const settled = res.body.events.find((e) => e.action === 'ORDER_REFUND_SETTLED');
    expect(settled.detail.providerConfirmed).toBe(false);
    expect(settled.detail.channel).toBe('GATEWAY');

    // Every count on this screen is a floor, never a total: audit() swallows
    // its own write failures so a customer's bill can never fail because of
    // logging. The flag saying so is part of the response contract.
    expect(res.body.bestEffort).toBe(true);
    expect(res.body.truncated).toBe(false);
  });

  it('attributes each kind to the person, and keeps ATC out of a tenant it did not scope', async () => {
    const res = await activity(tokens.ownerA);
    expect(res.status).toBe(200);
    const byActor = res.body.byActor;
    expect(byActor.length).toBeGreaterThan(0);
    // Sorted busiest first — the whole point of the screen is that one name
    // stands out, not that a total is large.
    expect(byActor.map((x) => x.total)).toEqual([...byActor.map((x) => x.total)].sort((x, y) => y - x));
    for (const row of byActor) {
      // Every kind has to land in a counter. A kind added to kindOf with no
      // field in KIND_FIELD would drop out of this sum rather than show up
      // anywhere, which is how a whole category goes missing quietly.
      expect(row.discounts + row.cleared + row.voids + row.refunds).toBe(row.total);
    }
    // The §6 worked example ran on the cashier's login, so the cashier must be
    // named here even though the cashier may not open this screen.
    const cashier = byActor.find((x) => x.actorEmail === 'cashier.a1@test.local');
    expect(cashier.discounts).toBeGreaterThan(0);
    expect(cashier.role).toBe('CASHIER');
    expect(cashier.stillActive).toBe(true);

    // ATC reads with an explicit company scope, like every other report.
    const atc = await request(app)
      .get(`/api/reports/activity?from=${today}&to=${today}&companyId=${companyA.id}`)
      .set(auth(tokens.atc));
    expect(atc.status, JSON.stringify(atc.body)).toBe(200);
    expect(atc.body.events.length).toBe(res.body.events.length);
  });

  it('refuses a backwards range rather than answering with nothing', async () => {
    const res = await request(app)
      .get(`/api/reports/activity?from=${today}&to=2020-01-01`)
      .set(auth(tokens.ownerA));
    expect(res.status).toBe(400);
  });
});
