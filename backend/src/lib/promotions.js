// VC-102 promotion engine — evaluation only. Pure functions over plain data;
// the routes and recomputeOrder own every database read and write. Money is
// integer paise throughout, like money.js.
//
// STACKING AND PRECEDENCE, the authoritative statement (spec §VC-102 "define
// stacking and precedence explicitly"):
//   - A non-stackable promotion must be the ONLY promotion on the order.
//   - Stackable promotions combine. Each benefit is computed independently on
//     the undiscounted eligible base — not sequentially on a shrinking base —
//     so the amount a promotion grants does not depend on the order the till
//     applied them in.
//   - The combined discount (manual + all promotions) is clamped to the
//     order's subtotal. When the clamp bites, promotions lose benefit in
//     DESCENDING precedence number (highest number gives way first, ties by
//     promotion id) — precedence is "how firmly this offer holds its money".
//
// Eligibility windows are evaluated in IST, the calendar every daily boundary
// in this system already uses. Boundary semantics: start inclusive, end
// exclusive, for both the date range and the minute window.

import { percentOf } from './money.js';

// Same value as orders.js IST_OFFSET_MS, restated locally so this module and
// orders.js (which imports it) never form an import cycle.
const IST_OFFSET_MS = 330 * 60 * 1000;

const istParts = (at) => {
  const t = new Date(at.getTime() + IST_OFFSET_MS);
  return { weekday: t.getUTCDay(), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
};

// Why this promotion does not apply, as a machine-readable reason the till can
// phrase. Returns null when the schedule admits `at`.
export const scheduleRefusal = (promo, at) => {
  if (promo.startsAt && at < promo.startsAt) return 'NOT_STARTED';
  if (promo.endsAt && at >= promo.endsAt) return 'ENDED';
  const { weekday, minute } = istParts(at);
  if (promo.weekdayMask !== null && promo.weekdayMask !== undefined) {
    if (!((promo.weekdayMask >> weekday) & 1)) return 'WRONG_DAY';
  }
  if (promo.startMinute !== null && promo.startMinute !== undefined) {
    if (minute < promo.startMinute) return 'BEFORE_WINDOW';
  }
  if (promo.endMinute !== null && promo.endMinute !== undefined) {
    if (minute >= promo.endMinute) return 'AFTER_WINDOW';
  }
  return null;
};

// lines: ACTIVE lines only, each { productId, categoryId, lineSubtotalPaise }.
// A product rule outranks the product's category rule either way round.
export const eligibleLines = (lines, itemRules) => {
  const inclP = new Set();
  const exclP = new Set();
  const inclC = new Set();
  const exclC = new Set();
  for (const r of itemRules) {
    if (r.kind === 'INCLUDE_PRODUCT') inclP.add(r.productId);
    else if (r.kind === 'EXCLUDE_PRODUCT') exclP.add(r.productId);
    else if (r.kind === 'INCLUDE_CATEGORY') inclC.add(r.categoryId);
    else if (r.kind === 'EXCLUDE_CATEGORY') exclC.add(r.categoryId);
  }
  const hasIncludes = inclP.size > 0 || inclC.size > 0;
  return lines.filter((l) => {
    if (exclP.has(l.productId)) return false;
    if (inclP.has(l.productId)) return true;
    if (exclC.has(l.categoryId)) return false;
    if (hasIncludes) return inclC.has(l.categoryId);
    return true;
  });
};

// The one evaluation. ctx = { lines, orderType, at }, lines as above.
// Returns { ok: true, benefitPaise } or { ok: false, reason }.
export const evaluatePromotion = (promo, ctx) => {
  const refusal = scheduleRefusal(promo, ctx.at);
  if (refusal) return { ok: false, reason: refusal };
  if (promo.channel && promo.channel !== ctx.orderType) return { ok: false, reason: 'WRONG_CHANNEL' };

  const subtotal = ctx.lines.reduce((a, l) => a + l.lineSubtotalPaise, 0);
  if (promo.minSpendPaise !== null && promo.minSpendPaise !== undefined && subtotal < promo.minSpendPaise) {
    return { ok: false, reason: 'BELOW_MIN_SPEND' };
  }

  const eligible = eligibleLines(ctx.lines, promo.itemRules ?? []);
  const base = eligible.reduce((a, l) => a + l.lineSubtotalPaise, 0);
  if (base <= 0) return { ok: false, reason: 'NO_ELIGIBLE_ITEMS' };

  let benefit =
    promo.benefitType === 'FLAT'
      ? Math.min(promo.flatPaise ?? 0, base)
      : percentOf(base, Math.round(Number(promo.percent) * 1000));
  if (promo.maxBenefitPaise !== null && promo.maxBenefitPaise !== undefined) {
    benefit = Math.min(benefit, promo.maxBenefitPaise);
  }
  if (benefit <= 0) return { ok: false, reason: 'NO_BENEFIT' };
  return { ok: true, benefitPaise: benefit };
};

// Whether `promo` may join the promotions already on the order.
export const stackingRefusal = (promo, appliedPromos) => {
  if (appliedPromos.length === 0) return null;
  if (!promo.stackable) return 'NOT_STACKABLE';
  if (appliedPromos.some((p) => !p.stackable)) return 'BLOCKED_BY_NON_STACKABLE';
  return null;
};

// Clamp a set of computed benefits so manual + promotions never exceeds the
// subtotal. Returns a Map redemptionId → clamped benefit. Highest precedence
// number yields first; ties break by promotion id for determinism.
export const clampBenefits = (entries, subtotalPaise, manualPaise) => {
  let room = Math.max(0, subtotalPaise - manualPaise);
  const out = new Map();
  const order = [...entries].sort(
    (a, b) => a.precedence - b.precedence || (a.promotionId < b.promotionId ? -1 : 1),
  );
  for (const e of order) {
    const granted = Math.min(e.benefitPaise, room);
    out.set(e.redemptionId, granted);
    room -= granted;
  }
  return out;
};
