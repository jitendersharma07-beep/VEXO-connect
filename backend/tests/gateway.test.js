// Payment gateway suite (contract §13). Exercises the adapter, the webhook's
// signature verification, idempotent application and the reconciliation
// report against the test adapter — no provider account, no network.
//
// Every guard here is checked by its REASON, not merely by the fact that
// something was refused: a check that fires for the wrong cause is a check
// that will pass while the system is broken.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
const { signPayload, SIGNATURE_HEADER, testAdapter } = await import('../src/lib/gateway/testAdapter.js');

const app = createApp();
const SECRET = process.env.POS_GATEWAY_WEBHOOK_SECRET;

const wipe = async () => {
  // Before PosUser and Branch, which it references. Shared test database:
  // another file's DayClose rows block this file's PosUser delete.
  await prisma.dayClose.deleteMany();
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
const other = {};

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
const billedOrder = async (as = () => ({ token: tokens.cashier, productId })) => {
  const { token, productId: pid } = as();
  const created = await request(app).post('/api/orders').set(auth(token))
    .send({ type: 'TAKEAWAY', items: [{ productId: pid, qty: 2 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.order.id;
  const billed = await request(app).post(`/api/orders/${id}/bill`).set(auth(token)).send({});
  expect(billed.status, JSON.stringify(billed.body)).toBe(200);
  return { id, totalPaise: Math.round(billed.body.order.total * 100) };
};

const asOther = () => ({ token: other.cashierToken, productId: other.productId });

const openIntent = async (orderId, token = tokens.cashier) => {
  const res = await request(app).post(`/api/orders/${orderId}/payment-intents`)
    .set(auth(token)).send({});
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
  await mk({ email: 'atc.g@test.local', fullName: 'ATC Admin', role: 'POS_SUPER_ADMIN' });
  await mk({ email: 'owner.g@test.local', fullName: 'Owner G', role: 'CUSTOMER_OWNER', companyId: company.id });
  await mk({ email: 'cashier.g@test.local', fullName: 'Cashier G', role: 'CASHIER', companyId: company.id, branchId: branch.id });
  tokens.atc = await login('atc.g@test.local');
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

  // A second, unrelated tenant. Webhook events carry no company of their own,
  // so cross-tenant leakage in the reconciliation report is only provable with
  // a real neighbour to leak from.
  other.company = await prisma.company.create({
    data: {
      name: 'Rival Cafe', slug: 'rival-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  other.branch = await prisma.branch.create({
    data: { companyId: other.company.id, name: 'Rv One', code: 'R1' },
  });
  await mk({ email: 'owner.r@test.local', fullName: 'Owner R', role: 'CUSTOMER_OWNER', companyId: other.company.id });
  await mk({
    email: 'cashier.r@test.local', fullName: 'Cashier R', role: 'CASHIER',
    companyId: other.company.id, branchId: other.branch.id,
  });
  other.ownerToken = await login('owner.r@test.local');
  other.cashierToken = await login('cashier.r@test.local');

  const rTax = await request(app).post('/api/catalog/tax-rates').set(auth(other.ownerToken))
    .send({ name: 'GST 5%', ratePercent: 5 });
  const rCat = await request(app).post('/api/catalog/categories').set(auth(other.ownerToken))
    .send({ name: 'Tea', sortOrder: 1 });
  const rProd = await request(app).post('/api/catalog/products').set(auth(other.ownerToken))
    .send({ categoryId: rCat.body.category.id, name: 'Chai', basePrice: 100, taxRateId: rTax.body.taxRate.id });
  expect(rProd.status, JSON.stringify(rProd.body)).toBe(201);
  other.productId = rProd.body.product.id;
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

describe('reconciliation report', () => {
  const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  // An ATC operator has no company of their own, so the route makes them name
  // one; a customer's scope comes from their token and cannot be overridden.
  const fetchReport = (token) =>
    request(app).get('/api/reports/gateway-reconciliation')
      .query({ from: today(), to: today(), ...(token === tokens.atc ? { companyId: company.id } : {}) })
      .set(auth(token));

  // Assertions are scoped to ids this test created, never to running totals:
  // every other test in this file also writes intents and events.
  it('lists an open intent as an exception and drops it once settled', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);

    const before = await fetchReport(tokens.owner);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.report.exceptions.openIntents.map((i) => i.intentId)).toContain(intent.id);

    await deliver(succeeded(intent.providerRef, order.totalPaise));

    const after = await fetchReport(tokens.owner);
    expect(after.body.report.exceptions.openIntents.map((i) => i.intentId)).not.toContain(intent.id);
  });

  it('surfaces an amount mismatch as a verified-but-unapplied event', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, order.totalPaise - 100));

    const res = await fetchReport(tokens.owner);
    const row = res.body.report.exceptions.verifiedButNotApplied
      .find((e) => e.intentId === intent.id);
    expect(row).toBeTruthy();
    expect(row.reason).toBe('settled amount does not match the intent');
  });

  it('counts signature failures without ever storing them as events', async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const before = (await fetchReport(tokens.atc)).body.report.summary.signatureFailures;

    await deliver(succeeded(intent.providerRef, order.totalPaise), { secret: 'nope-wrong-secret' });
    await deliver(succeeded(intent.providerRef, order.totalPaise), { secret: 'nope-wrong-secret' });

    const after = await fetchReport(tokens.atc);
    expect(after.body.report.summary.signatureFailures).toBe(before + 2);
    // Counted, never stored: a forged id must not be able to occupy the key.
    expect(after.body.report.exceptions.verifiedButNotApplied
      .filter((e) => e.eventId?.startsWith('evt_') && e.intentId === intent.id)).toHaveLength(0);
  });

  it('tells a customer the signature-failure count is unknowable rather than zero', async () => {
    // A rejected delivery was never verified, so it cannot be tied to a
    // company. Reporting 0 would be a claim we have no basis to make.
    await deliver(succeeded('test_anything', 100), { secret: 'nope-wrong-secret' });

    const owner = await fetchReport(tokens.owner);
    expect(owner.body.report.summary.signatureFailures).toBeNull();
    expect((await fetchReport(tokens.atc)).body.report.summary.signatureFailures)
      .toBeGreaterThan(0);
  });

  it('reports no unprocessed events, because the insert and the settlement share a transaction', async () => {
    const res = await fetchReport(tokens.owner);
    expect(res.body.report.exceptions.unprocessedEvents).toBe(0);
  });

  it('names the configured provider', async () => {
    const res = await fetchReport(tokens.owner);
    expect(res.body.report.gateway.configured).toBe(true);
    expect(res.body.report.gateway.provider).toBe('test');
  });

  it('is refused to a cashier', async () => {
    const res = await fetchReport(tokens.cashier);
    expect(res.status).toBe(403);
  });

  it('never shows one tenant the gateway traffic of another', async () => {
    // Everything in this test belongs to Rival Cafe: an open intent, a
    // settled one, and a verified event that was refused on the amount.
    const open = await openIntent((await billedOrder(asOther)).id, other.cashierToken);
    const settledOrder = await billedOrder(asOther);
    const settled = await openIntent(settledOrder.id, other.cashierToken);
    await deliver(succeeded(settled.providerRef, settledOrder.totalPaise));
    const refusedOrder = await billedOrder(asOther);
    const refused = await openIntent(refusedOrder.id, other.cashierToken);
    await deliver(succeeded(refused.providerRef, refusedOrder.totalPaise - 100));

    const theirs = await fetchReport(other.ownerToken);
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body.report.exceptions.openIntents.map((i) => i.intentId)).toContain(open.id);
    expect(theirs.body.report.exceptions.verifiedButNotApplied.map((e) => e.intentId))
      .toContain(refused.id);

    // The neighbour sees none of it — not the intents, not the invoices, and
    // not the events, which are only reachable through their intent's order.
    //
    // Asserted id by id. `not.toEqual(expect.arrayContaining([...]))` would
    // only fail if EVERY id leaked, so a single leaked row would pass it.
    const mine = await fetchReport(tokens.owner);
    const body = JSON.stringify(mine.body);
    for (const id of [open.id, settled.id, refused.id,
                      settledOrder.id, refusedOrder.id]) {
      expect(body).not.toContain(id);
    }
  });

  it('hides unattributable events from a customer and shows them to ATC', async () => {
    // An event matching no intent belongs to nobody we can name; showing it
    // to a customer would disclose that another tenant's traffic exists.
    await deliver(succeeded('test_orphan_reference', 4200));

    const owner = await fetchReport(tokens.owner);
    expect(owner.body.report.summary.unattributedVisible).toBe(false);
    expect(owner.body.report.exceptions.verifiedButNotApplied
      .filter((e) => e.intentId === null)).toHaveLength(0);

    const atc = await fetchReport(tokens.atc);
    expect(atc.body.report.summary.unattributedVisible).toBe(true);
    expect(atc.body.report.exceptions.verifiedButNotApplied
      .filter((e) => e.intentId === null).length).toBeGreaterThan(0);
  });
});

describe('sales report keeps the channels apart', () => {
  it('never merges a manual and a gateway payment of the same method', async () => {
    const order = await billedOrder();
    const half = Math.floor(order.totalPaise / 2);
    // Both legs are OTHER: the test adapter reports no instrument, and a
    // manual OTHER is the method that would collide with it.
    await request(app).post(`/api/orders/${order.id}/payments`).set(auth(tokens.cashier))
      .send({ method: 'OTHER', amount: half / 100 });
    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, order.totalPaise - half));

    const res = await request(app).get('/api/reports/sales')
      .query({ from: today(), to: today() }).set(auth(tokens.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const other = res.body.report.byMethod.filter((m) => m.method === 'OTHER');
    const channels = other.map((m) => m.channel).sort();
    expect(channels).toEqual(['GATEWAY', 'MANUAL']);

    const byChannel = Object.fromEntries(
      res.body.report.byChannel.map((c) => [c.channel, c.amount]),
    );
    expect(byChannel.GATEWAY).toBeGreaterThan(0);
    expect(byChannel.MANUAL).toBeGreaterThan(0);
  });

  function today() {
    return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  }
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

describe('gateway refunds', () => {
  // Money the provider collected is returned by the provider, and only its
  // refund.succeeded webhook may say the customer actually has it back.
  // Same discipline as payments: asking is not receiving.
  let rfSeq = 0;
  const refundEvent = (kind, providerRef, amountPaise) => ({
    id: `evt_rf_${++rfSeq}_${Date.now()}`,
    type: kind,
    data: { providerRef, amountPaise, currency: 'INR' },
  });

  const gatewayPaid = async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const res = await deliver(succeeded(intent.providerRef, order.totalPaise));
    expect(res.body.applied, JSON.stringify(res.body)).toBe(true);
    return { ...order, intentId: intent.id };
  };

  const requestRefund = (orderId, rupees, reason = 'customer returned the order') =>
    request(app).post(`/api/orders/${orderId}/refunds`).set(auth(tokens.owner))
      .send({ amount: rupees, reason });

  const refundRow = (orderId) =>
    prisma.refund.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' } });

  it('sends a refund of gateway money back through the provider and settles nothing yet', async () => {
    const order = await gatewayPaid();
    const res = await requestRefund(order.id, order.totalPaise / 100);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.refund.channel).toBe('GATEWAY');
    expect(res.body.refund.status).toBe('PENDING');
    expect(res.body.refund.settledAt).toBeNull();

    // Nothing has moved: the order is still PAID, the money merely reserved.
    expect(res.body.order.status).toBe('PAID');
    expect(res.body.order.amountRefunded).toBe(0);
    expect(Math.round(res.body.order.amountRefundPending * 100)).toBe(order.totalPaise);

    const row = await refundRow(order.id);
    expect(row.providerRef).toMatch(/^testrf_/);
    expect(row.intentId).toBe(order.intentId);

    const entry = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_REFUND_REQUESTED', entityId: order.id },
    });
    expect(entry).toBeTruthy();
    expect(entry.meta.status).toBe('PENDING');
  });

  it('refund.succeeded settles the request, and only then is the order unwound', async () => {
    const order = await gatewayPaid();
    await requestRefund(order.id, order.totalPaise / 100);
    const row = await refundRow(order.id);

    const res = await deliver(refundEvent('refund.succeeded', row.providerRef, order.totalPaise));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.applied).toBe(true);

    const settled = await prisma.refund.findUnique({ where: { id: row.id } });
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.settledAt).not.toBeNull();

    const after = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(after.body.order.status).toBe('REFUNDED');
    expect(Math.round(after.body.order.amountRefunded * 100)).toBe(order.totalPaise);
    expect(after.body.order.amountRefundPending).toBe(0);

    const entry = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_REFUND_SETTLED', entityId: order.id },
    });
    expect(entry).toBeTruthy();
    expect(entry.meta.refundId).toBe(row.id);
  });

  it('refund.failed marks the request failed and frees the money to be requested again', async () => {
    const order = await gatewayPaid();
    await requestRefund(order.id, order.totalPaise / 100);
    const row = await refundRow(order.id);

    const res = await deliver(refundEvent('refund.failed', row.providerRef, order.totalPaise));
    expect(res.body.applied).toBe(true);

    const failed = await prisma.refund.findUnique({ where: { id: row.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toMatch(/provider reported/i);
    expect(failed.settledAt).not.toBeNull();

    // The order was never unwound, and a FAILED request reserves nothing —
    // so the same money may be asked back a second time.
    const view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.status).toBe('PAID');
    expect(view.body.order.amountRefunded).toBe(0);
    expect(view.body.order.amountRefundPending).toBe(0);

    const again = await requestRefund(order.id, order.totalPaise / 100, 'second attempt after failure');
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.refund.status).toBe('PENDING');

    const entry = await prisma.posAuditLog.findFirst({
      where: { action: 'ORDER_REFUND_FAILED', entityId: order.id },
    });
    expect(entry).toBeTruthy();
  });

  it('refuses to settle a refund for an amount that was never requested', async () => {
    const order = await gatewayPaid();
    const half = Math.floor(order.totalPaise / 2);
    await requestRefund(order.id, half / 100);
    const row = await refundRow(order.id);

    const res = await deliver(refundEvent('refund.succeeded', row.providerRef, half - 100));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);

    const evt = await prisma.gatewayWebhookEvent.findFirst({
      where: { intentId: order.intentId, skippedReason: { not: null } },
      orderBy: { receivedAt: 'desc' },
    });
    expect(evt.skippedReason).toBe('refunded amount does not match the request');

    // Change nothing, assert nothing: the request stays open for a human.
    const untouched = await prisma.refund.findUnique({ where: { id: row.id } });
    expect(untouched.status).toBe('PENDING');
    const view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.status).toBe('PAID');
  });

  it('applies a redelivered settlement exactly once and refuses a fresh event for a settled refund', async () => {
    const order = await gatewayPaid();
    await requestRefund(order.id, order.totalPaise / 100);
    const row = await refundRow(order.id);
    const event = refundEvent('refund.succeeded', row.providerRef, order.totalPaise);

    const first = await deliver(event);
    expect(first.body.applied).toBe(true);
    const second = await deliver(event);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const third = await deliver(refundEvent('refund.succeeded', row.providerRef, order.totalPaise));
    expect(third.body.applied).toBe(false);
    const evt = await prisma.gatewayWebhookEvent.findFirst({
      where: { skippedReason: 'refund already succeeded' },
      orderBy: { receivedAt: 'desc' },
    });
    expect(evt).toBeTruthy();

    const after = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(after.body.order.status).toBe('REFUNDED');
    expect(after.body.order.refunds.filter((r) => r.status === 'SUCCEEDED')).toHaveLength(1);
  });

  it('records a verified refund event that matches no refund without applying it', async () => {
    const res = await deliver(refundEvent('refund.succeeded', 'testrf_no_such_reference', 4200));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    const evt = await prisma.gatewayWebhookEvent.findFirst({
      where: { skippedReason: 'no refund matches this provider reference' },
      orderBy: { receivedAt: 'desc' },
    });
    expect(evt).toBeTruthy();
  });

  it('a partial settlement never unwinds the order; the remainder completes it', async () => {
    const order = await gatewayPaid();
    const half = Math.floor(order.totalPaise / 2);

    await requestRefund(order.id, half / 100, 'half back first');
    const firstRow = await refundRow(order.id);
    await deliver(refundEvent('refund.succeeded', firstRow.providerRef, half));

    let view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.status).toBe('PAID');
    expect(Math.round(view.body.order.amountRefunded * 100)).toBe(half);

    const rest = order.totalPaise - half;
    await requestRefund(order.id, rest / 100, 'and the remainder');
    const secondRow = await refundRow(order.id);
    expect(secondRow.id).not.toBe(firstRow.id);
    await deliver(refundEvent('refund.succeeded', secondRow.providerRef, rest));

    view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.status).toBe('REFUNDED');
    expect(Math.round(view.body.order.amountRefunded * 100)).toBe(order.totalPaise);
  });

  // Half in cash, half through the provider. Two pools, and a refund has to
  // come out of the one that actually took the money.
  const mixedOrder = async () => {
    const order = await billedOrder();
    const cash = Math.floor(order.totalPaise / 2);
    const card = order.totalPaise - cash;
    await request(app).post(`/api/orders/${order.id}/payments`).set(auth(tokens.cashier))
      .send({ method: 'CASH', amount: cash / 100 });
    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, card));
    return { ...order, cash, card, intentId: intent.id, intentProviderRef: intent.providerRef };
  };

  it('refuses a refund that no single payment can cover, rather than guessing a split', async () => {
    const order = await mixedOrder();

    // The whole total exceeds either leg. Routing it to the provider would ask
    // for more than the provider ever took; routing it to the till would hand
    // back cash the shop never held. Both are wrong, so neither is chosen.
    const res = await requestRefund(order.id, order.totalPaise / 100, 'full refund across both legs');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('amount');
    expect(res.body.error.message).toMatch(/more than one part/i);
    expect(res.body.error.message).toMatch(/Refund each payment separately/i);
    // It names the largest single refund that WOULD work, so the operator is
    // told what to do rather than left guessing.
    expect(res.body.error.message).toContain(`₹${(order.card / 100).toFixed(2)}`);

    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('ties each leg of a mixed order to the payment that took the money', async () => {
    const order = await mixedOrder();

    // The provider leg goes back to the provider, against that intent, and
    // waits for confirmation.
    const viaGateway = await requestRefund(order.id, order.card / 100, 'card share back');
    expect(viaGateway.status, JSON.stringify(viaGateway.body)).toBe(201);
    expect(viaGateway.body.refund.channel).toBe('GATEWAY');
    expect(viaGateway.body.refund.status).toBe('PENDING');
    const gwRow = await prisma.refund.findFirst({ where: { orderId: order.id, channel: 'GATEWAY' } });
    expect(gwRow.intentId).toBe(order.intentId);

    // The cash leg is handed over the counter and is done on the spot. It is
    // NOT attached to the intent — that money never went through the provider.
    const viaTill = await requestRefund(order.id, order.cash / 100, 'cash share back');
    expect(viaTill.status, JSON.stringify(viaTill.body)).toBe(201);
    expect(viaTill.body.refund.channel).toBe('MANUAL');
    expect(viaTill.body.refund.status).toBe('SUCCEEDED');
    const cashRow = await prisma.refund.findFirst({ where: { orderId: order.id, channel: 'MANUAL' } });
    expect(cashRow.intentId).toBeNull();
    expect(cashRow.providerRef).toBeNull();
    expect(cashRow.idempotencyKey).toBeNull();

    // Only the cash is back so far, and the order is not unwound while the
    // provider still owes its share.
    let view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(Math.round(view.body.order.amountRefunded * 100)).toBe(order.cash);
    expect(Math.round(view.body.order.amountRefundPending * 100)).toBe(order.card);
    expect(view.body.order.status).toBe('PAID');

    // Both legs are now fully spoken for, so nothing more can be asked back.
    const excess = await requestRefund(order.id, 0.01, 'one paisa too many');
    expect(excess.status, JSON.stringify(excess.body)).toBe(400);
    expect(excess.body.error.message).toMatch(/exceeds the amount collected/i);

    await deliver(refundEvent('refund.succeeded', gwRow.providerRef, order.card));
    view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.status).toBe('REFUNDED');
    expect(Math.round(view.body.order.amountRefunded * 100)).toBe(order.totalPaise);
  });

  it('will not refund a leg twice over, even when the order as a whole has room', async () => {
    const order = await mixedOrder();

    const first = await requestRefund(order.id, order.card / 100, 'card share back');
    expect(first.status).toBe(201);
    expect(first.body.refund.channel).toBe('GATEWAY');

    // The order still has the cash leg outstanding, so the TOTAL cap would
    // allow this. The per-leg cap is what stops the provider being asked to
    // return the card payment a second time; without it the customer is paid
    // the card amount twice and the till is never touched.
    const second = await requestRefund(order.id, order.card / 100, 'and again');
    if (second.status === 201) {
      expect(second.body.refund.channel, 'the card leg was refunded twice').toBe('MANUAL');
    }
    const gatewayRefunds = await prisma.refund.findMany({
      where: { orderId: order.id, channel: 'GATEWAY' },
    });
    const gatewayTotal = gatewayRefunds.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    expect(gatewayTotal).toBeLessThanOrEqual(order.card);
  });

  it('refuses to refund provider-collected money once the provider is gone', async () => {
    const order = await gatewayPaid();
    await withEnv({ POS_GATEWAY_PROVIDER: undefined, POS_GATEWAY_WEBHOOK_SECRET: undefined }, async () => {
      const { createApp: createBare } = await import('../src/app.js');
      const bare = createBare();
      const signIn = await request(bare).post('/api/auth/login')
        .send({ email: 'owner.g@test.local', password: PW });
      const res = await request(bare).post(`/api/orders/${order.id}/refunds`)
        .set(auth(signIn.body.token))
        .send({ amount: order.totalPaise / 100, reason: 'attempt with no provider' });
      // Refunding it against the till would hand back cash the shop never
      // received, so the route refuses and points at the provider dashboard.
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/no longer configured/i);
      expect(res.body.error.message).toMatch(/provider dashboard/i);
    });
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('refuses a refund on another company\'s order, indistinguishably from one that does not exist', async () => {
    const ours = await gatewayPaid();
    const absent = 'ckzzzzzzzzzzzzzzzzzzzzzzz';

    // The other tenant's owner is a real, fully privileged user — just not
    // here. The answer must carry no signal that this order exists at all.
    const cross = await request(app).post(`/api/orders/${ours.id}/refunds`)
      .set(auth(other.ownerToken)).send({ amount: 1, reason: 'not mine to refund' });
    const missing = await request(app).post(`/api/orders/${absent}/refunds`)
      .set(auth(other.ownerToken)).send({ amount: 1, reason: 'no such order' });

    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);
    expect(await prisma.refund.count({ where: { orderId: ours.id } })).toBe(0);

    // Reconcile is a second door onto the same money; it must be locked too.
    await requestRefund(ours.id, ours.totalPaise / 100);
    const row = await refundRow(ours.id);
    const crossReconcile = await request(app)
      .post(`/api/orders/${ours.id}/refunds/${row.id}/reconcile`)
      .set(auth(other.ownerToken)).send({});
    expect(crossReconcile.status).toBe(404);
  });
});

// The provider is asked over a network, and a network can decline to answer.
// "No answer" is not "no refund": the request may be paying out this second.
describe('a refund whose outcome the provider never reported', () => {
  let rfSeq = 0;
  const refundEvent = (kind, providerRef, amountPaise) => ({
    id: `evt_unk_${++rfSeq}_${Date.now()}`,
    type: kind,
    data: { providerRef, amountPaise, currency: 'INR' },
  });

  const gatewayPaid = async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    const res = await deliver(succeeded(intent.providerRef, order.totalPaise));
    expect(res.body.applied, JSON.stringify(res.body)).toBe(true);
    return { ...order, intentId: intent.id };
  };

  const requestRefund = (orderId, rupees, reason = 'customer returned the order') =>
    request(app).post(`/api/orders/${orderId}/refunds`).set(auth(tokens.owner))
      .send({ amount: rupees, reason });

  const refundRow = (orderId) =>
    prisma.refund.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' } });

  afterEach(() => vi.restoreAllMocks());

  it('holds the money and records the request when the provider times out', async () => {
    const order = await gatewayPaid();
    vi.spyOn(testAdapter, 'createRefund').mockRejectedValue(new Error('socket hang up'));

    const res = await requestRefund(order.id, order.totalPaise / 100);
    // 202, not 201 and not 5xx. The refund is on record; whether the provider
    // took it is unknown, and neither "created" nor "failed" would be true.
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.warning).toMatch(/did not confirm/i);
    expect(res.body.warning).toMatch(/do not raise a new one/i);

    // The row EXISTS. This is the whole point: a rolled-back transaction here
    // would leave the provider possibly paying out with nothing on our side.
    const row = await refundRow(order.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('PENDING');
    expect(row.providerRef).toBeNull();
    expect(row.idempotencyKey).toBeTruthy();
    expect(row.failureReason).toMatch(/socket hang up/);

    // And it holds its amount, so nothing further can be requested back.
    const view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.amountRefunded).toBe(0);
    expect(Math.round(view.body.order.amountRefundPending * 100)).toBe(order.totalPaise);
    expect(view.body.order.status).toBe('PAID');
    expect(view.body.order.refunds[0].providerConfirmed).toBe(false);
    expect(view.body.order.refunds[0].label).toMatch(/awaiting confirmation/i);
  });

  it('refuses to raise a second refund while one is unconfirmed', async () => {
    const order = await gatewayPaid();
    vi.spyOn(testAdapter, 'createRefund').mockRejectedValue(new Error('gateway timeout'));
    expect((await requestRefund(order.id, 1)).status).toBe(202);
    vi.restoreAllMocks();

    // There is plenty of room under the cap, so only the unconfirmed request
    // itself is what stops this. Raising another would be guessing about
    // money that may already have moved.
    const second = await requestRefund(order.id, 1, 'try again the wrong way');
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.message).toMatch(/never confirmed/i);
    expect(second.body.error.message).toMatch(/Reconcile/i);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('reconciles with the ORIGINAL idempotency key, so the provider sees one refund', async () => {
    const order = await gatewayPaid();
    const sent = [];
    const spy = vi.spyOn(testAdapter, 'createRefund');
    spy.mockImplementation(async (args) => {
      sent.push(args);
      throw new Error('no answer from upstream');
    });

    const first = await requestRefund(order.id, order.totalPaise / 100);
    expect(first.status).toBe(202);
    const row = await refundRow(order.id);
    const key = row.idempotencyKey;

    // Now the provider is reachable again. It derives its reference from the
    // key, exactly as a provider honouring idempotency does — so the same key
    // yielding the same reference is what "one refund, not two" looks like.
    spy.mockRestore();
    const realSpy = vi.spyOn(testAdapter, 'createRefund');
    realSpy.mockImplementation(async (args) => {
      sent.push(args);
      return { providerRef: `testrf_${args.idempotencyKey.slice(0, 16)}` };
    });

    const res = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // THE key assertion: the retry carried the same key as the first attempt.
    // A fresh key here is a second refund and a second payout.
    expect(sent).toHaveLength(2);
    expect(sent[1].idempotencyKey).toBe(key);
    expect(sent[1].amountPaise).toBe(order.totalPaise);

    // Still one row, now confirmed, still PENDING until the webhook lands.
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    const after = await prisma.refund.findUnique({ where: { id: row.id } });
    expect(after.idempotencyKey).toBe(key);
    expect(after.providerRef).toBeTruthy();
    expect(after.status).toBe('PENDING');
    expect(after.failureReason).toBeNull();

    // And it is the confirmed reference the webhook settles against.
    realSpy.mockRestore();
    await deliver(refundEvent('refund.succeeded', after.providerRef, order.totalPaise));
    const settled = await prisma.refund.findUnique({ where: { id: row.id } });
    expect(settled.status).toBe('SUCCEEDED');
    const view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(view.body.order.status).toBe('REFUNDED');
    expect(Math.round(view.body.order.amountRefunded * 100)).toBe(order.totalPaise);
  });

  it('keeps holding the money when reconciliation also gets no answer', async () => {
    const order = await gatewayPaid();
    vi.spyOn(testAdapter, 'createRefund').mockRejectedValue(new Error('still nothing'));
    await requestRefund(order.id, order.totalPaise / 100);
    const row = await refundRow(order.id);

    const res = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(res.status).toBe(202);
    expect(res.body.warning).toMatch(/still did not confirm/i);

    const after = await prisma.refund.findUnique({ where: { id: row.id } });
    expect(after.status).toBe('PENDING');
    expect(after.providerRef).toBeNull();
    expect(after.idempotencyKey).toBe(row.idempotencyKey);
    const view = await request(app).get(`/api/orders/${order.id}`).set(auth(tokens.cashier));
    expect(Math.round(view.body.order.amountRefundPending * 100)).toBe(order.totalPaise);
  });

  it('will not reconcile a refund the provider already has, or one already settled', async () => {
    const order = await gatewayPaid();
    await requestRefund(order.id, order.totalPaise / 100);
    const row = await refundRow(order.id);
    expect(row.providerRef).toBeTruthy();

    const confirmed = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(confirmed.status).toBe(409);
    expect(confirmed.body.error.message).toMatch(/already has this refund/i);

    await deliver(refundEvent('refund.succeeded', row.providerRef, order.totalPaise));
    const settled = await request(app)
      .post(`/api/orders/${order.id}/refunds/${row.id}/reconcile`)
      .set(auth(tokens.owner)).send({});
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/already succeeded/i);
  });

  it('surfaces an unconfirmed refund apart from one the provider has accepted', async () => {
    // Delta-based: earlier tests in this file leave their own pending refunds
    // behind, so absolute counts would assert on unrelated residue.
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const fetchReport = async () => {
      const res = await request(app).get('/api/reports/gateway-reconciliation')
        .query({ from: today, to: today })
        .set(auth(tokens.owner));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.report;
    };
    const before = await fetchReport();

    const unknown = await gatewayPaid();
    vi.spyOn(testAdapter, 'createRefund').mockRejectedValue(new Error('no answer'));
    await requestRefund(unknown.id, unknown.totalPaise / 100);
    vi.restoreAllMocks();

    const accepted = await gatewayPaid();
    await requestRefund(accepted.id, accepted.totalPaise / 100);

    const after = await fetchReport();

    // Two different problems. Lumping them together would hide the one that
    // must never be retried as a fresh refund.
    expect(after.summary.refundsUnconfirmedByProvider - before.summary.refundsUnconfirmedByProvider).toBe(1);
    expect(after.summary.refundsAwaitingProvider - before.summary.refundsAwaitingProvider).toBe(1);

    const newly = (key, prev) => {
      const seen = new Set(prev.exceptions[key].map((r) => r.refundId));
      return after.exceptions[key].filter((r) => !seen.has(r.refundId));
    };
    const newUnconfirmed = newly('refundsUnconfirmedByProvider', before);
    const newAwaiting = newly('refundsAwaitingProvider', before);
    expect(newUnconfirmed.map((r) => r.orderId)).toEqual([unknown.id]);
    expect(newAwaiting.map((r) => r.orderId)).toEqual([accepted.id]);
    expect(newUnconfirmed[0].failureReason).toMatch(/did not confirm/i);
  });
});

// Two cashiers, one order, the same instant. The cap is only a cap if it
// survives that; a check-then-insert with no lock is not one.
describe('refunds under concurrency', () => {
  const gatewayPaid = async () => {
    const order = await billedOrder();
    const intent = await openIntent(order.id);
    await deliver(succeeded(intent.providerRef, order.totalPaise));
    return order;
  };

  const fire = (orderId, rupees, reason) =>
    request(app).post(`/api/orders/${orderId}/refunds`).set(auth(tokens.owner))
      .send({ amount: rupees, reason });

  it('never reserves more than was collected, however simultaneous the requests', async () => {
    const order = await gatewayPaid();
    const full = order.totalPaise / 100;

    // Both ask for the whole amount at once. Exactly one may win.
    const results = await Promise.all([
      fire(order.id, full, 'first cashier'),
      fire(order.id, full, 'second cashier'),
    ]);

    const created = results.filter((r) => r.status === 201 || r.status === 202);
    expect(created).toHaveLength(1);
    const refused = results.find((r) => r.status >= 400);
    // Either refusal is correct. Whichever transaction loses the row lock
    // sees the winner's row — as a cap breach if the winner had already been
    // confirmed by the provider, or as an unconfirmed request still in
    // flight if it had not. Both refuse; neither over-refunds.
    expect(refused.body.error.message).toMatch(/exceeds the amount collected|never confirmed/i);

    const rows = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    const reserved = rows.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    expect(reserved).toBe(order.totalPaise);
  });

  it('holds the cap across many partial requests fired together', async () => {
    const order = await gatewayPaid();
    // Six requests for a quarter each: at most four can fit.
    const quarter = Math.floor(order.totalPaise / 4);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => fire(order.id, quarter / 100, `slice ${i}`)),
    );

    const accepted = results.filter((r) => r.status === 201 || r.status === 202);
    const rows = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(accepted.length);

    const reserved = rows.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0);
    // The invariant, stated as money rather than as a count: the shop can
    // never owe back more than it took.
    expect(reserved).toBeLessThanOrEqual(order.totalPaise);
    expect(accepted.length).toBeLessThanOrEqual(4);
    expect(accepted.length).toBeGreaterThan(0);
  });
});
