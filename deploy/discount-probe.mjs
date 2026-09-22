// Live probe: can a CASHIER apply an unlimited order discount on production,
// and is there any customer-admin control over that?
//
// Writes only to BSC-CP (the till that already carries acceptance traffic).
// BSC-CH stays untouched — it is reserved for the browser run.
// No password, token or cookie is ever printed.
import { readFileSync } from 'node:fs';

const BASE = 'https://atcworkspace.com/pos/api';
const CREDS = '/home/atc-noc/pos-demo-creds-20260921.txt';

const pw = (email) => {
  for (const line of readFileSync(CREDS, 'utf8').split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const [e, p] = line.split('\t');
    if (e?.trim().toLowerCase() === email) return p?.trim();
  }
  throw new Error(`no entry for ${email} (password never printed)`);
};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
};

const login = async (email) => {
  const r = await call('POST', '/auth/login', { body: { email, password: pw(email) } });
  if (r.status !== 200) throw new Error(`login ${email} -> HTTP ${r.status} (password not printed)`);
  return r.body.token ?? r.body.accessToken ?? r.body?.data?.token;
};

const line = (k, v) => console.log(`${k.padEnd(52)} ${v}`);

const cashier = await login('demo.cashier@atcpos.example');
const owner = await login('demo.owner@atcpos.example');
line('cashier + owner signed in', 'ok');

// Which branch is the cashier pinned to, and what can we sell?
const me = await call('GET', '/auth/me', { token: cashier });
const branchId = me.body?.user?.branchId ?? me.body?.branchId;
line('cashier role / pinned branch', `${me.body?.user?.role ?? me.body?.role} / ${branchId ? 'pinned' : 'unpinned'}`);

const prods = await call('GET', `/catalog/products?branchId=${branchId}`, { token: cashier });
const list = prods.body?.products ?? prods.body?.data ?? [];
const product = list.find((p) => Number(p.price) > 0) ?? list[0];
if (!product) { line('FAIL', `no product available (HTTP ${prods.status})`); process.exit(1); }
line('product chosen', `${product.name} @ ₹${product.price}`);

const ord = await call('POST', '/orders', {
  token: cashier,
  body: { branchId, type: 'TAKEAWAY', items: [{ productId: product.id, qty: 1 }] },
});
if (ord.status !== 201) { line('FAIL', `cashier could not open an order: HTTP ${ord.status}`); process.exit(1); }
const orderId = ord.body?.order?.id ?? ord.body?.id;
const subtotal = ord.body?.order?.subtotal ?? ord.body?.subtotal;
line('cashier opened an order', `subtotal ₹${subtotal}`);

// THE PROBE: a cashier zeroing the bill with a 100% discount.
const disc = await call('POST', `/orders/${orderId}/discount`, {
  token: cashier,
  body: { type: 'PERCENT', value: 100 },
});
line('CASHIER sets a 100% order discount', `HTTP ${disc.status}`);

const after = await call('GET', `/orders/${orderId}`, { token: cashier });
const o = after.body?.order ?? after.body;
line('  → order total after discount', `₹${o?.total}  (discount ₹${o?.discountAmount})`);

// Is there any surface an owner could use to restrict this?
for (const path of ['/settings', '/company/settings', '/permissions', '/roles', '/company/permissions']) {
  const r = await call('GET', path, { token: owner });
  line(`owner GET ${path}`, `HTTP ${r.status}`);
}

// Clean up: void the probe order so it never reads as trade.
const v = await call('POST', `/orders/${orderId}/void`, { token: owner, body: { reason: 'discount permission probe' } });
line('probe order voided by owner', `HTTP ${v.status}`);
