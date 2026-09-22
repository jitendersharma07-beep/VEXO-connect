// Provision the missing Cyber Hub (BSC-CH) demo staff through the SUPPORTED
// account flow: an authenticated CUSTOMER_OWNER calling POST /api/users, the
// same route the Team page uses. No direct database writes.
//
// SAFETY RAILS:
//   * signs in as the demo company owner only (default demo.owner@atcpos.example);
//     its password is read from an existing 0600 credentials file, never argv/env
//   * refuses unless the owner's company has isDemo = true
//   * idempotent — an account that already exists is reported and skipped
//   * no password, token or cookie is ever printed; server-generated temp
//     passwords go to OUT_FILE (mode 0600, refuses to overwrite)
//
// The created accounts keep mustChangePassword = true (the supported flow's
// secure default). If they are to be handed out as SHARED demo credentials,
// follow up with the documented scoped rotation using --demo, exactly as was
// done for the other demo accounts (docs/DEPLOY-PHASE2.md §5).
//
//   node deploy/provision-cyberhub-staff.mjs                    # against prod
//   BASE_URL=http://127.0.0.1:5010 node deploy/provision-cyberhub-staff.mjs
//
// Exit codes: 0 ok · 1 failed/refused · 2 usage/environment.

import { readFileSync, writeFileSync } from 'node:fs';

const BASE = (process.env.BASE_URL || 'https://atcworkspace.com/pos').replace(/\/$/, '');
const API = `${BASE}/api`;
const CREDS_FILE = process.env.CREDS_FILE || '/home/atc-noc/pos-demo-creds-20260921.txt';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'demo.owner@atcpos.example').toLowerCase();
const OUT_FILE =
  process.env.OUT_FILE ||
  `/home/atc-noc/pos-demo-creds-cyberhub-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.txt`;

const BRANCH_CODE = 'BSC-CH';
const STAFF = [
  { email: 'demo.manager.ch@atcpos.example', fullName: 'Demo Branch Manager — Cyber Hub', role: 'BRANCH_MANAGER' },
  { email: 'demo.cashier.ch@atcpos.example', fullName: 'Demo Cashier — Cyber Hub', role: 'CASHIER' },
];

const out = (line) => console.log(line);
const die = (code, msg) => { console.error(msg); process.exit(code); };

// Credentials file format (written by rotate-pos-passwords.mjs --out):
// comment lines start with '#', entries are "email<TAB>password".
const ownerPassword = (() => {
  let text;
  try {
    text = readFileSync(CREDS_FILE, 'utf8');
  } catch (e) {
    die(2, `cannot read credentials file ${CREDS_FILE}: ${e.code || e.message}`);
  }
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [email, password] = line.split('\t');
    if (email?.trim().toLowerCase() === OWNER_EMAIL && password) return password.trim();
  }
  die(2, `no entry for ${OWNER_EMAIL} in ${CREDS_FILE} (expected "email<TAB>password" lines)`);
  return undefined;
})();

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 160) }; }
  return { status: res.status, body: json };
};

const main = async () => {
  out(`target   ${BASE}`);

  const login = await call('POST', '/auth/login', { body: { email: OWNER_EMAIL, password: ownerPassword } });
  if (login.status !== 200) die(1, `FAIL: owner sign-in refused (HTTP ${login.status}) — not printing details`);
  const token = login.body.token ?? login.body.accessToken;
  if (!token) die(1, 'FAIL: sign-in succeeded but no token in the response');
  // Fail closed: /auth/login returns company{isDemo} for every tenant
  // principal; anything else (missing company, isDemo false) is a refusal.
  const company = login.body.company;
  if (!company || company.isDemo !== true) {
    die(1, `REFUSED: ${OWNER_EMAIL} does not belong to a company with isDemo=true; this script only provisions demo staff`);
  }
  out(`signed in as ${OWNER_EMAIL} (owner)${company?.name ? ` — ${company.name}` : ''}`);

  const br = await call('GET', '/branches', { token });
  const branches = br.body?.branches ?? [];
  const target = branches.find((b) => b.code === BRANCH_CODE);
  if (!target) die(1, `FAIL: branch ${BRANCH_CODE} not found (got: ${branches.map((b) => b.code).join(', ') || 'none'})`);
  out(`branch   ${target.name} (${target.code})`);

  const existingRes = await call('GET', '/users', { token });
  const existing = new Map((existingRes.body?.users ?? []).map((u) => [u.email, u]));

  const issued = [];
  let failures = 0;
  for (const s of STAFF) {
    const already = existing.get(s.email);
    if (already) {
      out(`SKIP     ${s.email} already exists (role=${already.role}, status=${already.status}); password untouched`);
      continue;
    }
    const r = await call('POST', '/users', {
      token,
      body: { email: s.email, fullName: s.fullName, role: s.role, branchId: target.id },
    });
    if ((r.status === 200 || r.status === 201) && r.body?.tempPassword) {
      issued.push({ email: s.email, tempPassword: r.body.tempPassword });
      out(`CREATED  ${s.email}  role=${s.role}  branch=${BRANCH_CODE}  (temp password captured, not shown)`);
    } else {
      failures += 1;
      const msg = r.body?.error?.message || r.body?.raw || '';
      out(`FAIL     ${s.email}  HTTP ${r.status}${msg ? `  — ${msg}` : ''}`);
    }
  }

  if (issued.length) {
    const body = [
      '# VEXO Connect (demo) — Cyber Hub staff temp credentials',
      `# generated ${new Date().toISOString()} by deploy/provision-cyberhub-staff.mjs`,
      '# mustChangePassword=true: each account is forced to set its own password at first sign-in.',
      '# Treat this file as a secret. Delete it once the credentials are handed over.',
      '',
      ...issued.map((i) => `${i.email}\t${i.tempPassword}`),
      '',
    ].join('\n');
    try {
      writeFileSync(OUT_FILE, body, { mode: 0o600, flag: 'wx' });
      out(`temp passwords written to ${OUT_FILE} (mode 0600), not shown here by design`);
    } catch (e) {
      die(1, `FAIL: could not write ${OUT_FILE}: ${e.code || e.message} — accounts exist but their temp passwords are unrecoverable; rotate them via the documented scoped rotation`);
    }
  }

  // Independent read-back through the same supported API.
  const after = await call('GET', '/users', { token });
  const verify = (after.body?.users ?? []).filter((u) => STAFF.some((s) => s.email === u.email));
  for (const s of STAFF) {
    const u = verify.find((v) => v.email === s.email);
    const ok = u && u.role === s.role && u.branchId === target.id && u.status === 'ACTIVE';
    out(`${ok ? 'PASS' : 'FAIL'}     read-back ${s.email}: ${u ? `role=${u.role} branch=${u.branchId === target.id ? BRANCH_CODE : u.branchId} status=${u.status}` : 'missing'}`);
    if (!ok) failures += 1;
  }

  process.exit(failures > 0 ? 1 : 0);
};

main().catch((e) => die(1, `FAIL: ${e.message}`));
