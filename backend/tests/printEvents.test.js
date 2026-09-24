// Print-request audit (Window 3 finding, 2026-09-24). Viewing a receipt or
// KOT (the GETs) is deliberately unaudited; the explicit Print click posts
// /orders/:id/print-events, which writes ORDER_PRINT_REQUESTED. The action
// says REQUESTED because the browser print path has no delivery status — a
// row here is not evidence of paper.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('printEvents.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const wipe = async () => {
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
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
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
let company, companyB, branch, branchB, coffee;
const tokens = {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const newOrder = async () => {
  const created = await request(app)
    .post('/api/orders')
    .set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', items: [{ productId: coffee, qty: 1 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.order;
};

const bill = async (id) => {
  const res = await request(app).post(`/api/orders/${id}/bill`).set(auth(tokens.cashier)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
};

const printEvent = (id, body, token = tokens.cashier) =>
  request(app).post(`/api/orders/${id}/print-events`).set(auth(token)).send(body);

const auditRows = (orderId) =>
  prisma.posAuditLog.findMany({
    where: { action: 'ORDER_PRINT_REQUESTED', entityId: orderId },
    orderBy: { createdAt: 'asc' },
  });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const mkCompany = (name, slug) =>
    prisma.company.create({
      data: {
        name,
        slug,
        licenses: {
          create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
        },
      },
    });
  company = await mkCompany('Print Cafe', 'print-cafe');
  companyB = await mkCompany('Other Diner', 'other-diner');
  branch = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-PE-0001', name: 'Main', code: 'M1' },
  });
  branchB = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-PE-0002', name: 'Other', code: 'O1' },
  });
  const mk = (email, fullName, role, companyId, branchId = null) =>
    prisma.posUser.create({ data: { email, fullName, role, companyId, branchId, passwordHash } });
  await mk('till@p.test', 'Print Till', 'CASHIER', company.id, branch.id);
  await mk('till@o.test', 'Other Till', 'CASHIER', companyB.id, branchB.id);

  const tax = await prisma.taxRate.create({
    data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const cat = await prisma.category.create({
    data: { companyId: company.id, name: 'Drinks', sortOrder: 1 },
  });
  coffee = (
    await prisma.product.create({
      data: { companyId: company.id, categoryId: cat.id, name: 'Coffee', basePrice: '500.00', taxRateId: tax.id },
    })
  ).id;

  tokens.cashier = await login('till@p.test');
  tokens.other = await login('till@o.test');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('print-request audit', () => {
  it('viewing the receipt writes no audit row; the explicit print event writes one per click', async () => {
    const o = await newOrder();
    await bill(o.id);

    // Viewing — the reprint path the UI reads — stays unaudited.
    const view = await request(app).get(`/api/orders/${o.id}/receipt`).set(auth(tokens.cashier));
    expect(view.status).toBe(200);
    expect(await auditRows(o.id)).toHaveLength(0);

    // Two explicit print clicks: two rows, so reprints are countable.
    expect((await printEvent(o.id, { document: 'RECEIPT' })).status).toBe(204);
    expect((await printEvent(o.id, { document: 'RECEIPT' })).status).toBe(204);
    const rows = await auditRows(o.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].meta).toMatchObject({ document: 'RECEIPT' });
    expect(rows[0].actorEmail).toBe('till@p.test');
  });

  it('a KOT print event records the document and kot seq', async () => {
    const o = await newOrder();
    const kot = await request(app).post(`/api/orders/${o.id}/kot`).set(auth(tokens.cashier)).send({});
    expect(kot.status, JSON.stringify(kot.body)).toBe(201);

    expect((await printEvent(o.id, { document: 'KOT', kotSeq: kot.body.kot.seq })).status).toBe(204);
    const rows = await auditRows(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ document: 'KOT', kotSeq: kot.body.kot.seq });
  });

  it('refuses a RECEIPT print event before billing — a receipt that cannot exist cannot be printed', async () => {
    const o = await newOrder();
    const res = await printEvent(o.id, { document: 'RECEIPT' });
    expect(res.status).toBe(409);
    expect(await auditRows(o.id)).toHaveLength(0);
  });

  it('rejects a malformed document and a foreign company order', async () => {
    const o = await newOrder();
    await bill(o.id);
    expect((await printEvent(o.id, { document: 'INVOICE' })).status).toBe(400);
    expect((await printEvent(o.id, { document: 'RECEIPT' }, tokens.other)).status).toBe(404);
    expect(await auditRows(o.id)).toHaveLength(0);
  });
});
