// The on-disk capture folder: scripts/lib/maildrop.js.
//
// This is the seam between two processes that never meet. scripts/mail-sink.mjs
// writes a .eml for every message the backend sends; deploy/e2e-workflow.mjs
// starts minutes later, reads that folder, and seats its staff accounts from
// the codes in it. Neither can see the other break, and the harness they serve
// refuses to run on this host, so the format is asserted here instead.
//
// The messages are produced by the real mailer over a real socket, and written
// by the same writeMessage() the daemon calls. Nothing here fabricates a file
// and then parses its own invention.
//
// NOTHING LEAVES THIS BOX: the sink relays nothing.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';
import {
  writeMessage,
  readMessages,
  messagesTo,
  waitForCode,
  redeemEmailedCode,
} from '../scripts/lib/maildrop.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('maildrop.test.js requires a DATABASE_URL ending in _test');
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vexo-maildrop-'));

// Exactly the wiring in scripts/mail-sink.mjs — the sink's callback is the
// shared writer. If the daemon and this test disagreed about the format, they
// would have to disagree about this one line.
const sink = startSmtpSink({ port: 0, onMessage: (msg) => writeMessage(DIR, msg) });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@maildrop.test';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { prisma } = await import('../src/lib/prisma.js');
const { createApp } = await import('../src/app.js');
const { unusableCredential } = await import('../src/lib/crypto.js');
const mailer = await import('../src/lib/mail/mailer.js');
const templates = await import('../src/lib/mail/templates.js');

const app = createApp();

const mailCode = (to, code) =>
  mailer.sendMail({
    to,
    template: 'reset-code',
    message: templates.resetCodeEmail({ code, ttlMinutes: 10, maxAttempts: 5 }),
  });

beforeEach(() => {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f));
  sink.reset();
});
beforeAll(() => prisma.emailOutbox.deleteMany());
afterAll(async () => {
  await prisma.emailOutbox.deleteMany();
  await sink.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe('the capture folder a harness reads its codes out of', () => {
  it('writes one file per message and reads the code back out of it', async () => {
    await mailCode('cashier@maildrop.test', '31415926');

    const files = fs.readdirSync(DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.eml$/);

    expect(await waitForCode(DIR, 'cashier@maildrop.test')).toBe('31415926');
  });

  it('keeps the code out of everything but the file, which is not world-readable', async () => {
    await mailCode('cashier@maildrop.test', '27182818');

    const file = path.join(DIR, fs.readdirSync(DIR)[0]);
    // 0600. A drop folder holds live codes until they are spent; a harness
    // leaving them readable by every account on the box is a real exposure.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // The outbox ledger records that a message was sent, never its body.
    const row = await prisma.emailOutbox.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(row.status).toBe('SENT');
    expect(JSON.stringify(row)).not.toContain('27182818');
  });

  it('never hands one address another address’s code', async () => {
    // The harness seats two accounts back to back. Reading the folder rather
    // than the response is only safe if the folder can tell them apart.
    await mailCode('cashier@maildrop.test', '11111111');
    await mailCode('manager@maildrop.test', '22222222');

    expect(await waitForCode(DIR, 'cashier@maildrop.test')).toBe('11111111');
    expect(await waitForCode(DIR, 'manager@maildrop.test')).toBe('22222222');
    expect(messagesTo(DIR, 'cashier@maildrop.test')).toHaveLength(1);
  });

  it('matches the address whole, not as a substring', async () => {
    await mailCode('manager@maildrop.test', '33333333');
    // "ana@..." is inside "manager@..." as text. An envelope is a list of
    // addresses, so it must be compared as addresses.
    expect(messagesTo(DIR, 'ana@maildrop.test')).toHaveLength(0);
    expect(await waitForCode(DIR, 'ana@maildrop.test', { timeoutMs: 150 })).toBeNull();
  });

  it('is case- and angle-bracket-insensitive, because the envelope is', async () => {
    await mailCode('Cashier@Maildrop.Test', '44444444');
    expect(await waitForCode(DIR, 'cashier@maildrop.test')).toBe('44444444');
  });

  it('returns the newest code when an address has been sent more than one', async () => {
    // A resend supersedes: the older code no longer verifies, so a reader that
    // returned it would fail the redemption for a reason nothing would explain.
    await mailCode('cashier@maildrop.test', '55555555');
    await mailCode('cashier@maildrop.test', '66666666');

    expect(readMessages(DIR)).toHaveLength(2);
    expect(await waitForCode(DIR, 'cashier@maildrop.test')).toBe('66666666');
  });

  it('gives up rather than hanging when no message ever arrives', async () => {
    const started = Date.now();
    expect(await waitForCode(DIR, 'nobody@maildrop.test', { timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports an empty folder as no mail, not as a crash', () => {
    expect(readMessages(path.join(DIR, 'does-not-exist'))).toEqual([]);
  });
});

// The claim deploy/e2e-workflow.mjs makes when it seats its Cyber Hub staff.
// That harness refuses to run on this host, so the steps are asserted here
// against the same two routes, over the same folder, for an account in the same
// state POST /users leaves one in: a credential no string satisfies.
describe('seating an account from the folder, as the harness does', () => {
  // Cleaned up by id rather than by a table wipe: this database is shared with
  // every other test file, and a wipe here would pull rows out from under them.
  const made = { users: [], companies: [] };

  afterAll(async () => {
    await prisma.posSession.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.authChallenge.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.posUser.deleteMany({ where: { id: { in: made.users } } });
    await prisma.license.deleteMany({ where: { companyId: { in: made.companies } } });
    await prisma.company.deleteMany({ where: { id: { in: made.companies } } });
  });

  const hire = async (email) => {
    const company = await prisma.company.create({
      data: {
        name: 'Maildrop Diner',
        slug: `maildrop-${Date.now()}`,
        licenses: {
          create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
        },
      },
    });
    made.companies.push(company.id);
    const user = await prisma.posUser.create({
      data: {
        email,
        fullName: 'Maildrop Finance',
        role: 'FINANCE',
        companyId: company.id,
        passwordHash: await unusableCredential(),
        mustChangePassword: true,
      },
    });
    made.users.push(user.id);
    return user;
  };

  const post = async (path, body) => {
    const res = await request(app).post(`/api${path}`).send(body);
    return { status: res.status, body: res.body };
  };

  it('opens an account no password could open, and leaves it signed-in-able', async () => {
    const email = 'seated@maildrop.test';
    await hire(email);

    // Nobody can get in yet — not even with the hash that is stored, because
    // no string produces it. This is the state the whole mechanism exists for.
    const beforeAttempt = await post('/auth/login', { email, password: 'not-the-password' });
    expect(beforeAttempt.status).toBe(401);

    // The code is produced by the real recovery route and reaches the folder
    // the only way it ever does: through a real SMTP conversation.
    expect((await post('/auth/forgot-password', { email })).status).toBe(200);

    const chosen = await redeemEmailedCode({
      dir: DIR,
      email,
      password: 'chosen-by-the-person-1',
      post,
    });

    const signedIn = await post('/auth/login', { email, password: chosen });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    // Redeeming a code IS choosing a password, so nothing nags them to do it
    // again — the banner that would say so is for accounts predating this.
    expect(signedIn.body.user.mustChangePassword).toBe(false);
  });

  it('refuses to spend the same code twice', async () => {
    const email = 'replayed@maildrop.test';
    await hire(email);
    expect((await post('/auth/forgot-password', { email })).status).toBe(200);

    const code = await waitForCode(DIR, email);
    await redeemEmailedCode({ dir: DIR, email, password: 'first-choice-wins-1', post });

    // Redeeming does not shred the mail — the folder is a mailbox, not the
    // server's memory of the challenge. Re-read it the way deploy/e2e-workflow.mjs
    // does, so what gets replayed below is a code someone really could still
    // find, not one this test kept a private copy of.
    const stillOnDisk = await waitForCode(DIR, email);
    expect(stillOnDisk).toBe(code);

    // A forwarded or shoulder-read mail must not stay live once it is spent.
    const replay = await post('/auth/forgot-password/verify', { email, code: stillOnDisk });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it('says which address it gave up on, rather than timing out silently', async () => {
    await expect(
      redeemEmailedCode({
        dir: DIR,
        email: 'never-mailed@maildrop.test',
        password: 'irrelevant-12345',
        post,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/never-mailed@maildrop.test/);
  });
});
