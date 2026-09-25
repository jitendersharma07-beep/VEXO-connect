// Adapter registry (LANE providers).
//
// Mirrors lib/gateway/index.js deliberately: one lookup, a hard production gate
// on the test doubles, and the rule that registering an adapter is not enabling
// it. What enables an integration is an IntegrationConnection row with a sealed
// credential, and what makes it CONNECTED is a call that came back.

import { env } from '../../../config/env.js';
import swiggy from './swiggy.js';
import zomato from './zomato.js';
import reelo from './reelo.js';
import tally from './tally.js';
import { TEST_ADAPTERS } from './testAdapters.js';

const REAL = Object.freeze({
  SWIGGY: swiggy,
  ZOMATO: zomato,
  REELO: reelo,
  TALLY: tally,
});

// The test doubles settle vouchers and move points on command. Production must
// not be able to reach one by any path, including a typo in a database column —
// so the gate is here, at lookup, and not only in config validation.
export const adapterFor = (provider) => {
  if (REAL[provider]) return REAL[provider];
  if (TEST_ADAPTERS[provider]) {
    if (env.NODE_ENV === 'production') {
      throw new Error(`Adapter "${provider}" is a test double and cannot be used in production`);
    }
    return TEST_ADAPTERS[provider];
  }
  throw new Error(`No adapter registered for provider "${provider}"`);
};

// For tests that need to swap the wire implementation under a real provider key
// — asserting this lane's behaviour on a timeout, say, without a network. Refuses
// outside test for the same reason adapterFor gates the doubles.
const overrides = new Map();

export const overrideAdapter = (provider, adapter) => {
  if (env.NODE_ENV !== 'test') {
    throw new Error('adapter overrides are only available under NODE_ENV=test');
  }
  overrides.set(provider, adapter);
};

export const clearAdapterOverrides = () => overrides.clear();

export const resolveAdapter = (provider) => overrides.get(provider) ?? adapterFor(provider);
