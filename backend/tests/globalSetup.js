// Serializes whole vitest RUNS against the shared test database.
//
// Every suite in tests/ wipes the tenant tables in beforeAll, and they all
// point at one database. fileParallelism:false makes that safe WITHIN a run; it
// does nothing between runs. Several agents work these lanes at once, so two
// vitest processes can be mid-run against the same database — and then each
// one's wipe() deletes the other's fixtures.
//
// CORRECTED 2026-09-24. This file arrived here as a copy of the version in the
// merge worktrees (merge-a406, main-merge — still byte-identical there), and it
// described THEIR database, not this lane's. It claimed this worktree has no
// private database and shares vcx_foundation_test with the x/foundation lane.
// That is not true here: `vcxp` pins TEST_DATABASE_URL to vcx_providers_test,
// and every lane runner on this box names its own (vcx_payments_test,
// vcx_kitchen_test, ...). A run that waits here is therefore waiting for ANOTHER
// RUN OF THIS LANE, never for foundation — which is what the timeout message
// below now says. The old text would have sent whoever hit it looking through
// other people's worktrees for a holder that cannot be there.
//
// The consequence for the key is the opposite of what the copied text claimed:
// because advisory locks are database-scoped (verified below), a lane with its
// own database could use any key at all. It stays identical to x/foundation's
// anyway, so that a file copied into the next lane — as this one was — is
// correct there too, and so that the merge worktrees, where the key IS
// load-bearing, never have to diverge from their sources.
//
// The incident that justifies the lock is still real, and belongs to the merge
// worktree: a run there (pid 2493488) held three connections to
// vcx_foundation_test with no advisory lock on that database at all, while
// foundation's globalSetup was already in place. A lock is a participation
// protocol, so one non-participant defeats it for everyone: foundation takes the
// lock, finds it uncontended, and proceeds straight into the other run's
// fixtures. The damage foundation logged that morning is what that looks like
// from the other side —
//   /tmp/vcx-a406-full-113135-r1.log — full suite, 11:31:35..11:33:40.
//     foundationPeople.test.js 17/30 red, first causal failure "expected 401 to
//     be 403": its PosUser rows were gone, so the tokens stopped resolving,
//     and the next fixture create hit PosUser_branchId_companyId_fkey.
//   /tmp/vcx-rl-1-gateway-113244.log — a peer starting at 11:32:44, inside that
//     window, whose OWN wipe() died on Region_companyId_fkey.
// Neither report had anything to do with the code under test.
//
// The fix is a session-level Postgres advisory lock held for the length of the
// run, so a second process WAITS instead of interleaving. Chosen over giving
// each run its own database because:
//   - CREATE DATABASE ... TEMPLATE requires zero sessions on the template, so
//     cloning fails precisely when runs overlap, which is the case that matters
//     unless a second, never-connected template database is kept migrated too;
//   - a lock cannot leak. Postgres drops it when the connection dies, so a
//     killed or crashed run leaves nothing behind. Per-run databases survive
//     their run and accumulate on a server this box shares between lanes.
// Contention is low — only this lane's own runs compete — but the 100,000-row
// import test alone takes ~8 min, so waiting is real and is still cheaper than
// re-running on corrupt fixtures.
//
// A run that cannot get the lock FAILS with the holder named. It must never
// proceed anyway: proceeding is exactly the corruption above, reported as a
// test failure somewhere unrelated.

import { PrismaClient } from '@prisma/client';

// 0x564358, "VCX". Identical to x/foundation's — see above for why that is a
// convention here rather than a requirement. Advisory locks are scoped to a
// database (verified 2026-09-24: the same key held on vcx_kitchen_test refused a
// second session on that database and did not block a session on
// vcx_foundation_test, and the pg_locks row carried the database oid), so lanes
// sharing this key never contend across their private databases.
const LOCK_KEY = 5653848;

const TIMEOUT_MS = Number(process.env.VCX_TEST_DB_LOCK_TIMEOUT_MS ?? 300_000);
const POLL_MS = 500;
const PROGRESS_MS = 15_000;
// The lock lives on the connection, so a pool that retired it while idle would
// release the lock mid-run and make this file decoration. Measured rather than
// assumed: on Prisma 5.22 — the version this lane pins too — a lock survived
// 330 s fully idle, lock still in pg_locks and the backend still alive, so there
// is no reap to outrun today. The heartbeat stays as insurance against that
// being a pool-version detail, and earns its keep as the liveness assertion
// below.
// MEASURED 2026-09-24, and the earlier measurement above was wrong about why.
// Prisma's pool retires the connection at ~300s of WALL CLOCK, not of idleness:
// a probe holding this lock with a query every 15s still had its backend pid
// change from 36438 to 36652 at t=301s, application_name back to empty and the
// advisory lock gone with the old backend
// (/home/atc-noc/vcx-providers-local/.runlogs/lockprobe.log). So no heartbeat
// frequency can outrun it, and every run longer than five minutes was losing the
// serialization guard — which the 482s 100,000-row import test found by printing
// "LOST the lock mid-run" seven times.
//
// 10s rather than 30s because the heartbeat is now the thing that RECOVERS the
// lock, and the window between losing it and noticing is the window in which
// another run can start wiping this database undetected.
const HEARTBEAT_MS = 10_000;

const IDENTITY = `vcx-test-lock:${process.pid}`;

let client = null;
let heartbeat = null;

const note = (msg) => process.stderr.write(`[test-db-lock] ${msg}\n`);

// Own client, own pool: the suites' prisma singleton hands out whichever
// pooled connection is free, and a session lock has to stay on ONE session.
// connection_limit=1 makes that structural rather than lucky.
const lockClient = (url) => {
  const u = new URL(url);
  u.searchParams.set('connection_limit', '1');
  u.searchParams.set('pool_timeout', '10');
  return new PrismaClient({ datasources: { db: { url: u.toString() } } });
};

const held = async () => {
  // classid/objid are the high and low halves of the bigint key; LOCK_KEY is
  // below 2^32, so its high half is 0.
  const [row] = await client.$queryRaw`
    SELECT count(*)::int AS n
      FROM pg_locks
     WHERE locktype = 'advisory'
       AND classid = 0
       AND objid = ${LOCK_KEY}
       AND pid = pg_backend_pid()
       AND granted`;
  return row.n > 0;
};

const holder = async () => {
  const [row] = await client.$queryRaw`
    SELECT a.pid,
           a.application_name AS app,
           date_trunc('second', now() - a.backend_start)::text AS age
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory'
       AND l.classid = 0
       AND l.objid = ${LOCK_KEY}
       AND l.granted
     LIMIT 1`;
  return row ?? null;
};

export async function setup() {
  const url = process.env.DATABASE_URL || '';
  // Same guard the suites carry, applied before the first connection: they
  // truncate tenant tables, so a non-_test database must fail the whole run
  // rather than one file.
  if (!/_test(\?|$)/.test(url)) {
    throw new Error('backend tests require a DATABASE_URL ending in _test');
  }

  client = lockClient(url);
  await client.$executeRawUnsafe(`SET application_name = '${IDENTITY}'`);

  const startedAt = Date.now();
  let lastProgress = 0;
  let waitedFor = null;

  for (;;) {
    const [{ ok }] = await client.$queryRaw`SELECT pg_try_advisory_lock(CAST(${LOCK_KEY} AS bigint)) AS ok`;
    if (ok) break;

    const waited = Date.now() - startedAt;
    if (waited >= TIMEOUT_MS) {
      const who = await holder();
      await client.$disconnect();
      client = null;
      throw new Error(
        `another run holds the test database (${url.replace(/\/\/[^@]*@/, '//')}).\n` +
          `  waited ${Math.round(waited / 1000)}s, giving up (VCX_TEST_DB_LOCK_TIMEOUT_MS=${TIMEOUT_MS}).\n` +
          (who
            ? `  holder: ${who.app || '(unnamed)'} backend pid ${who.pid}, connected ${who.age} ago.\n`
            : '  holder: released while we were giving up — just re-run.\n') +
          '  Runs are serialized because they share one database and each wipes it.\n' +
          '  This lane has its own database, so the holder is another run of THIS\n' +
          '  lane — look for a vitest under providers/, not in other worktrees.\n' +
          '  The 100,000-row import test holds it for ~8 min. Wait and re-run.'
      );
    }

    if (waited - lastProgress >= PROGRESS_MS) {
      lastProgress = waited;
      const who = await holder();
      waitedFor = who ?? waitedFor;
      note(
        `waiting ${Math.round(waited / 1000)}s for the test database` +
          (who ? ` (held by ${who.app || '(unnamed)'}, pid ${who.pid})` : '')
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const waited = Date.now() - startedAt;
  note(
    `acquired${waited >= POLL_MS ? ` after ${Math.round(waited / 1000)}s` : ''}` +
      ` as ${IDENTITY}${waitedFor ? ` (previous holder pid ${waitedFor.pid} finished)` : ''}`
  );

  // Re-asserts that the lock is still ours, and RE-TAKES it when the pool has
  // retired the session it was held on (see HEARTBEAT_MS above — that happens on
  // every run past ~5 minutes, not as an edge case).
  //
  // Re-taking is safe to distinguish from a real collision, because the two have
  // different answers: if pg_try_advisory_lock succeeds immediately then nobody
  // else holds it and nobody has wiped anything, so the run continues. If it
  // fails, another run does hold it and is wiping this database right now — and
  // then every later assertion in this process is measuring somebody else's
  // fixtures. That is not a warning, it is the end of the run: printing a note
  // and carrying on is how the corruption this file exists to prevent gets
  // reported as an unrelated red assertion somewhere else.
  heartbeat = setInterval(() => {
    held()
      .then(async (still) => {
        if (still) return;
        const [{ ok: retaken }] = await client.$queryRaw`SELECT pg_try_advisory_lock(CAST(${LOCK_KEY} AS bigint)) AS ok`;
        if (retaken) {
          // Re-asserted on whatever connection the pool has now. Worth a line:
          // it is the only visible evidence that the pool churns underneath a
          // long run, and the next person to read a slow run's output should
          // not have to rediscover it.
          note('lock session was retired by the pool and the lock has been re-taken — no other run intervened');
          await client.$executeRawUnsafe(`SET application_name = '${IDENTITY}'`);
          return;
        }
        const who = await holder();
        note(
          'LOST the test database to another run' +
            (who ? ` (${who.app || '(unnamed)'}, pid ${who.pid})` : '') +
            ' — it is wiping fixtures underneath this one, so every result from here is meaningless.',
        );
        note('aborting. Wait for that run to finish and re-run alone.');
        // Nothing else can stop the run from here: globalSetup has no handle on
        // the suites, and they are mid-flight against a database that is being
        // emptied. A non-zero exit is the honest outcome.
        process.exit(1);
      })
      .catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

export async function teardown() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (!client) return;
  // Releasing explicitly keeps the handover observable; dropping the connection
  // would release it anyway, which is why a killed run cannot wedge the lane.
  try {
    await client.$queryRaw`SELECT pg_advisory_unlock(CAST(${LOCK_KEY} AS bigint))`;
  } finally {
    await client.$disconnect();
    client = null;
  }
}
