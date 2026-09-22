// Register the sandbox webhook on the Razorpay TEST account, from the stored
// secret, without anyone retyping anything.
//
// WHY THIS EXISTS
//
// The webhook is the single point where this integration was silently dead: a
// real ₹105 payment was captured by Razorpay and the POS never heard about it,
// because `GET /v1/webhooks` on the account returned `count=0`. Nothing in the
// dashboard shouts about that, and nothing in the POS can detect it — an
// integration with no webhook registered looks exactly like one whose customers
// simply have not paid yet.
//
// Doing it here rather than by hand also removes the two ways the manual route
// goes wrong: a secret retyped differently from the stored one (every delivery
// then fails signature verification, which reads like an attack), and a URL
// left pointing at a tunnel hostname that has since been recycled.
//
// WHAT IT REGISTERS
//
// Exactly the four events EVENT_MAP in backend/src/lib/gateway/razorpay.js
// applies. Subscribing to more is not harmless: unmapped events are stored and
// skipped, and a log full of deliberate skips is where a real miss hides.
//
// GUARDS
//
//   * refuses anything but an rzp_test_ key — this must never touch a live
//     merchant account;
//   * refuses a URL that is not https;
//   * refuses to add a second webhook for a URL that already has one, so
//     re-running does not produce duplicate deliveries;
//   * prints the id, the URL and the event list, and never the secret.
//
// USAGE
//   node backend/scripts/razorpay-webhook-register.mjs <tunnel-hostname>
//   node backend/scripts/razorpay-webhook-register.mjs --list
//   node backend/scripts/razorpay-webhook-register.mjs --delete <webhook-id>
import { readFileSync, statSync } from 'node:fs';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const FILE = `${REPO}/backend/.secrets/razorpay-sandbox.env`;

let raw;
try { raw = readFileSync(FILE, 'utf8'); } catch {
  console.log(`FAIL: no stored credentials at ${FILE} — run razorpay-sandbox-setup.sh first`);
  process.exit(2);
}
const mode = (statSync(FILE).mode & 0o777).toString(8);
if (mode !== '600') { console.log(`FAIL: ${FILE} is mode ${mode}, expected 600`); process.exit(2); }

const env = {};
for (const line of raw.split('\n')) {
  const m = /^([A-Z0-9_]+)='(.*)'$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const KEY_ID = env.POS_GATEWAY_KEY_ID;
const KEY_SECRET = env.POS_GATEWAY_KEY_SECRET;
const WEBHOOK_SECRET = env.POS_GATEWAY_WEBHOOK_SECRET;

if (!KEY_ID || !KEY_SECRET) { console.log('FAIL: key id or key secret missing from the stored file'); process.exit(2); }
if (!KEY_ID.startsWith('rzp_test_')) {
  console.log('FAIL: the stored key is not a test key. This script refuses to touch a live account.');
  process.exit(2);
}

const auth = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
const api = async (method, path, body) => {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: res.status, body: parsed };
};

const show = (w) => {
  const on = Object.keys(w.events ?? {}).filter((k) => w.events[k]);
  console.log(`      ${w.id}  active=${w.active}`);
  console.log(`      url    ${w.url}`);
  console.log(`      events ${JSON.stringify(on)}`);
};

const list = await api('GET', '/webhooks?count=100');
if (list.status !== 200) {
  console.log(`FAIL: could not list webhooks — HTTP ${list.status} ${JSON.stringify(list.body).slice(0, 200)}`);
  process.exit(2);
}
const existing = list.body.items ?? [];

const arg = process.argv[2];

if (arg === '--list' || !arg) {
  console.log(`PASS: account has ${existing.length} webhook(s)`);
  existing.forEach(show);
  if (!arg) {
    console.log('');
    console.log('To register one:  node backend/scripts/razorpay-webhook-register.mjs <tunnel-hostname>');
  }
  process.exit(0);
}

if (arg === '--delete') {
  const id = process.argv[3];
  if (!id) { console.log('FAIL: pass the webhook id to delete'); process.exit(2); }
  const del = await api('DELETE', `/webhooks/${id}`);
  console.log(del.status === 200 || del.status === 204
    ? `PASS: deleted ${id}`
    : `FAIL: HTTP ${del.status} ${JSON.stringify(del.body).slice(0, 200)}`);
  process.exit(del.status === 200 || del.status === 204 ? 0 : 2);
}

if (!WEBHOOK_SECRET) {
  console.log('FAIL: no POS_GATEWAY_WEBHOOK_SECRET stored. Re-run razorpay-sandbox-setup.sh.');
  process.exit(2);
}

const host = arg.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const url = `https://${host}/api/gateway/webhook`;
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) { console.log(`FAIL: "${arg}" is not a hostname`); process.exit(2); }

const clash = existing.find((w) => w.url === url);
if (clash) {
  console.log('PASS: a webhook for this exact URL already exists — not adding a second');
  show(clash);
  console.log('      To replace it: --delete <id>, then run this again.');
  process.exit(0);
}

const EVENTS = ['payment.captured', 'payment.failed', 'refund.processed', 'refund.failed'];
const made = await api('POST', '/webhooks', { url, secret: WEBHOOK_SECRET, events: EVENTS });
if (made.status !== 200 && made.status !== 201) {
  console.log(`FAIL: HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 400)}`);
  process.exit(2);
}
console.log(`PASS: webhook registered (HTTP ${made.status}), secret reused from the stored file and not printed`);
show(made.body);
if (existing.length) {
  console.log('');
  console.log(`NOTE: the account now has ${existing.length + 1} webhooks. Older ones pointing at dead`);
  console.log('      tunnel hostnames still count as deliveries Razorpay retries. Consider --delete.');
}
