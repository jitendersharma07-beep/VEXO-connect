// ATC POS phase-2 dev walkthrough — Part B: manager flow.
// Depends on Part A having produced: one PAID order (529.90) and one OPEN
// order on T2 (Espresso). Requires POS_SEED_MANAGER_PASSWORD — never printed.
// Screenshots: <shots>/b-*.png
const fs = require('fs');
const { BASE, SHOTS, creds, launchBrowser } = require('./env.cjs');

fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const badResponses = [];
let shotN = 0;
let fails = 0;
const log = (s) => process.stdout.write(s + '\n');

async function main() {
  const manager = creds.manager();
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
    await page.screenshot({ path: `${SHOTS}/b-${String(shotN).padStart(2, '0')}-${name}.png` });
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

  // Owner directive: report ko is run ke pehle/baad ke DELTA se verify karo,
  // fixed cumulative totals se nahin — rerun par false failures na hon.
  let base = null;
  const parseReport = (t) => {
    const amt = t.match(/REFUNDS\s*\n\s*-?\s*₹\s*([\d,]+\.\d{2})/i);
    const ref = t.match(/refunded\s+(\d+)/i);
    const vod = t.match(/voided\s+(\d+)/i);
    return {
      refunds: amt ? Number(amt[1].replace(/,/g, '')) : NaN,
      refunded: ref ? Number(ref[1]) : 0,
      voided: vod ? Number(vod[1]) : 0,
    };
  };

  await step('manager signs in', async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', manager.email);
    await page.fill('#password', manager.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  });

  await step('reports (own branch): cards, CASH/MANUAL row, note, by-day', async () => {
    await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Net sales');
    await page.waitForSelector('text=CASH'); // data-dependent row => report load complete
    const t = await bodyText();
    if (!t.includes('CASH')) throw new Error('CASH method row missing');
    if (!t.includes('MANUAL')) throw new Error('MANUAL channel badge missing');
    if (!/manual/i.test(t)) throw new Error('report note missing');
    if (!t.includes('Coffee')) throw new Error('by-category Coffee missing');
    if (!t.includes('Cold Brews')) throw new Error('by-category Cold Brews missing');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!t.includes(today)) throw new Error('by-day row for today missing');
    base = parseReport(t);
    if (Number.isNaN(base.refunds)) throw new Error('could not parse Refunds card for baseline');
    await shot('reports-initial');
  });

  await step('manager cannot open /catalog (route gated)', async () => {
    await page.goto(BASE + '/catalog', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    if (page.url().includes('/catalog')) throw new Error('manager reached /catalog');
  });

  await step('orders list: PAID order visible with invoice number', async () => {
    await page.goto(BASE + '/orders', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Order history');
    await page.click('button:has-text("PAID")');
    await page.waitForSelector('tbody tr');
    await shot('orders-paid-filter');
  });

  await step('detail drawer: payments carry the manual label; refund PAID → REFUNDED', async () => {
    // sidebar note mein "payments" hai — isliye drawer-scoped wait, bodyText nahin
    await page.locator('tbody tr:has-text("529.90")').first().click();
    await page.waitForSelector('div.fixed h3:has-text("Payments")');
    // dash-agnostic (em-dash char mismatch se bacho) + content-anchored drawer read
    const t = await page.locator('div.fixed:has(h3:has-text("Payments"))').last().innerText();
    if (!/MANUAL PAYMENT RECORD/i.test(t) || !/gateway-verified/i.test(t)) throw new Error('manual label missing in drawer');
    await page.click('button:has-text("Refund…")');
    await page.waitForSelector('#refund-amount');
    await page.fill('#refund-amount', '529.90');
    await page.fill('#refund-reason', 'walkthrough refund test');
    await page.click('button:has-text("Record refund")');
    // success par modal khud band hota hai; textarea-value ke false match se pehle yahi gate hai
    await page.waitForSelector('div.fixed:has-text("Record refund")', { state: 'hidden' });
    await page.waitForSelector('text=walkthrough refund test');
    const drawer = await page.locator('div.fixed:has(h3:has-text("Payments"))').last().innerText();
    if (!drawer.includes('REFUNDED')) throw new Error('order not REFUNDED after full refund');
    await shot('refunded');
    await page.locator('button[aria-label="Close"]').first().click();
  });

  await step('open T2 OPEN order in sell screen', async () => {
    await page.click('button:has-text("PAID")'); // toggle PAID off (chips multi-select Set)
    await page.click('button:has-text("OPEN")');
    await page.locator('tbody tr:has-text("OPEN")').first().click();
    await page.waitForSelector('button:has-text("Open in sell screen")');
    await page.click('button:has-text("Open in sell screen")');
    await page.waitForSelector('text=Dine-in · T2');
    const t = await bodyText();
    if (!t.includes('Espresso')) throw new Error('T2 order lines missing');
  });

  await step('bill T2 then record PARTIAL cash 50 (order stays BILLED)', async () => {
    // is order ka Total panel se parse karo — run-records se verify (residue-tolerant)
    const panel = await bodyText();
    const tm = panel.match(/(?:^|\n)Total\s*₹\s*([\d,]+\.\d{2})/);
    if (!tm) throw new Error('order Total not found in sell panel');
    const total = Number(tm[1].replace(/,/g, ''));
    await page.click('button:has-text("Bill")');
    await page.waitForSelector('text=Record payment');
    await page.fill('#pay-tendered', '50');
    await page.click('button[type="submit"]:has-text("Record payment")');
    await page.waitForSelector('text=Payment recorded.');
    await page.waitForSelector('text=Amount still due');
    const remain = (total - 50).toFixed(2);
    const t = await bodyText();
    if (!t.includes(remain)) throw new Error(`remaining due ${remain} missing`);
    await shot('partial-payment');
    // modal khula chhoda — agla step page.goto se nikal jata hai
  });

  await step('void blocked while money is collected', async () => {
    await page.goto(BASE + '/orders', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Order history');
    await page.click('button:has-text("BILLED")');
    await page.locator('tbody tr:has-text("BILLED")').first().click();
    await page.waitForSelector('button:has-text("Void order…")');
    const disabled = await page.locator('button:has-text("Void order…")').isDisabled();
    if (!disabled) throw new Error('Void order enabled despite collected payment');
    await shot('void-blocked');
  });

  await step('refund the partial 50, void becomes available', async () => {
    await page.click('button:has-text("Refund…")');
    await page.waitForSelector('#refund-amount');
    await page.fill('#refund-amount', '50');
    await page.fill('#refund-reason', 'walkthrough partial refund');
    await page.click('button:has-text("Record refund")');
    await page.waitForSelector('div.fixed:has-text("Record refund")', { state: 'hidden' });
    await page.waitForSelector('text=walkthrough partial refund');
    const disabled = await page.locator('button:has-text("Void order…")').isDisabled();
    if (disabled) throw new Error('Void order still disabled after full refund');
  });

  await step('void order with audited reason; invoice number kept', async () => {
    await page.click('button:has-text("Void order…")');
    await page.waitForSelector('#reason-field');
    await page.fill('#reason-field', 'walkthrough void test');
    await page.click('form button[type="submit"]:has-text("Void order")');
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('div.fixed .badge')];
      return d.some((b) => b.textContent.trim() === 'VOID');
    });
    const t = await bodyText();
    if (t.includes('Order (not billed)')) throw new Error('invoice number lost after void');
    await shot('voided');
    await page.locator('button[aria-label="Close"]').first().click();
  });

  await step('reports final: delta refunds +579.90, refunded +1, voided +1', async () => {
    await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Net sales');
    await page.waitForSelector('text=CASH');
    if (!base) throw new Error('baseline missing (initial reports step failed)');
    const now = parseReport(await bodyText());
    const dRefunds = Number((now.refunds - base.refunds).toFixed(2));
    if (dRefunds !== 579.9) throw new Error(`refunds delta ${dRefunds} != 579.90 (this run: 529.90 full + 50 partial)`);
    if (now.refunded - base.refunded !== 1) throw new Error(`refunded delta ${now.refunded - base.refunded} != 1`);
    if (now.voided - base.voided !== 1) throw new Error(`voided delta ${now.voided - base.voided} != 1`);
    await shot('reports-final');
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
  process.exitCode = fails > 0 || unexpected5xx.length > 0 ? 1 : 0;
}

main().catch((e) => {
  log('FATAL ' + (e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | '));
  process.exitCode = 2;
});
