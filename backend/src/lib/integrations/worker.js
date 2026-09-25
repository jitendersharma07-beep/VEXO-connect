// Outbound delivery worker (LANE providers).
//
// The queue records intent; this turns intent into a call. The split matters
// because the two can fail independently, and conflating them is how an
// integration lies: a request handler that calls Tally inline either makes the
// cashier wait for a PC in the back office, or swallows the failure and reports
// a bill as posted when no voucher exists.
//
// Three rules hold this together.
//
// 1. The job row is the schedule; the DOMAIN row is the record. When a Tally
//    sales voucher is delivered, the truth an accountant needs is on
//    AccountingPosting (SENT/ACKNOWLEDGED, and Tally's own master id), not on a
//    queue entry that will eventually be pruned. So every success and every
//    permanent failure updates both.
//
// 2. An unanswered call is not a failure, and it is not a success either. A
//    timeout means the provider MAY have applied our request, so UNKNOWN is
//    retried and the domain row is left saying "we do not know yet" rather than
//    promoted.
//
//    What makes the retry safe is a key THE PROVIDER enforces. Reelo's
//    idempotency key is one; our own unique indexes are not. AccountingPosting's
//    unique index stops a second posting ROW being created, but a retry reuses
//    that row, so it does nothing whatsoever about sending the same voucher to
//    Tally twice — and Tally accepts the repeat. An earlier version of this
//    comment listed that index as though it were idempotency, which was wrong and
//    would have been read as a licence to retry Tally blindly. Tally's lost
//    acknowledgement is handled in adapters/tally.js, which looks the voucher up
//    before anything is resent; nothing here may assume delivery is exactly-once.
//
// 3. Nothing here decides a status by inspecting its own intentions. CONNECTED
//    is written only after a call returned; deriveStatus in index.js is the only
//    reader of that.
//
// Run shape: runOnce() drains what is due and returns. The interval loop in
// startWorker() is only for the long-running process — tests call runOnce, so
// there is no timer to race and no sleep to tune.

import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { env } from '../../config/env.js';
import { claim, succeed, fail } from './queue.js';
import { resolveAdapter } from './adapters/index.js';
import { openFor, sanitizeProviderError } from './index.js';
import { ProviderCallError } from './http.js';

// How many jobs one pass will take before returning. A bound, not a throttle:
// an unbounded drain with a provider that is answering instantly would hold the
// pass open indefinitely while a 3,000-job menu backfill runs, and the caller
// (an interval tick, or a test) never gets control back.
const BATCH = 25;

// The claim marker. Includes the pid so two workers on one host — a leftover dev
// process and the real one — are distinguishable in the lock column when a job
// is found stuck.
export const workerId = () => `worker:${process.pid}`;

// --- domain effects ----------------------------------------------------------
//
// Keyed by job kind because that is the only thing the queue itself knows. Each
// handler answers one question: given that this delivery succeeded (or died),
// what does the business record now say?
//
// Deliberately NOT a transaction with the send. There is no way to make an HTTP
// call and a database write atomic, and pretending otherwise picks the wrong
// failure: a rollback after a successful send would lose the acknowledgement for
// a voucher Tally really did create. So the send happens, then the record is
// updated, and the unique keys are what make a repeat harmless.

const markPostingSent = async (job, result) => {
  const postingId = job.payload?.postingId;
  if (!postingId) return;
  const ack = result?.detail ?? {};
  // ACKNOWLEDGED means Tally counted a voucher created, which is the strongest
  // statement its import response makes. A 200 whose counters we could not read
  // stays SENT, because "accepted" and "created one voucher" are different claims
  // and only one of them is evidence.
  //
  // An import response carries no master id, so externalMasterId is usually null
  // and the invoice number in the voucher's own REFERENCE is what ties the two
  // sides together. The exception is a delivery recovered from a lost
  // acknowledgement: that outcome comes from reading the Day Book, which does
  // sometimes carry Tally's own handle for the voucher. Written when it is there,
  // left null when it is not — never invented.
  const created = Number(ack.created ?? 0) > 0;
  await prisma.accountingPosting.updateMany({
    where: { id: postingId, companyId: job.companyId },
    data: {
      status: created ? 'ACKNOWLEDGED' : 'SENT',
      acknowledgedAt: created ? new Date() : undefined,
      externalMasterId: result?.externalRef ?? undefined,
      lastError: null,
    },
  });
};

const markPostingFailed = async (job, error, { dead }) => {
  const postingId = job.payload?.postingId;
  if (!postingId) return;
  await prisma.accountingPosting.updateMany({
    where: { id: postingId, companyId: job.companyId },
    data: {
      status: dead ? 'DEAD' : 'FAILED',
      attempts: job.attempts,
      lastError: sanitizeProviderError(error?.message || String(error)),
    },
  });
};

const markLoyaltyConfirmed = async (job, result) => {
  const operationId = job.payload?.operationId;
  if (!operationId) return;
  await prisma.loyaltyOperation.updateMany({
    // status guard: a reversal may have overtaken this delivery while it was in
    // flight, and a late "confirmed" must not un-reverse it.
    where: { id: operationId, companyId: job.companyId, status: 'PENDING' },
    data: {
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      externalRef: result?.externalRef ?? undefined,
      lastError: null,
    },
  });
};

const markLoyaltyFailed = async (job, error, { dead }) => {
  const operationId = job.payload?.operationId;
  if (!operationId) return;
  await prisma.loyaltyOperation.updateMany({
    where: { id: operationId, companyId: job.companyId, status: 'PENDING' },
    data: {
      // Only a dead job moves the operation to FAILED. While retries remain the
      // operation stays PENDING, because "we are still trying to tell Reelo
      // about this bill" and "Reelo refused this bill" are different answers to
      // give a customer standing at the till asking about their points.
      ...(dead ? { status: 'FAILED' } : {}),
      lastError: sanitizeProviderError(error?.message || String(error)),
    },
  });
};

// Aggregator status pushes have no separate record to promote: the state they
// report was already written to AggregatorOrder when the POS acted, and this job
// is only the notification. What a permanent failure DOES need is visibility —
// Zomato believing an order is still preparing after the rider has collected it
// is a dispute waiting to happen.
const markAggregatorPushDead = async (job, error, { dead }) => {
  // Only when the job is actually finished. Written on every failure instead, a
  // single outage produced eight OPEN rows for one order, each of them telling
  // the operator to go and fix it in the provider dashboard while the queue was
  // still retrying and about to succeed. That is worse than saying nothing: the
  // discrepancy list is the list of things a person must act on, and filling it
  // with work that is already in hand is how the one row that mattered gets
  // scrolled past.
  if (!dead) return;
  const { externalOrderId } = job.payload ?? {};
  await prisma.integrationDiscrepancy.create({
    data: {
      companyId: job.companyId,
      connectionId: job.connectionId,
      kind: 'STATUS_PUSH_FAILED',
      externalRef: externalOrderId ? String(externalOrderId) : null,
      orderId: job.payload?.orderId ?? null,
      detail: {
        jobKind: job.kind,
        attempts: job.attempts,
        error: sanitizeProviderError(error?.message || String(error)),
        note: 'The provider was never told about this state change. Update it in the provider dashboard.',
      },
      state: 'OPEN',
    },
  });
};

const EFFECTS = Object.freeze({
  TALLY_SALES: { ok: markPostingSent, bad: markPostingFailed },
  TALLY_CREDIT_NOTE: { ok: markPostingSent, bad: markPostingFailed },
  TALLY_RECEIPT: { ok: markPostingSent, bad: markPostingFailed },
  TALLY_LEDGER_MASTER: { ok: null, bad: null },
  REELO_BILL_SYNC: { ok: markLoyaltyConfirmed, bad: markLoyaltyFailed },
  REELO_REVERT: { ok: markLoyaltyConfirmed, bad: markLoyaltyFailed },
  REELO_SALE_RETURN: { ok: markLoyaltyConfirmed, bad: markLoyaltyFailed },
  ZOMATO_ORDER_CONFIRM: { ok: null, bad: markAggregatorPushDead },
  ZOMATO_ORDER_REJECT: { ok: null, bad: markAggregatorPushDead },
  ZOMATO_ORDER_READY: { ok: null, bad: markAggregatorPushDead },
  ZOMATO_ORDER_PICKED_UP: { ok: null, bad: markAggregatorPushDead },
  ZOMATO_ORDER_DELIVERED: { ok: null, bad: markAggregatorPushDead },
  ZOMATO_MENU_PUSH: { ok: null, bad: null },
  ZOMATO_ITEM_STOCK: { ok: null, bad: null },
  ZOMATO_MAC_UPDATE: { ok: null, bad: null },
});

// --- one job -----------------------------------------------------------------

// Errors raised here, before any provider contact, are permanent by
// construction: no amount of retrying fixes a disabled connection or a missing
// credential. Sent to fail() with permanent:true so the job lands in the
// operator's DEAD queue on the first attempt instead of nagging for an hour.
class JobUndeliverable extends Error {}

export const runJob = async (job) => {
  const connection = job.connection;
  const effects = EFFECTS[job.kind] ?? { ok: null, bad: null };

  try {
    if (!connection) throw new JobUndeliverable('The integration connection no longer exists');
    if (!connection.enabled) {
      throw new JobUndeliverable('The integration is switched off. Turn it on to deliver queued work.');
    }
    if (!connection.credentialCiphertext) {
      throw new JobUndeliverable('No provider credential is stored for this integration');
    }

    let credential;
    try {
      credential = openFor(connection);
    } catch (err) {
      // Distinguished from a wrong credential on purpose. This is the shape a
      // restored database or a rotated POS_INTEGRATION_SECRET_KEY takes, and the
      // fix is an operator re-entering the keys — not a retry.
      throw new JobUndeliverable(
        'The stored credential could not be opened. Re-enter it on the integration screen.',
      );
    }

    const adapter = resolveAdapter(connection.provider);
    const result = await adapter.perform({
      kind: job.kind,
      payload: job.payload ?? {},
      credential,
      config: connection.config ?? {},
    });

    await succeed(job.id, { externalRef: result?.externalRef ?? null });
    if (effects.ok) await effects.ok(job, result);

    // The one place CONNECTED is earned. A call went out and came back.
    await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: { lastSuccessfulSyncAt: new Date(), lastCheckedAt: new Date(), lastError: null, lastErrorAt: null },
    });

    return { jobId: job.id, kind: job.kind, outcome: 'SUCCEEDED' };
  } catch (err) {
    const undeliverable = err instanceof JobUndeliverable;
    const providerRefused = err instanceof ProviderCallError && err.providerRefused;
    const permanent = undeliverable || providerRefused;
    const dead = permanent || job.attempts >= job.maxAttempts;

    await fail(job, err, { permanent });
    if (effects.bad) await effects.bad(job, err, { dead });

    if (connection) {
      await prisma.integrationConnection.update({
        where: { id: connection.id },
        data: {
          lastCheckedAt: new Date(),
          lastError: sanitizeProviderError(err?.message || String(err)),
          lastErrorAt: new Date(),
        },
      });
    }

    logger.warn(
      {
        jobId: job.id,
        kind: job.kind,
        provider: connection?.provider,
        attempts: job.attempts,
        dead,
        reason: sanitizeProviderError(err?.message || String(err)),
      },
      'integration job failed',
    );

    return { jobId: job.id, kind: job.kind, outcome: dead ? 'DEAD' : 'RETRY' };
  }
};

// --- the pass ----------------------------------------------------------------

// `companyId` narrows a pass to one tenant. Used by the test suite so one
// tenant's queue cannot be drained by a case that was set up for another, which
// is the same isolation the routes get from companyScope.
export const runOnce = async ({ id = workerId(), companyId, max = BATCH } = {}) => {
  const results = [];
  for (let i = 0; i < max; i += 1) {
    const job = await claim(id, { companyId });
    if (!job) break;
    results.push(await runJob(job));
  }
  return results;
};

// --- the loop ----------------------------------------------------------------

let timer = null;

// Started from the process entrypoint, never from createApp(): an app built by a
// test must not acquire a background timer that outlives the case and claims
// jobs out from under it.
export const startWorker = ({ intervalMs = env.POS_INTEGRATION_WORKER_INTERVAL_MS } = {}) => {
  if (timer) return timer;
  if (!intervalMs || intervalMs <= 0) return null;

  let running = false;
  timer = setInterval(() => {
    // Re-entrancy guard rather than a queue of overlapping passes. Overlap is
    // survivable — claim() is atomic — but a provider that has gone slow would
    // otherwise accumulate passes until the process runs out of sockets.
    if (running) return;
    running = true;
    runOnce()
      .catch((err) => logger.error({ err }, 'integration worker pass failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // Does not hold the process open by itself; the HTTP server does that.
  timer.unref?.();
  logger.info({ intervalMs }, 'integration worker started');
  return timer;
};

export const stopWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
