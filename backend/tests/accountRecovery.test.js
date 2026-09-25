// Email-code password recovery, exercised through the HTTP surface with a
// real SMTP server on the other end.
//
// The codes under test are never fabricated here: every one is read out of the
// message the sink actually received, which is the only way to prove that what
// reaches the mailbox is what the verifier accepts. Nothing leaves this box —
// the sink relays nothing and the mailer's allowlist is set to the test domain.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('accountRecovery.test.js requires a DATABASE_URL ending in _test');
}

const sink = startSmtpSink({ port: 0 });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@recovery.test';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword, verifyPassword, hashSecret } = await import('../src/lib/crypto.js');
const { CHALLENGE_POLICY } = await import('../src/lib/accounts.js');
const { recoveryLimiter, setRateLimitEnforcementForTest } = await import('../src/middleware/rateLimit.js');

const app = createApp();

const PW = 'recovery-password-1';
const NEW_PW = 'brand-new-password-9';

let companyA, companySuspended, ownerA, cashierA, disabledA, ownerSuspended, ownerLapsed, platformAdmin;

// Same order as the other suites that clear the shared test database: every
// foreign key here is RESTRICT, so children go before the users, branches and
// companies they point at.
const wipe = async () => {
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
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.gstRegistration.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.region.deleteMany({ where: { parentId: { not: null } } });
  await prisma.region.deleteMany();
  await prisma.company.deleteMany();
};

// The code as the recipient sees it: pulled from the delivered message, never
// from the database or the return value of anything under test.
const codeFromLastMail = (to) => {
  const msg = [...sink.messages].reverse().find((m) => m.envelope.to.join(',').includes(to));
  if (!msg) throw new Error(`no message delivered to ${to}`);
  const parts = msg.raw.split(/--=_vexo_[0-9a-f]+/);
  const plain = parts.find((p) => p.includes('text/plain'));
  const body = Buffer.from(
    plain.slice(plain.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''),
    'base64',
  ).toString('utf8');
  const match = body.match(/\b(\d{8})\b/);
  if (!match) throw new Error('no 8-digit code in the delivered message');
  return match[1];
};

const forgot = (email) => request(app).post('/api/auth/forgot-password').send({ email });
const verify = (email, code) => request(app).post('/api/auth/forgot-password/verify').send({ email, code });
const reset = (resetToken, password, confirmPassword) =>
  request(app).post('/api/auth/forgot-password/reset').send({ resetToken, password, confirmPassword });
const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

// One whole trip through the flow, used where the point of the test is what
// happens after a successful reset rather than the steps themselves.
const fullReset = async (email, password) => {
  // Clears the per-account code budget first: no caller of this helper is
  // asserting anything about throttling, and the tests that are use `forgot`
  // directly.
  await clearChallenges();
  expect((await forgot(email)).status).toBe(200);
  const v = await verify(email, codeFromLastMail(email));
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  const r = await reset(v.body.resetToken, password, password);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
};

// The per-account hourly cap is counted from rows, deliberately, so tests that
// need a fresh budget have to clear them the same way a new hour would.
const clearChallenges = () => prisma.authChallenge.deleteMany();

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const future = new Date(Date.now() + 86400e3);
  const past = new Date(Date.now() - 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Recovery Retail',
      slug: 'recovery-retail',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: future } },
    },
  });
  companySuspended = await prisma.company.create({
    data: {
      name: 'Recovery Suspended',
      slug: 'recovery-suspended',
      status: 'SUSPENDED',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: future } },
    },
  });
  const companyLapsed = await prisma.company.create({
    data: {
      name: 'Recovery Lapsed',
      slug: 'recovery-lapsed',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: past } },
    },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  platformAdmin = await mk({ email: 'platform@recovery.test', fullName: 'Platform', role: 'POS_SUPER_ADMIN' });
  ownerA = await mk({ email: 'owner.a@recovery.test', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  cashierA = await mk({ email: 'cashier.a@recovery.test', fullName: 'Cashier A', role: 'CASHIER', companyId: companyA.id });
  disabledA = await mk({ email: 'disabled.a@recovery.test', fullName: 'Disabled A', role: 'CASHIER', companyId: companyA.id, status: 'DISABLED' });
  ownerSuspended = await mk({ email: 'owner.s@recovery.test', fullName: 'Owner S', role: 'CUSTOMER_OWNER', companyId: companySuspended.id });
  ownerLapsed = await mk({ email: 'owner.l@recovery.test', fullName: 'Owner L', role: 'CUSTOMER_OWNER', companyId: companyLapsed.id });
});

beforeEach(async () => {
  sink.reset();
  await clearChallenges();
  await prisma.emailOutbox.deleteMany();
});

afterAll(async () => {
  await wipe();
  await sink.close();
  await prisma.$disconnect();
});

describe('requesting a code', () => {
  it('delivers an 8-digit code and answers with no account detail', async () => {
    const res = await forgot('owner.a@recovery.test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      message: 'If that email is registered, a verification code is on its way.',
      expiresInMinutes: CHALLENGE_POLICY.ttlMinutes,
      codeLength: 8,
    });
    expect(sink.messages).toHaveLength(1);
    expect(codeFromLastMail('owner.a@recovery.test')).toMatch(/^\d{8}$/);
  });

  it('answers an unknown address identically, and sends nothing', async () => {
    const known = await forgot('owner.a@recovery.test');
    sink.reset();
    const unknown = await forgot('nobody@recovery.test');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(sink.messages).toHaveLength(0);
  });

  it('answers a disabled user identically, and sends nothing', async () => {
    const res = await forgot('disabled.a@recovery.test');
    expect(res.status).toBe(200);
    expect(sink.messages).toHaveLength(0);
    expect(await prisma.authChallenge.count({ where: { userId: disabledA.id } })).toBe(0);
  });

  it('answers a suspended company identically, and sends nothing', async () => {
    const res = await forgot('owner.s@recovery.test');
    expect(res.status).toBe(200);
    expect(sink.messages).toHaveLength(0);
    expect(await prisma.authChallenge.count({ where: { userId: ownerSuspended.id } })).toBe(0);
  });

  it('serves an account whose licence has expired', async () => {
    // The owner who let a renewal lapse is exactly the person who needs to get
    // back in and fix it. Recovery must not turn a billing state into a lockout.
    const res = await forgot('owner.l@recovery.test');
    expect(res.status).toBe(200);
    expect(await prisma.authChallenge.count({ where: { userId: ownerLapsed.id } })).toBe(1);
  });

  it('never returns the code, the challenge id or the hash to the caller', async () => {
    const res = await forgot('owner.a@recovery.test');
    const code = codeFromLastMail('owner.a@recovery.test');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(code);
    const row = await prisma.authChallenge.findFirst({ where: { userId: ownerA.id } });
    expect(body).not.toContain(row.id);
    expect(body).not.toContain(row.codeHash);
  });

  it('stores the code only as a keyed verifier, never in the outbox', async () => {
    await forgot('owner.a@recovery.test');
    const code = codeFromLastMail('owner.a@recovery.test');
    const row = await prisma.authChallenge.findFirst({ where: { userId: ownerA.id } });
    expect(row.codeHash).not.toContain(code);
    // An unkeyed digest would be enumerable offline: 10^8 is nothing. Prove it
    // is not simply sha256(code).
    expect(row.codeHash).not.toBe(hashSecret(code));
    const outbox = await prisma.emailOutbox.findMany();
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox)).not.toContain(code);
    expect(outbox[0].status).toBe('SENT');
  });
});

describe('resending', () => {
  it('refuses a second code inside the cooldown and says how long to wait', async () => {
    await forgot('owner.a@recovery.test');
    const res = await request(app)
      .post('/api/auth/forgot-password/resend')
      .send({ email: 'owner.a@recovery.test' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('POS_RATE_LIMITED');
    expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(
      CHALLENGE_POLICY.resendCooldownSeconds,
    );
  });

  it('replaces the previous code rather than adding a second live one', async () => {
    await forgot('owner.a@recovery.test');
    const first = codeFromLastMail('owner.a@recovery.test');

    // Age the existing row past the cooldown the way the clock would.
    await prisma.authChallenge.updateMany({
      where: { userId: ownerA.id },
      data: { createdAt: new Date(Date.now() - (CHALLENGE_POLICY.resendCooldownSeconds + 5) * 1000) },
    });
    const again = await forgot('owner.a@recovery.test');
    expect(again.status).toBe(200);
    const second = codeFromLastMail('owner.a@recovery.test');
    expect(second).not.toBe(first);

    // Exactly one live challenge, and the old code is dead.
    const live = await prisma.authChallenge.count({
      where: { userId: ownerA.id, consumedAt: null, supersededAt: null },
    });
    expect(live).toBe(1);
    expect((await verify('owner.a@recovery.test', first)).status).toBe(400);
    expect((await verify('owner.a@recovery.test', second)).status).toBe(200);
  });

  it('caps the number of codes per account per hour', async () => {
    const age = () =>
      prisma.authChallenge.updateMany({
        where: { userId: cashierA.id },
        data: { createdAt: new Date(Date.now() - (CHALLENGE_POLICY.resendCooldownSeconds + 5) * 1000) },
      });
    for (let i = 0; i < CHALLENGE_POLICY.maxPerHour; i += 1) {
      expect((await forgot('cashier.a@recovery.test')).status).toBe(200);
      await age();
    }
    const over = await forgot('cashier.a@recovery.test');
    expect(over.status).toBe(429);
    expect(sink.messages).toHaveLength(CHALLENGE_POLICY.maxPerHour);
  });
});

describe('verifying a code', () => {
  it('returns a reset authorization and NOT a session', async () => {
    await forgot('owner.a@recovery.test');
    const res = await verify('owner.a@recovery.test', codeFromLastMail('owner.a@recovery.test'));
    expect(res.status).toBe(200);
    expect(res.body.resetToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // The thing that would make this a login: a session cookie and a JWT.
    // Neither exists. Somebody who reads a code off a phone screen gets to
    // choose a new password, which mails the owner — not a signed-in tab.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(await prisma.posSession.count({ where: { userId: ownerA.id, revokedAt: null } })).toBe(0);
  });

  it('rejects a wrong code and counts the attempt down to a lockout', async () => {
    await forgot('owner.a@recovery.test');
    const good = codeFromLastMail('owner.a@recovery.test');
    const wrong = good === '00000000' ? '11111111' : '00000000';

    for (let i = 1; i <= CHALLENGE_POLICY.maxAttempts; i += 1) {
      const res = await verify('owner.a@recovery.test', wrong);
      expect(res.status).toBe(400);
      expect(res.body.error.details?.attemptsRemaining).toBe(CHALLENGE_POLICY.maxAttempts - i);
    }
    // Budget spent: even the RIGHT code is now refused. That is the property
    // that makes an 8-digit secret safe to email.
    const after = await verify('owner.a@recovery.test', good);
    expect(after.status).toBe(400);
    expect(after.body.error.message).toContain('Too many incorrect codes');
  });

  it('rejects an expired code', async () => {
    await forgot('owner.a@recovery.test');
    const code = codeFromLastMail('owner.a@recovery.test');
    await prisma.authChallenge.updateMany({
      where: { userId: ownerA.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await verify('owner.a@recovery.test', code);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not valid or has expired');
  });

  it('refuses another account\'s code', async () => {
    await forgot('owner.a@recovery.test');
    const ownersCode = codeFromLastMail('owner.a@recovery.test');
    await forgot('cashier.a@recovery.test');
    const res = await verify('cashier.a@recovery.test', ownersCode);
    expect(res.status).toBe(400);
    // And the cashier's own attempt budget paid for that guess.
    const row = await prisma.authChallenge.findFirst({ where: { userId: cashierA.id } });
    expect(row.attempts).toBe(1);
  });

  it('answers an unknown address the same way a wrong code is answered', async () => {
    const res = await verify('nobody@recovery.test', '12345678');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not valid or has expired');
  });

  it('cannot be reused: a verified code does not verify twice', async () => {
    await forgot('owner.a@recovery.test');
    const code = codeFromLastMail('owner.a@recovery.test');
    const first = await verify('owner.a@recovery.test', code);
    expect(first.status).toBe(200);
    const token = first.body.resetToken;
    await reset(token, NEW_PW, NEW_PW);
    const second = await verify('owner.a@recovery.test', code);
    expect(second.status).toBe(400);
    await fullReset('owner.a@recovery.test', PW);
  });

  it('two concurrent verifications of the same code cannot both succeed', async () => {
    // The attempt is spent by a conditional UPDATE, so the loser matches zero
    // rows rather than reading a stale count. Nothing here trusts a prior read.
    await forgot('cashier.a@recovery.test');
    const code = codeFromLastMail('cashier.a@recovery.test');
    await prisma.authChallenge.updateMany({
      where: { userId: cashierA.id },
      data: { attempts: CHALLENGE_POLICY.maxAttempts - 1 },
    });
    const results = await Promise.all([
      verify('cashier.a@recovery.test', code),
      verify('cashier.a@recovery.test', code),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
  });
});

describe('setting the new password', () => {
  afterAll(async () => {
    // Leave every fixture on the password the rest of the suite expects.
    await prisma.posUser.updateMany({ data: { passwordHash: await hashPassword(PW) } });
  });

  it('changes the password, revokes every session and notifies the owner', async () => {
    const before = await login('owner.a@recovery.test', PW);
    expect(before.status).toBe(200);
    expect(await prisma.posSession.count({ where: { userId: ownerA.id, revokedAt: null } })).toBe(1);

    sink.reset();
    await fullReset('owner.a@recovery.test', NEW_PW);

    expect(await prisma.posSession.count({ where: { userId: ownerA.id, revokedAt: null } })).toBe(0);
    expect((await login('owner.a@recovery.test', PW)).status).toBe(401);
    expect((await login('owner.a@recovery.test', NEW_PW)).status).toBe(200);

    // Two messages: the code, then the notice. The notice carries no password.
    const notice = sink.messages.at(-1);
    expect(notice.subject).toContain('password was changed');
    expect(notice.raw).not.toContain(NEW_PW);
  });

  it('logs out the session that was open before the reset', async () => {
    await clearChallenges();
    const session = await login('owner.a@recovery.test', NEW_PW);
    expect(session.status).toBe(200);
    const stillGood = await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${session.body.token}` });
    expect(stillGood.status).toBe(200);

    await fullReset('owner.a@recovery.test', PW);

    const afterReset = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${session.body.token}` });
    expect(afterReset.status).toBe(401);
  });

  it('completes without issuing a session of its own', async () => {
    // The test above proves the OLD session dies. This one proves no NEW one is
    // born: a reset must hand back a message, never a credential. That is what
    // keeps recovery from being a way around whatever guards login — today the
    // password, tomorrow a second factor. Automatically signing someone in here
    // would be a plausible-looking UX change that quietly reopens that door.
    await clearChallenges();
    // Same password in as out, so this test leaves the fixtures exactly as it
    // found them for the cases that follow.
    const done = await fullReset('owner.a@recovery.test', PW);

    expect(done.body).toEqual({ ok: true, message: expect.any(String) });
    expect(done.headers['set-cookie']).toBeUndefined();
    // Nothing usable by any name, in case a future refactor picks a new one.
    for (const key of ['token', 'accessToken', 'sessionToken', 'session', 'jwt']) {
      expect(done.body[key]).toBeUndefined();
    }
    expect(await prisma.posSession.count({ where: { userId: ownerA.id, revokedAt: null } })).toBe(0);

    // Positive control: the assertions above are only meaningful if this probe
    // can see a credential when one really is issued. Login issues one.
    const real = await login('owner.a@recovery.test', PW);
    expect(real.status).toBe(200);
    expect(real.body.token).toEqual(expect.any(String));
    expect(await prisma.posSession.count({ where: { userId: ownerA.id, revokedAt: null } })).toBe(1);
  });

  it('preserves role, tenant and licence state', async () => {
    await clearChallenges();
    await fullReset('owner.l@recovery.test', NEW_PW);
    const after = await prisma.posUser.findUnique({ where: { id: ownerLapsed.id } });
    expect(after.role).toBe('CUSTOMER_OWNER');
    expect(after.companyId).toBe(ownerLapsed.companyId);
    expect(after.status).toBe('ACTIVE');
    // The licence is untouched: recovery restores access to the account that
    // existed, it does not re-grant anything.
    const license = await prisma.license.findFirst({ where: { companyId: ownerLapsed.companyId } });
    expect(license.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it('refuses a reset token that was already spent', async () => {
    await clearChallenges();
    await forgot('cashier.a@recovery.test');
    const v = await verify('cashier.a@recovery.test', codeFromLastMail('cashier.a@recovery.test'));
    expect((await reset(v.body.resetToken, NEW_PW, NEW_PW)).status).toBe(200);
    const again = await reset(v.body.resetToken, 'another-password-2', 'another-password-2');
    expect(again.status).toBe(400);
    // And the second password never took effect.
    expect((await login('cashier.a@recovery.test', 'another-password-2')).status).toBe(401);
    expect((await login('cashier.a@recovery.test', NEW_PW)).status).toBe(200);
  });

  it('refuses an expired reset token', async () => {
    await clearChallenges();
    await forgot('cashier.a@recovery.test');
    const v = await verify('cashier.a@recovery.test', codeFromLastMail('cashier.a@recovery.test'));
    await prisma.authChallenge.updateMany({
      where: { userId: cashierA.id },
      data: { resetExpiresAt: new Date(Date.now() - 1000) },
    });
    expect((await reset(v.body.resetToken, 'yet-another-pass-3', 'yet-another-pass-3')).status).toBe(400);
  });

  it('refuses a forged reset token', async () => {
    const res = await reset('not-a-real-token-but-long-enough-to-parse', NEW_PW, NEW_PW);
    expect(res.status).toBe(400);
  });

  it('two concurrent resets with one token cannot both succeed', async () => {
    await clearChallenges();
    await forgot('cashier.a@recovery.test');
    const v = await verify('cashier.a@recovery.test', codeFromLastMail('cashier.a@recovery.test'));
    const results = await Promise.all([
      reset(v.body.resetToken, 'concurrent-one-111', 'concurrent-one-111'),
      reset(v.body.resetToken, 'concurrent-two-222', 'concurrent-two-222'),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
  });

  it('refuses a weak or whitespace-only password without spending the token', async () => {
    await clearChallenges();
    await forgot('cashier.a@recovery.test');
    const v = await verify('cashier.a@recovery.test', codeFromLastMail('cashier.a@recovery.test'));
    expect((await reset(v.body.resetToken, 'short', 'short')).status).toBe(400);
    expect((await reset(v.body.resetToken, '            ', '            ')).status).toBe(400);
    expect((await reset(v.body.resetToken, 'a-good-long-password', 'a-good-long-password')).status).toBe(200);
  });

  it('refuses a mismatched confirmation', async () => {
    await clearChallenges();
    await forgot('cashier.a@recovery.test');
    const v = await verify('cashier.a@recovery.test', codeFromLastMail('cashier.a@recovery.test'));
    const res = await reset(v.body.resetToken, 'mismatch-password-1', 'mismatch-password-2');
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('confirmPassword');
  });

  it('will not resurrect an account disabled while the token was live', async () => {
    await clearChallenges();
    await forgot('cashier.a@recovery.test');
    const v = await verify('cashier.a@recovery.test', codeFromLastMail('cashier.a@recovery.test'));
    await prisma.posUser.update({ where: { id: cashierA.id }, data: { status: 'DISABLED' } });
    const res = await reset(v.body.resetToken, 'disabled-attempt-11', 'disabled-attempt-11');
    expect(res.status).toBe(400);
    await prisma.posUser.update({ where: { id: cashierA.id }, data: { status: 'ACTIVE' } });
    expect((await login('cashier.a@recovery.test', 'disabled-attempt-11')).status).toBe(401);
  });

  it('stores the new password as a hash, not as anything reversible', async () => {
    await clearChallenges();
    await fullReset('platform@recovery.test', NEW_PW);
    const row = await prisma.posUser.findUnique({ where: { id: platformAdmin.id } });
    expect(row.passwordHash).toMatch(/^\$argon2/);
    expect(row.passwordHash).not.toContain(NEW_PW);
    expect(await verifyPassword(row.passwordHash, NEW_PW)).toBe(true);
  });
});

// The suite above runs with the limiters skipped, which is exactly why this
// exists: a skipped limiter stays green even if the 429 path is broken. The
// switch turns the SHIPPED configuration on rather than a test-only copy of it.
describe('the per-address ceiling (real 429 control)', () => {
  const PROBE_IP = '10.77.0.5';
  const asClient = (ip) => `${ip}, 172.18.0.1`;
  const ask = (ip = PROBE_IP) =>
    request(app)
      .post('/api/auth/forgot-password')
      .set('X-Forwarded-For', asClient(ip))
      .send({ email: 'nobody@recovery.test' });

  afterAll(() => {
    setRateLimitEnforcementForTest(false);
    recoveryLimiter.resetKey(PROBE_IP);
  });

  it('negative control: with enforcement off, twenty-five asks all pass', async () => {
    recoveryLimiter.resetKey(PROBE_IP);
    for (let i = 1; i <= 25; i += 1) {
      expect((await ask()).status, `ask ${i}`).toBe(200);
    }
  });

  it('refuses the twenty-first ask from one address inside the window', async () => {
    recoveryLimiter.resetKey(PROBE_IP);
    setRateLimitEnforcementForTest(true);
    try {
      for (let i = 1; i <= 20; i += 1) {
        expect((await ask()).status, `ask ${i}`).toBe(200);
      }
      const blocked = await ask();
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('POS_RATE_LIMITED');
      expect(blocked.headers['retry-after']).toBeDefined();
      // A neighbouring address is untouched: the counter is per client IP, and
      // one café's mistyped address must not lock out the next.
      expect((await ask('10.77.0.6')).status).toBe(200);
    } finally {
      setRateLimitEnforcementForTest(false);
      recoveryLimiter.resetKey(PROBE_IP);
      recoveryLimiter.resetKey('10.77.0.6');
    }
  });
});

describe('the audit trail', () => {
  it('records the request, the verification and the completion', async () => {
    await clearChallenges();
    await prisma.posAuditLog.deleteMany();
    await fullReset('owner.a@recovery.test', 'audit-trail-password-1');

    const rows = await prisma.posAuditLog.findMany({ orderBy: { at: 'asc' } });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('PASSWORD_RESET_REQUESTED');
    expect(actions).toContain('PASSWORD_RESET_CODE_VERIFIED');
    expect(actions).toContain('PASSWORD_RESET_COMPLETED');
    // No code, no token, no password anywhere in the evidence.
    expect(JSON.stringify(rows)).not.toContain('audit-trail-password-1');

    await clearChallenges();
    await fullReset('owner.a@recovery.test', PW);
  });

  it('records an attempt on an address that has no eligible account', async () => {
    await prisma.posAuditLog.deleteMany();
    await forgot('nobody@recovery.test');
    const row = await prisma.posAuditLog.findFirst({ where: { action: 'PASSWORD_RESET_REQUESTED' } });
    expect(row.meta.outcome).toBe('no-eligible-account');
    expect(row.entityId).toBeNull();
  });
});
