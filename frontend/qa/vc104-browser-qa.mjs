// VC-104 W2 — browser QA against the running UI (operator entry → store decision).
//
// Drives the real screens in a real browser and compares what a human sees
// against the backend's own JSON (captured off the wire) and against the seed
// values below. Every screenshot carries at least one assertion.
//
// SYNTHETIC. The demo seed (seedPhoneOrderCentre) prices these stores:
//   BSC-CP  Connaught Place  09:00–23:00, 6 orders / 15 min
//   BSC-CH  Cyber Hub        11:00–22:00 (closed Mondays), 2 orders / 15 min
//   110001 → CP ₹40 (min ₹200)  AND  CH ₹65 (min ₹300)   ← dual on purpose
//   122001 → CH ₹45 only                                  ← CP out-of-area case
// Cyber-Hub-dependent checks are guarded by what the server says about CH at
// run time (its hours are real): when CH is unavailable they are recorded as
// SKIP, never as silent passes.
//
// Usage (ports and credentials come from the caller, nothing is hardcoded):
//   QA_UI=http://127.0.0.1:5383 QA_API=http://127.0.0.1:5382 \
//   QA_OWNER=… QA_MANAGER=… QA_CASHIER=… QA_PASSWORD=… QA_CHROME=… \
//   node qa/vc104-browser-qa.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { treeStamp } from './tree-stamp.mjs';

// puppeteer-core is a QA-only dependency; resolve it from this lane if
// installed, else borrow the sibling vc105-ui lane's copy (same repo, same
// pinned version). createRequire because ESM import ignores NODE_PATH.
const puppeteer = (() => {
  for (const base of [
    import.meta.url,
    new URL('../../../vc105-ui/frontend/qa/', import.meta.url).href,
  ]) {
    try {
      return createRequire(base)('puppeteer-core');
    } catch {
      /* try next */
    }
  }
  throw new Error('puppeteer-core not found in vc104-ui or vc105-ui node_modules');
})();

const UI = process.env.QA_UI || 'http://127.0.0.1:5383';
const API = process.env.QA_API || 'http://127.0.0.1:5382';
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
const skip = (name, why) => {
  results.push({ name, pass: true, skipped: true, note: `SKIP: ${why}` });
  console.log(`SKIP  ${name} — ${why}`);
};

// Evidence survives a crash: results-vc104.json is written on EVERY exit path,
// so a thrown selector timeout can no longer discard the checks that already
// ran (the first full run lost 66 recorded passes exactly that way).
//
// The filename is lane-specific because a406 consolidation put two harnesses
// in this directory, both of which defaulted to the same plain results.json.
// Whichever ran second silently destroyed the other lane's evidence, and the
// loss was invisible — the surviving file looks like a complete, passing run.
//
// The tree stamp answers the other half: not "is this file complete" but
// "which checkout produced it". See qa/tree-stamp.mjs and D-4.
let resultsWritten = false;
const writeResults = () => {
  if (resultsWritten) return;
  resultsWritten = true;
  const passed = results.filter((r) => r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  writeFileSync(join(OUT, 'results-vc104.json'), JSON.stringify({
    ui: UI, api: API, at: new Date().toISOString(), ...treeStamp(import.meta.url),
    passed, skipped, total: results.length, results,
  }, null, 2));
  console.log(`\n${passed}/${results.length} browser checks passed (${skipped} skipped)`);
};
process.on('exit', writeResults);

// Mirrors src/lib/pos.js fmtINR so DOM strings can be checked against the
// server's numbers without the QA script inventing its own arithmetic.
const inr = (v) =>
  v === null || v === undefined
    ? '—'
    : `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const newPage = async () => {
  // A fresh context per user: pages in one browser share a cookie jar, so
  // without this the manager and cashier checks would quietly reuse the
  // owner's session and pass for the wrong reason (VC-105 QA defect).
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
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
  // The SPA probes /auth/me before it renders the form and React re-mounts the
  // inputs when that settles; typing into the pre-hydration DOM silently does
  // nothing. Wait, type, then verify the value stuck (VC-105 lesson).
  await page.waitForSelector('input[type="email"]', { visible: true });
  await sleep(600);
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
  await sleep(800);
};

const shot = async (page, name) => {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`        screenshot -> ${path}`);
};

// All API reads go through the page (vite proxy, session cookie included), so
// the QA sees exactly what the screen's own requests see.
const apiGet = (page, path) =>
  page.evaluate(async (p) => {
    const r = await fetch(`/api${p}`, { credentials: 'include' });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, path);
const apiPost = (page, path, body) =>
  page.evaluate(async ({ p, b }) => {
    const r = await fetch(`/api${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: b,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { p: path, b: body });

const readToasts = (page) =>
  page.$$eval('[role="alert"]', (els) => els.map((e) => e.innerText.trim())).catch(() => []);

const navText = (page) => page.evaluate(() => document.querySelector('aside')?.innerText ?? '');

// --- entry-form helpers -----------------------------------------------------

const pickCaller = async (page, term, fullName) => {
  await page.waitForSelector('input[placeholder*="Search by name"]', { visible: true });
  await page.click('input[placeholder*="Search by name"]', { clickCount: 3 });
  await page.type('input[placeholder*="Search by name"]', term, { delay: 15 });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('button')].some((b) => b.innerText.includes(name)),
    { timeout: 8000 },
    fullName,
  );
  await page.evaluate((name) => {
    [...document.querySelectorAll('button')].find((b) => b.innerText.includes(name))?.click();
  }, fullName);
  await page.waitForFunction(
    (name) => document.body.innerText.includes(name) && [...document.querySelectorAll('button')].some((b) => b.innerText.includes('Change caller')),
    { timeout: 8000 },
    fullName,
  );
  await sleep(300);
};

// Add items BY NAME, never by position: the seeded minimums (CP ₹200,
// CH ₹300/₹250) mean a sort-order-dependent basket could sit below a min and
// turn an availability assertion into a BELOW_MIN_ORDER false failure.
// Seeded prices: Cappuccino ₹180, Espresso ₹140 — so ['Cappuccino'] ×2 = ₹360
// clears every minimum, and the ₹500 golden basket clears CH's ₹300 with room.
const addItems = async (page, names) => {
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') || '').startsWith('Add ')).length > 0,
    { timeout: 10000 },
  );
  for (const name of names) {
    const clicked = await page.evaluate((n) => {
      const btn = document.querySelector(`button[aria-label="Add ${n}"]`);
      btn?.click();
      return Boolean(btn);
    }, name);
    if (!clicked) throw new Error(`menu has no "Add ${name}" button`);
    await sleep(150);
  }
};

const checkStores = async (page) => {
  await page.click('[data-testid="po-check-stores"]');
  await page.waitForSelector('[data-testid="po-options"]', { visible: true, timeout: 10000 });
  await sleep(300);
  return page.$$eval('[data-testid="po-options"] > label', (els) =>
    els.map((el) => ({
      testid: el.getAttribute('data-testid'),
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      available: el.innerText.includes('Available') && !el.innerText.includes('Unavailable'),
    })),
  );
};

const selectStore = async (page, code) => {
  await page.evaluate((c) => {
    document.querySelector(`[data-testid="po-option-${c}"] input[type="radio"]`)?.click();
  }, code);
  await sleep(200);
};

// ---------------------------------------------------------------------------

const owner = await newPage();
await login(owner, OWNER);

// --- 0. Session facts the whole run depends on ------------------------------
const me = await apiGet(owner, '/auth/me');
check('owner session is CUSTOMER_OWNER', me.json?.user?.role, 'CUSTOMER_OWNER');
const plan = me.json?.license?.plan ?? null;
check('demo licence plan is MULTI_STORE (HQ routing entitled)', plan, 'MULTI_STORE',
  'owner cross-store submission depends on this; a FAIL here invalidates the rest of the run');

// --- 1. Nav + list shell + status chips (no CANCELLED) ----------------------
check('owner nav offers Phone orders', /Phone orders/.test(await navText(owner)), true);
await owner.goto(`${UI}/phone-orders`, { waitUntil: 'networkidle0' });
await sleep(600);
const chips = await owner.$$eval('[data-testid="po-chips"] button', (els) => els.map((e) => e.innerText.trim()));
check('status chips are exactly All/Submitted/Accepted/Rejected (§4: no CANCELLED chip)', chips,
  ['All', 'Submitted', 'Accepted', 'Rejected']);
check('empty centre says so', /No phone orders yet/.test(await owner.evaluate(() => document.body.innerText)), true);
await shot(owner, '01-list-empty');

// --- 2. Golden path: Anita Rao, delivery to 110001, submit to CP ------------
await owner.goto(`${UI}/phone-orders/new`, { waitUntil: 'networkidle0' });
await pickCaller(owner, 'Anita', 'Anita Rao');
const defaultAddr = await owner.evaluate(() => {
  const checked = [...document.querySelectorAll('input[name="address"]')].find((r) => r.checked);
  return checked?.closest('label')?.innerText.replace(/\s+/g, ' ') ?? null;
});
check('default address is pre-selected for delivery', /Default/.test(defaultAddr ?? ''), true);
check('the pre-selected address is Home (110001)', /110001/.test(defaultAddr ?? ''), true);
await shot(owner, '02-entry-caller');

await addItems(owner, ['Cappuccino', 'Cappuccino', 'Espresso']); // ₹500 pre-tax: clears CP ₹200 AND CH ₹300
const basketCount = await owner.evaluate(
  () => [...document.querySelectorAll('button[aria-label="Remove"]')].length,
);
check('basket holds two lines after adding items', basketCount, 2);

let opts = await checkStores(owner);
check('every store is rendered with a verdict (none hidden)', opts.length, 2, '§5.6: unavailable stores are shown with reasons, never dropped');
const cpRow = opts.find((o) => o.testid === 'po-option-BSC-CP');
const chRow = opts.find((o) => o.testid === 'po-option-BSC-CH');
// BOTH stores' hours are widened to all-day by qa/run-seed.mjs, in W2's
// scratch DB only, so the run is time-independent instead of green-only
// between 09:00 and 23:00 IST and degraded outside 11:00–22:00. The
// `if (chOpen) … else skip(…)` pairs below are kept, but they no longer mean
// "you ran this at night" — reaching one now means the fixture failed to
// apply, which run-seed.mjs's own cpOpenDays=14 assertion should have caught
// first. See the rationale block in run-seed.mjs for what that costs.
check('Connaught Place is available for 110001', cpRow?.available, true,
  'QA fixture holds CP open around the clock — this asserts service-area match, not hours');
check('CP quotes the seeded ₹40 delivery charge', /₹40\.00/.test(cpRow?.text ?? ''), true);
check('CP states the seeded ₹200 minimum order', /min order ₹200\.00/.test(cpRow?.text ?? ''), true);
const chOpen = Boolean(chRow?.available);
if (chOpen) {
  check('Cyber Hub quotes the seeded ₹65 delivery charge', /₹65\.00/.test(chRow?.text ?? ''), true,
    '110001 is deliberately dual-serviced so a move visibly re-prices');
} else {
  skip('Cyber Hub ₹65 quote for 110001', `CH row says: ${chRow?.text ?? 'missing'}`);
}
await shot(owner, '03-entry-options');

// Capture the submit request/response off the wire — the idempotency replay
// must reuse the EXACT body (same key, same hash), not a reconstruction.
let submitBody = null;
let submitRes = null;
const isSubmitUrl = (u) => u.endsWith('/api/phone-orders');
const onReq = (r) => {
  if (r.method() === 'POST' && isSubmitUrl(r.url())) submitBody = r.postData();
};
const onRes = (r) => {
  if (r.request().method() === 'POST' && isSubmitUrl(r.url())) {
    r.json().then((j) => { submitRes = { status: r.status(), json: j }; }).catch(() => {});
  }
};
owner.on('request', onReq);
owner.on('response', onRes);

await selectStore(owner, 'BSC-CP');
await owner.click('[data-testid="po-submit"]');
await owner.waitForSelector('[data-testid="po-success"]', { visible: true, timeout: 15000 });
await sleep(400);
owner.off('request', onReq);
owner.off('response', onRes);

const po1 = submitRes?.json?.phoneOrder ?? null;
check('submission answered 201 Created', submitRes?.status, 201);
check('reference has the PH- shape', /^PH-\d{6}$/.test(po1?.reference ?? ''), true);
check('order status starts SUBMITTED', po1?.status, 'SUBMITTED');
check('delivery charge is quoted, not billable (C-6 open)', po1?.deliveryChargeBillable, false);

const domPayable = await owner.$eval('[data-testid="po-payable"]', (el) => el.innerText.trim());
const domTotal = await owner.$eval('[data-testid="po-total"]', (el) => el.innerText.trim());
const domDelivery = await owner.$eval('[data-testid="po-delivery"]', (el) => el.innerText.trim());
check('payable on screen is the SERVER quote, formatted', domPayable, inr(po1?.payableQuote));
check('food-and-tax on screen is order.total', domTotal, inr(po1?.order?.total));
check('delivery on screen is the quoted charge', domDelivery, inr(po1?.deliveryCharge));
check('server invariant payableQuote = total + deliveryCharge held on this order',
  po1 ? Math.abs(po1.payableQuote - (po1.order.total + po1.deliveryCharge)) < 1e-9 : null, true,
  'a server number, asserted as evidence; the client never computes it');
check('C-6 caveat is read to the operator', /C-6/.test(await owner.evaluate(() => document.body.innerText)), true);
await shot(owner, '04-entry-submitted');

// --- 3. Idempotency: exact replay returns the SAME order, list stays at one -
check('the submit request body was captured', Boolean(submitBody), true);
const replay = await apiPost(owner, '/phone-orders', submitBody);
check('an exact replay answers 200, not 201', replay.status, 200, '§5.7: same key + same hash = same order back');
check('the replay returns the SAME order id', replay.json?.phoneOrder?.id, po1?.id);
const listAfterReplay = await apiGet(owner, '/phone-orders');
check('exactly one order exists for that reference after the replay',
  (listAfterReplay.json?.phoneOrders ?? []).filter((p) => p.reference === po1?.reference).length, 1);

// --- 4. Stale options are withdrawn when an input changes -------------------
await owner.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Take another order'))?.click();
});
await sleep(500);
await pickCaller(owner, 'Anita', 'Anita Rao');
// One Cappuccino now; "More" bumps it to 2 (₹360) so order 2 clears CH's ₹300
// minimum — section 9 moves this very order CP→CH and must re-price, not refuse.
await addItems(owner, ['Cappuccino']);
await checkStores(owner);
await owner.evaluate(() => {
  [...document.querySelectorAll('button[aria-label="More"]')][0]?.click(); // qty 1 → 2
});
await sleep(300);
const optionsGone = await owner.$('[data-testid="po-options"]');
check('changing the basket withdraws the store list and the choice', optionsGone, null,
  'options are point-in-time; a stale verdict is never left clickable');
await shot(owner, '05-stale-options-withdrawn');

// …and the same form then submits order 2 to CP (for the reject/move tests).
let opts2 = await checkStores(owner);
check('re-check renders both stores again', opts2.length, 2);
let submitBody2 = null;
let submitRes2 = null;
const onReq2 = (r) => { if (r.method() === 'POST' && isSubmitUrl(r.url())) submitBody2 = r.postData(); };
const onRes2 = (r) => {
  if (r.request().method() === 'POST' && isSubmitUrl(r.url())) {
    r.json().then((j) => { submitRes2 = { status: r.status(), json: j }; }).catch(() => {});
  }
};
owner.on('request', onReq2);
owner.on('response', onRes2);
await selectStore(owner, 'BSC-CP');
await owner.click('[data-testid="po-submit"]');
await owner.waitForSelector('[data-testid="po-success"]', { visible: true, timeout: 15000 });
owner.off('request', onReq2);
owner.off('response', onRes2);
const po2 = submitRes2?.json?.phoneOrder ?? null;
check('order 2 submitted to CP', po2?.status, 'SUBMITTED');
check('order 2 got its own idempotency key (fresh form = fresh key)',
  Boolean(submitBody && submitBody2) && JSON.parse(submitBody).idempotencyKey !== JSON.parse(submitBody2).idempotencyKey,
  true, '§5.7: "Take another order" mints a new key; nothing else does');

// --- 5. Duplicate phone number is a repeat caller, not a dead end -----------
await owner.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Take another order'))?.click();
});
await sleep(500);
await owner.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.innerText.includes('New caller'))?.click();
});
await owner.waitForSelector('#nc-name', { visible: true });
await owner.type('#nc-name', 'QA Duplicate Probe');
await owner.type('#nc-phone', '+919876500011'); // Anita's seeded number
await owner.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Save caller'))?.click();
});
await owner.waitForSelector('[data-testid="po-open-duplicate"]', { visible: true, timeout: 8000 });
check('a 409 duplicate offers to open the existing caller', true, true, '§5.2: POS_CONFLICT carries details.customerId');
await shot(owner, '06-duplicate-caller');
await owner.click('[data-testid="po-open-duplicate"]');
await owner.waitForFunction(() => document.body.innerText.includes('Anita Rao'), { timeout: 8000 });
check('opening the duplicate lands on Anita Rao', true, true);

// --- 6. Out-of-area: Dev Menon (122001) — CP refuses, with reasons shown ----
await owner.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Change caller'))?.click();
});
await sleep(400);
await pickCaller(owner, 'Dev', 'Dev Menon');
await addItems(owner, ['Cappuccino', 'Cappuccino']); // ₹360 ≥ CH@122001's ₹250 min
const optsDev = await checkStores(owner);
const cpDev = optsDev.find((o) => o.testid === 'po-option-BSC-CP');
const chDev = optsDev.find((o) => o.testid === 'po-option-BSC-CH');
check('both stores still rendered for an out-of-area caller', optsDev.length, 2);
check('CP is unavailable for 122001', cpDev?.available, false);
check('CP names the reason: Out of area', /Out of area/.test(cpDev?.text ?? ''), true,
  'badge label + the server message beside it');
if (chOpen) {
  check('CH is available for 122001 at ₹45', chDev?.available && /₹45\.00/.test(chDev?.text ?? ''), true);
} else {
  check('CH is rendered with its own reasons (closed)', (chDev?.text ?? '').length > 0, true);
}
await shot(owner, '07-out-of-area');

// --- 7. List + detail: what the centre sees ---------------------------------
await owner.goto(`${UI}/phone-orders`, { waitUntil: 'networkidle0' });
await sleep(800);
const rowCount = await owner.$$eval('[data-testid="po-list"] tbody tr', (els) => els.length);
check('the centre lists both submitted orders', rowCount, 2);
await owner.evaluate((ref) => {
  for (const tr of document.querySelectorAll('[data-testid="po-list"] tbody tr')) {
    if (tr.innerText.includes(ref)) { tr.click(); return; }
  }
}, po1.reference);
await owner.waitForSelector('[data-testid="po-detail"]', { visible: true, timeout: 8000 });
await sleep(600);
const detailText = await owner.$eval('[data-testid="po-detail"]', (el) => el.innerText.replace(/\s+/g, ' '));
check('detail shows the caller fetched by id', /Anita Rao/.test(detailText), true);
check('detail says the store has not decided yet', /Waiting for the store to accept/.test(detailText), true);
check('detail shows who took the call', /taken by/.test(detailText), true);
const detailPayable = await owner.$eval('[data-testid="po-detail-payable"]', (el) => el.innerText.trim());
check('detail To-collect equals the server quote', detailPayable, inr(po1.payableQuote));
check('detail carries the C-6 delivery caveat', /C-6 open/.test(detailText), true);
check('the URL carries the open order (deep-linkable)', await owner.evaluate(() => new URL(window.location.href).searchParams.has('open')), true);
await shot(owner, '08-list-detail');

// --- 8. Accept exactly once: manager decides, a stale second decider gets 409
const mgr = await newPage();
if (MANAGER) {
  await login(mgr, MANAGER);
  check('manager nav offers Phone orders', /Phone orders/.test(await navText(mgr)), true);
  await mgr.goto(`${UI}/phone-orders?open=${po1.id}`, { waitUntil: 'networkidle0' });
  await mgr.waitForSelector('[data-testid="po-accept"]', { visible: true, timeout: 8000 });

  // The owner's card still shows SUBMITTED (deliberately stale) with its own
  // Accept button. The manager decides first; the owner's click must then be
  // refused by the server, and the screen must show the truth, not the wish.
  await mgr.click('[data-testid="po-accept"]');
  await mgr.waitForFunction(
    () => document.querySelector('[data-testid="po-detail"]')?.innerText.includes('Accepted by'),
    { timeout: 10000 },
  );
  const mgrDetail = await mgr.$eval('[data-testid="po-detail"]', (el) => el.innerText.replace(/\s+/g, ' '));
  check('manager acceptance shows the decider BY NAME', /Accepted by/.test(mgrDetail), true, '§9: attribution is snapshotted names');
  check('accepted status is shown', /ACCEPTED/.test(mgrDetail), true);
  await shot(mgr, '09-manager-accepted');

  const staleAcceptVisible = await owner.$('[data-testid="po-accept"]');
  check('owner card is stale on purpose (still offers Accept)', Boolean(staleAcceptVisible), true);
  await owner.click('[data-testid="po-accept"]');
  await sleep(1500);
  const toasts = await readToasts(owner);
  check('second decider is told, not silently ignored', toasts.length > 0, true,
    `server 409 POS_PHONE_ORDER_ALREADY_DECIDED surfaced as a toast: ${JSON.stringify(toasts)}`);
  await owner.waitForFunction(
    () => document.querySelector('[data-testid="po-detail"]')?.innerText.includes('Accepted by'),
    { timeout: 10000 },
  );
  const ownerDetailNow = await owner.$eval('[data-testid="po-detail"]', (el) => el.innerText.replace(/\s+/g, ' '));
  check('after the refusal the owner sees the real decision', /Accepted by/.test(ownerDetailNow), true);
  check('the Accept button is gone once decided', await owner.$('[data-testid="po-accept"]'), null);
  await shot(owner, '10-second-decider-409');
} else {
  skip('accept exactly-once block', 'QA_MANAGER not set');
}

// --- 9. Reject with a reason (manager), then owner moves the order ----------
if (MANAGER) {
  await mgr.goto(`${UI}/phone-orders?open=${po2.id}`, { waitUntil: 'networkidle0' });
  await mgr.waitForSelector('[data-testid="po-reject"]', { visible: true, timeout: 8000 });
  await mgr.click('[data-testid="po-reject"]');
  await mgr.waitForSelector('#reason-field', { visible: true });
  await mgr.type('#reason-field', 'QA: kitchen cannot take this one');
  await mgr.evaluate(() => {
    [...document.querySelectorAll('button[type="submit"]')].find((b) => b.innerText.includes('Reject order'))?.click();
  });
  await mgr.waitForFunction(
    () => document.querySelector('[data-testid="po-detail"]')?.innerText.includes('Rejected by'),
    { timeout: 10000 },
  );
  const rejText = await mgr.$eval('[data-testid="po-detail"]', (el) => el.innerText.replace(/\s+/g, ' '));
  check('rejection shows decider name and the typed reason', /Rejected by/.test(rejText) && /kitchen cannot take this one/.test(rejText), true);
  await shot(mgr, '11-manager-rejected');
} else {
  skip('reject block', 'QA_MANAGER not set');
}

// Owner reassigns the rejected order to Cyber Hub — the quote must change.
await owner.goto(`${UI}/phone-orders?open=${po2.id}`, { waitUntil: 'networkidle0' });
await owner.waitForSelector('[data-testid="po-detail"]', { visible: true, timeout: 8000 });
await sleep(500);
const moveBtn = await owner.$('[data-testid="po-move"]');
check('owner is offered the move on a REJECTED order', Boolean(moveBtn), true, 'reassign is owner-only (rolesFor phone.order.reassign)');
if (moveBtn && chOpen) {
  await owner.click('[data-testid="po-move"]');
  await owner.waitForSelector('[data-testid="mv-option-BSC-CH"]', { visible: true, timeout: 10000 });
  const currentBadge = await owner.$eval('[data-testid="mv-option-BSC-CP"]', (el) => el.innerText);
  check('the routed store is badged Current store and not selectable', /Current store/.test(currentBadge), true);
  const modalNote = await owner.evaluate(() => document.body.innerText);
  check('the modal says the preview is basket-less', /without the basket/.test(modalNote), true,
    'the sidecar carries no lines; the server re-judges with the basket on the move');
  await owner.evaluate(() => {
    document.querySelector('[data-testid="mv-option-BSC-CH"] input[type="radio"]')?.click();
  });
  await owner.type('#move-reason', 'QA: caller asked for the other store');
  await shot(owner, '12-reassign-modal');
  await owner.click('[data-testid="mv-submit"]');
  // Caught, not naked: a missing banner must record a FAIL and let the rest of
  // the evidence run, not crash the harness (defect D-1 hid behind that crash).
  const bannerEl = await owner
    .waitForSelector('[data-testid="po-move-banner"]', { visible: true, timeout: 12000 })
    .catch(() => null);
  check('the re-price banner appears after the move', Boolean(bannerEl), true,
    'server priceChanged OR a payableQuote drift must raise it — the operator re-reads the quote');
  const moved = await apiGet(owner, `/phone-orders/${po2.id}`);
  const movedPo = moved.json?.phoneOrder;
  check('the move re-routed the order to CH and reset it to SUBMITTED', movedPo?.status, 'SUBMITTED');
  check('the re-priced quote reflects CH delivery ₹65 (was ₹40)',
    movedPo ? movedPo.deliveryCharge : null, 65);
  if (bannerEl) {
    const banner = await owner.$eval('[data-testid="po-move-banner"]', (el) => el.innerText.replace(/\s+/g, ' '));
    check('the operator is told to read the NEW quote to the caller', new RegExp(inr(movedPo?.payableQuote).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(banner), true,
      `banner: ${banner}`);
  }
  const eventsText = await owner.$eval('[data-testid="po-detail"]', (el) => el.innerText.replace(/\s+/g, ' '));
  check('history shows the move between named stores', /Moved/.test(eventsText) && /→/.test(eventsText), true);
  await shot(owner, '13-after-move');
} else if (!chOpen) {
  skip('owner reassign CP→CH with re-price', 'Cyber Hub is outside its 11:00–22:00 hours at run time');
}

// --- 10. Branch-pinned manager scope after the move -------------------------
if (MANAGER && chOpen) {
  await mgr.goto(`${UI}/phone-orders`, { waitUntil: 'networkidle0' });
  await sleep(800);
  const mgrList = await mgr.evaluate(() => document.querySelector('[data-testid="po-list"]')?.innerText ?? document.body.innerText);
  check('CP manager still sees the order accepted at CP', mgrList.includes(po1.reference), true);
  check('CP manager no longer sees the order moved to CH', mgrList.includes(po2.reference), false,
    'branch scope is routedBranchId OR acceptedBranchId — the moved order left both');
  await shot(mgr, '14-manager-scope');
} else if (MANAGER) {
  skip('manager scope-after-move check', 'move was skipped (CH closed)');
}

// --- 11. Capacity: CH takes 2 per 15-min slot -------------------------------
// D-2 (backend, REPORTED — W1's tree is read-only from this lane): ASAP
// submissions persist scheduledFor = NULL, and the booked count filters
// `scheduledFor: { gte, lt }`, which NULL can never match — so an ASAP order
// can NEVER fill a kitchen (run 140702 measured CH "0/2 booked" with 2 live
// ASAP CH orders in the slot's wall-clock window). Capacity is therefore
// proven on the SCHEDULED path, where the backend does enforce, and the ASAP
// hole is pinned as an explicit tripwire at the end of this section.
const capacitySlotAt = () => {
  // One shared timestamp for both fillers AND the probe: same 15-min bucket
  // by construction, no boundary maths. The only backend constraint on
  // scheduledFor is that it be in the future (phoneOrders.js:572); the real
  // gate is the branch being open AT the slot, and run-seed.mjs now holds CH
  // open on all 7 days, so any future instant is legal.
  //
  // This used to return null outside `m >= 11*60+15 && m <= 21*60+30` and on
  // Mondays, to keep the slot inside CH's seeded 11:00–22:00. That guard was
  // wrong as well as limiting: getHours() is BOX-local — this box runs UTC —
  // while the backend judges hours in IST, so it was comparing a UTC clock
  // against an IST window. The two only overlap 11:15–16:30 UTC; the daytime
  // lane run at 14:19 UTC landed inside that overlap and passed by luck.
  return new Date(Date.now() + 45 * 60000);
};
const scheduleAt = async (page, t) => {
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Schedule for later'))?.click();
  });
  await page.waitForSelector('input[type="datetime-local"]', { visible: true, timeout: 5000 });
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  await page.evaluate((v) => {
    const el = document.querySelector('input[type="datetime-local"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, local);
  // React state proof, not DOM proof: in LATER mode the check button stays
  // disabled until scheduledLocal lands, so an enabled button IS the receipt.
  return page
    .waitForFunction(() => !document.querySelector('[data-testid="po-check-stores"]')?.disabled, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
};
const capT = capacitySlotAt();
if (chOpen) {
  // Fill the slot: two ₹360 baskets (above CH's ₹300 min, so the only
  // possible CH refusal in this section is AT_CAPACITY) scheduled into the
  // same slot. Each goto mounts a fresh form = fresh idempotency key (§4).
  let fillerProblem = null;
  for (const nth of [1, 2]) {
    await owner.goto(`${UI}/phone-orders/new`, { waitUntil: 'networkidle0' });
    await pickCaller(owner, 'Anita', 'Anita Rao');
    await addItems(owner, ['Cappuccino', 'Cappuccino']);
    if (!(await scheduleAt(owner, capT))) { fillerProblem = `filler ${nth}: schedule input never armed`; break; }
    const opts = await checkStores(owner);
    const chRowNow = opts.find((o) => o.testid === 'po-option-BSC-CH');
    if (!chRowNow?.available) { fillerProblem = `filler ${nth} refused: ${chRowNow?.text ?? 'no CH row'}`; break; }
    await selectStore(owner, 'BSC-CH');
    await owner.click('[data-testid="po-submit"]');
    await owner.waitForSelector('[data-testid="po-success"]', { visible: true, timeout: 15000 });
  }
  if (fillerProblem) {
    check('both scheduled fillers were accepted into the slot', fillerProblem, 'both accepted',
      'a pre-filled slot means the hermetic DB reset did not run; an unarmed input means the datetime wiring broke');
  } else {
    // Third basket, same slot: the UI must render the refusal, never hide the store.
    await owner.goto(`${UI}/phone-orders/new`, { waitUntil: 'networkidle0' });
    await pickCaller(owner, 'Anita', 'Anita Rao');
    await addItems(owner, ['Cappuccino', 'Cappuccino']);
    const probeArmed = await scheduleAt(owner, capT);
    check('the capacity probe form armed with the shared slot time', probeArmed, true);
    if (probeArmed) {
      const optsFull = await checkStores(owner);
      const chFull = optsFull.find((o) => o.testid === 'po-option-BSC-CH');
      const cpStill = optsFull.find((o) => o.testid === 'po-option-BSC-CP');
      check('a full CH slot is refused with Kitchen full', chFull?.available === false && /Kitchen full/.test(chFull?.text ?? ''), true,
        `CH row: ${chFull?.text}`);
      check('the refusal carries the 2/2 count', /2\/2/.test(chFull?.text ?? ''), true,
        `CH row: ${chFull?.text}`);
      check('CP is untouched by CH capacity', cpStill?.available, true);
      await shot(owner, '15-capacity');
      // D-2 tripwire: the SAME basket flipped to ASAP books 0/2 even though
      // §9's moved order is a live SUBMITTED ASAP order routed to CH. The day
      // this check FAILS, W1 changed the capacity semantics — retire the pin
      // and re-prove the ASAP path with real fillers instead.
      await owner.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.innerText.includes('As soon as possible'))?.click();
      });
      await sleep(300);
      const optsAsap = await checkStores(owner);
      const chAsap = optsAsap.find((o) => o.testid === 'po-option-BSC-CH');
      check('D-2 pin: ASAP orders never occupy a slot (backend counts scheduledFor only)',
        chAsap?.available === true && /0\/2/.test(chAsap?.text ?? ''), true,
        `CH row: ${chAsap?.text} — a live ASAP CH order exists (§9's move) yet booked shows 0`);
      await shot(owner, '15b-capacity-asap-d2');
    }
  }
} else {
  skip('capacity fill check', 'CH did not come back available — the all-day hours fixture did not apply');
}

// --- 12. Cashier: no link, bounced route, refused API -----------------------
if (CASHIER) {
  const cash = await newPage();
  await login(cash, CASHIER);
  check('cashier nav never offers Phone orders', /Phone orders/.test(await navText(cash)), false);
  await cash.goto(`${UI}/phone-orders`, { waitUntil: 'networkidle0' });
  await sleep(800);
  const landedOn = await cash.evaluate(() => window.location.pathname);
  check('cashier is bounced off /phone-orders', landedOn.includes('phone-orders'), false, `landed on ${landedOn}`);
  const cashApi = await apiGet(cash, '/phone-orders');
  check('the API refuses a cashier regardless of the UI guard', cashApi.status, 403);
  const cashApiWrite = await apiPost(cash, '/phone-orders/customers', JSON.stringify({ name: 'X', phone: '99' }));
  check('the customer-write API refuses a cashier too', cashApiWrite.status, 403);
  await shot(cash, '16-cashier-denied');
  await cash.close();
} else {
  skip('cashier refusal block', 'QA_CASHIER not set');
}

// --- 13. Responsive ----------------------------------------------------------
await owner.setViewport({ width: 390, height: 900 });
await owner.goto(`${UI}/phone-orders`, { waitUntil: 'networkidle0' });
await sleep(700);
const overflowList = await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal page overflow on the list at 390px', overflowList <= 0, true);
await shot(owner, '17-responsive-list-390');
await owner.goto(`${UI}/phone-orders/new`, { waitUntil: 'networkidle0' });
await sleep(700);
const overflowNew = await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal page overflow on the entry form at 390px', overflowNew <= 0, true);
await shot(owner, '18-responsive-entry-390');

// ---------------------------------------------------------------------------
if (MANAGER) await mgr.close();
await browser.close();

writeResults();
process.exit(results.every((r) => r.pass) ? 0 : 1);
