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

export const testAdapter = {
  name: 'test',

  async createSession({ idempotencyKey }) {
    // Derived from the key, so a retried create yields the same reference
    // exactly as a real provider's idempotency would. checkoutUrl is null
    // because nothing here can actually take money.
    return {
      providerRef: `test_${hmacHex('atc-pos-test-adapter', idempotencyKey).slice(0, 24)}`,
      checkoutUrl: null,
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
