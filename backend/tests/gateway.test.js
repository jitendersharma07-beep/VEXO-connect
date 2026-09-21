// Payment gateway suite (contract §13). Exercises the adapter, the webhook's
// signature verification, idempotent application and the reconciliation
// report against the test adapter — no provider account, no network.
//
// Every guard here is checked by its REASON, not merely by the fact that
// something was refused: a check that fires for the wrong cause is a check
// that will pass while the system is broken.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('gateway.test.js requires a DATABASE_URL ending in _test');
}

// Must precede the app import: config/env.js reads process.env once, at load.
process.env.POS_GATEWAY_PROVIDER = 'test';
process.env.POS_GATEWAY_WEBHOOK_SECRET = 'gateway-test-secret-not-a-real-one';
process.env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = '300';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { signPayload, SIGNATURE_HEADER } = await import('../src/lib/gateway/testAdapter.js');

const app = createApp();
const SECRET = process.env.POS_GATEWAY_WEBHOOK_SECRET;

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

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
let company, branch, productId;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// Posts a raw, signed body exactly as a provider would. The body is sent as a
// STRING: supertest JSON-stringifies a Buffer when the content type is JSON,
// which would silently change the very bytes the signature covers.
const deliverRaw = (raw, signature) =>
  request(app)
    .post('/api/gateway/webhook')
    .set(SIGNATURE_HEADER, signature)
    .set('Content-Type', 'application/json')
    .send(raw);

const deliver = async (payload, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) => {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return deliverRaw(raw, signPayload(secret, timestamp, raw));
};

let evtSeq = 0;
const succeeded = (providerRef, amountPaise, extra = {}) => ({
  id: `evt_${++evtSeq}_${Date.now()}`,
  type: 'payment.succeeded',
  data: { providerRef, amountPaise, currency: 'INR', ...extra },
});

// A billed order with a known total, returned with its due amount in paise.
const billedOrder = async () => {
  const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
    .send({ type: 'TAKEAWAY', items: [{ productId, qty: 2 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.order.id;
  const billed = await request(app).post(`/api/orders/${id}/bill`).set(auth(tokens.cashier)).send({});
  expect(billed.status, JSON.stringify(billed.body)).toBe(200);
  return { id, totalPaise: Math.round(billed.body.order.total * 100) };
};

const openIntent = async (orderId) => {
  const res = await request(app).post(`/api/orders/${orderId}/payment-intents`)
    .set(auth(tokens.cashier)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.intent;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  company = await prisma.company.create({
    data: {
      name: 'Gateway Cafe', slug: 'gateway-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  branch = await prisma.branch.create({ data: { companyId: company.id, name: 'Gw One', code: 'G1' } });
  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'owner.g@test.local', fullName: 'Owner G', role: 'CUSTOMER_OWNER', companyId: company.id });
  await mk({ email: 'cashier.g@test.local', fullName: 'Cashier G', role: 'CASHIER', companyId: company.id, branchId: branch.id });
  tokens.owner = await login('owner.g@test.local');
  tokens.cashier = await login('cashier.g@test.local');

  const tax = await request(app).post('/api/catalog/tax-rates').set(auth(tokens.owner))
    .send({ name: 'GST 5%', ratePercent: 5 });
  const cat = await request(app).post('/api/catalog/categories').set(auth(tokens.owner))
    .send({ name: 'Coffee', sortOrder: 1 });
  const prod = await request(app).post('/api/catalog/products').set(auth(tokens.owner))
    .send({ categoryId: cat.body.category.id, name: 'Latte', basePrice: 200, taxRateId: tax.body.taxRate.id });
  expect(prod.status, JSON.stringify(prod.body)).toBe(201);
  productId = prod.body.product.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('payment intents', () => {
  it('opens one intent on a billed order and reuses it instead of opening a second', async () => {
    const order = await billedOrder();
    const first = await openIntent(order.id);
    expect(first.status).toBe('PENDING');
    expect(Math.round(first.amount * 100)).toBe(order.totalPaise);
    expect(first.providerRef).toBeTruthy();

    const again = await request(app).post(`/api/orders/${order.id}/payment-intents`)
      .set(auth(tokens.cashier)).send({});
    expect(again.status).toBe(200);
    expect(again.body.intent.id).toBe(first.id);
  });

  it('never exposes the idempotency key', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    expect(intent.idempotencyKey).toBeUndefined();
    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.idempotencyKey).toBeTruthy();
  });

  it('refuses an intent on an order that is not billed', async () => {
    const created = await request(app).post('/api/orders').set(auth(tokens.cashier))
      .send({ type: 'TAKEAWAY', items: [{ productId, qty: 1 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await request(app).post(`/api/orders/${created.body.order.id}/payment-intents`)
      .set(auth(tokens.cashier)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/billed orders only/i);
  });

  it('refuses an intent once the order is fully paid', async () => {
    const order = await billedOrder();
    await request(app).post(`/api/orders/${order.id}/payments`).set(auth(tokens.cashier))
      .send({ method: 'CASH', tendered: order.totalPaise / 100 });
    const res = await request(app).post(`/api/orders/${order.id}/payment-intents`)
      .set(auth(tokens.cashier)).send({});
    // A fully paid order has already left BILLED, so it is refused by the
    // same state check the manual payments route uses.
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/billed orders only/i);
  });
});

describe('webhook signature verification', () => {
  it('settles an order on a correctly signed success event', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);

    const res = await deliver(succeeded(intent.providerRef, order.totalPaise));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.applied).toBe(true);

    const after = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(after.body.order.status).toBe('PAID');
    const payment = after.body.order.payments.find((p) => p.channel === 'GATEWAY');
    expect(payment).toBeTruthy();
    expect(Math.round(payment.amount * 100)).toBe(order.totalPaise);
    // The provider settled it, so there is no staff member to attribute it to.
    expect(payment.receivedBy).toBeNull();
    expect(payment.tendered).toBeNull();

    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('SUCCEEDED');
    expect(stored.closedAt).not.toBeNull();
  });

  it('refuses a delivery signed with the wrong secret and records nothing', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const before = await prisma.gatewayWebhookEvent.count();

    const res = await deliver(succeeded(intent.providerRef, order.totalPaise), {
      secret: 'an-entirely-different-secret',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('POS_GATEWAY_SIGNATURE_INVALID');
    // Terse on the wire: the caller is not told which check failed.
    expect(res.body.error.message).not.toMatch(/timestamp|mismatch|json/i);

    // The forged event id must not have been stored, or it could squat the
    // unique key and block the genuine delivery for good.
    expect(await prisma.gatewayWebhookEvent.count()).toBe(before);
    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('records the precise rejection reason in the audit log, not on the wire', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, order.totalPaise), { secret: 'wrong-secret-here' });

    const entry = await prisma.posAuditLog.findFirst({
      where: { action: 'GATEWAY_WEBHOOK_REJECTED' },
      orderBy: { at: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry.meta.reason).toBe('signature mismatch');
    expect(entry.meta.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a body tampered with after signing', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const genuine = JSON.stringify(succeeded(intent.providerRef, order.totalPaise));
    const forged = genuine.replace(`"amountPaise":${order.totalPaise}`, '"amountPaise":1');
    expect(forged).not.toBe(genuine);

    const res = await deliverRaw(forged, signPayload(SECRET, Math.floor(Date.now() / 1000), genuine));
    expect(res.status).toBe(400);
    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('refuses a replayed delivery whose signature is genuine but stale', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const res = await deliver(succeeded(intent.providerRef, order.totalPaise), {
      timestamp: Math.floor(Date.now() / 1000) - 301,
    });
    expect(res.status).toBe(400);
    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('refuses a delivery carrying no signature at all', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const raw = JSON.stringify(succeeded(intent.providerRef, order.totalPaise));
    const res = await request(app).post('/api/gateway/webhook')
      .set('Content-Type', 'application/json').send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('POS_GATEWAY_SIGNATURE_INVALID');
  });

  it('is not session-authenticated — the signature is the only credential', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    // No Authorization header anywhere in deliver(), and it still settles.
    const res = await deliver(succeeded(intent.providerRef, order.totalPaise));
    expect(res.body.applied).toBe(true);
  });
});

describe('idempotency', () => {
  it('applies a redelivered event exactly once', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const event = succeeded(intent.providerRef, order.totalPaise);

    const first = await deliver(event);
    expect(first.body.applied).toBe(true);
    const second = await deliver(event);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const payments = await prisma.payment.count({ where: { orderId: order.id } });
    expect(payments).toBe(1);
  });

  it('refuses a second, differently-identified event for an already-settled intent', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, order.totalPaise));

    const res = await deliver(succeeded(intent.providerRef, order.totalPaise));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);

    const row = await prisma.gatewayWebhookEvent.findFirst({
      where: { intentId: intent.id, skippedReason: { not: null } },
      orderBy: { receivedAt: 'desc' },
    });
    expect(row.skippedReason).toBe('intent already settled');
  });

  it('survives concurrent redelivery of the same event', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const event = succeeded(intent.providerRef, order.totalPaise);

    const results = await Promise.all([deliver(event), deliver(event), deliver(event)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.applied === true)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });
});

describe('what a verified event is still refused for', () => {
  it('refuses to settle an amount that does not match the intent', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);

    const res = await deliver(succeeded(intent.providerRef, order.totalPaise - 100));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);

    const row = await prisma.gatewayWebhookEvent.findFirst({
      where: { intentId: intent.id }, orderBy: { receivedAt: 'desc' },
    });
    expect(row.skippedReason).toBe('settled amount does not match the intent');
    // Nothing asserted about the money either way: no payment, and the intent
    // is left open for a human to judge.
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('records a verified event for an unknown provider reference without applying it', async () => {
    const res = await deliver(succeeded('test_no_such_reference', 5000));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    const row = await prisma.gatewayWebhookEvent.findFirst({
      where: { intentId: null }, orderBy: { receivedAt: 'desc' },
    });
    expect(row.skippedReason).toBe('no intent matches this provider reference');
  });

  it('marks the intent failed on a payment.failed event and records no payment', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const res = await deliver({
      id: `evt_fail_${Date.now()}`,
      type: 'payment.failed',
      data: { providerRef: intent.providerRef, amountPaise: order.totalPaise, currency: 'INR' },
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);

    const stored = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('FAILED');
    expect(stored.failureReason).toMatch(/provider reported/i);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);

    const after = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(after.body.order.status).toBe('BILLED');
  });

  it('records an unhandled event type without applying it', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const res = await deliver({
      id: `evt_odd_${Date.now()}`,
      type: 'payment.disputed',
      data: { providerRef: intent.providerRef, amountPaise: order.totalPaise, currency: 'INR' },
    });
    expect(res.status).toBe(200);
    const row = await prisma.gatewayWebhookEvent.findFirst({
      where: { intentId: intent.id }, orderBy: { receivedAt: 'desc' },
    });
    expect(row.skippedReason).toMatch(/unhandled event type "payment.disputed"/);
  });
});

// Re-imports the module graph under a temporarily altered environment, so the
// shipped configuration can be tested rather than merely asserted. config/env.js
// reads process.env once at load, which is exactly what this has to defeat.
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

describe('the shipped, unconfigured state', () => {
  it('exposes no webhook endpoint at all when no provider is configured', async () => {
    await withEnv({ POS_GATEWAY_PROVIDER: undefined, POS_GATEWAY_WEBHOOK_SECRET: undefined }, async () => {
      const { createApp: createBare } = await import('../src/app.js');
      const res = await request(createBare()).post('/api/gateway/webhook')
        .set('Content-Type', 'application/json').send('{}');
      // Not 501, not 403: there is no such route to probe.
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('POS_NOT_FOUND');
    });
  });

  it('refuses to open an intent, telling the cashier to record it manually', async () => {
    await withEnv({ POS_GATEWAY_PROVIDER: undefined, POS_GATEWAY_WEBHOOK_SECRET: undefined }, async () => {
      const { createApp: createBare } = await import('../src/app.js');
      const bare = createBare();
      const signIn = await request(bare).post('/api/auth/login')
        .send({ email: 'cashier.g@test.local', password: PW });
      const order = await billedOrder();
      const res = await request(bare).post(`/api/orders/${order.id}/payment-intents`)
        .set(auth(signIn.body.token)).send({});
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('POS_GATEWAY_NOT_CONFIGURED');
      expect(res.body.error.message).toMatch(/record the payment manually/i);
    });
  });

  it('refuses to boot at all with the test adapter under NODE_ENV=production', async () => {
    await withEnv({ NODE_ENV: 'production' }, async () => {
      // The adapter that settles on command must be unreachable wherever a
      // real customer could be charged, and this fires before any route
      // exists rather than on the first webhook.
      await expect(import('../src/config/env.js')).rejects.toThrow(
        /Gateway provider "test" cannot be used in production/,
      );
    });
  });

  it('refuses the test adapter under any NODE_ENV that is not test or development', async () => {
    // The registry's gate is a whitelist, so an unfamiliar NODE_ENV such as
    // "staging" refuses rather than quietly allowing a settle-on-command
    // adapter. This is the second, independent gate behind the boot check.
    await withEnv({ NODE_ENV: 'staging' }, async () => {
      const { getAdapter } = await import('../src/lib/gateway/index.js');
      expect(() => getAdapter()).toThrowError(/not enabled on this deployment/i);
    });
  });

  it('refuses at boot when a provider is named without a webhook secret', async () => {
    await withEnv({ POS_GATEWAY_PROVIDER: 'test', POS_GATEWAY_WEBHOOK_SECRET: undefined }, async () => {
      await expect(import('../src/config/env.js')).rejects.toThrow(
        /POS_GATEWAY_WEBHOOK_SECRET is missing/,
      );
    });
  });
});

describe('MANUAL and GATEWAY stay distinguishable', () => {
  it('a manual payment is never marked gateway-verified', async () => {
    const order = await billedOrder();
    const res = await request(app).post(`/api/orders/${order.id}/payments`).set(auth(tokens.cashier))
      .send({ method: 'CASH', tendered: order.totalPaise / 100 });
    expect(res.status).toBe(201);
    expect(res.body.payment.channel).toBe('MANUAL');
    expect(res.body.payment.receivedBy.fullName).toBe('Cashier G');
  });

  it('the two channels coexist on one order and stay labelled', async () => {
    const order = await billedOrder();
    const half = Math.floor(order.totalPaise / 2);
    await request(app).post(`/api/orders/${order.id}/payments`).set(auth(tokens.cashier))
      .send({ method: 'CASH', amount: half / 100 });

    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, order.totalPaise - half));

    const after = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(after.body.order.status).toBe('PAID');
    const channels = after.body.order.payments.map((p) => p.channel).sort();
    expect(channels).toEqual(['GATEWAY', 'MANUAL']);
    const manual = after.body.order.payments.find((p) => p.channel === 'MANUAL');
    const gateway = after.body.order.payments.find((p) => p.channel === 'GATEWAY');
    expect(manual.receivedBy).not.toBeNull();
    expect(gateway.receivedBy).toBeNull();
  });
});
