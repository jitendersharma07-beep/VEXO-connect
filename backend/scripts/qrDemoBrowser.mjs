// Drives the guest QR flow in a real browser at a real phone viewport.
//
// The point of this script is that nothing in it talks to the database or to
// Express. It clicks what a guest would click, in Chromium, against the dev
// server — so it fails if the page does not render, if the proxy is wrong, if a
// button is off screen, or if the SPA never routed /t/<token> at all. The test
// suite cannot catch any of those: it calls the API directly.
//
//   node scripts/qrDemoStage.mjs      # writes /tmp/qr-demo/cards.json
//   node scripts/qrDemoBrowser.mjs
//
// Writes screenshots to /tmp/qr-demo/ and prints PASS or FAIL per step.

import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Read-only borrow of a browser driver that is already installed on this box.
// Nothing is written there and nothing in this lane depends on it at runtime —
// it is test tooling for one script.
const { chromium } = require('/opt/atc/frontend/node_modules/playwright-core');

const SHOTS = '/tmp/qr-demo';
mkdirSync(SHOTS, { recursive: true });

// Which cards to drive comes from the staging run, not from the command line: a
// printed token is 32 opaque characters and retyping one is how you end up
// debugging the wrong table.
const staged = JSON.parse(readFileSync(`${SHOTS}/cards.json`, 'utf8'));
const cardFor = (store, table) => {
  const hit = staged.cards.find((c) => c.store.includes(store) && c.table === table);
  if (!hit) throw new Error(`staging has no ${table} at ${store}`);
  return hit.url;
};
const url = cardFor('Connaught Place', 'T1');
const secondUrl = cardFor('Koramangala', 'T1');

const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name} — ${err.message}`);
  }
};

const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({
  executablePath: '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome',
});

// A real phone, not a narrow desktop window: the touch flags change how the
// page behaves and the device pixel ratio is what makes an overflowing card
// obvious in a screenshot.
const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

const context = await browser.newContext(phone);
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Every request the browser made that did not succeed, by URL. Checked instead
// of the console text because "a 401 appeared" is not a finding — WHICH request
// got it is the whole question.
const failedRequests = [];
page.on('response', (r) => {
  if (!r.ok() && r.status() !== 304) failedRequests.push(`${r.status()} ${r.url()}`);
});

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

// --- 1. scanning ------------------------------------------------------------

let storeLine = '';
await step('scanning the card opens this store, floor and table', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('header');
  storeLine = (await page.locator('header').innerText()).replace(/\n/g, ' | ');
  must(/Saffron Grill/.test(storeLine), `header did not name the store: ${storeLine}`);
  must(/T\d|P\d/.test(storeLine), `header did not name the table: ${storeLine}`);
  must(/Ground Floor/.test(storeLine), `header did not name the floor: ${storeLine}`);
  await shot('01-scan');
  return storeLine;
});

await step('the menu is the store’s real menu with prices', async () => {
  const body = await page.locator('main').innerText();
  for (const want of ['Starters', 'Biryani', 'Hyderabadi Dum Biryani', 'Drinks']) {
    must(body.includes(want), `menu is missing ${want}`);
  }
  must(/₹\s?520|from ₹\s?340/.test(body), 'no variant pricing on screen');
  return 'categories, products and prices all present';
});

// --- 2. nothing is ordered by looking ---------------------------------------

await step('a scan alone does not start an order', async () => {
  const body = await page.locator('main').innerText();
  must(!/Your table/i.test(body), 'an order panel appeared before anything was sent');
  must(
    /Start my table order/.test(body),
    'the page did not offer to start an order',
  );
  return 'no order, no bill, only an invitation to start';
});

// --- 3. starting the visit --------------------------------------------------

let joinCode = '';
await step('starting the table order issues a session and a join code', async () => {
  await page.getByRole('button', { name: /Start my table order/i }).click();
  await page.waitForSelector('text=/Table code/', { timeout: 15000 });
  const badge = await page.locator('text=/Table code \\d{4}/').first().innerText();
  joinCode = badge.replace(/\D/g, '');
  must(/^\d{4}$/.test(joinCode), `join code did not look like four digits: ${badge}`);
  await shot('02-session');
  return `join code ${joinCode}`;
});

// --- 4. choosing and sending ------------------------------------------------

await step('choosing a variant and a modifier builds a basket', async () => {
  await page.getByRole('button', { name: /Hyderabadi Dum Biryani/ }).first().click();
  await page.waitForSelector('text=Size');
  await page.getByRole('button', { name: /^Full/ }).click();
  await page.getByRole('button', { name: /Extra raita/ }).click();
  await shot('03-product-sheet');
  await page.getByRole('button', { name: /Add to the table order/ }).click();
  await page.waitForSelector('text=/Send to the till/');
  const bar = await page.locator('text=/Send to the till/').first().innerText();
  must(/₹/.test(bar), `send bar carried no total: ${bar}`);
  return bar.replace(/\n/g, ' ');
});

await step('sending puts the lines on the table’s order, unconfirmed', async () => {
  await page.getByRole('button', { name: /Send to the till/ }).click();
  await page.waitForSelector('text=/waiting for a member of staff to confirm/i', {
    timeout: 15000,
  });
  const body = await page.locator('main').innerText();
  must(/Your table/i.test(body), 'no order panel after sending');
  must(/Waiting for staff/.test(body), 'a line claimed the kitchen had it already');
  must(!/With the kitchen/.test(body), 'a line claimed the kitchen had it before acceptance');
  await shot('04-sent-awaiting-staff');
  return 'order visible, every line still waiting for staff';
});

// --- 5. a second phone at the same table ------------------------------------

const second = await browser.newContext(phone);
const secondPage = await second.newPage();
await step('a second phone must know the code, and then shares one bill', async () => {
  await secondPage.goto(url, { waitUntil: 'networkidle' });
  await secondPage.waitForSelector('text=/four-digit code/i');
  const body = await secondPage.locator('main').innerText();
  must(!/Hyderabadi Dum Biryani.*₹/s.test(body) || !/Your table/i.test(body),
    'the other party’s order was visible before joining');
  await secondPage.screenshot({ path: `${SHOTS}/05-join-gate.png`, fullPage: true });

  await secondPage.getByLabel(/Four-digit table code/i).fill('0000' === joinCode ? '1111' : '0000');
  await secondPage.getByRole('button', { name: /Join this table/i }).click();
  await secondPage.waitForSelector('text=/code|Try/i', { timeout: 15000 });
  const refused = await secondPage.locator('main').innerText();
  must(!/Table code \d{4}/.test(refused), 'a wrong code let the phone in');

  await secondPage.getByLabel(/Four-digit table code/i).fill(joinCode);
  await secondPage.getByRole('button', { name: /Join this table/i }).click();
  await secondPage.waitForSelector('text=/Your table/i', { timeout: 15000 });
  const joined = await secondPage.locator('main').innerText();
  must(/Hyderabadi Dum Biryani/.test(joined), 'the shared order was not visible after joining');
  must(/added by Guest 1/.test(joined), 'the shared line was not attributed to the other guest');
  must(!/added by you/.test(joined.split('Add something')[0]), 'a joined phone claimed a line it did not add');
  await secondPage.screenshot({ path: `${SHOTS}/06-joined-shared-bill.png`, fullPage: true });
  return 'wrong code refused, right code joined, one shared bill';
});

// --- 6. the POS side of the same event --------------------------------------

// The staff half is driven over HTTP rather than through a second browser: what
// is being demonstrated is that the guest's order landed on the right table in
// the POS, and the floor-plan endpoint is where a manager's screen reads that
// from. Going through the API keeps the claim about the server's answer, not
// about a staff component's rendering.
const API = 'http://127.0.0.1:5531/api';
const staffJson = async (path, init) => {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
};

let cashier;
await step('the order is on the right table on the floor plan', async () => {
  const auth = await staffJson('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cashier@saffron.demo', password: staged.password }),
  });
  cashier = { Authorization: `Bearer ${auth.token}` };

  const floors = await staffJson('/floors', { headers: cashier });
  const floor = floors.floors.find((f) => f.name === 'Ground Floor');
  must(floor, 'the demo floor was not visible to the cashier');
  const { layout } = await staffJson(`/floors/${floor.id}/layout`, { headers: cashier });

  const byName = new Map(layout.tables.map((t) => [t.name, t.service]));
  const t1 = byName.get('T1');
  must(t1, 'T1 was not on the published layout');
  must(t1.state === 'ORDERING', `T1 read ${t1.state}, not ORDERING`);
  must(t1.awaitingStaff >= 1, `T1 showed ${t1.awaitingStaff} baskets awaiting staff`);
  must(t1.guests === 2, `T1 showed ${t1.guests} guests, not the two phones that joined`);
  // The tables nobody scanned must be untouched. A state machine that marks the
  // whole floor busy would pass every test above.
  for (const name of ['T2', 'T3', 'P1']) {
    must(byName.get(name)?.state === 'FREE', `${name} read ${byName.get(name)?.state}, not FREE`);
  }
  return `T1 ORDERING, ${t1.awaitingStaff} awaiting staff, ${t1.guests} guests; T2/T3/P1 FREE`;
});

await step('accepting at the till is what tells the kitchen, and the phone sees it', async () => {
  const pending = await staffJson('/table-qr/submissions?status=SUBMITTED', { headers: cashier });
  const list = pending.submissions;
  must(list.length >= 1, `no submission was waiting: ${JSON.stringify(pending).slice(0, 200)}`);
  const accepted = await staffJson(`/table-qr/submissions/${list[0].id}/accept`, {
    method: 'POST',
    headers: { ...cashier, 'Content-Type': 'application/json' },
    body: '{}',
  });
  must(accepted.kotId, 'acceptance cut no KOT');

  // The guest page polls, so this is the phone learning the truth from the
  // server rather than from having pressed a button.
  await page.waitForSelector('text=/With the kitchen/', { timeout: 20000 });
  const body = await page.locator('main').innerText();
  must(!/waiting for a member of staff to confirm/i.test(body), 'the phone still said undecided');
  await shot('09-accepted-with-kitchen');
  return `KOT ${accepted.kotId} cut; the phone now reads "With the kitchen"`;
});

// --- 7. the other store's card, same table label ---------------------------

if (secondUrl) {
  const other = await browser.newContext(phone);
  const otherPage = await other.newPage();
  await step('the same table label at another store is a different table', async () => {
    await otherPage.goto(secondUrl, { waitUntil: 'networkidle' });
    await otherPage.waitForSelector('header');
    const header = (await otherPage.locator('header').innerText()).replace(/\n/g, ' | ');
    must(header !== storeLine, `the other store rendered the same header: ${header}`);
    must(/Koramangala|Bengaluru/.test(header), `did not resolve to the other store: ${header}`);
    const body = await otherPage.locator('main').innerText();
    must(!/Your table/i.test(body), 'the other store’s table showed an order');
    must(/Start my table order/.test(body), 'the other store’s table was not free');
    await otherPage.screenshot({ path: `${SHOTS}/07-other-store.png`, fullPage: true });
    return header;
  });
  await other.close();
}

// --- 7. a dead card ---------------------------------------------------------

await step('an unknown token is refused, with no store named', async () => {
  const dead = await browser.newContext(phone);
  const deadPage = await dead.newPage();
  const base = new URL(url);
  await deadPage.goto(`${base.origin}/t/thistokenwasnevermintedatall000`, {
    waitUntil: 'networkidle',
  });
  await deadPage.waitForSelector('text=/not in use/i', { timeout: 15000 });
  const body = await deadPage.locator('body').innerText();
  must(!/Saffron Grill/.test(body), 'a refusal leaked a store name');
  await deadPage.screenshot({ path: `${SHOTS}/08-dead-card.png`, fullPage: true });
  await dead.close();
  return 'refused without naming a store or table';
});

// --- 8. nothing broke on the way -------------------------------------------

await step('no guest request failed, and nothing else 401d either', async () => {
  // The staff shell mounts AuthProvider above every route, so loading any page
  // in this SPA probes /api/auth/me and gets 401 when nobody is signed in. That
  // is the shell's bootstrap, it happens on /display too, and it has no visible
  // effect on this page — so it is named here and tolerated. Anything else that
  // failed is a finding, and in particular a failed /api/guest/qr call is.
  const bootstrap = (u) => /\/api\/auth\/me$/.test(u);
  const unexpected = failedRequests.filter((line) => !bootstrap(line.split(' ')[1]));
  must(unexpected.length === 0, `failed requests: ${unexpected.slice(0, 4).join(' / ')}`);
  must(
    failedRequests.some((line) => bootstrap(line.split(' ')[1])),
    'the shell auth probe did not happen — this filter is now lying about what it hides',
  );
  const guestCalls = failedRequests.filter((l) => l.includes('/api/guest/qr'));
  must(guestCalls.length === 0, `guest endpoint failures: ${guestCalls.join(' / ')}`);
  return `${failedRequests.length} failed request(s), all of them the shell auth probe`;
});

// --- 9. the phone fits the phone -------------------------------------------

await step('nothing overflows a 390px viewport', async () => {
  const overflow = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) {
        out.push(`${el.tagName}.${el.className}`.slice(0, 80));
      }
    }
    return out.slice(0, 5);
  });
  must(overflow.length === 0, `overflowing elements: ${overflow.join(' / ')}`);
  return 'no horizontal overflow';
});

await context.close();
await second.close();
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
console.log(`screenshots in ${SHOTS}`);
process.exit(failed.length === 0 ? 0 : 1);
