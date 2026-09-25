// LANE reporting — end-to-end verification of the reporting surface over HTTP.
//
// This is not a unit test. It signs in as each seeded authority and asks the
// running API the questions a reviewer would ask, because the claims in the
// handover are about the deployed surface, not about the functions underneath
// it. Every check prints PASS or FAIL with the figures it compared, so a reader
// can disagree with the figure rather than having to trust the word.
//
//   REPORTING_VERIFY_BASE=http://127.0.0.1:5560/api \
//   POS_SEED_PASSWORD='<the one you seeded with>' node scripts/reporting-verify.mjs
//
// Run scripts/reporting-seed-demo.mjs against the same database first: several
// checks assert states only that dataset produces (a store that never traded, a
// part-paid bill, an after-midnight bill, a second tenant).
//
// WHY THE NEGATIVE CHECKS MATTER MOST
//
// A reporting layer fails safely-looking: a scope bug returns a number, and a
// number is believed. So the isolation checks do not merely assert "no error" —
// they assert that a store this user may not see is ABSENT from the answer, and
// they are run against a database that contains a second tenant with distinctive
// takings, so a leak has something recognisable to leak. A check that cannot
// fail is not evidence.

const BASE = process.env.REPORTING_VERIFY_BASE || 'http://127.0.0.1:5560/api';
const PW = process.env.POS_SEED_PASSWORD;
if (!PW) {
  console.error('Refusing: set POS_SEED_PASSWORD to the password the demo was seeded with.');
  process.exit(2);
}

let passes = 0;
const failures = [];
const notes = [];

const pass = (name, detail = '') => {
  passes += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail = '') => {
  failures.push(name);
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};
const check = (name, ok, detail = '') => (ok ? pass(name, detail) : fail(name, detail));
const note = (text) => {
  notes.push(text);
  console.log(`note  ${text}`);
};
const section = (title) => console.log(`\n=== ${title} ===`);

const login = async (email) => {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const body = await res.json();
  return { email, token: body.token, role: body.user.role, companyId: body.user.companyId };
};

const get = async (who, path, params = {}) => {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const started = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${who.token}` } });
  const ms = Date.now() - started;
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, ms, headers: res.headers };
};

const send = async (method, who, path, payload) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const patch = (who, path, payload) => send('PATCH', who, path, payload);
const post = (who, path, payload) => send('POST', who, path, payload);

const rupees = (v) => (v && typeof v === 'object' ? Number(v.amount) : Number(v ?? 0));
const paise = (v) => (v && typeof v === 'object' ? Number(v.paise) : null);
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------

const users = {};
for (const [key, email] of Object.entries({
  owner: 'owner@reporting.demo.local',
  finance: 'finance@reporting.demo.local',
  regional: 'regional.north@reporting.demo.local',
  manager: 'manager.cp@reporting.demo.local',
  auditor: 'auditor@reporting.demo.local',
  cashier: 'cashier.cp@reporting.demo.local',
  rival: 'owner@rival.demo.local',
})) {
  try {
    users[key] = await login(email);
  } catch (err) {
    console.error(`FATAL ${err.message}`);
    process.exit(2);
  }
}

section('who signed in');
for (const [k, u] of Object.entries(users)) console.log(`      ${k.padEnd(9)} ${u.role.padEnd(17)} ${u.email}`);

// Learn the store ids from the owner's own answer rather than from the seed, so
// this script verifies the API and not its own assumptions about the database.
const ownerDash = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
if (ownerDash.status !== 200) {
  console.error(`FATAL owner dashboard returned ${ownerDash.status}`);
  process.exit(2);
}
const storeByName = new Map(ownerDash.body.scope.stores.map((s) => [s.name, s]));
const byId = new Map(ownerDash.body.scope.stores.map((s) => [s.id, s]));
const find = (fragment) => [...storeByName.values()].find((s) => s.name.includes(fragment));
const cp = find('Connaught');
const cyberHub = find('Cyber Hub');
const bandra = find('Bandra');
const newTown = find('New Town');

// ===========================================================================
section('A. tenant and store isolation, by direct API request');

{
  const r = await get(users.cashier, '/reporting/dashboard', { preset: 'TODAY' });
  check('A1 cashier is refused the consolidated dashboard', r.status === 403,
    `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}
{
  const r = await get(users.cashier, '/reporting/reports/sales', { preset: 'TODAY' });
  check('A2 cashier is refused the sales report', r.status === 403,
    `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}
{
  const r = await get(users.manager, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name);
  check('A3 branch manager sees exactly their own store', r.status === 200 && names.length === 1 && names[0] === cp.name,
    `${names.length} store(s): ${names.join(', ')}`);
}
{
  // The attack: name another store explicitly in the query string.
  const r = await get(users.manager, '/reporting/reports/sales', { preset: 'THIS_MONTH', storeId: cyberHub.id });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name);
  const leaked = names.includes(cyberHub.name);
  check('A4 branch manager asking for another store by id does not receive it',
    !leaked && (r.status === 403 || names.every((n) => n === cp.name)),
    `HTTP ${r.status}, stores: ${names.join(', ') || '(none)'}`);
}
{
  const r = await get(users.regional, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name).sort();
  const westLeak = names.some((n) => n.includes('Bandra') || n.includes('Lower Parel'));
  check('A5 regional manager sees their region and not the other', r.status === 200 && !westLeak && names.length > 0,
    `${names.length} store(s): ${names.join(', ')}`);
}
{
  const r = await get(users.regional, '/reporting/reports/sales', { preset: 'THIS_MONTH', storeId: bandra.id });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name);
  check('A6 regional manager asking for an out-of-region store by id does not receive it',
    !names.includes(bandra.name),
    `HTTP ${r.status}, stores: ${names.join(', ') || '(none)'}`);
}
{
  // Cross-tenant, the decisive one: the other company's owner asks for one of
  // this company's stores by id, and asks with this company's scope header.
  const r = await get(users.rival, '/reporting/reports/sales', { preset: 'THIS_MONTH', storeId: cp.id });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name);
  check('A7 the other tenant cannot read this company\'s store by id',
    !names.includes(cp.name),
    `HTTP ${r.status}, stores: ${names.join(', ') || '(none)'}`);
}
{
  const r = await fetch(new URL(`${BASE}/reporting/dashboard?preset=THIS_MONTH`), {
    headers: { Authorization: `Bearer ${users.rival.token}`, 'x-pos-company': users.owner.companyId },
  });
  const body = await r.json().catch(() => null);
  const names = (body?.scope?.stores ?? []).map((s) => s.name);
  const leaked = names.some((n) => storeByName.has(n));
  check('A8 the other tenant cannot borrow this company via the scope header', !leaked,
    `HTTP ${r.status}, stores: ${names.join(', ') || '(none)'}`);
}
{
  const r = await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_MONTH' });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name);
  check('A9 this company cannot see the other tenant\'s store',
    !names.some((n) => n.includes('Kettle')),
    `stores: ${names.join(', ')}`);
}
{
  // Positive control for A7/A8: the rival CAN read its own store. Without this,
  // every cross-tenant pass above could be explained by a broken token.
  const r = await get(users.rival, '/reporting/reports/sales', { preset: 'THIS_MONTH' });
  const names = (r.body?.scope?.stores ?? []).map((s) => s.name);
  check('A10 positive control: the other tenant can read its own store',
    r.status === 200 && names.some((n) => n.includes('Kettle')),
    `HTTP ${r.status}, stores: ${names.join(', ') || '(none)'}`);
}
{
  const r = await get(users.finance, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const a = await get(users.auditor, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  check('A11 finance and auditor can read the consolidated dashboard',
    r.status === 200 && a.status === 200, `finance ${r.status}, auditor ${a.status}`);
}
{
  const r = await get(users.auditor, '/reporting/settings');
  const w = await patch(users.auditor, '/reporting/settings', { staleAfterMinutes: 240 });
  check('A12 auditor may read the reporting periods but not change them',
    r.status === 200 && w.status === 403, `read ${r.status}, write ${w.status}`);
}
{
  // The export is a separate route and a separate chance to forget the scope.
  const r = await get(users.manager, '/reporting/reports/sales/export', {
    preset: 'THIS_MONTH', format: 'csv', storeId: cyberHub.id,
  });
  const csv = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  check('A13 the CSV export enforces the same scope as the screen',
    !csv.includes(cyberHub.name), `HTTP ${r.status}, ${csv.length} bytes, Cyber Hub present: ${csv.includes(cyberHub.name)}`);
}

// ===========================================================================
section('B. periods, timezone and the business-day boundary');

const settings0 = (await get(users.owner, '/reporting/settings')).body;
console.log(`      settings: tz ${settings0.timezone}, cutoff ${settings0.businessDayCutoffMinutes}m, weekStart ${settings0.weekStartDay}, FY month ${settings0.financialYearStartMonth}, stale ${settings0.staleAfterMinutes}m`);

{
  const today = await get(users.owner, '/reporting/reports/sales', { preset: 'TODAY' });
  const lastMonth = await get(users.owner, '/reporting/reports/sales', { preset: 'LAST_MONTH' });
  check('B1 an in-progress period is marked partial and a finished one is not',
    today.body.period.partial === true && lastMonth.body.period.partial === false,
    `TODAY partial ${today.body.period.partial}, LAST_MONTH partial ${lastMonth.body.period.partial}`);
}
{
  const t = await get(users.owner, '/reporting/reports/sales', { preset: 'TODAY' });
  const y = await get(users.owner, '/reporting/reports/sales', { preset: 'YESTERDAY' });
  const noOverlap = t.body.period.from >= y.body.period.to;
  check('B2 today and yesterday do not overlap',
    noOverlap, `yesterday ends ${y.body.period.to}, today starts ${t.body.period.from}`);
}
{
  const r = await get(users.owner, '/reporting/reports/salesByPeriod', { preset: 'THIS_MONTH', grouping: 'DAY' });
  const bucketSum = r.body.rows.reduce((a, row) => a + (paise(row.netSales) ?? 0), 0);
  const total = paise(r.body.totals.netSales);
  check('B3 the daily buckets sum to the month total exactly, in paise',
    bucketSum === total, `${r.body.rows.length} days, Σ ${bucketSum} vs total ${total}`);
}
{
  const day = await get(users.owner, '/reporting/reports/salesByPeriod', { preset: 'THIS_MONTH', grouping: 'DAY' });
  const week = await get(users.owner, '/reporting/reports/salesByPeriod', { preset: 'THIS_MONTH', grouping: 'WEEK' });
  const month = await get(users.owner, '/reporting/reports/salesByPeriod', { preset: 'THIS_MONTH', grouping: 'MONTH' });
  const sums = [day, week, month].map((r) => r.body.rows.reduce((a, row) => a + (paise(row.netSales) ?? 0), 0));
  check('B4 regrouping the same window does not change the total',
    sums[0] === sums[1] && sums[1] === sums[2],
    `day ${sums[0]} / week ${sums[1]} / month ${sums[2]} (${day.body.rows.length}/${week.body.rows.length}/${month.body.rows.length} rows)`);
}
{
  // The boundary test proper. The seed writes one bill at 00:40 IST today. With
  // a midnight cutoff it belongs to today; with a 05:00 cutoff the same bill
  // belongs to yesterday, and nothing else in the dataset moves.
  const before = await get(users.owner, '/reporting/reports/sales', { preset: 'TODAY' });
  const beforeToday = paise(before.body.totals.netSales);
  const beforeY = paise((await get(users.owner, '/reporting/reports/sales', { preset: 'YESTERDAY' })).body.totals.netSales);

  const moved = await patch(users.owner, '/reporting/settings', { businessDayCutoffMinutes: 300 });
  if (moved.status !== 200) {
    fail('B5 moving the business-day cutoff re-cuts the day', `PATCH returned ${moved.status}`);
  } else {
    const after = await get(users.owner, '/reporting/reports/sales', { preset: 'TODAY' });
    const afterToday = paise(after.body.totals.netSales);
    const afterY = paise((await get(users.owner, '/reporting/reports/sales', { preset: 'YESTERDAY' })).body.totals.netSales);
    check('B5 moving the business-day cutoff re-cuts the day without editing a bill',
      afterToday !== beforeToday || afterY !== beforeY,
      `today ${inr(beforeToday / 100)} → ${inr(afterToday / 100)}, yesterday ${inr(beforeY / 100)} → ${inr(afterY / 100)}`);
    check('B6 the period stamp reports the cutoff it used',
      after.body.period.businessDayCutoffMinutes === 300 || after.body.period.cutoffMinutes === 300
      || JSON.stringify(after.body.period).includes('300'),
      `period: ${JSON.stringify(after.body.period)}`);
    await patch(users.owner, '/reporting/settings', { businessDayCutoffMinutes: settings0.businessDayCutoffMinutes });
    const restored = (await get(users.owner, '/reporting/settings')).body;
    check('B7 the cutoff is restored after the boundary test',
      restored.businessDayCutoffMinutes === settings0.businessDayCutoffMinutes,
      `back to ${restored.businessDayCutoffMinutes}m`);
  }
}
{
  const before = (await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_WEEK' })).body.period;
  const w = await patch(users.owner, '/reporting/settings', { weekStartDay: (settings0.weekStartDay + 3) % 7 });
  const after = (await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_WEEK' })).body.period;
  await patch(users.owner, '/reporting/settings', { weekStartDay: settings0.weekStartDay });
  check('B8 the week start moves the week window', w.status === 200 && before.from !== after.from,
    `${before.from} → ${after.from}`);
}
{
  const before = (await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_FINANCIAL_YEAR' })).body.period;
  const w = await patch(users.owner, '/reporting/settings', { financialYearStartMonth: settings0.financialYearStartMonth === 1 ? 7 : 1 });
  const after = (await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_FINANCIAL_YEAR' })).body.period;
  await patch(users.owner, '/reporting/settings', { financialYearStartMonth: settings0.financialYearStartMonth });
  check('B9 the financial-year start moves the year window', w.status === 200 && before.from !== after.from,
    `${before.from} → ${after.from}`);
}
{
  const r = await patch(users.owner, '/reporting/settings', { businessDayCutoffMinutes: 900 });
  check('B10 a cutoff past noon is refused rather than silently clamped', r.status === 400,
    `HTTP ${r.status} ${r.body?.error?.message ?? ''}`);
  const still = (await get(users.owner, '/reporting/settings')).body;
  check('B11 the refused write changed nothing',
    still.businessDayCutoffMinutes === settings0.businessDayCutoffMinutes,
    `cutoff is ${still.businessDayCutoffMinutes}m`);
}
{
  const r = await patch(users.owner, '/reporting/settings', { weekStartDay: 9 });
  check('B12 an impossible week start is refused, not clamped to a valid-looking day',
    r.status === 400, `HTTP ${r.status} ${r.body?.error?.message ?? ''}`);
}
{
  const r = await get(users.owner, '/reporting/reports/sales', { preset: 'CUSTOM', from: '2026-09-01', to: '2026-09-07' });
  check('B13 a custom range is honoured', r.status === 200 && r.body.period.from.startsWith('2026-09-01'),
    `${r.body?.period?.from} → ${r.body?.period?.to}`);
}
{
  const r = await get(users.owner, '/reporting/reports/sales', { preset: 'CUSTOM', from: '2026-09-30', to: '2026-09-01' });
  check('B14 a backwards custom range is refused', r.status === 400,
    `HTTP ${r.status} ${r.body?.error?.message ?? ''}`);
}
{
  const r = await get(users.owner, '/reporting/reports/sales', { preset: 'TODAY' });
  const c = r.body.comparison;
  check('B15 today is compared against the same elapsed time, and says so',
    Boolean(c?.note?.toLowerCase().includes('elapsed')), `note: ${c?.note ?? '(none)'}`);
}

// ===========================================================================
section('C. the consolidated total reconciles with the stores under it');

{
  const r = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const rows = r.body.rows;
  const sum = rows.reduce((a, row) => a + (paise(row.netSales) ?? 0), 0);
  const total = paise(r.body.totals.netSales);
  check('C1 the store rows sum to the company net sales, in paise',
    sum === total, `${rows.length} stores, Σ ${sum} vs total ${total}`);
}
{
  const r = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  for (const field of ['collected', 'dues', 'refunds']) {
    const sum = r.body.rows.reduce((a, row) => a + (paise(row[field]) ?? 0), 0);
    const total = paise(r.body.totals[field]);
    check(`C2 the store rows sum to company ${field}`, sum === total, `Σ ${sum} vs ${total}`);
  }
}
{
  // §4: "Recalculate consolidated ratios from total numerators and denominators.
  // Do not average store percentages."
  const r = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const rates = r.body.rows.map((row) => row.discountRatePercent).filter((v) => v !== null && v !== undefined);
  const mean = rates.length ? rates.reduce((a, v) => a + Number(v), 0) / rates.length : null;
  const shown = Number(r.body.totals.discountRatePercent);
  const recomputed = (paise(r.body.totals.discounts) / paise(r.body.totals.grossItems)) * 100;
  const matchesRecomputed = Math.abs(shown - recomputed) < 0.02;
  check('C3 the company discount rate is recomputed from the totals, not averaged',
    matchesRecomputed, `shown ${shown}%, recomputed ${recomputed.toFixed(4)}%, mean of ${rates.length} stores ${mean?.toFixed(4)}%`);
  if (matchesRecomputed && mean !== null && Math.abs(shown - mean) < 0.02) {
    note(`the mean of the store rates happens to equal the recomputed rate here (${mean.toFixed(4)}%), so C3 distinguishes them only by construction, not by the figures`);
  }
}
{
  // Per-store drill-down must equal that store's row in the comparison.
  const dash = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const row = dash.body.rows.find((x) => x.storeId === cp.id);
  const drill = await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_MONTH', storeId: cp.id });
  check('C4 a store row equals that store\'s own report, in paise',
    paise(row.netSales) === paise(drill.body.totals.netSales),
    `dashboard row ${paise(row.netSales)} vs drill-down ${paise(drill.body.totals.netSales)}`);
}
{
  const r = await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_MONTH' });
  const t = r.body.totals;
  const identity = paise(t.netSales) + paise(t.tax) === paise(t.invoiced);
  check('C5 net sales plus tax equals invoiced',
    identity, `${paise(t.netSales)} + ${paise(t.tax)} = ${paise(t.netSales) + paise(t.tax)} vs invoiced ${paise(t.invoiced)}`);
}
{
  // §3: "Keep invoice, payment, refund, settlement and stock-movement dates
  // separately explainable." The seed bills one order late on the day before
  // yesterday and settles it the next morning, so yesterday's sales and
  // yesterday's collections can only agree if one of them is wrong. Asserted on
  // YESTERDAY rather than TODAY because yesterday is a complete day whatever hour
  // this runs at — on TODAY the two figures legitimately coincide in the minutes
  // just after midnight, when nothing has been collected yet but the bill raised.
  const sales = await get(users.owner, '/reporting/reports/sales', { preset: 'YESTERDAY' });
  const coll = await get(users.owner, '/reporting/reports/collections', { preset: 'YESTERDAY' });
  const s = paise(sales.body.totals.invoiced);
  const c = paise(coll.body.totals.collected);
  check('C6 invoiced and collected are different numbers over the same day, and each says what it counts',
    s !== c && Boolean(sales.body.basis?.sales) && Boolean(coll.body.basis?.collections),
    `invoiced ${s} on "${sales.body.basis?.sales}", collected ${c} on "${coll.body.basis?.collections}"`);
}
{
  const r = await get(users.owner, '/reporting/reports/dues', { preset: 'THIS_MONTH' });
  check('C7 dues are non-zero, so a part-paid bill is visible rather than rounded away',
    paise(r.body.totals?.dues ?? r.body.rows.reduce?.((a, x) => a + (paise(x.dues) ?? 0), 0)) > 0,
    `dues ${JSON.stringify(r.body.totals?.dues)}`);
}
{
  const r = await get(users.owner, '/reporting/reports/refunds', { preset: 'THIS_MONTH' });
  const t = r.body.totals ?? {};
  check('C8 a pending refund is held apart from money actually returned',
    paise(t.refundsPending) > 0 && paise(t.refunds) !== paise(t.refundsPending),
    `returned ${paise(t.refunds)}, pending ${paise(t.refundsPending)}`);
}

// ===========================================================================
section('D. the screen, the drill-down and the export agree');

// Splits CSV far enough to compare it, quotes and CRLF included. The line ending
// matters: a trailing \r makes the LAST cell of every row differ from the payload
// by an invisible character, which reads as a column-order bug.
const csvCells = (csv) => csv.trim().split(/\r?\n/).map((line) => {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
});

{
  const json = await get(users.owner, '/reporting/reports/sales', { preset: 'THIS_MONTH' });
  const csv = await get(users.owner, '/reporting/reports/sales/export', { preset: 'THIS_MONTH', format: 'csv' });
  const rows = csvCells(String(csv.body));
  const headerRow = rows.find((r) => r[0] === json.body.columns[0].label);
  const jsonHeaders = json.body.columns.map((c) => c.label);
  check('D1 the CSV columns are the screen\'s columns, in order',
    Boolean(headerRow) && headerRow.slice(0, jsonHeaders.length).join('|') === jsonHeaders.join('|'),
    `csv: ${headerRow?.slice(0, 4).join(', ')}… | json: ${jsonHeaders.slice(0, 4).join(', ')}…`);

  const hi = rows.indexOf(headerRow);
  const bodyRows = rows.slice(hi + 1).filter((r) => r.length === headerRow.length && r[0] && r[0] !== 'Company total');
  check('D2 the CSV has one row per store the screen shows',
    bodyRows.length >= json.body.rows.length,
    `csv ${bodyRows.length} rows vs screen ${json.body.rows.length}`);

  // Cell-by-cell on the first store: the formatter on each side must agree.
  const first = json.body.rows[0];
  const csvFirst = bodyRows.find((r) => r[0] === first.storeName);
  let mismatch = null;
  if (csvFirst) {
    json.body.columns.forEach((c, i) => {
      if (mismatch) return;
      const v = first[c.key];
      let expected;
      if (v === null || v === undefined) expected = '';
      else if (c.type === 'money') expected = String(v.amount);
      else if (c.type === 'qty') expected = `${v.qty} ${v.unitLabel}`;
      else if (c.type === 'percent') expected = `${v}%`;
      else if (c.type === 'coverage') expected = String(v.note ?? v.state);
      else expected = String(v);
      if (String(csvFirst[i] ?? '').trim() !== expected.trim()) {
        mismatch = `${c.key}: csv "${csvFirst[i]}" vs payload "${expected}"`;
      }
    });
  }
  check('D3 every cell of the first store matches between payload and CSV',
    Boolean(csvFirst) && !mismatch, mismatch ?? `${json.body.columns.length} cells on "${first.storeName}"`);
}
{
  const filtered = await get(users.owner, '/reporting/reports/sales/export', {
    preset: 'THIS_MONTH', format: 'csv', storeId: cp.id,
  });
  const csv = String(filtered.body);
  check('D4 a filtered export contains the filtered store and not the others',
    csv.includes(cp.name) && !csv.includes(cyberHub.name),
    `${cp.name} present, ${cyberHub.name} present: ${csv.includes(cyberHub.name)}`);
  check('D5 the export states the period and filters it used',
    csv.includes('2026') && /period|Period/.test(csv), `${csv.split('\n').length} lines`);
}
for (const [format, sig, type] of [
  ['xlsx', 'PK', 'spreadsheet'],
  ['pdf', '%PDF', 'pdf'],
]) {
  const r = await fetch(new URL(`${BASE}/reporting/reports/sales/export?preset=THIS_MONTH&format=${format}`), {
    headers: { Authorization: `Bearer ${users.owner.token}` },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const head = buf.subarray(0, 4).toString('latin1');
  check(`D6 the ${format.toUpperCase()} export is a real ${type} file`,
    r.status === 200 && head.startsWith(sig) && buf.length > 500,
    `HTTP ${r.status}, ${buf.length} bytes, magic "${head.replace(/[^\x20-\x7e]/g, '.')}", type ${r.headers.get('content-type')}`);
}
{
  const r = await get(users.owner, '/reporting/reports/sales/export', { preset: 'THIS_MONTH', format: 'exe' });
  check('D7 an unknown export format is refused', r.status === 400,
    `HTTP ${r.status} ${r.body?.error?.message ?? ''}`);
}

// ===========================================================================
section('E. honest absence: unavailable, never recorded, stale, demo');

const catalog = (await get(users.owner, '/reporting/catalog')).body;
{
  const states = {};
  for (const r of catalog.reports) states[r.state] = (states[r.state] ?? 0) + 1;
  console.log(`      catalog: ${catalog.reports.length} reports — ${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const unbuildable = catalog.reports.filter((r) => !r.buildable);
  check('E1 every report the catalog cannot build carries a reason',
    unbuildable.every((r) => Boolean(r.note)), `${unbuildable.length} unbuildable, all noted: ${unbuildable.every((r) => Boolean(r.note))}`);
}
{
  const unbuildable = catalog.reports.filter((r) => !r.buildable);
  let bad = null;
  for (const r of unbuildable) {
    const res = await get(users.owner, `/reporting/reports/${r.key}`, { preset: 'THIS_MONTH' });
    const b = res.body;
    const reason = b.note ?? b.coverage?.note ?? null;
    if (b.available !== false || !reason) { bad = `${r.key}: available=${b.available}, reason=${reason ?? 'none'}`; break; }
    if (b.state === 'AVAILABLE') { bad = `${r.key} answers available=false while calling its state AVAILABLE`; break; }
    if (b.totals !== null) { bad = `${r.key} returned totals ${JSON.stringify(b.totals)} instead of none`; break; }
  }
  check('E2 an unavailable report answers "not measured", never a zero, and never calls itself available',
    !bad, bad ?? `checked all ${unbuildable.length} unbuildable reports`);
}
{
  const r = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const cov = r.body.coverage.stores[newTown.id];
  check('E3 a store that has never traded reads "never recorded", not zero sales',
    cov?.state === 'NEVER_RECORDED' && Boolean(cov.note),
    `${newTown.name}: ${cov?.state} — "${cov?.note}"`);
}
{
  const r = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const s = r.body.coverage.summary;
  check('E4 the coverage summary accounts for every store in scope',
    s.active + s.noActivity + s.neverRecorded + s.stale === s.total,
    JSON.stringify(s));
  const stale = Object.entries(r.body.coverage.stores).filter(([, c]) => c.state === 'STALE');
  check('E5 every stale store says how long it has been silent',
    stale.every(([, c]) => /\d+ minutes/.test(c.note ?? '')),
    stale.length ? `${stale.length} stale, e.g. ${byId.get(stale[0][0])?.name}: "${stale[0][1].note}"` : 'none stale right now');
  const finished = await get(users.owner, '/reporting/dashboard', { preset: 'LAST_MONTH' });
  check('E6 a finished period has no stale stores, because history cannot go stale',
    finished.body.coverage.summary.stale === 0,
    `LAST_MONTH stale ${finished.body.coverage.summary.stale}, partial ${finished.body.period.partial}`);
}
{
  const without = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const with_ = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH', includeDemo: 'true' });
  const a = paise(without.body.totals.netSales);
  const b = paise(with_.body.totals.netSales);
  check('E7 a demo store is left out of the company total by default and changes it when included',
    b > a && without.body.scope.stores.length < with_.body.scope.stores.length,
    `${without.body.scope.stores.length} stores ${inr(a / 100)} → ${with_.body.scope.stores.length} stores ${inr(b / 100)}`);
}
{
  const r = await get(users.owner, '/reporting/reports/consumption', { preset: 'THIS_MONTH' });
  const f = r.body.meta?.figures ?? [];
  const measured = f.filter((x) => x.measured).map((x) => x.key);
  const not = f.filter((x) => !x.measured).map((x) => x.key);
  check('E8 the five consumption figures are listed separately, with only the measured one claimed',
    f.length === 5 && measured.length === 1 && measured[0] === 'sold',
    `measured: ${measured.join(', ')} | not measured: ${not.join(', ')}`);
  // Not "there are no rows". The rows carry the one measured figure, and the
  // claim is about the other four: absent, and absent is `null`, because 0 would
  // say the shelves were counted and agreed with the recipes.
  const unmeasured = ['expected', 'physical', 'wastage', 'unexplained'];
  const zeroed = r.body.rows.flatMap((row) =>
    unmeasured.filter((k) => row[k] === 0 || row[k] === '0').map((k) => `${row.name}.${k}`));
  const nulled = r.body.rows.every((row) => unmeasured.every((k) => row[k] === null));
  check('E9 consumption reports no variance at all rather than a zero variance',
    zeroed.length === 0 && nulled && Boolean(r.body.coverage?.note)
      && (r.body.caveats ?? []).some((c) => /zero variance/i.test(c)),
    zeroed.length ? `zero-valued: ${zeroed.join(', ')}` :
      `${r.body.rows.length} rows, 4 unmeasured columns null in all of them`);
  check('E10 the menu quantities that ARE measured are shown',
    r.body.rows.length > 0 && r.body.rows.every((row) => Number(row.qty) > 0),
    `${r.body.rows.length} items sold`);
  // The check whose absence let a defect ship: the coverage note says the menu
  // quantities are "shown below", and for every export that sentence is only true
  // if they are in `rows`. While they sat in meta.soldQuantities the screen showed
  // 6 items and the CSV showed a bare header — a file that read as "nothing sold".
  const csv = await get(users.owner, '/reporting/reports/consumption/export', { preset: 'THIS_MONTH', format: 'csv' });
  const cells = csvCells(String(csv.body));
  const head = r.body.columns[0].label;
  const hi = cells.findIndex((row) => row[0] === head);
  const dataRows = hi === -1 ? [] : cells.slice(hi + 1).filter((row) => row.some((c) => String(c).trim()));
  check('E10b the export carries the same measured rows the screen shows',
    hi !== -1 && dataRows.length === r.body.rows.length,
    `${r.body.rows.length} rows on screen, ${dataRows.length} under "${head}" in the CSV`);
  // And the blanks are blank. A CSV cell holding 0 under "Unexplained" is the
  // fabricated reconciliation this report refuses to print.
  const csvZero = dataRows.filter((row) => row.slice(3).some((c) => String(c).trim() === '0'));
  check('E10c the four unmeasured columns are empty in the export, not zero',
    csvZero.length === 0,
    csvZero.length ? `${csvZero.length} rows carry a 0` : 'every unmeasured cell is empty');
}
{
  // §5: "Do not label food margin as net profit when required expenses such as
  // rent, salaries and utilities are absent."
  const all = JSON.stringify(catalog.reports);
  const offenders = catalog.reports.filter((r) => /net profit|profit after|bottom line/i.test(`${r.label} ${r.note ?? ''}`));
  check('E11 nothing in the catalog is labelled net profit',
    offenders.length === 0, offenders.map((o) => o.key).join(', ') || 'no report claims profit');
  // Named families rather than a regex over labels: a pattern that matches
  // nothing passes vacuously, which is how "we do not fabricate Swiggy figures"
  // becomes a check that never looked.
  const caps = catalog.capabilities ?? {};
  const providerBacked = ['loyalty', 'delivery', 'accounting', 'settlement'];
  const present = providerBacked.filter((k) => caps[k]);
  check('E13 the provider-backed families are all declared in the capability list',
    present.length === providerBacked.length,
    `declared: ${present.join(', ')}${present.length === providerBacked.length ? '' : ` — missing ${providerBacked.filter((k) => !caps[k]).join(', ')}`}`);
  const claiming = present.filter((k) => caps[k].state === 'AVAILABLE');
  check('E12 no provider-backed family claims to be available with nothing connected',
    claiming.length === 0,
    present.map((k) => `${k}=${caps[k].state}`).join(', '));
  check('E14 every provider-backed family explains what is missing',
    present.every((k) => Boolean(caps[k].note)),
    present.map((k) => `${k}: ${caps[k].note ? 'noted' : 'NO NOTE'}`).join(', '));
  check('E15 food margin is labelled a margin and carries the missing-expenses caveat',
    /margin/i.test(caps.profitability?.label ?? '')
    && /not net profit/i.test(caps.profitability?.caveat ?? caps.profitability?.note ?? ''),
    `${caps.profitability?.label} — "${caps.profitability?.caveat ?? caps.profitability?.note ?? '(none)'}"`);
}

// ===========================================================================
section('F. every report the catalog offers actually answers, and how fast');

{
  const timings = [];
  let broke = null;
  for (const r of catalog.reports.filter((x) => x.buildable)) {
    const res = await get(users.owner, `/reporting/reports/${r.key}`, { preset: 'THIS_MONTH' });
    timings.push([r.key, res.ms, res.status, Array.isArray(res.body?.rows) ? res.body.rows.length : '-']);
    if (res.status !== 200) broke = `${r.key} returned ${res.status}`;
  }
  check('F1 every buildable report returns 200 for the owner', !broke, broke ?? `${timings.length} reports`);
  timings.sort((a, b) => b[1] - a[1]);
  console.log('      slowest first, on the seeded volume:');
  for (const [key, ms, status, rows] of timings) console.log(`        ${String(ms).padStart(5)}ms  ${key.padEnd(20)} ${status}  ${rows} rows`);
  const worst = timings[0];
  check('F2 the slowest report is under 2s at this volume', worst[1] < 2000, `${worst[0]} ${worst[1]}ms`);
}
{
  const t0 = Date.now();
  const r = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_FINANCIAL_YEAR' });
  const ms = Date.now() - t0;
  check('F3 the whole-year consolidated dashboard answers under 3s',
    r.status === 200 && ms < 3000, `${ms}ms over ${r.body?.scope?.stores?.length} stores`);
}
{
  const r = await get(users.owner, '/reporting/reports/nonsense', { preset: 'TODAY' });
  check('F4 an unknown report key is refused, not invented', r.status === 404 || r.status === 400,
    `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}
{
  const dash = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const targets = Object.values(dash.body.drilldown?.metrics ?? {});
  let broken = null;
  for (const href of targets) {
    const path = String(href).replace(/^\/api/, '');
    const res = await get(users.owner, path.split('?')[0], { preset: 'THIS_MONTH' });
    if (res.status !== 200) { broken = `${path} → ${res.status}`; break; }
  }
  check('F5 every drill-down the dashboard offers opens', !broken, broken ?? `${targets.length} metric links`);
}
{
  const dash = await get(users.manager, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const hrefs = (dash.body.drilldown?.stores ?? []).map((s) => s.href);
  check('F6 a branch manager is offered drill-downs only into their own store',
    hrefs.length === 1 && hrefs[0].includes(cp.id), `${hrefs.length} store link(s)`);
}

// ===========================================================================
section('H. scheduled reports: who may configure one, and what a run actually did');

// The schedule list carries two facts the form cannot show and a reader would
// otherwise assume: whether anything fires on its own in this deployment, and
// whether a given schedule has ever sent.
const schedList = await get(users.owner, '/reporting/schedules');
{
  const s = schedList.body?.scheduler;
  check('H1 the schedule list says whether the scheduler is running at all',
    schedList.status === 200 && typeof s?.enabled === 'boolean' && Boolean(s?.note),
    `enabled=${s?.enabled} — "${s?.note ?? ''}"`);
}
const schedules = schedList.body?.schedules ?? [];
const schedByState = (st) => schedules.find((s) => s.state === st);
{
  const states = schedules.map((s) => s.state).sort();
  check('H2 a draft, an active and a paused schedule are all distinguishable in the list',
    new Set(states).size === 3 && states.includes('DRAFT') && states.includes('ACTIVE') && states.includes('PAUSED'),
    states.join(', '));
}
{
  // BRANCH_MANAGER deliberately holds no schedule action at all. Asserted through
  // HTTP rather than by reading the grant table, because the grant table is what
  // the screen reads too, and a screen and a server agreeing about a bug is the
  // failure mode this check exists for.
  const r = await get(users.manager, '/reporting/schedules');
  check('H3 a branch manager cannot even list schedules', r.status === 403,
    `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}
{
  // AUDITOR holds every *.read — including report.schedule.read — and no write.
  // Scan, do not touch.
  const listed = await get(users.auditor, '/reporting/schedules');
  const written = await post(users.auditor, '/reporting/schedules', {
    name: `Auditor probe ${Date.now()}`, reportKey: 'sales', cadence: 'DAILY',
  });
  check('H4 an auditor may read the schedules and may not create one',
    listed.status === 200 && written.status === 403,
    `read ${listed.status}, write ${written.status} ${written.body?.error?.code ?? ''}`);
}
{
  // Finance can read the tax report, so it may schedule it. This is the positive
  // control for H6: without it, "a schedule you may not read is refused" would
  // pass on a build where every create is refused.
  //
  // A schedule cannot be deleted — its deliveries are the record of who received
  // which figures, and cascading those away to tidy up a test would destroy the
  // audit trail the approval list exists for. So this row is left behind under a
  // fixed name, and a second run of the harness is expected to be told the name is
  // taken. Both answers prove the same thing: the refusal in H6 is about authority,
  // not about creates being broken.
  const name = 'Verification probe — monthly tax (harness)';
  const r = await post(users.finance, '/reporting/schedules', {
    name, reportKey: 'tax', cadence: 'MONTHLY', dayOfMonth: 5,
  });
  const born = r.status === 201 && r.body?.state === 'DRAFT';
  const alreadyThere = r.status === 409;
  check('H5 a schedule for a report the creator may read is accepted, and born DRAFT',
    born || alreadyThere,
    born ? `HTTP 201, state ${r.body.state}` : `HTTP ${r.status} — "${r.body?.error?.message ?? ''}" (left by an earlier run)`);
  if (alreadyThere) note('H5 left a DRAFT schedule behind by design; a schedule cannot be deleted without destroying its delivery record.');
}
{
  // CASHIER holds no report action, so it cannot read the sales report — and must
  // not be able to reach it on a timer either. The interesting refusal is not the
  // 403 on the list but that the create path checks the REPORT's authority, not
  // just the schedule's.
  const r = await post(users.cashier, '/reporting/schedules', {
    name: `Cashier probe ${Date.now()}`, reportKey: 'sales', cadence: 'DAILY',
  });
  check('H6 a report you may not read cannot be scheduled', r.status === 403,
    `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}
{
  const r = await post(users.owner, '/reporting/schedules', {
    name: `Store scope probe ${Date.now()}`, reportKey: 'sales', cadence: 'DAILY',
    storeIds: [newTown.id, 'clnonexistentstoreid00000'],
  });
  check('H7 a schedule naming a store the creator cannot reach is refused',
    r.status === 404, `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}
{
  const r = await post(users.owner, '/reporting/schedules', {
    name: `Recipient probe ${Date.now()}`, reportKey: 'sales', cadence: 'DAILY',
    recipientIds: ['clnonexistentrecipient000'],
  });
  check('H8 a schedule can only name an approved, unrevoked address',
    r.status === 400 && /approved/i.test(r.body?.error?.message ?? ''),
    `HTTP ${r.status} — "${r.body?.error?.message ?? ''}"`);
}
{
  const revoked = (await get(users.owner, '/reporting/recipients')).body?.recipients ?? [];
  const gone = revoked.find((x) => x.revokedAt);
  const r = gone
    ? await post(users.owner, '/reporting/schedules', {
      name: `Revoked recipient probe ${Date.now()}`, reportKey: 'sales', cadence: 'DAILY',
      recipientIds: [gone.id],
    })
    : { status: null };
  check('H9 an address whose approval was withdrawn cannot be named by a new schedule',
    Boolean(gone) && r.status === 400,
    gone ? `${gone.email} → HTTP ${r.status}` : 'no revoked address in the dataset to try');
}
{
  const draft = schedByState('DRAFT');
  const r = draft ? await post(users.owner, `/reporting/schedules/${draft.id}/run`, {}) : { status: null };
  check('H10 a draft cannot be made to send — it has deliberately never sent anything',
    r.status === 400 && /draft/i.test(r.body?.error?.message ?? ''),
    `HTTP ${r.status} — "${r.body?.error?.message ?? ''}"`);
}

// The two runs that matter: the first produces a delivery, the second must produce
// the SAME one. "Scheduled retries do not duplicate deliveries" is §8's wording,
// and the only way to show it is to ask twice and compare the row.
const active = schedByState('ACTIVE');
let firstRun = null;
if (active) {
  firstRun = await post(users.owner, `/reporting/schedules/${active.id}/run`, {});
  check('H11 running an active schedule produces a delivery for a completed period',
    firstRun.status === 200 && Boolean(firstRun.body?.delivery) && Boolean(firstRun.body?.runKey),
    `runKey ${firstRun.body?.runKey ?? '—'}, status ${firstRun.body?.delivery?.status ?? '—'}`);

  const second = await post(users.owner, `/reporting/schedules/${active.id}/run`, {});
  check('H12 asking again for the same period does not send a second copy',
    second.status === 200
    && second.body?.deduplicated === true
    && second.body?.delivery?.id === firstRun.body?.delivery?.id,
    `deduplicated=${second.body?.deduplicated}, same row=${second.body?.delivery?.id === firstRun.body?.delivery?.id}, attempts ${second.body?.delivery?.attempts}`);

  const hist = await get(users.owner, `/reporting/schedules/${active.id}/deliveries`);
  const rows = hist.body?.deliveries ?? [];
  const forKey = rows.filter((d) => d.runKey === firstRun.body?.runKey);
  check('H13 the delivery history holds exactly one row for that period, not two',
    hist.status === 200 && forKey.length === 1, `${forKey.length} row(s) for ${firstRun.body?.runKey}`);

  const d = firstRun.body?.delivery;
  check('H14 a delivery names the mechanism that carried it rather than implying email',
    d?.transport === 'FILE' && Boolean(d?.artifact),
    `transport ${d?.transport ?? '—'}, artifact ${d?.artifact ?? 'none'}`);
  check('H15 the addresses written to and the ones withheld are both recorded',
    Array.isArray(d?.sentTo) && Array.isArray(d?.withheld),
    `sent to ${d?.sentTo?.length ?? 0}, withheld ${d?.withheld?.length ?? 0}`);
  // The rule the work order states outright: only approved TEST addresses may be
  // written to by a verification run. Every non-test address must appear in
  // `withheld`, and this asserts it against the approval list rather than trusting
  // the delivery's own account of itself.
  const approved = (await get(users.owner, '/reporting/recipients')).body?.recipients ?? [];
  const testAddrs = new Set(approved.filter((x) => x.isTestAddress).map((x) => x.email));
  const nonTestWritten = (d?.sentTo ?? []).filter((e) => !testAddrs.has(e));
  check('H16 nothing but an approved test address was written to',
    nonTestWritten.length === 0,
    nonTestWritten.length ? `wrote to ${nonTestWritten.join(', ')}` : `${(d?.sentTo ?? []).join(', ') || 'nothing'}`);
  check('H17 the delivery records the period it reported on, for later reconciliation',
    Boolean(d?.period?.from) && Boolean(d?.period?.to) && d.period.from <= d.period.to,
    `${d?.period?.from} to ${d?.period?.to}, ${d?.rowCount ?? '—'} rows, ${d?.bytes ?? '—'} bytes`);
} else {
  fail('H11 running an active schedule produces a delivery for a completed period', 'no ACTIVE schedule seeded');
}
{
  const r = await get(users.rival, '/reporting/schedules');
  const names = (r.body?.schedules ?? []).map((s) => s.name);
  const leaked = names.filter((n) => schedules.some((s) => s.name === n));
  check('H18 the other tenant sees none of these schedules',
    r.status === 200 && leaked.length === 0,
    `HTTP ${r.status}, ${names.length} of their own, ${leaked.length} of ours`);
}
if (active) {
  const r = await post(users.rival, `/reporting/schedules/${active.id}/run`, {});
  check('H19 the other tenant cannot make one of these schedules send',
    r.status === 404, `HTTP ${r.status} ${r.body?.error?.code ?? ''}`);
}

// ===========================================================================
section('I. the exception worklist: what ran, what did not, and who may close it');

const exc = await get(users.owner, '/reporting/exceptions', { preset: 'THIS_MONTH' });
{
  check('I1 the worklist opens with the seeded findings and their thresholds',
    exc.status === 200 && (exc.body?.exceptions ?? []).length > 0 && Boolean(exc.body?.thresholds),
    `${exc.body?.exceptions?.length ?? 0} open, ${Object.keys(exc.body?.thresholds ?? {}).length} thresholds declared`);
}
{
  // The claim §7 turns on. A detector that could not run reports `found: null` and
  // a reason — never 0 — because "no low-stock alerts" and "this build cannot see
  // stock" are different statements and an owner acts differently on each.
  const scan = await post(users.owner, '/reporting/exceptions/scan?preset=THIS_MONTH', {});
  const roll = scan.body?.detectors ?? [];
  const ran = roll.filter((d) => d.found !== null);
  const could0not = roll.filter((d) => d.found === null);
  check('I2 a scan reports every detector, including the ones that could not run',
    scan.status === 200 && roll.length === (exc.body?.kinds?.length ?? 0) && ran.length > 0 && could0not.length > 0,
    `${roll.length} detectors: ${ran.length} ran, ${could0not.length} could not`);
  check('I3 a detector that could not run reports no count and says why',
    could0not.every((d) => d.found === null && Boolean(d.note)),
    could0not.map((d) => d.kind).join(', '));
  // Runs its own second scan rather than treating the one above as the second
  // after the seed's. The first scan of a demo database is entitled to raise
  // findings that only became true since it was seeded: STALE_BRANCH_DATA is in
  // the TRANSIENT set precisely because it is a condition, not a historical
  // fact, so leaving the demo data alone for longer than staleAfterMinutes
  // (180) makes every store that traded that day legitimately go stale. Observed
  // 2026-09-25: the first scan raised 3, one per store that had been fresh when
  // the seed ran — the detector working. The dedup claim is about the PAIR, and
  // only the pair: whatever the first scan found, the scan immediately after it
  // must add nothing.
  const again = await post(users.owner, '/reporting/exceptions/scan?preset=THIS_MONTH', {});
  check('I4 a scan immediately repeated raises nothing new',
    again.status === 200 && again.body?.raised === 0 && again.body?.refreshed >= 0,
    `first raised ${scan.body?.raised}, repeat raised ${again.body?.raised}, ` +
      `refreshed ${again.body?.refreshed}, cleared ${again.body?.cleared}`);
}
{
  const rows = exc.body?.exceptions ?? [];
  check('I5 every finding names the role expected to act and the basis it was raised on',
    rows.length > 0 && rows.every((e) => Boolean(e.responsibleRole) && Boolean(e.detail?.basis)),
    `${rows.length} rows, roles: ${[...new Set(rows.map((e) => e.responsibleRole))].join(', ')}`);
  const kitchen = rows.filter((e) => e.kind === 'DELAYED_KITCHEN_ORDER');
  check('I6 an item still waiting is graded above one that went out late',
    kitchen.some((e) => e.severity === 'CRITICAL' && e.detail?.stillWaiting === true)
    && kitchen.some((e) => e.severity === 'WARNING' && e.detail?.stillWaiting === false),
    kitchen.map((e) => `${e.severity}/${e.detail?.stillWaiting ? 'waiting' : 'served'}`).join(', '));
  const cash = rows.filter((e) => e.kind === 'CASH_DIFFERENCE');
  check('I7 a cash difference is due from when the drawer was counted, not from the scan',
    cash.length > 0 && cash.every((e) => Boolean(e.dueAt)),
    cash.map((e) => `${e.detail?.businessDate} due ${String(e.dueAt).slice(0, 10)}`).join(', '));
}
{
  const r = await get(users.manager, '/reporting/exceptions', { preset: 'THIS_MONTH' });
  const outside = (r.body?.exceptions ?? []).filter((e) => e.branchId && e.branchId !== cp.id);
  check('I8 a branch manager sees findings for their own store and no other',
    r.status === 200 && outside.length === 0,
    `HTTP ${r.status}, ${r.body?.exceptions?.length ?? 0} row(s), ${outside.length} outside their store`);
}
{
  // AUDITOR can scan and cannot close: report.exception.resolve is the stronger
  // authority, and an auditor recording that a problem was dealt with would be the
  // auditor auditing themselves.
  const row = (exc.body?.exceptions ?? []).find((e) => e.status === 'OPEN');
  const scanned = await post(users.auditor, '/reporting/exceptions/scan?preset=THIS_MONTH', {});
  const closed = row
    ? await post(users.auditor, `/reporting/exceptions/${row.id}`, { status: 'RESOLVED' })
    : { status: null };
  check('I9 an auditor may look for exceptions and may not close one',
    scanned.status === 200 && closed.status === 403,
    `scan ${scanned.status}, close ${closed.status} ${closed.body?.error?.code ?? ''}`);
}
{
  const mine = (exc.body?.exceptions ?? []).find((e) => e.branchId && e.branchId !== cp.id);
  const r = mine
    ? await post(users.manager, `/reporting/exceptions/${mine.id}`, { status: 'RESOLVED' })
    : { status: null };
  check('I10 a manager cannot close a finding belonging to a store they do not hold',
    Boolean(mine) && r.status === 404,
    mine ? `${mine.kind} at ${mine.storeName} → HTTP ${r.status}` : 'no out-of-reach finding to try');
}
{
  const row = (exc.body?.exceptions ?? []).find((e) => e.status === 'OPEN');
  const r = row ? await post(users.owner, `/reporting/exceptions/${row.id}`, { status: 'DISMISSED' }) : { status: null };
  check('I11 dismissing a finding without a reason is refused',
    r.status === 400 && /reason|note/i.test(r.body?.error?.message ?? ''),
    `HTTP ${r.status} — "${r.body?.error?.message ?? ''}"`);
}
{
  const r = await get(users.rival, '/reporting/exceptions', { preset: 'THIS_MONTH' });
  const ours = new Set((exc.body?.exceptions ?? []).map((e) => e.id));
  const leaked = (r.body?.exceptions ?? []).filter((e) => ours.has(e.id));
  check('I12 the other tenant sees none of these findings',
    r.status === 200 && leaked.length === 0,
    `HTTP ${r.status}, ${r.body?.exceptions?.length ?? 0} of their own, ${leaked.length} of ours`);
}
{
  // Both numbers have to describe the same moment. `exc` at the top of this
  // section was read BEFORE the scans in I2–I4, so comparing against it measured
  // the order of the lines in this file rather than the agreement of two
  // endpoints: any scan that raised anything made it fail, and on 2026-09-25 one
  // legitimately did (dashboard 13 against a worklist snapshot of 10, the
  // difference being exactly the 3 the scan had just raised). Re-read the
  // worklist here.
  const dash = await get(users.owner, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const nowList = await get(users.owner, '/reporting/exceptions', { preset: 'THIS_MONTH' });
  const s = dash.body?.exceptions;
  const open = (nowList.body?.exceptions ?? []).length;
  check('I13 the dashboard band and the worklist agree on how many need action',
    Number(s?.open ?? -1) === open, `dashboard ${s?.open}, worklist ${open}`);
  check('I14 the dashboard band names the checks that could not run rather than implying a clear estate',
    Array.isArray(s?.undetectable) && s.undetectable.length > 0,
    `${s?.undetectable?.length ?? 0} undetectable: ${(s?.undetectable ?? []).map((u) => u.kind).join(', ')}`);
  const cashierDash = await get(users.cashier, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  check('I15 a reader without exception access gets no preview of rows they may not open',
    cashierDash.status === 403 || cashierDash.body?.exceptions === null,
    `HTTP ${cashierDash.status}, exceptions ${JSON.stringify(cashierDash.body?.exceptions ?? null)}`);
}

// ---------------------------------------------------------------------------
const settingsEnd = (await get(users.owner, '/reporting/settings')).body;
section('G. the verification left the settings as it found them');
check('G1 timezone, cutoff, week start, FY month and stale threshold are unchanged',
  settingsEnd.timezone === settings0.timezone
  && settingsEnd.businessDayCutoffMinutes === settings0.businessDayCutoffMinutes
  && settingsEnd.weekStartDay === settings0.weekStartDay
  && settingsEnd.financialYearStartMonth === settings0.financialYearStartMonth
  && settingsEnd.staleAfterMinutes === settings0.staleAfterMinutes,
  `${settingsEnd.timezone}, ${settingsEnd.businessDayCutoffMinutes}m, week ${settingsEnd.weekStartDay}, FY ${settingsEnd.financialYearStartMonth}, stale ${settingsEnd.staleAfterMinutes}m`);

console.log(`\n${'='.repeat(64)}`);
console.log(`${passes} passed, ${failures.length} failed${notes.length ? `, ${notes.length} note(s)` : ''}`);
if (failures.length) {
  console.log('\nfailed:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
