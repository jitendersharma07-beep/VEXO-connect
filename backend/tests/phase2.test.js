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
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  // Before Order: PaymentIntent references it ON DELETE RESTRICT, so an
  // order delete fails outright once any intent exists.
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
  branchA1 = await prisma.branch.create({ data: { companyId: companyA.id, name: 'Alpha One', code: 'A1' } });
  branchA2 = await prisma.branch.create({ data: { companyId: companyA.id, name: 'Alpha Two', code: 'A2' } });
  branchB1 = await prisma.branch.create({ data: { companyId: companyB.id, name: 'Bravo One', code: 'B1' } });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'atc@test.local', fullName: 'ATC Admin', role: 'POS_SUPER_ADMIN' });
  await mk({ email: 'owner.a@test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  await mk({ email: 'manager.a1@test.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id });
  await mk({ email: 'cashier.a1@test.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id });
  await mk({ email: 'owner.b@test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });
  await mk({ email: 'owner.c@test.local', fullName: 'Owner C', role: 'CUSTOMER_OWNER', companyId: companyC.id });

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
