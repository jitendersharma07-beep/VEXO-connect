// LANE reporting — browser QA against the running demo stack.
//
// scripts/reporting-verify.mjs already interrogates the API. This drives the
// SCREEN, because the two can disagree and only one of them is what the owner
// looks at: a number can be correct in JSON and rendered into a column it does
// not belong to, a store a user may not see can be filtered by the server and
// still named in a dropdown, and a report the catalog calls unavailable can
// render an inviting empty table. Every screen captured here carries at least
// one assertion — a screenshot nobody asserted against is decoration.
//
// The UI values are read back out of the DOM and compared against the API's own
// JSON for the same request, so the check is "what the human sees equals what
// the server said", not "the page rendered without throwing".
//
// Usage (nothing is hardcoded; ports and credentials come from the caller):
//   QA_UI=http://127.0.0.1:5188 QA_API=http://127.0.0.1:5560/api \
//   QA_PASSWORD='…' QA_CHROME=~/.cache/ms-playwright/chromium-1117/chrome-linux/chrome \
//   node qa/reporting-browser-qa.mjs

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// puppeteer-core is a QA-only dependency and is not in this lane's
// package.json: adding it there would change a file three other lanes share,
// for a tool that never ships. It is resolved from wherever it already exists
// on this box instead, and QA_PUPPETEER overrides the search.
const puppeteerPath = [
  process.env.QA_PUPPETEER,
  join(process.cwd(), 'node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
  '/home/atc-noc/vexo-connect-x-lanes/vc105-ui/frontend/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
  '/home/atc-noc/vexo-connect-x-lanes/vc104-ui/frontend/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
  '/home/atc-noc/vexo-connect-x-lanes/main-merge/frontend/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
].find((p) => p && existsSync(p));
if (!puppeteerPath) {
  console.error('puppeteer-core not found. Set QA_PUPPETEER to its ESM entry point.');
  process.exit(2);
}
const puppeteer = (await import(pathToFileURL(puppeteerPath).href)).default;

const UI = process.env.QA_UI || 'http://127.0.0.1:5188';
const API = process.env.QA_API || 'http://127.0.0.1:5560/api';
const PASSWORD = process.env.QA_PASSWORD;
const CHROME = process.env.QA_CHROME;
const OUT = process.env.QA_OUT || join(process.cwd(), 'qa/screens/reporting');
const DOMAIN = process.env.QA_DOMAIN || 'reporting.demo.local';

if (!PASSWORD || !CHROME) {
  console.error('Set QA_PASSWORD and QA_CHROME.');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const USERS = {
  owner: `owner@${DOMAIN}`,
  finance: `finance@${DOMAIN}`,
  regional: `regional.north@${DOMAIN}`,
  manager: `manager.cp@${DOMAIN}`,
  auditor: `auditor@${DOMAIN}`,
  cashier: `cashier.cp@${DOMAIN}`,
  rival: 'owner@rival.demo.local',
};

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  results.push({ name, pass: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
};
// For a claim this dataset could not exercise. Recorded as skipped rather than
// passed: a check whose condition never arose has proved nothing, and counting it
// as a PASS in results.json is how a suite comes to report more evidence than it
// has.
const skipped = [];
const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`SKIP  ${name} — ${why}`);
};
const section = (t) => console.log(`\n=== ${t} ===`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

// A fresh context per user: pages in one browser share a cookie jar, so without
// this the manager and cashier checks would quietly reuse the owner's session
// and pass for the wrong reason — the single most dangerous false PASS here,
// since every isolation claim in the handover rests on these pages.
const newPage = async () => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.__errors = errors;
  if (process.env.QA_DEBUG) {
    page.on('console', (m) => console.log('  [console]', m.type(), m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)));
    page.on('response', (r) => {
      if (r.url().includes('/api/')) console.log('  [api]', r.status(), r.url().replace(UI, ''));
    });
  }
  return page;
};

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const login = async (page, email) => {
  await page.goto(`${UI}/login`, { waitUntil: 'networkidle0' });
  // The SPA probes /auth/me before it renders the form and React re-mounts the
  // inputs when that settles; typing into the pre-hydration DOM silently does
  // nothing, which is how a harness can "log in" to a login page. So wait for
  // the field, then verify the value actually stuck.
  await page.waitForSelector('input[type="email"]', { visible: true });
  await settle(600);
  await page.click('input[type="email"]');
  await page.type('input[type="email"]', email, { delay: 8 });
  await page.click('input[type="password"]');
  await page.type('input[type="password"]', PASSWORD, { delay: 8 });
  const typed = await page.$eval('input[type="email"]', (el) => el.value);
  if (typed !== email) throw new Error(`login form did not accept input (got "${typed}")`);
  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), { timeout: 20000 });
  } catch {
    const onScreen = await page.evaluate(() => document.body.innerText).catch(() => '');
    await page.screenshot({ path: join(OUT, `login-failed-${email.split('@')[0]}.png`) }).catch(() => {});
    throw new Error(`login did not leave /login for ${email}. Screen said:\n${onScreen.slice(0, 400)}`);
  }
  await settle(800);
  // The SPA holds its session in an httpOnly cookie, so there is nothing to read
  // out of localStorage. Taking the browser's own cookie is the stronger move
  // anyway: the direct API attempts below then run as EXACTLY the session the
  // screen is using, rather than as a second login that might differ.
  const jar = await page.cookies();
  const session = jar.find((c) => /session|token/i.test(c.name));
  if (!session) throw new Error(`no session cookie after login as ${email} (cookies: ${jar.map((c) => c.name).join(', ') || 'none'})`);
  return `${session.name}=${session.value}`;
};

const shots = [];
const shot = async (page, name, selectors = null) => {
  const path = join(OUT, `${name}.png`);
  let clip = null;
  if (selectors) {
    clip = await page.evaluate((sels) => {
      const boxes = sels.map((s) => document.querySelector(s)).filter(Boolean).map((el) => el.getBoundingClientRect());
      if (!boxes.length) return null;
      const pad = 12;
      const left = Math.min(...boxes.map((b) => b.left)) + window.scrollX - pad;
      const top = Math.min(...boxes.map((b) => b.top)) + window.scrollY - pad;
      const right = Math.max(...boxes.map((b) => b.right)) + window.scrollX + pad;
      const bottom = Math.max(...boxes.map((b) => b.bottom)) + window.scrollY + pad;
      return { x: Math.max(0, Math.round(left)), y: Math.max(0, Math.round(top)), width: Math.round(right - Math.max(0, left)), height: Math.round(bottom - Math.max(0, top)) };
    }, selectors);
    // A selector that did not match must not silently downgrade to a duplicate
    // full-page shot — that is exactly the failure this parameter exists to fix.
    if (!clip || clip.width < 1 || clip.height < 1) throw new Error(`shot("${name}") found none of its selectors: ${selectors.join(', ')}`);
  }
  await page.screenshot(clip ? { path, clip, captureBeyondViewport: true } : { path, fullPage: true });
  shots.push({ name, path });
  console.log(`        screenshot -> ${path}`);
};

const api = async (cookie, path, params = {}) => {
  const url = new URL(API.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// What a human sees in the report table, read out of the DOM.
const readTable = (page) =>
  page.evaluate(() => {
    const t = document.querySelector('[data-testid="report-table"]');
    if (!t) return null;
    const head = [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim());
    const rows = [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((td) => td.innerText.trim()));
    const foot = [...t.querySelectorAll('tfoot tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((td) => td.innerText.trim()));
    return { head, rows, foot };
  });

const bodyText = (page) => page.evaluate(() => document.body.innerText);

// A wide table inside a fixed card is the defect a passing test never sees.
const overflows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('table, [data-testid="report-table"]')]
      .map((el) => {
        let p = el.parentElement;
        while (p && getComputedStyle(p).overflowX === 'visible' && p !== document.body) p = p.parentElement;
        const host = p ?? document.body;
        return el.scrollWidth > host.clientWidth + 2 && getComputedStyle(host).overflowX === 'visible'
          ? { width: el.scrollWidth, host: host.clientWidth }
          : null;
      })
      .filter(Boolean));

const digits = (s) => (s ?? '').replace(/[^0-9]/g, '');

try {
  // =========================================================================
  section('1. the consolidated dashboard as the owner sees it');

  const owner = await newPage();
  const ownerToken = await login(owner, USERS.owner);

  // The preset must be in the URL. The screen's own default is TODAY, so a bare
  // /reporting compared against a THIS_MONTH API call compares two different
  // questions — and "₹17,534 contains the digits of ₹422,552" is false in a way
  // that looks like a rendering bug rather than a harness bug.
  await owner.goto(`${UI}/reporting?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="kpi-netSales"]', { timeout: 20000 });
  await settle(900);
  // Errors from before this point are the SPA's pre-login /auth/me probe, which
  // is a 401 by design. Only what this screen did counts.
  owner.__errors.length = 0;

  const dash = await api(ownerToken, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  // Every comparison below is "screen equals API". If the API call itself
  // failed, those comparisons stop being checks and start being coincidences —
  // a screen figure of ₹17,534 "contains" the digits of an API total of 0. So
  // establish the reference answer is real before comparing anything to it.
  check('1.0 the harness can ask the API as the same session the browser holds',
    dash.status === 200 && Array.isArray(dash.body?.rows) && dash.body.rows.length > 0
      && Number.isFinite(dash.body?.totals?.netSales?.paise),
    `HTTP ${dash.status}, ${dash.body?.rows?.length} store rows, net ${dash.body?.totals?.netSales?.paise} paise`);
  const kpis = await owner.evaluate(() =>
    Object.fromEntries(
      ['netSales', 'collected', 'orders', 'aov', 'dues', 'refunds', 'discounts', 'tax'].map((k) => {
        const el = document.querySelector(`[data-testid="kpi-${k}"]`);
        return [k, el ? el.innerText.replace(/\s+/g, ' ').trim() : null];
      }),
    ),
  );
  check('1.1 all eight headline figures are on the screen', Object.values(kpis).every(Boolean), Object.keys(kpis).filter((k) => !kpis[k]).join(', ') || 'netSales, collected, orders, aov, dues, refunds, discounts, tax');

  // Rupees on screen against paise in the payload: the screen is the claim.
  const netRupees = Math.round((dash.body?.totals?.netSales?.paise ?? 0) / 100);
  check('1.2 the net sales tile shows the figure the API computed',
    digits(kpis.netSales).includes(String(netRupees)),
    `screen "${kpis.netSales}" vs api ₹${netRupees} (${dash.body?.totals?.netSales?.paise} paise)`);

  const table = await readTable(owner);
  check('1.3 the location comparison table renders one row per store in scope',
    table && table.rows.length === (dash.body?.rows?.length ?? -1),
    `screen ${table?.rows.length} rows vs api ${dash.body?.rows?.length}`);

  // Case-insensitively: the header is upper-cased in CSS, and innerText honours
  // text-transform. The claim is about order and identity, not letter case.
  const upper = (a) => a.map((s) => s.toUpperCase());
  check('1.4 the table header is the API\'s column list, in order',
    table && JSON.stringify(upper(table.head.slice(0, dash.body.columns.length))) === JSON.stringify(upper(dash.body.columns.map((c) => c.label))),
    `screen: ${table?.head.slice(0, 4).join(', ')}… | api: ${dash.body?.columns?.slice(0, 4).map((c) => c.label).join(', ')}…`);

  // The consolidated total is the one figure a reader will act on, and averaging
  // store percentages is the classic way to get it wrong. §4 forbids it.
  const footCells = table?.foot?.[0] ?? [];
  check('1.5 the table carries a consolidated total row',
    footCells.length > 0 && digits(footCells.join(' ')).includes(String(netRupees)),
    footCells.length ? `total row: ${footCells.slice(0, 3).join(' | ')}` : 'no tfoot');

  const ownerText = await bodyText(owner);
  // storeName, not label: `r.label ?? r.name ?? ''` is undefined on these rows,
  // and `includes('')` is true for every string, so the check passed for every
  // store including ones that were not on the page at all.
  const apiStoreNames = (dash.body?.rows ?? []).map((r) => r.storeName);
  check('1.6 every store the API returned is named on the screen',
    apiStoreNames.length > 0 && apiStoreNames.every((n) => n && ownerText.includes(n)),
    `${apiStoreNames.length} stores: ${apiStoreNames.join(', ')}`);

  // §4 asks for stock variance, wastage and food cost on this dashboard. They
  // are not in this build, and the screen has to say so rather than show zero.
  const capPanel = await owner.$('[data-testid="capability-panel"]');
  const capText = capPanel ? await owner.evaluate((el) => el.innerText, capPanel) : '';
  check('1.7 the dashboard names what it cannot show, instead of showing zero',
    Boolean(capPanel) && /not part of this deployment|not connected|does not build/i.test(capText),
    capPanel ? `${capText.split('\n').filter(Boolean).length} lines, e.g. "${capText.split('\n').filter((l) => l.length > 30)[0]?.slice(0, 90)}"` : 'no capability panel');

  check('1.8 no wastage or food-cost figure is rendered as a zero',
    !/(Wastage|Food cost|Stock variance)\s*₹?\s*0(\.00)?\b/i.test(ownerText),
    'no zero-valued absent metric on screen');

  const ovf = await overflows(owner);
  check('1.9 nothing on the dashboard overflows its container', ovf.length === 0, ovf.length ? JSON.stringify(ovf[0]) : 'no horizontal overflow');

  check('1.10 the dashboard rendered with no console or page errors',
    owner.__errors.length === 0, owner.__errors.slice(0, 2).join(' | ') || 'clean');

  await shot(owner, '01-hq-dashboard-owner');
  await shot(owner, '01b-hq-kpis', ['[data-testid="kpi-netSales"]', '[data-testid="kpi-tax"]']);
  await shot(owner, '01c-hq-capability-panel', ['[data-testid="capability-panel"]']);

  // =========================================================================
  section('2. daily, weekly and monthly on the screen');

  const stamps = {};
  for (const [preset, label] of [['TODAY', 'Today'], ['THIS_WEEK', 'This Week'], ['THIS_MONTH', 'This Month'], ['LAST_MONTH', 'Last Month']]) {
    await owner.goto(`${UI}/reporting/salesByPeriod?preset=${preset}`, { waitUntil: 'networkidle0' });
    await owner.waitForSelector('[data-testid="period-stamp"]', { timeout: 20000 });
    await settle(800);
    const stamp = await owner.$eval('[data-testid="period-stamp"]', (el) => el.innerText.replace(/\s+/g, ' ').trim());
    const t = await readTable(owner);
    stamps[preset] = { stamp, rows: t?.rows.length ?? 0 };
    const res = await api(ownerToken, '/reporting/reports/salesByPeriod', { preset });
    check(`2.${preset} the ${label} view states its own window and matches the API row count`,
      t && t.rows.length === (res.body?.rows?.length ?? -1) && new RegExp(label.replace(/ /g, ' '), 'i').test(stamp),
      `stamp "${stamp.slice(0, 110)}" — ${t?.rows.length} rows vs api ${res.body?.rows?.length}`);
    await shot(owner, `02-salesByPeriod-${preset.toLowerCase()}`);
  }

  check('2.5 the four presets produced four different windows',
    new Set(Object.values(stamps).map((s) => s.stamp)).size === 4,
    Object.entries(stamps).map(([k, v]) => `${k}:${v.rows}r`).join(' '));

  // Grouping is the daily/weekly/monthly requirement proper: same window,
  // different buckets, same total.
  const grouped = {};
  for (const grouping of ['DAY', 'WEEK', 'MONTH']) {
    await owner.goto(`${UI}/reporting/salesByPeriod?preset=THIS_MONTH&grouping=${grouping}`, { waitUntil: 'networkidle0' });
    await owner.waitForSelector('[data-testid="report-table"]', { timeout: 20000 });
    await settle(700);
    const t = await readTable(owner);
    grouped[grouping] = { rows: t.rows.length, total: digits((t.foot?.[0] ?? []).join(' ')) };
    await shot(owner, `02b-grouping-${grouping.toLowerCase()}`);
  }
  check('2.6 regrouping the same month changes the bucket count but not the total',
    grouped.DAY.rows > grouped.WEEK.rows && grouped.WEEK.rows >= grouped.MONTH.rows
      && grouped.DAY.total === grouped.WEEK.total && grouped.WEEK.total === grouped.MONTH.total,
    `day ${grouped.DAY.rows} rows / week ${grouped.WEEK.rows} / month ${grouped.MONTH.rows}; totals ${grouped.DAY.total} = ${grouped.WEEK.total} = ${grouped.MONTH.total}`);

  // §3 asks today-so-far to be compared with the same elapsed period, and the
  // screen has to say which comparison it used or the number is unreadable.
  await owner.goto(`${UI}/reporting/salesByPeriod?preset=TODAY`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="period-stamp"]', { timeout: 20000 });
  await settle(700);
  const cmpNote = await owner.$eval('[data-testid="comparison-note"]', (el) => el.innerText.trim()).catch(() => '');
  check('2.7 today-so-far discloses that it is compared against the same elapsed time',
    /same elapsed/i.test(cmpNote), cmpNote ? `"${cmpNote}"` : 'no comparison note on screen');

  // =========================================================================
  section('3. the consumption screen keeps the five figures apart');

  await owner.goto(`${UI}/reporting/consumption?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
  await settle(1200);
  const consText = await bodyText(owner);
  const figuresPanel = await owner.$('[data-testid="consumption-figures"]');
  const figures = figuresPanel ? await owner.evaluate((el) => el.innerText, figuresPanel) : '';
  check('3.1 the five consumption figures are listed as separate things',
    Boolean(figuresPanel)
      && /sold|menu/i.test(figures) && /expected/i.test(figures)
      && /physical/i.test(figures) && /wastage/i.test(figures) && /unexplained/i.test(figures),
    figuresPanel ? figures.replace(/\s+/g, ' ').slice(0, 200) : 'no consumption-figures panel');

  check('3.2 the four unmeasured figures are labelled not measured, not shown as zero',
    !/unexplained\s*variance\s*:?\s*0\b/i.test(consText) && /not measured|not recorded|no count|not part of this deployment/i.test(consText),
    'no zero variance rendered');

  // Counted off the same table every other report renders, because that is the
  // one the exports are built from. The previous form read a bespoke table and
  // compared its length against `body.sold ?? body.soldQuantities ?? soldRows` —
  // neither field existed, so it fell through to comparing soldRows with itself
  // and passed without ever looking. A vacuous check is how the screen and the
  // CSV came to disagree while this said 3.3 PASS.
  const soldTable = await owner.$('[data-testid="report-table"]');
  const soldRows = soldTable ? await owner.evaluate((el) => el.querySelectorAll('tbody tr').length, soldTable) : 0;
  const consApi = await api(ownerToken, '/reporting/reports/consumption', { preset: 'THIS_MONTH' });
  const apiRows = consApi.body?.rows?.length ?? -1;
  check('3.3 the menu quantities that ARE measured are shown on screen',
    soldRows > 0 && apiRows > 0 && soldRows === apiRows,
    `${soldRows} rows on screen, ${apiRows} from the API`);

  check('3.4 the consumption screen does not call a food margin a profit',
    !/net\s*profit/i.test(consText), 'no "net profit" on screen');

  await shot(owner, '03-consumption');
  await shot(owner, '03b-consumption-figures', ['[data-testid="consumption-figures"]']);

  // =========================================================================
  section('4. the report centre offers only what it can answer');

  await owner.goto(`${UI}/reporting/reports`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid^="report-card-"]', { timeout: 20000 });
  await settle(800);
  const cards = await owner.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="report-card-"]')].map((el) => ({
      key: el.dataset.testid.replace('report-card-', ''),
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || /pointer-events-none|opacity-/.test(el.className),
    })),
  );
  const catalog = await api(ownerToken, '/reporting/catalog');
  check('4.1 every report in the catalog has a card on the screen',
    cards.length === (catalog.body?.reports?.length ?? -1),
    `${cards.length} cards vs ${catalog.body?.reports?.length} catalog entries`);

  const unbuildable = (catalog.body?.reports ?? []).filter((r) => !r.buildable);
  // Assert the card carries the SERVER's own sentence, rather than matching a
  // phrasing this harness guessed at. A regex of expected wording fails when
  // the server says "No loyalty integration is part of this deployment" —
  // which is a reason, correctly given.
  const missingReason = unbuildable.filter((r) => {
    const card = cards.find((c) => c.key === r.key);
    return !card || !r.note || !card.text.includes(r.note);
  });
  check('4.2 every card the build cannot answer carries the server\'s own reason',
    unbuildable.length > 0 && missingReason.length === 0,
    missingReason.length ? `no reason on: ${missingReason.map((r) => r.key).join(', ')}` : `${unbuildable.length} unbuildable cards all carry a reason`);

  await shot(owner, '04-report-centre');

  // Opening an unavailable report must not look like a measured empty result.
  const dead = unbuildable[0]?.key;
  if (dead) {
    await owner.goto(`${UI}/reporting/${dead}?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
    await settle(1000);
    const deadPanel = await owner.$('[data-testid="report-unavailable"]');
    const deadText = await bodyText(owner);
    check(`4.3 opening an unavailable report (${dead}) explains itself instead of showing an empty table`,
      Boolean(deadPanel) && !/data-testid="report-table"/.test(await owner.content()),
      deadPanel ? `"${(await owner.evaluate((el) => el.innerText, deadPanel)).replace(/\s+/g, ' ').slice(0, 140)}"` : `no unavailable panel; screen said "${deadText.slice(0, 120)}"`);
    await shot(owner, '04b-report-unavailable');
  }

  // =========================================================================
  section('5. what each role can see on the screen, and cannot');

  // A store manager. The dangerous failure is not an error page — it is a
  // number from a store they may not see, which looks exactly like a correct
  // number.
  const mgr = await newPage();
  const mgrToken = await login(mgr, USERS.manager);
  await mgr.goto(`${UI}/reporting`, { waitUntil: 'networkidle0' });
  await settle(1400);
  const mgrText = await bodyText(mgr);
  const mgrTable = await readTable(mgr);
  const ownStore = 'Connaught Place';
  const foreign = ['Cyber Hub', 'Bandra West', 'Lower Parel', 'Kettle & Co Indiranagar'];
  const leaked = foreign.filter((s) => mgrText.includes(s));
  check('5.1 the branch manager sees their own store', mgrText.includes(ownStore), `"${ownStore}" present`);
  check('5.2 and no other store appears anywhere on their dashboard',
    leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${foreign.length} foreign stores absent`);
  check('5.3 their comparison table has exactly one row',
    (mgrTable?.rows.length ?? 0) === 1, `${mgrTable?.rows.length} row(s)`);
  await shot(mgr, '05-dashboard-manager');

  // Same question through the API with the manager's own token: a UI that
  // filters client-side would pass 5.2 and fail here, and that is the bug that
  // matters, because an export bypasses the screen entirely.
  const mgrApi = await api(mgrToken, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const mgrApiStores = (mgrApi.body?.rows ?? []).map((r) => r.storeName);
  check('5.4 the API gives the manager one store too, so the filtering is the server\'s',
    mgrApiStores.length === 1 && mgrApiStores[0] === ownStore,
    `api rows: ${JSON.stringify(mgrApiStores)}`);

  // Asking for another store explicitly is the attempt a screen cannot make.
  const otherStore = (dash.body?.rows ?? []).find((r) => r.storeName !== ownStore);
  check('5.5a the harness found another store to attempt', Boolean(otherStore?.storeId), otherStore?.storeName ?? 'none');
  if (otherStore?.storeId) {
    const grab = await api(mgrToken, '/reporting/dashboard', { preset: 'THIS_MONTH', storeId: otherStore.storeId });
    const grabbed = (grab.body?.rows ?? []).map((r) => r.storeName);
    check('5.5 naming another store in the request does not return it',
      grab.status === 403 || grab.status === 404 || (grabbed.length > 0 && grabbed.every((n) => n === ownStore)),
      `asked for "${otherStore.storeName}" → HTTP ${grab.status}, rows ${JSON.stringify(grabbed)}`);
  }

  // The regional manager: more than one store, fewer than all.
  const regional = await newPage();
  const regToken = await login(regional, USERS.regional);
  await regional.goto(`${UI}/reporting`, { waitUntil: 'networkidle0' });
  await settle(1400);
  const regTable = await readTable(regional);
  const regApi = await api(regToken, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  check('5.6 the regional manager sees several stores but not the whole company',
    (regTable?.rows.length ?? 0) > 1 && (regTable?.rows.length ?? 0) < (dash.body?.rows?.length ?? 0),
    `regional ${regTable?.rows.length} of company ${dash.body?.rows?.length}`);
  check('5.7 the regional screen and the regional API agree on the store list',
    (regTable?.rows.length ?? 0) === (regApi.body?.rows?.length ?? -1),
    `screen ${regTable?.rows.length} vs api ${regApi.body?.rows?.length}`);
  await shot(regional, '05b-dashboard-regional');

  // The auditor: may read, may not change the periods. A read-only role that
  // can still save settings is a quiet authorisation hole.
  const auditor = await newPage();
  const audToken = await login(auditor, USERS.auditor);
  await auditor.goto(`${UI}/reporting/settings`, { waitUntil: 'networkidle0' });
  await settle(1200);
  const audText = await bodyText(auditor);
  const audSaveDisabled = await auditor.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /save|apply|update/i.test(b.innerText));
    return btns.length === 0 || btns.every((b) => b.disabled);
  });
  check('5.8 the auditor can read the reporting settings', /timezone|business day|week start/i.test(audText), 'settings visible');
  check('5.9 but the screen offers them no way to save a change', audSaveDisabled, audSaveDisabled ? 'no enabled save control' : 'an enabled save button is on screen');
  const audWrite = await fetch(`${API.replace(/\/$/, '')}/reporting/settings`, {
    method: 'PATCH',
    headers: { cookie: audToken, 'content-type': 'application/json' },
    body: JSON.stringify({ timezone: 'UTC' }),
  });
  check('5.10 and the API refuses the change even when the screen is bypassed',
    audWrite.status === 403, `HTTP ${audWrite.status}`);
  await shot(auditor, '05c-settings-auditor');

  // The cashier: no reporting at all. The check is that the door is shut, not
  // that a link is hidden.
  const cashier = await newPage();
  const cashToken = await login(cashier, USERS.cashier);
  await cashier.goto(`${UI}/reporting`, { waitUntil: 'networkidle0' });
  await settle(1200);
  const cashText = await bodyText(cashier);
  const cashApi = await api(cashToken, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  check('5.11 the cashier is refused the consolidated dashboard on screen',
    !/Location comparison/i.test(cashText) && /permission|not authorised|not authorized|no access/i.test(cashText),
    cashText.replace(/\s+/g, ' ').slice(0, 130));
  check('5.12 and the API refuses them too', cashApi.status === 403, `HTTP ${cashApi.status}`);
  await shot(cashier, '05d-dashboard-cashier-refused');

  // The other tenant. Without this the isolation claim is about an empty room.
  const rival = await newPage();
  const rivalToken = await login(rival, USERS.rival);
  await rival.goto(`${UI}/reporting`, { waitUntil: 'networkidle0' });
  await settle(1400);
  const rivalText = await bodyText(rival);
  const rivalApi = await api(rivalToken, '/reporting/dashboard', { preset: 'THIS_MONTH' });
  const ourStores = ['Connaught Place', 'Cyber Hub', 'Bandra West', 'Lower Parel'];
  const crossed = ourStores.filter((s) => rivalText.includes(s));
  // A positive control. Without it, a token that simply does not work would
  // sail through 5.14 and be reported as watertight tenant isolation.
  check('5.13 the other tenant sees their own store — so their session works',
    rivalText.includes('Kettle & Co') && (rivalApi.body?.rows ?? []).some((r) => /Kettle/.test(r.storeName ?? '')),
    `api rows: ${JSON.stringify((rivalApi.body?.rows ?? []).map((r) => r.storeName))}`);
  check('5.14 and none of this company\'s stores appear on their screen',
    crossed.length === 0, crossed.length ? `LEAKED: ${crossed.join(', ')}` : `${ourStores.length} stores absent`);
  await shot(rival, '05e-dashboard-other-tenant');

  // =========================================================================
  section('6. drill-down from a figure to the records behind it');

  await owner.goto(`${UI}/reporting`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="kpi-netSales"]', { timeout: 20000 });
  await settle(900);
  const before = owner.url();
  await owner.click('[data-testid="kpi-netSales"]');
  await owner.waitForFunction((u) => window.location.href !== u, { timeout: 10000 }, before).catch(() => {});
  await settle(1000);
  check('6.1 selecting the net sales figure opens the report behind it',
    /\/reporting\/(sales|salesByPeriod)/.test(owner.url()), owner.url().replace(UI, ''));
  await shot(owner, '06-drilldown-from-kpi');

  await owner.goto(`${UI}/reporting`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="report-table"]', { timeout: 20000 });
  await settle(900);
  // The store name, not cell 0 — cell 0 is the rank number, and "1" appears in
  // every report ever rendered, so matching on it proved nothing.
  const firstStore = await owner.$eval('[data-testid="report-table"] tbody tr', (tr) => {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim());
    return cells.find((c) => /[A-Za-z]{3}/.test(c) && !/^₹/.test(c)) ?? cells[1] ?? cells[0];
  });
  const before2 = owner.url();
  await owner.click('[data-testid="report-table"] tbody tr');
  await owner.waitForFunction((u) => window.location.href !== u, { timeout: 10000 }, before2).catch(() => {});
  await settle(1000);
  const storeScreen = await bodyText(owner);
  check('6.2 selecting a store row opens that store, and the screen says which',
    owner.url() !== before2 && storeScreen.includes(firstStore),
    `${owner.url().replace(UI, '')} — "${firstStore}"`);
  await shot(owner, '06b-drilldown-store');

  // =========================================================================
  section('7. the export the screen offers is the screen');

  await owner.goto(`${UI}/reporting/sales?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="report-table"]', { timeout: 20000 });
  await settle(900);
  const screenTable = await readTable(owner);
  const csv = await fetch(`${API.replace(/\/$/, '')}/reporting/reports/sales/export?preset=THIS_MONTH&format=csv`, {
    headers: { cookie: ownerToken },
  });
  const csvText = await csv.text();
  // Blank lines are kept: the file is a preamble, then the table, then a blank
  // line and a "# Totals" key/value block. Filtering blanks out ran the row
  // count straight through the separator and into the totals, reporting 25
  // rows for a five-store report.
  const csvLines = csvText.split(/\r?\n/);
  const cells = (line) => line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
  // Upper-case both sides: the screen's header is upper-cased in CSS, and the
  // file is not. Matching on the literal screen text found no header row at
  // all, and every count derived from that index was then nonsense.
  const wanted = screenTable.head.map((h) => h.toUpperCase());
  const headerIdx = csvLines.findIndex((l) => JSON.stringify(cells(l).map((c) => c.toUpperCase())) === JSON.stringify(wanted));
  check('7.1 the exported columns are the columns on the screen, in order',
    headerIdx >= 0,
    headerIdx >= 0
      ? `${wanted.length} columns match: ${screenTable.head.slice(0, 4).join(', ')}…`
      : `no CSV row matches the screen header — screen: ${screenTable.head.join(', ')} | csv row0: ${cells(csvLines[0] ?? '').join(', ')}`);
  if (headerIdx >= 0) {
    const dataRows = [];
    for (const line of csvLines.slice(headerIdx + 1)) {
      if (!line.trim() || line.startsWith('#')) break;
      dataRows.push(line);
    }
    check('7.2 the export has the rows the screen has',
      dataRows.length === screenTable.rows.length, `csv ${dataRows.length} vs screen ${screenTable.rows.length}`);
    check('7.3 the export names the period it covers',
      /period|from|to/i.test(csvLines.slice(0, headerIdx).join(' ')), `${headerIdx} preamble lines`);
  }
  await shot(owner, '07-sales-report-with-export');

  // A store filter applied on the screen must reach the export, or the file a
  // manager downloads is not the report they were looking at.
  const filteredCsv = await fetch(`${API.replace(/\/$/, '')}/reporting/reports/sales/export?preset=THIS_MONTH&format=csv`, {
    headers: { cookie: mgrToken },
  });
  const filteredText = await filteredCsv.text();
  check('7.4 the manager\'s export contains their store and none of the others',
    filteredText.includes(ownStore) && !foreign.some((s) => filteredText.includes(s)),
    `${filteredText.split(/\r?\n/).filter(Boolean).length} lines, own store present, ${foreign.length} others absent`);

  // =========================================================================
  section('8. honest empties on screen');

  await owner.goto(`${UI}/reporting?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="report-table"]', { timeout: 20000 });
  await settle(900);
  const coverage = await owner.$('[data-testid="coverage-strip"]');
  const coverageText = coverage ? await owner.evaluate((el) => el.innerText.replace(/\s+/g, ' '), coverage) : '';
  check('8.1 the dashboard shows a data-coverage strip',
    Boolean(coverage), coverageText.slice(0, 160) || 'no coverage strip');

  // Compare against the API's own coverage states rather than guessed wording.
  const byState = (s) => (dash.body?.rows ?? []).filter((r) => r.coverage?.state === s);
  const never = byState('NEVER_RECORDED');
  const stale = byState('STALE');
  const screenRows = await owner.evaluate(() =>
    [...document.querySelectorAll('[data-testid="report-table"] tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  const neverRow = never.length ? screenRows.find((r) => r.includes(never[0].storeName)) : null;
  check('8.2 a store that never traded is named as such, and shows no zero figure',
    never.length > 0 && Boolean(neverRow) && /never reported/i.test(neverRow) && !/₹\s?0\.00/.test(neverRow),
    neverRow ? `"${neverRow.slice(0, 130)}"` : `${never.length} never-recorded stores in the API answer`);

  const staleRow = stale.length ? screenRows.find((r) => r.includes(stale[0].storeName)) : null;
  check('8.3 a silent store reports how long it has been silent, on the row itself',
    stale.length === 0 || (Boolean(staleRow) && /\d+\s*(minutes|hours|days)/i.test(staleRow)),
    staleRow ? `"${staleRow.slice(0, 130)}"` : `${stale.length} stale stores in the API answer`);
  await shot(owner, '08-coverage-strip', ['[data-testid="coverage-strip"]']);
  await shot(owner, '08b-coverage-rows', ['[data-testid="report-table"]']);

  // =========================================================================
  section('10. the exception worklist on screen');

  await owner.goto(`${UI}/reporting/exceptions?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="exception-summary"]', { timeout: 20000 });
  await settle(900);

  const excApi = await api(ownerToken, '/reporting/exceptions', { preset: 'THIS_MONTH' });
  const excScreen = await bodyText(owner);
  check('10.1 the counts on screen are the counts the server answered',
    excScreen.includes(String(excApi.body?.summary?.open ?? '—'))
    && excScreen.includes(String(excApi.body?.summary?.bySeverity?.CRITICAL ?? '—')),
    `open ${excApi.body?.summary?.open}, critical ${excApi.body?.summary?.bySeverity?.CRITICAL}, overdue ${excApi.body?.summary?.overdue}`);

  // Before any scan, the screen must already name what CAN be looked for. A
  // worklist that only lists findings reads as a complete sweep, and the four
  // kinds this build cannot detect would be invisible until somebody pressed a
  // button they had no reason to press.
  const unscanned = await owner.$('[data-testid="detector-roll-unscanned"]');
  check('10.2 on first load the screen names every kind of check that exists, not only what was found',
    Boolean(unscanned) && new RegExp(`${excApi.body?.kinds?.length ?? 0} kinds of exception exist`).test(excScreen),
    `${excApi.body?.kinds?.length ?? 0} kinds declared, roll-call rendered: ${Boolean(unscanned)}`);
  await shot(owner, '10-exceptions-worklist');

  await owner.click('[data-testid="scan-now"]');
  await owner.waitForSelector('[data-testid="detector-roll"]', { timeout: 20000 });
  await settle(900);
  const scanApi = await api(ownerToken, '/reporting/exceptions', { preset: 'THIS_MONTH' });
  const cannot = (scanApi.body?.summary?.undetectable ?? []).map((u) => u.kind);
  const rollRows = await owner.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-testid^="detector-"]')]
      .map((el) => [el.dataset.testid.replace('detector-', ''), el.innerText.replace(/\s+/g, ' ').trim()])));
  // The claim §7 turns on, read off the rendered row: a check that could not run
  // must show a reason where the count goes. "0 found" and "cannot be seen here"
  // are different statements and an owner acts differently on each.
  const zeroClaimed = cannot.filter((k) => /\b0 found\b/.test(rollRows[k] ?? ''));
  const reasonGiven = cannot.filter((k) => (rollRows[k] ?? '').length > 40);
  check('10.3 a check that could not run shows a reason on its own row, never a zero',
    cannot.length > 0 && zeroClaimed.length === 0 && reasonGiven.length === cannot.length,
    cannot.length
      ? `${cannot.length} undetectable, ${zeroClaimed.length} falsely showing a count — e.g. "${(rollRows[cannot[0]] ?? '').slice(0, 120)}"`
      : 'nothing undetectable in this build');
  await shot(owner, '10b-detector-roll', ['[data-testid="detector-roll"]']);

  // The fold. A group bigger than the cap has to say how many it is hiding, and
  // the heading count must stay the real one — a screen that silently shows eight
  // of seventy is the same lie as a server that silently returns 300 of 400.
  const groups = await owner.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="exception-group-"]')].map((g) => ({
      kind: g.dataset.testid.replace('exception-group-', ''),
      shown: g.querySelectorAll('li[data-testid^="exception-"]').length,
      folded: Boolean(g.querySelector('[data-testid^="exception-fold-"]')),
      heading: g.innerText.split('\n')[0],
      // The count is its own element, so it is read as one. Regexing it out of the
      // heading text does not work: innerText renders the label and the number with
      // nothing between them, so "Cash difference at closing2" has no word boundary
      // before the digit and any \b pattern silently fails to match a correct screen.
      headingCount: Number(g.querySelector('h2 span')?.innerText?.trim() ?? NaN),
      foldLabel: g.querySelector('[data-testid^="exception-fold-"]')?.innerText?.trim() ?? null,
    })));
  const big = groups.find((g) => g.folded);
  const apiCount = (kind) => (excApi.body?.exceptions ?? []).filter((e) => e.kind === kind).length;

  // The count in the heading must be of everything, folded or not. This is the
  // assertion that always runs, and it is the one the fold could have broken:
  // showing eight rows under a heading that says eight, when seventy exist, is
  // the same lie the server's silent 300-row cut was.
  const miscounted = groups.filter((g) => g.headingCount !== apiCount(g.kind));
  check('10.4 each group\'s heading counts every finding of that kind, not the rows on screen',
    groups.length > 0 && miscounted.length === 0,
    miscounted.length
      ? miscounted.map((g) => `${g.kind}: heading says ${g.headingCount}, API has ${apiCount(g.kind)}`).join('; ')
      : groups.map((g) => `${g.kind} ${g.shown} shown of ${g.headingCount}`).join(', '));

  if (big) {
    check('10.5 a group too long for one screen folds, and says how many it is hiding',
      big.shown < apiCount(big.kind) && /\d+ more are hidden/.test(big.foldLabel ?? ''),
      `${big.kind}: ${big.shown} of ${apiCount(big.kind)} shown — "${big.foldLabel}"`);
    await owner.click(`[data-testid="exception-fold-${big.kind}"]`);
    await settle(400);
    const after = await owner.evaluate((k) =>
      document.querySelectorAll(`[data-testid="exception-group-${k}"] li[data-testid^="exception-"]`).length, big.kind);
    check('10.6 expanding a folded group shows every row it was hiding',
      after === apiCount(big.kind), `${after} rows after expanding, ${apiCount(big.kind)} in the API answer`);
    await shot(owner, '10c-exception-group-expanded', [`[data-testid="exception-group-${big.kind}"]`]);
  } else {
    // Deliberate, and worth saying rather than passing: the demo seed closes almost
    // every trading day, so no kind reaches the fold cap. The fold exists for an
    // estate that does not, and this dataset cannot stand in for one.
    const why = `largest group is ${Math.max(0, ...groups.map((g) => apiCount(g.kind)))} rows, under the fold cap — this dataset cannot exercise it`;
    skip('10.5 a group too long for one screen folds, and says how many it is hiding', why);
    skip('10.6 expanding a folded group shows every row it was hiding', why);
  }

  // Every kind must name a role, or the worklist is a list of complaints with
  // nobody attached. The role belongs to the kind, not to the individual finding,
  // so the screen says it once per group — and the heading takes it from the first
  // row, which is only safe if the whole group agrees. Both halves are asserted:
  // the wrong role on a heading is worse than no role at all.
  // The product's labels, spelled as frontend/src/lib/roles.js spells them. Held
  // here as a literal rather than imported: a check that reads its expected value
  // out of the code under test agrees with that code by construction, including
  // when both are wrong.
  const ROLE_WORDS = { BRANCH_MANAGER: 'Store Manager', REGIONAL_MANAGER: 'Regional Manager', FINANCE: 'Finance', INVENTORY: 'Inventory' };
  const headings = await owner.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('[data-testid^="exception-group-"]')]
      .map((g) => [g.dataset.testid.replace('exception-group-', ''), g.querySelector('h2')?.parentElement?.innerText?.replace(/\s+/g, ' ').trim() ?? ''])));
  const kindsOnScreen = Object.keys(headings);
  const roleOf = (kind) => [...new Set((excApi.body?.exceptions ?? []).filter((e) => e.kind === kind).map((e) => e.responsibleRole))];
  const mixed = kindsOnScreen.filter((k) => roleOf(k).length !== 1);
  const mislabelled = kindsOnScreen.filter((k) => !headings[k].includes(`${ROLE_WORDS[roleOf(k)[0]] ?? roleOf(k)[0]} is expected to act`));
  check('10.7 every kind of finding names the role expected to act, and names the right one',
    kindsOnScreen.length > 0 && mixed.length === 0 && mislabelled.length === 0,
    mixed.length || mislabelled.length
      ? `mixed roles in ${mixed.join(', ') || 'none'}; wrong or missing on ${mislabelled.join(', ') || 'none'}`
      : `${kindsOnScreen.length} kinds: ${kindsOnScreen.map((k) => `${k}→${roleOf(k)[0]}`).join(', ')}`);

  await mgr.goto(`${UI}/reporting/exceptions?preset=THIS_MONTH`, { waitUntil: 'networkidle0' });
  await mgr.waitForSelector('[data-testid="exception-summary"]', { timeout: 20000 });
  await settle(900);
  const mgrExcText = await bodyText(mgr);
  const mgrApiExc = await api(mgrToken, '/reporting/exceptions', { preset: 'THIS_MONTH' });
  const mgrStores = new Set((mgrApiExc.body?.scope?.stores ?? []).map((s) => s.name));
  const allStores = (excApi.body?.scope?.stores ?? []).map((s) => s.name);
  const foreignOnScreen = allStores.filter((n) => !mgrStores.has(n) && mgrExcText.includes(n));
  check('10.8 a branch manager\'s worklist names their own store and no other',
    foreignOnScreen.length === 0,
    `${mgrApiExc.body?.exceptions?.length ?? 0} row(s), own: ${[...mgrStores].join(', ')}, leaked: ${foreignOnScreen.join(', ') || 'none'}`);
  await shot(mgr, '10d-exceptions-manager');

  const excOverflow = await overflows(owner);
  check('10.9 the worklist fits the screen it is drawn on', excOverflow.length === 0, JSON.stringify(excOverflow));

  // =========================================================================
  section('11. the schedules screen says what it will and will not do');

  await owner.goto(`${UI}/reporting/schedules`, { waitUntil: 'networkidle0' });
  await owner.waitForSelector('[data-testid="scheduler-state"]', { timeout: 20000 });
  await settle(900);
  const schedText = await bodyText(owner);
  const schedApi = await api(ownerToken, '/reporting/schedules');

  // The two facts a person configuring a schedule cannot get from the form, and
  // would otherwise assume wrongly in both directions: that saving one makes it
  // send, and that a delivery means an email.
  check('11.1 the screen says whether anything sends on its own in this deployment',
    /Off in this deployment/i.test(schedText) === (schedApi.body?.scheduler?.enabled === false)
    && schedText.includes(schedApi.body?.scheduler?.note ?? ' '),
    `scheduler.enabled=${schedApi.body?.scheduler?.enabled}`);
  const transport = await owner.$('[data-testid="transport-state"]');
  check('11.2 the screen names the mechanism a delivery uses instead of implying email',
    Boolean(transport) && /\bFILE\b/.test(schedText) && !/\bemail(ed)?\b/i.test(await owner.evaluate((el) => el.innerText, transport)),
    transport ? (await owner.evaluate((el) => el.innerText.replace(/\s+/g, ' '), transport)).slice(0, 150) : 'no transport panel');

  const states = await owner.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="schedule-"]')].map((c) => {
      const t = c.innerText;
      return { name: t.split('\n')[0], draft: /\bDRAFT\b/.test(t), active: /\bACTIVE\b/.test(t), paused: /\bPAUSED\b/.test(t) };
    }));
  check('11.3 a draft, an active and a paused schedule are told apart on the card itself',
    states.some((s) => s.draft) && states.some((s) => s.active) && states.some((s) => s.paused),
    states.map((s) => `${s.name.slice(0, 26)}:${s.draft ? 'D' : s.active ? 'A' : s.paused ? 'P' : '?'}`).join(', '));

  // A draft must not offer "Run now". The server refuses it anyway — this is the
  // screen agreeing rather than presenting an action that will fail.
  const runOffered = await owner.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="schedule-"]')]
      .filter((c) => /\bDRAFT\b/.test(c.innerText))
      .map((c) => [...c.querySelectorAll('button')].some((b) => /Run now/i.test(b.innerText))));
  check('11.4 a draft is not offered a send button it would be refused for',
    runOffered.length > 0 && runOffered.every((x) => x === false),
    `${runOffered.length} draft(s), ${runOffered.filter(Boolean).length} offering "Run now"`);
  await shot(owner, '11-schedules');

  // The delivery history, opened the way a person opens it. The row has to carry
  // the transport and who was written to, because "SENT" on its own is the field
  // that gets read as "emailed to everybody named on the schedule".
  const activeName = (schedApi.body?.schedules ?? []).find((s) => s.state === 'ACTIVE')?.name ?? null;
  const opened = activeName
    ? await owner.evaluate((n) => {
      const card = [...document.querySelectorAll('[data-testid^="schedule-"]')].find((c) => c.innerText.includes(n));
      const btn = card ? [...card.querySelectorAll('button')].find((b) => b.innerText.trim() === 'History') : null;
      if (!btn) return false;
      btn.click();
      return true;
    }, activeName)
    : false;
  if (opened) {
    await settle(1200);
    const modal = await owner.evaluate(() => document.body.innerText);
    const deliveries = (await api(ownerToken, `/reporting/schedules/${(schedApi.body.schedules.find((s) => s.state === 'ACTIVE')).id}/deliveries`)).body?.deliveries ?? [];
    const sent = deliveries.find((d) => d.status === 'SENT');
    check('11.5 the delivery history shows what was sent, by which transport, for which period',
      Boolean(sent) && modal.includes(sent.period.from) && /via FILE/.test(modal),
      sent ? `${deliveries.length} delivery(ies), latest ${sent.status} for ${sent.period.from}` : `${deliveries.length} delivery(ies), none SENT`);
    // Only approved test addresses may be written to in this build. The screen is
    // where somebody checks that before trusting the schedule with real figures.
    const withheldShown = sent?.withheld?.length ? sent.withheld.every((e) => modal.includes(e)) : true;
    check('11.6 the addresses written to, and the ones deliberately withheld, are both on screen',
      Boolean(sent) && sent.sentTo.every((e) => modal.includes(e)) && withheldShown,
      sent ? `wrote to ${sent.sentTo.join(', ') || 'nothing'}; withheld ${sent.withheld.join(', ') || 'nothing'}` : 'no delivery to read');
    await shot(owner, '11b-delivery-history');
  } else {
    check('11.5 the delivery history shows what was sent, by which transport, for which period', false,
      activeName ? `could not open History for "${activeName}"` : 'no ACTIVE schedule on screen');
    check('11.6 the addresses written to, and the ones deliberately withheld, are both on screen', false, 'history not opened');
  }

  // BRANCH_MANAGER holds no schedule action at all, so the screen must refuse
  // rather than render an empty list that reads as "no schedules exist".
  await mgr.goto(`${UI}/reporting/schedules`, { waitUntil: 'networkidle0' });
  await settle(1200);
  const mgrSched = await bodyText(mgr);
  const mgrSchedApi = await api(mgrToken, '/reporting/schedules');
  // The exact sentence, not a keyword: "permission" and "access" both appear in
  // the navigation, so a loose match here would pass on a screen that rendered
  // nothing at all. Naming the screen also proves the guard was given what it
  // guards — "you cannot open this screen" is a worse refusal than one that says
  // which.
  const refusal = /You do not have permission to open scheduled reports/i.test(mgrSched);
  check('11.7 a role with no schedule permission is refused by name rather than shown an empty list',
    mgrSchedApi.status === 403 && refusal && !/No schedule yet/i.test(mgrSched),
    `API ${mgrSchedApi.status}, refusal named the screen: ${refusal}`);
  await shot(mgr, '11c-schedules-manager-refused');

  // =========================================================================
  section('12. the screenshots are different pictures');

  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const hashes = shots.map((s) => ({ name: s.name, hash: createHash('sha256').update(readFileSync(s.path)).digest('hex').slice(0, 12) }));
  const unique = new Set(hashes.map((h) => h.hash));
  const dupes = hashes.filter((h, i) => hashes.findIndex((x) => x.hash === h.hash) !== i);
  check('12.1 every screenshot is a distinct image',
    unique.size === hashes.length,
    dupes.length ? `duplicates: ${dupes.map((d) => d.name).join(', ')}` : `${hashes.length} distinct images`);

  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), ui: UI, api: API, results, skipped, shots: hashes, passed: results.length - failed, failed }, null, 2));
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err.message}`);
  failed += 1;
} finally {
  await browser.close();
}

console.log('\n================================================================');
console.log(`${results.length - failed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
if (skipped.length) {
  console.log('\nnot exercised by this dataset:');
  for (const s of skipped) console.log(`  - ${s.name} — ${s.why}`);
}
if (failed) {
  console.log('\nfailed:');
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`screenshots + results.json: ${OUT}`);
process.exit(failed ? 1 : 0);
