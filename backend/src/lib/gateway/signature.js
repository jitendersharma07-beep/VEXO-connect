// Shared primitives for webhook signature verification. Kept separate from
// any one adapter so a future real provider reuses the same hardened compare
// and replay window rather than hand-rolling its own.

import crypto from 'node:crypto';

export const hmacHex = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

export const sha256Hex = (payload) =>
  crypto.createHash('sha256').update(payload).digest('hex');

// Constant-time compare of two hex digests. timingSafeEqual throws on a
// length mismatch, so lengths are checked first; a valid digest's length is
// fixed and public, so that check leaks nothing. Buffer.from(..., 'hex')
// silently truncates invalid hex rather than throwing, which is why the
// decoded lengths are compared too and an empty decode is refused.
export const hexEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

// A captured body carries a genuine signature forever, so age is the only
// thing that stops a replay. Future-dated deliveries are refused by the same
// window: accepting them would let an attacker mint a delivery that stays
// valid for as long as they chose.
export const withinTolerance = (timestampSeconds, toleranceSeconds, nowMs = Date.now()) => {
  const ts = Number(timestampSeconds);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Math.floor(nowMs / 1000) - ts) <= toleranceSeconds;
};

// Parses a `t=<unix>,v1=<hex>` signature header. Returns null on anything
// malformed; callers treat null as "refused" and never look further.
export const parseSignatureHeader = (header) => {
  if (typeof header !== 'string' || header.length > 512) return null;
  let timestamp = null;
  let signature = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && timestamp === null) timestamp = value;
    else if (key === 'v1' && signature === null) signature = value;
  }
  if (!timestamp || !signature) return null;
  if (!/^\d{1,12}$/.test(timestamp)) return null;
  return { timestamp: Number(timestamp), signature };
};
