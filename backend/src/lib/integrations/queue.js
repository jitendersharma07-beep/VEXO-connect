// Outbound work queue for provider integrations (LANE providers).
//
// Every call this lane makes to a provider goes through here, for one reason:
// none of these providers can be assumed reachable at the moment we have
// something to say. Tally runs on a PC in the shop that gets switched off.
// Zomato's endpoint is across the internet from a restaurant's connection.
// Reelo is a third party with its own outages. Calling them inline from a
// request handler would mean a cashier waiting on somebody else's uptime, and a
// lost update whenever the call failed.
//
// So: intent is recorded in the database first, inside the caller's transaction
// where one exists, and delivery is a separate concern that can retry. The
// queue's contract is at-least-once, which is why receiving ends are keyed —
// see the unique constraints on AggregatorOrder, LoyaltyOperation and
// AccountingPosting.

import { prisma } from '../prisma.js';
import { jobDedupeKey, sanitizeProviderError } from './index.js';

// Doubling from 30s, capped at an hour. The cap matters: uncapped exponential
// backoff on an 8-attempt job puts the last retry days out, by which time a
// day-close has been done on books missing a voucher.
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];

// `attempts` is the number of attempts ALREADY MADE: claim() increments the
// column before the call, so the first failure arrives here with attempts === 1
// and has to wait the first rung. Indexing by attempts directly would skip the
// 30s rung entirely and hold every later retry one rung too long — invisible in
// production, because everything still retries and nothing errors, which is why
// the arithmetic is spelled out here. The counts line up: maxAttempts 8 leaves 7
// gaps to fill and BACKOFF_MS has exactly 7 rungs to fill them with.
const backoffFor = (attempts) =>
  BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];

// A worker that dies mid-job leaves lockedAt set. Without a reclaim window that
// job is stuck forever and silently — the queue would look healthy while one
// voucher never posts. Chosen longer than any single provider timeout so a slow
// call is never reclaimed underneath a worker that is still working.
export const LOCK_TIMEOUT_MS = 5 * 60_000;

// Enqueue. `client` so this can join the caller's transaction: a job that says
// "tell Zomato we accepted" must not exist if the acceptance itself rolled back.
export const enqueue = async (client, { companyId, connectionId, kind, payload, dedupe, runAt }) => {
  const dedupeKey = jobDedupeKey(kind, ...(Array.isArray(dedupe) ? dedupe : [dedupe]));
  // upsert, not create-and-catch: the collision is expected traffic here (a
  // re-delivered webhook, a double-tapped button), not an exceptional case.
  // update is deliberately minimal — an existing job keeps its attempt history
  // and its schedule, because "we already intend to do this" is the answer.
  return client.integrationJob.upsert({
    where: { connectionId_dedupeKey: { connectionId, dedupeKey } },
    create: {
      companyId,
      connectionId,
      kind,
      dedupeKey,
      payload,
      nextAttemptAt: runAt ?? new Date(),
    },
    update: {},
  });
};

// Claim one job. Written as a conditional update rather than read-then-write so
// two workers racing cannot both take the same row: the loser's update matches
// zero rows because the winner has already moved lockedBy.
export const claim = async (workerId, { now = new Date(), companyId } = {}) => {
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  const candidate = await prisma.integrationJob.findFirst({
    where: {
      status: 'PENDING',
      nextAttemptAt: { lte: now },
      ...(companyId ? { companyId } : {}),
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    orderBy: { nextAttemptAt: 'asc' },
  });
  if (!candidate) return null;

  const { count } = await prisma.integrationJob.updateMany({
    where: {
      id: candidate.id,
      status: 'PENDING',
      // Re-asserting the lock state we read is what makes this atomic. If
      // another worker claimed it in between, this matches nothing.
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    data: { status: 'IN_FLIGHT', lockedAt: now, lockedBy: workerId, attempts: { increment: 1 } },
  });
  if (count === 0) return null;

  return prisma.integrationJob.findUnique({
    where: { id: candidate.id },
    include: { connection: true },
  });
};

export const succeed = (jobId, { externalRef } = {}) =>
  prisma.integrationJob.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      succeededAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      // Cleared on success so the operator-facing error queue shows only work
      // that is still wrong, not everything that was ever briefly wrong.
      lastError: null,
      lastErrorAt: null,
      externalRef: externalRef ?? undefined,
    },
  });

// A failure that has exhausted its attempts becomes DEAD, not deleted. DEAD is
// the operator's queue: something the business intended never reached the
// provider, and somebody has to know. Silently dropping it is how a month's
// books end up short three vouchers with nothing to point at.
export const fail = async (job, error, { permanent = false } = {}) => {
  const attempts = job.attempts;
  const dead = permanent || attempts >= job.maxAttempts;
  return prisma.integrationJob.update({
    where: { id: job.id },
    data: {
      status: dead ? 'DEAD' : 'PENDING',
      lockedAt: null,
      lockedBy: null,
      lastError: sanitizeProviderError(error?.message || String(error)),
      lastErrorAt: new Date(),
      nextAttemptAt: dead ? job.nextAttemptAt : new Date(Date.now() + backoffFor(attempts)),
    },
  });
};

// Operator-triggered retry of a dead job. Resets the schedule but NOT the
// attempt count: the history of how many times this failed is evidence, and an
// operator who retries the same broken voucher twenty times should be able to
// see that they did.
export const requeue = (jobId) =>
  prisma.integrationJob.update({
    where: { id: jobId },
    data: {
      status: 'PENDING',
      nextAttemptAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      maxAttempts: { increment: BACKOFF_MS.length },
    },
  });

// Counts for the integrations screen. Pending-and-due is separated from
// pending-and-waiting because "14 jobs pending" reads as a problem when it is
// a normal backoff, and reads as normal when it is a queue that has stopped.
export const queueSummary = async (companyId, connectionId) => {
  const now = new Date();
  const where = { companyId, ...(connectionId ? { connectionId } : {}) };
  const [pending, due, inFlight, dead, oldestDue] = await Promise.all([
    prisma.integrationJob.count({ where: { ...where, status: 'PENDING' } }),
    prisma.integrationJob.count({ where: { ...where, status: 'PENDING', nextAttemptAt: { lte: now } } }),
    prisma.integrationJob.count({ where: { ...where, status: 'IN_FLIGHT' } }),
    prisma.integrationJob.count({ where: { ...where, status: 'DEAD' } }),
    prisma.integrationJob.findFirst({
      where: { ...where, status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      select: { nextAttemptAt: true },
    }),
  ]);
  return { pending, due, inFlight, dead, oldestDueAt: oldestDue?.nextAttemptAt ?? null };
};
