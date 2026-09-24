// Render the REAL Sell screen and photograph the item grid.
//
// Why this exists: the menu-photo feature is a layout change to the densest
// screen in the product, and neither the backend suite nor `vite build` can see
// a layout. The grid had to keep working in three states that look nothing
// alike, so all three are shot here and compared:
//
//   nophotos  — no product carries an image. MUST be pixel-identical to the
//               grid that shipped before this feature: same tile height, same
//               three-line name clamp, no reserved strip. This is the state
//               every existing shop is in, and the one a regression would hurt.
//   photos    — every product has one.
//   mixed     — some do, some do not. The interesting case: grid rows stretch
//               to their tallest cell, so a half-photographed catalogue is
//               where a naive per-tile layout tears.
//
// It then re-renders at the viewports real POS hardware actually has, and
// counts how many tiles land above the fold. That second pass exists because
// the first one did not catch anything: every early screenshot of this feature
// was taken at 1280x900, which is a desktop. At 1024x768 — the classic 4:3 till
// — the photo row pushed 2 of 6 items below the fold, and a desktop-sized
// screenshot is constitutionally unable to show that. "It rendered correctly"
// is only true at the size it was rendered.
//
// Transport is fixtures, not the dev database: the page holds no credential and
// cannot write, and the run does not depend on seed data existing. It renders
// the built bundle from `vite preview`, so what is photographed is what ships.
//
// Usage (from the repo root):
//   npx vite build --outDir dist          # in frontend/
//   npx vite preview --port 5624 &        # in frontend/
//   node tests/e2e/shoot-sell-grid.mjs
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/atc-noc/mg-bulk-probe/');
const { chromium } = require('playwright-core');

const BASE = process.env.POS_E2E_BASE || 'http://127.0.0.1:5624';
const SHOTS = process.env.POS_E2E_SHOTS || '/tmp/pos-menu-images';
await fs.mkdir(SHOTS, { recursive: true });

// Distinct flat colours, so a mis-mapped photo is obvious in the screenshot
// rather than plausible. Solid PNGs keep the fixture tiny and readable.
const swatch = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // 1x1 PNG, expanded by object-cover to fill the tile.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const zlib = require('node:zlib');
  const raw = Buffer.from([0x00, r, g, b]); // filter byte + one RGB pixel
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const PHOTOS = {
  p1: swatch('#b45309'),
  p2: swatch('#7c2d12'),
  p3: swatch('#1e3a8a'),
  p4: swatch('#065f46'),
  p5: swatch('#9d174d'),
  p6: swatch('#4c1d95'),
};

// Names chosen from the screenshot the request came with, plus one deliberately
// long one — the three-line clamp exists because a real café menu has these.
const ITEMS = [
  { id: 'p1', name: 'Butter Croissant', basePrice: 120 },
  { id: 'p2', name: 'Cappuccino', basePrice: 180 },
  { id: 'p3', name: 'Cold Brew', basePrice: 220, variants: [{ id: 'v1', status: 'ACTIVE' }] },
  { id: 'p4', name: 'Espresso', basePrice: 100 },
  { id: 'p5', name: 'Masala Chai', basePrice: 80 },
  {
    id: 'p6',
    name: 'Double Chocolate Fudge Brownie with Vanilla Bean Ice Cream',
    basePrice: 260,
  },
];

const MODES = {
  nophotos: () => null,
  photos: (id) => `/api/media/products/acme/${id}.png`,
  mixed: (id) => (['p1', 'p3', 'p6'].includes(id) ? `/api/media/products/acme/${id}.png` : null),
};

const session = {
  user: { id: 'u1', name: 'Asha', email: 'asha@example.com', role: 'CUSTOMER_OWNER' },
  company: { id: 'c1', name: 'Alpha Cafe' },
  branch: { id: 'b1', name: 'Main' },
  license: { status: 'ACTIVE', plan: 'MULTI_STORE', expiresAt: '2099-01-01T00:00:00.000Z' },
};

const browser = await chromium.launch({
  executablePath: process.env.POS_E2E_CHROMIUM ||
    '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

const results = [];

for (const [mode, imageFor] of Object.entries(MODES)) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api/, '');

    // Photo bytes. Served from the same prefix the app builds, so this also
    // proves the <img> src the component produces is actually fetchable.
    const photo = p.match(/^\/media\/products\/acme\/(\w+)\.png$/);
    if (photo) {
      const body = PHOTOS[photo[1]];
      if (!body) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: 'image/png', body });
    }

    const json = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

    if (p === '/auth/me') return json(session);
    if (p === '/catalog/categories') {
      return json({ categories: [{ id: 'cat1', name: 'Coffee', sortOrder: 1 }] });
    }
    if (p === '/catalog/products') {
      return json({
        products: ITEMS.map((it) => ({
          status: 'ACTIVE',
          categoryId: 'cat1',
          variants: [],
          modifierGroups: [],
          ...it,
          imageUrl: imageFor(it.id),
        })),
      });
    }
    if (p === '/tables') return json({ tables: [] });
    if (p === '/orders') return json({ orders: [] });
    if (p === '/branches') return json({ branches: [session.branch] });
    return json({});
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Butter Croissant', { timeout: 15000 });
  // Photos are lazy; settle them before the shutter.
  await page.waitForTimeout(600);

  // Scoped to the product grid's own breakpoint class. `div.grid` also caught
  // the category chips, and `grid-cols-2` additionally caught the Takeaway /
  // Dine-in pair in the order panel — both of which counted as "tiles" and made
  // the harness report six items as eight. 2xl:grid-cols-4 is unique to the
  // catalogue grid.
  const GRID = 'div[class*="2xl:grid-cols-4"]';
  const grid = page.locator(GRID).first();
  await grid.screenshot({ path: path.join(SHOTS, `sell-grid-${mode}.png`) });
  await page.screenshot({ path: path.join(SHOTS, `sell-full-${mode}.png`) });

  // Measurements, because "it looked fine" is not a check. Tile heights prove
  // the grid is uniform; naturalWidth proves each <img> actually decoded rather
  // than sitting broken behind an onError that hid it.
  const stats = await page.evaluate((sel) => {
    const tiles = [...document.querySelectorAll(`${sel} > button`)];
    const imgs = [...document.querySelectorAll(`${sel} > button img`)];
    const box = (t) => t.getBoundingClientRect();

    // Uniformity is a PER-ROW property, not a whole-grid one. CSS grid stretches
    // every cell in a row to that row's tallest, but two rows may legitimately
    // differ when a long name wraps to an extra line — that is the same
    // behaviour the grid had before photos existed. Checking one height across
    // the whole grid would fail on the pre-feature layout too, which is how a
    // check ends up measuring the harness instead of the page.
    const rows = new Map();
    for (const t of tiles) {
      const top = Math.round(box(t).top);
      if (!rows.has(top)) rows.set(top, []);
      rows.get(top).push(Math.round(box(t).height));
    }
    const raggedRows = [...rows.values()].filter((hs) => new Set(hs).size > 1).length;

    return {
      tiles: tiles.length,
      rows: rows.size,
      raggedRows,
      heights: [...new Set(tiles.map((t) => Math.round(box(t).height)))].sort((a, b) => a - b),
      widths: [...new Set(tiles.map((t) => Math.round(box(t).width)))],
      imgs: imgs.length,
      decoded: imgs.filter((i) => i.naturalWidth > 0).length,
      hidden: imgs.filter((i) => i.style.display === 'none').length,
      // Any tile whose content spills its box would clip a price or a name.
      overflowing: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
    };
  }, GRID);

  results.push({ mode, ...stats, consoleErrors });
  await context.close();
}

// ---------------------------------------------------------------------------
// Till viewports: does the menu still fit on the hardware this runs on?
// ---------------------------------------------------------------------------
// A photo row buys recognition and spends vertical space. The thing worth
// measuring is not whether it looks nice but whether the cashier can still see
// their menu without scrolling, at the sizes POS screens actually come in.
//
// 1024x768 is the one that bites, and not because it is narrow: it is the only
// size here where the order panel still sits beside the grid while the screen
// is short, so the grid gets two columns AND tall tiles at once. 768x1024 is
// narrower and costs nothing, because there the panel stacks underneath.
const VIEWPORTS = [
  { name: '1024x768', width: 1024, height: 768 }, // 4:3 till — the bad case
  { name: '1366x768', width: 1366, height: 768 }, // common widescreen till
  { name: '1280x800', width: 1280, height: 800 }, // above the 780px threshold
  { name: '768x1024', width: 768, height: 1024 }, // portrait tablet
  { name: '1280x900', width: 1280, height: 900 }, // desktop, for contrast
];

const fold = [];
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const page = await context.newPage();
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^\/api/, '');
    const photo = p.match(/^\/media\/products\/acme\/(\w+)\.png$/);
    if (photo) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PHOTOS[photo[1]] });
    }
    const json = (obj) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
    if (p === '/auth/me') return json(session);
    if (p === '/catalog/categories') return json({ categories: [{ id: 'cat1', name: 'Coffee', sortOrder: 1 }] });
    if (p === '/catalog/products') {
      return json({
        products: ITEMS.map((it) => ({
          status: 'ACTIVE', categoryId: 'cat1', variants: [], modifierGroups: [],
          ...it, imageUrl: `/api/media/products/acme/${it.id}.png`,
        })),
      });
    }
    if (p === '/tables') return json({ tables: [] });
    if (p === '/orders') return json({ orders: [] });
    if (p === '/branches') return json({ branches: [session.branch] });
    return json({});
  });

  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Butter Croissant', { timeout: 15000 });
  await page.waitForTimeout(500);

  const m = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('div[class*="2xl:grid-cols-4"] > button')];
    const vh = window.innerHeight;
    const img = document.querySelector('div[class*="2xl:grid-cols-4"] > button img');
    return {
      total: tiles.length,
      // Fully visible: a tile half off the bottom is not a tile the cashier can
      // read the price off.
      aboveFold: tiles.filter((t) => t.getBoundingClientRect().bottom <= vh).length,
      tileH: tiles.length ? Math.round(tiles[0].getBoundingClientRect().height) : 0,
      photoH: img ? Math.round(img.getBoundingClientRect().height) : 0,
    };
  });
  fold.push({ ...vp, ...m });
  await page.screenshot({ path: path.join(SHOTS, `sell-till-${vp.name}.png`) });
  await context.close();
}

await browser.close();

console.log('');
console.log('viewport    tiles above fold   tile h   photo h');
for (const f of fold) {
  console.log(
    `${f.name.padEnd(11)} ${String(`${f.aboveFold}/${f.total}`).padEnd(18)} ` +
      `${String(f.tileH).padEnd(8)} ${f.photoH}`,
  );
}

console.log('');
for (const r of results) {
  console.log(
    `${r.mode.padEnd(9)} tiles=${r.tiles} rows=${r.rows} ragged=${r.raggedRows} ` +
      `heights=[${r.heights}] imgs=${r.imgs} decoded=${r.decoded} ` +
      `hiddenByOnError=${r.hidden} overflowing=${r.overflowing} ` +
      `consoleErrors=${r.consoleErrors.length}`,
  );
  for (const e of r.consoleErrors.slice(0, 3)) console.log(`   ! ${e}`);
}

const byMode = Object.fromEntries(results.map((r) => [r.mode, r]));
const checks = [
  ['all six items render in every mode', results.every((r) => r.tiles === ITEMS.length)],
  ['no row is ragged in any mode', results.every((r) => r.raggedRows === 0)],
  // The half-photographed catalogue is the case a per-tile layout would tear:
  // a photo on one tile would leave its neighbours short inside a stretched row.
  ['mixed rows are the same height as fully-photographed ones',
    `${byMode.mixed.heights}` === `${byMode.photos.heights}`],
  ['no photo row at all when no product has one', byMode.nophotos.imgs === 0],
  ['every photo decodes when all are present', byMode.photos.decoded === 6],
  ['mixed shows photos only for the three that have them', byMode.mixed.decoded === 3],
  ['no image fell back to the onError placeholder', results.every((r) => r.hidden === 0)],
  ['nothing overflows its tile', results.every((r) => r.overflowing === 0)],
  ['no console errors', results.every((r) => r.consoleErrors.length === 0)],
  // The regression that would matter most: turning photos on must not change
  // how wide the tiles are, only how tall.
  ['tile width unchanged by photos', byMode.nophotos.widths[0] === byMode.photos.widths[0]],
  // The whole six-item demo menu must survive on every till size. This is the
  // check that would have failed before the max-height variant landed.
  ['whole menu fits above the fold on every till size',
    fold.every((f) => f.aboveFold === f.total)],
  // And the variant must actually be doing something on the short screens,
  // rather than passing because the layout happens to fit anyway. Without this,
  // deleting the max-height class would leave the suite green at 1280x800 and
  // only fail at 1024x768 for reasons nobody could read off the output.
  ['short screens really do get the smaller photo row',
    fold.filter((f) => f.height <= 780).every((f) => f.photoH === 64) &&
      fold.filter((f) => f.height > 780).every((f) => f.photoH === 96)],
];

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
console.log('');
console.log(`shots in ${SHOTS}`);
console.log(failed === 0 ? 'SELL GRID: PASS' : `SELL GRID: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
