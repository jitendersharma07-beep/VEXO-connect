// VC-101 customer display — pairing codes and station pointers.
//
// Deliberately in-memory, not in Prisma. The display's durable credential is
// its signed token, whose life is tied to the minting cashier's PosSession
// (checked in the database on every poll), so revocation is real without any
// table here. What this module keeps is only "which order is this station
// showing right now" — ephemeral by nature — plus outstanding pairing codes
// for their five-minute life.
//
// Two accepted, documented limits of the in-memory choice (single backend
// instance, which is how this product deploys):
//   - outstanding pairing codes die on a backend restart (mint a new one);
//   - a station's pointer dies on restart too, so the display shows IDLE
//     until the cashier's next action on the sale re-points it. Nothing a
//     customer was shown is lost — every figure lives on the Order rows.
//
// A "station" is one cashier at one branch: `${branchId}:${cashierId}`.
// Codes, tokens and pointers are all scoped to a station, which makes
// cross-counter and cross-branch reads impossible by construction rather
// than by filtering.

import { randomBytes } from 'node:crypto';

export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

const codes = new Map(); // code -> { companyId, branchId, cashierId, sessionId, expiresAt }
const pointers = new Map(); // stationKey -> { orderId, version, updatedAt }

export const stationKeyFor = (branchId, cashierId) => `${branchId}:${cashierId}`;

const sweepCodes = () => {
  const now = Date.now();
  for (const [code, grant] of codes) {
    if (grant.expiresAt <= now) codes.delete(code);
  }
};

// Six digits, leading zeros kept — easy to read out across a counter, and
// single-use with a five-minute life, so guessing is left to the route's
// rate limiter. Collisions re-roll rather than overwrite: overwriting would
// let a second mint silently invalidate a code someone is mid-typing.
export const mintPairCode = ({ companyId, branchId, cashierId, sessionId }) => {
  sweepCodes();
  let code;
  do {
    code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
  } while (codes.has(code));
  const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
  codes.set(code, { companyId, branchId, cashierId, sessionId, expiresAt });
  return { code, expiresAt };
};

// Consumes the code whether or not it is still valid — a known-but-expired
// code must not be probeable twice.
export const redeemPairCode = (code) => {
  const grant = codes.get(code);
  if (!grant) return null;
  codes.delete(code);
  if (grant.expiresAt <= Date.now()) return null;
  return grant;
};

export const setPointer = (stationKey, orderId) => {
  const prev = pointers.get(stationKey);
  const next = {
    orderId,
    version: (prev?.version ?? 0) + 1,
    updatedAt: Date.now(),
  };
  pointers.set(stationKey, next);
  return next;
};

export const getPointer = (stationKey) => pointers.get(stationKey) ?? null;

export const clearPointer = (stationKey) => {
  const prev = pointers.get(stationKey);
  pointers.delete(stationKey);
  return Boolean(prev);
};

// An owner clearing without naming a branch blanks every station of theirs,
// whichever branch they happened to be selling on.
export const clearPointersForCashier = (cashierId) => {
  const suffix = `:${cashierId}`;
  for (const key of pointers.keys()) {
    if (key.endsWith(suffix)) pointers.delete(key);
  }
};

// Test hook: lets the vitest suite age a code past its TTL without waiting
// five minutes. Not used by any route.
export const _expireCodeForTest = (code) => {
  const grant = codes.get(code);
  if (grant) grant.expiresAt = 0;
};
