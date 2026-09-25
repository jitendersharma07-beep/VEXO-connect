// Card-terminal connector registry (contract §4).
//
// NO TERMINAL CONNECTOR IS ENABLED, AND NONE CAN BE. POS_TERMINAL_PROVIDER is
// unset on every deployment, and the only connector here that can actually run
// is a simulator refused outside test and development. The vendor entries are
// registered UNAVAILABLE and each says exactly what it is waiting for — see
// `dependency` below. Registering a connector is not implementing one.
//
// THIS IS NOT THE GATEWAY. lib/gateway/ collects money through a browser: a
// hosted page or a payment link the customer opens. Nothing in it reads a chip,
// a magnetic stripe or an NFC tap, and no amount of gateway configuration ever
// produces card-present acceptance — which is why razorpay.js declares
// cardPresent and contactless false. A card terminal is a separate physical
// device with its own vendor SDK, and that is what this directory is for. The
// two are kept apart in code because they are kept apart in reality, and a POS
// that blurs them tells a cashier to tap a card against a web page.
//
// WHAT IS SHARED. Everything after the money moves: PaymentIntent records the
// attempt, applyGatewayEvent applies the outcome, Payment carries the result
// with channel=TERMINAL and entrySource=TERMINAL_CONFIRMED, and the same
// refund, reconciliation and day-close code reads it. There is ONE payment
// ledger, not two. A terminal attempt differs from a checkout attempt in
// PaymentIntent.flow and in which adapter it talks to; nothing downstream
// forks.
//
// CONNECTOR CONTRACT. A connector is an object with a name, a capability
// declaration, and three required methods.
//
//   capabilities
//     -> { startPayment, getStatus, cancel, createRefund, cardPresent,
//          contactless, printsCardSlip, perAccountCredentials }
//     All booleans, all required, none inferred — the same rule the gateway
//     contract states, for the same reason: a missing method cannot explain
//     itself, and an operator reading a readiness matrix needs the reason
//     rather than the gap.
//
//     cardPresent and contactless are the two flags the whole directory exists
//     for. A connector that declares contactless true is asserting that the
//     device it drives accepts a tap; declaring it on a connector that cannot
//     is how a shop ends up telling customers to tap against a reader that
//     will only take a dip.
//
//     printsCardSlip says the DEVICE prints its own cardholder copy. Where it
//     is false the POS receipt is the only paper the customer gets, and the
//     receipt template has to carry the card detail instead.
//
//   startPayment({ amountPaise, currency, orderId, readerRef, idempotencyKey,
//                  credentials })
//     -> { providerRef, detail? }
//     Puts ONE amount on ONE reader and returns the vendor's reference for the
//     attempt. It does NOT wait for the customer: a card-present transaction
//     takes as long as a person takes to find their card, and a connector that
//     blocks until the tap has to hold an HTTP request open across it. The
//     answer arrives through getStatus.
//
//     readerRef names WHICH physical device — Device.readerRef, resolved
//     server-side from the till's own store. It is required even where a
//     deployment has one reader, because the day it has two, an attempt that
//     cannot say which device is holding the customer's card is unanswerable.
//
//     idempotencyKey must reach the vendor, so a retried start returns the
//     attempt already on the reader instead of putting a second amount on it.
//     Where a vendor has no idempotency of its own the connector must say so in
//     a comment here, because then a retry genuinely can double-charge and the
//     route's own reservation is the only thing preventing it.
//
//   getStatus({ providerRef, readerRef, credentials })
//     -> { status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNCERTAIN',
//          chargeRef?, amountPaise?, currency?, method?, entryMode?,
//          failureCode?, detail? }
//     Where has this attempt got to? This is the only question whose answer may
//     settle a terminal payment, and the answer is the DEVICE's, not the
//     cashier's and not the clock's.
//
//     PENDING is the normal state and means the customer has not finished. A
//     status this connector does not recognise, an unreachable device, a
//     timeout: all UNCERTAIN, never a guess. Guessing PENDING leaves a paid
//     bill open; guessing FAILED lets the cashier take the money a second time
//     for a card that was already charged. UNCERTAIN is the only honest answer
//     and the caller must surface it as such rather than resolving it.
//
//     entryMode is how the card was read — CHIP, CONTACTLESS, SWIPE, OTHER.
//     Recorded because "was this a tap?" is a question a chargeback asks.
//
//     NOTHING here may record a payment. A status enquiry is a read.
//
//   cancel({ providerRef, readerRef, credentials })
//     -> { cancelled: true }
//     Takes the amount OFF the reader, so the customer's card cannot be
//     presented against it any more. Declare it false unless the vendor
//     publishes a call that does this on the device; a "cancel" that only
//     closes our own row while the reader still shows the amount is a lie the
//     next customer can disprove by tapping.
//
// Two methods are OPTIONAL.
//
//   createRefund({ chargeProviderRef, amountPaise, currency, orderId,
//                  readerRef, idempotencyKey, credentials })
//     -> { providerRef }
//     Card-present refunds are a genuinely different act from a gateway
//     refund — many vendors require the card back at the reader, and some
//     require a supervisor card. EVERY connector here declares it false,
//     including the simulator: refunding money the POS cannot actually move is
//     the fake success this codebase refuses. A terminal payment is therefore
//     returned the way the cash and card legs already are — the cashier
//     reverses it on the device and records it, which is what the refund route
//     means by a MANUAL refund with method CARD.
//
//   verifyCredentials({ credentials })
//     -> { ok: boolean, detail: string }
//     Do these keys authenticate? Must be a READ that takes no money. ok:false
//     means the vendor said no — NOT that the vendor could not be reached,
//     which is an unanswered question and must be reported as such in `detail`.
//
// CREDENTIALS. Passed per call, exactly as the gateway contract requires, so a
// connector never reads a process-global credential and never settles one
// tenant's takings into another's account. No connector needs them today:
// perAccountCredentials is false everywhere, and the routes therefore pass
// null. When a vendor connector arrives that does need them, it resolves
// through the SAME PaymentProviderAccount rows keyed on the connector's name —
// lib/gateway/accounts.js is provider-agnostic and needs no change for it.
//
// Amounts are integer paise in both directions.

import { env } from '../../config/env.js';
import { terminalNotConfigured, terminalConnectorUnavailable } from '../errors.js';
import { simulatorConnector } from './simulator.js';

// A connector that is known, named and NOT implemented.
//
// It exists so a deployment can be told the truth in one place: this vendor is
// recognised, here is exactly what has to be obtained before it works, and
// until then every call refuses rather than pretending. The alternative — an
// adapter written against a vendor's API from memory — is how a POS ships code
// that posts to endpoints that do not exist, and discovers it at a counter.
//
// `dependency` is a sentence an operator can act on, not a status word. It is
// the text the readiness document and the API both print.
const unavailableConnector = ({ name, vendor, dependency }) => {
  const refuse = () => {
    throw terminalConnectorUnavailable(vendor, dependency);
  };
  return {
    name,
    vendor,
    available: false,
    dependency,
    // Every one false. This is not modesty: until the SDK is in hand, what the
    // device can do is unverified, and an unverified capability is a promise
    // made to a cashier on a customer's behalf.
    capabilities: {
      startPayment: false,
      getStatus: false,
      cancel: false,
      createRefund: false,
      cardPresent: false,
      contactless: false,
      printsCardSlip: false,
      perAccountCredentials: false,
    },
    startPayment: refuse,
    getStatus: refuse,
    cancel: refuse,
  };
};

// The vendors this product is most likely to meet in an Indian restaurant, each
// registered so the gap is visible in the API and the readiness matrix rather
// than being discovered when somebody plugs a device in.
//
// Nothing about their protocols is asserted here, because nothing about their
// protocols is known to this codebase. Each needs the vendor's own integration
// pack and a device to test against, and no substitute for either exists.
const VENDOR_CONNECTORS = [
  {
    name: 'pinelabs',
    vendor: 'Pine Labs',
    dependency:
      'its integration documentation, merchant credentials and a test device have not been supplied',
  },
  {
    name: 'ezetap',
    vendor: 'Ezetap',
    dependency:
      'its integration documentation, merchant credentials and a test device have not been supplied',
  },
  {
    name: 'mswipe',
    vendor: 'Mswipe',
    dependency:
      'its integration documentation, merchant credentials and a test device have not been supplied',
  },
  {
    // SoftPOS — tap-to-phone — is in the brief as an alternative to a physical
    // reader. It is listed separately because its dependency is different in
    // kind: the acceptance app runs ON the phone and is certified per device
    // model, so there is no server-side connector to write until a certified
    // SDK is licensed.
    name: 'softpos',
    vendor: 'SoftPOS (tap to phone)',
    dependency:
      'a certified tap-to-phone SDK and its per-device-model certification have not been licensed',
  },
];

const connectors = new Map([
  [simulatorConnector.name, simulatorConnector],
  ...VENDOR_CONNECTORS.map((v) => [v.name, unavailableConnector(v)]),
]);

// The simulator approves payments on command, so it must be unreachable
// anywhere a real card could be presented. config/env.js refuses it at boot
// under NODE_ENV=production; this is the second, independent gate, and it is a
// whitelist so an unset or unexpected NODE_ENV refuses rather than allows.
// Exactly the arrangement lib/gateway/index.js uses for its test adapter.
const isSimulator = (name) => name.startsWith('sim');
const simulatorsAllowed = () => env.NODE_ENV === 'test' || env.NODE_ENV === 'development';

export const getConnector = () => {
  const name = env.POS_TERMINAL_PROVIDER;
  if (!name) throw terminalNotConfigured();
  if (isSimulator(name) && !simulatorsAllowed()) throw terminalNotConfigured();
  const connector = connectors.get(name);
  if (!connector) throw terminalNotConfigured();
  // Registered but not implemented. Refusing HERE rather than at the first call
  // means a till asking "can I take a card?" gets the dependency in the answer,
  // instead of a working-looking button that fails with a customer waiting.
  if (connector.available === false) {
    throw terminalConnectorUnavailable(connector.vendor, connector.dependency);
  }
  return connector;
};

export const terminalAvailable = () => {
  try {
    getConnector();
    return true;
  } catch {
    return false;
  }
};

// Every connector and its state, for the readiness endpoint and the operator
// screen. Deliberately includes the ones that cannot run: "we have not got
// Pine Labs" is the single most useful thing this list can tell somebody
// choosing a terminal vendor, and hiding it would leave the screen implying
// the only option is the one that happens to be registered.
export const connectorCatalogue = () =>
  [...connectors.values()]
    .filter((c) => !(isSimulator(c.name) && !simulatorsAllowed()))
    .map((c) => ({
      name: c.name,
      vendor: c.vendor ?? c.name,
      available: c.available !== false,
      dependency: c.dependency ?? null,
      capabilities: c.capabilities,
      configured: c.name === env.POS_TERMINAL_PROVIDER,
    }));
