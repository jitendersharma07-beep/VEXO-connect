// Deterministic in-process adapters (LANE providers).
//
// NOT OPERATIONAL AND NOT A PROVIDER. These exist so the parts of this lane that
// are genuinely ours — dedupe, ordering, outlet resolution, backoff, the error
// queue, the reconciliation report, the import reporting — can be exercised and
// proven without a provider account, and without ever calling a real provider's
// production API.
//
// What they can prove: that a redelivered webhook makes one kitchen ticket; that
// an out-of-order cancellation is not applied; that a failed voucher lands in the
// error queue and retries with backoff; that two companies cannot see each
// other's connections.
//
// What they CANNOT prove, and must never be cited as proving: that our request
// bodies match what Zomato or Reelo actually expect. A test adapter agrees with
// whatever we send it. Passing tests against this file is evidence about VEXO,
// never evidence about the provider.
//
// Registry access is gated on NODE_ENV so production cannot name one — same
// reasoning as the gateway's test-adapter guard in config/env.js, and the same
// distance between "verified" and "fake success".

import { ProviderCallError } from '../http.js';

// A settable script so a test can say "the next call times out" and assert what
// this lane does about it, rather than waiting for a real outage to find out.
const state = {
  failNext: null,   // null | { kind, message }
  ackNext: null,    // null | an import acknowledgement to answer with once
  calls: [],
  balances: new Map(),
};

export const testControl = {
  reset() {
    state.failNext = null;
    state.ackNext = null;
    state.calls = [];
    state.balances = new Map();
  },
  failNextWith(kind, message = 'scripted failure') {
    state.failNext = { kind, message };
  },
  // A settable acknowledgement, so a test can hand the accounting side the one
  // answer that matters most: an HTTP 200 that does NOT say a voucher was
  // created. Tally really does answer that way — a voucher referencing a ledger
  // that does not exist comes back 200 with created:0 and errors:1 — and the
  // difference between "accepted" and "created one voucher" is the difference
  // between books that balance and books that do not.
  ackNextWith(detail) {
    state.ackNext = detail;
  },
  setBalance(phone, points) {
    state.balances.set(String(phone).replace(/\D/g, '').slice(-10), points);
  },
  calls: () => state.calls.slice(),
};

const maybeFail = () => {
  if (!state.failNext) return;
  const { kind, message } = state.failNext;
  state.failNext = null;
  throw new ProviderCallError(message, { kind });
};

const record = (op, args) => {
  state.calls.push({ op, args, at: new Date() });
};

// --- aggregator double -------------------------------------------------------

export const testAggregator = {
  key: 'TEST_AGGREGATOR',
  operable: true,
  async checkConnection() {
    record('checkConnection', {});
    maybeFail();
    return { ok: true, detail: 'test aggregator (in-process, no provider contacted)' };
  },
  // Accepts an already-normalised envelope so a test can hand-write the exact
  // duplicate, out-of-order or unmappable-outlet case it wants to assert on.
  //
  // The date fields are still coerced, because that is part of what normalising
  // MEANS here and a JSON body cannot carry a Date: isStale() compares
  // providerEventAt with .getTime(), so an adapter that passed the string through
  // would hand the pipeline something it cannot compare. adapters/zomato.js does
  // the same coercion on the same two fields.
  parseInbound({ body }) {
    const asDate = (v) => {
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    return {
      ...body,
      providerEventAt: asDate(body.providerEventAt),
      placedAt: asDate(body.placedAt),
    };
  },
  async perform({ kind, payload }) {
    record(kind, payload);
    maybeFail();
    return { externalRef: `test-ref-${state.calls.length}`, detail: { echoed: payload } };
  },
};

// --- loyalty double ----------------------------------------------------------

const key10 = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

export const testLoyalty = {
  key: 'TEST_LOYALTY',
  operable: true,
  async checkConnection() {
    record('checkConnection', {});
    maybeFail();
    return { ok: true, detail: 'test loyalty (in-process, no provider contacted)' };
  },
  parseInbound() {
    throw new ProviderCallError('test loyalty adapter has no inbound side', { kind: 'TERMINAL' });
  },
  async lookupCustomer({ phone }) {
    record('lookupCustomer', { phone });
    maybeFail();
    const k = key10(phone);
    const known = state.balances.has(k);
    return {
      normalized: { national: k, e164: `+91${k}`, confident: /^[6-9]\d{9}$/.test(k), digits: k },
      externalCustomerId: known ? `test-cust-${k}` : null,
      name: known ? `Test ${k}` : null,
      // null, not 0, for an unknown customer — the distinction this lane is
      // built to preserve.
      points: known ? state.balances.get(k) : null,
      rewards: [],
      raw: {},
    };
  },
  async sendRedemptionOtp({ phone }) {
    record('sendRedemptionOtp', { phone });
    maybeFail();
    return { requested: true, raw: {} };
  },
  async redeem({ phone, points, otp }) {
    record('redeem', { phone, points, otp });
    maybeFail();
    const k = key10(phone);
    const before = state.balances.get(k) ?? 0;
    if (points > before) {
      throw new ProviderCallError('insufficient points', { kind: 'TERMINAL' });
    }
    state.balances.set(k, before - points);
    return { externalRef: `test-redeem-${state.calls.length}`, pointsDelta: -points, balanceAfter: before - points, raw: {} };
  },
  async syncBill({ bill }) {
    record('syncBill', bill);
    maybeFail();
    const k = key10(bill.phone);
    // Earn rule is 1 point per 100 rupees, chosen only because it is round.
    // Nothing in this lane depends on it: the provider owns the arithmetic, and
    // a test that asserted on this number would be asserting on the double.
    const earned = Math.floor(Number(bill.amount) / 100);
    const before = state.balances.get(k) ?? 0;
    state.balances.set(k, before + earned);
    return {
      externalRef: `test-bill-${bill.billNumber}`,
      externalCustomerId: `test-cust-${k}`,
      pointsDelta: earned,
      balanceAfter: before + earned,
      raw: {},
    };
  },
  async revert({ billRef, phone }) {
    record('revert', { billRef, phone });
    maybeFail();
    return { externalRef: `test-revert-${billRef}`, raw: {} };
  },
  async saleReturn({ billRef, phone, amount }) {
    record('saleReturn', { billRef, phone, amount });
    maybeFail();
    return { externalRef: `test-return-${billRef}`, raw: {} };
  },
  async perform({ kind, payload }) {
    switch (kind) {
      case 'REELO_BILL_SYNC': return this.syncBill({ bill: payload });
      case 'REELO_REDEEM': return this.redeem(payload);
      case 'REELO_REVERT': return this.revert(payload);
      case 'REELO_SALE_RETURN': return this.saleReturn(payload);
      default: throw new ProviderCallError(`test loyalty adapter has no handler for ${kind}`, { kind: 'TERMINAL' });
    }
  },
};

// --- accounting double -------------------------------------------------------

export const testAccounting = {
  key: 'TEST_ACCOUNTING',
  operable: true,
  // The vouchers it "accepted", so a test can assert that a voided-and-reissued
  // bill produced one sales voucher and one credit note, and not two of either.
  vouchers: () => state.calls.filter((c) => c.op.startsWith('TALLY_')),
  async checkConnection() {
    record('checkConnection', {});
    maybeFail();
    return { ok: true, detail: 'test accounting (in-process, no Tally contacted)' };
  },
  parseInbound() {
    throw new ProviderCallError('test accounting adapter has no inbound side', { kind: 'TERMINAL' });
  },
  async perform({ kind, payload }) {
    record(kind, payload);
    maybeFail();
    const ack = state.ackNext ?? { status: 1, created: 1, errors: 0, ok: true };
    state.ackNext = null;
    return { externalRef: null, detail: ack };
  },
};

export const TEST_ADAPTERS = Object.freeze({
  TEST_AGGREGATOR: testAggregator,
  TEST_LOYALTY: testLoyalty,
  TEST_ACCOUNTING: testAccounting,
});
