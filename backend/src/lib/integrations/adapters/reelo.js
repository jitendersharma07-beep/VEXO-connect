// Reelo loyalty adapter (LANE providers).
//
// IDENTITY, settled before a line was written: the client's provider is REELO —
// reelo.io, Reelo Technologies Private Limited, restaurant loyalty/CRM in India.
// NOT reelo.me (a relocation service), NOT RELO Direct (US corporate
// relocation), NOT Reloy (a different Indian loyalty company). The names are
// close enough that getting this wrong would have pointed a customer-data
// connector at an unrelated company.
//
// SOURCE OF TRUTH: Reelo. This adapter reads and instructs; it never computes a
// balance. The client has roughly 100,000 existing customers with existing
// points, expiries and tier rules in their Reelo account, and the only safe way
// to preserve them is to never hold a competing opinion about them. Every
// balance this lane stores is marked as a cache and timestamped.
//
// Paths and the two-step redemption flow are taken from Reelo's own public POS
// integration collection (checked 2026-09-24). The authentication scheme is only
// PARTIALLY published — identity travels in the body as merchant_id +
// customer_key with vendor_id in the path, and one documented request also
// carries an `auth-key` header — so the header is sent when the operator has
// been given one and omitted when they have not, rather than invented.
//
// WHAT REELO'S PUBLISHED API CANNOT DO, and therefore what this adapter does not
// pretend to do: there is no bulk export, no bulk import and no historical
// customer export. Customers are created implicitly by bill sync. Migrating the
// existing 100,000 customers is consequently a Reelo-side export file, handled
// in lib/integrations/loyaltyImport.js — not a loop over an API that has no such
// endpoint.

import { providerDef } from '../providers.js';
import { ProviderCallError, providerFetch, joinUrl } from '../http.js';

const PATHS = providerDef('REELO').paths;

const DEFAULT_BASE = 'https://api.reelo.io';

// {{domain}}/v1/pos/integrations/{{vendor_id}}/<path>
const urlFor = (credential, config, path) =>
  joinUrl(joinUrl(config?.apiBase || DEFAULT_BASE, `/v1/pos/integrations/${encodeURIComponent(credential.vendorId)}`), path);

const headersFor = (credential) => ({
  'Content-Type': 'application/json',
  // Sent only when the operator was issued one. Sending an empty header would
  // be worse than sending none: an auth layer that sees the header present and
  // blank may reject differently than one that sees it absent, and we would be
  // debugging our own invention.
  ...(credential.authKey ? { 'auth-key': credential.authKey } : {}),
});

// Reelo identifies the STORE, not the company. Outlet-level keys override the
// company default so a multi-branch client whose Reelo account issues per-branch
// keys works without a second connection per branch.
const storeIdentity = (credential, outlet) => ({
  merchant_id: outlet?.externalOutletId || credential.merchantId,
  customer_key: outlet?.customerKey || credential.customerKey,
});

// --- phone normalisation -----------------------------------------------------

// Reelo is keyed on the customer's phone number, so this function decides
// whether the client's existing customer is FOUND or a DUPLICATE PROFILE gets
// created. That makes it the highest-consequence function in this lane.
//
// Deliberately different from the `ph:<digits>` key in routes/orders.js: that
// key never leaves the tenant, so raw digits are fine there. This one has to
// match a string Reelo already holds, and "+91 98765 43210", "09876543210" and
// "9876543210" are the same customer to a human and three different customers
// to a naive comparison.
//
// Returns { digits, e164, national, confident }. `confident` false means the
// number did not fit the Indian mobile pattern — the caller must then treat a
// miss as an exception to report rather than as licence to create a new profile.
export const normalizePhone = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  let national = digits;
  if (digits.length === 12 && digits.startsWith('91')) national = digits.slice(2);
  else if (digits.length === 13 && digits.startsWith('091')) national = digits.slice(3);
  else if (digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
  // 10 digits opening 6-9 is the Indian mobile series. Anything else is kept
  // verbatim and flagged, because silently reshaping an unrecognised number is
  // how one customer's points get credited to another.
  const confident = /^[6-9]\d{9}$/.test(national);
  return {
    digits,
    national,
    e164: confident ? `+91${national}` : null,
    confident,
  };
};

// --- calls -------------------------------------------------------------------

const post = async (credential, config, path, body, { method = 'POST' } = {}) => {
  const result = await providerFetch(urlFor(credential, config, path), {
    method,
    headers: headersFor(credential),
    body: JSON.stringify(body),
  });
  return result.json ?? {};
};

export const adapter = {
  key: 'REELO',
  operable: true,

  async checkConnection({ credential, config, outlet }) {
    // A lookup for a number that is syntactically valid and cannot belong to
    // anyone: the Indian mobile series starts at 6, so a 10-digit number opening
    // with 5 is well-formed enough to reach the endpoint and cannot match a real
    // customer. A connection test must not read a real person's balance, and it
    // must certainly not create anything — which rules out probing with
    // /bill/customer, the endpoint that creates profiles.
    try {
      await post(credential, config, PATHS.customerRewards, {
        ...storeIdentity(credential, outlet),
        phone: '5000000000',
      });
      return { ok: true, detail: 'Reelo answered the customer-lookup endpoint.' };
    } catch (err) {
      if (err instanceof ProviderCallError) {
        // A 404 "customer not found" is the endpoint working exactly as asked.
        // Treating it as a failure would make a correctly configured connection
        // report itself broken.
        if (err.status === 404) {
          return { ok: true, detail: 'Reelo answered (no customer for the probe number, which is expected).' };
        }
        return { ok: false, detail: err.message };
      }
      return { ok: false, detail: 'Reelo could not be reached' };
    }
  },

  // Reelo publishes no webhooks, so there is no inbound side. Stated rather than
  // left absent so the registry's shape is uniform and a future webhook does not
  // look like a missing feature today.
  parseInbound() {
    throw new ProviderCallError('Reelo does not publish webhooks; this lane never receives inbound Reelo calls', {
      kind: 'TERMINAL',
    });
  },

  // --- the operations ---------------------------------------------------------

  async lookupCustomer({ credential, config, outlet, phone }) {
    const norm = normalizePhone(phone);
    const body = await post(credential, config, PATHS.customerRewards, {
      ...storeIdentity(credential, outlet),
      phone: norm.national,
    });
    return {
      normalized: norm,
      // Field names read defensively: the collection shows the endpoint but a
      // response schema can change under us, and a missing balance must read as
      // "unknown" and not as zero. A zero balance shown to a customer who has
      // 4,000 points is the complaint this guards against.
      externalCustomerId: body.customer_id ?? body.customerId ?? body.id ?? null,
      name: body.name ?? body.customer_name ?? null,
      points: Number.isFinite(Number(body.points)) ? Number(body.points) : null,
      rewards: Array.isArray(body.rewards) ? body.rewards : [],
      raw: body,
    };
  },

  // Step 1 of redemption. Reelo sends the CUSTOMER an OTP; the cashier cannot
  // proceed without it. This is a till-workflow constraint, not just an API one,
  // and any UI that redeems in one tap cannot work against Reelo.
  async sendRedemptionOtp({ credential, config, outlet, phone }) {
    const norm = normalizePhone(phone);
    const body = await post(credential, config, PATHS.authenticate, {
      ...storeIdentity(credential, outlet),
      phone: norm.national,
    });
    return { requested: true, raw: body };
  },

  // Step 2. `idempotencyKey` is ours, not Reelo's — Reelo publishes no
  // idempotency mechanism, so the guard is the unique index on
  // LoyaltyOperation(connectionId, idempotencyKey) and the fact that this is
  // only ever called from a job whose row was claimed exactly once.
  async redeem({ credential, config, outlet, phone, otp, reward, points, billRef }) {
    const norm = normalizePhone(phone);
    const payload = {
      ...storeIdentity(credential, outlet),
      phone: norm.national,
      otp,
      ...(billRef ? { bill_number: billRef } : {}),
    };
    const path = reward ? PATHS.redeemCoupon : PATHS.redeemPoints;
    const body = await post(
      credential,
      config,
      path,
      reward ? { ...payload, coupon_code: reward } : { ...payload, points },
    );
    return {
      externalRef: body.transaction_id ?? body.id ?? null,
      pointsDelta: Number.isFinite(Number(body.points_redeemed)) ? -Number(body.points_redeemed) : null,
      balanceAfter: Number.isFinite(Number(body.points)) ? Number(body.points) : null,
      raw: body,
    };
  },

  // Bill sync. Also, per Reelo's documentation, the only way a customer comes
  // into existence — which is why this must never be called speculatively. A
  // bill sync for a mistyped phone number does not just fail, it enrols a
  // customer who does not exist, and the user's constraint on this is explicit.
  async syncBill({ credential, config, outlet, bill }) {
    const norm = normalizePhone(bill.phone);
    const body = await post(credential, config, PATHS.billCustomer, {
      ...storeIdentity(credential, outlet),
      phone: norm.national,
      ...(bill.name ? { name: bill.name } : {}),
      bill_number: bill.billNumber,
      bill_amount: bill.amount,
      bill_date: bill.billDate,
      // Reelo's documented transaction.source accepts 'zomato' and 'swiggy', so
      // an aggregator order is reported as such rather than as a counter sale.
      // Points rules differ by channel at many merchants.
      ...(bill.source ? { source: bill.source } : {}),
      ...(bill.paymentType ? { payment_type: bill.paymentType } : {}),
      ...(Array.isArray(bill.items) ? { items: bill.items } : {}),
    });
    return {
      externalRef: body.transaction_id ?? body.id ?? null,
      externalCustomerId: body.customer_id ?? body.customerId ?? null,
      pointsDelta: Number.isFinite(Number(body.points_earned)) ? Number(body.points_earned) : null,
      balanceAfter: Number.isFinite(Number(body.points)) ? Number(body.points) : null,
      raw: body,
    };
  },

  // The counterpart to a POS void. Reelo owns the reversal arithmetic; we say
  // which bill, never how many points to take back.
  async revert({ credential, config, outlet, billRef, phone }) {
    const norm = normalizePhone(phone);
    const body = await post(credential, config, PATHS.revertPoints, {
      ...storeIdentity(credential, outlet),
      phone: norm.national,
      bill_number: billRef,
    });
    return { externalRef: body.transaction_id ?? body.id ?? null, raw: body };
  },

  async saleReturn({ credential, config, outlet, billRef, phone, amount }) {
    const norm = normalizePhone(phone);
    const body = await post(credential, config, PATHS.saleReturn, {
      ...storeIdentity(credential, outlet),
      phone: norm.national,
      bill_number: billRef,
      return_amount: amount,
    });
    return { externalRef: body.transaction_id ?? body.id ?? null, raw: body };
  },

  async perform({ kind, payload, credential, config, outlet }) {
    switch (kind) {
      case 'REELO_BILL_SYNC':
        return this.syncBill({ credential, config, outlet, bill: payload });
      case 'REELO_REDEEM':
        return this.redeem({ credential, config, outlet, ...payload });
      case 'REELO_REVERT':
        return this.revert({ credential, config, outlet, ...payload });
      case 'REELO_SALE_RETURN':
        return this.saleReturn({ credential, config, outlet, ...payload });
      default:
        throw new ProviderCallError(`Reelo adapter has no handler for job kind ${kind}`, { kind: 'TERMINAL' });
    }
  },
};

export default adapter;
