// LANE foundation — people and authority (spec B§5): /api/users under
// action-gating, placement rules, the no-escalation reach rule, permission
// rules against the role ceiling, store assignments and support grants.
//
// Runs ONLY against a database whose name ends in _test — the guard below
// refuses anything else, because the suite truncates every table.
//
// This file is the first to create rows in the foundation-lane tables
// (regions, assignments, rules, grants). Their foreign keys are RESTRICT, and
// the older test files' wipes do not know these tables exist — so this file
// wipes them itself on the way in AND on the way out, leaving the shared test
// database exactly as the next file expects to find it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('foundationPeople.test.js requires a DATABASE_URL ending in _test');
}

// LANE accounts — a real SMTP server, because neither write path in
// /api/users hands back a credential any more. Creating a person and resetting
// one both end in a message to that person, so a suite with nowhere to deliver
// would be asserting against a 503 rather than against the behaviour.
//
// Started BEFORE config/env.js is read, so SMTP_PORT can name the port the
// kernel just handed out.
const sink = startSmtpSink({ port: 0 });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@people.test.local';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

// The code is read out of the message the sink actually received — never
// fabricated, never taken from a response body, because the whole point of the
// change under test is that no response body carries one.
const bodyOfLastMail = (to) => {
  const msg = [...sink.messages].reverse().find((m) => m.envelope.to.join(',').includes(to));
  if (!msg) throw new Error(`no message delivered to ${to}`);
  const parts = msg.raw.split(/--=_vexo_[0-9a-f]+/);
  const plain = parts.find((p) => p.includes('text/plain'));
  return Buffer.from(plain.slice(plain.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
};

const codeFor = (email) => {
  const found = bodyOfLastMail(email).match(/\b(\d{8})\b/);
  if (!found) throw new Error(`no 8-digit code in the message to ${email}`);
  return found[1];
};

// The full journey a person takes from an administrator's button press to a
// password of their own: the code lands in their mailbox, they verify it, they
// choose. Exactly the steps /forgot-password walks them through.
const setPasswordByEmailedCode = async (email, password) => {
  const verify = await request(app)
    .post('/api/auth/forgot-password/verify')
    .send({ email, code: codeFor(email) });
  expect(verify.status, JSON.stringify(verify.body)).toBe(200);
  const reset = await request(app)
    .post('/api/auth/forgot-password/reset')
    .send({ resetToken: verify.body.resetToken, password });
  expect(reset.status, JSON.stringify(reset.body)).toBe(200);
};

const app = createApp();

const wipe = async () => {
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
  await prisma.discountPolicy.deleteMany();
  // Foundation-lane tables. Every FK is RESTRICT, so these go before the
  // users, branches and companies they point at.
  await prisma.supportAccessGrant.deleteMany();
  await prisma.permissionRule.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.device.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.branchBrand.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.userInvitation.deleteMany();
  await prisma.emailOutbox.deleteMany();
  await prisma.authChallenge.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  // GST points at LegalEntity (RESTRICT), both point at Company; and a nested
  // region cannot outlive its parent's delete, so children go first.
  await prisma.gstRegistration.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.region.deleteMany({ where: { parentId: { not: null } } });
  await prisma.region.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'people-password-1';
let companyX, companyY, companyZ, branchX1, branchX2, branchY1, regionX, regionY;
let ownerX, adminX, cashierX1, cashierZ, atcAdmin;
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const auth = (t) => ({ Authorization: `Bearer ${t}` });
// Platform principals act inside a named tenant.
const atcAuth = (companyId) => ({ ...auth(tokens.atc), 'x-pos-company': companyId });

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyX = await prisma.company.create({
    data: { name: 'People Retail', slug: 'people-retail', licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 86400e3) } } },
  });
  companyY = await prisma.company.create({
    data: { name: 'People Bystander', slug: 'people-bystander', licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) } } },
  });
  companyZ = await prisma.company.create({
    data: { name: 'People Lapsed', slug: 'people-lapsed', licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() - 86400e3) } } },
  });

  regionX = await prisma.region.create({ data: { companyId: companyX.id, name: 'North', code: 'NORTH' } });
  regionY = await prisma.region.create({ data: { companyId: companyY.id, name: 'Elsewhere', code: 'ELSE' } });

  branchX1 = await prisma.branch.create({ data: { companyId: companyX.id, publicId: 'VC-FP-0001', name: 'People One', code: 'PX1' } });
  branchX2 = await prisma.branch.create({ data: { companyId: companyX.id, publicId: 'VC-FP-0002', name: 'People Two', code: 'PX2', regionId: regionX.id } });
  branchY1 = await prisma.branch.create({ data: { companyId: companyY.id, publicId: 'VC-FP-0003', name: 'Bystander One', code: 'PY1' } });
  await prisma.branch.create({ data: { companyId: companyZ.id, publicId: 'VC-FP-0004', name: 'Lapsed One', code: 'PZ1' } });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  atcAdmin = await mk({ email: 'atc@people.test.local', fullName: 'ATC People', role: 'POS_SUPER_ADMIN' });
  ownerX = await mk({ email: 'owner.x@people.test.local', fullName: 'Owner X', role: 'CUSTOMER_OWNER', companyId: companyX.id });
  adminX = await mk({ email: 'admin.x@people.test.local', fullName: 'Admin X', role: 'COMPANY_ADMIN', companyId: companyX.id });
  await mk({ email: 'auditor.x@people.test.local', fullName: 'Auditor X', role: 'AUDITOR', companyId: companyX.id });
  await mk({ email: 'manager.x1@people.test.local', fullName: 'Manager X1', role: 'BRANCH_MANAGER', companyId: companyX.id, branchId: branchX1.id });
  cashierX1 = await mk({ email: 'cashier.x1@people.test.local', fullName: 'Cashier X1', role: 'CASHIER', companyId: companyX.id, branchId: branchX1.id });
  await mk({ email: 'cashier.x2@people.test.local', fullName: 'Cashier X2', role: 'CASHIER', companyId: companyX.id, branchId: branchX2.id });
  await mk({ email: 'rm.x@people.test.local', fullName: 'RM X', role: 'REGIONAL_MANAGER', companyId: companyX.id, regionId: regionX.id });
  await mk({ email: 'owner.y@people.test.local', fullName: 'Owner Y', role: 'CUSTOMER_OWNER', companyId: companyY.id });
  await mk({ email: 'owner.z@people.test.local', fullName: 'Owner Z', role: 'CUSTOMER_OWNER', companyId: companyZ.id });
  cashierZ = await mk({ email: 'cashier.z@people.test.local', fullName: 'Cashier Z', role: 'CASHIER', companyId: companyZ.id });

  tokens.atc = await login('atc@people.test.local');
  tokens.ownerX = await login('owner.x@people.test.local');
  tokens.adminX = await login('admin.x@people.test.local');
  tokens.auditorX = await login('auditor.x@people.test.local');
  tokens.managerX1 = await login('manager.x1@people.test.local');
  tokens.cashierX1 = await login('cashier.x1@people.test.local');
  tokens.rmX = await login('rm.x@people.test.local');
  tokens.ownerY = await login('owner.y@people.test.local');
  tokens.ownerZ = await login('owner.z@people.test.local');
});

afterAll(async () => {
  // Leave the shared test database empty: the older files' wipes do not cover
  // this lane's tables, and their RESTRICT keys would fail on our leftovers.
  await wipe();
  await sink.close();
  await prisma.$disconnect();
});

describe('people: listing and scope', () => {
  it('company-wide callers see the whole tenant, and only the tenant', async () => {
    const res = await request(app).get('/api/users').set(auth(tokens.ownerX));
    expect(res.status).toBe(200);
    const emails = res.body.users.map((u) => u.email).sort();
    expect(emails).toEqual([
      'admin.x@people.test.local',
      'auditor.x@people.test.local',
      'cashier.x1@people.test.local',
      'cashier.x2@people.test.local',
      'manager.x1@people.test.local',
      'owner.x@people.test.local',
      'rm.x@people.test.local',
    ]);
  });

  it('a store-pinned manager sees only the people of their store (and themselves)', async () => {
    const res = await request(app).get('/api/users').set(auth(tokens.managerX1));
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.email).sort()).toEqual([
      'cashier.x1@people.test.local',
      'manager.x1@people.test.local',
    ]);
  });

  it('a regional manager sees the people of their region', async () => {
    const res = await request(app).get('/api/users').set(auth(tokens.rmX));
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.email).sort()).toEqual([
      'cashier.x2@people.test.local',
      'rm.x@people.test.local',
    ]);
  });

  it('a cashier holds no user.read and is refused outright', async () => {
    const res = await request(app).get('/api/users').set(auth(tokens.cashierX1));
    expect(res.status).toBe(403);
  });

  it('an auditor reads the list but cannot write to it', async () => {
    const list = await request(app).get('/api/users').set(auth(tokens.auditorX));
    expect(list.status).toBe(200);
    expect(list.body.assignableRoles).toEqual([]);
    const create = await request(app)
      .post('/api/users')
      .set(auth(tokens.auditorX))
      .send({ email: 'nope@people.test.local', fullName: 'Nope', role: 'CASHIER', branchId: branchX1.id });
    expect(create.status).toBe(403);
  });

  it('assignableRoles is the reach rule made visible: owner may hand out owner, admin may not', async () => {
    const owner = await request(app).get('/api/users').set(auth(tokens.ownerX));
    expect(owner.body.assignableRoles).toContain('CUSTOMER_OWNER');
    expect(owner.body.assignableRoles).toContain('COMPANY_ADMIN');
    const admin = await request(app).get('/api/users').set(auth(tokens.adminX));
    expect(admin.body.assignableRoles).not.toContain('CUSTOMER_OWNER');
    expect(admin.body.assignableRoles).toContain('COMPANY_ADMIN');
    expect(admin.body.assignableRoles).toContain('CASHIER');
  });
});

describe('people: minting within reach', () => {
  it('an admin mints a cashier: 201, no credential in the response, a code to the person', async () => {
    const email = 'new.cashier@people.test.local';
    const res = await request(app)
      .post('/api/users')
      .set(auth(tokens.adminX))
      .send({ email, fullName: 'New Cashier', role: 'CASHIER', branchId: branchX1.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.user.role).toBe('CASHIER');
    expect(res.body.user.branch.code).toBe('PX1');
    // Stands for "has not chosen one yet". There is nothing to change FROM.
    expect(res.body.user.mustChangePassword).toBe(true);

    // The response tells the administrator a code is on its way and nothing
    // more. This is the assertion the whole change exists for: the endpoint
    // used to return a working password here.
    const code = codeFor(email);
    expect(res.body.passwordSetup).toMatchObject({ sent: true, sentTo: email, codeLength: 8 });
    expect(JSON.stringify(res.body)).not.toContain(code);

    // The account is real and completely unreachable: no password was chosen,
    // so no password works. The code is not a password either — it buys one
    // step of the recovery flow and nothing else.
    for (const guess of [code, 'password123', 'new.cashier']) {
      const attempt = await request(app).post('/api/auth/login').send({ email, password: guess });
      expect(attempt.status, `login accepted "${guess}"`).toBe(401);
    }

    // The person sets their own, from the mailbox, and only then can sign in.
    await setPasswordByEmailedCode(email, 'chosen-by-the-cashier-1');
    const signedIn = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'chosen-by-the-cashier-1' });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect(signedIn.body.user.mustChangePassword).toBe(false);

    // Nothing secret reached the trail or the outbox row.
    const logged = await prisma.posAuditLog.findFirst({
      where: { action: 'USER_CREATE', entityId: res.body.user.id },
    });
    expect(logged).toBeTruthy();
    expect(JSON.stringify(logged.meta)).not.toContain(code);
    const outbox = await prisma.emailOutbox.findFirst({ where: { to: email }, orderBy: { createdAt: 'desc' } });
    expect(outbox.status).toBe('SENT');
    expect(JSON.stringify(outbox)).not.toContain(code);
    expect(JSON.stringify(outbox)).not.toContain('chosen-by-the-cashier-1');
  });

  it('an admin cannot mint an owner — role standing, before any action math', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(tokens.adminX))
      .send({ email: 'fake.owner@people.test.local', fullName: 'Fake Owner', role: 'CUSTOMER_OWNER' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the account owner can create or change an owner account');
  });

  it('a DENY rule narrows what the admin can hand out: no minting a role that holds the denied action', async () => {
    const rule = await request(app)
      .put('/api/permissions/rules')
      .set(auth(tokens.ownerX))
      .send({ level: 'USER', userId: adminX.id, action: 'org.region.write', effect: 'DENY' });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    const res = await request(app)
      .post('/api/users')
      .set(auth(tokens.adminX))
      .send({ email: 'peer.admin@people.test.local', fullName: 'Peer Admin', role: 'COMPANY_ADMIN' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/would hold permissions you do not/);
    // Rule removed, the same mint goes through — the refusal was the rule, not the role.
    const clear = await request(app)
      .delete(`/api/permissions/rules/${rule.body.rule.id}`)
      .set(auth(tokens.ownerX));
    expect(clear.status).toBe(200);
    const retry = await request(app)
      .post('/api/users')
      .set(auth(tokens.adminX))
      .send({ email: 'peer.admin@people.test.local', fullName: 'Peer Admin', role: 'COMPANY_ADMIN' });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  });

  it('placement: a store-pinned role needs an in-scope store, nothing else', async () => {
    const noStore = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'p1@people.test.local', fullName: 'P One', role: 'CASHIER' });
    expect(noStore.status).toBe(400);
    const withRegion = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'p2@people.test.local', fullName: 'P Two', role: 'CASHIER', regionId: regionX.id });
    expect(withRegion.status).toBe(400);
    // Another tenant's store reads exactly like no store at all.
    const foreignStore = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'p3@people.test.local', fullName: 'P Three', role: 'CASHIER', branchId: branchY1.id });
    expect(foreignStore.status).toBe(404);
    expect(foreignStore.body.error.message).toBe('Store not found');
  });

  it('placement: a regional manager needs an ACTIVE region of this tenant', async () => {
    const noRegion = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'r1@people.test.local', fullName: 'R One', role: 'REGIONAL_MANAGER' });
    expect(noRegion.status).toBe(400);
    const withStore = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'r2@people.test.local', fullName: 'R Two', role: 'REGIONAL_MANAGER', branchId: branchX1.id });
    expect(withStore.status).toBe(400);
    const foreignRegion = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'r3@people.test.local', fullName: 'R Three', role: 'REGIONAL_MANAGER', regionId: regionY.id });
    expect(foreignRegion.status).toBe(404);
    expect(foreignRegion.body.error.message).toBe('Region not found');
    const ok = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'rm2.x@people.test.local', fullName: 'RM Two', role: 'REGIONAL_MANAGER', regionId: regionX.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.user.region.code).toBe('NORTH');
  });

  it('placement: a company role takes neither store nor region', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'f1@people.test.local', fullName: 'F One', role: 'FINANCE', branchId: branchX1.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/company-wide/);
  });

  it('refuses a duplicate email and the platform role by name', async () => {
    const dup = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: cashierX1.email, fullName: 'Dup', role: 'CASHIER', branchId: branchX1.id });
    expect(dup.status).toBe(409);
    const platform = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'sneak@people.test.local', fullName: 'Sneak', role: 'POS_SUPER_ADMIN' });
    expect(platform.status).toBe(400);
  });
});

describe('people: editing, owner standing and the last-owner lockout', () => {
  let owner2;

  it('the owner mints a second owner; an admin cannot touch either owner account', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerX))
      .send({ email: 'owner2.x@people.test.local', fullName: 'Owner Two', role: 'CUSTOMER_OWNER' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    owner2 = res.body.user;
    const rename = await request(app)
      .patch(`/api/users/${owner2.id}`)
      .set(auth(tokens.adminX))
      .send({ fullName: 'Renamed By Admin' });
    expect(rename.status).toBe(403);
    expect(rename.body.error.message).toBe('Only the account owner can create or change an owner account');
  });

  it('nobody changes their own role or placement — name changes stay allowed', async () => {
    const role = await request(app)
      .patch(`/api/users/${ownerX.id}`)
      .set(auth(tokens.ownerX))
      .send({ role: 'COMPANY_ADMIN' });
    expect(role.status).toBe(403);
    expect(role.body.error.message).toBe('You cannot change your own role or where it applies');
    const name = await request(app)
      .patch(`/api/users/${ownerX.id}`)
      .set(auth(tokens.ownerX))
      .send({ fullName: 'Owner X Renamed' });
    expect(name.status).toBe(200);
    expect(name.body.user.fullName).toBe('Owner X Renamed');
  });

  it('demoting an owner is allowed while another active owner remains', async () => {
    const res = await request(app)
      .patch(`/api/users/${owner2.id}`)
      .set(auth(tokens.ownerX))
      .send({ role: 'FINANCE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user.role).toBe('FINANCE');
  });

  it('the last active owner can be disabled by nobody — not even the platform', async () => {
    const res = await request(app)
      .patch(`/api/users/${ownerX.id}/status`)
      .set(atcAuth(companyX.id))
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/only active owner/);
  });

  it('self-disable is refused regardless of role', async () => {
    const res = await request(app)
      .patch(`/api/users/${ownerX.id}/status`)
      .set(auth(tokens.ownerX))
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(400);
  });

  it('a cross-tenant target reads exactly like an absent one', async () => {
    const ownerYRow = await prisma.posUser.findUnique({ where: { email: 'owner.y@people.test.local' } });
    const cross = await request(app)
      .patch(`/api/users/${ownerYRow.id}`)
      .set(auth(tokens.ownerX))
      .send({ fullName: 'Hijacked' });
    const absent = await request(app)
      .patch('/api/users/nonexistent-id')
      .set(auth(tokens.ownerX))
      .send({ fullName: 'Hijacked' });
    expect(cross.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(cross.body.error.message).toBe(absent.body.error.message);
  });

  it('a role change keeps the store only where the new role can use it', async () => {
    const target = await prisma.posUser.findUnique({ where: { email: 'new.cashier@people.test.local' } });
    // Store role → store role: the pin survives without being restated.
    const promote = await request(app)
      .patch(`/api/users/${target.id}`)
      .set(auth(tokens.adminX))
      .send({ role: 'BRANCH_MANAGER' });
    expect(promote.status, JSON.stringify(promote.body)).toBe(200);
    expect(promote.body.user.branch.code).toBe('PX1');
    // Store role → company role: the pin is dropped, not smuggled along.
    const toCompany = await request(app)
      .patch(`/api/users/${target.id}`)
      .set(auth(tokens.adminX))
      .send({ role: 'FINANCE' });
    expect(toCompany.status, JSON.stringify(toCompany.body)).toBe(200);
    expect(toCompany.body.user.branch).toBeNull();
  });
});

describe('people: password reset and disable revoke sessions', () => {
  it('a reset cuts the credential, revokes every session, and hands the caller nothing', async () => {
    // A dedicated victim, used by no other test: the rotation below is this
    // test's whole point, and doing it to a shared fixture would turn any
    // mid-test assertion failure into a 401 cascade through every later test
    // that logs that fixture in. An extra row needs no restore step at all —
    // there is nothing to hand back.
    const victim = await prisma.posUser.create({
      data: {
        email: 'reset.victim@people.test.local',
        fullName: 'Reset Victim',
        role: 'CASHIER',
        companyId: companyX.id,
        branchId: branchX1.id,
        passwordHash: await hashPassword(PW),
      },
    });
    const victimToken = await login(victim.email);
    const res = await request(app)
      .post(`/api/users/${victim.id}/reset-password`)
      .set(auth(tokens.ownerX));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.email).toBe(victim.email);
    expect(res.body.passwordReset).toMatchObject({ sent: true, sentTo: victim.email, codeLength: 8 });

    // The old session died with the credential.
    const stale = await request(app).get('/api/auth/me').set(auth(victimToken));
    expect(stale.status).toBe(401);

    // And so did the password. This is a CUT, not a handover: the owner who
    // pressed the button holds nothing that signs in as the victim, and the
    // password the victim had is gone too.
    const oldPassword = await request(app).post('/api/auth/login').send({ email: victim.email, password: PW });
    expect(oldPassword.status).toBe(401);
    const code = codeFor(victim.email);
    expect(JSON.stringify(res.body)).not.toContain(code);

    // Only the mailbox gets them back in, and what they choose is theirs.
    await setPasswordByEmailedCode(victim.email, 'victim-picked-this-1');
    const back = await request(app)
      .post('/api/auth/login')
      .send({ email: victim.email, password: 'victim-picked-this-1' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.user.mustChangePassword).toBe(false);

    const logged = await prisma.posAuditLog.findFirst({
      where: { action: 'USER_PASSWORD_RESET', entityId: victim.id },
      orderBy: { at: 'desc' },
    });
    expect(logged).toBeTruthy();
    expect(JSON.stringify(logged.meta)).not.toContain(code);
    // Nothing anywhere in the sink's traffic carries the password they chose.
    for (const msg of sink.messages) expect(msg.raw).not.toContain('victim-picked-this-1');
  });

  it('a disabled account is not reset back to life — it is enabled first, or not at all', async () => {
    const shutOut = await prisma.posUser.create({
      data: {
        email: 'shut.out@people.test.local',
        fullName: 'Shut Out',
        role: 'CASHIER',
        companyId: companyX.id,
        branchId: branchX1.id,
        status: 'DISABLED',
        passwordHash: await hashPassword(PW),
      },
    });
    const res = await request(app)
      .post(`/api/users/${shutOut.id}/reset-password`)
      .set(auth(tokens.ownerX));
    // Refused rather than silently issuing a code the verify step would reject:
    // recovery deliberately passes over disabled accounts, so a code sent here
    // could never be spent and the administrator would wait for a sign-in that
    // was never coming.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/disabled/i);
    expect(await prisma.authChallenge.count({ where: { userId: shutOut.id } })).toBe(0);
  });

  it('you reset other people, never yourself; a cashier resets nobody', async () => {
    const self = await request(app)
      .post(`/api/users/${ownerX.id}/reset-password`)
      .set(auth(tokens.ownerX));
    expect(self.status).toBe(400);
    const cashierToken = await login('cashier.x1@people.test.local');
    const cashier = await request(app)
      .post(`/api/users/${adminX.id}/reset-password`)
      .set(auth(cashierToken));
    expect(cashier.status).toBe(403);
  });

  it('disabling revokes sessions immediately; enabling lets the person back in', async () => {
    const t = await login('cashier.x1@people.test.local');
    const off = await request(app)
      .patch(`/api/users/${cashierX1.id}/status`)
      .set(auth(tokens.ownerX))
      .send({ status: 'DISABLED' });
    expect(off.status).toBe(200);
    expect(off.body.user.status).toBe('DISABLED');
    expect((await request(app).get('/api/auth/me').set(auth(t))).status).toBe(401);
    const on = await request(app)
      .patch(`/api/users/${cashierX1.id}/status`)
      .set(auth(tokens.ownerX))
      .send({ status: 'ACTIVE' });
    expect(on.status).toBe(200);
    expect((await login('cashier.x1@people.test.local')).length).toBeGreaterThan(0);
  });

  it('an expired licence blocks hiring but never the security operations', async () => {
    const hire = await request(app)
      .post('/api/users')
      .set(auth(tokens.ownerZ))
      .send({ email: 'late@people.test.local', fullName: 'Too Late', role: 'CASHIER' });
    expect([402, 403]).toContain(hire.status);
    // Reset BEFORE disable, because a disabled account is no longer resettable
    // — and because this is the order that matters: the owner whose renewal
    // lapsed must still be able to cut a credential that has gone astray.
    const reset = await request(app)
      .post(`/api/users/${cashierZ.id}/reset-password`)
      .set(auth(tokens.ownerZ));
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.passwordReset.sent).toBe(true);
    const off = await request(app)
      .patch(`/api/users/${cashierZ.id}/status`)
      .set(auth(tokens.ownerZ))
      .send({ status: 'DISABLED' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
  });
});

describe('assignments: scope replacement and the owner guard', () => {
  it('an admin widens a manager to two stores, and the list follows the assignment', async () => {
    const managerRow = await prisma.posUser.findUnique({ where: { email: 'manager.x1@people.test.local' } });
    const set = await request(app)
      .put(`/api/permissions/assignments/${managerRow.id}`)
      .set(auth(tokens.adminX))
      .send({ storeIds: [branchX1.id, branchX2.id] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const list = await request(app).get('/api/users').set(auth(tokens.managerX1));
    const emails = list.body.users.map((u) => u.email);
    expect(emails).toContain('cashier.x2@people.test.local');
    // Cleared, the role's own pin is the scope again.
    const clear = await request(app)
      .put(`/api/permissions/assignments/${managerRow.id}`)
      .set(auth(tokens.adminX))
      .send({ storeIds: [] });
    expect(clear.status).toBe(200);
    const after = await request(app).get('/api/users').set(auth(tokens.managerX1));
    expect(after.body.users.map((u) => u.email)).not.toContain('cashier.x2@people.test.local');
  });

  it('nobody assigns themselves, and only an owner may re-scope the owner', async () => {
    const self = await request(app)
      .put(`/api/permissions/assignments/${adminX.id}`)
      .set(auth(tokens.adminX))
      .send({ storeIds: [branchX1.id] });
    expect(self.status).toBe(403);
    // Without this guard an admin could pin the owner to one store and narrow
    // their reach company-wide — assignments REPLACE the role's scope.
    const pinOwner = await request(app)
      .put(`/api/permissions/assignments/${ownerX.id}`)
      .set(auth(tokens.adminX))
      .send({ storeIds: [branchX1.id] });
    expect(pinOwner.status).toBe(403);
    expect(pinOwner.body.error.message).toMatch(/Only the account owner/);
  });
});

describe('rules and grants: the ceiling holds and support access is tenant-issued', () => {
  it('an ALLOW rule cannot add what the role never had; a DENY takes away what it did', async () => {
    const allow = await request(app)
      .put('/api/permissions/rules')
      .set(auth(tokens.ownerX))
      .send({ level: 'USER', userId: cashierX1.id, action: 'refund.issue', effect: 'ALLOW' });
    expect(allow.status, JSON.stringify(allow.body)).toBe(200);
    const cashierToken = await login('cashier.x1@people.test.local');
    const me1 = await request(app).get('/api/permissions/me').set(auth(cashierToken));
    expect(me1.status).toBe(200);
    expect(me1.body.actions).not.toContain('refund.issue'); // ceiling first, rules second
    expect(me1.body.actions).toContain('order.item.void'); // positive control

    const deny = await request(app)
      .put('/api/permissions/rules')
      .set(auth(tokens.ownerX))
      .send({ level: 'USER', userId: cashierX1.id, action: 'order.item.void', effect: 'DENY' });
    expect(deny.status).toBe(200);
    const me2 = await request(app).get('/api/permissions/me').set(auth(cashierToken));
    expect(me2.body.actions).not.toContain('order.item.void');

    for (const id of [allow.body.rule.id, deny.body.rule.id]) {
      const clear = await request(app).delete(`/api/permissions/rules/${id}`).set(auth(tokens.ownerX));
      expect(clear.status).toBe(200);
    }
  });

  it('a cashier cannot write rules at all — not even about themselves', async () => {
    const cashierToken = await login('cashier.x1@people.test.local');
    const res = await request(app)
      .put('/api/permissions/rules')
      .set(auth(cashierToken))
      .send({ level: 'USER', userId: cashierX1.id, action: 'refund.issue', effect: 'ALLOW' });
    expect(res.status).toBe(403);
  });

  it('platform permission.write is grant-gated, and the platform cannot self-issue the grant', async () => {
    const before = await request(app)
      .put('/api/permissions/rules')
      .set(atcAuth(companyX.id))
      .send({ level: 'COMPANY', action: 'table.write', effect: 'DENY' });
    expect(before.status).toBe(403);
    expect(before.body.error.message).toMatch(/support access/);

    const selfIssue = await request(app)
      .post('/api/permissions/support-grants')
      .set(atcAuth(companyX.id))
      .send({ email: atcAdmin.email, reason: 'letting myself in', hours: 1 });
    expect(selfIssue.status).toBe(403);
    expect(selfIssue.body.error.message).toMatch(/inside this account/);

    const grant = await request(app)
      .post('/api/permissions/support-grants')
      .set(auth(tokens.ownerX))
      .send({ email: atcAdmin.email, reason: 'ticket 4711', hours: 1 });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    expect(grant.body.grant.active).toBe(true);

    const during = await request(app)
      .put('/api/permissions/rules')
      .set(atcAuth(companyX.id))
      .send({ level: 'COMPANY', action: 'table.write', effect: 'DENY' });
    expect(during.status, JSON.stringify(during.body)).toBe(200);

    const revoke = await request(app)
      .post(`/api/permissions/support-grants/${grant.body.grant.id}/revoke`)
      .set(auth(tokens.ownerX));
    expect(revoke.status).toBe(200);
    expect(revoke.body.grant.active).toBe(false);

    const after = await request(app)
      .put('/api/permissions/rules')
      .set(atcAuth(companyX.id))
      .send({ level: 'COMPANY', action: 'table.write', effect: 'ALLOW' });
    expect(after.status).toBe(403);

    // The tenant's own owner clears the rule the operator wrote.
    const rules = await request(app).get('/api/permissions/rules').set(auth(tokens.ownerX));
    const written = rules.body.rules.find((r) => r.action === 'table.write' && r.level === 'COMPANY');
    expect(written).toBeTruthy();
    const clear = await request(app).delete(`/api/permissions/rules/${written.id}`).set(auth(tokens.ownerX));
    expect(clear.status).toBe(200);
  });

  it('removal is judged on the state it produces: a caller still denied by another rule cannot clear one', async () => {
    // Three rules by the owner: policy authority for the admin, a personal
    // DENY binding the admin, and the cashier rule the admin will try to clear.
    const armed = [];
    const put = async (body) => {
      const res = await request(app).put('/api/permissions/rules').set(auth(tokens.ownerX)).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      armed.push(res.body.rule.id);
      return res.body.rule;
    };
    try {
      await put({ level: 'USER', userId: adminX.id, action: 'permission.write', effect: 'ALLOW' });
      await put({ level: 'USER', userId: adminX.id, action: 'order.item.void', effect: 'DENY' });
      const cashierRule = await put({ level: 'USER', userId: cashierX1.id, action: 'order.item.void', effect: 'DENY' });
      // The admin passes the route's permission.write gate and the tenant
      // lookup — but with the cashier's rule gone their OWN deny would still
      // stand, so they would be handing out an action they do not hold.
      const asAdmin = await request(app)
        .delete(`/api/permissions/rules/${cashierRule.id}`)
        .set(auth(tokens.adminX));
      expect(asAdmin.status).toBe(403);
      // The owner holds the action once the rule is out of the picture.
      const asOwner = await request(app)
        .delete(`/api/permissions/rules/${cashierRule.id}`)
        .set(auth(tokens.ownerX));
      expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
      armed.pop(); // the owner just removed it
    } finally {
      // The ALLOW and the admin's DENY must not leak into later tests' sums.
      await prisma.permissionRule.deleteMany({ where: { id: { in: armed } } });
    }
  });
});
