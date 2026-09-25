#!/usr/bin/env node
//
// Proves that the configured mail provider accepts a message from the REAL
// sending path — the same `sendMail()` the invitation and recovery flows call,
// including the EmailOutbox row — and then stops short of claiming the message
// arrived, because a sending host cannot know that.
//
//   node scripts/verify-mail-delivery.mjs <recipient@example.com>
//
// Needs the same environment the server runs with (SMTP_*, MAIL_FROM,
// DATABASE_URL). It reads SMTP_PASSWORD from the environment and never prints
// it, logs it, or writes it anywhere: the output is PASS/FAIL lines plus facts
// that are safe to paste into a chat window, because that is what happens to
// this kind of output in practice.
//
// WHY THIS EXISTS, in one line: every message this product has ever sent went
// to a local sink that relays nothing. This is the script that changes that,
// and the honest limit of what it can prove is written into its own output.

import { randomBytes } from 'node:crypto';
import net from 'node:net';

const recipient = process.argv[2];

const pass = (m, detail) => {
  console.log(`PASS  ${m}`);
  if (detail) console.log(`      ${detail}`);
};
const fail = (m, detail) => {
  console.log(`FAIL  ${m}`);
  if (detail) console.log(`      ${detail}`);
};

if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
  console.log('Usage: node scripts/verify-mail-delivery.mjs <recipient@example.com>');
  console.log('');
  console.log('Send to a mailbox you can actually open. The whole point of this');
  console.log('script is the part a machine cannot check for you.');
  process.exit(64);
}

// Imported after the argv check so a plain mistake in the command line does not
// have to survive config validation first.
let env;
let mailEnabled;
let sendMail;
let mailStatus;
try {
  const cfg = await import('../src/config/env.js');
  env = cfg.env;
  mailEnabled = cfg.mailEnabled;
  ({ sendMail, mailStatus } = await import('../src/lib/mail/mailer.js'));
} catch (err) {
  fail('the mail configuration was rejected before anything was sent', err.message);
  console.log('');
  console.log('This is config validation talking, not the provider. Fix the value it');
  console.log('names and run again — see docs/ACCOUNTS-GO-LIVE.md §1.');
  process.exit(1);
}

if (!mailEnabled) {
  fail('no mail provider is configured (SMTP_HOST is empty)');
  console.log('');
  console.log('Nothing was sent. With SMTP_HOST unset the product deliberately refuses');
  console.log('to bootstrap an administrator or invite a user rather than pretending to');
  console.log('mail them — so this is the one thing that must be fixed first.');
  process.exit(1);
}

const st = mailStatus();
const maskedUser = env.SMTP_USERNAME
  ? env.SMTP_USERNAME.replace(/^(.)(.*)(@.*)$/, (_m, a, b, c) => `${a}${'*'.repeat(Math.max(b.length, 1))}${c}`)
  : '(none — unauthenticated submission)';

console.log(`host      ${env.SMTP_HOST}:${env.SMTP_PORT}  security=${env.SMTP_SECURITY}`);
console.log(`from      ${env.MAIL_FROM}`);
console.log(`username  ${maskedUser}`);
console.log(`recipient ${recipient}`);
console.log(`env       NODE_ENV=${env.NODE_ENV}  allowlist=${env.MAIL_ALLOWED_RECIPIENTS || '(none — production mode)'}`);
console.log('');

// --- 1. Transport pre-flight -------------------------------------------------
// Done before authenticating so that "wrong port" and "wrong password" cannot
// be confused for one another in the failure report.
const preflight = await new Promise((resolve) => {
  const sock = net.connect({ host: env.SMTP_HOST, port: env.SMTP_PORT });
  sock.setEncoding('utf8');
  let buf = '';
  let greeting = null;
  let settled = false;
  const done = (v) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sock.destroy();
    resolve(v);
  };
  const timer = setTimeout(() => done({ ok: false, reason: 'no reply within 15s' }), 15_000);
  // An SMTP reply is finished when a line begins "NNN " — a space rather than a
  // hyphen. Multi-line EHLO replies use "NNN-" until the last one.
  const complete = (s) =>
    s
      .split(/\r?\n/)
      .filter(Boolean)
      .some((l) => /^\d{3} /.test(l));
  sock.on('data', (chunk) => {
    buf += chunk;
    if (!complete(buf)) return;
    const lines = buf.split(/\r?\n/).filter(Boolean);
    buf = '';
    if (greeting === null) {
      greeting = lines[0];
      sock.write('EHLO verify.local\r\n');
      return;
    }
    sock.write('QUIT\r\n');
    done({ ok: true, greeting, caps: lines.map((l) => l.replace(/^\d{3}[- ]/, '')) });
  });
  sock.on('error', (err) => done({ ok: false, reason: err.message }));
});

if (!preflight.ok) {
  fail(`cannot reach ${env.SMTP_HOST}:${env.SMTP_PORT}`, preflight.reason);
  console.log('');
  console.log('Nothing was sent, and no credential was used. This is a network or');
  console.log('host/port problem, not an authentication problem.');
  process.exit(1);
}
pass(`${env.SMTP_HOST}:${env.SMTP_PORT} answers`, preflight.greeting);

const offersStarttls = preflight.caps.some((c) => /^starttls$/i.test(c));
if (env.SMTP_SECURITY === 'starttls') {
  if (offersStarttls) pass('the server offers STARTTLS, which is what SMTP_SECURITY=starttls needs');
  else {
    fail('SMTP_SECURITY=starttls but the server does not offer STARTTLS');
    console.log('      The client refuses to continue in plaintext, so nothing will send.');
    console.log('      Either this is the wrong port, or use SMTP_SECURITY=tls on 465.');
    process.exit(1);
  }
}

// --- 2. The real send ------------------------------------------------------
// A marker, so the owner can tell THIS message apart from an earlier attempt
// sitting in the same mailbox. It is random but not secret.
const marker = randomBytes(4).toString('hex').toUpperCase();
const subject = `VEXO Connect delivery check ${marker}`;

let result;
try {
  result = await sendMail({
    to: recipient,
    template: 'delivery-check',
    message: {
      subject,
      text: [
        `This is a delivery check from VEXO Connect. Reference ${marker}.`,
        '',
        'It carries no password, code or link. If you are reading it in the',
        'mailbox it was addressed to, then invitations and password-recovery',
        'codes can reach this address too.',
      ].join('\n'),
      html: `<p>This is a delivery check from VEXO Connect. Reference <strong>${marker}</strong>.</p>
<p>It carries no password, code or link. If you are reading it in the mailbox it
was addressed to, then invitations and password-recovery codes can reach this
address too.</p>`,
    },
    meta: { purpose: 'provider-delivery-check', marker },
  });
} catch (err) {
  const name = err?.constructor?.name || 'Error';
  if (name === 'MailRecipientRefusedError') {
    fail(`this build refuses to mail ${recipient}`, err.message);
    console.log('');
    console.log(`      MAIL_ALLOWED_RECIPIENTS is ${env.MAIL_ALLOWED_RECIPIENTS || '(unset)'}, and outside`);
    console.log('      production the allowlist is mandatory so a staging box cannot mail');
    console.log('      real customers. Add this address to it, or run with NODE_ENV=production');
    console.log('      only once you intend that.');
    console.log('      Nothing left this machine.');
    process.exit(1);
  }
  fail('the provider refused the message', err.message);
  console.log('');
  console.log('      Read that reason literally. "authentication failed" means the username');
  console.log('      or password is wrong. "relay access denied" or "sender address rejected"');
  console.log('      usually means MAIL_FROM is not a mailbox this account may send as.');
  console.log('      The password itself is never printed here, by either of us.');
  process.exit(1);
}

pass('the provider ACCEPTED the message for delivery');
console.log(`      queued as: ${String(result.messageId || '(no id returned)')}`);
if (result.response) console.log(`      server said: ${String(result.response).slice(0, 200)}`);
pass('the outbox recorded it as SENT', `EmailOutbox id ${result.id}`);

// --- 3. The honest limit ---------------------------------------------------
console.log('');
console.log('─────────────────────────────────────────────────────────────────────');
console.log('ACCEPTANCE IS NOT DELIVERY. What is proven above is that the provider');
console.log('took the message and queued it. A message can be accepted here and');
console.log('still be dropped, spam-foldered or bounced afterwards — SPF, DKIM and');
console.log('DMARC are all evaluated by the RECEIVING side, after this script has');
console.log('exited successfully.');
console.log('');
console.log('The remaining step cannot be automated from this machine:');
console.log('');
console.log(`  Open ${recipient} and look for the subject`);
console.log(`      "${subject}"`);
console.log('');
console.log('  In the inbox        -> delivery is genuinely proven. Say so.');
console.log('  In spam/junk        -> delivery works, reputation does not. Usually');
console.log('                         DKIM signing or a missing DMARC policy.');
console.log('  Nowhere after 5 min -> accepted then dropped. Check the provider log');
console.log('                         for the queue id above; that is the only place');
console.log('                         the real reason is written down.');
console.log('─────────────────────────────────────────────────────────────────────');
process.exit(0);
