#!/usr/bin/env node
// Verifies the ATC POS prod stack by content, without touching any other service.
// Default target is the loopback edge (host-nginx-stripped paths). To verify the
// public mount after go-live: BASE_URL=https://atcworkspace.com/pos node deploy/prod-verify.mjs
// Prints PASS/FAIL lines only — never prints credentials. Exit 0 = all green.

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8110').replace(/\/$/, '');
// Served-at-/pos (public) vs prefix-stripped loopback: assets in index.html are
// always /pos/assets/*; on loopback the fetchable path has the /pos stripped.
const atPublicMount = BASE.endsWith('/pos');
const ORIGIN = atPublicMount ? BASE.slice(0, -'/pos'.length) : BASE;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// ONE reader for the whole run. The previous version opened a fresh readline
// interface per prompt: characters typed or pasted ahead of the second prompt
// were consumed by the first interface and discarded when it closed, so the
// password arrived truncated or empty. An empty password is a schema violation,
// not a credential failure, so the API answered 400 — which reads like "the
// admin password is wrong" when the same password works fine in a browser.
const CR = '\r';
const LF = '\n';
const EOT = String.fromCharCode(4); // ctrl-D
const ETX = String.fromCharCode(3); // ctrl-C
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);
const ESC = String.fromCharCode(27);

let reading = false;
let pending = null; // { resolve, hidden } — the prompt currently awaiting a line
let partial = '';
let escState = 0; // 0 normal · 1 just saw ESC · 2 inside a CSI/SS3 sequence
const typedAhead = [];

const closeReader = () => {
  if (!reading) return;
  process.stdin.removeListener('data', onData);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  reading = false;
};

const deliver = () => {
  if (pending && typedAhead.length) {
    const { resolve } = pending;
    pending = null;
    // Written here rather than where Enter was pressed, so a line that was
    // typed ahead still ends its prompt cleanly — exactly once, either way.
    process.stdout.write('\n');
    resolve(typedAhead.shift());
  }
};

function onData(chunk) {
  for (const ch of chunk) {
    // Swallow terminal escape sequences. In raw mode an arrow key, a function
    // key or a bracketed paste arrives as ESC-[…-final-byte. Those bytes are
    // invisible when echoed back, so letting them into the value produces a
    // field that looks empty on screen but fails validation — which is exactly
    // how a stray arrow key became "not an email address".
    if (escState === 1) {
      escState = ch === '[' || ch === 'O' ? 2 : 0;
      continue;
    }
    if (escState === 2) {
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) escState = 0; // final byte ends it
      continue;
    }
    if (ch === ESC) {
      escState = 1;
      continue;
    }
    if (ch === ETX) {
      closeReader();
      process.stdout.write('\n');
      process.exit(130);
    }
    if (ch === CR || ch === LF || ch === EOT) {
      typedAhead.push(partial);
      partial = '';
      deliver();
      continue;
    }
    if (ch === DEL || ch === BS) {
      if (partial) {
        partial = partial.slice(0, -1);
        if (pending) process.stdout.write('\b \b');
      }
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) continue; // any remaining control byte (tab, ctrl-*)
    partial += ch;
    // Echo only while a prompt is live, so a pasted line that arrives early is
    // buffered rather than printed.
    if (pending) process.stdout.write(pending.hidden ? '*' : ch);
  }
}

const ask = (prompt, { hidden = false } = {}) =>
  new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('interactive sign-in needs a TTY — re-run from a terminal, not a pipe'));
      return;
    }
    if (!reading) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      reading = true;
    }
    process.stdout.write(prompt);
    pending = { resolve, hidden };
    deliver();
  });

const get = (path, opts = {}) => fetch(BASE + path, { redirect: 'manual', ...opts });
const json = (path, body, headers = {}) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

try {
  // 1. Edge → backend → database chain
  const health = await get('/api/health');
  const healthBody = await health.json().catch(() => ({}));
  record('api health (edge→backend→db)', health.status === 200 && healthBody.service === 'atc-pos-api',
    `status ${health.status}`);

  // 2. SPA shell served, with the /pos/ base baked into the bundle
  const index = await get('/');
  const indexHtml = await index.text();
  const assetMatch = indexHtml.match(/src="(\/pos\/assets\/[^"]+\.js)"/);
  record('index.html served with /pos/ asset base', index.status === 200 && Boolean(assetMatch),
    assetMatch ? assetMatch[1] : 'asset ref not found');

  // 3. The referenced bundle actually loads through the same mount
  if (assetMatch) {
    const assetPath = atPublicMount ? assetMatch[1] : assetMatch[1].replace(/^\/pos/, '');
    const asset = await fetch(ORIGIN + assetPath);
    const assetText = asset.status === 200 ? await asset.text() : '';
    record('js bundle fetch + content', asset.status === 200 && assetText.includes('VEXO Connect'),
      `status ${asset.status}, ${assetText.length} bytes`);
  } else {
    record('js bundle fetch + content', false, 'skipped — no asset ref');
  }

  // 4. Direct refresh on nested SPA routes falls back to index.html
  for (const route of ['/login', '/dashboard', '/atc/companies']) {
    const page = await get(route);
    const html = await page.text();
    record(`direct refresh ${route}`, page.status === 200 && html.includes('/pos/assets/'), `status ${page.status}`);
  }

  // 5. Unauthenticated API access is refused
  const anonMe = await get('/api/auth/me');
  record('anonymous /api/auth/me refused', anonMe.status === 401, `status ${anonMe.status}`);

  // 6. Wrong password refused indistinctly
  const badLogin = await json('/api/auth/login', { email: 'nobody@atcpos.example', password: 'definitely-wrong' });
  const badBody = await badLogin.json().catch(() => ({}));
  record('wrong credentials → 401', badLogin.status === 401 && Boolean(badBody?.error?.message),
    `status ${badLogin.status}`);

  // 7. Real sign-in (prompted; nothing echoed or printed)
  const email = (await ask('ATC admin email [pos.admin@atcinfocom.in]: ')).trim() || 'pos.admin@atcinfocom.in';
  // Deliberately NOT trimmed: a password may legitimately start or end with a
  // space, and silently stripping it turns a correct password into a 401.
  const password = await ask('Password (hidden): ', { hidden: true });
  closeReader();

  // Check what the schema checks, before sending. A malformed payload comes
  // back as 400 and is indistinguishable, at a glance, from a rejected
  // credential — so refuse locally and say which field is wrong.
  let token;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    record('admin sign-in', false, `field=email: not an email address (length ${email.length}) — nothing was sent`);
  } else if (password.length === 0) {
    record('admin sign-in', false, 'field=password: empty input — nothing was sent');
  } else {
    const login = await json('/api/auth/login', { email, password });
    const loginBody = await login.json().catch(() => ({}));
    token = loginBody?.token;
    // Only the API's own code/message/field are surfaced. Never the request
    // body, the response body, the token or the session cookie.
    const e = loginBody?.error;
    const why = e ? `, ${e.code}${e.field ? ` field=${e.field}` : ''}: ${e.message}` : '';
    record('admin sign-in', login.status === 200 && Boolean(token) && loginBody?.user?.role === 'POS_SUPER_ADMIN',
      `status ${login.status}${why}`);
  }

  if (token) {
    const auth = { authorization: `Bearer ${token}` };

    // 8. Session answers /me
    const me = await get('/api/auth/me', { headers: auth });
    record('authenticated /api/auth/me', me.status === 200);

    // 9. ATC console reachable for the super admin
    const companies = await get('/api/atc/companies', { headers: auth });
    const companiesBody = await companies.json().catch(() => ({}));
    const demo = (companiesBody?.companies || []).find((c) => c.slug === 'demo-brew-street');
    record('ATC console lists demo company (isDemo)', companies.status === 200 && demo?.isDemo === true,
      `status ${companies.status}, companies ${companiesBody?.companies?.length ?? '?'}`);

    // 10. Logout revokes the session server-side
    const logout = await json('/api/auth/logout', {}, auth);
    const meAfter = await get('/api/auth/me', { headers: auth });
    record('logout revokes session', logout.status === 200 && meAfter.status === 401,
      `me after logout ${meAfter.status}`);
  } else {
    record('authenticated checks', false, 'skipped — sign-in failed');
  }
} catch (err) {
  closeReader(); // never leave the operator's terminal in raw mode
  record('verification run', false, err?.message || String(err));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed against ${BASE}`);
process.exit(failed === 0 ? 0 : 1);
