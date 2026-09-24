// VC-104 Central phone-order centre — display helpers.
//
// Contract: ../vc104-api/docs/VC104-API-CONTRACT.md. The version and checksum
// are pinned here so a contract change nobody announced shows up as a diff
// rather than as a silently wrong screen. (Checksum is of the contract file at
// the moment this screen was verified against it.)
export const VC104_CONTRACT_VERSION = '1.2.1';
export const VC104_CONTRACT_SHA256 =
  'd9e7f70b8ea02f4e64c7d0bc8493b4652008f94298cb3fd83caf2e5c0f0a0d9a';

// HARD RULE (contract §3/§8): the client never computes money. payableQuote,
// order.total and deliveryCharge are three server-sent numbers; this screen
// formats them and never adds them. total is food+tax only; payableQuote is
// what the caller pays; deliveryCharge is QUOTED, not billed (C-6 open).

export const PHONE_STATUS_STYLES = {
  SUBMITTED: 'bg-sky-100 text-sky-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-700',
};

export const phoneStatusStyle = (status) =>
  PHONE_STATUS_STYLES[status] || 'bg-slate-200 text-slate-600';

// Filterable statuses only. CANCELLED exists in the enum but no route can
// produce it and ?status=CANCELLED is a 400 — so it gets no chip (contract §4).
export const QUERYABLE_STATUSES = ['SUBMITTED', 'ACCEPTED', 'REJECTED'];

export const FULFILMENT_LABELS = { PICKUP: 'Pickup', DELIVERY: 'Delivery' };

// The server sends an authoritative `message` beside every reason code; the
// message is what is shown. These are badge labels only.
export const REASON_LABELS = {
  NOT_SERVICEABLE: 'Out of area',
  CLOSED_AT_FULFILMENT: 'Closed',
  AT_CAPACITY: 'Kitchen full',
  MENU_UNAVAILABLE: 'Menu item unavailable',
  BELOW_MIN_ORDER: 'Below minimum',
  BRANCH_INACTIVE: 'Inactive store',
  NOT_ENTITLED: 'Not entitled',
};

export const reasonLabel = (code) => REASON_LABELS[code] || code;

// --- error envelope helpers (§3, §11) ---------------------------------------

export const errCode = (err) => err?.response?.data?.error?.code || '';
export const errDetails = (err) => err?.response?.data?.error?.details || null;
export const unavailableReasonsOf = (err) => errDetails(err)?.unavailableReasons ?? [];
export const conflictCustomerIdOf = (err) => errDetails(err)?.customerId ?? null;

// §5.7 — generated ONCE when the entry form opens and reused for every retry
// of that submission, so a double-click or a network retry can never create a
// second order. A fresh key means a fresh form, never a fresh click.
export const newIdempotencyKey = () => crypto.randomUUID();
