// Batch eligibility, FEFO selection, and the six stock figures.
//
// Eligibility is computed at the moment it is asked for, from the batch's
// expiry date and state. It is NOT a flag some nightly job sets. That is the
// whole design: if the reminder scheduler has been down for a week, expired
// stock is still refused for sale, allocation and consumption, because
// nothing had to run for the comparison `expiryDate < today` to be true.

import { qtyToMilli, milliToQty } from './units.js';

export const BLOCKED_REASONS = {
  EXPIRED: 'EXPIRED',
  QUARANTINED: 'QUARANTINED',
  RECALLED: 'RECALLED',
  OPENED_PAST_USE_BY: 'OPENED_PAST_USE_BY',
};

// Date-only comparison, in the same UTC-date space the expiryDate column uses
// (@db.Date). A batch with an expiry of today is still good today and is
// refused from tomorrow — "use by" means the date is included.
const dateOnly = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const batchBlockReason = (batch, asOf = new Date()) => {
  if (batch.state === 'QUARANTINED') return BLOCKED_REASONS.QUARANTINED;
  if (batch.state === 'RECALLED') return BLOCKED_REASONS.RECALLED;
  if (batch.expiryDate && dateOnly(new Date(batch.expiryDate)) < dateOnly(asOf)) {
    return BLOCKED_REASONS.EXPIRED;
  }
  return null;
};

export const isBatchEligible = (batch, asOf = new Date()) => batchBlockReason(batch, asOf) === null;

// Batch positions at a location, newest information first for the caller:
// eligible ones in FEFO order, then the blocked ones with their reason.
//
// FEFO order is expiry ascending with undated batches LAST. An undated batch
// is one that does not expire, so putting it first would hold back the stock
// that actually has a deadline.
export const batchPositionsAt = async (client, { locationId, itemId, asOf = new Date() }) => {
  const rows = await client.stockBatchBalance.findMany({
    where: { locationId, itemId },
    include: { batch: true },
  });
  const openings = await client.stockBatchOpening.findMany({
    where: { locationId, batchId: { in: rows.map((r) => r.batchId) }, closedAt: null },
  });
  const openPastUseBy = new Map();
  for (const o of openings) {
    if (new Date(o.useByAt) >= asOf) continue;
    openPastUseBy.set(o.batchId, (openPastUseBy.get(o.batchId) ?? 0) + qtyToMilli(o.qty));
  }

  const positions = rows
    .map((r) => {
      const qtyMilli = qtyToMilli(r.qty);
      const reason = batchBlockReason(r.batch, asOf);
      // An opened container that is past its own use-by blocks only what is
      // left inside it. The unopened stock of the same batch beside it is
      // untouched — that is the point of tracking openings separately.
      const openBlockedMilli = Math.min(openPastUseBy.get(r.batchId) ?? 0, Math.max(qtyMilli, 0));
      const blockedMilli = reason ? Math.max(qtyMilli, 0) : openBlockedMilli;
      return {
        batchId: r.batchId,
        batchCode: r.batch.batchCode,
        supplierBatchCode: r.batch.supplierBatchCode,
        expiryDate: r.batch.expiryDate,
        state: r.batch.state,
        qtyMilli,
        blockedMilli,
        eligibleMilli: Math.max(qtyMilli - blockedMilli, 0),
        blockReason: reason ?? (openBlockedMilli > 0 ? BLOCKED_REASONS.OPENED_PAST_USE_BY : null),
      };
    })
    .filter((p) => p.qtyMilli !== 0);

  positions.sort((a, b) => {
    if (!a.expiryDate && !b.expiryDate) return a.batchCode.localeCompare(b.batchCode);
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    const d = new Date(a.expiryDate) - new Date(b.expiryDate);
    return d !== 0 ? d : a.batchCode.localeCompare(b.batchCode);
  });

  return positions;
};

// Pick batches to satisfy needMilli, first-expiring first, skipping anything
// blocked and anything already reserved to somebody else.
//
// Returns short: true when the eligible stock cannot cover the need. It never
// substitutes a blocked batch to make the number work — a caller that wants
// to know whether expiry is the reason gets that from `blocked`.
export const selectFefo = (positions, needMilli, reservedByBatch = new Map()) => {
  const picks = [];
  let remaining = needMilli;
  let blocked = 0;
  for (const p of positions) {
    blocked += p.blockedMilli;
    if (remaining <= 0) continue;
    const reserved = reservedByBatch.get(p.batchId) ?? 0;
    const free = Math.max(p.eligibleMilli - reserved, 0);
    if (free <= 0) continue;
    const take = Math.min(free, remaining);
    picks.push({ batchId: p.batchId, batchCode: p.batchCode, expiryDate: p.expiryDate, qtyMilli: take });
    remaining -= take;
  }
  return { picks, shortMilli: Math.max(remaining, 0), short: remaining > 0, blockedMilli: blocked };
};

const sumMilli = (rows, field = 'qty') => rows.reduce((a, r) => a + qtyToMilli(r[field]), 0);

// The six figures, for one location+item. Each is stored or derived from
// exactly one source, and none is inferred by subtracting two others at the
// display layer — that is what keeps the numbers agreeing with the shelf.
export const stockStateFor = async (client, { companyId, locationId, itemId, asOf = new Date() }) => {
  const balance = await client.stockBalance.findUnique({
    where: { locationId_itemId: { locationId, itemId } },
  });
  const physicalMilli = balance ? qtyToMilli(balance.qty) : 0;

  const positions = await batchPositionsAt(client, { locationId, itemId, asOf });
  const trackedMilli = positions.reduce((a, p) => a + p.qtyMilli, 0);
  const blockedMilli = positions.reduce((a, p) => a + p.blockedMilli, 0);

  const reservations = await client.stockReservation.findMany({
    where: { locationId, itemId, state: 'HELD' },
  });
  const reservedMilli = sumMilli(reservations);

  // Dispatched from here and not yet settled anywhere.
  const outbound = await client.stockTransferLine.findMany({
    where: { transfer: { fromLocationId: locationId, status: 'DISPATCHED' }, itemId },
    select: { dispatchedQty: true },
  });
  const inbound = await client.stockTransferLine.findMany({
    where: { transfer: { toLocationId: locationId, status: 'DISPATCHED' }, itemId },
    select: { dispatchedQty: true },
  });

  const usableMilli = physicalMilli - blockedMilli;
  return {
    companyId,
    locationId,
    itemId,
    physical: milliToQty(physicalMilli),
    // Untracked stock (an item with trackBatches off) is never blocked: there
    // is no batch to have an expiry. Reported separately so the two are not
    // confused with each other.
    untracked: milliToQty(physicalMilli - trackedMilli),
    blocked: milliToQty(blockedMilli),
    usable: milliToQty(usableMilli),
    reserved: milliToQty(reservedMilli),
    available: milliToQty(Math.max(usableMilli - reservedMilli, 0)),
    // Negative available is a real condition (stock went out from under a
    // reservation) and is surfaced rather than clamped away.
    availableRaw: milliToQty(usableMilli - reservedMilli),
    inTransitOut: milliToQty(sumMilli(outbound, 'dispatchedQty')),
    inTransitIn: milliToQty(sumMilli(inbound, 'dispatchedQty')),
    valuePaise: balance ? String(balance.valuePaise) : '0',
    batches: positions.map((p) => ({
      batchId: p.batchId,
      batchCode: p.batchCode,
      supplierBatchCode: p.supplierBatchCode,
      expiryDate: p.expiryDate,
      state: p.state,
      qty: milliToQty(p.qtyMilli),
      eligible: milliToQty(p.eligibleMilli),
      blockReason: p.blockReason,
    })),
  };
};

// Reservations held against specific batches at a location, as a map the FEFO
// picker can subtract. Reservation lines are per batch, so an allocation made
// yesterday still holds the exact batch it promised.
export const reservedByBatchAt = async (client, { locationId, itemId }) => {
  const lines = await client.stockReservationLine.findMany({
    where: { reservation: { locationId, itemId, state: 'HELD' } },
    select: { batchId: true, qty: true },
  });
  const map = new Map();
  for (const l of lines) map.set(l.batchId, (map.get(l.batchId) ?? 0) + qtyToMilli(l.qty));
  return map;
};
