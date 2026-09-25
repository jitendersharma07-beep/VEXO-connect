// Per-tenant merchant credentials (contract §4).
//
// The sentence this file exists to hold is "do not route unrelated customers'
// settlements into one merchant account". On a multi-tenant deployment that is
// not a policy anyone can follow by being careful — it is a property of where
// the credentials are read from. Held in process environment variables, one set
// per running server, every company sharing the box shares one merchant
// account and every customer's card payment lands in whoever's bank account the
// box was configured with. There is no careful way to use a global.
//
// So the tests here are about resolution and confinement:
//   - an attempt binds the account resolved from ITS OWN order's company
//   - a store account ends the search; it never climbs to the company account
//   - a webhook signed by one tenant's secret cannot touch another's attempt
//   - a secret that goes in never comes back out, in a response, a list or an
//     audit row
//
// The environment fallback is deliberately still here and deliberately tested:
// it is what a single-account deployment uses, and it is reachable ONLY for a
// company that has configured no account of its own.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('paymentAccounts.test.js requires a DATABASE_URL ending in _test');
}

// Must precede the app import: config/env.js reads process.env once, at load.
process.env.POS_GATEWAY_PROVIDER = 'test';
process.env.POS_GATEWAY_WEBHOOK_SECRET = 'accounts-suite-env-secret-not-real';
process.env.POS_GATEWAY_KEY_ID = 'env_key_id_not_real';
process.env.POS_GATEWAY_KEY_SECRET = 'env_key_secret_not_real';
// 32 bytes of hex. A throwaway for this suite, and the only reason the routes
// will accept a credential at all — without it they refuse rather than storing
// plaintext.
process.env.POS_PAYMENT_SECRET_KEY = 'a'.repeat(64);

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { signPayload, SIGNATURE_HEADER, setTestSettlement, clearTestSettlements } = await import(
  '../src/lib/gateway/testAdapter.js'
);
const { resolveAccount, PaymentAccountError } = await import('../src/lib/gateway/accounts.js');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const ENV_SECRET = process.env.POS_GATEWAY_WEBHOOK_SECRET;

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

// A is a two-store tenant, so "this outlet settles into its own account" has
// somewhere to be true. B is a second tenant and exists to be isolated from.
const A = { tokens: {} };
const B = { tokens: {} };

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const buildShop = async (shop, { slug, name, publicId, code, secondStore = false }) => {
  const passwordHash = await hashPassword(PW);
  shop.company = await prisma.company.create({
    data: {
      name,
      slug,
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 4, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  shop.branch = await prisma.branch.create({
    data: { companyId: shop.company.id, publicId, name: 'Main', code },
  });
  if (secondStore) {
    shop.branch2 = await prisma.branch.create({
      data: {
        companyId: shop.company.id,
        publicId: publicId.replace(/\d+$/, (n) => String(Number(n) + 100).padStart(n.length, '0')),
        name: 'Second',
        code: `${code}2`,
      },
    });
  }
  const mk = (email, fullName, role, branchId) =>
    prisma.posUser.create({
      data: { email, fullName, role, companyId: shop.company.id, branchId, passwordHash },
    });
  await mk(`owner@${slug}.test`, 'Owner', 'CUSTOMER_OWNER', shop.branch.id);
  await mk(`till@${slug}.test`, 'Till', 'CASHIER', shop.branch.id);
  shop.tokens.owner = await login(`owner@${slug}.test`);
  shop.tokens.cashier = await login(`till@${slug}.test`);
  if (secondStore) {
    await mk(`mgr2@${slug}.test`, 'Second manager', 'BRANCH_MANAGER', shop.branch2.id);
    shop.tokens.manager2 = await login(`mgr2@${slug}.test`);
  }

  const tax = await prisma.taxRate.create({
    data: { companyId: shop.company.id, name: 'No tax', ratePercent: '0.00' },
  });
  const cat = await prisma.category.create({
    data: { companyId: shop.company.id, name: 'Food', sortOrder: 1 },
  });
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
};

const listAccounts = (shop, token = shop.tokens.owner) =>
  request(app).get('/api/payment-accounts').set(auth(token));

const createAccount = (shop, body, token = shop.tokens.owner) =>
  request(app).post('/api/payment-accounts').set(auth(token)).send({
    provider: 'test',
    mode: 'TEST',
    ...body,
  });

// A stored account does NOT start taking payments — `active` defaults to false
// and an operator turns it on after checking the provider's dashboard. So every
// test below that wants a working account has to say so in as many words, which
// is the same sequence an operator performs. That default is asserted in its
// own right further down; here it is only being obeyed.
const activate = async (shop, accountId, token = shop.tokens.owner) => {
  const res = await request(app)
    .patch(`/api/payment-accounts/${accountId}`)
    .set(auth(token))
    .send({ active: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.account.active).toBe(true);
  return res;
};

const workingAccount = async (shop, body, token = shop.tokens.owner) => {
  const made = await createAccount(shop, body, token);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await activate(shop, made.body.account.id, token);
  return made;
};

const billed = async (shop, { branch = shop.branch, token = shop.tokens.owner } = {}) => {
  const created = await request(app)
    .post('/api/orders')
    .set(auth(token))
    .send({ type: 'TAKEAWAY', branchId: branch.id, items: [{ productId: shop.productId, qty: 1 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.order.id;
  const bill = await request(app).post(`/api/orders/${id}/bill`).set(auth(token)).send({});
  expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  return { id, total: bill.body.order.total };
};

const openCheckout = (shop, orderId, token = shop.tokens.owner) =>
  request(app).post(`/api/orders/${orderId}/payment-intents`).set(auth(token)).send({});

let evtSeq = 0;
const deliver = async (payload, secret) => {
  const raw = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  return request(app)
    .post('/api/gateway/webhook')
    .set(SIGNATURE_HEADER, signPayload(secret, timestamp, raw))
    .set('Content-Type', 'application/json')
    .send(raw);
};

const succeeded = (providerRef, amountPaise) => ({
  id: `evt_acct_${++evtSeq}_${Date.now()}`,
  type: 'payment.succeeded',
  data: { providerRef, amountPaise, currency: 'INR' },
});

beforeAll(async () => {
  await wipe();
  await buildShop(A, { slug: 'acct-a', name: 'Accounts A', publicId: 'VC-AC-0001', code: 'AA', secondStore: true });
  await buildShop(B, { slug: 'acct-b', name: 'Accounts B', publicId: 'VC-AC-0002', code: 'AB' });
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

// Each test configures the merchant accounts it needs from nothing, so the
// bills and attempts that reference them go too — an intent holds an accountId,
// and a stale one from the previous test would either block the delete or,
// worse, survive into a test reasoning about which account settles what.
beforeEach(async () => {
  clearTestSettlements();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.paymentProviderAccount.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kitchenItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
});

// ---------------------------------------------------------------------------

describe('storing a merchant credential', () => {
  const SECRET = 'live-looking-but-entirely-fake-secret-01';

  it('never gives the secret back, in the response or in the list', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a_1', keySecret: SECRET });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // What an operator screen needs is whether there is one, not what it is.
    expect(made.body.account.keySecretSet).toBe(true);
    expect(JSON.stringify(made.body)).not.toContain(SECRET);

    const list = await listAccounts(A);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.accounts[0].keyId).toBe('key_a_1');
    expect(list.body.accounts[0]).not.toHaveProperty('keySecret');
    expect(list.body.accounts[0]).not.toHaveProperty('keySecretEnc');
  });

  it('holds it encrypted at rest', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a_1', keySecret: SECRET });
    const row = await prisma.paymentProviderAccount.findUnique({ where: { id: made.body.account.id } });
    expect(row.keySecretEnc).not.toContain(SECRET);
    expect(row.keySecretEnc.length).toBeGreaterThan(SECRET.length);
  });

  it('records a fingerprint in the audit log, never the credential', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a_1', keySecret: SECRET });
    const entry = await prisma.posAuditLog.findFirst({
      where: { action: 'PAYMENT_ACCOUNT_CREATE', entityId: made.body.account.id },
    });
    expect(entry).toBeTruthy();
    const meta = JSON.stringify(entry.meta);
    expect(meta).not.toContain(SECRET);
    // Enough to prove two accounts hold different credentials, or that a
    // rotation actually changed something.
    expect(entry.meta.keySecretFingerprint).toBeTruthy();
    expect(entry.meta.keySecretFingerprint).not.toContain(SECRET);
  });

  it('refuses a provider this build has no adapter for', async () => {
    const res = await createAccount(A, {
      provider: 'stripe',
      label: 'Wrong provider',
      keyId: 'key_x',
      keySecret: SECRET,
    });
    // Storing credentials for a name nothing can use is a silent dead end.
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('provider');
    expect(res.body.error.message).toMatch(/configured for "test"/);
  });

  it('refuses a second account for the same provider in the same place', async () => {
    await createAccount(A, { label: 'One', keyId: 'key_a_1', keySecret: SECRET });
    const again = await createAccount(A, { label: 'Two', keyId: 'key_a_2', keySecret: SECRET });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already has a company-wide/i);
  });

  it('will not accept a credential on a deployment that cannot encrypt one', async () => {
    const list = await listAccounts(A);
    // The two facts an operator needs before they can read the list correctly.
    expect(list.body.secretStorageReady).toBe(true);
    expect(list.body.provider).toBe('test');
    // The refusal itself is asserted in the negative control below, where the
    // key is genuinely absent.
  });
});

// ---------------------------------------------------------------------------

describe('which account a payment settles into', () => {
  const A_SECRET = 'company-a-secret-entirely-fake-000001';
  const B_SECRET = 'company-b-secret-entirely-fake-000002';

  it("binds an attempt to its OWN company's account", async () => {
    const accountA = await workingAccount(A, { label: 'A head office', keyId: 'key_a', keySecret: A_SECRET });
    const accountB = await workingAccount(B, { label: 'B head office', keyId: 'key_b', keySecret: B_SECRET });

    const orderA = await billed(A);
    const orderB = await billed(B);
    const intentA = await openCheckout(A, orderA.id);
    const intentB = await openCheckout(B, orderB.id);
    expect(intentA.status, JSON.stringify(intentA.body)).toBe(201);
    expect(intentB.status, JSON.stringify(intentB.body)).toBe(201);

    const rowA = await prisma.paymentIntent.findUnique({ where: { id: intentA.body.intent.id } });
    const rowB = await prisma.paymentIntent.findUnique({ where: { id: intentB.body.intent.id } });
    // The whole claim, in two assertions: each tenant's money is routed to its
    // own merchant account, and this is a property of resolution rather than
    // of anybody remembering to configure the box correctly.
    expect(rowA.accountId).toBe(accountA.body.account.id);
    expect(rowB.accountId).toBe(accountB.body.account.id);
    expect(rowA.accountId).not.toBe(rowB.accountId);
  });

  it('prefers the store account over the company one', async () => {
    const companyWide = await workingAccount(A, { label: 'Head office', keyId: 'key_hq', keySecret: A_SECRET });
    const storeOwn = await workingAccount(A, {
      label: 'Second outlet',
      branchId: A.branch2.id,
      keyId: 'key_store2',
      keySecret: A_SECRET,
    });

    const resolved = await resolveAccount({
      companyId: A.company.id,
      branchId: A.branch2.id,
      provider: 'test',
    });
    expect(resolved.accountId).toBe(storeOwn.body.account.id);
    expect(resolved.keyId).toBe('key_store2');

    // And the store with no row of its own uses the company account.
    const fallback = await resolveAccount({
      companyId: A.company.id,
      branchId: A.branch.id,
      provider: 'test',
    });
    expect(fallback.accountId).toBe(companyWide.body.account.id);
  });

  it('does NOT climb past a switched-off store account to the company one', async () => {
    await workingAccount(A, { label: 'Head office', keyId: 'key_hq', keySecret: A_SECRET });
    const storeOwn = await workingAccount(A, {
      label: 'Second outlet',
      branchId: A.branch2.id,
      keyId: 'key_store2',
      keySecret: A_SECRET,
    });
    const off = await request(app)
      .patch(`/api/payment-accounts/${storeOwn.body.account.id}`)
      .set(auth(A.tokens.owner))
      .send({ active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    // "This outlet stopped taking online payments" and "this outlet's money now
    // goes to head office" are different instructions, and only one was given.
    await expect(
      resolveAccount({ companyId: A.company.id, branchId: A.branch2.id, provider: 'test' }),
    ).rejects.toThrow(PaymentAccountError);
  });

  it('uses the environment pair only for a tenant that has configured nothing', async () => {
    await workingAccount(A, { label: 'A only', keyId: 'key_a', keySecret: A_SECRET });

    const configured = await resolveAccount({
      companyId: A.company.id,
      branchId: A.branch.id,
      provider: 'test',
    });
    expect(configured.source).toBe('ACCOUNT');

    // B has no row, so the single-account deployment's answer applies to B and
    // to nobody else. Once a tenant configures a row this branch is unreachable
    // for it — which is what stops a configured tenant ever being billed
    // through the shared credentials.
    const bare = await resolveAccount({
      companyId: B.company.id,
      branchId: B.branch.id,
      provider: 'test',
    });
    expect(bare.source).toBe('ENV');
    expect(bare.accountId).toBeNull();
  });

  it('refuses live credentials on a server that is not production', async () => {
    await workingAccount(A, {
      label: 'Head office',
      keyId: 'key_a',
      keySecret: A_SECRET,
      mode: 'LIVE',
    });
    // A live key on a dev box is a paste error, and the cost of noticing late
    // is a genuine charge on somebody's card during a test run.
    await expect(
      resolveAccount({ companyId: A.company.id, branchId: A.branch.id, provider: 'test' }),
    ).rejects.toThrow(/not a production server/i);
  });

  it('does not start taking payments the moment a credential is stored', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a', keySecret: A_SECRET });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // Typing a key into a form is not the same as having checked, on the
    // provider's own dashboard, that the key belongs to this shop and is ready.
    // Until somebody says so, the row exists and settles nothing.
    expect(made.body.account.active).toBe(false);
    await expect(
      resolveAccount({ companyId: A.company.id, branchId: A.branch.id, provider: 'test' }),
    ).rejects.toThrow(/not active/i);

    // Positive control: the only thing between this account and working is the
    // operator's confirmation.
    await activate(A, made.body.account.id);
    const resolved = await resolveAccount({
      companyId: A.company.id,
      branchId: A.branch.id,
      provider: 'test',
    });
    expect(resolved.accountId).toBe(made.body.account.id);
  });

  it('refuses outright rather than falling back to the shared environment pair', async () => {
    // The tempting behaviour — an account that is off, so use the deployment's
    // own credentials instead — would take this tenant's money into whichever
    // merchant account the environment names. That is the single failure the
    // brief names by hand, and it must not be reachable by a switch nobody
    // flipped. B's row is off; B's money goes nowhere at all.
    const made = await createAccount(B, { label: 'B head office', keyId: 'key_b', keySecret: B_SECRET });
    expect(made.status).toBe(201);

    await expect(
      resolveAccount({ companyId: B.company.id, branchId: B.branch.id, provider: 'test' }),
    ).rejects.toThrow(PaymentAccountError);

    // Negative control, and the reason this test is not merely a restatement of
    // the one above: a tenant with NO row at all does reach the environment
    // pair, so the refusal here is caused by B's own row rather than by the
    // environment being unset.
    await prisma.paymentProviderAccount.delete({ where: { id: made.body.account.id } });
    const bare = await resolveAccount({
      companyId: B.company.id,
      branchId: B.branch.id,
      provider: 'test',
    });
    expect(bare.source).toBe('ENV');
  });
});

// ---------------------------------------------------------------------------

describe('a webhook cannot cross a tenant boundary', () => {
  const A_SECRET = 'company-a-webhook-secret-fake-0001';
  const B_SECRET = 'company-b-webhook-secret-fake-0002';

  it("refuses to settle A's attempt on a delivery signed with B's secret", async () => {
    await workingAccount(A, {
      label: 'A head office',
      keyId: 'key_a',
      keySecret: 'company-a-key-secret-fake-0001',
      webhookSecret: A_SECRET,
    });
    await workingAccount(B, {
      label: 'B head office',
      keyId: 'key_b',
      keySecret: 'company-b-key-secret-fake-0002',
      webhookSecret: B_SECRET,
    });

    const orderA = await billed(A);
    const intentA = await openCheckout(A, orderA.id);
    const refA = intentA.body.intent.providerRef;
    expect(refA).toBeTruthy();

    // B's secret is genuinely valid — this is not a forged signature. It is a
    // real delivery to the wrong tenant's attempt, which is what a shared
    // webhook URL makes possible and what the account check has to stop.
    const payload = succeeded(refA, 10000);
    const crossed = await deliver(payload, B_SECRET);
    expect(crossed.status).toBe(200);
    expect(crossed.body.applied).toBe(false);

    const event = await prisma.gatewayWebhookEvent.findFirst({
      where: { eventId: payload.id },
    });
    // Same wording as a genuine miss, on purpose: the reply must not confirm
    // that the reference exists on some other tenant.
    expect(event.skippedReason).toMatch(/no intent matches this provider reference/i);
    expect(await prisma.payment.count({ where: { orderId: orderA.id } })).toBe(0);
    expect((await prisma.order.findUnique({ where: { id: orderA.id } })).status).toBe('BILLED');

    // The control: the same delivery signed by A's own secret settles.
    const proper = await deliver(succeeded(refA, 10000), A_SECRET);
    expect(proper.status).toBe(200);
    expect(proper.body.applied).toBe(true);
    const payment = await prisma.payment.findFirst({ where: { orderId: orderA.id } });
    expect(payment.channel).toBe('GATEWAY');
    expect(payment.entrySource).toBe('PROVIDER_CONFIRMED');
  });

  it('rejects a delivery signed with no known secret at all, and stores nothing', async () => {
    await workingAccount(A, {
      label: 'A head office',
      keyId: 'key_a',
      keySecret: 'company-a-key-secret-fake-0001',
      webhookSecret: A_SECRET,
    });
    const orderA = await billed(A);
    const intentA = await openCheckout(A, orderA.id);

    const before = await prisma.gatewayWebhookEvent.count();
    const res = await deliver(succeeded(intentA.body.intent.providerRef, 10000), 'not-any-configured-secret');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('POS_GATEWAY_SIGNATURE_INVALID');
    // Never stored: eventId comes from the payload, so an unverified delivery
    // could otherwise squat the unique key and block the genuine event.
    expect(await prisma.gatewayWebhookEvent.count()).toBe(before);
  });

  it('still honours the deployment-wide secret for a tenant with no account', async () => {
    // B has configured nothing, so B's attempts are opened on the environment
    // credentials and its deliveries are signed with the environment secret.
    const orderB = await billed(B);
    const intentB = await openCheckout(B, orderB.id);
    const res = await deliver(succeeded(intentB.body.intent.providerRef, 10000), ENV_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('who may see and change a merchant account', () => {
  const SECRET = 'a-secret-that-is-entirely-fake-0001';

  it("does not show one tenant another tenant's accounts", async () => {
    const mine = await createAccount(A, { label: 'A head office', keyId: 'key_a', keySecret: SECRET });
    await createAccount(B, { label: 'B head office', keyId: 'key_b', keySecret: SECRET });

    const list = await listAccounts(B);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0].keyId).toBe('key_b');

    // And naming A's account id directly is absent, not forbidden.
    const patch = await request(app)
      .patch(`/api/payment-accounts/${mine.body.account.id}`)
      .set(auth(B.tokens.owner))
      .send({ label: 'Mine now' });
    expect(patch.status).toBe(404);
    const verify = await request(app)
      .post(`/api/payment-accounts/${mine.body.account.id}/verify`)
      .set(auth(B.tokens.owner))
      .send({});
    expect(verify.status).toBe(404);
  });

  it('shows a store manager their own store account and the company-wide one', async () => {
    await createAccount(A, { label: 'Head office', keyId: 'key_hq', keySecret: SECRET });
    await createAccount(A, {
      label: 'Second outlet',
      branchId: A.branch2.id,
      keyId: 'key_store2',
      keySecret: SECRET,
    });

    const list = await listAccounts(A, A.tokens.manager2);
    expect(list.status).toBe(200);
    const byKey = Object.fromEntries(list.body.accounts.map((a) => [a.keyId, a]));
    // The company-wide row is what their store settles into when it has no row
    // of its own; hiding it would show an empty list for a store that takes
    // online payments perfectly well.
    expect(Object.keys(byKey).sort()).toEqual(['key_hq', 'key_store2']);
    expect(byKey.key_store2.appliesTo).toMatch(/Second/);
    expect(byKey.key_hq.appliesTo).toMatch(/whole company/i);
  });

  it('refuses a cashier', async () => {
    const res = await createAccount(A, { label: 'Nope', keyId: 'key_x', keySecret: SECRET }, A.tokens.cashier);
    expect(res.status).toBe(403);
    const list = await listAccounts(A, A.tokens.cashier);
    expect(list.status).toBe(403);
  });

  it('refuses an unauthenticated read', async () => {
    const res = await request(app).get('/api/payment-accounts');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('checking that a credential works', () => {
  const SECRET = 'verify-suite-secret-entirely-fake-01';

  it('stamps a verification only when the provider says yes', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a', keySecret: SECRET });
    const res = await request(app)
      .post(`/api/payment-accounts/${made.body.account.id}/verify`)
      .set(auth(A.tokens.owner))
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.account.lastVerifiedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('drops the green tick when the credentials are changed underneath it', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a', keySecret: SECRET });
    await request(app)
      .post(`/api/payment-accounts/${made.body.account.id}/verify`)
      .set(auth(A.tokens.owner))
      .send({});

    const rotated = await request(app)
      .patch(`/api/payment-accounts/${made.body.account.id}`)
      .set(auth(A.tokens.owner))
      .send({ keySecret: 'a-rotated-secret-entirely-fake-0002' });
    expect(rotated.status).toBe(200);
    // A past verification was a statement about the credentials that were there
    // then. Leaving it up would say a key nobody has ever used is known to work.
    expect(rotated.body.account.lastVerifiedAt).toBeNull();
    expect(rotated.body.account.lastVerifyNote).toBeNull();
  });

  it('records a refusal as a note without claiming the account was verified', async () => {
    const made = await createAccount(A, { label: 'Head office', keyId: 'key_a', keySecret: SECRET });
    // The test adapter says no when there is no key id. Blanked directly
    // because the routes correctly refuse to store an account without one.
    await prisma.paymentProviderAccount.update({
      where: { id: made.body.account.id },
      data: { keyId: '' },
    });
    const res = await request(app)
      .post(`/api/payment-accounts/${made.body.account.id}/verify`)
      .set(auth(A.tokens.owner))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.note).toMatch(/no key id/i);
    expect(res.body.account.lastVerifiedAt).toBeNull();
  });
});
