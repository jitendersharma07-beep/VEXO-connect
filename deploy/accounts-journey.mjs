#!/usr/bin/env node
// LANE accounts — the acceptance run for the whole account lifecycle, end to
// end, in a real browser.
//
// WHY THIS EXISTS AND WHAT IT ADDS TO THE UNIT SUITE
//
// backend/tests covers each endpoint, and covers them well — but every one of
// those tests calls the API directly. None of them proves that the screens a
// person actually touches are wired to those endpoints, that the emailed link
// resolves to a route the SPA serves, or that the token survives the trip
// through a MIME body and a browser address bar. Those are exactly the joins
// that break silently: the API stays green while the button does nothing.
//
// So this drives the REAL built bundle in headless Chromium against a REAL
// backend over HTTP, and reads the mail out of a REAL SMTP conversation.
//
// WHAT IT PROVES
//
//   1. The platform administrator exists because the bootstrap script made it,
//      by invitation, and can sign in.
//   2. The last active administrator cannot be disabled — in the UI, and by
//      the server when the UI is bypassed.
//   3. Creating a customer company, licensing it, and inviting its owner sends
//      a message that reaches a mailbox, and that message carries no password.
//   4. The invited owner opens the link, sees who invited them and to what,
//      chooses their own password, and lands on a sign-in page — NOT a session.
//   5. That owner signs in with the password they chose, with no forced change.
//   6. The same owner can lose it and recover by 8-digit email code, after
//      which the old password is dead and the new one works.
//   7. That owner hires a colleague and is shown no credential for them: the
//      colleague gets an emailed code, the link opens the code box directly,
//      and they choose their own password and sign in with it.
//   8. Recovery answers an unregistered address exactly as a registered one.
//
// ISOLATION
//
// Everything runs in this one process: the SMTP sink, the backend, the static
// server and the browser. The only external dependency is the database named
// by DATABASE_URL, which the caller creates and migrates — this script neither
// creates nor drops one, so it cannot be pointed at production by accident and
// cannot destroy what it was pointed at. The sink relays nothing, so nothing
// here can reach a real mailbox.
//
// NOT PRODUCTION, AND IT CANNOT PRETEND TO BE
//
// config/env.js refuses SMTP_SECURITY=none outside development/test and
// refuses a non-https APP_URL in production, so a loopback rehearsal that
// claimed to be production would not boot. This run sets NODE_ENV=development
// and is therefore evidence about the code, not about a production mail path.
// It is deliberately not `test` either: that would disable the rate limiters,
// and a run with them off cannot tell a working 429 from a missing one.
//
// OUTPUT DISCIPLINE
//
// PASS/FAIL lines and observed facts, never a secret. The invitation token,
// the 8-digit recovery code and every password are held in variables and typed
// into the page; none is printed, and the recovery screenshot is taken BEFORE
// the code is entered so the image cannot carry it either. This output gets
// pasted into chat.
//
// USAGE — the database must be FRESH, and the script refuses if it is not.
// Re-running against a previous run's database leaves a second administrator
// behind, which turns the last-administrator checks into no-ops that still
// report PASS. See the precondition below.
//
//   1. create and migrate an EMPTY database
//   2. build the bundle:  VITE_BASE_PATH=/pos/ npm --prefix frontend run build
//   3. DATABASE_URL=... node deploy/accounts-journey.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from '/home/atc-noc/mg-bulk-probe/node_modules/playwright-core/index.mjs';
import { startSmtpSink } from '../backend/scripts/lib/smtpSink.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DIST = path.join(ROOT, 'frontend/dist');
const CHROME = '/home/atc-noc/.cache/ms-playwright/chromium-1117/chrome-linux/chrome';
const BASEPATH = '/pos';
const API_PORT = Number(process.env.JOURNEY_API_PORT || 5021);
const WEB_PORT = Number(process.env.JOURNEY_WEB_PORT || 5022);
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const SHOTS = `/tmp/vcx-journey-${RUN}`;

if (!process.env.DATABASE_URL) {
  console.log('FAIL: set DATABASE_URL to an isolated, already-migrated database');
  process.exit(2);
}
if (!existsSync(path.join(DIST, 'index.html'))) {
  console.log(`FAIL: no bundle at ${DIST} — run: VITE_BASE_PATH=/pos/ npm --prefix frontend run build`);
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const pass = (what, detail) => console.log(`PASS  ${what}${detail ? `\n      ${detail}` : ''}`);
const fail = (what, detail) => {
  failures += 1;
  console.log(`FAIL  ${what}${detail ? `\n      ${detail}` : ''}`);
};
const check = (cond, what, detail) => (cond ? pass(what, detail) : fail(what, detail));

// --- the mailbox ------------------------------------------------------------

const messages = [];
const sink = startSmtpSink({ port: 0, onMessage: (m) => messages.push(m) });
await sink.started;

// Bodies arrive base64-encoded per MIME part. Decode every part and join: the
// harness does not care which alternative it reads, only what the recipient
// could see.
const textOf = (msg) =>
  msg.raw
    .split(/--=_vexo_[0-9a-f]+/)
    .map((part) => {
      if (!/content-transfer-encoding:\s*base64/i.test(part)) return '';
      const body = part.split(/\r?\n\r?\n/).slice(1).join('\n');
      try {
        return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n') || msg.raw;

const waitForMail = async (to, matcher, label) => {
  for (let i = 0; i < 60; i += 1) {
    const hit = messages.find((m) => m.envelope.to.join(',').includes(to) && matcher(m));
    if (hit) return { ...hit, text: textOf(hit) };
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`no ${label} arrived for ${to}`);
  return null;
};

// --- the backend, in this process -------------------------------------------

// Set BEFORE app.js is imported: config/env.js reads the environment once at
// load and decides there whether mail is configured at all.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.POS_JWT_SECRET = randomBytes(32).toString('hex');
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURITY = 'none';
process.env.MAIL_FROM = 'VEXO Connect <no-reply@vexoconnect.test>';
// The allow-list is what stops a mis-set config mailing a real customer during
// a rehearsal. Every address below is inside it, so the run demonstrates that
// approved recipients get through rather than only that others are blocked.
process.env.MAIL_ALLOWED_RECIPIENTS = '*@journey.test';
// Read from configuration, never from a request Host header. The links in the
// captured mail are checked against this exact value.
process.env.APP_URL = `http://127.0.0.1:${WEB_PORT}${BASEPATH}`;
// The browser sends Origin on same-origin POSTs, and the proxy below rewrites
// Host but deliberately does NOT rewrite Origin — forging it would hide a real
// misconfiguration. So the API's allow-list has to name the address the bundle
// is actually served from, exactly as a deployment must.
process.env.CORS_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

const { createApp } = await import('../backend/src/app.js');
const api = http.createServer(await createApp());
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

// A FRESH database, asserted rather than assumed.
//
// Found by negative control: re-running against the database from a previous
// run left a second active administrator behind, and three checks went quietly
// from proving something to proving nothing. The single-administrator warning
// stopped rendering, the Disable button stopped being greyed, and the server
// answered with the self-disable refusal (400) instead of the last-admin one
// (409) — every one of them a PASS you could not get if you looked, and a
// silent FAIL if you did not.
//
// The last-admin rule is only testable when this run's administrator really is
// the last one, so that precondition is checked here instead of hoped for.
const { prisma } = await import('../backend/src/lib/prisma.js');
const existingAdmins = await prisma.posUser.count({ where: { role: 'POS_SUPER_ADMIN', companyId: null } });
if (existingAdmins > 0) {
  console.log(
    `FAIL: this database already holds ${existingAdmins} platform administrator account(s).\n` +
      '      The last-administrator checks below would pass without testing anything.\n' +
      '      Create and migrate a fresh database and point DATABASE_URL at that.',
  );
  process.exit(2);
}

// --- the bundle, on the same origin as the API ------------------------------
//
// Same origin is not a convenience. The session cookie is SameSite and api.js
// sends `withCredentials: true`; two ports would make the browser drop it and
// the run would fail for a reason unrelated to the code under test.
//
// The SPA fallback is what makes /pos/invite#<token> resolve to the app rather
// than a 404 — the thing an emailed link depends on and that no unit test sees.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
const web = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${WEB_PORT}`);
  // api.js builds every URL as `${BASE_URL}api`, so the browser asks for
  // /pos/api/…; the backend mounts at /api. Strip the prefix in transit.
  if (url.pathname.startsWith(`${BASEPATH}/api/`)) {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        method: req.method,
        path: url.pathname.slice(BASEPATH.length) + url.search,
        headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"JOURNEY_PROXY","message":"backend unreachable"}}');
    });
    req.pipe(up);
    return;
  }
  const rel = url.pathname.startsWith(BASEPATH) ? url.pathname.slice(BASEPATH.length) : url.pathname;
  const file = path.join(DIST, rel.replace(/^\/+/, ''));
  const serve = (f) => {
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    createReadStream(f).pipe(res);
  };
  // Refuse anything that escaped the dist folder before touching the disk.
  if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) serve(file);
  else serve(path.join(DIST, 'index.html'));
});
await new Promise((r) => web.listen(WEB_PORT, '127.0.0.1', r));

const BASE = `http://127.0.0.1:${WEB_PORT}${BASEPATH}`;
const API = `http://127.0.0.1:${API_PORT}/api`;
console.log(`api 127.0.0.1:${API_PORT} · web ${BASE} · sink 127.0.0.1:${sink.port}\n`);

// Addresses and passwords are generated per run, held only here, never printed.
const stamp = randomBytes(3).toString('hex');
const ADMIN = `root.${stamp}@journey.test`;
const OWNER = `owner.${stamp}@journey.test`;
const pw = () => `${randomBytes(12).toString('base64url')}Aa1`;
const STAFF = `finance.${stamp}@journey.test`;
const ADMIN_PW = pw();
const OWNER_PW = pw();
const OWNER_PW2 = pw();
const STAFF_PW = pw();

const finish = async (code) => {
  await new Promise((r) => api.close(r));
  await new Promise((r) => web.close(r));
  await sink.close();
  process.exit(code);
};

// --- 1. the administrator exists because the script made it -----------------

// ASYNC, not execFileSync. The SMTP sink lives in this process, so a
// synchronous child blocks the very event loop that has to answer the child's
// SMTP connection — the mail times out and the script correctly reports a
// delivery failure that is entirely the harness's fault.
const { stdout: bootstrap } = await promisify(execFile)(
  'node',
  ['scripts/bootstrap-platform-admin.mjs', '--email', ADMIN, '--confirm'],
  { cwd: path.join(ROOT, 'backend'), encoding: 'utf8', env: process.env },
);
check(/invitation/i.test(bootstrap), 'the bootstrap script issues an invitation, not a password');
check(
  !/\bpassword is\b|\btemporary password\b/i.test(bootstrap),
  'the bootstrap script prints no credential',
);

const adminMail = await waitForMail(ADMIN, (m) => /invit/i.test(m.subject), 'platform-admin invitation');
if (!adminMail) await finish(1);

const tokenFrom = (mail) => /https?:\/\/\S*?\/invite#([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] || '';
const adminToken = tokenFrom(adminMail);
check(Boolean(adminToken), 'the invitation mail carries an accept link with a fragment token');
check(
  adminMail.text.includes(`${BASE}/invite#`),
  'the link is built from APP_URL, including its base path',
  `observed base: ${BASE}/invite#…`,
);
check(!/temporary password|your password is/i.test(adminMail.text), 'no password appears in the invitation mail');

// --- the browser ------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

const acceptInvitation = async (token, password, who, label) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  await page.goto(`${BASE}/invite#${token}`, { waitUntil: 'networkidle' });
  const heading = (await page.locator('h2').first().textContent()) || '';
  check(/set your password/i.test(heading), `${label}: the emailed link opens the accept page`, `heading: ${heading}`);

  // The offer is shown before anything is typed — the whole reason a person
  // can tell a genuine invitation from a lure.
  const body = await page.locator('body').innerText();
  check(body.includes(who), `${label}: the page names the address the invitation was issued to`);

  // The fragment must already be gone: read once, and history keeps no copy.
  check(!page.url().includes('#'), `${label}: the token is cleared from the address bar after it is read`);

  await shot(page, `${label}-01-accept`);
  await page.fill('#password', password);
  await page.fill('#confirmPassword', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=Your account is ready', { timeout: 20000 });

  // Accepting must NOT sign anyone in. If it did, an emailed link would open a
  // till.
  const cookies = await page.context().cookies();
  check(!cookies.some((c) => /pos|session|token/i.test(c.name)), `${label}: accepting issues no session`);
  await shot(page, `${label}-02-ready`);
  await page.close();
};

await acceptInvitation(adminToken, ADMIN_PW, ADMIN, 'admin');

// --- 2. the administrator signs in and the last-admin rule holds ------------

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', ADMIN);
await page.fill('#password', ADMIN_PW);
await page.click('button[type=submit]');
await page.waitForURL(/atc\/companies/, { timeout: 20000 });
pass('the bootstrapped administrator signs in with the password they chose');
check(
  !/change your password/i.test(await page.locator('body').innerText()),
  'no forced password change is demanded — there was never a temporary one',
);
await shot(page, 'admin-03-console');

await page.goto(`${BASE}/atc/platform-admins`, { waitUntil: 'networkidle' });
const adminsText = await page.locator('body').innerText();
check(/Platform administrators/i.test(adminsText), 'the platform-administrator console renders');
check(
  /one active administrator/i.test(adminsText),
  'it warns that a single-administrator platform cannot be recovered from a screen',
);
check(
  await page.locator('button:has-text("Disable")').first().isDisabled(),
  'the last administrator\'s Disable button is refused in the UI',
);
await shot(page, 'admin-04-platform-admins');

// A greyed button is a courtesy, not a control. The server must refuse it too.
const cookieHeader = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
const me = await (await fetch(`${API}/auth/me`, { headers: { cookie: cookieHeader } })).json();
const selfDisable = await fetch(`${API}/atc/platform-admins/${me.user.id}/status`, {
  method: 'PATCH',
  headers: { cookie: cookieHeader, 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'DISABLED' }),
});
const selfBody = await selfDisable.json();
check(
  selfDisable.status === 409 && /only active platform administrator/i.test(selfBody?.error?.message || ''),
  'the server refuses to disable the last active platform administrator',
  `${selfDisable.status} · ${selfBody?.error?.message || ''}`,
);

// --- 3. onboard a real customer, by invitation ------------------------------

const slug = `journey-${stamp}`;
await page.goto(`${BASE}/atc/companies`, { waitUntil: 'networkidle' });
await page.click('button:has-text("New company")');
await page.fill('#c-name', `Journey Foods ${stamp}`);
await page.fill('#c-slug', slug);
await page.click('form button[type=submit]');
await page.waitForSelector(`text=${slug}`, { timeout: 20000 });
pass('a customer company is created from the console');

await page.click(`tr:has-text("${slug}") a:has-text("Manage")`);
await page.waitForSelector('button:has-text("Invite owner")', { timeout: 20000 });
await shot(page, 'admin-05-company');

// The licence, BEFORE the owner is invited — the order the onboarding sequence
// specifies, and not a formality. A company with no licence is readable but
// not writable: its owner signs in, sees the whole console, and is refused
// with POS_LICENSE_MISSING the moment they try to do anything, including hire
// their first colleague. Leaving this step out of the rehearsal is how a
// customer's first working day becomes a support call.
await page.click('button:has-text("Issue licence")');
await page.selectOption('#l-plan', 'MULTI_STORE');
const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
await page.fill('#l-expiry', expiry);
await page.fill('#l-limit', '5');
await page.click('form button[type=submit]');
await page.waitForSelector('text=/ACTIVE|Active/', { timeout: 20000 });
pass('a licence is issued before the owner is invited', `MULTI_STORE to ${expiry}`);
await shot(page, 'admin-05b-licensed');

await page.click('button:has-text("Invite owner")');
await page.fill('#o-name', 'Journey Owner');
await page.fill('#o-email', OWNER);
await page.click('form button[type=submit]');
await page.waitForSelector('text=A sign-up link is on its way', { timeout: 20000 });
const afterInvite = await page.locator('body').innerText();
check(!/temporary password|password is/i.test(afterInvite), 'the screen reveals no password after inviting');
await shot(page, 'admin-06-invited');

const ownerMail = await waitForMail(OWNER, (m) => /invit/i.test(m.subject), 'owner invitation');
if (!ownerMail) await finish(1);
check(!/temporary password|your password is/i.test(ownerMail.text), 'no password appears in the owner invitation mail');
const ownerToken = tokenFrom(ownerMail);
check(Boolean(ownerToken), 'the owner invitation carries a fragment token');

await acceptInvitation(ownerToken, OWNER_PW, OWNER, 'owner');

// --- 4. the owner signs in with the password they chose ---------------------

const ownerPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const ownerSignIn = async (password) => {
  await ownerPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await ownerPage.fill('#email', OWNER);
  await ownerPage.fill('#password', password);
  await ownerPage.click('button[type=submit]');
};
await ownerSignIn(OWNER_PW);
await ownerPage.waitForURL(/dashboard|licence|branches|sell/, { timeout: 20000 });
pass('the invited owner signs in with the password they chose, first try');
await shot(ownerPage, 'owner-07-dashboard');

// --- 5. recovery by email code ----------------------------------------------

const before = messages.length;
await ownerPage.goto(`${BASE}/forgot-password`, { waitUntil: 'networkidle' });
await ownerPage.fill('#email', OWNER);
await ownerPage.click('button[type=submit]');
await ownerPage.waitForSelector('#code', { timeout: 20000 });
const codeScreen = await ownerPage.locator('body').innerText();
check(/8-digit code/.test(codeScreen), 'the recovery screen states the code length the server issues');
check(/10 minutes/.test(codeScreen), 'and the expiry the server enforces');
// Taken BEFORE the code is typed. After it, the field holds the OTP and the
// image would be a credential.
await shot(ownerPage, 'owner-08-code-requested');

const codeMail = await waitForMail(OWNER, (m) => /code|reset|password/i.test(m.subject), 'recovery code');
if (!codeMail) await finish(1);
check(messages.length > before, 'a recovery message was actually delivered', `${messages.length - before} new`);
const code = /\b(\d{8})\b/.exec(codeMail.text)?.[1] || '';
check(code.length === 8, 'the emailed code is 8 digits');

await ownerPage.fill('#code', code);
await ownerPage.click('button[type=submit]');
await ownerPage.waitForSelector('#confirmPassword', { timeout: 20000 });
pass('the code from the mailbox is accepted');
await ownerPage.fill('#password', OWNER_PW2);
await ownerPage.fill('#confirmPassword', OWNER_PW2);
await ownerPage.click('button[type=submit]');
await ownerPage.waitForSelector('text=Password updated', { timeout: 20000 });
pass('the owner sets a new password through the browser');
await shot(ownerPage, 'owner-09-recovered');

// --- 6. the old password is dead, the new one works -------------------------

const oldTry = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: OWNER, password: OWNER_PW }),
});
check(oldTry.status === 401, 'the password that was replaced no longer signs in', `status ${oldTry.status}`);

await ownerSignIn(OWNER_PW2);
await ownerPage.waitForURL(/dashboard|licence|branches|sell/, { timeout: 20000 });
pass('the recovered password signs in');

// --- 7. the owner hires staff, and never holds their credential -------------
//
// The OTHER way an account comes into being. Section 3 covered invitations,
// where no user row exists until the link is accepted. This is the direct
// create a manager uses for somebody standing in front of them: the row is in
// place immediately, but with a password hash no string satisfies, and the
// person is mailed a code.
//
// Worth driving in a browser rather than trusting the unit suite, because the
// join under test spans both halves of the product and neither half can see
// the other break. The backend composes /forgot-password?step=code&email=…;
// the frontend reads those two parameters to open ALREADY on the code step. If
// either side drifts, every unit test still passes and the person who clicks
// the link lands on step one — where asking for a code mints a second one that
// supersedes the one in their hand, or trips the 60-second cooldown and
// refuses. The screen would never explain why the code stopped working.
const staffBefore = messages.length;
await ownerPage.goto(`${BASE}/team`, { waitUntil: 'networkidle' });
await ownerPage.click('button:has-text("Add team member")');
await ownerPage.fill('#u-name', 'Journey Finance');
await ownerPage.fill('#u-email', STAFF);
// A company-level role on purpose. This tenant has no store yet — a freshly
// onboarded customer does not — and the store-pinned roles require one, so
// CASHIER here would fail on a missing branch and prove nothing about codes.
await ownerPage.selectOption('#u-role', 'FINANCE');
await ownerPage.click('form button[type=submit]');
// A screen that refuses tells you WHY, in the box it puts the message in. A
// bare selector timeout throws that away and reports only that something did
// not appear, which is the least useful half of what the page is saying.
try {
  await ownerPage.waitForSelector('text=Code sent', { timeout: 20000 });
} catch {
  const visible = (await ownerPage.locator('body').innerText()).replace(/\n{2,}/g, '\n').trim();
  fail('hiring a colleague mails them a setup code', `the screen said instead:\n      ${visible.slice(0, 600).replace(/\n/g, '\n      ')}`);
  await shot(ownerPage, 'owner-10-hire-failed');
  await browser.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  await finish(1);
}
const hireScreen = await ownerPage.locator('body').innerText();
check(
  !/temporary password|password is|[A-Za-z0-9_-]{16,}Aa1/.test(hireScreen),
  'hiring reveals no credential to the manager who did the hiring',
);
check(hireScreen.includes(STAFF), 'it names the address the code went to, so a typo is visible now');
await shot(ownerPage, 'owner-10-hired');

// The badge lives in the table, which reloads when the dialog closes — read it
// there rather than through the open dialog, where the row is not yet present.
await ownerPage.click('button:has-text("Done")');
await ownerPage.waitForSelector(`tr:has-text("${STAFF}")`, { timeout: 20000 });
const rosterRow = await ownerPage.locator(`tr:has-text("${STAFF}")`).innerText();
check(/Awaiting password/.test(rosterRow), 'the roster shows the new account awaiting its own password');

const staffMail = await waitForMail(STAFF, (m) => /password|account/i.test(m.subject), 'staff setup code');
if (!staffMail) await finish(1);
check(messages.length > staffBefore, 'a setup message reaches the new colleague', `${messages.length - staffBefore} new`);
const staffCode = /\b(\d{8})\b/.exec(staffMail.text)?.[1] || '';
check(staffCode.length === 8, 'the staff setup code is 8 digits, like every other code');

// The link as the recipient would click it: taken out of the MIME body, not
// reconstructed here — reconstructing it would test this script, not the mail.
const staffLink = /https?:\/\/\S*forgot-password\S*/.exec(staffMail.text)?.[0]?.replace(/[)>.,]+$/, '') || '';
check(
  staffLink.startsWith(`${BASE}/forgot-password?step=code`),
  'the mail links straight to the code box, beneath APP_URL',
  staffLink ? `observed: ${staffLink.split('?')[0]}?${staffLink.split('?')[1]?.split('&')[0]}…` : 'no link found',
);
check(!staffLink.includes(staffCode), 'the code itself is not in the link — it is typed, never carried in a URL');

const staffPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await staffPage.goto(staffLink, { waitUntil: 'networkidle' });
await staffPage.waitForSelector('#code', { timeout: 20000 });
pass('the link opens the recovery page already on the code step');
check(
  (await staffPage.locator('#email').count()) === 0,
  'and does not ask again for the address the code was sent to',
);
await shot(staffPage, 'staff-11-code-step');

await staffPage.fill('#code', staffCode);
await staffPage.click('button[type=submit]');
await staffPage.waitForSelector('#confirmPassword', { timeout: 20000 });
pass('the emailed staff code is accepted');
await staffPage.fill('#password', STAFF_PW);
await staffPage.fill('#confirmPassword', STAFF_PW);
await staffPage.click('button[type=submit]');
await staffPage.waitForSelector('text=Password updated', { timeout: 20000 });
pass('the new colleague chooses their own password');

await staffPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await staffPage.fill('#email', STAFF);
await staffPage.fill('#password', STAFF_PW);
await staffPage.click('button[type=submit]');
await staffPage.waitForURL(/dashboard|licence|branches|sell|team/, { timeout: 20000 });
pass('and signs in with it, with no forced change — it was never temporary');
await shot(staffPage, 'staff-12-signed-in');
await staffPage.close();

// --- 8. recovery is not an account oracle -----------------------------------
//
// Compared against ADMIN rather than OWNER on purpose. OWNER has just been
// through a recovery, so a second request would hit the per-account cooldown
// and answer 429 — a difference that says "asked about recently", not "exists".
// A registered address with no live challenge is what actually tests the claim.
const ask = (email) =>
  fetch(`${API}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
const unknown = await ask(`nobody.${stamp}@journey.test`);
const known = await ask(ADMIN);
const [u, k] = [await unknown.json(), await known.json()];
check(
  unknown.status === known.status && JSON.stringify(u) === JSON.stringify(k),
  'an unregistered address is answered identically to a registered one',
  `both ${unknown.status}: ${u.message}`,
);

await browser.close();
console.log(`\nscreenshots: ${SHOTS}`);
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
await finish(failures === 0 ? 0 : 1);
