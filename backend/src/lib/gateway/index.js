// Payment provider registry (contract §13).
//
// NO LIVE PROVIDER IS ENABLED. A Razorpay adapter exists and is registered
// below, but online payment is not available on any deployment of this product
// today: POS_GATEWAY_PROVIDER is unset everywhere, so every call here refuses
// and the POS stays manual-only. Registering an adapter is not enabling it —
// that needs an account, credentials and a deliberate config change by the
// owner, and until then this module's job is to refuse cleanly rather than to
// pretend.
//
// ADAPTER CONTRACT. A provider is an object with a name and three methods:
//
//   createSession({ amountPaise, currency, orderId, idempotencyKey })
//     -> { providerRef, checkoutUrl }
//     Opens one attempt to collect amountPaise. Must pass idempotencyKey to
//     the provider so a retry returns the first attempt instead of opening a
//     second one the customer could also pay.
//
//   createRefund({ intentProviderRef, chargeProviderRef, amountPaise, currency,
//                  orderId, idempotencyKey })
//     -> { providerRef }
//     Asks the provider to return amountPaise from the payment that took it.
//     Two references, because providers do not agree on how many there are:
//     intentProviderRef names the ATTEMPT we opened, chargeProviderRef names
//     the money that actually landed. Razorpay needs the second (its refund
//     route is /payments/<pay_id>/refund); a provider that uses one id for
//     both may read either. The reference it returns names the REFUND, and it
//     is a request, not a result: only a later refund.succeeded webhook may
//     mark the money as actually paid out.
//
//   verifyWebhook({ rawBody, headers, secret, toleranceSeconds, nowMs })
//     -> { valid: true, eventId, kind, providerRef, amountPaise, currency,
//          chargeRef?, method? }
//      | { valid: false, reason }
//     chargeRef is the provider's id for the charge, stored on the Payment so
//     the money can later be sent back; omit it where the provider has no
//     such second id. kind that is not one of the four in apply.js is not an
//     error — it is passed through under the provider's own name, recorded,
//     skipped with a reason, and surfaced by reconciliation.
//     rawBody is the exact bytes received, as a string. On failure it returns
//     ONLY a reason: deliberately no eventId, because eventId comes from the
//     payload and handing one back for an unverified delivery is what would
//     let an attacker squat the idempotency key with a forged id and block
//     the genuine event for good. The caller cannot misuse what it is not given.
//
// Two methods are OPTIONAL. The first exists because not every provider has a
// browser step; the second because not every provider can be asked after the
// fact what it did.
//
//   fetchSettlement({ intentProviderRef })
//     -> { settled: true, providerRef, chargeRef, amountPaise, currency,
//          method, captured, receipt, posOrderId }
//      | { settled: false, reason }
//     Asks the provider what actually happened to one attempt. This is the
//     pull half of the webhook's push: a webhook that is merely LATE — tunnel
//     down, retries exhausted, endpoint misconfigured — leaves a customer who
//     has paid facing a POS that still shows the bill as due, and nothing in a
//     push-only design can ever close that gap.
//
//     It reports facts, never conclusions. `settled` means the provider says
//     the money was captured; it does NOT mean the POS may record a payment.
//     That decision belongs to the caller, which holds the records this has to
//     be checked against, and orders.js makes every one of those comparisons
//     explicitly rather than trusting a boolean computed in here.
//
//     `receipt` and `posOrderId` are the two values WE sent at createSession
//     and the provider stored verbatim. They are returned so the caller can
//     prove the thing it just fetched is its own: without them, a reconcile
//     is only as good as the assumption that the configured key pair still
//     points at the account the intent was opened on. They are the account
//     check, and they are checked against our own row, not against config.
//
//     `captured` is separate from `settled` on purpose. An AUTHORIZED payment
//     is money blocked on a card that the merchant has not received, and a
//     provider that reports one must not be able to close an order here.
//
//     Absent on adapters with no such query. A caller MUST treat its absence
//     as "reconciliation unavailable" and say so, rather than falling back to
//     anything that writes a payment on weaker evidence.
//
//   verifyCheckoutHandoff({ intentProviderRef, paymentId, signature })
//     -> boolean
//     Proves the three values the provider's in-browser checkout handed back
//     came from the provider and not from the page's own JavaScript. It is a
//     DISPLAY fact, never a settlement one: a true here means the customer
//     reached a real success screen, and nothing may record a payment from it.
//     It exists because the cashier acts on what the screen says — an
//     unverified "customer has paid" is how goods leave the counter unpaid.
//     Absent on adapters whose provider has no such handoff.
//
// Amounts are integer paise in both directions; the adapter converts to and
// from whatever the provider's wire format happens to be.

import { env, gatewayEnabled } from '../../config/env.js';
import { gatewayNotConfigured } from '../errors.js';
import { testAdapter } from './testAdapter.js';
import { razorpayAdapter } from './razorpay.js';

const adapters = new Map([
  [testAdapter.name, testAdapter],
  [razorpayAdapter.name, razorpayAdapter],
]);

// The test adapter settles payments on command, so it must be unreachable
// anywhere a real customer could be charged. env.js refuses it at boot under
// NODE_ENV=production; this is the second, independent gate, and it is a
// whitelist so an unset or unexpected NODE_ENV refuses rather than allows.
const isTestAdapter = (name) => name.startsWith('test');
const testAdaptersAllowed = () => env.NODE_ENV === 'test' || env.NODE_ENV === 'development';

export const getAdapter = () => {
  if (!gatewayEnabled) throw gatewayNotConfigured();
  const name = env.POS_GATEWAY_PROVIDER;
  if (isTestAdapter(name) && !testAdaptersAllowed()) throw gatewayNotConfigured();
  const adapter = adapters.get(name);
  if (!adapter) throw gatewayNotConfigured();
  return adapter;
};

// For callers that need to branch on availability without catching — the
// reconciliation report, for instance, stays readable on a deployment that
// has no gateway so the operator can see that plainly.
export const gatewayAvailable = () => {
  try {
    getAdapter();
    return true;
  } catch {
    return false;
  }
};
