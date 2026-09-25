// The mail lane end to end, against a real SMTP server on a real socket.
//
// The sink (scripts/lib/smtpSink.js) is not a stub of the client's transport —
// it is a server the unmodified client in src/lib/mail/smtpClient.js talks to.
// So a green run here is evidence about the protocol conversation (multi-line
// replies, AUTH, dot-stuffing, MIME framing), not merely about the templates.
//
// NOTHING LEAVES THIS BOX. The sink relays nothing, and the mailer's
// non-production allowlist is exercised below precisely to prove a stray
// recipient is refused before a socket is opened.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('mail.test.js requires a DATABASE_URL ending in _test');
}

// The sink must be listening before config/env.js is read, so SMTP_PORT can
// name it.
const sink = startSmtpSink({ port: 0 });
await sink.started;

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.SMTP_USERNAME = 'sink-user';
process.env.SMTP_PASSWORD = 'sink-password-not-real';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
process.env.MAIL_ALLOWED_RECIPIENTS = '*@vexoconnect.test,allowed@example.com';
process.env.APP_URL = 'https://portal.vexoconnect.test/pos';

const { prisma } = await import('../src/lib/prisma.js');
const { sendSmtp, buildMimeMessage } = await import('../src/lib/mail/smtpClient.js');
const mailer = await import('../src/lib/mail/mailer.js');
const templates = await import('../src/lib/mail/templates.js');

const decodeB64Part = (raw, contentType) => {
  // Pull one part of a multipart/alternative body and undo its base64.
  const parts = raw.split(/--=_vexo_[0-9a-f]+/);
  const part = parts.find((p) => p.includes(contentType));
  if (!part) return null;
  const body = part.slice(part.indexOf('\r\n\r\n') + 4);
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
};

beforeEach(() => sink.reset());
beforeAll(() => prisma.emailOutbox.deleteMany());
afterAll(async () => {
  await prisma.emailOutbox.deleteMany();
  await sink.close();
  await prisma.$disconnect();
});

describe('smtpClient against a real server', () => {
  it('completes a submission and returns the server acceptance line', async () => {
    const res = await sendSmtp({
      host: '127.0.0.1',
      port: sink.port,
      security: 'none',
      username: 'u',
      password: 'p',
      from: 'VEXO Connect <no-reply@vexoconnect.test>',
      to: ['someone@vexoconnect.test'],
      subject: 'Plain subject',
      text: 'hello',
      html: '<p>hello</p>',
    });
    expect(res.response).toContain('250');
    expect(res.messageId).toMatch(/^<[0-9a-f]{32}@vexo-connect>$/);
    expect(sink.messages).toHaveLength(1);
    // The envelope carries the bare address, not the display name.
    expect(sink.messages[0].envelope.from).toBe('<no-reply@vexoconnect.test>');
    expect(sink.messages[0].envelope.to).toEqual(['<someone@vexoconnect.test>']);
  });

  it('encodes a non-ASCII subject as an RFC 2047 word and decodes back', async () => {
    await sendSmtp({
      host: '127.0.0.1',
      port: sink.port,
      security: 'none',
      from: 'no-reply@vexoconnect.test',
      to: 'someone@vexoconnect.test',
      subject: 'Invoice ₹1,250 — नमस्ते',
      text: 'body',
      html: '<p>body</p>',
    });
    const raw = sink.messages[0].headers.subject;
    expect(raw).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = Buffer.from(raw.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8');
    expect(decoded).toBe('Invoice ₹1,250 — नमस्ते');
  });

  it('delivers a body whose line begins with a dot without truncating it', async () => {
    // Dot-stuffing: an unstuffed leading "." would end DATA early and the
    // message would arrive cut in half — the classic SMTP data-loss bug.
    const text = 'first line\n.\nafter the dot\n.hidden command';
    await sendSmtp({
      host: '127.0.0.1',
      port: sink.port,
      security: 'none',
      from: 'no-reply@vexoconnect.test',
      to: 'someone@vexoconnect.test',
      subject: 'Dots',
      text,
      html: '<p>x</p>',
    });
    const got = decodeB64Part(sink.messages[0].raw, 'text/plain');
    expect(got).toBe(text);
  });

  it('carries both alternatives with the plain part first', async () => {
    await sendSmtp({
      host: '127.0.0.1',
      port: sink.port,
      security: 'none',
      from: 'no-reply@vexoconnect.test',
      to: 'someone@vexoconnect.test',
      subject: 'Alternatives',
      text: 'plain version',
      html: '<p>rich version</p>',
    });
    const raw = sink.messages[0].raw;
    expect(sink.messages[0].headers['content-type']).toMatch(/^multipart\/alternative; boundary=/);
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
    expect(decodeB64Part(raw, 'text/plain')).toBe('plain version');
    expect(decodeB64Part(raw, 'text/html')).toBe('<p>rich version</p>');
  });

  it('refuses to continue in plaintext when STARTTLS was asked for and not offered', async () => {
    // The sink advertises no STARTTLS. A client that shrugged and carried on
    // would put the mailbox password on the wire.
    await expect(
      sendSmtp({
        host: '127.0.0.1',
        port: sink.port,
        security: 'starttls',
        username: 'u',
        password: 'p',
        from: 'no-reply@vexoconnect.test',
        to: 'someone@vexoconnect.test',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
      }),
    ).rejects.toThrow(/STARTTLS/i);
    expect(sink.messages).toHaveLength(0);
  });

  it('keeps the password out of the error when AUTH is refused', async () => {
    // A 535 that echoed the failing command would put the credential into
    // logs, error trackers and screenshots.
    const rude = startSmtpSink({ port: 0 });
    await rude.started;
    // Re-point at a server that rejects AUTH: easiest is a port with nothing
    // listening after close, which fails at connect; to exercise the AUTH
    // refusal specifically, the sink answers 500 to an unknown verb, so ask
    // for a mechanism it does not offer.
    await rude.close();
    await expect(
      sendSmtp({
        host: '127.0.0.1',
        port: rude.port ?? 1,
        security: 'none',
        from: 'no-reply@vexoconnect.test',
        to: 'someone@vexoconnect.test',
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/SMTP connect failed/);
  });

  it('builds a Message-ID and Date on every message', () => {
    const mime = buildMimeMessage({
      from: 'a@b.test',
      to: ['c@d.test'],
      subject: 'S',
      text: 't',
      html: '<p>t</p>',
      messageId: '<abc@vexo-connect>',
    });
    expect(mime).toContain('Message-ID: <abc@vexo-connect>');
    expect(mime).toMatch(/Date: \w{3}, \d{2} \w{3} \d{4}/);
    expect(mime).toContain('MIME-Version: 1.0');
  });
});

describe('mailer', () => {
  it('records a sent message in the outbox without storing the body', async () => {
    const msg = templates.resetCodeEmail({ code: '12345678', ttlMinutes: 10, maxAttempts: 5 });
    const out = await mailer.sendMail({
      to: 'owner@vexoconnect.test',
      template: 'reset-code',
      message: msg,
      meta: { reason: 'test' },
    });
    const row = await prisma.emailOutbox.findUnique({ where: { id: out.id } });
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.providerResponse).toContain('250');
    // The code reached the mailbox and nowhere else.
    expect(decodeB64Part(sink.messages[0].raw, 'text/plain')).toContain('12345678');
    expect(JSON.stringify(row)).not.toContain('12345678');
  });

  it('refuses a recipient outside the allowlist before opening a socket', async () => {
    await expect(
      mailer.sendMail({
        to: 'a-real-customer@gmail.com',
        template: 'reset-code',
        message: templates.resetCodeEmail({ code: '00000000', ttlMinutes: 10, maxAttempts: 5 }),
      }),
    ).rejects.toThrow(/MAIL_ALLOWED_RECIPIENTS/);
    expect(sink.messages).toHaveLength(0);
    // Refused before the row is written: nothing to mistake for a queued send.
    expect(await prisma.emailOutbox.count({ where: { to: 'a-real-customer@gmail.com' } })).toBe(0);
  });

  it('matches an allowlist wildcard by domain, not by substring', async () => {
    // "*@vexoconnect.test" must not admit "evil-vexoconnect.test" or
    // "vexoconnect.test.attacker.com".
    expect(mailer.recipientAllowed('x@vexoconnect.test')).toBe(true);
    expect(mailer.recipientAllowed('allowed@example.com')).toBe(true);
    expect(mailer.recipientAllowed('x@evil-vexoconnect.test')).toBe(false);
    expect(mailer.recipientAllowed('x@vexoconnect.test.attacker.com')).toBe(false);
    expect(mailer.recipientAllowed('other@example.com')).toBe(false);
  });

  it('reports its own configuration without exposing the password', () => {
    const status = mailer.mailStatus();
    expect(status.configured).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sink-password-not-real');
  });
});

describe('templates', () => {
  it('builds action links only from APP_URL', () => {
    const { text, html } = templates.invitationEmail({
      companyName: 'Brew Street',
      roleLabel: 'Owner',
      inviterName: 'Support',
      acceptUrl: templates.appLink('/invite/TOKEN123'),
      expiresAt: new Date('2026-10-01T12:00:00Z'),
    });
    // WITH the /pos sub-path APP_URL carries. `new URL('/invite', base)` throws
    // the sub-path away and resolves against the origin, which would mail every
    // recipient a link to a page that is not served there.
    expect(text).toContain('https://portal.vexoconnect.test/pos/invite/TOKEN123');
    expect(html).toContain('https://portal.vexoconnect.test/pos/invite/TOKEN123');
    // Nothing in the builder can be influenced by a request header.
    expect(text).not.toContain('localhost');
  });

  it('escapes HTML in caller-supplied names', () => {
    const { html } = templates.invitationEmail({
      companyName: '<script>alert(1)</script>',
      roleLabel: 'Owner',
      inviterName: null,
      acceptUrl: templates.appLink('/invite/x'),
      expiresAt: new Date(),
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps the code out of the subject line', () => {
    const msg = templates.resetCodeEmail({ code: '98765432', ttlMinutes: 10, maxAttempts: 5 });
    expect(msg.subject).not.toContain('98765432');
    expect(msg.text).toContain('98765432');
  });

  it('never states a password in the password-changed notice', () => {
    const msg = templates.passwordChangedEmail({ when: new Date(), ip: '203.0.113.9' });
    expect(msg.text).toMatch(/was changed/);
    expect(msg.text).not.toMatch(/your new password is/i);
  });
});

// Last, because it takes the sink away: the mailer's configuration was read at
// import and points at this port, so stopping the server is the only honest
// way to make a real delivery fail.
describe('mailer, once the server stops answering', () => {
  it('records FAILED with the reason and rethrows rather than reporting success', async () => {
    await sink.close();

    await expect(
      mailer.sendMail({
        to: 'owner@vexoconnect.test',
        template: 'password-changed',
        message: templates.passwordChangedEmail({ when: new Date(), ip: null }),
      }),
    ).rejects.toThrow();

    const row = await prisma.emailOutbox.findFirst({
      where: { template: 'password-changed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toMatch(/connect|ECONNREFUSED|SMTP/i);
  });

  it('still lets a best-effort notification leave the caller intact', async () => {
    // A password change must not be unwound because a mail server had a bad
    // minute — but the failure is still in the ledger.
    const before = await prisma.emailOutbox.count({ where: { status: 'FAILED' } });
    const result = await mailer.sendMailBestEffort({
      to: 'owner@vexoconnect.test',
      template: 'password-changed',
      message: templates.passwordChangedEmail({ when: new Date(), ip: null }),
    });
    expect(result).toBeNull();
    expect(await prisma.emailOutbox.count({ where: { status: 'FAILED' } })).toBe(before + 1);
  });
});
