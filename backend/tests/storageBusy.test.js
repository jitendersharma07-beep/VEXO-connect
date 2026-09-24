// Transaction-budget control (opaque-500 incident, 2026-09-24).
//
// Every write path here runs inside an interactive $transaction and none of the
// 27 call sites passed options, so all of them inherited Prisma's UNDECLARED
// 5 s default. On a loaded box a transaction overran it, the engine closed it
// under the request (P2028), and because P2028 is not an AppError the error
// middleware's catch-all answered 500 POS_INTERNAL_ERROR. It cost two full-suite
// runs, each on a different victim: 11:09:09 lost foundationPeople.test.js on
// PUT /api/permissions/rules, 11:17:06 lost gateway.test.js on POST /api/orders.
// Neither route was at fault; the budget was.
//
// This file guards both halves of the repair, and is written so it can fail:
//   1. the budget declared in src/lib/prisma.js is really in force — work that
//      would have died at the old default now finishes;
//   2. the NEGATIVE control — force the old budget back with an explicit
//      override and the same work still throws P2028, so test 1 is proving
//      something rather than merely passing;
//   3. a real P2028 leaves the error middleware as 503 POS_STORAGE_BUSY, while
//      a stranger error still leaves it as 500. The second half matters most:
//      the mapping must be narrow, or it becomes a way to hide real bugs.
//
// Reads only. The transaction body is two SELECT 1s either side of a wait, so
// nothing is written and nothing needs cleaning up.

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('storageBusy.test.js requires a DATABASE_URL ending in _test');
}

const { prisma } = await import('../src/lib/prisma.js');
const { errorHandler } = await import('../src/middleware/error.js');

// Long enough to have blown the old 5 s default with room to spare, short
// enough to stay well inside the 20 s testTimeout.
const PAST_THE_OLD_DEFAULT_MS = 6000;

const sleepingTransaction = (ms, options) =>
  prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1`;
    await new Promise((r) => setTimeout(r, ms));
    // The query that discovers the transaction has expired, if it has.
    await tx.$queryRaw`SELECT 1`;
    return 'finished';
  }, options);

// A genuine engine P2028, produced the same way the incident produced one —
// not a hand-built object that could drift from what Prisma actually throws.
// Forced with a deliberately tiny budget so it costs ~1.5 s rather than the
// 6 s the real default needed; two tests below share this one instance,
// because paying for it twice buys nothing.
const forcedTimeout = sleepingTransaction(1500, { timeout: 1000, maxWait: 5000 }).catch((e) => e);

// An express app that does nothing but hand a given error to the real
// middleware, so what is asserted is the middleware's own behaviour.
const appThatThrows = (err) => {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(err));
  app.use(errorHandler);
  return app;
};

describe('interactive transaction budget', () => {
  it('finishes work that would have died at the undeclared 5 s default', async () => {
    await expect(sleepingTransaction(PAST_THE_OLD_DEFAULT_MS, undefined)).resolves.toBe('finished');
  });

  it('NEGATIVE CONTROL: forcing a short budget back still throws P2028', async () => {
    // If this ever stops throwing, the test above has stopped proving anything:
    // it would be passing because nothing times out any more, not because the
    // budget declared in src/lib/prisma.js is what carried it.
    const err = await forcedTimeout;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('P2028');
  });
});

describe('transient storage failures are legible, and only the transient ones', () => {
  it('turns a real P2028 into 503 POS_STORAGE_BUSY, not an opaque 500', async () => {
    const real = await forcedTimeout;
    expect(real.code).toBe('P2028');

    const res = await request(appThatThrows(real)).get('/boom');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('POS_STORAGE_BUSY');
    // The cashier is told the truth — nothing was saved, try again — and is
    // never shown the engine's wording.
    expect(res.body.error.message).toMatch(/Nothing was saved/);
    expect(JSON.stringify(res.body)).not.toMatch(/P2028|Transaction API error|prisma/i);
  });

  it('maps P2024 (no free connection) the same way', async () => {
    const poolTimeout = Object.assign(new Error('Timed out fetching a new connection'), {
      code: 'P2024',
    });
    const res = await request(appThatThrows(poolTimeout)).get('/boom');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('POS_STORAGE_BUSY');
  });

  it('leaves every other failure as 500 — the mapping must not become a blanket', async () => {
    const stranger = Object.assign(new Error('null is not an object'), { code: 'P2002' });
    const res = await request(appThatThrows(stranger)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('POS_INTERNAL_ERROR');

    const codeless = await request(appThatThrows(new Error('boom'))).get('/boom');
    expect(codeless.status).toBe(500);
    expect(codeless.body.error.code).toBe('POS_INTERNAL_ERROR');
  });
});
