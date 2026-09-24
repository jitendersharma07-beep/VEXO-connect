// Phase-2 shared helpers (contract docs/PHASE2-CONTRACT.md).
//
// HARD RULE (§3/§6): the client NEVER computes money. Helpers here only
// FORMAT server-sent rupee numbers for display. Client-side arithmetic is
// allowed solely for non-authoritative hints (disable a button), never for
// showing an amount.

// §5.3 — a payment is either hand-recorded by a member of staff or settled by
// a provider and confirmed by a signature-verified webhook. The two are never
// shown alike: the label states which, and is chosen from the payment's own
// channel rather than assumed. The receipt prints the server-sent `label`.
export const MANUAL_PAYMENT_LABEL = 'MANUAL PAYMENT RECORD — not gateway-verified';
export const GATEWAY_PAYMENT_LABEL = 'GATEWAY PAYMENT — confirmed by the provider';

export const paymentLabelFor = (channel) =>
  channel === 'GATEWAY' ? GATEWAY_PAYMENT_LABEL : MANUAL_PAYMENT_LABEL;

// Amber is the caution colour used for BILLED-but-unsettled elsewhere, and
// hand-recorded money carries the same "somebody asserted this" weight.
// Emerald matches PAID: provider-confirmed and not in question.
export const CHANNEL_STYLES = {
  MANUAL: 'bg-amber-100 text-amber-700',
  GATEWAY: 'bg-emerald-100 text-emerald-700',
};

export const channelStyle = (channel) => CHANNEL_STYLES[channel] || 'bg-slate-200 text-slate-600';

// Refund labels mirror the server's refundLabelFor (backend lib/orders.js):
// a gateway refund is only "paid out" once the provider's webhook confirmed
// it. Labelling it returned any earlier would tell the customer their money
// is back while the provider has moved nothing.
// The server sends its own `label` on every refund; that is the authority and
// is used whenever present. This is the fallback for an older payload.
export const refundLabelFor = (r) => {
  if (r?.label) return r.label;
  if (r?.channel !== 'GATEWAY') return 'REFUND HANDED BACK — recorded by staff';
  if (r?.status === 'SUCCEEDED') return 'REFUND PAID OUT — confirmed by the provider';
  if (r?.status === 'FAILED') return 'REFUND FAILED — the provider did not pay this out';
  if (r?.providerConfirmed === false) return 'REFUND SENT — awaiting confirmation from the provider';
  return 'REFUND REQUESTED — not yet paid out by the provider';
};

// A gateway refund the provider never acknowledged. It may already be paying
// out, so the screen must not offer "refund again" — only reconcile.
export const isUnconfirmedRefund = (r) =>
  r?.channel === 'GATEWAY' && r?.status === 'PENDING' && r?.providerConfirmed === false;

export const REFUND_STATUS_STYLES = {
  PENDING: 'bg-amber-100 text-amber-700',
  SUCCEEDED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
};

export const refundStatusStyle = (status) =>
  REFUND_STATUS_STYLES[status] || 'bg-slate-200 text-slate-600';

export const fmtINR = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// "an 8-digit", "a 6-digit", or "An 8-digit" to open a sentence.
//
// LANE accounts — the code length is configuration the server reports, not a
// constant these screens can read, so the article in front of it cannot be
// typed by hand. It was, and the panel that confirms a new colleague's setup
// code read "A 8-digit code is on its way" to every administrator who hired
// somebody. Written this way, changing the policy to six cannot strand an
// "an" in front of it either.
//
// Only 8, 11 and 18 take "an": eight, eleven and eighteen are the digit counts
// that begin with a vowel sound. Nothing plausible reaches the hundreds.
const TAKES_AN = new Set([8, 11, 18]);
export const digitsPhrase = (n, { capital = false } = {}) => {
  const article = TAKES_AN.has(Number(n)) ? 'an' : 'a';
  return `${capital ? `${article[0].toUpperCase()}${article.slice(1)}` : article} ${n}-digit`;
};

// Business dates are IST per contract §3.
const IST = 'Asia/Kolkata';

export const fmtDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        timeZone: IST,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

// Date with no clock, for things that are a day rather than a moment — a
// licence expiry, a plan start. Same IST pinning as fmtDateTime, and same
// reason: a licence that runs out on 31 March runs out on 31 March in
// Bengaluru, not on whatever date the viewer's laptop thinks it is. Rendered
// with `new Date(iso).toLocaleDateString()` instead, the identical licence
// reads 3/31/2027 from here and 3/30/2027 from New York, and "when does my
// licence expire" stops having one answer.
export const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', {
        timeZone: IST,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

export const fmtTime = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: '2-digit', minute: '2-digit' })
    : '—';

// YYYY-MM-DD in IST (en-CA locale formats exactly that).
export const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });
export const istDaysAgo = (days) =>
  new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: IST });

// --- error envelope helpers (§3) -------------------------------------------
export const apiErrorCode = (err) => err?.response?.data?.error?.code || '';
export const isLicenseError = (err) => apiErrorCode(err).startsWith('POS_LICENSE');

// --- roles (§5 role table) ---------------------------------------------------
export const isAtc = (user) => user?.role === 'POS_SUPER_ADMIN';
export const canSell = (user) =>
  ['CASHIER', 'BRANCH_MANAGER', 'CUSTOMER_OWNER'].includes(user?.role);
export const isManagerUp = (user) =>
  ['BRANCH_MANAGER', 'CUSTOMER_OWNER'].includes(user?.role);
export const canWriteCatalog = (user) =>
  ['CUSTOMER_OWNER', 'POS_SUPER_ADMIN'].includes(user?.role);
export const canWriteTables = (user) =>
  ['BRANCH_MANAGER', 'CUSTOMER_OWNER'].includes(user?.role);
export const canSeeReports = (user) =>
  ['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN'].includes(user?.role);

// Non-authoritative licence hint (§3): server is the authority (403
// POS_LICENSE_*); this only pre-disables write actions so the UI never fakes
// success. ATC operators bypass licensing.
export const licenseUsable = (license, user) => {
  if (isAtc(user)) return true;
  if (!license) return false;
  if (license.status !== 'ACTIVE') return false;
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) return false;
  return true;
};

export const ORDER_STATUS_STYLES = {
  OPEN: 'bg-sky-100 text-sky-700',
  BILLED: 'bg-amber-100 text-amber-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  REFUNDED: 'bg-purple-100 text-purple-700',
  VOID: 'bg-slate-200 text-slate-500',
};

// --- ATC operator company scope (§3: ?companyId= / x-pos-company) ----------
// Set only from the ATC console; cleared on login/logout. lib/api.js attaches
// the header on every request while a scope is active.
const ATC_SCOPE_KEY = 'pos.atcCompany';

export const getAtcScope = () => {
  try {
    const raw = sessionStorage.getItem(ATC_SCOPE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.id ? parsed : null;
  } catch {
    return null;
  }
};

export const setAtcScope = (company) => {
  try {
    if (company && company.id) {
      sessionStorage.setItem(ATC_SCOPE_KEY, JSON.stringify({ id: company.id, name: company.name || '' }));
    }
  } catch {
    // sessionStorage unavailable — scope simply not remembered.
  }
};

export const clearAtcScope = () => {
  try {
    sessionStorage.removeItem(ATC_SCOPE_KEY);
  } catch {
    // ignore
  }
};
