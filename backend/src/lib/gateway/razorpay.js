// Razorpay adapter for the contract in index.js.
//
// Written against Razorpay's published API and exercised end to end against a
// stub of it (tests/razorpay.test.js). That stub proves the wire format, the
// signatures and the failure classification — and, on its own, proves nothing
// about a real Razorpay account: the same author wrote both sides of it.
//
// What HAS been asked of a real test account, and what has not:
//
//   verifyCredentials, getStatus, fetchSettlement — READ paths, verified
//   against the sandbox on 2026-09-25 by scripts/razorpay-sandbox-read-probe.mjs,
//   9/9, including a wrong secret rejected for the stated reason and an unpaid
//   order read as PENDING rather than as success. Read-only; no money moved.
//
//   createSession, createRefund, verifyWebhook — the WRITE paths. Verified
//   against a real account in the predecessor repository (see
//   docs/RAZORPAY-SANDBOX.md, 2026-09-22: a genuine payment.captured applied,
//   a genuine refund.processed settled). NOT re-run from this tree, and this
//   tree changed how credentials reach them — per-account rather than from the
//   environment. Treat the routing as covered by tests only until somebody
//   takes one sandbox payment through a tenant-configured account.
//
// Keys live outside this repository and must never enter it.
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
//
// The pages each wire-format decision was read off, so the next person can
// re-check them rather than re-derive them:
//
//   Create an Order            https://razorpay.com/docs/api/orders/create/
//   Payment capture settings   https://razorpay.com/docs/payment-gateway/rainy-day/capture-settings/api
//   Fetch All Orders           https://razorpay.com/docs/api/orders/fetch-all/
//   Create a Normal Refund     https://razorpay.com/docs/api/refunds/create-normal/
//   Refund idempotency         https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/
//   Refunds for a Payment      https://razorpay.com/docs/api/refunds/fetch-multiple-refund-payment/
//   Validate/Test Webhooks     https://razorpay.com/docs/webhooks/validate-test/
//   API Authentication         https://razorpay.com/docs/api/authentication/
//
// Two of those are worth stating outright because they are easy to get wrong.
// The refund idempotency key must be at least 10 characters of alphanumerics,
// hyphens and underscores, and `receipt` is capped at 40 — randomUUID() meets
// both, which is why the same value serves as key and receipt. And test and
// live share one hostname; the key pair alone decides which account is hit, so
// there is no sandbox base URL to point at.

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

// WHOSE Razorpay account this call is made against.
//
// Credentials arrive per call, from the caller, because on a multi-tenant
// deployment the merchant account belongs to the company whose order is being
// paid — not to the process. Reading them out of the environment in here is
// what made every tenant's card payment settle into one bank account.
//
// The environment pair stays as the fallback for callers that pass nothing,
// which is the single-account deployment this adapter was written for and every
// existing test. See lib/gateway/accounts.js: once a tenant configures a row,
// its calls always arrive with credentials and this fallback is unreachable
// for it.
const credentialsOf = (credentials) => ({
  keyId: credentials?.keyId ?? env.POS_GATEWAY_KEY_ID,
  keySecret: credentials?.keySecret ?? env.POS_GATEWAY_KEY_SECRET,
});

// Razorpay authenticates API calls with HTTP Basic, key id as the user and key
// secret as the password.
const authHeader = (credentials) => {
  const { keyId, keySecret } = credentialsOf(credentials);
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
};

// Every failure out of this module is one of these, and the distinction is the
// whole point: a caller may safely re-ask after a RETRYABLE one, because
// nothing was decided. A TERMINAL one is Razorpay saying no. An UNKNOWN one —
// timeout, socket reset — may already have moved money, so it is never
// reported as a refusal. orders.js turns anything non-terminal into an
// unconfirmed refund that keeps holding its amount.
//
// LOCAL and MISMATCH are failures on our side of the wire, and neither is a
// refusal. LOCAL means the request never left: a precondition we check
// ourselves, so the provider has no opinion about it. MISMATCH means Razorpay
// answered 200 and acted, but not as asked — which is the opposite of a
// refusal, because money may well have moved.
export class RazorpayError extends Error {
  constructor(message, { kind, status = null, code = null }) {
    super(message);
    this.name = 'RazorpayError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryable = kind === 'RETRYABLE' || kind === 'UNKNOWN';
    // Part of the adapter contract: it asserts that the provider received the
    // request, refused it, and moved no money, which is what lets orders.js
    // release the reserved amount and hand it back to be refunded again.
    //
    // So it is not derived from the label alone. It also requires the HTTP
    // client-error status that is the evidence for the claim, and only
    // request() — which has actually spoken to Razorpay — can supply one. A
    // throw raised locally carries status null and therefore cannot release
    // money however it is classified, which is the guarantee wanted here: a
    // bug in our own precondition must never read as a decision by Razorpay.
    this.providerRefused = kind === 'TERMINAL' && status >= 400 && status < 500;
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

const request = async (method, path, { body, headers = {}, credentials } = {}) => {
  let response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        authorization: authHeader(credentials),
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
// fails in a way that might still have created something is looked up here
// rather than posted again.
//
// MEASURED, and it changes what this is worth: the receipt query is a lagging
// index. An order fetched by id answers at once, but the same order does not
// appear under ?receipt= for a while — 7.7 s, 16.0 s, 30.0 s, 30.8 s and 32.8 s
// on five samples against the sandbox, with no ceiling established. Four of the
// five are over 15 s. This function runs
// immediately after the POST it is recovering from, so it will usually return
// null and createSession will rethrow the original error.
//
// That is why no retry loop was put here. Waiting the index out would hold a
// cashier at the till for an unbounded time, at the one moment the payment has
// already gone wrong. The failure is in the safe direction and stays there: the
// caller leaves the intent open with providerRef null, so nothing is recorded as
// settled, and the customer is never handed the unseen order's id — the frontend
// opens Checkout on the providerRef, which is still null — so the orphan cannot
// be paid. The cost is an unpaid order left at Razorpay, which wants a
// reconciliation sweep somewhere waiting is free, not this code path.
//
// Verified against the real API once the index has caught up, which is what
// makes the branch below worth keeping: with one order under the receipt it is
// adopted and no second is posted, and with two it raises rather than guessing.
// See scripts/razorpay-sandbox-write-probe.mjs.
const findOrderByReceipt = async (receipt, credentials) => {
  const page = await request('GET', `/v1/orders?receipt=${encodeURIComponent(receipt)}&count=2`, { credentials });
  const items = Array.isArray(page?.items) ? page.items : [];
  // Two orders under one receipt means the recovery itself is ambiguous, and
  // picking one would be a guess about which the customer can pay.
  return items.length === 1 ? items[0] : null;
};

const createSession = async ({ amountPaise, currency, orderId, idempotencyKey, credentials }) => {
  const payload = {
    amount: amountPaise,
    currency,
    receipt: idempotencyKey,
    // Automatic capture matters for correctness, not convenience: an
    // authorized-but-uncaptured payment is money the shop has not received,
    // and this POS only ever records captures.
    //
    // capture_options is OPTIONAL, and this block is sent anyway. An earlier
    // comment here claimed the API rejects `{ capture: 'automatic' }` without
    // it, reading "mandatory" from
    // https://razorpay.com/docs/payment-gateway/rainy-day/capture-settings/api .
    // Asked directly, the sandbox accepts every form: with the options, without
    // them, with either sub-field missing, and with no `payment` block at all —
    // all five return 200. The documentation describes the shape of the object
    // when you send it, not a condition for sending one.
    //
    // It is still sent, for a reason the docs do not cover: with no payment
    // block the order inherits whatever capture setting the Razorpay dashboard
    // currently has, and that is a checkbox someone can change without touching
    // this repository. Naming the behaviour here pins it to the code.
    //
    // What is NOT established by that 200: the Orders API does not echo these
    // settings back — an order created with them and one created bare read back
    // byte-identical — so acceptance is not evidence they are honoured. The only
    // proof of automatic capture is a real payment arriving as payment.captured
    // rather than payment.authorized. Until that has been seen, treat automatic
    // capture as intended-but-unconfirmed.
    payment: {
      capture: 'automatic',
      capture_options: {
        // Minutes an authorized payment may sit before it is auto-captured.
        // 12 is the documented minimum, and the right end of the range for a
        // counter: the customer is standing there, so the shop wants the money
        // taken now rather than held pending.
        automatic_expiry_period: 12,
        // The refund default for payments on this order. 'normal' matches the
        // speed createRefund asks for explicitly; 'optimum' would quietly bill
        // the shop for instant refunds it never chose.
        refund_speed: 'normal',
      },
    },
    notes: { pos_order_id: orderId },
  };

  let created;
  try {
    created = await request('POST', '/v1/orders', { body: payload, credentials });
  } catch (err) {
    // A refusal created nothing, so there is nothing to recover. The test is
    // providerRefused rather than the TERMINAL label because only the former
    // carries the answered-and-declined evidence: a 501 is classified terminal
    // too, and that one is a server fault which may well have created an order.
    // Anything short of a refusal may have created an order we never saw the id
    // of, and opening a second would show the customer two payable pages for
    // one bill.
    if (err instanceof RazorpayError && err.providerRefused) throw err;
    const recovered = await findOrderByReceipt(idempotencyKey, credentials).catch(() => null);
    if (!recovered?.id) throw err;
    created = recovered;
  }

  if (typeof created.id !== 'string' || !created.id) {
    throw new RazorpayError('Razorpay created an order without an id', { kind: 'UNKNOWN' });
  }
  // A charge for a different amount than we asked for is not our charge. An
  // order was nonetheless created, so this is a mismatch rather than a refusal.
  if (paiseFrom(created.amount) !== amountPaise) {
    throw new RazorpayError('Razorpay created an order for a different amount', { kind: 'MISMATCH' });
  }

  return {
    providerRef: created.id,
    // Razorpay has no hosted payment page to redirect to for this flow: the
    // browser opens Checkout with the order id and the publishable key id.
    // Null is the honest answer, and the frontend reads it as "use Checkout".
    checkoutUrl: null,
  };
};

// --- settlement lookup ------------------------------------------------------

// Razorpay reports the instrument as lowercase 'card' | 'upi' | 'netbanking' |
// 'wallet' | 'emi'. Only the first two have a column here; the rest are OTHER
// rather than guessed at, because this feeds the sales report's breakdown.
//
// Declared here, above both readers, because fetchSettlement and verifyWebhook
// each map it and two copies would drift.
const METHOD_MAP = new Map([['card', 'CARD'], ['upi', 'UPI']]);

// The most payments one fetch can return. An order with more attempts than
// this is not something this adapter can create — Razorpay closes an order on
// capture — but a truncated page would make "exactly one capture" unprovable,
// so it is detected rather than assumed away.
const PAYMENT_PAGE_MAX = 100;

// What does Razorpay say happened to this attempt?
//
// Two calls, because the two halves live on different entities and both are
// needed. The ORDER carries `receipt` and `notes.pos_order_id` — the values we
// sent when we opened it, which are what let the caller prove this record is
// ours. The PAYMENTS carry the capture, the charge id and the instrument.
//
// Nothing here decides anything. It returns what the account says and lets
// orders.js compare that against our own rows.
const fetchSettlement = async ({ intentProviderRef, credentials }) => {
  if (typeof intentProviderRef !== 'string' || !intentProviderRef.startsWith('order_')) {
    // LOCAL: Razorpay was never asked, so it has no opinion. An intent with no
    // order_… was never opened with the provider and there is nothing to find.
    throw new RazorpayError(
      'this payment attempt has no Razorpay order id recorded, so the provider cannot be asked about it',
      { kind: 'LOCAL' },
    );
  }

  const order = await request('GET', `/v1/orders/${encodeURIComponent(intentProviderRef)}`, { credentials });
  const page = await request(
    'GET',
    `/v1/orders/${encodeURIComponent(intentProviderRef)}/payments?count=${PAYMENT_PAGE_MAX}`,
    { credentials },
  );
  const items = Array.isArray(page?.items) ? page.items : null;
  if (!items) {
    throw new RazorpayError('Razorpay listed payments in a shape this adapter cannot read', {
      kind: 'UNKNOWN',
    });
  }

  // `captured` and `status` are checked together. Either alone has been seen to
  // disagree with the other in Razorpay's own docs' examples, and recording
  // money on the strength of one field that says yes while another says no is
  // the precise failure this whole module is built to avoid.
  const captures = items.filter((p) => p?.status === 'captured' && p?.captured === true);

  // Absence is only evidence when the list was complete.
  if (captures.length === 0 && items.length >= PAYMENT_PAGE_MAX) {
    throw new RazorpayError(
      'Razorpay returned a full page of payments with no capture on it, so whether one exists cannot be established',
      { kind: 'UNKNOWN' },
    );
  }
  if (captures.length === 0) {
    const tried = items.length;
    return {
      settled: false,
      reason: tried === 0
        ? 'the provider has no payment on this attempt'
        : `the provider has ${tried} payment attempt(s) on this order but none captured`,
    };
  }
  // Two captures on one order is a state this adapter cannot have created, and
  // choosing one would be a guess about which money is the order's.
  if (captures.length > 1) {
    throw new RazorpayError(
      'Razorpay reports more than one captured payment on this order; a human must decide which is correct',
      { kind: 'MISMATCH' },
    );
  }

  const payment = captures[0];
  const amountPaise = paiseFrom(payment.amount);
  if (amountPaise === null) {
    throw new RazorpayError('Razorpay reported a captured payment with an unreadable amount', {
      kind: 'UNKNOWN',
    });
  }

  return {
    settled: true,
    // The ATTEMPT, echoed from the payment rather than from our argument, so a
    // provider that answered about a different order is visible to the caller
    // instead of being papered over by the id we asked with.
    providerRef: typeof payment.order_id === 'string' ? payment.order_id : null,
    chargeRef: typeof payment.id === 'string' && payment.id ? payment.id : null,
    amountPaise,
    currency: typeof payment.currency === 'string' ? payment.currency : null,
    method: METHOD_MAP.get(payment.method) ?? 'OTHER',
    captured: true,
    // Ours, stored by Razorpay at create time. The caller's proof of ownership.
    receipt: typeof order?.receipt === 'string' ? order.receipt : null,
    posOrderId: typeof order?.notes?.pos_order_id === 'string' ? order.notes.pos_order_id : null,
  };
};

// --- refunds ----------------------------------------------------------------

// The most refunds one fetch can return (docs: default 10, maximum 100). It
// matters below: a full page may be a truncated page, and a key that is not on
// a truncated page has not been shown to be absent.
const REFUND_PAGE_MAX = 100;

// Did a refund under OUR key already happen?
//
// A 4xx on the refund POST says Razorpay would not accept THAT REQUEST. It does
// not say no refund exists. Razorpay rejects a replayed idempotency key whose
// payload differs, and a conflict means a concurrent attempt may have created
// one already — in both cases a refund can be on its way to the customer while
// the status code reads like a refusal. Releasing the reservation on the status
// alone is how the same money gets refunded twice.
//
// So the status is only the question. This is the answer: every refund on the
// charge carries notes.pos_refund_key, so the key we sent is findable. It
// reports three outcomes and never guesses between them.
//   FOUND     — a refund under this key exists; the provider acted.
//   ABSENT    — the whole list was read and this key is not in it.
//   AMBIGUOUS — could not be established. Not the same as ABSENT.
const findRefundByKey = async (chargeProviderRef, idempotencyKey, credentials) => {
  const page = await request(
    'GET',
    `/v1/payments/${encodeURIComponent(chargeProviderRef)}/refunds?count=${REFUND_PAGE_MAX}`,
    { credentials },
  );
  const items = Array.isArray(page?.items) ? page.items : null;
  if (!items) return { state: 'AMBIGUOUS', refund: null };

  const matches = items.filter((item) => item?.notes?.pos_refund_key === idempotencyKey);
  if (matches.length === 1) return { state: 'FOUND', refund: matches[0] };
  // Two refunds under one key is a state this adapter cannot have created, and
  // choosing one of them would be a guess about which money moved.
  if (matches.length > 1) return { state: 'AMBIGUOUS', refund: null };
  // Absence is only evidence when the list was complete. A full page might have
  // a second page behind it holding the very refund being looked for.
  if (items.length >= REFUND_PAGE_MAX) return { state: 'AMBIGUOUS', refund: null };
  return { state: 'ABSENT', refund: null };
};

// chargeProviderRef is the pay_… the money actually landed on. intentProviderRef
// — the order_… — cannot be refunded; Razorpay has no such route, and passing
// it would 400 on every gateway refund ever raised.
const createRefund = async ({ chargeProviderRef, amountPaise, currency, orderId, idempotencyKey, credentials }) => {
  // LOCAL, not TERMINAL. Razorpay is never asked, so it cannot have refused:
  // this is our own record missing the charge id, and the refund is very
  // possibly still payable once that is put right. Calling it a refusal would
  // release the held amount and write "the payment provider refused" against a
  // provider that was never contacted.
  if (typeof chargeProviderRef !== 'string' || !chargeProviderRef.startsWith('pay_')) {
    throw new RazorpayError(
      'this payment has no Razorpay payment id recorded, so it cannot be refunded through the API',
      { kind: 'LOCAL' },
    );
  }
  let refund;
  try {
    refund = await request('POST', `/v1/payments/${encodeURIComponent(chargeProviderRef)}/refund`, {
      credentials,
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
  } catch (err) {
    // Only a client error is worth a second look. A 5xx or a request that was
    // never answered already holds the money — there is nothing to improve and
    // an extra call would only add a way to fail.
    const status = err instanceof RazorpayError ? err.status : null;
    if (status === null || status < 400 || status >= 500) throw err;

    // This is the rule the whole file turns on: a 4xx is a claim about the
    // request, and the reservation is only released once that claim is checked
    // against the refunds that actually exist on the charge.
    let outcome;
    try {
      outcome = await findRefundByKey(chargeProviderRef, idempotencyKey, credentials);
    } catch {
      // The lookup failed, so the question stands unanswered.
      outcome = { state: 'AMBIGUOUS', refund: null };
    }

    if (outcome.state === 'ABSENT') {
      // 4xx AND no refund on the charge under our key. Now the refusal is
      // evidenced, and only now may the held amount go back on sale.
      throw err;
    }
    if (outcome.state !== 'FOUND') {
      // UNKNOWN carries no status, so providerRefused is false and the
      // reservation stands. The operator is told which two facts conflict
      // rather than being shown a refusal the provider may not have made.
      throw new RazorpayError(
        `Razorpay answered ${status} but a refund under this key may already exist, so the money stays held: ${err.message}`,
        { kind: 'UNKNOWN', code: err.code },
      );
    }
    // FOUND: the earlier request did go through. Fall through to the same
    // amount and currency checks a fresh refund gets — a recovered refund is
    // not trusted any further than a created one.
    refund = outcome.refund;
  }

  if (typeof refund.id !== 'string' || !refund.id) {
    throw new RazorpayError('Razorpay accepted the refund without returning a reference', { kind: 'UNKNOWN' });
  }
  // MISMATCH, emphatically not a refusal. Razorpay answered 200 with a refund
  // entity, so a refund exists and an amount is on its way to the customer —
  // just not the one asked for. Releasing the reservation here would free that
  // money to be refunded a second time on top of a payout already in flight.
  // It holds, and a human is told exactly what does not line up.
  if (paiseFrom(refund.amount) !== amountPaise) {
    throw new RazorpayError('Razorpay refunded a different amount than was requested', { kind: 'MISMATCH' });
  }
  if (currency && typeof refund.currency === 'string' && refund.currency !== currency) {
    throw new RazorpayError('Razorpay refunded in a different currency', { kind: 'MISMATCH' });
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

// The adapter's own wrapper, so the route never has to know which of the two
// secrets signs a handoff. intentProviderRef is the order_… we opened, and the
// secret is the one belonging to the account that opened it — a handoff from a
// tenant's own account does not verify against the deployment's shared key.
const verifyCheckoutHandoff = ({ intentProviderRef, paymentId, signature, credentials }) =>
  verifyCheckoutSignature({
    orderId: intentProviderRef,
    paymentId,
    signature,
    secret: credentialsOf(credentials).keySecret,
  });

// --- status enquiry ---------------------------------------------------------

// Where has this attempt got to?
//
// Distinct from fetchSettlement, which answers the narrower and more dangerous
// question "may money be recorded". This one answers "what should the cashier's
// screen say", and it is allowed to say PENDING — the state fetchSettlement
// deliberately collapses into `settled: false`, because a caller that may write
// a payment must not be able to read "not yet" as "no".
//
// Built on the two GETs Razorpay documents for an order, and on nothing else:
//   Fetch an Order            https://razorpay.com/docs/api/orders/fetch-with-id/
//   Fetch Payments for Order  https://razorpay.com/docs/api/orders/fetch-payments/
//
// Razorpay's order status is 'created' | 'attempted' | 'paid'. 'attempted'
// means somebody tried and it did not go through — an interesting fact for the
// screen, and NOT a failure of the attempt: the same order stays payable.
const ORDER_STATUS = new Map([
  ['created', 'PENDING'],
  ['attempted', 'PENDING'],
  ['paid', 'SUCCEEDED'],
]);

const getStatus = async ({ intentProviderRef, credentials }) => {
  if (typeof intentProviderRef !== 'string' || !intentProviderRef.startsWith('order_')) {
    throw new RazorpayError(
      'this payment attempt has no Razorpay order id recorded, so the provider cannot be asked about it',
      { kind: 'LOCAL' },
    );
  }
  const order = await request('GET', `/v1/orders/${encodeURIComponent(intentProviderRef)}`, { credentials });
  const status = ORDER_STATUS.get(order?.status) ?? null;
  if (status === null) {
    // An unrecognised status is UNCERTAIN, never a guess. A new Razorpay order
    // state read as PENDING would leave a paid bill open; read as SUCCEEDED it
    // would close an unpaid one.
    return { status: 'UNCERTAIN', detail: `Razorpay reports an order status this adapter does not know: ${order?.status}` };
  }
  if (status !== 'SUCCEEDED') {
    return { status, detail: order?.status === 'attempted' ? 'the customer has tried and not completed payment' : null };
  }

  // 'paid' is the provider's word for the ORDER. The charge behind it is what
  // carries the amount and the capture, so it is read rather than assumed —
  // the same two-field rule fetchSettlement applies.
  const page = await request(
    'GET',
    `/v1/orders/${encodeURIComponent(intentProviderRef)}/payments?count=${PAYMENT_PAGE_MAX}`,
    { credentials },
  );
  const items = Array.isArray(page?.items) ? page.items : [];
  const captures = items.filter((p) => p?.status === 'captured' && p?.captured === true);
  if (captures.length !== 1) {
    return {
      status: 'UNCERTAIN',
      detail: 'Razorpay reports the order paid but not exactly one captured payment on it',
    };
  }
  return {
    status: 'SUCCEEDED',
    chargeRef: typeof captures[0].id === 'string' ? captures[0].id : null,
    amountPaise: paiseFrom(captures[0].amount),
    currency: typeof captures[0].currency === 'string' ? captures[0].currency : null,
    method: METHOD_MAP.get(captures[0].method) ?? 'OTHER',
    detail: null,
  };
};

// --- credential check -------------------------------------------------------

// Do these keys authenticate against Razorpay?
//
// The cheapest authenticated READ Razorpay documents: list one order. It takes
// no money, creates nothing, and needs no order to exist — an account with
// none answers 200 with an empty list, which is a pass. What it proves is the
// only thing worth proving before a customer is standing at the counter: the
// key pair is real and belongs to an account this deployment can reach.
//
//   Fetch All Orders   https://razorpay.com/docs/api/orders/fetch-all/
//
// A 401 is a clear no. Anything else — a timeout, a 500 — is NOT a no: it is
// an unanswered question, and saying "these credentials are wrong" because
// Razorpay was briefly unreachable sends an operator to re-enter a key that
// was correct all along.
const verifyCredentials = async ({ credentials }) => {
  try {
    await request('GET', '/v1/orders?count=1', { credentials });
    return { ok: true, detail: 'Razorpay accepted these credentials' };
  } catch (err) {
    const status = err instanceof RazorpayError ? err.status : null;
    if (status === 401 || status === 403) {
      return { ok: false, detail: 'Razorpay rejected these credentials' };
    }
    return {
      ok: false,
      detail: `Razorpay could not be asked, so these credentials are unchecked: ${err?.message ?? 'no answer'}`,
    };
  }
};

// WHAT THIS ADAPTER CAN AND CANNOT DO. Declared rather than inferred, because
// the difference between "the method is missing" and "the method is missing
// today" is the difference between a capability matrix a buyer can rely on and
// one that has to be re-derived by reading the source.
//
// cancel is false for a reason worth stating: Razorpay publishes NO endpoint
// that cancels or voids an order. Their Orders API has create, fetch, fetch-all,
// fetch-payments and update-notes, and nothing else. An order stays payable
// until it expires on Razorpay's side, so there is nothing truthful to call
// here and nothing has been invented to fill the gap.
//
// cardPresent and contactless are false for a larger reason. This is an ONLINE
// CHECKOUT integration. It collects money through a browser or a payment link,
// and it does not drive a card terminal, read a chip, or accept a tap — those
// need a terminal connector and a device (see lib/terminal/), which is a
// different integration with different hardware and a different certification.
// Nothing about having Razorpay working gets a shop card-present acceptance.
const capabilities = {
  createSession: true,
  getStatus: true,
  cancel: false,
  createRefund: true,
  partialRefund: true,
  fetchSettlement: true,
  verifyWebhook: true,
  checkoutHandoff: true,
  perAccountCredentials: true,
  verifyCredentials: true,
  cardPresent: false,
  contactless: false,
};

export const razorpayAdapter = {
  name: 'razorpay',
  capabilities,
  createSession,
  getStatus,
  createRefund,
  fetchSettlement,
  verifyWebhook,
  verifyCheckoutHandoff,
  verifyCredentials,
};
