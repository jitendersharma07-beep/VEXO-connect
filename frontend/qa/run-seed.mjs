// VC-104 W2 — seed the W2 demo DB (atc_pos_vc104ui_demo) using W1's seed
// script, without any secret ever reaching a terminal or a file.
//
// Why a runner instead of a shell one-liner: the demo login password is
// DERIVED at runtime from the container's POSTGRES_PASSWORD (sha256, first 24
// hex chars) and must never be printed; seed.js prints every issued password
// to stdout, so stdout is swallowed here and seeding is verified by row
// counts instead. Prints PASS/FAIL and counts only.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BACKEND = new URL('../../../vc104-api/backend/', import.meta.url).pathname;
const DB = 'atc_pos_vc104ui_demo';

const pw = execFileSync('docker', ['exec', 'atc-pos-dev-db', 'printenv', 'POSTGRES_PASSWORD'])
  .toString()
  .trim();
const derived = createHash('sha256').update(pw).digest('hex').slice(0, 24);

const res = spawnSync('node', ['prisma/seed.js'], {
  cwd: BACKEND,
  stdio: ['ignore', 'ignore', 'inherit'], // stdout: seed prints passwords — swallow it
  env: {
    ...process.env,
    DATABASE_URL: `postgresql://atc_pos:${encodeURIComponent(pw)}@127.0.0.1:5439/${DB}`,
    POS_SEED_ALLOW_FIXED_PASSWORDS: 'true',
    POS_SEED_RESET_PASSWORDS: 'true',
    POS_SEED_ADMIN_PASSWORD: derived,
    POS_SEED_OWNER_PASSWORD: derived,
    POS_SEED_MANAGER_PASSWORD: derived,
    POS_SEED_CASHIER_PASSWORD: derived,
  },
});
if (res.status !== 0) {
  console.error(`FAIL: seed exited ${res.status === null ? `signal ${res.signal}` : res.status}`);
  process.exit(1);
}

const sqlc = (sql) =>
  execFileSync('docker', ['exec', 'atc-pos-dev-db', 'psql', '-U', 'atc_pos', '-d', DB, '-Atc', sql])
    .toString()
    .trim();
const count = sqlc;

// QA fixture, this DB only: the seed issues FREE_TRIAL, but cross-store phone
// routing is gated on plan === 'MULTI_STORE' (src/lib/phoneOrders.js
// hqRoutingEntitled) — without this every submit to a non-own store is
// NOT_ENTITLED. QA §0 asserts the plan before relying on it.
sqlc(`UPDATE "License" SET plan = 'MULTI_STORE'
      WHERE "companyId" IN (SELECT id FROM "Company" WHERE "isDemo" = true)`);
const plan = sqlc(`SELECT plan FROM "License"
      WHERE "companyId" IN (SELECT id FROM "Company" WHERE "isDemo" = true)`);

const users = count('SELECT count(*) FROM "PosUser"');
const branches = count('SELECT count(*) FROM "Branch"');
const callers = count('SELECT count(*) FROM "Customer"');
const areas = count('SELECT count(*) FROM "BranchServiceArea"');
console.log(`PosUser=${users} Branch=${branches} Customer=${callers} BranchServiceArea=${areas} plan=${plan}`);
const ok =
  Number(users) >= 4 && Number(branches) >= 2 && Number(callers) >= 2 && Number(areas) >= 3 &&
  plan === 'MULTI_STORE';
console.log(ok ? 'PASS: demo DB seeded' : 'FAIL: unexpected row counts');
process.exit(ok ? 0 : 1);
