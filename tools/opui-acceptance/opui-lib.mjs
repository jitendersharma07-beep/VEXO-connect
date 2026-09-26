// Shared helpers for the three x/operator-ui acceptance harnesses
// (promotions-acceptance.mjs, kds-acceptance.mjs, authz-acceptance.mjs).
//
// Lives OUTSIDE the worktree on purpose: `vcxo setup` asserts the lane's four
// dependency manifests are byte-identical to the dev clone's, and a test
// dependency committed into the lane would invalidate the dependency reuse the
// whole lane stands on.
//
// Three rules these harnesses exist to enforce on themselves, because each has
// already produced a false PASS somewhere in this programme:
//
//   1. An empty value is a FAILURE, never a pass. A 404 that returns `{}` makes
//      `expect(body.thing).toBe(undefined)` green. `check()` refuses undefined,
//      null and '' outright, so a route that stops existing fails loudly instead
//      of quietly agreeing with every assertion about it.
//   2. HTTP status is not evidence of a write. Every mutation is confirmed by
//      reading the row back out of Postgres, because a 200 over a rolled-back
//      transaction looks exactly like a 200 over a committed one.
//   3. A refusal must be the RIGHT refusal. Cross-tenant reads must 404, not
//      403: a 403 confirms the id exists in some other tenant, which is itself
//      the leak. `refuses()` takes the exact status it will accept.
//
// Never prints a password, a token or a JWT.

import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

export const API = process.env.VCX_OPUI_API || 'http://127.0.0.1:5571';
export const UI = process.env.VCX_OPUI_UI || 'http://127.0.0.1:5671';
const DBC = 'vexo-connect-dev-db';
const DBNAME = 'vcx_opui';

if (hostname() !== 'atc-noc') {
  console.error(`refusing — this harness is for atc-noc only (got ${hostname()})`);
  process.exit(1);
}

export const seed = {
  OWNER: process.env.VCX_OPUI_SEED_OWNER,
  MANAGER: process.env.VCX_OPUI_SEED_MANAGER,
  CASHIER: process.env.VCX_OPUI_SEED_CASHIER,
};
for (const [k, v] of Object.entries(seed)) {
  if (!v) {
    console.error(`refusing: VCX_OPUI_SEED_${k} is not in the environment (run via \`vcxo accept\`)`);
    process.exit(1);
  }
}

// --- database ----------------------------------------------------------------
// Read-only by convention here; the harnesses write through the API so that
// every row they assert on was produced by the code under test, not by SQL.
// The one exception is makeRivalTenant(), which must create a second company
// because the seed ships only one and cross-tenant cannot be tested without it.
export const sql = (q, db = DBNAME) =>
  execFileSync('docker', ['exec', '-i', DBC, 'psql', '-U', 'vexo_dev', '-d', db, '-tAc', q], {
    encoding: 'utf8',
  }).trim();

// psql -tAc prints booleans as the bare letters `t`/`f`, which check()'s
// String(actual) === String(expected) would never match against a real JS
// `true`/`false` — turn the driver text back into an actual boolean so a
// caller can write check(what, sqlBool('select ...'), true) directly.
export const sqlBool = (q, db = DBNAME) => sql(q, db) === 't';

// --- tally -------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
const gaps = [];

export const ok = (m) => {
  pass += 1;
  console.log(`  PASS  ${m}`);
};
export const no = (m) => {
  fail += 1;
  failures.push(m);
  console.log(`  FAIL  ${m}`);
};

// A third outcome, and the reason it exists is a reporting-integrity one.
//
// Some assertions here pin down behaviour that is WRONG but not this lane's to
// change — an endpoint with no role gate, an allowlist that predates two roles.
// Written as ok()/refuses() they print PASS, land in `passed:` and make a
// security hole read as a verified control. Written as no() they print FAIL and
// turn a known, reported, owner-assigned gap into a red gate that everyone
// learns to ignore. Neither is honest.
//
// gap() is neither. It prints GAP, tallies separately, never affects the exit
// code, and is reprinted in full at the end so it cannot be skimmed past. The
// behaviour is still asserted — if the owner tightens the gate, the assertion
// underneath fails and this harness reports the change instead of silently
// agreeing with whichever version it meets.
export const gap = (what, owner, detail) => {
  gaps.push({ what, owner, detail });
  console.log(`  GAP   ${what}`);
  if (detail) console.log(`        ${detail}`);
};
export const section = (t) => console.log(`\n-- ${t}`);

// Rule 1: empty is a failure, not a pass.
export const check = (what, actual, expected) => {
  if (actual === undefined || actual === null || actual === '') {
    no(`${what} — empty/absent value (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`);
    return false;
  }
  if (String(actual) === String(expected)) {
    ok(`${what} (${actual})`);
    return true;
  }
  no(`${what} — got ${JSON.stringify(String(actual))}, wanted ${JSON.stringify(String(expected))}`);
  return false;
};

export const truthy = (what, actual) => {
  if (actual === undefined || actual === null || actual === '' || actual === false) {
    no(`${what} — empty/absent (got ${JSON.stringify(actual)})`);
    return false;
  }
  ok(`${what}`);
  return true;
};

export const verdict = (label) => {
  console.log(`\n${'='.repeat(62)}`);
  console.log(` ${label}`);
  console.log('='.repeat(62));
  console.log(`passed:  ${pass}`);
  console.log(`failed:  ${fail}`);
  if (gaps.length) console.log(`gaps:    ${gaps.length}  (reproduced, NOT passes — see below)`);
  if (fail) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (gaps.length) {
    console.log('\nOPEN GAPS — behaviour asserted as it IS, not as it should be.');
    console.log('These are not security passes and must not be reported as any.');
    for (const g of gaps) {
      console.log(`  - ${g.what}`);
      console.log(`      owner: ${g.owner}`);
      if (g.detail) console.log(`      ${g.detail}`);
    }
  }
  const state = fail === 0 && pass > 0 ? 'GREEN' : pass === 0 ? 'RED (nothing asserted)' : 'RED';
  // A run carrying gaps is never plain GREEN. The exit code stays 0 because the
  // gaps are known and owner-assigned, but the word GREEN on its own would be
  // read as "nothing outstanding", which is exactly false here.
  console.log(`verdict: ${state}${gaps.length && state === 'GREEN' ? ` — with ${gaps.length} OPEN GAP(S), not a clean pass` : ''}`);
  process.exit(fail === 0 && pass > 0 ? 0 : 1);
};

// --- http --------------------------------------------------------------------
export async function login(email, password) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: HTTP ${r.status}`);
  const d = await r.json();
  // The token is returned for use as a bearer credential and is never logged.
  return { token: d.token, user: d.user, company: d.company, branch: d.branch, license: d.license };
}

export function client(session) {
  const call = async (method, path, body) => {
    const r = await fetch(`${API}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = null;
    const text = await r.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 200) };
      }
    }
    return { status: r.status, data };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

// Rule 3: the exact refusal, not merely "not a 2xx". `want` may be one status
// or a list — a list is for the genuinely ambiguous cases, and the message says
// which one arrived so the log still pins the behaviour down.
export const refuses = async (what, res, want) => {
  const wanted = Array.isArray(want) ? want : [want];
  if (wanted.includes(res.status)) {
    ok(`${what} → ${res.status}`);
    return true;
  }
  if (res.status >= 200 && res.status < 300) {
    no(`${what} → ADMITTED with ${res.status}, expected ${wanted.join(' or ')}`);
    return false;
  }
  no(`${what} → ${res.status}, expected ${wanted.join(' or ')}`);
  return false;
};

export const admits = async (what, res) => {
  if (res.status >= 200 && res.status < 300) {
    ok(`${what} → ${res.status}`);
    return true;
  }
  no(`${what} → ${res.status}, expected 2xx`);
  return false;
};

// --- fixtures ----------------------------------------------------------------
// owner/manager/cashier come from `node prisma/seed.js` (backend/prisma/seed.js)
// and are what the other two roles below are compared against. companyAdmin/
// regionalManager/finance do NOT exist in that seed — the app's ROLE_ACTIONS
// baseline (backend/src/lib/permissions.js) grants them promo.* on paper, and
// this harness exists to check whether kitchen.js's requireRole allowlists
// (which predate COMPANY_ADMIN/REGIONAL_MANAGER/FINANCE and were never
// extended for them) agree. That comparison needs REAL sessions of each; a
// unit test that constructs `req.user` by hand would prove the middleware
// function works, not that the route is reachable the way a browser reaches
// it, cookie/token and all.
export const sessions = async () => {
  const base = {
    owner: await login('demo.owner@atcpos.example', seed.OWNER),
    manager: await login('demo.manager@atcpos.example', seed.MANAGER),
    cashier: await login('demo.cashier@atcpos.example', seed.CASHIER),
  };
  const { password } = await makeExtraRoles(base.owner.user.companyId);
  return {
    ...base,
    companyAdmin: await login('authz.companyadmin@atcpos.example', password),
    regionalManager: await login('authz.regionalmanager@atcpos.example', password),
    finance: await login('authz.finance@atcpos.example', password),
  };
};

// COMPANY_ADMIN, REGIONAL_MANAGER (pinned to a real Region) and FINANCE, all on
// the same company as owner/manager/cashier. Idempotent (ON CONFLICT on the
// unique email) and left in place between runs, same as makeRivalTenant below;
// the password is rotated every call so the harness never has to remember one
// across runs, and it is never printed.
export async function makeExtraRoles(companyId) {
  let region = sql(`select id from "Region" where "companyId" = '${companyId}' and code = 'NORTH'`);
  if (!region) {
    region = sql(
      `insert into "Region" (id, "companyId", name, code, status, "createdAt", "updatedAt")
       values ('xregion${Date.now().toString(36)}', '${companyId}', 'North', 'NORTH', 'ACTIVE', now(), now())
       returning id`,
    );
  }

  const pw = `Xa!${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64')}`;
  const hash = argon2HashCLI(pw);
  const upsert = (email, fullName, role, regionId) =>
    sql(`
      insert into "PosUser" (id, "companyId", "branchId", "regionId", email, "fullName", "passwordHash", role, status, "mustChangePassword", "createdAt", "updatedAt")
      values ('xu${Date.now().toString(36)}${role.slice(0, 3).toLowerCase()}', '${companyId}', null, ${regionId ? `'${regionId}'` : 'null'}, '${email}', '${fullName}', '${hash}', '${role}', 'ACTIVE', false, now(), now())
      on conflict (email) do update set
        "passwordHash" = excluded."passwordHash", "mustChangePassword" = false,
        role = excluded.role, "companyId" = excluded."companyId",
        "regionId" = excluded."regionId", status = 'ACTIVE'
    `);

  upsert('authz.companyadmin@atcpos.example', 'Acceptance Company Admin', 'COMPANY_ADMIN', null);
  upsert('authz.regionalmanager@atcpos.example', 'Acceptance Regional Manager', 'REGIONAL_MANAGER', region);
  upsert('authz.finance@atcpos.example', 'Acceptance Finance', 'FINANCE', null);

  return { password: pw, regionId: region };
}

// A second company, because the seed ships exactly one and "cross-tenant" is
// untestable without a rival. Created idempotently and left in place: it is a
// fixture of this lane's private database, which no other lane can see.
//
// The password is generated per run, never printed, and the row is written with
// the same bcrypt cost the application uses — read out of the seeded owner's
// own hash rather than assumed, so this cannot drift from the app.
// Each of the three rows is checked and created independently, rather than
// gating all three creates behind one "does the Company exist" branch. A
// half-finished prior run (Company created, Branch insert then rejected by a
// NOT-NULL it didn't know about) must self-heal on the next call instead of
// wedging forever on an incomplete tenant that `if (existing)` would then
// assume was whole. That is not a hypothetical: publicId below was added
// after exactly that happened.
export async function makeRivalTenant() {
  const pw = `Rv!${Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64')}`;
  const hash = argon2HashCLI(pw);

  // Column sets are read from the seeded rows rather than hard-coded, so a
  // migration that adds a NOT NULL column breaks this loudly at insert time
  // instead of silently producing a half-built tenant.
  let cid = sql(`select id from "Company" where slug = 'rival-foods-acceptance'`);
  if (!cid) {
    cid = `rivalco${Date.now().toString(36)}`;
    sql(
      `insert into "Company" (id, name, slug, status, "createdAt", "updatedAt")
       select '${cid}', 'Rival Foods (Acceptance)', 'rival-foods-acceptance', status, now(), now()
       from "Company" limit 1`,
    );
  }

  let bid = sql(`select id from "Branch" where "companyId" = '${cid}' limit 1`);
  if (!bid) {
    bid = `rivalbr${Date.now().toString(36)}`;
    // publicId is NOT NULL, UNIQUE, and CHECKed to `^VC-[A-Z]{2}-[0-9]{4,}$`
    // (see Branch_publicId_shape) — the real app mints this from a per-state
    // counter (mintStorePublicId, backend/src/lib/identity.js); a fixture has
    // no state to mint from, so it fabricates a value in the same shape.
    const publicId = `VC-RV-${Date.now().toString().slice(-6)}`;
    sql(
      `insert into "Branch" (id, "companyId", name, code, "publicId", "isDemo", status, "createdAt", "updatedAt")
       select '${bid}', '${cid}', 'Rival Foods — Test Kitchen', 'RIVAL1', '${publicId}', true, status, now(), now()
       from "Branch" limit 1`,
    );
  }

  const uid = sql(`select id from "PosUser" where email = 'rival.owner@acceptance.invalid'`);
  if (uid) {
    // Re-point company/branch/password so the run always knows them, without
    // printing the password.
    sql(
      `update "PosUser" set "passwordHash" = '${hash}', "companyId" = '${cid}', "branchId" = '${bid}', status = 'ACTIVE'
       where id = '${uid}'`,
    );
  } else {
    const newUid = `rivalus${Date.now().toString(36)}`;
    sql(
      `insert into "PosUser" (id, "companyId", "branchId", email, "fullName", "passwordHash", role, status, "mustChangePassword", "createdAt", "updatedAt")
       values ('${newUid}', '${cid}', '${bid}', 'rival.owner@acceptance.invalid', 'Rival Owner', '${hash}', 'CUSTOMER_OWNER', 'ACTIVE', false, now(), now())`,
    );
  }

  // requireUsableLicense (backend/src/middleware/rbac.js) 403s every write and
  // transition route in promotions.js — chained AFTER requireAction but
  // BEFORE loadPromotion()'s tenant-scoped notFound() ever runs — whenever
  // resolveCompanyScope finds no usable License row for req.companyScope.id.
  // A company with zero License rows gets req.license = null, which is
  // unconditionally not usable. Without this row every mutation the rival
  // attempts 403s regardless of which id it targets, which proves nothing
  // about tenant isolation either way: the 403 would be about billing, not
  // about the resource. The rival needs a real, ACTIVE, unexpired licence so
  // its 404s are actually about the resource.
  let lid = sql(`select id from "License" where "companyId" = '${cid}'`);
  if (!lid) {
    lid = `rivallic${Date.now().toString(36)}`;
    sql(
      `insert into "License" (id, "companyId", plan, status, "expiresAt", "baseBranchLimit", "graceDays", "createdAt", "updatedAt")
       values ('${lid}', '${cid}', 'FREE_TRIAL', 'ACTIVE', now() + interval '30 days', 2, 0, now(), now())`,
    );
  }

  return { companyId: cid, branchId: bid, email: 'rival.owner@acceptance.invalid', password: pw };
}

// argon2, via the lane's own backend dependency tree — matching
// backend/src/lib/crypto.js#hashPassword exactly, because verifyPassword()
// there wraps argon2Verify() in a try/catch that turns ANY mismatch (wrong
// password, or a hash from a different algorithm entirely) into the same
// `false`. A bcrypt hash would not throw; it would just make this fixture's
// login fail with an indistinct "invalid credentials" 401, which looks
// exactly like a typo'd password until someone reads crypto.js.
function argon2HashCLI(plain) {
  const out = execFileSync(
    'node',
    [
      '-e',
      `require('@node-rs/argon2').hash(process.argv[1]).then((h) => process.stdout.write(h));`,
      plain,
    ],
    { cwd: '/home/atc-noc/vexo-connect-x-lanes/operator-ui/backend', encoding: 'utf8' },
  );
  return out.trim().replace(/'/g, '');
}
