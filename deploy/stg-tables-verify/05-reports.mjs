// Phase 5 — reports, day close and the activity log, against the DEPLOYED stack.
//
// THE DESIGN DECISION THAT MAKES THIS PHASE WORTH RUNNING. A report is the one
// thing in a POS that is trivially easy to test uselessly: assert 200, assert a
// number is a number, go green. That proves nothing — an aggregator that returns
// constants, or that silently drops a branch's takings, passes it.
//
// So every figure here is verified DIFFERENTIALLY. The report is read, a bill is
// put through the real till, the report is read again, and the DELTA is asserted
// to equal that bill to the paise. A frozen aggregator fails a delta; it cannot
// fail an "is a number" check. And each positive delta is paired with a negative
// control — a VOIDed bill that must move NOTHING — because a report that simply
// counted every order would also pass a delta test.
//
// Integer paise throughout, as in phases 2, 3 and 4.
import { api, check, note, summary, paise, rupees, loadJson } from './lib.mjs';

const tokens = loadJson('.tokens.json');
const MGR = tokens.BRANCH_MANAGER;
const CASHIER = tokens.CASHIER;
const OWNER = tokens.CUSTOMER_OWNER;
const ATC = tokens.POS_SUPER_ADMIN;

const me = (await api('/api/auth/me', { token: MGR })).body.user;
const branchId = me.branchId;
const companyId = me.companyId;

// The reports key on the IST business day (istDayStartUtc / istDateOf), so the
// harness must ask for the same day the app would file a bill under. Computing
// it in UTC would silently miss everything after 18:30 UTC.
const IST = () => new Date(Date.now() + 5.5 * 3600e3);
const TODAY = IST().toISOString().slice(0, 10);
note(`business day under test (IST): ${TODAY}`);

const products = (await api('/api/catalog/products', { token: MGR })).body.products;
const P1 = products.find((p) => Number(p.basePrice) > 0);
const P2 = products.find((p) => p.id !== P1.id && Number(p.basePrice) > 0);

const freeAll = async (label) => {
  const open = (await api('/api/orders?status=OPEN', { token: MGR })).body?.orders ?? [];
  let n = 0;
  for (const o of open) {
    const r = await api(`/api/orders/${o.id}/void`, {
      method: 'POST', token: MGR, body: { reason: `verify harness: ${label}` },
    });
    if (r.status === 200) n += 1;
  }
  return n;
};
note(`reset: voided ${await freeAll('phase 5 start')} leftover OPEN bills`);

const tables = async () => (await api('/api/tables', { token: MGR })).body.tables;
const freeTable = async () => (await tables()).find((t) => t.branchId === branchId && !t.currentOrder);
const readOrder = async (id, token = MGR) =>
  (await api(`/api/orders/${id}`, { token })).body?.order ?? null;

const salesReport = async (token = MGR) => {
  const r = await api(`/api/reports/sales?from=${TODAY}&to=${TODAY}`, { token });
  return { status: r.status, report: r.body?.report ?? null };
};
const preview = async (token = MGR) => {
  const r = await api(`/api/reports/day-close/preview?date=${TODAY}`, { token });
  return { status: r.status, preview: r.body?.preview ?? null, existing: r.body?.existingClose ?? null };
};

// Opens a bill, bills it, and settles it in one named tender.
const sellAndSettle = async (method, qty1 = 3, qty2 = 2) => {
  const tbl = await freeTable();
  if (!tbl) await freeAll('need a table for the report bill');
  const t = tbl ?? (await freeTable());
  const created = await api('/api/orders', {
    method: 'POST', token: CASHIER,
    body: { type: 'DINE_IN', tableId: t.id, items: [{ productId: P1.id, qty: qty1 }, { productId: P2.id, qty: qty2 }] },
  });
  const id = created.body?.order?.id;
  await api(`/api/orders/${id}/bill`, { method: 'POST', token: CASHIER, body: {} });
  const billed = await readOrder(id);
  const pay = await api(`/api/orders/${id}/payments`, {
    method: 'POST', token: CASHIER, body: { method, amount: Number(billed.total) },
  });
  return { order: await readOrder(id), payStatus: pay.status };
};

// ===========================================================================
// AUTHORITY
// ===========================================================================
note('--- who may read the books ---');
{
  const cashier = await api(`/api/reports/sales?from=${TODAY}&to=${TODAY}`, { token: CASHIER });
  check('CASHIER cannot read the sales report → 403', cashier.status === 403, `got ${cashier.status}`);

  const mgr = await salesReport(MGR);
  check('control: BRANCH_MANAGER can → 200, so that 403 is a permission and not a broken route',
    mgr.status === 200, mgr.status === 200 ? '' : `got ${mgr.status}`);

  // A cashier MAY see the drawer preview. That is deliberate and documented:
  // "a count made without knowing the expected figure is the only kind worth
  // having". Asserting it stops a later tightening from passing silently.
  const prev = await preview(CASHIER);
  check('but a CASHIER MAY read the day-close preview (they are the one counting the drawer)',
    prev.status === 200, prev.status === 200 ? '' : `got ${prev.status}`);
}

// ===========================================================================
// THE SALES REPORT, TIED OUT AGAINST A REAL BILL
// ===========================================================================
note('--- sales: the delta of a real bill, to the paise ---');
let cashBill = null;
{
  const b0 = await salesReport();
  check('the sales report renders for today → 200', b0.status === 200,
    b0.status === 200 ? '' : `got ${b0.status}`);
  check('  ...and it is scoped to this manager\'s branch, not the whole company',
    b0.report?.branchId === branchId, `branchId=${b0.report?.branchId}`);
  const s0 = b0.report.sales;
  note(`before: gross ${s0.grossItems}, discounts ${s0.discounts}, tax ${s0.tax}, net ${s0.netSales}, collected ${s0.collected}`);

  const sold = await sellAndSettle('CASH');
  cashBill = sold.order;
  check('put a CASH bill through the real till and settle it → PAID',
    cashBill?.status === 'PAID', `status=${cashBill?.status} pay=${sold.payStatus}`);
  note(`the bill: subtotal ${cashBill.subtotal}, tax ${cashBill.taxAmount}, total ${cashBill.total}`);

  const b1 = await salesReport();
  const s1 = b1.report.sales;

  // The four deltas that have to move by exactly this bill.
  const d = (k) => paise(s1[k]) - paise(s0[k]);
  check(`grossItems moved by exactly the bill's subtotal (${cashBill.subtotal})`,
    d('grossItems') === paise(cashBill.subtotal), `delta=${rupees(d('grossItems'))}`);
  check(`tax moved by exactly the bill's tax (${cashBill.taxAmount})`,
    d('tax') === paise(cashBill.taxAmount), `delta=${rupees(d('tax'))}`);
  check(`collected moved by exactly what was tendered (${cashBill.total})`,
    d('collected') === paise(cashBill.total), `delta=${rupees(d('collected'))}`);

  // CORRECTION, RECORDED RATHER THAN QUIETLY FIXED. A first draft asserted
  // netSales moved by `subtotal − discount` and got one red. The app is right:
  // `netSales += order.total` (reports.js:113), so netSales is the sum of order
  // TOTALS and therefore INCLUDES tax. The delta is the bill's total.
  check(`netSales moved by exactly the bill's total (${cashBill.total}) — netSales is tax-inclusive`,
    d('netSales') === paise(cashBill.total), `delta=${rupees(d('netSales'))}`);

  // The standing identity between the six totals, which has to hold on every
  // read and not just on this delta.
  const identity = paise(s1.netSales) === paise(s1.grossItems) - paise(s1.discounts) + paise(s1.tax);
  check('netSales == grossItems − discounts + tax, to the paise, across the whole day', identity,
    identity ? '' : `${s1.grossItems} − ${s1.discounts} + ${s1.tax} ≠ ${s1.netSales}`);

  // The breakdowns must agree with the totals, or one of the two is decoration.
  // They are siblings of `sales`, not fields inside it — `sales` carries the six
  // totals only, and reading them from inside it produced three empty arrays.
  const byMethod = b1.report.byMethod ?? [];
  const methodSum = byMethod.reduce((a, m) => a + paise(m.amount), 0);
  check('byMethod sums to collected, so the breakdown and the total are the same money',
    methodSum === paise(s1.collected),
    methodSum === paise(s1.collected) ? '' : `byMethod=${rupees(methodSum)} collected=${s1.collected}`);
  const cashRow = byMethod.find((m) => m.method === 'CASH' && m.channel !== 'GATEWAY');
  check('  ...and the CASH tender is attributed to a CASH row, keyed by channel as well as method',
    !!cashRow, cashRow ? '' : JSON.stringify(byMethod).slice(0, 160));

  // byCategory accumulates `lineSubtotal` (reports.js:106), so it is NOT the
  // tax-inclusive netSales — comparing the two was my error. What it must do is
  // grow by this bill's subtotal, with every rupee attributed to a NAMED
  // category rather than to null.
  const cat0 = (b0.report.byCategory ?? []).reduce((a, c) => a + paise(c.amount), 0);
  const cat1 = (b1.report.byCategory ?? []).reduce((a, c) => a + paise(c.amount), 0);
  check(`byCategory grew by exactly the bill's subtotal (${cashBill.subtotal})`,
    cat1 - cat0 === paise(cashBill.subtotal), `delta=${rupees(cat1 - cat0)}`);
  const unnamed = (b1.report.byCategory ?? []).filter((c) => !c.name || !c.categoryId);
  check('  ...and no takings sit in an unnamed category', unnamed.length === 0,
    unnamed.length === 0 ? '' : JSON.stringify(unnamed).slice(0, 140));

  const orders = b1.report.orders;
  check('the order counts include this PAID bill', (orders?.paid ?? 0) >= 1, `paid=${orders?.paid}`);
}

// ===========================================================================
// THE NEGATIVE CONTROL — a VOIDed bill must move nothing
// ===========================================================================
note('--- the control: a voided bill must not appear in the takings ---');
{
  const b0 = await salesReport();
  const s0 = b0.report.sales;

  const tbl = await freeTable();
  const created = await api('/api/orders', {
    method: 'POST', token: CASHIER,
    body: { type: 'DINE_IN', tableId: tbl.id, items: [{ productId: P1.id, qty: 9 }] },
  });
  const id = created.body.order.id;
  const opened = await readOrder(id);
  note(`a bill of ${opened.total} is opened and then voided — it must be invisible to the money figures`);

  const v = await api(`/api/orders/${id}/void`, {
    method: 'POST', token: MGR, body: { reason: 'verify harness: the negative control' },
  });
  check('void the bill → 200', v.status === 200, v.status === 200 ? '' : `got ${v.status}`);

  const b1 = await salesReport();
  const s1 = b1.report.sales;
  const unmoved = ['grossItems', 'tax', 'netSales', 'collected']
    .every((k) => paise(s1[k]) === paise(s0[k]));
  check('NONE of gross / tax / net / collected moved for the voided bill',
    unmoved, unmoved ? '' :
      ['grossItems', 'tax', 'netSales', 'collected'].map((k) => `${k} ${s0[k]}→${s1[k]}`).join(' '));

  const orders = b1.report.orders;
  check('  ...but the void IS counted as a void, so it is visible rather than erased',
    (orders?.voided ?? 0) >= 1, `voided=${orders?.voided}`);
}

// ===========================================================================
// A REFUND MUST SHOW AS A REFUND, NOT AS A SMALLER SALE
// ===========================================================================
note('--- a refund reduces the drawer without rewriting the sale ---');
{
  const b0 = await salesReport();
  const s0 = b0.report.sales;

  const amount = 25;
  const r = await api(`/api/orders/${cashBill.id}/refunds`, {
    method: 'POST', token: MGR,
    body: { amount, method: 'CASH', reason: 'verify harness: refund tie-out' },
  });
  check(`refund ₹${amount} in cash against the settled bill → 200/201`, r.status < 300,
    r.status < 300 ? '' : `got ${r.status} ${JSON.stringify(r.body).slice(0,160)}`);

  const b1 = await salesReport();
  const s1 = b1.report.sales;
  check(`the refunds figure moved by exactly ₹${amount}`,
    paise(s1.refunds) - paise(s0.refunds) === paise(amount),
    `delta=${rupees(paise(s1.refunds) - paise(s0.refunds))}`);
  check('  ...and netSales did NOT move — a refund is not a rewritten sale',
    paise(s1.netSales) === paise(s0.netSales), `${s0.netSales} → ${s1.netSales}`);
  check('  ...and grossItems did not move either', paise(s1.grossItems) === paise(s0.grossItems),
    `${s0.grossItems} → ${s1.grossItems}`);
}

// ===========================================================================
// DAY CLOSE — the drawer, its variance, and the correction path
// ===========================================================================
note('--- day close ---');
{
  const p = await preview();
  check('the day-close preview renders → 200', p.status === 200, p.status === 200 ? '' : `got ${p.status}`);
  const pv = p.preview;
  note(`expected cash ${pv.expectedCash} (cash sales ${pv.cashSales} − cash refunds ${pv.cashRefunds}),` +
    ` card ${pv.cardSales}, upi ${pv.upiSales}, billed ${pv.ordersBilled}, open ${pv.openOrders}`);

  const drawerOk = paise(pv.expectedCash) === paise(pv.cashSales) - paise(pv.cashRefunds);
  check('expectedCash == cashSales − cashRefunds, to the paise', drawerOk,
    drawerOk ? '' : `${pv.cashSales} − ${pv.cashRefunds} ≠ ${pv.expectedCash}`);
  check('expectedCash is non-zero, so the assertion above is not comparing zeros',
    paise(pv.expectedCash) !== 0, `expectedCash=${pv.expectedCash}`);
  check('the preview states that it EXCLUDES the opening float (the likeliest honest-count error)',
    /excludes the opening float/i.test(String(pv.note ?? '')), String(pv.note ?? '').slice(0, 90));

  // ATC must not declare a café's cash. The route's requireRole omits
  // POS_SUPER_ADMIN by name, and the header says why: "an ATC operator
  // declaring a customer's cash would put ATC's name on a figure only the café
  // can know". A platform operator must name the tenant or it 400s first, so
  // the probe carries ?companyId=.
  const atc = await api(`/api/reports/day-close?companyId=${companyId}`, {
    method: 'POST', token: ATC,
    body: { date: TODAY, branchId, countedCash: Number(pv.expectedCash) },
  });
  check('ATC cannot file a day close → 403 (only the café may declare its own cash)',
    atc.status === 403, atc.status === 403 ? '' : `got ${atc.status} ${JSON.stringify(atc.body).slice(0,140)}`);

  const cash = await api('/api/reports/day-close', {
    method: 'POST', token: CASHIER,
    body: { date: TODAY, branchId, countedCash: Number(pv.expectedCash) },
  });
  check('a CASHIER cannot file a day close either → 403 (the count is theirs, the signature is not)',
    cash.status === 403, cash.status === 403 ? '' : `got ${cash.status}`);

  // A variance with no explanation must be refused. This is the assertion that
  // proves the guard exists at all; filing the exact figure afterwards proves
  // the refusal was about the note and not about the route.
  const off = await api('/api/reports/day-close', {
    method: 'POST', token: MGR,
    body: { date: TODAY, branchId, countedCash: Number(pv.expectedCash) + 100 },
  });
  check('a count that is ₹100 over with NO note is refused → 400', off.status === 400,
    off.status === 400 ? '' : `got ${off.status} ${JSON.stringify(off.body).slice(0,160)}`);
  check('  ...and the refusal names the amount and the direction, so the counter knows what to explain',
    /100\.00/.test(String(off.body?.error?.message ?? '')) && /over/i.test(String(off.body?.error?.message ?? '')),
    String(off.body?.error?.message ?? '').slice(0, 120));

  // Re-runnable: today may already be closed by an earlier run, and the route
  // correctly refuses a second unqualified filing. Chain through the correction
  // reference the way the UI does, and say so out loud so a reader knows which
  // path was taken.
  const prior = p.existing;
  if (prior) note(`today already has a closing (${prior.id}) — filing this one as a correction against it`);
  const exact = await api('/api/reports/day-close', {
    method: 'POST', token: MGR,
    body: {
      date: TODAY, branchId, countedCash: Number(pv.expectedCash), openingFloat: 0,
      ...(prior ? { correctsId: prior.id, note: 'verify harness: re-run, corrects the previous close' } : {}),
    },
  });
  check('the manager files a count that matches exactly → 201', exact.status === 201,
    exact.status === 201 ? '' : `got ${exact.status} ${JSON.stringify(exact.body).slice(0,180)}`);
  const close = exact.body?.close;
  check('  ...at zero variance', paise(close?.variance ?? close?.variancePaise ?? 1) === 0,
    `variance=${close?.variance}`);
  check('  ...recording WHO signed it', !!(close?.closedBy?.id || close?.closedById),
    JSON.stringify(close?.closedBy ?? close?.closedById ?? null));

  // A double-click must not file two contradictory records of the same evening.
  const twice = await api('/api/reports/day-close', {
    method: 'POST', token: MGR,
    body: { date: TODAY, branchId, countedCash: Number(pv.expectedCash) },
  });
  check('filing the same day again without a correction reference is refused → 409',
    twice.status === 409, twice.status === 409 ? '' : `got ${twice.status} ${JSON.stringify(twice.body).slice(0,160)}`);
  check('  ...and the refusal tells the operator to file a CORRECTION rather than just failing',
    /correction/i.test(String(twice.body?.error?.message ?? '')),
    String(twice.body?.error?.message ?? '').slice(0, 120));

  // The correction path, which must supersede rather than overwrite.
  const corr = await api('/api/reports/day-close', {
    method: 'POST', token: MGR,
    body: {
      date: TODAY, branchId, countedCash: Number(pv.expectedCash) + 50,
      note: 'verify harness: a deliberate ₹50 surplus, corrected against the first close',
      correctsId: close.id,
    },
  });
  check('a CORRECTION against the existing close is accepted → 201', corr.status === 201,
    corr.status === 201 ? '' : `got ${corr.status} ${JSON.stringify(corr.body).slice(0,180)}`);
  check('  ...carrying the ₹50 variance the note explains',
    paise(corr.body?.close?.variance ?? 0) === paise(50), `variance=${corr.body?.close?.variance}`);

  // And the superseded record must still be there. "A correction that hides
  // what it corrected is not an audit trail."
  // `includeSuperseded` is a z.enum(['true','false']) — the literal string, not
  // a 1. Sending `=1` was refused 400, correctly, and it was my query that was
  // wrong rather than the route.
  const hist = await api(
    `/api/reports/day-close?from=${TODAY}&to=${TODAY}&includeSuperseded=true`, { token: OWNER });
  const rows = hist.body?.closes ?? [];
  check('the superseded closing is still retrievable, so the correction did not erase it',
    hist.status === 200 && rows.length >= 2, `status=${hist.status} rows=${rows.length}`);
  check('  ...and it is flagged as superseded rather than silently identical to the live one',
    rows.some((c) => c.superseded === true), JSON.stringify(rows.map((c) => c.superseded)));

  const cur = await api(`/api/reports/day-close?from=${TODAY}&to=${TODAY}`, { token: OWNER });
  const curRows = cur.body?.closes ?? [];
  check('  ...while the default view shows only the current record per day',
    cur.status === 200 && curRows.length < rows.length, `default=${curRows.length} withSuperseded=${rows.length}`);
}

// ===========================================================================
// ACTIVITY LOG — the refund and the void must be findable
// ===========================================================================
note('--- activity log ---');
{
  const r = await api(`/api/reports/activity?from=${TODAY}&to=${TODAY}`, { token: MGR });
  check('the activity report renders → 200', r.status === 200, r.status === 200 ? '' : `got ${r.status}`);
  // The rows are at `events` (reports.js res.json → { range, byActor, events }).
  // `rows` was my guess and it produced an empty array, which then made three
  // assertions fail for the wrong reason entirely.
  const rows = r.body?.events ?? [];
  const actions = rows.map((x) => String(x.action ?? ''));
  check('  ...and it is not empty, after a phase that voided and refunded', rows.length > 0,
    rows.length ? '' : `n=${rows.length}`);
  check('the void this phase filed appears in it', actions.some((a) => /VOID/i.test(a)),
    actions.some((a) => /VOID/i.test(a)) ? '' : actions.slice(0, 12).join(','));
  check('the refund this phase filed appears in it', actions.some((a) => /REFUND/i.test(a)),
    actions.some((a) => /REFUND/i.test(a)) ? '' : actions.slice(0, 12).join(','));
  check('  ...each event naming the actor, which is the only thing that makes it a record',
    rows.every((x) => !!(x.actorEmail || x.actorName)),
    JSON.stringify(rows.slice(0, 2).map((x) => x.actorEmail ?? x.actorName)));
  check('  ...and byActor is present, so an owner can ask "who" without reading every row',
    Array.isArray(r.body?.byActor) || typeof r.body?.byActor === 'object',
    typeof r.body?.byActor);

  const cashier = await api(`/api/reports/activity?from=${TODAY}&to=${TODAY}`, { token: CASHIER });
  check('a CASHIER cannot read the activity log → 403 (it is the record OF them)',
    cashier.status === 403, `got ${cashier.status}`);
}

// ===========================================================================
// THE REPORTING MODULE'S OWN DASHBOARD
// ===========================================================================
note('--- the reporting module ---');
{
  const dash = await api('/api/reporting/dashboard', { token: MGR });
  check('the reporting dashboard renders → 200', dash.status === 200,
    dash.status === 200 ? '' : `got ${dash.status} ${JSON.stringify(dash.body).slice(0,140)}`);

  const cat = await api('/api/reporting/catalog', { token: MGR });
  check('the report catalog lists the reports this build ships → 200', cat.status === 200,
    cat.status === 200 ? '' : `got ${cat.status}`);
  const keys = (cat.body?.reports ?? cat.body?.catalog ?? []).map((x) => x.key ?? x.id);
  check('  ...and it is non-empty, so there is something to run', keys.length > 0, `n=${keys.length}`);

  if (keys.length) {
    const one = await api(`/api/reporting/reports/${keys[0]}?from=${TODAY}&to=${TODAY}`, { token: MGR });
    check(`running the first catalogued report (${keys[0]}) → 200`, one.status === 200,
      one.status === 200 ? '' : `got ${one.status} ${JSON.stringify(one.body).slice(0,160)}`);
  }

  const bogus = await api('/api/reporting/reports/not-a-real-report', { token: MGR });
  check('control: an unknown report key → 404, so the 200 above is a real lookup', bogus.status === 404,
    `got ${bogus.status}`);
}

note(`cleanup: voided ${await freeAll('phase 5 end')} bills`);

process.exit(summary('Phase 5 — sales report, day close, activity log') ? 1 : 0);
