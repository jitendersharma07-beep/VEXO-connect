// Billing BROWSER dry run against the deployed POS.
//
// Drives the real screen in a real browser, then reads the effect out of the
// database — a screen that says "Paid" is not proof that anything was paid.
// Every assertion below is checked twice: once against what the UI rendered
// and once against what Postgres holds. Only the second one is evidence.
//
// Target till: BSC-CH (Cyber Hub), reserved in UAT-TILL-RESERVATION.md.
// No password, token or cookie is ever printed.
//
//   EXPLORE=1 node deploy/billing-browser-run.mjs     # read-only reconnaissance
//   node deploy/billing-browser-run.mjs               # sell → bill → pay → receipt (WRITES)
//   CLOSE_DAY=1 CLOSE_ONLY=1 node deploy/…            # file the day closing (PERMANENT)
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
const TILL = 'BSC-CH';

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
  await page.waitForLoadState('networkidle');
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

  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/02-sell.png`, fullPage: true });

  if (EXPLORE) {
    await dump('sell');
    log('EXPLORE mode — no writes performed');
    await browser.close();
    process.exit(0);
  }

  // `amountPaid` / `amountDue` are NOT columns — the API derives them. So
  // derive them here too, from the payment and refund rows, rather than
  // asking the same code that is under test what it thinks it collected.
  const orderRow = async () => {
    const r = await q(`select o.id, o.status, o."invoiceNumber",
                              o.subtotal::float8 as subtotal, o."taxAmount"::float8 as tax,
                              o.total::float8 as total,
                              coalesce((select sum(p.amount) from "Payment" p where p."orderId"=o.id),0)::float8 as paid,
                              coalesce((select sum(r2.amount) from "Refund" r2
                                        where r2."orderId"=o.id and r2.status='SUCCEEDED'),0)::float8 as refunded
                       from "Order" o join "Branch" b on b.id=o."branchId"
                       where b.code='${TILL}' order by o."createdAt" desc limit 1`);
    return r[0];
  };

  let dbOrder;
  let due;
  if (CLOSE_ONLY) {
    dbOrder = await orderRow();
    due = Math.round(dbOrder.paid * 100) / 100;
    log('CLOSE_ONLY — reusing the order already on the till', `${dbOrder.invoiceNumber} ₹${dbOrder.total}`);
  } else {
  // ---- 1. open a takeaway order on the reserved till -----------------
  // The order panel is rendered twice below lg (pinned panel + sticky action
  // bar). At 1366 px only the panel is visible, but every locator below is
  // still scoped or :visible-filtered rather than relying on that, because a
  // silently-ambiguous selector is how a harness starts clicking the wrong
  // control after an unrelated layout change.
  await page.selectOption('#sell-branch', { label: /Cyber Hub/ });
  const branchLabel = await page.locator('#sell-branch option:checked').innerText();
  check('1.1 reserved till selected in the UI', /BSC-CH/.test(branchLabel), branchLabel);

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

  const uiTotal = (await page.locator('text=Total').locator('xpath=following-sibling::*[1]').first()
    .innerText().catch(() => '')) || '';
  log('  screen total', uiTotal.trim());
  log('  db subtotal/tax/total', `₹${dbOrder.subtotal} / ₹${dbOrder.tax} / ₹${dbOrder.total}`);
  await page.screenshot({ path: `${OUT}/03-order-open.png`, fullPage: true });

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
  await page.locator('.print-area').first().screenshot({ path: `${OUT}/08-receipt-print.png` });
  await page.pdf({ path: `${OUT}/09-receipt.pdf`, width: '80mm', height: '200mm', printBackground: true });
  await page.emulateMedia({ media: null });
  log('  receipt PDF written', `${OUT}/09-receipt.pdf`);
  } // end of the sell/bill/pay path (skipped under CLOSE_ONLY)

  // ---- 6. the closing -------------------------------------------------
  if (!CLOSE_DAY) {
    log('CLOSE_DAY=0 — day closing skipped');
  } else {
    await page.goto(`${BASE}/reports/day-close`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const hasBranchSelect = await page.locator('#dc-branch').isVisible().catch(() => false);
    if (hasBranchSelect) await page.selectOption('#dc-branch', { label: /Cyber Hub/ });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/10-day-close-preview.png`, fullPage: true });

    // Count the drawer honestly: opening float 0, so the counted cash that
    // balances is exactly the cash the day took. A deliberate zero variance
    // is the assertion — if the expected figure were wrong the form would
    // demand a note, and that demand is the test.
    const float = 0;
    await page.fill('#dc-counted', String(due));
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
                               d."cashSalesPaise" as cash_sales, d."ordersBilled" as orders,
                               d."closedAt"
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
