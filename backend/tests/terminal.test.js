// Card-present payments through a terminal connector (contract §2, §3, §4).
//
// Everything here runs against the SIMULATED reader in src/lib/terminal/
// simulator.js. That simulator is not a Pine Labs, Ezetap or Mswipe
// integration, speaks no vendor's protocol and reads no card — and a file that
// asserts its behaviour is therefore evidence about the POS, never about a
// vendor. What these tests can prove is the part that does not depend on which
// device is on the counter: the attempt lifecycle, idempotency, the five
// outcomes, recovery after a cut connection, and the rule that only the
// device's own answer may settle a payment.
//
// The three sentences the file exists to hold:
//   - a terminal timeout is not payment confirmation, and is not a decline
//   - an UNCERTAIN outcome is never resolved into a manual payment
//   - a provider-confirmed card payment stays distinguishable from a
//     hand-recorded one, in the row, forever
//
// The negative controls are the point of several of these. "An unreachable
// reader does not change the attempt" only means something if the same attempt
// IS changed when the reader answers, so both halves are asserted.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('terminal.test.js requires a DATABASE_URL ending in _test');
}

// Must precede the app import: config/env.js reads process.env once, at load.
// The gateway is configured too, because one of the rules under test is that a
// browser checkout and a reader cannot both hold the same balance.
process.env.POS_TERMINAL_PROVIDER = 'sim';
process.env.POS_GATEWAY_PROVIDER = 'test';
process.env.POS_GATEWAY_WEBHOOK_SECRET = 'terminal-suite-secret-not-a-real-one';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword, hashSecret } = await import('../src/lib/crypto.js');
const { connectorCatalogue, getConnector } = await import('../src/lib/terminal/index.js');
const { setSimOutcome, setSimUnreachable, setSimReaderDead, clearSimTerminal, simProviderRef } =
  await import('../src/lib/terminal/simulator.js');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const wipe = async () => {
  // Shared test database, and files run one after another: whatever an earlier
  // suite left behind RESTRICTs a delete in here. This is the order the
  // established suites use, plus this lane's device-command and merchant-account
  // tables. Measured — without orderItemModifier the whole file aborts on a
  // foreign key from rows it never created itself.
  await prisma.deviceCommand.deleteMany();
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
  await prisma.paymentProviderAccount.deleteMany();
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
  await prisma.device.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';

// Shop A is the one under test. Shop B exists so every isolation claim has
// something real to be isolated from.
const A = { tokens: {} };
const B = { tokens: {} };

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const buildShop = async (shop, { slug, name, publicId, code }) => {
  const passwordHash = await hashPassword(PW);
  shop.company = await prisma.company.create({
    data: {
      name,
      slug,
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 2, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  shop.branch = await prisma.branch.create({
    data: { companyId: shop.company.id, publicId, name: 'Main', code },
  });
  const mk = (email, fullName, role) =>
    prisma.posUser.create({
      data: { email, fullName, role, companyId: shop.company.id, branchId: shop.branch.id, passwordHash },
    });
  shop.ownerId = (await mk(`owner@${slug}.test`, 'Owner', 'CUSTOMER_OWNER')).id;
  await mk(`till@${slug}.test`, 'Till', 'CASHIER');
  shop.tokens.owner = await login(`owner@${slug}.test`);
  shop.tokens.cashier = await login(`till@${slug}.test`);

  const tax = await prisma.taxRate.create({
    data: { companyId: shop.company.id, name: 'No tax', ratePercent: '0.00' },
  });
  const cat = await prisma.category.create({
    data: { companyId: shop.company.id, name: 'Food', sortOrder: 1 },
  });
  // Zero-rated and round, so every amount in this file is the number it looks
  // like and a split tender can be checked by adding up in one's head.
  shop.productId = (
    await prisma.product.create({
      data: {
        companyId: shop.company.id,
        categoryId: cat.id,
        name: 'Thali',
        basePrice: '100.00',
        taxRateId: tax.id,
      },
    })
  ).id;

  shop.reader = await mkReader(shop, { name: 'Counter reader', readerRef: `rdr-${slug}-1` });
};

// Devices are created directly rather than through the enrolment flow: what
// this file is about starts once a reader exists, and the enrolment routes have
// their own suite.
let deviceSeq = 0;
// The shape the database enforces: VX-DVC- and at least eight digits.
const devicePublicId = () => `VX-DVC-${String(++deviceSeq).padStart(8, '0')}`;
const mkReader = (shop, { name, readerRef, type = 'PAYMENT_TERMINAL', status = 'ACTIVE', terminalId = null }) =>
  prisma.device.create({
    data: {
      publicId: devicePublicId(),
      companyId: shop.company.id,
      branchId: shop.branch.id,
      terminalId,
      name,
      type,
      status,
      readerRef,
    },
  });

const billed = async (shop, { qty = 1, token = shop.tokens.cashier } = {}) => {
  const created = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ type: 'TAKEAWAY', items: [{ productId: shop.productId, qty }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.order.id;
  const bill = await request(app).post(`/api/orders/${id}/bill`).set(auth(token)).send({});
  expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  return { id, total: bill.body.order.total };
};

const startTerminal = (shop, orderId, body, token = shop.tokens.cashier, headers = {}) =>
  request(app)
    .post(`/api/orders/${orderId}/terminal-payments`)
    .set(auth(token))
    .set(headers)
    .send({ deviceId: shop.reader.id, ...body });

const askStatus = (shop, orderId, intentId, token = shop.tokens.cashier) =>
  request(app)
    .post(`/api/orders/${orderId}/terminal-payments/${intentId}/status`)
    .set(auth(token))
    .send({});

const cancelAttempt = (shop, orderId, intentId, token = shop.tokens.cashier) =>
  request(app)
    .post(`/api/orders/${orderId}/terminal-payments/${intentId}/cancel`)
    .set(auth(token))
    .send({});

const manualPay = (shop, orderId, body, token = shop.tokens.cashier) =>
  request(app).post(`/api/orders/${orderId}/payments`).set(auth(token)).send(body);

const readOrder = async (shop, orderId, token = shop.tokens.cashier) => {
  const res = await request(app).get(`/api/orders/${orderId}`).set(auth(token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
};

// An attempt that has reached the reader and is waiting for a card — the state
// a real one spends most of its life in, and the starting point of nearly
// every test below.
const pending = async (shop, opts = {}) => {
  const order = await billed(shop, opts);
  const res = await startTerminal(shop, order.id, opts.amount === undefined ? {} : { amount: opts.amount });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.status).toBe('PENDING');
  return { order, intent: res.body.intent };
};

beforeAll(async () => {
  await wipe();
  await buildShop(A, { slug: 'term-a', name: 'Terminal A', publicId: 'VC-TM-0001', code: 'TA' });
  await buildShop(B, { slug: 'term-b', name: 'Terminal B', publicId: 'VC-TM-0002', code: 'TB' });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(() => {
  clearSimTerminal();
});

// ---------------------------------------------------------------------------

describe('what this build actually has', () => {
  it('registers every vendor connector as unavailable, each naming its dependency', () => {
    const catalogue = connectorCatalogue();
    const vendors = catalogue.filter((c) => c.name !== 'sim');
    expect(vendors.map((c) => c.name).sort()).toEqual(['ezetap', 'mswipe', 'pinelabs', 'softpos']);
    for (const c of vendors) {
      expect(c.available, `${c.name} must not claim to be available`).toBe(false);
      // A sentence an operator can act on, not a status word.
      expect(typeof c.dependency).toBe('string');
      expect(c.dependency.length).toBeGreaterThan(20);
      // Nothing about an unimplemented device's abilities is asserted. An
      // unverified capability is a promise made to a cashier on a customer's
      // behalf.
      expect(Object.values(c.capabilities).every((v) => v === false)).toBe(true);
    }
  });

  it('labels the only runnable connector as a simulator, and it refuses to refund', () => {
    const sim = connectorCatalogue().find((c) => c.name === 'sim');
    expect(sim.available).toBe(true);
    expect(sim.vendor).toMatch(/simulat/i);
    expect(sim.vendor).toMatch(/test and development only/i);
    // No connector in this build can move money back, including this one.
    // A simulator-only refund path would be plumbing no real connector can
    // satisfy, and a green test for it would be the fake success the brief
    // forbids.
    expect(sim.capabilities.createRefund).toBe(false);
    expect(getConnector().name).toBe('sim');
  });

  it('exposes the same catalogue to an operator, gaps included', async () => {
    const res = await request(app).get('/api/devices/reader-connectors').set(auth(A.tokens.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pine = res.body.connectors.find((c) => c.name === 'pinelabs');
    expect(pine.available).toBe(false);
    expect(pine.dependency).toMatch(/documentation/i);
  });
});

// Re-imports the module graph under a temporarily altered environment, so the
// shipped configuration is tested rather than merely asserted.
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
  it('refuses a card attempt and tells the cashier to use the terminal itself', async () => {
    const order = await billed(A);
    await withEnv({ POS_TERMINAL_PROVIDER: undefined }, async () => {
      const { createApp: bare } = await import('../src/app.js');
      const res = await request(bare())
        .post(`/api/orders/${order.id}/terminal-payments`)
        .set(auth(A.tokens.cashier))
        .send({ deviceId: A.reader.id });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('POS_TERMINAL_NOT_CONFIGURED');
      expect(res.body.error.message).toMatch(/record it/i);
    });
  });

  it('names the missing dependency when a registered vendor connector is selected', async () => {
    const order = await billed(A);
    await withEnv({ POS_TERMINAL_PROVIDER: 'pinelabs' }, async () => {
      const { createApp: bare } = await import('../src/app.js');
      const res = await request(bare())
        .post(`/api/orders/${order.id}/terminal-payments`)
        .set(auth(A.tokens.cashier))
        .send({ deviceId: A.reader.id });
      // 501 with the dependency in the message, not a button that fails with a
      // customer waiting.
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('POS_TERMINAL_CONNECTOR_UNAVAILABLE');
      expect(res.body.error.message).toMatch(/Pine Labs/);
      expect(res.body.error.message).toMatch(/have not been supplied/);
    });
  });

  it('cannot be started at all on a production server', async () => {
    await withEnv({ NODE_ENV: 'production', POS_TERMINAL_PROVIDER: 'sim' }, async () => {
      // config/env.js refuses at boot. The registry's NODE_ENV whitelist is the
      // second, independent gate; this asserts the first, which is the one that
      // makes the second unreachable.
      await expect(import('../src/config/env.js')).rejects.toThrow(/cannot be used in production/i);
    });
  });
});

// ---------------------------------------------------------------------------

describe('putting an amount on a reader', () => {
  it('opens an attempt and records nothing as paid', async () => {
    const order = await billed(A);
    const res = await startTerminal(A, order.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.connector).toBe('sim');
    expect(res.body.status).toBe('PENDING');
    expect(res.body.reader.id).toBe(A.reader.id);
    // So the till can print the right instruction. Guessing these wrong tells a
    // customer to tap a device that only takes a dip.
    expect(res.body.capabilities.cardPresent).toBe(true);
    expect(res.body.capabilities.contactless).toBe(true);

    const row = await prisma.paymentIntent.findUnique({ where: { id: res.body.intent.id } });
    expect(row.flow).toBe('TERMINAL');
    expect(row.deviceId).toBe(A.reader.id);
    expect(row.companyId).toBe(A.company.id);
    expect(row.branchId).toBe(A.branch.id);
    // No terminal connector needs merchant credentials today, so none is bound.
    expect(row.accountId).toBeNull();
    expect(row.providerRef).toBe(simProviderRef(row.idempotencyKey));

    // The reader has the amount. Nothing has been paid.
    const after = await readOrder(A, order.id);
    expect(after.status).toBe('BILLED');
    expect(after.payments).toHaveLength(0);
  });

  it('takes a part-amount, which is what makes cash-plus-card possible', async () => {
    const order = await billed(A, { qty: 2 }); // 200
    const res = await startTerminal(A, order.id, { amount: 60 });
    expect(res.status).toBe(201);
    expect(res.body.intent.amount).toBe(60);
  });

  it('refuses more than the bill', async () => {
    const order = await billed(A);
    const res = await startTerminal(A, order.id, { amount: 101 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('amount');
  });

  it('is offered on billed orders only', async () => {
    const created = await request(app)
      .post('/api/orders')
      .set(auth(A.tokens.cashier))
      .send({ type: 'TAKEAWAY', items: [{ productId: A.productId, qty: 1 }] });
    const res = await startTerminal(A, created.body.order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/billed orders only/i);
  });

  describe('which device may be addressed', () => {
    it('refuses a device that is not a card reader', async () => {
      const counter = await mkReader(A, { name: 'Counter PC', readerRef: null, type: 'COUNTER' });
      const order = await billed(A);
      const res = await startTerminal(A, order.id, { deviceId: counter.id });
      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe('deviceId');
    });

    it('refuses an inactive reader and says where to activate it', async () => {
      const dead = await mkReader(A, { name: 'Spare', readerRef: 'rdr-a-spare', status: 'PENDING' });
      const order = await billed(A);
      const res = await startTerminal(A, order.id, { deviceId: dead.id });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/devices screen/i);
    });

    it('refuses a reader with no vendor reference, because no connector could address it', async () => {
      const unref = await mkReader(A, { name: 'Unlabelled', readerRef: null });
      const order = await billed(A);
      const res = await startTerminal(A, order.id, { deviceId: unref.id });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/vendor reference/i);
    });

    it("cannot address another tenant's reader, and is not told it exists", async () => {
      const order = await billed(A);
      const res = await startTerminal(A, order.id, { deviceId: B.reader.id });
      // 404, not 403: a different answer would make this an oracle for which
      // device ids exist on the deployment.
      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found in this store/i);
    });

    it('refuses a reader bound to a different till when the request comes from a till', async () => {
      const tillA = await prisma.terminal.create({
        data: { companyId: A.company.id, branchId: A.branch.id, name: 'Till 1', code: 'T1' },
      });
      const tillB = await prisma.terminal.create({
        data: { companyId: A.company.id, branchId: A.branch.id, name: 'Till 2', code: 'T2' },
      });
      const boundReader = await mkReader(A, {
        name: 'Till 2 reader',
        readerRef: 'rdr-a-till2',
        terminalId: tillB.id,
      });
      const token = 'device-token-for-till-one';
      await prisma.device.create({
        data: {
          publicId: devicePublicId(),
          companyId: A.company.id,
          branchId: A.branch.id,
          terminalId: tillA.id,
          name: 'Till 1 tablet',
          type: 'COUNTER',
          status: 'ACTIVE',
          tokenHash: hashSecret(token),
        },
      });

      const order = await billed(A);
      const res = await startTerminal(A, order.id, { deviceId: boundReader.id }, A.tokens.cashier, {
        'x-pos-device-token': token,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/different till/i);
    });
  });
});

// ---------------------------------------------------------------------------

describe('one live attempt per bill', () => {
  it('returns the attempt already on the reader rather than opening a second', async () => {
    const { order, intent } = await pending(A);
    const again = await startTerminal(A, order.id);
    expect(again.status).toBe(200); // 200, not 201: nothing new was created
    expect(again.body.intent.id).toBe(intent.id);
    expect(again.body.intent.providerRef).toBe(intent.providerRef);
    expect(await prisma.paymentIntent.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('refuses a second attempt on a different reader', async () => {
    const other = await mkReader(A, { name: 'Second reader', readerRef: 'rdr-a-2' });
    const { order } = await pending(A);
    const res = await startTerminal(A, order.id, { deviceId: other.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/different reader/i);
  });

  it('refuses a second attempt for a different amount', async () => {
    const { order } = await pending(A, { qty: 2 });
    const res = await startTerminal(A, order.id, { amount: 50 });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/different amount/i);
  });

  it('refuses a reader while a browser checkout is open on the same bill', async () => {
    const order = await billed(A);
    const checkout = await request(app)
      .post(`/api/orders/${order.id}/payment-intents`)
      .set(auth(A.tokens.cashier))
      .send({});
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    const res = await startTerminal(A, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/online payment is already open/i);
  });

  it('two tills pressing Charge together open exactly one attempt', async () => {
    const order = await billed(A);
    const [one, two] = await Promise.all([startTerminal(A, order.id), startTerminal(A, order.id)]);
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    expect(await prisma.paymentIntent.count({ where: { orderId: order.id } })).toBe(1);
    // And one amount on the reader, not two.
    expect(one.body.intent.id).toBe(two.body.intent.id);
  });
});

// ---------------------------------------------------------------------------

describe('a reader that will not take the amount', () => {
  it('leaves the attempt open and resumes it under the SAME key rather than charging twice', async () => {
    setSimReaderDead(A.reader.readerRef);
    const order = await billed(A);

    const refused = await startTerminal(A, order.id);
    expect(refused.status).toBe(502);
    expect(refused.body.error.code).toBe('POS_TERMINAL_UNAVAILABLE');

    // The row survives with no providerRef: the amount may or may not be on the
    // device, so the attempt is UNKNOWN rather than failed.
    const open = await prisma.paymentIntent.findFirst({ where: { orderId: order.id } });
    expect(open.status).toBe('CREATED');
    expect(open.providerRef).toBeNull();
    expect(open.failureReason).toMatch(/did not answer/i);

    // Reader recovers. The next press must resume, carrying the same
    // idempotency key, so a connector with idempotency of its own returns the
    // attempt already on the reader instead of stacking a second amount.
    clearSimTerminal();
    const resumed = await startTerminal(A, order.id);
    expect(resumed.status).toBe(200);
    expect(resumed.body.intent.id).toBe(open.id);
    expect(await prisma.paymentIntent.count({ where: { orderId: order.id } })).toBe(1);
    const after = await prisma.paymentIntent.findUnique({ where: { id: open.id } });
    expect(after.idempotencyKey).toBe(open.idempotencyKey);
    expect(after.providerRef).toBe(simProviderRef(open.idempotencyKey));
    expect(after.status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------

describe('asking the reader what happened', () => {
  it('reports PENDING while nobody has presented a card', async () => {
    const { order, intent } = await pending(A);
    const res = await askStatus(A, order.id, intent.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.recorded).toBe(false);
    expect(res.body.order.payments).toHaveLength(0);
  });

  it('counts the asks, so a stuck attempt becomes visible instead of silent', async () => {
    const { order, intent } = await pending(A);
    await askStatus(A, order.id, intent.id);
    await askStatus(A, order.id, intent.id);
    const row = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(row.statusCheckCount).toBe(2);
    expect(row.lastStatusCheckAt).toBeInstanceOf(Date);
    // Neither column moves money.
    expect(row.status).toBe('PENDING');
  });

  it('records the payment when the reader says it took the money', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_ok_1',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
      entryMode: 'CONTACTLESS',
    });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUCCEEDED');
    expect(res.body.recorded).toBe(true);
    expect(res.body.payment.amount).toBe(100);
    expect(res.body.order.status).toBe('PAID');

    const payment = await prisma.payment.findUnique({ where: { intentId: intent.id } });
    // The four dimensions the contract asks to be kept apart.
    expect(payment.method).toBe('CARD');
    expect(payment.channel).toBe('TERMINAL');
    expect(payment.entrySource).toBe('TERMINAL_CONFIRMED');
    expect(payment.provider).toBe('sim');
    // A reader has no webhook to send, so every terminal settlement is a pull
    // and the event row says so.
    const event = await prisma.gatewayWebhookEvent.findFirst({ where: { eventId: 'chg_ok_1' } });
    expect(event.source).toBe('RECOVERY');
    expect(event.processedAt).toBeInstanceOf(Date);
    expect(event.intentId).toBe(intent.id);
  });

  it('keeps a provider-confirmed card payment distinguishable from a hand-recorded one', async () => {
    const { order: o1, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_distinct',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    await askStatus(A, o1.id, intent.id);

    const o2 = await billed(A);
    const manual = await manualPay(A, o2.id, { method: 'CARD', amount: 100 });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);

    const confirmed = await prisma.payment.findUnique({ where: { intentId: intent.id } });
    const typed = await prisma.payment.findFirst({ where: { orderId: o2.id } });

    // Same method, same amount, same day. Everything that says which is which
    // lives in the other three columns, and it survives in the row rather than
    // in a screen's memory.
    expect(typed.method).toBe(confirmed.method);
    expect(typed.channel).toBe('MANUAL');
    expect(typed.entrySource).toBe('MANUAL_ENTRY');
    expect(typed.provider).toBeNull();
    expect(typed.intentId).toBeNull();
    expect(confirmed.channel).toBe('TERMINAL');
    expect(confirmed.entrySource).toBe('TERMINAL_CONFIRMED');
  });

  it('polling twice cannot pay twice', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_twice',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    const first = await askStatus(A, order.id, intent.id);
    const second = await askStatus(A, order.id, intent.id);
    expect(first.body.recorded).toBe(true);
    // Not an error: a till that lost its answer asks again, and the truth is
    // what stops anyone taking the money a second time.
    expect(second.status).toBe(200);
    expect(second.body.recorded).toBe(false);
    expect(second.body.alreadyRecorded).toBe(true);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('two tills polling the same attempt at the same instant record it once', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_race',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    const results = await Promise.all([
      askStatus(A, order.id, intent.id),
      askStatus(A, order.id, intent.id),
      askStatus(A, order.id, intent.id),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    expect(results.filter((r) => r.body.recorded === true)).toHaveLength(1);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    const order2 = await readOrder(A, order.id);
    expect(order2.status).toBe('PAID');
  });

  it('refuses to record a success the reader would not name a charge for', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    const res = await askStatus(A, order.id, intent.id);
    // Without a charge reference there is no key that tells a repeat poll from
    // a second charge, so this refuses rather than guessing.
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/did not name the charge/i);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('does not close a bill for an amount nobody asked for', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_short',
      amountPaise: 9000, // ₹90 against a ₹100 attempt
      currency: 'INR',
      method: 'CARD',
    });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(false);
    expect(res.body.reason).toMatch(/amount does not match/i);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    // Not smoothed over: the reason is on the event row for reconciliation.
    const event = await prisma.gatewayWebhookEvent.findFirst({ where: { eventId: 'chg_short' } });
    expect(event.skippedReason).toMatch(/amount does not match/i);
    expect((await readOrder(A, order.id)).status).toBe('BILLED');
  });

  it('refuses a settlement in another currency however similar the integer looks', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_usd',
      amountPaise: 10000,
      currency: 'USD',
      method: 'CARD',
    });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.body.recorded).toBe(false);
    expect(res.body.reason).toMatch(/currency does not match/i);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('the outcomes that are not a yes', () => {
  it('reports a decline, closes the attempt and frees the balance', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'FAILED',
      failureCode: 'DECLINED_BY_ISSUER',
      detail: 'the issuer declined the card',
    });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.failureCode).toBe('DECLINED_BY_ISSUER');
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);

    // Freeing the balance is the point: the cashier can present another card.
    clearSimTerminal();
    const retry = await startTerminal(A, order.id);
    expect(retry.status).toBe(201);
    expect(retry.body.intent.id).not.toBe(intent.id);
  });

  it('leaves an UNCERTAIN attempt open, unresolved, and says so in words', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'UNCERTAIN',
      detail: 'the reader lost power mid-transaction',
    });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UNCERTAIN');
    expect(res.body.recorded).toBe(false);
    // The cashier decides what happens next, and the wrong decision here is the
    // expensive one, so the advice is explicit rather than implied by a state.
    expect(res.body.advice).toMatch(/do not record this payment by hand/i);

    // Not resolved into anything: not failed, not paid, and above all not
    // silently converted into a manual card payment.
    const row = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(row.status).toBe('UNCERTAIN');
    expect(row.closedAt).toBeNull();
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
    const after = await readOrder(A, order.id);
    expect(after.status).toBe('BILLED');
    expect(after.amountDue).toBe(100);
  });

  it('an UNCERTAIN attempt that later turns out to have been charged is still recorded once', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, { status: 'UNCERTAIN', detail: 'no answer from the card' });
    await askStatus(A, order.id, intent.id);

    // The batch is checked, the charge is found, and the reader can now answer.
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_late',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.body.recorded).toBe(true);
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect((await readOrder(A, order.id)).status).toBe('PAID');
  });

  it('an unreachable reader changes NOTHING about the attempt', async () => {
    const { order, intent } = await pending(A);
    setSimUnreachable(intent.providerRef);

    const res = await askStatus(A, order.id, intent.id);
    // 502, not a decline and not a success: the question was not answered.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('POS_TERMINAL_UNAVAILABLE');

    const row = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    // Still PENDING — "we could not ask" and "we asked and it does not know"
    // are different facts and the row must not collapse them.
    expect(row.status).toBe('PENDING');
    expect(row.closedAt).toBeNull();
    expect(row.failureReason).toMatch(/could not be reached/i);

    // The control: the same attempt, asked again once the reader answers.
    clearSimTerminal();
    setSimOutcome(intent.providerRef, { status: 'UNCERTAIN', detail: 'the reader does not know' });
    const asked = await askStatus(A, order.id, intent.id);
    expect(asked.status).toBe(200);
    expect(asked.body.status).toBe('UNCERTAIN');
  });

  it('never treats a word it does not recognise as approval', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, { status: 'APPROVED_MAYBE' });
    const res = await askStatus(A, order.id, intent.id);
    expect(res.body.status).toBe('UNCERTAIN');
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('a card charged after the bill was settled in cash is not taken twice', async () => {
    // The out-of-order case: declined at the reader, cash taken, and then the
    // reader turns out to have charged after all.
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, { status: 'FAILED', detail: 'declined' });
    await askStatus(A, order.id, intent.id);

    const cash = await manualPay(A, order.id, { method: 'CASH', tendered: 100 });
    expect(cash.status).toBe(201);

    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_after_cash',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    const late = await askStatus(A, order.id, intent.id);
    expect(late.status).toBe(200);
    expect(late.body.recorded).toBe(false);
    // The bill was already settled, so the order-state check refuses before the
    // amount-due one gets a turn. Either guard stops the second collection; the
    // reason recorded is the one that actually fired.
    expect(late.body.reason).toMatch(/order is PAID, not BILLED/i);
    // One payment on the bill, and the customer is not charged ₹200 for a ₹100
    // meal. The unmatched charge is on the event row for reconciliation.
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(1);
    const event = await prisma.gatewayWebhookEvent.findFirst({ where: { eventId: 'chg_after_cash' } });
    expect(event.skippedReason).toMatch(/order is PAID, not BILLED/i);
  });
});

// ---------------------------------------------------------------------------

describe('taking the amount back off the reader', () => {
  it('cancels on the device and says that it did', async () => {
    const { order, intent } = await pending(A);
    const res = await cancelAttempt(A, order.id, intent.id);
    expect(res.status).toBe(200);
    expect(res.body.intent.status).toBe('CANCELLED');
    // The sim declares cancel, so this is a real state change on the device.
    expect(res.body.cancelledOnDevice).toBe(true);
    expect(res.body.advice).toBeUndefined();

    // And the balance is free again.
    const retry = await startTerminal(A, order.id);
    expect(retry.status).toBe(201);
  });

  it('refuses to cancel a payment that has already been recorded', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_no_cancel',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    await askStatus(A, order.id, intent.id);
    const res = await cancelAttempt(A, order.id, intent.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already been recorded/i);
  });

  it('will not close its own row when the reader could not be told', async () => {
    const { order, intent } = await pending(A);
    setSimUnreachable(intent.providerRef);
    const res = await cancelAttempt(A, order.id, intent.id);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/may still be on the device/i);
    // Closing anyway would leave an amount live on a reader with nothing in the
    // POS tracking it — which is how a customer pays a bill already written off.
    const row = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(row.status).toBe('PENDING');
    expect(row.cancelledAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('mixed tenders', () => {
  it('settles a bill as cash plus card and keeps both legs honest', async () => {
    const order = await billed(A, { qty: 2 }); // ₹200
    const cash = await manualPay(A, order.id, { method: 'CASH', amount: 50 });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);

    const started = await startTerminal(A, order.id, { amount: 150 });
    expect(started.status).toBe(201);
    setSimOutcome(started.body.intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_split',
      amountPaise: 15000,
      currency: 'INR',
      method: 'CARD',
      entryMode: 'CHIP',
    });
    const done = await askStatus(A, order.id, started.body.intent.id);
    expect(done.body.recorded).toBe(true);
    expect(done.body.order.status).toBe('PAID');

    const payments = await prisma.payment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => [p.method, p.channel, p.entrySource])).toEqual([
      ['CASH', 'MANUAL', 'MANUAL_ENTRY'],
      ['CARD', 'TERMINAL', 'TERMINAL_CONFIRMED'],
    ]);
  });

  it('will not put more on the reader than the bill still owes', async () => {
    const order = await billed(A, { qty: 2 }); // ₹200
    await manualPay(A, order.id, { method: 'CASH', amount: 150 });
    const res = await startTerminal(A, order.id, { amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('amount');
  });
});

// ---------------------------------------------------------------------------

describe('returning a card-present payment', () => {
  it('goes back as a manual reversal, because no connector here can move that money', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_refundable',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    await askStatus(A, order.id, intent.id);

    const refund = await request(app)
      .post(`/api/orders/${order.id}/refunds`)
      .set(auth(A.tokens.owner))
      .send({ amount: 40, reason: 'One thali sent back', method: 'CARD' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    // MANUAL, not GATEWAY: the cashier reverses it on the device. Calling it a
    // provider refund would be claiming the POS returned money it cannot move.
    expect(refund.body.refund.channel).toBe('MANUAL');
    expect(refund.body.refund.method).toBe('CARD');
    expect(refund.body.refund.status).toBe('SUCCEEDED');
  });

  it('refuses to return more than was collected', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_overrefund',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    await askStatus(A, order.id, intent.id);
    const res = await request(app)
      .post(`/api/orders/${order.id}/refunds`)
      .set(auth(A.tokens.owner))
      .send({ amount: 120, reason: 'Wrong amount typed', method: 'CARD' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('amount');
  });

  it('counts an earlier refund against the remaining refundable amount', async () => {
    const { order, intent } = await pending(A);
    setSimOutcome(intent.providerRef, {
      status: 'SUCCEEDED',
      chargeRef: 'chg_partial_refunds',
      amountPaise: 10000,
      currency: 'INR',
      method: 'CARD',
    });
    await askStatus(A, order.id, intent.id);
    const first = await request(app)
      .post(`/api/orders/${order.id}/refunds`)
      .set(auth(A.tokens.owner))
      .send({ amount: 70, reason: 'Most of it went back', method: 'CARD' });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/orders/${order.id}/refunds`)
      .set(auth(A.tokens.owner))
      .send({ amount: 40, reason: 'And the rest', method: 'CARD' });
    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/exceeds the amount collected/i);
  });
});

// ---------------------------------------------------------------------------

describe('who may do this, and to whose bills', () => {
  it('refuses an unauthenticated start', async () => {
    const order = await billed(A);
    const res = await request(app)
      .post(`/api/orders/${order.id}/terminal-payments`)
      .send({ deviceId: A.reader.id });
    expect(res.status).toBe(401);
  });

  it("cannot open an attempt on another tenant's bill", async () => {
    const order = await billed(B);
    const res = await request(app)
      .post(`/api/orders/${order.id}/terminal-payments`)
      .set(auth(A.tokens.cashier))
      .send({ deviceId: A.reader.id });
    expect(res.status).toBe(404);
  });

  it("cannot ask about another tenant's attempt", async () => {
    const mine = await pending(A);
    const theirs = await pending(B);
    // Naming their intent against my order: absent, not forbidden.
    const res = await askStatus(A, mine.order.id, theirs.intent.id);
    expect(res.status).toBe(404);
    // And their intent is untouched by my asking.
    const row = await prisma.paymentIntent.findUnique({ where: { id: theirs.intent.id } });
    expect(row.statusCheckCount).toBe(0);
  });

  it("cannot cancel another tenant's attempt", async () => {
    const mine = await pending(A);
    const theirs = await pending(B);
    const res = await cancelAttempt(A, mine.order.id, theirs.intent.id);
    expect(res.status).toBe(404);
    const row = await prisma.paymentIntent.findUnique({ where: { id: theirs.intent.id } });
    expect(row.status).toBe('PENDING');
  });

  it('records who opened the attempt', async () => {
    const { intent } = await pending(A);
    const row = await prisma.paymentIntent.findUnique({ where: { id: intent.id } });
    expect(row.createdById).toBeTruthy();
    const audits = await prisma.posAuditLog.findMany({
      where: { entityId: intent.id, action: 'TERMINAL_INTENT_CREATED' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].companyId).toBe(A.company.id);
  });
});
