// Swiggy adapter — INTERFACE ONLY. NOT OPERATIONAL.
//
// This file intentionally contains no endpoints, no payload shapes and no
// authentication scheme, because Swiggy publishes none. Checked 2026-09-24:
// developers.swiggy.com renders no API content without a Swiggy-issued
// organisation login, and there is no self-serve path to one.
//
// Why this file exists at all, rather than nothing: the registry, the outlet
// mapping, the event pipeline and the portal all need Swiggy to be a first-class
// provider so that the day credentials and documentation arrive, the work is
// writing this one file — not retrofitting a fifth provider into four places.
// Every call refuses with the reason, so an operator who enables it is told what
// is missing instead of watching a queue fill with failures.
//
// DO NOT "complete" this file from a blog post, a scraping vendor's page or an
// LLM's recollection of Swiggy's API. Endpoints obtained that way produce a
// build that passes its own tests and fails on the first real order — which is
// worse than this refusal, because the refusal is honest.

import { providerDef } from '../providers.js';

const refuse = () => {
  const err = new Error(providerDef('SWIGGY').blockedReason);
  err.code = 'POS_INTEGRATION_NOT_OPERABLE';
  err.kind = 'TERMINAL';
  err.retryable = false;
  throw err;
};

export const adapter = {
  key: 'SWIGGY',
  operable: false,

  // Answers rather than throws, because "can we reach Swiggy" has a truthful
  // answer that is not an exception: no, and here is why.
  async checkConnection() {
    return { ok: false, detail: providerDef('SWIGGY').blockedReason };
  },

  parseInbound() {
    return refuse();
  },

  async perform() {
    return refuse();
  },
};

export default adapter;
