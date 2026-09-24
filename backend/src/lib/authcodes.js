import { createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

// Verifiers for the two kinds of secret the account flows put in email.
//
// An INVITATION or RESET-AUTHORIZATION token is 32 random bytes — 256 bits of
// entropy — so a plain sha256 digest (hashSecret, the PosSession idiom) would
// already be unbruteforceable. They still go through the keyed HMAC below for
// uniformity: nothing in these tables is verifiable from a database dump alone.
//
// An EMAIL CODE is 8 digits — 10^8 possibilities, enumerable offline in
// milliseconds if the stored verifier were an unkeyed hash. The HMAC key is
// derived from POS_JWT_SECRET, which never lives in the database, so a dump
// of AuthChallenge rows yields nothing without also holding the app secret.
// Online guessing is separately capped by the per-challenge attempt counter.

const macKey = () =>
  Buffer.from(hkdfSync('sha256', env.POS_JWT_SECRET, 'vexo-pos-auth', 'email-code-verifier', 32));

export const secretVerifier = (value) =>
  createHmac('sha256', macKey()).update(String(value)).digest('hex');

export const verifierMatches = (value, storedVerifier) => {
  const a = Buffer.from(secretVerifier(value), 'hex');
  const b = Buffer.from(String(storedVerifier ?? ''), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

// Cryptographically random, uniformly distributed 8-digit code. randomInt is
// rejection-sampled by node, so no modulo bias.
export const newEmailCode = () => String(randomInt(0, 100000000)).padStart(8, '0');

// Link/authorization token: URL-safe, 256-bit.
export const newOpaqueToken = () => randomBytes(32).toString('base64url');

export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
// A hard per-account ceiling behind the cooldown, so a scripted caller cannot
// mint challenges (and emails) all day at one per minute.
export const MAX_CHALLENGES_PER_HOUR = 5;
export const INVITE_TTL_DAYS = 7;

export const codeExpiry = (nowMs = Date.now()) => new Date(nowMs + CODE_TTL_MINUTES * 60 * 1000);
export const inviteExpiry = (nowMs = Date.now()) =>
  new Date(nowMs + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
