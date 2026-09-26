// Tenant isolation across the UNAUTHENTICATED half of the merged accounts
// code — password recovery and invitation acceptance.
//
// Why a separate file, when both routes already have suites:
//
//   - `accountRecovery.test.js` is effectively single-tenant. It builds
//     companyA, a SUSPENDED company and a LAPSED-licence company, but the two
//     extra tenants exist to test *eligibility* (skip the suspended, serve the
//     lapsed), not isolation. Its one cross-account check — "refuses another
//     account's code" — pits ownerA against cashierA, who are both inside
//     companyA. That proves the code is bound to a user. It does not prove the
//     binding survives a tenant boundary, which is a different claim and the
//     one a customer cares about.
//
//   - `invitations.test.js` already IS two-tenant and covers its side properly:
//     a foreign store is refused 404 on create, a foreign invitation is
//     indistinguishable from one that never existed, the listing shows one
//     tenant its own rows only, and acceptance lands the new user in the
//     inviting company. Nothing here duplicates that. What is added below is
//     the one property that spans both routes — that their tokens live in
//     separate namespaces.
//
// Why it is not covered by the 58 isolation probes in the acceptance record:
// every one of those was authenticated, and they predate this merge. An
// unauthenticated endpoint has no session to scope it, so its isolation rests
// entirely on what the submitted token or address is bound to — which is
// exactly what is asserted here and could not have been asserted there.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('authTenantIsolation.test.js requires a DATABASE_URL ending in _test');
}

const sink = startSmtpSink({ port: 0 });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@isolation.test';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { createInvitation } = await import('../src/lib/invitations.js');

const app = createApp();

const PW_A = 'tenant-a-password-1';
const PW_B = 'tenant-b-password-1';
const NEW_PW = 'brand-new-password-9';

const A = 'owner.a@isolation.test';
const B = 'owner.b@isolation.test';

let companyA, companyB, ownerA, ownerB;

// Read out of the message the sink actually received, never from the database:
// a code the verifier accepts but the mailbox never saw would prove nothing
// about what an attacker can hold.
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
const resetRaw = (body) => request(app).post('/api/auth/forgot-password/reset').send(body);
const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

const clearChallenges = () => prisma.authChallenge.deleteMany();
const hashOf = async (id) => (await prisma.posUser.findUnique({ where: { id } })).passwordHash;

// Request → verify, returning the reset authorization. Stops short of spending
// it, because several tests below are about what the authorization can and
// cannot be pointed at.
const authorizationFor = async (email) => {
  await clearChallenges();
  expect((await forgot(email)).status).toBe(200);
  const v = await verify(email, codeFromLastMail(email));
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return v.body.resetToken;
};

beforeAll(async () => {
  await wipeAll();
  const future = new Date(Date.now() + 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Isolation Tenant A',
      slug: 'isolation-a',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: future } },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Isolation Tenant B',
      slug: 'isolation-b',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: future } },
    },
  });

  ownerA = await prisma.posUser.create({
    data: {
      email: A,
      fullName: 'Owner A',
      role: 'CUSTOMER_OWNER',
      companyId: companyA.id,
      passwordHash: await hashPassword(PW_A),
    },
  });
  ownerB = await prisma.posUser.create({
    data: {
      email: B,
      fullName: 'Owner B',
      role: 'CUSTOMER_OWNER',
      companyId: companyB.id,
      passwordHash: await hashPassword(PW_B),
    },
  });
});

beforeEach(async () => {
  sink.reset();
  await clearChallenges();
  await prisma.emailOutbox.deleteMany();
});

afterAll(async () => {
  await wipeAll();
  await sink.close();
  await prisma.$disconnect();
});

describe('a recovery code is bound to one account in one tenant', () => {
  it('will not verify another tenant’s owner, and costs that owner an attempt', async () => {
    await forgot(A);
    const codeA = codeFromLastMail(A);
    await forgot(B);

    const res = await verify(B, codeA);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not valid or has expired');

    // Tenant B's own budget paid for the guess — the same accounting the
    // within-tenant case gets. Anything else would make a cross-tenant guess
    // cheaper than a local one.
    const row = await prisma.authChallenge.findFirst({ where: { userId: ownerB.id } });
    expect(row.attempts).toBe(1);
  });

  it('does not hand back an authorization for the tenant whose code it was', async () => {
    await forgot(A);
    const codeA = codeFromLastMail(A);
    await forgot(B);

    const res = await verify(B, codeA);
    expect(res.body.resetToken).toBeUndefined();
    // And tenant A's challenge is untouched: B's failed guess must not consume
    // or supersede the code A is still waiting to type.
    const rowA = await prisma.authChallenge.findFirst({ where: { userId: ownerA.id } });
    expect(rowA.attempts).toBe(0);
    expect(rowA.verifiedAt).toBeNull();
    expect(rowA.consumedAt).toBeNull();
  });
});

describe('a reset authorization moves exactly one password', () => {
  it('leaves the other tenant’s credential and sessions alone', async () => {
    const sessionB = await login(B, PW_B);
    expect(sessionB.status).toBe(200);
    const hashBBefore = await hashOf(ownerB.id);

    const token = await authorizationFor(A);
    expect((await resetRaw({ resetToken: token, password: NEW_PW, confirmPassword: NEW_PW })).status).toBe(200);

    // A moved.
    expect((await login(A, NEW_PW)).status).toBe(200);
    // B did not — byte-identical hash, not merely "still logs in": a rehash
    // with the same plaintext would pass a login check and still mean the
    // reset had reached into the wrong tenant's row.
    expect(await hashOf(ownerB.id)).toBe(hashBBefore);
    expect((await login(B, PW_B)).status).toBe(200);

    // revokeAllSessions is scoped to the one user, so B's open tab survives.
    const stillGood = await request(app)
      .get('/api/auth/me')
      .set({ Authorization: `Bearer ${sessionB.body.token}` });
    expect(stillGood.status).toBe(200);
    expect(stillGood.body.user.email).toBe(B);

    // Put A back, so order between tests cannot matter.
    const back = await authorizationFor(A);
    expect((await resetRaw({ resetToken: back, password: PW_A, confirmPassword: PW_A })).status).toBe(200);
  });

  // The reset body names no account — only the authorization does. This pins
  // that it stays that way: if a later change accepted an `email` and trusted
  // it, a token earned for one tenant would become a password write in
  // another, and every assertion above would still pass.
  it('ignores an account named in the body and resets the token’s own account', async () => {
    const hashBBefore = await hashOf(ownerB.id);
    const token = await authorizationFor(A);

    const res = await resetRaw({
      resetToken: token,
      password: NEW_PW,
      confirmPassword: NEW_PW,
      email: B,
      userId: ownerB.id,
      companyId: companyB.id,
    });
    expect(res.status).toBe(200);

    expect((await login(A, NEW_PW)).status).toBe(200);
    expect(await hashOf(ownerB.id)).toBe(hashBBefore);
    expect((await login(B, PW_B)).status).toBe(200);

    const back = await authorizationFor(A);
    expect((await resetRaw({ resetToken: back, password: PW_A, confirmPassword: PW_A })).status).toBe(200);
  });

  // The verify step is not the decision. Eligibility is re-read when the
  // authorization is spent, and a tenant stopped in between must win — the
  // company-level twin of the existing "will not resurrect an account disabled
  // while the token was live".
  it('refuses an authorization whose tenant was suspended while it was live', async () => {
    const token = await authorizationFor(B);
    const hashBefore = await hashOf(ownerB.id);

    await prisma.company.update({ where: { id: companyB.id }, data: { status: 'SUSPENDED' } });
    try {
      const res = await resetRaw({ resetToken: token, password: NEW_PW, confirmPassword: NEW_PW });
      expect(res.status).toBe(400);
      expect(await hashOf(ownerB.id)).toBe(hashBefore);
    } finally {
      await prisma.company.update({ where: { id: companyB.id }, data: { status: 'ACTIVE' } });
    }
    expect((await login(B, PW_B)).status).toBe(200);
  });
});

describe('the request endpoint is not a tenant oracle', () => {
  // The suites already prove a registered address and an unknown one answer
  // alike. The missing question is narrower and is the one a competitor asks:
  // given an address, can I learn WHICH tenant it belongs to, or that two
  // addresses belong to different ones. Every answer has to be the same bytes.
  it('answers for either tenant and for nobody with byte-identical bodies', async () => {
    const results = [];
    for (const email of [A, B, 'stranger@isolation.test']) {
      await clearChallenges();
      const res = await forgot(email);
      results.push({ status: res.status, body: JSON.stringify(res.body) });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0].status).toBe(200);
    // Nothing tenant-shaped in the one public answer.
    expect(results[0].body).not.toMatch(/Isolation Tenant|isolation-a|isolation-b/);
    expect(results[0].body).not.toContain(companyA.id);
    expect(results[0].body).not.toContain(companyB.id);
  });

  it('does not name the tenant in the mail it sends either', async () => {
    await forgot(B);
    const msg = [...sink.messages].reverse().find((m) => m.envelope.to.join(',').includes(B));
    expect(msg).toBeDefined();
    expect(msg.raw).not.toContain(companyA.id);
    expect(msg.raw).not.toContain(A);
  });
});

describe('one address belongs to at most one tenant', () => {
  // The structural premise of the whole email-keyed flow: both handlers resolve
  // the account with findUnique({ where: { email } }). That is unambiguous only
  // because the column is globally unique. If a migration ever made it unique
  // per tenant instead, the lookup would have to choose, and "recover the
  // account for this address" would silently pick one tenant's user — so the
  // constraint is asserted here rather than assumed from the schema file.
  it('cannot be registered in a second tenant', async () => {
    const passwordHash = await hashPassword(PW_B);
    await expect(
      prisma.posUser.create({
        data: { email: A, fullName: 'Impostor A', role: 'CASHIER', companyId: companyB.id, passwordHash },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Positive control, so the assertion above cannot pass merely because this
    // create was going to fail anyway. The same row with an unused address is
    // accepted — it is the address that is refused, not the placement.
    const ok = await prisma.posUser.create({
      data: { email: 'spare.b@isolation.test', fullName: 'Spare B', role: 'CASHIER', companyId: companyB.id, passwordHash },
    });
    expect(ok.companyId).toBe(companyB.id);
    await prisma.posUser.delete({ where: { id: ok.id } });
  });

  it('cannot be invited into a second tenant either', async () => {
    await expect(
      createInvitation(prisma, {
        companyId: companyB.id,
        email: A,
        fullName: 'Impostor A',
        role: 'CASHIER',
      }),
    ).rejects.toBeTruthy();
  });
});

describe('the two token namespaces do not cross', () => {
  // Both routes take an opaque token from an email and both are
  // unauthenticated. They must not be interchangeable: an invitation is an
  // offer of an account that does not exist yet, and a reset authorization is
  // write access to one that does.
  it('an invitation token is not a password reset authorization', async () => {
    const { token } = await createInvitation(prisma, {
      companyId: companyB.id,
      email: 'newjoiner.b@isolation.test',
      fullName: 'New Joiner B',
      role: 'CASHIER',
    });

    const res = await resetRaw({ resetToken: token, password: NEW_PW, confirmPassword: NEW_PW });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('resetToken');

    // And the invitation is still usable: a rejected cross-use must not burn
    // the link the new joiner is holding.
    const lookup = await request(app).post('/api/invite/lookup').send({ token });
    expect(lookup.status).toBe(200);
    expect(lookup.body.invitation.companyName).toBe('Isolation Tenant B');
  });

  it('a password reset authorization is not an invitation token', async () => {
    const token = await authorizationFor(A);

    const lookup = await request(app).post('/api/invite/lookup').send({ token });
    expect(lookup.status).toBe(400);
    const accept = await request(app)
      .post('/api/invite/accept')
      .send({ token, password: NEW_PW, confirmPassword: NEW_PW });
    expect(accept.status).toBe(400);

    // No account was created for it, and the authorization is still A's own.
    expect(await prisma.posUser.count({ where: { companyId: companyB.id } })).toBe(1);
    expect((await resetRaw({ resetToken: token, password: PW_A, confirmPassword: PW_A })).status).toBe(200);
  });
});
