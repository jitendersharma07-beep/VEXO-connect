// Drive the real POS HTTP API up to the point a human (or a browser) must pay.
//
// Everything here goes through the actual routes a cashier's browser calls —
// no Prisma shortcuts — so a pass means the route, its RBAC, its licence gate
// and its money maths all held. The provider side is real: opening the intent
// creates a genuine Razorpay order.
//
// Reads the 0600 sandbox login. Prints no credential.
import { readFileSync } from 'node:fs';

const REPO = '/home/atc-noc/atc-pos';
const API = 'http://127.0.0.1:5010/api';
const env = {};
for (const line of readFileSync(`${REPO}/backend/.secrets/dev-sandbox-account.env`, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)='(.*)'$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
};

const must = (label, res, want = 200) => {
  if (res.status !== want) {
    console.log(`FAIL: ${label} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    process.exit(2);
  }
  console.log(`PASS: ${label}`);
  return res.body;
};

// --- log in -----------------------------------------------------------------
const login = async (email) => {
  const res = await call('POST', '/auth/login', { body: { email, password: env.POS_SANDBOX_PASSWORD } });
  if (res.status !== 200) { console.log(`FAIL: login ${email} -> HTTP ${res.status} ${JSON.stringify(res.body)}`); process.exit(2); }
  return res.body.token ?? res.body.accessToken ?? res.body.data?.token;
};
const owner = await login(env.POS_SANDBOX_OWNER);
const cashier = await login(env.POS_SANDBOX_CASHIER);
console.log('PASS: owner and cashier logged in through /api/auth/login');

// --- catalog, as the owner --------------------------------------------------
const stamp = Date.now().toString().slice(-6);
const taxList = (await call('GET', '/catalog/tax-rates', { token: owner })).body.taxRates ?? [];
let taxId = taxList.find((t) => Number(t.ratePercent) === 5)?.id;
if (!taxId) {
  taxId = must('create tax rate GST 5%', await call('POST', '/catalog/tax-rates', {
    token: owner, body: { name: 'GST 5%', ratePercent: 5 },
  }), 201).taxRate.id;
} else {
  console.log('PASS: reusing existing GST 5% tax rate');
}

const catId = must('create category', await call('POST', '/catalog/categories', {
  token: owner, body: { name: `Coffee ${stamp}`, sortOrder: 1 },
}), 201).category.id;

const product = must('create product at ₹100.00 + 5% GST', await call('POST', '/catalog/products', {
  token: owner,
  body: { name: `Filter Coffee ${stamp}`, sku: `FC-${stamp}`, categoryId: catId, taxRateId: taxId, basePrice: 100 },
}), 201).product;

// --- an order, as the cashier ----------------------------------------------
const order = must('open an order with 1 x Filter Coffee', await call('POST', '/orders', {
  token: cashier,
  body: { branchId: env.POS_SANDBOX_BRANCH, type: 'TAKEAWAY', items: [{ productId: product.id, qty: 1 }] },
}), 201).order;

const billed = must('bill the order', await call('POST', `/orders/${order.id}/bill`, { token: cashier, body: {} })).order;
console.log(`      subtotal ${billed.subtotal}  tax ${billed.taxAmount}  total ${billed.total}  status ${billed.status}`);

// --- open a REAL Razorpay attempt -------------------------------------------
const opened = must('open a payment intent (real Razorpay order)', await call('POST', `/orders/${order.id}/payment-intents`, {
  token: cashier, body: {},
}), 201);

console.log('');
console.log('--- hand this to the browser ---------------------------------');
console.log(`POS order id     ${order.id}`);
console.log(`invoice          ${billed.invoiceNo ?? '(none)'}`);
console.log(`provider ref     ${opened.intent.providerRef}`);
console.log(`amount           ${opened.intent.amount}`);
console.log(`provider         ${opened.provider}`);
console.log(`order status     ${billed.status}  (must stay due until the webhook says otherwise)`);
