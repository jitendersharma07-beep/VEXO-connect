// A complete reference implementation of the adapter contract in index.js.
//
// It exists so the signature, idempotency, application and reconciliation
// paths can be exercised end to end without a provider account. It will
// settle a payment on command, which is precisely what "no fake success"
// forbids in front of a real customer, so it is refused outside
// test/development twice over: by config/env.js at boot and by the registry.

import { hmacHex, hexEqual, withinTolerance, parseSignatureHeader } from './signature.js';

export const SIGNATURE_HEADER = 'x-atcpos-signature';

// Signed payload is `<timestamp>.<raw body>`, so a body lifted from one
// delivery cannot be replayed under a fresh timestamp: the timestamp is
// inside the MAC, not merely beside it.
export const signingPayload = (timestamp, rawBody) => `${timestamp}.${rawBody}`;

export const signPayload = (secret, timestamp, rawBody) =>
  `t=${timestamp},v1=${hmacHex(secret, signingPayload(timestamp, rawBody))}`;

// What this fake provider will answer when asked about an attempt. Empty by
// default, so an adapter nobody has primed reports no payment — the same
// answer a real provider gives for an attempt the customer abandoned, and the
// safe one to default to.
//
// A value may be a function, which is called on each fetch. That is not a
// convenience: it is the only way to test the race that matters. Recovery has
// to reach the provider over the network, and a webhook can land during that
// call, so a test needs a hook that runs WHILE the reconcile is mid-flight.
const settlements = new Map();

export const setTestSettlement = (intentProviderRef, answer) => {
  settlements.set(intentProviderRef, answer);
};

// What this fake provider will answer when asked where an attempt has got to.
// Separate from settlements because the two questions have different answers:
// an attempt can be PENDING, which fetchSettlement is deliberately unable to
// express. Unprimed, it falls back to the settlement answer, so a test that
// only cares about the settled case primes one map and not two.
const statuses = new Map();

export const setTestStatus = (intentProviderRef, answer) => {
  statuses.set(intentProviderRef, answer);
};

// Attempts this fake provider has been told to treat as cancelled. A cancel
// here is a REAL state change on the provider's side — the attempt stops being
// payable — which is exactly what a provider that supports cancellation does
// and what Razorpay, which does not, cannot.
const cancelled = new Set();

export const clearTestSettlements = () => {
  settlements.clear();
  statuses.clear();
  cancelled.clear();
};

export const testAdapter = {
  name: 'test',

  // The reference implementation supports everything the contract defines,
  // which is what makes it useful for exercising the routes. It is NOT a
  // statement about any real provider: see razorpay.js, where cancel,
  // cardPresent and contactless are all false and say why.
  capabilities: {
    createSession: true,
    getStatus: true,
    cancel: true,
    createRefund: true,
    partialRefund: true,
    fetchSettlement: true,
    verifyWebhook: true,
    checkoutHandoff: false,
    perAccountCredentials: true,
    verifyCredentials: true,
    cardPresent: false,
    contactless: false,
  },

  // Accepts anything with both halves present. It authenticates against
  // nothing, so there is nothing to be right or wrong about — what it exercises
  // is the route's handling of a yes and of a no, and the no is reachable by
  // storing an account with no key id.
  async verifyCredentials({ credentials }) {
    if (!credentials?.keyId) {
      return { ok: false, detail: 'no key id was supplied' };
    }
    return { ok: true, detail: 'the test adapter accepts any credentials' };
  },

  async fetchSettlement({ intentProviderRef }) {
    const answer = settlements.get(intentProviderRef);
    if (answer === undefined) {
      return { settled: false, reason: 'the provider has no payment on this attempt' };
    }
    return typeof answer === 'function' ? answer() : answer;
  },

  async getStatus({ intentProviderRef }) {
    if (cancelled.has(intentProviderRef)) {
      return { status: 'CANCELLED', detail: 'this attempt was cancelled with the provider' };
    }
    const primed = statuses.get(intentProviderRef);
    if (primed !== undefined) return typeof primed === 'function' ? primed() : primed;

    const answer = settlements.get(intentProviderRef);
    const resolved = typeof answer === 'function' ? answer() : answer;
    if (resolved?.settled) {
      return {
        status: 'SUCCEEDED',
        chargeRef: resolved.chargeRef ?? null,
        amountPaise: resolved.amountPaise ?? null,
        currency: resolved.currency ?? null,
        method: resolved.method ?? 'OTHER',
        detail: null,
      };
    }
    // Not settled is not failed. The customer may still be on the page.
    return { status: 'PENDING', detail: resolved?.reason ?? null };
  },

  async cancel({ intentProviderRef }) {
    cancelled.add(intentProviderRef);
    return { cancelled: true };
  },

  async createSession({ idempotencyKey }) {
    // Derived from the key, so a retried create yields the same reference
    // exactly as a real provider's idempotency would. checkoutUrl is null
    // because nothing here can actually take money.
    return {
      providerRef: `test_${hmacHex('atc-pos-test-adapter', idempotencyKey).slice(0, 24)}`,
      checkoutUrl: null,
    };
  },

  // Asks the provider to return money. It returns a reference, NOT a result:
  // a real provider queues the payout and confirms later by webhook, and
  // pretending otherwise here is exactly the fake success this codebase
  // refuses to ship.
  async createRefund({ idempotencyKey }) {
    return {
      providerRef: `testrf_${hmacHex('atc-pos-test-adapter-refund', idempotencyKey).slice(0, 22)}`,
    };
  },

  verifyWebhook({ rawBody, headers, secret, toleranceSeconds, nowMs }) {
    const parsed = parseSignatureHeader(headers?.[SIGNATURE_HEADER]);
    if (!parsed) return { valid: false, reason: 'signature header missing or malformed' };

    if (!withinTolerance(parsed.timestamp, toleranceSeconds, nowMs)) {
      return { valid: false, reason: 'signature timestamp outside tolerance' };
    }

    const expected = hmacHex(secret, signingPayload(parsed.timestamp, rawBody));
    if (!hexEqual(parsed.signature, expected)) {
      return { valid: false, reason: 'signature mismatch' };
    }

    // Only now is the body trustworthy enough to parse.
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { valid: false, reason: 'signed body is not valid JSON' };
    }

    const eventId = body?.id;
    const kind = body?.type;
    const providerRef = body?.data?.providerRef;
    const amountPaise = body?.data?.amountPaise;

    if (typeof eventId !== 'string' || !eventId) {
      return { valid: false, reason: 'event id missing' };
    }
    if (typeof kind !== 'string' || !kind) {
      return { valid: false, reason: 'event type missing' };
    }
    if (typeof providerRef !== 'string' || !providerRef) {
      return { valid: false, reason: 'provider reference missing' };
    }
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
      return { valid: false, reason: 'amount missing or not an integer count of paise' };
    }

    return {
      valid: true,
      eventId,
      kind,
      providerRef,
      amountPaise,
      currency: typeof body?.data?.currency === 'string' ? body.data.currency : 'INR',
    };
  },
};
