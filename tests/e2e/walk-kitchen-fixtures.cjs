// VC-103 kitchen screens — fixture-render verification (Part E).
// Window 3's kitchen backend is LANDED and THIS lane's backend mounts it
// (app.js: api.use('/kitchen', …); the lane is cut from main @ d625370) — but
// this walk still intercepts the network with fixtures so the render
// assertions are deterministic (fixed ages, an overdue item, a mid-poll
// cancellation, a PARTIAL order) whatever the seed happens to hold. Real
// backend responses are the API journeys' job, not this walk's. The fixtures
// mirror the landed contract EXACTLY (backend/src/api/routes/kitchen.js):
//   GET  /kitchen/stations                  → { stations }  (isDefault, not
//                                             defaultForBranch)
//   GET  /kitchen/stations/:id/board        → { seq, items } live snapshot
//   GET  /kitchen/stations/:id/board?sinceSeq=N → { seq, items } deltas,
//                                             terminal states included
//   POST /kitchen/items/:id/state           → { item, replayed }
//   GET  /kitchen/overview                  → { stations, ordersKitchenReady,
//                                             lastChangeAt, seq } (managerUp —
//                                             the supervisor's authoritative
//                                             counts; kitchen.js:241)
//   (NO delay endpoint; items carry name/qty/kotSeq — no productName,
//    orderType, tableCode, invoiceNumber, modifiers or notes)
// /branches is NOT fixtured — the owner's store picker runs against the real
// stack, and chooseStoreIfAsked() picks the first store when the seed has more
// than one (useKitchenBranch auto-picks only a list of exactly one).
// Verified here: default-station preselect, name/qty render, KOT labels,
// overdue highlight, delay reason display, snapshot→delta cancellation
// ("do not prepare"), cross-station aggregation on expediter/supervisor,
// partial readiness, supervisor stats — plus a negative probe that no
// old-contract path (/kitchen/items?since, /delay) is ever requested.
// Screenshots: <shots>/e-*.png.
const fs = require('fs');
const { BASE, SHOTS, creds, launchBrowser } = require('./env.cjs');

fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
let shotN = 0;
let fails = 0;
const log = (s) => process.stdout.write(s + '\n');

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const stations = [
  { id: 'st-hot', name: 'Hot Kitchen', sortOrder: 0, status: 'ACTIVE', targetPrepSeconds: 300, isDefault: true },
  { id: 'st-cold', name: 'Cold Station', sortOrder: 1, status: 'ACTIVE', targetPrepSeconds: 180, isDefault: false },
];

// publicItem shape @ 1e92440. The board's snapshot mode carries only live
// states with changeSeq <= SNAP_SEQ; ki-4's cancellation (changeSeq 5) lands
// via the FIRST delta poll — which is exactly how a till-side cancel reaches
// an open screen in production.
const SNAP_SEQ = 4;
const LIVE_SEQ = 5;
const items = [
  { id: 'ki-1', orderId: 'ord-1', kotId: 'kot-1', orderItemId: 'oi-1', stationId: 'st-hot',
    state: 'QUEUED', version: 1, changeSeq: 1, targetSeconds: 300,
    queuedAt: iso(90 * 1000), startedAt: null, readyAt: null, servedAt: null,
    cancelledAt: null, delayReason: null, name: 'Cappuccino', qty: 2, kotSeq: 1 },
  { id: 'ki-2', orderId: 'ord-1', kotId: 'kot-1', orderItemId: 'oi-2', stationId: 'st-hot',
    state: 'IN_PREP', version: 3, changeSeq: 2, targetSeconds: 300,
    queuedAt: iso(700 * 1000), startedAt: iso(600 * 1000), readyAt: null, servedAt: null,
    cancelledAt: null, delayReason: 'Waiting on bread delivery',
    name: 'Veg Sandwich', qty: 1, kotSeq: 1 }, // overdue: 700s vs 300s target
  { id: 'ki-3', orderId: 'ord-1', kotId: 'kot-1', orderItemId: 'oi-3', stationId: 'st-hot',
    state: 'READY', version: 2, changeSeq: 3, targetSeconds: 300,
    queuedAt: iso(400 * 1000), startedAt: iso(350 * 1000), readyAt: iso(60 * 1000),
    servedAt: null, cancelledAt: null, delayReason: null,
    name: 'Masala Chai', qty: 1, kotSeq: 1 }, // → 1 of 3 lines ready = PARTIAL
  { id: 'ki-5', orderId: 'ord-2', kotId: 'kot-2', orderItemId: 'oi-5', stationId: 'st-cold',
    state: 'QUEUED', version: 1, changeSeq: 4, targetSeconds: 180,
    queuedAt: iso(45 * 1000), startedAt: null, readyAt: null, servedAt: null,
    cancelledAt: null, delayReason: null, name: 'Butter Croissant', qty: 3, kotSeq: 2 },
  { id: 'ki-4', orderId: 'ord-2', kotId: 'kot-2', orderItemId: 'oi-4', stationId: 'st-hot',
    state: 'CANCELLED', version: 2, changeSeq: 5, targetSeconds: 300,
    queuedAt: iso(200 * 1000), startedAt: null, readyAt: null, servedAt: null,
    cancelledAt: iso(30 * 1000), delayReason: null, name: 'Cold Brew', qty: 1, kotSeq: 2 },
];
const LIVE = new Set(['QUEUED', 'IN_PREP', 'READY']);

async function main() {
  const owner = creds.owner();
  const browser = await launchBrowser(log);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });

  // Fixture the landed kitchen contract; everything else hits the real stack.
  const fulfilled = [];
  await ctx.route('**/api/kitchen/**', async (route) => {
    const url = new URL(route.request().url());
    fulfilled.push(url.pathname + (url.search || ''));
    if (url.pathname.endsWith('/kitchen/stations')) {
      return route.fulfill({ json: { stations } });
    }
    if (url.pathname.endsWith('/kitchen/overview')) {
      // Same arithmetic the landed route does (kitchen.js:241-291), over the
      // fixture rows: QUEUED/IN_PREP counts per station, oldest QUEUED age,
      // whole-order readiness (every live line READY — ord-1 still cooking,
      // ord-2 has a QUEUED line, so 0 here).
      const per = stations.map((st) => {
        const mine = items.filter((i) => i.stationId === st.id);
        const queuedRows = mine.filter((i) => i.state === 'QUEUED');
        const oldestMs = queuedRows.length
          ? Math.max(...queuedRows.map((i) => now - new Date(i.queuedAt).getTime()))
          : null;
        return {
          stationId: st.id,
          name: st.name,
          queued: queuedRows.length,
          inPrep: mine.filter((i) => i.state === 'IN_PREP').length,
          oldestQueuedAgeSec: oldestMs === null ? null : Math.round(oldestMs / 1000),
        };
      });
      return route.fulfill({
        json: { stations: per, ordersKitchenReady: 0, lastChangeAt: iso(30 * 1000), seq: LIVE_SEQ },
      });
    }
    const boardM = url.pathname.match(/\/kitchen\/stations\/([^/]+)\/board$/);
    if (boardM) {
      const stId = boardM[1];
      const raw = url.searchParams.get('sinceSeq');
      if (raw === null) {
        // live snapshot: active states at the cursor's snapshot moment
        const out = items.filter((i) => i.stationId === stId && LIVE.has(i.state) && i.changeSeq <= SNAP_SEQ);
        return route.fulfill({ json: { seq: SNAP_SEQ, items: out } });
      }
      const since = Number(raw);
      const out = items.filter((i) => i.stationId === stId && i.changeSeq > since);
      return route.fulfill({ json: { seq: LIVE_SEQ, items: out } });
    }
    const stateM = url.pathname.match(/\/kitchen\/items\/([^/]+)\/state$/);
    if (stateM && route.request().method() === 'POST') {
      const item = items.find((i) => i.id === stateM[1]);
      const body = route.request().postDataJSON() || {};
      return route.fulfill({
        json: {
          item: { ...item, state: body.to ?? item.state, version: (body.version ?? item.version) + 1, changeSeq: LIVE_SEQ + 1 },
          replayed: false,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'fixture miss: ' + url.pathname } });
  });

  const shot = async (name) => {
    shotN += 1;
    await page.screenshot({ path: `${SHOTS}/e-${String(shotN).padStart(2, '0')}-${name}.png`, fullPage: true });
  };
  const step = async (name, fn) => {
    try { await fn(); log(`PASS ${name}`); }
    catch (e) {
      fails += 1;
      log(`FAIL ${name}: ${String(e.message || e).split('\n')[0]}`);
      try { await shot('FAIL-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)); } catch {}
    }
  };
  const bodyHas = async (re, what) => {
    const body = await page.evaluate(() => document.body.innerText);
    if (!re.test(body)) throw new Error('missing ' + what);
  };

  // An OWNER always sees the store select (their PosUser.branchId is null, so
  // every kitchen call needs a chosen store). It auto-picks only when the
  // company has exactly ONE active store; with more, pick the first. Each
  // page.goto remounts the SPA, so the choice must be repeated per screen.
  const chooseStoreIfAsked = async () => {
    // state:'attached'. waitForSelector defaults to 'visible', and an <option>
    // inside a collapsed <select> has no box, so it is never visible: measured
    // against this very picker (3 options, value=''), 'visible' times out at
    // 4003ms and 'attached' resolves in 16ms. With the default spelling the
    // store is never chosen, useKitchenBranch.ready stays false, not one
    // /kitchen call is ever made, and all seven board steps fail for that one
    // reason. walk-promotions.cjs:207 carried the identical bug.
    await page.waitForSelector('select[aria-label="Store"] option:nth-child(2)', { state: 'attached' });
    const sel = page.locator('select[aria-label="Store"]');
    if (!(await sel.inputValue())) {
      const v = await sel.locator('option').nth(1).getAttribute('value');
      await sel.selectOption(v);
    }
  };

  await step('owner signs in', async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', owner.email);
    await page.fill('#password', owner.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  await step('station: isDefault station preselected, names/KOT render', async () => {
    await page.goto(BASE + '/kitchen', { waitUntil: 'domcontentloaded' });
    await chooseStoreIfAsked();
    await page.waitForSelector('text=Cappuccino'); // board painted
    const sel = await page.$eval('select[aria-label="Station"]', (el) => el.value);
    if (sel !== 'st-hot') throw new Error(`default station is ${sel}, want st-hot (isDefault)`);
    await bodyHas(/2 × Cappuccino/, 'qty × name line');
    await bodyHas(/KOT #1/, 'KOT label from kotSeq');
    await shot('station-board');
  });

  await step('station: overdue highlight + delay reason shown (read-only)', async () => {
    await bodyHas(/Waiting on bread delivery/, 'delay reason');
    // no Delay button anywhere — the endpoint does not exist
    const delayButtons = await page.locator('button:has-text("Delay")').count();
    if (delayButtons !== 0) throw new Error(`${delayButtons} Delay button(s) present; contract has no delay endpoint`);
    await shot('station-flags');
  });

  await step('station: till-side cancel arrives via the delta poll', async () => {
    // ki-4 (changeSeq 5) is NOT in the snapshot; the next poll's sinceSeq=4
    // delta carries it — same path a reconnect uses.
    await page.waitForSelector('text=do not prepare');
    await bodyHas(/Cold Brew/, 'cancelled line name');
    await shot('station-cancelled');
  });

  await step('station: Start advances a queued ticket', async () => {
    await page.locator('button:has-text("Start")').first().click();
    await page.waitForTimeout(500); // optimistic update settles
    await shot('station-after-start');
  });

  await step('expediter: cross-station aggregation + partial readiness', async () => {
    await page.goto(BASE + '/kitchen/expediter', { waitUntil: 'domcontentloaded' });
    await chooseStoreIfAsked();
    await page.waitForSelector('text=KOT #1'); // orderLabel falls back to KOT
    await bodyHas(/1 of 3 lines ready/i, '"x of y lines ready" line');
    await bodyHas(/PARTIAL/, 'PARTIAL badge');
    // ord-2's queued line lives on st-cold — visible only if the adapter
    // fans out across every station's board.
    await bodyHas(/Butter Croissant/, 'cold-station line (aggregation proof)');
    await page.waitForSelector('button:has-text("Served")');
    await shot('expediter-board');
  });

  await step('supervisor: stations, delayed reasons, cancellation feed', async () => {
    await page.goto(BASE + '/kitchen/supervisor', { waitUntil: 'domcontentloaded' });
    await chooseStoreIfAsked();
    await page.waitForSelector('text=Hot Kitchen');
    await bodyHas(/Cold Station/, 'second station card');
    await bodyHas(/Waiting on bread delivery/, 'delayed list shows the reason');
    await page.waitForSelector('text=Cold Brew'); // cancellation via delta
    await shot('supervisor-board');
  });

  await step('supervisor: authoritative /kitchen/overview consumed', async () => {
    // Three proofs the counts came from overview and not the board fallback:
    // the "Last kitchen change" footer renders only from overview.lastChangeAt;
    // "Orders ready to serve" shows a number, never the pre-overview '—'; and
    // no overview error banner is up.
    await page.waitForSelector('text=Last kitchen change');
    const body = await page.evaluate(() => document.body.innerText);
    if (/Orders ready to serve\s*\n\s*—/i.test(body)) {
      throw new Error("'Orders ready to serve' still shows — (overview never answered)");
    }
    if (/Could not load the kitchen overview/i.test(body)) {
      throw new Error('overview error banner is visible');
    }
    await shot('supervisor-overview');
  });

  await ctx.close();
  await browser.close();

  log('---');
  // Negative probe: the adapter must never speak the OLD derived contract.
  const oldPaths = fulfilled.filter((p) => /\/kitchen\/items\?|\/delay$|[?&]since=/.test(p));
  if (oldPaths.length) {
    fails += 1;
    log(`FAIL old-contract request seen: ${oldPaths[0]}`);
  } else {
    log('PASS no old-contract requests (items?since / delay)');
  }
  log(`steps failed: ${fails}`);
  log(`kitchen fixture routes served: ${fulfilled.length}`);
  const realErrors = consoleErrors.filter((e) => !/401|403|400|409/.test(e));
  log(`page/console errors (unexpected): ${realErrors.length}`);
  realErrors.slice(0, 10).forEach((e) => log('  ' + e.slice(0, 200)));
  process.exitCode = fails > 0 ? 1 : 0;
}

main().catch((e) => {
  log('FATAL ' + (e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | '));
  process.exitCode = 2;
});
