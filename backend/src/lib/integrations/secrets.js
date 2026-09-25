// Credential sealing for provider integrations (LANE providers).
//
// Provider credentials are not like the passwords elsewhere in this codebase.
// A password is only ever *verified*, so argon2 in lib/crypto.js is right for
// it and the plaintext is never needed again. An aggregator API key has to be
// *replayed* on every outbound call, so it must be recoverable — which means
// encryption, not hashing, and means lib/crypto.js has nothing that fits.
//
// Threat this actually addresses: a database dump. A dump of vcx `Integration-
// Connection` rows must not let the holder place orders, redeem a customer's
// loyalty points or post vouchers into the client's books. It does NOT address
// an attacker with the running server's environment — they have the key, and
// pretending otherwise would be the sort of claim B§14 p9 forbids.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard; 96-bit nonces are what the mode is built for
const TAG_BYTES = 16;

// Thrown rather than returned so a caller cannot accidentally treat a failure
// to open a credential as an empty credential and then call a provider with no
// authentication — which reads as "provider refused us" and sends the operator
// hunting in the wrong place.
export class CredentialSealError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialSealError';
  }
}

const key = () => {
  if (!env.POS_INTEGRATION_SECRET_KEY) {
    throw new CredentialSealError('POS_INTEGRATION_SECRET_KEY is not configured');
  }
  return Buffer.from(env.POS_INTEGRATION_SECRET_KEY, 'hex');
};

// The scope is bound into the ciphertext as GCM additional data, so a sealed
// blob lifted out of one company's connection row and pasted into another's
// fails to open instead of decrypting into a working credential. That makes the
// tenant boundary part of the cryptography rather than part of a query filter.
const aad = (scope) => {
  if (!scope?.companyId || !scope?.provider) {
    throw new CredentialSealError('credential scope needs companyId and provider');
  }
  return Buffer.from(`vcx:integration:${scope.companyId}:${scope.provider}`, 'utf8');
};

// Two credential objects that differ only in key order are the same credential.
// Without this, re-saving an unchanged credential through a different code path
// would change the fingerprint and the portal would report a rotation that
// never happened.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

// HMAC, not a bare sha256, because several of these credentials are short and
// guessable-shaped (a Tally company name, a six-character outlet code). A plain
// digest of those is reversible by anyone holding the dump and a word list; an
// HMAC under the server key is not. The fingerprint exists so the portal can
// say "the credential changed on <date>" without ever decrypting one.
export const credentialFingerprint = (scope, secret) =>
  createHmac('sha256', key())
    .update(aad(scope))
    .update(Buffer.from([0]))
    .update(canonical(secret), 'utf8')
    .digest('hex');

export const sealCredential = (scope, secret) => {
  if (!secret || typeof secret !== 'object') {
    throw new CredentialSealError('credential must be an object');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(aad(scope));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(secret), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    // Version-prefixed so a future key rotation or algorithm change can read
    // what is already stored instead of orphaning every configured integration.
    ciphertext: [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.'),
    fingerprint: credentialFingerprint(scope, secret),
  };
};

export const openCredential = (scope, ciphertext) => {
  if (typeof ciphertext !== 'string' || !ciphertext) {
    throw new CredentialSealError('no sealed credential to open');
  }
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialSealError('sealed credential is not a recognised format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const body = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CredentialSealError('sealed credential is malformed');
  }
  let plain;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAAD(aad(scope));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately one message for a wrong key, a wrong scope and a tampered
    // body. Which of the three it was is useful to an attacker probing the
    // boundary and useless to the operator, who can only ever re-enter the
    // credential.
    throw new CredentialSealError('sealed credential failed authentication');
  }
  try {
    return JSON.parse(plain);
  } catch {
    throw new CredentialSealError('sealed credential did not contain an object');
  }
};

// Used when a caller submits a credential to confirm they hold the one already
// stored (a "test connection" that must not accept a near-miss). Compares
// fingerprints, so no plaintext is decrypted to answer the question.
export const credentialMatches = (scope, secret, storedFingerprint) => {
  if (typeof storedFingerprint !== 'string' || storedFingerprint.length !== 64) return false;
  const a = Buffer.from(credentialFingerprint(scope, secret), 'hex');
  const b = Buffer.from(storedFingerprint, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
