// Serializes whole vitest RUNS against the shared test database.
//
// Every suite in tests/ wipes the tenant tables in beforeAll, and they all
// point at one database. fileParallelism:false makes that safe WITHIN a run; it
// does nothing between runs. Several agents work these lanes at once, so two
// vitest processes can be mid-run against the same database — and then each
// one's wipe() deletes the other's fixtures.
//
// This worktree makes that sharper than the lanes it consolidates: its tests do
// not run against a private database. The lane's own runner refuses anything
// but vcx_foundation_test at 127.0.0.1:5440, which is ALSO the x/foundation
// lane's database. So the collision here is CROSS-LANE — a foundation run and a
// merge run are two different worktrees wiping one database.
//
// That is why the key below must stay byte-identical to the one in
// x/foundation's tests/globalSetup.js. In a lane with a private database the
// shared key is merely harmless; here it is load-bearing, and a "unique per
// lane" key would silently restore the bug.
//
// Observed 2026-09-24 in this worktree: a run here (pid 2493488) held three
// connections to vcx_foundation_test with no advisory lock on that database at
// all, while foundation's globalSetup was already in place. A lock is a
// participation protocol, so one non-participant defeats it for everyone:
// foundation takes the lock, finds it uncontended, and proceeds straight into
// this lane's fixtures. The damage foundation logged that morning is what that
// looks like from the other side —
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
// Contention here is higher than in a private lane — every foundation run
// competes too — but runs are ~2 min and waiting is cheaper than re-running on
// corrupt fixtures.
//
// A run that cannot get the lock FAILS with the holder named. It must never
// proceed anyway: proceeding is exactly the corruption above, reported as a
// test failure somewhere unrelated.

import { PrismaClient } from '@prisma/client';

// 0x564358, "VCX". Identical to x/foundation's by requirement — see above.
// Advisory locks are scoped to a database (verified 2026-09-24: the same key
// held on vcx_kitchen_test refused a second session on that database and did
// not block a session on vcx_foundation_test, and the pg_locks row carried the
// database oid), so lanes WITH a private database still never contend.
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
const HEARTBEAT_MS = 30_000;

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
          '  This worktree shares vcx_foundation_test with the x/foundation lane,\n' +
          '  so the holder may be a run in a DIFFERENT worktree. Wait and re-run.'
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

  // Re-asserts that the lock is still ours, and keeps the session non-idle.
  // Losing it mid-run would mean another run is already wiping underneath this
  // one, which makes every later result meaningless — worth saying out loud
  // rather than leaving to surface as an unrelated red assertion.
  heartbeat = setInterval(() => {
    held()
      .then((still) => {
        if (!still) note('LOST the lock mid-run — results are not trustworthy, re-run alone');
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
