// Point the Razorpay sandbox at this dev tunnel, from the API rather than the
// dashboard.
//
// Two reasons this is not just a convenience:
//
// 1. The webhook secret has to be byte-identical on both sides or every
//    delivery fails its HMAC check. Typing it into a dashboard field is the
//    one step in the whole setup where a silent transcription error produces
//    exactly the symptom we are trying to rule out — deliveries that arrive
//    and are refused. Sending the stored secret directly makes the match a
//    property of the setup instead of something to re-verify afterwards.
//
// 2. The quick tunnel's hostname is ephemeral. It dies with the process, so
//    re-registering is a recurring chore, not a one-off. A chore done by hand
//    is a chore done differently each time.
//
// TEST KEYS ONLY — it refuses anything else. It never prints the secret, and
// the secret never appears in argv: it is read from the 0600 credential file
// and goes straight into the request body.
//
//   node backend/scripts/dev-webhook-register.mjs --list
//   node backend/scripts/dev-webhook-register.mjs --url https://<host>/api/gateway/webhook
//   node backend/scripts/dev-webhook-register.mjs --delete wh_XXXX

import { readFileSync } from 'node:fs';

const REPO = '/home/atc-noc/atc-pos';
const SECRETS = `${REPO}/backend/.secrets/razorpay-sandbox.env`;
const API = 'https://api.razorpay.com/v1/webhooks';

// The events the backend actually acts on. Subscribing to more would mean
// accepting deliveries we then log and drop, which makes the event log harder
// to read for no gain. payment.authorized is deliberately absent: the backend
// records it but will not create a Payment from it, because an authorisation
// is not money.
const EVENTS = ['payment.captured', 'payment.failed', 'refund.processed', 'refund.failed'];

const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(2); };

const env = {};
for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const keyId = env.POS_GATEWAY_KEY_ID || '';
const keySecret = env.POS_GATEWAY_KEY_SECRET || '';
const webhookSecret = env.POS_GATEWAY_WEBHOOK_SECRET || '';

if (!keyId || !keySecret) die('POS_GATEWAY_KEY_ID / _KEY_SECRET missing');
if (keyId.includes('_live_')) die('LIVE key; refusing');
if (!keyId.startsWith('rzp_test_')) die('not a test key; refusing');

const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

const call = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null, report status */ }
  return { status: res.status, json, text };
};

const active = (w) => Object.entries(w.events || {}).filter(([, on]) => on).map(([k]) => k).sort();

const show = (w) => {
  console.log(`  ${w.id}  active=${w.active}  url=${w.url}`);
  console.log(`     events=${active(w).join(', ') || '(none)'}`);
};

const list = async () => {
  const { status, json, text } = await call('GET', API);
  if (status !== 200) die(`list returned HTTP ${status}: ${text.slice(0, 200)}`);
  return json.items || [];
};

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? '';
};

if (args.includes('--list') || args.length === 0) {
  const items = await list();
  console.log(`registered webhooks on this sandbox account: ${items.length}`);
  items.forEach(show);
  process.exit(0);
}

const delId = arg('--delete');
if (delId) {
  const { status, text } = await call('DELETE', `${API}/${delId}`);
  // Razorpay answers 204 on a successful delete; some accounts answer 200.
  if (status !== 200 && status !== 204) die(`delete returned HTTP ${status}: ${text.slice(0, 200)}`);
  console.log(`deleted ${delId}`);
  process.exit(0);
}

const url = arg('--url');
if (!url) die('pass --url https://<host>/api/gateway/webhook (or --list)');
if (!url.startsWith('https://')) die('webhook url must be https');
if (!url.endsWith('/api/gateway/webhook')) die('url must end in /api/gateway/webhook');
if (!webhookSecret) die('POS_GATEWAY_WEBHOOK_SECRET missing — the backend would refuse every delivery');

// Reuse an existing registration for the same path rather than stacking a
// second one. Two webhooks pointing at the same backend means every event is
// delivered twice, and the second copy is then correctly rejected as a
// duplicate — which looks exactly like a bug in the dedupe logic.
const existing = (await list()).find((w) => {
  try { return new URL(w.url).pathname === '/api/gateway/webhook'; } catch { return false; }
});

if (existing) {
  console.log(`updating existing webhook ${existing.id}`);
  const { status, json, text } = await call('PATCH', `${API}/${existing.id}`, {
    url,
    secret: webhookSecret,
    events: EVENTS,
  });
  if (status !== 200) die(`update returned HTTP ${status}: ${text.slice(0, 300)}`);
  console.log('updated:');
  show(json);
} else {
  const { status, json, text } = await call('POST', API, {
    url,
    secret: webhookSecret,
    events: EVENTS,
  });
  if (status !== 200 && status !== 201) die(`create returned HTTP ${status}: ${text.slice(0, 300)}`);
  console.log('created:');
  show(json);
}

// Read it back from the provider instead of trusting the write's own response.
const after = await list();
console.log(`\nprovider now reports ${after.length} webhook(s):`);
after.forEach(show);

const ok = after.some((w) => w.url === url && w.active && EVENTS.every((e) => active(w).includes(e)));
console.log(ok
  ? '\nPASS: this url is registered, active, and subscribed to all four events'
  : '\nFAIL: registration did not land as intended — see the list above');
process.exit(ok ? 0 : 1);
