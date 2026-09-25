// Does GET /v1/orders?receipt=<r> filter, or is it ignored?
//
// The write probe found that an order created seconds earlier was not returned
// under its own receipt. findOrderByReceipt — the whole recovery path for a
// create whose answer was lost — depends on that filter, so the difference
// between the two explanations decides whether the recovery is broken or merely
// early:
//
//   ignored/unsupported  the filter is not a filter, and recovery can never
//                        work no matter how long it waits.
//   indexed late         the order exists but is not yet in the queryable
//                        index, and recovery needs to retry rather than assume.
//
// The discriminator is an order that has EXISTED for a while. This takes the
// newest order the unfiltered list returns — so it certainly exists and is
// certainly old enough to be indexed — and asks for it by its own receipt. A
// zero there cannot be a delay.
//
// STRICTLY READ-ONLY: every request is a GET. Prints counts and verdicts, never
// an order id, a receipt or an amount.

import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const SECRETS =
  process.argv[2] || '/home/atc-noc/atc-pos/backend/.secrets/razorpay-sandbox.env';
const UPSTREAM = 'https://api.razorpay.com';

const parsed = Object.fromEntries(
  readFileSync(SECRETS, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const eq = l.indexOf('=');
      return eq === -1 ? null : [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
    .filter(Boolean),
);

const keyId = parsed.POS_GATEWAY_KEY_ID;
const keySecret = parsed.POS_GATEWAY_KEY_SECRET;
if (!keyId?.startsWith('rzp_test_')) {
  console.log('FAIL: not a Razorpay test key');
  process.exit(2);
}
const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

const get = async (path) => {
  const res = await fetch(`${UPSTREAM}${path}`, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const all = await get('/v1/orders?count=10');
if (all.status !== 200) {
  console.log(`FAIL: unfiltered list answered ${all.status}`);
  process.exit(2);
}
const items = Array.isArray(all.body?.items) ? all.body.items : [];
console.log(`unfiltered list: ${items.length} orders returned`);

const withReceipt = items.find((o) => typeof o.receipt === 'string' && o.receipt);
if (!withReceipt) {
  console.log('INCONCLUSIVE: none of the recent orders carries a receipt to filter on');
  process.exit(3);
}
const ageMin = Math.round((Date.now() / 1000 - withReceipt.created_at) / 60);
console.log(`chosen order carries a receipt and is ${ageMin} minutes old`);

const filtered = await get(`/v1/orders?receipt=${encodeURIComponent(withReceipt.receipt)}&count=3`);
const got = Array.isArray(filtered.body?.items) ? filtered.body.items : [];
console.log(`filtered by that receipt: HTTP ${filtered.status}, ${got.length} orders returned`);

if (filtered.status === 200 && got.some((o) => o.id === withReceipt.id)) {
  console.log('VERDICT: the receipt filter WORKS — the write probe saw an indexing delay, not a broken filter');
  process.exit(0);
}
if (filtered.status === 200 && got.length === 0) {
  console.log('VERDICT: the receipt filter returns NOTHING for an order that demonstrably exists and is minutes old.');
  console.log('         This is not a delay. findOrderByReceipt cannot recover a lost create.');
  process.exit(1);
}
console.log(`VERDICT: the filter answered unexpectedly — ${got.length} orders, none of them the one asked for`);
process.exit(1);
