import rateLimit from 'express-rate-limit';

const message = { error: { code: 'POS_RATE_LIMITED', message: 'Too many requests, please slow down' } };

// The vitest suite exercises many deliberate login failures from one IP;
// without this skip the login limiter would answer 429 where the tests (and
// the behaviour under test) expect 401.
const isTest = process.env.NODE_ENV === 'test';

// …which leaves the 429 path itself untested: a limiter that is skipped stays
// green even when refusal is broken. This switch turns genuine enforcement
// back on for the handful of tests that assert the refusal, using the shipped
// configuration values (windows, limits, headers) rather than a test-only copy
// of them.
//
// It cannot weaken anything. The flag is only ever read alongside `isTest`, so
// outside a test run `shouldSkip` is false whatever the flag says — there is no
// value of it that disables a limiter in production. Callers are expected to
// set it back to false in a finally/afterAll; tests/gateway.test.js and
// tests/accountRecovery.test.js both do.
let enforceInTest = false;

export const setRateLimitEnforcementForTest = (on) => {
  enforceInTest = Boolean(on);
};

const shouldSkip = () => isTest && !enforceInTest;

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldSkip,
  message,
});

// The guest QR endpoints are the only unauthenticated, write-capable surface in
// the product: anyone who can photograph a table can reach them. The global
// limiter is far too generous for that — 300/minute is a comfortable budget for
// walking four-digit join codes or minting visits. A real party scans once,
// joins once and submits a handful of times, so 40 a minute is invisible to them
// and ruinous to a script.
export const guestQrLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldSkip,
  message: {
    error: { code: 'POS_RATE_LIMITED', message: 'Too many requests from this phone. Please wait a moment.' },
  },
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: shouldSkip,
  message: {
    error: { code: 'POS_RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a few minutes.' },
  },
});

// Password recovery, per client address. This sits in front of the per-account
// ceilings in lib/accounts.js and answers a different attack: those stop
// somebody hammering one mailbox, this stops them walking an address list to
// farm "which of these exist" out of load or timing. Neither substitutes for
// the other.
//
// Looser than loginLimiter because a real person mistypes their address, waits
// for a mail that is slow, and asks again — but far tighter than the global
// ceiling, because no honest caller needs twenty of these in a quarter hour.
export const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldSkip,
  message: {
    error: {
      code: 'POS_RATE_LIMITED',
      message: 'Too many recovery attempts. Try again in a few minutes.',
    },
  },
});
