// Do the WRITE paths this lane added actually work against a real Razorpay
// account, or only against tests/razorpayFlow.test.js's stub?
//
// The read probe established the reads. Every write was stubbed, and the stub
// was written by the same author as the adapter, so it proves the wire format
// the adapter EXPECTS and nothing about the one Razorpay ACCEPTS.
//
// TWO DIFFERENT THINGS ARE BEING SEPARATED HERE, because the first run of this
// probe conflated them and read as four adapter defects that were nothing of
// the kind:
//
//   the adapter's logic      given an order that exists under a receipt, does
//                            createSession adopt it instead of posting again,
//                            and does it refuse when two exist? Answerable, and
//                            answered below against the real API.
//   the provider's index     how long after a create is the order returned by
//                            GET /v1/orders?receipt=. Measured separately by
//                            razorpay-receipt-visibility-probe.mjs: 7.7 s,
//                            16.0 s and 30.0 s on three samples, no ceiling
//                            established. findOrderByReceipt runs IMMEDIATELY
//                            after the failed POST, so in practice it misses.
//
// Mixing them means a slow index reads as a broken adapter. So every phase below
// WAITS for the order it depends on to be visible before exercising the logic.
// That is not making the test easier: the wait is the provider's latency, and
// what is under test is what the adapter does once the lookup can answer at all.
// The consequence of the lag is a finding in its own right and is recorded in
// the readiness document, not papered over here.
//
// HOW THE FAILED CREATE IS ARRANGED. A loopback pass-through sits in front of
// api.razorpay.com via POS_GATEWAY_API_BASE. It forwards every request unchanged
// and returns the real answer. In `reject` mode it answers 502 to a POST
// /v1/orders WITHOUT forwarding it, which is indistinguishable, from the
// adapter's side, from a create whose answer was lost: it posted, got no usable
// answer, and an order already exists under its receipt. 502 is in
// RETRYABLE_STATUS, so providerRefused is false and the adapter takes its
// recovery path. Razorpay's API is never stubbed — the orders, the receipts and
// the lookup are all real.
//
// WHAT THIS COSTS. Three orders of INR 1.00 on a TEST account, the smallest
// amount Razorpay accepts. No money moves, no live key is reachable — the script
// refuses anything but rzp_test_ — nothing is captured or refunded, and no
// customer record exists to touch. Razorpay has no API for deleting a test
// order, so the three remain on the account as unpaid orders.
//
// It prints verdicts and never evidence: no key, no secret, no order id, no
// receipt.
//
// Usage, from backend/:
//   node scripts/razorpay-sandbox-write-probe.mjs [path/to/sandbox.env]

import { readFileSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const SECRETS =
  process.argv[2] || '/home/atc-noc/atc-pos/backend/.secrets/razorpay-sandbox.env';
const UPSTREAM = 'https://api.razorpay.com';
const AMOUNT_PAISE = 100;
// Generous, because the measured lag reached 30 s and no ceiling was
// established. A timeout here is a finding, not a pass.
const VISIBLE_BUDGET_MS = 90000;
const POLL_MS = 1000;

let pass = 0;
let fail = 0;
const ok = (what) => {
  pass += 1;
  console.log(`PASS: ${what}`);
};
const bad = (what) => {
  fail += 1;
  console.log(`FAIL: ${what}`);
};
const note = (what) => console.log(`NOTE: ${what}`);
const die = (why) => {
  console.log(`FAIL: ${why}`);
  process.exit(2);
};

// --- credentials ------------------------------------------------------------

let fmode;
try {
  fmode = (statSync(SECRETS).mode & 0o777).toString(8);
} catch {
  die(`no credential file at ${SECRETS}`);
}
if (fmode !== '600') die(`credential file is mode ${fmode}, expected 600`);

const parsed = Object.fromEntries(
  readFileSync(SECRETS, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      return eq === -1
        ? null
        : [line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
    .filter(Boolean),
);

const keyId = parsed.POS_GATEWAY_KEY_ID;
const keySecret = parsed.POS_GATEWAY_KEY_SECRET;
if (!keyId || !keySecret) die('stored credentials are incomplete');
// This script CREATES things. A live key here would create them with real
// customers' money. Refuse before the server is even started.
if (keyId.includes('_live_')) die('that is a LIVE key; this script writes to sandbox accounts only');
if (!keyId.startsWith('rzp_test_')) die('key id does not look like a Razorpay test key');
ok('stored key id is a TEST key, and the file is 0600');

const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

// --- the loopback pass-through ----------------------------------------------

// 'pass' forwards everything. 'reject' answers 502 to POST /v1/orders without
// forwarding it, so no order is created by the call under test.
let postMode = 'pass';

const proxy = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  if (postMode === 'reject' && req.method === 'POST' && req.url.startsWith('/v1/orders')) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'GATEWAY', description: 'answer withheld by probe' } }));
    return;
  }

  let upstream;
  let text;
  try {
    upstream = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method,
      headers: {
        authorization: req.headers.authorization ?? '',
        'content-type': req.headers['content-type'] ?? 'application/json',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(25000),
    });
    text = await upstream.text();
  } catch {
    res.writeHead(504, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'PROXY', description: 'upstream unreachable' } }));
    return;
  }

  res.writeHead(upstream.status, { 'content-type': 'application/json' });
  res.end(text);
});

await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', resolve);
});
const port = proxy.address().port;

// config/env.js reads process.env once at import and the adapter imports it, so
// the base has to be set before the dynamic import below. http is accepted
// outside production and test; that guard is deliberate and is not being worked
// around — this really is a development-mode run.
process.env.NODE_ENV ||= 'development';
process.env.POS_GATEWAY_API_BASE = `http://127.0.0.1:${port}`;
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.POS_JWT_SECRET ||= 'unused-by-this-probe-which-makes-no-token';

const { razorpayAdapter, RazorpayError } = await import('../src/lib/gateway/razorpay.js');
const credentials = { keyId, keySecret };

const newReceipt = (tag) => `vcxint-${tag}-${randomBytes(4).toString('hex')}`;
const localOrderId = () => `probe-${randomBytes(4).toString('hex')}`;

// Raw, direct to Razorpay — deliberately NOT through the proxy or the adapter,
// so arranging a phase's preconditions cannot be mistaken for the phase passing.
const rawCreate = async (receipt) => {
  const res = await fetch(`${UPSTREAM}/v1/orders`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: AMOUNT_PAISE, currency: 'INR', receipt }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  return res.json();
};

const rawByReceipt = async (receipt) => {
  const res = await fetch(`${UPSTREAM}/v1/orders?receipt=${encodeURIComponent(receipt)}&count=5`, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const page = await res.json();
  return Array.isArray(page?.items) ? page.items : [];
};

// Waits until the receipt returns exactly `want` orders. Returns the elapsed ms,
// or null if the budget ran out — which is reported rather than swallowed.
const waitVisible = async (receipt, want) => {
  const startedAt = Date.now();
  for (;;) {
    const items = await rawByReceipt(receipt);
    if (Array.isArray(items) && items.length === want) return Date.now() - startedAt;
    if (Date.now() - startedAt >= VISIBLE_BUDGET_MS) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

const finish = () => {
  proxy.close();
  console.log('');
  console.log(`${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} checks passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};

// --- 1. a create Razorpay agrees is ours ------------------------------------

const key1 = newReceipt('w1');
const order1 = localOrderId();
let created1 = null;
try {
  created1 = await razorpayAdapter.createSession({
    amountPaise: AMOUNT_PAISE,
    currency: 'INR',
    orderId: order1,
    idempotencyKey: key1,
    credentials,
  });
} catch (err) {
  bad(`createSession could not create a sandbox order: ${err?.message ?? 'no message'}`);
}

if (created1) {
  if (typeof created1.providerRef === 'string' && created1.providerRef.startsWith('order_')) {
    ok('createSession creates a real Razorpay order and returns its order_ reference');
  } else {
    bad('createSession returned something that is not a Razorpay order reference');
  }
  // The frontend reads null as "open Checkout". A URL here would mean this build
  // believes Razorpay has a hosted page for this flow, which it does not.
  if (created1.checkoutUrl === null) {
    ok('createSession offers no hosted redirect, which is the honest answer for this flow');
  } else {
    bad('createSession returned a checkout URL for a flow that has none');
  }

  // Fetch by id, which the read probe showed answers immediately. This is the
  // round trip of the fields a later reconciliation needs; the receipt INDEX is
  // a separate matter and is phase 2's problem.
  const byId = await fetch(`${UPSTREAM}/v1/orders/${created1.providerRef}`, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(20000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  if (byId?.receipt === key1) {
    ok('Razorpay stores the receipt the adapter sent, which is the id the recovery path queries on');
  } else {
    bad('the receipt did not round-trip onto the order entity');
  }
  if (byId?.amount === AMOUNT_PAISE && byId?.currency === 'INR') {
    ok('Razorpay stored the amount in paise and the currency as asked');
  } else {
    bad('the stored order does not carry the amount or currency that was asked for');
  }
  if (byId?.notes?.pos_order_id === order1) {
    ok('the POS order id round-trips in notes, so a settlement can be traced back to its bill');
  } else {
    bad('the POS order id did not round-trip in the order notes');
  }
  if (byId?.status === 'created') {
    ok('a freshly created order is unpaid at Razorpay, not paid');
  } else {
    bad(`a freshly created order reads as ${byId?.status ?? 'unreadable'} rather than unpaid`);
  }

  // Through the adapter now. PENDING is the only safe answer for an order
  // nobody has presented a card for.
  try {
    const status = await razorpayAdapter.getStatus({
      intentProviderRef: created1.providerRef,
      credentials,
    });
    if (status.status === 'PENDING') {
      ok('getStatus reads the order this probe just created as PENDING, not as paid');
    } else {
      bad(`getStatus read a brand-new unpaid order as ${status.status}`);
    }
  } catch (err) {
    bad(`getStatus could not read an order it had just created: ${err?.message}`);
  }

  try {
    const settled = await razorpayAdapter.fetchSettlement({
      intentProviderRef: created1.providerRef,
      credentials,
    });
    if (settled.settled === false && typeof settled.reason === 'string' && settled.reason) {
      ok('fetchSettlement reports the new order unsettled and says why, rather than throwing');
    } else {
      bad(
        `fetchSettlement answered ${JSON.stringify({ settled: settled.settled, reason: settled.reason ?? null })} for an unpaid order`,
      );
    }
  } catch (err) {
    bad(`fetchSettlement threw on an unpaid order instead of reporting it unsettled: ${err?.message}`);
  }

  // The lag, observed on the order this phase just made. Not asserted — it is
  // the provider's latency, not this build's behaviour — but recorded, because
  // it is the reason phase 2 has to wait at all.
  const lag = await waitVisible(key1, 1);
  note(
    lag === null
      ? `the created order was still not findable by its receipt after ${VISIBLE_BUDGET_MS} ms`
      : `the created order became findable by its receipt after ${lag} ms — findOrderByReceipt runs immediately, so it would have missed`,
  );
}

// --- 2. with the order visible, a lost create is adopted, not repeated ------

const key2 = newReceipt('w2');
const existing = await rawCreate(key2);
if (!existing?.id) {
  bad('could not arrange phase 2: the precondition order was not created');
} else {
  const seen = await waitVisible(key2, 1);
  if (seen === null) {
    bad(`could not arrange phase 2: the order never became findable by receipt within ${VISIBLE_BUDGET_MS} ms`);
  } else {
    postMode = 'reject';
    let adopted = null;
    let adoptErr = null;
    try {
      adopted = await razorpayAdapter.createSession({
        amountPaise: AMOUNT_PAISE,
        currency: 'INR',
        orderId: localOrderId(),
        idempotencyKey: key2,
        credentials,
      });
    } catch (err) {
      adoptErr = err;
    }
    postMode = 'pass';

    if (adopted?.providerRef === existing.id) {
      ok('a create whose answer was lost adopts the order that already exists under its receipt');
    } else if (adopted) {
      bad('the recovery returned a different order than the one that existed');
    } else {
      bad(`the recovery did not adopt an order that was findable under its receipt: ${adoptErr?.message}`);
    }

    // The claim that matters: it LOOKED UP rather than posting a second time.
    const after = await rawByReceipt(key2);
    if (Array.isArray(after) && after.length === 1) {
      ok('exactly one order exists under that receipt afterwards, so no second was posted');
    } else {
      bad(`${Array.isArray(after) ? after.length : 'an unknown number of'} orders exist under one receipt after recovery`);
    }
  }
}

// --- 3. two orders under one receipt is ambiguous, not resolved by guessing --

// Razorpay does not enforce receipt uniqueness, so this state is reachable in
// production. Picking one of two would be a guess about which page the customer
// can pay, so the adapter must refuse.
const key3 = newReceipt('w3');
const pairA = await rawCreate(key3);
const pairB = await rawCreate(key3);
if (!pairA?.id || !pairB?.id) {
  bad('could not arrange phase 3: the ambiguous pair was not created');
} else {
  const bothSeen = await waitVisible(key3, 2);
  if (bothSeen === null) {
    bad(`could not arrange phase 3: two orders under one receipt never both became visible within ${VISIBLE_BUDGET_MS} ms`);
  } else {
    ok('Razorpay allows two orders under one receipt, so the ambiguous case is reachable and not hypothetical');
    postMode = 'reject';
    let picked = null;
    let pickErr = null;
    try {
      picked = await razorpayAdapter.createSession({
        amountPaise: AMOUNT_PAISE,
        currency: 'INR',
        orderId: localOrderId(),
        idempotencyKey: key3,
        credentials,
      });
    } catch (err) {
      pickErr = err;
    }
    postMode = 'pass';

    if (!picked && pickErr instanceof RazorpayError) {
      ok('with the receipt ambiguous the adapter raises rather than picking one of two orders');
      // Razorpay refused nothing here, so nothing may be released on the
      // strength of it. This is the flag orders.js keys the intent's fate on.
      if (pickErr.providerRefused === false) {
        ok('and it does not report that as a provider refusal, so no money is released on it');
      } else {
        bad('an ambiguous recovery was reported as a provider refusal');
      }
    } else if (picked) {
      bad('an ambiguous receipt did not stop the adapter from returning one of two orders');
    } else {
      bad(`an ambiguous recovery raised something the caller cannot classify: ${pickErr?.message}`);
    }
  }
}

// --- 4. a refusal is classified as a refusal -------------------------------

// Below Razorpay's INR 1.00 minimum: answered, refused, nothing created. The
// flag under test is providerRefused, which is what lets orders.js close the
// intent and release the reserved amount — so it must be true here and, from
// phase 3, false when the provider never gave a verdict.
const key4 = newReceipt('w4');
try {
  await razorpayAdapter.createSession({
    amountPaise: 50,
    currency: 'INR',
    orderId: localOrderId(),
    idempotencyKey: key4,
    credentials,
  });
  bad('Razorpay accepted an amount below its own minimum, so the refusal path was not exercised');
} catch (err) {
  if (!(err instanceof RazorpayError)) {
    bad(`a refused create raised something the caller cannot classify: ${err?.message}`);
  } else if (err.providerRefused === true && err.status >= 400 && err.status < 500) {
    ok('a create Razorpay refuses is classified as refused, carrying the provider 4xx that is the evidence');
    if (err.retryable === false) {
      ok('and it is not marked retryable, so the refusal is not posted again');
    } else {
      bad('a refused create was marked retryable');
    }
  } else {
    bad(
      `a refused create was classified wrongly: kind=${err.kind}, status=${err.status}, providerRefused=${err.providerRefused}`,
    );
  }
}

finish();
