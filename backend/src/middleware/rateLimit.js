import rateLimit from 'express-rate-limit';

const message = { error: { code: 'POS_RATE_LIMITED', message: 'Too many requests, please slow down' } };

// The vitest suite exercises many deliberate login failures from one IP;
// without this skip the login limiter would answer 429 where the tests (and
// the behaviour under test) expect 401.
const isTest = process.env.NODE_ENV === 'test';

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  message,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: () => isTest,
  message: {
    error: { code: 'POS_RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a few minutes.' },
  },
});
