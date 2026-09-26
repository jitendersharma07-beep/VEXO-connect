// x/operator-ui acceptance — BROWSER JOURNEYS for VC-102 promotions.
//
// Why this exists alongside tests/e2e/walk-promotions.cjs rather than replacing
// it. That walk is repo-owned and is left exactly as its authors wrote it. Of
// its fourteen steps, seven (6-12) drive a cashier-facing offers panel on the
// Sell screen — "Offers running", an aria-labelled promo-code box, Apply and
// Remove buttons. `Sell.jsx` contains no promotion code at all, and no branch
// in this repository contains that UI. Those steps were inherited from 357e617
// (the salvage of the w2-frontend drafts), not written against a built screen.
// Editing them to pass would be papering over unbuilt scope, and deleting them
// would destroy the record that the scope was once specified. So they stay
// untouched and unrun, and the journeys that ARE in this lane's scope are
// driven here instead.
//
// What makes this a harness and not a click-script: every browser assertion
// that claims a write happened is read back out of Postgres. The screen saying
// "Archived" is presentation. `status = 'ARCHIVED'` in the row is the fact.
// That is the same rule the API harnesses in this directory follow, and it is
// the reason a green run here means something.
//
// Runs at 1440x900 on purpose — the viewport that exposed the modal-clipping
// defect. A journey suite that only ever runs at 1920x1080 would not have
// found it.

import { createRequire } from 'node:module';
import {
  UI, seed, sql, check, ok, no, section, verdict, truthy, makeRivalTenant,
  sessions, client,
} from './opui-lib.mjs';

const require = createRequire(import.meta.url);
const PW = process.env.POS_E2E_PLAYWRIGHT
  || '/home/atc-noc/.npm/_npx/f0a362733743bae2/node_modules/playwright-core';
const CHROMIUM = process.env.POS_E2E_CHROMIUM
  || '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';
const SHOTS = process.env.POS_E2E_SHOTS || '/tmp/vcx-opui-shots';

const RUN = Date.now().toString(36).slice(-5);
const RULES_NAME = `Journey rule ${RUN}`;
const REFUSED_NAME = `Journey refused ${RUN}`;
const STATION_NAME = `Journey Pass ${RUN}`;

let shotN = 0;

const launch = async () => {
  const { chromium } = require(PW);
  try {
    return await chromium.launch({ headless: true, chromiumSandbox: false });
  } catch {
    return await chromium.launch({ headless: true, chromiumSandbox: false, executablePath: CHROMIUM });
  }
};

const signIn = async (page, email, password) => {
  await page.goto(`${UI}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
};

const shot = async (page, name) => {
  shotN += 1;
  await page.screenshot({ path: `${SHOTS}/j-${String(shotN).padStart(2, '0')}-${name}.png` })
    .catch(() => {});
};

// A browser step that must not throw. Any throw is a failed assertion, not a
// crash: the run continues so one broken journey does not hide the other five.
const journey = async (page, name, fn) => {
  try {
    await fn();
    ok(name);
    return true;
  } catch (e) {
    no(`${name} — ${String(e.message || e).split('\n')[0]}`);
    await shot(page, 'FAIL-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40));
    return false;
  }
};

const main = async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const bad5xx = [];
  page.on('response', (r) => { if (r.status() >= 500) bad5xx.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  // ------------------------------------------------------------- owner entry
  section('the owner reaches the promotions screen in a real browser');
  await journey(page, 'owner signs in and lands on the dashboard', async () => {
    await signIn(page, 'demo.owner@atcpos.example', seed.OWNER);
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });
  await journey(page, 'promotions screen is reachable from the nav', async () => {
    await page.click('nav >> text=Promotions');
    await page.waitForSelector('text=Live now');
    await shot(page, 'promotions');
  });

  // ------------------------------------------------- refusal leaves no trace
  // The interesting half of a refusal is not the message, it is that nothing
  // was written. A screen that shows an error but POSTed anyway is worse than
  // one that shows nothing.
  section('a server refusal surfaces AND writes nothing');
  await journey(page, 'percent above 100 is refused, and no row is created', async () => {
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');
    await page.fill('#promo-name', REFUSED_NAME);
    await page.fill('#promo-value', '150');
    await page.click('button[type="submit"]:has-text("Create draft")');
    await page.waitForSelector('text=/less than or equal to 100/i');
    const rows = sql(`select count(*) from "Promotion" where name = '${REFUSED_NAME}'`);
    if (rows !== '0') throw new Error(`refused promotion still wrote ${rows} row(s)`);
    // Close it the way a user would, at a viewport where that used to be
    // impossible; this is the regression guard for the modal fix.
    await page.locator('div.fixed div.mb-4 button').click({ timeout: 5000 });
    await page.waitForSelector('#promo-name', { state: 'detached', timeout: 5000 });
  });

  // ------------------------------------------------------ rules round-trip
  section('an item rule survives POST → PUT /rules → GET, and reaches the database');
  let promoId = null;
  await journey(page, 'draft with an INCLUDE_PRODUCT rule round-trips to the list', async () => {
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');
    await page.fill('#promo-name', RULES_NAME);
    await page.fill('#promo-value', '5');
    await page.selectOption('select[aria-label="Rule kind"]', 'INCLUDE_PRODUCT');
    // state:'attached', and the distinction is not pedantry. waitForSelector
    // defaults to state:'visible', and an <option> inside a collapsed <select>
    // has no box, so it is never "visible" — the default spelling of this wait
    // cannot pass no matter how well the catalogue loads. Measured: 'visible'
    // times out at 4000ms with seven options sitting in the DOM; 'attached'
    // resolves in 9ms. tests/e2e/walk-promotions.cjs:207 has the default
    // spelling and would never have gone green; see the handoff note.
    await page.waitForSelector('select[aria-label="Item"] option:nth-child(2)', { state: 'attached' });
    await page.selectOption('select[aria-label="Item"]', { label: 'Cappuccino' });
    await page.click('button:has-text("Add rule")');
    await page.waitForSelector('text=Only this item: Cappuccino');
    await page.click('button[type="submit"]:has-text("Create draft")');
    await page.waitForSelector(`tr:has-text("${RULES_NAME}"):has-text("Only this item: Cappuccino")`);
    await shot(page, 'rule-round-trip');
  });

  // The list rendering the rule back proves the GET. Postgres proves the write.
  promoId = sql(`select id from "Promotion" where name = '${RULES_NAME}'`);
  truthy('the promotion exists in the database', promoId);
  if (promoId) {
    check('it is a DRAFT, as the journey intends',
      sql(`select status from "Promotion" where id = '${promoId}'`), 'DRAFT');
    check('exactly one item rule was stored',
      sql(`select count(*) from "PromotionItemRule" where "promotionId" = '${promoId}'`), 1);
    check('the stored rule is INCLUDE_PRODUCT',
      sql(`select kind from "PromotionItemRule" where "promotionId" = '${promoId}'`), 'INCLUDE_PRODUCT');
    check('the stored rule names Cappuccino by product id, not by label',
      sql(`select p.name from "PromotionItemRule" r join "Product" p on p.id = r."productId"
           where r."promotionId" = '${promoId}'`), 'Cappuccino');
    check('the rule set no categoryId (exactly one target, matching the kind)',
      sql(`select "categoryId" is null from "PromotionItemRule" where "promotionId" = '${promoId}'`), 't');
  }

  // ------------------------------------------------------------- archive
  section('archive asks first; cancelling changes nothing; confirming is terminal');
  await journey(page, 'the confirm prompt appears and "Keep it" leaves the row a DRAFT', async () => {
    await page.locator(`tr:has-text("${RULES_NAME}") button:has-text("Archive")`).click();
    await page.waitForSelector('text=Archive this promotion?');
    await page.click('button:has-text("Keep it")');
    await page.waitForSelector('text=Archive this promotion?', { state: 'detached' });
    await page.waitForSelector(`tr:has-text("${RULES_NAME}"):has-text("Draft")`);
    const after = sql(`select status from "Promotion" where id = '${promoId}'`);
    if (after !== 'DRAFT') throw new Error(`"Keep it" still changed the row to ${after}`);
  });

  await journey(page, 'confirming archives the row and withdraws its write controls', async () => {
    await page.locator(`tr:has-text("${RULES_NAME}") button:has-text("Archive")`).click();
    await page.waitForSelector('text=Archive this promotion?');
    await page.click('button:has-text("Archive permanently")');
    await page.waitForSelector(`tr:has-text("${RULES_NAME}"):has-text("Archived")`);
    const edits = await page.locator(`tr:has-text("${RULES_NAME}") button:has-text("Edit")`).count();
    if (edits !== 0) throw new Error('an archived row still offers Edit');
    await shot(page, 'archived');
  });
  check('the database agrees the promotion is ARCHIVED',
    sql(`select status from "Promotion" where id = '${promoId}'`), 'ARCHIVED');

  // ============================================================= VC-103 KDS
  // tests/e2e/walk-kitchen-fixtures.cjs proves the three kitchen screens RENDER
  // a known payload — it intercepts `**/api/kitchen/**` and answers from a
  // literal, so nothing it asserts ever reaches Postgres. Deliberate on its
  // part, and it is why it cannot be the evidence for "verified against the
  // real API". These journeys are the other half: real stations, a real KOT
  // through the real routing, the real 4s poll loop, and every transition the
  // screen claims read back out of the database.
  //
  // The seed ships ZERO KitchenStation and ZERO KitchenItem rows, so there is
  // nothing to drive a board with until this builds it. Fixtures go through the
  // API (POST /kitchen/stations, POST /orders, POST /orders/:id/kot) and never
  // by INSERTing KitchenItem directly: routing, changeSeq and targetSeconds are
  // decided by routeKotItems(), and a hand-built row would only assert this
  // harness's assumptions back at itself.
  section('VC-103 kitchen: a real station and a real KOT, built through the API');
  const s = await sessions();
  const owner = client(s.owner);
  const companyId = s.owner.user.companyId;
  // The manager's pinned branch, so the owner's picked store and the pinned
  // roles' implicit one are the same board.
  const kBranchId = s.manager.user.branchId;
  truthy('the manager is pinned to a branch, which is the board under test', kBranchId);

  const cappuccinoId = sql(`select id from "Product" where "companyId" = '${companyId}' and name = 'Cappuccino'`);
  const sandwichId = sql(`select id from "Product" where "companyId" = '${companyId}' and name = 'Veg Sandwich'`);
  truthy('the demo menu has Cappuccino to cook', cappuccinoId);
  truthy('the demo menu has Veg Sandwich to cook', sandwichId);

  let stationId = null;
  let station2Id = null;
  let kOrderId = null;
  const stationRes = await owner.post('/kitchen/stations', {
    branchId: kBranchId, name: STATION_NAME, isDefault: true, targetPrepSeconds: 600, sortOrder: 5,
  });
  stationId = stationRes.data?.station?.id ?? null;
  truthy('the owner created the journey station', stationId);
  // A SECOND station, and not for symmetry. KitchenStation.jsx:220 renders the
  // station picker only when stations.length > 1 — a store with one station
  // deliberately offers no choice, the same reasoning as the single-store
  // auto-pick. So "the isDefault station is preselected" is not even a
  // observable claim until a second station exists to be preselected over.
  const station2Res = await owner.post('/kitchen/stations', {
    branchId: kBranchId, name: `${STATION_NAME} Grill`, targetPrepSeconds: 900, sortOrder: 15,
  });
  station2Id = station2Res.data?.station?.id ?? null;
  truthy('the owner created a second station, so the picker has something to pick', station2Id);
  check('only the first station is flagged the branch default',
    sql(`select count(*) from "KitchenStation" where "branchId" = '${kBranchId}' and "defaultForBranch" is not null`), 1);
  const orderRes = await owner.post('/orders', {
    type: 'TAKEAWAY',
    branchId: kBranchId,
    items: [{ productId: cappuccinoId, qty: 2 }, { productId: sandwichId, qty: 1 }],
  });
  kOrderId = orderRes.data?.order?.id ?? null;
  truthy('the owner opened a two-line takeaway order', kOrderId);
  if (kOrderId) {
    await owner.post(`/orders/${kOrderId}/kot`);
    check('sending the KOT minted one ticket line per order line',
      sql(`select count(*) from "KitchenItem" where "orderId" = '${kOrderId}'`), 2);
    check('both lines routed to the journey station (no rules, so the store default)',
      sql(`select count(*) from "KitchenItem" where "orderId" = '${kOrderId}' and "stationId" = '${stationId}'`), 2);
    check('both lines start QUEUED',
      sql(`select count(*) from "KitchenItem" where "orderId" = '${kOrderId}' and state = 'QUEUED'`), 2);
  }

  const cappItemId = kOrderId ? sql(
    `select ki.id from "KitchenItem" ki join "OrderItem" oi on oi.id = ki."orderItemId"
     where ki."orderId" = '${kOrderId}' and oi.name = 'Cappuccino'`,
  ) : '';

  // --------------------------------------------------- owner branch selection
  // An owner's PosUser.branchId is null, so every kitchen call needs an explicit
  // ?branchId= and the screen must ask for one. This company has TWO active
  // stores, so useKitchenBranch's single-store auto-pick does not fire — the
  // picker is the only way to address the API at all, and if it were broken the
  // board would never poll even once.
  section('the owner picks a store before any kitchen call is made');
  const kitchenCalls = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/kitchen/')) kitchenCalls.push(u.replace(/^https?:\/\/[^/]+/, ''));
  });
  await journey(page, 'no kitchen call is made while the store is still unchosen', async () => {
    await page.goto(`${UI}/kitchen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('select[aria-label="Store"]', { timeout: 10000 });
    await page.waitForTimeout(1200);
    if (kitchenCalls.length !== 0) {
      throw new Error(`polled ${kitchenCalls.length} time(s) before a store was chosen: ${kitchenCalls[0]}`);
    }
    const opts = await page.locator('select[aria-label="Store"] option').count();
    if (opts < 3) throw new Error(`store picker offers ${opts} option(s); two stores + placeholder expected`);
  });

  await journey(page, 'choosing the store starts the poll and paints the real board', async () => {
    await page.selectOption('select[aria-label="Store"]', kBranchId);
    await page.waitForSelector('text=Cappuccino', { timeout: 15000 });
    if (kitchenCalls.length === 0) throw new Error('the board painted without any /api/kitchen call — not the real API');
    // Two stations exist, so the picker must be on screen and must have opened
    // on the isDefault one rather than merely the first the API listed.
    const pickers = await page.locator('select[aria-label="Station"]').count();
    if (pickers !== 1) throw new Error(`expected one station picker for a two-station store, found ${pickers}`);
    const st = await page.$eval('select[aria-label="Station"]', (el) => el.value);
    if (st !== stationId) throw new Error(`preselected station is ${st}, want the isDefault station ${stationId}`);
    await shot(page, 'kds-station-real');
  });

  await journey(page, 'the board shows the quantity and the KOT the backend actually stored', async () => {
    const body = await page.evaluate(() => document.body.innerText);
    if (!/2 × Cappuccino/.test(body)) throw new Error('the 2 × Cappuccino line did not render');
    if (!/Veg Sandwich/.test(body)) throw new Error('the second routed line did not render');
    const kotSeq = sql(`select k.seq from "Kot" k where k."orderId" = '${kOrderId}' order by k.seq limit 1`);
    if (!new RegExp(`KOT #${kotSeq}`).test(body)) throw new Error(`board does not show KOT #${kotSeq} from the stored row`);
  });

  // ----------------------------------------------------------- a transition
  // The screen saying IN_PREP is presentation. The row is the fact.
  section('a transition driven from the browser reaches Postgres');
  await journey(page, 'Start moves the ticket to IN_PREP, bumps the version and stamps startedAt', async () => {
    if (!cappItemId) throw new Error('no Cappuccino ticket row to advance — this check would pass vacuously');
    const before = sql(`select version from "KitchenItem" where id = '${cappItemId}'`);
    check('the ticket is QUEUED before the click',
      sql(`select state from "KitchenItem" where id = '${cappItemId}'`), 'QUEUED');
    await page.locator('button:has-text("Start")').first().click();
    // Poll the row rather than sleeping a guessed interval: the optimistic
    // update paints before the POST lands, so a fixed wait would be racing it.
    let state = '';
    for (let i = 0; i < 20; i += 1) {
      state = sql(`select state from "KitchenItem" where id = '${cappItemId}'`);
      if (state === 'IN_PREP') break;
      await page.waitForTimeout(250);
    }
    if (state !== 'IN_PREP') throw new Error(`the row is still ${state} after the Start click`);
    const after = sql(`select version from "KitchenItem" where id = '${cappItemId}'`);
    if (Number(after) <= Number(before)) throw new Error(`version did not advance (${before} → ${after})`);
    check('startedAt was stamped by the server',
      sql(`select "startedAt" is not null from "KitchenItem" where id = '${cappItemId}'`), 't');
    await shot(page, 'kds-after-start');
  });

  // ------------------------------------------------------- supervisor counts
  // managerUp only. The numbers must come from /kitchen/overview, not from the
  // board the screen already has — that is the whole reason the route exists.
  section('the supervisor screen consumes the authoritative /kitchen/overview');
  await journey(page, 'overview renders, and its per-station split matches SQL', async () => {
    await page.goto(`${UI}/kitchen/supervisor`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('select[aria-label="Store"] option:nth-child(2)', { state: 'attached' });
    await page.selectOption('select[aria-label="Store"]', kBranchId);
    await page.waitForSelector(`text=${STATION_NAME}`, { timeout: 15000 });
    // Only overview.lastChangeAt can render this footer, so its presence is the
    // proof the authoritative route answered rather than the board fallback.
    await page.waitForSelector('text=Last kitchen change', { timeout: 15000 });
    const body = await page.evaluate(() => document.body.innerText);
    if (/Orders ready to serve\s*\n\s*—/i.test(body)) throw new Error('"Orders ready to serve" never left its pre-overview dash');
    if (/Could not load the kitchen overview/i.test(body)) throw new Error('the overview error banner is up');
    const queued = sql(`select count(*) from "KitchenItem" where "stationId" = '${stationId}' and state = 'QUEUED'`);
    const inPrep = sql(`select count(*) from "KitchenItem" where "stationId" = '${stationId}' and state = 'IN_PREP'`);
    const want = `${queued} queued · ${inPrep} cooking`;
    if (!body.includes(want)) throw new Error(`station card does not read "${want}" (SQL truth) — screen and database disagree`);
    ok(`the station card agrees with Postgres: ${want}`);
    await shot(page, 'kds-supervisor-real');
  });

  // ------------------------------------------------------- denied principal
  // The screen must not offer what the server will refuse. CASHIER resolves
  // promo.apply only — no promo.read — so the Promotions screen is not theirs.
  section('a CASHIER is not offered the promotions screen');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cashier = await ctx2.newPage();
  await journey(cashier, 'cashier signs in', async () => {
    await signIn(cashier, 'demo.cashier@atcpos.example', seed.CASHIER);
    await cashier.waitForURL('**/dashboard', { timeout: 15000 }).catch(() => {});
    await cashier.waitForSelector('nav', { timeout: 10000 });
  });
  await journey(cashier, 'the nav offers the cashier no Promotions link', async () => {
    const n = await cashier.locator('nav >> text=Promotions').count();
    if (n !== 0) throw new Error(`nav still offers Promotions to a cashier (${n} link(s))`);
  });
  await journey(cashier, 'typing the URL directly does not yield the promotions list', async () => {
    await cashier.goto(`${UI}/promotions`, { waitUntil: 'domcontentloaded' });
    await cashier.waitForTimeout(1500);
    const newBtn = await cashier.locator('button:has-text("New promotion")').count();
    if (newBtn !== 0) throw new Error('cashier was served the promotions editor controls');
    await shot(cashier, 'cashier-promotions-denied');
  });
  // managerUp kitchen screens are gated the same way (kitchen.js requireRole).
  await journey(cashier, 'the cashier is offered Station but not Supervisor', async () => {
    const station = await cashier.locator('nav >> text=Station').count();
    const supervisor = await cashier.locator('nav >> text=Supervisor').count();
    if (station === 0) throw new Error('cashier lost the Station screen, which operate allows');
    if (supervisor !== 0) throw new Error('cashier is offered Supervisor, which managerUp forbids');
  });
  // Hiding the link is not the gate. A cashier who types the URL must still be
  // refused by the server, and the screen must not render counts it was refused.
  await journey(cashier, 'typing /kitchen/supervisor gives a cashier no overview numbers', async () => {
    await cashier.goto(`${UI}/kitchen/supervisor`, { waitUntil: 'domcontentloaded' });
    await cashier.waitForTimeout(2500);
    const body = await cashier.evaluate(() => document.body.innerText);
    if (/Last kitchen change/.test(body)) throw new Error('a cashier was served the managerUp overview footer');
    if (STATION_NAME && body.includes(`${STATION_NAME}`) && /queued ·/.test(body)) {
      throw new Error('a cashier was served per-station supervisor counts');
    }
    await shot(cashier, 'cashier-supervisor-denied');
  });
  // The board itself IS a cashier's screen (operate) — and a denial journey
  // that cannot tell "correctly refused" from "screen is broken for everyone"
  // proves nothing, so assert the allowed half too.
  await journey(cashier, 'the same cashier CAN work the station board (operate is allowed)', async () => {
    await cashier.goto(`${UI}/kitchen`, { waitUntil: 'domcontentloaded' });
    // A pinned role takes its branch from the session: no picker, no choice.
    const pickers = await cashier.locator('select[aria-label="Store"]').count();
    if (pickers !== 0) throw new Error('a branch-pinned cashier was offered a store picker');
    await cashier.waitForSelector('text=Cappuccino', { timeout: 15000 });
  });
  await ctx2.close();

  // ---------------------------------------------------------- cross-tenant
  // The API harness already proves 404-not-403 on every verb. What a browser
  // adds is the question the API cannot answer: does a real signed-in rival
  // ever SEE tenant A's data on screen.
  section('a rival tenant signing in sees none of tenant A\'s promotions');
  const rival = await makeRivalTenant();
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rpage = await ctx3.newPage();
  await journey(rpage, 'the rival owner signs in to their own company', async () => {
    await signIn(rpage, rival.email, rival.password);
    await rpage.waitForURL('**/dashboard', { timeout: 15000 });
  });
  await journey(rpage, "tenant A's promotion is absent from the rival's screen", async () => {
    // Guard first. On the previous run this assertion passed while tenant A's
    // promotion did not exist — "the rival cannot see X" is worth nothing when
    // there is no X. An absent fixture must fail this, not satisfy it.
    if (!promoId) throw new Error('tenant A has no promotion to hide — this check would pass vacuously');
    await rpage.goto(`${UI}/promotions`, { waitUntil: 'domcontentloaded' });
    await rpage.waitForTimeout(2000);
    const body = await rpage.evaluate(() => document.body.innerText);
    if (body.includes(RULES_NAME)) throw new Error("the rival's screen shows tenant A's promotion by name");
    // Non-vacuous: prove the screen actually rendered rather than erroring out
    // blank, which would pass the check above for the wrong reason.
    if (!/promotion/i.test(body)) throw new Error('the rival got no promotions screen at all — check is vacuous');
    await shot(rpage, 'rival-promotions');
  });
  await journey(rpage, "a direct URL to tenant A's promotion does not reveal it", async () => {
    if (!promoId) throw new Error('no tenant A promotion id to probe with — this check would pass vacuously');
    await rpage.goto(`${UI}/promotions?id=${promoId}`, { waitUntil: 'domcontentloaded' });
    await rpage.waitForTimeout(1500);
    const body = await rpage.evaluate(() => document.body.innerText);
    if (body.includes(RULES_NAME)) throw new Error("tenant A's promotion name leaked into the rival's page");
  });

  // The kitchen half of the same question. A rival owner is a legitimate
  // CUSTOMER_OWNER — the gate that must hold here is tenancy, not role.
  await journey(rpage, "the rival's kitchen shows none of tenant A's stations or tickets", async () => {
    if (!stationId) throw new Error('tenant A has no station to hide — this check would pass vacuously');
    await rpage.goto(`${UI}/kitchen`, { waitUntil: 'domcontentloaded' });
    await rpage.waitForTimeout(2500);
    const body = await rpage.evaluate(() => document.body.innerText);
    if (body.includes(STATION_NAME)) throw new Error("tenant A's station name is on the rival's screen");
    if (/2 × Cappuccino/.test(body)) throw new Error("tenant A's ticket line is on the rival's screen");
    if (!/kitchen|station|store/i.test(body)) throw new Error('the rival got no kitchen screen at all — check is vacuous');
    await shot(rpage, 'rival-kitchen');
  });

  // Forging tenant A's branch id into the query the screen builds. This is the
  // refusal that matters most: guessing an id must be a 404, never a board.
  await journey(rpage, "forcing tenant A's branchId into the rival's session is refused", async () => {
    if (!kBranchId) throw new Error('no tenant A branch id to forge — this check would pass vacuously');
    const probe = await rpage.evaluate(async (bid) => {
      const r = await fetch(`/api/kitchen/stations?branchId=${bid}`, { credentials: 'include' });
      let n = -1;
      try { const j = await r.json(); n = Array.isArray(j.stations) ? j.stations.length : -1; } catch { /* non-JSON */ }
      return { status: r.status, stations: n };
    }, kBranchId);
    // 404, not 403: a 403 would confirm the branch exists, which is itself a
    // cross-tenant disclosure. opui-lib's refuses() holds API callers to the
    // same rule and the browser must not be the soft way in.
    if (probe.status !== 404) throw new Error(`cross-tenant branchId answered ${probe.status}, want 404 (403 would confirm the id exists)`);
    if (probe.stations > 0) throw new Error(`the rival was handed ${probe.stations} of tenant A's stations`);
  });
  await ctx3.close();

  // ---------------------------------------------------------------- tidy up
  // PromotionItemRule.promotion is onDelete: Restrict, so rules go first.
  section('the journey removes its own fixtures');
  if (promoId) {
    sql(`delete from "PromotionItemRule" where "promotionId" = '${promoId}'`);
    sql(`delete from "PromotionStore" where "promotionId" = '${promoId}'`);
    sql(`delete from "Promotion" where id = '${promoId}'`);
    check('no journey promotion survives the run',
      sql(`select count(*) from "Promotion" where name like 'Journey %'`), 0);
  }
  // KitchenItem → OrderItem → Kot → Order, then the station. The seed ships no
  // kitchen rows at all, so "zero" below is the true resting state and not a
  // count this harness talked itself into.
  if (kOrderId) {
    sql(`delete from "KitchenItem" where "orderId" = '${kOrderId}'`);
    sql(`delete from "OrderItemModifier" where "orderItemId" in (select id from "OrderItem" where "orderId" = '${kOrderId}')`);
    sql(`delete from "OrderItem" where "orderId" = '${kOrderId}'`);
    sql(`delete from "Kot" where "orderId" = '${kOrderId}'`);
    sql(`delete from "Order" where id = '${kOrderId}'`);
  }
  if (stationId) sql(`delete from "KitchenStation" where id = '${stationId}'`);
  if (station2Id) sql(`delete from "KitchenStation" where id = '${station2Id}'`);
  check('no journey kitchen ticket survives the run',
    kOrderId ? sql(`select count(*) from "KitchenItem" where "orderId" = '${kOrderId}'`) : '0', 0);
  check('no journey station survives the run',
    sql(`select count(*) from "KitchenStation" where name like 'Journey Pass %'`), 0);

  const realErrors = consoleErrors.filter((e) => !/401|403|400|409|404/.test(e));
  check('no unexpected console errors', realErrors.length, 0);
  realErrors.slice(0, 5).forEach((e) => console.log('   ' + e.slice(0, 160)));
  check('no HTTP 5xx during the journeys', bad5xx.length, 0);
  bad5xx.slice(0, 5).forEach((r) => console.log('   ' + r));

  await ctx.close();
  await browser.close();
  verdict('vcxo accept journeys');
};

main().catch((e) => {
  console.error(`\nharness error: ${e.message}`);
  process.exit(2);
});
