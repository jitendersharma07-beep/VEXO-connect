// Billing BROWSER dry run against the deployed POS.
//
// Drives the real screen in a real browser, then reads the effect out of the
// database — a screen that says "Paid" is not proof that anything was paid.
// Every assertion below is checked twice: once against what the UI rendered
// and once against what Postgres holds. Only the second one is evidence.
//
// No password, token or cookie is ever printed.
//
// The flow is the client demo end to end, in the order a shift actually runs:
// permissions → sell → DISCOUNT → KOT → bill → payment → receipt → REFUND →
// REPORT → day closing. The discount, refund and report steps are the phase-2
// work being accepted here; the rest is the billing path they have to survive.
//
// ---- which till, and why this one --------------------------------------
// Originally BSC-CH (Cyber Hub), reserved in UAT-TILL-RESERVATION.md. That
// reservation was overtaken by events on 2026-09-23: a second session ran its
// own harness (~/pos-bsc-ch-uat/run.mjs) through BSC-CH from 08:09 IST, and by
// 08:17 had order BSC-CH/26-27/00001 billed, paid ₹189 and part-refunded ₹10,
// with the permanent day closing still to come. Its phases are
// explore→sell→refund→report→close: there is no discount step anywhere in it.
//
// So the two runs are split by what each can file exactly once:
//   BSC-CH (theirs)  billing → payment → refund → report → DAY CLOSING
//   BSC-CP (this)    the DISCOUNT leg, which their run does not cover
// Racing them to the closing is the precise failure the reservation exists to
// prevent, and a second order of mine inside their closing would make its
// figures describe trade that was not theirs. BSC-CP is the right home for the
// discount leg: UAT-TILL-RESERVATION.md names it as explicitly NOT reserved,
// it already carries the acceptance traffic, and nothing files a closing on it
// — so this run can prove the discount in production without spending a date.
//
//   EXPLORE=1 node deploy/billing-browser-run.mjs     # read-only reconnaissance
//   node deploy/billing-browser-run.mjs               # the flow above (WRITES)
//   CLOSE_DAY=1 CLOSE_ONLY=1 node deploy/…            # file the day closing (PERMANENT)
//
// Invocation is by that exact form, from the repo root. If the environment
// refuses it, the refusal is reported as the result — `cd deploy && node
// ./billing-browser-run.mjs` is the SAME action wearing a different path and
// is not an answer to a denial.
import { readFileSync, mkdirSync } from 'node:fs';
// Same vendored playwright-core and pinned Chromium build that
// deploy/render-uat-screens.mjs uses — this lane has no node_modules of its own.
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

const BASE = (process.env.BASE_URL || 'https://atcworkspace.com/pos').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-billing-run';
const CREDS = '/home/atc-noc/pos-demo-creds-20260921.txt';
const OWNER = 'demo.owner@atcpos.example';
const EXPLORE = process.env.EXPLORE === '1';
// The closing is opt-in, not opt-out. It is the only step here that cannot
// be undone — one per (branch, business date), permanent — so it should take
// a deliberate act to fire, not a forgotten flag.
const CLOSE_DAY = process.env.CLOSE_DAY === '1';
// CLOSE_ONLY=1 skips straight to the closing, for the second half of a run
// that was deliberately split. Splitting matters because the selectors in
// the sell path are the part most likely to break, and a debugging loop that
// re-runs them would put a second order on a till whose whole point is that
// the closing covers exactly one.
const CLOSE_ONLY = process.env.CLOSE_ONLY === '1';
// The till this run writes to, and the one till a closing may ever be filed
// on. They are deliberately different constants: the reservation is what makes
// a closing honest, so the closing is bound to the RESERVED name rather than
// to whichever till happens to be selected.
const TILL = process.env.TILL || 'BSC-CP';
const RESERVED_TILL = 'BSC-CH';
// The branch <select> lists display names, not codes, so every screen that has
// to pick this till needs the name. Derived here once: three call sites used to
// carry the literal, which is how a retarget half-happens.
const TILL_NAME_RE = { 'BSC-CH': /Cyber Hub/, 'BSC-CP': /Connaught Place/ }[TILL];
if (!TILL_NAME_RE) throw new Error(`no display name known for till ${TILL}`);
// A closing on an unreserved till would cover other sessions' trade and its
// figures would not be a statement anyone could check. Refuse in the config,
// before a browser starts, rather than discovering it after the row is written.
if (CLOSE_DAY && TILL !== RESERVED_TILL) {
  throw new Error(
    `refusing to file a day closing on ${TILL}: only ${RESERVED_TILL} is reserved, `
    + 'and a closing over trade this run did not make is not evidence of anything.',
  );
}

mkdirSync(OUT, { recursive: true });

const pw = (email) => {
  for (const l of readFileSync(CREDS, 'utf8').split('\n')) {
    if (l.startsWith('#') || !l.trim()) continue;
    const [e, p] = l.split('\t');
    if (e?.trim().toLowerCase() === email) return p?.trim();
  }
  throw new Error(`no credentials entry for ${email}`);
};

const log = (k, v = '') => console.log(`${String(k).padEnd(46)} ${v}`);
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, detail ?? '');
};

// ---- the precondition, before a browser is even started ----------------
// A DayClose is permanent and there is one per (branch, business date). This
// run files a real one, and the only honest closing is one whose entire trade
// for that date belongs to the run — otherwise the figures on it describe
// somebody else's activity and nobody can check them.
//
// So: refuse to start rather than discover it afterwards. UAT-TILL-RESERVATION.md
// has described this rail as though it were already here; it was not, and a
// reservation doc asserting a guard that does not exist is worse than no doc.
// Reads the business date from the database rather than from the clock in this
// process, because `businessDate` is IST text and the roll at midnight is
// exactly when the two disagree.
const BIZ_DATE = (await q(
  "select to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') as d",
))[0].d;
if (!EXPLORE) {
  const [pre] = await q(`select
      (select count(*)::int from "Order" o join "Branch" b on b.id=o."branchId"
       where b.code='${TILL}'
         and (o."createdAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}') as orders,
      (select count(*)::int from "DayClose" d join "Branch" b on b.id=d."branchId"
       where b.code='${TILL}' and d."businessDate" = '${BIZ_DATE}') as closings`);

  // A closing already on the books is fatal on any till, closing or not: an
  // order opened after it is trade the closing does not mention, so the day's
  // figures silently stop adding up. This is the one rail that never relaxes.
  if (pre.closings !== 0) {
    throw new Error(
      `refusing to run: ${TILL} on ${BIZ_DATE} is already closed `
      + `(${pre.closings} closing(s)). An order after the closing is trade nobody counted.`,
    );
  }

  // The zero-orders rail only means something when this run is going to file
  // the closing — its job is to keep that closing's figures exclusively this
  // run's. On a till nobody closes, demanding zero prior orders asserts a
  // cleanliness that is not required and that BSC-CP, which carries the
  // acceptance traffic by design, could never satisfy.
  if (CLOSE_DAY) {
    // CLOSE_ONLY is the second half of a deliberately split run, so by then the
    // till is expected to hold exactly the one order the first half opened.
    const allowedOrders = CLOSE_ONLY ? 1 : 0;
    if (pre.orders !== allowedOrders) {
      throw new Error(
        `refusing to run: ${TILL} on ${BIZ_DATE} has ${pre.orders} order(s) `
        + `(expected ${allowedOrders}) and this run would close the day over them. `
        + 'Find out who wrote to the reserved till before going any further.',
      );
    }
  }
  log(
    'precondition',
    `${TILL} on ${BIZ_DATE}: ${pre.orders} order(s), ${pre.closings} closing(s)`
    + ` — ${CLOSE_DAY ? 'clear to close' : 'clear (no closing will be filed)'}`,
  );
}

// The day's report figures BEFORE this run writes anything. Checks 5.9/5.10
// assert what this order adds to the aggregate, so the "before" has to be read
// before the order exists — not reconstructed afterwards by subtracting what
// the run believes it did, which would be assuming the answer.
const baseline = (await q(`select
    coalesce((select sum(o.total) from "Order" o join "Branch" b on b.id=o."branchId"
              where b.code='${TILL}' and o.status in ('PAID','REFUNDED')
                and (o."billedAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}'),0)::float8 as net,
    coalesce((select sum(r.amount) from "Refund" r join "Order" o on o.id=r."orderId"
              join "Branch" b on b.id=o."branchId"
              where b.code='${TILL}' and r.status='SUCCEEDED'
                and (r."createdAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}'),0)::float8 as refunds`))[0];
if (!EXPLORE) log('baseline', `${TILL} ${BIZ_DATE}: net ₹${baseline.net}, refunds ₹${baseline.refunds}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

// Surface anything the page itself complains about. A billing screen that
// works while throwing is still a defect, and it will not show up in a
// screenshot.
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', OWNER);
  await page.fill('input[type="password"]', pw(OWNER));
  await page.click('button[type="submit"]');
  // `networkidle` is the wrong signal here and quietly cost a whole run. The
  // login is an XHR inside a single-page app, not a navigation: nothing ever
  // "loads", so waitForLoadState returned while the POST was still open, the
  // next goto() cancelled it — the server logged `request aborted`, status
  // null, at 483 ms — and the route guard bounced straight back to /login.
  // The harness then explored the login screen and called it the sell screen.
  //
  // Wait for the thing that actually changes: the button stops saying it is
  // working, and the router leaves /login. Both, because either alone has a
  // false reading — a REFUSED login also stops saying "Signing in…".
  await page.locator('button[type="submit"]:has-text("Signing in…")')
    .waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle');
  if (/\/login$/.test(new URL(page.url()).pathname)) {
    const why = await page.locator('[role="alert"], .text-red-600, .text-red-700').first()
      .innerText().catch(() => '');
    throw new Error(`login did not complete — still on /login${why ? `: ${why.trim()}` : ''}`);
  }
  log('signed in as owner', page.url().replace(BASE, ''));
  await page.screenshot({ path: `${OUT}/01-after-login.png`, fullPage: true });

  const dump = async (tag) => {
    const info = await page.evaluate(() => ({
      url: location.pathname,
      buttons: [...document.querySelectorAll('button')]
        .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
        .filter(Boolean).slice(0, 40),
      selects: [...document.querySelectorAll('select')].map((s) => ({
        name: s.name || s.id || '(unnamed)',
        options: [...s.options].map((o) => o.text.trim()),
      })),
      headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.innerText.trim()).slice(0, 12),
    }));
    log(`--- ${tag} @ ${info.url}`);
    log('  headings', info.headings.join(' | '));
    log('  selects', JSON.stringify(info.selects));
    log('  buttons', info.buttons.join(' · '));
  };

  // selectOption's `label` takes a STRING, not a RegExp — hand it a regex and
  // Playwright throws "expected string, got object" rather than matching
  // loosely. Every branch picker in this file was written the wrong way and
  // none of them had ever executed, so all three would have failed the run one
  // after another. Match the regex here, against the options as rendered, and
  // hand selectOption the exact text it wants. Throws with the list it did see,
  // because "no such option" is only diagnosable next to what was on offer.
  const chooseOption = async (selector, re) => {
    const labels = (await page.locator(`${selector} option`).allInnerTexts()).map((t) => t.trim());
    const want = labels.find((t) => re.test(t));
    if (!want) throw new Error(`${selector}: nothing matches ${re} in [${labels.join(' | ')}]`);
    await page.selectOption(selector, { label: want });
    return want;
  };

  // ---- 0. the authority screen, before anything spends it -------------
  // The feature being accepted is "the customer's owner decides who may
  // discount". So read that decision off the screen the owner actually uses,
  // BEFORE the till exercises it — a ceiling demonstrated only by the one
  // account that has no ceiling proves nothing about the ones that do.
  //
  // Read-only, so EXPLORE runs it too. That is deliberate: it is the only
  // part of the flow whose selectors can be rehearsed without spending the
  // till's one clean business date on finding out they moved.
  const policyScreen = async () => {
    await page.goto(`${BASE}/discounts`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/02a-discount-authority.png`, fullPage: true });

    // "May give" is the third column of the staff table.
    const mayGive = async (email) => {
      const row = page.locator('tr', { hasText: email }).first();
      if (!(await row.count())) return '(no row)';
      return (await row.locator('td').nth(2).innerText()).trim();
    };
    const cashierSays = await mayGive('demo.cashier@atcpos.example');
    const managerSays = await mayGive('demo.manager@atcpos.example');
    const ownerSays = await mayGive(OWNER);
    check('0.1 a cashier may give nothing by default', /^No discounts$/i.test(cashierSays), cashierSays);
    check('0.2 a branch manager may give nothing by default', /^No discounts$/i.test(managerSays), managerSays);
    check('0.3 the customer owner is the one who is not capped', /no limit/i.test(ownerSays), ownerSays);

    // The three lines above would read the same if somebody had configured a
    // deny row for every cashier in the company. This is the one that says
    // the denial is the PRODUCT's default rather than this tenant's setting:
    // there is no policy row at all, anywhere, so what the screen printed
    // came out of ROLE_FLOOR in code.
    const policyRows = await q('select count(*)::int as n from "DiscountPolicy"');
    check('0.4 default DENY is code, not a row somebody added',
      policyRows[0].n === 0, `${policyRows[0].n} DiscountPolicy rows in the whole database`);
  };

  // Reads the two headline figures off the sales report the way a person
  // does — off the cards, not out of a JSON body nobody looks at.
  //
  // A StatCard is <div>{label}</div><div>{value}</div>, siblings, so go from
  // the label to the element beside it. Matching case-insensitively because
  // the label is upper-cased by CSS and innerText returns what the CSS did,
  // not what the JSX said. Filtering divs by `hasText` instead would land on
  // the innermost node — the label alone, carrying no figure at all.
  const openReport = async (branchRe, date) => {
    await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.fill('#rep-from', date);
    await page.fill('#rep-to', date);
    if (await page.locator('#rep-branch').isVisible().catch(() => false)) {
      await chooseOption('#rep-branch', branchRe);
    }
    await page.waitForTimeout(2000);
    const stat = async (label) => {
      const txt = await page.locator(`text=/^${label}$/i`).first()
        .locator('xpath=following-sibling::*[1]').innerText().catch(() => '');
      const m = txt.match(/₹\s?([\d,]+(?:\.\d+)?)/);
      return m ? Number(m[1].replace(/,/g, '')) : NaN;
    };
    return { net: await stat('Net sales'), refunds: await stat('Refunds') };
  };

  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/02-sell.png`, fullPage: true });

  if (EXPLORE) {
    await dump('sell');
    await policyScreen();
    await dump('discounts');

    // Rehearse the report reader against the till this run is NOT writing to,
    // so the cross-check stays independent of anything this harness did.
    // Nothing here writes. Two things come out of it that are worth having on
    // their own: the sales report is proved to work in production against real
    // rows, and the selector that reads it is proved before a run is spent
    // finding out it moved.
    const other = TILL === 'BSC-CP'
      ? { code: 'BSC-CH', re: /Cyber Hub/ }
      : { code: 'BSC-CP', re: /Connaught Place/ };
    const cp = await openReport(other.re, BIZ_DATE);
    await page.screenshot({ path: `${OUT}/02b-report-rehearsal.png`, fullPage: true });
    const [want] = await q(`select
        coalesce((select sum(o.total) from "Order" o join "Branch" b on b.id=o."branchId"
                  where b.code='${other.code}' and o.status in ('PAID','REFUNDED')
                    and (o."billedAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}'),0)::float8 as net,
        coalesce((select sum(r.amount) from "Refund" r join "Order" o on o.id=r."orderId"
                  join "Branch" b on b.id=o."branchId"
                  where b.code='${other.code}' and r.status='SUCCEEDED'
                    and (r."createdAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}'),0)::float8 as refunds`);
    check('R.1 the sales report\'s net sales matches the database',
      Math.abs(cp.net - want.net) < 0.01, `report ₹${cp.net} vs db ₹${want.net} (${other.code}, ${BIZ_DATE})`);
    check('R.2 the sales report\'s refunds match the database',
      Math.abs(cp.refunds - want.refunds) < 0.01, `report ₹${cp.refunds} vs db ₹${want.refunds}`);

    const pass = results.filter((r) => r.ok).length;
    log('');
    log('EXPLORE mode — no writes performed', `${pass} PASS / ${results.length - pass} FAIL`);
    await browser.close();
    process.exit(pass === results.length ? 0 : 1);
  }

  // `amountPaid` / `amountDue` are NOT columns — the API derives them. So
  // derive them here too, from the payment and refund rows, rather than
  // asking the same code that is under test what it thinks it collected.
  // Set the moment this run's order exists, so every later read names it
  // explicitly instead of trusting that nothing else touched the till.
  let pinnedOrderId = null;
  const orderRow = async () => {
    const r = await q(`select o.id, o.status, o."invoiceNumber",
                              o.subtotal::float8 as subtotal, o."taxAmount"::float8 as tax,
                              o.total::float8 as total,
                              coalesce((select sum(p.amount) from "Payment" p where p."orderId"=o.id),0)::float8 as paid,
                              coalesce((select sum(r2.amount) from "Refund" r2
                                        where r2."orderId"=o.id and r2.status='SUCCEEDED'),0)::float8 as refunded
                       from "Order" o join "Branch" b on b.id=o."branchId"
                       where ${pinnedOrderId ? `o.id='${pinnedOrderId}'` : `b.code='${TILL}'`}
                       order by o."createdAt" desc limit 1`);
    return r[0];
  };

  let dbOrder;
  let due;
  let refunded;
  let disc;
  let expectDisc;
  if (CLOSE_ONLY) {
    dbOrder = await orderRow();
    due = Math.round(dbOrder.paid * 100) / 100;
    refunded = Math.round(dbOrder.refunded * 100) / 100;
    log('CLOSE_ONLY — reusing the order already on the till',
      `${dbOrder.invoiceNumber} ₹${dbOrder.total}, took ₹${due}, returned ₹${refunded}`);
  } else {
  await policyScreen();

  // ---- 1. open a takeaway order on the reserved till -----------------
  // The order panel is rendered twice below lg (pinned panel + sticky action
  // bar). At 1366 px only the panel is visible, but every locator below is
  // still scoped or :visible-filtered rather than relying on that, because a
  // silently-ambiguous selector is how a harness starts clicking the wrong
  // control after an unrelated layout change.
  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await chooseOption('#sell-branch', TILL_NAME_RE);
  const branchLabel = await page.locator('#sell-branch option:checked').innerText();
  check('1.1 target till selected in the UI', branchLabel.includes(TILL), branchLabel);

  await page.getByRole('button', { name: 'Takeaway' }).click();

  // Two lines, so the receipt has something to get wrong: one plain product
  // and one whose quantity is raised through the +/- controls.
  const pick = async (name) => {
    await page.locator('button', { hasText: new RegExp(`^${name}\\b`) }).first().click();
    // A product with variants opens a chooser instead of adding a line.
    const variant = page.getByRole('dialog').locator('button').first();
    if (await page.getByRole('dialog').isVisible().catch(() => false)) await variant.click();
    await page.waitForTimeout(400);
  };
  await pick('Masala Chai');
  await pick('Grilled Veg Sandwich');
  await page.getByRole('button', { name: 'Increase quantity' }).first().click();
  await page.waitForTimeout(600);

  dbOrder = await orderRow();
  check('1.2 order reached the database', !!dbOrder, dbOrder ? `status ${dbOrder.status}` : 'no row');
  // From here on, read THIS order by id rather than "the newest on the till".
  // On a reserved till those are the same thing; on BSC-CP, which carries the
  // acceptance traffic, a concurrent session's order would quietly become the
  // subject of every assertion below — and they would all still pass.
  pinnedOrderId = dbOrder.id;
  log('  pinned order', `${dbOrder.id} (${dbOrder.invoiceNumber || 'not yet billed'})`);

  const uiTotal = (await page.locator('text=Total').locator('xpath=following-sibling::*[1]').first()
    .innerText().catch(() => '')) || '';
  log('  screen total', uiTotal.trim());
  log('  db subtotal/tax/total', `₹${dbOrder.subtotal} / ₹${dbOrder.tax} / ₹${dbOrder.total}`);
  await page.screenshot({ path: `${OUT}/03-order-open.png`, fullPage: true });

  // ---- 1b. the discount ------------------------------------------------
  // 10% off, taken by the owner — inside the only authority that is not
  // capped, so it needs no approval and the bill that follows carries a real
  // discount through billing, payment, the receipt, the report and the
  // closing. That end-to-end carry is the point; the ceiling itself is
  // proved by the suite and by step 0, not by spending money here.
  await page.click('[aria-label="Edit order discount"]');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '% Percent' }).click();
  await page.waitForTimeout(200);
  await page.fill('#disc-value', '10');
  await page.screenshot({ path: `${OUT}/03a-discount-modal.png`, fullPage: true });
  await page.click('button[type="submit"]:has-text("Apply discount")');
  // Wait for the POST to settle rather than for a guessed number of
  // milliseconds: the button carries "Applying…" for exactly as long as the
  // request is in flight, so the label going away IS the request landing.
  await page.locator('button[type="submit"]:has-text("Applying…")')
    .waitFor({ state: 'detached', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(800);
  // The modal has no Cancel — it closes on its backdrop.
  for (let i = 0; i < 4 && (await page.locator('div.fixed.inset-0.z-50').count()); i += 1) {
    await page.mouse.click(5, 5);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(400);

  disc = await q(`select o."discountType", o."discountValue"::float8 as value,
                         o."discountAmount"::float8 as amount,
                         o."discountApprovedById" as approver,
                         o.subtotal::float8 as subtotal, o.total::float8 as total
                  from "Order" o where o.id='${dbOrder.id}'`);
  check('1.3 the discount is on the order in the database',
    disc[0].discountType === 'PERCENT' && Number(disc[0].value) === 10,
    disc[0].discountType ? `${disc[0].discountType} ${disc[0].value}` : 'no discount');
  // 10% of the subtotal, to the paisa — asserted as arithmetic rather than as
  // "some money came off", because an off-by-a-rounding-step discount is
  // exactly the defect a demo sails past. `subtotal` is the pre-order-discount
  // figure (gross less any line discounts) and an order discount does not
  // move it, so reading it back here is the same number the discount was
  // computed from.
  expectDisc = Math.round(disc[0].subtotal * 10) / 100;
  check('1.4 the amount taken off is 10% of the subtotal',
    Math.abs(disc[0].amount - expectDisc) < 0.01,
    `₹${disc[0].amount} off ₹${disc[0].subtotal} (expected ₹${expectDisc})`);
  check('1.5 an owner-level discount needs nobody to approve it',
    disc[0].approver === null, disc[0].approver ? 'approver stamped' : 'no approver, as expected');

  // The audit row is the phase-2 addition: it has to say who did it, in what
  // role, and what limit they were under AT THE TIME — a trail that records
  // only the ceilings that were breached cannot answer "was this allowed?"
  // once the policy has been edited.
  const da = await q(`select a."actorRole", a.meta->>'actorLimit' as limit_json,
                             a.meta->'after'->>'combinedDiscountPaise' as after_paise
                      from "PosAuditLog" a
                      where a.action='ORDER_DISCOUNT_SET' and a."entityId"='${dbOrder.id}'
                      order by a.at desc limit 1`);
  check('1.6 the discount is audited with the actor\'s role',
    da.length === 1 && da[0].actorRole === 'CUSTOMER_OWNER',
    da.length ? `actorRole ${da[0].actorRole}` : 'no audit row');
  check('1.7 the audit records the limit that was in force',
    da.length === 1 && da[0].limit_json !== null, da[0]?.limit_json ?? 'no actorLimit');
  check('1.8 the audit\'s figure is the discount actually taken',
    da.length === 1 && Math.round(Number(da[0].after_paise)) === Math.round(expectDisc * 100),
    `${da[0]?.after_paise} paise audited vs ₹${expectDisc} taken`);
  log('  discounted total', `₹${disc[0].total} (subtotal ₹${disc[0].subtotal} less ₹${disc[0].amount}, plus tax)`);
  await page.screenshot({ path: `${OUT}/03b-discount-applied.png`, fullPage: true });

  // ---- 2. KOT ---------------------------------------------------------
  await page.getByRole('button', { name: /Send KOT/ }).first().click();
  await page.waitForTimeout(1500);
  const kot = await q(`select k.seq, k."createdAt" from "Kot" k where k."orderId"='${dbOrder.id}' order by k.seq`);
  check('2.1 KOT recorded against the order', kot.length === 1, kot.length ? `KOT #${kot[0].seq}` : 'none');
  const kotItems = await q(`select count(*)::int as n from "OrderItem" where "orderId"='${dbOrder.id}' and "kotId" is not null`);
  check('2.2 both lines carry the KOT sequence', kotItems[0].n === 2, `${kotItems[0].n} of 2 lines`);
  await page.screenshot({ path: `${OUT}/04-kot-sent.png`, fullPage: true });

  // ---- 3. bill --------------------------------------------------------
  await page.getByRole('button', { name: /^Bill/ }).first().click();
  await page.waitForTimeout(2000);
  dbOrder = await orderRow();
  check('3.1 order is BILLED in the database', dbOrder.status === 'BILLED', dbOrder.status);
  check('3.2 invoice number allocated', !!dbOrder.invoiceNumber, dbOrder.invoiceNumber || 'none');
  const onScreenInvoice = await page.locator(`text=${dbOrder.invoiceNumber}`).first().isVisible().catch(() => false);
  check('3.3 the invoice on screen is the one in the database', onScreenInvoice, dbOrder.invoiceNumber);
  // The discount has to survive billing, not merely have happened. Billing
  // freezes the invoice, and a discount that is dropped or re-applied at that
  // moment is a bill that does not match the quote the customer agreed to.
  check('3.4 the billed total still carries the discount',
    Math.abs(dbOrder.total - (disc[0].subtotal - expectDisc + dbOrder.tax)) < 0.01,
    `₹${dbOrder.total} = ₹${disc[0].subtotal} − ₹${expectDisc} + tax ₹${dbOrder.tax}`);
  await page.screenshot({ path: `${OUT}/05-billed.png`, fullPage: true });

  // ---- 4. cash payment ------------------------------------------------
  // Tender more than the total on purpose: change due is computed by the
  // server, so an over-tender is the only version of this step that proves
  // the calculation rather than echoing the amount back.
  due = Math.round((dbOrder.total - dbOrder.paid) * 100) / 100;
  const tendered = Math.ceil(due / 100) * 100 + 100;
  const expectedChange = Math.round((tendered - due) * 100) / 100;
  await page.getByRole('button', { name: /Record payment/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'CASH', exact: true }).click();
  await page.fill('#pay-tendered', String(tendered));
  await page.getByRole('button', { name: /^Record payment$|^Recording…$/ }).last().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/06-payment-recorded.png`, fullPage: true });

  const pay = await q(`select p.method, p.channel, p.amount::float8 as amount, p.tendered::float8 as tendered
                       from "Payment" p where p."orderId"='${dbOrder.id}'`);
  check('4.1 exactly one payment row exists', pay.length === 1, `${pay.length} row(s)`);
  check('4.2 payment is a MANUAL cash payment', pay[0]
    && pay[0].method === 'CASH' && pay[0].channel === 'MANUAL',
    pay[0] ? `${pay[0].method}/${pay[0].channel}` : '—');
  check('4.3 amount taken is the amount due, not the amount tendered',
    pay[0].amount === due, `₹${pay[0].amount} vs due ₹${due} (tendered ₹${pay[0].tendered})`);

  // There is no changeDue column: the server computes it per response and the
  // drawer, not the database, is where the money goes. So the assertion is
  // that the figure the cashier is shown equals tendered minus the amount
  // actually recorded — an arithmetic claim made on screen, checked against
  // two stored numbers.
  const changeShown = await page.locator('text=Change due').locator('xpath=following-sibling::*[1]')
    .first().innerText().catch(() => '');
  const changeNum = Number(String(changeShown).replace(/[^0-9.]/g, ''));
  check('4.4 change shown on screen = tendered − amount recorded',
    changeNum === expectedChange && expectedChange === Math.round((pay[0].tendered - pay[0].amount) * 100) / 100,
    `screen ₹${changeNum}, db ₹${pay[0].tendered} − ₹${pay[0].amount} = ₹${expectedChange}`);

  dbOrder = await orderRow();
  check('4.5 order is PAID and nothing is outstanding',
    dbOrder.status === 'PAID' && Math.round((dbOrder.total - dbOrder.paid) * 100) / 100 === 0,
    `${dbOrder.status}, total ₹${dbOrder.total}, paid ₹${dbOrder.paid}`);

  const paidBadge = await page.locator('text=Payment recorded').first().isVisible().catch(() => false);
  check('4.6 the screen agrees with the database', paidBadge, 'both say paid');

  // ---- 5. receipt, in print media -------------------------------------
  await page.getByRole('button', { name: /Order paid in full/ }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/07-receipt-screen.png`, fullPage: true });

  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(300);
  const printBox = await page.locator('.print-area').first().boundingBox();
  // 72 mm of printable width at 96 CSS dpi = 272 px. This is the same rail
  // render-uat-screens.mjs enforces on fixtures; here it is measured on the
  // real receipt for a real order, which is the version that matters.
  const widthOk = printBox && printBox.width > 0 && printBox.width <= 273;
  check('5.1 real receipt fits the 72 mm printable width',
    widthOk, printBox ? `${printBox.width.toFixed(1)} px (limit 272)` : 'no print area');
  const clipped = await page.locator('.print-area').first().evaluate(
    (el) => el.scrollWidth - el.clientWidth,
  );
  check('5.2 no horizontal clipping in the receipt', clipped <= 1, `overflow ${clipped} px`);
  // The customer's copy is where a discount has to be visible, or the shop
  // has taken money off without telling anybody on paper.
  const receiptText = await page.locator('.print-area').first().innerText();
  check('5.3 the receipt shows the discount it gave',
    /Discount/i.test(receiptText) && receiptText.includes(expectDisc.toFixed(2)),
    `looking for -₹${expectDisc.toFixed(2)} on the printed copy`);
  await page.locator('.print-area').first().screenshot({ path: `${OUT}/08-receipt-print.png` });
  await page.pdf({ path: `${OUT}/09-receipt.pdf`, width: '80mm', height: '200mm', printBackground: true });
  await page.emulateMedia({ media: null });
  log('  receipt PDF written', `${OUT}/09-receipt.pdf`);

  // ---- 5b. the refund --------------------------------------------------
  // PART of the bill, not all of it. A full refund leaves a drawer that
  // should hold nothing, which is the one case where a broken closing still
  // balances; a partial refund forces cash taken and cash returned to be two
  // separate figures that have to reconcile against each other.
  refunded = Math.min(40, Math.round((due / 2) * 100) / 100);
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('tr', { hasText: dbOrder.invoiceNumber }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/09a-order-drawer.png`, fullPage: true });
  await page.getByRole('button', { name: /Refund…/ }).first().click();
  await page.waitForTimeout(700);
  await page.fill('#refund-amount', String(refunded));
  await page.fill('#refund-reason', 'UAT: customer returned the sandwich');
  await page.screenshot({ path: `${OUT}/09b-refund-modal.png`, fullPage: true });
  await page.getByRole('button', { name: /^Record refund$|^Recording…$/ }).last().click();
  await page.locator('button[type="submit"]:has-text("Recording…")')
    .waitFor({ state: 'detached', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/09c-refund-recorded.png`, fullPage: true });

  const ref = await q(`select r.amount::float8 as amount, r.status, r.channel, r.reason,
                              r."providerRef"
                       from "Refund" r where r."orderId"='${dbOrder.id}'`);
  check('5.4 exactly one refund row exists', ref.length === 1, `${ref.length} row(s)`);
  check('5.5 the refund settled across the counter, not at a provider',
    ref[0] && ref[0].status === 'SUCCEEDED' && ref[0].channel === 'MANUAL' && ref[0].providerRef === null,
    ref[0] ? `${ref[0].status}/${ref[0].channel}` : '—');
  check('5.6 the refund is for the amount asked and carries its reason',
    ref[0] && Math.abs(ref[0].amount - refunded) < 0.01 && (ref[0].reason || '').length >= 3,
    ref[0] ? `₹${ref[0].amount} — "${ref[0].reason}"` : '—');

  dbOrder = await orderRow();
  check('5.7 a PART refund leaves the order PAID, not REFUNDED',
    dbOrder.status === 'PAID', `${dbOrder.status}, paid ₹${dbOrder.paid}, refunded ₹${dbOrder.refunded}`);
  check('5.8 the order now nets out at collected minus returned',
    Math.abs((dbOrder.paid - dbOrder.refunded) - (due - refunded)) < 0.01,
    `₹${dbOrder.paid} − ₹${dbOrder.refunded} = ₹${Math.round((dbOrder.paid - dbOrder.refunded) * 100) / 100}`);

  // ---- 5c. the report --------------------------------------------------
  // Everything above is one order's own row. The report is the first thing
  // that AGGREGATES, and an aggregate is where a discount or a refund gets
  // silently counted twice, netted away, or dropped.
  const rep = await openReport(TILL_NAME_RE, BIZ_DATE);
  await page.screenshot({ path: `${OUT}/09d-sales-report.png`, fullPage: true });

  // On a till whose whole day is this run, the report totals ARE this order's.
  // On BSC-CP they are not — it carries the acceptance traffic by design — so
  // the assertion has to be about this run's CONTRIBUTION to the aggregate,
  // not about the aggregate. Measured as a delta against the same figures read
  // before the order existed; comparing to an absolute would pass on a quiet
  // till and fail on a busy one while the code under test behaved identically.
  const [agg] = await q(`select
      coalesce((select sum(o.total) from "Order" o join "Branch" b on b.id=o."branchId"
                where b.code='${TILL}' and o.status in ('PAID','REFUNDED')
                  and (o."billedAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}'),0)::float8 as net,
      coalesce((select sum(r.amount) from "Refund" r join "Order" o on o.id=r."orderId"
                join "Branch" b on b.id=o."branchId"
                where b.code='${TILL}' and r.status='SUCCEEDED'
                  and (r."createdAt" at time zone 'UTC' at time zone 'Asia/Kolkata')::date = date '${BIZ_DATE}'),0)::float8 as refunds`);

  check('5.9 the report counts the refund, once, at its real size',
    Math.abs(rep.refunds - agg.refunds) < 0.01 && Math.abs(rep.refunds - (baseline.refunds + refunded)) < 0.01,
    `report ₹${rep.refunds} = db ₹${agg.refunds} = ₹${baseline.refunds} before + ₹${refunded} returned`);
  // Net sales is Σ order totals for orders billed in range — the DISCOUNTED
  // totals. A report that quoted the gross would be the shop's revenue
  // overstated by exactly the discount it gave. So the delta this order adds
  // must be its discounted total, and must NOT be the gross.
  const grossWouldBe = Math.round((disc[0].subtotal + dbOrder.tax) * 100) / 100;
  check('5.10 net sales is the discounted total, not the gross',
    Math.abs(rep.net - agg.net) < 0.01
      && Math.abs((rep.net - baseline.net) - dbOrder.total) < 0.01
      && Math.abs((rep.net - baseline.net) - grossWouldBe) > 0.01,
    `report ₹${rep.net} − ₹${baseline.net} before = ₹${Math.round((rep.net - baseline.net) * 100) / 100}`
    + `, order total ₹${dbOrder.total}, gross would have been ₹${grossWouldBe}`);
  } // end of the sell/bill/pay/refund/report path (skipped under CLOSE_ONLY)

  // ---- 6. the closing -------------------------------------------------
  if (!CLOSE_DAY) {
    log('CLOSE_DAY=0 — day closing skipped');
  } else {
    await page.goto(`${BASE}/reports/day-close`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const hasBranchSelect = await page.locator('#dc-branch').isVisible().catch(() => false);
    if (hasBranchSelect) await chooseOption('#dc-branch', TILL_NAME_RE);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/10-day-close-preview.png`, fullPage: true });

    // Count the drawer honestly: opening float 0, so the cash that should be
    // in it is what the day took LESS what it handed back. Counting `due`
    // alone — the figure before the refund — is the mistake this step exists
    // to catch, and it would leave a variance of exactly the refund.
    //
    // A deliberate zero variance is the assertion: if the expected figure
    // were wrong the form would demand a note, and that demand is the test.
    const float = 0;
    const expectedDrawer = Math.round((due - refunded) * 100) / 100;
    log('  drawer should hold', `₹${due} taken − ₹${refunded} returned = ₹${expectedDrawer}`);
    await page.fill('#dc-counted', String(expectedDrawer));
    await page.fill('#dc-float', String(float));
    await page.waitForTimeout(600);
    const balanced = await page.locator('text=/The drawer/').first().innerText().catch(() => '');
    check('6.1 counted drawer balances against expected cash',
      /balances|matches|is correct/i.test(balanced) || /₹0/.test(balanced), balanced.trim() || 'no variance line');
    await page.screenshot({ path: `${OUT}/11-day-close-counted.png`, fullPage: true });

    await page.getByRole('button', { name: /^(Close \d|Filing…|File correction)/ }).first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/12-day-closed.png`, fullPage: true });

    // Money on DayClose is stored in PAISE as integers, unlike Order/Payment
    // which are numeric rupees. Comparing the two without the /100 is how a
    // closing silently reads a hundred times too large.
    const dc = await q(`select d."businessDate", d."countedCashPaise" as counted,
                               d."expectedCashPaise" as expected, d."variancePaise" as variance,
                               d."cashSalesPaise" as cash_sales,
                               d."cashRefundsPaise" as cash_refunds,
                               d."ordersBilled" as orders, d."closedAt"
                        from "DayClose" d join "Branch" b on b.id=d."branchId"
                        where b.code='${TILL}' order by d."closedAt" desc limit 1`);
    check('6.2 a closing exists for this till and business date',
      dc.length === 1, dc.length ? `${dc[0].businessDate} closed at ${dc[0].closedAt}` : 'none');
    check('6.3 the closing reconciles with zero variance',
      dc.length === 1 && Number(dc[0].variance) === 0,
      dc.length ? `counted ₹${dc[0].counted / 100} vs expected ₹${dc[0].expected / 100}, variance ₹${dc[0].variance / 100}` : '—');
    check('6.4 the closing covers this run\'s trade and only this run\'s',
      dc.length === 1 && Number(dc[0].orders) === 1
        && Math.round(Number(dc[0].cash_sales)) === Math.round(due * 100),
      dc.length ? `${dc[0].orders} order billed, cash sales ₹${dc[0].cash_sales / 100} (run took ₹${due})` : '—');
    // Cash taken and cash returned are stored apart, and the expected drawer
    // is their difference. Netting the refund into sales instead would give
    // the same expected cash while understating the day's trade — the two
    // figures a shop reconciles against its own book.
    check('6.5 the refund is held apart from sales and subtracted from the drawer',
      dc.length === 1
        && Math.round(Number(dc[0].cash_refunds)) === Math.round(refunded * 100)
        && Math.round(Number(dc[0].expected)) === Math.round((due - refunded) * 100),
      dc.length ? `sales ₹${dc[0].cash_sales / 100} − refunds ₹${dc[0].cash_refunds / 100} = expected ₹${dc[0].expected / 100}` : '—');
  }

  // ---- 7. the page itself ---------------------------------------------
  check('7.1 no console or page errors during the billing path',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'clean');

  const pass = results.filter((r) => r.ok).length;
  log('');
  log('RESULT', `${pass} PASS / ${results.length - pass} FAIL`);
  log('order', `${dbOrder.invoiceNumber} on ${TILL}, total ₹${dbOrder.total}`);
  log('artefacts', OUT);
  if (pass !== results.length) process.exitCode = 1;
} finally {
  await browser.close();
}

// Read-only SQL against the production database, via the container — the
// prod Postgres publishes no host port, which is why this goes through
// docker exec rather than a connection string.
async function q(sql) {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('docker', [
    'exec', '-i', 'pos-prod-postgres-1',
    'psql', '-U', 'atc_pos', '-d', 'atc_pos', '-tA', '-c',
    `select coalesce(json_agg(t), '[]') from (${sql}) t`,
  ], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}
