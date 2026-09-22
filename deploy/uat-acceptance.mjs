// Acceptance run against a DEPLOYED POS, over its real public URL.
//
// Every check here goes through https://…/pos/api — the same routes a
// cashier's browser calls, through the same nginx, into the same container and
// database. Nothing is stubbed and nothing is read out of the source tree,
// because "the code does X" and "the thing running at that URL does X" have
// already disagreed on this deployment once.
//
// SAFETY RAILS, checked before anything is written:
//   * the target company must have isDemo = true — it refuses to run against
//     a real tenant
//   * it never touches pos.admin or any pre-existing account's password
//   * the two accounts it signs in with are created for this run and deleted
//     at the end, including on failure
//
// It prints PASS / FAIL / NOT TESTED lines. No password, token or cookie is
// ever printed, including on error.
//
//   node deploy/uat-acceptance.mjs                       # against production
//   BASE_URL=http://127.0.0.1:5010 node deploy/uat-acceptance.mjs   # dev backend

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hash as argon2Hash } from '/home/atc-noc/atc-pos/backend/node_modules/@node-rs/argon2/index.js';

const BASE = (process.env.BASE_URL || 'https://atcworkspace.com/pos').replace(/\/$/, '');
const DB_CONTAINER = process.env.POS_DB_CONTAINER || 'pos-prod-postgres-1';
const API = `${BASE}/api`;
const RUN = randomBytes(3).toString('hex');

const results = [];
const record = (id, name, state, detail = '') => {
  results.push({ id, name, state });
  console.log(`${state.padEnd(10)} ${id}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const pass = (id, n, d) => record(id, n, 'PASS', d);
const fail = (id, n, d) => record(id, n, 'FAIL', d);
const skip = (id, n, d) => record(id, n, 'NOT TESTED', d);

const psql = (sql) => new Promise((resolve, reject) => {
  const p = spawn('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'atc_pos', '-d', 'atc_pos', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `psql exit ${c}`))));
  p.stdin.end(sql);
});

const call = async (method, path, { token, body, raw } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 160) }; }
  return { status: res.status, body: json };
};

const money = (v) => Number(v);
const near = (a, b) => Math.abs(money(a) - money(b)) < 0.005;

// --- rails --------------------------------------------------------------

const company = await psql(`select id || '|' || name || '|' || "isDemo" from "Company" where "isDemo" = true order by "createdAt" limit 1;`)
  .catch((e) => { console.error(`FAIL: cannot read the database — ${e.message}`); process.exit(2); });
if (!company) { console.error('FAIL: no company with isDemo = true; refusing to write to a real tenant'); process.exit(2); }
const [companyId, companyName] = company.split('|');

const branches = (await psql(`select id || '|' || name from "Branch" where "companyId" = '${companyId}' order by "createdAt";`))
  .split('\n').filter(Boolean).map((l) => { const [id, name] = l.split('|'); return { id, name }; });
if (branches.length < 2) { console.error(`FAIL: need two branches to test branch isolation; found ${branches.length}`); process.exit(2); }

console.log(`target    ${BASE}`);
console.log(`company   ${companyName} (isDemo)`);
console.log(`branches  ${branches.map((b) => b.name).join('  |  ')}`);
console.log('');

// --- throwaway accounts -------------------------------------------------

const OWNER_EMAIL = `uat.owner.${RUN}@atcpos.example`;
const CASHIER_A = `uat.cashier.a.${RUN}@atcpos.example`;
const CASHIER_B = `uat.cashier.b.${RUN}@atcpos.example`;
const SECRET = randomBytes(24).toString('base64url'); // in-process only, never printed

const cleanup = async () => {
  await psql(`delete from "PosUser" where email in ('${OWNER_EMAIL}','${CASHIER_A}','${CASHIER_B}');`).catch(() => {});
};

let exitCode = 0;
try {
  const hashed = (await argon2Hash(SECRET)).replace(/'/g, "''");
  const mk = (email, name, role, branchId) =>
    `insert into "PosUser" (id, "companyId", "branchId", email, "fullName", "passwordHash", role, status, "mustChangePassword", "createdAt", "updatedAt")
     values (gen_random_uuid()::text, '${companyId}', ${branchId ? `'${branchId}'` : 'null'}, '${email}', '${name}', '${hashed}', '${role}', 'ACTIVE', false, now(), now());`;
  await psql([
    mk(OWNER_EMAIL, `UAT Owner ${RUN}`, 'CUSTOMER_OWNER', null),
    mk(CASHIER_A, `UAT Cashier A ${RUN}`, 'CASHIER', branches[0].id),
    mk(CASHIER_B, `UAT Cashier B ${RUN}`, 'CASHIER', branches[1].id),
  ].join('\n'));

  const login = async (email) => {
    const r = await call('POST', '/auth/login', { body: { email, password: SECRET } });
    return r.status === 200 ? (r.body.token ?? r.body.accessToken) : null;
  };

  // ===== 1. Login and isolation ========================================

  const owner = await login(OWNER_EMAIL);
  const cashA = await login(CASHIER_A);
  const cashB = await login(CASHIER_B);
  if (owner && cashA && cashB) pass('1.1', 'owner and two branch cashiers sign in');
  else { fail('1.1', 'owner and two branch cashiers sign in', 'one or more logins refused'); throw new Error('cannot continue without sessions'); }

  const consoleTry = await call('GET', '/atc/companies', { token: owner });
  (consoleTry.status === 403 || consoleTry.status === 401)
    ? pass('1.2', 'tenant owner cannot reach the platform console', `HTTP ${consoleTry.status}`)
    : fail('1.2', 'tenant owner cannot reach the platform console', `HTTP ${consoleTry.status}`);

  const usersTry = await call('GET', '/users', { token: cashA });
  (usersTry.status === 403)
    ? pass('1.3', 'cashier cannot list users', `HTTP ${usersTry.status}`)
    : fail('1.3', 'cashier cannot list users', `HTTP ${usersTry.status}`);

  // ===== 2. Menu -> order -> bill -> payment -> receipt =================

  const taxes = (await call('GET', '/catalog/tax-rates', { token: owner })).body.taxRates ?? [];
  let taxId = taxes.find((t) => Number(t.ratePercent) === 5)?.id;
  if (!taxId) {
    const r = await call('POST', '/catalog/tax-rates', { token: owner, body: { name: 'GST 5%', ratePercent: 5 } });
    taxId = r.body?.taxRate?.id;
  }
  const cat = await call('POST', '/catalog/categories', { token: owner, body: { name: `UAT Coffee ${RUN}`, sortOrder: 99 } });
  const catId = cat.body?.category?.id;
  const prod = await call('POST', '/catalog/products', {
    token: owner,
    body: { name: `UAT Filter Coffee ${RUN}`, sku: `UAT-${RUN}`, categoryId: catId, taxRateId: taxId, basePrice: 100 },
  });
  const productId = prod.body?.product?.id;
  (taxId && catId && productId)
    ? pass('2.1', 'owner creates tax rate, category and product')
    : fail('2.1', 'owner creates tax rate, category and product', `tax ${taxId ? 'ok' : 'FAIL'} cat ${cat.status} prod ${prod.status}`);

  const opened = await call('POST', '/orders', {
    token: cashA,
    body: { branchId: branches[0].id, type: 'TAKEAWAY', items: [{ productId, qty: 2 }] },
  });
  const orderId = opened.body?.order?.id;
  orderId ? pass('2.2', 'cashier opens an order with 2 x ₹100 item', `HTTP ${opened.status}`)
          : fail('2.2', 'cashier opens an order', `HTTP ${opened.status} ${JSON.stringify(opened.body).slice(0, 160)}`);

  const kot = await call('POST', `/orders/${orderId}/kot`, { token: cashA, body: {} });
  (kot.status === 200 || kot.status === 201)
    ? pass('2.3', 'KOT ticket created for the kitchen', `HTTP ${kot.status}`)
    : fail('2.3', 'KOT ticket created for the kitchen', `HTTP ${kot.status}`);

  const billed = await call('POST', `/orders/${orderId}/bill`, { token: cashA, body: {} });
  const bill = billed.body?.order;
  bill?.invoiceNumber
    ? pass('2.4', 'order is billed and gets an invoice number', bill.invoiceNumber)
    : fail('2.4', 'order is billed and gets an invoice number', `HTTP ${billed.status}`);

  // ===== 3. Calculations ================================================

  if (bill) {
    const expectedSub = 200;
    const expectedTax = 10;   // 5% of 200
    const expectedTotal = 210;
    (near(bill.subtotal, expectedSub) && near(bill.taxAmount, expectedTax) && near(bill.total, expectedTotal))
      ? pass('3.1', '2 x ₹100 + 5% GST = ₹210', `subtotal ${bill.subtotal} tax ${bill.taxAmount} total ${bill.total}`)
      : fail('3.1', '2 x ₹100 + 5% GST = ₹210', `got subtotal ${bill.subtotal} tax ${bill.taxAmount} total ${bill.total}`);
  } else skip('3.1', 'bill arithmetic', 'no billed order');

  // Duplicate-click: two identical "Record payment" requests at once, which is
  // what a double-tap on a slow connection actually sends. Exactly one must
  // succeed; two successes means the till collected the bill twice.
  const dueNow = money(bill?.amountDue ?? 210);
  const [p1, p2] = await Promise.all([
    call('POST', `/orders/${orderId}/payments`, { token: cashA, body: { method: 'CASH', amount: dueNow } }),
    call('POST', `/orders/${orderId}/payments`, { token: cashA, body: { method: 'CASH', amount: dueNow } }),
  ]);
  const accepted = [p1, p2].filter((r) => r.status === 200 || r.status === 201).length;
  const paidRows = Number(await psql(`select count(*) from "Payment" where "orderId" = '${orderId}';`));
  const paidSum = Number(await psql(`select coalesce(sum(amount),0) from "Payment" where "orderId" = '${orderId}';`));
  (accepted === 1 && paidRows === 1)
    ? pass('3.2', 'double-clicked payment is collected once', `${accepted} accepted, ${paidRows} row(s), ₹${paidSum}`)
    : fail('3.2', 'double-clicked payment is collected once', `${accepted} accepted, ${paidRows} payment row(s) totalling ₹${paidSum} against a ₹${dueNow} bill`);

  const reread = await call('GET', `/orders/${orderId}`, { token: cashA });
  const persisted = reread.body?.order;
  (persisted && persisted.invoiceNumber === bill?.invoiceNumber && near(persisted.total, bill?.total))
    ? pass('3.3', 'billed order persists unchanged on re-read', `${persisted.invoiceNumber} status ${persisted.status}`)
    : fail('3.3', 'billed order persists unchanged on re-read', `HTTP ${reread.status}`);

  // ===== 2.5 Receipt ====================================================

  const receipt = await call('GET', `/orders/${orderId}/receipt`, { token: cashA });
  const rc = receipt.body?.receipt ?? receipt.body;
  const hasLines = Array.isArray(rc?.items) && rc.items.length > 0;
  const hasPay = Array.isArray(rc?.payments) && rc.payments.length > 0;
  (receipt.status === 200 && hasLines && hasPay)
    ? pass('2.5', 'receipt returns lines, totals and the payment', `${rc.items.length} line(s), ${rc.payments.length} payment(s)`)
    : fail('2.5', 'receipt returns lines, totals and the payment', `HTTP ${receipt.status}`);

  // ===== 1.4 Branch isolation, with a real order to point at ============

  const crossRead = await call('GET', `/orders/${orderId}`, { token: cashB });
  (crossRead.status === 403 || crossRead.status === 404)
    ? pass('1.4', "cashier cannot open another branch's order", `HTTP ${crossRead.status}`)
    : fail('1.4', "cashier cannot open another branch's order", `HTTP ${crossRead.status} — it was readable`);

  const crossList = await call('GET', `/orders?branchId=${branches[0].id}`, { token: cashB });
  const leaked = (crossList.body?.orders ?? []).some((o) => o.id === orderId);
  (!leaked)
    ? pass('1.5', "branch B's order list excludes branch A", `HTTP ${crossList.status}, ${(crossList.body?.orders ?? []).length} row(s)`)
    : fail('1.5', "branch B's order list excludes branch A", 'branch A order appeared');

  // ===== 4. Reports =====================================================

  const today = new Date().toISOString().slice(0, 10);
  const repAll = await call('GET', `/reports/sales?from=${today}&to=${today}`, { token: owner });
  const repA = await call('GET', `/reports/sales?from=${today}&to=${today}&branchId=${branches[0].id}`, { token: owner });
  const repB = await call('GET', `/reports/sales?from=${today}&to=${today}&branchId=${branches[1].id}`, { token: owner });

  const dbTotal = Number(await psql(
    `select coalesce(sum(p.amount),0) from "Payment" p join "Order" o on o.id = p."orderId" where o."companyId" = '${companyId}' and p."createdAt" >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';`,
  ));
  const repTotal = money(repAll.body?.summary?.collected ?? repAll.body?.summary?.total ?? repAll.body?.totals?.collected ?? NaN);

  if (repAll.status !== 200) {
    fail('4.1', 'owner can read the sales report', `HTTP ${repAll.status}`);
  } else if (Number.isNaN(repTotal)) {
    fail('4.1', 'sales report total matches the underlying payments',
      `report shape not recognised — keys: ${Object.keys(repAll.body ?? {}).join(',')}`);
  } else {
    near(repTotal, dbTotal)
      ? pass('4.1', 'sales report total matches the underlying payments', `report ₹${repTotal} = database ₹${dbTotal}`)
      : fail('4.1', 'sales report total matches the underlying payments', `report ₹${repTotal} vs database ₹${dbTotal}`);
  }

  (repA.status === 200 && repB.status === 200)
    ? pass('4.2', 'owner can pull each branch separately', `A HTTP ${repA.status}, B HTTP ${repB.status}`)
    : fail('4.2', 'owner can pull each branch separately', `A HTTP ${repA.status}, B HTTP ${repB.status}`);

  const cashierReport = await call('GET', `/reports/sales?from=${today}&to=${today}`, { token: cashA });
  (cashierReport.status === 403)
    ? pass('4.3', 'cashier cannot read sales reports', `HTTP ${cashierReport.status}`)
    : fail('4.3', 'cashier cannot read sales reports', `HTTP ${cashierReport.status}`);

  // Daily closing (phase 2). The preview must agree with the till's own
  // records: same IST business day, same branch, cash only, SUCCEEDED
  // non-gateway refunds subtracted. Read-only on purpose — committing a
  // closing files a permanent record for the day; the correction chain and
  // commit path are exercised by the vitest day-close suite in staging.
  const dcPrev = await call('GET', `/reports/day-close/preview?branchId=${branches[0].id}`, { token: owner });
  const prev = dcPrev.body?.preview;
  if (dcPrev.status !== 200 || !prev) {
    fail('4.4', 'day-close preview reconciles with recorded cash', `HTTP ${dcPrev.status}`);
  } else {
    const istStart = `date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;
    const dbCashSales = Number(await psql(
      `select coalesce(sum(p.amount),0) from "Payment" p join "Order" o on o.id = p."orderId" where o."companyId" = '${companyId}' and o."branchId" = '${branches[0].id}' and p.method = 'CASH' and coalesce(p.channel,'MANUAL') <> 'GATEWAY' and p."createdAt" >= ${istStart};`,
    ));
    const dbCashRefunds = Number(await psql(
      `select coalesce(sum(r.amount),0) from "Refund" r join "Order" o on o.id = r."orderId" where o."companyId" = '${companyId}' and o."branchId" = '${branches[0].id}' and r.status = 'SUCCEEDED' and coalesce(r.channel,'MANUAL') <> 'GATEWAY' and r."createdAt" >= ${istStart};`,
    ));
    (near(prev.cashSales, dbCashSales) && near(prev.cashRefunds, dbCashRefunds) && near(prev.expectedCash, dbCashSales - dbCashRefunds))
      ? pass('4.4', 'day-close preview reconciles with recorded cash', `expected ₹${prev.expectedCash} = cash ₹${dbCashSales} − refunds ₹${dbCashRefunds}`)
      : fail('4.4', 'day-close preview reconciles with recorded cash', `preview ₹${prev.cashSales}/₹${prev.cashRefunds}/₹${prev.expectedCash} vs db ₹${dbCashSales}/₹${dbCashRefunds}`);
  }

  const dcCashPrev = await call('GET', '/reports/day-close/preview', { token: cashA });
  const dcCashPost = await call('POST', '/reports/day-close', { token: cashA, body: { countedCash: 0 } });
  (dcCashPrev.status === 200 && dcCashPost.status === 403)
    ? pass('4.5', 'cashier may preview the drawer but not commit the closing', `preview ${dcCashPrev.status}, close ${dcCashPost.status}`)
    : fail('4.5', 'cashier may preview the drawer but not commit the closing', `preview ${dcCashPrev.status}, close ${dcCashPost.status}`);

  // ===== 5. Cancellation and refund permissions =========================

  const cashierRefund = await call('POST', `/orders/${orderId}/refunds`, { token: cashA, body: { amount: 10, reason: 'UAT permission probe' } });
  (cashierRefund.status === 403)
    ? pass('5.1', 'cashier cannot issue a refund', `HTTP ${cashierRefund.status}`)
    : fail('5.1', 'cashier cannot issue a refund', `HTTP ${cashierRefund.status}`);

  const cashierVoid = await call('POST', `/orders/${orderId}/void`, { token: cashA, body: { reason: 'UAT permission probe' } });
  (cashierVoid.status === 403)
    ? pass('5.2', 'cashier cannot void a billed order', `HTTP ${cashierVoid.status}`)
    : fail('5.2', 'cashier cannot void a billed order', `HTTP ${cashierVoid.status}`);

  const ownerRefund = await call('POST', `/orders/${orderId}/refunds`, { token: owner, body: { amount: 10, reason: 'UAT partial refund' } });
  const refundOk = ownerRefund.status === 200 || ownerRefund.status === 201;
  refundOk
    ? pass('5.3', 'owner can issue a partial refund', `HTTP ${ownerRefund.status}`)
    : fail('5.3', 'owner can issue a partial refund', `HTTP ${ownerRefund.status} ${JSON.stringify(ownerRefund.body).slice(0, 140)}`);

  if (refundOk) {
    const refundRows = Number(await psql(`select count(*) from "Refund" r join "Order" o on o.id = r."orderId" where o.id = '${orderId}';`));
    const repAfter = await call('GET', `/reports/sales?from=${today}&to=${today}`, { token: owner });
    const refundedInReport = money(repAfter.body?.summary?.refunded ?? repAfter.body?.totals?.refunded ?? NaN);
    if (Number.isNaN(refundedInReport)) {
      fail('5.4', 'the refund appears in the sales report', 'report exposes no refunded figure');
    } else {
      (refundRows === 1 && near(refundedInReport, 10))
        ? pass('5.4', 'the refund appears in the sales report', `₹${refundedInReport} refunded`)
        : fail('5.4', 'the refund appears in the sales report', `${refundRows} refund row(s), report says ₹${refundedInReport}`);
    }
  } else skip('5.4', 'the refund appears in the sales report', 'no refund was created');

  // ===== 6. Gateway =====================================================

  const gw = await call('POST', '/gateway/webhook', { body: {} });
  (gw.status === 404)
    ? skip('6.1', 'Razorpay checkout / webhook / refund on this deployment',
        'the gateway router is not mounted here (HTTP 404) — the feature is not deployed')
    : fail('6.1', 'gateway route state', `expected 404 on an undeployed gateway, got ${gw.status}`);

  // ===== 7. Print =======================================================

  const demoFlagged = rc?.company?.isDemo === true || rc?.isDemo === true;
  demoFlagged
    ? pass('7.1', 'receipt payload carries the demo flag that prints the DEMO banner')
    : fail('7.1', 'receipt payload carries the demo flag', 'isDemo not present in the receipt payload');

  const kots = await call('GET', `/orders/${orderId}/kots`, { token: cashA });
  (kots.status === 200 && (kots.body?.kots ?? []).length > 0)
    ? pass('7.2', 'KOT is retrievable for printing', `${(kots.body?.kots ?? []).length} ticket(s)`)
    : fail('7.2', 'KOT is retrievable for printing', `HTTP ${kots.status}`);

  skip('7.3', 'receipt/KOT layout on a physical thermal printer',
    'no printer is attached to this deployment; layout has only been checked in a browser');

  console.log('');
  console.log(`order used: ${bill?.invoiceNumber ?? orderId} (left in place as demo data, receipt prints the DEMO banner)`);
} catch (err) {
  fail('run', 'acceptance run completed', err?.message || String(err));
  exitCode = 1;
} finally {
  await cleanup();
  console.log('temporary UAT accounts deleted');
}

const f = results.filter((r) => r.state === 'FAIL').length;
const s = results.filter((r) => r.state === 'NOT TESTED').length;
const p = results.filter((r) => r.state === 'PASS').length;
console.log(`\n${p} PASS · ${f} FAIL · ${s} NOT TESTED  (${results.length} checks against ${BASE})`);
process.exit(f > 0 ? 1 : exitCode);
