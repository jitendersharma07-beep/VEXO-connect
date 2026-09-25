// How an inventory notification actually reaches a person.
//
// NO EXTERNAL TRANSPORT IS IMPLEMENTED. There is no email adapter and no
// WhatsApp adapter in this codebase. This lane's own evidence document claimed
// for a while that they existed and had merely not been exercised; that was
// wrong, and the correction is recorded in INVENTORY.md §10. What exists is
// the seam such an adapter plugs into, an in-app transport that is genuinely
// complete, and a test transport that drives the seam without sending
// anything.
//
// Naming a transport with no adapter behind it is not an error and does not
// throw. It writes the notification FAILED with the reason, because the rule
// this module exists to keep is that a message which did not arrive must leave
// a record saying so. Silence is the one outcome that is never allowed.
//
// WHY THIS IS STRICTER THAN THE PAYMENT GATEWAY. A payment that quietly does
// nothing fails loudly, because the customer is standing at the counter. A
// notification that quietly does nothing is indistinguishable from one that
// was delivered and ignored — nobody is waiting at a counter for an expiry
// warning. So a transport that cannot really send must never report that it
// did, and the check for that runs at boot AND on every lookup.
//
// TRANSPORT CONTRACT. A transport is an object with a name and one method:
//
//   async send({ notificationId, companyId, recipientId, channel, title,
//                body, attempt })
//     -> { delivered: true, providerRef?: string }
//      | { delivered: false, reason: string, permanent?: boolean }
//
//     `providerRef` is the provider's own id for the message. It is stored so
//     that "we delivered it" can later be checked against the provider rather
//     than merely asserted from our own row — the same reason a payment keeps
//     its charge reference. Omit it where the transport has no such id; in-app
//     does not, because the row IS the message.
//
//     `reason` is written to lastError and shown in the portal, so it is
//     addressed to the person who has to do something about it, not to
//     whoever greps the logs.
//
//     `permanent: true` means a retry cannot help: an address that does not
//     exist, a recipient who has opted out, a number that is not on WhatsApp.
//     The row goes UNDELIVERABLE and the scheduler stops, instead of spending
//     the whole attempt budget rediscovering the same answer and leaving a
//     portal that says "still trying" about something that will never arrive.
//     Omit it and the failure is treated as transient and retried.
//
//     `attempt` is 1 on the first try. A transport that carries an
//     idempotency key to its provider should derive it from notificationId,
//     NOT from attempt, or a retry sends a second message.
//
//     A transport MUST NOT throw. Callers are on paths that have already moved
//     stock, or are mid-tick over other companies' rows, and neither may be
//     undone by a mail server refusing a connection. deliver() below contains
//     a throw anyway, because "must not" is a contract and contracts get
//     broken by the adapter written six months from now.

// config/env.js is imported for its boot-time refusal of a test transport in
// production, not for a value. Its copy of INVENTORY_NOTIFY_TRANSPORT is
// captured at import and so cannot be read here: this module resolves the
// transport per call, so that a deployment which changes it, and a test which
// exercises more than one, both get the transport that is configured now
// rather than the one that was configured when the process started.
import '../../config/env.js';
import { logger } from '../logger.js';
import { testNotifyTransport } from './notifyTestTransport.js';

const inappTransport = {
  name: 'inapp',
  async send() {
    // The row IS the delivery. The portal reads InventoryNotification
    // directly, so there is no third party to hand anything to and nothing
    // that can fail once the row is committed. Reporting success here is not
    // the fake success this module refuses elsewhere — it is the accurate
    // description of a transport whose storage and whose delivery are the
    // same act.
    //
    // No providerRef: there is no provider. A null here is a fact, not a gap.
    return { delivered: true };
  },
};

const transports = new Map([
  [inappTransport.name, inappTransport],
  [testNotifyTransport.name, testNotifyTransport],
]);

export const configuredTransportName = () =>
  (process.env.INVENTORY_NOTIFY_TRANSPORT || 'inapp').trim().toLowerCase();

// The test transport reports delivery on command, so production must never be
// able to reach it. Whitelisted on the safe environments so an unset or
// misspelt NODE_ENV refuses rather than allows.
//
// Read from process.env at call time, with NO fallback to env.NODE_ENV, and
// both halves of that are deliberate.
//
// Call time, because config/env.js captures the value at import: the rate
// limiter in this codebase caches NODE_ENV the same way and it has already
// cost one debugging session. For a gate whose failure mode is "nobody was
// ever told", a stale copy of the deciding value is not a trade worth making.
//
// No fallback, because env.NODE_ENV substitutes 'development' when the
// variable is unset — so falling back would turn "we do not know what
// environment this is" into "it is a safe one", which is the exact inversion
// this whitelist exists to prevent. Undefined matches neither arm and refuses.
const isTestTransport = (name) => name.startsWith('test');
const testTransportsAllowed = () => {
  const mode = process.env.NODE_ENV;
  return mode === 'test' || mode === 'development';
};

// Returns the transport, or null with the reason it is not available.
//
// Deliberately does not throw. Every caller is already committed to something
// — a dispatch that moved stock, a scheduler tick part-way through a list —
// and a transport that is missing is a fact to record on the notification, not
// an exception to unwind a transaction with.
export const resolveTransport = (name = configuredTransportName()) => {
  if (isTestTransport(name) && !testTransportsAllowed()) {
    return { transport: null, reason: `Transport "${name}" is not available outside test and development` };
  }
  const transport = transports.get(name);
  if (!transport) {
    return { transport: null, reason: `No adapter configured for transport "${name}"` };
  }
  return { transport, reason: null };
};

const CHANNEL_OF = { inapp: 'INAPP', test: 'TEST' };
export const channelFor = (name = configuredTransportName()) => CHANNEL_OF[name] ?? name.toUpperCase();

// Run one delivery attempt and translate the answer into the columns that
// describe it. Both the request path and the scheduler's retry come through
// here, because the previous arrangement had this decision written out twice
// and the copies had already drifted: one marked in-app DELIVERED at creation,
// the other re-stamped lastError on every pass whether or not anything had
// changed.
export const attemptDelivery = async ({ notificationId, companyId, recipientId, channel, title, body, attempt }) => {
  const name = configuredTransportName();
  const { transport, reason } = resolveTransport(name);
  if (!transport) {
    // Not retryable in any useful sense — the deployment's configuration will
    // not change between now and the next tick — but it is also not the
    // recipient's address being wrong, and marking it UNDELIVERABLE would
    // claim we established something about them. It stays FAILED, which is
    // "this did not arrive and here is why", and a deployment that later
    // names a real transport picks the row back up.
    return { state: 'FAILED', lastError: reason, providerRef: null, deliveredAt: null };
  }

  let result;
  try {
    result = await transport.send({ notificationId, companyId, recipientId, channel, title, body, attempt });
  } catch (err) {
    // The contract says a transport must not throw. This is what happens when
    // one does anyway: the failure is recorded against the notification and
    // treated as transient, rather than escaping into a caller that has
    // already moved stock.
    logger.error({ err, transport: name, notificationId }, 'inventory: notification transport threw');
    return {
      state: 'FAILED',
      lastError: `Transport "${name}" failed: ${err?.message ?? 'unknown error'}`,
      providerRef: null,
      deliveredAt: null,
    };
  }

  if (result?.delivered) {
    return { state: 'DELIVERED', lastError: null, providerRef: result.providerRef ?? null, deliveredAt: new Date() };
  }

  return {
    state: result?.permanent ? 'UNDELIVERABLE' : 'FAILED',
    lastError: result?.reason ?? `Transport "${name}" reported no delivery and gave no reason`,
    providerRef: null,
    deliveredAt: null,
  };
};
