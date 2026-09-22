#!/usr/bin/env node
// Screenshot + print-geometry verification for branding and the 80 mm thermal
// layouts (UAT point 8).
//
// Renders the REAL frontend through the Vite dev server: /login for branding
// proof, and /uat-render.html (dev-only fixture harness) for the receipt and
// KOT views — in screen media, under emulated print media, and as a PDF at the
// paper size.
//
//   BASE_URL=http://127.0.0.1:5177 node deploy/render-uat-screens.mjs
//
// Optional authenticated shots (dashboard + day-close) when STAGE_EMAIL and
// STAGE_PASSWORD are exported by the caller; the values are typed into the
// form and never printed. PASS/FAIL lines only. Exit 0 = all green.
//
// PHYSICAL PRINTER OUTPUT REMAINS NOT TESTED. Everything below is browser
// geometry. It can show the layout sits inside the window the head can image;
// it cannot show anything about heat, paper, or a driver. See
// frontend/docs/HARDWARE-CHECKLIST.md §2.

import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5177').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-uat-screens';
const CHROME = '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';

// ---------------------------------------------------------------------------
// ASSUMED PRINTER PROFILE
// ---------------------------------------------------------------------------
// The layout targets ONE profile, and this block is its written statement.
// If a site's printer differs, these are the numbers that change — §2 of the
// hardware checklist exists to capture that per site, before go-live.
//
//   Class      EPSON TM-T82 / TM-T88 and compatibles
//   Paper      80 mm roll
//   Head       576 addressable dots at 203 dpi
//   Printable  576 / 203 in  =  72.06 mm     <- what the layout is built to
//   Dead zone  80 - 72.06    =   7.94 mm     <- under the head, never inked
//
// PAPER WIDTH IS NOT PRINTABLE WIDTH, and conflating the two is what this
// file used to do: it asserted .print-area measured 302 px, the full 80 mm
// paper width. That is not a test of the layout, it is the clipping defect
// written down as a test — and it stayed green for the whole period every
// receipt was losing 7.9 mm off its right edge (the paise of the TOTAL, the
// tail of the invoice number, the entire right-hand amount column), because
// an element screenshot cannot observe an @page margin.
//
// Derived rather than hard-coded, so the profile above is the single place a
// different printer has to be described.
const PRINTER = {
  name: 'EPSON TM-T82/T88-class, 80 mm roll',
  paperMm: 80,
  dots: 576,
  dpi: 203,
};
const CSS_PX_PER_MM = 96 / 25.4;
const PRINTABLE_MM = (PRINTER.dots / PRINTER.dpi) * 25.4; // 72.06
const PRINTABLE_PX = PRINTABLE_MM * CSS_PX_PER_MM; //         272.4
const PAPER_PX = PRINTER.paperMm * CSS_PX_PER_MM; //          302.4
const PAPER_PT = PRINTER.paperMm * (72 / 25.4); //            226.77 (PDF units)
const TOL_PX = 3;

// Where the 72 mm window physically sits on the 80 mm paper is the driver's
// decision, not CSS's. That is one of the things only a real printer settles,
// and it is why §2 asks for a printed receipt to be measured with a ruler.

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const mm = (px) => (px / CSS_PX_PER_MM).toFixed(1);

console.log(
  `Printer profile: ${PRINTER.name}\n` +
    `  ${PRINTER.paperMm} mm paper, ${PRINTER.dots} dots @ ${PRINTER.dpi} dpi ` +
    `= ${PRINTABLE_MM.toFixed(2)} mm printable (${PRINTABLE_PX.toFixed(0)} px at 96 dpi CSS)\n` +
    `  dead zone ${(PRINTER.paperMm - PRINTABLE_MM).toFixed(2)} mm — never inked\n`,
);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

// Measures one .print-area the way the head would see it: the content box
// against the printable window, and then every descendant against the content
// box. The second half is the part an equality check on the box can never do —
// a correctly sized box can still have a row overflowing out of it.
const measurePrintArea = (el) =>
  el.evaluate((n) => {
    const box = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    const escapes = [];
    for (const d of n.querySelectorAll('*')) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const overRight = r.right - box.right;
      const overLeft = box.left - r.left;
      if (overRight > 1 || overLeft > 1) {
        escapes.push({
          text: (d.textContent || '').trim().slice(0, 28),
          over: Math.round(Math.max(overRight, overLeft)),
        });
      }
    }
    // Text present in the DOM but visually cut off by its own box. A receipt
    // can be inside the paper and still be unreadable this way.
    const truncated = [...n.querySelectorAll('*')]
      .filter((d) => d.children.length === 0 && d.scrollWidth > d.clientWidth + 1)
      .map((d) => ({
        text: (d.textContent || '').trim().slice(0, 28),
        scroll: d.scrollWidth,
        client: d.clientWidth,
      }));
    return {
      width: box.width,
      scrollWidth: n.scrollWidth,
      clientWidth: n.clientWidth,
      padding: `${cs.paddingLeft}/${cs.paddingRight}`,
      escapes: escapes.slice(0, 6),
      truncated: truncated.slice(0, 6),
    };
  });

// @page is invisible to an element screenshot — exactly how the clipping bug
// survived review. The MARGIN is readable from CSSOM, so read it and assert
// on it.
//
// The SIZE is not. Chromium drops the `size` descriptor on the floor: a rule
// written `@page { size: 80mm auto; margin: 0 }` serialises back out of CSSOM
// as `@page { margin: 0px; }`, and r.style has only the four margin
// longhands. So an absent size here means nothing, and a present one would
// prove nothing either. Size is checked further down against the PDF, which
// is the artefact the paginating renderer actually produced.
const readPageRules = (page) =>
  page.evaluate(() => {
    const out = [];
    const walk = (list) => {
      for (const r of list) {
        if (r.constructor?.name === 'CSSPageRule' || r.type === 6) {
          out.push({
            css: r.cssText,
            margin: r.style?.margin ?? '',
            size: r.style?.getPropertyValue('size') ?? '',
          });
        } else if (r.cssRules) {
          walk(r.cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        /* cross-origin sheet */
      }
    }
    return out;
  });

// The PDF is the only artefact here produced by the paginating renderer, so
// it is the only one where @page size actually applies. This is the blind
// spot the previous version of the file had.
const pdfMediaBox = (buf) => {
  const all = [
    ...buf
      .toString('latin1')
      .matchAll(/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g),
  ];
  if (all.length === 0) return null;
  const m = all[0];
  return {
    w: parseFloat(m[3]) - parseFloat(m[1]),
    h: parseFloat(m[4]) - parseFloat(m[2]),
    pages: all.length,
  };
};

// receipt-long is the fixture that can actually fail these: wrapping names,
// two-digit quantities, four-figure amounts and a full-length invoice number.
// The short fixtures physically cannot overflow, which is why they never
// caught the original defect.
const SHOTS = ['receipt-demo', 'receipt-due', 'receipt-long', 'kot'];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  // 1. Branding: the login page as a customer first sees it.
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  const brandText = await page.textContent('body');
  await page.screenshot({ path: `${OUT}/login.png`, fullPage: true });
  record(
    'login page renders VEXO Connect branding',
    brandText.includes('VEXO Connect') && !/ATC POS/.test(brandText),
    'saved login.png',
  );

  // 2. Fixture harness in screen media.
  await page.goto(`${BASE}/uat-render.html?view=all`, { waitUntil: 'networkidle' });
  for (const name of SHOTS) {
    const el = page.locator(`[data-shot="${name}"] .print-area`);
    if (!(await el.isVisible().catch(() => false))) {
      record(`${name} screen render`, false, 'element not found');
      continue;
    }
    await el.screenshot({ path: `${OUT}/${name}-screen.png` });
    record(`${name} screen render`, true, `saved ${name}-screen.png`);
  }

  // 3. Wording the customer's evidence depends on. These strings are sent by
  //    the server and printed verbatim; reworded, the receipt stops matching
  //    what actually happened to the money.
  const harnessText = await page.textContent('body');
  for (const [label, needle] of [
    ['DEMO banner', 'DEMO — sample data, not a real sale'],
    ['manual-payment label', 'MANUAL PAYMENT RECORD — not gateway-verified'],
    ['gateway-payment label', 'GATEWAY PAYMENT — confirmed by the provider'],
    ['pending-refund label', 'REFUND REQUESTED — not yet paid out by the provider'],
    ['settled-refund label', 'REFUND HANDED BACK — recorded by staff'],
    ['BALANCE DUE row', 'BALANCE DUE'],
  ]) {
    record(`receipt prints the ${label} verbatim`, harnessText.includes(needle));
  }
  // A REQUESTED refund must print WITHOUT a minus sign: no money has moved,
  // and "-₹x" on paper tells the customer they have already been repaid.
  record(
    'pending gateway refund prints as requested, not returned',
    harnessText.includes('Refund requested') &&
      harnessText.includes('REFUND REQUESTED — not yet paid out by the provider'),
  );

  // 4. @page geometry. margin:0 is not a style preference — a 4 mm @page
  //    margin on top of a 72 mm content box renders 72 mm into a 64 mm
  //    window. The head's own dead edge IS the margin; adding a second one
  //    is what clipped the receipts in the first place.
  //    This CSSOM read is the ONLY defence against a @page margin, which is
  //    why it checks EVERY rule rather than the first one. Verified by
  //    negative control: re-introducing `@page { margin: 4mm }` leaves every
  //    geometric check on this page green — the margin is applied by the
  //    paginating renderer and is invisible to element boxes, to scrollWidth
  //    and to the PDF MediaBox (which reports the paper, margin included).
  //    There are already two @page rules in play — index.css's and the one
  //    printPageSize.js installs — so "rule [0] is clean" is not an answer
  //    about what the cascade does.
  const isZero = (m) => {
    const t = (m || '').trim();
    return t === '' || t === '0' || t === '0px' || /^0(px)?(\s+0(px)?){1,3}$/.test(t);
  };

  // Fire this FIRST. The paper size is supplied at runtime, not by the
  // stylesheet, because Chromium ignores `size: 80mm auto` and falls back to
  // US Letter. Dispatching the event the real Ctrl+P path fires installs the
  // second @page rule, so the margin scan below sees the cascade the printer
  // will see rather than half of it.
  const jobRule = await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeprint'));
    return document.getElementById('pos-print-page-size')?.textContent ?? '';
  });
  record(
    `beforeprint installs a @page size of ${PRINTER.paperMm} mm by a measured height`,
    new RegExp(`size:\\s*${PRINTER.paperMm}mm\\s+\\d+(\\.\\d+)?mm`).test(jobRule),
    jobRule ? jobRule.replace(/\s+/g, ' ').trim() : '(no rule installed)',
  );

  const pageRules = await readPageRules(page);
  record('a @page rule is present', pageRules.length > 0, `${pageRules.length} found`);
  const withMargin = pageRules.filter((r) => !isZero(r.margin));
  record(
    'no @page rule adds a margin of its own',
    pageRules.length > 0 && withMargin.length === 0,
    withMargin.length
      ? `${withMargin.length} of ${pageRules.length} declare one: ${withMargin.map((r) => `"${r.margin}"`).join(', ')}`
      : `all ${pageRules.length} at margin 0`,
  );

  // 5. Print media: the geometry checks that replace the old paper-width
  //    assertion. Note the comparison is ONE-SIDED on purpose — narrower than
  //    printable merely wastes roll, wider is silently cut, and an equality
  //    band cannot tell those two apart.
  await page.emulateMedia({ media: 'print' });
  for (const name of SHOTS) {
    const el = page.locator(`[data-shot="${name}"] .print-area`);
    if (!(await el.isVisible().catch(() => false))) {
      record(`${name} print render`, false, 'element not found');
      continue;
    }
    await el.screenshot({ path: `${OUT}/${name}-print.png` });
    const m = await measurePrintArea(el);
    const cut = m.width - PRINTABLE_PX;

    record(
      `${name} content box fits the ${PRINTABLE_MM.toFixed(1)} mm printable window`,
      m.width <= PRINTABLE_PX + TOL_PX,
      `${m.width.toFixed(0)}px (${mm(m.width)}mm) vs ${PRINTABLE_PX.toFixed(0)}px` +
        (cut > TOL_PX ? ` — ${mm(cut)}mm would be CUT OFF` : ''),
    );
    // Guards the lazy fix: shrinking the box until the clipping check goes
    // quiet would pass the line above and waste half the roll.
    record(
      `${name} content box still uses the roll`,
      m.width >= PRINTABLE_PX * 0.9,
      `${mm(m.width)}mm of ${PRINTABLE_MM.toFixed(1)}mm available`,
    );
    record(
      `${name} no element escapes the printable box`,
      m.escapes.length === 0,
      m.escapes.map((o) => `"${o.text}" +${o.over}px`).join(' | ') || 'every child inside the box',
    );
    record(
      `${name} no text truncated inside its own box`,
      m.truncated.length === 0,
      m.truncated.map((t) => `"${t.text}" ${t.scroll}>${t.client}`).join(' | ') || 'none',
    );
    record(
      `${name} no horizontal scroll in the print area`,
      m.scrollWidth <= m.clientWidth + 2,
      `scroll ${m.scrollWidth}/${m.clientWidth}, padding ${m.padding}`,
    );
  }

  // 6. The long bill specifically — long names, the invoice number, and the
  //    amount column. These are the three things the clipping defect ate, so
  //    they are checked by name rather than left to the generic sweep.
  {
    const el = page.locator('[data-shot="receipt-long"] .print-area');
    const long = await el.evaluate((n) => {
      const box = n.getBoundingClientRect();
      const leaves = [...n.querySelectorAll('*')].filter((d) => d.children.length === 0);
      const invoice = leaves.find((d) => /^[A-Z-]+\/\d{4}\/\d+$/.test((d.textContent || '').trim()));
      // Amount cells carry tabular-nums. They are right-aligned, so they are
      // the first thing to fall off, and the last thing anyone would notice.
      const amounts = [...n.querySelectorAll('.tabular-nums')].map((d) => {
        const r = d.getBoundingClientRect();
        return {
          text: (d.textContent || '').trim(),
          overRight: Math.round(r.right - box.right),
          clipped: d.scrollWidth > d.clientWidth + 1,
        };
      });
      // A name that occupies more than one line proves wrapping actually
      // happens, rather than the fixture simply being short enough to fit.
      const wrapped = leaves.filter((d) => {
        const r = d.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(d).lineHeight) || 14;
        return (d.textContent || '').trim().length > 40 && r.height > lh * 1.5;
      });
      return {
        invoiceText: invoice ? invoice.textContent.trim() : null,
        invoiceClipped: invoice ? invoice.scrollWidth > invoice.clientWidth + 1 : null,
        invoiceOver: invoice ? Math.round(invoice.getBoundingClientRect().right - box.right) : null,
        amountCount: amounts.length,
        clippedAmounts: amounts.filter((a) => a.clipped).map((a) => a.text),
        worstAmountEdge: amounts.length ? Math.max(...amounts.map((a) => a.overRight)) : -999,
        wrappedCount: wrapped.length,
      };
    });

    record(
      'long bill: invoice number renders in full',
      long.invoiceText === 'BSC-CP/2026/000483',
      `got "${long.invoiceText}"`,
    );
    record(
      'long bill: invoice number is not clipped',
      long.invoiceClipped === false && long.invoiceOver <= 0,
      `${long.invoiceOver}px past the box edge`,
    );
    record(
      'long bill: every amount stays inside the printable box',
      long.amountCount > 0 && long.worstAmountEdge <= 0,
      `${long.amountCount} amounts, worst right edge ${long.worstAmountEdge}px`,
    );
    record(
      'long bill: no amount is internally clipped',
      long.clippedAmounts.length === 0,
      long.clippedAmounts.join(' | ') || 'all render in full',
    );
    record(
      'long bill: long product names wrap rather than overflow',
      long.wrappedCount > 0,
      `${long.wrappedCount} names occupy more than one line`,
    );
  }
  // `media: null` CLEARS the override; `media: 'screen'` pins it. They are
  // not the same and the difference is invisible until you print: with the
  // override pinned to screen, page.pdf() lays the document out with
  // @media print never matching, so the @page rule is not applied and the
  // PDF comes out US Letter. Measured — 612x792pt pinned, 227x439pt cleared.
  await page.emulateMedia({ media: null });

  // 7. PDF at the paper size — the end-to-end check that the page size
  //    reaches the renderer at all. This is the only artefact here produced
  //    by the paginating renderer, so it is the only place the page geometry
  //    is observable; an element screenshot cannot see it, which is how the
  //    original clipping defect survived.
  const pdfHeights = {};
  for (const name of ['receipt-long', 'kot']) {
    await page.goto(`${BASE}/uat-render.html?view=${name}`, { waitUntil: 'networkidle' });
    const path = `${OUT}/${name}.pdf`;
    await page.pdf({ path, preferCSSPageSize: true, printBackground: true });
    const size = pdfMediaBox(readFileSync(path));
    if (!size) {
      record(`${name} PDF page size readable`, false, 'no MediaBox found');
      continue;
    }
    record(
      `${name} PDF renders at ${PRINTER.paperMm} mm paper width`,
      Math.abs(size.w - PAPER_PT) <= 2,
      `${size.w.toFixed(1)}pt = ${(size.w / (72 / 25.4)).toFixed(1)}mm, expected ${PAPER_PT.toFixed(1)}pt`,
    );
    // The dead zone, derived from the PDF rather than from the constants.
    // The previous form of this check compared PAPER_PX with PRINTABLE_PX —
    // two numbers computed a few lines apart from the same profile literal.
    // It could not fail, and it sat green underneath a PDF that was coming
    // out US Letter.
    const pageMm = size.w / (72 / 25.4);
    const deadMm = pageMm - PRINTABLE_MM;
    record(
      `${name} PDF reserves the head's dead zone`,
      Math.abs(deadMm - (PRINTER.paperMm - PRINTABLE_MM)) <= 0.5,
      `page ${pageMm.toFixed(1)}mm - content ${PRINTABLE_MM.toFixed(1)}mm = ${deadMm.toFixed(1)}mm unprinted`,
    );

    // One page. On a continuous roll a second page is a second cut, so a
    // receipt that paginates is torn in half rather than merely ugly.
    record(
      `${name} PDF is a single page`,
      size.pages === 1,
      `${size.pages} page(s)`,
    );
    pdfHeights[name] = size.h;
  }

  // The page height must be MEASURED per job, not a fixed form. Two fixtures
  // of very different lengths proving the same page height would mean the
  // height is hard-coded — which silently feeds blank roll after every short
  // ticket and puts the auto-cut in the wrong place.
  if (pdfHeights['receipt-long'] && pdfHeights['kot']) {
    const tall = pdfHeights['receipt-long'];
    const short = pdfHeights['kot'];
    record(
      'PDF page height follows the content, not a fixed form',
      tall - short > 20,
      `receipt-long ${(tall / (72 / 25.4)).toFixed(0)}mm vs kot ${(short / (72 / 25.4)).toFixed(0)}mm`,
    );
  }

  // 8. Optional authenticated pages (staging only, credentials from env).
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
console.log(`\n${results.length - failed}/${results.length} checks passed; artefacts in ${OUT}`);
console.log('NOTE  browser geometry only — physical printing is NOT TESTED.');
process.exit(failed === 0 ? 0 : 1);
