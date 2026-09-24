// What a store should order, and for which delivery.
//
// Two separable problems live here and are kept apart on purpose:
//
//   WHEN — which delivery cycle a plan is currently working towards. Pure
//          calendar arithmetic in the STORE's timezone, because a cutoff of
//          18:00 means six in the evening where the store is and a server in
//          another zone must not move it.
//   HOW MUCH — the suggestion. Derived from what is on the shelf, what is
//          already promised, and what the store actually consumes.
//
// The suggestion is advice. It is never posted as stock, and a plan only
// files an order by itself when someone has explicitly turned autoSubmit on.

import { milliToQty, qtyToMilli } from './units.js';
import { stockStateFor } from './stock.js';

const DAY_MS = 86400000;

// Demand, not loss. Wastage is stock that was thrown away, and ordering more
// to replace what keeps being thrown away is how a spoilage problem becomes a
// standing order.
const DEMAND_TYPES = ['SALE_CONSUMPTION', 'PRODUCTION_OUT'];

/* ------------------------------------------------------------ timezone */

const PARTS = new Map();
const formatterFor = (timeZone) => {
  let f = PARTS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    PARTS.set(timeZone, f);
  }
  return f;
};

export const localParts = (date, timeZone) => {
  const p = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const minute = Number(p.hour) * 60 + Number(p.minute);
  // ISO weekday of the LOCAL date, computed from the local Y/M/D rather than
  // from the instant, so a store just past midnight is on the right day.
  const isoWeekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return { year, month, day, minute, isoWeekday };
};

// The instant at which a given wall-clock time occurs in a timezone.
//
// Solved by measuring the zone's offset at an approximation and correcting
// once: enough for every real zone, including half-hour offsets and the hour
// either side of a DST change.
export const zonedWallTime = (timeZone, { year, month, day, minute = 0 }) => {
  const wantUtc = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  const probe = new Date(wantUtc);
  const seen = localParts(probe, timeZone);
  const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, Math.floor(seen.minute / 60), seen.minute % 60);
  return new Date(wantUtc - (seenUtc - wantUtc));
};

const addLocalDays = ({ year, month, day }, n) => {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

const isoWeekdayOf = ({ year, month, day }) => ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;

// The next delivery this plan is ordering for.
//
// A cycle is identified by its DELIVERY date, not by when the order was
// raised: two attempts on either side of midnight are the same Tuesday
// delivery and must collapse to one requirement.
export const nextCycle = (plan, from = new Date()) => {
  const days = (plan.deliveryDays ?? []).filter((d) => d >= 1 && d <= 7);
  if (!days.length) return null;

  const here = localParts(from, plan.timezone);
  // Ordering for a delivery this many days out; today counts only if we are
  // still the right side of the cutoff.
  for (let ahead = 0; ahead <= 21; ahead += 1) {
    const cand = addLocalDays(here, ahead);
    if (!days.includes(isoWeekdayOf(cand))) continue;

    const deliverAt = zonedWallTime(plan.timezone, { ...cand, minute: plan.requiredByMinute });
    // The order has to be in by the cutoff, leadTimeDays before delivery.
    const cutoffDay = addLocalDays(cand, -plan.leadTimeDays);
    const cutoffAt = zonedWallTime(plan.timezone, { ...cutoffDay, minute: plan.cutoffMinute });
    if (cutoffAt.getTime() < from.getTime()) continue;

    return {
      // Stored as a date: the local delivery day, pinned to UTC midnight so
      // the @db.Date column holds the day the store means.
      cycleDate: new Date(Date.UTC(cand.year, cand.month - 1, cand.day)),
      cutoffAt,
      requiredBy: deliverAt,
    };
  }
  return null;
};

/* ---------------------------------------------------------- consumption */

// Measured daily demand over a window. Returns null — not zero — when there
// is no history at all, because "this store sells none of it" and "this store
// has never been measured" lead to opposite decisions.
export const consumptionRateMilli = async (client, { locationId, itemId, days = 28, asOf = new Date() }) => {
  const since = new Date(asOf.getTime() - days * DAY_MS);
  const rows = await client.stockMovement.findMany({
    where: { locationId, itemId, type: { in: DEMAND_TYPES }, occurredAt: { gte: since, lte: asOf } },
    select: { qty: true, occurredAt: true },
  });
  if (!rows.length) return null;

  const outMilli = rows.reduce((a, r) => a + Math.max(-qtyToMilli(r.qty), 0), 0);
  // Measure over the window actually observed, not the window asked for: a
  // store open three days does not get its rate divided by twenty-eight.
  const first = rows.reduce((a, r) => Math.min(a, r.occurredAt.getTime()), asOf.getTime());
  const observedDays = Math.max((asOf.getTime() - first) / DAY_MS, 1);
  return outMilli / observedDays;
};

/* ----------------------------------------------------------- suggestion */

// Stock already promised to this destination by someone who can deliver it.
//
// An APPROVED request is a commitment from the source; a SUBMITTED one is a
// hope. Counting the hope is how a store that asked twice and was answered
// once runs out.
const confirmedIncomingMilli = async (client, { locationId, itemId }) => {
  // A transfer leaves DISPATCHED the moment it is received, so everything
  // still in that state is wholly in transit.
  const inTransit = await client.stockTransferLine.findMany({
    where: { transfer: { toLocationId: locationId, status: 'DISPATCHED' }, itemId },
    select: { dispatchedQty: true },
  });
  const transit = inTransit.reduce((a, l) => a + qtyToMilli(l.dispatchedQty ?? 0), 0);

  const approved = await client.storeRequestLine.findMany({
    where: {
      itemId,
      request: { destinationLocationId: locationId, status: { in: ['APPROVED', 'PARTIALLY_APPROVED', 'IN_FULFILMENT'] } },
    },
    select: { approvedQty: true, dispatchedQty: true },
  });
  const promised = approved.reduce(
    (a, l) => a + Math.max(qtyToMilli(l.approvedQty ?? 0) - qtyToMilli(l.dispatchedQty ?? 0), 0),
    0,
  );
  return { transitMilli: transit, promisedMilli: promised };
};

// Asked for but not yet decided. Not stock — this figure exists only to stop
// the plan raising the same requirement a second time while the first is
// still sitting in somebody's approval queue.
const outstandingRequestedMilli = async (client, { locationId, itemId }) => {
  const lines = await client.storeRequestLine.findMany({
    where: { itemId, request: { destinationLocationId: locationId, status: { in: ['DRAFT', 'SUBMITTED'] } } },
    select: { requestedQty: true },
  });
  return lines.reduce((a, l) => a + qtyToMilli(l.requestedQty), 0);
};

// How much more this location can physically hold, or null when it has not
// declared a capacity.
//
// Capacity is a single figure per location while items are counted in their
// own base units, so this is a coarse guard against ordering a truckload into
// a cupboard, not a volumetric model. It only ever reduces a suggestion.
const capacityHeadroomMilli = async (client, location) => {
  if (location.capacityBaseQty === null || location.capacityBaseQty === undefined) return null;
  const rows = await client.stockBalance.findMany({ where: { locationId: location.id }, select: { qty: true } });
  const onHand = rows.reduce((a, r) => a + qtyToMilli(r.qty), 0);
  return Math.max(qtyToMilli(location.capacityBaseQty) - onHand, 0);
};

// One line's worth of advice, with every input that produced it.
//
// The inputs are returned alongside the number because a suggestion a manager
// cannot interrogate is a suggestion a manager will either obey blindly or
// ignore entirely.
export const suggestLine = async (client, { plan, destination, line, asOf, rateDays }) => {
  const state = await stockStateFor(client, {
    companyId: plan.companyId,
    locationId: destination.id,
    itemId: line.itemId,
    asOf,
  });
  const availableMilli = qtyToMilli(state.availableRaw);
  const { transitMilli, promisedMilli } = await confirmedIncomingMilli(client, {
    locationId: destination.id,
    itemId: line.itemId,
  });
  const pendingMilli = await outstandingRequestedMilli(client, { locationId: destination.id, itemId: line.itemId });

  const rate = await consumptionRateMilli(client, {
    locationId: destination.id,
    itemId: line.itemId,
    days: rateDays,
    asOf,
  });
  // No measured history: drive from the explicit min/target alone rather than
  // inventing a rate. This is the deliberate cold-start path.
  const dailyMilli = rate ?? 0;

  const minMilli = qtyToMilli(line.minQty);
  const targetMilli = qtyToMilli(line.targetQty);
  const safetyMilli = qtyToMilli(line.safetyQty ?? 0);
  const incomingMilli = transitMilli + promisedMilli;

  const consumeToDelivery = Math.round(dailyMilli * plan.leadTimeDays);
  const consumeOverCover = Math.round(dailyMilli * plan.coverDays);
  const projectedAtDelivery = availableMilli + incomingMilli - consumeToDelivery;

  const trigger = projectedAtDelivery <= minMilli + safetyMilli;
  let suggestMilli = trigger
    ? Math.max(targetMilli + safetyMilli + consumeOverCover - availableMilli - incomingMilli, 0)
    : 0;

  // The requirement is already sitting in an approval queue. Raising it again
  // would double the order the moment both were approved.
  let suppressed = null;
  if (suggestMilli > 0 && pendingMilli >= suggestMilli) {
    suppressed = 'ALREADY_REQUESTED';
    suggestMilli = 0;
  }

  return {
    itemId: line.itemId,
    item: line.item ? { id: line.item.id, name: line.item.name, baseUnit: line.item.baseUnit } : undefined,
    suggestedQty: milliToQty(suggestMilli),
    suggestMilli,
    suppressed,
    reason: {
      available: state.availableRaw,
      usable: state.usable,
      blocked: state.blocked,
      reserved: state.reserved,
      inTransit: milliToQty(transitMilli),
      approvedNotDispatched: milliToQty(promisedMilli),
      awaitingApproval: milliToQty(pendingMilli),
      // Null here means "never measured", which is a different statement from
      // a measured rate of zero and is rendered as such in the portal.
      dailyConsumption: rate === null ? null : milliToQty(Math.round(rate)),
      coverDays: plan.coverDays,
      leadTimeDays: plan.leadTimeDays,
      projectedAtDelivery: milliToQty(projectedAtDelivery),
      minQty: milliToQty(minMilli),
      targetQty: milliToQty(targetMilli),
      safetyQty: milliToQty(safetyMilli),
      triggered: trigger,
    },
  };
};

export const suggestForPlan = async (client, plan, { asOf = new Date(), rateDays = 28 } = {}) => {
  const destination = await client.inventoryLocation.findUnique({ where: { id: plan.destinationLocationId } });
  const lines = plan.lines ?? (await client.replenishmentPlanLine.findMany({
    where: { planId: plan.id, active: true },
    include: { item: { select: { id: true, name: true, baseUnit: true } } },
  }));

  const out = [];
  for (const line of lines.filter((l) => l.active !== false)) {
    out.push(await suggestLine(client, { plan, destination, line, asOf, rateDays }));
  }

  // Coarse capacity guard, applied after the per-item maths so the scaling is
  // visible rather than buried inside each line.
  const headroom = await capacityHeadroomMilli(client, destination);
  let cappedByCapacity = false;
  if (headroom !== null) {
    const total = out.reduce((a, s) => a + s.suggestMilli, 0);
    if (total > headroom && total > 0) {
      cappedByCapacity = true;
      for (const s of out) {
        s.suggestMilli = Math.floor((s.suggestMilli * headroom) / total);
        s.suggestedQty = milliToQty(s.suggestMilli);
        s.reason.cappedByCapacity = true;
      }
    }
  }

  return {
    planId: plan.id,
    cycle: nextCycle(plan, asOf),
    cappedByCapacity,
    headroom: headroom === null ? null : milliToQty(headroom),
    lines: out,
  };
};

// The identity of "this plan's order for this delivery". Unique per company,
// which is what stops a scheduler retry, a restarted process and an impatient
// manager from raising the same Tuesday order three times.
export const requirementKeyFor = (plan, cycleDate) =>
  `plan:${plan.id}:${new Date(cycleDate).toISOString().slice(0, 10)}`;
