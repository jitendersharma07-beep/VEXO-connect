// A controllable stand-in for a card reader, implementing the connector
// contract in index.js.
//
// IT IS NOT A PINE LABS OR EZETAP INTEGRATION and must never be described as
// one. It speaks no vendor's protocol, reaches no device and reads no card. It
// exists so the parts that DO have to be right without hardware — the attempt
// lifecycle, idempotency, the five outcomes, recovery after a cut connection,
// and the rule that only the device's own answer may settle a payment — can be
// driven end to end and asserted on.
//
// It approves payments on command, which is exactly what "no fake success"
// forbids in front of a real customer, so it is refused outside test and
// development twice over: by config/env.js at boot and by the registry.

import { createHash } from 'node:crypto';

// What the imaginary reader will say when asked about an attempt.
//
// Keyed by the providerRef startPayment handed back. Unprimed means PENDING —
// a reader with an amount on it and nobody's card against it yet, which is the
// state a real one spends most of its time in and the safe one to default to.
//
// A value may be a function, called on each enquiry. That is not a
// convenience: an attempt that changes state BETWEEN two polls is the whole
// point of several tests, and a static map cannot express it.
const outcomes = new Map();

// Attempts the reader has been told to stop answering for — an unplugged
// device, a dead battery, a cable pulled mid-transaction. Distinct from a
// primed UNCERTAIN because it models the failure at the transport rather than
// in the answer: the connector throws instead of returning, and the route has
// to treat a thrown enquiry exactly as carefully as a returned UNCERTAIN.
const unreachable = new Set();

// Readers that refuse to accept a new amount at all. Models a device that is
// offline when the cashier presses Charge, which must leave no half-open
// attempt behind.
const deadReaders = new Set();

export const setSimOutcome = (providerRef, answer) => {
  outcomes.set(providerRef, answer);
};

export const setSimUnreachable = (providerRef) => {
  unreachable.add(providerRef);
};

export const setSimReaderDead = (readerRef) => {
  deadReaders.add(readerRef);
};

export const clearSimTerminal = () => {
  outcomes.clear();
  unreachable.clear();
  deadReaders.clear();
};

// Derived from the idempotency key, so a retried start yields the SAME
// reference — which is what a vendor's own idempotency would do, and what lets
// a test assert that a retry did not put a second amount on the reader.
export const simProviderRef = (idempotencyKey) =>
  `sim_${createHash('sha256').update(`vexo-connect/sim-terminal ${idempotencyKey}`).digest('hex').slice(0, 24)}`;

const ANSWERED = new Set(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNCERTAIN']);

export const simulatorConnector = {
  name: 'sim',
  vendor: 'Simulated card reader (test and development only)',
  available: true,
  dependency: null,

  capabilities: {
    startPayment: true,
    getStatus: true,
    // A real reader can be told to drop the amount it is displaying, and this
    // one models that faithfully — it is one of the behaviours the routes have
    // to get right before a vendor connector exists to exercise them.
    cancel: true,
    // False, and NOT because this file could not fake one. See the contract
    // header: no connector here refunds, because the POS cannot actually move
    // that money, and a simulator-only refund path would be plumbing no real
    // connector can yet satisfy.
    createRefund: false,
    // The two flags this whole directory exists for. True here means "the
    // simulated device models a dip and a tap", which is what makes the
    // card-present code path testable at all. It says nothing whatever about
    // any real deployment: getConnector refuses this connector outside test
    // and development, so no customer can ever meet it.
    cardPresent: true,
    contactless: true,
    // Nothing prints. The POS receipt is the only paper in a simulated sale.
    printsCardSlip: false,
    // Authenticates against nothing, so there is nothing to scope.
    perAccountCredentials: false,
  },

  async startPayment({ readerRef, idempotencyKey }) {
    if (deadReaders.has(readerRef)) {
      const err = new Error('the card reader did not answer');
      // No providerRefused flag: an unanswered start is UNKNOWN, and the route
      // has to keep the attempt open and resume it under the same key rather
      // than opening a second one.
      throw err;
    }
    return { providerRef: simProviderRef(idempotencyKey) };
  },

  async getStatus({ providerRef }) {
    if (unreachable.has(providerRef)) {
      throw new Error('the card reader could not be reached');
    }
    const primed = outcomes.get(providerRef);
    const answer = typeof primed === 'function' ? primed() : primed;
    if (answer === undefined) {
      return { status: 'PENDING', detail: 'the amount is on the reader and no card has been presented' };
    }
    // A primed answer this connector does not recognise is UNCERTAIN, not a
    // guess — the same rule a real connector must follow for a vendor status
    // code it has never seen.
    if (!ANSWERED.has(answer?.status)) {
      return { status: 'UNCERTAIN', detail: `the reader reported "${answer?.status}"` };
    }
    return answer;
  },

  async cancel({ providerRef }) {
    if (unreachable.has(providerRef)) {
      throw new Error('the card reader could not be reached');
    }
    outcomes.set(providerRef, { status: 'CANCELLED', detail: 'the amount was taken off the reader' });
    return { cancelled: true };
  },
};
