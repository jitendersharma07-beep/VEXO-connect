// What password recovery answers when the mail provider is NOT working.
//
// The sibling suite proves the happy path, including that an unregistered
// address is answered exactly like a registered one. That property is the whole
// security model of this route, and it used to hold only while SMTP was
// healthy: a send failure propagated out of the request handler as a 500, while
// an unregistered address returned 200 without ever attempting a send. Anyone
// could then read membership off the status code — and precisely when a
// deployment is least likely to notice, because its mail is already broken.
//
// So this file runs the same route against a provider that cannot work. There
// is no mock: SMTP_PORT points at a port nothing listens on, so the client
// takes a real ECONNREFUSED, the same way it would against a provider that is
// down, blocked by a firewall, or simply typed wrong.
//
// Runs ONLY against a database whose name ends in _test — it deletes rows.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('accountRecoveryOutage.test.js requires a DATABASE_URL ending in _test');
}

// Mail is CONFIGURED — mailEnabled must be true, or the route short-circuits on
// 503 and proves nothing. It is configured to somewhere that cannot answer.
// Port 1 is privileged and unused, so the connection is refused immediately
// rather than hanging until the 20 s socket timeout.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@outage.test';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { mailEnabled } = await import('../src/config/env.js');

const app = createApp();
const forgot = (email) => request(app).post('/api/auth/forgot-password').send({ email });

let owner, unreachable;

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword('outage-password-1');
  const company = await prisma.company.create({
    data: {
      name: 'Outage Retail',
      slug: 'outage-retail',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  const mk = (data) => prisma.posUser.create({ data: { passwordHash, companyId: company.id, ...data } });
  // Inside the allow-list: the send is attempted and the socket refuses it.
  owner = await mk({ email: 'owner@outage.test', fullName: 'Outage Owner', role: 'CUSTOMER_OWNER' });
  // Outside it: refused before a socket is ever opened. A different failure on
  // a different line, and the one a typo'd allow-list actually produces.
  unreachable = await mk({ email: 'owner@elsewhere.test', fullName: 'Elsewhere Owner', role: 'CUSTOMER_OWNER' });
});

beforeEach(async () => {
  await prisma.authChallenge.deleteMany();
  await prisma.emailOutbox.deleteMany();
});

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

describe('recovery when the mail provider is broken', () => {
  it('is actually configured, so the route is not short-circuiting on 503', () => {
    // The control for every assertion below. If mail were unconfigured the
    // route would answer 503 to everyone, which is also indistinguishable —
    // but for a reason that would make this file vacuous.
    expect(mailEnabled).toBe(true);
  });

  it('really does fail to send — the outbox records the attempt as FAILED', async () => {
    // Positive control. Without this, "both answered 200" could just mean no
    // send was ever tried and the test proves nothing about an outage.
    const res = await forgot('owner@outage.test');
    expect(res.status).toBe(200);

    const outbox = await prisma.emailOutbox.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('FAILED');
    expect(outbox[0].to).toBe('owner@outage.test');
  });

  it('answers a registered address exactly as an unregistered one', async () => {
    const registered = await forgot('owner@outage.test');
    const unregistered = await forgot('nobody@outage.test');

    // The regression this file exists for: registered used to be 500 here.
    expect(registered.status).toBe(200);
    expect(registered.status).toBe(unregistered.status);
    expect(registered.body).toEqual(unregistered.body);
  });

  it('got far enough to try — the registered address minted a challenge, the unknown one did not', async () => {
    // Identical answers are only worth something if the registered path
    // actually reached the send and failed there. A challenge row is the proof
    // it was not quietly skipped somewhere earlier.
    await forgot('owner@outage.test');
    await forgot('nobody@outage.test');

    expect(await prisma.authChallenge.count({ where: { userId: owner.id } })).toBe(1);
    expect(await prisma.authChallenge.count()).toBe(1);
  });

  it('answers identically when the allow-list refuses the recipient, and leaves no outbox row', async () => {
    // A mistyped MAIL_ALLOWED_RECIPIENTS is the likeliest first-run
    // misconfiguration, and it is rejected before the outbox row is created —
    // so the response is the only thing an operator could have read, and the
    // server log is the only trace. Both of those facts are asserted here.
    const refused = await forgot('owner@elsewhere.test');
    const unregistered = await forgot('nobody@elsewhere.test');

    expect(refused.status).toBe(200);
    expect(refused.status).toBe(unregistered.status);
    expect(refused.body).toEqual(unregistered.body);

    expect(await prisma.emailOutbox.count()).toBe(0);
    expect(await prisma.authChallenge.count({ where: { userId: unreachable.id } })).toBe(1);
  });
});
