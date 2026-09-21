// Razorpay adapter for the contract in index.js.
//
// Written against Razorpay's published API. It is complete and exercised end
// to end against a stub of that API (tests/razorpay.test.js), which proves the
// wire format, the signatures and the failure classification — and proves
// nothing whatsoever about a real Razorpay account. NO SANDBOX CALL HAS BEEN
// MADE: that needs keys this repository does not have and must never hold.
// Until someone runs it against real test keys, treat "verified" here as
// "verified against the documentation", not "verified against Razorpay".
//
// Three Razorpay facts drive most of the shape below.
//
// 1. Razorpay names the ATTEMPT and the CHARGE differently. We open an
//    `order_…`, the customer pays it, and the money lands as a `pay_…`. A
//    refund posts to /payments/<pay_id>/refund, so the pay_… has to be kept
//    when the webhook brings it — PaymentIntent.providerRef holds the order_…
//    and cannot refund anything. That is Payment.providerRef, and it is why
//    verifyWebhook returns chargeRef alongside providerRef.
//
// 2. Razorpay's webhook carries NO timestamp header and documents no replay
//    window. The contract asks for one anyway, so it is taken from the body's
//    created_at — which is inside the signed bytes and therefore cannot be
//    edited by a replayer. This is our check, not a guarantee Razorpay makes:
//    a body replayed within the window still verifies, and the eventId unique
//    index is what actually stops it being applied twice.
//
// 3. An AUTHORIZED payment is not a captured one. The money is blocked on the
//    customer's card and the merchant has not received it. Only
//    payment.captured settles anything here; payment.authorized is passed
//    through unmapped so it lands in reconciliation for a human, which is the
//    correct outcome for "the customer thinks they paid and we have not been
//    paid".

import { Buffer } from 'node:buffer';

import { env } from '../../config/env.js';
import { hmacHex, hexEqual, withinTolerance } from './signature.js';
import {
  EVENT_SUCCEEDED,
  EVENT_FAILED,
  EVENT_REFUND_SUCCEEDED,
  EVENT_REFUND_FAILED,
} from './apply.js';

const DEFAULT_API_BASE = 'https://api.razorpay.com';
export const SIGNATURE_HEADER = 'x-razorpay-signature';
export const EVENT_ID_HEADER = 'x-razorpay-event-id';

const apiBase = () => (env.POS_GATEWAY_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');

// Razorpay authenticates API calls with HTTP Basic, key id as the user and key
// secret as the password.
const authHeader = () =>
  `Basic ${Buffer.from(`${env.POS_GATEWAY_KEY_ID}:${env.POS_GATEWAY_KEY_SECRET}`).toString('base64')}`;

// Every failure out of this module is one of these, and the distinction is the
// whole point: a caller may safely re-ask after a RETRYABLE one, because
// nothing was decided. A TERMINAL one is Razorpay saying no. An UNKNOWN one —
// timeout, socket reset — may already have moved money, so it is never
// reported as a refusal. orders.js turns anything non-terminal into an
// unconfirmed refund that keeps holding its amount.
export class RazorpayError extends Error {
  constructor(message, { kind, status = null, code = null }) {
    super(message);
    this.name = 'RazorpayError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryable = kind === 'RETRYABLE' || kind === 'UNKNOWN';
    // Part of the adapter contract, and deliberately opt-in: it asserts that
    // the provider received the request, refused it, and moved no money, which
    // is what lets orders.js release the reserved amount. An adapter that does
    // not set it gets the conservative outcome — an unconfirmed refund that
    // keeps holding its money until a human reconciles it.
    this.providerRefused = kind === 'TERMINAL';
  }
}

// 409 is in here deliberately: on an idempotent POST it means a concurrent
// request with the same key is still in flight, and the answer exists in a
// moment. 429 and 5xx are Razorpay asking us to come back.
const RETRYABLE_STATUS = new Set([409, 429, 500, 502, 503, 504]);

// Razorpay's error body is { error: { code, description, ... } }. The
// description is the operator-facing half and is safe to surface; the request
// that produced it is not, because it carries the key id.
const describeError = (status, parsed) => {
  const description = parsed?.error?.description;
  const code = parsed?.error?.code ?? null;
  return {
    code,
    message: typeof description === 'string' && description
      ? description
      : `Razorpay answered ${status}`,
  };
};

const request = async (method, path, { body, headers = {} } = {}) => {
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        authorization: authHeader(),
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(env.POS_GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    // A request that left this process and was never answered may have been
    // acted on. Nothing here may claim otherwise.
    throw new RazorpayError(
      `no answer from Razorpay: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error'}`,
      { kind: 'UNKNOWN' },
    );
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const { code, message } = describeError(response.status, parsed);
    throw new RazorpayError(message, {
      kind: RETRYABLE_STATUS.has(response.status) ? 'RETRYABLE' : 'TERMINAL',
      status: response.status,
      code,
    });
  }
  if (!parsed || typeof parsed !== 'object') {
    // A 200 we cannot read is not a success we can act on.
    throw new RazorpayError('Razorpay answered with a body that is not JSON', { kind: 'UNKNOWN', status: response.status });
  }
  return parsed;
};

// Razorpay sends amounts as an integer in the smallest unit, which for INR is
// paise — the same unit the contract uses — but a float or a string here would
// silently become the wrong amount of money, so it is checked rather than
// coerced.
const paiseFrom = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

// --- payments ---------------------------------------------------------------

// Razorpay's Orders API has no idempotency header (unlike its refunds). What it
// does have is `receipt`, our own id for the order, which is returned on the
// entity and is queryable. So the key is sent as the receipt, and a create that
// fails in a way that might still have created something is resolved by looking
// the receipt up rather than by posting again.
const findOrderByReceipt = async (receipt) => {
  const page = await request('GET', `/v1/orders?receipt=${encodeURIComponent(receipt)}&count=2`);
  const items = Array.isArray(page?.items) ? page.items : [];
  // Two orders under one receipt means the recovery itself is ambiguous, and
  // picking one would be a guess about which the customer can pay.
  return items.length === 1 ? items[0] : null;
};

const createSession = async ({ amountPaise, currency, orderId, idempotencyKey }) => {
  const payload = {
    amount: amountPaise,
    currency,
    receipt: idempotencyKey,
    // Nested form; the flat `payment_capture` is deprecated. Automatic capture
    // matters for correctness, not convenience: an authorized-but-uncaptured
    // payment is money the shop has not received, and this POS only ever
    // records captures.
    payment: { capture: 'automatic' },
    notes: { pos_order_id: orderId },
  };

  let created;
  try {
    created = await request('POST', '/v1/orders', { body: payload });
  } catch (err) {
    // Terminal means Razorpay refused and created nothing, so there is nothing
    // to recover. Anything else may have created an order we never saw the id
    // of; opening a second one would show the customer two payable pages for
    // one bill.
    if (err instanceof RazorpayError && err.kind === 'TERMINAL') throw err;
    const recovered = await findOrderByReceipt(idempotencyKey).catch(() => null);
    if (!recovered?.id) throw err;
    created = recovered;
  }

  if (typeof created.id !== 'string' || !created.id) {
    throw new RazorpayError('Razorpay created an order without an id', { kind: 'UNKNOWN' });
  }
  // A charge for a different amount than we asked for is not our charge.
  if (paiseFrom(created.amount) !== amountPaise) {
    throw new RazorpayError('Razorpay created an order for a different amount', { kind: 'TERMINAL' });
  }

  return {
    providerRef: created.id,
    // Razorpay has no hosted payment page to redirect to for this flow: the
    // browser opens Checkout with the order id and the publishable key id.
    // Null is the honest answer, and the frontend reads it as "use Checkout".
    checkoutUrl: null,
  };
};

// --- refunds ----------------------------------------------------------------

// chargeProviderRef is the pay_… the money actually landed on. intentProviderRef
// — the order_… — cannot be refunded; Razorpay has no such route, and passing
// it would 400 on every gateway refund ever raised.
const createRefund = async ({ chargeProviderRef, amountPaise, currency, orderId, idempotencyKey }) => {
  if (typeof chargeProviderRef !== 'string' || !chargeProviderRef.startsWith('pay_')) {
    throw new RazorpayError(
      'this payment has no Razorpay payment id recorded, so it cannot be refunded through the API',
      { kind: 'TERMINAL' },
    );
  }
  const refund = await request('POST', `/v1/payments/${encodeURIComponent(chargeProviderRef)}/refund`, {
    // Razorpay's own idempotency header for this route. With it, a retry of a
    // request we never saw the answer to returns the FIRST refund instead of
    // creating a second one — which is the difference between an unknown
    // outcome and paying the customer back twice.
    headers: { 'x-refund-idempotency': idempotencyKey },
    body: {
      amount: amountPaise,
      speed: 'normal',
      notes: { pos_order_id: orderId, pos_refund_key: idempotencyKey },
    },
  });

  if (typeof refund.id !== 'string' || !refund.id) {
    throw new RazorpayError('Razorpay accepted the refund without returning a reference', { kind: 'UNKNOWN' });
  }
  if (paiseFrom(refund.amount) !== amountPaise) {
    throw new RazorpayError('Razorpay refunded a different amount than was requested', { kind: 'TERMINAL' });
  }
  if (currency && typeof refund.currency === 'string' && refund.currency !== currency) {
    throw new RazorpayError('Razorpay refunded in a different currency', { kind: 'TERMINAL' });
  }

  // Deliberately NOT reporting refund.status here even when Razorpay already
  // says "processed". The refund is a request until refund.processed arrives
  // signed; an unsigned field in an API response is not evidence the money
  // moved, and treating it as such is what puts "-₹500" on a customer's
  // receipt for money they never got.
  return { providerRef: refund.id };
};

// --- webhooks ---------------------------------------------------------------

// Razorpay's event names on the left, this codebase's vocabulary on the right.
// Only these four change anything. Everything else — payment.authorized,
// order.paid, refund.created, refund.speed_changed — is passed through under
// its own name so apply.js records it, skips it with a readable reason, and
// the reconciliation report shows it to a human.
const EVENT_MAP = new Map([
  ['payment.captured', EVENT_SUCCEEDED],
  ['payment.failed', EVENT_FAILED],
  ['refund.processed', EVENT_REFUND_SUCCEEDED],
  ['refund.failed', EVENT_REFUND_FAILED],
]);

// Razorpay reports the instrument as lowercase 'card' | 'upi' | 'netbanking' |
// 'wallet' | 'emi'. Only the first two have a column here; the rest are OTHER
// rather than guessed at, because this feeds the sales report's breakdown.
const METHOD_MAP = new Map([['card', 'CARD'], ['upi', 'UPI']]);

const refusal = (reason) => ({ valid: false, reason });

const verifyWebhook = ({ rawBody, headers, secret, toleranceSeconds, nowMs }) => {
  const signature = headers?.[SIGNATURE_HEADER];
  if (typeof signature !== 'string' || !signature) return refusal('signature header missing');

  // Razorpay signs the raw bytes with the WEBHOOK secret — which is a
  // different secret from the API key secret, and configured separately in
  // their dashboard. There is no timestamp in the signed payload.
  if (!hexEqual(signature.trim(), hmacHex(secret, rawBody))) {
    return refusal('signature mismatch');
  }

  // Only now is the body trustworthy enough to parse.
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return refusal('signed body is not valid JSON');
  }

  // The event id is a HEADER, not a body field, so it is outside the signature.
  // That is safe here only because it is used as an idempotency key and never
  // as authority: a forged id cannot make an unsigned body apply, and gateway.js
  // refuses to store an id from a delivery that did not verify, so it cannot be
  // used to squat the unique index either.
  const eventId = headers?.[EVENT_ID_HEADER];
  if (typeof eventId !== 'string' || !eventId) return refusal('event id header missing');

  const name = body?.event;
  if (typeof name !== 'string' || !name) return refusal('event name missing');

  // Razorpay documents no replay window of its own, so this is ours, taken from
  // a field inside the signed bytes. See the header note: it narrows the window,
  // it does not close it — the eventId unique index does that.
  if (!withinTolerance(body?.created_at, toleranceSeconds, nowMs)) {
    return refusal('event timestamp missing or outside tolerance');
  }

  const kind = EVENT_MAP.get(name) ?? name;

  // Routed on the family, not on the two names we act upon. A refund.created
  // or refund.speed_changed carries a refund entity and no payment one, so
  // sending it down the payment branch would refuse a perfectly genuine,
  // correctly-signed delivery — and gateway.js answers a refusal with 400,
  // which makes Razorpay retry it forever and buries real signature failures
  // in the audit log.
  if (name.startsWith('refund.')) {
    const entity = body?.payload?.refund?.entity;
    const providerRef = entity?.id;
    if (typeof providerRef !== 'string' || !providerRef) return refusal('refund id missing');
    const amountPaise = paiseFrom(entity?.amount);
    if (amountPaise === null) return refusal('refund amount missing or not an integer count of paise');
    return {
      valid: true,
      eventId,
      kind,
      providerRef,
      amountPaise,
      currency: typeof entity?.currency === 'string' ? entity.currency : 'INR',
    };
  }

  const entity = body?.payload?.payment?.entity;
  if (!entity || typeof entity !== 'object') return refusal('payment entity missing');
  // order_id, not id: it is the attempt we opened and stored, and the only
  // reference that can be matched back to a PaymentIntent.
  const providerRef = entity.order_id;
  if (typeof providerRef !== 'string' || !providerRef) return refusal('payment order id missing');
  const amountPaise = paiseFrom(entity.amount);
  if (amountPaise === null) return refusal('payment amount missing or not an integer count of paise');

  return {
    valid: true,
    eventId,
    kind,
    providerRef,
    // The pay_… the money landed on, kept so the payment can later be refunded.
    chargeRef: typeof entity.id === 'string' && entity.id ? entity.id : null,
    amountPaise,
    currency: typeof entity.currency === 'string' ? entity.currency : 'INR',
    method: METHOD_MAP.get(entity.method) ?? 'OTHER',
  };
};

// --- browser handoff --------------------------------------------------------

// Razorpay Checkout hands the browser back three values, and this proves they
// came from Razorpay rather than from the page's own JavaScript. Note the
// secret: this one is signed with the API KEY secret, not the webhook secret.
//
// It is a convenience, never an authority. It says the customer's browser
// reached a real Razorpay success; it does not say the money settled, and
// nothing in this codebase records a payment from it. Only the signed webhook
// does that.
export const verifyCheckoutSignature = ({ orderId, paymentId, signature, secret }) => {
  if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') {
    return false;
  }
  return hexEqual(signature.trim(), hmacHex(secret, `${orderId}|${paymentId}`));
};

export const razorpayAdapter = {
  name: 'razorpay',
  createSession,
  createRefund,
  verifyWebhook,
};
