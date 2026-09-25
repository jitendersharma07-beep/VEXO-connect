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
let branchId;

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
  // Before PosUser and Branch, which it references. Shared test database:
  // another file's DayClose rows block this file's PosUser delete.
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
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
  // Union of both sides: the candidate's publicId (the accounts lane made it
  // part of the branch fixture) and the lane's branchId capture (the gateway
  // refund print tests place their PrintAgent on this branch explicitly,
  // because targetsFor matches on branchId and the owner carries none).
  const branch = await prisma.branch.create({ data: { companyId: company.id, publicId: 'VC-RZ-0001', name: 'Rz One', code: 'Z1' } });
  branchId = branch.id;
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
    queue(
      answer(400, { error: { description: 'the payment has been fully refunded already' } }),
      // The 400 is not enough on its own any more. Releasing money now costs a
      // second question — does a refund under this key exist on the charge? —
      // and the empty list is the answer that makes the refusal safe to act on.
      answer(200, { entity: 'collection', count: 0, items: [] }),
    );
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

  // The money-losing case the release rule exists to prevent, end to end.
  // Razorpay rejects a replayed idempotency key with a 400, so the request that
  // looks most like "we refused" is the one most likely to be sitting on top of
  // a refund already paid out. Releasing on the status alone would let the
  // cashier refund the same order twice, and the customer would be paid twice.
  it('does not release, or fail, a refund whose 400 hides one already made', async () => {
    const order = await paidOrder();
    const existing = nextId('rfnd_');
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key already used' } }),
      // The charge does carry a refund under our key. The 400 was about the
      // request, not about whether money moved.
      // Echo back the key the POST actually sent, which is the only thing that
      // ties the refund on the charge to the request this POS made.
      () => {
        const sent = [...calls].reverse().find((c) => c.headers['x-refund-idempotency']);
        return {
          status: 200,
          body: {
            entity: 'collection',
            count: 1,
            items: [
              {
                ...refundBody(10000, existing, order.payRef),
                notes: { pos_refund_key: sent.headers['x-refund-idempotency'] },
              },
            ],
          },
        };
      },
    );
    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'duplicate charge' });
    // 201: the refund was placed — by the earlier attempt, which this one found.
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const row = await refundOf(order.id);
    // Not FAILED. Nothing was refused, so nothing is released.
    expect(row.status).toBe('PENDING');
    expect(row.settledAt).toBeNull();
    // And it is tracking the refund that actually exists at Razorpay.
    expect(row.providerRef).toBe(existing);

    // And the ₹100 is still HELD. This is the assertion the whole rule exists
    // for: had the 400 been read as a refusal, this amount would have gone back
    // on sale while Razorpay was paying it out, and the next request would
    // return it a second time. Asking for the full amount collected must still
    // be short by exactly the reserved ₹100.
    const again = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: order.totalPaise / 100, reason: 'second attempt' });
    expect(again.status, JSON.stringify(again.body)).toBe(400);
    expect(again.body.error.message).toMatch(/exceeds the amount collected/i);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  }, 15000);

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

  // A fault on OUR side of the wire is not the provider declining. The
  // distinction decides whether the reserved amount is handed back to be
  // refunded again, so it is asserted on the money, not just on the label.
  it('holds the money when our own precondition fails, because Razorpay never answered', async () => {
    const order = await paidOrder();
    // A payment settled before Payment.providerRef existed.
    await prisma.payment.updateMany({ where: { orderId: order.id }, data: { providerRef: null } });

    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'no reference' });
    expect(res.status).toBe(202);
    expect(res.body.warning).toMatch(/did not confirm/);

    const row = await refundOf(order.id);
    // PENDING, not FAILED. Nothing left this process, so Razorpay has no
    // opinion to record — and "the payment provider refused the refund" would
    // be a straight untruth about a provider that was never contacted.
    expect(row.status).toBe('PENDING');
    expect(row.settledAt).toBeNull();
    expect(row.failureReason).toMatch(/did not confirm/);
    expect(row.failureReason).toMatch(/no Razorpay payment id/);
    expect(calls.filter((c) => c.path.includes('/refund'))).toHaveLength(0);

    // The assertion that matters. The amount stays reserved, so the order
    // cannot be refunded a second time on top of it. Were this classified as a
    // refusal the reservation would be released, and the operator could raise
    // the same refund again the moment the missing pay_ id was backfilled —
    // paying the customer twice for one order.
    queue(answer(200, refundBody(10000, nextId('rfnd_'), order.payRef)));
    const second = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'trying again' });
    expect(second.status).toBe(409);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  });

  // A 200 carrying a refund for the wrong amount is the most dangerous answer
  // Razorpay can give: a payout is under way and it is not the one we asked
  // for. It must not be read as a refusal, or the difference gets refunded on
  // top of it.
  it('holds the money when Razorpay refunds an amount other than the one asked for', async () => {
    const order = await paidOrder();
    queue(answer(200, refundBody(9999, nextId('rfnd_'), order.payRef)));

    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'amount mismatch' });
    expect(res.status).toBe(202);

    const row = await refundOf(order.id);
    expect(row.status).toBe('PENDING');
    expect(row.failureReason).toMatch(/did not confirm/);
    expect(row.failureReason).toMatch(/different amount/);
  });
});

// Reconcile re-sends a refund the provider never answered, and it is only safe
// because it re-sends THE SAME request: same charge, same key, same body.
// Razorpay then hands back the original refund instead of creating a second
// one. Get any of the three wrong and the retry is a second payout.
describe('reconciling a refund the provider never confirmed', () => {
  // A refund that was sent and never answered: PENDING, holding its amount,
  // with no provider reference. This is the only state reconcile accepts.
  const unanswered = async () => {
    const order = await paidOrder();
    queue(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); return undefined; });
    const res = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'customer changed mind' });
    expect(res.status).toBe(202);
    const row = await refundOf(order.id);
    expect(row.status).toBe('PENDING');
    expect(row.providerRef).toBeNull();
    expect(row.idempotencyKey).toBeTruthy();
    return { order, row };
  };

  it('re-sends to the same pay_ id under the original idempotency key', async () => {
    const { order, row } = await unanswered();
    const first = calls.filter((c) => c.path.includes('/refund')).at(-1);
    expect(first).toBeTruthy();
    calls.length = 0;

    const settledRef = nextId('rfnd_');
    queue(answer(200, refundBody(10000, settledRef, order.payRef)));
    const res = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const retry = calls.filter((c) => c.path.includes('/refund'));
    // One call, which is already the regression: the route used to hand the
    // adapter the order_… string instead of a leg, so the charge id arrived
    // undefined, the adapter threw before reaching the network, and reconcile
    // silently made NO request at all.
    expect(retry).toHaveLength(1);
    // The charge, not the attempt. Only a pay_ can be refunded, and reaching
    // it means going through the intent to the Payment it settled into.
    expect(retry[0].path).toBe(`/v1/payments/${order.payRef}/refund`);
    // The ORIGINAL key. A fresh one is a brand new refund at Razorpay, raised
    // against a request that may be paying out as this runs.
    expect(retry[0].headers['x-refund-idempotency']).toBe(row.idempotencyKey);
    expect(retry[0].headers['x-refund-idempotency']).toBe(first.headers['x-refund-idempotency']);
    // And the same body byte for byte: Razorpay answers 409 to a replayed key
    // whose body differs, which would strand the refund permanently
    // unreconcilable.
    expect(retry[0].body).toBe(first.body);

    const after = await refundOf(order.id);
    expect(after.providerRef).toBe(settledRef);
    // A reference to track, not money returned. Only the signed
    // refund.processed settles it.
    expect(after.status).toBe('PENDING');
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  }, 15000);

  // The negative control for the change above: tightening what counts as a
  // refusal must not stop a real one releasing. If this goes green while the
  // local-fault tests also pass, the two paths are genuinely distinguished
  // rather than both being held.
  it('still releases the money when the provider refuses on the retry', async () => {
    const { order, row } = await unanswered();
    queue(
      answer(400, { error: { description: 'the payment has been fully refunded already' } }),
      // Same evidence the create path now demands: the charge carries no refund
      // under this key, so the 400 really is a refusal and not a replay sitting
      // on top of a payout already made.
      answer(200, { entity: 'collection', count: 0, items: [] }),
    );
    const res = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(res.status).toBe(202);

    const after = await refundOf(order.id);
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toMatch(/refused the refund/);

    // Released, so the order is refundable again.
    queue(answer(200, refundBody(order.totalPaise, nextId('rfnd_'), order.payRef)));
    const second = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: order.totalPaise / 100, reason: 'retry in full' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
  }, 15000);

  it('keeps holding the money when the retry is unanswered too', async () => {
    const { order, row } = await unanswered();
    queue(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); return undefined; });
    const res = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(res.status).toBe(202);
    expect(res.body.warning).toMatch(/stays held/);

    const after = await refundOf(order.id);
    expect(after.status).toBe('PENDING');
    expect(after.providerRef).toBeNull();
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  }, 20000);
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

// The browser's claim that the customer paid. The whole point of these is
// that a verified handoff still settles nothing — the cashier's screen is
// allowed to change, the money is not.
describe('the checkout handoff', () => {
  const KEY_SECRET = process.env.POS_GATEWAY_KEY_SECRET;

  // An intent open with Razorpay, no webhook delivered yet.
  const openIntent = async () => {
    const order = await billedOrder();
    const orderRef = nextId('order_');
    queue(answer(200, orderBody(order.totalPaise, orderRef)));
    const opened = await request(app).post(`/api/orders/${order.id}/payment-intents`)
      .set(auth(tokens.cashier)).send({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    return { ...order, orderRef, intentId: opened.body.intent.id };
  };

  const sign = (orderRef, payRef, secret = KEY_SECRET) =>
    crypto.createHmac('sha256', secret).update(`${orderRef}|${payRef}`).digest('hex');

  const handoff = (orderId, intentId, body) =>
    request(app).post(`/api/orders/${orderId}/payment-intents/${intentId}/handoff`)
      .set(auth(tokens.cashier)).send(body);

  it('accepts a signature from Razorpay and still reports the money unsettled', async () => {
    const order = await openIntent();
    const payRef = nextId('pay_');

    const res = await handoff(order.id, order.intentId, {
      paymentId: payRef, signature: sign(order.orderRef, payRef),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.handoff).toBe('verified');
    // The browser beat the webhook, which is the normal case and must not
    // read as payment.
    expect(res.body.settled).toBe(false);
    expect(res.body.order.status).toBe('BILLED');
    expect(res.body.order.payments).toHaveLength(0);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('reports settled once the webhook has actually landed', async () => {
    const order = await openIntent();
    const payRef = nextId('pay_');
    const hook = await deliver(captured(order.orderRef, payRef, order.totalPaise));
    expect(hook.body.applied).toBe(true);

    const res = await handoff(order.id, order.intentId, {
      paymentId: payRef, signature: sign(order.orderRef, payRef),
    });
    expect(res.status).toBe(200);
    expect(res.body.settled).toBe(true);
    expect(res.body.order.status).toBe('PAID');
  });

  it('refuses a forged signature', async () => {
    const order = await openIntent();
    const payRef = nextId('pay_');

    const res = await handoff(order.id, order.intentId, {
      paymentId: payRef, signature: 'a'.repeat(64),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/could not be verified/);
  });

  // The two secrets are easy to confuse and the failure would be silent.
  it('refuses a handoff signed with the webhook secret', async () => {
    const order = await openIntent();
    const payRef = nextId('pay_');

    const res = await handoff(order.id, order.intentId, {
      paymentId: payRef, signature: sign(order.orderRef, payRef, SECRET),
    });
    expect(res.status).toBe(400);
  });

  // Signing over the wrong attempt is how one order's handoff would be
  // replayed onto another's bill.
  it('refuses a signature made for a different attempt', async () => {
    const order = await openIntent();
    const payRef = nextId('pay_');

    const res = await handoff(order.id, order.intentId, {
      paymentId: payRef, signature: sign(nextId('order_'), payRef),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an intent belonging to another order', async () => {
    const mine = await openIntent();
    const other = await openIntent();
    const payRef = nextId('pay_');

    const res = await handoff(mine.id, other.intentId, {
      paymentId: payRef, signature: sign(other.orderRef, payRef),
    });
    expect(res.status).toBe(404);
  });

  it('records the handoff so an intent that never settles can be told apart', async () => {
    const order = await openIntent();
    const payRef = nextId('pay_');
    await handoff(order.id, order.intentId, {
      paymentId: payRef, signature: sign(order.orderRef, payRef),
    });

    const log = await prisma.posAuditLog.findFirst({
      where: { action: 'GATEWAY_CHECKOUT_HANDOFF', entityId: order.intentId },
    });
    expect(log).not.toBeNull();
    expect(log.meta.chargeRef).toBe(payRef);
  });
});

// refundLabelFor has five branches; four of them are about gateway money, and
// they exist to stop a receipt saying the customer's money is back before the
// provider has sent it. Until now only the MANUAL branch was pinned on a
// printed document (printJobs.test.js, row 5b), and the one gateway label with
// any coverage was asserted on the ORDER VIEW. A wrong label on a screen is an
// argument; on paper in the customer's hand it is the shop's written word, so
// each branch is pinned here on a stored PrintJob.document.
describe('what the printed receipt says about gateway refund money', () => {
  let receiptTargetId;

  beforeAll(async () => {
    // The owner here carries no branch of its own, so the agent is placed
    // explicitly on the branch the cashier's orders belong to — targetsFor
    // matches on branchId and would otherwise find nothing.
    const agent = await request(app).post('/api/print-agents').set(auth(tokens.owner))
      .send({ name: 'Counter PC', branchId });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    // Enrolment is what makes the agent ACTIVE, and targetsFor requires it.
    const enrolled = await request(app).post('/api/print-agents/enrol')
      .send({ code: agent.body.enrolCode, platform: 'linux', hostname: 'rz-till' });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    const target = await request(app).post(`/api/print-agents/${agent.body.agent.id}/targets`)
      .set(auth(tokens.owner))
      .send({ name: 'Front receipt', purpose: 'RECEIPT', transport: 'TCP', host: '10.0.0.10' });
    expect(target.status, JSON.stringify(target.body)).toBe(201);
    receiptTargetId = target.body.target.id;
  });

  // The document is a snapshot taken at enqueue, so the refund has to be in its
  // final state before this is called.
  const printedReceipt = async (orderId) => {
    const res = await request(app).post('/api/print-jobs').set(auth(tokens.cashier))
      .send({ orderId, kind: 'RECEIPT' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // queued:0 is a 201 with an empty jobs array — no RECEIPT target matched,
    // and every assertion below would then be made about nothing.
    expect(res.body.queued, JSON.stringify(res.body)).toBe(1);
    const row = await prisma.printJob.findUnique({ where: { id: res.body.jobs[0].id } });
    expect(row.targetId).toBe(receiptTargetId);
    return row.document;
  };

  it('prints PAID OUT only once the provider has confirmed the refund', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(order.totalPaise, refundRef, order.payRef)));
    const raised = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: order.totalPaise / 100, reason: 'order cancelled' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    const hook = await deliver(refundOutcome(refundRef, order.payRef, order.totalPaise));
    expect(hook.body.applied).toBe(true);
    expect((await refundOf(order.id)).status).toBe('SUCCEEDED');

    const doc = await printedReceipt(order.id);
    expect(doc.refunds).toHaveLength(1);
    expect(doc.refunds[0]).toMatchObject({
      amount: order.totalPaise / 100,
      reason: 'order cancelled',
      status: 'SUCCEEDED',
      channel: 'GATEWAY',
      label: 'REFUND PAID OUT — confirmed by the provider',
    });
  });

  it('prints REQUESTED, not paid out, while the provider holds the request', async () => {
    const order = await paidOrder();
    const refundRef = nextId('rfnd_');
    queue(answer(200, refundBody(10000, refundRef, order.payRef)));
    const raised = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'spilled drink' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    const row = await refundOf(order.id);
    expect(row.status).toBe('PENDING');
    // The reference is what separates this branch from the unanswered one.
    expect(row.providerRef).toBe(refundRef);

    const doc = await printedReceipt(order.id);
    expect(doc.refunds).toHaveLength(1);
    expect(doc.refunds[0]).toMatchObject({
      amount: 100,
      reason: 'spilled drink',
      status: 'PENDING',
      channel: 'GATEWAY',
      label: 'REFUND REQUESTED — not yet paid out by the provider',
    });
    // The statement this branch exists to prevent, asserted as an absence too:
    // Razorpay accepting the request is not Razorpay having paid it.
    expect(doc.refunds[0].label).not.toMatch(/PAID OUT|HANDED BACK/);
  });

  it('prints SENT — awaiting confirmation when the provider never answered', async () => {
    const order = await paidOrder();
    // Opens the response and never finishes it: the refund may be paying out
    // this second, and we hold no reference to ask about later.
    queue(({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); return undefined; });
    const raised = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'customer changed mind' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(202);

    const row = await refundOf(order.id);
    expect(row.status).toBe('PENDING');
    expect(row.providerRef).toBeNull();

    const doc = await printedReceipt(order.id);
    expect(doc.refunds).toHaveLength(1);
    expect(doc.refunds[0]).toMatchObject({
      amount: 100,
      reason: 'customer changed mind',
      status: 'PENDING',
      channel: 'GATEWAY',
      label: 'REFUND SENT — awaiting confirmation from the provider',
    });
    // Unanswered is not refused, and it is not paid either. The customer may
    // already have this money, so the paper claims neither.
    expect(doc.refunds[0].label).not.toMatch(/PAID OUT|FAILED|REQUESTED/);
  }, 15000);

  it('prints no refund line at all when the provider refused it', async () => {
    const order = await paidOrder();
    queue(
      answer(400, { error: { description: 'the payment has been fully refunded already' } }),
      // The empty collection is the evidence that makes the refusal safe to
      // act on: no refund under our key exists on the charge.
      answer(200, { entity: 'collection', count: 0, items: [] }),
    );
    const raised = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: 100, reason: 'duplicate charge' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(202);

    // The refund row EXISTS and is FAILED. Without this the empty array below
    // would be evidence of nothing: a refund nobody ever raised prints
    // identically.
    const row = await refundOf(order.id);
    expect(row.status).toBe('FAILED');
    expect(row.channel).toBe('GATEWAY');

    const doc = await printedReceipt(order.id);
    // buildReceipt filters FAILED out of the document, so this branch is pinned
    // by absence rather than by its label. Nothing moved, so there is nothing
    // to tell the customer about their money — and "REFUND FAILED" on paper
    // they keep is the shop announcing an attempt that changed nothing.
    expect(doc.refunds).toEqual([]);
    // Nowhere else either. Matched on the label vocabulary rather than the bare
    // word, which would trip on a legitimate REFUNDED order status later.
    expect(JSON.stringify(doc)).not.toMatch(/REFUND (PAID OUT|FAILED|SENT|REQUESTED|HANDED BACK)/);
    // The bill is still settled in full: a refused refund returned nothing.
    expect(doc.amountPaid).toBe(order.totalPaise / 100);
    expect(doc.amountDue).toBe(0);
  });
});

// REQUIRED INTEGRATION CHECK 2, 2026-09-25 — the payment ordering change tested
// where it decides money, not where it decides layout.
//
// VC-103 gave ORDER_INCLUDE.payments a `[createdAt, id]` tie-break, and its
// stated reason was pickRefundLeg: "with two provider charges tied, which charge
// a refund posts against was undefined". Verifying that claim showed the change
// did not reach the outcome it named. pickRefundLeg has exactly one call site,
// the refund route, and that route did not read payments through ORDER_INCLUDE —
// it used a bare `select:` with no ORDER BY at all. So the receipt's tender order
// became deterministic while the refund's target charge stayed at the planner's
// discretion. The include now lives in lib/orders.js beside refundLegs and
// carries the same tie-break; these tests are what hold it there.
//
// What is asserted is DETERMINISM, and only that. Ascending cuid follows the
// order rows were inserted by this system; it is NOT evidence of the order the
// provider captured the charges in. Clock skew, a late capture on an earlier
// attempt, or a redelivered webhook all put the provider's chronology at odds
// with our insertion order, and nothing here claims otherwise.
//
// FINANCE POLICY, OPEN: whether a tie should prefer the first-inserted charge at
// all. "Most headroom" would refuse fewer refunds; "oldest provider intent"
// would reconcile more naturally against a statement. Either would be a
// different rule, not a better tie-break, and neither is chosen here.
describe('which gateway charge a refund posts against, when two are tied', () => {
  // Two gateway charges on one order are built directly, and the reason is
  // itself a finding worth recording. refundLegs supports the state explicitly
  // ("two intents on one order are two distinct charges") but the write paths
  // cannot currently reach it: the intent route always opens for the FULL
  // remaining due, and applyGatewayEvent refuses a capture that is not exactly
  // the intent's amount and refuses any capture beyond the amount due. So no
  // sequence of routes and webhooks produces two partial gateway charges. The
  // rows are therefore constructed at the database, and the REFUND is then
  // driven entirely through the real route — which is the code under test.
  const twoTiedGatewayCharges = async () => {
    const order = await billedOrder();
    const half = order.totalPaise / 2;
    expect(Number.isInteger(half)).toBe(true);

    const cashier = await prisma.posUser.findFirstOrThrow({ where: { email: 'cashier.z@test.local' } });
    const mkLeg = async (payRef) => {
      const intent = await prisma.paymentIntent.create({
        data: {
          orderId: order.id, provider: 'razorpay', providerRef: nextId('order_'),
          amount: (half / 100).toFixed(2), currency: 'INR', status: 'SUCCEEDED',
          idempotencyKey: crypto.randomUUID(), createdById: cashier.id,
        },
      });
      return prisma.payment.create({
        data: {
          orderId: order.id, branchId, method: 'UPI', channel: 'GATEWAY',
          amount: (half / 100).toFixed(2), intentId: intent.id, providerRef: payRef,
        },
      });
    };

    // Inserted first, and given the HIGHER id below, so insertion order and
    // ascending id disagree. Without that the two are the same sequence — cuid
    // is time-prefixed — and this test would pass with no tie-break at all,
    // which is the false green the VC-103 test notes ran into.
    const firstInserted = await mkLeg(nextId('pay_'));
    const secondInserted = await mkLeg(nextId('pay_'));
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
    return { order, half, firstInserted, secondInserted };
  };

  // One instant for both rows, as a single transaction would have produced, and
  // ids chosen by the caller. Nothing FK-references Payment.id, so rewriting it
  // rearranges nothing else.
  const TIE = new Date('2026-09-24T12:00:00.000Z');
  let tiePair = 0;
  const tieAndRewrite = async (lowRow, highRow) => {
    // Payment.id is unique across the table, so the pair is numbered — two tests
    // in this file tie their own rows and would otherwise collide on the second.
    // The number is shared by the pair, so 'a' before 'z' is what decides the
    // sort, exactly as the literal names did.
    const k = String(++tiePair).padStart(2, '0');
    // High first. An UPDATE writes a new row version at the end of the heap, so
    // the rewrite sequence becomes the physical order and an unordered read
    // follows it — doing low first would line the heap up with ascending id and
    // hide a missing ORDER BY.
    await prisma.payment.update({ where: { id: highRow.id }, data: { id: `zz-tie-${k}-z-second`, createdAt: TIE } });
    await prisma.payment.update({ where: { id: lowRow.id }, data: { id: `zz-tie-${k}-a-first`, createdAt: TIE } });
    const rows = await prisma.payment.findMany({
      where: { orderId: lowRow.orderId }, orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].createdAt.getTime()).toBe(rows[1].createdAt.getTime());
    return { low: rows[0], high: rows[1] };
  };

  // Answers whatever charge it is asked about, so the CALL is the evidence
  // rather than a queued expectation that would decide the answer in advance.
  const echoRefunds = (amountPaise) => {
    fallback = ({ path }) => {
      const charge = path.split('/')[3];
      return { status: 200, body: refundBody(amountPaise, nextId('rfnd_'), charge) };
    };
  };
  const chargesCalled = () =>
    calls.filter((c) => /\/refund$/.test(c.path)).map((c) => c.path.split('/')[3]);

  it('posts against the charge the declared order names, and the un-named charge is never called', async () => {
    const { order, half, firstInserted, secondInserted } = await twoTiedGatewayCharges();
    // secondInserted gets the LOW id: the declared winner is the row that went
    // in SECOND, so a pass cannot be insertion order in disguise.
    const { low, high } = await tieAndRewrite(secondInserted, firstInserted);
    expect(low.providerRef).toBe(secondInserted.providerRef);
    expect(high.providerRef).toBe(firstInserted.providerRef);

    // Half of one leg, so BOTH legs have the headroom and the tie is what
    // decides. An amount only one leg could cover would be answered by
    // arithmetic and prove nothing about ordering.
    const amountPaise = half / 2;
    expect(amountPaise).toBeLessThanOrEqual(half);
    echoRefunds(amountPaise);

    const raised = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: amountPaise / 100, reason: 'tied charges' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    // THE SELECTED PROVIDER PAYMENT REFERENCE, read off the wire rather than
    // inferred: this is the pay_… id in the URL the adapter posted to.
    expect(chargesCalled()).toEqual([low.providerRef]);
    expect(chargesCalled()).not.toContain(high.providerRef);

    // The refund is attributed to that charge's intent in our own records too,
    // so the row and the wire agree about which charge is being returned.
    const row = await refundOf(order.id);
    expect(row.intentId).toBe(low.intentId);
    expect(row.channel).toBe('GATEWAY');

    // UNCHANGED AMOUNT AND CAPS. A tie-break may reorder rows; it must not
    // revalue them. Asserted on the money, not on the labels.
    expect(Math.round(Number(row.amount) * 100)).toBe(amountPaise);
    const after = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.owner));
    expect(after.status).toBe(200);
    expect(Math.round(after.body.order.amountPaid * 100)).toBe(order.totalPaise);
    expect(after.body.order.amountDue).toBe(0);
    expect(after.body.order.status).toBe('PAID'); // a PENDING gateway refund returns nothing yet
    const collected = await prisma.payment.aggregate({ where: { orderId: order.id }, _sum: { amount: true } });
    expect(Math.round(Number(collected._sum.amount) * 100)).toBe(order.totalPaise);

    // The cap moved by exactly the amount reserved, on the selected leg only.
    // Proved through the route's own refusal message, which quotes
    // largestRefundablePaise — so this reads the real cap, not a re-derivation.
    echoRefunds(order.totalPaise);
    const tooBig = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: (half + 1) / 100, reason: 'more than one leg holds' });
    expect(tooBig.status, JSON.stringify(tooBig.body)).toBe(400);
    // The untouched leg still holds its full half; the selected one is down by
    // the reservation. So the largest single-leg refund is still that full half.
    expect(tooBig.body.error.message).toContain(`₹${(half / 100).toFixed(2)}`);
    expect(chargesCalled()).toEqual([low.providerRef]); // refused before any second call
  }, 20000);

  // NEGATIVE CONTROL. Same fixture, ids the other way round. If the assertion
  // above were passing on something incidental — heap order, intent creation
  // order, which row the planner likes — this would post against the same
  // charge and fail. It has to follow the ids to be green.
  it('follows the declared order when the ids are the other way round', async () => {
    const { order, half, firstInserted, secondInserted } = await twoTiedGatewayCharges();
    const { low, high } = await tieAndRewrite(firstInserted, secondInserted);
    expect(low.providerRef).toBe(firstInserted.providerRef);

    const amountPaise = half / 2;
    echoRefunds(amountPaise);
    const raised = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: amountPaise / 100, reason: 'tied charges, reversed' });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);

    expect(chargesCalled()).toEqual([low.providerRef]);
    expect(chargesCalled()).not.toContain(high.providerRef);
    expect(Math.round(Number((await refundOf(order.id)).amount) * 100)).toBe(amountPaise);
  }, 20000);

  // The behavioural tests above can only be as good as the planner's whim on
  // the day: with the ORDER BY gone they may still come back in ascending id
  // and go green on broken code. This one cannot. Drop the tie-break from the
  // include the refund route reads and it fails on the next run, whatever
  // Postgres decides — the same reason printJobs.test.js asserts
  // ORDER_INCLUDE's declaration next to its behavioural test.
  it('the refund route reads payments through a declared tie-break, not a bare select', async () => {
    const { REFUND_PAYMENT_INCLUDE, ORDER_INCLUDE } = await import('../src/lib/orders.js');
    const tieBroken = [{ createdAt: 'asc' }, { id: 'asc' }];
    expect(REFUND_PAYMENT_INCLUDE.orderBy).toEqual(tieBroken);
    // The same rule as the reader that prints the tenders, so a receipt and a
    // refund can never disagree about which charge came first.
    expect(ORDER_INCLUDE.payments.orderBy).toEqual(tieBroken);
    // And it still carries what a leg needs: without providerRef the refund has
    // no charge to post to, and the orderBy would be decorating nothing.
    expect(REFUND_PAYMENT_INCLUDE.select.providerRef).toBe(true);
    expect(REFUND_PAYMENT_INCLUDE.select.intent.select.providerRef).toBe(true);
  });
});
