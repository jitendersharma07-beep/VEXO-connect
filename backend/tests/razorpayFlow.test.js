// The Razorpay adapter through the whole stack: HTTP route, database, money.
//
// tests/razorpay.test.js proves the adapter speaks Razorpay's protocol.
// This proves the protocol is wired to the money correctly — that a captured
// payment becomes refundable, that a refusal and a silence are handled
// differently, and that no ordering of webhooks pays a customer twice.
//
// Razorpay itself is a stub on loopback. NO SANDBOX CALL IS MADE and no key
// exists here; a green run is evidence about this codebase, not about a
// Razorpay account.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import crypto from 'node:crypto';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('razorpayFlow.test.js requires a DATABASE_URL ending in _test');
}

// The stub must be listening before config/env.js is read, or the adapter
// holds the default base URL and these tests call the real api.razorpay.com.
const routes = [];
const calls = [];
let fallback = null;

const stub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://stub.invalid');
    calls.push({ method: req.method, path: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const handler = routes.shift() || fallback;
    if (!handler) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { description: 'stub had no queued answer' } }));
    }
    const out = handler({ method: req.method, path: url.pathname, res });
    if (out === undefined) return;
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

process.env.POS_GATEWAY_PROVIDER = 'razorpay';
process.env.POS_GATEWAY_WEBHOOK_SECRET = 'razorpay-flow-webhook-secret-not-real';
process.env.POS_GATEWAY_KEY_ID = 'rzp_test_0000000000fake';
process.env.POS_GATEWAY_KEY_SECRET = 'not-a-real-key-secret-000000';
process.env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = '300';
process.env.POS_GATEWAY_TIMEOUT_MS = '1200';
process.env.POS_GATEWAY_API_BASE = `http://127.0.0.1:${stub.address().port}`;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { SIGNATURE_HEADER, EVENT_ID_HEADER } = await import('../src/lib/gateway/razorpay.js');

const app = createApp();
const SECRET = process.env.POS_GATEWAY_WEBHOOK_SECRET;

const answer = (status, body) => () => ({ status, body });
const queue = (...h) => routes.push(...h);

// --- Razorpay-shaped fixtures -----------------------------------------------

let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(6, '0')}fake`;

const orderBody = (amount, id) => ({
  id, entity: 'order', amount, amount_paid: 0, amount_due: amount,
  currency: 'INR', receipt: 'r', status: 'created', attempts: 0, notes: {},
  created_at: Math.floor(Date.now() / 1000),
});

const refundBody = (amount, id, paymentId) => ({
  id, entity: 'refund', amount, currency: 'INR', payment_id: paymentId,
  notes: {}, receipt: null, acquirer_data: {}, status: 'processed',
  speed_processed: 'normal', speed_requested: 'normal',
  created_at: Math.floor(Date.now() / 1000),
});

const captured = (orderRef, payRef, amount, event = 'payment.captured') => ({
  entity: 'event', account_id: 'acc_fake', event, contains: ['payment'],
  payload: {
    payment: {
      entity: {
        id: payRef, entity: 'payment', amount, currency: 'INR',
        status: event === 'payment.failed' ? 'failed' : 'captured',
        order_id: orderRef, method: 'upi', captured: event === 'payment.captured',
        notes: {}, fee: 0, tax: 0, created_at: Math.floor(Date.now() / 1000),
      },
    },
  },
  created_at: Math.floor(Date.now() / 1000),
});

const refundOutcome = (refundRef, payRef, amount, event = 'refund.processed') => ({
  entity: 'event', account_id: 'acc_fake', event, contains: ['refund'],
  payload: { refund: { entity: refundBody(amount, refundRef, payRef) } },
  created_at: Math.floor(Date.now() / 1000),
});

// Sends the exact bytes Razorpay would, signed the way Razorpay signs them.
// The body goes as a STRING: supertest re-serialises a Buffer under a JSON
// content type, which would change the very bytes the signature covers.
const deliver = (payload, { secret = SECRET, eventId = nextId('evt_') } = {}) => {
  const raw = JSON.stringify(payload);
  return request(app)
    .post('/api/gateway/webhook')
    .set(SIGNATURE_HEADER, crypto.createHmac('sha256', secret).update(raw).digest('hex'))
    .set(EVENT_ID_HEADER, eventId)
    .set('Content-Type', 'application/json')
    .send(raw);
};

// --- tenant fixtures --------------------------------------------------------

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
let productId;

const wipe = async () => {
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
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

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const company = await prisma.company.create({
    data: {
      name: 'Razor Cafe', slug: 'razor-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  const branch = await prisma.branch.create({ data: { companyId: company.id, name: 'Rz One', code: 'Z1' } });
  const mk = (d) => prisma.posUser.create({ data: { passwordHash, ...d } });
  await mk({ email: 'owner.z@test.local', fullName: 'Owner Z', role: 'CUSTOMER_OWNER', companyId: company.id });
  await mk({ email: 'cashier.z@test.local', fullName: 'Cashier Z', role: 'CASHIER', companyId: company.id, branchId: branch.id });
  tokens.owner = await login('owner.z@test.local');
  tokens.cashier = await login('cashier.z@test.local');

  const tax = await request(app).post('/api/catalog/tax-rates').set(auth(tokens.owner)).send({ name: 'GST 5%', ratePercent: 5 });
  const cat = await request(app).post('/api/catalog/categories').set(auth(tokens.owner)).send({ name: 'Coffee', sortOrder: 1 });
  const prod = await request(app).post('/api/catalog/products').set(auth(tokens.owner))
    .send({ categoryId: cat.body.category.id, name: 'Latte', basePrice: 200, taxRateId: tax.body.taxRate.id });
  expect(prod.status, JSON.stringify(prod.body)).toBe(201);
  productId = prod.body.product.id;
});

afterAll(async () => {
  stub.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  routes.length = 0;
  calls.length = 0;
  fallback = null;
});

const billedOrder = async () => {
  const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', items: [{ productId, qty: 2 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.order.id;
  const billed = await request(app).post(`/api/orders/${id}/bill`).set(auth(tokens.cashier)).send({});
  expect(billed.status, JSON.stringify(billed.body)).toBe(200);
  return { id, totalPaise: Math.round(billed.body.order.total * 100) };
};

// A billed order, an intent opened against a stubbed Razorpay order, and a
// captured payment delivered as a signed webhook. Returns everything later
// assertions need to name.
const paidOrder = async () => {
  const order = await billedOrder();
  const orderRef = nextId('order_');
  queue(answer(200, orderBody(order.totalPaise, orderRef)));
  const opened = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);

  const payRef = nextId('pay_');
  const hook = await deliver(captured(orderRef, payRef, order.totalPaise));
  expect(hook.status, JSON.stringify(hook.body)).toBe(200);
  expect(hook.body.applied).toBe(true);
  return { ...order, orderRef, payRef, intentId: opened.body.intent.id };
};

const refundOf = (orderId) => prisma.refund.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' } });

describe('opening a payment', () => {
  it('calls Razorpay outside the transaction and stores the order reference', async () => {
    const order = await billedOrder();
    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));

    const res = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.intent.status).toBe('PENDING');
    expect(res.body.intent.providerRef).toBe(orderRef);
    // The key id is the publishable half of the pair and Checkout needs it.
    expect(res.body.keyId).toBe(process.env.POS_GATEWAY_KEY_ID);
    expect(res.body.provider).toBe('razorpay');
    // The secret half must never reach a client.
    expect(JSON.stringify(res.body)).not.toContain(process.env.POS_GATEWAY_KEY_SECRET);
  });

  it('never exposes the idempotency key, but does store one', async () => {
    const order = await billedOrder();
    queue(answer(200, orderBody(order.totalPaise, nextId('order_'))));
    const res = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
    expect(res.body.intent.idempotencyKey).toBeUndefined();
    const stored = await prisma.paymentIntent.findUnique({ where: { id: res.body.intent.id } });
    expect(stored.idempotencyKey).toBeTruthy();
  });

  it('closes the intent when Razorpay refuses, so a fresh one can be opened', async () => {
    const order = await billedOrder();
    queue(answer(400, { error: { description: 'amount exceeds maximum' } }));
    const refused = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
    expect(refused.status).toBe(502);

    const closed = await prisma.paymentIntent.findFirst({ where: { orderId: order.id } });
    expect(closed.status).toBe('FAILED');
    expect(closed.providerRef).toBeNull();

    // A refusal created nothing at Razorpay, so the order is not stuck.
    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));
    const second = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
    expect(second.status).toBe(201);
    expect(second.body.intent.providerRef).toBe(orderRef);
  });

  it('resumes the SAME intent under the same key after an unanswered create', async () => {
    const order = await billedOrder();
    // Never answers: UNKNOWN. Razorpay may hold a payable order we never saw.
    queue(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); return undefined; },
      answer(200, { items: [] }));
    const first = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
    expect(first.status).toBe(502);

    const open = await prisma.paymentIntent.findFirst({ where: { orderId: order.id } });
    // Left open on purpose: opening a second would be a second payable page.
    expect(open.status).toBe('CREATED');
    expect(open.providerRef).toBeNull();

    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));
    const retry = await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.intent.id).toBe(open.id);
    // Same receipt as the first attempt: Razorpay returns the order it already
    // has rather than opening a second one the customer could also pay.
    expect(JSON.parse(calls.at(-1).body).receipt).toBe(open.idempotencyKey);

    const after = await prisma.paymentIntent.findUnique({ where: { id: open.id } });
    expect(after.providerRef).toBe(orderRef);
    // Still exactly one intent on this order.
    expect(await prisma.paymentIntent.count({ where: { orderId: order.id } })).toBe(1);
  }, 15000);
});

describe('a captured payment', () => {
  it('records the payment and keeps the pay_ id the refund route needs', async () => {
    const order = await paidOrder();
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment.channel).toBe('GATEWAY');
    expect(payment.method).toBe('UPI');
    expect(payment.receivedById).toBeNull();
    // Without this the money could never be sent back through the API.
    expect(payment.providerRef).toBe(order.payRef);
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('does not settle on payment.authorized — authorized is not received', async () => {
    const order = await billedOrder();
    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));
    await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});

    const hook = await deliver(captured(orderRef, nextId('pay_'), order.totalPaise, 'payment.authorized'));
    expect(hook.status).toBe(200);
    expect(hook.body.applied).toBe(false);

    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('BILLED');
    const event = await prisma.gatewayWebhookEvent.findFirst({ where: { kind: 'payment.authorized' } });
    expect(event.skippedReason).toMatch(/unhandled event type "payment.authorized"/);
  });

  it('applies a redelivered capture exactly once', async () => {
    const order = await billedOrder();
    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));
    await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});

    const payRef = nextId('pay_');
    const body = captured(orderRef, payRef, order.totalPaise);
    const eventId = nextId('evt_');
    const first = await deliver(body, { eventId });
    const again = await deliver(body, { eventId });

    expect(first.body.applied).toBe(true);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('applies a capture redelivered under a NEW event id exactly once too', async () => {
    // Razorpay's retry normally reuses the event id, but the intent uniqueness
    // is the guard that does not depend on that being true.
    const order = await billedOrder();
    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));
    await request(app).post(`/api/orders/${order.id}/payment-intents`).set(auth(tokens.cashier)).send({});

    const body = captured(orderRef, nextId('pay_'), order.totalPaise);
    await deliver(body, { eventId: nextId('evt_') });
    const again = await deliver(body, { eventId: nextId('evt_') });

    expect(again.status).toBe(200);
    expect(again.body.applied).toBe(false);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('answers 400 and records nothing when the signature does not verify', async () => {
    const before = await prisma.gatewayWebhookEvent.count();
    const res = await deliver(captured(nextId('order_'), nextId('pay_'), 1000), { secret: 'wrong-secret' });
    expect(res.status).toBe(400);
    expect(await prisma.gatewayWebhookEvent.count()).toBe(before);
  });
});

describe('refunding a Razorpay payment', () => {
  it('posts to the payment id, not the order id, and stays PENDING', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(10000, refundRef, order.payRef)));

    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'spilled drink' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(calls.at(-1).path).toBe(`/v1/payments/${order.payRef}/refund`);
    const stored = await refundOf(order.id);
    expect(stored.channel).toBe('GATEWAY');
    // A request, not a result. Only refund.processed may change this.
    expect(stored.status).toBe('PENDING');
    expect(stored.providerRef).toBe(refundRef);
    expect(stored.settledAt).toBeNull();
    expect(calls.at(-1).headers['x-refund-idempotency']).toBe(stored.idempotencyKey);
    // The order is not unwound by a request.
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('settles only when refund.processed arrives signed', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(order.totalPaise, refundRef, order.payRef)));
    await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: order.totalPaise / 100, reason: 'order cancelled' });

    expect((await refundOf(order.id)).status).toBe('PENDING');

    const hook = await deliver(refundOutcome(refundRef, order.payRef, order.totalPaise));
    expect(hook.status).toBe(200);
    expect(hook.body.applied).toBe(true);

    const settled = await refundOf(order.id);
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.settledAt).not.toBeNull();
    // Now, and only now, is the order unwound.
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('REFUNDED');
  });

  it('releases the money when Razorpay refuses, so a second refund is possible', async () => {
    const order = await paidOrder();
    queue(answer(400, { error: { description: 'the payment has been fully refunded already' } }));
    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'duplicate charge' });
    // 202, not 201: a record was made, but no refund was placed.
    expect(res.status).toBe(202);
    expect(res.body.refund.status).toBe('FAILED');

    const failed = await refundOf(order.id);
    // FAILED, not left hanging: Razorpay received it and moved nothing.
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toMatch(/refused the refund/);
    expect(failed.providerRef).toBeNull();

    // A failed refund holds no money, so the full amount is refundable again.
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(order.totalPaise, refundRef, order.payRef)));
    const second = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: order.totalPaise / 100, reason: 'retry in full' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((await refundOf(order.id)).providerRef).toBe(refundRef);
  });

  it('holds the money and BLOCKS a second refund when Razorpay never answers', async () => {
    const order = await paidOrder();
    // No answer at all. The refund may be paying out this second.
    queue(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); return undefined; });
    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'customer changed mind' });
    expect(res.status).toBe(202);
    // Still PENDING on the wire: the caller is told a request exists, never
    // that money came back.
    expect(res.body.refund.status).toBe('PENDING');

    const unknown = await refundOf(order.id);
    expect(unknown.status).toBe('PENDING');
    expect(unknown.providerRef).toBeNull();
    expect(unknown.failureReason).toMatch(/did not confirm/);

    // The critical assertion. Asking again here is how a customer gets paid
    // twice, so it must be refused outright rather than retried.
    queue(answer(200, refundBody(10000, nextId('rfnd_'), order.payRef)));
    const second = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'trying again' });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/never confirmed/i);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  }, 15000);

  it('never returns more than was collected, however many requests are in flight', async () => {
    const order = await paidOrder();
    const each = Math.floor(order.totalPaise / 3);
    fallback = () => ({ status: 200, body: refundBody(each, nextId('rfnd_'), order.payRef) });

    // Four concurrent requests for a third each. The fourth must be refused:
    // a pending request still holds its money.
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
          .send({ amount: each / 100, reason: `concurrent ${n}` }),
      ),
    );
    const accepted = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status !== 201);
    expect(accepted.length).toBeLessThanOrEqual(3);
    expect(refused.length).toBeGreaterThanOrEqual(1);

    const rows = await prisma.refund.findMany({ where: { orderId: order.id } });
    const reserved = rows
      .filter((r) => r.status === 'PENDING' || r.status === 'SUCCEEDED')
      .reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    expect(reserved).toBeLessThanOrEqual(order.totalPaise);
  }, 20000);

  it('refuses to refund a gateway payment whose pay_ id was never recorded', async () => {
    const order = await paidOrder();
    // A payment settled before Payment.providerRef existed.
    await prisma.payment.updateMany({ where: { orderId: order.id }, data: { providerRef: null } });

    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'no reference' });
    expect(res.status).toBe(202);

    const row = await refundOf(order.id);
    // Terminal and refused before any network call, so the money is released
    // rather than stranded — and the reason names what a human must do.
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/no Razorpay payment id/);
    expect(calls.filter((c) => c.path.includes('/refund'))).toHaveLength(0);
  });
});

describe('out-of-order and unmatched events', () => {
  it('stores a refund.processed that arrives before the reference was recorded', async () => {
    const order = await paidOrder();
    const hook = await deliver(refundOutcome(nextId('rfnd_'), order.payRef, 10000));
    expect(hook.status).toBe(200);
    expect(hook.body.applied).toBe(false);
    const event = await prisma.gatewayWebhookEvent.findFirst({
      where: { kind: 'refund.succeeded' }, orderBy: { receivedAt: 'desc' },
    });
    expect(event.skippedReason).toMatch(/no refund matches/);
  });

  it('ignores a payment.failed that arrives after the capture', async () => {
    const order = await paidOrder();
    const hook = await deliver(captured(order.orderRef, order.payRef, order.totalPaise, 'payment.failed'));
    expect(hook.status).toBe(200);
    expect(hook.body.applied).toBe(false);

    const intent = await prisma.paymentIntent.findUnique({ where: { id: order.intentId } });
    expect(intent.status).toBe('SUCCEEDED');
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('PAID');
  });

  it('will not settle a refund twice, however often refund.processed arrives', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(10000, refundRef, order.payRef)));
    await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'once' });

    const body = refundOutcome(refundRef, order.payRef, 10000);
    expect((await deliver(body)).body.applied).toBe(true);
    const again = await deliver(body);
    expect(again.status).toBe(200);
    expect(again.body.applied).toBe(false);

    const event = await prisma.gatewayWebhookEvent.findFirst({
      where: { skippedReason: { contains: 'already' } }, orderBy: { receivedAt: 'desc' },
    });
    expect(event.skippedReason).toMatch(/refund already succeeded/);
    expect((await refundOf(order.id)).status).toBe('SUCCEEDED');
  });

  it('records refund.created without settling anything', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(10000, refundRef, order.payRef)));
    await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'created only' });

    // A genuine, correctly signed delivery we do not act on. It must be
    // accepted — a 400 here makes Razorpay retry it forever.
    const hook = await deliver(refundOutcome(refundRef, order.payRef, 10000, 'refund.created'));
    expect(hook.status).toBe(200);
    expect(hook.body.applied).toBe(false);
    expect((await refundOf(order.id)).status).toBe('PENDING');

    const event = await prisma.gatewayWebhookEvent.findFirst({ where: { kind: 'refund.created' } });
    expect(event.skippedReason).toMatch(/unhandled refund event type "refund.created"/);
  });

  it('refuses to settle a refund for an amount other than the one requested', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(10000, refundRef, order.payRef)));
    await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'amount check' });

    const hook = await deliver(refundOutcome(refundRef, order.payRef, 99999));
    expect(hook.status).toBe(200);
    expect(hook.body.applied).toBe(false);
    expect((await refundOf(order.id)).status).toBe('PENDING');
  });
});
