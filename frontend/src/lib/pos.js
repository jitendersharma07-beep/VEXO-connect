// Phase-2 shared helpers (contract docs/PHASE2-CONTRACT.md).
//
// HARD RULE (§3/§6): the client NEVER computes money. Helpers here only
// FORMAT server-sent rupee numbers for display. Client-side arithmetic is
// allowed solely for non-authoritative hints (disable a button), never for
// showing an amount.

// §5.3 — every phase-2 payment is a hand-recorded entry. This exact label is
// rendered wherever a payment appears; the receipt additionally prints the
// server-sent `label` verbatim.
export const MANUAL_PAYMENT_LABEL = 'MANUAL PAYMENT RECORD — not gateway-verified';

export const fmtINR = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
