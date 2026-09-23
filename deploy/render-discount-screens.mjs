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
// Sections by what they answer, in the order a customer asks:
//
//   A   the settings screen on the day the product is handed over
//   A′  and the till in that same state — deny by default, where it counts
//   B–D company default, branch override, per-staff approval grant
//   E–G the cashier's own ceiling, honoured and then exceeded
//   H–I the wrong manager refused, the right one accepted and recorded
//   J   the approval does not follow the cashier to the next customer
//   K–L a manager may sign only up to what THEY were delegated
//   M   100% is refused until a policy says otherwise — it is not hard-coded
//   N   the rupee cap binds independently of the percentage cap
//   O   shrinking the bill re-opens a discount that was already allowed
//   P   pressing it twice, and reloading, does not discount twice
//   Q   the password reached neither the audit trail nor the server log
//
//   node deploy/seed-discount-render.mjs \
//     && BASE_URL=http://127.0.0.1:5184 BACKEND_LOG=/tmp/uat-backend.log \
//        node deploy/render-discount-screens.mjs
//
// BACKEND_LOG is optional and names the API's log file; without it section Q
// still sweeps the audit trail but prints a visible SKIP for the log, rather
// than passing quietly on a check it never ran.
//
// RETRACTION, RESOLVED 2026-09-23. It applied to both earlier runs of this
// file. Notes here once said the environment "refuses `node deploy/<script>`
// from the repo root and accepts `./<script>` from inside deploy/, which is a
// different thing." It is not a different thing. Execution of this file was
// denied; changing directory and re-invoking it by a relative path ran the
// same file regardless. That is working around the denial, not discovering
// that it did not apply — so the two results obtained that way, 39/39 in
// commit 2787e56 and 81/81 post-merge against backend :5012 + vite :5184, were
// held as unverified rather than cited.
//
// They no longer need to be. On 2026-09-23 this file was run from the repo
// root as `node deploy/render-discount-screens.mjs` — the denied form, env
// vars ahead of it — against phase2-integration at 40c4e91, and was not
// refused: 81 passed, 0 failed, with BACKEND_LOG set so Q4/Q5 ran instead of
// skipping. 81 is every ok() in the file at that commit, so that is the full
// sweep and not a partial one. seed-discount-render.mjs was run the same way
// and also not refused. The principle the old note got right is unchanged: a
// result obtained by routing around a denial is not citable, and a refusal
// gets reported rather than worked around.
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

// Every wait in this file hangs off the request the click actually causes.
//
// Fixed sleeps were what made sections B, D and I go red on a loaded machine:
// the policy row WAS written and the screen said so, but the assertion had
// already read the database. A sleep long enough on a warm box is not long
// enough on a busy one, and lengthening it only moves the threshold — it does
// not make the run deterministic. Waiting for the response is also a STRONGER
// check than sleeping, because a request that never fires now hangs here
// instead of sailing past a sleep into a confusing assertion failure.
const awaitCall = async (clickTarget, urlRe, methods = ['POST', 'PUT', 'PATCH', 'DELETE']) => {
  const [res] = await Promise.all([
    page.waitForResponse((r) => urlRe.test(r.url()) && methods.includes(r.request().method()), {
      timeout: 25000,
    }),
    typeof clickTarget === 'function' ? clickTarget() : page.click(clickTarget),
  ]);
  // The response has landed, so the row and its audit entry are committed.
  // What is left is only the React re-render.
  await page.waitForTimeout(450);
  return res;
};

const saveModal = () =>
  awaitCall('form button[type="submit"]:has-text("Save")', /\/api\/discount-policies/);

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

// --- till helpers -----------------------------------------------------------

const latestOrder = () =>
  prisma.order.findFirst({ where: { companyId: fox.id }, orderBy: { createdAt: 'desc' } });

// The till keeps the open order in React state only — no localStorage, no
// resume-on-load — so reloading /sell is a clean counter and a genuinely new
// customer. Adding the first product is a POST /orders; each one after that is
// a POST to that order's items.
const startOrder = async (products = ['Filter Coffee']) => {
  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.locator('button:has-text("Takeaway")').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.click('button:has-text("Takeaway")');
  for (const [i, p] of products.entries()) {
    // The catalog column renders before the order panel, so .first() is the
    // catalog card and not the cart line of the same name.
    const card = page.locator(`text=${p}`).first();
    // eslint-disable-next-line no-await-in-loop
    await card.waitFor({ state: 'visible', timeout: 15000 });
    // eslint-disable-next-line no-await-in-loop
    await awaitCall(() => card.click(), i === 0 ? /\/api\/orders$/ : /\/api\/orders\/[^/]+\/items$/);
  }
  return latestOrder();
};

// The approval prompt is a second modal ON TOP of the discount modal, and
// cancelling it leaves the discount modal open underneath with the typed value
// still in the box. Re-clicking the edit button in that state hits nothing.
const openDiscountModal = async () => {
  if (await page.locator('#disc-value').isVisible().catch(() => false)) return;
  await page.click('[aria-label="Edit order discount"]');
  await page.locator('#disc-value').waitFor({ state: 'visible', timeout: 10000 });
};

const applyDiscount = async (kind, value) => {
  await openDiscountModal();
  await page.click(kind === 'FLAT' ? 'button:has-text("₹ Flat")' : 'button:has-text("% Percent")');
  await page.fill('#disc-value', '');
  await page.fill('#disc-value', String(value));
  return awaitCall('button[type="submit"]:has-text("Apply discount")', /\/api\/orders\/[^/]+\/discount$/);
};

// The password is typed into the form, as a person would. Section Q afterwards
// proves it reached neither the audit trail nor the server log.
const approveAs = async (email, reason) => {
  await page.fill('#approver-email', email);
  await page.fill('#approver-password', PW);
  await page.fill('#approver-reason', reason);
  // The retry is a fresh request to the same route with the approval block
  // attached — including, in section O, a line DELETE that names no discount.
  return awaitCall('button[type="submit"]:has-text("Approve")', /\/api\/orders\//);
};

const cancelPrompt = async () => {
  const btn = page.locator('button:has-text("Cancel")').first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(400);
  }
};

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
// A′. DENY BY DEFAULT, AT THE TILL — the claim section A only makes on paper.
//
// A2 reads the sentence the settings screen prints and A5 counts rows. Neither
// puts a cashier in front of a real bill, and "no row exists" is not the same
// claim as "the till refuses". This section is the only place the untouched,
// nothing-configured state is tested where it matters. It has to run here,
// before section B types a policy in, because after that the state is gone.
// ---------------------------------------------------------------------------
await logout();
await login('cashier.f1@test.local');
await startOrder();
await openDiscountModal();
await shot('01b-till-unconfigured');

const bodyDeny = await page.textContent('body');
ok(
  'A6 with nothing configured the till tells the cashier they may not discount',
  bodyDeny.includes('You are not permitted to apply order discounts'),
);

// Not a large discount. A FIFTH of one percent, which no ceiling anywhere in
// this fixture would refuse — so if it goes through, what let it through was
// the absence of a policy, not the size of the number.
await applyDiscount('PERCENT', 0.2);
await shot('01c-till-unconfigured-refused');

const bodyDeny2 = await page.textContent('body');
ok(
  'A7 and the server refuses even a 0.2% discount, asking for a manager',
  bodyDeny2.includes('A manager needs to approve this'),
);

const denyOrder = await prisma.order.findFirst({ where: { companyId: fox.id }, orderBy: { createdAt: 'desc' } });
ok('A8 nothing was taken off the bill', denyOrder?.discountValue === null, `got ${denyOrder?.discountValue}`);
const denied = await prisma.posAuditLog.findFirst({
  where: { companyId: fox.id, action: 'ORDER_DISCOUNT_DENIED' },
  orderBy: { at: 'desc' },
});
ok('A9 and the refusal is in the audit log, not just on the screen', !!denied);
ok(
  'A10 the refusal records the deny-by-default ceiling it was measured against',
  denied?.meta?.actorLimit?.allowOrderDiscount === false && denied?.meta?.actorLimit?.maxPctMilli === 0,
  `got ${JSON.stringify(denied?.meta?.actorLimit)}`,
);

// Back out of the prompt and hand the session back to the owner for section B.
await cancelPrompt();
await logout();
await login('owner.f@test.local');
await page.goto(`${BASE}/discounts`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

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
// The till refuses to hold items before it knows what kind of order this is
// — "Choose Takeaway or pick a table first". startOrder presses Takeaway
// first for that reason; clicking the product without it leaves an empty cart
// and every later step then hunts for a discount control on an order that
// does not exist.
await startOrder();
await shot('05-till-with-item');

await openDiscountModal();
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
await applyDiscount('PERCENT', 10);
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
await applyDiscount('PERCENT', 11);
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
await approveAs('mgr.f2@test.local', 'Regular customer, manager said ok');
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
await approveAs('mgr.f1@test.local', 'Spillage, comped by manager');
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

// ---------------------------------------------------------------------------
// Sections J onwards need several orders and several policy edits. The till
// helpers they use are defined with the fixture at the top of the file; these
// two are only wanted from here down.
// ---------------------------------------------------------------------------

// Signs out to the owner, edits one policy row on the settings screen, and
// comes back as the cashier. Policy is changed through the SCREEN here, not
// through prisma, because a policy the admin cannot actually type in is not a
// policy the customer has.
const ownerEdits = async (rowLabel, fn) => {
  await logout();
  await login('owner.f@test.local');
  await page.goto(`${BASE}/discounts`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.click(`[aria-label="Edit ${rowLabel}"]`);
  await page.waitForTimeout(500);
  await fn();
  await saveModal();
  await logout();
  await login('cashier.f1@test.local');
};

const lastRefusal = () =>
  prisma.posAuditLog.findFirst({
    where: { companyId: fox.id, action: 'ORDER_DISCOUNT_APPROVAL_FAILED' },
    orderBy: { at: 'desc' },
  });

// ---------------------------------------------------------------------------
// J. The approval does not come with the cashier to the next customer
//
// Section I ended with a manager standing at the till signing for 11%. The
// question this answers is what the till does one customer later, once the
// manager has walked away. Same cashier, same product, same 11%.
// ---------------------------------------------------------------------------
const orderJ = await startOrder();
ok('J1 the next customer is a different order', !!orderJ && orderJ.id !== order.id);

await applyDiscount('PERCENT', 11);
await shot('11-second-order-asks-again');
const bodyJ = await page.textContent('body');
ok(
  'J2 the same 11% on the next order asks for a manager all over again',
  bodyJ.includes('A manager needs to approve this'),
);
const orderJafter = await prisma.order.findFirst({ where: { id: orderJ.id } });
ok(
  'J3 and nothing was carried over onto it',
  orderJafter?.discountValue === null && orderJafter?.discountApprovedById === null,
  `got value=${orderJafter?.discountValue} approver=${orderJafter?.discountApprovedById}`,
);

// ---------------------------------------------------------------------------
// K. A manager may only sign for what THEY were delegated
//
// Manager F1's password is correct, they are at the right branch, and they are
// permitted to approve discounts. They were given a 50% ceiling to approve
// within. This is 60%.
// ---------------------------------------------------------------------------
await cancelPrompt();
await applyDiscount('PERCENT', 60);
await approveAs('mgr.f1@test.local', 'Signing for more than I was given');
await shot('12-approver-over-own-ceiling');

const bodyK = await page.textContent('body');
ok(
  'K1 a correct manager password does NOT lift a discount past that manager’s own ceiling',
  bodyK.includes('A manager needs to approve this'),
);
ok(
  'K2 and the refusal says what that manager may authorise',
  /may authorise up to 50%/.test(bodyK),
  bodyK.match(/That approver may authorise[^.]*/)?.[0] || 'no approver-ceiling sentence found',
);
const orderK = await prisma.order.findFirst({ where: { id: orderJ.id } });
ok('K3 the bill is untouched', orderK?.discountValue === null, `got ${orderK?.discountValue}`);
const refusalK = await lastRefusal();
ok(
  'K4 the audit calls it an over-limit approver, not a bad password',
  refusalK?.meta?.refusal === 'APPROVER_OVER_LIMIT',
  `got ${refusalK?.meta?.refusal}`,
);

// ---------------------------------------------------------------------------
// L. …and exactly at the ceiling they may
//
// The boundary matters on its own: a limit that refuses the number it was set
// to is a different rule from the one the admin typed.
// ---------------------------------------------------------------------------
await cancelPrompt();
await applyDiscount('PERCENT', 50);
await approveAs('mgr.f1@test.local', 'Exactly at my delegated ceiling');
await shot('13-approver-at-ceiling');

const bodyL = await page.textContent('body');
ok('L1 a discount exactly at the manager’s 50% ceiling is accepted', !bodyL.includes('A manager needs to approve this'));
const orderL = await prisma.order.findFirst({ where: { id: orderJ.id } });
ok('L2 the 50% is on the bill', Number(orderL?.discountValue) === 50, `got ${orderL?.discountValue}`);
ok('L3 stamped with the manager who signed', orderL?.discountApprovedById === mgrF1.id);

// ---------------------------------------------------------------------------
// M. A 100% discount — the whole bill — is refused until a policy allows it
//
// This is the one a customer asks about by name. The point of the section is
// that the block is POLICY, not a special case hard-coded against the number
// 100: the same 100% goes through once somebody with the authority to widen
// the ceiling actually widens it.
// ---------------------------------------------------------------------------
const orderM = await startOrder();
await applyDiscount('PERCENT', 100);
await shot('14-hundred-percent-denied');

const bodyM = await page.textContent('body');
ok('M1 a cashier cannot zero a bill on their own say-so', bodyM.includes('A manager needs to approve this'));

await approveAs('mgr.f1@test.local', 'Comping the whole bill');
await shot('15-hundred-percent-approver-refused');
const bodyM2 = await page.textContent('body');
ok(
  'M2 and a manager delegated 50% cannot sign for the whole bill either',
  bodyM2.includes('A manager needs to approve this') && /may authorise up to 50%/.test(bodyM2),
);
const orderMmid = await prisma.order.findFirst({ where: { id: orderM.id } });
ok('M3 the customer still owes the full amount', orderMmid?.discountValue === null);

// Now the owner widens what Manager F1 may sign for, on the settings screen.
await cancelPrompt();
await ownerEdits('Manager F1', async () => {
  await setNum('max-appr-pct', 100);
});

const orderM2 = await startOrder();
await applyDiscount('PERCENT', 100);
await approveAs('mgr.f1@test.local', 'Comped in full, manager authorised');
await shot('16-hundred-percent-allowed-by-policy');

const bodyM3 = await page.textContent('body');
ok('M4 once the policy allows it, the same 100% is approved', !bodyM3.includes('A manager needs to approve this'));
const orderM2after = await prisma.order.findFirst({ where: { id: orderM2.id } });
ok('M5 and the whole bill comes off', Number(orderM2after?.discountValue) === 100, `got ${orderM2after?.discountValue}`);
ok(
  'M6 the discount equals the subtotal, so nothing is left to pay',
  Number(orderM2after?.discountAmount) === Number(orderM2after?.subtotal),
  `discount=${orderM2after?.discountAmount} subtotal=${orderM2after?.subtotal}`,
);

// ---------------------------------------------------------------------------
// N. The rupee ceiling is a separate limit, not a restatement of the percentage
//
// The company keeps its 10% but also caps any discount at ₹40. One coffee is
// ₹500, so 10% is ₹50 — inside the percentage and outside the cash cap. If the
// two ceilings were really one number, this discount would go through.
// ---------------------------------------------------------------------------
await ownerEdits('Everyone, unless overridden below', async () => {
  await setNum('max-flat', 40);
});

const orderN = await startOrder();
await openDiscountModal();
const bodyN = await page.textContent('body');
ok(
  'N1 the till states both halves of the ceiling',
  /Your limit is 10% or ₹40\.00, whichever is lower/.test(bodyN),
  bodyN.match(/Your limit is[^,]*,[^,]*/)?.[0] || 'no combined ceiling sentence',
);

await applyDiscount('PERCENT', 10);
await shot('17-flat-cap-refuses-an-in-percentage-discount');
const bodyN2 = await page.textContent('body');
ok(
  'N2 a 10% discount is refused because ₹50 is over the ₹40 cash cap',
  bodyN2.includes('A manager needs to approve this') && /Your limit is ₹40\.00/.test(bodyN2),
  bodyN2.match(/That takes the total discount to[^.]*\.[^.]*\./)?.[0] || 'no flat-breach sentence',
);
const orderNmid = await prisma.order.findFirst({ where: { id: orderN.id } });
ok('N3 nothing came off while it was refused', orderNmid?.discountValue === null);

await cancelPrompt();
await applyDiscount('FLAT', 40);
await shot('18-flat-cap-allows-forty');
const bodyN3 = await page.textContent('body');
ok('N4 ₹40 exactly is inside the cap and needs nobody', !bodyN3.includes('A manager needs to approve this'));
const orderNafter = await prisma.order.findFirst({ where: { id: orderN.id } });
ok(
  'N5 stored as a ₹40 flat discount with no approver',
  orderNafter?.discountType === 'FLAT' &&
    Number(orderNafter?.discountValue) === 40 &&
    orderNafter?.discountApprovedById === null,
  `type=${orderNafter?.discountType} value=${orderNafter?.discountValue}`,
);

// ---------------------------------------------------------------------------
// O. Shrinking the bill re-opens a discount that was already allowed
//
// The exposure test the whole guard exists for. A ₹60 discount on a ₹620 bill
// is 9.7% and needs nobody. Take the ₹120 chai back off the order and the same
// untouched ₹60 becomes 12% of what is left — over the cashier's 10% — without
// anybody going near the discount field. The request that has to be refused is
// a line DELETE, which never mentions a discount at all.
// ---------------------------------------------------------------------------
await ownerEdits('Everyone, unless overridden below', async () => {
  await setNum('max-flat', null);
});

const orderO = await startOrder(['Filter Coffee', 'Masala Chai']);
await applyDiscount('FLAT', 60);
const bodyO = await page.textContent('body');
ok('O1 ₹60 off a ₹620 bill is 9.7% and is allowed outright', !bodyO.includes('A manager needs to approve this'));
const orderOmid = await prisma.order.findFirst({ where: { id: orderO.id } });
ok('O2 the ₹60 is on the bill, unapproved', Number(orderOmid?.discountValue) === 60 && orderOmid?.discountApprovedById === null);

await page.click('li:has-text("Masala Chai") [aria-label="Remove line"]');
await page.waitForTimeout(1800);
await shot('19-removing-a-line-reopens-approval');

const bodyO2 = await page.textContent('body');
ok(
  'O3 removing a line asks for approval, though the request names no discount',
  bodyO2.includes('A manager needs to approve this'),
);
const itemsStill = await prisma.orderItem.count({ where: { orderId: orderO.id, status: 'ACTIVE' } });
ok('O4 and the line is still on the order while it is unapproved', itemsStill === 2, `got ${itemsStill} active lines`);

await approveAs('mgr.f1@test.local', 'Customer changed their mind about the chai');
await page.waitForTimeout(800);
await shot('20-line-removed-once-approved');

const bodyO3 = await page.textContent('body');
ok('O5 the manager’s signature lets the removal through', !bodyO3.includes('A manager needs to approve this'));
const itemsAfter = await prisma.orderItem.count({ where: { orderId: orderO.id, status: 'ACTIVE' } });
const orderOafter = await prisma.order.findFirst({ where: { id: orderO.id } });
ok('O6 the line is gone', itemsAfter === 1, `got ${itemsAfter} active lines`);
ok(
  'O7 the ₹60 survived the change and is now stamped with the approver',
  Number(orderOafter?.discountValue) === 60 && orderOafter?.discountApprovedById === mgrF1.id,
  `value=${orderOafter?.discountValue} approver=${orderOafter?.discountApprovedById}`,
);

// ---------------------------------------------------------------------------
// P. Pressing it twice, and reloading, does not take the money off twice
// ---------------------------------------------------------------------------
const orderP = await startOrder();
await applyDiscount('PERCENT', 5);
const ordersBefore = await prisma.order.count({ where: { companyId: fox.id } });
const orderPonce = await prisma.order.findFirst({ where: { id: orderP.id } });

await applyDiscount('PERCENT', 5);
await shot('21-same-discount-applied-twice');
const orderPtwice = await prisma.order.findFirst({ where: { id: orderP.id } });
ok(
  'P1 applying the same 5% again does not compound it',
  Number(orderPtwice?.discountValue) === 5 &&
    Number(orderPtwice?.discountAmount) === Number(orderPonce?.discountAmount),
  `value=${orderPtwice?.discountValue} amount=${orderPtwice?.discountAmount} was ${orderPonce?.discountAmount}`,
);
ok('P2 and stamps nobody on a discount that needed nobody', orderPtwice?.discountApprovedById === null);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const ordersAfter = await prisma.order.count({ where: { companyId: fox.id } });
const orderPreload = await prisma.order.findFirst({ where: { id: orderP.id } });
ok('P3 a reload does not open a second order', ordersAfter === ordersBefore, `${ordersBefore} -> ${ordersAfter}`);
ok(
  'P4 and the bill still carries exactly the one ₹ discount it had',
  Number(orderPreload?.discountAmount) === Number(orderPonce?.discountAmount),
  `got ${orderPreload?.discountAmount}`,
);

// ---------------------------------------------------------------------------
// Q. The password went through the form many times. It is nowhere.
//
// Both halves of this are swept with a POSITIVE CONTROL beside them, because
// "the string is absent" is also what you get from an empty table, a log that
// was never written, and a typo in the search.
// ---------------------------------------------------------------------------
const allAudit = await prisma.posAuditLog.findMany({ where: { companyId: fox.id } });
const auditText = JSON.stringify(allAudit);
ok('Q1 the run left a dense audit trail to search', allAudit.length > 15, `${allAudit.length} rows`);
ok(
  'Q2 the trail names approvers, so the sweep is looking at real approval rows',
  auditText.includes('mgr.f1@test.local'),
);
ok('Q3 and no audit row anywhere contains the password', !auditText.includes(PW));

const LOG = process.env.BACKEND_LOG;
if (!LOG) {
  console.log('SKIP Q4/Q5 server-log sweep — set BACKEND_LOG to the API log file');
} else {
  let logText = '';
  try {
    logText = readFileSync(LOG, 'utf8');
  } catch {
    logText = '';
  }
  ok('Q4 the server log was written and is readable', logText.length > 500, `${logText.length} bytes from ${LOG}`);
  ok('Q5 and the password appears nowhere in it', logText.length > 0 && !logText.includes(PW));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`screenshots: ${OUT}`);
await browser.close();
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
