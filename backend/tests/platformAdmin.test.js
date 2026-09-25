// The VEXO-side console: who administers the platform, and how a real customer
// company is brought into existence.
//
// Two properties carry this file and neither is provable from a screenshot.
//
//   1. Platform access is GRANTED, never inherited. There is no path here —
//      and none anywhere else — by which holding a mailbox, belonging to a
//      domain, or already owning some account turns into POS_SUPER_ADMIN.
//   2. The last active platform administrator cannot be disabled. Everything
//      that repairs this platform runs from these accounts, including the
//      screen that would re-enable one, so the mistake has no undo short of
//      database surgery.
//
// Mail is real throughout: an SMTP server on 127.0.0.1 receives every message,
// and every token used below is read out of the body that was actually
// delivered rather than fabricated from the row.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('platformAdmin.test.js requires a DATABASE_URL ending in _test');
}

const sink = startSmtpSink({ port: 0 });
await sink.started;

// Set before app.js is imported: config/env.js reads the environment once at
// load and decides there whether mail is configured at all.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@platform.test';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const PW = 'platform-admin-pw-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let rootAdmin, rootToken;

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

// The token out of the message that was actually delivered. The body is a
// base64 text/plain MIME part and the link carries the token in the URL
// fragment, so neither msg.raw nor the row will yield it.
const inviteTokenFor = (to) => {
  const msg = [...sink.messages].reverse().find((m) => m.envelope.to.join(',').includes(to));
  if (!msg) throw new Error(`no message delivered to ${to}`);
  const part = msg.raw.split(/--=_vexo_[0-9a-f]+/).find((p) => p.includes('text/plain'));
  const body = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  const token = body.match(/https:\/\/\S+#([A-Za-z0-9_-]{20,})/)?.[1];
  if (!token) throw new Error(`no accept link in the message to ${to}`);
  return token;
};

const login = async (email, password = PW) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const mkPlatformAdmin = (email, over = {}) =>
  prisma.posUser.create({
    data: {
      email,
      fullName: 'Platform Administrator',
      role: 'POS_SUPER_ADMIN',
      companyId: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      ...over,
    },
  });

beforeAll(wipe);
beforeEach(async () => {
  await wipe();
  sink.reset();
  rootAdmin = await mkPlatformAdmin('root@platform.test', { passwordHash: await hashPassword(PW) });
  rootToken = await login('root@platform.test');
});
afterAll(async () => {
  await wipe();
  await sink.close();
  await prisma.$disconnect();
});

const mkCompany = async (over = {}) => {
  const res = await request(app)
    .post('/api/atc/companies')
    .set(auth(rootToken))
    .send({ name: 'Brew Street', slug: `brew-street-${Math.random().toString(36).slice(2, 8)}`, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.company;
};

describe('onboarding a real customer company', () => {
  it('runs create → licence → invite owner → accept → sign in, with no password anywhere', async () => {
    const company = await mkCompany({ name: 'Brew Street Coffee' });
    expect(company.isDemo).toBe(false);

    const lic = await request(app)
      .post(`/api/atc/companies/${company.id}/licenses`)
      .set(auth(rootToken))
      .send({ plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: new Date(Date.now() + 365 * 86400e3).toISOString() });
    expect(lic.status, JSON.stringify(lic.body)).toBe(201);

    const invite = await request(app)
      .post(`/api/atc/companies/${company.id}/owner`)
      .set(auth(rootToken))
      .send({ email: 'owner@platform.test', fullName: 'Dana Owner' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);

    // Nothing in the response is usable as a credential. This endpoint used to
    // return a temporary password, which put a live secret into an API body, a
    // browser network tab, and any screenshot of the onboarding screen.
    const bodyText = JSON.stringify(invite.body);
    expect(invite.body.tempPassword).toBeUndefined();
    expect(bodyText).not.toMatch(/password/i);
    expect(bodyText).not.toMatch(/https?:\/\//);
    const row = await prisma.userInvitation.findUnique({ where: { id: invite.body.invitation.id } });
    expect(bodyText).not.toContain(row.tokenHash);

    // No account exists yet. The company has an owner only once the person on
    // the other end proves they hold the mailbox.
    expect(await prisma.posUser.count({ where: { email: 'owner@platform.test' } })).toBe(0);

    const token = inviteTokenFor('owner@platform.test');
    const accepted = await request(app)
      .post('/api/invite/accept')
      .send({ token, password: 'dana-chose-this-99' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    // Accepting is NOT signing in: the link proves the mailbox, not the person
    // at the keyboard, so no session comes back with it.
    expect(accepted.body.token).toBeUndefined();

    const ownerToken = await login('owner@platform.test', 'dana-chose-this-99');
    const me = await request(app).get('/api/auth/me').set(auth(ownerToken));
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('CUSTOMER_OWNER');
    // They chose it themselves and nobody else has ever seen it, so there is
    // nothing to force a change of.
    expect(me.body.user.mustChangePassword).toBe(false);

    const user = await prisma.posUser.findUnique({ where: { email: 'owner@platform.test' } });
    expect(user.companyId).toBe(company.id);
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('will not invite an owner into a company that is not active', async () => {
    const company = await mkCompany();
    const sus = await request(app)
      .patch(`/api/atc/companies/${company.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'SUSPENDED' });
    expect(sus.status).toBe(200);

    const res = await request(app)
      .post(`/api/atc/companies/${company.id}/owner`)
      .set(auth(rootToken))
      .send({ email: 'owner@platform.test', fullName: 'Dana Owner' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await prisma.userInvitation.count()).toBe(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses an address that already holds an account, rather than inviting a link that cannot be accepted', async () => {
    const company = await mkCompany();
    await prisma.posUser.create({
      data: {
        email: 'taken@platform.test',
        fullName: 'Someone Else',
        role: 'CASHIER',
        companyId: company.id,
        passwordHash: await hashPassword(PW),
      },
    });

    const res = await request(app)
      .post(`/api/atc/companies/${company.id}/owner`)
      .set(auth(rootToken))
      .send({ email: 'taken@platform.test', fullName: 'Dana Owner' });
    expect(res.status).toBe(409);
    expect(sink.messages).toHaveLength(0);
    // Untouched: an invitation is never an upgrade of an existing account.
    const after = await prisma.posUser.findUnique({ where: { email: 'taken@platform.test' } });
    expect(after.role).toBe('CASHIER');
  });

  it('resending mints a new link and kills the old one', async () => {
    const company = await mkCompany();
    const invite = await request(app)
      .post(`/api/atc/companies/${company.id}/owner`)
      .set(auth(rootToken))
      .send({ email: 'owner@platform.test', fullName: 'Dana Owner' });
    expect(invite.status).toBe(201);
    const first = inviteTokenFor('owner@platform.test');

    // The cooldown is real, so the row is aged rather than the test waiting.
    await prisma.userInvitation.update({
      where: { id: invite.body.invitation.id },
      data: { lastSentAt: new Date(Date.now() - 10 * 60_000) },
    });

    const resent = await request(app)
      .post(`/api/atc/invitations/${invite.body.invitation.id}/resend`)
      .set(auth(rootToken))
      .send({});
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body.invitation.sentCount).toBe(2);

    const second = inviteTokenFor('owner@platform.test');
    expect(second).not.toBe(first);

    // An invitation forwarded by mistake must not stay live for its full week
    // just because a fresh one was issued.
    const stale = await request(app).post('/api/invite/accept').send({ token: first, password: 'nope-nope-nope-1' });
    expect(stale.status).toBe(400);
    expect(await prisma.posUser.count({ where: { email: 'owner@platform.test' } })).toBe(0);

    const ok = await request(app).post('/api/invite/accept').send({ token: second, password: 'dana-chose-this-99' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('a resend inside the cooldown is refused, so the button cannot post somebody a message per press', async () => {
    const company = await mkCompany();
    const invite = await request(app)
      .post(`/api/atc/companies/${company.id}/owner`)
      .set(auth(rootToken))
      .send({ email: 'owner@platform.test', fullName: 'Dana Owner' });
    expect(invite.status).toBe(201);

    const res = await request(app)
      .post(`/api/atc/invitations/${invite.body.invitation.id}/resend`)
      .set(auth(rootToken))
      .send({});
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('POS_RATE_LIMITED');
    expect(sink.messages).toHaveLength(1);
  });

  it('revoking kills the link before it is used', async () => {
    const company = await mkCompany();
    const invite = await request(app)
      .post(`/api/atc/companies/${company.id}/owner`)
      .set(auth(rootToken))
      .send({ email: 'owner@platform.test', fullName: 'Dana Owner' });
    const token = inviteTokenFor('owner@platform.test');

    const rev = await request(app)
      .post(`/api/atc/invitations/${invite.body.invitation.id}/revoke`)
      .set(auth(rootToken))
      .send({});
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body.invitation.status).toBe('REVOKED');

    const res = await request(app).post('/api/invite/accept').send({ token, password: 'dana-chose-this-99' });
    expect(res.status).toBe(400);
    expect(await prisma.posUser.count({ where: { email: 'owner@platform.test' } })).toBe(0);
  });
});

// A gate with no key is not a feature, it is an outage. The inventory module
// is refused to every company by default, so there has to be a way for VEXO to
// sell it — and this is the only one. Nothing in the customer-facing API can
// set it, which is the point.
describe('selling an extension module with a licence', () => {
  const issue = (companyId, body) =>
    request(app)
      .post(`/api/atc/companies/${companyId}/licenses`)
      .set(auth(rootToken))
      .send({ plan: 'MULTI_STORE', expiresAt: new Date(Date.now() + 365 * 86400e3).toISOString(), ...body });

  it('grants a module on the licence, and records the grant in the audit trail', async () => {
    const company = await mkCompany({ name: 'Module Buyer' });
    const res = await issue(company.id, { modules: ['INVENTORY'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.license.modules).toEqual(['INVENTORY']);

    const stored = await prisma.license.findUnique({ where: { id: res.body.license.id } });
    expect(stored.modules).toEqual(['INVENTORY']);

    // Who turned Inventory on for this customer, and when. A module grant is a
    // commercial act, so it has to be answerable from the record rather than
    // from the current value of a column.
    const entry = await prisma.posAuditLog.findFirst({
      where: { action: 'LICENSE_ISSUE', companyId: company.id },
      orderBy: { at: 'desc' },
    });
    expect(entry.meta.modules).toEqual(['INVENTORY']);
  });

  it('defaults to core POS only when no module is named', async () => {
    const company = await mkCompany({ name: 'Core Only' });
    const res = await issue(company.id, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // An empty array, not null: every licence issued before this column
    // existed says core POS only, and that has to keep being what it says.
    expect(res.body.license.modules).toEqual([]);
  });

  it('refuses a module nobody sells, rather than storing it', async () => {
    const company = await mkCompany({ name: 'Typo Buyer' });
    // The column is an array of strings, so the database cannot tell a typo
    // from a product. A customer who has paid for "INVENTROY" would find the
    // screens shut and nothing in the system able to explain why.
    const res = await issue(company.id, { modules: ['INVENTROY'] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await prisma.license.count({ where: { companyId: company.id } }), 'and issued nothing').toBe(0);
  });

  it('stores the same module once however many times it is named', async () => {
    const company = await mkCompany({ name: 'Double Buyer' });
    const res = await issue(company.id, { modules: ['INVENTORY', 'INVENTORY'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.license.modules).toEqual(['INVENTORY']);
  });
});

describe('who may reach the VEXO console at all', () => {
  it('turns away a customer owner, however senior inside their own tenant', async () => {
    const company = await mkCompany();
    await prisma.posUser.create({
      data: {
        email: 'owner@platform.test',
        fullName: 'Dana Owner',
        role: 'CUSTOMER_OWNER',
        companyId: company.id,
        passwordHash: await hashPassword(PW),
      },
    });
    const ownerToken = await login('owner@platform.test');

    for (const call of [
      request(app).get('/api/atc/platform-admins').set(auth(ownerToken)),
      request(app).get('/api/atc/companies').set(auth(ownerToken)),
      request(app).post('/api/atc/platform-admins').set(auth(ownerToken)).send({ email: 'x@platform.test', fullName: 'X Y' }),
      request(app).post('/api/atc/companies').set(auth(ownerToken)).send({ name: 'Theirs', slug: 'theirs' }),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
    }
    expect(await prisma.userInvitation.count()).toBe(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses a customer principal on EVERY platform endpoint, including ones added later', async () => {
    // The test above hand-lists four paths. This one asks the router what it
    // actually serves, because the realistic way to ship an unguarded platform
    // endpoint is not to weaken `requireAtc` — it is to add a route ABOVE the
    // `router.use(requirePosAuth, requireAtc)` line, where the guard never
    // runs. Hand-written lists cannot catch that; enumeration can, and it
    // covers endpoints nobody has written yet.
    const { default: atcRouter } = await import('../src/api/routes/atc.js');
    const endpoints = atcRouter.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route.methods)
          .filter((m) => m !== '_all')
          .map((method) => ({ method, path: layer.route.path })),
      );
    // Guards the enumeration itself. Without this, a future Express that
    // changes the shape of `router.stack` would yield an empty list and the
    // loop below would vacuously pass — the worst kind of green. Anchored on
    // paths rather than a count, so legitimately retiring an endpoint does not
    // fail here for the wrong reason.
    const paths = new Set(endpoints.map((e) => e.path));
    for (const known of ['/companies', '/platform-admins', '/companies/:companyId/licenses']) {
      expect(paths, 'router enumeration looks broken, not merely changed').toContain(known);
    }

    const company = await mkCompany();
    await prisma.posUser.create({
      data: {
        email: 'owner@platform.test',
        fullName: 'Senior Owner',
        role: 'CUSTOMER_OWNER',
        companyId: company.id,
        passwordHash: await hashPassword(PW),
      },
    });
    const ownerToken = await login('owner@platform.test');
    const before = {
      companies: await prisma.company.count(),
      users: await prisma.posUser.count(),
      licenses: await prisma.license.count(),
    };

    for (const { method, path } of endpoints) {
      const url = `/api/atc${path.replace(/:[A-Za-z0-9_]+/g, 'cmugabrmq00025jywjhfhz02f')}`;
      const pending = request(app)[method](url).set(auth(ownerToken));
      const res = method === 'get' ? await pending : await pending.send({});
      // 403 specifically: a 404 would mean the request got past the guard and
      // was merely looking for a row, and a 500 would mean it got further still.
      expect(res.status, `${method.toUpperCase()} ${url}`).toBe(403);
    }

    // Refused all the way down — nothing was written on the way to a 403.
    expect(await prisma.company.count()).toBe(before.companies);
    expect(await prisma.posUser.count()).toBe(before.users);
    expect(await prisma.license.count()).toBe(before.licenses);
    expect(await prisma.userInvitation.count()).toBe(0);
    expect(sink.messages).toHaveLength(0);
  });
});

describe('platform administrators', () => {
  it('lists the administrators and how many are active, and never a token', async () => {
    await mkPlatformAdmin('second@platform.test', { passwordHash: await hashPassword(PW), status: 'DISABLED' });
    const res = await request(app).get('/api/atc/platform-admins').set(auth(rootToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.admins.map((a) => a.email).sort()).toEqual(['root@platform.test', 'second@platform.test']);
    expect(res.body.activeCount).toBe(1);
    // A management screen — or a screenshot of one — must not be replayable
    // into an account.
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|passwordHash/);
  });

  it('appoints another administrator by invitation, who then holds platform scope', async () => {
    const res = await request(app)
      .post('/api/atc/platform-admins')
      .set(auth(rootToken))
      .send({ email: 'second@platform.test', fullName: 'Second Admin' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\/|password/i);

    const token = inviteTokenFor('second@platform.test');
    const accepted = await request(app).post('/api/invite/accept').send({ token, password: 'second-chose-this-1' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    const user = await prisma.posUser.findUnique({ where: { email: 'second@platform.test' } });
    expect(user.role).toBe('POS_SUPER_ADMIN');
    // Platform scope, not a tenant's. A POS_SUPER_ADMIN carrying a companyId
    // would read as an administrator while being scoped to one customer.
    expect(user.companyId).toBeNull();

    const secondToken = await login('second@platform.test', 'second-chose-this-1');
    const console_ = await request(app).get('/api/atc/companies').set(auth(secondToken));
    expect(console_.status).toBe(200);
  });

  it('records the appointment in the audit trail without the link', async () => {
    const res = await request(app)
      .post('/api/atc/platform-admins')
      .set(auth(rootToken))
      .send({ email: 'second@platform.test', fullName: 'Second Admin' });
    expect(res.status).toBe(201);

    const row = await prisma.posAuditLog.findFirst({ where: { action: 'PLATFORM_ADMIN_INVITED' } });
    expect(row, 'no PLATFORM_ADMIN_INVITED audit row').toBeTruthy();
    expect(row.actorEmail).toBe('root@platform.test');
    const invitation = await prisma.userInvitation.findUnique({ where: { id: res.body.invitation.id } });
    expect(JSON.stringify(row.meta)).not.toContain(invitation.tokenHash);
    expect(JSON.stringify(row.meta)).not.toContain(inviteTokenFor('second@platform.test'));
  });

  it('refuses to disable the only active administrator', async () => {
    // A second admin exists but is DISABLED, so the count that matters is one.
    // This is the shape that makes a naive "is there another row" check wrong.
    const other = await mkPlatformAdmin('second@platform.test', {
      passwordHash: await hashPassword(PW),
      status: 'DISABLED',
    });

    const res = await request(app)
      .patch(`/api/atc/platform-admins/${rootAdmin.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'DISABLED' });
    // WHICH refusal, not merely that one happened. The self-disable rule would
    // also stop this call, so a bare 4xx here would stay green with the
    // last-admin rule deleted — and that is the rule with no undo.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toMatch(/only active platform administrator/i);

    const after = await prisma.posUser.findUnique({ where: { id: rootAdmin.id } });
    expect(after.status).toBe('ACTIVE');
    expect((await prisma.posUser.findUnique({ where: { id: other.id } })).status).toBe('DISABLED');
  });

  it('does not count a company-scoped POS_SUPER_ADMIN as another platform administrator', async () => {
    // A POS_SUPER_ADMIN row carrying a companyId is not a platform
    // administrator — it cannot reach the platform surface the way one does.
    // Counting it would make "there is another admin" read as true while being
    // false, which is exactly how the last real one gets disabled.
    const company = await mkCompany();
    await prisma.posUser.create({
      data: {
        email: 'scoped@platform.test',
        fullName: 'Scoped Admin',
        role: 'POS_SUPER_ADMIN',
        companyId: company.id,
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });

    const res = await request(app)
      .patch(`/api/atc/platform-admins/${rootAdmin.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'DISABLED' });
    // The last-admin refusal specifically: if the scoped row were counted, this
    // would sail past it and be stopped only by the self-disable rule, which
    // says something quite different and would not have saved the platform.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toMatch(/only active platform administrator/i);
    expect((await prisma.posUser.findUnique({ where: { id: rootAdmin.id } })).status).toBe('ACTIVE');

    // And it is not listed as one either.
    const list = await request(app).get('/api/atc/platform-admins').set(auth(rootToken));
    expect(list.body.admins.map((a) => a.email)).toEqual(['root@platform.test']);
  });

  it('refuses to disable yourself even when another active administrator exists', async () => {
    await mkPlatformAdmin('second@platform.test', { passwordHash: await hashPassword(PW) });
    const res = await request(app)
      .patch(`/api/atc/platform-admins/${rootAdmin.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'DISABLED' });
    // The platform survives this one, so it is the OTHER refusal — the pair is
    // only meaningful if each test pins the message it expects.
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/your own platform administrator account/i);
    expect((await prisma.posUser.findUnique({ where: { id: rootAdmin.id } })).status).toBe('ACTIVE');
  });

  it('disables another administrator once one remains, and ends their session immediately', async () => {
    const other = await mkPlatformAdmin('second@platform.test', { passwordHash: await hashPassword(PW) });
    const otherToken = await login('second@platform.test');
    // Live before: so the revocation below is shown to be what ends it.
    expect((await request(app).get('/api/atc/companies').set(auth(otherToken))).status).toBe(200);

    const res = await request(app)
      .patch(`/api/atc/platform-admins/${other.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'DISABLED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.admin.status).toBe('DISABLED');

    // A disabled administrator with a live session is still an administrator
    // until it expires, so the session is cut with the status.
    const after = await request(app).get('/api/atc/companies').set(auth(otherToken));
    expect(after.status).toBe(401);
    expect(await prisma.posSession.count({ where: { userId: other.id, revokedAt: null } })).toBe(0);
  });

  it('re-enabling the disabled one restores the count, and it can then be used to disable the other', async () => {
    const other = await mkPlatformAdmin('second@platform.test', {
      passwordHash: await hashPassword(PW),
      status: 'DISABLED',
    });

    const on = await request(app)
      .patch(`/api/atc/platform-admins/${other.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'ACTIVE' });
    expect(on.status).toBe(200);

    const otherToken = await login('second@platform.test');
    const res = await request(app)
      .patch(`/api/atc/platform-admins/${rootAdmin.id}/status`)
      .set(auth(otherToken))
      .send({ status: 'DISABLED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await prisma.posUser.findUnique({ where: { id: rootAdmin.id } })).status).toBe('DISABLED');
  });

  it('will not touch a tenant account through the platform-admin route', async () => {
    const company = await mkCompany();
    const tenant = await prisma.posUser.create({
      data: {
        email: 'owner@platform.test',
        fullName: 'Dana Owner',
        role: 'CUSTOMER_OWNER',
        companyId: company.id,
        passwordHash: await hashPassword(PW),
      },
    });

    const res = await request(app)
      .patch(`/api/atc/platform-admins/${tenant.id}/status`)
      .set(auth(rootToken))
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(404);
    expect((await prisma.posUser.findUnique({ where: { id: tenant.id } })).status).toBe('ACTIVE');
  });

  it('cannot promote an existing account to platform administrator by inviting its address', async () => {
    const company = await mkCompany();
    await prisma.posUser.create({
      data: {
        email: 'cashier@platform.test',
        fullName: 'A Cashier',
        role: 'CASHIER',
        companyId: company.id,
        passwordHash: await hashPassword(PW),
      },
    });

    const res = await request(app)
      .post('/api/atc/platform-admins')
      .set(auth(rootToken))
      .send({ email: 'cashier@platform.test', fullName: 'A Cashier' });
    expect(res.status).toBe(409);

    // The rule this protects: platform access is granted deliberately, never
    // inherited from already owning an address on the platform.
    const after = await prisma.posUser.findUnique({ where: { email: 'cashier@platform.test' } });
    expect(after.role).toBe('CASHIER');
    expect(after.companyId).toBe(company.id);
    expect(sink.messages).toHaveLength(0);
  });
});
