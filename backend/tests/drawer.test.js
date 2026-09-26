// Cash-drawer command channel (contract §5).
//
// What is asserted here, in the order the contract states it: company/store/
// device binding and capability checks; authenticated commands with unique ids,
// expiry and audit rows; opens tied to committed cash receipts and authorised
// cash refunds; permission-controlled manual opening with a reason; NO opening
// for card or UPI; protection against repeated clicks, duplicate delivery and
// cross-store commands; honest status for unsupported, disconnected, failed and
// uncertain commands.
//
// And the two sentences the whole file exists to hold:
//   - an uncertain or expired command is never replayed after reconnection
//   - an acknowledgement is never reported as a drawer having opened, unless a
//     declared sensor says so
//
// The negative controls matter as much as the positives. "Expired commands are
// not dispatched" is only evidence if the same command IS dispatched when it is
// still in date, so both halves are asserted against one fixture.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('drawer.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { COMMAND_TTL_SEC, DRAWER_CLAIM_TEXT } = await import('../src/lib/peripherals/drawer.js');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const PW = 'test-password-1';

// Shop A: the one under test. Shop B: a second tenant, present only so every
// isolation claim has something real to be isolated FROM.
const A = { tokens: {} };
const B = { tokens: {} };

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const enrolAgent = async (shop, name) => {
  const created = await request(app)
    .post('/api/print-agents')
    .set(auth(shop.tokens.owner))
    .send({ name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const enrolled = await request(app)
    .post('/api/print-agents/enrol')
    .send({ code: created.body.enrolCode, platform: 'linux', agentVersion: '0.1.0' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  return {
    id: created.body.agent.id,
    cred: `${enrolled.body.agentId}.${enrolled.body.secret}`,
  };
};

const buildShop = async (shop, { slug, name, publicId, code }) => {
  const passwordHash = await hashPassword(PW);
  shop.company = await prisma.company.create({
    data: {
      name,
      slug,
      licenses: {
        create: {
          plan: 'SINGLE_STORE',
          baseBranchLimit: 2,
          expiresAt: new Date(Date.now() + 86400e3),
        },
      },
    },
  });
  shop.branch = await prisma.branch.create({
    data: { companyId: shop.company.id, publicId, name: 'Main', code },
  });
  const mk = (email, fullName, role) =>
    prisma.posUser.create({
      data: {
        email,
        fullName,
        role,
        companyId: shop.company.id,
        branchId: shop.branch.id,
        passwordHash,
      },
    });
  shop.ownerId = (await mk(`owner@${slug}.test`, 'Owner', 'CUSTOMER_OWNER')).id;
  await mk(`till@${slug}.test`, 'Till', 'CASHIER');
  shop.tokens.owner = await login(`owner@${slug}.test`);
  shop.tokens.cashier = await login(`till@${slug}.test`);

  const tax = await prisma.taxRate.create({
    data: { companyId: shop.company.id, name: 'GST 5%', ratePercent: '5.00' },
  });
  const cat = await prisma.category.create({
    data: { companyId: shop.company.id, name: 'Food', sortOrder: 1 },
  });
  shop.productId = (
    await prisma.product.create({
      data: {
        companyId: shop.company.id,
        categoryId: cat.id,
        name: 'Burger',
        basePrice: '100.00',
        taxRateId: tax.id,
      },
    })
  ).id;

  shop.agent = await enrolAgent(shop, 'Counter PC');
  const target = await request(app)
    .post(`/api/print-agents/${shop.agent.id}/targets`)
    .set(auth(shop.tokens.owner))
    .send({
      name: 'Front receipt',
      purpose: 'RECEIPT',
      transport: 'TCP',
      host: '10.0.0.10',
      drawerKick: true,
    });
  expect(target.status, JSON.stringify(target.body)).toBe(201);
  shop.targetId = target.body.target.id;
};

// A billed order settled by one tender, returning the payment row.
const billedAndPaid = async (shop, { method = 'CASH' } = {}) => {
  const created = await request(app)
    .post('/api/orders')
    .set(auth(shop.tokens.cashier))
    .send({ type: 'TAKEAWAY', items: [{ productId: shop.productId, qty: 1 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.order.id;
  const bill = await request(app)
    .post(`/api/orders/${orderId}/bill`)
    .set(auth(shop.tokens.cashier))
    .send({});
  expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  const total = bill.body.order.total;
  const pay = await request(app)
    .post(`/api/orders/${orderId}/payments`)
    .set(auth(shop.tokens.cashier))
    .send(method === 'CASH' ? { method, tendered: total } : { method, amount: total });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  return { orderId, total, payment: pay.body.payment };
};

const openDrawer = (shop, body, token = shop.tokens.cashier) =>
  request(app).post('/api/drawer/open').set(auth(token)).send(body);

const claim = (shop, claimToken, max) =>
  request(app)
    .post('/api/print-agents/commands/claim')
    .set(auth(shop.agent.cred))
    .send({ claimToken, ...(max ? { max } : {}) });

const report = (shop, commandId, body) =>
  request(app)
    .post(`/api/print-agents/commands/${commandId}/report`)
    .set(auth(shop.agent.cred))
    .send(body);

const readCommand = (shop, id, token = shop.tokens.owner) =>
  request(app).get(`/api/drawer/commands/${id}`).set(auth(token));

// Fixture reset, not a state transition the product makes: earlier tests leave
// commands sitting in the queue, and a claim takes the OLDEST batch. Winding
// their windows shut lets each protocol test reason about an empty queue while
// still going through the real sweep to get there.
const drainQueue = async () => {
  await prisma.deviceCommand.updateMany({
    where: { status: 'QUEUED' },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await prisma.deviceCommand.updateMany({
    where: { status: 'DISPATCHED' },
    data: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });
  await claim(A, `drain-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  await claim(B, `drain-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
};

// One command on a clean queue, already claimed by the agent under the given
// token and ready to be reported on.
const freshCommand = async (shop, token) => {
  await drainQueue();
  const { payment } = await billedAndPaid(shop);
  const opened = await openDrawer(shop, { cause: 'CASH_RECEIPT', paymentId: payment.id });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const id = opened.body.command.id;
  const claimed = await claim(shop, token);
  expect(claimed.body.commands.map((c) => c.id), 'the command must be claimable').toContain(id);
  return { id, paymentId: payment.id };
};

beforeAll(async () => {
  await wipeAll();
  await buildShop(A, { slug: 'drawer-a', name: 'Drawer Cafe A', publicId: 'VC-DR-0001', code: 'DA' });
  await buildShop(B, { slug: 'drawer-b', name: 'Drawer Cafe B', publicId: 'VC-DR-0002', code: 'DB' });
});

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

describe('drawer profile: documented hardware bounds, authorised changes', () => {
  it('lists the store drawers with their sensor status', async () => {
    const res = await request(app).get('/api/drawer/targets').set(auth(A.tokens.cashier));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.targets).toHaveLength(1);
    const t = res.body.targets[0];
    expect(t.id).toBe(A.targetId);
    // The default profile, and the default answer to "can this say OPENED".
    expect(t.drawerPin).toBe(2);
    expect(t.drawerOnMs).toBe(50);
    expect(t.drawerSensor).toBe(false);
    expect(t.agentOnline).toBe(true);
  });

  it('a cashier cannot change the pulse profile', async () => {
    const res = await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.cashier))
      .send({ drawerOnMs: 120 });
    expect(res.status).toBe(403);
  });

  it('the owner may set any profile inside the documented envelope', async () => {
    const res = await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerPin: 5, drawerOnMs: 60, drawerOffMs: 180 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.target).toMatchObject({ drawerPin: 5, drawerOnMs: 60, drawerOffMs: 180 });
    expect(res.body.limits.pins).toEqual([2, 5]);
    // Put back, so the rest of the file reasons about the shipped default.
    await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerPin: 2, drawerOnMs: 50, drawerOffMs: 200 });
  });

  it('refuses a pin the connector does not carry and a pulse that cooks the coil', async () => {
    const pin = await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerPin: 3 });
    expect(pin.status).toBe(400);
    expect(pin.body.error.field).toBe('drawerPin');

    const long = await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerOnMs: 500 });
    expect(long.status).toBe(400);
    expect(long.body.error.field).toBe('drawerOnMs');
    // The refusal says WHY in hardware terms, not "invalid input".
    expect(long.body.error.message).toMatch(/overheats the coil/i);

    const short = await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerOnMs: 1 });
    expect(short.status).toBe(400);

    const row = await prisma.printTarget.findUnique({ where: { id: A.targetId } });
    expect(row.drawerPin).toBe(2);
    expect(row.drawerOnMs).toBe(50);
  });

  it('a store with no drawer-capable printer says so instead of failing silently', async () => {
    await prisma.printTarget.update({ where: { id: A.targetId }, data: { drawerKick: false } });
    const { payment } = await billedAndPaid(A);
    const res = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no cash drawer is set up/i);
    await prisma.printTarget.update({ where: { id: A.targetId }, data: { drawerKick: true } });
  });
});

describe('cause: a drawer opens for cash, and only for cash', () => {
  it('a committed cash receipt opens it, and the pulse is frozen onto the row', async () => {
    const { payment } = await billedAndPaid(A);
    const res = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.deduped).toBe(false);
    expect(res.body.agentOnline).toBe(true);
    const c = res.body.command;
    expect(c.status).toBe('QUEUED');
    expect(c.cause).toBe('CASH_RECEIPT');
    expect(c.causeRefId).toBe(payment.id);
    expect(c.drawerPin).toBe(2);
    expect(c.drawerOnMs).toBe(50);
    expect(c.drawerOffMs).toBe(200);
    // Nothing has happened yet, so the only honest claim is that nothing is known.
    expect(c.claim).toBe('UNKNOWN');
    expect(c.sensorEquipped).toBe(false);
    const ttl = new Date(c.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(COMMAND_TTL_SEC * 1000);
  });

  it('a card payment does not open the drawer', async () => {
    const { payment } = await billedAndPaid(A, { method: 'CARD' });
    const res = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not cash/i);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: payment.id } })).toBe(0);
  });

  it('a UPI payment does not open the drawer either', async () => {
    const { payment } = await billedAndPaid(A, { method: 'UPI' });
    const res = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
    expect(res.status).toBe(409);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: payment.id } })).toBe(0);
  });

  it('a cash refund opens it; a provider refund does not', async () => {
    const { orderId, total } = await billedAndPaid(A);
    const refund = await request(app)
      .post(`/api/orders/${orderId}/refunds`)
      .set(auth(A.tokens.owner))
      .send({ amount: total, reason: 'customer returned the order', method: 'CASH' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const refundId = refund.body.refund.id;
    const ok = await openDrawer(A, { cause: 'CASH_REFUND', refundId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.command.cause).toBe('CASH_REFUND');

    // A provider refund returns money through the provider. Nothing leaves the
    // till, so nothing justifies opening it.
    const viaProvider = await prisma.refund.create({
      data: {
        orderId,
        byId: A.ownerId,
        amount: '10.00',
        reason: 'provider refund fixture',
        channel: 'GATEWAY',
        status: 'SUCCEEDED',
      },
    });
    const refused = await openDrawer(A, { cause: 'CASH_REFUND', refundId: viaProvider.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/payment provider/i);
  });

  it('a refund that has not completed does not open the drawer', async () => {
    const { orderId } = await billedAndPaid(A);
    const pending = await prisma.refund.create({
      data: {
        orderId,
        byId: A.ownerId,
        amount: '10.00',
        reason: 'unconfirmed fixture',
        channel: 'MANUAL',
        method: 'CASH',
        status: 'PENDING',
      },
    });
    const res = await openDrawer(A, { cause: 'CASH_REFUND', refundId: pending.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/PENDING/);
  });

  it('a card refund does not open the drawer', async () => {
    const { orderId, total } = await billedAndPaid(A, { method: 'CARD' });
    const refund = await request(app)
      .post(`/api/orders/${orderId}/refunds`)
      .set(auth(A.tokens.owner))
      .send({ amount: total, reason: 'reversed on the terminal', method: 'CARD' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const res = await openDrawer(A, { cause: 'CASH_REFUND', refundId: refund.body.refund.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not cash/i);
  });

  it('a manual open needs the separate permission, and a reason', async () => {
    const byCashier = await openDrawer(A, { cause: 'MANUAL', reason: 'float top-up', idempotencyKey: 'manual-key-0001' });
    expect(byCashier.status).toBe(403);
    expect(byCashier.body.error.message).toMatch(/without a sale/i);

    const noReason = await openDrawer(A, { cause: 'MANUAL', idempotencyKey: 'manual-key-0002' }, A.tokens.owner);
    expect(noReason.status).toBe(400);

    const ok = await openDrawer(
      A,
      { cause: 'MANUAL', reason: 'float top-up before service', idempotencyKey: 'manual-key-0003' },
      A.tokens.owner,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.command.reason).toBe('float top-up before service');
    expect(ok.body.command.causeRefId).toBeNull();

    const logged = await prisma.posAuditLog.findFirst({
      where: { action: 'DRAWER_OPEN_REQUESTED', entityId: ok.body.command.id },
    });
    expect(logged).not.toBeNull();
    expect(logged.meta.reason).toBe('float top-up before service');
  });

  it('a cash receipt that does not exist, or belongs to another tenant, is not found', async () => {
    const missing = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: 'no-such-payment' });
    expect(missing.status).toBe(404);

    const other = await billedAndPaid(B);
    const crossTenant = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: other.payment.id });
    // The same answer as a payment that does not exist: ids cannot be probed to
    // learn what the shop next door took.
    expect(crossTenant.status).toBe(404);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: other.payment.id } })).toBe(0);
  });

  it("a printer id from another tenant's store is not found", async () => {
    const { payment } = await billedAndPaid(A);
    const res = await openDrawer(A, {
      cause: 'CASH_RECEIPT',
      paymentId: payment.id,
      targetId: B.targetId,
    });
    expect(res.status).toBe(404);
  });
});

describe('repeated clicks and duplicate delivery', () => {
  it('a double-clicked cash sale is one command', async () => {
    const { payment } = await billedAndPaid(A);
    const [first, second] = await Promise.all([
      openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id }),
      openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(first.body.command.id).toBe(second.body.command.id);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: payment.id } })).toBe(1);
  });

  it('five sequential clicks are still one command', async () => {
    const { payment } = await billedAndPaid(A);
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const res = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
      expect([200, 201]).toContain(res.status);
      seen.add(res.body.command.id);
    }
    expect(seen.size).toBe(1);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: payment.id } })).toBe(1);
  });

  it('two genuinely different manual opens are two commands', async () => {
    const one = await openDrawer(
      A,
      { cause: 'MANUAL', reason: 'counted the till', idempotencyKey: 'manual-count-0001' },
      A.tokens.owner,
    );
    const two = await openDrawer(
      A,
      { cause: 'MANUAL', reason: 'counted the till again', idempotencyKey: 'manual-count-0002' },
      A.tokens.owner,
    );
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(one.body.command.id).not.toBe(two.body.command.id);
  });
});

describe('the agent protocol: claim, lease, report', () => {
  let commandId;
  let paymentId;

  it('the agent is handed a pin and two durations — no host, no bytes, no shell', async () => {
    await drainQueue();
    const { payment } = await billedAndPaid(A);
    paymentId = payment.id;
    const opened = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId });
    expect(opened.status).toBe(201);
    commandId = opened.body.command.id;

    const res = await claim(A, 'claim-token-aaaa1111');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBe(false);
    const mine = res.body.commands.find((c) => c.id === commandId);
    expect(mine).toBeDefined();
    expect(Object.keys(mine).sort()).toEqual(
      ['drawerOffMs', 'drawerOnMs', 'drawerPin', 'expiresAt', 'id', 'kind', 'targetId'].sort(),
    );
    expect(mine.kind).toBe('DRAWER_OPEN');
    expect(JSON.stringify(mine)).not.toMatch(/10\.0\.0\.10/);
    expect(await prisma.deviceCommand.findUnique({ where: { id: commandId } })).toMatchObject({
      status: 'DISPATCHED',
      attempts: 1,
    });
  });

  it('a replayed claim returns the same commands rather than leasing them twice', async () => {
    const again = await claim(A, 'claim-token-aaaa1111');
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.commands.map((c) => c.id)).toContain(commandId);
    const row = await prisma.deviceCommand.findUnique({ where: { id: commandId } });
    // The critical assertion: a lost response did NOT produce a second pulse.
    expect(row.attempts).toBe(1);
  });

  it('a different claim token gets nothing already dispatched', async () => {
    const other = await claim(A, 'claim-token-bbbb2222');
    expect(other.status).toBe(200);
    expect(other.body.commands.map((c) => c.id)).not.toContain(commandId);
  });

  it('an acknowledgement is reported as acknowledged, never as opened', async () => {
    const res = await report(A, commandId, { ok: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.claim).toBe('ACKNOWLEDGED');
    expect(res.body.claimText).toBe(DRAWER_CLAIM_TEXT.ACKNOWLEDGED);
    expect(res.body.claimText).toMatch(/no drawer sensor/i);

    const row = await prisma.deviceCommand.findUnique({ where: { id: commandId } });
    expect(row.ackAt).not.toBeNull();
    expect(row.sensorConfirmed).toBe(false);

    const read = await readCommand(A, commandId);
    expect(read.body.command.claim).toBe('ACKNOWLEDGED');
    expect(read.body.command.sensorEquipped).toBe(false);
  });

  it('an agent claiming a drawer opened cannot make it so without a declared sensor', async () => {
    const { id } = await freshCommand(A, 'claim-token-cccc3333');
    // The agent asserts the drawer is open. The target declares no sensor, so
    // the assertion is discarded: an agent cannot grant itself the right to
    // make a physical claim.
    const res = await report(A, id, { ok: true, drawerOpen: true });
    expect(res.body.claim).toBe('ACKNOWLEDGED');
    const row = await prisma.deviceCommand.findUnique({ where: { id } });
    expect(row.sensorConfirmed).toBe(false);
  });

  it('with a declared sensor, open and not-open are told apart', async () => {
    await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerSensor: true });

    const declared = await prisma.posAuditLog.findFirst({
      where: { action: 'DRAWER_SENSOR_DECLARED', entityId: A.targetId },
    });
    expect(declared, 'turning the sensor on is audited under its own action').not.toBeNull();

    const { id: cmdOpen } = await freshCommand(A, 'claim-token-dddd4444');
    const sensorOpen = await report(A, cmdOpen, { ok: true, drawerOpen: true });
    expect(sensorOpen.body.status).toBe('CONFIRMED');
    expect(sensorOpen.body.claim).toBe('OPENED');
    expect(sensorOpen.body.claimText).toBe(DRAWER_CLAIM_TEXT.OPENED);

    const { id: cmdShut } = await freshCommand(A, 'claim-token-eeee5555');
    // The pulse was delivered and the drawer did not move: a jam, or a hand on
    // the front. Delivery CONFIRMED, physical claim explicitly negative.
    const sensorShut = await report(A, cmdShut, { ok: true, drawerOpen: false });
    expect(sensorShut.body.status).toBe('CONFIRMED');
    expect(sensorShut.body.claim).toBe('ACKNOWLEDGED_NOT_OPENED');

    await request(app)
      .patch(`/api/drawer/targets/${A.targetId}`)
      .set(auth(A.tokens.owner))
      .send({ drawerSensor: false });
  });

  it('a failed delivery is FAILED and is never retried on its own', async () => {
    const { id, paymentId: failedPaymentId } = await freshCommand(A, 'claim-token-ffff6666');
    const res = await report(A, id, { ok: false, error: 'printer refused the connection' });
    expect(res.body.status).toBe('FAILED');
    expect(res.body.claim).toBe('UNKNOWN');

    // No backoff, no re-queue: the row is final and nothing will pick it up.
    const after = await claim(A, 'claim-token-gggg7777');
    expect(after.body.commands.map((c) => c.id)).not.toContain(id);
    const row = await prisma.deviceCommand.findUnique({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);

    // But the cashier still has cash to put away, so a fresh click raises a
    // NEW command against the same sale — a new decision, separately audited.
    const retry = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: failedPaymentId });
    expect(retry.status).toBe(201);
    expect(retry.body.command.id).not.toBe(id);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: failedPaymentId } })).toBe(2);
  });

  it('one agent cannot see or report on another tenant commands', async () => {
    await drainQueue();
    const { payment } = await billedAndPaid(A);
    const opened = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
    const id = opened.body.command.id;

    const foreignClaim = await claim(B, 'claim-token-hhhh8888');
    expect(foreignClaim.status).toBe(200);
    expect(foreignClaim.body.commands.map((c) => c.id)).not.toContain(id);

    const foreignReport = await request(app)
      .post(`/api/print-agents/commands/${id}/report`)
      .set(auth(B.agent.cred))
      .send({ ok: true });
    expect(foreignReport.status).toBe(404);
    expect(await prisma.deviceCommand.findUnique({ where: { id } })).toMatchObject({
      status: 'QUEUED',
      ackAt: null,
    });
  });

  it('an unauthenticated caller cannot drive a drawer', async () => {
    expect((await request(app).post('/api/drawer/open').send({ cause: 'MANUAL', reason: 'x', idempotencyKey: 'aaaaaaaa' })).status).toBe(401);
    expect((await request(app).post('/api/print-agents/commands/claim').send({ claimToken: 'aaaaaaaa' })).status).toBe(401);
    expect((await request(app).post('/api/print-agents/commands/x/report').send({ ok: true })).status).toBe(401);
  });
});

describe('expiry and uncertainty: never replayed after reconnection', () => {
  it('a command still in date is dispatched — the control for the next test', async () => {
    const { id } = await freshCommand(A, 'claim-token-live0001');
    await report(A, id, { ok: true });
  });

  it('an expired command is EXPIRED, and an agent reconnecting later never gets it', async () => {
    await drainQueue();
    const { payment } = await billedAndPaid(A);
    const id = (await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id })).body.command.id;
    // The agent was offline for the whole window. Four hours later it comes back.
    await prisma.deviceCommand.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 4 * 3600e3) },
    });

    const res = await claim(A, 'claim-token-late0001');
    expect(res.body.commands.map((c) => c.id)).not.toContain(id);
    const row = await prisma.deviceCommand.findUnique({ where: { id } });
    expect(row.status).toBe('EXPIRED');
    expect(row.attempts).toBe(0);
    expect(row.ackAt).toBeNull();

    // And it stays gone however many times the agent asks.
    for (const token of ['claim-token-late0002', 'claim-token-late0003']) {
      const again = await claim(A, token);
      expect(again.body.commands.map((c) => c.id)).not.toContain(id);
    }
    expect((await prisma.deviceCommand.findUnique({ where: { id } })).attempts).toBe(0);
  });

  it('a lease that runs out is UNCERTAIN, never back in the queue', async () => {
    const { id, paymentId } = await freshCommand(A, 'claim-token-lease001');
    await prisma.deviceCommand.update({
      where: { id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const next = await claim(A, 'claim-token-lease002');
    expect(next.body.commands.map((c) => c.id)).not.toContain(id);
    const row = await prisma.deviceCommand.findUnique({ where: { id } });
    expect(row.status).toBe('UNCERTAIN');
    expect(row.attempts).toBe(1);

    const read = await readCommand(A, id);
    expect(read.body.command.status).toBe('UNCERTAIN');
    expect(read.body.command.claim).toBe('UNKNOWN');
    expect(read.body.command.claimText).toBe(DRAWER_CLAIM_TEXT.UNKNOWN);

    // A late "it worked" arrives after the lease died. It is KEPT, because the
    // person resolving the till wants to read it — but it does not resurrect the
    // command, and it does not turn UNCERTAIN into CONFIRMED.
    const late = await report(A, id, { ok: true, detail: { note: 'network came back' } });
    expect(late.status).toBe(200);
    expect(late.body.status).toBe('UNCERTAIN');
    expect(late.body.recorded).toBe(true);
    const afterLate = await prisma.deviceCommand.findUnique({ where: { id } });
    expect(afterLate.status).toBe('UNCERTAIN');
    expect(afterLate.ackAt).toBeNull();
    expect(afterLate.sensorConfirmed).toBe(false);
    expect(afterLate.lastReport.ok).toBe(true);

    // Asking again for the same sale does NOT fire a second pulse at a drawer
    // that may already be open. The cashier is told to look at the till.
    const again = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId });
    expect(again.status).toBe(200);
    expect(again.body.deduped).toBe(true);
    expect(again.body.command.id).toBe(id);
    expect(again.body.advice).toMatch(/look at the till/i);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: paymentId } })).toBe(1);
  });

  it('a confirmed command is not re-fired for the same sale either', async () => {
    const { id, paymentId } = await freshCommand(A, 'claim-token-done0001');
    await report(A, id, { ok: true });

    const again = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId });
    expect(again.status).toBe(200);
    expect(again.body.deduped).toBe(true);
    expect(again.body.command.id).toBe(id);
    expect(await prisma.deviceCommand.count({ where: { causeRefId: paymentId } })).toBe(1);
  });

  it('an offline agent is reported honestly, and the command still expires on its own', async () => {
    await drainQueue();
    await prisma.printAgent.update({
      where: { id: A.agent.id },
      data: { lastSeenAt: new Date(Date.now() - 3600e3) },
    });
    const { payment } = await billedAndPaid(A);
    const res = await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id });
    expect(res.status).toBe(201);
    expect(res.body.agentOnline).toBe(false);

    const targets = await request(app).get('/api/drawer/targets').set(auth(A.tokens.owner));
    expect(targets.body.targets[0].agentOnline).toBe(false);

    await prisma.deviceCommand.update({
      where: { id: res.body.command.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const read = await readCommand(A, res.body.command.id);
    expect(read.body.command.status).toBe('EXPIRED');

    await prisma.printAgent.update({
      where: { id: A.agent.id },
      data: { lastSeenAt: new Date() },
    });
  });
});

describe('reads are tenant-scoped', () => {
  it("one tenant cannot read another's commands", async () => {
    const { payment } = await billedAndPaid(A);
    const id = (await openDrawer(A, { cause: 'CASH_RECEIPT', paymentId: payment.id })).body.command.id;

    const foreign = await request(app)
      .get(`/api/drawer/commands/${id}`)
      .set(auth(B.tokens.owner));
    expect(foreign.status).toBe(404);

    const list = await request(app).get('/api/drawer/commands').set(auth(B.tokens.owner));
    expect(list.status).toBe(200);
    expect(list.body.commands.map((c) => c.id)).not.toContain(id);

    const own = await request(app).get('/api/drawer/commands').set(auth(A.tokens.owner));
    expect(own.body.commands.map((c) => c.id)).toContain(id);
  });

  it("another tenant's drawer list shows only its own printers", async () => {
    const res = await request(app).get('/api/drawer/targets').set(auth(B.tokens.owner));
    expect(res.status).toBe(200);
    expect(res.body.targets.map((t) => t.id)).toEqual([B.targetId]);
  });
});
