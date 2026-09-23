#!/usr/bin/env node
// End-to-end check of the till's money path against a RUNNING backend:
//   sale → discount (policy, ceiling, approval) → bill → partial payment and
//   its retry → refund → sales report → day close, plus branch isolation.
//
// Every check asserts the behaviour the product SHOULD have, so a failure is a
// defect, not a changed expectation. Things worth knowing that are not
// pass/fail are printed as OBSERVATIONS.
//
// It writes orders, payments, refunds and a day closing. It therefore refuses
// to run against anything but a throwaway database on a non-production host.
// Drive it through deploy/e2e-isolated.sh, which creates that database.

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.E2E_BASE;
const DB = process.env.E2E_DB ?? '';
const refuse = (why) => {
  console.error(`REFUSED: ${why}`);
  process.exit(2);
};
if (!BASE) refuse('E2E_BASE is not set — run deploy/e2e-isolated.sh');
const baseUrl = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) refuse(`${baseUrl.hostname} is not loopback`);
if (baseUrl.port === '8110') refuse('8110 is the production edge port');
if (os.hostname() === 'atc-noc') refuse('this host runs production');
if (!DB.startsWith('atc_pos_e2e_')) refuse('E2E_DB must name a throwaway atc_pos_e2e_* database');

const env = process.env;
for (const k of ['POS_SEED_OWNER_PASSWORD', 'POS_SEED_MANAGER_PASSWORD', 'POS_SEED_CASHIER_PASSWORD']) {
  if (!env[k]) refuse(`${k} is not set`);
}

// --- plumbing ----------------------------------------------------------------

const api = async (token, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
};

const code = (r) => r.body?.error?.code ?? '';
const msg = (r) => r.body?.error?.message ?? '';
const paise = (v) => Math.round(Number(v) * 100);
const rupees = (p) => Number((p / 100).toFixed(2));
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const say = (r) => `HTTP ${r.status}${msg(r) ? ` "${msg(r)}"` : ''}`;
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const results = [];
const observations = [];
const check = (id, area, what, pass, detail = '') => {
  results.push({ id, area, what, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(7)} ${what}${detail ? `  [${detail}]` : ''}`);
};
const observe = (id, what, detail) => {
  observations.push({ id, what, detail });
  console.log(`NOTE  ${id.padEnd(7)} ${what}  [${detail}]`);
};

const login = async (email, password) => {
  const r = await api(null, 'POST', '/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${say(r)}`);
  return { token: r.body.token, user: r.body.user, email, password };
};

const must = (r, what) => {
  if (!ok2xx(r)) throw new Error(`${what}: ${say(r)}`);
  return r.body;
};

const newPassword = () => `E2e-${randomUUID().replace(/-/g, '').slice(0, 20)}`;

// --- setup -------------------------------------------------------------------

const RUN = DB.replace('atc_pos_e2e_', '');
const today = istToday();

const owner = await login('demo.owner@atcpos.example', env.POS_SEED_OWNER_PASSWORD);
const cpMgr = await login('demo.manager@atcpos.example', env.POS_SEED_MANAGER_PASSWORD);
const cpCash = await login('demo.cashier@atcpos.example', env.POS_SEED_CASHIER_PASSWORD);

const branches = must(await api(owner.token, 'GET', '/branches'), 'list branches').branches;
const CP = branches.find((b) => b.code === 'BSC-CP');
const CH = branches.find((b) => b.code === 'BSC-CH');
const products = must(await api(owner.token, 'GET', '/catalog/products'), 'list products').products;
const sku = (s) => {
  const p = products.find((x) => x.sku === s);
  if (!p) throw new Error(`seed product ${s} missing`);
  return p.id;
};

const createStaff = async (role, tag, branchId) => {
  const email = `e2e.${tag}.${RUN}@atcpos.example`;
  const body = must(
    await api(owner.token, 'POST', '/users', { email, fullName: `E2E ${tag}`, role, branchId }),
    `create ${tag}`,
  );
  return { email, temp: body.tempPassword, id: body.user.id };
};
const chCashAcct = await createStaff('CASHIER', 'cashier-ch', CH.id);
const chMgrAcct = await createStaff('BRANCH_MANAGER', 'manager-ch', CH.id);

// --- 1. accounts -------------------------------------------------------------

const chCashTemp = await login(chCashAcct.email, chCashAcct.temp);
check('AUTH-1', 'accounts', 'a new staff account must change its temporary password',
  chCashTemp.user.mustChangePassword === true);

const early = await api(chCashTemp.token, 'POST', '/orders', {
  type: 'TAKEAWAY',
  items: [{ productId: sku('CHA-01'), qty: 1 }],
});
if (early.status === 201) {
  observe('OBS-1', 'The first-login password change is enforced by the browser only',
    `POST /orders with the unchanged temporary password → HTTP 201; the API accepts work before the change`);
}

const changePassword = async (acct) => {
  const s = await login(acct.email, acct.temp);
  const pw = newPassword();
  must(await api(s.token, 'POST', '/auth/change-password', { currentPassword: acct.temp, newPassword: pw }),
    `change password ${acct.email}`);
  return login(acct.email, pw);
};
const chCash = await changePassword(chCashAcct);
const chMgr = await changePassword(chMgrAcct);
check('AUTH-2', 'accounts', 'after the change the account signs in without the flag',
  chCash.user.mustChangePassword === false && chMgr.user.mustChangePassword === false);

// --- 2. sale + deny-by-default ----------------------------------------------

const a = await api(cpCash.token, 'POST', '/orders', {
  type: 'TAKEAWAY',
  branchId: CH.id, // deliberately the WRONG branch — a pinned cashier must not be able to choose it
  items: [{ productId: sku('CAP-01'), qty: 2 }, { productId: sku('SND-01'), qty: 1 }],
});
must(a, 'create order A');
const A = a.body.order;
check('ISO-1', 'branch isolation', 'a cashier naming another branch still opens the bill at their own',
  A.branchId === CP.id, `sent BSC-CH, stored ${A.branchId === CP.id ? 'BSC-CP' : A.branchId}`);
check('SALE-1', 'sale', 'order A prices from the catalog: 2 × ₹180 + ₹150 = ₹510.00 gross',
  paise(A.subtotal) === 51000, `subtotal ${A.subtotal}`);

const denyDefault = await api(cpCash.token, 'POST', `/orders/${A.id}/discount`, { type: 'PERCENT', value: 5 });
check('DISC-1', 'discount policy', 'with no policy configured a cashier cannot discount at all',
  denyDefault.status === 403 && code(denyDefault) === 'POS_DISCOUNT_NOT_PERMITTED'
    && denyDefault.body?.error?.details?.approvalRequired === true,
  say(denyDefault));

// --- 3. owner sets the policy -------------------------------------------------

const putPolicy = (token, body) =>
  api(token, 'PUT', '/discount-policies', {
    allowLineDiscount: null, allowOrderDiscount: null, maxPercent: null, maxFlatPaise: null,
    canApprove: null, maxApprovalPercent: null, maxApprovalFlatPaise: null, note: null,
    ...body,
  });

const polCashier = await putPolicy(cpCash.token, { level: 'COMPANY', allowOrderDiscount: true, maxPercent: 100 });
const polManager = await putPolicy(cpMgr.token, { level: 'COMPANY', allowOrderDiscount: true, maxPercent: 100 });
check('POL-1', 'discount policy', 'only the owner can change discount policy (cashier and manager refused)',
  polCashier.status === 403 && polManager.status === 403,
  `cashier ${polCashier.status}, manager ${polManager.status}`);

const p1 = await putPolicy(owner.token, {
  level: 'COMPANY', allowLineDiscount: true, allowOrderDiscount: true, maxPercent: 10,
  note: 'E2E: staff may discount up to 10%',
});
const p2 = await putPolicy(owner.token, {
  level: 'USER', userId: cpMgr.user.id, maxPercent: 20, canApprove: true, maxApprovalPercent: 30,
  note: 'E2E: manager 20%, may approve to 30%',
});
// Probed on the OTHER branch's cashier, whose discounts nothing below relies
// on: if this refusal ever regresses, the saved 0% row must not quietly
// become the limit every later till check runs under.
const unusable = await putPolicy(owner.token, { level: 'USER', userId: chCashAcct.id, allowOrderDiscount: true, maxPercent: 0 });
check('POL-2', 'discount policy', 'owner saves a 10% staff default and a manager override (20%, approves to 30%)',
  ok2xx(p1) && ok2xx(p2), `${p1.status}/${p2.status}`);
check('POL-3', 'discount policy', 'a grant with a 0% ceiling is refused at save time, not discovered at the till',
  unusable.status === 400, say(unusable));

const eff = must(await api(owner.token, 'GET', '/discount-policies'), 'read policies').effective;
const effOf = (id) => eff.find((e) => e.userId === id);
check('POL-4', 'discount policy', 'effective limits read back: cashier 10%, manager 20% + approves to 30%',
  effOf(cpCash.user.id)?.ceiling === '10%' && effOf(cpMgr.user.id)?.ceiling === '20%'
    && effOf(cpMgr.user.id)?.approvalCeiling === '30%',
  `cashier ${effOf(cpCash.user.id)?.ceiling}, manager ${effOf(cpMgr.user.id)?.ceiling}/${effOf(cpMgr.user.id)?.approvalCeiling}`);
const ownerEff = effOf(owner.user.id);
if (ownerEff && ownerEff.ceiling !== 'no limit') {
  observe('OBS-2', 'A company-wide staff default also narrows the owner at the till',
    `owner's own ceiling reads "${ownerEff.ceiling}", approval "${ownerEff.approvalCeiling}" — the owner self-approves above it with their own password`);
}

// --- 4. discount at the till --------------------------------------------------

const disc = (token, value, approval) =>
  api(token, 'POST', `/orders/${A.id}/discount`, { type: 'PERCENT', value, ...(approval ? { approval } : {}) });

const d10 = await disc(cpCash.token, 10);
check('DISC-2', 'discount', 'cashier applies 10% — inside their own ceiling, no approval',
  ok2xx(d10) && paise(d10.body.order.discountAmount) === 5100, `${say(d10)} discount ${d10.body?.order?.discountAmount}`);

const d25 = await disc(cpCash.token, 25);
check('DISC-3', 'discount', 'cashier asks for 25% — refused, approval required, limit stated',
  d25.status === 403 && d25.body?.error?.details?.approvalRequired === true, say(d25));

const approval = (acct, reason = 'E2E regular customer') => ({ approverEmail: acct.email, password: acct.password, reason });

const badPw = await disc(cpCash.token, 25, { ...approval(cpMgr), password: 'definitely-wrong' });
check('DISC-4', 'discount', 'approval with a wrong password is refused without saying which part was wrong',
  badPw.status === 403 && msg(badPw) === 'Those approver credentials were not accepted.', say(badPw));

const wrongBranch = await disc(cpCash.token, 25, approval(chMgr));
check('ISO-2', 'branch isolation', "another branch's manager cannot approve a discount here",
  wrongBranch.status === 403 && /cannot approve a discount at this branch/.test(msg(wrongBranch)), say(wrongBranch));

const overApprover = await disc(cpCash.token, 40, approval(cpMgr));
check('DISC-5', 'discount', "40% is above the manager's own approval ceiling (30%) — refused",
  overApprover.status === 403 && /up to 30%/.test(msg(overApprover)), say(overApprover));

const d25ok = await disc(cpCash.token, 25, approval(cpMgr));
check('DISC-6', 'discount', 'manager approves 25% with their own password — ₹127.50 off',
  ok2xx(d25ok) && paise(d25ok.body.order.discountAmount) === 12750, `${say(d25ok)} discount ${d25ok.body?.order?.discountAmount}`);

// Line + order discounts are one figure. 6% on a line under 10% on the order
// is 15.4% of the bill, and a 10% cashier must not reach it by stacking.
const c = must(await api(cpCash.token, 'POST', '/orders', {
  type: 'TAKEAWAY',
  items: [{ productId: sku('CAP-01'), qty: 1 }, { productId: sku('CRS-01'), qty: 1 }],
}), 'create order C').order;
const capLine = c.items.find((i) => i.name === 'Cappuccino');
const line = await api(cpCash.token, 'PATCH', `/orders/${c.id}/items/${capLine.id}`, { lineDiscount: 18 });
check('DISC-7', 'discount', 'cashier takes ₹18 off one line (6% of the bill) — inside 10%', ok2xx(line), say(line));
const stacked = await api(cpCash.token, 'POST', `/orders/${c.id}/discount`, { type: 'PERCENT', value: 10 });
check('DISC-8', 'discount', 'a further 10% order discount is measured together with the line (15.4%) — refused',
  stacked.status === 403 && /15\.4%/.test(msg(stacked)), say(stacked));
const voidC = await api(cpMgr.token, 'POST', `/orders/${c.id}/void`, { reason: 'E2E stacking probe' });
check('SALE-3', 'sale', 'manager voids the probe bill', ok2xx(voidC), say(voidC));

// --- 5. bill + partial payment + retry ---------------------------------------

const bill = await api(cpCash.token, 'POST', `/orders/${A.id}/bill`);
const billed = bill.body?.order;
check('SALE-2', 'sale', 'order A bills with an invoice number',
  ok2xx(bill) && billed.status === 'BILLED' && Boolean(billed.invoiceNumber),
  `${say(bill)} ${billed?.invoiceNumber ?? ''} total ${billed?.total ?? ''}`);
const totalA = paise(billed.total);

const pay = (token, body) => api(token, 'POST', `/orders/${A.id}/payments`, body);
const half = Math.floor(totalA / 2);
const K1 = randomUUID();
const first = await pay(cpCash.token, { method: 'CARD', amount: rupees(half), idempotencyKey: K1 });
check('PAY-1', 'payment', `partial CARD payment of ₹${rupees(half).toFixed(2)} is taken`,
  first.status === 201 && first.body.replayed === false && first.body.order.status === 'BILLED', say(first));
const retry = await pay(cpCash.token, { method: 'CARD', amount: rupees(half), idempotencyKey: K1 });
check('PAY-2', 'payment', 'the same tender retried is a replay: HTTP 200, nothing collected twice',
  retry.status === 200 && retry.body.replayed === true && paise(retry.body.order.amountPaid) === half, say(retry));

const K2 = randomUUID();
const [r1, r2] = await Promise.all([
  pay(cpCash.token, { method: 'CARD', amount: 1, idempotencyKey: K2 }),
  pay(cpCash.token, { method: 'CARD', amount: 1, idempotencyKey: K2 }),
]);
const statuses = [r1.status, r2.status].sort().join('+');
check('PAY-3', 'payment', 'two simultaneous sends of one ₹1.00 tender land once (201 + 200 replay)',
  statuses === '200+201', statuses);

const afterRetries = must(await api(cpCash.token, 'GET', `/orders/${A.id}`), 'read A').order;
check('PAY-4', 'payment', 'order A holds exactly two payment rows after four sends',
  afterRetries.payments.length === 2 && paise(afterRetries.amountPaid) === half + 100,
  `${afterRetries.payments.length} rows, paid ${afterRetries.amountPaid}`);

const reused = await pay(cpCash.token, { method: 'CARD', amount: rupees(half + 1), idempotencyKey: K1 });
check('PAY-5', 'payment', 'a key reused for a different amount is refused, not replayed',
  reused.status === 409, say(reused));

const cashierRefund = await api(cpCash.token, 'POST', `/orders/${A.id}/refunds`, { amount: 5, reason: 'E2E cashier refund attempt' });
check('REF-1', 'refund', 'a cashier cannot refund', cashierRefund.status === 403, say(cashierRefund));

const dueA = totalA - half - 100;
const tendered = Math.ceil(dueA / 10000) * 10000 + 10000; // next ₹100 note, plus one more
const cash = await pay(cpCash.token, { method: 'CASH', tendered: rupees(tendered), idempotencyKey: randomUUID() });
check('PAY-6', 'payment', `cash settles the ₹${rupees(dueA).toFixed(2)} still due, with correct change`,
  cash.status === 201 && cash.body.order.status === 'PAID' && paise(cash.body.changeDue) === tendered - dueA,
  `${say(cash)} change ${cash.body?.changeDue}`);

// The drawer, as a person standing at it would count it.
let drawerPaise = dueA;

// Order A was settled in card AND cash, so which way ₹20 goes back is the
// manager's call — the server must refuse to guess it.
const unsaid = await api(cpMgr.token, 'POST', `/orders/${A.id}/refunds`, { amount: 20, reason: 'E2E partial refund, cash back' });
check('REF-4', 'refund', 'a refund on a card-and-cash bill must say how it goes back',
  unsaid.status === 400 && unsaid.body?.error?.field === 'method', say(unsaid));
const refundA = await api(cpMgr.token, 'POST', `/orders/${A.id}/refunds`, {
  amount: 20, reason: 'E2E partial refund, cash back', method: 'CASH',
});
check('REF-2', 'refund', 'manager refunds ₹20.00 of order A; a partial refund leaves it PAID',
  ok2xx(refundA) && refundA.body.order?.status === 'PAID', `${say(refundA)} ${refundA.body?.order?.status ?? ''}`);
drawerPaise -= 2000;

// Order B is paid by card only, so no cash from it ever enters the drawer.
const b = must(await api(cpCash.token, 'POST', '/orders', {
  type: 'TAKEAWAY',
  items: [{ productId: sku('ESP-01'), qty: 1 }],
}), 'create order B').order;
const bBilled = must(await api(cpCash.token, 'POST', `/orders/${b.id}/bill`), 'bill B').order;
const totalB = paise(bBilled.total);
must(await api(cpCash.token, 'POST', `/orders/${b.id}/payments`, {
  method: 'CARD', amount: rupees(totalB), idempotencyKey: randomUUID(),
}), 'pay B by card');
const refundB = await api(cpMgr.token, 'POST', `/orders/${b.id}/refunds`, {
  amount: rupees(totalB), reason: 'E2E card reversal on the terminal',
});
check('REF-3', 'refund', `a full refund of card-paid order B (₹${rupees(totalB).toFixed(2)}) marks it REFUNDED`,
  ok2xx(refundB) && refundB.body.order?.status === 'REFUNDED', `${say(refundB)} ${refundB.body?.order?.status ?? ''}`);
check('REF-5', 'refund', 'a card-only bill refunds as CARD without being asked',
  refundB.body?.refund?.method === 'CARD', `method ${refundB.body?.refund?.method}`);

// --- 6. branch isolation on the finished bills -------------------------------

const chReadA = await api(chCash.token, 'GET', `/orders/${A.id}`);
check('ISO-3', 'branch isolation', "another branch's cashier cannot open this branch's bill",
  chReadA.status === 403, say(chReadA));
const chPayA = await api(chCash.token, 'POST', `/orders/${A.id}/payments`, { method: 'CARD', amount: 1, idempotencyKey: randomUUID() });
check('ISO-4', 'branch isolation', "another branch's cashier cannot take a payment on it",
  chPayA.status === 403, say(chPayA));
const chReceipt = await api(chCash.token, 'GET', `/orders/${A.id}/receipt`);
check('ISO-5', 'branch isolation', "another branch's cashier cannot print its receipt",
  chReceipt.status === 403, say(chReceipt));
const chList = must(await api(chCash.token, 'GET', '/orders?pageSize=100'), 'CH list');
const chRows = chList.orders ?? chList.items ?? [];
check('ISO-6', 'branch isolation', "a cashier's order list holds only their own branch",
  chRows.every((o) => o.branchId === CH.id) && !chRows.some((o) => o.id === A.id),
  `${chRows.length} rows, all BSC-CH: ${chRows.every((o) => o.branchId === CH.id)}`);
const mgrPreviewCH = await api(cpMgr.token, 'GET', `/reports/day-close/preview?branchId=${CH.id}`);
check('ISO-7', 'branch isolation', "a manager cannot preview another branch's day close",
  mgrPreviewCH.status === 403, say(mgrPreviewCH));
const salesOwn = must(await api(cpMgr.token, 'GET', `/reports/sales?from=${today}&to=${today}`), 'sales own');
const salesCH = must(await api(cpMgr.token, 'GET', `/reports/sales?from=${today}&to=${today}&branchId=${CH.id}`), 'sales CH');
check('ISO-8', 'branch isolation', "a manager asking for another branch's sales still gets only their own",
  JSON.stringify(salesOwn) === JSON.stringify(salesCH));

// --- 7. reports --------------------------------------------------------------

const cashierSales = await api(cpCash.token, 'GET', `/reports/sales?from=${today}&to=${today}`);
check('REP-1', 'report', 'a cashier cannot read the sales report', cashierSales.status === 403, say(cashierSales));
check('REP-2', 'report', "the manager's sales report answers for today", Boolean(salesOwn),
  `keys: ${Object.keys(salesOwn).join(',')}`);

// --- 8. day close ------------------------------------------------------------

const cashierPreview = await api(cpCash.token, 'GET', '/reports/day-close/preview');
check('DC-1', 'day close', 'a cashier can see the day-close preview for their branch', cashierPreview.status === 200, say(cashierPreview));
const cashierClose = await api(cpCash.token, 'POST', '/reports/day-close', { countedCash: 0 });
check('DC-2', 'day close', 'a cashier cannot commit the day close', cashierClose.status === 403, say(cashierClose));

const preview = must(await api(cpMgr.token, 'GET', '/reports/day-close/preview'), 'manager preview').preview;
check('DC-3', 'day close', 'cash sales equal the cash actually taken on order A',
  paise(preview.cashSales) === dueA, `cashSales ${preview.cashSales}, taken ${rupees(dueA).toFixed(2)}`);
check('DC-4', 'day close', 'expected cash equals what an honest count of the drawer finds',
  paise(preview.expectedCash) === drawerPaise,
  `expected ${preview.expectedCash}, drawer ${rupees(drawerPaise).toFixed(2)}, cashRefunds ${preview.cashRefunds}`);

const honest = await api(cpMgr.token, 'POST', '/reports/day-close', { countedCash: rupees(drawerPaise), openingFloat: 0 });
check('DC-5', 'day close', 'an honest count closes the day with zero variance',
  honest.status === 201 && paise(honest.body.close?.variance) === 0, say(honest));
if (honest.status !== 201) {
  const withNote = await api(cpMgr.token, 'POST', '/reports/day-close', {
    countedCash: rupees(drawerPaise),
    openingFloat: 0,
    note: 'E2E: honest count; the difference is the card refund on order B',
  });
  observe('OBS-3', 'An honest count had to be closed with an explanation',
    `${say(withNote)}, recorded variance ${withNote.body?.close?.variance ?? '?'}`);
}

// --- tidy + report -----------------------------------------------------------

if (early.status === 201) {
  await api(owner.token, 'POST', `/orders/${early.body.order.id}/void`, { reason: 'E2E probe of the password-change gate' });
}

const failed = results.filter((r) => !r.pass);
const summary = {
  db: DB,
  base: BASE,
  ranAt: new Date().toISOString(),
  businessDate: today,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
  observations,
};
mkdirSync(new URL('../.devlogs/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../.devlogs/e2e-result-${DB}.json`, import.meta.url), JSON.stringify(summary, null, 2));

console.log(`\n${summary.passed}/${results.length} checks passed, ${observations.length} observation(s).`);
if (failed.length) console.log(`FAILED: ${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
