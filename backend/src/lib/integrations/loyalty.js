// Loyalty integration (LANE providers).
//
// THE CONSTRAINT THAT SHAPES THIS ENTIRE FILE: the client already has roughly
// 100,000 customers in their Reelo account, with real points, real expiries and
// real membership tiers. Preserving them is not a feature, it is the condition
// of the work. So:
//
//   * Reelo is the authority on every balance. This lane never computes one,
//     never adjusts one, and never treats its own stored figure as current.
//     LoyaltyProfileLink.lastKnownBalance is a CACHE with a timestamp next to it,
//     and the timestamp is displayed wherever the number is.
//   * Nothing here enrols a customer. Reelo creates profiles implicitly on bill
//     sync, so a bill synced for a mistyped number does not fail — it creates a
//     person. Every path into syncBill therefore goes through a confident phone
//     normalisation first, and an unconfident number is refused.
//   * Nothing here sends a message. Reelo owns customer communication, and the
//     user's instruction on that is explicit.
//   * Every operation carries an idempotency key of our own making, because Reelo
//     publishes no idempotency mechanism and the queue is at-least-once. The
//     unique index on LoyaltyOperation(connectionId, idempotencyKey) is what
//     turns a retried job into one redemption instead of two.
//
// A redemption is the one operation here that spends something the customer
// owns. It is therefore the only one that is two-phase: the operation row is
// written PENDING before the call and only moves to CONFIRMED on the provider's
// answer. An UNKNOWN outcome stays PENDING and is never retried automatically —
// see performRedemption.

import { prisma } from '../prisma.js';
import { normalizePhone } from './adapters/reelo.js';
import { jobDedupeKey } from './index.js';

export { normalizePhone };

// --- linking -----------------------------------------------------------------

// Find the link for a customer, or create it from what the provider returned.
//
// Both unique indexes matter here and they guard different mistakes:
//   (connectionId, customerId)         — one VEXO customer cannot be linked to
//                                        two provider profiles, which would make
//                                        their balance depend on which row we
//                                        happened to read.
//   (connectionId, externalCustomerId) — one provider profile cannot be linked to
//                                        two VEXO customers, which would let two
//                                        people spend the same points.
// Both are scoped to the connection, and a connection belongs to one company, so
// a phone number shared between two tenants' customers can never cross.
export const linkCustomer = async (client, { companyId, connectionId, customerId, externalCustomerId, phone, lookup, source }) => {
  const norm = normalizePhone(phone);
  const data = {
    normalizedPhone: norm.national,
    lastKnownBalance: lookup?.points ?? null,
    balanceAsOf: lookup?.points != null ? new Date() : null,
    membershipTier: lookup?.tier ?? null,
    lastSyncedAt: new Date(),
  };
  return client.loyaltyProfileLink.upsert({
    where: { connectionId_customerId: { connectionId, customerId } },
    create: { companyId, connectionId, customerId, externalCustomerId, source, ...data },
    // externalCustomerId is deliberately NOT updated. If the provider starts
    // answering with a different id for the same customer, that is either a
    // provider-side merge or our own mis-match, and both need a human. Silently
    // re-pointing the link would move a balance from one person to another.
    update: data,
  });
};

// Refresh the cached balance from the provider. Returns the lookup so a caller
// can show a live figure; the cache exists for the case where the provider is
// unreachable and the till still has to show something, labelled with its age.
export const refreshBalance = async ({ adapter, connection, credential, config, outlet, link, phone }) => {
  const lookup = await adapter.lookupCustomer({ credential, config, outlet, phone });
  if (link && lookup.points != null) {
    await prisma.loyaltyProfileLink.update({
      where: { id: link.id },
      data: { lastKnownBalance: lookup.points, balanceAsOf: new Date(), lastSyncedAt: new Date() },
    });
  }
  return lookup;
};

// What a till may show. The age of the figure travels with the figure — a balance
// with no timestamp invites a cashier to promise points that expired last month.
export const publicBalance = (link, lookup) => {
  if (lookup?.points != null) {
    return { points: lookup.points, asOf: new Date(), live: true, source: 'PROVIDER' };
  }
  if (link?.lastKnownBalance != null) {
    return { points: link.lastKnownBalance, asOf: link.balanceAsOf, live: false, source: 'CACHE' };
  }
  // Not zero. "We do not know" and "they have none" are different answers and
  // only one of them is safe to act on.
  return { points: null, asOf: null, live: false, source: 'UNKNOWN' };
};

// --- idempotency keys --------------------------------------------------------

// Derived from what the operation IS, never from a clock or a random value. A
// retry of the same intent must produce the same key, or the unique index cannot
// do its job. Bill sync is keyed on the order, so a bill synced twice is one
// operation; redemption is keyed on the order plus the amount, so a genuine
// second redemption on the same bill is a distinct operation and a double-tap is
// not.
export const billSyncKey = (orderId) => `bill:${orderId}`;
export const redeemKey = (orderId, points, reward) => `redeem:${orderId}:${reward ?? ''}:${points ?? ''}`;
export const revertKey = (orderId) => `revert:${orderId}`;
export const returnKey = (refundId) => `return:${refundId}`;

// --- bill sync ---------------------------------------------------------------

// Queued, not called inline. A bill must not fail to print because a loyalty
// provider is slow, and the customer is standing at the counter.
//
// Refuses an unconfident phone number rather than syncing it: bill sync is what
// CREATES a customer at Reelo, so a mistyped number does not produce an error
// the operator can correct, it produces a person who does not exist, holding
// points nobody can claim. The user's instruction not to enrol customers again
// is enforced here.
export const enqueueBillSync = async (tx, { connection, order, customer, phone, source }) => {
  const norm = normalizePhone(phone ?? customer?.phone);
  if (!norm.confident) {
    return { queued: false, reason: 'phone number is not a recognisable Indian mobile number; not sent to the loyalty provider' };
  }

  const idempotencyKey = billSyncKey(order.id);
  // The operation row and the job are created together. The row is the record
  // that we intended this; the job is the attempt. Without the row, a job that
  // dies leaves no trace that a bill was ever meant to sync.
  const op = await tx.loyaltyOperation.upsert({
    where: { connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey } },
    create: {
      companyId: connection.companyId,
      connectionId: connection.id,
      customerId: customer?.id ?? null,
      orderId: order.id,
      kind: 'BILL_SYNC',
      idempotencyKey,
      amount: order.total,
    },
    update: {},
  });

  await tx.integrationJob.upsert({
    where: {
      connectionId_dedupeKey: {
        connectionId: connection.id,
        dedupeKey: jobDedupeKey('REELO_BILL_SYNC', order.id),
      },
    },
    create: {
      companyId: connection.companyId,
      connectionId: connection.id,
      kind: 'REELO_BILL_SYNC',
      dedupeKey: jobDedupeKey('REELO_BILL_SYNC', order.id),
      payload: {
        operationId: op.id,
        phone: norm.national,
        name: customer?.name ?? null,
        billNumber: order.invoiceNumber ?? order.id,
        amount: String(order.total),
        billDate: order.billedAt ? new Date(order.billedAt).toISOString().slice(0, 10) : null,
        source: source ?? null,
      },
    },
    update: {},
  });

  return { queued: true, operationId: op.id };
};

// --- redemption --------------------------------------------------------------

// Redemption spends the customer's property, so it is deliberately NOT queued:
// the cashier is standing there with the customer, the OTP they just read out is
// valid for minutes, and a redemption that happens ten minutes later in a
// background worker is a redemption nobody watched. It is called inline, once,
// with a PENDING row written first.
//
// The three outcomes and why they differ:
//   CONFIRMED — provider answered yes. Points are spent.
//   FAILED    — provider answered no. Nothing was spent; the operator can retry
//               with a fresh OTP.
//   PENDING   — provider did not answer (timeout, reset). The points MAY be
//               spent. This is never auto-retried and never auto-failed: it is
//               surfaced for a human to check against the customer's balance,
//               because guessing either way is a real customer losing real
//               points or a restaurant giving away a discount twice.
export const performRedemption = async ({ adapter, connection, credential, config, outlet, order, customer, phone, otp, points, reward }) => {
  const norm = normalizePhone(phone ?? customer?.phone);
  if (!norm.confident) {
    return { ok: false, reason: 'phone number is not a recognisable Indian mobile number' };
  }
  const idempotencyKey = redeemKey(order.id, points, reward);

  let op;
  try {
    op = await prisma.loyaltyOperation.create({
      data: {
        companyId: connection.companyId,
        connectionId: connection.id,
        customerId: customer?.id ?? null,
        orderId: order.id,
        kind: 'REDEEM',
        idempotencyKey,
        pointsDelta: points != null ? -Math.abs(points) : null,
      },
    });
  } catch (err) {
    if (err?.code !== 'P2002') throw err;
    // The collision IS the duplicate detection. A till that double-fires the
    // same approved redemption gets one redemption and an honest answer about
    // the first one's state.
    const existing = await prisma.loyaltyOperation.findUnique({
      where: { connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey } },
    });
    return { ok: existing?.status === 'CONFIRMED', duplicate: true, operation: existing };
  }

  try {
    const result = await adapter.redeem({
      credential, config, outlet,
      phone: norm.national, otp, points, reward,
      billRef: order.invoiceNumber ?? order.id,
    });
    const confirmed = await prisma.loyaltyOperation.update({
      where: { id: op.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        externalRef: result.externalRef ?? null,
        pointsDelta: result.pointsDelta ?? op.pointsDelta,
      },
    });
    // Cache refresh, best-effort. A failure to update our cache must not undo a
    // redemption the provider has already accepted.
    if (result.balanceAfter != null && customer) {
      await prisma.loyaltyProfileLink.updateMany({
        where: { connectionId: connection.id, customerId: customer.id },
        data: { lastKnownBalance: result.balanceAfter, balanceAsOf: new Date() },
      }).catch(() => {});
    }
    return { ok: true, operation: confirmed, balanceAfter: result.balanceAfter ?? null };
  } catch (err) {
    const answered = err?.providerRefused === true;
    await prisma.loyaltyOperation.update({
      where: { id: op.id },
      data: {
        // Left PENDING on an unanswered call. See the note above: this is the
        // case where the points may or may not be gone, and the only safe thing
        // is to say so.
        status: answered ? 'FAILED' : 'PENDING',
        lastError: String(err?.message ?? err).slice(0, 300),
      },
    });
    return {
      ok: false,
      unknown: !answered,
      reason: answered
        ? String(err?.message ?? err)
        : 'The loyalty provider did not answer. The redemption may or may not have gone through — check the customer’s balance before retrying.',
      operationId: op.id,
    };
  }
};

// --- reversal ----------------------------------------------------------------

// A voided bill must give back what it earned. Queued, because by the time a void
// happens the customer has usually gone, and linked to the operation it reverses
// so the pair is auditable — a reversal with no forward operation is either a
// bug or an attempt to hand out points.
export const enqueueReversal = async (tx, { connection, order, customer, phone }) => {
  const norm = normalizePhone(phone ?? customer?.phone);
  if (!norm.confident) return { queued: false, reason: 'phone number is not a recognisable Indian mobile number' };

  const original = await tx.loyaltyOperation.findUnique({
    where: { connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey: billSyncKey(order.id) } },
  });
  // Nothing was ever earned on this bill, so there is nothing to take back.
  // Sending a revert anyway would ask Reelo to reverse a transaction it does not
  // have, and the honest answer to "did we reverse it" is "there was nothing to".
  if (!original || original.status !== 'CONFIRMED') {
    return { queued: false, reason: 'no confirmed loyalty transaction exists for this bill' };
  }

  const idempotencyKey = revertKey(order.id);
  const op = await tx.loyaltyOperation.upsert({
    where: { connectionId_idempotencyKey: { connectionId: connection.id, idempotencyKey } },
    create: {
      companyId: connection.companyId,
      connectionId: connection.id,
      customerId: customer?.id ?? null,
      orderId: order.id,
      kind: 'REVERSE',
      idempotencyKey,
      reversesId: original.id,
    },
    update: {},
  });

  await tx.integrationJob.upsert({
    where: {
      connectionId_dedupeKey: { connectionId: connection.id, dedupeKey: jobDedupeKey('REELO_REVERT', order.id) },
    },
    create: {
      companyId: connection.companyId,
      connectionId: connection.id,
      kind: 'REELO_REVERT',
      dedupeKey: jobDedupeKey('REELO_REVERT', order.id),
      payload: { operationId: op.id, phone: norm.national, billRef: order.invoiceNumber ?? order.id },
    },
    update: {},
  });

  return { queued: true, operationId: op.id };
};
