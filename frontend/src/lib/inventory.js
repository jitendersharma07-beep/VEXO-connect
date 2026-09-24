// Client-side helpers for the inventory screens.
//
// HARD RULE, inherited from lib/pos.js §3/§6 and extended here: the client
// never computes money and never computes stock. Everything below FORMATS a
// figure the server already decided. The server sends quantities as exact
// three-decimal strings and values as integer-paise strings precisely so that
// no browser has to turn them into floats, and nothing here does.

// --- units -----------------------------------------------------------------
//
// An item's stock unit is its BASE unit: grams, millilitres or pieces. The
// server stores and sends in that unit and only that unit, so these labels
// name what the number already is rather than converting it.
//
// There is deliberately no g→kg or ml→litre rescaling here. A screen that
// silently prints "1.5" where the ledger holds 1500 g gives two different
// answers to "how much is there", and the one the stock count is compared
// against is the ledger's.
export const BASE_UNIT_LABEL = { G: 'g', ML: 'ml', PCS: 'pcs' };

export const unitLabel = (baseUnit) => BASE_UNIT_LABEL[baseUnit] || baseUnit || '';

// Thousands separators for the whole part, the three decimals left alone.
const groupInt = (intPart) => {
  const neg = intPart.startsWith('-');
  const digits = neg ? intPart.slice(1) : intPart;
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// "1500.000" → "1,500.000". Strings in, strings out: parseFloat on a stock
// figure is how 0.1 kg becomes 0.09999999999999999 kg.
export const fmtQty = (qty, baseUnit) => {
  if (qty === null || qty === undefined || qty === '') return '—';
  const s = String(qty);
  const [i, d = ''] = s.split('.');
  const out = `${groupInt(i)}.${d.padEnd(3, '0').slice(0, 3)}`;
  return baseUnit ? `${out} ${unitLabel(baseUnit)}` : out;
};

// True when a three-decimal quantity string is exactly zero, without going
// through Number(). Used to decide emphasis, never to decide a total.
export const qtyIsZero = (qty) => /^-?0+(\.0*)?$/.test(String(qty ?? '0'));

export const qtyIsNegative = (qty) => String(qty ?? '').trim().startsWith('-');

// A packing factor is the one quantity the API sends as an integer count of
// thousandths rather than as a decimal string, because it is an Int column.
// Moving the point three places is done by slicing the digits, for the same
// reason everything else here is: /1000 on 12345 is exact today and stops being
// exact the moment somebody defines a pack of a heavy enough item.
export const fmtMilli = (milli, baseUnit) => {
  if (milli === null || milli === undefined || milli === '') return '—';
  const s = String(milli).trim();
  if (!/^-?\d+$/.test(s)) return '—';
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).padStart(4, '0');
  return fmtQty(`${neg ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`, baseUnit);
};

// --- money -----------------------------------------------------------------
//
// Paise arrive as a string because they can exceed Number.MAX_SAFE_INTEGER on
// a large valuation. The rupee point is inserted by slicing the string, so a
// ₹1,84,467,440,737,095.52 valuation prints the figure the server computed
// rather than the nearest double to it.
export const fmtPaise = (paise) => {
  if (paise === null || paise === undefined || paise === '') return '—';
  const s = String(paise).trim();
  if (!/^-?\d+$/.test(s)) return '—';
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).padStart(3, '0');
  const rupees = digits.slice(0, -2);
  const paisePart = digits.slice(-2);
  // Indian grouping: last three, then pairs.
  const head = rupees.slice(0, -3);
  const tail = rupees.slice(-3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  return `${neg ? '-' : ''}₹${grouped}.${paisePart}`;
};

// §7: "Missing costs must be visibly missing, never presented as zero-cost
// profit." A null unit cost is a position the ledger has never been able to
// value, and it says so in words. It must never fall through to ₹0.00.
export const COST_UNKNOWN = 'cost not known';

export const fmtCost = (paise) => (paise === null || paise === undefined ? COST_UNKNOWN : fmtPaise(paise));

export const COST_STATUS_STYLES = {
  ACTUAL: 'bg-emerald-100 text-emerald-700',
  ESTIMATED: 'bg-amber-100 text-amber-700',
  MISSING: 'bg-red-100 text-red-700',
};

// --- stock states (§4) ------------------------------------------------------
//
// Six figures the spec insists are kept apart. The wording is the wording the
// screens use, because "available" and "usable" differing by reservations is
// the whole point and a tooltip is where that gets lost.
export const STOCK_STATE_HELP = {
  physical: 'Everything on the shelf, including stock that may not be sold.',
  usable: 'Physical minus expired, recalled, quarantined and damaged stock.',
  reserved: 'Usable stock already promised to an approved request.',
  available: 'Usable minus reserved — what a new request can actually draw on.',
  inTransit: 'Dispatched by the sender and not yet accepted by the receiver.',
  blocked: 'Expired, recalled, quarantined or damaged. Present but unavailable.',
};

// --- batch blocking (§3) ----------------------------------------------------
//
// The server derives this at read time by comparing expiry to now; it is never
// a stored flag, so a scheduler that is down cannot make expired stock look
// available. The client only renders the server's answer.
export const BLOCK_REASON_LABEL = {
  EXPIRED: 'Expired',
  RECALLED: 'Recalled',
  QUARANTINED: 'Quarantined',
};

export const blockLabel = (reason) => (reason ? BLOCK_REASON_LABEL[reason] || reason : null);

export const BATCH_STATE_STYLES = {
  AVAILABLE: 'bg-emerald-100 text-emerald-700',
  QUARANTINED: 'bg-amber-100 text-amber-700',
  RECALLED: 'bg-red-100 text-red-700',
};

// --- request and transfer lifecycle (§5) ------------------------------------
//
// Submission, allocation, dispatch and receipt are four different things and
// the colours keep them four different things. Amber is "somebody still has to
// act"; sky is "moving"; emerald is "settled".
export const REQUEST_STATUS_STYLES = {
  DRAFT: 'bg-slate-200 text-slate-600',
  SUBMITTED: 'bg-amber-100 text-amber-700',
  PARTIALLY_APPROVED: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-sky-100 text-sky-700',
  IN_FULFILMENT: 'bg-sky-100 text-sky-700',
  FULFILLED: 'bg-emerald-100 text-emerald-700',
  // Fulfilled short and signed off. Deliberately not the same colour as
  // FULFILLED: §5 forbids closing a partially fulfilled request without
  // explicitly cancelling the rest, and the screen should not let the two
  // outcomes look alike afterwards either.
  CLOSED_SHORT: 'bg-orange-100 text-orange-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
  REJECTED: 'bg-red-100 text-red-700',
};

export const REQUEST_STATUS_LABEL = {
  PARTIALLY_APPROVED: 'Partly approved',
  IN_FULFILMENT: 'In fulfilment',
  CLOSED_SHORT: 'Closed short',
};

export const requestStatusLabel = (s) => REQUEST_STATUS_LABEL[s] || s;

export const TRANSFER_STATUS_STYLES = {
  REQUESTED: 'bg-amber-100 text-amber-700',
  DISPATCHED: 'bg-sky-100 text-sky-700',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-slate-200 text-slate-500',
};

export const REMINDER_STATE_STYLES = {
  PENDING: 'bg-amber-100 text-amber-700',
  NOTIFIED: 'bg-sky-100 text-sky-700',
  ESCALATED: 'bg-red-100 text-red-700',
  ACKNOWLEDGED: 'bg-emerald-100 text-emerald-700',
  OBSOLETE: 'bg-slate-200 text-slate-500',
};

// §6 lists what a reminder may be about. The four the scheduler owns and the
// four the request routes own are not distinguished here — to the person being
// chased they are all "somebody needs to do something" — but each one names
// the actual action so an inbox of eight reminders is eight instructions
// rather than eight notifications.
export const REMINDER_KIND_LABEL = {
  SUBMISSION_CUTOFF: 'Order cutoff approaching',
  PENDING_APPROVAL: 'Waiting for approval',
  DISPATCH_DUE: 'Dispatch due',
  DELIVERY_OVERDUE: 'Delivery overdue',
  RECEIPT_PENDING: 'Waiting to be received',
  UNRESOLVED_SHORTAGE: 'Shortage not settled',
  BATCH_EXPIRING: 'Batch expiring',
  OPENED_CONTAINER_EXPIRING: 'Opened container expiring',
};

export const reminderKindLabel = (k) => REMINDER_KIND_LABEL[k] || k;

export const badge = (map, key) => `badge ${map[key] || 'bg-slate-100 text-slate-600'}`;

// --- movement types (§4) ----------------------------------------------------
//
// Every stock change is one of these and the ledger screen names it in the
// operator's language. A reversal reads as a reversal rather than as a second
// issue, because §4 forbids silent edits and the screen has to show that the
// correction is a linked entry and not an overwrite.
export const MOVEMENT_LABEL = {
  GRN: 'Goods received',
  PURCHASE_RETURN: 'Returned to supplier',
  SALE_CONSUMPTION: 'Consumed by a sale',
  SALE_REVERSAL: 'Sale reversed',
  WASTAGE: 'Wastage',
  COUNT_ADJUSTMENT: 'Stock count adjustment',
  TRANSFER_OUT: 'Dispatched',
  TRANSFER_IN: 'Received',
  PRODUCTION_IN: 'Produced',
  PRODUCTION_OUT: 'Consumed by production',
};

export const movementLabel = (type) => MOVEMENT_LABEL[type] || type;

// --- roles (§8) -------------------------------------------------------------
//
// These mirror INVENTORY_ACTIONS in backend/src/lib/inventory/permissions.js
// exactly, and they mirror it for one reason only: to avoid offering a button
// the server is going to refuse. They are NOT the permission check. Every
// route re-checks on the server, including a request typed straight at the
// API with no browser involved, which is what §8's "enforce all permissions on
// the server" means. Deleting this file must weaken nothing.
export const canUseInventory = (user) =>
  ['CUSTOMER_OWNER', 'BRANCH_MANAGER'].includes(user?.role);

export const isInventoryOwner = (user) => user?.role === 'CUSTOMER_OWNER';

// A cashier reaches no inventory screen at all. Stated as its own helper
// because §8 words it as a prohibition — "cashiers cannot change stock" — and
// the honest implementation of that is that they do not get the screens
// either, rather than getting them with the buttons greyed out.
export const isCashier = (user) => user?.role === 'CASHIER';

export const MINUTES_IN_DAY = 1440;

// A plan's cutoff is stored as a minute of the day in the plan's OWN timezone,
// so it renders as a clock face and never through Date — a plan cutting off at
// 18:00 in Kolkata cuts off at 18:00 in Kolkata whoever is looking at it.
export const fmtMinuteOfDay = (m) => {
  if (m === null || m === undefined) return '—';
  const n = Number(m);
  if (!Number.isInteger(n) || n < 0 || n >= MINUTES_IN_DAY) return '—';
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

export const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const fmtDeliveryDays = (days) =>
  Array.isArray(days) && days.length ? days.map((d) => DAY_NAMES[d] || d).join(', ') : '—';

export const LOCATION_KIND_LABEL = {
  WAREHOUSE: 'Warehouse',
  STORE: 'Store room',
  CENTRAL_KITCHEN: 'Central kitchen',
  SUBLOCATION: 'Sublocation',
};

export const ITEM_KIND_LABEL = {
  RAW: 'Raw',
  SEMI_FINISHED: 'Semi-finished',
  FINISHED: 'Finished',
  PACKAGING: 'Packaging',
};
