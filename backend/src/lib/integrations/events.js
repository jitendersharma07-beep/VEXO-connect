// Inbound provider event pipeline (LANE providers).
//
// Aggregators deliver at-least-once, over the public internet, with no ordering
// guarantee. Concretely, all three of these WILL happen in production:
//   * the same order-placed callback arrives twice because our first 200 was
//     lost on the way back;
//   * a "cancelled" arrives before the "placed" it cancels, because the first
//     delivery attempt was retried after the second event was generated;
//   * a callback arrives for an outlet nobody has mapped yet.
//
// None of those may produce a second kitchen ticket, a second invoice or a
// dropped order. This file is where that is decided, and it decides it with
// database constraints rather than with careful sequencing, because careful
// sequencing does not survive two app processes.

import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../prisma.js';
import { sanitizeProviderError } from './index.js';

// --- authentication ----------------------------------------------------------

// Zomato's published prerequisites describe inbound auth as headers THEY are
// configured to send, agreed on the onboarding form. There is no published HMAC
// scheme, so there is no signature to verify — the honest check is that the
// agreed header carries the agreed value.
//
// Constant-time because the alternative leaks the token one byte at a time to
// anybody who can measure our response, and this endpoint is public by
// necessity. Length is compared first and separately: timingSafeEqual throws on
// a length mismatch, and the length of a shared secret is not the secret.
export const verifySharedHeader = (headers, headerName, expected) => {
  if (!headerName || !expected) return false;
  const received = headers[String(headerName).toLowerCase()];
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

// --- recording ---------------------------------------------------------------

// Record the event, or discover it is a repeat. The unique index on
// (connectionId, externalEventId) is the duplicate guard: we do not look first
// and then insert, because between the look and the insert is exactly where the
// second copy of a re-delivered webhook lands.
//
// Returns { event, duplicate } — the caller answers 200 either way. A provider
// that gets a non-2xx for a duplicate will keep redelivering it forever.
//
// ONLY AUTHENTICATED DELIVERIES MAY REACH THIS FUNCTION, and the caller enforces
// that before calling. An earlier version stored failed-auth deliveries too, on
// the reasoning that a burst of them is evidence of probing. That was wrong, and
// routes/gateway.js had already said why: externalEventId comes out of the
// payload, so an unauthenticated caller who guesses or observes an event id can
// insert it first, and the genuine delivery then arrives as a duplicate and is
// silently dropped. That is a denial of service on a restaurant's aggregator
// orders, mountable from anywhere, costing one HTTP request. Rejected deliveries
// go to the audit log instead, where they are still evidence and cannot squat a
// key.
export const recordEvent = async ({
  companyId,
  connectionId,
  externalEventId,
  kind,
  payload,
  externalOrderId = null,
  providerSequence = null,
  providerEventAt = null,
}) => {
  try {
    const event = await prisma.integrationEvent.create({
      data: {
        companyId,
        connectionId,
        externalEventId,
        kind,
        payload,
        // True by construction, per the paragraph above. The column stays
        // because it records why this row was allowed to exist at all, and a
        // reader of the table should not have to know this function to see it.
        signatureValid: true,
        externalOrderId,
        providerSequence,
        providerEventAt,
        status: 'RECEIVED',
      },
    });
    return { event, duplicate: false };
  } catch (err) {
    if (err?.code !== 'P2002') throw err;
    const event = await prisma.integrationEvent.findUnique({
      where: { connectionId_externalEventId: { connectionId, externalEventId } },
    });
    return { event, duplicate: true };
  }
};

export const markProcessed = (eventId) =>
  prisma.integrationEvent.update({
    where: { id: eventId },
    data: { status: 'PROCESSED', processedAt: new Date(), lastError: null },
  });

export const markSkipped = (eventId, reason) =>
  prisma.integrationEvent.update({
    where: { id: eventId },
    data: { status: 'SKIPPED', processedAt: new Date(), skipReason: reason.slice(0, 300) },
  });

export const markFailed = (eventId, error) =>
  prisma.integrationEvent.update({
    where: { id: eventId },
    data: {
      status: 'FAILED',
      attempts: { increment: 1 },
      lastError: sanitizeProviderError(error?.message || String(error)),
    },
  });

// --- ordering ----------------------------------------------------------------

// Is this event older than what the aggregator order has already seen?
//
// Prefers the provider's own sequence number when it sends one, because a
// sequence is authoritative about order and a timestamp is only evidence about
// it — two events generated in the same second have no timestamp ordering at
// all. Falls back to the provider's event time, and finally answers "not stale"
// when the provider gives us neither, because refusing to apply an event on a
// suspicion is how a real cancellation gets ignored.
export const isStale = (existing, { providerSequence, providerEventAt }) => {
  if (!existing) return false;
  if (providerSequence != null && existing.lastSequence != null) {
    return providerSequence <= existing.lastSequence;
  }
  if (providerEventAt && existing.lastEventAt) {
    return providerEventAt.getTime() < existing.lastEventAt.getTime();
  }
  return false;
};

// Terminal states are terminal. A late "preparing" for an order the restaurant
// already cancelled must not un-cancel it, and no sequence number is going to
// make that the right thing to do — so this is enforced on the state machine
// and not only on the ordering.
const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'REJECTED']);

// Which transitions an inbound event may make. Deliberately permissive forward
// (aggregators skip states — a picked-up callback can arrive with no ready
// callback before it, because the rider was already at the counter) and
// completely closed backward.
const FORWARD = Object.freeze({
  RECEIVED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'READY', 'PICKED_UP', 'DELIVERED', 'CANCELLED'],
  PREPARING: ['READY', 'PICKED_UP', 'DELIVERED', 'CANCELLED'],
  READY: ['PICKED_UP', 'DELIVERED', 'CANCELLED'],
  PICKED_UP: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
});

export const canTransition = (from, to) => {
  if (from === to) return false;
  if (TERMINAL.has(from)) return false;
  return (FORWARD[from] || []).includes(to);
};

// --- discrepancies -----------------------------------------------------------

// Recorded, never corrected. The whole reason AggregatorOrder stores the
// provider's money columns verbatim next to ours is so that a mismatch is
// visible as a mismatch. Rewriting either side to agree would destroy the only
// evidence that something is wrong, and the user's constraint on this is
// explicit: do not silently recalculate provider totals.
export const recordDiscrepancy = (client, { companyId, connectionId, kind, externalRef, orderId, detail, expectedAmount, observedAmount }) =>
  client.integrationDiscrepancy.create({
    data: {
      companyId,
      connectionId,
      kind,
      externalRef: externalRef ?? null,
      orderId: orderId ?? null,
      detail: detail ?? null,
      expectedAmount: expectedAmount ?? null,
      observedAmount: observedAmount ?? null,
    },
  });
