// Staff onboarding by invitation, exercised through the HTTP surface with a
// real SMTP server on the other end.
//
// The tokens under test are never fabricated: every one is read out of the
// link in the message the sink actually received, which is the only way to
// prove that what lands in the mailbox is what the accept endpoint honours.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('invitations.test.js requires a DATABASE_URL ending in _test');
}

const sink = startSmtpSink({ port: 0 });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@invite.test';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword, hashSecret } = await import('../src/lib/crypto.js');
const { createInvitation, acceptInvitation } = await import('../src/lib/invitations.js');

const app = createApp();

const PW = 'invite-password-1';
const NEW_PW = 'chosen-by-me-99';

let companyA, companyB, companySuspended;
let storeA1, storeA2, storeB1, regionA;
let ownerA, adminA, managerA, cashierA, ownerB, ownerSuspended;

const wipe = async () => {
  await prisma.userInvitation.deleteMany();
  await prisma.emailOutbox.deleteMany();
  await prisma.authChallenge.deleteMany();
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
  await prisma.supportAccessGrant.deleteMany();
  await prisma.permissionRule.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.device.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.branchBrand.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.gstRegistration.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.region.deleteMany({ where: { parentId: { not: null } } });
  await prisma.region.deleteMany();
  await prisma.company.deleteMany();
};

// The decoded text/plain body of the last message to an address.
const bodyOfLastMail = (to) => {
  const msg = [...sink.messages].reverse().find((m) => m.envelope.to.join(',').includes(to));
  if (!msg) throw new Error(`no message delivered to ${to}`);
  const parts = msg.raw.split(/--=_vexo_[0-9a-f]+/);
  const plain = parts.find((p) => p.includes('text/plain'));
  return Buffer.from(plain.slice(plain.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
};

// The token exactly as the recipient would get it: read off the link in the
// email, from the fragment, never from the database.
const tokenFromLastMail = (to) => {
  const body = bodyOfLastMail(to);
  const match = body.match(/https:\/\/\S+#([A-Za-z0-9_-]{20,})/);
  if (!match) throw new Error(`no invitation link in the message to ${to}`);
  return match[1];
};

const login = async (email, password = PW) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token;
};

const invite = (token, body) =>
  request(app).post('/api/invitations').set('Authorization', `Bearer ${token}`).send(body);
const listInvites = (token) =>
  request(app).get('/api/invitations').set('Authorization', `Bearer ${token}`);
const resend = (token, id) =>
  request(app).post(`/api/invitations/${id}/resend`).set('Authorization', `Bearer ${token}`).send({});
const revoke = (token, id) =>
  request(app).post(`/api/invitations/${id}/revoke`).set('Authorization', `Bearer ${token}`).send({});
const lookup = (inviteToken) => request(app).post('/api/invite/lookup').send({ token: inviteToken });
const accept = (inviteToken, password, confirmPassword) =>
  request(app).post('/api/invite/accept').send({ token: inviteToken, password, confirmPassword });

// Ages an invitation's lastSentAt past the resend cooldown. The cooldown is
// counted from the row, so this is what waiting a minute would do.
const clearCooldown = (id) =>
  prisma.userInvitation.update({
    where: { id },
    data: { lastSentAt: new Date(Date.now() - 120_000) },
  });

let ownerAToken;

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const future = new Date(Date.now() + 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Invite Retail',
      slug: 'invite-retail',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 5, expiresAt: future } },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Other Retail',
      slug: 'invite-other',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 5, expiresAt: future } },
    },
  });
  companySuspended = await prisma.company.create({
    data: {
      name: 'Suspended Retail',
      slug: 'invite-suspended',
      status: 'SUSPENDED',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: future } },
    },
  });

  regionA = await prisma.region.create({ data: { companyId: companyA.id, name: 'North', code: 'N' } });
  storeA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-IN-0001', name: 'Store A1', code: 'A1', regionId: regionA.id },
  });
  storeA2 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-IN-0002', name: 'Store A2', code: 'A2' },
  });
  storeB1 = await prisma.branch.create({
    data: { companyId: companyB.id, publicId: 'VC-IN-0003', name: 'Store B1', code: 'B1' },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  ownerA = await mk({ email: 'owner.a@invite.test', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  adminA = await mk({ email: 'admin.a@invite.test', fullName: 'Admin A', role: 'COMPANY_ADMIN', companyId: companyA.id });
  managerA = await mk({
    email: 'manager.a@invite.test',
    fullName: 'Manager A',
    role: 'BRANCH_MANAGER',
    companyId: companyA.id,
    branchId: storeA1.id,
  });
  cashierA = await mk({
    email: 'cashier.a@invite.test',
    fullName: 'Cashier A',
    role: 'CASHIER',
    companyId: companyA.id,
    branchId: storeA1.id,
  });
  ownerB = await mk({ email: 'owner.b@invite.test', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });
  ownerSuspended = await mk({
    email: 'owner.s@invite.test',
    fullName: 'Owner S',
    role: 'CUSTOMER_OWNER',
    companyId: companySuspended.id,
  });
});

beforeEach(async () => {
  sink.reset();
  await prisma.userInvitation.deleteMany();
  await prisma.emailOutbox.deleteMany();
  // Accounts created by acceptance in a previous test, and the assignments
  // they own. The fixture accounts above are kept.
  const keep = [ownerA.id, adminA.id, managerA.id, cashierA.id, ownerB.id, ownerSuspended.id];
  await prisma.userStoreAssignment.deleteMany({ where: { userId: { notIn: keep } } });
  await prisma.posSession.deleteMany({ where: { userId: { notIn: keep } } });
  await prisma.posAuditLog.deleteMany();
  await prisma.posUser.deleteMany({ where: { id: { notIn: keep } } });
  ownerAToken = await login(ownerA.email);
});

afterAll(async () => {
  // Leave the shared test database empty: the older files' wipes do not cover
  // this lane's tables, and their RESTRICT keys would fail on our leftovers.
  await wipe();
  await sink.close();
  await prisma.$disconnect();
});

describe('sending an invitation', () => {
  it('creates a pending invitation and mails a link, creating no account yet', async () => {
    const res = await invite(ownerAToken, {
      email: 'new.manager@invite.test',
      fullName: 'New Manager',
      role: 'BRANCH_MANAGER',
      branchId: storeA1.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.invitation.status).toBe('PENDING');
    expect(res.body.invitation.email).toBe('new.manager@invite.test');

    // Invitation-pending is not a user: nothing can sign in as this person yet.
    const user = await prisma.posUser.findUnique({ where: { email: 'new.manager@invite.test' } });
    expect(user).toBeNull();

    const body = bodyOfLastMail('new.manager@invite.test');
    expect(body).toContain('Invite Retail');
    expect(body).toMatch(/https:\/\/portal\.vexoconnect\.test\/pos\/invite#/);
  });

  it('builds the link beneath APP_URL, so a portal served at a sub-path is reachable', async () => {
    await invite(ownerAToken, {
      email: 'sub.path@invite.test',
      fullName: 'Sub Path',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    const body = bodyOfLastMail('sub.path@invite.test');
    // The /pos segment must survive: without it the link 404s in production.
    expect(body).toContain('https://portal.vexoconnect.test/pos/invite#');
    expect(body).not.toContain('https://portal.vexoconnect.test/invite#');
  });

  it('never returns the token, and never stores it anywhere reversible', async () => {
    const res = await invite(ownerAToken, {
      email: 'secret.token@invite.test',
      fullName: 'Secret Token',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    const token = tokenFromLastMail('secret.token@invite.test');

    expect(JSON.stringify(res.body)).not.toContain(token);
    const row = await prisma.userInvitation.findUnique({ where: { id: res.body.invitation.id } });
    expect(row.tokenHash).not.toBe(token);
    // Keyed, not a bare digest: a database dump alone cannot be turned back
    // into a working link even for a token an attacker guesses at.
    expect(row.tokenHash).not.toBe(hashSecret(token));

    const outbox = await prisma.emailOutbox.findMany();
    expect(outbox.length).toBe(1);
    expect(JSON.stringify(outbox[0])).not.toContain(token);
  });

  it('records the invitation in the audit trail without the token', async () => {
    const res = await invite(ownerAToken, {
      email: 'audited@invite.test',
      fullName: 'Audited',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    const token = tokenFromLastMail('audited@invite.test');
    const row = await prisma.posAuditLog.findFirst({ where: { action: 'USER_INVITED' } });
    expect(row.entityId).toBe(res.body.invitation.id);
    expect(row.meta.email).toBe('audited@invite.test');
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('refuses a role that holds permissions the inviter does not', async () => {
    const managerToken = await login(managerA.email);
    const res = await invite(managerToken, {
      email: 'too.senior@invite.test',
      fullName: 'Too Senior',
      role: 'COMPANY_ADMIN',
    });
    expect(res.status).toBe(403);
    expect(await prisma.userInvitation.count()).toBe(0);
  });

  it('keeps owner invitations to the owner, even from an admin who may invite everyone else', async () => {
    const adminToken = await login(adminA.email);
    const ok = await invite(adminToken, {
      email: 'admin.can@invite.test',
      fullName: 'Admin Can',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    expect(ok.status).toBe(201);

    const res = await invite(adminToken, {
      email: 'second.owner@invite.test',
      fullName: 'Second Owner',
      role: 'CUSTOMER_OWNER',
    });
    expect(res.status).toBe(403);
  });

  it('refuses a caller who holds no user.write at all', async () => {
    const cashierToken = await login(cashierA.email);
    const res = await invite(cashierToken, {
      email: 'from.cashier@invite.test',
      fullName: 'From Cashier',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    expect(res.status).toBe(403);
  });

  it('demands a store for a store-pinned role and refuses one outside the caller’s reach', async () => {
    const missing = await invite(ownerAToken, {
      email: 'no.store@invite.test',
      fullName: 'No Store',
      role: 'CASHIER',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.field).toBe('branchId');

    // Another tenant's store answers exactly as a store that does not exist.
    const foreign = await invite(ownerAToken, {
      email: 'foreign.store@invite.test',
      fullName: 'Foreign Store',
      role: 'CASHIER',
      branchId: storeB1.id,
    });
    expect(foreign.status).toBe(404);
    expect(await prisma.userInvitation.count()).toBe(0);
  });

  it('refuses an address that already holds an account', async () => {
    const res = await invite(ownerAToken, {
      email: cashierA.email,
      fullName: 'Duplicate',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    expect(res.status).toBe(409);
  });

  it('supersedes an earlier invitation to the same address, killing the first link', async () => {
    const first = await invite(ownerAToken, {
      email: 'twice@invite.test',
      fullName: 'Twice',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    const firstToken = tokenFromLastMail('twice@invite.test');

    const second = await invite(ownerAToken, {
      email: 'twice@invite.test',
      fullName: 'Twice',
      role: 'CASHIER',
      branchId: storeA2.id,
    });
    const secondToken = tokenFromLastMail('twice@invite.test');
    expect(secondToken).not.toBe(firstToken);

    expect((await lookup(firstToken)).status).toBe(400);
    expect((await lookup(secondToken)).status).toBe(200);

    const rows = await prisma.userInvitation.findMany({ where: { email: 'twice@invite.test' } });
    expect(rows.filter((r) => r.status === 'PENDING').length).toBe(1);
    expect(rows.find((r) => r.id === first.body.invitation.id).status).toBe('REVOKED');
    expect(rows.find((r) => r.id === second.body.invitation.id).status).toBe('PENDING');
  });

  it('shows the tenant its own invitations and nobody else’s', async () => {
    await invite(ownerAToken, {
      email: 'mine@invite.test',
      fullName: 'Mine',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    const ownerBToken = await login(ownerB.email);
    await invite(ownerBToken, {
      email: 'theirs@invite.test',
      fullName: 'Theirs',
      role: 'CASHIER',
      branchId: storeB1.id,
    });

    const mine = await listInvites(ownerAToken);
    expect(mine.body.invitations.map((i) => i.email)).toEqual(['mine@invite.test']);
    expect(mine.body.assignableRoles).toContain('CUSTOMER_OWNER');
    // Never the token or its verifier, on a screen anyone may screenshot.
    expect(JSON.stringify(mine.body)).not.toContain('tokenHash');
  });
});

describe('accepting an invitation', () => {
  const sendTo = async (email, body = {}) => {
    const res = await invite(ownerAToken, {
      email,
      fullName: 'Invited Person',
      role: 'BRANCH_MANAGER',
      branchId: storeA1.id,
      ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.invitation.id, token: tokenFromLastMail(email) };
  };

  it('tells the accept page who is invited, and nothing more', async () => {
    const { token } = await sendTo('lookup.me@invite.test');
    const res = await lookup(token);
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({
      email: 'lookup.me@invite.test',
      role: 'BRANCH_MANAGER',
      roleLabel: 'Store Manager',
      companyName: 'Invite Retail',
      storeName: 'Store A1',
    });
    // No ids, no inviter, no token: the page names the company so a real
    // invitation is distinguishable from a lure, and stops there.
    expect(res.body.invitation.id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('creates the account with the invited role and placement, and marks the email proven', async () => {
    const { token } = await sendTo('accepted@invite.test');
    const res = await accept(token, NEW_PW, NEW_PW);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const user = await prisma.posUser.findUnique({ where: { email: 'accepted@invite.test' } });
    expect(user.role).toBe('BRANCH_MANAGER');
    expect(user.companyId).toBe(companyA.id);
    expect(user.branchId).toBe(storeA1.id);
    expect(user.status).toBe('ACTIVE');
    // They chose it themselves, so there is nothing to force a change of.
    expect(user.mustChangePassword).toBe(false);
    // Clicking a link that only ever existed in that mailbox IS the proof.
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('materialises named stores into assignments', async () => {
    const { token } = await sendTo('multi.store@invite.test', {
      role: 'BRANCH_MANAGER',
      branchId: storeA1.id,
      storeIds: [storeA1.id, storeA2.id],
    });
    await accept(token, NEW_PW, NEW_PW);
    const user = await prisma.posUser.findUnique({ where: { email: 'multi.store@invite.test' } });
    const rows = await prisma.userStoreAssignment.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.branchId).sort()).toEqual([storeA1.id, storeA2.id].sort());
    expect(rows.every((r) => r.companyId === companyA.id)).toBe(true);
  });

  it('issues no session — the new account still has to sign in', async () => {
    const { token } = await sendTo('no.session@invite.test');
    const res = await accept(token, NEW_PW, NEW_PW);

    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();

    const user = await prisma.posUser.findUnique({ where: { email: 'no.session@invite.test' } });
    expect(await prisma.posSession.count({ where: { userId: user.id } })).toBe(0);

    // And the password they chose is the one that works.
    const signIn = await request(app)
      .post('/api/auth/login')
      .send({ email: 'no.session@invite.test', password: NEW_PW });
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
  });

  it('stores the chosen password as a hash and puts it in no message', async () => {
    const { token } = await sendTo('hashed@invite.test');
    await accept(token, NEW_PW, NEW_PW);
    const user = await prisma.posUser.findUnique({ where: { email: 'hashed@invite.test' } });
    expect(user.passwordHash).toMatch(/^\$argon2/);
    expect(user.passwordHash).not.toContain(NEW_PW);
    for (const msg of sink.messages) expect(msg.raw).not.toContain(NEW_PW);
  });

  it('cannot be accepted twice', async () => {
    const { token } = await sendTo('once.only@invite.test');
    expect((await accept(token, NEW_PW, NEW_PW)).status).toBe(201);

    const again = await accept(token, 'another-password-1', 'another-password-1');
    expect(again.status).toBe(400);
    expect(await prisma.posUser.count({ where: { email: 'once.only@invite.test' } })).toBe(1);
  });

  // The route reads the invitation row, then claims it in a later transaction.
  // Anything that changes the row in between — a revoke by the admin who sent
  // it, the expiry passing — is invisible to that first read, so the claim
  // itself has to re-assert the conditions rather than trust the snapshot.
  // Driven through the library because the gap is not reachable over HTTP.
  for (const [what, change] of [
    ['revoked', { status: 'REVOKED', revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['already accepted', { status: 'ACCEPTED', acceptedAt: new Date() }],
  ]) {
    it(`will not claim an invitation that was ${what} after it was read`, async () => {
      const email = `stale.${what.split(' ')[0]}@invite.test`;
      const { id } = await sendTo(email);
      const snapshot = await prisma.userInvitation.findUnique({ where: { id } });
      await prisma.userInvitation.update({ where: { id }, data: change });

      const user = await acceptInvitation(prisma, snapshot, { password: NEW_PW });
      expect(user).toBeNull();
      expect(await prisma.posUser.count({ where: { email } })).toBe(0);
    });
  }

  it('two concurrent acceptances of one link create exactly one account', async () => {
    const { id, token } = await sendTo('race@invite.test');
    const results = await Promise.all([
      accept(token, NEW_PW, NEW_PW),
      accept(token, 'other-password-99', 'other-password-99'),
    ]);
    expect(await prisma.posUser.count({ where: { email: 'race@invite.test' } })).toBe(1);

    // The loser's ANSWER is the assertion, not just the account count. A unique
    // index on email also yields one account — while handing the loser a 409
    // naming the address, or a 500. Only the claim on the invitation row turns
    // the race into the same refusal every other unusable link gets.
    const winner = results.find((r) => r.status === 201);
    const loser = results.find((r) => r !== winner);
    expect(winner, results.map((r) => `${r.status} ${JSON.stringify(r.body)}`).join(' | ')).toBeTruthy();
    expect(loser.status, JSON.stringify(loser.body)).toBe(400);
    // Compared against a token that never existed, so the refusal is pinned to
    // the one every unusable link gets rather than to a copy of the sentence.
    const forged = await accept('not-a-real-token-at-all-0000', NEW_PW, NEW_PW);
    expect(loser.body.error.message).toBe(forged.body.error.message);
    expect((await prisma.userInvitation.findUnique({ where: { id } })).status).toBe('ACCEPTED');
  });

  it('refuses a revoked, an expired and a forged token the same way', async () => {
    const revoked = await sendTo('revoked@invite.test');
    await revoke(ownerAToken, revoked.id);

    const expired = await sendTo('expired@invite.test');
    await prisma.userInvitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const answers = await Promise.all([
      accept(revoked.token, NEW_PW, NEW_PW),
      accept(expired.token, NEW_PW, NEW_PW),
      accept('not-a-real-token-at-all-0000', NEW_PW, NEW_PW),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(400);
      // One sentence for every way it can fail: distinguishing them tells an
      // uninvited holder of a link which guess was close.
      expect(res.body.error.message).toBe(answers[0].body.error.message);
    }
    expect(await prisma.posUser.count({ where: { email: { contains: '@invite.test' } } })).toBe(6);
  });

  it('will not staff a company that is suspended', async () => {
    // Minted through the library rather than the route: a suspended tenant's
    // owner cannot sign in to issue one, and the question here is what the
    // ACCEPT side does with a link whose tenant has since been stopped.
    const { token } = await createInvitation(prisma, {
      companyId: companySuspended.id,
      email: 'into.suspended@invite.test',
      fullName: 'Into Suspended',
      role: 'CASHIER',
      createdById: ownerSuspended.id,
    });
    const res = await accept(token, NEW_PW, NEW_PW);
    expect(res.status).toBe(400);
    expect(await prisma.posUser.count({ where: { email: 'into.suspended@invite.test' } })).toBe(0);
    // And the lookup says no more than the accept does.
    expect((await lookup(token)).status).toBe(400);
  });

  it('refuses a weak password without spending the invitation', async () => {
    const { token } = await sendTo('weak@invite.test');
    const weak = await accept(token, 'short', 'short');
    expect(weak.status).toBe(400);
    const spaces = await accept(token, '              ', '              ');
    expect(spaces.status).toBe(400);

    // Still open afterwards: a rejected password must not burn the invitation.
    const good = await accept(token, NEW_PW, NEW_PW);
    expect(good.status, JSON.stringify(good.body)).toBe(201);
  });

  it('refuses a mismatched confirmation and names the field', async () => {
    const { token } = await sendTo('mismatch@invite.test');
    const res = await accept(token, NEW_PW, 'something-else-1');
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('confirmPassword');
    expect(await prisma.posUser.count({ where: { email: 'mismatch@invite.test' } })).toBe(0);
  });

  it('records the acceptance against the invitation that produced it', async () => {
    const { id, token } = await sendTo('joined@invite.test');
    await accept(token, NEW_PW, NEW_PW);

    const row = await prisma.userInvitation.findUnique({ where: { id } });
    const user = await prisma.posUser.findUnique({ where: { email: 'joined@invite.test' } });
    expect(row.status).toBe('ACCEPTED');
    expect(row.acceptedById).toBe(user.id);
    expect(row.acceptedAt).not.toBeNull();

    const audited = await prisma.posAuditLog.findFirst({ where: { action: 'USER_INVITE_ACCEPTED' } });
    expect(audited.entityId).toBe(user.id);
    expect(JSON.stringify(audited)).not.toContain(NEW_PW);
  });
});

describe('resending and revoking', () => {
  const sendTo = async (email) => {
    const res = await invite(ownerAToken, {
      email,
      fullName: 'Invited Person',
      role: 'CASHIER',
      branchId: storeA1.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.invitation.id, token: tokenFromLastMail(email) };
  };

  it('rotates the token, so the link that was forwarded by mistake stops working', async () => {
    const { id, token: first } = await sendTo('rotated@invite.test');
    await clearCooldown(id);

    const res = await resend(ownerAToken, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.invitation.sentCount).toBe(2);

    const second = tokenFromLastMail('rotated@invite.test');
    expect(second).not.toBe(first);
    expect((await lookup(first)).status).toBe(400);
    expect((await lookup(second)).status).toBe(200);
  });

  it('holds a resend behind the same cooldown the email-code challenge uses', async () => {
    const { id } = await sendTo('cooldown@invite.test');
    const res = await resend(ownerAToken, id);
    expect(res.status).toBe(429);
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    // One mail, not two: the second ask sent nothing.
    expect(sink.messages.length).toBe(1);
  });

  it('refuses to resend an invitation that is no longer open', async () => {
    const { id, token } = await sendTo('closed@invite.test');
    await accept(token, NEW_PW, NEW_PW);
    await clearCooldown(id);
    expect((await resend(ownerAToken, id)).status).toBe(400);
  });

  it('revokes a pending invitation and kills its link', async () => {
    const { id, token } = await sendTo('withdrawn@invite.test');
    const res = await revoke(ownerAToken, id);
    expect(res.status).toBe(200);
    expect(res.body.invitation.status).toBe('REVOKED');
    expect((await lookup(token)).status).toBe(400);

    const audited = await prisma.posAuditLog.findFirst({ where: { action: 'USER_INVITE_REVOKED' } });
    expect(audited.entityId).toBe(id);
  });

  it('will not revoke one that has already been accepted', async () => {
    const { id, token } = await sendTo('already.in@invite.test');
    await accept(token, NEW_PW, NEW_PW);
    const res = await revoke(ownerAToken, id);
    expect(res.status).toBe(400);
    // The account stands; withdrawing access to it is a different operation.
    const user = await prisma.posUser.findUnique({ where: { email: 'already.in@invite.test' } });
    expect(user.status).toBe('ACTIVE');
  });

  it('answers for another tenant’s invitation exactly as for one that does not exist', async () => {
    const { id } = await sendTo('cross.tenant@invite.test');
    const ownerBToken = await login(ownerB.email);

    expect((await revoke(ownerBToken, id)).status).toBe(404);
    expect((await resend(ownerBToken, id)).status).toBe(404);
    expect((await revoke(ownerBToken, 'no-such-invitation-id')).status).toBe(404);

    const row = await prisma.userInvitation.findUnique({ where: { id } });
    expect(row.status).toBe('PENDING');
  });

  it('reports a lapsed invitation as expired rather than still pending', async () => {
    const { id } = await sendTo('lapsed@invite.test');
    await prisma.userInvitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const list = await listInvites(ownerAToken);
    expect(list.body.invitations.find((i) => i.id === id).status).toBe('EXPIRED');
  });
});
