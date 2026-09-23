// Discount APPROVAL browser acceptance against the deployed POS.
//
// The last unproven leg of VEXO Connect Core. `billing-browser-run.mjs` proved
// that a discount can be applied, billed, paid and reported; it proved nothing
// about who is *allowed* to apply one, because it ran as the owner, and the
// owner's ceiling is unlimited. Every refusal in discountGuard.js was therefore
// still theory in production.
//
// This run drives the refusal path itself, in a real browser, as a real
// cashier:
//
//   owner sets a 10% cashier ceiling and a 20% manager approval ceiling
//   → cashier discounts 10%            must succeed with NO approval
//   → cashier discounts 25%            must NOT apply; approval prompt appears
//   → wrong approver password          must fail, order unchanged
//   → 40% with a real manager          must fail: over the APPROVER's own limit
//   → 15% with that same manager       must succeed, inside their delegated 20%
//   → reload and re-apply              must not duplicate or compound
//   → manager voids the order          cleanup through the app, not the database
//
// The fifth and sixth steps are the ones worth the trouble. "A manager can
// approve it" is not the claim being tested — the claim is that a manager can
// approve it *only up to the limit their owner gave them*, and an approval
// path that cannot refuse its own approver is a rubber stamp with a password
// on it.
//
// No password is ever printed, and the redaction check at the end reads the
// audit rows and the backend log into THIS process to search them, rather than
// passing a password to psql or grep where it would sit in the process table.
//
// ---- which till, and why -----------------------------------------------
// BSC-CP (Connaught Place). BSC-CH is reserved, already carries a filed day
// closing for today, and is explicitly out of scope — so it is refused in
// config below, before a browser starts. BSC-CP has no closing dependency:
// nothing files a closing on it, which is what makes an extra order there
// harmless. The order this run opens is voided before it exits, and a void is
// an audited application-level state change, not a deletion.
//
// This run does NOT bill, pay, refund, close a day, or touch Razorpay. There
// is no code here that could: the only POSTs it can cause are the discount
// routes, the order/line routes that create the test order, and the void.
//
//   EXPLORE=1 node deploy/discount-approval-run.mjs   # read-only reconnaissance
//   node deploy/discount-approval-run.mjs             # the flow above (WRITES)
//
// Invocation is by that exact form, from the repo root. If the environment
// refuses it, the refusal is the result.

import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';

const BASE = (process.env.BASE_URL || 'https://atcworkspace.com/pos').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/home/atc-noc/pos-discount-approval-run';
const CREDS = '/home/atc-noc/pos-demo-creds-20260921.txt';
const EXPLORE = process.env.EXPLORE === '1';

const OWNER = 'demo.owner@atcpos.example';
const MANAGER = 'demo.manager@atcpos.example';
const CASHIER = 'demo.cashier@atcpos.example';

const TILL = process.env.TILL || 'BSC-CP';
// Out of scope by instruction, and it has a permanent closing filed for today:
// an order opened on it now would sit outside that closing forever. Refused in
// config rather than checked later, because "later" is after the write.
const FORBIDDEN_TILL = 'BSC-CH';
if (TILL === FORBIDDEN_TILL) {
  throw new Error(`refusing to run on ${FORBIDDEN_TILL}: it is reserved, its day closing for `
    + 'today is already filed, and this run is explicitly scoped away from it.');
}
const TILL_NAME_RE = { 'BSC-CP': /Connaught Place/ }[TILL];
if (!TILL_NAME_RE) throw new Error(`no display name known for till ${TILL}`);

// The numbers the whole run turns on. Named, so the assertions below read as
// the policy they are testing rather than as magic constants.
const CASHIER_PCT = 10;   // what the owner grants the cashier
const APPROVER_PCT = 20;  // what the owner grants the manager to APPROVE
const WITHIN = 10;        // at the cashier's ceiling exactly — must pass alone
const OVER = 25;          // over the cashier, under nothing — needs a signature
const OVER_APPROVER = 40; // over the MANAGER's ceiling too — must be refused
const APPROVED = 15;      // over the cashier, inside the manager's 20%

// Deliberately not a password. Never read from the credentials file, so a
// mistake here cannot accidentally send a real one.
const WRONG_PASSWORD = 'not-the-managers-password-0000';

// Pick up an order this run already opened instead of opening another.
//
// The first writing pass died between creating the order and reading it back
// — a bad interpolation in this file, not a fault in the POS — and left a real
// two-line OPEN order behind. Re-running from the top would not have retried
// that order, it would have opened a SECOND one, which is exactly how a till
// ends the day describing trade that never happened. Named explicitly rather
// than auto-detected: BSC-CP carries other sessions' acceptance traffic, and
// "the newest open order by this cashier" is a guess that looks right until
// the day it isn't.
const ADOPT_ORDER = (process.env.ADOPT_ORDER || '').trim();
if (ADOPT_ORDER && !/^[a-z0-9]{20,40}$/i.test(ADOPT_ORDER)) {
  throw new Error(`ADOPT_ORDER is not an order id: ${JSON.stringify(ADOPT_ORDER)}`);
}

mkdirSync(OUT, { recursive: true });

// Read-only SQL against the production database, via the container — the prod
// Postgres publishes no host port.
//
// The subquery alias is `_q`, not `t`. With `t`, a query that named a column
// `t` made `json_agg(t)` resolve to the COLUMN rather than the row, and the
// wrapper silently returned `["2026-09-23T09:04:12"]` instead of
// `[{"t":"..."}]` — so `[0].t` read `undefined` and the caller interpolated
// the word "undefined" into the next statement. It failed loudly here; the
// same shape in a WHERE clause is the kind that quietly matches everything.
function q(sql) {
  const out = execFileSync('docker', [
    'exec', '-i', 'pos-prod-postgres-1',
    'psql', '-U', 'atc_pos', '-d', 'atc_pos', '-tA', '-c',
    `select coalesce(json_agg(_q), '[]') from (${sql}) _q`,
  ], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

const pw = (email) => {
  for (const l of readFileSync(CREDS, 'utf8').split('\n')) {
    if (l.startsWith('#') || !l.trim()) continue;
    const [e, p] = l.split('\t');
    if (e?.trim().toLowerCase() === email) return p?.trim();
  }
  throw new Error(`no credentials entry for ${email}`);
};

const log = (k, v = '') => console.log(`${String(k).padEnd(52)} ${v}`);
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, detail ?? '');
};

// ---- preconditions, before a browser is started -------------------------
const BIZ_DATE = q("select to_char(now() at time zone 'Asia/Kolkata','YYYY-MM-DD') as d")[0].d;
const START_ISO = q(
  "select to_char(now() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') as started",
)[0].started;
if (!START_ISO) throw new Error('could not read the run start time from the database');

const who = q(`select email, role, status, "mustChangePassword" as must_change,
       "fullName" as name, "branchId" as branch_id, id
  from "PosUser" where email in ('${OWNER}','${MANAGER}','${CASHIER}')`);
const byEmail = Object.fromEntries(who.map((u) => [u.email, u]));
for (const e of [OWNER, MANAGER, CASHIER]) {
  const u = byEmail[e];
  if (!u) throw new Error(`${e} does not exist — refusing to create a production identity`);
  if (u.status !== 'ACTIVE') throw new Error(`${e} is ${u.status} — refusing to enable it`);
  if (u.must_change) throw new Error(`${e} must change its password — refusing to reset it`);
}
const till = q(`select id, code, name, status from "Branch" where code = '${TILL}'`)[0];
if (!till) throw new Error(`till ${TILL} not found`);
if (byEmail[CASHIER].branch_id !== till.id) {
  throw new Error(`${CASHIER} is not assigned to ${TILL} — refusing to reassign staff`);
}
if (byEmail[MANAGER].branch_id !== till.id) {
  throw new Error(`${MANAGER} is not assigned to ${TILL}, so their approval would be refused `
    + 'for the wrong reason (APPROVER_WRONG_BRANCH) and the ceiling test would prove nothing.');
}
// An order opened after a closing is filed falls outside it permanently.
const closings = q(`select count(*)::int as n from "DayClose" d join "Branch" b on b.id = d."branchId"
  where b.code = '${TILL}' and d."businessDate" = '${BIZ_DATE}'`)[0].n;
if (closings !== 0) {
  throw new Error(`${TILL} already has ${closings} closing(s) for ${BIZ_DATE} — an order opened `
    + 'now would sit outside it. Refusing.');
}

log('till', `${till.code} — ${till.name} (${till.status}), business date ${BIZ_DATE}`);
log('cashier', `${byEmail[CASHIER].name} · ${byEmail[CASHIER].role}`);
log('approver', `${byEmail[MANAGER].name} · ${byEmail[MANAGER].role}`);
log('policy rows now', String(q('select count(*)::int as n from "DiscountPolicy"')[0].n));
log('day closings on till today', `${closings} (required: 0)`);

const orderRow = (id) => q(`select o.id, o.status, o."discountType"::text as disc_type,
    o."discountValue"::float8 as disc_value, o."discountAmount"::float8 as disc_amount,
    o.subtotal::float8 as subtotal, o."taxAmount"::float8 as tax, o.total::float8 as total,
    o."discountApprovedById" as approved_by, o."discountReason" as reason,
    o."openedById" as opened_by, o."invoiceNumber" as invoice,
    (select count(*)::int from "Payment" p where p."orderId" = o.id) as payments,
    (select count(*)::int from "Refund" r where r."orderId" = o.id) as refunds
  from "Order" o where o.id = '${id}'`)[0];

// Only this run's rows. The order may be adopted from an earlier pass, and an
// assertion that "an ORDER_DISCOUNT_DENIED exists" would then pass on evidence
// this run did not produce — a check that cannot fail is not a check.
// `m` is the parsed meta. Asserting against the TEXT was a quiet mistake in
// the first pass: psql renders jsonb as `"actorLimit": {…}` with a space, so
// /"actorLimit":\{/ never matched and five checks failed against a trail that
// was in fact complete. Parse it and read fields, rather than pattern-match a
// rendering that is not part of any contract.
const auditFor = (id) => q(`select a.action, a."actorRole" as actor_role, a."actorId" as actor_id,
    a.meta::text as meta,
    to_char(a.at at time zone 'UTC' at time zone 'Asia/Kolkata','HH24:MI:SS') as at
  from "PosAuditLog" a
  where a."entityId" = '${id}' and a.at >= timestamp '${START_ISO}' order by a.at asc`)
  .map((a) => ({ ...a, m: JSON.parse(a.meta) }));

if (EXPLORE) {
  log('', '');
  log('EXPLORE', 'preconditions only — no browser started, nothing written');
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

// Each role gets its own context. Sharing one and logging out between roles
// would leave the run's result depending on a logout working, which is not
// what is being tested here.
const newPage = async (label) => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  let signedIn = false;
  const errors = [];
  const note = (t) => errors.push({
    text: t,
    // The SPA asks GET /api/auth/me on a cold boot; there is no session yet
    // and the server correctly answers 401. Forgiven only before sign-in —
    // one after that means the session was lost mid-flow.
    benign: !signedIn && /Failed to load resource/.test(t) && /\b401\b/.test(t),
  });
  page.on('console', (m) => { if (m.type() === 'error') note(m.text()); });
  page.on('pageerror', (e) => note(`pageerror: ${e.message}`));
  page.__errors = errors;
  page.__label = label;
  page.__signIn = () => { signedIn = true; };
  return page;
};

const signIn = async (page, email) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', pw(email));
  await page.click('button[type="submit"]');
  await page.locator('button[type="submit"]:has-text("Signing in…")')
    .waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !location.pathname.endsWith('/login'), null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle');
  if (/\/login$/.test(new URL(page.url()).pathname)) {
    const why = await page.locator('[role="alert"], .text-red-600, .text-red-700').first()
      .innerText().catch(() => '');
    throw new Error(`login did not complete for ${email}${why ? `: ${why.trim()}` : ''}`);
  }
  page.__signIn();
  log(`signed in · ${page.__label}`, page.url().replace(BASE, ''));
};

// Every overlay in this app is `div.fixed.inset-0.z-50` dismissed by a
// mousedown on the backdrop; nothing closes on Escape. Ask the page which
// viewport corner is genuinely the backdrop rather than guessing (5,5), and
// click the backdrop and NOTHING else — modal headers carry live buttons.
const OVERLAY = 'div.fixed.inset-0.z-50';
const overlays = (page) => page.evaluate((sel) => {
  const live = [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length);
  return live.map((el) => {
    const { innerWidth: w, innerHeight: h } = window;
    const spot = [[5, 5], [w - 5, 5], [5, h - 5], [w - 5, h - 5]]
      .find(([x, y]) => document.elementFromPoint(x, y) === el) || null;
    return {
      title: (el.querySelector('h2, h3')?.innerText || '').trim() || '(untitled)',
      error: (el.querySelector('.text-red-700')?.innerText || '').trim(),
      spot,
    };
  });
}, OVERLAY);

const dismissTop = async (page) => {
  const up = await overlays(page);
  if (!up.length) return null;
  const top = up[up.length - 1];
  if (!top.spot) throw new Error(`overlay "${top.title}" has no reachable backdrop`);
  await page.mouse.click(top.spot[0], top.spot[1]);
  await page.waitForTimeout(400);
  return top.title;
};

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

let orderId = null;
let cashierPage = null;

try {
  // =====================================================================
  // A. the owner sets the ceilings
  // =====================================================================
  const owner = await newPage('owner');
  await signIn(owner, OWNER);
  await owner.goto(`${BASE}/discounts`, { waitUntil: 'networkidle' });
  await owner.waitForTimeout(1200);
  await shot(owner, '01-discounts-before');

  const rowFor = (name) => owner.locator('tr', { hasText: name }).first();
  const beforeGive = (await rowFor('Demo Cashier').innerText().catch(() => '')).replace(/\s+/g, ' ');
  log('  cashier row before', beforeGive.trim());

  // Fills the seven-field policy modal. `null` means "leave on Inherit".
  const setPolicy = async (subject, fields) => {
    await owner.getByRole('button', { name: `Edit ${subject}` }).first().click();
    await owner.waitForTimeout(700);
    for (const [id, value] of Object.entries(fields)) {
      if (value === null) continue;
      if (typeof value === 'boolean') await owner.selectOption(`#${id}`, value ? 'yes' : 'no');
      else await owner.fill(`#${id}`, String(value));
    }
    await owner.getByRole('button', { name: 'Save' }).first().click();
    await owner.waitForTimeout(1600);
    const stillUp = (await overlays(owner)).find((o) => /—|default|override/.test(o.title));
    if (stillUp?.error) throw new Error(`saving ${subject}'s policy was refused: ${stillUp.error}`);
    await owner.waitForTimeout(600);
  };

  await setPolicy('Demo Cashier', {
    'allow-line': true,
    'allow-order': true,
    'max-pct': CASHIER_PCT,
    'policy-note': `Core acceptance ${BIZ_DATE}: ${CASHIER_PCT}% cashier ceiling`,
  });
  await setPolicy('Demo Branch Manager', {
    'can-approve': true,
    'max-appr-pct': APPROVER_PCT,
    'policy-note': `Core acceptance ${BIZ_DATE}: may approve to ${APPROVER_PCT}%`,
  });
  await owner.reload({ waitUntil: 'networkidle' });
  await owner.waitForTimeout(1400);
  await shot(owner, '02-discounts-after');

  const cashierRow = (await rowFor('Demo Cashier').innerText()).replace(/\s+/g, ' ');
  const managerRow = (await rowFor('Demo Branch Manager').innerText()).replace(/\s+/g, ' ');
  log('  cashier row after', cashierRow.trim());
  log('  manager row after', managerRow.trim());

  check('1.1 the owner screen shows the cashier a 10% ceiling',
    new RegExp(`\\b${CASHIER_PCT}%`).test(cashierRow), cashierRow.trim());
  check('1.2 the owner screen shows the manager may approve to 20%',
    new RegExp(`\\b${APPROVER_PCT}%`).test(managerRow), managerRow.trim());

  const pol = q(`select p.level::text as level, u.email, p."maxPercent"::float8 as max_pct,
      p."canApprove" as can_approve, p."maxApprovalPercent"::float8 as max_appr_pct,
      p."allowOrderDiscount" as allow_order
    from "DiscountPolicy" p left join "PosUser" u on u.id = p."userId" order by p."createdAt"`);
  const cashPol = pol.find((p) => p.email === CASHIER);
  const mgrPol = pol.find((p) => p.email === MANAGER);
  check('1.3 the cashier ceiling reached the database',
    cashPol?.max_pct === CASHIER_PCT && cashPol?.allow_order === true,
    cashPol ? `maxPercent=${cashPol.max_pct} allowOrder=${cashPol.allow_order}` : 'no row');
  check('1.4 the manager approval scope reached the database',
    mgrPol?.can_approve === true && mgrPol?.max_appr_pct === APPROVER_PCT,
    mgrPol ? `canApprove=${mgrPol.can_approve} maxApprovalPercent=${mgrPol.max_appr_pct}` : 'no row');
  // Separation of duties: approving for somebody else is not the same
  // permission as spending yourself, and the manager was granted only the
  // first. If this ever reads true the two have been conflated.
  check('1.5 approving is a separate grant from giving — the manager got only the first',
    mgrPol?.allow_order !== true, `manager allowOrderDiscount = ${String(mgrPol?.allow_order)}`);

  // =====================================================================
  // B. the cashier
  // =====================================================================
  cashierPage = await newPage('cashier');
  const page = cashierPage;
  await signIn(page, CASHIER);

  if (ADOPT_ORDER) {
    // Prove it is this run's own order before writing a single discount to it.
    const adopt = q(`select o.id, o.status, o."openedById" as opened_by, b.code as till,
        (select count(*)::int from "Payment" p where p."orderId" = o.id) as payments,
        (select count(*)::int from "Refund" r where r."orderId" = o.id) as refunds,
        (select count(*)::int from "OrderItem" i where i."orderId" = o.id) as lines
      from "Order" o join "Branch" b on b.id = o."branchId" where o.id = '${ADOPT_ORDER}'`)[0];
    if (!adopt) throw new Error(`ADOPT_ORDER ${ADOPT_ORDER} does not exist`);
    if (adopt.till !== TILL) throw new Error(`that order is on ${adopt.till}, not ${TILL}`);
    if (adopt.status !== 'OPEN') throw new Error(`that order is ${adopt.status}, not OPEN`);
    if (adopt.opened_by !== byEmail[CASHIER].id) {
      throw new Error('that order was opened by somebody else — refusing to write to it');
    }
    if (adopt.payments !== 0 || adopt.refunds !== 0) {
      throw new Error(`that order has ${adopt.payments} payment(s) and ${adopt.refunds} refund(s) `
        + '— this run does not touch money');
    }
    if (adopt.lines < 1) throw new Error('that order has no lines to discount');
    orderId = adopt.id;
    log('  adopted order', `${orderId} (${adopt.lines} lines) — not opening a second one`);
    await page.goto(`${BASE}/sell?order=${orderId}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
  } else {
    await page.goto(`${BASE}/sell`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const branchSel = page.locator('#sell-branch');
    if (await branchSel.isVisible().catch(() => false)) {
      const opts = await page.locator('#sell-branch option').allInnerTexts();
      const want = opts.find((o) => TILL_NAME_RE.test(o));
      if (want) await page.selectOption('#sell-branch', { label: want });
      await page.waitForTimeout(600);
    }
    // `exact` matters: the open-orders list on the same screen carries entries
    // like "Takeaway ₹94.50 BILLED" from earlier acceptance traffic, and a
    // substring match resolves to both, which is a strict-mode violation.
    await page.getByRole('button', { name: 'Takeaway', exact: true }).click();
    await page.waitForTimeout(800);

    const pick = async (name) => {
      await page.locator('button', { hasText: new RegExp(`^${name}\\b`) }).first().click();
      if (await page.getByRole('dialog').isVisible().catch(() => false)) {
        await page.getByRole('dialog').locator('button').first().click();
      }
      await page.waitForTimeout(500);
    };
    await pick('Masala Chai');
    await pick('Grilled Veg Sandwich');
    await page.waitForTimeout(800);

    const mine = q(`select o.id from "Order" o join "Branch" b on b.id = o."branchId"
      where b.code = '${TILL}' and o."openedById" = '${byEmail[CASHIER].id}'
        and o."createdAt" >= timestamp '${START_ISO}' order by o."createdAt" desc limit 2`);
    if (mine.length !== 1) {
      throw new Error(`expected exactly one new order from this run, found ${mine.length}`);
    }
    orderId = mine[0].id;
  }
  const opened = orderRow(orderId);
  log('  order', `${orderId} · subtotal ₹${opened.subtotal} · total ₹${opened.total}`);
  check('2.1 the cashier opened exactly one order',
    opened.status === 'OPEN' && opened.opened_by === byEmail[CASHIER].id,
    `${opened.status}, openedBy = the cashier`);
  await shot(page, '03-order-open');

  const GROSS = opened.subtotal;
  const pctOf = (p) => Math.round(GROSS * p) / 100;

  // Opens the discount modal, types a percentage, submits. Returns without
  // waiting for a verdict — the caller decides what the verdict should be.
  const applyPercent = async (value) => {
    const up = await overlays(page);
    if (!up.some((o) => /^Order discount$/.test(o.title))) {
      await page.getByRole('button', { name: 'Edit order discount' }).first().click();
      await page.waitForTimeout(700);
    }
    await page.getByRole('button', { name: '% Percent' }).first().click();
    await page.fill('#disc-value', String(value));
    await page.getByRole('button', { name: /^Apply discount$/ }).first().click();
  };

  // ---- 3. within the cashier's own limit: no signature required --------
  await applyPercent(WITHIN);
  await page.waitForTimeout(2500);
  const afterWithin = orderRow(orderId);
  const upAfterWithin = await overlays(page);
  await shot(page, '04-within-limit');
  check(`3.1 ${WITHIN}% is inside the cashier's ceiling and applied with no approval`,
    Math.abs(afterWithin.disc_amount - pctOf(WITHIN)) < 0.01 && afterWithin.disc_type === 'PERCENT',
    `discountAmount ₹${afterWithin.disc_amount} (expected ₹${pctOf(WITHIN)})`);
  check('3.2 nothing asked for a manager',
    !upAfterWithin.some((o) => /manager needs to approve/i.test(o.title)),
    upAfterWithin.map((o) => o.title).join(', ') || 'no overlay up');
  check('3.3 an unapproved discount carries no approver',
    afterWithin.approved_by === null && afterWithin.reason === null,
    `discountApprovedById=${afterWithin.approved_by}, discountReason=${afterWithin.reason}`);

  // ---- 4. above the cashier's limit: must not apply --------------------
  await applyPercent(OVER);
  await page.waitForTimeout(3000);
  const afterOver = orderRow(orderId);
  const promptUp = await overlays(page);
  await shot(page, '05-approval-prompt');
  const approvalUp = promptUp.some((o) => /manager needs to approve/i.test(o.title));
  check(`4.1 ${OVER}% did NOT apply on the cashier's own authority`,
    Math.abs(afterOver.disc_amount - pctOf(WITHIN)) < 0.01,
    `discountAmount still ₹${afterOver.disc_amount}, not ₹${pctOf(OVER)}`);
  check('4.2 the approval prompt appeared', approvalUp,
    promptUp.map((o) => o.title).join(' / ') || 'no overlay up');
  check('4.3 the refusal was recorded before anyone was asked to sign',
    auditFor(orderId).some((a) => a.action === 'ORDER_DISCOUNT_DENIED'),
    auditFor(orderId).map((a) => a.action).join(', '));

  const approve = async (email, password, reason) => {
    await page.fill('#approver-email', email);
    await page.fill('#approver-password', password);
    await page.fill('#approver-reason', reason);
    await page.getByRole('button', { name: /^Approve$/ }).first().click();
    await page.waitForTimeout(3500);
  };

  // ---- 5. wrong approver password --------------------------------------
  await approve(MANAGER, WRONG_PASSWORD, 'Acceptance: wrong password must not pass');
  const afterWrong = orderRow(orderId);
  const wrongUp = await overlays(page);
  await shot(page, '06-wrong-password');
  const wrongErr = wrongUp.map((o) => o.error).filter(Boolean).join(' | ');
  check('5.1 a wrong approver password was refused', !!wrongErr, wrongErr || 'no error shown');
  check('5.2 the order was not changed by the failed approval',
    Math.abs(afterWrong.disc_amount - pctOf(WITHIN)) < 0.01 && afterWrong.approved_by === null,
    `discountAmount ₹${afterWrong.disc_amount}, approver ${afterWrong.approved_by}`);
  check('5.3 the prompt stayed open instead of retrying by itself',
    wrongUp.some((o) => /manager needs to approve/i.test(o.title)),
    wrongUp.map((o) => o.title).join(' / '));
  const wrongAudit = auditFor(orderId).filter((a) => a.action === 'ORDER_DISCOUNT_APPROVAL_FAILED');
  check('5.4 the failure names the reason, not the credential',
    wrongAudit.some((a) => /BAD_PASSWORD/.test(a.meta)),
    wrongAudit.map((a) => (a.meta.match(/"refusal":\s*"[A-Z_]+"/) || ['?'])[0]).join(', '));

  // ---- 6. over the APPROVER's own delegated limit ----------------------
  // The manager's credentials here are correct. The refusal has to come from
  // their ceiling, not from their password — that is the whole point.
  await dismissTop(page);           // close the prompt
  await page.waitForTimeout(600);
  await applyPercent(OVER_APPROVER);
  await page.waitForTimeout(3000);
  const overApprUp = await overlays(page);
  check('6.1 a discount over the approver ceiling still prompts first',
    overApprUp.some((o) => /manager needs to approve/i.test(o.title)),
    overApprUp.map((o) => o.title).join(' / ') || 'no overlay');
  await approve(MANAGER, pw(MANAGER), 'Acceptance: over the approver own ceiling');
  const afterOverAppr = orderRow(orderId);
  const overApprAfter = await overlays(page);
  await shot(page, '07-over-approver-limit');
  const overErr = overApprAfter.map((o) => o.error).filter(Boolean).join(' | ');
  check(`6.2 ${OVER_APPROVER}% was refused even with a valid manager signature`,
    Math.abs(afterOverAppr.disc_amount - pctOf(WITHIN)) < 0.01 && !!overErr,
    `discountAmount still ₹${afterOverAppr.disc_amount} · "${overErr}"`);
  const overAudit = auditFor(orderId).filter((a) => /APPROVER_OVER/.test(a.meta));
  check('6.3 the refusal was the approver ceiling, not the password',
    overAudit.length > 0 && /APPROVER_OVER_LIMIT/.test(JSON.stringify(overAudit)),
    overAudit.length ? 'ORDER_DISCOUNT_APPROVAL_FAILED refusal=APPROVER_OVER_LIMIT' : 'not recorded');

  // ---- 7. inside the approver's delegated limit: must succeed ----------
  await dismissTop(page);
  await page.waitForTimeout(600);
  await applyPercent(APPROVED);
  await page.waitForTimeout(3000);
  const REASON = `Core acceptance ${BIZ_DATE}: goodwill on a delayed order`;
  await approve(MANAGER, pw(MANAGER), REASON);
  await page.waitForTimeout(1500);
  const afterApproved = orderRow(orderId);
  await shot(page, '08-approved');
  check(`7.1 ${APPROVED}% applied once a manager inside their own 20% signed for it`,
    Math.abs(afterApproved.disc_amount - pctOf(APPROVED)) < 0.01,
    `discountAmount ₹${afterApproved.disc_amount} (expected ₹${pctOf(APPROVED)})`);
  check('7.2 the approver is recorded on the order',
    afterApproved.approved_by === byEmail[MANAGER].id,
    `discountApprovedById = ${afterApproved.approved_by}`);
  check('7.3 the reason the operator typed is kept with it',
    afterApproved.reason === REASON, afterApproved.reason || '(none)');
  check('7.4 tax was recomputed on the discounted base',
    afterApproved.total > 0
      && Math.abs(afterApproved.total - (afterApproved.subtotal - afterApproved.disc_amount + afterApproved.tax)) < 0.02,
    `₹${afterApproved.subtotal} − ₹${afterApproved.disc_amount} + ₹${afterApproved.tax} = ₹${afterApproved.total}`);

  // ---- 8. refresh and retry must not compound --------------------------
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.goto(`${BASE}/sell?order=${orderId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const afterReload = orderRow(orderId);
  check('8.1 a reload did not change the discount',
    Math.abs(afterReload.disc_amount - pctOf(APPROVED)) < 0.01,
    `discountAmount ₹${afterReload.disc_amount}`);

  // Re-send the SAME figure. The discount modal opens pre-filled with the
  // current value, so pressing "Apply discount" twice is an ordinary thing
  // for a cashier to do. It moves no money, so it needs no second signature —
  // and it must not quietly restate the order as unapproved, which is the
  // defect the `unchanged && !signer` guard in orders.js exists to stop.
  await applyPercent(APPROVED);
  await page.waitForTimeout(3000);
  const retryUp = await overlays(page);
  const afterRetry = orderRow(orderId);
  await shot(page, '09-after-retry');
  check('8.2 re-sending the same discount is not a second discount',
    Math.abs(afterRetry.disc_amount - pctOf(APPROVED)) < 0.01,
    `discountAmount ₹${afterRetry.disc_amount}, not ₹${pctOf(APPROVED * 2)} — set, not added`);
  check('8.3 it moved no money, so it did not ask for another signature',
    !retryUp.some((o) => /manager needs to approve/i.test(o.title)),
    retryUp.map((o) => o.title).join(' / ') || 'no overlay up');
  check('8.4 and it did NOT erase the approval already on the row',
    afterRetry.approved_by === byEmail[MANAGER].id && afterRetry.reason === REASON,
    `discountApprovedById still ${afterRetry.approved_by}`);

  // Raising it, though, is a new exposure — so the earlier approval must not
  // act as a standing permission. This is the "no manager mode" claim, tested
  // rather than asserted.
  const RAISED = 18;
  await applyPercent(RAISED);
  await page.waitForTimeout(3000);
  const raiseUp = await overlays(page);
  const afterRaiseAttempt = orderRow(orderId);
  await shot(page, '10-raise-reprompts');
  check('8.5 raising an already-approved discount prompts again — approval is per-request',
    raiseUp.some((o) => /manager needs to approve/i.test(o.title))
      && Math.abs(afterRaiseAttempt.disc_amount - pctOf(APPROVED)) < 0.01,
    `still ₹${afterRaiseAttempt.disc_amount} until signed for`);
  await approve(MANAGER, pw(MANAGER), `${REASON} (raised to ${RAISED}%)`);
  await page.waitForTimeout(1500);
  const afterRaise = orderRow(orderId);
  await shot(page, '11-raised');
  check('8.6 the raise replaced the discount, it did not stack on it',
    Math.abs(afterRaise.disc_amount - pctOf(RAISED)) < 0.01,
    `discountAmount ₹${afterRaise.disc_amount} = ${RAISED}% of ₹${GROSS}, `
    + `not ₹${pctOf(APPROVED + RAISED)}`);
  check('8.7 still one order, still no payment or refund on it',
    afterRaise.payments === 0 && afterRaise.refunds === 0 && afterRaise.status === 'OPEN',
    `status ${afterRaise.status}, ${afterRaise.payments} payments, ${afterRaise.refunds} refunds`);

  // =====================================================================
  // C. the audit trail
  // =====================================================================
  const trail = auditFor(orderId);
  log('', '');
  log('audit trail', `${trail.length} rows on this order`);
  for (const a of trail) log(`  ${a.at}  ${a.action}`, `${a.actor_role}`);

  const set = trail.filter((a) => a.action === 'ORDER_DISCOUNT_SET');
  const approvedSet = set.find((a) => a.m.approvedBy);
  const refusals = trail.filter((a) => a.action === 'ORDER_DISCOUNT_DENIED'
    || a.action === 'ORDER_DISCOUNT_APPROVAL_FAILED');
  check('9.1 the requester and their role are on the record',
    set.length > 0 && set.every((a) => a.actor_id === byEmail[CASHIER].id && a.actor_role === 'CASHIER'),
    `${set.length} ORDER_DISCOUNT_SET rows, all actorRole=CASHIER`);
  check('9.2 the ceiling in force at the time is on the record',
    set.every((a) => a.m.actorLimit?.maxPctMilli === CASHIER_PCT * 1000),
    `actorLimit.maxPctMilli = ${set[0]?.m.actorLimit?.maxPctMilli} on all ${set.length} rows`);
  // The exposure is recorded as a shape, not a single number: the gross it was
  // measured against, the cash given away, and the share of the bill that is.
  // All three have to be on both sides or "before/after" is not reconstructable.
  const exposureOk = (e) => e && Number.isInteger(e.grossPaise)
    && Number.isInteger(e.combinedDiscountPaise) && Number.isInteger(e.combinedPctMilli);
  const exposure = (e) => `₹${(e.combinedDiscountPaise / 100).toFixed(2)}/${e.combinedPctMilli / 1000}%`;
  check('9.3 the before and after exposure are both on the record',
    set.length > 0 && set.every((a) => exposureOk(a.m.before) && exposureOk(a.m.after)),
    set.map((a) => `${exposure(a.m.before)}→${exposure(a.m.after)}`).join(', '));
  check('9.4 the approver identity is on the approved row',
    approvedSet?.m.approvedBy?.email === MANAGER,
    `approvedBy = ${approvedSet?.m.approvedBy?.email} (${approvedSet?.m.approvedBy?.role})`);
  check('9.5 self-approval is recorded as a fact, and here it is false',
    approvedSet?.m.approvedBy?.selfApproved === false,
    'approvedBy.selfApproved = false — the cashier asked, the manager signed');
  check('9.6 the approval reason is on the record',
    typeof approvedSet?.m.approvalReason === 'string'
      && approvedSet.m.approvalReason.includes('goodwill on a delayed order'),
    approvedSet?.m.approvalReason || '(none)');
  check('9.7 the branch is on the record',
    trail.every((a) => a.m.branchId === till.id),
    `branchId ${till.id} on all ${trail.length} rows`);
  check('9.8 both refusal kinds were recorded',
    refusals.some((a) => a.m.refusal === 'BAD_PASSWORD')
      && refusals.some((a) => a.m.breach?.kind === 'APPROVER_OVER_LIMIT'
        || a.m.refusal === 'APPROVER_OVER_LIMIT'),
    refusals.map((a) => a.m.refusal || a.m.breach?.kind || a.action).join(', '));
  check('9.9 an unapproved set records no approver rather than omitting the field',
    set.filter((a) => !a.m.approvedBy).every((a) => a.m.approvedBy === null
      && a.m.approvalReason === null),
    `${set.filter((a) => !a.m.approvedBy).length} unapproved sets, all explicitly null`);

  // ---- 10. redaction ---------------------------------------------------
  // The password is compared inside this process. It is never passed to psql,
  // grep or any other argv, where it would be readable in the process table.
  const secret = pw(MANAGER);
  const allMeta = q(`select a.meta::text as meta from "PosAuditLog" a
    where a.at >= timestamp '${START_ISO}'`).map((r) => r.meta).join('\n');
  const orderJson = JSON.stringify(orderRow(orderId));
  const backendLog = execFileSync('docker',
    ['logs', '--since', `${START_ISO}Z`, 'pos-prod-backend-1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

  check('10.1 the approver password is nowhere in the audit rows',
    !allMeta.includes(secret), `${allMeta.length} bytes of meta searched`);
  check('10.2 the approver password is nowhere on the order row',
    !orderJson.includes(secret), 'order row searched');
  check('10.3 the approver password is nowhere in the backend log',
    !backendLog.includes(secret), `${backendLog.length} bytes of log searched`);
  check('10.4 the wrong password was not logged either',
    !allMeta.includes(WRONG_PASSWORD) && !backendLog.includes(WRONG_PASSWORD),
    'a rejected credential is still a credential');
  check('10.5 no "password" key survived into any audit row',
    !/"password"\s*:/.test(allMeta), 'no password field in meta');
  // A negative control: if the search itself were broken, this would also
  // pass, and 10.1-10.4 would be worthless.
  check('10.6 negative control — the search can find a string that IS there',
    allMeta.includes(byEmail[MANAGER].email),
    `found ${MANAGER} in the audit meta, so the searches above are real`);

  // =====================================================================
  // D. cleanup, through the app
  // =====================================================================
  const mgr = await newPage('manager');
  await signIn(mgr, MANAGER);
  await mgr.goto(`${BASE}/sell?order=${orderId}`, { waitUntil: 'networkidle' });
  await mgr.waitForTimeout(2000);
  await shot(mgr, '12-manager-resumed');
  await mgr.getByRole('button', { name: 'Void order' }).first().click();
  await mgr.waitForTimeout(800);
  await mgr.fill('#reason-field', `Core acceptance ${BIZ_DATE}: discount approval test order`);
  await mgr.getByRole('button', { name: 'Void order' }).last().click();
  await mgr.waitForTimeout(2500);
  const voided = orderRow(orderId);
  await shot(mgr, '13-voided');
  check('11.1 the test order was voided through the application',
    voided.status === 'VOID', `status ${voided.status}`);
  check('11.2 the void kept the financial history rather than deleting it',
    voided.disc_amount > 0 && voided.approved_by === byEmail[MANAGER].id,
    `discount ₹${voided.disc_amount} and its approver are still on the row`);

  // This run's whole subject is the refusal path, so a browser console full of
  // 403s is the feature working, not a fault — axios logs every rejected XHR.
  // Forgiving them wholesale would blind the check, so count them instead: one
  // 403 per refusal the server recorded, and nothing else of any kind.
  const allErrors = [...cashierPage.__errors, ...owner.__errors, ...mgr.__errors]
    .filter((e) => !e.benign);
  const refused403 = allErrors.filter((e) => /Failed to load resource/.test(e.text)
    && /\b403\b/.test(e.text));
  const unexplained = allErrors.filter((e) => !refused403.includes(e));
  check('12.1 every page error is one of this run\'s deliberate refusals',
    unexplained.length === 0,
    unexplained.map((e) => e.text).join(' | ') || `${refused403.length} × 403, nothing else`);
  check('12.2 the browser saw exactly as many refusals as the server recorded',
    refused403.length === refusals.length,
    `${refused403.length} console 403s vs ${refusals.length} refusal audit rows`);

  log('', '');
  const pass = results.filter((r) => r.ok).length;
  log('RESULT', `${pass}/${results.length} checks passed`);
  log('order', `${orderId} — ${voided.status}`);
  log('screenshots', OUT);
  if (pass !== results.length) process.exitCode = 1;
} finally {
  await browser.close();
}
