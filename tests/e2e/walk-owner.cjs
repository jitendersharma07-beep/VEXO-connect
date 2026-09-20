// ATC POS phase-2 dev walkthrough — Part C: owner catalog admin + reports
// scope + a minimal ATC-admin scoping check. Requires POS_SEED_OWNER_PASSWORD
// and POS_SEED_ADMIN_PASSWORD — never printed. Screenshots: <shots>/c-*.png
const fs = require('fs');
const { BASE, SHOTS, creds, launchBrowser } = require('./env.cjs');

fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const badResponses = [];
let shotN = 0;
let fails = 0;
const log = (s) => process.stdout.write(s + '\n');

async function main() {
  const owner = creds.owner();
  const admin = creds.admin();
  const browser = await launchBrowser(log);

  const newPage = async () => {
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
    return { ctx, page };
  };

  let { ctx, page } = await newPage();
  const shot = async (name) => {
    shotN += 1;
    await page.screenshot({ path: `${SHOTS}/c-${String(shotN).padStart(2, '0')}-${name}.png` });
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

  await step('owner signs in', async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', owner.email);
    await page.fill('#password', owner.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  await step('reports: all branches + branch filter to empty CH branch', async () => {
    await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Net sales');
    await page.waitForSelector('#rep-branch');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    await page.waitForSelector(`text=${today}`); // by-day row => data load complete, amount-agnostic
    await shot('reports-all-branches');
    await page.selectOption('#rep-branch', { label: 'Brew Street Café — Cyber Hub (BSC-CH)' });
    await page.waitForSelector('text=No activity in this range.');
    await shot('reports-ch-empty');
  });

  await step('catalog: products table renders seed rows', async () => {
    await page.goto(BASE + '/catalog', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Catalog');
    await page.waitForSelector('tr:has-text("Cappuccino")');
    await shot('catalog');
  });

  await step('create product with tax, then add a variant', async () => {
    await page.click('button:has-text("Add product")');
    await page.waitForSelector('#p-name');
    await page.fill('#p-name', 'Walkthrough Special ' + Date.now()); // unique per run
    await page.fill('#p-price', '99');
    await page.selectOption('#p-tax', { label: 'GST 5%' });
    await page.click('button[type="submit"]:has-text("Create product")');
    await page.waitForSelector('text=Variants (absolute unit price)');
    await page.click('text=+ Add variant');
    await page.fill('input[aria-label="New variant name"]', 'Mini');
    await page.fill('input[aria-label="New variant price"]', '79');
    await page.click('button[type="submit"]:has-text("Add")');
    await page.waitForSelector('li:has-text("Mini")');
    await shot('product-created');
    await page.locator('div.fixed div.mb-4 button').click();
  });

  await step('search finds it; archive removes it from ACTIVE', async () => {
    await page.fill('input[aria-label="Search products"]', 'Walkthrough');
    await page.waitForSelector('tr:has-text("Walkthrough Special")');
    await page.locator('tr:has-text("Walkthrough Special") button:has-text("Archive")').click();
    await page.waitForSelector('text=Archive product');
    await page.locator('div.fixed button:has-text("Archive")').last().click();
    await page.waitForSelector('text=No products here');
    await shot('archived-gone-from-active');
  });

  await step('ARCHIVED filter shows it with badge', async () => {
    await page.selectOption('select[aria-label="Filter by status"]', 'ARCHIVED');
    await page.waitForSelector('tr:has-text("Walkthrough Special")');
    const row = await page.locator('tr:has-text("Walkthrough Special")').first().innerText();
    if (!row.includes('ARCHIVED')) throw new Error('ARCHIVED badge missing');
    await shot('archived-filter');
  });

  await step('tables admin renders branch tables', async () => {
    await page.goto(BASE + '/tables', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=T1');
    await shot('tables');
  });

  await step('owner sell screen has branch selector', async () => {
    await page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Cappuccino');
    await page.waitForSelector('#sell-branch');
    const t = await bodyText();
    if (t.includes('does not allow POS actions')) throw new Error('licence banner shown for active trial');
    await shot('owner-sell');
  });

  await step('ATC admin: lands on companies, data screens demand a scope', async () => {
    await ctx.close();
    ({ ctx, page } = await newPage());
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', admin.email);
    await page.fill('#password', admin.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/atc/companies', { timeout: 15000 });
    await shot('atc-companies');
    await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=No company selected');
    await shot('atc-unscoped-reports');
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
  log(`http 4xx seen: ${badResponses.length - unexpected5xx.length}`);
  process.exitCode = fails > 0 || unexpected5xx.length > 0 ? 1 : 0;
}

main().catch((e) => {
  log('FATAL ' + (e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | '));
  process.exitCode = 2;
});
