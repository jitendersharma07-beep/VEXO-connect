// Shared helpers for the pos-stgtbl verification matrix (candidate 16a22b0).
//
// Adapted from the pos-staging-114ffc9 harness rather than imported from it:
// that harness's own comment warns it "must never read back into" another
// session's tree, and the same rule applies in reverse. SECRETS below resolves
// only inside THIS directory, so a stray basename cannot reach a peer's creds.
//
// Secrets are read from 0600 files and never printed; anything that would carry
// one prints a mask instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Loopback + /pos prefix: probing the container at "/" would skip the prefix
// strip and the cookie-path rewrite, i.e. pass without testing them.
export const BASE = process.env.POS_BASE ?? 'http://127.0.0.1:8113/pos';

export const HERE = fileURLToPath(new URL('.', import.meta.url));
export const SECRETS = path.resolve(HERE, '../secrets');

export const readCreds = (file) => {
  const out = new Map();
  const p = path.join(SECRETS, path.basename(file));
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [email, ...rest] = t.split(/\s+/);
    out.set(email, rest.join(' '));
  }
  return out;
};

export const api = async (p, { method = 'GET', token, body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
  const ctype = res.headers.get('content-type') ?? '';
  let payload = null;
  if (ctype.includes('application/json')) payload = await res.json().catch(() => null);
  else payload = await res.text().catch(() => null);
  return { status: res.status, ctype, body: payload, headers: res.headers };
};

let pass = 0;
let fail = 0;
const failures = [];

export const check = (name, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? '  — ' + detail : ''}`);
    console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
  return condition;
};

export const note = (msg) => console.log(`note  ${msg}`);

export const summary = (label) => {
  console.log(`\n===== ${label}: ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('failed checks:\n  ' + failures.join('\n  '));
  return fail;
};

// --- money -----------------------------------------------------------------
// Every amount the API returns is a decimal string. Comparing those as floats is
// how a rounding error becomes a passing test, so everything is compared in
// integer paise.
export const paise = (v) => Math.round(Number(v) * 100);
export const rupees = (p) => (p / 100).toFixed(2);

export const loadTokens = () =>
  new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(HERE, '.tokens.json'), 'utf8'))));

export const saveJson = (name, obj) =>
  fs.writeFileSync(path.join(HERE, name), JSON.stringify(obj, null, 2), { mode: 0o600 });

export const loadJson = (name) =>
  JSON.parse(fs.readFileSync(path.join(HERE, name), 'utf8'));
