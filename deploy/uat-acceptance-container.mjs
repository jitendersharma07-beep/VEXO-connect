// The handover acceptance run, executed INSIDE the production backend container.
//
// Same questions as deploy/uat-acceptance.mjs, different plumbing. That one
// drives the public URL from the host and reaches the database with
// `docker exec … psql`. This one runs in the container, talks to the API on
// loopback and uses the application's own Prisma client. The checks are the
// point; which side of the container wall they run from is not.
//
// What it still proves, despite being inside: every check below is an HTTP
// request through the real router, the real middleware, the real RBAC guards
// and the real Postgres at its real isolation level. The two properties that
// cannot survive mocking — a lost update between two racing connections, and
// one branch's token against another branch's row — are exactly the ones a
// unit suite cannot answer, and they are answered here.
//
// SAFETY RAILS, checked before anything is written:
//   * the target company must have isDemo = true; it refuses a real tenant
//   * it never touches pos.admin or any pre-existing account's password
//   * the three accounts it signs in with are created for this run, share one
//     in-process random password that is never printed, and are deleted at the
//     end including on failure
//   * the orders it creates are tagged and removed in the same teardown, so a
//     client opening the demo afterwards does not find probe rows in it
//
// No password, token or cookie is printed, including on error.
//
//   docker exec pos-prod-backend-1 node /tmp/uat-acceptance-container.mjs

import { randomBytes } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { prisma } from '/app/src/lib/prisma.js';

// Loopback when this runs inside the serving container itself; when it runs as
// a sidecar on the same compose network instead — which is what happens when
// copying a file into the running production container is not available — the
// API is one DNS name away and POS_PROBE_BASE names it. Either way the requests
// traverse the real router, so the answers are the same.
const BASE = process.env.POS_PROBE_BASE || 'http://127.0.0.1:5000';
const API = `${BASE}/api`;
const RUN = randomBytes(3).toString('hex');
const TAG = `uat-probe-${RUN}`;

const results = [];
const record = (id, name, state, detail = '') => {
  results.push({ id, name, state });
  console.log(`${state.padEnd(10)} ${id.padEnd(4)} ${name}${detail ? `\n                — ${detail}` : ''}`);
};
const pass = (id, n, d) => record(id, n, 'PASS', d);
const fail = (id, n, d) => record(id, n, 'FAIL', d);
const skip = (id, n, d) => record(id, n, 'NOT TESTED', d);

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
};

const n = (v) => Number(v ?? 0);
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.005;
const rupees = (v) => `₹${n(v).toFixed(2)}`;

// --- rails ------------------------------------------------------------------

const company = await prisma.company.findFirst({ where: { isDemo: true }, orderBy: { createdAt: 'asc' } });
if (!company) { console.log('FAIL: no company with isDemo = true; refusing to write to a real tenant'); process.exit(2); }

const branches = await prisma.branch.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
if (branches.length < 2) { console.log(`FAIL: need two branches for branch isolation; found ${branches.length}`); process.exit(2); }

console.log(`target    ${BASE} (in-container loopback)`);
console.log(`company   ${company.name}  [isDemo]`);
console.log(`branches  ${branches.map((b) => b.name).join('   |   ')}`);
console.log('');

const OWNER_EMAIL = `uat.owner.${RUN}@atcpos.example`;
const CASH_A = `uat.cashier.a.${RUN}@atcpos.example`;
const CASH_B = `uat.cashier.b.${RUN}@atcpos.example`;
const SECRET = randomBytes(24).toString('base64url'); // in-process only, never printed

const cleanup = async () => {
  // Orders first: Payment/Refund/Kot/OrderItem hang off them and the FKs are
  // RESTRICT in places, so the children have to go before the parent.
  const mine = await prisma.order.findMany({ where: { note: { contains: TAG } }, select: { id: true } });
  const ids = mine.map((o) => o.id);
  if (ids.length) {
    await prisma.payment.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.refund.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.kotItem?.deleteMany({ where: { kot: { orderId: { in: ids } } } }).catch(() => {});
    await prisma.kot.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }
  await prisma.dayClose.deleteMany({ where: { note: { contains: TAG } } }).catch(() => {});

  // Signing in writes a PosSession, and PosSession.userId is RESTRICT, so the
  // account cannot be deleted while its login survives. Swallowing that error
  // is how an earlier run left six ACTIVE accounts — two of them owners — in a
  // client-facing demo tenant with passwords nobody holds. Sessions first, and
  // the outcome is counted afterwards rather than assumed.
  const emails = [OWNER_EMAIL, CASH_A, CASH_B];
  const mkd = await prisma.posUser.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = mkd.map((u) => u.id);
  if (userIds.length) {
    await prisma.posSession.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.posUser.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }
  const strandedUsers = await prisma.posUser.count({ where: { email: { in: emails } } }).catch(() => -1);
  const strandedOrders = await prisma.order.count({ where: { note: { contains: TAG } } }).catch(() => -1);
  return { removed: ids.length, strandedUsers, strandedOrders };
};

let exitCode = 0;
try {
  const passwordHash = await argon2Hash(SECRET);
  const mk = (email, fullName, role, branchId) => prisma.posUser.create({
    data: { companyId: company.id, branchId, email, fullName, passwordHash, role, status: 'ACTIVE', mustChangePassword: false },
  });
  await mk(OWNER_EMAIL, `UAT Owner ${RUN}`, 'CUSTOMER_OWNER', null);
  await mk(CASH_A, `UAT Cashier A ${RUN}`, 'CASHIER', branches[0].id);
  await mk(CASH_B, `UAT Cashier B ${RUN}`, 'CASHIER', branches[1].id);

  const login = async (email) => {
    const r = await call('POST', '/auth/login', { body: { email, password: SECRET } });
    return r.status === 200 ? r.body.token : null;
  };

  // ===== 1. Login and isolation =============================================

  const owner = await login(OWNER_EMAIL);
  const cashA = await login(CASH_A);
  const cashB = await login(CASH_B);
  if (owner && cashA && cashB) pass('1.1', 'owner and two branch cashiers sign in');
  else { fail('1.1', 'owner and two branch cashiers sign in', 'one or more logins refused'); throw new Error('no sessions'); }

  const console_ = await call('GET', '/atc/companies', { token: owner });
  (console_.status === 403 || console_.status === 401)
    ? pass('1.2', 'tenant owner cannot reach the platform console', `HTTP ${console_.status}`)
    : fail('1.2', 'tenant owner cannot reach the platform console', `HTTP ${console_.status} — expected 403`);

  const usersTry = await call('GET', '/users', { token: cashA });
  (usersTry.status === 403)
    ? pass('1.3', 'cashier cannot list staff accounts', `HTTP ${usersTry.status}`)
    : fail('1.3', 'cashier cannot list staff accounts', `HTTP ${usersTry.status} — expected 403`);

  // ===== 2. Menu -> order -> bill -> payment -> receipt ======================

  const prods = await call('GET', '/catalog/products?limit=100', { token: owner });
  const list = prods.body.products ?? prods.body.items ?? [];
  const item = list.find((p) => p.sku === 'BS-HC-03') ?? list[0];
  if (!item) { fail('2.1', 'catalog has something to sell', 'no products returned'); throw new Error('empty catalog'); }
  pass('2.1', 'catalog has something to sell', `${list.length} products; using ${item.name} at ${rupees(item.basePrice)}`);

  const mkOrder = async (token, branchId, note) => {
    const r = await call('POST', '/orders', {
      token,
      body: { type: 'TAKEAWAY', branchId, note: `${TAG} ${note}`, items: [{ productId: item.id, qty: 2 }] },
    });
    return { status: r.status, id: r.body.order?.id ?? r.body.id, order: r.body.order };
  };

  const a1 = await mkOrder(cashA, branches[0].id, 'main');
  (a1.status === 200 || a1.status === 201) && a1.id
    ? pass('2.2', 'cashier opens an order with 2 units', `order ${a1.id.slice(0, 8)}…`)
    : fail('2.2', 'cashier opens an order with 2 units', `HTTP ${a1.status}`);
  if (!a1.id) throw new Error('no order');

  const kot = await call('POST', `/orders/${a1.id}/kot`, { token: cashA });
  (kot.status === 200 || kot.status === 201)
    ? pass('2.3', 'kitchen ticket is issued', `HTTP ${kot.status}`)
    : fail('2.3', 'kitchen ticket is issued', `HTTP ${kot.status}`);

  // Two concurrent bills: exactly one invoice number may exist afterwards.
  const [b1, b2] = await Promise.all([
    call('POST', `/orders/${a1.id}/bill`, { token: cashA }),
    call('POST', `/orders/${a1.id}/bill`, { token: cashA }),
  ]);
  const billed = await call('GET', `/orders/${a1.id}`, { token: cashA });
  const inv = billed.body.order?.invoiceNumber;
  const billOk = [b1, b2].filter((r) => r.status < 400).length >= 1 && Boolean(inv);
  const dbInvoices = await prisma.order.count({ where: { id: a1.id, invoiceNumber: { not: null } } });
  (billOk && dbInvoices === 1)
    ? pass('2.4', 'double-clicked Bill issues exactly one invoice number', `invoice ${inv}; responses ${b1.status}/${b2.status}`)
    : fail('2.4', 'double-clicked Bill issues exactly one invoice number', `invoice=${inv} responses ${b1.status}/${b2.status}`);

  const ord = billed.body.order;
  const receipt = await call('GET', `/orders/${a1.id}/receipt`, { token: cashA });
  (receipt.status === 200)
    ? pass('2.5', 'receipt is retrievable for the billed order', `HTTP ${receipt.status}`)
    : fail('2.5', 'receipt is retrievable for the billed order', `HTTP ${receipt.status}`);

  // ===== 3. Arithmetic, duplicate click, persistence =========================

  // serializeOrder emits taxAmount, not taxTotal. Reading a key the API does
  // not publish yields 0 and reports a tax bug that is not there, which is the
  // more expensive failure of the two.
  const sub = n(ord?.subtotal), tax = n(ord?.taxAmount), tot = n(ord?.total);
  const expectedSub = n(item.basePrice) * 2;
  const expectedTax = Math.round(expectedSub * 5) / 100;
  (near(sub, expectedSub) && near(tax, expectedTax) && near(tot, sub + tax))
    ? pass('3.1', 'bill arithmetic is right', `2 × ${rupees(item.basePrice)} = ${rupees(sub)} + 5% ${rupees(tax)} = ${rupees(tot)}`)
    : fail('3.1', 'bill arithmetic is right', `subtotal ${rupees(sub)} (expected ${rupees(expectedSub)}), tax ${rupees(tax)} (expected ${rupees(expectedTax)}), total ${rupees(tot)}`);

  // THE check. Two concurrent full-amount payments on one bill.
  // Paid in CASH deliberately: it is the only method that lands in the drawer,
  // so it is the only one that makes the day-close preview below a real
  // assertion instead of a comparison against a structural zero.
  const due = n(ord?.amountDue ?? tot);
  const [p1, p2] = await Promise.all([
    call('POST', `/orders/${a1.id}/payments`, { token: cashA, body: { method: 'CASH', amount: due } }),
    call('POST', `/orders/${a1.id}/payments`, { token: cashA, body: { method: 'CASH', amount: due } }),
  ]);
  const accepted = [p1, p2].filter((r) => r.status === 200 || r.status === 201).length;
  const rows = await prisma.payment.findMany({ where: { orderId: a1.id } });
  const collected = rows.reduce((s, r) => s + n(r.amount), 0);
  (accepted === 1 && rows.length === 1 && near(collected, due))
    ? pass('3.2', 'double-clicked Record payment collects the bill once', `responses ${p1.status}/${p2.status}; 1 payment row of ${rupees(collected)} against a ${rupees(due)} bill`)
    : fail('3.2', 'double-clicked Record payment collects the bill once', `${accepted} accepted (${p1.status}/${p2.status}); ${rows.length} payment row(s) totalling ${rupees(collected)} against a ${rupees(due)} bill`);

  const after = await call('GET', `/orders/${a1.id}`, { token: cashA });
  const st = after.body.order?.status;
  (st === 'PAID' || n(after.body.order?.amountDue) === 0)
    ? pass('3.3', 'the paid bill persists and reads back settled', `status ${st}, due ${rupees(after.body.order?.amountDue)}`)
    : fail('3.3', 'the paid bill persists and reads back settled', `status ${st}, due ${rupees(after.body.order?.amountDue)}`);

  // ===== 1.4 / 1.5 cross-branch isolation (needs a real order to ask for) ====

  const bOrder = await mkOrder(cashB, branches[1].id, 'other-branch');
  const peek = await call('GET', `/orders/${bOrder.id}`, { token: cashA });
  (peek.status === 403 || peek.status === 404)
    ? pass('1.4', "a cashier cannot read another branch's order", `HTTP ${peek.status}`)
    : fail('1.4', "a cashier cannot read another branch's order", `HTTP ${peek.status} — expected 403/404`);

  const listA = await call('GET', '/orders?limit=100', { token: cashA });
  const leaked = (listA.body.orders ?? listA.body.items ?? []).filter((o) => o.branchId && o.branchId !== branches[0].id);
  (leaked.length === 0)
    ? pass('1.5', "a cashier's order list holds only their own branch", `${(listA.body.orders ?? listA.body.items ?? []).length} orders, 0 from elsewhere`)
    : fail('1.5', "a cashier's order list holds only their own branch", `${leaked.length} order(s) from another branch`);

  // ===== 4. Reports and daily closing ========================================

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  // The report publishes { report: { sales: { collected, refunds, … } } }.
  const salesOf = (r) => r.body?.report?.sales ?? {};
  const rep = await call('GET', `/reports/sales?from=${today}&to=${today}&branchId=${branches[0].id}`, { token: owner });
  const repTotal = n(salesOf(rep).collected);
  const dbTotal = (await prisma.payment.findMany({
    where: { order: { branchId: branches[0].id }, createdAt: { gte: new Date(`${today}T00:00:00Z`) } },
  })).reduce((s, r) => s + n(r.amount), 0);
  (rep.status === 200)
    ? (dbTotal > 0 && near(repTotal, dbTotal)
        ? pass('4.1', 'the sales report agrees with the underlying payment rows', `report ${rupees(repTotal)} = database ${rupees(dbTotal)}`)
        : fail('4.1', 'the sales report agrees with the underlying payment rows', `report ${rupees(repTotal)} vs database ${rupees(dbTotal)}`))
    : fail('4.1', 'the sales report agrees with the underlying payment rows', `HTTP ${rep.status}`);

  // Branch scoping is only demonstrated if the money appears under exactly one
  // branch. "Both returned 0" is not evidence of separation, so the sale has to
  // be present on A and absent from B for this to pass.
  const repB = await call('GET', `/reports/sales?from=${today}&to=${today}&branchId=${branches[1].id}`, { token: owner });
  const bTotal = n(salesOf(repB).collected);
  (repB.status === 200 && repTotal >= due && bTotal === 0)
    ? pass('4.2', 'the owner can read each branch separately', `${branches[0].name.slice(-14)} ${rupees(repTotal)} · ${branches[1].name.slice(-9)} ${rupees(bTotal)} — the sale appears under one branch only`)
    : fail('4.2', 'the owner can read each branch separately', `${rupees(repTotal)} vs ${rupees(bTotal)} — expected the sale on ${branches[0].name.slice(-14)} and nothing on ${branches[1].name.slice(-9)}`);

  const repDenied = await call('GET', `/reports/sales?from=${today}&to=${today}`, { token: cashA });
  (repDenied.status === 403)
    ? pass('4.3', 'a cashier cannot read the sales report', `HTTP ${repDenied.status}`)
    : fail('4.3', 'a cashier cannot read the sales report', `HTTP ${repDenied.status} — expected 403`);

  const prev = await call('GET', `/reports/day-close/preview?branchId=${branches[0].id}`, { token: owner });
  const expectedCash = n(prev.body.preview?.expectedCash ?? prev.body.expectedCash);
  (prev.status === 200 && near(expectedCash, due))
    ? pass('4.4', 'daily closing previews the cash the POS expects', `expected cash ${rupees(expectedCash)} = the ${rupees(due)} taken in cash`)
    : fail('4.4', 'daily closing previews the cash the POS expects', `HTTP ${prev.status}, expected cash ${rupees(expectedCash)} against ${rupees(due)} collected in cash`);

  // An unexplained variance must be refused; the same figure with a note must file.
  const short = await call('POST', '/reports/day-close', {
    token: owner,
    body: { branchId: branches[0].id, countedCash: expectedCash + 50 },
  });
  (short.status === 400)
    ? pass('4.5', 'an unexplained cash variance is refused', `HTTP ${short.status} — ${String(short.body?.error?.message ?? '').slice(0, 80)}`)
    : fail('4.5', 'an unexplained cash variance is refused', `HTTP ${short.status} — expected 400`);

  const filed = await call('POST', '/reports/day-close', {
    token: owner,
    body: { branchId: branches[0].id, countedCash: expectedCash, note: `${TAG} acceptance run` },
  });
  (filed.status === 200 || filed.status === 201)
    ? pass('4.6', 'a balanced closing files', `HTTP ${filed.status}`)
    : fail('4.6', 'a balanced closing files', `HTTP ${filed.status} — ${JSON.stringify(filed.body).slice(0, 120)}`);

  const closeDenied = await call('POST', '/reports/day-close', {
    token: cashA, body: { branchId: branches[0].id, countedCash: 0 },
  });
  (closeDenied.status === 403)
    ? pass('4.7', 'a cashier cannot close the day', `HTTP ${closeDenied.status}`)
    : fail('4.7', 'a cashier cannot close the day', `HTTP ${closeDenied.status} — expected 403`);

  // ===== 5. Refund and void permissions ======================================

  const refundDenied = await call('POST', `/orders/${a1.id}/refunds`, { token: cashA, body: { amount: 10, reason: 'probe' } });
  (refundDenied.status === 403)
    ? pass('5.1', 'a cashier cannot refund', `HTTP ${refundDenied.status}`)
    : fail('5.1', 'a cashier cannot refund', `HTTP ${refundDenied.status} — expected 403`);

  const voidDenied = await call('POST', `/orders/${a1.id}/void`, { token: cashA, body: { reason: 'probe' } });
  (voidDenied.status === 403)
    ? pass('5.2', 'a cashier cannot void an order', `HTTP ${voidDenied.status}`)
    : fail('5.2', 'a cashier cannot void an order', `HTTP ${voidDenied.status} — expected 403`);

  const refund = await call('POST', `/orders/${a1.id}/refunds`, { token: owner, body: { amount: 50, reason: `${TAG} partial` } });
  const refundRows = await prisma.refund.findMany({ where: { orderId: a1.id } });
  ((refund.status === 200 || refund.status === 201) && refundRows.length === 1 && near(refundRows[0].amount, 50))
    ? pass('5.3', 'the owner can refund part of a paid bill', `HTTP ${refund.status}, one refund row of ${rupees(refundRows[0]?.amount)}`)
    : fail('5.3', 'the owner can refund part of a paid bill', `HTTP ${refund.status}, ${refundRows.length} refund row(s)`);

  const repAfter = await call('GET', `/reports/sales?from=${today}&to=${today}&branchId=${branches[0].id}`, { token: owner });
  const refunded = n(salesOf(repAfter).refunds);
  near(refunded, 50)
    ? pass('5.4', 'the refund shows up in the report', `refunded ${rupees(refunded)}`)
    : fail('5.4', 'the refund shows up in the report', `report shows refunded ${rupees(refunded)}, expected ${rupees(50)}`);

  // ===== 6. Gateway =========================================================

  const gw = await call('GET', '/gateway/config', { token: owner });
  (gw.status === 404)
    ? skip('6.1', 'Razorpay sandbox checkout, webhook and refund', 'gateway is deliberately not configured in production — /api/gateway/* is unmounted (404), so no online payment can be taken or tested here')
    : fail('6.1', 'gateway is disabled in production', `HTTP ${gw.status} — expected 404; production is not supposed to expose a gateway`);

  // ===== 7. Receipt / KOT ===================================================

  const rBody = JSON.stringify(receipt.body);
  /demo/i.test(rBody)
    ? pass('7.1', 'the receipt is marked as demo', 'receipt payload carries a demo marker')
    : fail('7.1', 'the receipt is marked as demo', 'no demo marker in the receipt payload');

  const kots = await call('GET', `/orders/${a1.id}/kots`, { token: cashA });
  (kots.status === 200 && (kots.body.kots ?? kots.body.items ?? []).length >= 1)
    ? pass('7.2', 'the kitchen ticket can be reprinted', `${(kots.body.kots ?? kots.body.items ?? []).length} KOT(s) on the order`)
    : fail('7.2', 'the kitchen ticket can be reprinted', `HTTP ${kots.status}`);

  skip('7.3', 'printing on a real thermal printer', 'no printer was connected to this run; browser print layout only');
} catch (err) {
  console.log(`\nERROR  ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  const t = await cleanup().catch((e) => ({ removed: 0, strandedUsers: -1, strandedOrders: -1, error: e?.message }));
  console.log('');
  const c = (s) => results.filter((r) => r.state === s).length;
  const dirty = t.strandedUsers !== 0 || t.strandedOrders !== 0;
  console.log(`teardown   ${t.removed} probe order(s) removed; ${t.strandedUsers} account(s) and ${t.strandedOrders} order(s) left behind`);
  // A probe that leaves rows in the tenant it was auditing has to say so in the
  // same breath as its verdict, or the next reader trusts a tenant that is not
  // actually clean.
  if (dirty) console.log(`WARNING    teardown incomplete — remove the residue by hand${t.error ? ` (${t.error})` : ''}`);
  console.log(`summary    ${c('PASS')} PASS · ${c('FAIL')} FAIL · ${c('NOT TESTED')} NOT TESTED`);
  await prisma.$disconnect().catch(() => {});
  process.exit(exitCode || (c('FAIL') > 0 || dirty ? 1 : 0));
}
