// VC-102 promotions browser walk — Part D, against Window 1's landed API.
// Owner creates + publishes an automatic percent promotion and a coded flat
// one (server-side validation refusal proven on the way), then works the
// Sell screen: ineligible code refused with the engine's reason (order
// survives OPEN), automatic offer applied by picking from the offers list,
// removal + re-apply, plain bill, receipt naming the offer, coded offer on a
// qualifying order. Finally, back on the campaign screen: a DRAFT with an
// item rule round-trips through PUT /rules and the list names the rule back,
// and Archive asks first ("Keep it" changes nothing) before the terminal
// DRAFT → ARCHIVED move strips the row's write controls.
// Screenshots: <shots>/d-*.png; FAIL-* for failed steps.
const fs = require('fs');
const { BASE, SHOTS, creds, launchBrowser } = require('./env.cjs');

fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const badResponses = [];
let shotN = 0;
let fails = 0;
const log = (s) => process.stdout.write(s + '\n');

// Unique per run so re-runs against a persistent demo DB never collide on
// the promo-code unique index or pick up a previous run's campaigns.
const RUN = String(Date.now()).slice(-6);
const AUTO_NAME = `Walk Auto 10pc ${RUN}`;
const CODE = `WALK${RUN}`;
const CODE_NAME = `Walk Coded 50 ${RUN}`;
const RULES_NAME = `Walk Rules ${RUN}`;

async function main() {
  const owner = creds.owner();
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
    await page.screenshot({ path: `${SHOTS}/d-${String(shotN).padStart(2, '0')}-${name}.png` });
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
  const closeModal = async () => {
    await page.locator('div.fixed div.mb-4 button').click().catch(() => page.keyboard.press('Escape'));
  };

  await step('owner signs in', async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', owner.email);
    await page.fill('#password', owner.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  await step('promotions page reachable from nav', async () => {
    await page.click('nav >> text=Promotions');
    await page.waitForSelector('text=Live now');
    await shot('promotions-page');
  });

  await step('create + publish automatic 10% promotion', async () => {
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');
    await page.fill('#promo-name', AUTO_NAME);
    await page.fill('#promo-value', '10');
    await page.click('button[type="submit"]:has-text("Create draft")');
    await page.waitForSelector(`tr:has-text("${AUTO_NAME}")`);
    await page.locator(`tr:has-text("${AUTO_NAME}") button:has-text("Publish")`).click();
    await page.waitForSelector(`tr:has-text("${AUTO_NAME}"):has-text("Live now")`);
    await shot('auto-promo-live');
  });

  await step('server refuses 150% percent benefit', async () => {
    // No client-side max on the field — the zod schema is the authority and
    // its message ("percent: Number must be less than or equal to 100")
    // surfaces in the form's error note.
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');
    await page.fill('#promo-name', 'Bad promo ' + RUN);
    await page.fill('#promo-value', '150');
    await page.click('button[type="submit"]:has-text("Create draft")');
    await page.waitForSelector('text=/less than or equal to 100/i');
    await shot('validation-error');
    await closeModal();
  });

  await step('create + publish coded ₹50-over-₹500 promotion', async () => {
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');
    await page.fill('#promo-name', CODE_NAME);
    await page.selectOption('#promo-type', 'FLAT');
    await page.fill('#promo-value', '50');
    await page.fill('#promo-min', '500');
    await page.fill('#promo-code', CODE);
    await page.click('button[type="submit"]:has-text("Create draft")');
    await page.waitForSelector(`tr:has-text("${CODE_NAME}")`);
    await page.locator(`tr:has-text("${CODE_NAME}") button:has-text("Publish")`).click();
    await page.waitForSelector(`tr:has-text("${CODE_NAME}"):has-text("Live now")`);
    await shot('coded-promo-live');
  });

  await step('sell shows the offers panel (promo.read holder)', async () => {
    await page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Cappuccino');
    await page.click('button:has-text("Takeaway")');
    await page.locator('button:has-text("Masala Chai")').first().click();
    await page.waitForSelector('text=Offers running');
    await page.waitForSelector(`text=${AUTO_NAME}`);
    await shot('offers-panel');
  });

  await step('ineligible code refused with reason; order survives OPEN', async () => {
    // ₹90 chai is under the ₹500 minimum — the server refuses with the
    // engine's reason and the order is untouched (Bill still offered, no
    // promotion row, discount still zero).
    await page.fill('input[aria-label="Promo code"]', CODE);
    await page.locator('button[aria-label="Apply promo code"]').click();
    await page.waitForSelector('text=/does not apply/i');
    await page.waitForSelector('button:has-text("Bill")');
    const totals = await page.locator('span:text-is("Discount")').locator('..').innerText();
    if (!/0\.00/.test(totals.replace(/,/g, ''))) throw new Error('discount moved on refusal: ' + totals);
    await shot('ineligible-refused');
  });

  await step('automatic offer applied from the list (server figures)', async () => {
    await page.locator(`li:has-text("${AUTO_NAME}") button:has-text("Apply")`).click();
    await page.waitForSelector('text=/saved ₹9\\.00/');
    const totals = await page.locator('span:text-is("Discount")').locator('..').innerText();
    if (!/9\.00/.test(totals.replace(/,/g, ''))) throw new Error('discount line not ₹9.00: ' + totals);
    await shot('auto-applied');
  });

  await step('promotion removable and re-appliable before billing', async () => {
    await page.locator(`button[aria-label="Remove ${AUTO_NAME}"]`).click();
    await page.waitForSelector('text=/saved ₹9\\.00/', { state: 'detached' });
    const totals = await page.locator('span:text-is("Discount")').locator('..').innerText();
    if (!/0\.00/.test(totals.replace(/,/g, ''))) throw new Error('discount not back to zero: ' + totals);
    await shot('promo-removed');
    await page.locator(`li:has-text("${AUTO_NAME}") button:has-text("Apply")`).click();
    await page.waitForSelector('text=/saved ₹9\\.00/');
  });

  await step('bill carries the promotion; totals are the server’s', async () => {
    await page.locator('button:has-text("Bill")').first().click();
    await page.waitForSelector('text=/Billed — invoice/');
    // The payment modal opens on bill; the applied row must survive billing.
    await closeModal();
    await page.waitForSelector(`text=${AUTO_NAME}`);
    await page.waitForSelector('text=/saved ₹9\\.00/');
    await shot('billed-with-promo');
  });

  await step('receipt names the promotion under its discount', async () => {
    await page.locator('button:has-text("Receipt")').first().click();
    await page.waitForSelector('text=/Invoice/i');
    const body = await page.evaluate(() => document.body.innerText);
    if (!/Discount/i.test(body)) throw new Error('receipt shows no discount line');
    if (!body.includes(AUTO_NAME)) throw new Error('receipt does not name the promotion');
    await shot('receipt-names-promo');
    // The print dialog has its own markup (portalled onto <body>).
    await page.locator('button[aria-label="Close"]').click();
  });

  await step('coded promotion applies on a qualifying order', async () => {
    await page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Cappuccino');
    await page.click('button:has-text("Takeaway")');
    // 3 × ₹180 Cappuccino = ₹540 ≥ ₹500 minimum.
    for (let i = 0; i < 3; i += 1) {
      await page.locator('button:has-text("Cappuccino")').first().click();
      await page.waitForTimeout(300);
    }
    await page.fill('input[aria-label="Promo code"]', CODE);
    await page.locator('button[aria-label="Apply promo code"]').click();
    await page.waitForSelector(`text=${CODE_NAME}`);
    await page.waitForSelector('text=/saved ₹50\\.00/');
    await shot('coded-applied');
  });

  await step('draft with an item rule round-trips (editor, PUT /rules, list)', async () => {
    // Stays a DRAFT on purpose: it must never reach the till, so the sell
    // steps above keep meaning what they say on a re-run.
    await page.goto(BASE + '/promotions', { waitUntil: 'domcontentloaded' });
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');
    await page.fill('#promo-name', RULES_NAME);
    await page.fill('#promo-value', '5');
    await page.selectOption('select[aria-label="Rule kind"]', 'INCLUDE_PRODUCT');
    // The catalogue loads when the form opens; wait for real options.
    await page.waitForSelector('select[aria-label="Item"] option:nth-child(2)');
    await page.selectOption('select[aria-label="Item"]', { label: 'Cappuccino' });
    await page.click('button:has-text("Add rule")');
    await page.waitForSelector('text=Only this item: Cappuccino');
    await page.click('button[type="submit"]:has-text("Create draft")');
    // The list names the rule back from the server's own row — the proof the
    // rule survived POST + PUT and came back on GET /promotions.
    await page.waitForSelector(`tr:has-text("${RULES_NAME}"):has-text("Only this item: Cappuccino")`);
    await shot('rule-round-trip');
  });

  await step('archive asks first; confirming is terminal', async () => {
    // Cancel path: the confirm modal appears and "Keep it" changes nothing.
    await page.locator(`tr:has-text("${RULES_NAME}") button:has-text("Archive")`).click();
    await page.waitForSelector('text=Archive this promotion?');
    await page.click('button:has-text("Keep it")');
    await page.waitForSelector('text=Archive this promotion?', { state: 'detached' });
    await page.waitForSelector(`tr:has-text("${RULES_NAME}"):has-text("Draft")`);
    // Confirm path: DRAFT → ARCHIVED, and the row loses its write controls
    // (the server refuses every edit on an ARCHIVED promotion with a 409).
    await page.locator(`tr:has-text("${RULES_NAME}") button:has-text("Archive")`).click();
    await page.waitForSelector('text=Archive this promotion?');
    await page.click('button:has-text("Archive permanently")');
    await page.waitForSelector(`tr:has-text("${RULES_NAME}"):has-text("Archived")`);
    const editButtons = await page.locator(`tr:has-text("${RULES_NAME}") button:has-text("Edit")`).count();
    if (editButtons !== 0) throw new Error('archived row still offers Edit');
    await shot('archived-terminal');
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
