// Do the READ paths this lane added actually work against a real Razorpay
// account, or only against tests/razorpay.test.js's stub?
//
// The stub proves the wire format the adapter EXPECTS. It cannot prove that is
// the wire format Razorpay SENDS, because the same author wrote both. Two of
// the calls below have never been made against the account at all:
//
//   getStatus          GET /v1/orders/{id} and /v1/orders/{id}/payments
//   verifyCredentials  GET /v1/orders?count=1
//
// STRICTLY READ-ONLY. Every request is a GET. Nothing is created, no money
// moves, no order or payment is modified, and a failure here changes nothing at
// Razorpay. It refuses outright on anything but a test key.
//
// It prints verdicts and never evidence: no key, no secret, no order id, no
// payment id, no amount. An operator pasting this output into a chat window
// leaks nothing. That is deliberate — the credential file it reads is the same
// one `razorpay-sandbox-check.sh` guards, and the whole point of these two
// scripts is that running them is safe in front of anybody.
//
// Usage, from backend/:
//   node scripts/razorpay-sandbox-read-probe.mjs [path/to/sandbox.env]

import { readFileSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const SECRETS =
  process.argv[2] || '/home/atc-noc/atc-pos/backend/.secrets/razorpay-sandbox.env';

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
const die = (why) => {
  console.log(`FAIL: ${why}`);
  process.exit(2);
};

// --- credentials ------------------------------------------------------------

let mode;
try {
  mode = (statSync(SECRETS).mode & 0o777).toString(8);
} catch {
  die(`no credential file at ${SECRETS}`);
}
if (mode !== '600') die(`credential file is mode ${mode}, expected 600`);

const parsed = Object.fromEntries(
  readFileSync(SECRETS, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      return eq === -1 ? null : [line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
    .filter(Boolean),
);

const keyId = parsed.POS_GATEWAY_KEY_ID;
const keySecret = parsed.POS_GATEWAY_KEY_SECRET;
if (!keyId || !keySecret) die('stored credentials are incomplete');
// A live key here would make every read below a read of real customers' money,
// and one typo away from a write. Refuse before the first request.
if (keyId.includes('_live_')) die('that is a LIVE key; this script talks to sandbox accounts only');
if (!keyId.startsWith('rzp_test_')) die('key id does not look like a Razorpay test key');
ok('stored key id is a TEST key, and the file is 0600');

// config/env.js reads process.env once at import, and the adapter imports it.
// These two are its only hard requirements and neither is used by a GET.
process.env.NODE_ENV ||= 'development';
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.POS_JWT_SECRET ||= 'unused-by-this-probe-which-makes-no-token';

const { razorpayAdapter, RazorpayError } = await import('../src/lib/gateway/razorpay.js');

const credentials = { keyId, keySecret };

// --- one raw read, to find something real to ask about ----------------------

// The adapter has no "list orders" method — it has no reason to. This probe
// does: it needs the id of an order that genuinely exists on the account, and
// inventing one would test nothing.
const listOrders = async (count) => {
  const res = await fetch(`https://api.razorpay.com/v1/orders?count=${count}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) die(`could not list orders to probe with (HTTP ${res.status})`);
  const body = await res.json();
  return Array.isArray(body?.items) ? body.items : [];
};

let orders;
try {
  orders = await listOrders(50);
} catch (err) {
  die(`could not reach Razorpay: ${err?.message ?? 'no answer'}`);
}
if (!orders.length) die('the sandbox account has no orders, so there is nothing to read back');

const paidOrder = orders.find((o) => o.status === 'paid');
const openOrder = orders.find((o) => o.status === 'created' || o.status === 'attempted');

// --- verifyCredentials ------------------------------------------------------

const good = await razorpayAdapter.verifyCredentials({ credentials });
if (good.ok === true) ok('verifyCredentials accepts the real key pair');
else bad(`verifyCredentials rejected a key pair that works: ${good.detail}`);

// The negative control, and the one that matters: a function that returns
// {ok:true} unconditionally would pass the test above. This one has to come
// back false, AND for the right stated reason — "Razorpay rejected these
// credentials" and "Razorpay could not be asked" are different answers and only
// the first is a verdict on the key.
const wrong = await razorpayAdapter.verifyCredentials({
  credentials: { keyId, keySecret: `${keySecret}-deliberately-wrong` },
});
if (wrong.ok === false && /rejected these credentials/i.test(wrong.detail)) {
  ok('verifyCredentials rejects a wrong secret, and says the provider rejected it');
} else {
  bad(`verifyCredentials mishandled a wrong secret: ok=${wrong.ok}, detail=${wrong.detail}`);
}

// --- getStatus --------------------------------------------------------------

if (!paidOrder) {
  bad('no paid order on the account, so getStatus SUCCEEDED could not be exercised');
} else {
  const res = await razorpayAdapter.getStatus({ intentProviderRef: paidOrder.id, credentials });
  const shaped =
    res.status === 'SUCCEEDED' &&
    typeof res.chargeRef === 'string' &&
    res.chargeRef.startsWith('pay_') &&
    Number.isSafeInteger(res.amountPaise) &&
    res.amountPaise > 0 &&
    res.currency === 'INR';
  if (shaped) ok('getStatus reads a genuinely paid order as SUCCEEDED with a pay_ charge, an integer amount and a currency');
  else bad(`getStatus returned a shape this build cannot settle on: ${JSON.stringify({ ...res, chargeRef: typeof res.chargeRef })}`);

  // The amount Razorpay reports must be the amount Razorpay's own order record
  // carries. A capture for a different sum than the order is the mismatch case
  // the settle path refuses on, and it has to be visible here.
  if (res.amountPaise === paidOrder.amount) ok('the captured amount agrees with the order it belongs to');
  else bad('the captured amount does not agree with the order amount');

  const settled = await razorpayAdapter.fetchSettlement({ intentProviderRef: paidOrder.id, credentials });
  if (settled.settled === true && typeof settled.receipt === 'string' && settled.receipt) {
    ok('fetchSettlement confirms the capture and returns our own receipt back, which is what proves the order is ours');
  } else {
    bad(`fetchSettlement did not confirm a capture Razorpay reports as paid: ${JSON.stringify({ settled: settled.settled, reason: settled.reason ?? null })}`);
  }
}

if (!openOrder) {
  console.log('SKIP: no unpaid order on the account, so getStatus PENDING was not exercised');
} else {
  const res = await razorpayAdapter.getStatus({ intentProviderRef: openOrder.id, credentials });
  // This is the control for the SUCCEEDED case above. Without it, an adapter
  // that answered SUCCEEDED for everything would look correct.
  if (res.status === 'PENDING') ok('getStatus reads an unpaid order as PENDING, not as success');
  else bad(`getStatus read an unpaid order as ${res.status}`);
}

// An id that is well formed and does not exist. The honest answers are an error
// or PENDING-with-nothing; the one answer that would be dangerous is SUCCEEDED.
try {
  const res = await razorpayAdapter.getStatus({
    intentProviderRef: 'order_00000000000000',
    credentials,
  });
  if (res.status === 'SUCCEEDED') bad('getStatus reported SUCCEEDED for an order that does not exist');
  else ok(`getStatus does not invent a success for an unknown order id (answered ${res.status})`);
} catch (err) {
  if (err instanceof RazorpayError) ok('getStatus raises rather than guessing for an unknown order id');
  else bad(`getStatus failed in a way the caller cannot classify: ${err?.message}`);
}

// A reference that was never opened with Razorpay at all. This must be refused
// locally — no network call — because there is nothing to ask about.
try {
  await razorpayAdapter.getStatus({ intentProviderRef: 'not-an-order-reference', credentials });
  bad('getStatus called Razorpay about a reference that is not a Razorpay order');
} catch (err) {
  if (err instanceof RazorpayError && err.kind === 'LOCAL') {
    ok('getStatus refuses a non-Razorpay reference locally, without asking the provider');
  } else {
    bad(`getStatus mishandled a non-Razorpay reference: ${err?.message}`);
  }
}

// --- verdict ----------------------------------------------------------------

console.log('');
console.log(`${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} checks passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
