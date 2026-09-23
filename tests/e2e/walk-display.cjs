// VC-101 dev walkthrough — cashier till and customer display, side by side.
// Two isolated browser contexts on purpose: the display context never holds
// a staff cookie, so anything it renders arrived over the pairing token.
// Read-only towards the repo; talks to the dev stack only (see env.cjs).
// Requires POS_SEED_CASHIER_PASSWORD in the environment — never printed.
// Output: step PASS/FAIL lines. Screenshots: <shots>/d-*.png
const fs = require('fs');
const { BASE, SHOTS, creds, launchBrowser } = require('./env.cjs');

fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
let shotN = 0;
let fails = 0;

const log = (s) => process.stdout.write(s + '\n');

async function main() {
  const cashier = creds.cashier();
  const browser = await launchBrowser(log);
  const tillCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dispCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const till = await tillCtx.newPage();
  const display = await dispCtx.newPage();
  till.setDefaultTimeout(15000);
  display.setDefaultTimeout(15000);

  for (const [name, page] of [['till', till], ['display', display]]) {
    page.on('pageerror', (err) => consoleErrors.push(`${name} pageerror: ${err.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`${name} console: ${m.text()}`);
    });
  }

  const shot = async (page, name) => {
    shotN += 1;
    await page.screenshot({ path: `${SHOTS}/d-${String(shotN).padStart(2, '0')}-${name}.png` });
  };

  const step = async (name, fn) => {
    try {
      await fn();
      log(`PASS ${name}`);
    } catch (e) {
      fails += 1;
      log(`FAIL ${name}: ${String(e.message || e).split('\n')[0]}`);
      try { await shot(till, 'FAIL-till'); await shot(display, 'FAIL-display'); } catch {}
    }
  };

  await step('cashier signs in', async () => {
    await till.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await till.fill('#email', cashier.email);
    await till.fill('#password', cashier.password);
    await till.click('button[type="submit"]');
    await till.waitForURL('**/sell', { timeout: 15000 });
  });

  let code = '';
  await step('pair page mints a six-digit code', async () => {
    await till.goto(BASE + '/display/pair', { waitUntil: 'domcontentloaded' });
    await till.click('button:has-text("Generate pairing code")');
    await till.waitForSelector('div.font-mono');
    code = (await till.locator('div.font-mono').innerText()).replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) throw new Error(`code not six digits: "${code}"`);
    await shot(till, 'pair-page-code');
  });

  await step('display pairs and idles on the branch welcome', async () => {
    await display.goto(BASE + '/display', { waitUntil: 'domcontentloaded' });
    await shot(display, 'display-pair-screen');
    await display.fill('input[aria-label="Pairing code"]', code);
    await display.click('button:has-text("Pair display")');
    await display.waitForSelector('text=your order will appear here');
    await shot(display, 'display-idle');
  });

  let total = '';
  await step('takeaway order mirrors onto the display', async () => {
    await till.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
    await till.click('button:has-text("Takeaway")');
    await till.click('button.card:has-text("Cappuccino")');
    await till.waitForSelector('span:has-text("OPEN")');
    await till.click('button.card:has-text("Masala Chai")');
    await till.waitForSelector('li:has-text("Masala Chai")');
    await shot(till, 'till-two-lines');
    // The idle display polls every 10s; the first ACTIVE frame can lag that.
    await display.waitForSelector('text=Cappuccino', { timeout: 15000 });
    await display.waitForSelector('text=Masala Chai');
    // The figure the customer sees must be the figure the till shows. The
    // till renders the server total; read it there, demand it here.
    const tillText = await till.evaluate(() => document.body.innerText);
    const m = tillText.match(/Total\s*₹?([\d,]+\.\d{2})/);
    if (!m) throw new Error('till total not found');
    total = m[1];
    await display.waitForSelector(`text=${total}`);
    await shot(display, 'display-active');
  });

  await step('billing turns the display into a payment ask', async () => {
    await till.click('button:has-text("Bill")');
    await till.waitForSelector('text=Record payment');
    await display.waitForSelector('text=Please pay', { timeout: 10000 });
    await display.waitForSelector('text=Invoice');
    await shot(display, 'display-billed');
  });

  await step('settling flips the display to a thank-you', async () => {
    await till.click('div.fixed button:has-text("CASH")');
    await till.fill('#pay-tendered', '1000');
    await till.click('button[type="submit"]:has-text("Record payment")');
    await till.waitForSelector('text=Payment recorded.');
    await display.waitForSelector('text=Thank you!', { timeout: 10000 });
    const shown = await display.evaluate(() => document.body.innerText);
    if (!shown.includes(total)) throw new Error(`thank-you total missing ${total}`);
    await shot(display, 'display-thankyou');
  });

  await step('after the dwell the display idles again', async () => {
    await display.waitForSelector('text=your order will appear here', { timeout: 20000 });
    await shot(display, 'display-idle-after-sale');
  });

  await step('cashier sign-out ends the pairing', async () => {
    // Through the page so the session cookie goes with it; the UI path to
    // sign-out is covered by the existing walkthroughs.
    await till.evaluate(() =>
      fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }),
    );
    await display.waitForSelector('text=Pair this display', { timeout: 25000 });
    await display.waitForSelector('text=This display was signed out');
    await shot(display, 'display-unpaired-after-logout');
  });

  await browser.close();

  if (consoleErrors.length) {
    log('console errors (informational):');
    for (const e of consoleErrors.slice(0, 10)) log('  ' + e);
  }
  log(fails ? `RESULT: ${fails} step(s) FAILED` : 'RESULT: all steps passed');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  log('STOP: ' + (e.message || e));
  process.exit(2);
});
