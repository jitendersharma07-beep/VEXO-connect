// Measures whether the promotions editor's close/submit controls are actually
// reachable, at several mainstream viewport heights.
//
// Why this exists: walk-promotions.cjs step 4 ends with closeModal(), whose
// selector (`div.fixed div.mb-4 button`) is correct markup-wise — ui.jsx's
// Modal really does render that — yet the click never lands and every later
// step times out behind a stuck-open overlay. The question this answers is
// whether that is a stale test selector or a genuine defect, and the only
// honest way to answer it is geometry, not a screenshot read by eye.
//
// Prints, per viewport: the card's top/bottom against the viewport, and
// whether the X (close) and the submit button are inside it. Anything with
// top < 0 or bottom > height is content the user cannot reach, because the
// overlay is `fixed inset-0` with no scroll of its own.

const path = require('path');
const E2E = '/home/atc-noc/vexo-connect-x-lanes/operator-ui/tests/e2e';
const { BASE, creds, launchBrowser } = require(path.join(E2E, 'env.cjs'));

const SIZES = [
  { width: 1440, height: 900, note: 'the walk\'s own viewport / 14-16" laptop' },
  { width: 1366, height: 768, note: 'the commonest Windows laptop' },
  { width: 1920, height: 1080, note: 'desktop 1080p' },
];

const main = async () => {
  const owner = creds.owner();
  const browser = await launchBrowser((m) => console.log(m));

  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await ctx.newPage();

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', owner.email);
    await page.fill('#password', owner.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    await page.click('nav >> text=Promotions');
    await page.waitForSelector('text=Live now');
    await page.click('button:has-text("New promotion")');
    await page.waitForSelector('#promo-name');

    const measure = async (label) => {
      const m = await page.evaluate(() => {
        const overlay = document.querySelector('div.fixed.inset-0');
        const card = overlay && overlay.querySelector('div.card');
        const closeBtn = card && card.querySelector('div.mb-4 button');
        const submit = card && card.querySelector('button[type="submit"]');
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
        };
        return {
          vh: window.innerHeight,
          overlayScrolls: overlay
            ? { scrollH: overlay.scrollHeight, clientH: overlay.clientHeight, overflowY: getComputedStyle(overlay).overflowY }
            : null,
          card: box(card),
          close: box(closeBtn),
          submit: box(submit),
          submitText: submit ? submit.textContent.trim() : null,
        };
      });
      // Reachability, not raw geometry. Once the overlay is a scroll
      // container, "outside the viewport right now" stops meaning
      // "unreachable" — the honest test is whether the browser can bring the
      // control into view at all. Ask it to, then look again.
      const reach = async (sel, label) => {
        const el = page.locator(sel).first();
        if (!(await el.count())) return `${label}: ABSENT`;
        const before = await el.boundingBox();
        await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        const after = await el.boundingBox();
        const vh = m.vh;
        if (!after) return `${label}: ABSENT after scroll`;
        const inView = after.y >= 0 && after.y + after.height <= vh;
        const moved = before ? Math.round(Math.abs(after.y - before.y)) : 0;
        if (!inView) {
          const over = after.y < 0 ? `${Math.round(-after.y)}px above the top` : `${Math.round(after.y + after.height - vh)}px below the bottom`;
          return `${label}: UNREACHABLE — still ${over} after scrollIntoView`;
        }
        return `${label}: reachable${moved ? ` (needed ${moved}px of scroll)` : ' without scrolling'}`;
      };
      console.log(`  ${label}`);
      console.log(`    card       height=${m.card.h}  (viewport height ${m.vh})`);
      console.log(`    overlay    scrollHeight=${m.overlayScrolls.scrollH} clientHeight=${m.overlayScrolls.clientH} overflow-y=${m.overlayScrolls.overflowY}`);
      console.log(`    ${await reach('div.fixed.inset-0 div.mb-4 button', 'close X   ')}`);
      console.log(`    ${await reach('div.fixed.inset-0 button[type="submit"]', 'submit    ')}  [${m.submitText}]`);
      return m;
    };

    console.log(`\n${size.width}x${size.height}  — ${size.note}`);
    await measure('as opened:');

    // Now grow it the way step 4 does: a server refusal adds an error note.
    await page.fill('#promo-name', 'Probe ' + Date.now());
    await page.fill('#promo-value', '150');
    await page.click('button[type="submit"]:has-text("Create draft")').catch(() => {});
    await page.waitForSelector('text=/less than or equal to 100/i', { timeout: 8000 }).catch(() => {});
    await measure('after the server refusal (the state the walk closes from):');

    // And the actual thing the walk tries to do.
    const clicked = await page.locator('div.fixed div.mb-4 button').click({ timeout: 4000 })
      .then(() => 'clicked').catch((e) => 'FAILED: ' + String(e.message || e).split('\n')[0]);
    console.log(`    closeModal() click -> ${clicked}`);
    const stillOpen = await page.locator('#promo-name').count();
    console.log(`    editor still open after closeModal()? ${stillOpen > 0 ? 'YES — the walk is now stuck' : 'no'}`);

    await ctx.close();
  }

  await browser.close();
};

main().catch((e) => {
  console.error('probe error: ' + (e.message || e));
  process.exit(2);
});
