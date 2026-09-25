// Pulls the printable artefacts off the running stack and checks them.
//
// The browser run proves a guest who visits the URL can order. This proves the
// other half, which no test above it can: that the image a member of staff
// downloads and sticks on a table actually carries that URL. The two are
// separate failures — a card can be perfectly scannable and point at the wrong
// store, or at localhost, and nothing else in this lane would notice.
//
// Reads the demo's own cards.json for the expected URLs rather than taking
// tokens on a command line, and decodes with tests/fixtures/qrDecoder.js — the
// same independent reader the suite uses, which imports nothing from src/.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeMatrix, decodePng } from '../tests/fixtures/qrDecoder.js';

// Rebuilds the symbols a print sheet draws, straight from its content stream.
// Each card emits one "0 0 0 rg" fill followed by a rectangle per run of dark
// modules, so the symbol can be recovered without rasterising anything — and
// what is read back is the ink that will land on the paper.
const symbolsInPdf = (pdf) => {
  const stream = pdf.toString('latin1');
  return stream
    .split('0 0 0 rg')
    .slice(1)
    .map((block) => {
      const rects = [...block.slice(0, block.indexOf('\nf\n')).matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)]
        .map((m) => m.slice(1).map(Number));
      if (rects.length === 0) return null;
      const step = Math.min(...rects.map((r) => r[3]));
      const x0 = Math.min(...rects.map((r) => r[0]));
      const top = Math.max(...rects.map((r) => r[1] + r[3]));
      const right = Math.max(...rects.map((r) => r[0] + r[2]));
      const bottom = Math.min(...rects.map((r) => r[1]));
      // The symbol is square and the finders reach all four edges, so the drawn
      // extent is the whole symbol.
      const size = Math.round(Math.max(right - x0, top - bottom) / step);
      // A page also fills black for its text and its cut lines. Only a QR-shaped
      // run of rectangles is a symbol, and the three finders settle it.
      if (size % 4 !== 1 || size < 21 || size > 177) return null;
      const modules = new Uint8Array(size * size);
      for (const [x, y, w, h] of rects) {
        const r = Math.round((top - y - h) / step);
        const c = Math.round((x - x0) / step);
        if (r < 0 || r >= size || c < 0 || c + Math.round(w / step) > size) return null;
        for (let i = 0; i < Math.round(w / step); i += 1) modules[r * size + c + i] = 1;
      }
      const finder = (r0, c0) =>
        [0, 1, 2, 3, 4, 5, 6].every((r) =>
          [0, 1, 2, 3, 4, 5, 6].every((c) => {
            const ring = r === 0 || r === 6 || c === 0 || c === 6;
            const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            return (modules[(r0 + r) * size + c0 + c] === 1) === (ring || core);
          }),
        );
      if (!finder(0, 0) || !finder(0, size - 7) || !finder(size - 7, 0)) return null;
      return { size, modules };
    })
    .filter(Boolean);
};

const API = 'http://127.0.0.1:5531/api';
const DIR = '/tmp/qr-demo';
const OUT = `${DIR}/artifacts`;

const demo = JSON.parse(readFileSync(`${DIR}/cards.json`, 'utf8'));

let passed = 0;
const failures = [];
const step = async (name, fn) => {
  try {
    const note = await fn();
    passed += 1;
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name} — ${e.message}`);
  }
};
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const login = async (email, password) => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  must(res.ok, `login failed for ${email}: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  must(cookie, 'login returned no session cookie');
  return cookie;
};

const staff = demo.staff ?? demo.stores?.[0]?.staff;
const owner = staff?.owner ?? 'owner@saffron.demo';
const password = demo.password ?? 'demo-password-1';

mkdirSync(OUT, { recursive: true });
const cookie = await login(owner, password);

const get = async (path, accept) => {
  const res = await fetch(`${API}${path}`, { headers: { cookie, ...(accept ? { accept } : {}) } });
  return res;
};

const codes = await (async () => {
  const res = await get('/table-qr');
  must(res.ok, `GET /table-qr answered ${res.status}`);
  const { tables } = await res.json();
  return tables.filter((t) => t.qr).map((t) => ({ ...t.qr, branchId: t.branchId }));
})();

const cardUrl = (store, table) =>
  demo.cards.find((c) => c.store.includes(store) && c.table === table)?.url;

// Matching on the URL the API itself advertises also checks that the two agree:
// a card staged by one code path and printed by another would not line up.
const codeFor = (store, table) => {
  const wanted = cardUrl(store, table);
  must(wanted, `the demo staged no ${store} ${table} card`);
  const row = codes.find((c) => c.url === wanted);
  must(row, `no ACTIVE code in the API matches the staged ${store} ${table} card`);
  return { row, wanted };
};

// --- the image on the table --------------------------------------------------

await step('the downloaded PNG decodes to the configured URL for that table', async () => {
  const { row, wanted } = codeFor('Connaught Place', 'T1');
  const res = await get(`/table-qr/${row.id}/png`);
  must(res.ok, `PNG download answered ${res.status}`);
  must(
    res.headers.get('content-type') === 'image/png',
    `served ${res.headers.get('content-type')} rather than image/png`,
  );
  must(
    /no-store/.test(res.headers.get('cache-control') ?? ''),
    'a printable credential was served cacheable',
  );
  const png = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${OUT}/card-cp-t1.png`, png);

  const read = decodePng(png);
  must(read.text === wanted, `decoded ${read.text}\n        expected ${wanted}`);
  return `${read.text} (version ${read.version})`;
});

await step('a second table decodes to its own URL, not the first one', async () => {
  // Without this, a decoder or an endpoint that returned one fixed image would
  // have passed the step above.
  const { row, wanted } = codeFor('Connaught Place', 'T2');
  const res = await get(`/table-qr/${row.id}/png`);
  must(res.ok, `PNG download answered ${res.status}`);
  const png = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${OUT}/card-cp-t2.png`, png);
  const read = decodePng(png);
  must(read.text === wanted, `decoded ${read.text}, expected ${wanted}`);
  must(read.text !== cardUrl('Connaught Place', 'T1'), 'T2 decoded to T1 — the cards are identical');
  return read.text;
});

await step('the same table label in the other store decodes to a different URL', async () => {
  const cp = cardUrl('Connaught Place', 'T1');
  const { row, wanted: kor } = codeFor('Koramangala', 'T1');
  must(kor !== cp, 'both stores staged the same T1 URL');
  const res = await get(`/table-qr/${row.id}/png`);
  must(res.ok, `PNG download answered ${res.status}`);
  const png = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${OUT}/card-kor-t1.png`, png);
  const read = decodePng(png);
  must(read.text === kor, `decoded ${read.text}, expected ${kor}`);
  return `${read.text} — not ${cp}`;
});

await step('no card points at a host a customer cannot reach', async () => {
  // The dev stack is deliberately allowed to be localhost; production is not,
  // and env.js refuses to boot with one. What is checked here is that every
  // card agrees with the single configured base, so none of them was built
  // from a request header or a hard-coded string.
  const bases = new Set(demo.cards.map((c) => new URL(c.url).origin));
  must(bases.size === 1, `cards point at ${bases.size} different hosts: ${[...bases].join(', ')}`);
  return `all ${demo.cards.length} cards share the configured base ${[...bases][0]}`;
});

// --- the sheet that gets printed --------------------------------------------

await step('the print sheet is a real PDF naming store, floor, section and table', async () => {
  const { row } = codeFor('Connaught Place', 'T1');
  const res = await get(`/table-qr/export.pdf?branchId=${encodeURIComponent(row.branchId)}`);
  must(res.ok, `PDF export answered ${res.status}`);
  must(
    res.headers.get('content-type') === 'application/pdf',
    `served ${res.headers.get('content-type')} rather than application/pdf`,
  );
  const pdf = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${OUT}/cards-connaught-place.pdf`, pdf);
  must(pdf.subarray(0, 5).toString() === '%PDF-', 'the body does not start with %PDF-');
  must(pdf.subarray(-6).toString().includes('%%EOF'), 'the body has no %%EOF trailer');

  // Card text is drawn as uncompressed PDF text operators, so a printed card
  // can be checked for what it says without rasterising it.
  const text = pdf.toString('latin1');
  for (const phrase of ['Saffron Grill', 'Connaught Place', 'Ground Floor', 'Window Row', 'T1']) {
    must(text.includes(phrase), `the sheet never names "${phrase}"`);
  }
  must(!text.includes('Koramangala'), 'one store’s sheet carries another store’s tables');
  return `${(pdf.length / 1024).toFixed(0)} kB, names store, city, floor, section and table`;
});

await step('every symbol on the print sheet decodes to its own table’s URL', async () => {
  // The PDF and the PNG share a matrix builder but not a renderer, so a card
  // can be a valid-looking QR on paper and still be unreadable or wrong. This
  // reads the drawn rectangles back.
  const pdf = readFileSync(`${OUT}/cards-connaught-place.pdf`);
  const symbols = symbolsInPdf(pdf);
  const expected = demo.cards.filter((c) => c.store.includes('Connaught Place')).map((c) => c.url);
  must(
    symbols.length === expected.length,
    `sheet draws ${symbols.length} symbols for ${expected.length} tables`,
  );
  const read = symbols.map((s) => decodeMatrix(s).text);
  must(new Set(read).size === read.length, 'two cards on one sheet carry the same URL');
  for (const url of expected) must(read.includes(url), `no card on the sheet decodes to ${url}`);
  return `${read.length} cards, each its own table`;
});

console.log(`\n${passed}/${passed + failures.length} checks passed`);
console.log(`artefacts in ${OUT}`);
if (failures.length) process.exit(1);
