import fs from 'node:fs';
import path from 'node:path';

// The plumbing a harness uses to open an account the only way it can be
// opened: by reading the code out of the mail. One .eml per accepted message,
// the reader that gets one back, and the redemption those exist to serve.
//
// All of it lives here on purpose. scripts/mail-sink.mjs writes the files and
// deploy/e2e-workflow.mjs reads them, in different processes started minutes
// apart; if each owned its own idea of the format, a change to one would be
// found by a harness failing somewhere unrelated, long after the fact. The
// redemption is here for a second reason: the harness that needs it refuses to
// run on the host it was written on, so if the steps lived in that file they
// could never be tested. Here they are — tests/maildrop.test.js.
//
// This is test and development plumbing. It never runs in production — nothing
// writes a maildrop there, because nothing is capturing mail there.

// Envelope addresses arrive from the wire as "<a@b>" and are kept that way in
// the file, so what is on disk is what the server was actually told.
const bare = (address) => String(address).replace(/^</, '').replace(/>$/, '').trim().toLowerCase();

export const ENVELOPE_FROM = 'X-Sink-Envelope-From';
export const ENVELOPE_TO = 'X-Sink-Envelope-To';

// Lexicographic order is chronological: the stamp leads and is fixed-width.
const filename = (when = new Date()) =>
  `${when.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.eml`;

export const writeMessage = (dir, msg, when) => {
  const file = path.join(dir, filename(when));
  fs.writeFileSync(
    file,
    `${ENVELOPE_FROM}: ${msg.envelope.from}\r\n` +
      `${ENVELOPE_TO}: ${msg.envelope.to.join(', ')}\r\n${msg.raw}`,
    // The body holds a live code until it is redeemed. Not world-readable.
    { mode: 0o600 },
  );
  return file;
};

// Bodies arrive base64-encoded per MIME part. Decode every part and join: a
// reader does not care which alternative it takes the code from, only what the
// recipient could see. Falls back to the raw text for a non-multipart message.
export const textOf = (raw) =>
  raw
    .split(/--=_vexo_[0-9a-f]+/)
    .map((part) => {
      if (!/content-transfer-encoding:\s*base64/i.test(part)) return '';
      const body = part.split(/\r?\n\r?\n/).slice(1).join('\n');
      try {
        return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n') || raw;

const parseFile = (file) => {
  const raw = fs.readFileSync(file, 'utf8');
  const head = raw.slice(0, raw.indexOf('\r\n\r\n') + 1 || raw.length);
  const to = new RegExp(`^${ENVELOPE_TO}: *(.*)$`, 'im').exec(head)?.[1] ?? '';
  const subject = /^Subject: *(.*)$/im.exec(head)?.[1] ?? '';
  return {
    file,
    subject,
    to: to.split(',').map(bare).filter(Boolean),
    get text() {
      return textOf(raw);
    },
  };
};

// Oldest first. A caller wanting the newest message for an address should take
// the last match, not the first.
export const readMessages = (dir) => {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.eml'))
    .sort()
    .map((n) => parseFile(path.join(dir, n)));
};

export const messagesTo = (dir, address) => {
  const want = bare(address);
  return readMessages(dir).filter((m) => m.to.includes(want));
};

/**
 * Wait for a message to <address> and return the first group of `digits`
 * consecutive digits in it — the emailed code.
 *
 * Polls, because the message is written by another process: the API answering
 * 201 does not mean the SMTP conversation has finished and the file is closed.
 * Returns null rather than throwing, so a caller decides whether a missing
 * code is a refusal or a failed check.
 */
export const waitForCode = async (dir, address, { digits = 8, timeoutMs = 20000, pollMs = 200 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(`\\b(\\d{${digits}})\\b`);
  for (;;) {
    const hits = messagesTo(dir, address);
    // Newest first: an address that was sent a second code has had the first
    // superseded, and the newest is the only one that will still verify.
    for (const msg of hits.reverse()) {
      const code = pattern.exec(msg.text)?.[1];
      if (code) return code;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
};

/**
 * Open an account created by POST /users, by redeeming the code that was
 * mailed to it — the same two calls /forgot-password makes, in the same order.
 *
 * `post(path, body)` is injected so this works for whatever the caller already
 * has: supertest in the suite, fetch in a harness. It must resolve to
 * `{ status, body }`. Nothing here touches the database or reaches past the
 * API: a back door that exists for tests exists in production.
 *
 * Returns the password it chose. The caller signs in with it — proving the
 * account is open is the caller's assertion to make, not this function's.
 */
export const redeemEmailedCode = async ({ dir, email, password, post, timeoutMs }) => {
  const code = await waitForCode(dir, email, timeoutMs ? { timeoutMs } : {});
  if (!code) {
    throw new Error(
      `no code reached ${email} — check the sink log, and that ` +
        'MAIL_ALLOWED_RECIPIENTS covers the address',
    );
  }
  const verify = await post('/auth/forgot-password/verify', { email, code });
  if (verify.status !== 200) {
    throw new Error(`verifying the code mailed to ${email}: HTTP ${verify.status}`);
  }
  const reset = await post('/auth/forgot-password/reset', {
    resetToken: verify.body.resetToken,
    password,
    confirmPassword: password,
  });
  if (reset.status !== 200) {
    throw new Error(`setting the first password for ${email}: HTTP ${reset.status}`);
  }
  return password;
};
