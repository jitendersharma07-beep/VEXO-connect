// VC-105 Menu Profitability — display helpers.
//
// Built against docs/VC105-API-CONTRACT.md v1.1.1
// sha256 182d5a16b259c65fb347114907b0a2e45817709fb3ccee3b3df9334df34a4eb0
//
// NOTHING HERE CALCULATES MONEY. The contract is explicit (§9): every money
// value and every classification is the server's, and the UI must not re-add,
// re-allocate, re-round or re-segment. What is here is unit rendering
// (paise -> rupees) and the one rule that matters most on this screen:
//
//   an unknown cost is NOT zero.
//
// A missing cost arrives as null. Formatting it with the ordinary money
// formatter would print "₹0.00", which reads as "this dish costs nothing" —
// the exact fabricated conclusion the contract forbids. `fmtPaise` refuses to
// do that: null renders as the unknown marker, and the caller has to opt in to
// a different placeholder deliberately.

import { fmtINR } from './pos.js';

export const CONTRACT_VERSION = '1.1.1';
export const CONTRACT_SHA256 = '182d5a16b259c65fb347114907b0a2e45817709fb3ccee3b3df9334df34a4eb0';

export const UNKNOWN = '—';

/**
 * Integer paise -> "₹1,234.56". null/undefined -> the unknown marker, never ₹0.
 *
 * The sign leads: a negative contribution margin reads as "-₹45.00", not
 * "₹-45.00". A loss is the thing the eye must catch first on this screen, and
 * the minus sign buried after the currency symbol is easy to miss in a column
 * of figures. This is local presentation — the shared fmtINR is unchanged, so
 * no other screen moves.
 */
export const fmtPaise = (paise, unknown = UNKNOWN) => {
  if (paise === null || paise === undefined) return unknown;
  return paise < 0 ? `-${fmtINR(Math.abs(paise) / 100)}` : fmtINR(paise / 100);
};

/** Milli-paise (thousandths of a paisa) -> rupees, for cost breakdown rows. */
export const fmtMilliPaise = (milli, unknown = UNKNOWN) =>
  milli === null || milli === undefined ? unknown : fmtINR(milli / 100000);

/** Server-computed percentage -> "83.8%". null -> unknown marker, never 0%. */
export const fmtPercent = (pct, unknown = UNKNOWN) =>
  pct === null || pct === undefined ? unknown : `${pct.toFixed(2)}%`;

/** Popularity share (0..1) -> "8.75%". */
export const fmtShare = (share) =>
  share === null || share === undefined ? UNKNOWN : `${(share * 100).toFixed(2)}%`;

/**
 * Render a recipe line's quantity the way a cook would read it.
 *
 * The contract carries quantities in milli-base-units (thousandths of g/ml/
 * pcs), which is right for arithmetic and unreadable on a screen: "150000"
 * means 150 ml. Where the fixture named the unit it was entered in, show that
 * instead — "0.15 L" is what the recipe actually says.
 *
 * This is unit rendering, not calculation: no money is derived here.
 */
export const fmtIngredientQty = (ing) => {
  if (ing?.qtyBaseMilli === null || ing?.qtyBaseMilli === undefined) return UNKNOWN;
  if (ing.unit && ing.factorMilli) {
    const inNamedUnit = ing.qtyBaseMilli / ing.factorMilli;
    return `${Number(inNamedUnit.toFixed(4))} ${ing.unit}`;
  }
  return `${Number((ing.qtyBaseMilli / 1000).toFixed(3))}`;
};

// Cost coverage vocabulary is the inventory schema's own StockCostStatus, plus
// STALE which the contract derives from costBasisAt against staleCostDays.
export const COST_STATUS = {
  ACTUAL: {
    label: 'Actual',
    hint: 'Costed from recorded stock at the established valuation method.',
    className: 'bg-emerald-100 text-emerald-800',
  },
  ESTIMATED: {
    label: 'Estimated',
    hint: 'Costed, but from an estimate rather than recorded stock movement.',
    className: 'bg-amber-100 text-amber-800',
  },
  STALE: {
    label: 'Stale',
    hint: 'A real cost, but struck longer ago than the stale-cost window. Counted, and flagged.',
    className: 'bg-orange-100 text-orange-800',
  },
  MISSING: {
    label: 'No cost',
    hint: 'No cost exists for this line. It is excluded from margin — it is not a zero cost.',
    className: 'bg-rose-100 text-rose-800',
  },
};

export const costStatusOf = (status) => COST_STATUS[status] ?? COST_STATUS.MISSING;

// The four menu-engineering segments. Thresholds are the server's and are
// displayed as numbers next to the chart, not restated as a rule of thumb.
export const SEGMENTS = {
  STAR: {
    label: 'Star',
    hint: 'Popular and high margin — protect it.',
    className: 'bg-emerald-100 text-emerald-800',
    dot: '#059669',
  },
  PLOUGHHORSE: {
    label: 'Ploughhorse',
    hint: 'Popular but low margin — it carries volume, not profit.',
    className: 'bg-sky-100 text-sky-800',
    dot: '#0284c7',
  },
  PUZZLE: {
    label: 'Puzzle',
    hint: 'High margin but few buyers — a promotion candidate.',
    className: 'bg-violet-100 text-violet-800',
    dot: '#7c3aed',
  },
  DOG: {
    label: 'Dog',
    hint: 'Neither popular nor profitable — a menu review candidate.',
    className: 'bg-slate-200 text-slate-700',
    dot: '#64748b',
  },
  UNCLASSIFIED: {
    label: 'No verdict',
    hint: 'Cost is unknown, so this item cannot be placed. It is NOT a dog.',
    className: 'bg-rose-100 text-rose-800',
    dot: '#e11d48',
  },
};

export const segmentOf = (segment) => SEGMENTS[segment] ?? SEGMENTS.UNCLASSIFIED;

export const CHANNELS = [
  { value: '', label: 'All channels' },
  { value: 'DINE_IN', label: 'Dine-in' },
  { value: 'TAKEAWAY', label: 'Takeaway' },
];

export const GROUP_BY = [
  { value: 'item', label: 'By item' },
  { value: 'store', label: 'By store' },
  { value: 'channel', label: 'By channel' },
  { value: 'period', label: 'By day' },
];
