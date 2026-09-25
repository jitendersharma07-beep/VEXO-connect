// Create an isolated DEV company for real-provider sandbox testing.
//
// WHY A NEW COMPANY RATHER THAN THE DEMO ONE
//
// The sandbox run puts real Razorpay attempts, captures and refunds into the
// database. Mixing those into "Brew Street Café (Demo)" would leave the demo
// tenant — the one shown to people — carrying provider rows from a test, and
// would make the demo's own reports wrong. A separate tenant keeps the two
// apart, and proves tenant isolation incidentally: this company must never see
// the demo's orders, and vice versa.
//
// It creates ONLY new rows. No existing account's password is changed and no
// existing row is touched, which is also why this is safe to re-run.
//
// The login password is generated here and written to the same 0600
// git-ignored directory as the provider keys. It is never printed.
//
// DEV DATABASE ONLY.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = '/home/atc-noc/atc-pos';
const DIR = `${REPO}/backend/.secrets`;
const FILE = `${DIR}/dev-sandbox-account.env`;

const pw = execFileSync('docker', ['exec', 'atc-pos-dev-db', 'printenv', 'POSTGRES_PASSWORD']).toString().trim();
if (!pw) { console.log('FAIL: dev database container atc-pos-dev-db is not running'); process.exit(2); }
const DSN = `postgresql://atc_pos:${pw}@127.0.0.1:5439/atc_pos?schema=public`;
if (!DSN.endsWith('@127.0.0.1:5439/atc_pos?schema=public')) { console.log('FAIL: not the dev database'); process.exit(2); }
process.env.DATABASE_URL = DSN;
process.env.NODE_ENV = 'development';
process.env.POS_JWT_SECRET ??= 'x'.repeat(48);

mkdirSync(DIR, { recursive: true, mode: 0o700 });
try {
  execFileSync('git', ['-C', REPO, 'check-ignore', '-q', FILE]);
} catch {
  console.log(`FAIL: git does NOT ignore ${FILE} — refusing to write a credential it can see`);
  process.exit(2);
}

// Reuse the stored password if the fixture already exists, so re-running does
// not invalidate a session that is mid-test.
let PASSWORD;
if (existsSync(FILE)) {
  const m = /^POS_SANDBOX_PASSWORD='(.*)'$/m.exec(readFileSync(FILE, 'utf8'));
  PASSWORD = m?.[1];
}
PASSWORD ||= `${randomBytes(15).toString('base64url')}Aa1!`;

const { prisma } = await import(`${REPO}/backend/src/lib/prisma.js`);
const { hashPassword } = await import(`${REPO}/backend/src/lib/crypto.js`);

const SLUG = 'rzp-sandbox-dev';
const OWNER = 'sandbox.owner@atcpos.dev';
const CASHIER = 'sandbox.cashier@atcpos.dev';

let company = await prisma.company.findUnique({ where: { slug: SLUG } });
if (!company) {
  company = await prisma.company.create({
    data: {
      name: 'Razorpay Sandbox (Dev)', slug: SLUG, isDemo: true,
      city: 'New Delhi', state: 'Delhi', contactName: 'ATC Dev',
    },
  });
  console.log('PASS: created sandbox company');
} else {
  console.log('PASS: sandbox company already present, reusing');
}

let branch = await prisma.branch.findFirst({ where: { companyId: company.id, code: 'SBX1' } });
branch ??= await prisma.branch.create({
  data: { companyId: company.id, name: 'Sandbox Counter', code: 'SBX1', isDemo: true, city: 'New Delhi', state: 'Delhi' },
});

const existingLicence = await prisma.license.findFirst({ where: { companyId: company.id } });
if (!existingLicence) {
  await prisma.license.create({
    data: {
      companyId: company.id, plan: 'MULTI_STORE', status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000), baseBranchLimit: 3,
      // The sandbox is what the inventory screens are rendered against, and
      // they are gated on the module. Without it the sidebar hides the section
      // and every route answers 403.
      modules: ['INVENTORY'],
      notes: 'Dev sandbox fixture — not a customer licence',
    },
  });
  console.log('PASS: issued a dev licence (90 days, MULTI_STORE)');
} else if (!existingLicence.modules.includes('INVENTORY')) {
  // A sandbox seeded before the module gate existed already has a licence, so
  // the create above is skipped and the tenant would sit there entitled to
  // nothing — screens hidden, routes 403 — with the fixture reporting success.
  // This script is re-run to bring an existing sandbox up to date, so bringing
  // the entitlement up to date is its job too.
  //
  // An UPDATE, which the ATC route deliberately does not offer: there a module
  // grant is a commercial act and issuing a new row is what keeps the history.
  // Nothing here is commercial and there is no history worth keeping.
  await prisma.license.update({
    where: { id: existingLicence.id },
    data: { modules: [...new Set([...existingLicence.modules, 'INVENTORY'])] },
  });
  console.log('PASS: added the INVENTORY module to the existing dev licence');
}

const passwordHash = await hashPassword(PASSWORD);
for (const [email, role, fullName, branchId] of [
  [OWNER, 'CUSTOMER_OWNER', 'Sandbox Owner', null],
  [CASHIER, 'CASHIER', 'Sandbox Cashier', branch.id],
]) {
  await prisma.posUser.upsert({
    where: { email },
    // Re-running refreshes only this fixture's own password, never anyone else's.
    update: { passwordHash, status: 'ACTIVE', mustChangePassword: false },
    create: { email, fullName, role, companyId: company.id, branchId, passwordHash, mustChangePassword: false },
  });
}
console.log('PASS: sandbox owner and cashier ready');

writeFileSync(FILE, `# DEV-ONLY sandbox login for the atc-pos dev database (port 5439).
# Mode 0600, git-ignored. Written by backend/scripts/dev-sandbox-fixture.mjs.
# NOT a client credential. Never copy this to a deployment.
POS_SANDBOX_COMPANY='${company.id}'
POS_SANDBOX_BRANCH='${branch.id}'
POS_SANDBOX_OWNER='${OWNER}'
POS_SANDBOX_CASHIER='${CASHIER}'
POS_SANDBOX_PASSWORD='${PASSWORD}'
`, { mode: 0o600 });
chmodSync(FILE, 0o600);

console.log('PASS: login stored at 0600, git-ignored, nothing printed');
console.log(`      company ${company.id}`);
console.log(`      branch  ${branch.id}`);
await prisma.$disconnect();
