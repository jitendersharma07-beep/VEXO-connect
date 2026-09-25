// Store Agent printing: one-time enrolment, credentialed heartbeat, scoped
// target selection (pass vs station printers), idempotent enqueue, atomic
// claim with claimToken replay, retry/backoff to FAILED, lease expiry to
// UNCERTAIN (never auto-retried), audited reprint with a required reason and
// human resolution. CONFIRMED is the ceiling — nothing here claims paper.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('printJobs.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { ORDER_INCLUDE } = await import('../src/lib/orders.js');

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
  // whose schema had no promotions or modifiers, so its wipe had no statement
  // for them. On the shared test database that is not optional:
  // OrderItemModifier_orderItemId_fkey is RESTRICT, so one residue row from
  // catalogModifiers or promotions makes the orderItem delete below throw in
  // beforeAll and takes all 26 tests in this file with it.
  //
  // It was latent rather than absent before. Vitest orders files by size
  // descending; this file sat at position 14 behind discountSettings, and
  // nothing ahead of it left modifier rows. The two new tests grew the file,
  // which moved it to position 8 directly behind promotions, and the same
  // unchanged wipe then threw. File size is not a contract, so the wipe is
  // completed here rather than left to depend on where the file lands.
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
let company, branch, burgerId, saladId;
let grillId, coldId; // stations: Grill (default), Cold prep
let agentId, agentCred; // Bearer <agentId>.<secret>
let receiptTargetId, passTargetId, grillTargetId;
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const agentAuth = () => ({ Authorization: `Bearer ${agentCred}` });

const newOrderWithKot = async (productIds) => {
  const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', items: productIds.map((productId) => ({ productId, qty: 1 })) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const kot = await request(app).post(`/api/orders/${created.body.order.id}/kot`)
    .set(auth(tokens.cashier)).send({});
  expect(kot.status, JSON.stringify(kot.body)).toBe(201);
  return { order: created.body.order, kot: kot.body.kot };
};

const enqueue = (body, token = tokens.cashier) =>
  request(app).post('/api/print-jobs').set(auth(token)).send(body);

const claim = (claimToken, max) =>
  request(app).post('/api/print-agents/jobs/claim').set(agentAuth())
    .send({ claimToken, ...(max ? { max } : {}) });

const report = (jobId, body) =>
  request(app).post(`/api/print-agents/jobs/${jobId}/report`).set(agentAuth()).send(body);

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  company = await prisma.company.create({
    data: {
      name: 'Print Cafe',
      slug: 'print-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  // publicId is required and unique since the foundation lane landed — the
  // store identity a human reads out over the phone. This lane's fixtures were
  // written before that column existed, so they are given one here rather than
  // the column being made optional.
  branch = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-PJ-0001', name: 'Main', code: 'P1' },
  });
  const mk = (email, fullName, role) =>
    prisma.posUser.create({ data: { email, fullName, role, companyId: company.id, branchId: branch.id, passwordHash } });
  await mk('owner@p.test', 'Print Owner', 'CUSTOMER_OWNER');
  await mk('till@p.test', 'Print Till', 'CASHIER');

  const tax = await prisma.taxRate.create({
    data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const food = await prisma.category.create({ data: { companyId: company.id, name: 'Food', sortOrder: 1 } });
  const mkProduct = async (name) =>
    (await prisma.product.create({
      data: { companyId: company.id, categoryId: food.id, name, basePrice: '100.00', taxRateId: tax.id },
    })).id;
  burgerId = await mkProduct('Burger');
  saladId = await mkProduct('Salad');

  tokens.owner = await login('owner@p.test');
  tokens.cashier = await login('till@p.test');

  // Grill is the default station; Salad routes to Cold prep.
  const grill = await request(app).post('/api/kitchen/stations').set(auth(tokens.owner))
    .send({ name: 'Grill', isDefault: true, sortOrder: 0 });
  expect(grill.status, JSON.stringify(grill.body)).toBe(201);
  grillId = grill.body.station.id;
  const cold = await request(app).post('/api/kitchen/stations').set(auth(tokens.owner))
    .send({ name: 'Cold prep', sortOrder: 1 });
  expect(cold.status).toBe(201);
  coldId = cold.body.station.id;
  expect((await request(app).post('/api/kitchen/routes').set(auth(tokens.owner))
    .send({ stationId: coldId, productId: saladId })).status).toBe(201);
});

afterAll(async () => {
  // Leave nothing behind: PrintTarget.stationId RESTRICTs station deletion,
  // so a later file's branch wipe would fail on this file's leftovers.
  await wipe();
  await prisma.$disconnect();
});

describe('agent enrolment and identity', () => {
  let enrolCode;

  it('manager creates an agent and receives a one-time enrol code', async () => {
    const res = await request(app).post('/api/print-agents').set(auth(tokens.owner))
      .send({ name: 'Counter PC' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.enrolCode).toMatch(/^pae_/);
    expect(res.body.agent.status).toBe('PENDING');
    agentId = res.body.agent.id;
    enrolCode = res.body.enrolCode;
    const row = await prisma.printAgent.findUnique({ where: { id: agentId } });
    expect(row.enrolCodeHash).not.toBe(enrolCode); // hash only, never plaintext
  });

  it('cashier cannot create agents', async () => {
    const res = await request(app).post('/api/print-agents').set(auth(tokens.cashier))
      .send({ name: 'Rogue' });
    expect(res.status).toBe(403);
  });

  it('a wrong code is rejected', async () => {
    const res = await request(app).post('/api/print-agents/enrol')
      .send({ code: 'pae_definitely-not-issued' });
    expect(res.status).toBe(400);
  });

  it('the code enrols exactly once and yields the secret exactly once', async () => {
    const first = await request(app).post('/api/print-agents/enrol')
      .send({ code: enrolCode, platform: 'linux', agentVersion: '0.1.0', hostname: 'till-1' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.agentId).toBe(agentId);
    expect(first.body.secret).toMatch(/^pas_/);
    agentCred = `${first.body.agentId}.${first.body.secret}`;

    const again = await request(app).post('/api/print-agents/enrol').send({ code: enrolCode });
    expect(again.status).toBe(400);

    const row = await prisma.printAgent.findUnique({ where: { id: agentId } });
    expect(row.status).toBe('ACTIVE');
    expect(row.enrolCodeHash).toBeNull();
    expect(row.credentialHash).not.toBeNull();
    expect(row.credentialHash).not.toContain('pas_');
  });

  it('heartbeat records lastSeenAt and health; the list derives online', async () => {
    const beat = await request(app).post('/api/print-agents/heartbeat').set(agentAuth())
      .send({ health: { queueDepth: 0, printers: { pass: 'reachable' } } });
    expect(beat.status).toBe(204);
    const list = await request(app).get('/api/print-agents').set(auth(tokens.owner));
    expect(list.status).toBe(200);
    const me = list.body.agents.find((a) => a.id === agentId);
    expect(me.online).toBe(true);
    expect(me.health).toEqual({ queueDepth: 0, printers: { pass: 'reachable' } });
  });

  it('a bad credential is a 401', async () => {
    const res = await request(app).post('/api/print-agents/heartbeat')
      .set({ Authorization: `Bearer ${agentId}.pas_wrong` }).send({});
    expect(res.status).toBe(401);
  });

  it('targets: receipt, pass KOT printer, and a Grill station printer', async () => {
    const mkTarget = async (body) => {
      const res = await request(app).post(`/api/print-agents/${agentId}/targets`)
        .set(auth(tokens.owner)).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.target.id;
    };
    receiptTargetId = await mkTarget({ name: 'Front receipt', purpose: 'RECEIPT', transport: 'TCP', host: '10.0.0.10' });
    passTargetId = await mkTarget({ name: 'Pass', purpose: 'KOT', transport: 'TCP', host: '10.0.0.11' });
    grillTargetId = await mkTarget({ name: 'Grill printer', purpose: 'KOT', stationId: grillId, transport: 'TCP', host: '10.0.0.12' });

    const noHost = await request(app).post(`/api/print-agents/${agentId}/targets`)
      .set(auth(tokens.owner)).send({ name: 'Bad', purpose: 'KOT', transport: 'TCP' });
    expect(noHost.status).toBe(400);
    const stationOnReceipt = await request(app).post(`/api/print-agents/${agentId}/targets`)
      .set(auth(tokens.owner)).send({ name: 'Bad', purpose: 'RECEIPT', stationId: grillId, transport: 'TCP', host: 'x' });
    expect(stationOnReceipt.status).toBe(400);
  });
});

describe('enqueue: scoping, dedupe, receipt gate', () => {
  it('a Burger KOT reaches the pass printer and the Grill printer, not Cold', async () => {
    const { order, kot } = await newOrderWithKot([burgerId]);
    const res = await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.queued).toBe(2);
    const targetIds = res.body.jobs.map((j) => j.targetId).sort();
    expect(targetIds).toEqual([grillTargetId, passTargetId].sort());
    for (const j of res.body.jobs) expect(j.status).toBe('QUEUED');
  });

  it('the same request again dedupes to the same jobs', async () => {
    const { order, kot } = await newOrderWithKot([burgerId]);
    const first = await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    expect(first.body.queued).toBe(2);
    const second = await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    expect(second.status).toBe(201);
    expect(second.body.queued).toBe(0);
    expect(second.body.jobs.every((j) => j.deduped)).toBe(true);
    expect(second.body.jobs.map((j) => j.id).sort())
      .toEqual(first.body.jobs.map((j) => j.id).sort());
  });

  it('a Salad-only KOT skips the Grill printer', async () => {
    const { order, kot } = await newOrderWithKot([saladId]);
    const res = await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    expect(res.body.queued).toBe(1);
    expect(res.body.jobs[0].targetId).toBe(passTargetId);
  });

  it('receipts exist only after billing', async () => {
    const { order } = await newOrderWithKot([burgerId]);
    const early = await enqueue({ orderId: order.id, kind: 'RECEIPT' });
    expect(early.status).toBe(409);
    const bill = await request(app).post(`/api/orders/${order.id}/bill`)
      .set(auth(tokens.cashier)).send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const res = await enqueue({ orderId: order.id, kind: 'RECEIPT' });
    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(1);
    expect(res.body.jobs[0].targetId).toBe(receiptTargetId);
    const row = await prisma.printJob.findUnique({ where: { id: res.body.jobs[0].id } });
    expect(row.document.invoiceNumber).toBeTruthy(); // the billed receipt, not a KOT
  });

  it('a foreign company cannot print this order', async () => {
    const passwordHash = await hashPassword(PW);
    const other = await prisma.company.create({
      data: {
        name: 'Other Co', slug: 'other-co-print',
        licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
      },
    });
    const ob = await prisma.branch.create({ data: { companyId: other.id, publicId: 'VC-PJ-0002', name: 'O', code: 'O1' } });
    await prisma.posUser.create({
      data: { email: 'owner@o.test', fullName: 'O', role: 'CUSTOMER_OWNER', companyId: other.id, branchId: ob.id, passwordHash },
    });
    const foreign = await login('owner@o.test');
    const { order, kot } = await newOrderWithKot([burgerId]);
    const res = await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id }, foreign);
    expect(res.status).toBe(404);
  });
});

describe('printed documents carry the truth (pre-hardware checklist)', () => {
  // The server renders documents; the agent renders paper. These tests pin
  // the DOCUMENT half of the checklist: totals, tax breakup, discounts,
  // notes, and the wrap parameters the agent needs. Character wrapping, cut
  // and drawer-kick EFFECTS are hardware acceptance — not provable here.

  it('a billed receipt document carries items, discount, tax breakup and totals', async () => {
    await prisma.discountPolicy.create({ data: {
      companyId: company.id, level: 'COMPANY', scopeKey: 'company',
      allowLineDiscount: true, allowOrderDiscount: true,
      maxPercent: '15.000', note: 'checklist fixture' } });
    const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
      .send({ type: 'TAKEAWAY', items: [{ productId: burgerId, qty: 2 }, { productId: saladId, qty: 1 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.order.id;
    const disc = await request(app).post(`/api/orders/${orderId}/discount`)
      .set(auth(tokens.cashier)).send({ type: 'PERCENT', value: 10 });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);
    const bill = await request(app).post(`/api/orders/${orderId}/bill`)
      .set(auth(tokens.cashier)).send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const order = bill.body.order;
    // §6 money engine, tax-exclusive: 300 − 10% = 270 taxable, 5% GST.
    expect(order.subtotal).toBe(300);
    expect(order.discountAmount).toBe(30);
    expect(order.taxAmount).toBe(13.5);
    expect(order.total).toBe(283.5);

    const res = await enqueue({ orderId, kind: 'RECEIPT' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.queued).toBe(1);
    const row = await prisma.printJob.findUnique({ where: { id: res.body.jobs[0].id } });
    const doc = row.document;
    expect(doc.invoiceNumber).toBe(order.invoiceNumber);
    expect(doc.company.name).toBe('Print Cafe');
    expect(doc.branch).toMatchObject({ name: 'Main', code: 'P1' });
    expect(doc.order.cashier).toBe('Print Till');
    expect(doc.order.type).toBe('TAKEAWAY');
    expect(doc.items).toHaveLength(2);
    expect(doc.items.find((i) => i.name === 'Burger'))
      .toMatchObject({ qty: 2, unitPrice: 100, lineDiscount: 0, amount: 200 });
    expect(doc.items.find((i) => i.name === 'Salad'))
      .toMatchObject({ qty: 1, unitPrice: 100, amount: 100 });
    expect(doc.subtotal).toBe(order.subtotal);
    expect(doc.discountAmount).toBe(order.discountAmount);
    expect(doc.taxBreakup).toEqual([{ name: 'GST 5%', percent: 5, taxable: 270, tax: 13.5 }]);
    expect(doc.taxBreakup.reduce((a, b) => a + b.tax, 0)).toBe(order.taxAmount);
    expect(doc.total).toBe(order.total);
    expect(doc.payments).toEqual([]);
    expect(doc.amountPaid).toBe(0);
    expect(doc.amountDue).toBe(order.total);
    expect(doc.refunds).toEqual([]);
  });

  // The zero-state half of the test above is the control for this one: the same
  // four fields, asserted empty when no money has moved. Together they show the
  // document reports collection rather than defaulting to either shape.
  it('a paid receipt document carries each tender, its change, and the refund', async () => {
    const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
      .send({ type: 'TAKEAWAY', items: [{ productId: burgerId, qty: 2 }, { productId: saladId, qty: 1 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.order.id;
    const bill = await request(app).post(`/api/orders/${orderId}/bill`)
      .set(auth(tokens.cashier)).send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.order.total).toBe(315); // 300 + 5% GST, no discount

    // Split deliberately: CARD stores no tendered, CASH does. They are the two
    // branches of the receipt's change-due calculation, and change printed wrong
    // is a dispute at the counter.
    const card = await request(app).post(`/api/orders/${orderId}/payments`)
      .set(auth(tokens.cashier)).send({ method: 'CARD', amount: 115 });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    const cash = await request(app).post(`/api/orders/${orderId}/payments`)
      .set(auth(tokens.cashier)).send({ method: 'CASH', tendered: 250 });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.order.status).toBe('PAID');
    expect(cash.body.changeDue).toBe(50); // 250 handed over against 200 still due

    // Split bills have no single tender to infer, so the method is explicit.
    const refund = await request(app).post(`/api/orders/${orderId}/refunds`)
      .set(auth(tokens.owner)).send({ amount: 40, reason: 'salad sent back', method: 'CASH' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);

    const res = await enqueue({ orderId, kind: 'RECEIPT' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await prisma.printJob.findUnique({ where: { id: res.body.jobs[0].id } });
    const doc = row.document;

    // Found by method, not by index: payments are ordered on createdAt alone,
    // with no id tie-break, so two tenders inside one millisecond have no
    // defined print order.
    expect(doc.payments).toHaveLength(2);
    expect(doc.payments.find((p) => p.method === 'CARD')).toEqual({
      method: 'CARD', channel: 'MANUAL', amount: 115, tendered: null, changeDue: null,
      label: 'MANUAL PAYMENT RECORD — not gateway-verified',
    });
    expect(doc.payments.find((p) => p.method === 'CASH')).toEqual({
      method: 'CASH', channel: 'MANUAL', amount: 200, tendered: 250, changeDue: 50,
      label: 'MANUAL PAYMENT RECORD — not gateway-verified',
    });
    expect(doc.amountPaid).toBe(315);

    expect(doc.refunds).toHaveLength(1);
    expect(doc.refunds[0]).toMatchObject({
      amount: 40, reason: 'salad sent back', status: 'SUCCEEDED', channel: 'MANUAL',
      label: 'REFUND HANDED BACK — recorded by staff',
    });

    // Not 40. amountDue is what is still owed on the bill, and the bill was
    // settled in full; the ₹40 back is its own line. Letting the refund reopen
    // the balance would hand the customer paper saying they still owe it.
    expect(doc.amountDue).toBe(0);
    expect(doc.total).toBe(315);
  });

  // The test above finds its tenders by method precisely because their print
  // order was undefined. This one removes that excuse.
  //
  // Payment.createdAt is TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP. Postgres
  // evaluates CURRENT_TIMESTAMP once per transaction, so a tie is not a thought
  // experiment — it is guaranteed for rows written together, and millisecond
  // precision allows it for rows that merely land close.
  //
  // Both conditions below are forced, and the second one is the point. Written
  // the obvious way — tie the timestamps, expect ascending id — this test passes
  // with NO tie-break at all: Postgres hands back the two rows in insertion
  // order, and Prisma's cuid is time-prefixed, so ascending id and insertion
  // order are the same sequence. Measured, not assumed: on `createdAt` alone it
  // was green. So the ids are rewritten to disagree with insertion order, which
  // is the only arrangement in which the ORDER BY is observable at all.
  it('two tenders sharing a createdAt still print in one defined, repeatable order', async () => {
    const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
      .send({ type: 'TAKEAWAY', items: [{ productId: burgerId, qty: 2 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.order.id;
    const bill = await request(app).post(`/api/orders/${orderId}/bill`)
      .set(auth(tokens.cashier)).send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    const total = bill.body.order.total;

    // Through the route, so these are real payments: receivedBy set, order
    // driven to PAID, amounts applied against the bill.
    const first = await request(app).post(`/api/orders/${orderId}/payments`)
      .set(auth(tokens.cashier)).send({ method: 'CARD', amount: 100 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await request(app).post(`/api/orders/${orderId}/payments`)
      .set(auth(tokens.cashier)).send({ method: 'UPI', amount: total - 100 });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.order.status).toBe('PAID');

    const card = await prisma.payment.findFirstOrThrow({ where: { orderId, method: 'CARD' } });
    const upi = await prisma.payment.findFirstOrThrow({ where: { orderId, method: 'UPI' } });

    // One instant for both, as a single transaction would have produced, and
    // ids that run opposite to the order they were inserted in: UPI went in
    // second and now sorts first. Nothing FK-references Payment.id — no
    // `REFERENCES "Payment"` exists in any migration — so rewriting it here
    // rearranges nothing else.
    const tie = new Date('2026-09-24T12:00:00.000Z');
    const LOW = 'zz-tie-aaa-sorts-first';
    const HIGH = 'zz-tie-zzz-sorts-second';
    // HIGH is rewritten first on purpose. An UPDATE writes a new row version at
    // the end of the heap, so the rewrite order becomes the physical order, and
    // an unordered read follows it. Doing LOW first lines the heap up with
    // ascending id and the assertion below passes with no tie-break at all —
    // observed, not theorised.
    await prisma.payment.update({ where: { id: card.id }, data: { id: HIGH, createdAt: tie } });
    await prisma.payment.update({ where: { id: upi.id }, data: { id: LOW, createdAt: tie } });

    const tied = await prisma.payment.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
    expect(tied).toHaveLength(2);
    expect(tied[0].createdAt.getTime()).toBe(tied[1].createdAt.getTime());
    // The discriminator: ascending id must now be the reverse of insertion
    // order, or this test is back to proving nothing.
    expect(tied.map((p) => p.method)).toEqual(['UPI', 'CARD']);

    // Ascending id is the declared tie-break, so that is the order both readers
    // must show. Asserted against ids, not methods: with only two tenders a
    // method assertion passes on a coin flip half the time.
    const expectedIds = tied.map((p) => p.id);

    // Read twice. A single read cannot distinguish a defined order from a
    // coincidence — Postgres may return either row first when nothing breaks the
    // tie, and will often be consistent about it within one plan. The pairing is
    // what carries the claim: the ids fix WHICH order is correct, the repeat
    // shows it was not luck.
    const reads = [];
    for (let i = 0; i < 2; i += 1) {
      const got = await request(app).get(`/api/orders/${orderId}`).set(auth(tokens.cashier));
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      reads.push(got.body.order.payments.map((p) => p.id));
    }
    expect(reads[0]).toEqual(expectedIds);
    expect(reads[1]).toEqual(expectedIds);

    // The receipt is the customer-visible half, and it drops the ids — so map
    // the expected ids to their methods and assert the printed sequence.
    const methodOf = new Map(tied.map((p) => [p.id, p.method]));
    const expectedMethods = expectedIds.map((id) => methodOf.get(id));
    expect(new Set(expectedMethods).size).toBe(2); // the sequence can distinguish an order at all

    const receipt = await request(app).get(`/api/orders/${orderId}/receipt`).set(auth(tokens.cashier));
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body.receipt.payments.map((p) => p.method)).toEqual(expectedMethods);

    // And the document actually queued for the printer, which is the artifact
    // the customer ends up holding.
    const job = await enqueue({ orderId, kind: 'RECEIPT' });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    const row = await prisma.printJob.findUnique({ where: { id: job.body.jobs[0].id } });
    expect(row.document.payments.map((p) => p.method)).toEqual(expectedMethods);

    // The tie-break reorders rows; it must not revalue them. A stable print
    // order bought at the cost of a wrong total would be a bad trade.
    expect(row.document.amountPaid).toBe(total);
    expect(row.document.amountDue).toBe(0);
    expect(row.document.total).toBe(total);
  });

  // The behavioural test above needs help to fail. Without the tie-break it
  // returns whatever order the read happens to produce, and that order is not
  // stable across circumstances: with the two id rewrites applied in the other
  // sequence it came back ascending anyway and the test was green on the
  // unfixed code. The rewrite sequence is now chosen to make it RED, but that
  // RED rests on heap layout — an implementation detail no test should depend
  // on for its safety value.
  //
  // So assert the declaration itself. This cannot be satisfied by luck: drop
  // the tie-break and it fails on the next run, whatever the planner decides.
  // The two tests answer different questions — this one that the rule is
  // declared, the one above that the declared rule reaches the paper.
  it('the order include declares a tie-break for payments and refunds, not createdAt alone', () => {
    const tieBroken = [{ createdAt: 'asc' }, { id: 'asc' }];
    expect(ORDER_INCLUDE.payments.orderBy).toEqual(tieBroken);
    expect(ORDER_INCLUDE.refunds.orderBy).toEqual(tieBroken);
    // items already did this; payments and refunds were the outliers.
    expect(ORDER_INCLUDE.items.orderBy).toEqual(tieBroken);
  });

  it('a KOT document carries the order note and per-line notes', async () => {
    const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
      .send({ type: 'TAKEAWAY', note: 'serve together',
        items: [{ productId: burgerId, qty: 1 }, { productId: saladId, qty: 1 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.order.id;
    // No API writes item notes yet (schema field, writer pending) — set it
    // the way a future till will, so the ticket contract is pinned now.
    await prisma.orderItem.updateMany({
      where: { orderId, productId: burgerId }, data: { note: 'no onions' },
    });
    const kot = await request(app).post(`/api/orders/${orderId}/kot`)
      .set(auth(tokens.cashier)).send({});
    expect(kot.status, JSON.stringify(kot.body)).toBe(201);
    const res = await enqueue({ orderId, kind: 'KOT', kotId: kot.body.kot.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.queued).toBe(2); // pass + Grill (Cold has no printer)
    const row = await prisma.printJob.findUnique({ where: { id: res.body.jobs[0].id } });
    const doc = row.document;
    expect(doc.seq).toBe(1);
    expect(doc.type).toBe('TAKEAWAY');
    expect(doc.note).toBe('serve together');
    expect(doc.items.map((i) => i.name).sort()).toEqual(['Burger', 'Salad']);
    expect(doc.items.find((i) => i.name === 'Burger').note).toBe('no onions');
    expect(doc.items.find((i) => i.name === 'Salad').note).toBeNull();
  });

  it('the claim hands the agent its wrap parameters with the document', async () => {
    await prisma.printTarget.update({ where: { id: receiptTargetId }, data: { widthChars: 42 } });
    const mine = await prisma.printJob.findFirst({
      where: { targetId: receiptTargetId, status: 'QUEUED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(mine).not.toBeNull();
    // Park everything, then make ONLY this job due (never blanket-unpark).
    await prisma.printJob.updateMany({
      where: { status: 'QUEUED' },
      data: { nextAttemptAt: new Date(Date.now() + 3600e3) },
    });
    await prisma.printJob.update({ where: { id: mine.id }, data: { nextAttemptAt: new Date() } });
    const c = await claim('tok-checklist-width');
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.jobs).toHaveLength(1);
    const j = c.body.jobs[0];
    expect(j.id).toBe(mine.id);
    // The agent wraps/cuts/kicks from these — the software half of the
    // paper-size checklist row.
    expect(j.target).toMatchObject({ widthChars: 42, cut: true, drawerKick: false });
    expect(j.document.invoiceNumber).toBeTruthy();
    const done = await report(j.id, { ok: true, detail: { bytes: 2048 } });
    expect(done.body.status).toBe('CONFIRMED');
  });

  it('asking again for the same reprint returns the same job, never a 500', async () => {
    const source = await prisma.printJob.findFirst({
      where: { status: 'CONFIRMED', targetId: receiptTargetId },
    });
    expect(source).not.toBeNull();
    const first = await request(app).post(`/api/print-jobs/${source.id}/reprint`)
      .set(auth(tokens.cashier)).send({ reason: 'customer wants a copy' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await request(app).post(`/api/print-jobs/${source.id}/reprint`)
      .set(auth(tokens.cashier)).send({ reason: 'customer wants a copy' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.job.id).toBe(first.body.job.id);
  });
});

describe('claim, report, retry and the truth rules', () => {
  const drain = async () => {
    // Park everything currently due so a test starts from an empty queue.
    await prisma.printJob.updateMany({
      where: { status: 'QUEUED' },
      data: { nextAttemptAt: new Date(Date.now() + 3600e3) },
    });
  };

  it('claim dispatches atomically; the same claimToken replays the same batch', async () => {
    await drain();
    const { order, kot } = await newOrderWithKot([burgerId]);
    await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });

    const first = await claim('tok-claim-1');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(first.body.jobs).toHaveLength(2);
    expect(first.body.jobs[0].target.host).toBeTruthy();
    expect(first.body.jobs[0].attempts).toBe(1);

    const replay = await claim('tok-claim-1');
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.jobs.map((j) => j.id).sort())
      .toEqual(first.body.jobs.map((j) => j.id).sort());

    const fresh = await claim('tok-claim-2');
    expect(fresh.body.replayed).toBe(false);
    expect(fresh.body.jobs).toHaveLength(0);
  });

  it('ok report confirms — the ceiling, not a paper claim', async () => {
    await drain();
    const { order, kot } = await newOrderWithKot([saladId]);
    await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    const c = await claim('tok-ok-1');
    const jobId = c.body.jobs[0].id;
    const r = await report(jobId, { ok: true, detail: { bytes: 512 } });
    expect(r.body.status).toBe('CONFIRMED');
    const row = await prisma.printJob.findUnique({ where: { id: jobId } });
    expect(row.completedAt).not.toBeNull();
    expect(row.lastReport.ok).toBe(true);
    expect(row.claimToken).toBeNull();
  });

  it('failure retries with backoff, then FAILED at maxAttempts', async () => {
    await drain();
    const { order, kot } = await newOrderWithKot([saladId]);
    const enq = await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    expect(enq.body.queued, JSON.stringify(enq.body)).toBe(1);
    const myJobId = enq.body.jobs[0].id;

    let jobId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Make THIS job due, by id — a blanket QUEUED update un-parks other
      // tests' drained jobs and the capped claim returns those instead.
      await prisma.printJob.update({
        where: { id: myJobId }, data: { nextAttemptAt: new Date() },
      });
      const c = await claim(`tok-fail-${attempt}`);
      expect(c.body.jobs, `attempt ${attempt}`).toHaveLength(1);
      jobId = c.body.jobs[0].id;
      expect(c.body.jobs[0].attempts).toBe(attempt);
      const r = await report(jobId, { ok: false, error: `printer offline (${attempt})` });
      if (attempt < 3) {
        expect(r.body.status).toBe('QUEUED');
        const row = await prisma.printJob.findUnique({ where: { id: jobId } });
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        expect(row.lastError).toContain('printer offline');
      } else {
        expect(r.body.status).toBe('FAILED');
      }
    }
    const final = await prisma.printJob.findUnique({ where: { id: jobId } });
    expect(final.status).toBe('FAILED');
    expect(final.attempts).toBe(3);
  });

  it('an expired lease becomes UNCERTAIN and is never re-queued', async () => {
    await drain();
    const { order, kot } = await newOrderWithKot([saladId]);
    await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    const c = await claim('tok-lease-1');
    const jobId = c.body.jobs[0].id;
    await prisma.printJob.update({
      where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    // Any sweep-bearing read surfaces the truth.
    const list = await request(app).get('/api/print-jobs?status=UNCERTAIN').set(auth(tokens.owner));
    expect(list.status).toBe(200);
    expect(list.body.jobs.map((j) => j.id)).toContain(jobId);

    // A later claim must NOT pick it up: a second KOT is a second dish.
    const again = await claim('tok-lease-2');
    expect(again.body.jobs.map((j) => j.id)).not.toContain(jobId);

    // The agent's late report is recorded but changes nothing.
    const late = await report(jobId, { ok: true });
    expect(late.status).toBe(200);
    expect(late.body.status).toBe('UNCERTAIN');
    const row = await prisma.printJob.findUnique({ where: { id: jobId } });
    expect(row.status).toBe('UNCERTAIN');
    expect(row.lastReport.ok).toBe(true);
  });

  it('reprint requires a reason, links the source, resolves it, and audits the actor', async () => {
    const source = await prisma.printJob.findFirst({ where: { status: 'UNCERTAIN' } });
    expect(source).not.toBeNull();

    const bare = await request(app).post(`/api/print-jobs/${source.id}/reprint`)
      .set(auth(tokens.cashier)).send({});
    expect(bare.status).toBe(400);

    const res = await request(app).post(`/api/print-jobs/${source.id}/reprint`)
      .set(auth(tokens.cashier)).send({ reason: 'ticket never came out at the pass' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.job.reprintOfId).toBe(source.id);
    expect(res.body.job.reason).toBe('ticket never came out at the pass');
    expect(res.body.job.status).toBe('QUEUED');

    const src = await prisma.printJob.findUnique({ where: { id: source.id } });
    expect(src.resolution).toBe('REPRINTED');
    expect(src.resolvedById).not.toBeNull();

    const auditRow = await prisma.posAuditLog.findFirst({
      where: { action: 'PRINT_JOB_REPRINT', entityId: res.body.job.id },
      orderBy: { at: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow.meta.reason).toBe('ticket never came out at the pass');
    expect(auditRow.meta.reprintOf).toBe(source.id);
  });

  it('resolve records human judgement once, on UNCERTAIN/FAILED only', async () => {
    await drain();
    const { order, kot } = await newOrderWithKot([saladId]);
    await enqueue({ orderId: order.id, kind: 'KOT', kotId: kot.id });
    const c = await claim('tok-resolve-1');
    const jobId = c.body.jobs[0].id;
    await prisma.printJob.update({
      where: { id: jobId }, data: { status: 'UNCERTAIN', leaseExpiresAt: null },
    });

    const ok = await request(app).post(`/api/print-jobs/${jobId}/resolve`)
      .set(auth(tokens.owner)).send({ resolution: 'CONFIRMED_BY_STAFF' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.job.resolution).toBe('CONFIRMED_BY_STAFF');

    const twice = await request(app).post(`/api/print-jobs/${jobId}/resolve`)
      .set(auth(tokens.owner)).send({ resolution: 'DISMISSED' });
    expect(twice.status).toBe(409);

    const confirmed = await prisma.printJob.findFirst({ where: { status: 'CONFIRMED' } });
    const wrongState = await request(app).post(`/api/print-jobs/${confirmed.id}/resolve`)
      .set(auth(tokens.owner)).send({ resolution: 'DISMISSED' });
    expect(wrongState.status).toBe(409);
  });

  it('revoking the agent kills its credential', async () => {
    const res = await request(app).post(`/api/print-agents/${agentId}/revoke`)
      .set(auth(tokens.owner)).send({});
    expect(res.status).toBe(204);
    const beat = await request(app).post('/api/print-agents/heartbeat').set(agentAuth()).send({});
    expect(beat.status).toBe(401);
  });
});
