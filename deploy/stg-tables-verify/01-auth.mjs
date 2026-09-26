// Phase 1 — login, the forced password change, and role isolation, against the
// DEPLOYED stack.
//
// WHY THIS IS NOT REDUNDANT WITH THE UNIT SUITE. The 1767 tests already prove
// these routes against the code. This proves them against *this deployment*:
// through the nginx /pos/ prefix strip, the cookie-path rewrite, the real
// image's compiled Prisma client and the real migrated database. Those are
// different claims and the standing rule is not to conflate them.
//
// Tokens are written to .tokens.json at 0600 for the later phases, so no phase
// re-logins and burns the rate limiter.
//
// ONE CORRECTION IS RECORDED HERE RATHER THAN QUIETLY FIXED. A first draft
// asserted `mustChangePassword === false` and got four red checks. The app was
// right and the assertion was wrong: the seed mints generated passwords and so
// correctly demands a change (prisma/seed.js:58). The flag is asserted TRUE
// below, then cleared the way an operator would.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { api, check, note, summary, saveJson, readCreds, SECRETS } from './lib.mjs';

// Re-runnable: once passwords have been rotated the originals no longer work,
// so prefer the rotated file when it exists.
const ROTATED = path.join(SECRETS, 'creds-rotated.txt');
const rotatedAlready = fs.existsSync(ROTATED);
const creds = readCreds(rotatedAlready ? 'creds-rotated.txt' : 'creds.txt');
note(rotatedAlready ? 'using already-rotated credentials' : 'using seed credentials, will rotate');

const tokens = {};
const ids = {};

// The login limiter is 10 failures / 15 min / IP (middleware/rateLimit.js).
// Negative auth cases are therefore RATIONED: exactly two, and they run LAST so
// a lockout cannot poison the positive path.
note('login limiter is 10 failures/15min/IP — exactly 2 negative logins, run last');

const expectRole = {
  'admin@stgtbl.invalid': 'POS_SUPER_ADMIN',
  'demo.owner@atcpos.example': 'CUSTOMER_OWNER',
  'demo.manager@atcpos.example': 'BRANCH_MANAGER',
  'demo.cashier@atcpos.example': 'CASHIER',
};

const login = async (email, password) =>
  api('/api/auth/login', { method: 'POST', body: { email, password } });

// --- the accept path, all four seeded roles --------------------------------
for (const [email, password] of creds) {
  const r = await login(email, password);
  const ok = check(
    `login ${email} → 200`,
    r.status === 200 && typeof r.body?.token === 'string' && r.body.token.length > 20,
    r.status === 200 ? `ctype=${r.ctype}` : `status=${r.status}`,
  );
  if (!ok) continue;
  check(`  ...role is ${expectRole[email]}`, r.body.user?.role === expectRole[email],
    r.body.user?.role === expectRole[email] ? '' : `got ${r.body.user?.role}`);
  // The seed forces a change on generated credentials. Assert the flag in the
  // state it SHOULD be in, which differs before and after rotation.
  const wantFlag = !rotatedAlready;
  check(`  ...mustChangePassword is ${wantFlag} (${wantFlag ? 'seed forces a change' : 'cleared by rotation'})`,
    r.body.user?.mustChangePassword === wantFlag,
    r.body.user?.mustChangePassword === wantFlag ? '' : `got ${r.body.user?.mustChangePassword}`);
  // The password must never come back in any field. Detail ONLY on failure —
  // a detail printed on the pass line reads like the failure it is not.
  const echoed = JSON.stringify(r.body).toLowerCase().includes(password.toLowerCase());
  check('  ...response body does not echo the password', !echoed, echoed ? 'ECHOED' : '');
  tokens[expectRole[email]] = r.body.token;
  ids[expectRole[email]] = {
    userId: r.body.user?.id,
    companyId: r.body.user?.companyId,
    branchId: r.body.user?.branchId,
  };
}

// --- the forced change does NOT lock the user out of ordinary work ----------
// It gates discount APPROVAL only (lib/discountGuard.js:210), which phase 3
// exercises. Proving here that it does not gate ordinary reads means a later
// 403 cannot be blamed on it.
if (!rotatedAlready) {
  const r = await api('/api/auth/me', { token: tokens.CASHIER });
  check('mustChangePassword does not block ordinary reads (it gates discount approval only)',
    r.status === 200, `got ${r.status}`);
}

// --- rotate, the way a real first sign-in would ----------------------------
if (!rotatedAlready) {
  const lines = [];
  for (const [email, password] of creds) {
    const role = expectRole[email];
    if (!tokens[role]) continue;
    // Generated here, never printed. base64url of 24 random bytes.
    const next = crypto.randomBytes(24).toString('base64url');
    const r = await api('/api/auth/change-password', {
      method: 'POST',
      token: tokens[role],
      body: { currentPassword: password, newPassword: next },
    });
    if (!check(`change-password ${role} → 200`, r.status === 200 && r.body?.ok === true, `got ${r.status}`)) continue;
    lines.push(`${email} ${next}`);
    // The route revokes every OTHER session for the user, so the current token
    // must still work and a re-login must succeed on the NEW password only.
    const again = await login(email, next);
    check(`  ...re-login on the new password → 200, flag now false`,
      again.status === 200 && again.body?.user?.mustChangePassword === false,
      again.status === 200 ? '' : `got ${again.status}`);
    if (again.status === 200) tokens[role] = again.body.token;
  }
  fs.writeFileSync(ROTATED, lines.join('\n') + '\n', { mode: 0o600 });
  note(`rotated credentials written to secrets/creds-rotated.txt (0600), ${lines.length} accounts`);
}

// --- /me round-trips the token through the real deployment -----------------
for (const [role, token] of Object.entries(tokens)) {
  const r = await api('/api/auth/me', { token });
  check(`/api/auth/me as ${role} → 200 and same role`,
    r.status === 200 && r.body?.user?.role === role,
    r.status === 200 ? '' : `status=${r.status}`);
}

// --- role isolation --------------------------------------------------------
// The assertion is "refused with 403", not "200 is absent" — a 404 from an
// unmounted route would pass a sloppier check, so controls below prove the
// routes exist and that 403 is not this app's catch-all.
note('role isolation — refusals must be 403 (authenticated but not permitted), not 404');

const isolation = [
  ['CASHIER', 'GET', '/api/users', 403],
  ['CASHIER', 'POST', '/api/branches', 403, { name: 'should-never-exist', code: 'SNE' }],
  ['CASHIER', 'POST', '/api/catalog/categories', 403, { name: 'should-never-exist' }],
  ['CASHIER', 'GET', '/api/reports/activity', 403],
  ['BRANCH_MANAGER', 'POST', '/api/branches', 403, { name: 'should-never-exist-2', code: 'SNE2' }],
];

for (const [role, method, p, want, body] of isolation) {
  const token = tokens[role];
  if (!token) { check(`isolation ${role} ${method} ${p}`, false, 'no token'); continue; }
  const r = await api(p, { method, token, body });
  check(`${role} ${method} ${p} → ${want}`, r.status === want, r.status === want ? '' : `got ${r.status}`);
}

// --- the controls that make those 403s mean something ---------------------
{
  const r = await api('/api/users', { token: tokens.CUSTOMER_OWNER });
  check('control: CUSTOMER_OWNER GET /api/users → 200, so the CASHIER 403 is a permission and not a 404',
    r.status === 200, r.status === 200 ? '' : `got ${r.status}`);
}
{
  const r = await api('/api/users-does-not-exist', { token: tokens.CUSTOMER_OWNER });
  check("control: a bogus sibling route → 404, so 403 is not this app's catch-all",
    r.status === 404, r.status === 404 ? '' : `got ${r.status}`);
}
// And nothing the refusals above attempted may have actually landed.
{
  const r = await api('/api/branches', { token: tokens.CUSTOMER_OWNER });
  const names = (Array.isArray(r.body) ? r.body : r.body?.branches ?? []).map((b) => b.name);
  check('control: neither refused POST created a branch (still 2)',
    names.length === 2 && !names.some((n) => String(n).startsWith('should-never-exist')),
    `branches=${names.length}`);
}

// --- tenant scope ---------------------------------------------------------
{
  const owner = ids.CUSTOMER_OWNER;
  const cashier = ids.CASHIER;
  check('cashier and owner resolve to the same company (the seed builds one tenant)',
    !!owner?.companyId && owner.companyId === cashier?.companyId, '');
  check('CASHIER is pinned to a branch, so branch scope has something to enforce',
    !!cashier?.branchId, '');
}

// --- the two rationed negative logins, last ------------------------------
{
  const email = [...creds.keys()][0];
  const r = await login(email, 'wrong-password-on-purpose');
  check('a wrong password is refused (401)', r.status === 401, r.status === 401 ? '' : `got ${r.status}`);
  check('  ...and the refusal does not disclose whether the email exists',
    !/no such user|unknown email|not found|does not exist/i.test(JSON.stringify(r.body ?? '')),
    JSON.stringify(r.body?.error?.message ?? ''));
}
{
  const r = await api('/api/auth/me', { token: 'garbage.token.value' });
  check('a garbage bearer is refused (401)', r.status === 401, r.status === 401 ? '' : `got ${r.status}`);
}

saveJson('.tokens.json', tokens);
saveJson('.ids.json', ids);
note('tokens saved to verify/.tokens.json (0600) for the later phases');

process.exit(summary('Phase 1 — login, forced change, role isolation') ? 1 : 0);
