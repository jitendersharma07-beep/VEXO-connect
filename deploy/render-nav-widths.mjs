#!/usr/bin/env node
// Navigation reachability across widths — the check WORK-ORDER-MOBILE-NAV.md
// asks for, run against the BUILT bundle rather than a dev-server fixture.
//
//   BASE_URL=http://127.0.0.1:5180/pos node deploy/render-nav-widths.mjs
//
// Point BASE_URL at a `vite preview` of frontend/dist, or at the deployed
// origin. It must be the built artefact: a dev server transforms different
// source and can pass while the shipped bundle fails.
//
// No credentials. /api/auth/me is intercepted and answered with a session of
// the role under test, so this measures the REAL Layout.jsx role gating with
// no account, no password and no writes. Every other /api call is answered
// with an empty payload — the subject here is the nav, not the data.
//
// The two numbers per row, and why they are the two:
//
//   overflow = scrollWidth - clientWidth. Must stay 0. The no-overflow
//   property held at every width BEFORE the drawer existed; a fix that
//   introduces a horizontal scrollbar has traded one layout defect for
//   another.
//
//   links = count of VISIBLE a[href^="/pos/"]. Must be > 0 below md, and
//   must be SMALLER FOR THE CASHIER THAN FOR THE OWNER at the same width.
//   That comparison is the only assertion here that fails if the drawer is
//   wired to a hardcoded link list instead of the role-gated one, and that
//   failure mode is a permissions leak, not a layout bug.

import { mkdirSync } from 'node:fs';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5180/pos').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-nav-screens';
const CHROME = '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';

const results = [];
const record = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const SESSIONS = {
  cashier: {
    user: { id: 'u-cashier', fullName: 'Probe Cashier', email: 'probe.cashier@example.invalid', role: 'CASHIER', mustChangePassword: false },
    company: { id: 'c-1', name: 'Brew Street Café (Demo)', isDemo: true },
    branch: { id: 'b-1', name: 'Cyber Hub', code: 'BSC-CH' },
    license: { status: 'ACTIVE', plan: 'PILOT', expiresAt: '2027-12-31T00:00:00.000Z' },
    onlinePayment: { enabled: false, provider: null },
  },
  owner: {
    user: { id: 'u-owner', fullName: 'Probe Owner', email: 'probe.owner@example.invalid', role: 'CUSTOMER_OWNER', mustChangePassword: false },
    company: { id: 'c-1', name: 'Brew Street Café (Demo)', isDemo: true },
    branch: null,
    license: { status: 'ACTIVE', plan: 'PILOT', expiresAt: '2027-12-31T00:00:00.000Z' },
    onlinePayment: { enabled: false, provider: null },
  },
};

// Answers for the data calls a page makes on mount. Shapes only need to be
// non-crashing; nothing here is asserted on.
const EMPTY = {
  '/api/catalog/products': { products: [] },
  '/api/catalog/categories': { categories: [] },
  '/api/branches': { branches: [] },
  '/api/tables': { tables: [] },
  '/api/orders': { orders: [], total: 0 },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

// width, height, role, whether to open the drawer first
const ROWS = [
  { w: 430, h: 932, role: 'cashier', open: false },
  { w: 430, h: 932, role: 'cashier', open: true },
  { w: 430, h: 932, role: 'owner', open: true },
  { w: 767, h: 1024, role: 'cashier', open: true },
  { w: 768, h: 1024, role: 'cashier', open: false },
  { w: 768, h: 1024, role: 'owner', open: false },
];

const measured = [];

try {
  for (const row of ROWS) {
    const tag = `${row.w}x${row.h}-${row.role}${row.open ? '-drawer' : ''}`;
    const ctx = await browser.newContext({ viewport: { width: row.w, height: row.h } });
    const consoleErrors = [];

    await ctx.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/pos/, '');
      if (path === '/api/auth/me') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSIONS[row.role]) });
      }
      // Writes are refused rather than faked — this probe must not be able to
      // change anything even if a page tries.
      if (route.request().method() !== 'GET') {
        return route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PROBE_READ_ONLY' } }) });
      }
      const body = EMPTY[path] ?? {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    // Did we actually land on Sell, or did a role gate redirect us? A gate
    // redirects rather than erroring, so without this a redirected page would
    // be measured and scored as if it were the page we asked for.
    const landed = new URL(page.url()).pathname;
    const onSell = landed.endsWith('/sell');

    let opened = null;
    if (row.open) {
      const btn = page.locator('button[aria-label="Open navigation"]');
      opened = await btn.isVisible().catch(() => false);
      if (opened) {
        await btn.click();
        await page.waitForTimeout(250);
      }
    }

    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const links = [...document.querySelectorAll('a[href^="/pos/"]')].filter((a) => {
        const r = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      return {
        overflow: de.scrollWidth - de.clientWidth,
        links: links.length,
        labels: links.map((a) => a.textContent.trim()).filter(Boolean),
        // VISIBLE, not merely present. The control carries md:hidden, so at
        // 768px it is still in the DOM with display:none. A querySelector
        // truthiness check cannot tell "hidden by breakpoint" from "on
        // screen", and would report the sidebar and the drawer control
        // coexisting at 768px when only one of them is shown.
        menuButton: (() => {
          const b = document.querySelector('button[aria-label="Open navigation"]');
          if (!b) return false;
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        })(),
        sidebarVisible: (() => {
          const a = document.querySelector('aside');
          if (!a) return false;
          const r = a.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })(),
        errorBoundary: document.body.textContent.includes('Something went wrong'),
      };
    });

    await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: false });
    measured.push({ ...row, tag, ...m, onSell, opened, consoleErrors: consoleErrors.length });

    record(`${tag}  landed on /sell`, onSell, `url ${landed}`);
    record(`${tag}  no horizontal overflow`, m.overflow === 0, `scrollWidth-clientWidth ${m.overflow}`);
    record(`${tag}  no error boundary, no console errors`,
      !m.errorBoundary && consoleErrors.length === 0,
      `boundary ${m.errorBoundary}, console errors ${consoleErrors.length}`);
    if (row.open) {
      record(`${tag}  menu control present and opens`, opened === true, `button visible ${opened}`);
    }
    // "Reachable" is not "links are on screen". Below md with the drawer shut
    // the correct answer is zero links and a visible control — that is what a
    // drawer IS. Asserting links > 0 unconditionally would mark the working
    // design as broken, which is the mirror of the defect being fixed here:
    // the pre-fix screen ALSO showed zero links, and had nothing to press.
    const reachable = row.open || row.w >= 768 ? m.links > 0 : m.menuButton;
    record(`${tag}  navigation reachable`, reachable,
      row.open || row.w >= 768
        ? `${m.links} visible links: ${m.labels.join(', ')}`
        : `${m.links} links on screen, menu control visible ${m.menuButton}`);

    await ctx.close();
  }

  // The comparison that matters. Same width, same drawer state, two roles.
  const pair = (w, open) => {
    const c = measured.find((x) => x.w === w && x.role === 'cashier' && x.open === open);
    const o = measured.find((x) => x.w === w && x.role === 'owner' && x.open === open);
    if (!c || !o) return;
    record(`${w}px  cashier sees FEWER links than owner`, c.links < o.links,
      `cashier ${c.links} (${c.labels.join(', ')}) vs owner ${o.links}`);
    const leaked = c.labels.filter((l) => /catalog|team|licence|license|report|closing|reconcil/i.test(l));
    record(`${w}px  cashier sees no owner-only link`, leaked.length === 0,
      leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'none');
  };
  pair(430, true);
  pair(768, false);

  // The regression guard: at 768px the sidebar must still BE a sidebar.
  const at768 = measured.find((x) => x.w === 768 && x.role === 'cashier');
  record('768px  sidebar still renders as a sidebar',
    at768?.sidebarVisible === true && at768?.menuButton === false,
    `sidebar ${at768?.sidebarVisible}, menu button ${at768?.menuButton}`);
  const at767 = measured.find((x) => x.w === 767);
  record('767px  sidebar hidden, menu control takes over',
    at767?.sidebarVisible === false && at767?.menuButton === true,
    `sidebar ${at767?.sidebarVisible}, menu button ${at767?.menuButton}`);
} finally {
  await browser.close();
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
