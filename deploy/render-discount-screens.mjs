#!/usr/bin/env node
// Drives the discount feature through a real browser and checks every claim
// against the database.
//
// backend/tests/discountSettings.test.js already proves the rules hold when
// supertest asks. This file exists because supertest cannot see a screen. It
// asks the questions a screenshot can answer and a unit test cannot: is the
// settings page actually reachable and does the owner's typing reach the
// table; does the till TELL a cashier their limit before they type a number;
// and when the server refuses, does a prompt appear, does the wrong manager
// get turned away, does the right one get through.
//
//   cd deploy && node ./seed-discount-render.mjs \
//     && BASE_URL=http://127.0.0.1:5182 node ./render-discount-screens.mjs
//
// Run it from deploy/, as above. An earlier note here claimed this environment
// refuses to run the file at all; it refuses `node deploy/<script>` from the
// repo root and accepts `./<script>` from inside deploy/, which is a different
// thing. It has since been run: 39/39 green against backend :5011 + vite :5182.
//
// DATABASE_URL and RENDER_PASSWORD come from the env file below, not the
// command line. Expects deploy/seed-discount-render.mjs to have just run.
// PASS/FAIL lines only — the password is typed into the form and never
// printed. Exit 0 = all green.

import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

// Same mode-600 file the seed reads. The approver password is typed into a
// browser form and must never reach argv, the shell history, or this output.
const ENV_FILE = process.env.RENDER_ENV_FILE || '/tmp/discount-render.env';
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^export ([A-Z_]+)='(.*)'$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
} catch {
  console.error(`FAIL: cannot read ${ENV_FILE}`);
  process.exit(1);
}

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5177').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-discount-screens';
const CHROME = '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';
const PW = process.env.RENDER_PASSWORD;

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  console.error('FAIL: render requires a DATABASE_URL ending in _test');
  process.exit(1);
}
if (!PW) {
  console.error('FAIL: export RENDER_PASSWORD');
  process.exit(1);
}

const { prisma } = await import('../backend/src/lib/prisma.js');

mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log(`FAIL page-error — ${e.message}`));

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

// Prisma hands back Decimal objects, which are never === a number.
const pctOf = (d) => (d === null || d === undefined ? d : Number(d));

const login = async (email) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  // Sign-in is an XHR, not a navigation, so the page is ALREADY idle when the
  // click lands and waitForLoadState resolves immediately — before the session
  // cookie exists. Every later step then ran signed out and the whole file
  // reported the login screen as a missing feature. Wait for the thing that
  // only happens on success.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForURL(/\/(dashboard|sell)/, { timeout: 15000 });
  await page.waitForLoadState('networkidle');
};

const logout = async () => {
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
};

// A select whose empty value means "inherit"; 'yes'/'no' are the real answers.
const setTri = (id, v) => page.selectOption(`#${id}`, v);
const setNum = async (id, v) => {
  await page.fill(`#${id}`, '');
  if (v !== null) await page.fill(`#${id}`, String(v));
};

const saveModal = async () => {
  await page.click('form button[type="submit"]:has-text("Save")');
  await page.waitForTimeout(700);
};

const fox = await prisma.company.findFirst({ where: { slug: 'foxtrot-foods' } });
// The vitest suite wipes this same _test database, so a run that follows
// `npm test` finds nothing here and would otherwise die on a null id twelve
// lines later, reading like a product fault.
if (!fox) {
  console.error('FAIL: no fixture — run ./seed-discount-render.mjs first (npm test wipes this database)');
  process.exit(1);
}
// Section A is about the day the product is handed over: nothing configured.
// The file then types a policy in, so a second run over the same database has
// one already and A2/A5 go red — a setup problem wearing the costume of a
// feature failure. Refuse up front instead of reporting it as a finding.
const preexisting = await prisma.discountPolicy.count();
if (preexisting > 0) {
  console.error(`FAIL: ${preexisting} discount policies already exist — re-run ./seed-discount-render.mjs for a clean fixture`);
  process.exit(1);
}
const f1 = await prisma.branch.findFirst({ where: { companyId: fox.id, code: 'F1' } });
const f2 = await prisma.branch.findFirst({ where: { companyId: fox.id, code: 'F2' } });
const mgrF1 = await prisma.posUser.findFirst({ where: { email: 'mgr.f1@test.local' } });
const mgrF2 = await prisma.posUser.findFirst({ where: { email: 'mgr.f2@test.local' } });
const cashierF1 = await prisma.posUser.findFirst({ where: { email: 'cashier.f1@test.local' } });

// ---------------------------------------------------------------------------
// A. The owner opens a company that has configured nothing
// ---------------------------------------------------------------------------
await login('owner.f@test.local');
await page.goto(`${BASE}/discounts`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await shot('01-settings-unconfigured');

const bodyA = await page.textContent('body');
ok('A1 settings screen reachable by the owner', bodyA.includes('Discount permissions'));
ok(
  'A2 unconfigured company says so, and says the safe state is deliberate',
  bodyA.includes('Until this is set, only the owner may discount anything'),
);
ok('A3 both branches listed for override', bodyA.includes('Foxtrot One') && bodyA.includes('Foxtrot Two'));
ok('A4 staff listed', bodyA.includes('Manager F1') && bodyA.includes('Cashier F1'));
ok('A5 database still has no policy row', (await prisma.discountPolicy.count()) === 0);

// ---------------------------------------------------------------------------
// B. Company default: 10%, item and order discounts allowed
// ---------------------------------------------------------------------------
await page.click('[aria-label="Edit Everyone, unless overridden below"]');
await page.waitForTimeout(400);
await setTri('allow-line', 'yes');
await setTri('allow-order', 'yes');
await setNum('max-pct', 10);
await saveModal();
await shot('02-company-default-10pct');

const companyRow = await prisma.discountPolicy.findFirst({ where: { companyId: fox.id, branchId: null, userId: null } });
ok('B1 company default written by the screen', !!companyRow);
// The STORED column is maxPercent, a Decimal. maxPctMilli is what the
// resolver hands the till after merging the three levels, and does not exist
// on a row — reading it here returned undefined against every value and so
// could never have failed for the right reason.
ok('B2 stored as 10 percent', pctOf(companyRow?.maxPercent) === 10, `got ${companyRow?.maxPercent}`);
ok(
  'B3 a blank amount box is not a ceiling of zero',
  companyRow?.maxFlatPaise === null,
  `got ${companyRow?.maxFlatPaise}`,
);
ok('B4 both discount kinds allowed', companyRow?.allowLineDiscount === true && companyRow?.allowOrderDiscount === true);

// ---------------------------------------------------------------------------
// C. Branch override: Foxtrot Two goes to 20%, Foxtrot One is untouched
// ---------------------------------------------------------------------------
await page.click('[aria-label="Edit Foxtrot Two"]');
await page.waitForTimeout(400);
await setNum('max-pct', 20);
await saveModal();
await shot('03-branch-override-f2');

const f2Row = await prisma.discountPolicy.findFirst({ where: { companyId: fox.id, branchId: f2.id, userId: null } });
const f1Row = await prisma.discountPolicy.findFirst({ where: { companyId: fox.id, branchId: f1.id, userId: null } });
ok('C1 branch override written against the right branch', pctOf(f2Row?.maxPercent) === 20, `got ${f2Row?.maxPercent}`);
ok('C2 the other branch is NOT changed by it', f1Row === null);

// ---------------------------------------------------------------------------
// D. Staff grant: Manager F1 may approve up to 50%, without raising their own
// ---------------------------------------------------------------------------
await page.click('[aria-label="Edit Manager F1"]');
await page.waitForTimeout(400);
await setTri('can-approve', 'yes');
await setNum('max-appr-pct', 50);
await saveModal();
await shot('04-staff-approval-grant');

const mgrRow = await prisma.discountPolicy.findFirst({ where: { companyId: fox.id, userId: mgrF1.id } });
ok('D1 approval grant written', mgrRow?.canApprove === true);
ok('D2 approval ceiling 50 percent', pctOf(mgrRow?.maxApprovalPercent) === 50, `got ${mgrRow?.maxApprovalPercent}`);
ok(
  'D3 approving for others did NOT raise their own limit',
  mgrRow?.maxPercent === null,
  `got ${mgrRow?.maxPercent}`,
);

const bodyD = await page.textContent('body');
ok('D4 the screen reports the resolved approval ceiling', /50%/.test(bodyD));

// Manager F2 was never granted anything — the cross-branch case later needs a
// manager who CAN approve, so grant them the same 50% at their own branch.
await page.click('[aria-label="Edit Manager F2"]');
await page.waitForTimeout(400);
await setTri('can-approve', 'yes');
await setNum('max-appr-pct', 50);
await saveModal();
const mgr2Row = await prisma.discountPolicy.findFirst({ where: { companyId: fox.id, userId: mgrF2.id } });
ok('D5 Manager F2 also granted 50% approval, at their own branch', mgr2Row?.canApprove === true);

// ---------------------------------------------------------------------------
// E. The till tells the cashier their limit before they type a number
// ---------------------------------------------------------------------------
await logout();
await login('cashier.f1@test.local');
await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

// The till refuses to hold items before it knows what kind of order this is
// — "Choose Takeaway or pick a table first". Clicking the product without
// this leaves an empty cart, and every later step then hunts for a discount
// control on an order that does not exist.
await page.click('button:has-text("Takeaway")');
await page.waitForTimeout(700);
await page.click('text=Filter Coffee');
await page.waitForTimeout(1200);
await shot('05-till-with-item');

await page.click('[aria-label="Edit order discount"]');
await page.waitForTimeout(500);
await shot('06-till-ceiling-shown');

const bodyE = await page.textContent('body');
ok(
  'E1 the till states the cashier’s own ceiling, inherited from the company',
  /Your limit is 10%/.test(bodyE),
  bodyE.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence found',
);
ok('E2 and says the two discounts count together', /counting item and order discounts together/.test(bodyE));

// ---------------------------------------------------------------------------
// F. ALLOWED — 10% is inside the limit and needs nobody
// ---------------------------------------------------------------------------
await page.click('button:has-text("% Percent")');
await page.fill('#disc-value', '10');
await page.click('button[type="submit"]:has-text("Apply discount")');
await page.waitForTimeout(1200);
await shot('07-allowed-10pct');

const afterAllowed = await page.textContent('body');
ok(
  'F1 no approval prompt for a discount inside the limit',
  !afterAllowed.includes('A manager needs to approve this'),
);
let order = await prisma.order.findFirst({ where: { companyId: fox.id }, orderBy: { createdAt: 'desc' } });
ok('F2 the 10% discount reached the order', Number(order?.discountValue) === 10, `got ${order?.discountValue}`);
ok('F3 nobody was recorded as approving it', order?.discountApprovedById === null);

// ---------------------------------------------------------------------------
// G. ABOVE LIMIT — 11% is refused, and the refusal opens a prompt
// ---------------------------------------------------------------------------
await page.click('[aria-label="Edit order discount"]');
await page.waitForTimeout(500);
await page.click('button:has-text("% Percent")');
await page.fill('#disc-value', '11');
await page.click('button[type="submit"]:has-text("Apply discount")');
await page.waitForTimeout(1500);
await shot('08-above-limit-prompt');

const bodyG = await page.textContent('body');
ok('G1 an above-limit discount opens the approval prompt', bodyG.includes('A manager needs to approve this'));
ok('G2 the prompt asks for the approver’s OWN credentials', bodyG.includes('Approver’s password'));
ok(
  'G3 and says not to type somebody else’s',
  bodyG.includes('Do not enter someone else'),
);
order = await prisma.order.findFirst({ where: { id: order.id } });
ok('G4 the order is still at 10% while the prompt is open', Number(order?.discountValue) === 10);

// ---------------------------------------------------------------------------
// H. CROSS BRANCH — a real manager, real password, wrong branch
// ---------------------------------------------------------------------------
await page.fill('#approver-email', 'mgr.f2@test.local');
await page.fill('#approver-password', PW);
await page.fill('#approver-reason', 'Regular customer, manager said ok');
await page.click('button[type="submit"]:has-text("Approve")');
await page.waitForTimeout(1500);
await shot('09-cross-branch-refused');

const bodyH = await page.textContent('body');
ok('H1 the prompt STAYS OPEN after a refusal', bodyH.includes('A manager needs to approve this'));
ok(
  'H2 a manager from another branch is refused',
  /branch/i.test(bodyH.split('A manager needs to approve this')[1] || ''),
  'no branch reason surfaced in the prompt',
);
order = await prisma.order.findFirst({ where: { id: order.id } });
ok('H3 the refused approval changed nothing on the bill', Number(order?.discountValue) === 10);
ok('H4 and stamped nobody on it', order?.discountApprovedById === null);

// ---------------------------------------------------------------------------
// I. APPROVED — the manager of THIS branch, within their delegated 50%
// ---------------------------------------------------------------------------
await page.fill('#approver-email', 'mgr.f1@test.local');
await page.fill('#approver-password', PW);
await page.fill('#approver-reason', 'Spillage, comped by manager');
await page.click('button[type="submit"]:has-text("Approve")');
await page.waitForTimeout(2000);
await shot('10-approved');

const bodyI = await page.textContent('body');
ok('I1 the prompt closes once the right manager signs', !bodyI.includes('A manager needs to approve this'));

order = await prisma.order.findFirst({ where: { id: order.id } });
ok('I2 the 11% discount is now on the bill', Number(order?.discountValue) === 11, `got ${order?.discountValue}`);
ok('I3 the approver is stamped on the order', order?.discountApprovedById === mgrF1.id);
ok('I4 with the reason the manager gave', order?.discountReason === 'Spillage, comped by manager');
ok('I5 and when', !!order?.discountApprovedAt);

const audit = await prisma.posAuditLog.findMany({
  where: { companyId: fox.id, action: { contains: 'DISCOUNT' } },
  orderBy: { at: 'desc' },
  take: 20,
});
// An approved discount is an ORDER_DISCOUNT_SET that happens to name an
// approver — there is no separate "approved" action, and looking for one by
// name found section H's ORDER_DISCOUNT_APPROVAL_FAILED instead, which is the
// refusal. Ask for the approver, not for a word in the action.
const approved = audit.find((a) => a.action === 'ORDER_DISCOUNT_SET' && a.meta?.approvedBy);
ok('I6 an audit row records the approval', !!approved, audit.map((a) => a.action).join(',') || 'no discount audit rows');
ok(
  'I7 the audit names the actor and the approver separately',
  approved?.actorId === cashierF1.id && approved?.meta?.approvedBy?.id === mgrF1.id,
  approved ? `actor=${approved.actorId} approver=${approved.meta?.approvedBy?.id}` : '',
);
ok('I8 the audit records the role the actor held at the time', approved?.actorRole === 'CASHIER', `got ${approved?.actorRole}`);
// The branch rides in meta; PosAuditLog itself has no branch column, so the
// earlier `approved.branchId` read undefined against every possible value.
ok('I9 the audit carries the branch', approved?.meta?.branchId === f1.id, `got ${approved?.meta?.branchId}`);
ok(
  'I10 and the ceiling the discount was measured against',
  approved?.meta?.actorLimit?.maxPctMilli === 10000,
  `got ${JSON.stringify(approved?.meta?.actorLimit)}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots: ${OUT}`);
await browser.close();
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
