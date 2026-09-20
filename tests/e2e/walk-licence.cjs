// ATC POS phase-2 dev walkthrough — Part D: licensing enforcement.
//
// Runs ONLY inside a dedicated dev test tenant (slug pos-licence-test, isDemo).
// The demo tenant (demo-brew-street) is never read or written, and no order,
// payment or refund row is created anywhere. The tenant, its branch, its
// licence and a fresh disposable owner are provisioned by this script against
// the DEV database; the owner password is generated in memory and never
// printed. Residue per run: one extra owner user inside the test tenant.
//
// Why this talks to the database instead of the ATC admin API:
//   1. EXPIRED is *derived* (storedStatus ACTIVE + expiresAt in the past) and
//      no API accepts a past expiresAt, so a genuine EXPIRED state cannot be
//      produced through the API at all.
//   2. It needs no seed/admin password, so the licence check runs unattended.
//
// Enforcement distinguisher (the test tenant has no catalog, so no UI taps):
//   blocked : Sell banner shown + POST /api/orders -> 403 POS_LICENSE_<state>
//   usable  : Sell banner absent + POST /api/orders -> 400 (branchId required)
//             — the request PASSED the licence gate and reached validation.
//
// Legs, in one run: ACTIVE -> EXPIRED -> ACTIVE -> SUSPENDED -> ACTIVE.
// The licence's original storedStatus and exact expiresAt are captured first
// and written to a recovery file, which must be readable BEFORE anything is
// changed. Restore runs on normal exit and on SIGINT/SIGTERM, is verified by
// reading the row back, and a failed restore exits nonzero with the recovery
// file left in place. Shots: <shots>/d-*.png
//
// Env: DATABASE_URL (dev DB, required) · POS_E2E_BASE · POS_E2E_SHOTS
//      POS_E2E_RECOVERY (recovery file path)
//      POS_E2E_BACKEND_MODULES (where @prisma/client lives)
//      POS_E2E_DEV_DB_PORT (loopback port of the dev DB; default 5439)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BASE, SHOTS, launchBrowser } = require('./env.cjs');

const SLUG = 'pos-licence-test';
const PAST = new Date('2020-01-01T00:00:00.000Z');
const RECOVERY = process.env.POS_E2E_RECOVERY || '/tmp/pos-licence-test-recovery.json';
const DEV_DB_PORT = process.env.POS_E2E_DEV_DB_PORT || '5439';

const log = (s) => process.stdout.write(s + '\n');
const stop = (msg) => { log('STOP: ' + msg); process.exit(2); };

// --- guard: this script writes to a database, so prove it is the dev one ----
// pos-prod-postgres-1 publishes no host port, so a loopback DSN on the dev
// port cannot be production. A wrong DATABASE_URL stops the run, it does not
// get "handled".
const dsn = process.env.DATABASE_URL;
if (!dsn) stop('DATABASE_URL is not set (point it at the dev database)');
let parsed;
try { parsed = new URL(dsn); } catch { stop('DATABASE_URL is not a valid URL'); }
if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
  stop(`DATABASE_URL host is "${parsed.hostname}"; this script only runs against a loopback dev database`);
}
if (parsed.port !== DEV_DB_PORT) {
  stop(`DATABASE_URL port is "${parsed.port}", expected the dev database port ${DEV_DB_PORT}`);
}
if (process.env.NODE_ENV === 'production') stop('NODE_ENV=production');

const BACKEND_MODULES = process.env.POS_E2E_BACKEND_MODULES || path.resolve(__dirname, '../../backend/node_modules');
const requireBackend = (name) => {
  try {
    return require(path.join(BACKEND_MODULES, name));
  } catch {
    return stop(`cannot resolve ${name}; set POS_E2E_BACKEND_MODULES to the backend node_modules dir`);
  }
};
const { PrismaClient } = requireBackend('@prisma/client');
const { hash: argon2Hash } = requireBackend('@node-rs/argon2');

fs.mkdirSync(SHOTS, { recursive: true });

const prisma = new PrismaClient();
const consoleErrors = [];
const badResponses = [];
let shotN = 0;
let fails = 0;
const errCode = (j) => (j && j.error ? j.error.code : j && j.code);

// --- restore state ----------------------------------------------------------
let ARMED = false;        // true only once the licence has actually been changed
let RESTORED = false;
let original = null;      // { id, status, expiresAt }

const restoreLicence = async () => {
  if (!ARMED || RESTORED) return true;
  try {
    await prisma.license.update({
      where: { id: original.id },
      data: { status: original.status, expiresAt: original.expiresAt },
    });
    const back = await prisma.license.findUnique({
      where: { id: original.id },
      select: { status: true, expiresAt: true },
    });
    const sameStatus = back && back.status === original.status;
    const sameExpiry =
      back && (back.expiresAt === null ? original.expiresAt === null : back.expiresAt.getTime() === original.expiresAt.getTime());
    if (!sameStatus || !sameExpiry) {
      log(`RESTORE-FAILED: licence ${original.id} reads status=${back && back.status} expiresAt=${back && back.expiresAt && back.expiresAt.toISOString()}`);
      return false;
    }
    RESTORED = true;
    log(`restored licence ${original.id} to status=${original.status} expiresAt=${original.expiresAt ? original.expiresAt.toISOString() : 'null'} (verified by read-back)`);
    return true;
  } catch (e) {
    log('RESTORE-FAILED: ' + String(e.message || e).split('\n')[0]);
    return false;
  }
};

const bail = async (code) => {
  const ok = await restoreLicence();
  if (!ok) {
    log(`recovery file kept at ${RECOVERY} — restore the licence with the command inside it`);
    code = code || 1;
  } else if (ARMED) {
    try { fs.unlinkSync(RECOVERY); } catch {}
  }
  await prisma.$disconnect().catch(() => {});
  process.exit(code);
};
// Interruption must END the run — never fall through into the next leg.
process.on('SIGINT', () => { log('\ninterrupted (SIGINT)'); bail(130); });
process.on('SIGTERM', () => { log('\nterminated (SIGTERM)'); bail(143); });

async function main() {
  // --- provision the test tenant (nothing outside it is touched) ------------
  let company = await prisma.company.findUnique({ where: { slug: SLUG } });
  if (!company) {
    company = await prisma.company.create({ data: { name: 'Licence Test (Dev)', slug: SLUG, isDemo: true } });
  }
  if (company.slug !== SLUG) throw new Error('refusing: resolved company is not the test tenant');
  if (!(await prisma.branch.findFirst({ where: { companyId: company.id } }))) {
    await prisma.branch.create({
      data: { companyId: company.id, name: 'Licence Test Branch', code: 'LT-1', isDemo: true },
    });
  }
  let lic = await prisma.license.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: 'desc' } });
  if (!lic) {
    lic = await prisma.license.create({
      data: {
        companyId: company.id,
        plan: 'FREE_TRIAL',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        notes: 'dev licence-enforcement test tenant',
      },
    });
  }
  log(`test tenant ${SLUG} ready (demo tenant untouched); licence ${lic.id}`);

  // A licence left blocked by a crashed earlier run is repaired here, BEFORE
  // the original state is captured — otherwise we would faithfully restore a
  // broken state at the end.
  if (lic.status !== 'ACTIVE' || !lic.expiresAt || lic.expiresAt.getTime() <= Date.now()) {
    log(`pre-state was status=${lic.status} expiresAt=${lic.expiresAt && lic.expiresAt.toISOString()} — repairing to ACTIVE before capture (residue of an earlier run)`);
    lic = await prisma.license.update({
      where: { id: lic.id },
      data: { status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
    });
  }
  original = { id: lic.id, status: lic.status, expiresAt: lic.expiresAt };

  // --- recovery record, written and proven readable BEFORE any change -------
  const expiryIso = original.expiresAt ? original.expiresAt.toISOString() : null;
  const record = {
    writtenAt: new Date().toISOString(),
    tenant: SLUG,
    licenseId: original.id,
    originalStatus: original.status,
    originalExpiresAt: expiryIso,
    note: 'If this file still exists, the licence of the DEV test tenant may be left blocked. It does not affect the demo tenant or production.',
    recoveryCommand:
      `docker exec atc-pos-dev-db psql -U atc_pos -d atc_pos -v ON_ERROR_STOP=1 -c ` +
      `"UPDATE \\"License\\" SET status='${original.status}', \\"expiresAt\\"=` +
      `${expiryIso ? `'${expiryIso}'` : 'NULL'} WHERE id='${original.id}';"`,
  };
  fs.writeFileSync(RECOVERY, JSON.stringify(record, null, 2));
  const readBack = JSON.parse(fs.readFileSync(RECOVERY, 'utf8'));
  if (readBack.licenseId !== original.id || readBack.originalStatus !== original.status || readBack.originalExpiresAt !== expiryIso) {
    throw new Error(`recovery file at ${RECOVERY} did not read back correctly — refusing to change the licence`);
  }
  log(`recovery record written and read back: ${RECOVERY}`);

  // --- disposable owner, password in memory only ---------------------------
  const ownerEmail = `licowner-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@atcpos.example`;
  const ownerPw = 'Lt-' + crypto.randomBytes(12).toString('base64url');
  await prisma.posUser.create({
    data: {
      email: ownerEmail,
      fullName: 'Licence Test Owner',
      role: 'CUSTOMER_OWNER',
      companyId: company.id,
      passwordHash: await argon2Hash(ownerPw),
    },
  });

  // --- browser plumbing -----------------------------------------------------
  const browser = await launchBrowser(log);
  let shotPage = null;
  const newPage = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
    return { ctx, page };
  };
  const shot = async (name) => {
    if (!shotPage) return;
    shotN += 1;
    await shotPage.screenshot({ path: `${SHOTS}/d-${String(shotN).padStart(2, '0')}-${name}.png` });
  };
  const step = async (name, fn) => {
    try {
      await fn();
      log(`PASS ${name}`);
    } catch (e) {
      fails += 1;
      log(`FAIL ${name}: ${String(e.message || e).split('\n')[0]}`);
      try { await shot('FAIL-' + name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)); } catch {}
    }
  };
  const signIn = async (page) => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await page.fill('#email', ownerEmail);
    await page.fill('#password', ownerPw);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15000 });
  };
  const probeOrders = async (ctx) => {
    // requireUsableLicense runs before validation, so a dummy body is enough.
    const r = await ctx.request.post(`${BASE}/api/orders`, {
      data: { type: 'TAKEAWAY', items: [{ productId: 'licence-check', qty: 1 }] },
    });
    return { status: r.status(), code: errCode(await r.json().catch(() => ({}))) };
  };

  const blockedLeg = async (label, expectCode) => {
    const b = await newPage();
    shotPage = b.page;
    await step(`${label}: owner signs in`, () => signIn(b.page));
    await step(`${label}: sell screen shows the licence banner`, async () => {
      await b.page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
      await b.page.waitForSelector('text=does not allow POS actions');
      await shot(`${label}-banner`);
    });
    await step(`${label}: POST /api/orders -> 403 ${expectCode}`, async () => {
      const { status, code } = await probeOrders(b.ctx);
      if (status !== 403) throw new Error(`expected 403, got ${status}`);
      if (code !== expectCode) throw new Error(`403 code ${code}, wanted ${expectCode}`);
    });
    await b.ctx.close();
    shotPage = null;
  };

  const usableLeg = async (label) => {
    const c = await newPage();
    shotPage = c.page;
    await step(`${label}: owner signs in`, () => signIn(c.page));
    await step(`${label}: sell screen has no licence banner`, async () => {
      await c.page.goto(BASE + '/sell', { waitUntil: 'domcontentloaded' });
      await c.page.waitForSelector('#sell-branch');
      const t = await c.page.evaluate(() => document.body.innerText);
      if (t.includes('does not allow POS actions')) throw new Error('licence banner still shown');
      await shot(`${label}-no-banner`);
    });
    await step(`${label}: POST /api/orders reaches validation (400, not a licence 403)`, async () => {
      const { status, code } = await probeOrders(c.ctx);
      if (status !== 400) throw new Error(`expected 400 past the licence gate, got ${status}`);
      if (String(code).startsWith('POS_LICENSE_')) throw new Error(`still licence-blocked: ${code}`);
    });
    await c.ctx.close();
    shotPage = null;
  };

  try {
    await usableLeg('active');

    // EXPIRED: derived, so only the stored expiry moves. storedStatus stays ACTIVE.
    await step('induce EXPIRED (expiry moved to a fixed past timestamp)', async () => {
      ARMED = true;
      const u = await prisma.license.update({ where: { id: original.id }, data: { expiresAt: PAST } });
      if (u.expiresAt.getTime() !== PAST.getTime()) throw new Error('expiry write did not take');
      if (u.status !== 'ACTIVE') throw new Error(`storedStatus changed to ${u.status}; EXPIRED must be derived`);
    });
    await blockedLeg('expired', 'POS_LICENSE_EXPIRED');

    await step('put the original expiry back', async () => {
      const u = await prisma.license.update({ where: { id: original.id }, data: { expiresAt: original.expiresAt } });
      if (u.expiresAt.getTime() !== original.expiresAt.getTime()) throw new Error('expiry restore did not take');
    });

    // SUSPENDED: stored status, the lever the ATC console actually uses.
    await step('induce SUSPENDED', async () => {
      const u = await prisma.license.update({ where: { id: original.id }, data: { status: 'SUSPENDED' } });
      if (u.status !== 'SUSPENDED') throw new Error('status write did not take');
    });
    await blockedLeg('suspended', 'POS_LICENSE_SUSPENDED');
  } finally {
    const ok = await restoreLicence();
    if (!ok) {
      fails += 1;
      log(`WARNING: the DEV test tenant licence is NOT restored. Recovery file: ${RECOVERY}`);
      log('The demo tenant and production are unaffected.');
    }
  }

  // Only meaningful once the restore above verified: proves the tenant is
  // usable again through the same path that saw it blocked.
  if (RESTORED) await usableLeg('restored');
  else { log('SKIP restored leg: restore not verified'); }

  await browser.close();

  if (RESTORED) { try { fs.unlinkSync(RECOVERY); } catch {} }

  log('---');
  log(`tenant ${SLUG}; legs: active -> expired(403) -> suspended(403) -> restored`);
  log(`licence restored and verified: ${RESTORED}`);
  log(`steps failed: ${fails}`);
  const realErrors = consoleErrors.filter((e) => !/401|403|400|409/.test(e));
  log(`page/console errors (unexpected): ${realErrors.length}`);
  realErrors.slice(0, 10).forEach((e) => log('  ' + e.slice(0, 200)));
  const unexpected5xx = badResponses.filter((r) => /^5\d\d /.test(r));
  log(`http 5xx: ${unexpected5xx.length}`);
  unexpected5xx.slice(0, 10).forEach((r) => log('  ' + r));
  log(`http 4xx seen (expected: /auth/me probes 401 + deliberate 403/400): ${badResponses.length - unexpected5xx.length}`);
  process.exitCode = fails > 0 || unexpected5xx.length > 0 || !RESTORED ? 1 : 0;
}

main()
  .catch(async (e) => {
    log('FATAL ' + (e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | '));
    const ok = await restoreLicence();
    if (!ok && ARMED) log(`recovery file kept at ${RECOVERY}`);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
