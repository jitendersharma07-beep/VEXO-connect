// F-3 — the first-login password change, enforced by the SERVER.
//
// Until this gate existed the forced change lived in the browser: the screen
// covered itself with a modal, and the same temporary-password token opened
// bills from curl (POST /orders → 201). This suite pins the server-side rule:
//
//   * every route the app mounts refuses a temporary-password session with
//     403 POS_PASSWORD_CHANGE_REQUIRED, except the three setup routes;
//   * the route list is read out of Express itself, so a route added later is
//     covered without anybody remembering to add it here — and a route added
//     WITHOUT requirePosAuth fails the suite until it is consciously listed as
//     public;
//   * the forced change retires the restricted session and issues a normal
//     one, while a voluntary change keeps the session it was made from;
//   * a paired customer display (req.display) is untouched by any of it.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('firstLoginGate.test.js requires a DATABASE_URL ending in _test');
}

// The gateway router is mounted only when a provider is configured. Configure
// the in-process test adapter so its routes are part of the enumeration too.
process.env.POS_GATEWAY_PROVIDER = 'test';
process.env.POS_GATEWAY_WEBHOOK_SECRET = 'first-login-gate-test-secret';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { env } = await import('../src/config/env.js');
// The canonical full wipe every suite on this branch uses. The firstlogin lane
// had grown a second copy of it under helpers/wipe.js; importing that here
// would fork the helper, so the table list stops being maintained in one place.
const { wipeAll } = await import('./helpers/inventory.js');
// Branch.publicId is globally unique under a CHECK constraint; mint it with the
// same code the route uses rather than writing a literal that the next change to
// that constraint would silently invalidate.
const { mintStorePublicId } = await import('../src/lib/identity.js');

const app = createApp();
const PW = 'gate-test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const GATE = 'POS_PASSWORD_CHANGE_REQUIRED';

// ---------------------------------------------------------------------------
// Route enumeration straight from the Express router stack.
// ---------------------------------------------------------------------------

// Express 4 keeps no mount-path string on a router layer, only the regexp it
// compiled. Every mount in this app is a static path, which compiles to
// ^\/seg(\/seg)*\/?(?=\/|$) — unescape that, and refuse anything else loudly
// rather than guess, because a wrong guess would silently skip a whole router.
const mountPath = (layer) => {
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^/, '');
  src = src.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  src = src.replace(/\(\?=\\\/\|\$\)$/, '');
  const path = src.replace(/\\([/.\-])/g, '$1');
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(path)) {
    throw new Error(`cannot read the mount path of ${layer.regexp} — teach mountPath() this shape`);
  }
  return path;
};

const listRoutes = (expressApp) => {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk(expressApp._router.stack, '');
  return out;
};

const key = (r) => `${r.method} ${r.path}`;
const concrete = (path) => path.replace(/:([A-Za-z0-9_]+)/g, 'probe-$1');

// Routes that never see a staff session at all, with the reason. Adding to
// this list is the ONLY way a route can answer a temporary-password token with
// something other than the gate, so each entry has to be defensible.
const PUBLIC = {
  'GET /': 'service banner, no data',
  'GET /api/config': 'app name for the login screen',
  'GET /api/health/': 'liveness probe',
  'GET /health/': 'liveness probe (unprefixed mount)',
  'POST /api/auth/login': 'how a session is obtained in the first place',
  'POST /api/display/pair': 'redeems a pairing code; authenticated by the code',
  'GET /api/display/state': 'customer display; authenticated by its own display token',
  'POST /api/gateway/webhook': 'provider webhook; authenticated by HMAC signature',

  // Account recovery: reached precisely BECAUSE the caller cannot sign in, so
  // requiring a session would make the feature impossible. accountRecovery.js
  // contains no requirePosAuth at all.
  'POST /api/auth/forgot-password': 'starts recovery; the caller has no session by definition',
  'POST /api/auth/forgot-password/resend': 'same flow, same reason',
  'POST /api/auth/forgot-password/verify': 'authenticated by the emailed code',
  'POST /api/auth/forgot-password/reset': 'authenticated by the reset authorization token',

  // invitations.js exports TWO routers: an authenticated one for the staff who
  // issue invitations, and this public pair for the invitee, who has no account
  // yet. Authenticated by the 256-bit token in the body, behind recoveryLimiter.
  'POST /api/invite/lookup': 'invitee has no account yet; authenticated by the invite token',
  'POST /api/invite/accept': 'same, and this is the call that creates the account',

  // Print agents authenticate as DEVICES via requirePrintAgent, not as staff.
  // The staff halves of these same routers (POST/GET /api/print-agents,
  // /:id/revoke, /:id/targets) do go through requirePosAuth and ARE gated —
  // which is why they are absent from this list.
  'POST /api/print-agents/enrol': 'redeems an enrolment code; no session exists yet',
  'POST /api/print-agents/heartbeat': 'agent token, not a staff session',
  'POST /api/print-agents/jobs/claim': 'agent token, not a staff session',
  'POST /api/print-agents/jobs/:id/report': 'agent token, not a staff session',
  'POST /api/print-agents/commands/claim': 'agent token, not a staff session',
  'POST /api/print-agents/commands/:id/report': 'agent token, not a staff session',
};

// The three routes a temporary password exists to reach.
const SETUP = new Set(['GET /api/auth/me', 'POST /api/auth/change-password', 'POST /api/auth/logout']);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let company, branch, product, table;
let ownerToken, cashierNormalToken;
const temp = {}; // email → temporary password, minted through the real routes

const login = async (email, password = PW) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
};

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword(PW);

  company = await prisma.company.create({
    data: {
      name: 'Gate Café',
      slug: 'gate-cafe',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 30 * 86400e3) } },
    },
  });
  branch = await prisma.branch.create({
    data: {
      companyId: company.id,
      publicId: await mintStorePublicId(prisma),
      name: 'Gate One',
      code: 'G1',
    },
  });
  const tax = await prisma.taxRate.create({ data: { companyId: company.id, name: 'GST 5%', ratePercent: 5 } });
  const cat = await prisma.category.create({ data: { companyId: company.id, name: 'Coffee' } });
  product = await prisma.product.create({
    data: { companyId: company.id, categoryId: cat.id, name: 'Latte', sku: 'LAT-1', basePrice: 150, taxRateId: tax.id },
  });
  table = await prisma.diningTable.create({ data: { branchId: branch.id, name: 'T1' } });

  await prisma.posUser.create({
    data: { email: 'atc.gate@test.local', fullName: 'ATC Gate', role: 'POS_SUPER_ADMIN', passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'owner.gate@test.local', fullName: 'Owner Gate', role: 'CUSTOMER_OWNER', companyId: company.id, passwordHash },
  });
  await prisma.posUser.create({
    data: {
      email: 'cashier.normal@test.local',
      fullName: 'Cashier Normal',
      role: 'CASHIER',
      companyId: company.id,
      branchId: branch.id,
      passwordHash,
    },
  });
  // A platform operator on a temporary password — the prod seed's own state.
  temp['atc.temp@test.local'] = 'atc-temporary-pw-1';
  await prisma.posUser.create({
    data: {
      email: 'atc.temp@test.local',
      fullName: 'ATC Temp',
      role: 'POS_SUPER_ADMIN',
      passwordHash: await hashPassword(temp['atc.temp@test.local']),
      mustChangePassword: true,
    },
  });

  ownerToken = (await login('owner.gate@test.local')).token;
  cashierNormalToken = (await login('cashier.normal@test.local')).token;

  // Seeded temporary passwords, written directly — and that is the accurate
  // fixture rather than a shortcut.
  //
  // The lane this suite came from minted them through POST /api/users, which
  // used to answer with a tempPassword. It no longer does: an invited account is
  // created with unusableCredential() and mustChangePassword standing for "has
  // not chosen a password yet", so NO string signs it in and it can never reach
  // this gate at all. Routing the fixture through that route would therefore
  // test nothing, and on a deployment with no SMTP host it 503s before creating
  // anything.
  //
  // The population that really can hold a usable temporary password is the one
  // prisma/seed.js creates — a real hash plus the flag — so that is what these
  // rows are. It is also the population the F-3 hole was actually exploitable
  // from.
  for (const [email, role, extra] of [
    ['cashier.temp@test.local', 'CASHIER', { branchId: branch.id }],
    ['manager.temp@test.local', 'BRANCH_MANAGER', { branchId: branch.id }],
    ['cashier.rotate@test.local', 'CASHIER', { branchId: branch.id }],
    ['cashier.logout@test.local', 'CASHIER', { branchId: branch.id }],
    ['owner.temp@test.local', 'CUSTOMER_OWNER', {}],
  ]) {
    temp[email] = `temporary-${email.split('.')[1].split('@')[0]}-pw-1`;
    await prisma.posUser.create({
      data: {
        email,
        fullName: email.split('@')[0],
        role,
        companyId: company.id,
        passwordHash: await hashPassword(temp[email]),
        mustChangePassword: true,
        ...extra,
      },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('route enumeration', () => {
  it('reads the real route table, not an empty one', () => {
    const routes = listRoutes(app).map(key);
    // Controls: if the walker ever returns nothing, every "all routes are
    // gated" assertion below would pass vacuously.
    expect(routes.length).toBeGreaterThan(60);
    for (const known of [
      'POST /api/orders/',
      'POST /api/orders/:id/payments',
      'GET /api/atc/companies',
      'POST /api/display/pair-code',
      'POST /api/gateway/webhook',
      'POST /api/auth/change-password',
    ]) {
      expect(routes, known).toContain(known);
    }
  });

  it('every public route in the allowlist is actually mounted', () => {
    const routes = new Set(listRoutes(app).map(key));
    for (const k of [...Object.keys(PUBLIC), ...SETUP]) expect(routes.has(k), k).toBe(true);
  });
});

describe('a temporary-password session is refused everywhere but setup', () => {
  for (const email of ['cashier.temp@test.local', 'owner.temp@test.local', 'atc.temp@test.local']) {
    it(`${email}: every non-setup, non-public route answers ${GATE}`, async () => {
      const { token, user } = await login(email, temp[email]);
      expect(user.mustChangePassword).toBe(true);

      const leaks = [];
      for (const r of listRoutes(app)) {
        const k = key(r);
        if (PUBLIC[k] || SETUP.has(k)) continue;
        const res = await request(app)[r.method.toLowerCase()](concrete(r.path)).set(auth(token)).send({});
        if (res.status !== 403 || res.body?.error?.code !== GATE) {
          leaks.push(`${k} → ${res.status} ${res.body?.error?.code ?? ''}`);
        }
      }
      expect(leaks, 'routes that answered a temporary password with something other than the gate').toEqual([]);

      // The way out is still open.
      const me = await request(app).get('/api/auth/me').set(auth(token));
      expect(me.status).toBe(200);
      expect(me.body.user.mustChangePassword).toBe(true);
    });
  }

  it('public routes never answer with the gate (they do not read a staff session at all)', async () => {
    const { token } = await login('manager.temp@test.local', temp['manager.temp@test.local']);
    for (const k of Object.keys(PUBLIC)) {
      const [method, path] = k.split(' ');
      const res = await request(app)[method.toLowerCase()](path).set(auth(token)).send({});
      expect(res.body?.error?.code, k).not.toBe(GATE);
      // Not the catch-all 404 either: the route really exists and answered.
      expect(res.body?.error?.code === 'POS_NOT_FOUND' && res.status === 404, k).toBe(false);
    }
    // A staff token, restricted or not, is still not a display credential.
    const display = await request(app).get('/api/display/state').set(auth(token));
    expect(display.status).toBe(401);
  });

  it('F-3 repro: POST /orders with a temporary password is refused and writes nothing', async () => {
    const { token } = await login('cashier.temp@test.local', temp['cashier.temp@test.local']);
    const before = await prisma.order.count();
    const res = await request(app)
      .post('/api/orders')
      .set(auth(token))
      .send({ type: 'TAKEAWAY', items: [{ productId: product.id, qty: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(GATE);
    expect(await prisma.order.count()).toBe(before);
    // Positive control: the same body from a normal cashier session IS accepted.
    const ok = await request(app)
      .post('/api/orders')
      .set(auth(cashierNormalToken))
      .send({ type: 'TAKEAWAY', items: [{ productId: product.id, qty: 1 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('the restricted session is short-lived; a normal one keeps the working-day TTL', async () => {
    const r = await login('cashier.temp@test.local', temp['cashier.temp@test.local']);
    const ttlMin = (new Date(r.sessionExpiresAt) - Date.now()) / 60000;
    expect(ttlMin).toBeGreaterThan(env.POS_TEMP_SESSION_TTL_MINUTES - 1);
    expect(ttlMin).toBeLessThanOrEqual(env.POS_TEMP_SESSION_TTL_MINUTES);
    const row = await prisma.posSession.findFirst({
      where: { user: { email: 'cashier.temp@test.local' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(Math.abs(row.expiresAt - new Date(r.sessionExpiresAt))).toBeLessThan(1000);

    const n = await login('cashier.normal@test.local');
    const hours = (new Date(n.sessionExpiresAt) - Date.now()) / 3600e3;
    expect(hours).toBeGreaterThan(env.SESSION_TTL_HOURS - 0.1);
  });

  it('logout works from a restricted session and revokes it', async () => {
    const { token } = await login('cashier.logout@test.local', temp['cashier.logout@test.local']);
    await request(app).post('/api/auth/logout').set(auth(token)).expect(200);
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(401);
  });
});

describe('changing the temporary password', () => {
  it('refuses a wrong current password and a "new" password equal to the temporary one', async () => {
    const email = 'cashier.rotate@test.local';
    const { token } = await login(email, temp[email]);
    const wrong = await request(app)
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'not-it-at-all', newPassword: 'brand-new-pw-1' });
    expect(wrong.status).toBe(400);
    const same = await request(app)
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: temp[email], newPassword: temp[email] });
    expect(same.status).toBe(400);
    expect(same.body.error.field).toBe('newPassword');
    const u = await prisma.posUser.findUnique({ where: { email } });
    expect(u.mustChangePassword).toBe(true);
  });

  it('retires the restricted session, issues a full one, and the work routes open', async () => {
    const email = 'cashier.rotate@test.local';
    const first = await login(email, temp[email]);
    const second = await login(email, temp[email]); // e.g. the copy someone else holds

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(auth(first.token))
      .send({ currentPassword: temp[email], newPassword: 'my-own-password-1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sessionRotated).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.token).not.toBe(first.token);
    // The cookie is replaced too — the browser path never reads res.body.token.
    expect(String(res.headers['set-cookie'])).toContain(`${env.SESSION_COOKIE_NAME}=${res.body.token}`);

    // Both restricted tokens are dead, including the one that made the change.
    expect((await request(app).get('/api/auth/me').set(auth(first.token))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(second.token))).status).toBe(401);

    const fresh = res.body.token;
    const hours = (new Date(res.body.sessionExpiresAt) - Date.now()) / 3600e3;
    expect(hours).toBeGreaterThan(env.SESSION_TTL_HOURS - 0.1);
    const me = await request(app).get('/api/auth/me').set(auth(fresh));
    expect(me.body.user.mustChangePassword).toBe(false);
    const order = await request(app)
      .post('/api/orders')
      .set(auth(fresh))
      .send({ type: 'DINE_IN', tableId: table.id, items: [{ productId: product.id, qty: 2 }] });
    expect(order.status, JSON.stringify(order.body)).toBe(201);

    // The temporary password no longer signs in; the new one does.
    const old = await request(app).post('/api/auth/login').send({ email, password: temp[email] });
    expect(old.status).toBe(401);
    await login(email, 'my-own-password-1');

    const logged = await prisma.posAuditLog.findFirst({
      where: { action: 'PASSWORD_CHANGED', actorEmail: email },
      orderBy: { at: 'desc' },
    });
    expect(logged.meta).toMatchObject({ firstLogin: true, sessionRotated: true });
  });

  it('a voluntary change keeps the session it was made from and ends the others', async () => {
    const a = await login('cashier.normal@test.local');
    const b = await login('cashier.normal@test.local');
    const res = await request(app)
      .post('/api/auth/change-password')
      .set(auth(a.token))
      .send({ currentPassword: PW, newPassword: 'changed-voluntarily-1' });
    try {
      expect(res.status).toBe(200);
      expect(res.body.sessionRotated).toBe(false);
      // A route this CASHIER can actually reach. /api/branches requires
      // org.store.read, which a cashier does not hold, so it answers 403 to a
      // perfectly good session — it would assert the permission system, not the
      // survival of the session.
      expect((await request(app).get('/api/orders').set(auth(a.token))).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set(auth(b.token))).status).toBe(401);
    } finally {
      // Put it back even if an assertion above failed: this account is shared
      // with the suites below, and leaving it on the changed password turns one
      // failure into three.
      await prisma.posUser.update({
        where: { email: 'cashier.normal@test.local' },
        data: { passwordHash: await hashPassword(PW) },
      });
      cashierNormalToken = (await login('cashier.normal@test.local')).token;
    }
  });
});

describe('the flag is read live, and displays are not staff sessions', () => {
  it('flagging an account mid-session gates its very next request', async () => {
    const { token } = await login('cashier.normal@test.local');
    expect((await request(app).get('/api/orders').set(auth(token))).status).toBe(200);
    await prisma.posUser.update({ where: { email: 'cashier.normal@test.local' }, data: { mustChangePassword: true } });
    try {
      const gated = await request(app).get('/api/orders').set(auth(token));
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe(GATE);
      expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(200);
    } finally {
      await prisma.posUser.update({ where: { email: 'cashier.normal@test.local' }, data: { mustChangePassword: false } });
    }
  });

  it('a paired customer display keeps polling: req.display never passes through the gate', async () => {
    const minted = await request(app).post('/api/display/pair-code').set(auth(cashierNormalToken)).send({});
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const paired = await request(app).post('/api/display/pair').send({ code: minted.body.code });
    expect(paired.status, JSON.stringify(paired.body)).toBe(201);
    const displayToken = paired.body.displayToken;

    expect((await request(app).get('/api/display/state').set(auth(displayToken))).status).toBe(200);
    // Even with the cashier flagged, the display (which can only mirror what
    // the — now gated — till points it at) keeps answering. It holds no staff
    // rights for the gate to take away.
    await prisma.posUser.update({ where: { email: 'cashier.normal@test.local' }, data: { mustChangePassword: true } });
    try {
      expect((await request(app).get('/api/display/state').set(auth(displayToken))).status).toBe(200);
      // ...while the till itself can no longer steer it.
      const steer = await request(app).put('/api/display/state').set(auth(cashierNormalToken)).send({ orderId: null });
      expect(steer.body.error.code).toBe(GATE);
    } finally {
      await prisma.posUser.update({ where: { email: 'cashier.normal@test.local' }, data: { mustChangePassword: false } });
    }
    // And a display token is still not a staff credential, gate or no gate.
    expect((await request(app).get('/api/orders').set(auth(displayToken))).status).toBe(401);
  });
});
