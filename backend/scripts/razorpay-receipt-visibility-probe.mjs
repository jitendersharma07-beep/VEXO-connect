// How long after an order is created can it be found by its receipt?
//
// razorpay-receipt-filter-probe.mjs established that the filter works on an
// order a minute old and returns nothing on one a second old. findOrderByReceipt
// is called IMMEDIATELY after a create whose answer was lost — the coldest
// possible moment for that index — so the size of the gap decides what the
// recovery has to do about it:
//
//   under a second   the single lookup is merely unlucky, and one short retry
//                    closes it.
//   seconds          the recovery needs a bounded retry budget, and the number
//                    has to come from a measurement rather than a guess.
//   unbounded        recovery by receipt cannot be relied on at all and the
//                    orphaned order has to be reconciled another way.
//
// One order of INR 1.00 on a TEST account. Fetch-by-id is NOT the thing being
// measured — the write probe already showed that answers immediately — so this
// polls the FILTERED LIST, which is the query the recovery actually issues.
//
// Prints timings and verdicts, never an order id, a receipt or a key.

import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

const SECRETS =
  process.argv[2] || '/home/atc-noc/atc-pos/backend/.secrets/razorpay-sandbox.env';
const UPSTREAM = 'https://api.razorpay.com';
const BUDGET_MS = 30000;
const POLL_MS = 250;

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
if (keyId?.includes('_live_')) {
  console.log('FAIL: that is a LIVE key; this script writes to sandbox accounts only');
  process.exit(2);
}
if (!keyId?.startsWith('rzp_test_')) {
  console.log('FAIL: not a Razorpay test key');
  process.exit(2);
}
const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

const receipt = `vcxint-vis-${randomBytes(4).toString('hex')}`;

const created = await fetch(`${UPSTREAM}/v1/orders`, {
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/json' },
  body: JSON.stringify({ amount: 100, currency: 'INR', receipt }),
  signal: AbortSignal.timeout(20000),
});
if (!created.ok) {
  console.log(`FAIL: could not create the probe order (HTTP ${created.status})`);
  process.exit(2);
}
const order = await created.json();
const startedAt = Date.now();
console.log('created one INR 1.00 test order; polling the filtered list for it');

let firstSeenMs = null;
for (;;) {
  const elapsed = Date.now() - startedAt;
  const res = await fetch(`${UPSTREAM}/v1/orders?receipt=${encodeURIComponent(receipt)}&count=3`, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.some((o) => o.id === order.id)) {
    firstSeenMs = Date.now() - startedAt;
    break;
  }
  if (elapsed >= BUDGET_MS) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}

if (firstSeenMs === null) {
  console.log(`VERDICT: still not findable by receipt after ${BUDGET_MS} ms.`);
  console.log('         Recovery by receipt cannot be relied on within any useful window.');
  process.exit(1);
}

console.log(`VERDICT: findable by its receipt after ${firstSeenMs} ms`);
console.log(
  firstSeenMs <= POLL_MS
    ? '         The gap is under one poll, so a single immediate retry closes it.'
    : `         A recovery that looks once and gives up misses by ${firstSeenMs} ms.`,
);
process.exit(0);
