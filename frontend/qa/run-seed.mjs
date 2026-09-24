// VC-104 W2 — seed the W2 demo DB (atc_pos_vc104ui_demo) using this repo's
// seed script, without any secret ever reaching a terminal or a file.
//
// Why a runner instead of a shell one-liner: the demo login password is
// DERIVED at runtime from the container's POSTGRES_PASSWORD (sha256, first 24
// hex chars) and must never be printed; seed.js prints every issued password
// to stdout, so stdout is swallowed here and seeding is verified by row
// counts instead. Prints PASS/FAIL and counts only.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// THIS repo's backend, not the vc104-api lane's. It read
// '../../../vc104-api/backend/' until 2026-09-24, which was correct while the
// file lived in W2's frontend lane and the only backend in reach was W1's.
// After a406 consolidation it was wrong in the way D-4 describes: the script
// sat in main and seeded the LANE, so a green run here was evidence about the
// lane's 14 migrations, not about main's 22.
const BACKEND = new URL('../../backend/', import.meta.url).pathname;
const DB = process.env.QA_DB || 'atc_pos_vc104ui_demo';

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

// QA fixture, this DB only: hold BOTH demo stores open around the clock.
//
// The suite used to be green only between 09:00 and 23:00 IST, and degraded
// quietly outside 11:00–22:00. Two separate mechanisms:
//
//   CP (09:00–23:00) — the harness asserts availability unconditionally
//   (`Connaught Place is available for 110001`), so a night run FAILED, with a
//   message that reads like a backend availability bug rather than "you ran it
//   at night". The submit that follows then hung on [data-testid="po-success"]
//   and took the process down with it, discarding the rest of the suite.
//
//   CH (11:00–22:00, closed Mondays) — the harness is better behaved here and
//   records SKIP, but the blocks it skips are the two that carry the open
//   backend defects: the CP→CH reassign + re-price block (D-1) and the
//   capacity block (D-2, including the ASAP tripwire). A night run therefore
//   produced a PASSING artifact that had never executed the evidence the
//   defects doc leans on. The 18:01 UTC run on 2026-09-24 scored 61/61 with
//   4 skips where the daytime lane run scored 72/72 with none.
//
// Holding both open makes the run time-independent. That matters more than
// usual here: D-4 is the finding that a QA artifact is evidence about the tree
// that produced it — an artifact whose check COUNT depends on the clock is a
// weaker claim about any tree.
//
// What this costs, stated plainly: branch-hours logic is no longer exercised
// anywhere in the browser suite, and the CLOSED reason string loses its
// browser coverage (the harness's `if (chOpen) … else` closed-branches are now
// reachable only if this fixture fails to apply — which is itself the useful
// signal). Unavailable-store RENDERING is still covered deterministically by
// the out-of-area case: CP refuses 122001 with "Out of area", asserted and
// screenshotted at 07-out-of-area. Hours are backend logic and are tested
// there; the browser checks here are about service-area matching, pricing,
// routing and capacity.
//
// 1440, not 1439. The window is [opensMinute, closesMinute) — half-open, so
// that 09:00-17:00 and 17:00-21:00 can abut without both claiming 17:00 — and
// 1439 therefore means "open until 23:58:59", leaving the store shut for the
// last minute of every day. A browser run starting at 23:59 IST would have
// found both stores closed and gone red with nothing in the artifact to explain
// it: about one run in 1440, which is exactly the kind of flake that gets
// re-run rather than diagnosed. Measured, not reasoned: /tmp/vcx-w2close/
// hours-probe.mjs walks all 1440 minutes against the shipped isOpenAt and
// reports one closed minute at 1439 and none at 1440.
//
// The same value is in backend/tests/phoneOrders.test.js's openAllWeek(), where
// it is harmless today because no test there asks at a named minute; it is
// REPORTED in docs/VC104-BACKEND-DEFECTS.md rather than changed here, because
// that file belongs to the lane working D-1/D-2 right now.
sqlc(`UPDATE "BranchHours" SET "opensMinute" = 0, "closesMinute" = 1440, closed = false
      WHERE "branchId" IN (SELECT b.id FROM "Branch" b
                           JOIN "Company" c ON c.id = b."companyId"
                           WHERE c."isDemo" = true AND b.code IN ('BSC-CP', 'BSC-CH'))`);
const cpAlwaysOpen = sqlc(`SELECT count(*) FROM "BranchHours"
      WHERE "opensMinute" = 0 AND "closesMinute" = 1440 AND closed = false
        AND "branchId" IN (SELECT b.id FROM "Branch" b
                           JOIN "Company" c ON c.id = b."companyId"
                           WHERE c."isDemo" = true AND b.code IN ('BSC-CP', 'BSC-CH'))`);

const users = count('SELECT count(*) FROM "PosUser"');
const branches = count('SELECT count(*) FROM "Branch"');
const callers = count('SELECT count(*) FROM "Customer"');
const areas = count('SELECT count(*) FROM "BranchServiceArea"');
console.log(`PosUser=${users} Branch=${branches} Customer=${callers} BranchServiceArea=${areas} plan=${plan} cpOpenDays=${cpAlwaysOpen}`);
const ok =
  Number(users) >= 4 && Number(branches) >= 2 && Number(callers) >= 2 && Number(areas) >= 3 &&
  plan === 'MULTI_STORE' && Number(cpAlwaysOpen) === 14; // 7 days x 2 stores
console.log(ok ? 'PASS: demo DB seeded' : 'FAIL: unexpected row counts');
process.exit(ok ? 0 : 1);
