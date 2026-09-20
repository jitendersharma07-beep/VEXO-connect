#!/usr/bin/env node
// Verifies the ATC POS prod stack by content, without touching any other service.
// Default target is the loopback edge (host-nginx-stripped paths). To verify the
// public mount after go-live: BASE_URL=https://atcworkspace.com/pos node deploy/prod-verify.mjs
// Prints PASS/FAIL lines only — never prints credentials. Exit 0 = all green.

import readline from 'node:readline';

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

const ask = (prompt, { hidden = false } = {}) =>
  new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = function () { this.output.write('*'); };
    rl.question('', (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
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
    record('js bundle fetch + content', asset.status === 200 && assetText.includes('ATC POS'),
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
  const email = (await ask('ATC admin email [pos.admin@atcinfocom.in]: ')) || 'pos.admin@atcinfocom.in';
  const password = await ask('Password (hidden): ', { hidden: true });
  const login = await json('/api/auth/login', { email, password });
  const loginBody = await login.json().catch(() => ({}));
  const token = loginBody?.token;
  record('admin sign-in', login.status === 200 && Boolean(token) && loginBody?.user?.role === 'POS_SUPER_ADMIN',
    `status ${login.status}`);

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
  record('verification run', false, err?.message || String(err));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed against ${BASE}`);
process.exit(failed === 0 ? 0 : 1);
