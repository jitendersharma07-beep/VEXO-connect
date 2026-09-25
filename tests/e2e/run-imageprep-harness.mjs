// Run frontend/imageprep-harness.html in a real browser and exit non-zero if
// any check fails.
//
// Why this exists at all: frontend/src/lib/productImagePrep.js decides how big
// a menu photo is when it leaves the till — it downscales on a canvas and
// re-encodes until the bytes fit. None of that can be covered by the backend
// suite, because node has no canvas, and `vite build` only proves the file
// parses. So the one place the resize is actually exercised is a browser.
//
// Why CDP rather than the playwright walkthroughs beside this file: those need
// playwright-core resolved from outside the repo (see env.cjs). This needs
// nothing installed — node 22 ships a global WebSocket, and that is the whole
// dependency list. It also sidesteps `--dump-dom`, which on chrome-headless-shell
// snapshots the DOM BEFORE module scripts finish and so reliably captured the
// page's "running…" placeholder instead of its results.
//
// Usage:
//   npx vite --port 5623 &                               # from frontend/
//   chrome-headless-shell --remote-debugging-port=9222 & # any Chrome works
//   node tests/e2e/run-imageprep-harness.mjs
//
// Env:
//   POS_IMAGEPREP_URL  page to load   (default http://127.0.0.1:5623/imageprep-harness.html)
//   POS_CDP_BASE       DevTools HTTP  (default http://127.0.0.1:9222)
const CDP_BASE = process.env.POS_CDP_BASE || 'http://127.0.0.1:9222';
const PAGE_URL =
  process.env.POS_IMAGEPREP_URL || 'http://127.0.0.1:5623/imageprep-harness.html';

const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
let page = targets.find((t) => t.type === 'page');
if (!page) {
  page = await (await fetch(`${CDP_BASE}/json/new?about:blank`, { method: 'PUT' })).json();
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', () => reject(new Error(`could not open CDP socket at ${CDP_BASE}`)));
});

await send('Page.enable');
await send('Page.navigate', { url: PAGE_URL });

// Wait for the harness entry point to EXIST, not merely for readyState: module
// scripts evaluate after the document reports "interactive", so keying off
// readyState raced the module and failed as "__run is not a function".
const READY = 'typeof window.__run === "function"';
let ready = false;
for (let i = 0; i < 150; i += 1) {
  const { result } = await send('Runtime.evaluate', { expression: READY, returnByValue: true });
  if (result.value === true) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  console.log(`page never became ready (${READY}) at ${PAGE_URL} — is vite running?`);
  process.exit(1);
}

// awaitPromise matters: every check inside __run is async (decode, toBlob,
// toDataURL), so without it the result is a pending Promise and the run looks
// empty rather than failing.
const { result, exceptionDetails } = await send('Runtime.evaluate', {
  expression: 'window.__run()',
  awaitPromise: true,
  returnByValue: true,
});

if (exceptionDetails) {
  console.log(`HARNESS EXCEPTION: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  process.exit(1);
}

console.log(result.value);
ws.close();
process.exit(String(result.value).includes('HARNESS: PASS') ? 0 : 1);
