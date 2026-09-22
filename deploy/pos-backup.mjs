// Backup, verify and RESTORE-DRILL the ATC POS production database.
//
// Until this file existed there was no backup of this data anywhere. A cafe
// billing on this system has its entire sales history, its staff accounts and
// its cash closings in one Docker volume on one disk. Nothing about that
// arrangement survives a disk failure, a bad migration, or a `docker volume
// rm` typed at the wrong prompt.
//
//   node deploy/pos-backup.mjs --check    report state, write nothing
//   node deploy/pos-backup.mjs            take a backup and verify it
//   node deploy/pos-backup.mjs --drill    restore the newest backup and prove
//                                         it matches the live database
//
// WHAT IS AND IS NOT COVERED
//   Covered:     everything in the pos_pgdata volume, via pg_dump.
//   Not needed:  the pos-prod stack has no uploads volume and no bind mounts
//                (docker-compose.prod.yml) — the database really is the whole
//                of the state. Re-check this if a volume is ever added: a
//                pg_dump-only policy stops being complete the moment one is,
//                and it does so silently.
//   NOT covered: the .env. It holds POSTGRES_PASSWORD, POS_JWT_SECRET and the
//                gateway keys, and a database restored without it cannot even
//                be connected to. It is deliberately not copied here — a
//                credentials file duplicated into a data directory is how
//                secrets end up in seventeen places. The manifest records its
//                SHA-256 instead, so a recovery can tell whether the .env it
//                has is the one that matched the dump, without this directory
//                ever holding the secret.
//
// The decisions that are not obvious:
//
//   * pg_dump runs INSIDE the container over the unix socket, so the password
//     never reaches argv, this process, or the host. It also guarantees client
//     and server are the same major version, which a host pg_dump does not.
//
//   * the table list is read FROM THE DATABASE, never written here. A
//     hand-kept list silently stops covering the newest table, and the newest
//     table is the one nobody has the habit of checking. It is also the only
//     way this survives the drift that already exists — production is several
//     migrations behind the repo, so a script naming DayClose would refuse to
//     run at all.
//
//   * the file is written to .part and renamed only after being READ BACK and
//     found to contain every table the live database reported. An unverified
//     dump is a file, not a backup, and the difference is only ever discovered
//     on the day it matters.
//
//   * free space is checked first and the run REFUSED if tight. This box
//     shares one filesystem between /, /tmp and /var/lib/docker; filling it
//     crash-loops every database on the host. A backup job that causes the
//     outage is not a safety measure.
//
//   * retention never empties the directory and never deletes the newest file
//     regardless of age. A rule that can delete the last copy is a data-loss
//     mechanism wearing a hygiene costume.
//
//   * --drill restores into a THROWAWAY database and compares row counts and
//     the payment total against the live source. This is the only step that
//     distinguishes "we have files" from "we have backups". It is separate
//     from the nightly run because it is the expensive one, and because a
//     drill that fails should page a human rather than fail a cron job nobody
//     reads.
//
// Prints PASS / FAIL / NOTE lines. No password, DSN or customer row is ever
// printed, on success or on error.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, chmod, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { join, basename } from 'node:path';

const CONTAINER = process.env.POS_DB_CONTAINER || 'pos-prod-postgres-1';
const DEST = process.env.POS_BACKUP_DIR || '/home/atc-noc/atc-backups/pos-prod';
const ENV_FILE = process.env.POS_ENV_FILE || '/home/atc-noc/atc-pos/.env';
const KEEP_DAYS = Number(process.env.POS_BACKUP_KEEP_DAYS || 14);
const KEEP_MIN = Number(process.env.POS_BACKUP_KEEP_MIN || 3);
const MIN_FREE_MB = Number(process.env.POS_BACKUP_MIN_FREE_MB || 2048);
// The drill needs a postgres it may create and drop databases in. Production's
// own container would do the job and is deliberately not the default: a
// restore rehearsal that runs inside the thing it is insuring is one typo away
// from being the incident.
const DRILL_CONTAINER = process.env.POS_DRILL_CONTAINER || 'atc-pos-dev-db';
const DRILL_DB = 'pos_restore_drill';

const MODE = process.argv.includes('--drill') ? 'drill'
  : process.argv.includes('--check') ? 'check' : 'backup';

let failures = 0;
const pass = (m) => console.log(`PASS: ${m}`);
const fail = (m) => { console.log(`FAIL: ${m}`); failures += 1; };
const note = (m) => console.log(`NOTE: ${m}`);
const die = (m) => { console.log(`FAIL: ${m}`); process.exit(2); };

// No shell anywhere in this file: every argument is passed as an array
// element, so a table name can never be read as a command.
const run = (args, { stdout } = {}) => new Promise((resolve) => {
  const p = spawn('docker', args, { stdio: ['ignore', stdout ? 'pipe' : 'pipe', 'pipe'] });
  let out = '', err = '';
  if (stdout) p.stdout.pipe(stdout); else p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
});

// psql inside the container. POSTGRES_USER/DB come from the container's own
// environment via `sh -lc`-free indirection: we read them once, up front.
let DBUSER = null, DBNAME = null;
const psql = async (sql, { container = CONTAINER, db = null } = {}) => {
  const r = await run(['exec', container, 'psql', '-U', DBUSER, '-d', db || DBNAME,
    '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  if (r.code !== 0) throw new Error(r.err.split('\n')[0] || `psql exit ${r.code}`);
  return r.out;
};

const sha256File = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

// ---------------------------------------------------------------- the stack
const running = await run(['inspect', '-f', '{{.State.Running}}', CONTAINER]);
if (running.out !== 'true') die(`database container ${CONTAINER} is not running — nothing was attempted`);
pass(`database container ${CONTAINER} is running`);

const envOut = await run(['exec', CONTAINER, 'printenv', 'POSTGRES_USER']);
const envDb = await run(['exec', CONTAINER, 'printenv', 'POSTGRES_DB']);
DBUSER = envOut.out; DBNAME = envDb.out;
if (!DBUSER || !DBNAME) die('could not read POSTGRES_USER/POSTGRES_DB from the container');

await mkdir(DEST, { recursive: true });
await chmod(DEST, 0o700);
// A dump holds every customer's sales and every staff password hash. On a box
// with other tenants on it the mode is the only thing standing between them.
pass('backup directory is mode 700');

// --------------------------------------------------------------- free space
const fs = statfsSync(DEST);
const freeMb = Math.floor((fs.bavail * fs.bsize) / 1048576);
if (MODE === 'backup' && freeMb < MIN_FREE_MB) {
  die(`only ${freeMb}MB free at ${DEST}, need ${MIN_FREE_MB}MB — refusing to dump rather than risk filling the disk the databases live on`);
}
pass(`free space ${freeMb}MB (floor ${MIN_FREE_MB}MB)`);

// ------------------------------------------------------- what is in there
const tableRows = (await psql(
  "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name",
)).split('\n').filter(Boolean);
if (!tableRows.length) die('could not list tables in the database');

const counts = {};
let totalRows = 0;
for (const t of tableRows) {
  const n = Number(await psql(`select count(*) from "${t}"`));
  counts[t] = n;
  totalRows += n;
}
// One money figure, kept deliberately apart from the counts: a row count
// proves the rows arrived and says nothing about whether the amounts came
// with them.
const paymentSum = counts.Payment !== undefined
  ? await psql('select coalesce(sum(amount),0)::text from "Payment"') : null;
const migrations = counts._prisma_migrations !== undefined
  ? Number(await psql('select count(*) from _prisma_migrations where finished_at is not null')) : 0;
pass(`source has ${tableRows.length} tables, ${totalRows} rows, ${migrations} migrations applied, payments totalling ${paymentSum ?? 'n/a'}`);

const listDumps = async () => {
  const names = (await readdir(DEST)).filter((f) => f.startsWith('pos-prod-') && f.endsWith('.dump'));
  const withTime = await Promise.all(names.map(async (f) => ({ f, t: (await stat(join(DEST, f))).mtimeMs })));
  return withTime.sort((a, b) => b.t - a.t);
};

const existing = await listDumps();
if (existing.length) {
  const ageH = Math.floor((Date.now() - existing[0].t) / 3600000);
  if (ageH <= 26) pass(`most recent backup is ${ageH}h old`);
  else fail(`most recent backup is ${ageH}h old — the schedule is not running`);
} else {
  note(`no previous backup exists in ${DEST}`);
}

// =========================================================== --drill
if (MODE === 'drill') {
  const newest = existing[0];
  if (!newest) die('there is no backup to drill');
  const src = join(DEST, newest.f);
  note(`drilling ${newest.f} into ${DRILL_CONTAINER}:${DRILL_DB}`);

  const alive = await run(['inspect', '-f', '{{.State.Running}}', DRILL_CONTAINER]);
  if (alive.out !== 'true') die(`drill container ${DRILL_CONTAINER} is not running`);
  if (DRILL_CONTAINER === CONTAINER) die('refusing to drill inside the production container');

  const drillUser = (await run(['exec', DRILL_CONTAINER, 'printenv', 'POSTGRES_USER'])).out;
  const inTmp = `/tmp/pos-drill-${Date.now()}.dump`;
  let ok = true;
  try {
    const cp = await run(['cp', src, `${DRILL_CONTAINER}:${inTmp}`]);
    if (cp.code !== 0) die(`could not copy the dump into ${DRILL_CONTAINER}`);

    await run(['exec', DRILL_CONTAINER, 'psql', '-U', drillUser, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS ${DRILL_DB}`]);
    const created = await run(['exec', DRILL_CONTAINER, 'psql', '-U', drillUser, '-d', 'postgres',
      '-c', `CREATE DATABASE ${DRILL_DB}`]);
    if (created.code !== 0) die(`could not create ${DRILL_DB}: ${created.err.split('\n')[0]}`);

    // --exit-on-error, because pg_restore's default is to log an error, carry
    // on, and exit 0 — which is how a half-restored database gets called a
    // successful restore.
    const rest = await run(['exec', DRILL_CONTAINER, 'pg_restore', '-U', drillUser,
      '-d', DRILL_DB, '--no-owner', '--exit-on-error', inTmp]);
    if (rest.code !== 0) { fail(`pg_restore failed: ${rest.err.split('\n')[0]}`); ok = false; }
    else pass('pg_restore completed with no errors');

    if (ok) {
      const drillPsql = (sql) => run(['exec', DRILL_CONTAINER, 'psql', '-U', drillUser,
        '-d', DRILL_DB, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
      let mismatches = 0;
      for (const t of tableRows) {
        const r = await drillPsql(`select count(*) from "${t}"`);
        const got = r.code === 0 ? Number(r.out) : NaN;
        if (got !== counts[t]) { fail(`${t}: live ${counts[t]}, restored ${Number.isNaN(got) ? 'missing' : got}`); mismatches += 1; }
      }
      if (mismatches === 0) pass(`all ${tableRows.length} tables restored with identical row counts`);

      if (paymentSum !== null) {
        const r = await drillPsql('select coalesce(sum(amount),0)::text from "Payment"');
        if (r.code === 0 && r.out === paymentSum) pass(`payment total matches (${paymentSum})`);
        else fail(`payment total: live ${paymentSum}, restored ${r.out}`);
      }
      // Row counts can match while the rows are wrong. One content check on
      // the table a restore must get right: who can log in.
      const users = await drillPsql('select count(*) from "PosUser" where "passwordHash" is not null and length("passwordHash") > 20');
      const liveUsers = await psql('select count(*) from "PosUser" where "passwordHash" is not null and length("passwordHash") > 20');
      if (users.code === 0 && users.out === liveUsers) pass(`${liveUsers} staff logins survived the restore with their password hashes intact`);
      else fail(`staff password hashes: live ${liveUsers}, restored ${users.out}`);
    }
  } finally {
    // Always, including on failure: a drill that leaves a copy of production
    // lying around in a dev database has created the problem it was checking
    // for.
    await run(['exec', DRILL_CONTAINER, 'psql', '-U', drillUser, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS ${DRILL_DB}`]);
    await run(['exec', DRILL_CONTAINER, 'rm', '-f', inTmp]);
    pass('drill copy dropped and the temporary dump removed');
  }
  console.log(failures ? `\nFAIL: ${failures} problem(s) — this backup is NOT proven restorable` : '\nPASS: the newest backup restores to an exact copy of production');
  process.exit(failures ? 1 : 0);
}

if (MODE === 'check') {
  note('--check, nothing was written');
  process.exit(failures ? 1 : 0);
}

// =========================================================== --backup
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const out = join(DEST, `pos-prod-${stamp}.dump`);
const part = `${out}.part`;

const sink = createWriteStream(part, { mode: 0o600 });
const dumped = await run(['exec', CONTAINER, 'pg_dump', '-U', DBUSER, '-d', DBNAME, '-Fc', '--no-owner'], { stdout: sink });
await new Promise((r) => sink.end(r));
if (dumped.code !== 0) {
  await rm(part, { force: true });
  die(`pg_dump failed (${dumped.err.split('\n')[0] || `exit ${dumped.code}`}) — no file was kept`);
}
const size = (await stat(part)).size;
if (size < 4096) { await rm(part, { force: true }); die(`dump is only ${size} bytes — refusing to keep it`); }

// -------------------------------------------------------------- verify it
// Read the archive back through pg_restore. This catches a truncated write, a
// half-filled disk and a dump taken against the wrong database — none of
// which announce themselves in pg_dump's exit code.
const vTmp = `/tmp/pos-verify-${Date.now()}.dump`;
await run(['cp', part, `${CONTAINER}:${vTmp}`]);
const toc = await run(['exec', CONTAINER, 'pg_restore', '--list', vTmp]);
await run(['exec', CONTAINER, 'rm', '-f', vTmp]);
if (toc.code !== 0 || !toc.out) { await rm(part, { force: true }); die('the dump cannot be read back by pg_restore — not keeping it'); }

// Every table the source reported must appear in the archive. Checking one
// well-known name would pass a dump of the wrong database; checking all of
// them makes this a comparison rather than a smoke test.
const missing = tableRows.filter((t) => !toc.out.includes(`TABLE public ${t} `));
if (missing.length) { await rm(part, { force: true }); die(`the archive is missing tables the live database has: ${missing.join(' ')}`); }
pass(`archive lists all ${tableRows.length} tables (${(size / 1024).toFixed(0)} KiB)`);

const dumpSha = await sha256File(part);
let envSha = 'absent';
try { envSha = await sha256File(ENV_FILE); } catch { /* recorded as absent */ }

await rename(part, out);
await chmod(out, 0o600);

const manifest = join(DEST, `pos-prod-${stamp}.manifest`);
await writeFile(manifest, `${JSON.stringify({
  takenAt: new Date().toISOString(),
  container: CONTAINER,
  dumpFile: basename(out),
  dumpBytes: size,
  dumpSha256: dumpSha,
  envSha256: envSha,
  paymentAmountSum: paymentSum,
  migrationsApplied: migrations,
  rows: counts,
}, null, 2)}\n`, { mode: 0o600 });
pass('backup written and manifested');

// ----------------------------------------------------------- retention
// Age-based, with two floors. Neither is paranoia: the newest file is the only
// one guaranteed to match the current schema, and KEEP_MIN means a run of
// failures cannot be followed by a successful cleanup that leaves nothing.
const all = await listDumps();
let deleted = 0;
for (let i = all.length - 1; i >= 1; i -= 1) {
  if (all.length - deleted <= KEEP_MIN) break;
  const ageD = (Date.now() - all[i].t) / 86400000;
  if (ageD <= KEEP_DAYS) continue;
  await rm(join(DEST, all[i].f), { force: true });
  await rm(join(DEST, all[i].f.replace(/\.dump$/, '.manifest')), { force: true });
  deleted += 1;
}
pass(`retention: ${all.length - deleted} backup(s) kept, ${deleted} expired (policy ${KEEP_DAYS}d, floor ${KEEP_MIN})`);

console.log('\nNOTE: a dump that has never been restored is an assumption, not a backup.');
console.log('      Prove it:  node deploy/pos-backup.mjs --drill');
process.exit(failures ? 1 : 0);
