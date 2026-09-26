// Provider integration suite (LANE providers) — CONTRACT TESTS.
//
// WHAT THIS FILE IS EVIDENCE ABOUT, AND WHAT IT IS NOT.
//
// Every provider call below goes to a deterministic in-process double from
// src/lib/integrations/adapters/testAdapters.js. No Zomato, Reelo or Tally
// endpoint is contacted, and none could be: the doubles are registered through
// overrideAdapter(), which refuses outside NODE_ENV=test.
//
// So a green run here proves things about VEXO — that a redelivered callback
// makes one kitchen ticket, that a failed voucher lands in the error queue and
// retries with backoff, that two companies cannot see each other's connections,
// that an unknown loyalty customer reads as "unknown" and never as "zero". It
// proves NOTHING about whether our request bodies match what a provider expects.
// A double agrees with whatever we send it.
//
// Provider-side verification is BLOCKED on account access and is recorded as
// such in docs/INTEGRATION-VERIFICATION.md. No result in this file may be cited
// as provider testing.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('integrations.test.js requires a DATABASE_URL ending in _test');
}

// Must precede the app import: config/env.js reads process.env once, at load,
// and app.js only MOUNTS the webhook router when a credential key is present.
// 64 hex characters because that is what env.js validates.
process.env.POS_INTEGRATION_SECRET_KEY = 'a'.repeat(64);
// Left at 0 (off) deliberately. Delivery is driven explicitly with runOnce() so
// that no background timer claims a job out from under an assertion.
delete process.env.POS_INTEGRATION_WORKER_INTERVAL_MS;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { overrideAdapter, clearAdapterOverrides } = await import('../src/lib/integrations/adapters/index.js');
const { testAggregator, testLoyalty, testAccounting, testControl } =
  await import('../src/lib/integrations/adapters/testAdapters.js');
const { runOnce } = await import('../src/lib/integrations/worker.js');
// Imported so a duplicate hook call can be made directly. A bill cannot be
// issued twice through the API — the route refuses a closed order — so the only
// way to prove that a repeated "this bill was issued" does not credit a customer
// twice is to repeat the call the route makes.
const { onOrderBilled } = await import('../src/lib/integrations/hooks.js');
// The import's own fingerprint function, so a test can set up an interrupted run
// the way the route would have left one. Re-implementing the digest in the test
// would only prove that the test and the route agree on SHA-256.
const { fingerprint, runReport } = await import('../src/lib/integrations/loyaltyImport.js');
// Imported so the compare-and-set inside applyState can be driven the way two
// app processes drive it: both deciding against the same row snapshot, before
// either has written. Two HTTP deliveries cannot reproduce that — supertest
// awaits each one, so the second always reads the first's result.
const { applyState } = await import('../src/lib/integrations/aggregatorOrders.js');

const app = createApp();

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
const other = {};
let company, branch, productId, serviceUserId;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// --- provider fixtures -------------------------------------------------------

// The header the doubles' connections expect on an inbound callback. A literal
// pair, because that is what the connection's sealed credential holds and what
// verifySharedHeader compares against — there is no scheme to derive it from.
const IN_HEADER = 'x-vexo-test-auth';
const IN_VALUE = 'inbound-value-not-a-real-token';

const configure = async (provider, { config, credential, token = tokens.owner }) => {
  const put = await request(app).put(`/api/integrations/${provider}`).set(auth(token))
    .send({ enabled: true, config });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const cred = await request(app).put(`/api/integrations/${provider}/credential`).set(auth(token))
    .send({ credential });
  expect(cred.status, JSON.stringify(cred.body)).toBe(200);
  return prisma.integrationConnection.findUnique({
    where: { companyId_provider: { companyId: token === other.ownerToken ? other.company.id : company.id, provider } },
  });
};

const zomatoCredential = {
  apiKey: 'zomato-key-not-a-real-one',
  inboundHeaderName: IN_HEADER,
  inboundHeaderValue: IN_VALUE,
};

const reeloCredential = {
  vendorId: 'vendor-test',
  merchantId: 'merchant-test',
  customerKey: 'customer-key-not-a-real-one',
};

// A host, not a URL: lanHost refuses a scheme on purpose, because Tally is
// reached inside the shop network and a URL in this field is how "do not expose
// Tally to the internet" gets violated from the settings screen.
const tallyCredential = { host: '127.0.0.1', port: 9000 };

// A voucher shaped the way accounting.js shapes one, so a test that drives the
// adapter directly is exercising the real XML path rather than a stub.
const salesVoucherPayload = () => ({
  date: '2026-09-25',
  voucherNumber: 'VCX-TEST-1',
  narration: 'VEXO Connect test sale',
  partyLedgerName: 'Walk-in Customer',
  partyAmount: 118,
  reference: 'VCX-TEST-1',
  lines: [
    { ledgerName: 'Sales - Dine In', amount: 100 },
    { ledgerName: 'Output CGST', amount: 9 },
    { ledgerName: 'Output SGST', amount: 9 },
  ],
});

const tallyConfig = {
  companyName: 'Test Cafe Books',
  financialYearFrom: '2026-04-01',
  financialYearTo: '2027-03-31',
  postFrom: '2026-04-01',
  postCreditNotes: true,
  postReceipts: true,
};

// --- callback delivery -------------------------------------------------------

let evtSeq = 0;
const nextEventId = () => `evt-${++evtSeq}-${Date.now()}`;

// --- driving the queue from a test -------------------------------------------

// Not "a long time from now" as a vague idea but a date no run will reach, so
// parking a job is unambiguous rather than a race.
const PARKED = new Date('2099-01-01T00:00:00.000Z');

// Runs exactly one named job and nothing else.
//
// The queue is company-wide and one billed order produces two jobs — a Reelo
// bill sync and a Tally voucher — created in the same instant. "Run the next due
// job" is therefore a coin toss between them, and testControl.failNextWith() is
// one-shot: it would land on whichever job the pass reached first and the
// assertion would be about the wrong row. So everything else is parked, the
// named job is made due, and the pass is bounded to one.
const runOnlyJob = async (jobId, fail = null) => {
  await prisma.integrationJob.updateMany({
    where: { companyId: company.id, status: 'PENDING', id: { not: jobId } },
    data: { nextAttemptAt: PARKED },
  });
  await prisma.integrationJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date() } });
  if (fail) testControl.failNextWith(fail.kind, fail.message);
  const [outcome] = await runOnce({ companyId: company.id, max: 1 });
  return outcome;
};

// A till order, and a bill. The cashier's own token, because that is who rings
// one up — and it means these also exercise the branch scoping every loyalty
// route applies to an order id.
const openOrder = async (token = tokens.cashier) => {
  const created = await request(app).post('/api/orders').set(auth(token))
    .send({ type: 'TAKEAWAY', items: [{ productId, qty: 2 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.order;
};

const billOrder = async (orderId, token = tokens.cashier) => {
  const res = await request(app).post(`/api/orders/${orderId}/bill`).set(auth(token)).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.order;
};

// Posts an envelope the way a provider would: raw bytes, the agreed header, and
// nothing else. The test aggregator's parseInbound takes an already-normalised
// envelope, so the body IS the envelope — which is what lets a case hand-write
// the exact duplicate, stale or unmappable shape it wants to assert on.
const deliver = (connectionId, envelope, { header = IN_HEADER, value = IN_VALUE, provider = 'ZOMATO' } = {}) => {
  const req = request(app)
    .post(`/api/integrations/webhooks/${provider}/${connectionId}`)
    .set('Content-Type', 'application/json');
  if (header) req.set(header, value);
  return req.send(typeof envelope === 'string' ? envelope : JSON.stringify(envelope));
};

const placement = (overrides = {}) => ({
  externalEventId: nextEventId(),
  kind: 'ORDER_PLACED',
  externalOrderId: `zo-${evtSeq}`,
  externalOrderDisplayId: `#${evtSeq}`,
  externalOutletId: 'outlet-1',
  state: null,
  rawState: 'placed',
  providerSequence: 1,
  providerEventAt: new Date().toISOString(),
  placedAt: new Date().toISOString(),
  paymentMode: 'PREPAID',
  items: [{ externalItemId: productId, name: 'Latte', quantity: 2, unitPrice: 200, total: 400 }],
  // 2 × ₹200 is ₹400 in this catalogue — the product's price is GST-inclusive,
  // so the platform's gross and our total agree and the happy path records no
  // discrepancy. The mismatch case below changes this figure on purpose.
  money: {
    grossAmount: 400,
    providerDiscountAmount: 0,
    restaurantDiscountAmount: 0,
    commissionAmount: 80,
    taxAmount: 19.05,
    deliveryFeeAmount: 0,
    packagingFeeAmount: 0,
    netPayoutAmount: 320,
  },
  unreadable: [],
  ...overrides,
});

const stateChange = (externalOrderId, state, overrides = {}) => ({
  externalEventId: nextEventId(),
  kind: 'ORDER_STATE',
  externalOrderId,
  externalOutletId: 'outlet-1',
  state,
  rawState: String(state).toLowerCase(),
  providerSequence: 2,
  providerEventAt: new Date().toISOString(),
  items: [],
  money: {},
  unreadable: [],
  ...overrides,
});

beforeAll(async () => {
  await wipeAll();

  // The doubles stand in for the three operable providers. resolveAdapter()
  // consults these before adapterFor(), and overrideAdapter() throws outside
  // NODE_ENV=test — so this wiring cannot exist in a deployed build.
  overrideAdapter('ZOMATO', testAggregator);
  overrideAdapter('REELO', testLoyalty);
  overrideAdapter('TALLY', testAccounting);

  const passwordHash = await hashPassword(PW);
  company = await prisma.company.create({
    data: {
      name: 'Integration Cafe', slug: 'integration-cafe',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  branch = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-IN-0001', name: 'In One', code: 'I1' },
  });
  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'owner.i@test.local', fullName: 'Owner I', role: 'CUSTOMER_OWNER', companyId: company.id });
  await mk({ email: 'cashier.i@test.local', fullName: 'Cashier I', role: 'CASHIER', companyId: company.id, branchId: branch.id });
  await mk({ email: 'manager.i@test.local', fullName: 'Manager I', role: 'BRANCH_MANAGER', companyId: company.id, branchId: branch.id });
  // The account aggregator orders are attributed to. A dedicated non-login
  // service user, which is what the connection config is for — see the note on
  // orderActorUserId in providers.js.
  const svc = await mk({
    email: 'aggregator.i@test.local', fullName: 'Aggregator Service', role: 'CASHIER',
    companyId: company.id, branchId: branch.id,
  });
  serviceUserId = svc.id;

  tokens.owner = await login('owner.i@test.local');
  tokens.cashier = await login('cashier.i@test.local');
  tokens.manager = await login('manager.i@test.local');

  const tax = await request(app).post('/api/catalog/tax-rates').set(auth(tokens.owner))
    .send({ name: 'GST 5%', ratePercent: 5 });
  const cat = await request(app).post('/api/catalog/categories').set(auth(tokens.owner))
    .send({ name: 'Coffee', sortOrder: 1 });
  const prod = await request(app).post('/api/catalog/products').set(auth(tokens.owner))
    .send({ categoryId: cat.body.category.id, name: 'Latte', basePrice: 200, taxRateId: tax.body.taxRate.id });
  expect(prod.status, JSON.stringify(prod.body)).toBe(201);
  productId = prod.body.product.id;

  // A second tenant. Integration callbacks carry no company of their own — they
  // name a connection id — so cross-tenant leakage is only provable against a
  // real neighbour to leak from.
  other.company = await prisma.company.create({
    data: {
      name: 'Neighbour Cafe', slug: 'neighbour-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  other.branch = await prisma.branch.create({
    data: { companyId: other.company.id, publicId: 'VC-IN-0002', name: 'Nb One', code: 'N1' },
  });
  await mk({ email: 'owner.n@test.local', fullName: 'Owner N', role: 'CUSTOMER_OWNER', companyId: other.company.id });
  other.ownerToken = await login('owner.n@test.local');
});

afterAll(async () => {
  clearAdapterOverrides();
  // Ordinary cleanup now. It was once this lane's twelve tables by hand, because
  // their residue failed 17 of 23 files; wipeAll() makes that structural.
  await wipeAll();
  await prisma.$disconnect();
});

afterEach(() => {
  testControl.reset();
});

// --- registry, operability, permissions --------------------------------------

describe('provider registry', () => {
  it('lists every provider with its documentation status and capability contract', async () => {
    const res = await request(app).get('/api/integrations/providers').set(auth(tokens.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const keys = res.body.providers.map((p) => p.key);
    expect(keys).toEqual(['SWIGGY', 'ZOMATO', 'REELO', 'TALLY']);
    // The screen has to be able to say "credential storage is off" rather than
    // offering a form that will refuse to save.
    expect(res.body.credentialStorageAvailable).toBe(true);

    const swiggy = res.body.providers.find((p) => p.key === 'SWIGGY');
    expect(swiggy.operable).toBe(false);
    expect(swiggy.blockedReason).toMatch(/no public|not publish|developers\.swiggy/i);
    // A capability nobody can implement must read NOT_OFFERED or UNSPECIFIED,
    // never SPECIFIED. Asserted as an invariant so a future edit cannot quietly
    // promote a guess.
    expect(Object.values(swiggy.capabilities)).not.toContain('SPECIFIED');
  });

  it('refuses to configure Swiggy with Swiggy’s own reason, not a 500', async () => {
    const res = await request(app).put('/api/integrations/SWIGGY').set(auth(tokens.owner))
      .send({ enabled: true, config: {} });
    // The whole value of the guard is the sentence it carries. A 500 reaches the
    // operator as "Something went wrong" and leaves them pressing Save forever.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_INTEGRATION_NOT_OPERABLE');
    expect(res.body.error.message).toMatch(/Swiggy|API/i);
  });

  it('refuses a Swiggy credential for the same reason before touching the key', async () => {
    const res = await request(app).put('/api/integrations/SWIGGY/credential').set(auth(tokens.owner))
      .send({ credential: { apiKey: 'x' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_INTEGRATION_NOT_OPERABLE');
  });

  it('rejects an unknown provider key rather than creating a row for it', async () => {
    const res = await request(app).get('/api/integrations/DUNZO').set(auth(tokens.owner));
    expect(res.status).toBe(400);
  });

  it('describes exactly the fields its own schemas validate, so the settings form cannot drift', async () => {
    // The settings screen builds its form from credentialFields/configFields.
    // Nothing makes those agree with the zod schemas that judge the submission
    // except this test — and the way they come apart in practice is the bad way
    // round: the form stops offering a field the schema still requires, so Save
    // fails with a validation error about a box the operator never saw.
    const { PROVIDERS } = await import('../src/lib/integrations/providers.js');

    // TALLY's config schema is wrapped in .refine(), which is a ZodEffects and
    // carries no .shape of its own.
    const shapeOf = (schema) => {
      let s = schema;
      while (!s.shape && s._def?.schema) s = s._def.schema;
      return s.shape ?? {};
    };

    const res = await request(app).get('/api/integrations/providers').set(auth(tokens.owner));
    for (const summary of res.body.providers) {
      const def = PROVIDERS[summary.key];
      for (const [fields, schema, which] of [
        [summary.credentialFields, def.credentialSchema, 'credential'],
        [summary.configFields, def.configSchema, 'config'],
      ]) {
        const shape = shapeOf(schema);
        for (const f of fields) {
          expect(shape[f.name], `${summary.key} ${which} field "${f.name}" is offered but not validated`).toBeDefined();
          // A field the form calls required must actually be required, or the
          // asterisk on the screen is decoration.
          if (f.required) expect(shape[f.name].isOptional()).toBe(false);
        }
        // And the other direction, which is the one that strands an operator: a
        // key the schema demands and the form never asks for.
        for (const [name, member] of Object.entries(shape)) {
          if (member.isOptional()) continue;
          expect(
            fields.some((f) => f.name === name),
            `${summary.key} ${which} requires "${name}" but the form does not ask for it`,
          ).toBe(true);
        }
      }
      // Swiggy is the control: no fields, because nothing about it is knowable.
      if (!summary.operable) {
        expect(summary.credentialFields).toEqual([]);
        expect(summary.configFields).toEqual([]);
      }
    }
    // Positive control — this test would pass vacuously against four empty lists.
    const tally = res.body.providers.find((p) => p.key === 'TALLY');
    expect(tally.configFields.length).toBeGreaterThan(5);
    expect(tally.credentialFields.map((f) => f.name)).toContain('host');
  });
});

describe('permissions', () => {
  it('lets a branch manager read the queue but not configure the integration', async () => {
    // Chosen because it is an honest negative: BRANCH_MANAGER genuinely holds
    // integration.read and integration.job.retry, so a 403 on configure proves
    // the action gate rather than the absence of a login.
    const read = await request(app).get('/api/integrations/ZOMATO').set(auth(tokens.manager));
    expect(read.status, JSON.stringify(read.body)).toBe(200);

    const write = await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.manager))
      .send({ enabled: true, config: {} });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('POS_FORBIDDEN');
  });

  it('keeps a cashier out of the integrations screen entirely', async () => {
    const res = await request(app).get('/api/integrations/providers').set(auth(tokens.cashier));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('POS_FORBIDDEN');
  });

  it('lets a cashier use the till’s loyalty half', async () => {
    // The other side of the same coin: loyalty.lookup is in the SELL bundle, so
    // the cashier who cannot see /integrations can still serve a customer.
    const res = await request(app).post('/api/loyalty/lookup').set(auth(tokens.cashier))
      .send({ phone: '9876500001' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses an unauthenticated request to the integrations screen', async () => {
    const res = await request(app).get('/api/integrations/providers');
    expect(res.status).toBe(401);
  });
});

describe('credential handling', () => {
  it('never returns the ciphertext or the fingerprint, only the date', async () => {
    const conn = await configure('ZOMATO', {
      config: { orderActorUserId: serviceUserId, autoAccept: false },
      credential: zomatoCredential,
    });
    const res = await request(app).get('/api/integrations/ZOMATO').set(auth(tokens.owner));
    expect(res.status).toBe(200);
    expect(res.body.connection.hasCredential).toBe(true);
    expect(res.body.connection.credentialUpdatedAt).toBeTruthy();
    // The fingerprint is not a credential, but it is an oracle for "did the key
    // change" — so the caller gets a date instead.
    expect(res.body.connection.credentialCiphertext).toBeUndefined();
    expect(res.body.connection.credentialFingerprint).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(zomatoCredential.apiKey);
    expect(JSON.stringify(res.body)).not.toContain(IN_VALUE);

    const stored = await prisma.integrationConnection.findUnique({ where: { id: conn.id } });
    expect(stored.credentialCiphertext).toBeTruthy();
    // Sealed, not encoded. The plaintext must not be recoverable by reading the
    // column.
    expect(stored.credentialCiphertext).not.toContain(zomatoCredential.apiKey);
  });

  it('is CONFIGURED until something actually worked, then CONNECTED', async () => {
    await configure('REELO', { config: { redemptionEnabled: true }, credential: reeloCredential });
    const before = await request(app).get('/api/integrations/REELO').set(auth(tokens.owner));
    // Filling in the form is not a connection. An operator who reads "Connected"
    // stops watching the till.
    expect(before.body.status).toBe('CONFIGURED');

    const test = await request(app).post('/api/integrations/REELO/test').set(auth(tokens.owner)).send({});
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body.ok).toBe(true);
    expect(test.body.status).toBe('CONNECTED');
  });

  it('records a failed test as a failure and drops out of CONNECTED', async () => {
    testControl.failNextWith('RETRYABLE', 'provider unreachable');
    const res = await request(app).post('/api/integrations/REELO/test').set(auth(tokens.owner)).send({});
    // 200 with ok:false, not a 500. The request succeeded; the answer it carries
    // is "the provider would not talk to us", which is the likeliest outcome of
    // pressing Test and has to be reportable rather than an internal error.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.detail).toMatch(/unreachable/);
    const after = await request(app).get('/api/integrations/REELO').set(auth(tokens.owner));
    expect(after.body.status).toBe('ERROR');
    expect(after.body.connection.lastError).toMatch(/unreachable/);
  });

  it('drops back to CONFIGURED when the credential is replaced', async () => {
    const ok = await request(app).post('/api/integrations/REELO/test').set(auth(tokens.owner)).send({});
    expect(ok.body.status).toBe('CONNECTED');
    const rotated = await request(app).put('/api/integrations/REELO/credential').set(auth(tokens.owner))
      .send({ credential: { ...reeloCredential, customerKey: 'rotated-key-not-a-real-one' } });
    // Nothing has been shown to work with the NEW key, so leaving CONNECTED on
    // screen would be a claim about a credential nobody has exercised.
    expect(rotated.body.status).toBe('CONFIGURED');
    await request(app).post('/api/integrations/REELO/test').set(auth(tokens.owner)).send({});
  });

  it('refuses a credential that does not match the provider’s schema', async () => {
    const res = await request(app).put('/api/integrations/REELO/credential').set(auth(tokens.owner))
      .send({ credential: { vendorId: 'v' } });
    // Caught while the operator is still on the screen, not by a job at 8pm.
    expect(res.status).toBe(400);
  });

  it('refuses a credential for an integration that was never configured', async () => {
    const res = await request(app).put('/api/integrations/TALLY/credential').set(auth(other.ownerToken))
      .send({ credential: tallyCredential });
    expect(res.status).toBe(404);
  });

  it('refuses a Tally host written as a URL, because a scheme is how it leaves the LAN', async () => {
    await request(app).put('/api/integrations/TALLY').set(auth(tokens.owner))
      .send({ enabled: true, config: tallyConfig });
    const res = await request(app).put('/api/integrations/TALLY/credential').set(auth(tokens.owner))
      .send({ credential: { host: 'https://tally.example.com', port: 443 } });
    expect(res.status).toBe(400);
    // And a plain LAN address is accepted, so the refusal above is the guard
    // firing rather than the field being broken.
    const ok = await request(app).put('/api/integrations/TALLY/credential').set(auth(tokens.owner))
      .send({ credential: { host: '192.168.1.5', port: 9000 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  // The first version of this guard rejected an `http://` prefix and nothing
  // else, so every host below except the first one SAVED CLEANLY. `134744072` is
  // the one worth staring at: the WHATWG URL parser reads a bare integer as an
  // IPv4 address, so that string dials 8.8.8.8. These are the measured bypasses,
  // not hypothetical ones.
  const OFF_LAN_HOSTS = [
    ['a scheme', 'https://tally.example.com'],
    ['a public IPv4 literal', '8.8.8.8'],
    ['a public domain name', 'tally.example.com'],
    ['8.8.8.8 spelled as a decimal integer', '134744072'],
    ['8.8.8.8 spelled in hex', '0x8080808'],
    ['8.8.8.8 spelled as an octal dotted quad', '010.010.010.010'],
    ['a public address hidden behind userinfo', '192.168.1.1@8.8.8.8'],
    ['a public IPv6 literal', '2001:4860:4860::8888'],
    ['a port smuggled into the host field', '8.8.8.8:9000'],
  ];

  for (const [label, host] of OFF_LAN_HOSTS) {
    it(`refuses a Tally host given as ${label}`, async () => {
      await request(app).put('/api/integrations/TALLY').set(auth(tokens.owner))
        .send({ enabled: true, config: tallyConfig });
      const res = await request(app).put('/api/integrations/TALLY/credential').set(auth(tokens.owner))
        .send({ credential: { host, port: 9000 } });
      expect(res.status, `host ${host} was accepted: ${JSON.stringify(res.body)}`).toBe(400);
      // The message has to name the destination, or an operator who typed a
      // decimal integer has no way to learn it meant 8.8.8.8.
      expect(JSON.stringify(res.body).toLowerCase()).toMatch(/lan|network|host|ip|url/);
    });
  }

  // The positive controls. Without these the block above would pass just as well
  // against a field that refused every host, which would be a different bug.
  const ON_LAN_HOSTS = [
    ['a 192.168 address', '192.168.1.50'],
    ['a 10.x address', '10.0.0.5'],
    ['a 172.16-31 address', '172.20.3.4'],
    ['loopback', '127.0.0.1'],
    ['a bare LAN machine name', 'TALLYPC'],
    ['an .local name', 'tally.local'],
    // Octal and hex spellings of loopback and 192.168.1.50. Allowed on purpose:
    // the gate judges the address the parser produces, not the spelling, and
    // these addresses really are on the LAN.
    ['loopback in octal', '0177.0.0.1'],
    ['192.168.1.50 in hex', '0xc0.0xa8.1.50'],
  ];

  for (const [label, host] of ON_LAN_HOSTS) {
    it(`accepts a Tally host given as ${label}`, async () => {
      await request(app).put('/api/integrations/TALLY').set(auth(tokens.owner))
        .send({ enabled: true, config: tallyConfig });
      const res = await request(app).put('/api/integrations/TALLY/credential').set(auth(tokens.owner))
        .send({ credential: { host, port: 9000 } });
      expect(res.status, `host ${host} was refused: ${JSON.stringify(res.body)}`).toBe(200);
    });
  }
});

// --- Tally's destination, checked at call time --------------------------------

// The settings gate above answers a question about SPELLING, which is all a form
// has. It cannot answer the one that matters: `tallypc` is a perfectly good LAN
// name that a search domain or a poisoned resolver can point anywhere. Only
// resolution can tell, and it has to happen immediately before the call rather
// than when the host was saved.
//
// Every refusal here asserts that `fetch` was never reached. "Refused with a
// sensible message" is not the claim; "no bytes left this machine" is.
describe('Tally will not send to a destination it cannot confirm is on the LAN', () => {
  const resolvesTo = (addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const fails = (code) => async () => { const e = new Error('lookup failed'); e.code = code; throw e; };

  let tallyAdapter;
  let fetchSpy;

  beforeAll(async () => {
    ({ adapter: tallyAdapter } = await import('../src/lib/integrations/adapters/tally.js'));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  const expectNothingSent = async (host, resolver) => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host, port: 9000 },
        config: tallyConfig,
        resolver,
      }),
    ).rejects.toThrow();
    expect(fetchSpy, `a request was attempted to ${host}`).not.toHaveBeenCalled();
    return fetchSpy;
  };

  it('refuses a LAN-looking name that resolves to a public address', async () => {
    await expectNothingSent('tallypc', resolvesTo(['203.0.113.9']));
  });

  it('refuses a name that resolves to one private AND one public address', async () => {
    // Which of the two fetch would pick is not ours to choose, so one public
    // answer is enough to refuse the whole name.
    await expectNothingSent('tallypc', resolvesTo(['192.168.1.50', '203.0.113.9']));
  });

  it('refuses when the name cannot be resolved at all', async () => {
    // The uncomfortable direction, on purpose: a DNS outage stops Tally posting.
    // The alternative is sending an unauthenticated voucher write to an address
    // we could not verify, and the queue exists to hold work until a person looks.
    await expectNothingSent('tallypc', fails('ENOTFOUND'));
  });

  it('refuses when resolution succeeds but returns no address', async () => {
    await expectNothingSent('tallypc', async () => []);
  });

  it('refuses a public address dressed up as a decimal integer, at call time too', async () => {
    // Not just at the settings screen: a credential saved before this guard
    // existed still cannot reach the internet.
    const spy = await expectNothingSent('134744072', resolvesTo(['192.168.1.50']));
    expect(spy).not.toHaveBeenCalled();
  });

  it('names the address it refused, so the reason is actionable', async () => {
    await expect(
      tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: 'tallypc', port: 9000 },
        config: tallyConfig,
        resolver: resolvesTo(['203.0.113.9']),
      }),
    ).rejects.toThrow(/203\.0\.113\.9/);
  });

  it('classifies the refusal as TERMINAL so the queue stops instead of retrying', async () => {
    // A destination that is off-LAN will still be off-LAN in thirty seconds.
    // Retrying it eight times turns one clear refusal into eight identical ones.
    const err = await tallyAdapter
      .perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: '8.8.8.8', port: 9000 },
        config: tallyConfig,
      })
      .then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err.retryable).toBe(false);
    expect(err.providerRefused).toBe(true);
  });

  // THE POSITIVE CONTROL, and the reason this block is not just a list of
  // refusals: a real HTTP server on loopback, answering the way Tally answers.
  // If the gate refused everything, this would fail.
  it('does send to a host that resolves privately, proving the gate is not refusing everything', async () => {
    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(body);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const result = await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: '127.0.0.1', port },
        config: tallyConfig,
      });
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain('<TALLYMESSAGE');
      expect(result.detail.created).toBe(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reaches a LAN machine NAME once it resolves privately, and dials the verified address not the name', async () => {
    // Two claims in one test because they are the same mechanism. First, the
    // kind=name path passes traffic rather than merely passing validation.
    // Second — the security-relevant half — the request goes to the ADDRESS we
    // approved. Handing the NAME to fetch would make fetch resolve it a second
    // time, and a second answer can differ from the one just approved. The Host
    // header proves which of the two happened.
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.host);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const res = await tallyAdapter.checkConnection({
        credential: { host: 'tallypc', port },
        config: tallyConfig,
        resolver: resolvesTo(['127.0.0.1']),
      });
      expect(seen).toEqual([`127.0.0.1:${port}`]);
      expect(seen[0]).not.toContain('tallypc');
      // checkConnection looks for the company name in the answer; this stub does
      // not carry one, so ok:false is the honest result. The load-bearing
      // assertion is that the request happened, and where it went.
      expect(res.detail).toBeTruthy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reads a successful Tally import as success, not as a rejection', async () => {
    // A regression guard for a defect the positive control above uncovered: the
    // error-text matcher also matched <ERRORS>0</ERRORS>, the success COUNT, so
    // every voucher Tally accepted was reported as rejected. Exercised against a
    // response shaped the way Tally actually answers an import.
    const { parseImportResponse } = await import('../src/lib/integrations/adapters/tally.js');
    const success = parseImportResponse(
      '<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT>' +
        '<CREATED>1</CREATED><ALTERED>0</ALTERED><LASTVCHID>0</LASTVCHID>' +
        '<ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS>' +
        '</IMPORTRESULT></DATA></BODY></ENVELOPE>',
    );
    expect(success.errorText).toBeNull();
    expect(success.created).toBe(1);
    expect(success.ok).toBe(true);

    // And the negative control: a real import failure is still read as one, with
    // Tally's own wording preserved so the operator sees the actual reason.
    const failure = parseImportResponse(
      '<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>0</CREATED><ERRORS>1</ERRORS>' +
        '<LINEERROR>Ledger &apos;Sales - Dine In&apos; does not exist</LINEERROR>' +
        '</IMPORTRESULT></DATA></BODY></ENVELOPE>',
    );
    expect(failure.ok).toBe(false);
    expect(failure.errorText).toContain('does not exist');
  });

  it('does not consult DNS for an IP literal that is already on the LAN', async () => {
    // A literal address needs no name lookup, and a gate that asked anyway would
    // make Tally posting depend on DNS for no reason.
    let asked = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: '127.0.0.1', port },
        config: tallyConfig,
        resolver: async () => { asked = true; return []; },
      });
      expect(asked).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// A stand-in Tally, answering over real HTTP on loopback so the adapter's own
// request building, LAN gate and response parsing are all exercised. `reply`
// receives the request body and returns either XML to answer with, or null to
// destroy the socket — which is how the interesting failure is reproduced: Tally
// received and applied the import, and the answer never came back.
const fakeTally = async (reply) => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const isImport = body.includes('<TALLYREQUEST>Import</TALLYREQUEST>');
      requests.push({ isImport, isDayBook: body.includes('<ID>Day Book</ID>'), body });
      const answer = reply(body, requests);
      if (answer === null) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(answer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const IMPORT_OK = '<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT>' +
  '<CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS>' +
  '</IMPORTRESULT></DATA></BODY></ENVELOPE>';

const dayBookWith = (...vouchers) =>
  `<ENVELOPE><BODY><DATA><COLLECTION>${vouchers
    .map(({ number, masterId, type = 'Sales' }) =>
      `<VOUCHER REMOTEID="00000000-0000-0000-0000-000000000001-0000008a" VCHTYPE="${type}">` +
      `<DATE>20260925</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${number}</VOUCHERNUMBER>` +
      (masterId ? `<MASTERID>${masterId}</MASTERID>` : '') +
      '</VOUCHER>')
    .join('')}</COLLECTION></DATA></BODY></ENVELOPE>`;

describe('Tally recovers a voucher whose acknowledgement was lost, without sending it twice', () => {
  // The failure this block is about: Tally imports the sales voucher, and the
  // answer never arrives. The queue's default instinct — retry an UNKNOWN — puts
  // a SECOND sale in the client's books, because Tally publishes no
  // duplicate-detection for imports and our own unique index is on our own table.
  // Nothing about a local queue's dedupe key can prevent that.
  let tallyAdapter;
  beforeAll(async () => {
    ({ adapter: tallyAdapter } = await import('../src/lib/integrations/adapters/tally.js'));
  });

  it('asks Tally whether the voucher is there, and reports success without resending it', async () => {
    const payload = salesVoucherPayload();
    const tally = await fakeTally((body) =>
      body.includes('<TALLYREQUEST>Import</TALLYREQUEST>')
        // The import is applied and the answer is thrown away. From the client's
        // side this is indistinguishable from Tally never having seen it, which
        // is precisely why it must not be guessed at.
        ? null
        : dayBookWith({ number: payload.voucherNumber, masterId: '41337' }));
    try {
      const result = await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload,
        credential: { host: '127.0.0.1', port: tally.port },
        config: tallyConfig,
      });

      // Exactly one import. This is the assertion the whole mechanism exists for:
      // a second one here is a duplicate sale in a real client's books.
      expect(tally.requests.filter((r) => r.isImport)).toHaveLength(1);
      expect(tally.requests.filter((r) => r.isDayBook)).toHaveLength(1);

      expect(result.detail.ok).toBe(true);
      expect(result.detail.recoveredFromLostAcknowledgement).toBe(true);
      // Reported by the route it was actually established by, not as an ordinary
      // import acknowledgement — the two are different evidence.
      expect(result.detail.confirmedBy).toBe('Day Book export');
      expect(result.detail.originalError).toMatch(/did not answer/i);
      // Tally's own handle for the voucher, which an import response never gives.
      expect(result.externalRef).toBe('41337');
    } finally {
      await tally.close();
    }
  });

  it('refuses to resend when Tally does not list the voucher, and says why in words an operator can act on', async () => {
    const payload = salesVoucherPayload();
    const tally = await fakeTally((body) =>
      body.includes('<TALLYREQUEST>Import</TALLYREQUEST>')
        ? null
        // Someone else's voucher, so the export is a real answer that simply does
        // not contain ours.
        : dayBookWith({ number: 'SOMEBODY-ELSE-99', masterId: '90001' }));
    try {
      const err = await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload,
        credential: { host: '127.0.0.1', port: tally.port },
        config: tallyConfig,
      }).catch((e) => e);

      expect(tally.requests.filter((r) => r.isImport)).toHaveLength(1);
      // TERMINAL, so the queue stops. Not because we know the voucher is absent —
      // we do not — but because an export that omits a voucher is weaker evidence
      // than one that lists it, and the cost of being wrong is a duplicated sale.
      expect(err.retryable).toBe(false);
      expect(err.providerRefused).toBe(true);
      expect(err.message).toContain(payload.voucherNumber);
      expect(err.message).toMatch(/not been sent again/i);
      expect(err.message).toMatch(/not proof/i);
      expect(err.message).toMatch(/Retry/);
    } finally {
      await tally.close();
    }
  });

  it('keeps the plain automatic retry when the request never reached Tally at all', async () => {
    // The counterweight, and the reason this is not just "make every Tally blip a
    // manual job". A refused connection means Tally read no bytes, so nothing was
    // applied and there is nothing to look up: the queue should recover from a
    // back-office PC that was rebooting without anybody being told.
    const closed = await fakeTally(() => IMPORT_OK);
    const deadPort = closed.port;
    await closed.close();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const err = await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: '127.0.0.1', port: deadPort },
        config: tallyConfig,
      }).catch((e) => e);

      expect(err.code).toBe('ECONNREFUSED');
      expect(err.retryable).toBe(true);
      expect(err.providerRefused).toBe(false);
      // One attempt, and no Day Book lookup: asking would cost a round trip to
      // learn nothing, and would have failed the same way.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not look anything up when Tally answers normally', async () => {
    // The positive control. If the recovery path ran on every send, the tests
    // above would pass while the happy path did twice the work and the
    // acknowledgement being read would prove nothing.
    const tally = await fakeTally(() => IMPORT_OK);
    try {
      const result = await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: '127.0.0.1', port: tally.port },
        config: tallyConfig,
      });
      expect(result.detail.created).toBe(1);
      expect(result.detail.recoveredFromLostAcknowledgement).toBeUndefined();
      expect(tally.requests).toHaveLength(1);
      expect(tally.requests[0].isDayBook).toBe(false);
    } finally {
      await tally.close();
    }
  });

  it('does not look up a voucher Tally has explicitly rejected', async () => {
    // A rejection is an ANSWER. Nothing was applied, so there is nothing to
    // confirm, and Tally's own wording is what the operator needs to see.
    const tally = await fakeTally(() =>
      '<ENVELOPE><BODY><DATA><IMPORTRESULT><CREATED>0</CREATED><ERRORS>1</ERRORS>' +
      '<LINEERROR>Ledger &apos;Sales - Dine In&apos; does not exist</LINEERROR>' +
      '</IMPORTRESULT></DATA></BODY></ENVELOPE>');
    try {
      const err = await tallyAdapter.perform({
        kind: 'TALLY_SALES',
        payload: salesVoucherPayload(),
        credential: { host: '127.0.0.1', port: tally.port },
        config: tallyConfig,
      }).catch((e) => e);
      expect(err.message).toContain('does not exist');
      expect(tally.requests.filter((r) => r.isDayBook)).toHaveLength(0);
    } finally {
      await tally.close();
    }
  });

  it('reads a voucher number together with its own voucher, not a neighbour’s', async () => {
    const { findVoucherInExport } = await import('../src/lib/integrations/adapters/tally.js');
    const raw = dayBookWith(
      { number: 'INV-1', masterId: '111' },
      { number: 'INV-2', masterId: '222' },
      { number: 'INV-3', masterId: '333' },
    );
    // The reason the parser splits on voucher boundaries first. A flat regex over
    // the whole document finds INV-2 and then the FIRST master id in the file, and
    // would have written 111 against INV-2 — a wrong Tally handle is worse than no
    // handle, because a later amendment would target somebody else's voucher.
    expect(findVoucherInExport(raw, 'INV-2')).toMatchObject({ found: true, masterId: '222' });
    expect(findVoucherInExport(raw, 'INV-3')).toMatchObject({ found: true, masterId: '333' });

    // Absent, and not confused by a number that merely contains ours.
    expect(findVoucherInExport(raw, 'INV-9').found).toBe(false);
    expect(findVoucherInExport(dayBookWith({ number: 'INV-10' }), 'INV-1').found).toBe(false);
    expect(findVoucherInExport('', 'INV-1').found).toBe(false);
    expect(findVoucherInExport(raw, '').found).toBe(false);
  });
});

// --- inbound callbacks -------------------------------------------------------

const zomatoConnection = () =>
  prisma.integrationConnection.findUnique({
    where: { companyId_provider: { companyId: company.id, provider: 'ZOMATO' } },
  });

describe('callback authentication', () => {
  let connId;
  beforeAll(async () => {
    const conn = await zomatoConnection();
    connId = conn.id;
    const map = await request(app).put('/api/integrations/ZOMATO/outlets').set(auth(tokens.owner))
      .send({ outlets: [{ externalOutletId: 'outlet-1', externalOutletName: 'Zomato In One', branchId: branch.id }] });
    expect(map.status, JSON.stringify(map.body)).toBe(200);
  });

  it('accepts a delivery carrying the agreed header', async () => {
    const res = await deliver(connId, placement());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it('refuses a wrong header value, and says nothing about why', async () => {
    const res = await deliver(connId, placement(), { value: 'wrong-value' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('POS_INTEGRATION_CALLBACK_REFUSED');
    expect(res.body.error.message).toBe('Callback refused');
  });

  it('refuses a delivery with no auth header at all', async () => {
    const res = await deliver(connId, placement(), { header: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('POS_INTEGRATION_CALLBACK_REFUSED');
  });

  it('answers an unknown connection id identically, so a prober learns nothing', async () => {
    const unknown = await deliver('cl0000000000000000000000', placement());
    const wrongValue = await deliver(connId, placement(), { value: 'wrong-value' });
    // Byte-identical replies. A prober must not be able to tell "no such
    // connection" from "wrong token" from "wrong tenant".
    expect(unknown.status).toBe(wrongValue.status);
    expect(unknown.body).toEqual(wrongValue.body);
  });

  it('refuses a connection that has no credential stored', async () => {
    await request(app).put('/api/integrations/ZOMATO').set(auth(other.ownerToken))
      .send({ enabled: true, config: {} });
    const bare = await prisma.integrationConnection.findUnique({
      where: { companyId_provider: { companyId: other.company.id, provider: 'ZOMATO' } },
    });
    const res = await deliver(bare.id, placement());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('POS_INTEGRATION_CALLBACK_REFUSED');
  });

  it('refuses a disabled connection even with the right header', async () => {
    await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.owner))
      .send({ enabled: false, config: { orderActorUserId: serviceUserId, autoAccept: false } });
    const res = await deliver(connId, placement());
    expect(res.status).toBe(401);
    await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.owner))
      .send({ enabled: true, config: { orderActorUserId: serviceUserId, autoAccept: false } });
  });

  it('records a rejected delivery in the audit trail without storing the payload', async () => {
    const before = await prisma.posAuditLog.count({
      where: { companyId: company.id, action: 'INTEGRATION_CALLBACK_REJECTED' },
    });
    await deliver(connId, placement(), { value: 'wrong-value' });
    const after = await prisma.posAuditLog.count({
      where: { companyId: company.id, action: 'INTEGRATION_CALLBACK_REJECTED' },
    });
    expect(after).toBe(before + 1);
    // An unauthenticated delivery is never written to a table keyed on an id the
    // payload supplied — so there is no IntegrationEvent for it.
    const stored = await prisma.integrationEvent.count({
      where: { connectionId: connId, signatureValid: false },
    });
    expect(stored).toBe(0);
  });

  it('rejects a body that is not JSON, after authenticating it', async () => {
    const res = await deliver(connId, 'not json at all');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('POS_INTEGRATION_CALLBACK_UNPARSEABLE');
  });
});

describe('duplicate and out-of-order callbacks', () => {
  let connId;
  beforeAll(async () => {
    connId = (await zomatoConnection()).id;
  });

  it('makes one order and one kitchen ticket from a redelivered event id', async () => {
    const envelope = placement();
    const first = await deliver(connId, envelope);
    expect(first.status).toBe(200);
    expect(first.body.processed).toBe(true);

    const again = await deliver(connId, envelope);
    expect(again.status).toBe(200);
    // The single most important assertion in this file. At-least-once delivery
    // is the norm, and the second delivery must cost nothing.
    expect(again.body.duplicate).toBe(true);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: envelope.externalOrderId } },
    });
    expect(agg.orderId).toBeTruthy();
    const kots = await prisma.kot.count({ where: { orderId: agg.orderId } });
    expect(kots).toBe(1);
    const events = await prisma.integrationEvent.count({
      where: { connectionId: connId, externalEventId: envelope.externalEventId },
    });
    expect(events).toBe(1);
  });

  it('makes one order when the SAME placement arrives under a new event id', async () => {
    const envelope = placement();
    await deliver(connId, envelope);
    // A provider that redelivers with a fresh event id defeats the event-level
    // unique key. AggregatorOrder.orderId is the guard that still holds.
    const second = await deliver(connId, { ...envelope, externalEventId: nextEventId() });
    expect(second.status).toBe(200);
    expect(second.body.processed).toBe(true);

    const orders = await prisma.order.count({
      where: { companyId: company.id, externalOrderId: envelope.externalOrderId },
    });
    expect(orders).toBe(1);
    const agg = await prisma.aggregatorOrder.findMany({
      where: { connectionId: connId, externalOrderId: envelope.externalOrderId },
    });
    expect(agg).toHaveLength(1);
    const kots = await prisma.kot.count({ where: { orderId: agg[0].orderId } });
    expect(kots).toBe(1);
  });

  it('does not apply a state that arrives behind one already seen', async () => {
    const envelope = placement();
    await deliver(connId, envelope);
    const id = envelope.externalOrderId;

    // RECEIVED → ACCEPTED first: the FORWARD map is permissive about skipping
    // states but an order still has to be accepted before it can be ready.
    await deliver(connId, stateChange(id, 'ACCEPTED', { providerSequence: 2 }));
    const ready = await deliver(connId, stateChange(id, 'READY', { providerSequence: 9 }));
    expect(ready.body.processed).toBe(true);

    const late = await deliver(connId, stateChange(id, 'PREPARING', { providerSequence: 4 }));
    // Held, not applied, and 200 — the delivery was genuine and a redelivery
    // cannot change the outcome. The reason lives on the row.
    expect(late.status).toBe(200);
    expect(late.body.held).toBe(true);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    expect(agg.state).toBe('READY');
    const event = await prisma.integrationEvent.findFirst({
      where: { connectionId: connId, externalOrderId: id, status: 'SKIPPED' },
      orderBy: { receivedAt: 'desc' },
    });
    // Checked by its REASON. A guard that fires for the wrong cause is a guard
    // that will pass while the system is broken.
    expect(event.skipReason).toMatch(/older than/i);
  });

  it('refuses to move an order out of a terminal state', async () => {
    const envelope = placement();
    await deliver(connId, envelope);
    const id = envelope.externalOrderId;

    const cancelled = await deliver(connId, stateChange(id, 'CANCELLED', {
      providerSequence: 5, cancelReason: 'customer changed their mind',
    }));
    expect(cancelled.body.processed).toBe(true);

    const revived = await deliver(connId, stateChange(id, 'PREPARING', { providerSequence: 6 }));
    expect(revived.body.held).toBe(true);
    const event = await prisma.integrationEvent.findFirst({
      where: { connectionId: connId, externalOrderId: id, status: 'SKIPPED' },
      orderBy: { receivedAt: 'desc' },
    });
    expect(event.skipReason).toMatch(/not a permitted transition/i);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    expect(agg.state).toBe('CANCELLED');
    expect(agg.cancelReason).toBe('customer changed their mind');
  });

  // --- a state change that overtakes its own placement -------------------------
  //
  // Everything above this line is about ONE event arriving twice, and a unique
  // index settles it. These are about TWO DIFFERENT events arriving in the wrong
  // order, which no uniqueness constraint can see: both are genuine, both are
  // new, and the damage is done by acting on the second as though the first had
  // never happened. Uniqueness on the event id proves neither of the next four
  // things.

  it('records a cancellation that arrives before the order it cancels', async () => {
    const id = `zo-early-cancel-${++evtSeq}`;
    const res = await deliver(connId, stateChange(id, 'CANCELLED', {
      providerSequence: 4, cancelReason: 'customer cancelled before we heard of the order',
    }));
    expect(res.status).toBe(200);
    // Processed, not held. Holding is the honest description of the ordering but
    // the wrong outcome: it leaves a real cancellation depending on a retry the
    // provider has no reason to send.
    expect(res.body.processed).toBe(true);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    expect(agg).toBeTruthy();
    expect(agg.state).toBe('CANCELLED');
    expect(agg.cancelReason).toBe('customer cancelled before we heard of the order');
    // The point of the column. This row records a state, not an order anybody
    // has sent us, and placedAt stays null because the provider never said when
    // the order was placed — inventing a time would put a fiction on the one row
    // that exists to say we have not seen it.
    expect(agg.placementReceivedAt).toBeNull();
    expect(agg.placedAt).toBeNull();
    expect(agg.orderId).toBeNull();
    expect(await prisma.order.count({ where: { companyId: company.id, externalOrderId: id } })).toBe(0);
  });

  it('sends nothing to the kitchen when the placement arrives after the provider cancelled it', async () => {
    const id = `zo-late-place-${++evtSeq}`;
    const early = await deliver(connId, stateChange(id, 'CANCELLED', {
      providerSequence: 4, cancelReason: 'rider never assigned',
    }));
    expect(early.body.processed).toBe(true);

    const late = await deliver(connId, placement({ externalOrderId: id, providerSequence: 1 }));
    expect(late.status).toBe(200);
    // 200 and processed. The delivery was genuine and there is nothing left to
    // do with it, so answering anything else buys an endless redelivery of an
    // order that must never be cooked.
    expect(late.body.processed).toBe(true);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    // The cancellation stands, and the placement filled in the details it
    // carried so there is something for a person to look at.
    expect(agg.state).toBe('CANCELLED');
    expect(agg.cancelReason).toBe('rider never assigned');
    expect(agg.placementReceivedAt).toBeTruthy();
    expect(agg.placedAt).toBeTruthy();
    expect(String(agg.grossAmount)).toBe('400');

    // The three things this whole mechanism exists to prevent.
    expect(agg.orderId).toBeNull();
    expect(await prisma.order.count({ where: { companyId: company.id, externalOrderId: id } })).toBe(0);
    expect(await prisma.kot.count({ where: { order: { externalOrderId: id } } })).toBe(0);

    const rows = await request(app).get('/api/integrations/ZOMATO/discrepancies?state=OPEN')
      .set(auth(tokens.owner));
    const d = rows.body.discrepancies.find((x) => x.externalRef === id && x.kind === 'TERMINAL_BEFORE_PLACEMENT');
    // Checked by its CAUSE, not merely by its existence: this row is the only
    // place the operator learns that the platform and the restaurant disagree
    // about an order that was never made.
    expect(d).toBeTruthy();
    expect(d.detail.state).toBe('CANCELLED');
    expect(d.detail.note).toMatch(/No POS order, kitchen ticket or stock movement was created/);
  });

  it('still makes the order when the state that arrived first was not terminal', async () => {
    // The positive control for the two tests above, and the reason they are not
    // just proving that we drop late placements. The gate is on TERMINAL states.
    // An ACCEPTED that overtook its own placement is an order the restaurant is
    // expected to cook, and it must end with exactly one kitchen ticket.
    const id = `zo-early-accept-${++evtSeq}`;
    const early = await deliver(connId, stateChange(id, 'ACCEPTED', { providerSequence: 4 }));
    expect(early.body.processed).toBe(true);
    const shell = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    expect(shell.placementReceivedAt).toBeNull();
    expect(shell.orderId).toBeNull();

    const late = await deliver(connId, placement({ externalOrderId: id, providerSequence: 1 }));
    expect(late.body.processed).toBe(true);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    expect(agg.orderId).toBeTruthy();
    expect(agg.placementReceivedAt).toBeTruthy();
    // Not rewound to RECEIVED. The placement is older news than the acceptance,
    // and materialising must not undo a state the provider has already reported.
    expect(agg.state).toBe('ACCEPTED');
    expect(await prisma.kot.count({ where: { orderId: agg.orderId } })).toBe(1);
    expect(await prisma.order.count({ where: { companyId: company.id, externalOrderId: id } })).toBe(1);

    // And the order carries on from there rather than being stuck: the next
    // state change lands on a materialised row.
    const ready = await deliver(connId, stateChange(id, 'READY', { providerSequence: 5 }));
    expect(ready.body.processed).toBe(true);
    const done = await prisma.aggregatorOrder.findUnique({ where: { id: agg.id } });
    expect(done.state).toBe('READY');
    expect(done.orderId).toBe(agg.orderId);
  });

  it('does not let a slower event overwrite a state the order has already moved past', async () => {
    // applyState reads the row, decides the transition is permitted, then writes.
    // Between the decision and the write another process can move the row, and
    // the decision was made against a state that no longer exists. Ordering
    // metadata does not help here — both events are in order relative to the
    // snapshot each one read. The compare-and-set in the UPDATE is what settles
    // it, and this is the only way to make both decisions race.
    const envelope = placement();
    await deliver(connId, envelope);
    const id = envelope.externalOrderId;
    const snapshot = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: id } },
    });
    expect(snapshot.state).toBe('RECEIVED');

    const at = new Date();
    const first = await applyState(prisma, {
      aggOrder: snapshot,
      state: 'ACCEPTED',
      envelope: { providerSequence: 2, providerEventAt: at },
    });
    const second = await applyState(prisma, {
      aggOrder: snapshot,
      state: 'CANCELLED',
      envelope: { providerSequence: 3, providerEventAt: at, cancelReason: 'lost the race' },
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    // By its reason. A refusal for the wrong cause — a stale sequence, a
    // forbidden transition — would pass this assertion while the compare-and-set
    // was missing entirely.
    expect(second.reason).toMatch(/moved out of RECEIVED while this event was being applied/);

    const after = await prisma.aggregatorOrder.findUnique({ where: { id: snapshot.id } });
    expect(after.state).toBe('ACCEPTED');
    expect(after.cancelReason).toBeNull();
    expect(after.cancelledAt).toBeNull();
  });

  it('records a discrepancy when an order is cancelled after it reached the kitchen', async () => {
    const envelope = placement();
    await deliver(connId, envelope);
    const id = envelope.externalOrderId;
    await deliver(connId, stateChange(id, 'CANCELLED', { providerSequence: 7, cancelReason: 'rider unavailable' }));

    const rows = await request(app).get('/api/integrations/ZOMATO/discrepancies?state=OPEN')
      .set(auth(tokens.owner));
    expect(rows.status).toBe(200);
    const d = rows.body.discrepancies.find((x) => x.externalRef === id && x.kind === 'CANCELLED_AFTER_MATERIALISE');
    // Food may already have been made. This is the one cancellation that costs
    // money, so it is a row a person has to close, not a log line.
    expect(d).toBeTruthy();
    expect(d.orderId).toBeTruthy();
  });

  it('holds an order for an outlet nobody has mapped, and names the outlet', async () => {
    const envelope = placement({ externalOutletId: 'outlet-unmapped' });
    const res = await deliver(connId, envelope);
    expect(res.status).toBe(200);
    expect(res.body.held).toBe(true);

    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: envelope.externalOrderId } },
    });
    // A row exists even though nothing could be done with it: the operator's
    // first symptom of a mapping mistake should be a visible held order, not a
    // customer ringing to ask where their food is.
    expect(agg).toBeTruthy();
    expect(agg.orderId).toBeNull();
    expect(agg.branchId).toBeNull();
    const event = await prisma.integrationEvent.findFirst({
      where: { connectionId: connId, externalEventId: envelope.externalEventId },
    });
    expect(event.skipReason).toMatch(/outlet-unmapped/);
    expect(event.skipReason).toMatch(/not mapped to a store/i);
  });

  it('holds an order whose items are not in the catalogue', async () => {
    const envelope = placement({
      items: [{ externalItemId: 'no-such-product', name: 'Mystery Bowl', quantity: 1, unitPrice: 100, total: 100 }],
    });
    const res = await deliver(connId, envelope);
    expect(res.body.held).toBe(true);
    const event = await prisma.integrationEvent.findFirst({
      where: { connectionId: connId, externalEventId: envelope.externalEventId },
    });
    expect(event.skipReason).toMatch(/Mystery Bowl/);
    expect(event.skipReason).toMatch(/not in the catalogue/i);
    // A wrong kitchen ticket costs more than a late one, so nothing was made.
    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: envelope.externalOrderId } },
    });
    expect(agg.orderId).toBeNull();
  });

  it('holds an order whose totals could not be read, rather than billing a guess', async () => {
    const envelope = placement({
      money: { grossAmount: null, taxAmount: null },
      unreadable: ['grossAmount', 'taxAmount'],
    });
    const res = await deliver(connId, envelope);
    expect(res.body.held).toBe(true);
    const event = await prisma.integrationEvent.findFirst({
      where: { connectionId: connId, externalEventId: envelope.externalEventId },
    });
    expect(event.skipReason).toMatch(/totals could not be read/i);
    expect(event.skipReason).toMatch(/grossAmount/);
  });

  it('records a mismatch between the provider’s gross and our own total, altering neither', async () => {
    // Our total for these lines is ₹400. Claiming ₹500 is the platform and the
    // POS disagreeing, which somebody has to adjudicate.
    const envelope = placement({ money: { ...placement().money, grossAmount: 500 }, unreadable: [] });
    await deliver(connId, envelope);
    const agg = await prisma.aggregatorOrder.findUnique({
      where: { connectionId_externalOrderId: { connectionId: connId, externalOrderId: envelope.externalOrderId } },
      include: { order: true },
    });
    expect(agg.orderId).toBeTruthy();
    expect(String(agg.grossAmount)).toBe('500');
    // Ours is untouched. Two columns disagreeing is information; one column
    // reconciled into agreement is a lost defect.
    expect(String(agg.order.total)).toBe('400');
    const d = await prisma.integrationDiscrepancy.findFirst({
      where: { connectionId: connId, externalRef: envelope.externalOrderId, kind: 'ORDER_TOTAL_MISMATCH' },
    });
    expect(d).toBeTruthy();
    expect(String(d.expectedAmount)).toBe('500');
    expect(String(d.observedAmount)).toBe('400');
  });

  it('is the second tenant’s connection that a callback names, never ours', async () => {
    // The neighbour's ZOMATO connection exists but holds no credential, so a
    // payload that names it is refused. What this proves is that the connection
    // id in the URL is what scopes the write — a caller cannot reach our tenant
    // by pointing a valid-looking order at someone else's connection.
    const neighbour = await prisma.integrationConnection.findUnique({
      where: { companyId_provider: { companyId: other.company.id, provider: 'ZOMATO' } },
    });
    const envelope = placement();
    const res = await deliver(neighbour.id, envelope);
    expect(res.status).toBe(401);
    const leaked = await prisma.aggregatorOrder.count({
      where: { externalOrderId: envelope.externalOrderId },
    });
    expect(leaked).toBe(0);
  });

  it('records no discrepancy when the platform’s gross and our total agree', async () => {
    // The positive control for the assertion above: if a mismatch were recorded
    // for every order, the test before this one would pass while proving nothing.
    const envelope = placement();
    await deliver(connId, envelope);
    const d = await prisma.integrationDiscrepancy.count({
      where: { connectionId: connId, externalRef: envelope.externalOrderId, kind: 'ORDER_TOTAL_MISMATCH' },
    });
    expect(d).toBe(0);
  });
});

// --- the outbound queue ------------------------------------------------------

describe('retries after an outage', () => {
  let connId;

  beforeAll(async () => {
    connId = (await zomatoConnection()).id;
    // Auto-accept is off by default and every block above depends on that. It is
    // switched on here because an outbound call is what this block tests, and
    // confirming an order back to Zomato is the only outbound aggregator call a
    // callback produces on its own.
    const put = await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.owner))
      .send({ enabled: true, config: { orderActorUserId: serviceUserId, autoAccept: true } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    // Work the blocks above left due would be claimed by the passes below, and
    // failNextWith() is one-shot — it would land on whichever job a pass reached
    // first and every assertion here would be about the wrong row. Parked, not
    // deleted: those rows are other cases' evidence.
    await prisma.integrationJob.updateMany({
      where: { companyId: company.id, status: 'PENDING' },
      data: { nextAttemptAt: PARKED },
    });
  });

  afterAll(async () => {
    const put = await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.owner))
      .send({ enabled: true, config: { orderActorUserId: serviceUserId, autoAccept: false } });
    expect(put.status).toBe(200);
  });

  // Found by its dedupe key, never by "the newest row": a stray job from another
  // case must not be able to make one of these pass.
  const confirmJob = (externalOrderId) =>
    prisma.integrationJob.findUnique({
      where: {
        connectionId_dedupeKey: {
          connectionId: connId,
          dedupeKey: `ZOMATO_ORDER_CONFIRM:confirm:${externalOrderId}`,
        },
      },
    });

  // Time passing, expressed as the only thing claim() actually reads: a
  // nextAttemptAt now in the past. Faking the clock instead would also move the
  // timestamps these assertions measure against.
  const becomeDue = (jobId) =>
    prisma.integrationJob.update({ where: { id: jobId }, data: { nextAttemptAt: new Date() } });

  const attemptFailing = async (jobId, kind, message) => {
    await becomeDue(jobId);
    testControl.failNextWith(kind, message);
    const [outcome] = await runOnce({ companyId: company.id, max: 1 });
    return outcome;
  };

  const place = async () => {
    const envelope = placement();
    const res = await deliver(connId, envelope);
    expect(res.body.processed, JSON.stringify(res.body)).toBe(true);
    return envelope;
  };

  it('queues one confirmation per order however many times the callback arrives', async () => {
    const envelope = await place();
    // A fresh event id defeats the event-level unique key, so what is left is the
    // queue's own dedupe — which is the thing under test here.
    await deliver(connId, { ...envelope, externalEventId: nextEventId() });
    const jobs = await prisma.integrationJob.findMany({
      where: { connectionId: connId, dedupeKey: { contains: envelope.externalOrderId } },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('ZOMATO_ORDER_CONFIRM');
    // Untouched by the second delivery: an existing job keeps its own schedule,
    // because "we already intend to do this" is the whole answer.
    expect(jobs[0].attempts).toBe(0);
    await prisma.integrationJob.update({ where: { id: jobs[0].id }, data: { nextAttemptAt: PARKED } });
  });

  it('retries a timeout on the published backoff schedule instead of hot-looping', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);
    expect(job).toBeTruthy();

    // 30s, then 60s, then 120s — the first three rungs of BACKOFF_MS. Asserted
    // as a floor plus a generous ceiling because the delay is measured from when
    // fail() ran inside the pass, not from this line.
    for (const [i, delay] of [30_000, 60_000, 120_000].entries()) {
      const before = Date.now();
      const outcome = await attemptFailing(job.id, 'RETRYABLE', 'connect ETIMEDOUT');
      expect(outcome.outcome).toBe('RETRY');

      const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(i + 1);
      // Released on the way out. A lock left set by a worker that died is how a
      // queue looks healthy while one voucher never posts.
      expect(row.lockedAt).toBeNull();
      expect(row.lockedBy).toBeNull();
      expect(row.lastError).toMatch(/ETIMEDOUT/);

      const waited = row.nextAttemptAt.getTime() - before;
      expect(waited).toBeGreaterThanOrEqual(delay);
      expect(waited).toBeLessThan(delay + 10_000);
    }
    // Nothing in the operator's discrepancy list yet. Work that is still in hand
    // is not work for a person, and this is the control for the case below.
    const noise = await prisma.integrationDiscrepancy.count({
      where: { connectionId: connId, kind: 'STATUS_PUSH_FAILED', externalRef: envelope.externalOrderId },
    });
    expect(noise).toBe(0);
    await prisma.integrationJob.update({ where: { id: job.id }, data: { nextAttemptAt: PARKED } });
  });

  it('gives up at the attempt limit and leaves a row saying the provider was never told', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);

    let outcome;
    for (let i = 0; i < job.maxAttempts; i += 1) {
      outcome = await attemptFailing(job.id, 'RETRYABLE', 'connect ETIMEDOUT');
    }
    expect(outcome.outcome).toBe('DEAD');

    const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(job.maxAttempts);

    // DEAD is a queue a person reads, not a bin. Zomato still believes this
    // order was never confirmed, and that is a dispute somebody settles by hand.
    const rows = await prisma.integrationDiscrepancy.findMany({
      where: { connectionId: connId, kind: 'STATUS_PUSH_FAILED', externalRef: envelope.externalOrderId },
    });
    // ONE row, from the attempt that gave up — not one per failed attempt. Eight
    // rows telling an operator to go and fix something the queue was still
    // retrying is how the row that mattered gets scrolled past.
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('OPEN');
    expect(rows[0].detail.note).toMatch(/never told/i);
    expect(rows[0].detail.attempts).toBe(job.maxAttempts);
  });

  it('does not retry a refusal, because retrying a “no” is only noise', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);
    const outcome = await attemptFailing(job.id, 'TERMINAL', 'that order is already closed');
    expect(outcome.outcome).toBe('DEAD');

    const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    expect(row.status).toBe('DEAD');
    // One attempt, not eight. A provider that answered "no" will answer "no"
    // again, and seven more calls only delay the operator finding out.
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/already closed/);
  });

  it('dies on the first attempt when the integration is switched off, and says so in words', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);
    await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.owner))
      .send({ enabled: false, config: { orderActorUserId: serviceUserId, autoAccept: true } });

    await becomeDue(job.id);
    const [outcome] = await runOnce({ companyId: company.id, max: 1 });
    expect(outcome.outcome).toBe('DEAD');

    const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    // No provider was contacted, so no amount of waiting fixes it. The message
    // is the point: it names the thing the operator has to change.
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/switched off/i);
    expect(testControl.calls()).toHaveLength(0);

    await request(app).put('/api/integrations/ZOMATO').set(auth(tokens.owner))
      .send({ enabled: true, config: { orderActorUserId: serviceUserId, autoAccept: true } });
  });

  it('lets an operator retry a dead job and keeps the attempt history that says it failed', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);
    await attemptFailing(job.id, 'TERMINAL', 'gateway said no');

    const res = await request(app).post(`/api/integrations/ZOMATO/jobs/${job.id}/retry`)
      .set(auth(tokens.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.retried).toBe(true);

    const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    // Delivered inline, so the operator sees the outcome of the button they
    // pressed rather than a toast and a screen to refresh.
    expect(row.status).toBe('SUCCEEDED');
    expect(row.externalRef).toBeTruthy();
    // Cleared on success: the error queue must show only what is still wrong.
    expect(row.lastError).toBeNull();
    // Two, not one. The attempt count is evidence — an operator who retries the
    // same broken voucher twenty times should be able to see that they did.
    expect(row.attempts).toBe(2);
    expect(row.maxAttempts).toBe(job.maxAttempts + 7);

    const log = await prisma.posAuditLog.findFirst({
      where: { companyId: company.id, action: 'INTEGRATION_JOB_RETRY', entityId: job.id },
    });
    expect(log).toBeTruthy();
    expect(log.actorEmail).toBe('owner.i@test.local');
  });

  it('is the branch manager who may retry and the cashier who may not', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);
    await attemptFailing(job.id, 'TERMINAL', 'gateway said no');

    const denied = await request(app).post(`/api/integrations/ZOMATO/jobs/${job.id}/retry`)
      .set(auth(tokens.cashier));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('POS_FORBIDDEN');
    const still = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    expect(still.status).toBe('DEAD');

    // The positive control. Without it a 403 could be the route being missing,
    // and this case would pass with the permission check deleted.
    const allowed = await request(app).post(`/api/integrations/ZOMATO/jobs/${job.id}/retry`)
      .set(auth(tokens.manager));
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it('refuses to retry another company’s job, and says only “not found”', async () => {
    const envelope = await place();
    const job = await confirmJob(envelope.externalOrderId);

    const res = await request(app).post(`/api/integrations/ZOMATO/jobs/${job.id}/retry`)
      .set(auth(other.ownerToken));
    // Not 403. A neighbour asking about a job id must not learn that it exists.
    expect(res.status).toBe(404);

    const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    // A cross-tenant call must not even reset a schedule.
    expect(row.attempts).toBe(0);
    expect(row.status).toBe('PENDING');
    await prisma.integrationJob.update({ where: { id: job.id }, data: { nextAttemptAt: PARKED } });
  });

  it('shows the operator what is stuck, counting due work apart from waiting work', async () => {
    const res = await request(app).get('/api/integrations/ZOMATO/jobs').set(auth(tokens.owner));
    expect(res.status).toBe(200);
    // "14 jobs pending" reads as a problem when it is a normal backoff and as
    // normal when it is a queue that has stopped. The two are counted apart so
    // the screen can say which it is.
    expect(res.body.summary.dead).toBeGreaterThan(0);
    expect(res.body.summary.due).toBeLessThanOrEqual(res.body.summary.pending);
    const dead = res.body.jobs.filter((j) => j.status === 'DEAD');
    expect(dead.length).toBe(res.body.summary.dead);
    // Every dead job carries the reason it died, in text an operator can act on.
    for (const j of dead) expect(j.lastError).toBeTruthy();
    // And no job carries a credential, however the provider phrased its error.
    expect(JSON.stringify(res.body)).not.toContain(zomatoCredential.apiKey);
  });
});

// --- loyalty -----------------------------------------------------------------
//
// The block that matters most commercially. The client has roughly 100,000
// customers already in their Reelo account, with real points, and the condition
// of this work is that none of them is disturbed. So what is asserted here is
// mostly what does NOT happen: no balance computed by us, no profile created by
// us, no second credit for one bill, no points spent while the owner has the
// switch off, and "we do not know" never rendered as zero.

describe('loyalty at the till', () => {
  let connId;

  beforeAll(async () => {
    connId = (await prisma.integrationConnection.findUnique({
      where: { companyId_provider: { companyId: company.id, provider: 'REELO' } },
    })).id;
  });

  const billSyncJob = (orderId) =>
    prisma.integrationJob.findUnique({
      where: { connectionId_dedupeKey: { connectionId: connId, dedupeKey: `REELO_BILL_SYNC:${orderId}` } },
    });

  const lookup = (phone, token = tokens.cashier) =>
    request(app).post('/api/loyalty/lookup').set(auth(token)).send({ phone });

  const attach = (orderId, phone, name, token = tokens.cashier) =>
    request(app).post(`/api/loyalty/orders/${orderId}/customer`).set(auth(token)).send({ phone, name });

  const callsOf = (op) => testControl.calls().filter((c) => c.op === op);

  it('reads a number the provider has never seen as unknown, and never as zero', async () => {
    const res = await lookup('9000000001');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.known).toBe(false);
    // The single most important assertion in this block. A cashier told "0 points"
    // will say "you have no points"; told nothing, they will say "let me check".
    // Only one of those is true of a customer the provider has never heard of.
    expect(res.body.balance.points).toBeNull();
    expect(res.body.balance.source).toBe('UNKNOWN');
    // Nothing was created by asking. A lookup that enrolled people would grow the
    // client's customer base by one every time a wrong number was typed.
    const created = await prisma.customer.count({ where: { companyId: company.id, phone: '9000000001' } });
    expect(created).toBe(0);
  });

  it('refuses a number that is not a recognisable Indian mobile, before a bill can invent a person', async () => {
    const res = await lookup('12345');
    expect(res.status).toBe(400);
    // Reelo creates a customer implicitly on bill sync, so an unconfident number
    // does not produce a correctable error later — it produces a person who does
    // not exist, holding points nobody can claim.
    expect(res.body.error.message).toMatch(/recognisable Indian mobile/i);
    expect(testControl.calls()).toHaveLength(0);
  });

  it('shows the provider’s own figure, and falls back to a labelled cache when the provider is down', async () => {
    const phone = '9000000002';
    const order = await openOrder();
    testControl.setBalance(phone, 1500);
    expect((await attach(order.id, phone, 'Anita Rao')).status).toBe(200);

    const live = await lookup(phone);
    expect(live.body.known).toBe(true);
    expect(live.body.balance.points).toBe(1500);
    expect(live.body.balance.live).toBe(true);
    expect(live.body.balance.source).toBe('PROVIDER');

    testControl.failNextWith('RETRYABLE', 'reelo timed out');
    const cached = await lookup(phone);
    // A provider outage must not stop a sale, so the till still gets a number —
    // but it is labelled as a cache and it carries its own age, because a balance
    // with no timestamp invites a cashier to promise points that expired.
    expect(cached.status).toBe(200);
    expect(cached.body.balance.points).toBe(1500);
    expect(cached.body.balance.live).toBe(false);
    expect(cached.body.balance.source).toBe('CACHE');
    expect(cached.body.balance.asOf).toBeTruthy();
    expect(cached.body.providerError).toMatch(/timed out/i);
  });

  it('makes one customer and one instruction however many times a number is attached', async () => {
    const phone = '9000000003';
    const order = await openOrder();
    expect((await attach(order.id, phone, 'Ravi')).status).toBe(200);
    // The correction a cashier makes after mistyping a digit, and the double-tap
    // that follows it. Neither may produce a second Ravi.
    expect((await attach(order.id, phone, 'Ravi Kumar')).status).toBe(200);

    const customers = await prisma.customer.findMany({ where: { companyId: company.id, phone } });
    expect(customers).toHaveLength(1);
    // The name the cashier first entered is kept. The provider's copy is not more
    // authoritative about a person's name than the person who just asked them.
    expect(customers[0].name).toBe('Ravi');
    const ops = await prisma.loyaltyOperation.findMany({
      where: { connectionId: connId, orderId: order.id, kind: 'BILL_SYNC' },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe('PENDING');
  });

  it('credits an attached bill exactly once, however many times the bill is reported', async () => {
    const phone = '9000000004';
    testControl.setBalance(phone, 100);
    const order = await openOrder();
    expect((await attach(order.id, phone, 'Sunil')).status).toBe(200);
    await billOrder(order.id);

    // Reported a second time, which is what a retried request or a replayed hook
    // looks like from here. The upsert on (connection, dedupeKey) is what holds.
    await onOrderBilled(order.id);
    const jobs = await prisma.integrationJob.findMany({
      where: { connectionId: connId, kind: 'REELO_BILL_SYNC', dedupeKey: { contains: order.id } },
    });
    expect(jobs).toHaveLength(1);

    const outcome = await runOnlyJob(jobs[0].id);
    expect(outcome.outcome).toBe('SUCCEEDED');
    expect(callsOf('syncBill')).toHaveLength(1);

    const op = await prisma.loyaltyOperation.findUnique({
      where: { connectionId_idempotencyKey: { connectionId: connId, idempotencyKey: `bill:${order.id}` } },
    });
    expect(op.status).toBe('CONFIRMED');
    expect(op.externalRef).toBeTruthy();
    expect(op.confirmedAt).toBeTruthy();

    // ₹400 at the double's 1-point-per-₹100 rule is 4 points on top of 100. The
    // figure is the double's, not ours — what is being proved is that it moved
    // once. A lane that computed this number itself would be the defect.
    const after = await lookup(phone);
    expect(after.body.balance.points).toBe(104);

    // And again. A third report, a full pass, and the balance must not budge.
    await onOrderBilled(order.id);
    await runOnce({ companyId: company.id });
    expect(callsOf('syncBill')).toHaveLength(1);
    const still = await lookup(phone);
    expect(still.body.balance.points).toBe(104);
  });

  it('never sends a bill for a customer whose stored number is unusable', async () => {
    // This row shape is reachable: the import machinery creates Customer rows from
    // a Reelo-provided export, and an export can carry a landline or a truncated
    // number. Built directly because the till route refuses such a number at the
    // door, and the guard being tested is the one behind it.
    const order = await openOrder();
    const customer = await prisma.customer.create({
      data: { companyId: company.id, phone: '12345', name: 'Bad Number' },
    });
    await prisma.loyaltyOperation.create({
      data: {
        companyId: company.id, connectionId: connId, customerId: customer.id, orderId: order.id,
        kind: 'BILL_SYNC', idempotencyKey: `bill:${order.id}`,
      },
    });
    await billOrder(order.id);

    expect(await billSyncJob(order.id)).toBeNull();
    expect(callsOf('syncBill')).toHaveLength(0);
  });

  it('will not spend a customer’s points while the owner has redemption switched off', async () => {
    const phone = '9000000005';
    testControl.setBalance(phone, 800);
    const order = await openOrder();
    const off = await request(app).put('/api/integrations/REELO').set(auth(tokens.owner))
      .send({ enabled: true, config: { redemptionEnabled: false } });
    expect(off.status, JSON.stringify(off.body)).toBe(200);

    const otp = await request(app).post('/api/loyalty/otp').set(auth(tokens.cashier)).send({ phone });
    // The OTP request is refused too. Asking Reelo to text a customer a code we
    // are not going to honour is a message sent for nothing.
    expect(otp.status).toBe(409);
    expect(otp.body.error.message).toMatch(/switched off/i);

    const res = await request(app).post(`/api/loyalty/orders/${order.id}/redeem`).set(auth(tokens.cashier))
      .send({ phone, otp: '123456', points: 200 });
    expect(res.status).toBe(409);
    // Nothing was written and nobody was called: the switch is a refusal, not a
    // label on an attempt that happens anyway.
    expect(await prisma.loyaltyOperation.count({ where: { orderId: order.id, kind: 'REDEEM' } })).toBe(0);
    expect(testControl.calls()).toHaveLength(0);

    const on = await request(app).put('/api/integrations/REELO').set(auth(tokens.owner))
      .send({ enabled: true, config: { redemptionEnabled: true } });
    expect(on.status).toBe(200);
    // The positive control. With the switch back on the same call succeeds, so the
    // 409 above was the flag and not a broken route.
    const allowed = await request(app).post(`/api/loyalty/orders/${order.id}/redeem`).set(auth(tokens.cashier))
      .send({ phone, otp: '123456', points: 200 });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it('spends points once when the till double-fires the same redemption', async () => {
    const phone = '9000000006';
    testControl.setBalance(phone, 500);
    const order = await openOrder();

    const body = { phone, otp: '123456', points: 200 };
    const first = await request(app).post(`/api/loyalty/orders/${order.id}/redeem`)
      .set(auth(tokens.cashier)).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.redeemed).toBe(true);
    expect(first.body.duplicate).toBe(false);

    const again = await request(app).post(`/api/loyalty/orders/${order.id}/redeem`)
      .set(auth(tokens.cashier)).send(body);
    expect(again.status).toBe(200);
    // The unique index collision IS the duplicate detection, and the honest answer
    // to the second press is "that already happened", not a second deduction.
    expect(again.body.duplicate).toBe(true);
    expect(again.body.redeemed).toBe(true);

    expect(callsOf('redeem')).toHaveLength(1);
    const ops = await prisma.loyaltyOperation.findMany({
      where: { connectionId: connId, orderId: order.id, kind: 'REDEEM' },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe('CONFIRMED');
    expect(ops[0].pointsDelta).toBe(-200);
    const after = await lookup(phone);
    expect(after.body.balance.points).toBe(300);
  });

  it('leaves an unanswered redemption pending, and never retries it on its own', async () => {
    const phone = '9000000007';
    testControl.setBalance(phone, 500);
    const order = await openOrder();
    testControl.failNextWith('UNKNOWN', 'socket hang up');

    const res = await request(app).post(`/api/loyalty/orders/${order.id}/redeem`).set(auth(tokens.cashier))
      .send({ phone, otp: '123456', points: 200 });
    // 502, not 409. The two need different things from the cashier: try again with
    // a fresh code, versus stop and check the balance before touching it again.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('POS_LOYALTY_REDEEM_UNKNOWN');
    expect(res.body.error.message).toMatch(/may or may not/i);

    const op = await prisma.loyaltyOperation.findFirst({
      where: { connectionId: connId, orderId: order.id, kind: 'REDEEM' },
    });
    // PENDING, not FAILED. The points may or may not be gone and only a human
    // comparing this against the customer's balance can say which.
    expect(op.status).toBe('PENDING');
    expect(op.lastError).toMatch(/hang up/);
    // And nothing queued: an automatic retry here is a discount given twice.
    const queued = await prisma.integrationJob.count({
      where: { connectionId: connId, dedupeKey: { contains: 'redeem' } },
    });
    expect(queued).toBe(0);
  });

  it('records a refused redemption as failed, carrying the provider’s own reason', async () => {
    const phone = '9000000008';
    testControl.setBalance(phone, 500);
    const order = await openOrder();
    testControl.failNextWith('TERMINAL', 'that OTP has expired');

    const res = await request(app).post(`/api/loyalty/orders/${order.id}/redeem`).set(auth(tokens.cashier))
      .send({ phone, otp: '999999', points: 200 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_LOYALTY_REDEEM_REFUSED');
    expect(res.body.error.message).toMatch(/OTP has expired/i);

    const op = await prisma.loyaltyOperation.findFirst({
      where: { connectionId: connId, orderId: order.id, kind: 'REDEEM' },
    });
    expect(op.status).toBe('FAILED');
    // Nothing was spent, so the cashier can try again with a fresh code.
    const after = await lookup(phone);
    expect(after.body.balance.points).toBe(500);
  });

  it('gives back what a voided bill earned, and nothing at all when it earned nothing', async () => {
    const phone = '9000000009';
    testControl.setBalance(phone, 100);
    const earned = await openOrder();
    expect((await attach(earned.id, phone, 'Void Test')).status).toBe(200);
    await billOrder(earned.id);
    const job = await billSyncJob(earned.id);
    expect((await runOnlyJob(job.id)).outcome).toBe('SUCCEEDED');
    const original = await prisma.loyaltyOperation.findUnique({
      where: { connectionId_idempotencyKey: { connectionId: connId, idempotencyKey: `bill:${earned.id}` } },
    });
    expect(original.status).toBe('CONFIRMED');

    const voided = await request(app).post(`/api/orders/${earned.id}/void`).set(auth(tokens.owner))
      .send({ reason: 'billed the wrong table' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    const reverse = await prisma.loyaltyOperation.findUnique({
      where: { connectionId_idempotencyKey: { connectionId: connId, idempotencyKey: `revert:${earned.id}` } },
    });
    expect(reverse).toBeTruthy();
    expect(reverse.kind).toBe('REVERSE');
    // Linked to the operation it reverses. A reversal with no forward operation is
    // either a bug or an attempt to hand out points.
    expect(reverse.reversesId).toBe(original.id);

    // The other half, and the reason this case is one test and not two: a bill
    // whose sync never completed earned nothing, so asking Reelo to reverse a
    // transaction it does not have is the wrong instruction to send.
    const unearned = await openOrder();
    expect((await attach(unearned.id, '9000000010', 'Never Synced')).status).toBe(200);
    await billOrder(unearned.id);
    const stillVoided = await request(app).post(`/api/orders/${unearned.id}/void`).set(auth(tokens.owner))
      .send({ reason: 'cancelled before it was made' });
    expect(stillVoided.status).toBe(200);
    const none = await prisma.loyaltyOperation.count({
      where: { connectionId: connId, orderId: unearned.id, kind: 'REVERSE' },
    });
    expect(none).toBe(0);
  });

  it('tells a company with no loyalty programme that there is none, rather than failing', async () => {
    const res = await request(app).post('/api/loyalty/lookup').set(auth(other.ownerToken))
      .send({ phone: '9000000011' });
    // A till asks about loyalty on every bill. A 500 here would make a restaurant
    // that has no loyalty programme look broken on every single sale.
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/no loyalty programme/i);
    // And the neighbour's absence of a connection cannot be worked around by
    // naming one of our orders.
    const order = await openOrder();
    const cross = await request(app).post(`/api/loyalty/orders/${order.id}/customer`)
      .set(auth(other.ownerToken)).send({ phone: '9000000011' });
    expect(cross.status).toBe(409);
    expect(await prisma.loyaltyOperation.count({ where: { orderId: order.id } })).toBe(0);
  });
});

// --- accounting --------------------------------------------------------------
//
// Tally publishes no idempotency mechanism for imports and returns no master id
// for what it creates. Both absences are load-bearing here: duplicate suppression
// has to be ours, and "Tally acknowledged one voucher" has to be distinguished
// from "Tally answered the call". A connector that conflated those would report a
// month as posted while the books were short three vouchers.
//
// These cases run in order on purpose. The first one is the only chance to
// observe the state every operator starts in — a Tally connection configured and
// not one ledger mapped.

describe('accounting postings', () => {
  let connId;

  const LEDGERS = [
    { kind: 'PARTY_DEFAULT', key: 'DEFAULT', ledgerName: 'Counter Sales' },
    { kind: 'SALES_BY_TAX', key: '5', ledgerName: 'Sales - GST 5%' },
    { kind: 'TAX_OUTPUT', key: 'CGST', ledgerName: 'Output CGST' },
    { kind: 'TAX_OUTPUT', key: 'SGST', ledgerName: 'Output SGST' },
    { kind: 'PAYMENT_METHOD', key: 'CASH', ledgerName: 'Cash' },
    { kind: 'ROUNDING', key: 'ROUNDING', ledgerName: 'Rounding Off' },
  ];

  beforeAll(async () => {
    connId = (await prisma.integrationConnection.findUnique({
      where: { companyId_provider: { companyId: company.id, provider: 'TALLY' } },
    })).id;
  });

  const postingFor = (docType, sourceType, sourceId) =>
    prisma.accountingPosting.findUnique({
      where: {
        connectionId_sourceType_sourceId_docType: { connectionId: connId, sourceType, sourceId, docType },
      },
    });

  const jobFor = (docType, sourceType, sourceId) =>
    prisma.integrationJob.findUnique({
      where: {
        connectionId_dedupeKey: {
          connectionId: connId,
          dedupeKey: `TALLY_${docType === 'SALES' ? 'SALES' : docType}:${docType}:${sourceType}:${sourceId}`,
        },
      },
    });

  let heldOrderId;

  it('holds a bill that names a ledger nobody has mapped, and says which one', async () => {
    const order = await openOrder();
    const billed = await billOrder(order.id);
    heldOrderId = order.id;

    const posting = await postingFor('SALES', 'ORDER', order.id);
    expect(posting).toBeTruthy();
    // PENDING, not FAILED and not sent hopefully. Tally requires the ledger to
    // exist with exactly the right name, so a voucher naming an unmapped ledger
    // is rejected — and a rejected voucher is a bill missing from the books.
    expect(posting.status).toBe('PENDING');
    expect(posting.voucherNumber).toBe(billed.invoiceNumber);
    // Named by kind AND key, because "map your ledgers" is not an instruction
    // anyone can act on and `SALES_BY_TAX "5"` is.
    expect(posting.lastError).toMatch(/SALES_BY_TAX "5"/);
    expect(posting.lastError).toMatch(/PARTY_DEFAULT "DEFAULT"/);
    expect(await jobFor('SALES', 'ORDER', order.id)).toBeNull();

    // And the operator can see it without reading the database.
    const queue = await request(app).get('/api/integrations/TALLY/postings').set(auth(tokens.owner));
    expect(queue.status).toBe(200);
    const row = queue.body.postings.find((p) => p.sourceId === order.id);
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toMatch(/Map them on the integration screen/);
  });

  it('clears every held bill the moment the operator supplies the mapping', async () => {
    const res = await request(app).put('/api/integrations/TALLY/ledgers').set(auth(tokens.owner))
      .send({ ledgers: LEDGERS });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.saved).toBe(LEDGERS.length);
    // The sweep runs on save rather than waiting for a timer: the operator who
    // just supplied the answer should watch the held bills clear, not be told to
    // come back later. Every bill held above is rebuilt against the new mapping.
    expect(res.body.swept.queued).toBeGreaterThan(0);

    const posting = await postingFor('SALES', 'ORDER', heldOrderId);
    expect(posting.status).toBe('QUEUED');
    expect(posting.lastError).toBeNull();
    expect(await jobFor('SALES', 'ORDER', heldOrderId)).toBeTruthy();
  });

  it('writes one sales voucher for a bill and refuses to write a second', async () => {
    const order = await openOrder();
    const billed = await billOrder(order.id);
    const job = await jobFor('SALES', 'ORDER', order.id);
    expect(job).toBeTruthy();

    expect((await runOnlyJob(job.id)).outcome).toBe('SUCCEEDED');
    const posting = await postingFor('SALES', 'ORDER', order.id);
    // ACKNOWLEDGED is the strongest statement Tally's import response makes: it
    // counted a voucher created. Not "the call returned".
    expect(posting.status).toBe('ACKNOWLEDGED');
    expect(posting.acknowledgedAt).toBeTruthy();
    // No master id, because Tally's import response does not carry one. The
    // invoice number in the voucher's own reference is what ties the two sides
    // together, and inventing an id would be worse than admitting there is none.
    expect(posting.externalMasterId).toBeNull();
    expect(posting.voucherNumber).toBe(billed.invoiceNumber);

    const sent = testControl.calls().filter((c) => c.op === 'TALLY_SALES');
    expect(sent).toHaveLength(1);
    // The voucher carries the invoice number as its own reference, which is the
    // only stable external ref this integration has.
    expect(sent[0].args.voucherNumber).toBe(billed.invoiceNumber);

    // Now everything that could produce a second voucher. The sweep asks the
    // books' question ("which bills have no voucher"), so an acknowledged bill
    // must be invisible to it.
    const swept = await request(app).post('/api/integrations/TALLY/sweep').set(auth(tokens.owner));
    expect(swept.status).toBe(200);
    await runOnce({ companyId: company.id });
    expect(testControl.calls().filter((c) => c.op === 'TALLY_SALES')).toHaveLength(1);
    const after = await postingFor('SALES', 'ORDER', order.id);
    expect(after.status).toBe('ACKNOWLEDGED');
    expect(after.id).toBe(posting.id);
  });

  it('stays SENT when Tally answers without saying it created anything', async () => {
    const order = await openOrder();
    await billOrder(order.id);
    const job = await jobFor('SALES', 'ORDER', order.id);

    // A 200 carrying created:0 and errors:1. This is what Tally returns for a
    // voucher it would not accept, and reading it as success is how a connector
    // reports a month as posted while three vouchers are missing.
    testControl.ackNextWith({ status: 1, created: 0, errors: 1, ok: true });
    expect((await runOnlyJob(job.id)).outcome).toBe('SUCCEEDED');

    const posting = await postingFor('SALES', 'ORDER', order.id);
    expect(posting.status).toBe('SENT');
    expect(posting.acknowledgedAt).toBeNull();
    // The queue row succeeded because the call succeeded — the two are different
    // claims, and the one an accountant needs is on the posting.
    const row = await prisma.integrationJob.findUnique({ where: { id: job.id } });
    expect(row.status).toBe('SUCCEEDED');
  });

  it('turns a refund into exactly one credit note, and leaves the sales voucher alone', async () => {
    const order = await openOrder();
    const billed = await billOrder(order.id);
    const total = Number(billed.total);
    const paid = await request(app).post(`/api/orders/${order.id}/payments`).set(auth(tokens.cashier))
      .send({ method: 'CASH', tendered: total });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const refunded = await request(app).post(`/api/orders/${order.id}/refunds`).set(auth(tokens.owner))
      .send({ amount: total, reason: 'customer returned the order' });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);
    const refund = await prisma.refund.findFirst({ where: { orderId: order.id } });
    expect(refund.status).toBe('SUCCEEDED');

    const note = await postingFor('CREDIT_NOTE', 'REFUND', refund.id);
    expect(note).toBeTruthy();
    expect(String(note.amount)).toBe(String(total));
    // Against the original invoice, so the pair reconciles in Tally rather than
    // appearing as two unrelated vouchers.
    expect(note.voucherNumber).toContain(billed.invoiceNumber);

    const salesJob = await jobFor('SALES', 'ORDER', order.id);
    const noteJob = await jobFor('CREDIT_NOTE', 'REFUND', refund.id);
    expect((await runOnlyJob(salesJob.id)).outcome).toBe('SUCCEEDED');
    expect((await runOnlyJob(noteJob.id)).outcome).toBe('SUCCEEDED');

    // One of each. Not two credit notes, and not a second sales voucher because
    // the bill was touched again.
    expect(testControl.calls().filter((c) => c.op === 'TALLY_SALES')).toHaveLength(1);
    expect(testControl.calls().filter((c) => c.op === 'TALLY_CREDIT_NOTE')).toHaveLength(1);
    // Three postings, and each names a different subject: the sales voucher is
    // about the order, the receipt is about the PAYMENT and the credit note is
    // about the refund. That is why AccountingPosting identifies its subject by
    // (sourceType, sourceId) strings instead of a foreign key — three nullable
    // relation columns would be the alternative, and the first thing anyone would
    // do with them is forget one.
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    const postings = await prisma.accountingPosting.findMany({
      where: { connectionId: connId, sourceId: { in: [order.id, payment.id, refund.id] } },
    });
    expect(postings.map((p) => p.docType).sort()).toEqual(['CREDIT_NOTE', 'RECEIPT', 'SALES']);
  });

  it('does not post a bill dated before the day the operator asked posting to start', async () => {
    const future = await request(app).put('/api/integrations/TALLY').set(auth(tokens.owner))
      .send({ enabled: true, config: { ...tallyConfig, postFrom: '2099-01-01' } });
    expect(future.status, JSON.stringify(future.body)).toBe(200);

    const order = await openOrder();
    await billOrder(order.id);
    // Nothing at all, not a held row. The client's books before the cut-over date
    // are already closed, and posting into them is worse than not posting: it
    // changes figures an accountant has signed off.
    expect(await postingFor('SALES', 'ORDER', order.id)).toBeNull();

    const restored = await request(app).put('/api/integrations/TALLY').set(auth(tokens.owner))
      .send({ enabled: true, config: tallyConfig });
    expect(restored.status).toBe(200);
    // The positive control: with the date back, the same bill posts. Otherwise
    // this case would pass with postings broken entirely.
    const swept = await request(app).post('/api/integrations/TALLY/sweep').set(auth(tokens.owner));
    expect(swept.status).toBe(200);
    expect(await postingFor('SALES', 'ORDER', order.id)).toBeTruthy();
  });

  it('reports the queue by state, in count and in value, for reconciliation against the day book', async () => {
    const res = await request(app).get('/api/integrations/TALLY/postings').set(auth(tokens.owner));
    expect(res.status).toBe(200);
    // A count that matches Tally's day book while the value does not is a
    // different problem from neither matching, so both are reported.
    const ack = res.body.totals.find((t) => t.status === 'ACKNOWLEDGED');
    expect(ack.count).toBeGreaterThan(0);
    expect(Number(ack.amount)).toBeGreaterThan(0);
    for (const t of res.body.totals) expect(Number(t.amount)).not.toBeNaN();
    expect(JSON.stringify(res.body)).not.toContain(tallyCredential.host);
  });

  it('will not show one company the other’s books', async () => {
    const res = await request(app).get('/api/integrations/TALLY/postings').set(auth(other.ownerToken));
    // The neighbour never configured Tally, so there is no connection to read and
    // nothing to filter — which is the only answer that cannot leak by accident.
    expect(res.status).toBe(404);
    const swept = await request(app).post('/api/integrations/TALLY/sweep').set(auth(other.ownerToken));
    expect(swept.status).toBe(200);
    expect(swept.body.swept).toBe(0);
    expect(swept.body.reason).toMatch(/no Tally connection/i);
    const ours = await prisma.accountingPosting.count({ where: { companyId: other.company.id } });
    expect(ours).toBe(0);
  });
});

// --- the 100,000-customer migration -----------------------------------------
//
// The client's mandatory requirement, and the only part of this lane that can
// destroy something that already exists. Reelo publishes no bulk export, so this
// consumes a file the client downloads from their own account — which means the
// tests below are about the import's behaviour towards a file, and prove nothing
// about Reelo's export format. That belongs in the blocked list, not here.
describe('historical loyalty import', () => {
  let connId;

  beforeAll(async () => {
    // Configured here rather than relied upon from an earlier block. The import
    // is the one thing in this file an operator runs on day one, before a single
    // bill has been synced, so it has to work against a connection that has just
    // been switched on — and a block that can be run on its own is a block that
    // can be run on its own when it fails.
    connId = (await configure('REELO', { config: { redemptionEnabled: true }, credential: reeloCredential })).id;
  });

  const csv = (rows, header = 'customer_id,phone,name,points,tier') => [header, ...rows].join('\n');

  const post = (body, token = tokens.owner) =>
    request(app).post('/api/integrations/REELO/import').set(auth(token)).send(body);

  it('previews without writing anything, then writes the same numbers it predicted', async () => {
    const file = csv([
      'R-1,9000001001,Asha,1200,GOLD',
      'R-2,9000001002,Bhavna,40,',
      'R-3,9000001003,,0,',
    ]);

    const preview = await post({ csv: file, dryRun: true, totalReported: 3 });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.state).toBe('PREVIEW');
    expect(preview.body.totals.rowsRead).toBe(3);
    expect(preview.body.totals.customersCreated).toBe(3);
    expect(preview.body.totals.failed).toBe(0);
    // The preview is only worth reading if it is the truth about what a real run
    // will do, so it is asserted as a PREDICTION and then checked against the
    // outcome below — not merely as a response that came back 200.
    expect(preview.body.totals.balanceSumPoints).toBe(1240);
    expect(preview.body.totals.reconciles).toBe(true);

    // The load-bearing half: nothing exists yet.
    expect(await prisma.customer.count({ where: { companyId: company.id, phone: { startsWith: '90000010' } } })).toBe(0);
    expect(await prisma.loyaltyProfileLink.count({
      where: { connectionId: connId, externalCustomerId: { in: ['R-1', 'R-2', 'R-3'] } },
    })).toBe(0);

    const real = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS', totalReported: 3 });
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    expect(real.body.state).toBe('COMPLETED');
    expect(real.body.totals.customersCreated).toBe(preview.body.totals.customersCreated);
    expect(real.body.totals.balanceSumPoints).toBe(preview.body.totals.balanceSumPoints);
    expect(real.body.totals.reconciles).toBe(true);

    const made = await prisma.customer.findMany({
      where: { companyId: company.id, phone: { startsWith: '90000010' } },
      orderBy: { phone: 'asc' },
    });
    expect(made).toHaveLength(3);
    // A profile with no name in the export is named after its number rather than
    // left blank, so it is findable at a till.
    expect(made[2].name).toBe('9000001003');

    const links = await prisma.loyaltyProfileLink.findMany({
      where: { connectionId: connId, externalCustomerId: { in: ['R-1', 'R-2', 'R-3'] } },
    });
    expect(links).toHaveLength(3);
    const asha = links.find((l) => l.externalCustomerId === 'R-1');
    expect(asha.lastKnownBalance).toBe(1200);
    expect(asha.membershipTier).toBe('GOLD');
    // As-at-export, with its own timestamp, and labelled where it came from. The
    // till still reads live; this figure exists to be reconciled, not spent.
    expect(asha.source).toBe('HISTORICAL_IMPORT');
    expect(asha.balanceAsOf).toBeInstanceOf(Date);
  });

  it('never calls the provider, so nobody is enrolled again and nobody is messaged', async () => {
    testControl.reset();
    const res = await post({
      csv: csv(['R-9,9000001009,Deep,500,']),
      dryRun: false,
      confirm: 'IMPORT CUSTOMERS',
    });
    expect(res.status).toBe(200);
    expect(res.body.totals.customersCreated).toBe(1);
    // The instruction was explicit: do not reset points, do not enrol again, do
    // not recalculate old balances, do not send bulk messages. All four of those
    // would be a call to Reelo, and the import makes none — not one, for a file
    // that could be 100,000 rows long. Asserted on the provider double's own
    // call log rather than on an absence of errors.
    expect(testControl.calls()).toHaveLength(0);
    // And no queued work either, which is the other way a call could happen later.
    expect(await prisma.integrationJob.count({
      where: { connectionId: connId, kind: { in: ['REELO_BILL_SYNC', 'REELO_REDEEM'] }, dedupeKey: { contains: '9000001009' } },
    })).toBe(0);
  });

  it('matches a customer who is already in the POS instead of making a second one, and does not rename them', async () => {
    const existing = await prisma.customer.create({
      data: { companyId: company.id, name: 'Priya Sharma', phone: '9000002001', note: 'walked in' },
    });

    const res = await post({
      csv: csv(['R-20,9000002001,PRIYA S (reelo),300,SILVER']),
      dryRun: false,
      confirm: 'IMPORT CUSTOMERS',
    });
    expect(res.status).toBe(200);
    expect(res.body.totals.matchedExistingCustomers).toBe(1);
    expect(res.body.totals.customersCreated).toBe(0);

    const after = await prisma.customer.findMany({ where: { companyId: company.id, phone: '9000002001' } });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(existing.id);
    // The name the till typed survives the import. Overwriting 100,000 of these
    // from a third party's copy is a data loss event with a progress bar.
    expect(after[0].name).toBe('Priya Sharma');
    expect(after[0].note).toBe('walked in');

    const link = await prisma.loyaltyProfileLink.findUnique({
      where: { connectionId_customerId: { connectionId: connId, customerId: existing.id } },
    });
    expect(link.externalCustomerId).toBe('R-20');
    expect(link.lastKnownBalance).toBe(300);
  });

  it('is idempotent: importing the same file twice leaves one customer and one balance', async () => {
    const file = csv(['R-30,9000003001,Rekha,800,GOLD']);
    const first = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS' });
    expect(first.body.totals.customersCreated).toBe(1);

    const second = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS' });
    expect(second.status).toBe(200);
    // Not an error, and not a duplicate: the second pass recognises its own work.
    // A migration that cannot be re-run is a migration nobody dares re-run, and
    // "dare not re-run" is how a half-finished import stays half-finished.
    expect(second.body.totals.customersCreated).toBe(0);
    expect(second.body.totals.matchedExistingCustomers).toBe(1);
    expect(second.body.totals.failed).toBe(0);

    expect(await prisma.customer.count({ where: { companyId: company.id, phone: '9000003001' } })).toBe(1);
    const links = await prisma.loyaltyProfileLink.findMany({
      where: { connectionId: connId, normalizedPhone: '9000003001' },
    });
    expect(links).toHaveLength(1);
    expect(links[0].lastKnownBalance).toBe(800);
  });

  it('names every row it could not take, and why, instead of reporting a smaller total', async () => {
    const res = await post({
      csv: csv([
        'R-40,9000004001,Good One,100,',
        'R-41,12345,Bad Number,50,',
        'R-42,,No Number,10,',
        'R-43,9000004004,Bad Points,not-a-number,',
        'R-44,+91 90000 04005,Spaced Out,60,',
      ]),
      dryRun: true,
      totalReported: 5,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totals.rowsRead).toBe(5);
    expect(res.body.totals.failed).toBe(3);
    // The arithmetic is the point. "99,412 of 100,000" with no list of the 588 is
    // not a reportable result, so the report proves it can account for every row
    // it read before anyone reads the good news.
    expect(res.body.totals.accountedFor).toBe(5);
    expect(res.body.totals.reconciles).toBe(true);
    expect(res.body.exceptionCount).toBe(3);

    const byRow = new Map(res.body.exceptions.map((e) => [e.rowNumber, e]));
    // Row numbers are the file's own, header included, so a row can be found in
    // a spreadsheet by scrolling to it.
    expect(byRow.get(3).phoneRaw).toBe('12345');
    expect(byRow.get(3).reason).toMatch(/not a recognisable Indian mobile/i);
    expect(byRow.get(4).reason).toMatch(/no phone number/i);
    expect(byRow.get(5).reason).toMatch(/points value "not-a-number"/i);
    // Positive control: a number that merely LOOKS awkward is imported, so the
    // three refusals above are refusals of unreadable data and not of formatting.
    expect(res.body.totals.customersCreated).toBe(2);
  });

  it('refuses a real import that was not confirmed, and a file whose header it cannot read', async () => {
    const before = await prisma.loyaltyImportRun.count({ where: { companyId: company.id } });

    const unconfirmed = await post({ csv: csv(['R-50,9000005001,X,10,']), dryRun: false });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.message).toMatch(/IMPORT CUSTOMERS/);
    expect(unconfirmed.body.error.message).toMatch(/Nothing has been changed/i);

    const headerless = await post({
      csv: csv(['1,Someone,10'], 'reelo_ref,full_name,pts'),
      dryRun: true,
    });
    expect(headerless.status).toBe(400);
    expect(headerless.body.error.message).toMatch(/phone column/i);

    // Neither refusal created a run, so the import history is not littered with
    // rows that describe nothing.
    expect(await prisma.loyaltyImportRun.count({ where: { companyId: company.id } })).toBe(before);
    expect(await prisma.customer.count({ where: { companyId: company.id, phone: '9000005001' } })).toBe(0);
  });

  it('continues an interrupted run from its cursor rather than reading the file again', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => `R-6${i},90000060${String(i).padStart(2, '0')},P${i},${(i + 1) * 10},`);
    const file = csv(rows);

    // Simulate the interruption the way it actually happens: a real run that
    // committed some batches and then died, leaving RUNNING and a cursor. Written
    // by hand because the alternative is killing the process mid-request, and the
    // thing under test is the resume, not the crash.
    const stopped = await prisma.loyaltyImportRun.create({
      data: {
        companyId: company.id,
        connectionId: connId,
        state: 'RUNNING',
        dryRun: false,
        sourceFingerprint: fingerprint(file),
        totalReported: 6,
        cursor: '4',
        fetched: 3,
        created: 3,
        startedAt: new Date(),
      },
    });
    // The first three data rows are rows 2, 3 and 4; pretend they landed.
    for (const i of [0, 1, 2]) {
      await prisma.customer.create({
        data: { companyId: company.id, name: `P${i}`, phone: `90000060${String(i).padStart(2, '0')}` },
      });
    }

    const report = await runReport(stopped.id);
    expect(report.canResume).toBe(true);
    expect(report.resumeAfterRow).toBe(4);

    const resumed = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS', resumeRunId: stopped.id });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.id).toBe(stopped.id);
    expect(resumed.body.state).toBe('COMPLETED');
    // Six rows read across the two halves, not nine. The counters continue, which
    // is the whole reason the run is reopened instead of replaced: a fresh run
    // would report "created 3, matched 3" and lose the answer to the only
    // question asked afterwards — how many customers did the migration bring in.
    expect(resumed.body.totals.rowsRead).toBe(6);
    expect(resumed.body.totals.customersCreated).toBe(6);
    expect(resumed.body.totals.matchedExistingCustomers).toBe(0);
    expect(resumed.body.totals.reconciles).toBe(true);
    expect(resumed.body.cursor).toBe('7');

    expect(await prisma.customer.count({ where: { companyId: company.id, phone: { startsWith: '9000006' } } })).toBe(6);
    // Only the second half was linked, because only the second half was read —
    // the first three were never re-touched, which is what "repeats none" means.
    const links = await prisma.loyaltyProfileLink.findMany({
      where: { connectionId: connId, externalCustomerId: { startsWith: 'R-6' } },
    });
    expect(links.map((l) => l.externalCustomerId).sort()).toEqual(['R-63', 'R-64', 'R-65']);

    // A resume is its own act, logged as one. "Somebody re-ran the import" and
    // "somebody continued the import from row 4" are different events, and after a
    // 100,000-customer migration the difference is the first thing anybody asks.
    const trail = await prisma.posAuditLog.findFirst({
      where: { companyId: company.id, action: 'INTEGRATION_IMPORT_RESUME', entityId: stopped.id },
    });
    expect(trail).toBeTruthy();
    expect(trail.actorEmail).toBe('owner.i@test.local');
    expect(trail.meta.resumeAfterRow).toBe(4);
  });

  it('refuses to resume into a different file, a finished run, or another company’s run', async () => {
    const file = csv(['R-70,9000007001,A,10,', 'R-71,9000007002,B,20,']);
    // Same customers, same total, same length — only the order differs, which is
    // exactly how a re-export goes wrong and exactly what a size or name check
    // would wave through.
    const reordered = csv(['R-71,9000007002,B,20,', 'R-70,9000007001,A,10,']);

    const stopped = await prisma.loyaltyImportRun.create({
      data: {
        companyId: company.id,
        connectionId: connId,
        state: 'FAILED',
        dryRun: false,
        sourceFingerprint: fingerprint(file),
        cursor: '2',
        fetched: 1,
        created: 1,
        startedAt: new Date(),
        lastError: 'connection lost',
      },
    });

    // The dangerous case, and the reason the fingerprint column exists: the same
    // row number in a re-export is a different customer, so resuming at row 3 of
    // a reordered file would step over one person and import another twice while
    // reporting success.
    const wrongFile = await post({ csv: reordered, dryRun: false, confirm: 'IMPORT CUSTOMERS', resumeRunId: stopped.id });
    expect(wrongFile.status).toBe(400);
    expect(wrongFile.body.error.message).toMatch(/not the file that import was reading/i);
    expect(await prisma.customer.count({ where: { companyId: company.id, phone: { startsWith: '9000007' } } })).toBe(0);

    const asPreview = await post({ csv: file, dryRun: true, resumeRunId: stopped.id });
    expect(asPreview.status).toBe(400);
    expect(asPreview.body.error.message).toMatch(/report progress that is not being made/i);

    // Positive control: the same run, the same file, resumes.
    const ok = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS', resumeRunId: stopped.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.state).toBe('COMPLETED');
    // Reopened, so the error that stopped it is cleared rather than left to be
    // read as a fresh failure.
    expect(ok.body.lastError).toBeNull();

    const finished = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS', resumeRunId: stopped.id });
    expect(finished.status).toBe(400);
    expect(finished.body.error.message).toMatch(/already finished/i);

    // And the neighbour cannot continue ours, which is the tenant boundary on the
    // most destructive endpoint in the router.
    const trespass = await request(app)
      .post('/api/integrations/REELO/import')
      .set(auth(other.ownerToken))
      .send({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS', resumeRunId: stopped.id });
    expect([400, 404]).toContain(trespass.status);
    expect(await prisma.customer.count({ where: { companyId: other.company.id } })).toBe(0);
  });

  it('will not let a cashier run the migration, and will let the owner', async () => {
    const file = csv(['R-80,9000008001,Z,10,']);
    const denied = await post({ csv: file, dryRun: true }, tokens.cashier);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('POS_FORBIDDEN');

    // A branch manager can retry a stuck voucher but cannot migrate 100,000
    // customer records — the two are not the same authority, and the registry
    // says so by giving the manager integration.job.retry and not import.run.
    const manager = await post({ csv: file, dryRun: true }, tokens.manager);
    expect(manager.status).toBe(403);

    const allowed = await post({ csv: file, dryRun: true }, tokens.owner);
    expect(allowed.status).toBe(200);
  });

  it('holds 100,000 rows in one isolated run and accounts for every one of them', async () => {
    // The client's stated scale, against this lane's own database and its own
    // in-process double. No provider is contacted — the instruction forbids
    // stress-testing Reelo's production API, and nothing here could reach it.
    const N = 100_000;
    const lines = ['customer_id,phone,name,points,tier'];
    for (let i = 0; i < N; i += 1) {
      // 9,100,000,000 upwards: inside the Indian mobile range this lane accepts,
      // and disjoint from every other case in this file.
      lines.push(`P-${i},91${String(10_000_000 + i)},Cust ${i},${i % 500},`);
    }
    const file = lines.join('\n');

    const started = Date.now();
    const res = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS', totalReported: N });
    const seconds = (Date.now() - started) / 1000;
    expect(res.status, JSON.stringify(res.body?.error ?? res.body).slice(0, 400)).toBe(200);
    expect(res.body.state).toBe('COMPLETED');
    expect(res.body.totals.rowsRead).toBe(N);
    expect(res.body.totals.customersCreated).toBe(N);
    expect(res.body.totals.failed).toBe(0);
    expect(res.body.totals.accountedFor).toBe(N);
    expect(res.body.totals.reconciles).toBe(true);
    // Summed in a Decimal(18,0) column precisely because 100,000 balances pass a
    // 32-bit total sooner than anyone expects. Asserted against the arithmetic of
    // the file rather than against whatever the column happened to hold.
    const expectedSum = Array.from({ length: N }, (_, i) => i % 500).reduce((a, b) => a + b, 0);
    expect(res.body.totals.balanceSumPoints).toBe(expectedSum);
    expect(res.body.totals.balanceSumPoints).toBeGreaterThan(2_147_483_647 / 100);

    expect(await prisma.customer.count({ where: { companyId: company.id, phone: { startsWith: '9110' } } }))
      .toBeGreaterThan(0);
    expect(await prisma.loyaltyProfileLink.count({ where: { connectionId: connId, source: 'HISTORICAL_IMPORT', externalCustomerId: { startsWith: 'P-' } } }))
      .toBe(N);
    // Reported so the number is in the run log rather than in somebody's memory.
    // Not asserted as a threshold: this box is a shared development machine and a
    // timing assertion here would fail for reasons that have nothing to do with
    // the import.
    console.log(`[import] ${N} rows in ${seconds.toFixed(1)}s (${Math.round(N / seconds)} rows/s)`);

    // Cleared here, after every assertion, because 200,000 leftover rows are the
    // NEXT run's problem: wipeAll() deletes them table by table in beforeAll,
    // and at this volume that alone exceeded the 30s hook timeout and failed a
    // suite that had nothing to do with imports. Links first — the FK to Customer
    // is Cascade, so clearing the children up front leaves the trigger below
    // nothing to find.
    const linksStarted = Date.now();
    await prisma.loyaltyProfileLink.deleteMany({ where: { connectionId: connId, externalCustomerId: { startsWith: 'P-' } } });
    const linkSeconds = (Date.now() - linksStarted) / 1000;
    const customersStarted = Date.now();
    await prisma.customer.deleteMany({ where: { companyId: company.id, phone: { startsWith: '9110' } } });
    const customerSeconds = (Date.now() - customersStarted) / 1000;
    // Split reported separately from [import] above because the two halves fail
    // for different reasons and the single total hid that for three runs. The
    // customer delete fires LoyaltyProfileLink's cascade trigger once per row,
    // and before LoyaltyProfileLink_customerId_companyId_idx existed the trigger
    // had no index to use and seq-scanned the whole child table per parent.
    //
    // Measured 2026-09-26 by DROPPING the index and re-running, rather than by
    // assuming what its absence would cost. Same database, same 100k+100k shape,
    // raw SQL with no Prisma and no vitest in the path:
    //
    //     with the index      13,222ms
    //     without it         642,838ms      48.6x
    //
    // 642,838ms is a FLOOR, not the true cost: autovacuum ran 11 times on
    // LoyaltyProfileLink DURING that delete, shrinking the table each successive
    // seq scan had to walk, so the arm was being rescued mid-flight. Unrescued,
    // the same shape projects to ~1,005s. Either number overran the 900s budget
    // during CLEANUP, while every assertion above had already passed.
    //
    // Reading these two numbers: BOTH halves are load-sensitive, so neither is
    // worth anything without the box's load recorded beside it.
    //
    //   import   199 rows/s at load 2.68 | 205 at load 7.57 | 146 at load 13.65
    //   cleanup  customers 13.0s at load 13.65; ~3.2s against an idle database
    //
    // An earlier version of this comment called the import load-INsensitive,
    // reading the first two figures as flat. The third disproves it: the plateau
    // runs out somewhere above load ~8, and at 13.65 the import lost 182s —
    // most of the budget's headroom. What still separates the two causes is
    // SCALE, not sensitivity. Contention moves this cleanup line by single-digit
    // seconds; a missing index moves it into the HUNDREDS. Tens of seconds means
    // the box is busy. Hundreds means the index is gone.
    console.log(`[cleanup] links ${linkSeconds.toFixed(1)}s, customers ${customerSeconds.toFixed(1)}s`);
  }, 900_000);

  it('still recognises an imported customer at the till, and reads their balance live', async () => {
    // What the migration is FOR. An import that loads 100,000 rows nobody can
    // then serve has achieved nothing, so the chain is followed to the end: the
    // imported profile is found by phone, and the points figure the till shows is
    // the provider's live answer, not the cached one the file carried.
    const file = csv(['R-90,9000009001,Imported Person,777,GOLD']);
    const imported = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS' });
    expect(imported.status).toBe(200);

    testControl.reset();
    testControl.setBalance('9000009001', 812);

    const res = await request(app).post('/api/loyalty/lookup').set(auth(tokens.cashier)).send({ phone: '9000009001' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.known).toBe(true);
    // 812, not the 777 in the file. The import's figure is a cache for
    // reconciliation; the provider owns the balance and the till asks it.
    expect(res.body.balance.points).toBe(812);
    expect(res.body.balance.source).toBe('PROVIDER');
    expect(testControl.calls().filter((c) => c.op === 'lookupCustomer')).toHaveLength(1);

    // The till reused the row the import made instead of making a second one, and
    // left its name alone. Asserted on the database rather than on the response,
    // because the response shows whichever name the loyalty provider holds for
    // this profile — a display choice — while the question that matters is
    // whether a live lookup can quietly overwrite what a till typed.
    const rows = await prisma.customer.findMany({ where: { companyId: company.id, phone: '9000009001' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Imported Person');

    const links = await prisma.loyaltyProfileLink.findMany({
      where: { connectionId: connId, customerId: rows[0].id },
    });
    expect(links).toHaveLength(1);
    // Still R-90: the provider identity the import established is the one the till
    // uses, which is the entire point of having imported it.
    expect(links[0].externalCustomerId).toBe('R-90');
  });

  it('shows an imported customer’s balance as unknown, never as zero, when nobody can say what it is', async () => {
    // The case the real migration turns on. The client's export may not carry a
    // points column at all, or may carry it blank for some customers, and Reelo
    // may be unreachable at the moment a cashier asks. Displaying 0 there tells
    // the cashier this customer has earned nothing — so a person with a real
    // balance is refused a redemption they are entitled to, and the migration has
    // materially harmed the client's own customer. "We do not know" is the only
    // honest answer and it must survive all the way to the till.
    const file = csv(['R-91,9000009002,Blank Balance Person,,SILVER']);
    const imported = await post({ csv: file, dryRun: false, confirm: 'IMPORT CUSTOMERS' });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);

    const link = await prisma.loyaltyProfileLink.findFirst({
      where: { connectionId: connId, externalCustomerId: 'R-91' },
    });
    // Null in the cache, not 0. An import that defaulted the column would make
    // every unknown balance indistinguishable from a genuine empty one, and no
    // later lookup could tell them apart.
    expect(link).toBeTruthy();
    expect(link.lastKnownBalance).toBeNull();

    // And the provider cannot be reached, so there is no live figure either.
    testControl.reset();
    testControl.failNextWith('UNKNOWN', 'Reelo did not answer');
    const res = await request(app).post('/api/loyalty/lookup').set(auth(tokens.cashier)).send({ phone: '9000009002' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Known as a person, unknown as a balance. Those are separate facts and the
    // till is told both.
    expect(res.body.known).toBe(true);
    expect(res.body.balance.points).toBeNull();
    expect(res.body.balance.source).toBe('UNKNOWN');
    expect(res.body.balance.points).not.toBe(0);

    // The positive control, and the reason the assertion above is not simply
    // proving that this endpoint always answers UNKNOWN: the same customer, once
    // Reelo answers, reads the real figure.
    testControl.reset();
    testControl.setBalance('9000009002', 5000);
    const live = await request(app).post('/api/loyalty/lookup').set(auth(tokens.cashier)).send({ phone: '9000009002' });
    expect(live.body.balance.points).toBe(5000);
    expect(live.body.balance.source).toBe('PROVIDER');
  });
});

describe('audit trail', () => {
  // A distinctive value, so "the credential did not reach the trail" can be
  // asserted against the whole serialized response rather than against the one
  // field somebody remembered to check.
  const SECRET = 'zomato-header-value-BXQ7-must-never-appear';

  beforeAll(async () => {
    await configure('ZOMATO', {
      config: { posId: 'pos-audit-1', autoAccept: false },
      credential: { ...zomatoCredential, inboundHeaderValue: SECRET },
    });
    // Both of these exist so the two controls below are real rather than
    // inherited from whichever earlier block happened to run: a SECOND provider
    // in this company, so "filtered to ZOMATO" can be shown to have excluded
    // something, and an entry belonging to the NEIGHBOUR, so the isolation test
    // is not satisfied by an empty list.
    await configure('REELO', { config: { redemptionEnabled: true }, credential: reeloCredential });
    await configure('TALLY', {
      config: tallyConfig,
      credential: tallyCredential,
      token: other.ownerToken,
    });
  });

  it('shows what was changed, by whom, newest first', async () => {
    const res = await request(app).get('/api/integrations/audit/trail?provider=ZOMATO').set(auth(tokens.owner));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const actions = res.body.entries.map((e) => e.action);
    expect(actions).toContain('INTEGRATION_CONFIGURE');
    expect(actions).toContain('INTEGRATION_CREDENTIAL_WRITE');
    // The credential write happened after the configure, so it has to be the
    // earlier index. An unordered trail is a trail nobody can read a sequence of
    // events out of, which is the only thing it is for.
    expect(actions.indexOf('INTEGRATION_CREDENTIAL_WRITE'))
      .toBeLessThan(actions.indexOf('INTEGRATION_CONFIGURE'));

    const configured = res.body.entries.find((e) => e.action === 'INTEGRATION_CONFIGURE');
    expect(configured.actorEmail).toBe('owner.i@test.local');
    expect(configured.actorRole).toBe('CUSTOMER_OWNER');
    expect(configured.meta.provider).toBe('ZOMATO');
    expect(configured.meta.enabled).toBe(true);
    expect(new Date(configured.at).getTime()).toBeGreaterThan(0);
  });

  it('carries no credential material, not even the values it audited', async () => {
    const res = await request(app).get('/api/integrations/audit/trail').set(auth(tokens.owner));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(zomatoCredential.apiKey);
    expect(body).not.toContain(reeloCredential.customerKey);
    // The configure audit writes the whole config object to meta, and the
    // projection drops it. `posId` is not a secret — this asserts the allow-list
    // is an allow-list and not a deny-list of the keys somebody thought of.
    expect(body).not.toContain('pos-audit-1');
    // INTEGRATION_CREDENTIAL_WRITE audits an HMAC of the key. It is not the key,
    // and it is still not something a screen needs.
    const write = res.body.entries.find((e) => e.action === 'INTEGRATION_CREDENTIAL_WRITE');
    expect(write).toBeDefined();
    expect(write.meta.fingerprint).toBeUndefined();
    expect(Object.keys(write.meta)).toEqual(['provider']);
  });

  it('shows one tenant nothing of another’s', async () => {
    // The neighbour configured TALLY in this block's beforeAll, so this is a
    // positive control as well as an isolation check: they see their own entries,
    // and none of ours. Without the positive half, a route that returned nothing
    // to anybody would pass.
    const mine = await request(app).get('/api/integrations/audit/trail').set(auth(tokens.owner));
    const theirs = await request(app).get('/api/integrations/audit/trail').set(auth(other.ownerToken));
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body.entries.length).toBeGreaterThan(0);

    const mineIds = new Set(mine.body.entries.map((e) => e.id));
    for (const entry of theirs.body.entries) {
      expect(mineIds.has(entry.id)).toBe(false);
      expect(entry.actorEmail).not.toBe('owner.i@test.local');
    }
  });

  it('filters to one provider, and the filter is not the only thing keeping rows out', async () => {
    const all = await request(app).get('/api/integrations/audit/trail').set(auth(tokens.owner));
    const one = await request(app).get('/api/integrations/audit/trail?provider=ZOMATO').set(auth(tokens.owner));
    expect(one.body.entries.length).toBeGreaterThan(0);
    expect(one.body.entries.every((e) => e.meta.provider === 'ZOMATO')).toBe(true);
    // Something OTHER than ZOMATO is in the unfiltered list, or the filter above
    // proved nothing.
    expect(all.body.entries.some((e) => e.meta.provider && e.meta.provider !== 'ZOMATO')).toBe(true);
  });

  it('is gated on integration.read', async () => {
    const cashier = await request(app).get('/api/integrations/audit/trail').set(auth(tokens.cashier));
    expect(cashier.status).toBe(403);
    expect(cashier.body.error.code).toBe('POS_FORBIDDEN');
    // A manager holds integration.read, so this is the negative's control.
    const manager = await request(app).get('/api/integrations/audit/trail').set(auth(tokens.manager));
    expect(manager.status, JSON.stringify(manager.body)).toBe(200);
  });
});
