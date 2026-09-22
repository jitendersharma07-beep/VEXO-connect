#!/usr/bin/env node
// Screenshot verification for branding + 80 mm print layouts (UAT point 8).
// Renders the REAL frontend through the Vite dev server: the /login page for
// branding proof, and /uat-render.html (dev-only fixture harness) for the
// receipt/KOT thermal views — in screen media AND with print media emulated,
// plus an overflow probe against the 272 px (72 mm) PRINTABLE width.
//
//   BASE_URL=http://127.0.0.1:5177 node deploy/render-uat-screens.mjs
//
// Optional authenticated shots (dashboard + day-close) when STAGE_EMAIL and
// STAGE_PASSWORD are exported by the caller; the values are typed into the
// form and never printed. PASS/FAIL lines only. Exit 0 = all green.
// Physical printer output remains PENDING — this verifies browser layout only.

import { mkdirSync } from 'node:fs';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5177').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-uat-screens';
const CHROME = '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';
// 72 mm at CSS 96 dpi — the IMAGEABLE width of an 80 mm roll, not the paper
// width. This constant used to read 302 (80 mm) and line 80 used to assert the
// content box equalled it. That assertion was the defect written down as a
// test: content at the full paper width inside a 72 mm printable window put
// every right-aligned figure — amounts, invoice number, TOTAL — off the edge,
// and the check stayed green through all of it because an element screenshot
// cannot observe an @page margin.
//
// So the comparison below is one-sided on purpose. Narrower than the printable
// width wastes paper; wider is silently cut. Only one of those is a defect, and
// an equality band cannot tell them apart.
const PRINTABLE_PX = 272;

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  // 1. Branding: the login page as a customer first sees it.
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  const brandText = await page.textContent('body');
  await page.screenshot({ path: `${OUT}/login.png`, fullPage: true });
  record('login page renders VEXO Connect branding',
    brandText.includes('VEXO Connect') && !/ATC POS/.test(brandText),
    `saved login.png`);

  // 2. Fixture harness: receipt (demo + due variants) and KOT.
  const shots = ['receipt-demo', 'receipt-due', 'kot'];
  await page.goto(`${BASE}/uat-render.html?view=all`, { waitUntil: 'networkidle' });
  for (const name of shots) {
    const el = page.locator(`[data-shot="${name}"] .print-area`);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) { record(`${name} screen render`, false, 'element not found'); continue; }
    await el.screenshot({ path: `${OUT}/${name}-screen.png` });
    record(`${name} screen render`, true, `saved ${name}-screen.png`);
  }

  // Label truthfulness on paper: manual vs gateway wording must be present
  // exactly as the server sends it (mandate: manual entries clearly marked).
  const harnessText = await page.textContent('body');
  record('receipt prints manual-payment label verbatim',
    harnessText.includes('MANUAL PAYMENT RECORD — not gateway-verified'));
  record('pending gateway refund prints as requested, not returned',
    harnessText.includes('Refund requested') &&
    harnessText.includes('REFUND REQUESTED — not yet paid out by the provider'));
  record('demo receipt carries the DEMO banner',
    harnessText.includes('DEMO — sample data, not a real sale'));

  // 3. Print-media emulation: same views under @media print rules.
  await page.emulateMedia({ media: 'print' });
  for (const name of shots) {
    const el = page.locator(`[data-shot="${name}"] .print-area`);
    if (!(await el.isVisible().catch(() => false))) { record(`${name} print render`, false, 'element not found'); continue; }
    await el.screenshot({ path: `${OUT}/${name}-print.png` });
    const m = await el.evaluate((n) => ({
      scrollWidth: n.scrollWidth,
      clientWidth: n.clientWidth,
      rect: Math.round(n.getBoundingClientRect().width),
    }));
    const noOverflow = m.scrollWidth <= m.clientWidth + 2;
    // The element is absolutely positioned at left:0 under print rules, so its
    // width IS its right edge. Anything past PRINTABLE_PX is off the paper.
    const withinPrintable = m.rect <= PRINTABLE_PX + 3;
    const cutMm = ((m.rect - PRINTABLE_PX) / 96 * 25.4).toFixed(1);
    record(`${name} fits the 72 mm printable width without overflow`,
      noOverflow && withinPrintable,
      `width ${m.rect}px vs printable ${PRINTABLE_PX}px` +
      `${withinPrintable ? '' : `, ${cutMm} mm would be cut off`}` +
      `, scroll ${m.scrollWidth}/${m.clientWidth}`);
  }
  await page.emulateMedia({ media: 'screen' });

  // 4. Optional authenticated pages (staging only, credentials from env).
  if (process.env.STAGE_EMAIL && process.env.STAGE_PASSWORD) {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', process.env.STAGE_EMAIL);
    await page.fill('input[type="password"]', process.env.STAGE_PASSWORD);
    await Promise.all([
      page.waitForURL((u) => !String(u).includes('/login'), { timeout: 15000 }).catch(() => null),
      page.click('button[type="submit"]'),
    ]);
    const signedIn = !page.url().includes('/login');
    record('staging sign-in for authenticated shots', signedIn, signedIn ? '' : 'still on /login');
    if (signedIn) {
      await page.screenshot({ path: `${OUT}/dashboard.png`, fullPage: true });
      await page.goto(`${BASE}/day-close`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: `${OUT}/day-close.png`, fullPage: true });
      record('dashboard + day-close screenshots', true, 'saved dashboard.png, day-close.png');
    }
  } else {
    console.log('SKIP  authenticated page shots (STAGE_EMAIL/STAGE_PASSWORD not set)');
  }
} catch (err) {
  record('render run', false, err?.message || String(err));
} finally {
  await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed; PNGs in ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
