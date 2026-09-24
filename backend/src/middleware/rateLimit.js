import rateLimit from 'express-rate-limit';

const message = { error: { code: 'POS_RATE_LIMITED', message: 'Too many requests, please slow down' } };

// The vitest suite exercises many deliberate login failures from one IP;
// without this skip the login limiter would answer 429 where the tests (and
// the behaviour under test) expect 401.
const isTest = process.env.NODE_ENV === 'test';

// …which leaves the 429 path itself untested: a limiter that is skipped stays
// green even when refusal is broken. This switch turns genuine enforcement
// back on for the handful of tests that assert the refusal, using the shipped
// configuration values rather than a test-only copy of them.
//
// It cannot weaken anything. The flag is only ever read alongside `isTest`, so
// outside a test run `shouldSkip` is false whatever the flag says — there is no
// value of it that disables a limiter in production. Callers are expected to
// set it back to false in a finally/afterAll; tests/gateway.test.js does both.
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
