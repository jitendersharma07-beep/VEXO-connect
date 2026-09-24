// ATC POS foundation suite: authentication, cross-product token refusal,
// company and branch isolation, role gates, licence limits and expiry.
//
// Runs ONLY against a database whose name ends in _test — the guard below
// refuses anything else, because the suite truncates every table.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('foundation.test.js requires a DATABASE_URL ending in _test');
}

// Onboarding a customer owner is an INVITATION now, so this file needs a
// place for the message to land. Set before app.js is imported, because
// config/env.js reads the environment once at load and decides there whether
// mail is configured at all.
const sink = startSmtpSink({ port: 0 });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@test.local';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { env } = await import('../src/config/env.js');

const app = createApp();

// The accept token out of the message the sink actually received. The body is
// a base64 text/plain MIME part, so reading msg.raw directly finds nothing;
// the link carries the token in the URL fragment.
const inviteTokenFor = (to) => {
  const msg = [...sink.messages].reverse().find((m) => m.envelope.to.join(',').includes(to));
  if (!msg) throw new Error(`no message delivered to ${to}`);
  const part = msg.raw.split(/--=_vexo_[0-9a-f]+/).find((p) => p.includes('text/plain'));
  const body = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  const token = body.match(/https:\/\/\S+#([A-Za-z0-9_-]{20,})/)?.[1];
  if (!token) throw new Error(`no accept link in the message to ${to}`);
  return token;
};

const wipe = async () => {
  // Before PosUser and Branch, which it references. This file never creates a
  // DayClose, but it shares one test database with the files that do, and a
  // wipe that only clears its own tables leaves the other file's rows holding
  // a foreign key — so the failure lands here, in a suite that has nothing to
  // do with cash counts.
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  // Before Order: PaymentIntent references it ON DELETE RESTRICT, so an
  // order delete fails outright once any intent exists.
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  // Promotion tables before Order/Product/Category/Branch/Company — all four
  // point at them with RESTRICT foreign keys.
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
  // Before the three tables it points at. DiscountPolicy's foreign keys are
  // RESTRICT on purpose — a policy must not survive, or silently widen,
  // because its branch or user went away — so it has to go first here.
  await prisma.discountPolicy.deleteMany();
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
let atcAdmin, companyA, companyB, companyC, branchA1, branchA2, branchB1;
const tokens = {};

const mkUser = (data) => prisma.posUser.create({ data });

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: { name: 'Alpha Retail', slug: 'alpha-retail', licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 2, expiresAt: new Date(Date.now() + 86400e3) } } },
  });
  companyB = await prisma.company.create({
    data: { name: 'Bravo Foods', slug: 'bravo-foods', licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } } },
  });
  companyC = await prisma.company.create({
    data: { name: 'Charlie Expired', slug: 'charlie-expired', licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() - 86400e3) } } },
  });

  branchA1 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-FA-0001', name: 'Alpha One', code: 'A1' } });
  branchA2 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-FA-0002', name: 'Alpha Two', code: 'A2' } });
  branchB1 = await prisma.branch.create({ data: { companyId: companyB.id, publicId: 'VC-FA-0003', name: 'Bravo One', code: 'B1' } });
  await prisma.branch.create({ data: { companyId: companyC.id, publicId: 'VC-FA-0004', name: 'Charlie One', code: 'C1' } });

  atcAdmin = await mkUser({ email: 'atc@test.local', fullName: 'ATC Admin', role: 'POS_SUPER_ADMIN', passwordHash });
  await mkUser({ email: 'owner.a@test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id, passwordHash });
  await mkUser({ email: 'manager.a1@test.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id, passwordHash });
  await mkUser({ email: 'cashier.a1@test.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id, passwordHash });
  await mkUser({ email: 'owner.b@test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id, passwordHash });
  await mkUser({ email: 'owner.c@test.local', fullName: 'Owner C', role: 'CUSTOMER_OWNER', companyId: companyC.id, passwordHash });

  tokens.atc = await login('atc@test.local');
  tokens.ownerA = await login('owner.a@test.local');
  tokens.managerA1 = await login('manager.a1@test.local');
  tokens.cashierA1 = await login('cashier.a1@test.local');
  tokens.ownerB = await login('owner.b@test.local');
  tokens.ownerC = await login('owner.c@test.local');
});

afterAll(async () => {
  await sink.close();
  await prisma.$disconnect();
});

describe('authentication', () => {
  it('rejects a wrong password and an unknown email identically', async () => {
    const bad = await request(app).post('/api/auth/login').send({ email: 'owner.a@test.local', password: 'wrong-password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('answers /auth/me for a valid session (positive control)', async () => {
    const res = await request(app).get('/api/auth/me').set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner.a@test.local');
    expect(res.body.company.slug).toBe('alpha-retail');
    expect(res.body.license.plan).toBe('MULTI_STORE');
  });

  it('rejects no token / garbage token', async () => {
    const none = await request(app).get('/api/auth/me');
    const garbage = await request(app).get('/api/auth/me').set({ Authorization: 'Bearer not-a-jwt' });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('POS_UNAUTHENTICATED');
    expect(garbage.status).toBe(401);
  });

  it('rejects a token signed by another ATC product exactly like a garbage token', async () => {
    // Simulates an ATC NOC / Megatel / AGR token: valid JWT shape, real user id,
    // wrong signing key. It must fail SIGNATURE verification (same message as
    // garbage), proving the boundary is the key, not the payload.
    const foreign = jwt.sign({ sub: atcAdmin.id, role: 'POS_SUPER_ADMIN' }, 'x'.repeat(48), { issuer: 'atc-pos', expiresIn: '1h' });
    const res = await request(app).get('/api/auth/me').set(auth(foreign));
    const garbage = await request(app).get('/api/auth/me').set({ Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(garbage.body.error.message);
  });

  it('rejects a correctly-signed token with no session row (revocation works)', async () => {
    const forged = jwt.sign({ sub: atcAdmin.id, role: 'POS_SUPER_ADMIN' }, env.POS_JWT_SECRET, { issuer: 'atc-pos', expiresIn: '1h' });
    const res = await request(app).get('/api/auth/me').set(auth(forged));
    expect(res.status).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const t = await login('owner.b@test.local');
    await request(app).post('/api/auth/logout').set(auth(t)).expect(200);
    const after = await request(app).get('/api/auth/me').set(auth(t));
    expect(after.status).toBe(401);
  });

  it('records the client behind two proxies, not the proxy, and ignores a forged claim', async () => {
    // Production puts two nginx hops in front of this app — the host one for
    // atcworkspace.com and the one in the frontend container — and each
    // APPENDS to X-Forwarded-For. So the shape the app really sees is
    // "<client>, <docker gateway>", and the client is second from the right.
    //
    // This is not only about the audit column. `req.ip` keys both rate
    // limiters, so reading the proxy here gives every till in the café one
    // shared login-failure budget.
    const CLIENT = '203.0.113.77'; // TEST-NET-3, never a real host
    const HOP = '172.28.0.1'; // what the container nginx appends
    const FORGED = '198.51.100.9'; // what an attacker would inject

    const res = await request(app)
      .post('/api/auth/login')
      // The attacker's value is already in the header when the first proxy
      // receives it, so it ends up LEFT of both appended entries.
      .set('X-Forwarded-For', `${FORGED}, ${CLIENT}, ${HOP}`)
      // Set by the container nginx to its own view, and wrong on purpose:
      // if this header ever wins again, this assertion fails.
      .set('X-Real-IP', HOP)
      .send({ email: 'owner.b@test.local', password: PW });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const session = await prisma.posSession.findFirst({
      where: { user: { email: 'owner.b@test.local' } },
      orderBy: { createdAt: 'desc' },
      select: { ip: true },
    });
    expect(session.ip).toBe(CLIENT);
    expect(session.ip).not.toBe(HOP);
    expect(session.ip).not.toBe(FORGED);

    const logged = await prisma.posAuditLog.findFirst({
      where: { action: 'LOGIN_SUCCESS' },
      orderBy: { at: 'desc' },
      select: { ip: true },
    });
    expect(logged.ip).toBe(CLIENT);
  });
});

describe('company isolation', () => {
  it('lists only the caller company branches', async () => {
    const res = await request(app).get('/api/branches').set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    const codes = res.body.branches.map((b) => b.code).sort();
    expect(codes).toEqual(['A1', 'A2']);
  });

  it('answers 404 for another company branch — indistinguishable from absent', async () => {
    const cross = await request(app).get(`/api/branches/${branchB1.id}`).set(auth(tokens.ownerA));
    const absent = await request(app).get('/api/branches/nonexistent-id').set(auth(tokens.ownerA));
    expect(cross.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(cross.body.error.code).toBe(absent.body.error.code);
    // Positive control: the same row IS served to its own company.
    const own = await request(app).get(`/api/branches/${branchB1.id}`).set(auth(tokens.ownerB));
    expect(own.status).toBe(200);
  });

  it('ignores client-supplied companyId for customer principals', async () => {
    const res = await request(app).get(`/api/branches?companyId=${companyB.id}`).set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.branches.every((b) => ['A1', 'A2'].includes(b.code))).toBe(true);
  });

  it('user listing is company-scoped', async () => {
    const res = await request(app).get('/api/users').set(auth(tokens.ownerB));
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.email)).toEqual(['owner.b@test.local']);
  });
});

describe('branch scoping', () => {
  it('branch-pinned roles list only their own branch', async () => {
    const mgr = await request(app).get('/api/branches').set(auth(tokens.managerA1));
    expect(mgr.body.branches.map((b) => b.code)).toEqual(['A1']);
    // The Phase 1 catalog keeps org.store.read from CASHIER: a till login
    // sells; it does not browse the organisation's stores.
    const cash = await request(app).get('/api/branches').set(auth(tokens.cashierA1));
    expect(cash.status).toBe(403);
  });

  it('a branch-pinned manager reading a sibling branch is refused as forbidden, not hidden', async () => {
    const own = await request(app).get(`/api/branches/${branchA1.id}`).set(auth(tokens.managerA1));
    expect(own.status).toBe(200);
    const sibling = await request(app).get(`/api/branches/${branchA2.id}`).set(auth(tokens.managerA1));
    expect(sibling.status).toBe(403);
    expect(sibling.body.error.code).toBe('POS_FORBIDDEN');
  });
});

describe('role gates', () => {
  it('cashier cannot create branches or list users', async () => {
    const b = await request(app).post('/api/branches').set(auth(tokens.cashierA1)).send({ name: 'Rogue', code: 'RG' });
    expect(b.status).toBe(403);
    const u = await request(app).get('/api/users').set(auth(tokens.cashierA1));
    expect(u.status).toBe(403);
  });

  it('customer owner cannot reach the ATC console', async () => {
    const res = await request(app).get('/api/atc/companies').set(auth(tokens.ownerA));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/VEXO Connect administrators/);
  });

  it('ATC operator must name a company on scoped routes', async () => {
    const missing = await request(app).get('/api/branches').set(auth(tokens.atc));
    expect(missing.status).toBe(400);
    const scoped = await request(app).get(`/api/branches?companyId=${companyB.id}`).set(auth(tokens.atc));
    expect(scoped.status).toBe(200);
    expect(scoped.body.branches.map((b) => b.code)).toEqual(['B1']);
  });
});

describe('licensing', () => {
  it('branch create stops at the licence limit and resumes after an ATC add-on', async () => {
    // Company A: MULTI_STORE base 2, already has A1+A2 active.
    const blocked = await request(app).post('/api/branches').set(auth(tokens.ownerA)).send({ name: 'Alpha Three', code: 'A3' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/licence allows 2/);

    const license = await prisma.license.findFirst({ where: { companyId: companyA.id } });
    const addon = await request(app)
      .post(`/api/atc/licenses/${license.id}/addons`)
      .set(auth(tokens.atc))
      .send({ quantity: 1 });
    expect(addon.status).toBe(201);

    const allowed = await request(app).post('/api/branches').set(auth(tokens.ownerA)).send({ name: 'Alpha Three', code: 'A3' });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect(allowed.body.branch.code).toBe('A3');
  });

  it('an expired licence blocks mutations but not reads or sign-in', async () => {
    const reads = await request(app).get('/api/branches').set(auth(tokens.ownerC));
    expect(reads.status).toBe(200);
    const write = await request(app).post('/api/branches').set(auth(tokens.ownerC)).send({ name: 'New C', code: 'C2' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('POS_LICENSE_EXPIRED');
  });

  it('licence status is reported through /api/license', async () => {
    const res = await request(app).get('/api/license').set(auth(tokens.ownerC));
    expect(res.status).toBe(200);
    expect(res.body.license.status).toBe('EXPIRED');
  });
});

describe('ATC console lifecycle', () => {
  it('creates a company, licence and owner; the owner can sign in and is isolated', async () => {
    const c = await request(app)
      .post('/api/atc/companies')
      .set(auth(tokens.atc))
      .send({ name: 'Delta Traders', slug: 'delta-traders' });
    expect(c.status).toBe(201);
    const companyId = c.body.company.id;

    const lic = await request(app)
      .post(`/api/atc/companies/${companyId}/licenses`)
      .set(auth(tokens.atc))
      .send({ plan: 'SINGLE_STORE', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() });
    expect(lic.status).toBe(201);
    expect(lic.body.license.branchLimit).toBe(1);

    // The owner arrives by INVITATION. This endpoint used to mint a temporary
    // password and return it here, which made the owner's first credential
    // something VEXO chose, saw, and then had to transmit to an address nobody
    // had proved the customer controlled.
    const owner = await request(app)
      .post(`/api/atc/companies/${companyId}/owner`)
      .set(auth(tokens.atc))
      .send({ email: 'owner.d@test.local', fullName: 'Owner D' });
    expect(owner.status).toBe(201);
    expect(owner.body.invitation.email).toBe('owner.d@test.local');
    // No credential in the response, and no account yet either: the company has
    // an owner only once the person on the other end proves the mailbox.
    expect(owner.body.tempPassword).toBeUndefined();
    expect(JSON.stringify(owner.body)).not.toMatch(/https?:\/\//);
    expect(await prisma.posUser.count({ where: { email: 'owner.d@test.local' } })).toBe(0);

    // The token is read out of the message that was actually delivered — never
    // fabricated — so this proves the link in the mailbox is the one honoured.
    const token = inviteTokenFor('owner.d@test.local');
    const accepted = await request(app)
      .post('/api/invite/accept')
      .send({ token, password: 'owner-d-chose-this-1' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'owner.d@test.local', password: 'owner-d-chose-this-1' });
    expect(loginRes.status).toBe(200);
    // Nothing to force a change of: they chose it themselves, and nobody else
    // has ever seen it.
    expect(loginRes.body.user.mustChangePassword).toBe(false);

    const branches = await request(app).get('/api/branches').set(auth(loginRes.body.token));
    expect(branches.status).toBe(200);
    expect(branches.body.branches).toEqual([]);
  });

  it('audits what ATC changes, and records nothing when ATC only looks', async () => {
    const co = await request(app)
      .post('/api/atc/companies')
      .set(auth(tokens.atc))
      .send({ name: 'Echo Foods', slug: 'echo-foods' });
    expect(co.status).toBe(201);
    const companyId = co.body.company.id;

    await request(app)
      .post(`/api/atc/companies/${companyId}/licenses`)
      .set(auth(tokens.atc))
      .send({ plan: 'SINGLE_STORE', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() });

    const written = await prisma.posAuditLog.findMany({
      where: { companyId, action: { in: ['COMPANY_CREATE', 'LICENSE_ISSUE'] } },
      select: { action: true, actorEmail: true },
    });
    // Both actions, each naming the human who took it. Until this existed the
    // ATC audit path was code nobody had watched run: production holds zero
    // rows for any ATC action, because its one tenant was seeded straight into
    // the database rather than created through this route.
    expect(written.map((r) => r.action).sort()).toEqual(['COMPANY_CREATE', 'LICENSE_ISSUE']);
    expect(new Set(written.map((r) => r.actorEmail))).toEqual(new Set(['atc@test.local']));

    // The other half, and the reason HANDOVER.md no longer says "every ATC
    // access is logged": reads are not. This GET returns the tenant's staff
    // emails, roles and last-login times and leaves no trace.
    const before = await prisma.posAuditLog.count({ where: { companyId } });
    const look = await request(app)
      .get(`/api/atc/companies/${companyId}`)
      .set(auth(tokens.atc));
    expect(look.status).toBe(200);
    expect(look.body.users).toBeDefined();
    expect(await prisma.posAuditLog.count({ where: { companyId } })).toBe(before);
    // This pins a documented gap (§9), not a desired behaviour. If read
    // auditing is added, this assertion is what tells you to go correct the
    // doc — delete it, do not weaken it.
  });

  it('suspending a company revokes its sessions and blocks sign-in', async () => {
    const t = await login('owner.b@test.local');
    const sus = await request(app)
      .patch(`/api/atc/companies/${companyB.id}/status`)
      .set(auth(tokens.atc))
      .send({ status: 'SUSPENDED' });
    expect(sus.status).toBe(200);

    const after = await request(app).get('/api/auth/me').set(auth(t));
    expect([401, 403]).toContain(after.status);

    const relog = await request(app).post('/api/auth/login').send({ email: 'owner.b@test.local', password: PW });
    expect(relog.status).toBe(401);

    // Restore for any later assertions.
    await request(app)
      .patch(`/api/atc/companies/${companyB.id}/status`)
      .set(auth(tokens.atc))
      .send({ status: 'ACTIVE' });
  });
});
