// VC-105 W2 — browser QA against the running UI.
//
// Drives the real screen in a real browser and compares what a human sees
// against (a) the backend's own JSON and (b) values calculated by hand in the
// CHECKS table below. A screenshot that nobody asserted against is decoration,
// so every screen captured here also carries at least one assertion.
//
// SYNTHETIC. The backend is served with the VC-105 fixture cost provider, so
// every margin on these screens is fixture data. Fixture success is not
// evidence about live costs.
//
// Usage (ports and credentials come from the caller, nothing is hardcoded):
//   QA_UI=http://127.0.0.1:5387 QA_API=http://127.0.0.1:5386 \
//   QA_OWNER=owner@… QA_MANAGER=… QA_CASHIER=… QA_PASSWORD=… \
//   node qa/vc105-browser-qa.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const UI = process.env.QA_UI || 'http://127.0.0.1:5387';
const API = process.env.QA_API || 'http://127.0.0.1:5386';
const PASSWORD = process.env.QA_PASSWORD;
const OWNER = process.env.QA_OWNER;
const MANAGER = process.env.QA_MANAGER;
const CASHIER = process.env.QA_CASHIER;
const CHROME = process.env.QA_CHROME;
const OUT = process.env.QA_OUT || join(process.cwd(), 'qa/screens');

if (!PASSWORD || !OWNER || !CHROME) {
  console.error('Set QA_PASSWORD, QA_OWNER and QA_CHROME.');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, actual, expected, note = '') => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass, actual, expected, note });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
  return pass;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const newPage = async () => {
  // A fresh context per user: pages in one browser share a cookie jar, so
  // without this the manager and cashier checks would quietly reuse the
  // owner's session and pass for the wrong reason.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  // A harness that fails silently wastes more time than no harness: surface
  // what the page actually did whenever QA_DEBUG is set.
  if (process.env.QA_DEBUG) {
    page.on('console', (m) => console.log('  [console]', m.type(), m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)));
    page.on('requestfailed', (r) => console.log('  [reqfail]', r.url(), r.failure()?.errorText));
    page.on('response', (r) => {
      if (r.url().includes('/api/')) console.log('  [api]', r.status(), r.url().replace(UI, ''));
    });
  }
  return page;
};

const login = async (page, email) => {
  await page.goto(`${UI}/login`, { waitUntil: 'networkidle0' });
  // The SPA probes /auth/me before it renders the form, and React re-mounts
  // the inputs when that settles. Typing into the pre-hydration DOM silently
  // does nothing, which is how the first run of this script "logged in" to a
  // login page — so wait for the field, then verify the value actually stuck.
  await page.waitForSelector('input[type="email"]', { visible: true });
  await new Promise((r) => setTimeout(r, 600));
  await page.click('input[type="email"]');
  await page.type('input[type="email"]', email, { delay: 10 });
  await page.click('input[type="password"]');
  await page.type('input[type="password"]', PASSWORD, { delay: 10 });

  const typed = await page.$eval('input[type="email"]', (el) => el.value);
  if (typed !== email) throw new Error(`login form did not accept input (got "${typed}")`);

  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), { timeout: 15000 });
  } catch {
    const onScreen = await page.evaluate(() => document.body.innerText).catch(() => '');
    await page.screenshot({ path: join(OUT, `login-failed-${email.split('@')[0]}.png`) }).catch(() => {});
    throw new Error(`login did not leave /login for ${email}. Screen said:\n${onScreen.slice(0, 500)}`);
  }
  await new Promise((r) => setTimeout(r, 800));
};

const gotoReport = async (page, qs = '') => {
  await page.goto(`${UI}/reports/menu-profitability${qs}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 900));
};

const shot = async (page, name) => {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`        screenshot -> ${path}`);
};

// Read the rendered table back out of the DOM: this is what a human sees,
// not what the API returned.
const readTable = (page) =>
  page.evaluate(() => {
    const table = document.querySelector('[data-testid="profit-table"]');
    if (!table) return null;
    return [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
  });

// ---------------------------------------------------------------------------

const page = await newPage();
await login(page, OWNER);

// The window the seed covers.
const WIN = '?from=2026-09-01&to=2026-09-30';

// --- 1. Owner, whole period, grouped by item ------------------------------
await gotoReport(page, WIN);
await shot(page, '01-owner-item-view');

const rows = await readTable(page);
check('table renders one row per menu item sold', rows?.length, 6);

const byLabel = Object.fromEntries((rows || []).map((r) => [r[0], r]));

// Hand-calculated from the seed (see docs/VC105-EVIDENCE.md §3):
//   Filter Coffee 18 sold, net 76,956 paise = ₹769.56; COGS 18 x 810 = ₹145.80
//   contribution margin ₹523.76 on costed net ₹669.56 -> 78.22%
check('Filter Coffee net sales, as rendered', byLabel['Filter Coffee']?.[2], '₹769.56');
check('Filter Coffee COGS, as rendered', byLabel['Filter Coffee']?.[4], '₹145.80');
check('Filter Coffee contribution margin, as rendered', byLabel['Filter Coffee']?.[5], '₹523.76');
check('Filter Coffee margin %, as rendered', byLabel['Filter Coffee']?.[6], '78.22%');

// --- 2. Missing cost must not render as zero ------------------------------
check('Mystery Box COGS shows the unknown marker, not ₹0.00', byLabel['Mystery Box']?.[4], '—');
check('Mystery Box margin shows the unknown marker, not ₹0.00', byLabel['Mystery Box']?.[5], '—');
check('Mystery Box margin % shows the unknown marker, not 0%', byLabel['Mystery Box']?.[6], '—');
check('Mystery Box is labelled No cost', byLabel['Mystery Box']?.[7]?.includes('No cost'), true);
check('Mystery Box is NOT classified a Dog', byLabel['Mystery Box']?.[8], 'No verdict');

// --- 3. Stale and estimated cost are visible and distinct -----------------
check('Old Favourite is flagged Stale', byLabel['Old Favourite']?.[7]?.includes('Stale'), true);
check('Seasonal Special is flagged Estimated', byLabel['Seasonal Special']?.[7]?.includes('Estimated'), true);

// --- 4. Negative margin is shown as negative ------------------------------
// Loss Leader: 3 sold at ₹10 = ₹30 net, cost 3 x ₹25 = ₹75 -> CM -₹45, -150%
check('Loss Leader contribution margin is negative, sign first', byLabel['Loss Leader']?.[5], '-₹45.00');
check('Loss Leader margin % is negative', byLabel['Loss Leader']?.[6], '-150.00%');

// --- 5. Costing dependency is stated on screen ----------------------------
const banner = await page.$eval('[data-testid="costing-banner"]', (el) => el.innerText).catch(() => '');
check('costing banner names the dependency as BLOCKED', /BLOCKED/.test(banner), true);
check('costing banner warns the costs are synthetic', /[Ss]ynthetic/.test(banner), true);

// The screen must not let a reader take a synthetic historical figure for a
// historical fact.
const repro = await page.$eval('[data-testid="repro-warning"]', (el) => el.innerText).catch(() => '');
check('screen warns that synthetic history is not reproducible', /changing a price moves history/.test(repro), true);

// --- 6. Contribution margin wording, and partial-total disclosure ---------
const marginNote = await page.$eval('[data-testid="margin-label"]', (el) => el.innerText).catch(() => '');
check('screen says "contribution margin"', /[Cc]ontribution margin/.test(marginNote), true);
check('screen denies it is net business profit', /[Nn]ot net business profit/.test(marginNote), true);
check('partial totals state their exclusions', /excluded because no cost exists/.test(marginNote), true);

const pageText = await page.evaluate(() => document.body.innerText);
check('the phrase "net business profit" never appears as a claim', /(?<!Not )net business profit/i.test(pageText), false);

// --- 7. Coverage strip ----------------------------------------------------
const coverage = await page.$eval('[data-testid="coverage-strip"]', (el) => el.innerText).catch(() => '');
// 10 sold lines in the window; 9 costed, 1 (Mystery Box) not.
check('coverage strip states costed-of-total lines', /9 of 10 sold lines carry a cost/.test(coverage), true);

// --- 8. Chart excludes uncosted items rather than plotting them at zero ---
const unplottable = await page.$eval('[data-testid="chart-unplottable"]', (el) => el.innerText).catch(() => '');
check('chart states uncosted items cannot be placed', /cannot be placed/.test(unplottable), true);
check('chart names the uncosted item', /Mystery Box/.test(unplottable), true);
await shot(page, '02-chart-and-coverage');

// --- 9. Drilldown ---------------------------------------------------------
await page.evaluate(() => {
  const rowsEls = document.querySelectorAll('[data-testid="profit-table"] tbody tr');
  for (const tr of rowsEls) if (tr.innerText.startsWith('Latte')) { tr.click(); return; }
});
await new Promise((r) => setTimeout(r, 600));
const drill = await page.evaluate(() => document.body.innerText);
check('drilldown shows the recipe version', /Recipe version 2/.test(drill), true);
check('drilldown shows the yield', /yield 95%/.test(drill), true);
check('drilldown lists the ingredients', /Coffee powder/.test(drill) && /Milk/.test(drill), true);
check('drilldown shows the yield adjustment as its own line', /Yield adjustment/.test(drill), true);
check('drilldown states the calculation basis', /Calculation basis/.test(drill), true);
check('drilldown repeats that COGS is not reduced by a refund', /cogs not reduced on refund/i.test(drill), true);
await shot(page, '03-drilldown-latte');
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 400));

// --- 10. Drilldown for an item with no cost -------------------------------
await page.evaluate(() => {
  const rowsEls = document.querySelectorAll('[data-testid="profit-table"] tbody tr');
  for (const tr of rowsEls) if (tr.innerText.startsWith('Mystery Box')) { tr.click(); return; }
});
await new Promise((r) => setTimeout(r, 600));
const drill2 = await page.evaluate(() => document.body.innerText);
check('uncosted drilldown refuses to invent a recipe', /No recipe cost to explain/.test(drill2), true);
check('uncosted drilldown says the margin is unknown, not zero', /unknown\s*\n?\s*— not zero|unknown — not zero/.test(drill2.replace(/\s+/g, ' ')), true);
await shot(page, '04-drilldown-no-cost');
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 400));

// --- 11. Empty period -----------------------------------------------------
await gotoReport(page, '?from=2026-09-15&to=2026-09-15');
const empty = await page.evaluate(() => document.body.innerText);
check('an empty day says there were no sales', /No sales in this period/.test(empty), true);
check('an empty day does not claim a zero margin', /not a zero-margin result/.test(empty), true);
await shot(page, '05-empty-period');

// --- 12. Historical period is stable --------------------------------------
await gotoReport(page, '?from=2026-09-10&to=2026-09-11');
const histA = await readTable(page);
await gotoReport(page, '?from=2026-09-10&to=2026-09-11');
const histB = await readTable(page);
check('a historical period reproduces exactly on re-run', histA, histB);
check('the historical window shows fewer items than the full period', histA.length < 6, true);
await shot(page, '06-historical-period');

// --- 13. Filters ----------------------------------------------------------
await gotoReport(page, WIN);
await page.select('[data-testid="filter-channel"]', 'TAKEAWAY');
await new Promise((r) => setTimeout(r, 900));
const takeaway = await readTable(page);
const takeawayLabels = takeaway.map((r) => r[0]).sort();
check('channel filter narrows to takeaway items only', takeawayLabels, ['Filter Coffee', 'Mystery Box', 'Old Favourite']);
await shot(page, '07-filter-channel-takeaway');

await page.select('[data-testid="filter-channel"]', '');
await page.select('[data-testid="filter-groupby"]', 'store');
await new Promise((r) => setTimeout(r, 900));
const byStore = await readTable(page);
check('grouping by store returns the two seeded stores', byStore.map((r) => r[0]).sort(), ['Airport', 'Central']);
const storeText = await page.evaluate(() => document.body.innerText);
check('the segment chart is withheld for non-item groupings', /Switch the grouping back to/.test(storeText), true);
await shot(page, '08-group-by-store');

await page.select('[data-testid="filter-groupby"]', 'period');
await new Promise((r) => setTimeout(r, 900));
const byDay = await readTable(page);
// The seed trades on 6 days (10,11,12,13,14,16 September); 2026-09-15 is
// deliberately empty and must therefore NOT appear as a row.
check('grouping by day returns one row per trading day', byDay.length, 6);
check('the empty day is absent rather than shown as zero', byDay.map((r) => r[0]).includes('2026-09-15'), false);
await shot(page, '09-group-by-day');

// --- 14. Responsive -------------------------------------------------------
await page.setViewport({ width: 390, height: 900 });
await gotoReport(page, WIN);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal page overflow at 390px', overflow <= 0, true);
await shot(page, '10-responsive-390');
await page.setViewport({ width: 1440, height: 1000 });

// --- 15. Branch-pinned manager -------------------------------------------
if (MANAGER) {
  const mp = await newPage();
  await login(mp, MANAGER);
  await gotoReport(mp, WIN);
  const pinned = await mp.$eval('[data-testid="filter-store-pinned"]', (el) => el.innerText).catch(() => '');
  check('a branch manager sees their store is pinned', /Your store only/.test(pinned), true);
  const mgrRows = await readTable(mp);
  // Central only: coffee, latte, seasonal special. No airport-only items.
  check('a branch manager never sees another store\'s items', mgrRows.map((r) => r[0]).includes('Mystery Box'), false);
  await shot(mp, '11-manager-pinned-store');
  await mp.close();
}

// --- 16. Cashier is refused ----------------------------------------------
if (CASHIER) {
  const cp = await newPage();
  await login(cp, CASHIER);
  await gotoReport(cp, WIN);
  // The app's house pattern is to bounce a disallowed role rather than render
  // a refusal page, so the evidence is: not on the route, no link offered, and
  // the API refuses the call on its own account.
  const landedOn = await cp.evaluate(() => window.location.pathname);
  check('a cashier is bounced off the menu-profitability route', landedOn.includes('menu-profitability'), false);

  const navText = await cp.evaluate(() => document.querySelector('aside')?.innerText ?? '');
  check('a cashier is not offered the menu-profitability link', /Menu profitability/.test(navText), false);

  // Belt and braces: the guard is cosmetic if the endpoint would serve them.
  const apiStatus = await cp.evaluate(async (base) => {
    const r = await fetch(`${base}/api/reports/menu-profitability?from=2026-09-01&to=2026-09-30`, { credentials: 'include' });
    return r.status;
  }, UI);
  check('the API refuses a cashier regardless of the UI guard', apiStatus, 403);
  await shot(cp, '12-cashier-denied');
  await cp.close();
}

// ---------------------------------------------------------------------------
await browser.close();

const passed = results.filter((r) => r.pass).length;
// Lane-specific filename: a406 consolidation put this harness alongside
// vc104-browser-qa.mjs in the same directory, both defaulting to a plain
// results.json. Whichever ran second silently destroyed the other lane's
// evidence, and the survivor still looked like a complete, passing run.
// `at` is recorded so a stale file cannot pass for a fresh one.
writeFileSync(join(OUT, 'results-vc105.json'), JSON.stringify({ ui: UI, api: API, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
console.log(`\n${passed}/${results.length} browser checks passed`);
process.exit(passed === results.length ? 0 : 1);
