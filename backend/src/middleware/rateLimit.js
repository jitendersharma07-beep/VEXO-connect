import rateLimit from 'express-rate-limit';

const message = { error: { code: 'POS_RATE_LIMITED', message: 'Too many requests, please slow down' } };

// The vitest suite exercises many deliberate login failures from one IP;
// without this skip the login limiter would answer 429 where the tests (and
// the behaviour under test) expect 401.
const isTest = process.env.NODE_ENV === 'test';

// …which leaves the 429 path itself untested: a limiter that is skipped stays
// green even when refusal is broken. This switch turns genuine enforcement
// back on for the handful of tests whose subject IS the limiter, using the
// shipped configuration values rather than a test-only copy of them.
//
// It cannot weaken anything. The flag is only ever read alongside `isTest`, so
// outside a test run `skipInTest` is false whatever the flag says — there is no
// value of it that disables a limiter in production. Callers are expected to
// set it back to false in a finally/afterAll; tests/gateway.test.js does both.
let enforceInTest = false;

export const setRateLimitEnforcementForTest = (on) => {
  enforceInTest = Boolean(on);
};

const skipInTest = () => isTest && !enforceInTest;

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: skipInTest,
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
  skip: skipInTest,
  message: {
    error: {
      code: 'POS_RATE_LIMITED',
      message: 'Too many recovery attempts. Try again in a few minutes.',
    },
  },
});
