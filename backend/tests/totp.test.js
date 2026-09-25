// TOTP correctness against the standards, not against another implementation.
//
// The HOTP values come from RFC 4226 appendix D and the TOTP values from
// RFC 6238 appendix B. If this file is green, the codes this system generates
// are the codes Google Authenticator, Authy and 1Password will show — which is
// the only claim that matters, and the one a self-consistent test cannot make.
//
// No database and no network: this is a pure-function suite.

import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  hotp,
  totpAt,
  totpStep,
  verifyTotp,
  newTotpSecret,
  otpauthUri,
  encryptTotpSecret,
  decryptTotpSecret,
} from '../src/lib/totp.js';

// RFC 4226 appendix D uses the ASCII secret "12345678901234567890".
const RFC4226_KEY = Buffer.from('12345678901234567890', 'ascii');

describe('RFC 4226 HOTP vectors (appendix D)', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  it.each(expected.map((code, counter) => [counter, code]))(
    'counter %i produces %s',
    (counter, code) => {
      expect(hotp(RFC4226_KEY, counter)).toBe(code);
    },
  );
});

describe('RFC 6238 TOTP vectors (appendix B)', () => {
  // The appendix tabulates 8-digit SHA-1 values at fixed unix times.
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('time %i produces %s', (seconds, code) => {
    const step = totpStep(seconds * 1000);
    expect(totpAt(RFC4226_KEY, step, 8)).toBe(code);
  });
});

describe('base32', () => {
  // RFC 4648 section 10 vectors.
  const vectors = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('encodes %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it('round-trips a 20-byte secret', () => {
    const secret = newTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });

  it('accepts the spacing and padding authenticator apps display', () => {
    const secret = newTotpSecret();
    const grouped = base32Encode(secret).replace(/(.{4})/g, '$1 ').trim();
    expect(base32Decode(grouped)).toEqual(secret);
    expect(base32Decode(`${base32Encode(secret)}======`)).toEqual(secret);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YTB1')).toThrow(/Invalid base32/);
  });
});

describe('verifyTotp', () => {
  const now = 1_700_000_000_000;
  const key = newTotpSecret();

  it('accepts the current code and returns its step', () => {
    const step = totpStep(now);
    expect(verifyTotp(key, totpAt(key, step), { nowMs: now })).toBe(step);
  });

  it('accepts one step either side for clock skew', () => {
    const step = totpStep(now);
    expect(verifyTotp(key, totpAt(key, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(key, totpAt(key, step + 1), { nowMs: now })).toBe(step + 1);
  });

  it('rejects two steps away', () => {
    const step = totpStep(now);
    expect(verifyTotp(key, totpAt(key, step + 2), { nowMs: now })).toBeNull();
  });

  it('rejects a code that is not six digits', () => {
    expect(verifyTotp(key, '12345', { nowMs: now })).toBeNull();
    expect(verifyTotp(key, '1234567', { nowMs: now })).toBeNull();
    expect(verifyTotp(key, 'abcdef', { nowMs: now })).toBeNull();
    expect(verifyTotp(key, null, { nowMs: now })).toBeNull();
    expect(verifyTotp(key, '', { nowMs: now })).toBeNull();
  });

  it('refuses to replay a code inside its own window', () => {
    // The point of minStep. Someone who reads a code over a shoulder, or
    // captures it in transit, finds it already spent by the login that
    // revealed it — even though the 30-second window has not closed.
    const step = totpStep(now);
    const code = totpAt(key, step);
    expect(verifyTotp(key, code, { nowMs: now, minStep: -1 })).toBe(step);
    expect(verifyTotp(key, code, { nowMs: now, minStep: step })).toBeNull();
  });

  it('still accepts the next step after one was consumed', () => {
    const step = totpStep(now);
    const next = totpAt(key, step + 1);
    expect(verifyTotp(key, next, { nowMs: now, minStep: step })).toBe(step + 1);
  });

  it('rejects a code from a different secret', () => {
    const other = newTotpSecret();
    expect(verifyTotp(key, totpAt(other, totpStep(now)), { nowMs: now })).toBeNull();
  });
});

describe('otpauth URI', () => {
  it('carries the parameters an authenticator app needs', () => {
    const secret = newTotpSecret();
    const uri = otpauthUri({ secretBuf: secret, accountName: 'support@vexoconnect.com' });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.searchParams.get('secret')).toBe(base32Encode(secret));
    expect(parsed.searchParams.get('issuer')).toBe('VEXO Connect');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
    // The label is issuer-prefixed, which is what makes the entry readable
    // when someone holds accounts on several systems.
    expect(decodeURIComponent(uri)).toContain('VEXO Connect:support@vexoconnect.com');
  });

  it('escapes an account name containing a colon or a space', () => {
    const uri = otpauthUri({ secretBuf: newTotpSecret(), accountName: 'a b:c@d.test' });
    expect(uri).toContain('a%20b%3Ac%40d.test');
  });
});

describe('secret storage', () => {
  it('round-trips through AES-256-GCM', () => {
    const secret = newTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(secret))).toEqual(secret);
  });

  it('produces a different ciphertext every time', () => {
    const secret = newTotpSecret();
    expect(encryptTotpSecret(secret)).not.toBe(encryptTotpSecret(secret));
  });

  it('does not contain the plaintext seed', () => {
    const secret = newTotpSecret();
    const stored = encryptTotpSecret(secret);
    expect(stored).not.toContain(secret.toString('base64'));
    expect(stored).not.toContain(base32Encode(secret));
  });

  it('refuses a tampered ciphertext instead of returning wrong bytes', () => {
    // GCM's authentication tag is the difference between "this seed is wrong"
    // and "someone edited the database row".
    const stored = encryptTotpSecret(newTotpSecret());
    const [iv, tag, ct] = stored.split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptTotpSecret(`${iv}.${tag}.${flipped.toString('base64')}`)).toThrow();
  });
});
