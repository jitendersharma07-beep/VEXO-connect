// Set the password on the dev sandbox POS accounts to something YOU chose.
//
// The sandbox accounts were seeded with random passwords, which is correct for
// a script that logs in on your behalf and wrong for a human who has to open
// the POS in a browser and actually type one. The alternatives are worse: the
// stored password could be printed, but scrollback from this box gets pasted
// into chats, so anything printed here should be assumed public afterwards.
//
// So the password travels the other way. You type it, hidden, twice. It is
// hashed here, written to the database and to the 0600 sandbox file so the
// existing driver scripts keep working, and never printed by anything.
//
// HARD SCOPE — it refuses outside all of these:
//   * the dev Postgres container only (atc-pos-dev-db), never a remote DSN
//   * the "Razorpay Sandbox (Dev)" company only
//   * @atcpos.dev accounts only
// It cannot reach production: prod Postgres publishes no host port and this
// talks to the dev container by name.
//
//   node backend/scripts/dev-sandbox-password.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hash as argon2Hash } from '/home/atc-noc/atc-pos/backend/node_modules/@node-rs/argon2/index.js';

const REPO = '/home/atc-noc/atc-pos';
const ACCOUNT_FILE = `${REPO}/backend/.secrets/dev-sandbox-account.env`;
const CONTAINER = 'atc-pos-dev-db';
const COMPANY_NAME = 'Razorpay Sandbox (Dev)';

const die = (m) => { console.error(`FAIL: ${m}`); process.exit(2); };

const psql = (sql) => new Promise((resolve, reject) => {
  // SQL on stdin, never in argv: the hash would otherwise be visible in ps to
  // anyone else on the box.
  const p = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'atc_pos', '-d', 'atc_pos', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', '-']);
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `psql exit ${code}`))));
  p.stdin.end(sql);
});

const readHidden = (prompt) => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY) return reject(new Error('run this in a terminal — it reads hidden input'));
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let buf = '';
  const onData = (chunk) => {
    for (const ch of chunk.toString('utf8')) {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        return resolve(buf);
      }
      if (ch === '') { // Ctrl-C: leave the terminal usable
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); continue; }
      buf += ch;
    }
  };
  process.stdin.on('data', onData);
});

// --- scope checks, before anything is typed -----------------------------

const company = await psql(`select id from "Company" where name = '${COMPANY_NAME}';`).catch((e) => die(e.message));
if (!company) die(`no company named "${COMPANY_NAME}" in the dev database — wrong database, or the sandbox was never seeded`);
if (company.includes('\n')) die('more than one sandbox company; refusing to guess');

const emails = (await psql(
  `select email from "PosUser" where "companyId" = '${company}' and email like '%@atcpos.dev' order by email;`,
).catch((e) => die(e.message))).split('\n').filter(Boolean);

if (emails.length === 0) die('no @atcpos.dev accounts in the sandbox company');

console.log(`sandbox company: ${COMPANY_NAME}`);
console.log('accounts that will get the new password:');
emails.forEach((e) => console.log(`  ${e}`));
console.log('');

// --check stops here, before anything is typed or written. It exists so the
// scope above can be inspected — and so the database plumbing can be exercised
// — without committing to a change.
if (process.argv.includes('--check')) {
  console.log('--check: scope resolved, nothing was changed.');
  process.exit(0);
}

// --- the password -------------------------------------------------------

const p1 = await readHidden('New password: ').catch((e) => die(e.message));
if (p1.length < 12) die('too short — use at least 12 characters');
const p2 = await readHidden('Again:        ').catch((e) => die(e.message));
if (p1 !== p2) die('the two entries did not match; nothing was changed');

const hashed = await argon2Hash(p1);

// mustChangePassword is cleared deliberately: a forced change on first login
// would drop you into a password screen instead of the Sell screen, which is
// the one thing this is meant to avoid.
await psql(`
update "PosUser"
   set "passwordHash" = '${hashed.replace(/'/g, "''")}',
       "mustChangePassword" = false,
       "updatedAt" = now()
 where "companyId" = '${company}'
   and email like '%@atcpos.dev';
`).catch((e) => die(e.message));

// Keep the driver scripts working. Same file, same 0600, same variable.
if (existsSync(ACCOUNT_FILE)) {
  const lines = readFileSync(ACCOUNT_FILE, 'utf8').split('\n');
  let replaced = false;
  const next = lines.map((l) => {
    if (/^\s*POS_SANDBOX_PASSWORD\s*=/.test(l)) { replaced = true; return `POS_SANDBOX_PASSWORD=${p1}`; }
    return l;
  });
  if (!replaced) next.push(`POS_SANDBOX_PASSWORD=${p1}`);
  writeFileSync(ACCOUNT_FILE, next.join('\n'), { mode: 0o600 });
}

// Prove it by using it, rather than trusting the UPDATE's own row count.
const owner = emails.find((e) => e.startsWith('sandbox.owner')) || emails[0];
const res = await fetch('http://127.0.0.1:5010/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: owner, password: p1 }),
}).catch(() => null);

if (!res) {
  console.log('\nPASS (password set) — but the dev backend on 5010 is not answering, so it was not test-driven.');
  process.exit(0);
}
if (res.status === 200) {
  console.log(`\nPASS — password set, and ${owner} signs in with it.`);
  process.exit(0);
}
console.log(`\nFAIL — password was written but ${owner} still cannot sign in (HTTP ${res.status}).`);
process.exit(1);
