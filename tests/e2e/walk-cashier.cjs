// ATC POS phase-2 dev walkthrough — Part A: cashier flow.
// Read-only towards the repo; talks to the dev stack only (see env.cjs).
// Requires POS_SEED_CASHIER_PASSWORD in the environment — never printed.
// Output: step PASS/FAIL lines. Screenshots: <shots>/a-*.png
const fs = require('fs');
const { BASE, SHOTS, creds, launchBrowser } = require('./env.cjs');

fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const badResponses = [];
let shotN = 0;
let fails = 0;

const log = (s) => process.stdout.write(s + '\n');

async function main() {
  const cashier = creds.cashier();
  const browser = await launchBrowser(log);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);

  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push('console: ' + m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  const shot = async (name) => {
    shotN += 1;
    await page.screenshot({ path: `${SHOTS}/a-${String(shotN).padStart(2, '0')}-${name}.png`, fullPage: false });
  };

  const step = async (name, fn) => {
    try {
      await fn();
      log(`PASS ${name}`);
    } catch (e) {
      fails += 1;
      log(`FAIL ${name}: ${String(e.message || e).split('\n')[0]}`);
      try { await shot('FAIL-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)); } catch {}
    }
  };

  const bodyText = () => page.evaluate(() => document.body.innerText);

  await step('login page renders', async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await shot('login');
  });

  await step('cashier signs in', async () => {
    await page.fill('#email', cashier.email);
    await page.fill('#password', cashier.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/sell', { timeout: 15000 }); // cashier home = /sell
    await shot('cashier-landing');
  });

  await step('sell screen: catalog + categories load', async () => {
    await page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Cappuccino');
    await page.waitForSelector('text=Cold Brew');
    if (!(await bodyText()).includes('Coffee')) throw new Error('category chips missing');
    await shot('sell-catalog');
  });

  await step('dine-in: pick free table T1', async () => {
    await page.click('button:has-text("Dine-in")');
    await page.waitForSelector('text=Tables (occupied ones resume their order)');
    await page.click('button:has-text("T1")');
    await page.waitForSelector('text=Table T1 selected');
    await shot('table-picked');
  });

  await step('first product starts the order (Cappuccino)', async () => {
    await page.click('button.card:has-text("Cappuccino")');
    await page.waitForSelector('text=Dine-in · T1');
    await page.waitForSelector('span:has-text("OPEN")');
  });

  await step('add Masala Chai', async () => {
    await page.click('button.card:has-text("Masala Chai")');
    await page.waitForSelector('li:has-text("Masala Chai")');
  });

  await step('variant product: Cold Brew → Large', async () => {
    await page.click('button.card:has-text("Cold Brew")'); // .card: category chip "Cold Brews" bhi match karta tha
    await page.waitForSelector('text=Choose a size / variant.');
    await shot('variant-modal');
    await page.click('button:has-text("Large")');
    await page.waitForSelector('li:has-text("Cold Brew")');
  });

  await step('server totals: subtotal 490.00, total 529.90', async () => {
    await page.waitForSelector('text=529.90');
    const t = await bodyText();
    if (!t.includes('490.00')) throw new Error('subtotal 490.00 not shown');
    await shot('cart-totals');
  });

  await step('send KOT — ticket shows items, no prices', async () => {
    await page.click('button:has-text("Send KOT")');
    await page.waitForSelector('text=Kitchen order ticket');
    await page.waitForSelector('text=/KOT #\\d+/');
    const modal = await page
      .locator('div.fixed:has-text("Kitchen order ticket")')
      .first()
      .innerText();
    await shot('kot');
    await page.locator('div.fixed:has-text("Kitchen order ticket") button[aria-label="Close"]').click();
    if (modal.includes('₹')) throw new Error('KOT shows a price');
    if (!/Cappuccino[\s\S]*× 1/.test(modal)) throw new Error('KOT items missing');
  });

  await step('qty locked after KOT', async () => {
    await page.waitForSelector('text=Sent to kitchen — qty locked');
  });

  let invoiceNo = '';
  await step('bill: invoice number assigned, payment modal opens', async () => {
    await page.click('button:has-text("Bill")');
    await page.waitForSelector('text=Record payment');
    await page.waitForSelector('text=MANUAL PAYMENT RECORD');
    const t = await bodyText();
    const m = t.match(/\b[A-Z0-9][A-Z0-9-]*\/\d{2,4}[-/]\d{2,}\/\d+\b|\bINV[-/][A-Z0-9/-]+\b/);
    invoiceNo = m ? m[0] : '';
    if (!t.includes('BILLED')) throw new Error('order not BILLED');
    await shot('billed-payment-modal');
  });

  await step('over-payment by CARD amount is refused (400)', async () => {
    await page.click('div.fixed button:has-text("CARD")');
    await page.fill('#pay-amount', '600');
    await page.click('button[type="submit"]:has-text("Record payment")');
    await page.waitForSelector('div.fixed .border-red-200');
    await shot('overpay-rejected');
  });

  await step('CASH 1000 → server change due 470.10', async () => {
    await page.click('div.fixed button:has-text("CASH")');
    await page.fill('#pay-tendered', '1000');
    await page.click('button[type="submit"]:has-text("Record payment")');
    await page.waitForSelector('text=Payment recorded.');
    await page.waitForSelector('text=470.10');
    await shot('cash-change');
  });

  await step('receipt: DEMO banner, invoice, manual-payment label', async () => {
    await page.click('button:has-text("Order paid in full — view receipt")');
    await page.waitForSelector('text=DEMO — sample data, not a real sale');
    const rc = await page.locator('.print-area').first().innerText();
    await shot('receipt');
    await page.locator('div.fixed button[aria-label="Close"]').last().click();
    if (!/Invoice/.test(rc)) throw new Error('invoice row missing');
    if (invoiceNo && !rc.includes(invoiceNo)) throw new Error('invoice number mismatch on receipt');
    if (!/manual payment record — not gateway-verified/i.test(rc)) throw new Error('manual label missing');
    if (!rc.includes('470.10')) throw new Error('change due missing on receipt');
    if (!rc.includes('529.90')) throw new Error('total missing on receipt');
  });

  await step('reprint KOTs from the paid order', async () => {
    await page.click('text=Reprint KOTs');
    await page.waitForSelector('text=KOTs on this order');
    await page.locator('div.fixed button:has-text("KOT #")').first().click();
    await page.waitForSelector('text=Kitchen order ticket');
    await shot('kot-reprint');
    // ticket band karne par KOT-list modal wapas render hoti hai — dono band karo
    await page.locator('div.fixed button[aria-label="Close"]').last().click();
    await page.waitForSelector('text=KOTs on this order');
    await page.locator('div.fixed button[aria-label="Close"]').last().click();
    await page.waitForSelector('text=KOTs on this order', { state: 'hidden' });
  });

  await step('second order on T2 stays OPEN; board shows occupied amber', async () => {
    await page.click('button:has-text("New sale")');
    await page.click('button:has-text("Dine-in")');
    await page.waitForSelector('text=Tables (occupied ones resume their order)');
    const t2busy = page.locator('button[title*="Occupied — resume order"]:has-text("T2")');
    if (await t2busy.count()) {
      await t2busy.first().click(); // pichhle adhure run ka residue OPEN order resume
    } else {
      await page.click('button:has-text("T2")');
      await page.waitForSelector('text=Table T2 selected');
      await page.click('button.card:has-text("Espresso")');
    }
    await page.waitForSelector('text=Dine-in · T2');
    await page.waitForSelector('li:has-text("Espresso")');
    // board sirf Dine-in view mein hai — New sale ke baad dobara Dine-in kholna zaroori
    await page.click('button:has-text("New sale")');
    await page.click('button:has-text("Dine-in")');
    await page.waitForSelector('button[title*="Occupied — resume order"]:has-text("T2")');
    await shot('board-occupied');
  });

  await step('tapping occupied T2 resumes the order (no new order)', async () => {
    await page.click('button[title*="Occupied — resume order"]:has-text("T2")');
    await page.waitForSelector('text=Dine-in · T2');
    const t = await bodyText();
    if (!t.includes('Espresso')) throw new Error('resumed order lost its line');
  });

  await step('cashier cannot open /reports (route gated)', async () => {
    await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    if (page.url().includes('/reports')) throw new Error('cashier reached /reports');
    await shot('cashier-reports-blocked');
  });

  await step('cashier UI hides void controls', async () => {
    await page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Cappuccino');
    const t = await bodyText();
    if (t.includes('Void order')) throw new Error('cashier sees Void order');
  });

  await ctx.close();
  await browser.close();

  log('---');
  log(`steps failed: ${fails}`);
  const realErrors = consoleErrors.filter((e) => !/401|403|400|409/.test(e));
  log(`page/console errors (unexpected): ${realErrors.length}`);
  realErrors.slice(0, 10).forEach((e) => log('  ' + e.slice(0, 200)));
  const unexpected5xx = badResponses.filter((r) => /^5\d\d /.test(r));
  log(`http 5xx: ${unexpected5xx.length}`);
  unexpected5xx.slice(0, 10).forEach((r) => log('  ' + r));
  log(`http 4xx seen (expected ones incl. login probe 401, over-pay 400): ${badResponses.length - unexpected5xx.length}`);
  badResponses.filter((r) => !/^5\d\d /.test(r)).slice(0, 10).forEach((r) => log('  ' + r));
  process.exitCode = fails > 0 || unexpected5xx.length > 0 ? 1 : 0;
}

main().catch((e) => {
  log('FATAL ' + (e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | '));
  process.exitCode = 2;
});
