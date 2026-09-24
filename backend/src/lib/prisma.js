import { PrismaClient } from '@prisma/client';

// Every write path in this service — billing an order, recording a payment,
// setting a permission rule — runs inside an interactive $transaction, and not
// one of the 27 call sites passes options. So all 27 inherited Prisma's
// UNDECLARED 5 s default, and a transaction that overran it was closed
// underneath the request: P2028, which is not an AppError, so errorHandler's
// catch-all turned it into an opaque 500 POS_INTERNAL_ERROR.
//
// Observed twice on 2026-09-24 against vcx_foundation_test, on a box shared
// with five other lanes: the 11:09:09 run lost foundationPeople.test.js on
// PUT /api/permissions/rules, the 11:17:06 run lost gateway.test.js on
// POST /api/orders. A different victim each time, and never on a fast run —
// the signature of a wall-clock budget, not of a defect in either route.
// Reproduced deliberately rather than inferred: the same two-statement
// transaction throws P2028 at the default and completes with an explicit
// timeout (tests/storageBusy.test.js keeps that control).
//
// The number below is therefore a decision, not a default. A POS write is
// worth waiting for — a cashier would rather the bill take a moment than be
// told "something went wrong" with no way to know whether the order exists.
// 15 s is far above the real cost of the largest of these transactions and
// still bounded, so a genuinely sick database still fails instead of pinning
// connections indefinitely. maxWait is the separate budget for getting a
// connection at all, and it stays much shorter: queueing behind a drained
// pool is not worth 15 s.
export const prisma = new PrismaClient({
  transactionOptions: { timeout: 15000, maxWait: 5000 },
});
