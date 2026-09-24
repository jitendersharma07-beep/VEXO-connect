import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

// RFC 6238 TOTP on node:crypto, no third-party dependency. The verifier is
// exercised against the RFC 4226 appendix-D and RFC 6238 appendix-B test
// vectors in tests/totp.test.js — correctness is proven against the standard,
// not against another implementation.

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (buf) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (str) => {
  const clean = str.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

// RFC 4226 HOTP with dynamic truncation.
export const hotp = (keyBuf, counter, digits = 6) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', keyBuf).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    (((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff)) %
    10 ** digits;
  return String(code).padStart(digits, '0');
};

export const totpStep = (nowMs = Date.now(), periodSeconds = 30) =>
  Math.floor(nowMs / 1000 / periodSeconds);

export const totpAt = (keyBuf, step, digits = 6) => hotp(keyBuf, step, digits);

const safeEqualDigits = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

// Accepts the current step and one either side (clock skew), but never a step
// at or below `minStep` — the step of the last accepted code. Requiring
// strictly increasing steps is what makes a shoulder-surfed or intercepted
// code worthless: it cannot be replayed inside its own 30-second window,
// because the victim's own successful login already consumed that step.
// Returns the accepted step, or null.
export const verifyTotp = (keyBuf, code, { nowMs = Date.now(), window = 1, minStep = -1 } = {}) => {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const now = totpStep(nowMs);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = now + offset;
    if (step <= minStep) continue;
    if (safeEqualDigits(totpAt(keyBuf, step), code)) return step;
  }
  return null;
};

export const newTotpSecret = () => randomBytes(20);

export const otpauthUri = ({ secretBuf, accountName, issuer = 'VEXO Connect' }) => {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const secret = base32Encode(secretBuf);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
};

// --- secret storage --------------------------------------------------------
// The TOTP secret must be recoverable (verification recomputes the code from
// it), so unlike passwords it cannot be stored as a one-way hash. It is
// encrypted at rest with AES-256-GCM under a key derived from POS_JWT_SECRET,
// so a database dump alone does not yield working authenticator seeds.

const encryptionKey = () =>
  Buffer.from(hkdfSync('sha256', env.POS_JWT_SECRET, 'vexo-pos-mfa', 'totp-secret-encryption', 32));

export const encryptTotpSecret = (secretBuf) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(secretBuf), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
};

export const decryptTotpSecret = (stored) => {
  const [iv, tag, ct] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};
