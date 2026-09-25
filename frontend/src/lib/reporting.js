// LANE reporting — how a report payload is turned into something readable.
//
// The server decides what a report contains; this decides only how it looks. No
// figure is computed here and none is re-derived: a percentage on the screen is
// the percentage the server sent, because the moment the client divides two
// numbers itself the screen and the export begin to disagree and there is no way
// to tell which one the owner was reading.
//
// The cell rules below are the same rules backend/src/lib/reporting/export.js
// applies. That is not a coincidence to be maintained by hand — it is what makes
// "the CSV matches the screen" true rather than hopeful, so if one side changes,
// the other has to.

import api from './api.js';

export const PRESET_LABELS = Object.freeze({
  TODAY: 'Today',
  YESTERDAY: 'Yesterday',
  THIS_WEEK: 'This week',
  LAST_WEEK: 'Last week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  THIS_FINANCIAL_YEAR: 'This financial year',
  LAST_FINANCIAL_YEAR: 'Last financial year',
  CUSTOM: 'Custom range',
});

export const GROUPING_LABELS = Object.freeze({ DAY: 'Daily', WEEK: 'Weekly', MONTH: 'Monthly' });

export const FORMAT_LABELS = Object.freeze({
  csv: 'CSV',
  xlsx: 'Excel',
  pdf: 'PDF',
  json: 'JSON',
});

export const REPORT_LABELS = Object.freeze({
  sales: 'Sales, tax and discounts',
  salesByPeriod: 'Sales by period',
  tax: 'Tax by rate',
  discounts: 'Discounts given',
  productMix: 'Product and menu mix',
  locationComparison: 'Location comparison',
  collections: 'Collections by method',
  dues: 'Outstanding dues',
  refunds: 'Refunds',
  settlement: 'Settlement reconciliation',
  cash: 'Cash and shift differences',
  consumption: 'Ingredient consumption',
  wastage: 'Recorded wastage',
  stockValuation: 'Stock valuation',
  expiry: 'Batch expiry and holds',
  transfers: 'Warehouse transfers',
  purchasing: 'Supplier purchases',
  kitchenDelays: 'Kitchen and service delays',
  loyalty: 'Customer and loyalty',
  delivery: 'Delivery channels',
  profitability: 'Food margin and contribution',
});

export const FAMILY_GROUPS = Object.freeze([
  { key: 'revenue', label: 'Revenue', families: ['sales', 'productMix', 'locationComparison'] },
  { key: 'money', label: 'Money', families: ['collections', 'dues', 'refunds', 'settlement', 'cash'] },
  {
    key: 'stock',
    label: 'Stock and consumption',
    families: ['consumption', 'wastage', 'stockValuation', 'expiry', 'transfers', 'purchasing'],
  },
  {
    key: 'other',
    label: 'Operations and customers',
    families: ['kitchenDelays', 'loyalty', 'delivery', 'profitability', 'accounting'],
  },
]);

const inr = (rupees) =>
  `₹${Number(rupees).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A money value as the server sends it: `{ paise, amount }`.
 *
 * Rendered from `amount` — the rupee figure the server already rounded — rather
 * than by dividing the paise here. Two roundings of the same number are how a
 * screen ends up a paisa away from the spreadsheet beside it.
 */
export const fmtMoney = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return inr(v.amount ?? 0);
  return inr(v);
};

export const fmtQty = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return `${v.qty}${v.unitLabel ? ` ${v.unitLabel}` : ''}`;
  return String(v);
};

export const fmtInt = (v) =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN');

// null is "no ratio", not zero. A store that sold nothing has no discount rate,
// and printing 0% claims it gave no discounts on sales it never made.
export const fmtPercent = (v) => (v === null || v === undefined ? '—' : `${v}%`);

export const COVERAGE_STYLES = Object.freeze({
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  NO_ACTIVITY: 'bg-slate-100 text-slate-600',
  NEVER_RECORDED: 'bg-amber-100 text-amber-700',
  STALE: 'bg-red-100 text-red-700',
});

// The three "no data" answers §7 requires to stay apart. Zero activity is a
// measurement; never recorded is a store that has never sent anything; stale is
// a till that stopped talking and whose figures are therefore incomplete rather
// than low.
export const COVERAGE_LABELS = Object.freeze({
  ACTIVE: 'Reporting',
  NO_ACTIVITY: 'No activity',
  NEVER_RECORDED: 'Never reported',
  STALE: 'Stale',
});

export const STATE_STYLES = Object.freeze({
  AVAILABLE: 'bg-emerald-100 text-emerald-700',
  PENDING_INTEGRATION: 'bg-amber-100 text-amber-700',
  UNAVAILABLE: 'bg-slate-200 text-slate-600',
});

export const CADENCE_LABELS = Object.freeze({
  DAILY: 'Every day',
  WEEKLY: 'Every week',
  MONTHLY: 'Every month',
});

export const SCHEDULE_STATE_STYLES = Object.freeze({
  DRAFT: 'bg-slate-100 text-slate-600',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PAUSED: 'bg-amber-100 text-amber-700',
});

// SENT is deliberately never rendered as "emailed". This build writes a spool
// file, the delivery row records which transport carried it, and the screen prints
// that word — an owner who reads "sent" as "my accountant has it" would have been
// misled by the screen, not by the server.
export const DELIVERY_STATUS_STYLES = Object.freeze({
  SENT: 'bg-emerald-100 text-emerald-700',
  PENDING: 'bg-slate-100 text-slate-600',
  SKIPPED: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700',
});

export const SEVERITY_STYLES = Object.freeze({
  CRITICAL: 'bg-red-100 text-red-700',
  WARNING: 'bg-amber-100 text-amber-700',
  INFO: 'bg-sky-100 text-sky-700',
});

export const EXCEPTION_STATUS_STYLES = Object.freeze({
  OPEN: 'bg-red-50 text-red-700',
  ACKNOWLEDGED: 'bg-amber-50 text-amber-700',
  RESOLVED: 'bg-emerald-50 text-emerald-700',
  DISMISSED: 'bg-slate-100 text-slate-600',
});

export const EXCEPTION_KIND_LABELS = Object.freeze({
  CASH_DIFFERENCE: 'Cash difference at closing',
  UNCLOSED_SHIFT: 'Day not closed',
  UNUSUAL_REFUND: 'Large refund',
  UNUSUAL_DISCOUNT: 'Heavily discounted bill',
  DELAYED_KITCHEN_ORDER: 'Kitchen delay',
  STALE_BRANCH_DATA: 'Store stopped reporting',
  LOW_STOCK: 'Below reorder level',
  NEAR_EXPIRY: 'Batch near expiry',
  OVERDUE_REQUEST: 'Overdue warehouse request',
  SETTLEMENT_MISMATCH: 'Settlement mismatch',
});

// Who is expected to act — re-exported from roles.js, which is where a PosRole
// becomes English for every other screen in this product.
//
// This lane started with its own four-entry copy and it had already drifted:
// "Store manager" here against "Store Manager" on the team and permission
// screens. Four entries were enough to disagree, and the exception worklist is
// the screen most likely to be read beside the team list, since the point of
// naming a role is that somebody goes and finds that person.
export { roleLabel } from './roles.js';

const WEEKDAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

// 0 = Sunday, the numbering the server stores and getDay() returns. The one place
// a screen is tempted to invent its own is the one place an owner ends up with the
// Monday report arriving on Sunday.
export const weekdayName = (n) => WEEKDAY_NAMES[n] ?? '—';

export const hhmm = (minutes) =>
  `${String(Math.floor((minutes ?? 0) / 60)).padStart(2, '0')}:${String((minutes ?? 0) % 60).padStart(
    2,
    '0',
  )}`;

const ordinal = (n) => {
  const tail = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${tail[(v - 20) % 10] ?? tail[v] ?? tail[0]}`;
};

/** When a schedule fires, in the words the person configuring it would use. */
export const cadenceSentence = (s) => {
  const at = `${hhmm(s.sendAtMinutes)} ${s.timezone}`;
  if (s.cadence === 'DAILY') return `Every day at ${at}`;
  if (s.cadence === 'WEEKLY') return `Every ${weekdayName(s.weekday)} at ${at}`;
  // A monthly schedule asked for the 31st fires on the last day of a shorter
  // month rather than skipping it. Said here because the form cannot show it.
  return `The ${ordinal(s.dayOfMonth ?? 1)} of each month at ${at}${
    (s.dayOfMonth ?? 1) > 28 ? ' — the last day, in a shorter month' : ''
  }`;
};

export const fmtWhen = (iso) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const STATE_LABELS = Object.freeze({
  AVAILABLE: 'Ready',
  PENDING_INTEGRATION: 'Pending integration',
  UNAVAILABLE: 'Not in this build',
});

export const fmtCell = (row, column) => {
  const v = row?.[column.key];
  if (v === null || v === undefined) return '—';
  // A store that has never sent a transaction has not sold ₹0.00; nothing was
  // measured at all, and the server says so in row.coverage. Printing the zero
  // it returns for arithmetic's sake would put "no sales today" and "this till
  // has never been switched on" in the same column, looking identical.
  //
  // NO_ACTIVITY is deliberately not included: a store that traded before and
  // did not trade in this period really did take zero, and that IS a
  // measurement somebody should see.
  if (row?.coverage?.state === 'NEVER_RECORDED' && RIGHT_ALIGNED.has(column.type)) return '—';
  switch (column.type) {
    case 'money':
      return fmtMoney(v);
    case 'qty':
      return fmtQty(v);
    case 'percent':
      return fmtPercent(v);
    case 'integer':
      return fmtInt(v);
    case 'coverage':
      return COVERAGE_LABELS[v.state] ?? v.state;
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
};

export const RIGHT_ALIGNED = new Set(['money', 'integer', 'percent', 'qty']);

/** Signed, with the sign kept: a fall is information, not an error. */
export const fmtDelta = (d) => {
  if (!d || d.changePercent === null || d.changePercent === undefined) return null;
  const pct = d.changePercent;
  return {
    text: `${pct > 0 ? '+' : ''}${pct}%`,
    up: pct > 0,
    down: pct < 0,
    flat: pct === 0,
  };
};

export const deltaTone = (d, higherIsBetter = true) => {
  const f = fmtDelta(d);
  if (!f || f.flat) return 'text-slate-500';
  const good = f.up === higherIsBetter;
  return good ? 'text-emerald-600' : 'text-red-600';
};

/**
 * Query parameters for a report request.
 *
 * Built once and used for the screen, every drill-down and every export, because
 * §3 requires the filters to be the same in all three. A CSV produced from a
 * different parameter set than the table above it is worse than no CSV.
 */
export const reportParams = (filters) => {
  const p = {};
  if (filters.preset) p.preset = filters.preset;
  if (filters.preset === 'CUSTOM') {
    if (filters.from) p.from = filters.from;
    if (filters.to) p.to = filters.to;
  }
  if (filters.grouping) p.grouping = filters.grouping;
  if (filters.storeId) p.storeId = filters.storeId;
  if (filters.regionId) p.regionId = filters.regionId;
  if (filters.brandId) p.brandId = filters.brandId;
  if (filters.legalEntityId) p.legalEntityId = filters.legalEntityId;
  if (filters.includeDemo) p.includeDemo = 'true';
  if (filters.groupBy) p.groupBy = filters.groupBy;
  return p;
};

/**
 * The inverse of reportParams: read the filters back out of a URL.
 *
 * Shared by the consolidated dashboard and every report screen, because two
 * copies of this would drift — and the drift would show up as a link that
 * opens on a different period than the one that was sent.
 */
export const filtersFromSearch = (sp) => ({
  preset: sp.get('preset') ?? 'TODAY',
  from: sp.get('from') ?? '',
  to: sp.get('to') ?? '',
  grouping: sp.get('grouping') ?? 'DAY',
  storeId: sp.get('storeId') ?? '',
  regionId: sp.get('regionId') ?? '',
  brandId: sp.get('brandId') ?? '',
  legalEntityId: sp.get('legalEntityId') ?? '',
  includeDemo: sp.get('includeDemo') === 'true',
  groupBy: sp.get('groupBy') ?? '',
});

const filenameFrom = (headers, fallback) => {
  const cd = headers?.['content-disposition'] ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  return m ? m[1] : fallback;
};

/**
 * Download an export.
 *
 * Fetched through the api client rather than by pointing the browser at the URL:
 * the client carries the session and the company scope header, and an ATC
 * operator's export must land in the company they are actually looking at. A
 * plain link would drop the header and export the wrong tenant — or nothing.
 */
export const downloadReport = async (key, filters, format) => {
  const res = await api.get(`/reporting/reports/${key}/export`, {
    params: { ...reportParams(filters), format },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(res.headers, `${key}.${format}`);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
