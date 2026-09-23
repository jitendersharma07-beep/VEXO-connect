#!/usr/bin/env node
// The till half of the discount browser UAT.
//
// render-discount-screens.mjs proves the SETTINGS half: that the owner's
// typing reaches the table, that a branch override lands on the right branch,
// and that one above-limit discount is refused, prompted, cross-branch-refused
// and finally approved. This file is the other half — what a cashier can and
// cannot actually do at the till, all the way to the cases nobody enjoys
// writing: self-approval, replay, 100%, a cash cap, a negative bill, and the
// same request sent straight at the API with the screen bypassed.
//
//   RENDER_ENV_FILE=/tmp/discount-uat.env node deploy/seed-discount-render.mjs \
//     && RENDER_ENV_FILE=/tmp/discount-uat.env BASE_URL=http://127.0.0.1:5182 \
//        node deploy/render-discount-till.mjs
//
// RETRACTION. This note used to read "run it from deploy/ — this environment
// refuses `node deploy/<script>` from the repo root and accepts `./<script>`
// from inside deploy/", offered as a fact about the environment. It was a way
// around a denial: the same file, executed anyway, by a second invocation form
// tried after the first was refused. The results this file has produced were
// obtained under that workaround and are not cited as clean. See the fuller
// retraction at the top of render-discount-screens.mjs.
//
// USE A DATABASE NOBODY ELSE IS USING. The first run of this file died
// halfway through because another session ran `npm test`, which wipes the
// shared _test database; the browser was mid-order and the order it had just
// discounted stopped existing. Nothing was wrong with the product and three
// assertions reported as feature failures. /tmp/discount-uat.env points at
// atc_pos_discount_uat_test for exactly that reason.
//
// POLICY IS SET HERE THROUGH PRISMA, NOT THROUGH THE SCREEN. The screen's
// half is already proven next door and re-driving it would add four minutes
// of clicking to every case. What this file drives through the browser is the
// thing the settings screen cannot answer: what the till then allows.
//
// DATABASE_URL and RENDER_PASSWORD come from the env file, never from argv.
// PASS/FAIL lines only — the password is typed into forms and never printed.

import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

const ENV_FILE = process.env.RENDER_ENV_FILE || '/tmp/discount-uat.env';
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^export ([A-Z_]+)='(.*)'$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
} catch {
  console.error(`FAIL: cannot read ${ENV_FILE}`);
  process.exit(1);
}

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5182').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-discount-screens/till';
const CHROME = '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';
const PW = process.env.RENDER_PASSWORD;

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  console.error('FAIL: this run requires a DATABASE_URL ending in _test');
  process.exit(1);
}
if (!PW) {
  console.error('FAIL: export RENDER_PASSWORD');
  process.exit(1);
}

const { prisma } = await import('../backend/src/lib/prisma.js');
const { scopeKeyFor } = await import('../backend/src/lib/discountPolicy.js');

mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const failed = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Every assertion below reads a row back. A lookup that returns nothing must
// say so as a broken run, not arrive at an assertion as `undefined` and be
// reported as the product getting the answer wrong.
const must = (label, v) => {
  if (v === null || v === undefined) {
    console.error(`FAIL ${label} — expected a row and found none; the database may have been wiped mid-run`);
    process.exit(1);
  }
  return v;
};

const num = (d) => (d === null || d === undefined ? null : Number(d));

// --- fixture ----------------------------------------------------------------

const fox = await prisma.company.findFirst({ where: { slug: 'foxtrot-foods' } });
if (!fox) {
  console.error('FAIL: no fixture — run ./seed-discount-render.mjs first');
  process.exit(1);
}
const branches = await prisma.branch.findMany({ where: { companyId: fox.id } });
const f1 = must('fixture branch F1', branches.find((b) => b.code === 'F1'));
const f2 = must('fixture branch F2', branches.find((b) => b.code === 'F2'));
const userBy = async (email) =>
  must(`fixture user ${email}`, await prisma.posUser.findFirst({ where: { email } }));
const cashierF1 = await userBy('cashier.f1@test.local');
const cashierF2 = await userBy('cashier.f2@test.local');
const mgrF1 = await userBy('mgr.f1@test.local');
const mgrF2 = await userBy('mgr.f2@test.local');

// upsert on (companyId, scopeKey) — the index that exists because Postgres
// counts NULLs as distinct and a nullable (branchId,userId) pair would hold a
// hundred company defaults.
const setPolicy = async ({ level, branchId = null, userId = null, ...fields }) => {
  const scopeKey = scopeKeyFor({ level, branchId, userId });
  const data = {
    companyId: fox.id, level, branchId, userId, scopeKey,
    allowLineDiscount: null, allowOrderDiscount: null,
    maxPercent: null, maxFlatPaise: null,
    canApprove: null, maxApprovalPercent: null, maxApprovalFlatPaise: null,
    ...fields,
  };
  return prisma.discountPolicy.upsert({
    where: { companyId_scopeKey: { companyId: fox.id, scopeKey } },
    create: data,
    update: data,
  });
};
const clearPolicy = async ({ level, branchId = null, userId = null }) => {
  const scopeKey = scopeKeyFor({ level, branchId, userId });
  await prisma.discountPolicy.deleteMany({ where: { companyId: fox.id, scopeKey } });
};

// The state render-discount-screens.mjs leaves behind, rebuilt directly:
// company 10%, Foxtrot Two overridden to 20%, both managers may approve to 50%
// without that raising their own ceiling.
const baseline = async () => {
  await prisma.discountPolicy.deleteMany({ where: { companyId: fox.id } });
  await setPolicy({ level: 'COMPANY', allowLineDiscount: true, allowOrderDiscount: true, maxPercent: '10' });
  await setPolicy({ level: 'BRANCH', branchId: f2.id, maxPercent: '20' });
  await setPolicy({ level: 'USER', userId: mgrF1.id, canApprove: true, maxApprovalPercent: '50' });
  await setPolicy({ level: 'USER', userId: mgrF2.id, canApprove: true, maxApprovalPercent: '50' });
};
await baseline();

// --- browser ----------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log(`FAIL page-error — ${e.message}`));

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const body = () => page.textContent('body');

const login = async (email) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  // Sign-in is an XHR: the page is already idle when the click lands, so
  // waiting on load state returns before the session cookie exists.
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

const PROMPT = 'A manager needs to approve this';
const promptOpen = async () => (await body()).includes(PROMPT);

// The "Order discount" modal has no Cancel button — only Apply, and Remove
// once a discount exists. It closes on its backdrop (onMouseDown) or the
// unlabelled X. So close every modal the same way, by clicking the corner of
// the overlay, and keep going until none is left: a refused apply leaves the
// approval prompt stacked on top of the discount modal, and closing only the
// top one leaves the second to swallow the next click.
const modalCount = () => page.locator('div.fixed.inset-0.z-50').count();
const closeModal = async () => {
  for (let i = 0; i < 4; i += 1) {
    if ((await modalCount()) === 0) return;
    await page.mouse.click(5, 5);
    await page.waitForTimeout(400);
  }
  // Say so rather than carrying on. Giving up quietly is what turned a modal
  // that would not close into a later, unrelated-looking failure on a control
  // the overlay was covering — the step reported was not the step that broke.
  throw new Error(`closeModal: ${await modalCount()} modal(s) still open after 4 attempts`);
};
const cancelPrompt = closeModal;
const closeAnyModal = closeModal;

// A fresh order. "New sale" only clears the till's idea of the current order,
// so the next Takeaway + product opens a genuinely new row — which is what the
// replay cases need.
const newestOrder = async () => prisma.order.findFirst({ orderBy: { createdAt: 'desc' } });

const startOrder = async (items = 1) => {
  // Which bill was the newest BEFORE this call, so we can tell the one this
  // call creates from the one the last scenario left behind.
  const previousId = (await newestOrder())?.id ?? null;

  await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const ns = page.locator('button:has-text("New sale")');
  if (await ns.count()) { await ns.first().click(); await page.waitForTimeout(700); }
  await page.click('button:has-text("Takeaway")');
  await page.waitForTimeout(700);
  for (let i = 0; i < items; i += 1) {
    await page.click('text=Filter Coffee');
    await page.waitForTimeout(800);
  }

  // The POST that actually creates the order is fired by the first item click,
  // and the waits above are guesses. Wait for the row instead of guessing: on
  // a loaded machine the insert lands after them, every `latestOrder()` in the
  // scenario that follows then reads the PREVIOUS bill, and the assertion
  // fails for a reason that has nothing to do with discounts. That is exactly
  // how R8 once failed while the database plainly showed the right answer.
  for (let i = 0; i < 25; i += 1) {
    const current = await newestOrder();
    if (current && current.id !== previousId) return current;
    await page.waitForTimeout(300);
  }
  throw new Error('startOrder: no new order appeared within 7.5s of adding the first item');
};

const openDiscount = async () => {
  await closeModal();
  await page.click('[aria-label="Edit order discount"]');
  await page.waitForTimeout(600);
};

// Waits for a submit button to stop saying it is working, rather than for a
// number of milliseconds somebody guessed. Both buttons below swap their label
// while their POST is in flight — "Applying…" and "Checking…" — so the label
// going away IS the request settling, whatever the box is doing at the time.
//
// This is the same defect startOrder carries a note about, in a second place.
// The guesses were 1600ms and 1800ms; a loaded machine answered one discount
// POST in 2384ms, so the modal was still submitting when the next step tried
// to reopen it, and R4 failed on a control it could not reach rather than on a
// wrong answer — with the database plainly showing the right one. Approval is
// worse exposed than apply, because it verifies a password and is the slowest
// request the till makes.
//
// Settled means one of three things and this covers all of them: the modal
// closed (allowed), the approval prompt is now stacked on top (refused), or
// the button came back with an error beside it (refused, modal still up).
const settle = async (label) => {
  await page
    .locator(`button[type="submit"]:has-text("${label}")`)
    .waitFor({ state: 'detached', timeout: 25000 })
    .catch(() => {});
  await page.waitForTimeout(500);
};

// type: 'PERCENT' | 'FLAT'
const applyDiscount = async (type, value) => {
  await openDiscount();
  await page.click(`button:has-text("${type === 'FLAT' ? '₹ Flat' : '% Percent'}")`);
  await page.waitForTimeout(200);
  await page.fill('#disc-value', String(value));
  await page.click('button[type="submit"]:has-text("Apply discount")');
  await settle('Applying…');
};

const approveAs = async (email, reason) => {
  await page.fill('#approver-email', email);
  await page.fill('#approver-password', PW);
  await page.fill('#approver-reason', reason);
  await page.click('button[type="submit"]:has-text("Approve")');
  await settle('Checking…');
};

const latestOrder = async (branchId) =>
  prisma.order.findFirst({ where: { branchId }, orderBy: { createdAt: 'desc' } });
const orderById = async (id) => prisma.order.findFirst({ where: { id } });

const auditFor = async (orderId) =>
  prisma.posAuditLog.findMany({
    where: { entityId: orderId, action: { contains: 'DISCOUNT' } },
    orderBy: { at: 'asc' },
  });

// Same session the cashier is signed into, same origin — so this is the
// request the screen would have sent, with the screen taken out of it.
const api = (method, path, payload) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p, {
        method: m,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: b === null ? undefined : JSON.stringify(b),
      });
      let j = null;
      try { j = await r.json(); } catch { /* empty body */ }
      return { status: r.status, body: j };
    },
    [method, path, payload ?? null],
  );

// ===========================================================================
// J. The allowed band — a cashier on the company default of 10%
// ===========================================================================
await login('cashier.f1@test.local');

await startOrder(1);
const jOrder = must('J order', await latestOrder(f1.id));
ok('J1 an order with no discount is untouched', num(jOrder.discountValue) === null || num(jOrder.discountValue) === 0,
  `discountValue=${jOrder.discountValue}`);
ok('J2 and its total is the full bill', num(jOrder.discountAmount) === 0,
  `discountAmount=${jOrder.discountAmount}`);

await openDiscount();
const jBody = await body();
ok('J3 the till states the limit before a number is typed', /Your limit is 10%/.test(jBody),
  jBody.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence');
await closeAnyModal();

// below the limit
await applyDiscount('PERCENT', 4);
await shot('J-04pct');
ok('J4 4% applies with no prompt', !(await promptOpen()));
let j = must('J after 4%', await orderById(jOrder.id));
ok('J5 4% reached the order', num(j.discountValue) === 4, `got ${j.discountValue}`);
ok('J6 nobody approved it', j.discountApprovedById === null);

// exactly the limit — the boundary is inclusive
await applyDiscount('PERCENT', 10);
ok('J7 exactly 10% applies with no prompt', !(await promptOpen()));
j = must('J after 10%', await orderById(jOrder.id));
ok('J8 10% reached the order', num(j.discountValue) === 10, `got ${j.discountValue}`);
ok('J9 still nobody approved it', j.discountApprovedById === null);

// one step over
await applyDiscount('PERCENT', 10.5);
await shot('J-10_5pct-prompt');
ok('J10 10.5% is stopped and asks for approval', await promptOpen());
j = must('J after 10.5%', await orderById(jOrder.id));
ok('J11 the bill did not move while the prompt is open', num(j.discountValue) === 10, `got ${j.discountValue}`);

// ===========================================================================
// K. A cashier cannot approve their own above-limit discount
// ===========================================================================
await approveAs('cashier.f1@test.local', 'I am authorising myself');
await shot('K-self-approval-refused');
ok('K1 the prompt stays open after a cashier signs for themselves', await promptOpen());
const kBody = await body();
ok('K2 and says the account may not approve', /approve|permitted|not allowed/i.test(
  kBody.split(PROMPT)[1] || ''), 'no refusal reason surfaced');
j = must('K after self-approval', await orderById(jOrder.id));
ok('K3 the bill is unchanged', num(j.discountValue) === 10, `got ${j.discountValue}`);
ok('K4 and nobody is stamped on it', j.discountApprovedById === null);
const kAudit = await auditFor(jOrder.id);
const selfFail = kAudit.filter((a) => a.action === 'ORDER_DISCOUNT_APPROVAL_FAILED'
  && a.meta?.approverEmail === 'cashier.f1@test.local');
ok('K5 the refused self-approval is in the trail', selfFail.length === 1, `found ${selfFail.length}`);
ok('K6 recorded against the cashier who tried it', selfFail[0]?.actorId === cashierF1.id);

// ===========================================================================
// L. Approved once, and only once
// ===========================================================================
await approveAs('mgr.f1@test.local', 'Spillage, comped by manager');
await shot('L-approved');
ok('L1 the right manager closes the prompt', !(await promptOpen()));
j = must('L after approval', await orderById(jOrder.id));
ok('L2 the 10.5% discount is on the bill', num(j.discountValue) === 10.5, `got ${j.discountValue}`);
ok('L3 the approver is stamped', j.discountApprovedById === mgrF1.id);
ok('L4 with a timestamp', !!j.discountApprovedAt);

// 10.5% of ₹500 is ₹52.50. Applied twice it would be ₹105.
const gross = num(j.subtotal);
ok('L5 the money off is the discount applied exactly once',
  num(j.discountAmount) === Math.round(gross * 0.105 * 100) / 100,
  `gross=${gross} discountAmount=${j.discountAmount}`);
ok('L6 and the total is not double-discounted',
  num(j.total) > 0 && num(j.discountAmount) < gross,
  `total=${j.total}`);

const lAudit = await auditFor(jOrder.id);
const lApproved = lAudit.filter((a) => a.action === 'ORDER_DISCOUNT_SET' && a.meta?.approvedBy);
ok('L7 exactly one approved discount is recorded for this order', lApproved.length === 1,
  `found ${lApproved.length}`);

// reload — the browser re-reads the order from the server
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await shot('L-after-reload');
j = must('L after reload', await orderById(jOrder.id));
ok('L8 a refresh does not re-apply it', num(j.discountValue) === 10.5, `got ${j.discountValue}`);
ok('L9 and the money off is unchanged', num(j.discountAmount) === Math.round(gross * 0.105 * 100) / 100,
  `discountAmount=${j.discountAmount}`);
const lAudit2 = await auditFor(jOrder.id);
ok('L10 the refresh wrote no second approval',
  lAudit2.filter((a) => a.action === 'ORDER_DISCOUNT_SET' && a.meta?.approvedBy).length === 1);

// ===========================================================================
// M. The approval died with the response — it cannot be spent on another order
// ===========================================================================
await startOrder(1);
const mOrder = must('M order', await latestOrder(f1.id));
ok('M1 a new order really is a new order', mOrder.id !== jOrder.id);
ok('M2 it carries no approver from the last one', mOrder.discountApprovedById === null);

await applyDiscount('PERCENT', 10.5);
await shot('M-second-order-prompted');
ok('M3 the same 10.5% must be approved all over again', await promptOpen());
const m = must('M after attempt', await orderById(mOrder.id));
ok('M4 nothing was applied on the strength of the earlier approval',
  num(m.discountValue) === null || num(m.discountValue) === 0, `got ${m.discountValue}`);
ok('M5 and nobody is stamped on it', m.discountApprovedById === null);
const jStill = must('M check order J', await orderById(jOrder.id));
ok('M6 the first order keeps its own approval', jStill.discountApprovedById === mgrF1.id);
await cancelPrompt();

// The same discount, sent a second time with no approval block. Re-sending a
// value the bill already has takes nothing further off it, so a 200 here is
// right — refusing idempotent retries would punish a double-tap or a retried
// request. What must NOT happen is the approval record being cleared: the
// discount has not changed, so "a manager allowed this" is still true.
//
// This needs no tampering to reach. The discount modal opens holding the
// current value, so pressing Apply discount a second time re-sends it.
const replay = await api('POST', `/api/orders/${jOrder.id}/discount`, { type: 'PERCENT', value: 10.5 });
const jReplayed = must('M after replay', await orderById(jOrder.id));
ok('M7 re-sending the same discount leaves the bill alone', replay.status < 400
  && num(jReplayed.discountValue) === 10.5
  && num(jReplayed.discountAmount) === Math.round(gross * 0.105 * 100) / 100,
  `status=${replay.status} value=${jReplayed.discountValue} amount=${jReplayed.discountAmount}`);
ok('M8 and does NOT erase who approved it', jReplayed.discountApprovedById === mgrF1.id,
  `approver=${jReplayed.discountApprovedById} at=${jReplayed.discountApprovedAt} reason=${jReplayed.discountReason}`);

// ===========================================================================
// N. Safety — 100%, a negative bill, and the cash cap
// ===========================================================================
// 100% as a cashier: far above the 10% they hold.
await applyDiscount('PERCENT', 100);
await shot('N-100pct-blocked');
ok('N1 a 100% discount is blocked for a cashier by default', await promptOpen());
let n = must('N after 100%', await orderById(mOrder.id));
ok('N2 and nothing came off the bill', num(n.discountValue) === null || num(n.discountValue) === 0,
  `got ${n.discountValue}`);

// ...and not even the manager may sign for it: 100% is over their 50%.
await approveAs('mgr.f1@test.local', 'Customer complaint, whole bill');
await shot('N-100pct-approver-over-limit');
ok('N3 100% is refused even with the manager signing', await promptOpen());
const nBody = await body();
ok('N4 the refusal names the approver’s own ceiling', /50%|approve/i.test(nBody.split(PROMPT)[1] || ''));
n = must('N after approver refusal', await orderById(mOrder.id));
ok('N5 still nothing off the bill', num(n.discountValue) === null || num(n.discountValue) === 0);
ok('N6 and nobody stamped', n.discountApprovedById === null);
await cancelPrompt();

// Over 100% and below zero are refused by the route itself.
const over100 = await api('POST', `/api/orders/${mOrder.id}/discount`, { type: 'PERCENT', value: 101 });
ok('N7 a discount over 100% is rejected outright', over100.status === 400, `status ${over100.status}`);

const negative = await api('POST', `/api/orders/${mOrder.id}/discount`, { type: 'PERCENT', value: -10 });
ok('N8 a negative discount is rejected', negative.status >= 400, `status ${negative.status}`);

const mSub = num(must('N subtotal', await orderById(mOrder.id)).subtotal);
const overBill = await api('POST', `/api/orders/${mOrder.id}/discount`,
  { type: 'FLAT', value: mSub + 500 });
ok('N9 a flat discount larger than the bill is rejected', overBill.status === 400,
  `status ${overBill.status}`);
n = must('N after over-bill attempt', await orderById(mOrder.id));
ok('N10 the bill never went negative', num(n.total) >= 0, `total=${n.total}`);

// ===========================================================================
// O. The cash cap is a real ceiling, not decoration
// ===========================================================================
// ₹50 alongside the 10%. On a ₹1000 bill the cash cap is the lower of the two
// and 10% — which the percent ceiling allows — is ₹100 and must be refused.
await setPolicy({
  level: 'COMPANY', allowLineDiscount: true, allowOrderDiscount: true,
  maxPercent: '10', maxFlatPaise: 5000,
});

await startOrder(2);
const oOrder = must('O order', await latestOrder(f1.id));
ok('O1 the order is ₹1000 gross', num(oOrder.subtotal) === 1000, `subtotal=${oOrder.subtotal}`);

await openDiscount();
const oBody = await body();
ok('O2 the till names both halves of the ceiling', /₹50\.00/.test(oBody) && /10%/.test(oBody),
  oBody.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence');
await closeAnyModal();

await applyDiscount('FLAT', 50);
ok('O3 ₹50 is inside the cash cap', !(await promptOpen()));
let o = must('O after ₹50', await orderById(oOrder.id));
ok('O4 and reached the order', num(o.discountValue) === 50, `got ${o.discountValue}`);

await applyDiscount('FLAT', 60);
await shot('O-flat-over-cap');
ok('O5 ₹60 breaches the cash cap and is stopped', await promptOpen());
o = must('O after ₹60', await orderById(oOrder.id));
ok('O6 the bill is still at ₹50', num(o.discountValue) === 50, `got ${o.discountValue}`);
await cancelPrompt();

// 10% of ₹1000 is ₹100 — allowed by the percent ceiling, refused by the cash one.
await applyDiscount('PERCENT', 10);
await shot('O-percent-over-cash-cap');
ok('O7 a percentage inside the percent ceiling is still refused by the cash cap',
  await promptOpen());
o = must('O after 10%', await orderById(oOrder.id));
ok('O8 and the order kept its ₹50', num(o.discountValue) === 50 && o.discountType === 'FLAT',
  `type=${o.discountType} value=${o.discountValue}`);
await cancelPrompt();

await setPolicy({
  level: 'COMPANY', allowLineDiscount: true, allowOrderDiscount: true, maxPercent: '10',
});

// A fixed discount that was in limit becomes out of limit when the bill shrinks.
await startOrder(2);
const pOrder = must('P order', await latestOrder(f1.id));
await applyDiscount('FLAT', 100);
ok('O9 ₹100 off ₹1000 is exactly 10% and allowed', !(await promptOpen()));
let p = must('O after ₹100', await orderById(pOrder.id));
ok('O10 and it reached the order', num(p.discountValue) === 100, `got ${p.discountValue}`);

// Clicking the same product twice stacks quantity on ONE line, so "Remove
// line" empties the bill to ₹0 rather than halving it — which tests nothing,
// because a ₹100 discount on a ₹0 bill has no percentage to breach. Dropping
// the quantity is the case the route's own comment describes: the discount
// field is untouched and the bill it is measured against shrinks underneath it.
await page.click('[aria-label="Decrease quantity"]');
await page.waitForTimeout(1800);
await shot('O-shrink-the-bill');
ok('O11 halving the bill under a fixed discount is stopped — ₹100 off ₹500 is 20%',
  await promptOpen());
p = must('O after quantity drop', await orderById(pOrder.id));
ok('O12 the quantity did not move', num(p.subtotal) === 1000, `subtotal=${p.subtotal}`);
await cancelPrompt();

// ===========================================================================
// P. The API answers the same way as the screen
// ===========================================================================
await startOrder(1);
const qOrder = must('P bypass order', await latestOrder(f1.id));

const bypass = await api('POST', `/api/orders/${qOrder.id}/discount`, { type: 'PERCENT', value: 50 });
ok('P1 50% sent straight at the API is refused', bypass.status === 403, `status ${bypass.status}`);
ok('P2 and the refusal says approval is required', bypass.body?.approvalRequired === true
  || /approv/i.test(JSON.stringify(bypass.body ?? {})), JSON.stringify(bypass.body ?? {}).slice(0, 160));
let q = must('P after bypass', await orderById(qOrder.id));
ok('P3 nothing came off the bill', num(q.discountValue) === null || num(q.discountValue) === 0,
  `got ${q.discountValue}`);

// An approval block the cashier filled in for themselves. The reason has to
// clear reasonSchema's min(3) or this is a 400 about the reason and proves
// nothing about who may approve.
const selfBlock = await api('POST', `/api/orders/${qOrder.id}/discount`, {
  type: 'PERCENT', value: 50,
  approval: { approverEmail: 'cashier.f1@test.local', password: PW, reason: 'Approving my own bill' },
});
ok('P4 a cashier naming themselves as approver is refused', selfBlock.status === 403,
  `status ${selfBlock.status}`);

// A real approver, a wrong password.
const badPw = await api('POST', `/api/orders/${qOrder.id}/discount`, {
  type: 'PERCENT', value: 50,
  approval: { approverEmail: 'mgr.f1@test.local', password: 'not-the-password', reason: 'Manager said yes' },
});
ok('P5 a real approver with the wrong password is refused', badPw.status === 403,
  `status ${badPw.status}`);
q = must('P after credential attempts', await orderById(qOrder.id));
ok('P6 the bill survived all three attempts untouched',
  num(q.discountValue) === null || num(q.discountValue) === 0, `got ${q.discountValue}`);

// A line discount is guarded by the same ceiling as an order discount.
const lineBypass = await api('POST', `/api/orders/${qOrder.id}/discount`, { type: 'FLAT', value: 400 });
ok('P7 a flat discount worth 80% of the bill is refused', lineBypass.status === 403,
  `status ${lineBypass.status}`);

// Another branch's order is not reachable at all.
const f2Order = await prisma.order.findFirst({ where: { branchId: f2.id }, orderBy: { createdAt: 'desc' } });
if (f2Order) {
  const crossBranch = await api('POST', `/api/orders/${f2Order.id}/discount`, { type: 'PERCENT', value: 5 });
  ok('P8 a cashier cannot discount another branch’s order', crossBranch.status >= 400,
    `status ${crossBranch.status}`);
}

// ===========================================================================
// Q. Branch override — Foxtrot Two's till, 20%
// ===========================================================================
await logout();
await login('cashier.f2@test.local');
await startOrder(1);
const rOrder = must('Q order', await latestOrder(f2.id));
ok('Q1 the order opened at Foxtrot Two', rOrder.branchId === f2.id);

await openDiscount();
const rBody = await body();
ok('Q2 the other branch’s till states 20%, not the company 10%', /Your limit is 20%/.test(rBody),
  rBody.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence');
await closeAnyModal();

await applyDiscount('PERCENT', 20);
ok('Q3 20% applies at the overridden branch with no prompt', !(await promptOpen()));
let r = must('Q after 20%', await orderById(rOrder.id));
ok('Q4 and reached the order', num(r.discountValue) === 20, `got ${r.discountValue}`);

await applyDiscount('PERCENT', 21);
await shot('Q-f2-over-limit');
ok('Q5 21% is above even the raised branch limit', await promptOpen());
r = must('Q after 21%', await orderById(rOrder.id));
ok('Q6 the bill is still at 20%', num(r.discountValue) === 20, `got ${r.discountValue}`);

// Foxtrot One's manager may not sign here, and Foxtrot Two's may.
await approveAs('mgr.f1@test.local', 'Trying from the other branch');
ok('Q7 the other branch’s manager is turned away', await promptOpen());
r = must('Q after cross-branch', await orderById(rOrder.id));
ok('Q8 nothing moved', num(r.discountValue) === 20 && r.discountApprovedById === null,
  `value=${r.discountValue} approver=${r.discountApprovedById}`);

await approveAs('mgr.f2@test.local', 'Regular customer, manager approved');
ok('Q9 this branch’s manager gets through', !(await promptOpen()));
r = must('Q after approval', await orderById(rOrder.id));
ok('Q10 the 21% is on the bill', num(r.discountValue) === 21, `got ${r.discountValue}`);
ok('Q11 stamped by the manager of this branch', r.discountApprovedById === mgrF2.id);

// and the company default is untouched at the branch with no override
const f1Audit = await auditFor(jOrder.id);
const f1Ceiling = f1Audit.find((a) => a.meta?.actorLimit)?.meta?.actorLimit;
ok('Q12 Foxtrot One is still measured against the company 10%',
  f1Ceiling?.maxPctMilli === 10000, `maxPctMilli=${f1Ceiling?.maxPctMilli}`);

// ===========================================================================
// R. Per-staff policy
// ===========================================================================
await logout();

// A cashier trusted with less than the company default.
await setPolicy({ level: 'USER', userId: cashierF1.id, maxPercent: '5' });
await login('cashier.f1@test.local');
await startOrder(1);
const sOrder = must('R order', await latestOrder(f1.id));
await openDiscount();
const sBody = await body();
ok('R1 a per-staff limit beats the company default downwards', /Your limit is 5%/.test(sBody),
  sBody.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence');
await closeAnyModal();

await applyDiscount('PERCENT', 5);
ok('R2 5% applies', !(await promptOpen()));
let s = must('R after 5%', await orderById(sOrder.id));
ok('R3 and reached the order', num(s.discountValue) === 5, `got ${s.discountValue}`);

await applyDiscount('PERCENT', 8);
await shot('R-staff-lower-limit');
ok('R4 8% is above the per-staff 5% even though the company allows 10%', await promptOpen());
s = must('R after 8%', await orderById(sOrder.id));
ok('R5 the bill is still at 5%', num(s.discountValue) === 5, `got ${s.discountValue}`);
await cancelPrompt();

// A cashier trusted with more.
await setPolicy({ level: 'USER', userId: cashierF1.id, maxPercent: '25' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await startOrder(1);
const tOrder = must('R raised order', await latestOrder(f1.id));
await openDiscount();
const tBody = await body();
ok('R6 a per-staff limit beats the company default upwards', /Your limit is 25%/.test(tBody),
  tBody.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence');
await closeAnyModal();

await applyDiscount('PERCENT', 25);
ok('R7 25% applies with no approval', !(await promptOpen()));
let t = must('R after 25%', await orderById(tOrder.id));
ok('R8 and reached the order', num(t.discountValue) === 25, `got ${t.discountValue}`);
ok('R9 with nobody recorded as approving', t.discountApprovedById === null);

await clearPolicy({ level: 'USER', userId: cashierF1.id });

// The manager's approval ceiling is not their own discount ceiling.
await logout();
await login('mgr.f1@test.local');
await startOrder(1);
const uOrder = must('R manager order', await latestOrder(f1.id));
await openDiscount();
const uBody = await body();
ok('R10 a 50% approval ceiling does NOT raise the manager’s own limit',
  /Your limit is 10%/.test(uBody),
  uBody.match(/Your limit is[^.]*/)?.[0] || 'no limit sentence');
await closeAnyModal();

await applyDiscount('PERCENT', 30);
await shot('R-manager-own-limit');
ok('R11 the manager must still be approved for 30% of their own bill', await promptOpen());
let u = must('R after manager 30%', await orderById(uOrder.id));
ok('R12 nothing applied on the strength of being a manager',
  num(u.discountValue) === null || num(u.discountValue) === 0, `got ${u.discountValue}`);

// They may sign for themselves — and it is recorded as such.
await approveAs('mgr.f1@test.local', 'Late shift, no one else on');
ok('R13 a manager may sign their own above-limit discount', !(await promptOpen()));
u = must('R after self-approval', await orderById(uOrder.id));
ok('R14 and it applies', num(u.discountValue) === 30, `got ${u.discountValue}`);
const uAudit = await auditFor(uOrder.id);
const selfApproved = uAudit.find((a) => a.action === 'ORDER_DISCOUNT_SET' && a.meta?.approvedBy);
ok('R15 the trail marks it as self-approved',
  selfApproved?.meta?.approvedBy?.selfApproved === true,
  `selfApproved=${selfApproved?.meta?.approvedBy?.selfApproved}`);

// ===========================================================================
// S. What the trail can answer months later
// ===========================================================================
const sAudit = await auditFor(jOrder.id);
const approvedRow = sAudit.find((a) => a.action === 'ORDER_DISCOUNT_SET' && a.meta?.approvedBy);
const deniedRow = sAudit.find((a) => a.action === 'ORDER_DISCOUNT_DENIED');

ok('S1 the order it happened on', approvedRow?.entityId === jOrder.id);
ok('S2 what was asked for', approvedRow?.meta?.value === 10.5 && approvedRow?.meta?.type === 'PERCENT',
  `${approvedRow?.meta?.type} ${approvedRow?.meta?.value}`);
ok('S3 who asked', approvedRow?.actorId === cashierF1.id);
ok('S4 and the role they held at the time', approvedRow?.actorRole === 'CASHIER',
  `actorRole=${approvedRow?.actorRole}`);
ok('S5 the ceiling it was measured against', approvedRow?.meta?.actorLimit?.maxPctMilli === 10000,
  `maxPctMilli=${approvedRow?.meta?.actorLimit?.maxPctMilli}`);
ok('S6 who allowed it, separately from who rang it up',
  approvedRow?.meta?.approvedBy?.id === mgrF1.id
  && approvedRow?.meta?.approvedBy?.id !== approvedRow?.actorId);
ok('S7 why', approvedRow?.meta?.approvalReason === 'Spillage, comped by manager',
  `reason=${approvedRow?.meta?.approvalReason}`);
ok('S8 the branch', approvedRow?.meta?.branchId === f1.id);
// NB the key differs by action: an allowed discount records
// `combinedDiscountPaise` (discountAudit in orders.js) and a refusal records
// `combinedPaise` (exposureForAudit in discountGuard.js). Same number, two
// names — anything querying this table has to know which action it is reading.
ok('S9 the bill before and after', approvedRow?.meta?.before?.combinedDiscountPaise === 5000
  && approvedRow?.meta?.after?.combinedDiscountPaise === 5250,
  `before=${approvedRow?.meta?.before?.combinedDiscountPaise} after=${approvedRow?.meta?.after?.combinedDiscountPaise}`);
ok('S10 when', !!approvedRow?.at);
ok('S11 the earlier refusal is recorded too, with its breach',
  !!deniedRow && deniedRow.meta?.breach?.kind === 'PERCENT',
  `breach=${JSON.stringify(deniedRow?.meta?.breach ?? null)}`);
ok('S12 one approval for this order, not two',
  sAudit.filter((a) => a.action === 'ORDER_DISCOUNT_SET' && a.meta?.approvedBy).length === 1);

// Nothing anywhere ended up below zero.
const negatives = await prisma.order.count({ where: { companyId: fox.id, total: { lt: 0 } } });
ok('S13 no order in the company has a negative total', negatives === 0, `found ${negatives}`);

await baseline();
await browser.close();
await prisma.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`failing: ${failed.join(', ')}`);
console.log(`screenshots: ${OUT}`);
process.exit(fail ? 1 : 0);
