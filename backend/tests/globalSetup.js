// Serializes whole vitest RUNS against the shared test database, and starts
// each one from an empty one.
//
// Two separate hazards, and the merge of x/accounts kept both because they do
// not substitute for each other:
//
//   - BETWEEN runs: several agents work these lanes at once, so two vitest
//     processes can be mid-run against one database, each wipe() deleting the
//     other's fixtures. The advisory lock below is the fix.
//   - AFTER a crash: a run stopped halfway leaves rows the NEXT file's wipe has
//     no statement for, and the RESTRICT foreign keys then fail on residue that
//     has nothing to do with the code under test — one stale row reported as a
//     dozen red files. The TRUNCATE in reset() is the fix.
//
// ORDER IS LOAD-BEARING: the truncate runs only once the lock is held. Wiping
// first would be the very corruption the lock exists to prevent, except done by
// the process that is supposed to be preventing it.
//
// Every suite in tests/ wipes the tenant tables in beforeAll, and they all
// point at one database. fileParallelism:false makes that safe WITHIN a run; it
// does nothing between runs. Several agents work these lanes at once, so two
// vitest processes can be mid-run against the same database — and then each
// one's wipe() deletes the other's fixtures.
//
// Some worktrees make that sharper than others: a lane whose runner points at
// another lane's database — the consolidation worktree pointed at
// vcx_foundation_test at 127.0.0.1:5440, x/foundation's own — collides
// CROSS-LANE, two different worktrees wiping one database.
//
// That is why the key below must stay byte-identical everywhere this file is
// copied. In a lane with a private database the shared key is merely harmless;
// where two lanes share one it is load-bearing, and a "unique per
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
//
// The same is true of losing the lock MID-run, but only one of the two ways
// that can happen is a corruption, and the difference is the whole point of the
// heartbeat:
//   - ANOTHER run holds the key. It has already truncated these tables, so
//     every assertion after that moment describes a database changing
//     underneath it. Loud, and the run must not exit 0.
//   - NOBODY holds the key. A session lock dies with its session, so this is
//     this process's own connection having been replaced. Nothing was
//     corrupted; serialization is simply gone until the key is taken again, so
//     the heartbeat takes it again.
// Until 2026-09-25 the check was `pid = pg_backend_pid()`, which is false in
// BOTH cases and so could only ever report the worse one. It cost a green
// 923-test run that was discarded on the strength of the warning while an
// independent pg_stat_activity sampler was proving no second run existed. A
// warning that cries wolf is worse than none: the next reader learns to ignore
// it, and then a real theft passes for noise.

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
// below. Tunable only so the controls that exercise the two branches below do
// not have to wait 30 s per tick — nothing in a run should set it.
const HEARTBEAT_MS = Number(process.env.VCX_TEST_DB_HEARTBEAT_MS ?? 30_000);

const IDENTITY = `vcx-test-lock:${process.pid}`;

let client = null;
let heartbeat = null;
// Set the moment a foreign holder is seen, and read in teardown: vitest has
// already printed the results by then, so failing there is what keeps a run
// whose fixtures were wiped from being reported as green.
let stolenBy = null;
let affinityNoted = false;

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

// Who holds the key on THIS database, and is it us.
//
// The database filter is load-bearing, not tidiness: pg_locks is CLUSTER-wide.
// Advisory locks are scoped to a database, but the view is not — verified
// 2026-09-25, a query from vcx_payint_test listed four other lanes holding this
// same key on vcx_slotfresh_test, vcx_providers_test, vcx_floorplan_test and
// vcx_inventory_test. All lanes share one server and differ only by database,
// so without the filter every run on this box would see "somebody else holds
// it" and report a theft that never happened. It is also why the waiting and
// timeout messages can name the wrong lane's run without it.
//
// classid/objid are the high and low halves of the bigint key; LOCK_KEY is
// below 2^32, so its high half is 0. LEFT JOIN because the identity is a
// convenience and the lock row is the evidence: a backend that vanishes between
// the two reads must still count as a holder, not disappear into "unheld".
const holders = async () =>
  client.$queryRaw`
    SELECT l.pid::int AS pid,
           (l.pid = pg_backend_pid()) AS mine,
           coalesce(a.application_name, '') AS app,
           coalesce(date_trunc('second', now() - a.backend_start)::text, 'unknown') AS age
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory'
       AND l.classid = 0
       AND l.objid = ${LOCK_KEY}
       AND l.granted
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

// Ours by IDENTITY, not just by backend pid. The distinction is the whole
// defect: the 09-24 foundation false alarm had an independent poller watching
// ONE holder pid hold this key continuously from its 90 s tick through 166 s
// while the heartbeat was reporting the lock lost — so the lock had not moved,
// the heartbeat's own query had, onto a connection that was not the one holding
// it. Reading that as a theft would now FAIL the run: a worse bug than the
// warning it replaced. application_name is set on the locking session before it
// contends, so the identity travels with the lock and says "this process".
const isOurs = (r) => r.mine || r.app === IDENTITY;

const holder = async () => (await holders()).find((r) => !isOurs(r)) ?? null;

// Other runs connected to this database, holding the key or not. globalSetup
// sets application_name BEFORE it contends, so a competitor is visible here
// whether or not it ever wins the lock — which is what lets the reconnect
// message below say something evidence-based about the gap instead of assuming
// the coast was clear.
const peerRuns = async () => {
  const [row] = await client.$queryRaw`
    SELECT count(*)::int AS n
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND application_name LIKE 'vcx-test-lock:%'
       AND application_name <> ${IDENTITY}`;
  return row.n;
};

const reportTheft = (who) => {
  stolenBy = who ?? { pid: 0, app: '', age: 'unknown' };
  // First sentence kept byte-identical to the message this file has always
  // printed: it is what the lane notes and handovers quote.
  note(
    'LOST the lock mid-run — results are not trustworthy, re-run alone' +
      (who
        ? ` — taken by ${who.app || '(unnamed)'}, backend pid ${who.pid}, connected ${who.age} ago`
        : ' — the thief released it before it could be named')
  );
};

// One heartbeat tick. Silent while the lock is ours, which is every tick of a
// normal run.
const checkLock = async () => {
  const rows = await holders();
  const ours = rows.filter(isOurs);
  if (ours.length) {
    // Held by this process, just not on the connection that asked. Nothing is
    // wrong and nothing to do — a re-acquire would fail anyway, since the
    // session holding it is one of ours. Said once, because this is the shape
    // that used to be reported as a lost lock.
    if (!ours.some((r) => r.mine) && !affinityNoted) {
      affinityNoted = true;
      note(`still held, on backend pid ${ours[0].pid} rather than this connection — serialization intact`);
    }
    return;
  }

  // Someone else has it. Nothing to take back — they are mid-truncate, and a
  // blocking acquire here would just wait for the run that has already ruined
  // this one.
  const foreign = rows.find((r) => !isOurs(r));
  if (foreign) return reportTheft(foreign);

  // Unheld. try, never a blocking acquire: this runs on a timer inside a live
  // suite, and it must not be able to stall one.
  const [{ ok }] = await client.$queryRaw`SELECT pg_try_advisory_lock(CAST(${LOCK_KEY} AS bigint)) AS ok`;
  if (!ok) return reportTheft(await holder());

  // A replacement session starts with no application_name, and this one has to
  // stay named: that name is how a peer — and the samplers used to audit this
  // very warning — tell a participant from any other connection.
  await client.$executeRawUnsafe(`SET application_name = '${IDENTITY}'`);
  // Taking the key back after a theft is still worth doing — it keeps a third
  // participant out of the rest of the run — but it is not an all-clear, and a
  // log that reads like one is how the earlier false alarm did its damage.
  if (stolenBy) return note('took the key back, but this run is already invalid — see above');

  const peers = await peerRuns();
  note(
    'reconnected — the lock\'s connection was replaced, no other run held the key, re-acquired' +
      (peers
        ? `. ${peers} other test run(s) are on this database though, so the gap was contended: re-run alone before trusting a red result`
        : '')
  );
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
          '  Some lanes point at another lane\'s database, so the holder may be a run\n' +
          '  in a DIFFERENT worktree. Wait and re-run.'
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
  heartbeat = setInterval(() => {
    checkLock().catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Only now, with the lock held, is it safe to empty the database: this is the
  // one moment no other run can be mid-fixture. _prisma_migrations is excluded
  // deliberately — emptying it would make the next `migrate deploy` re-run
  // migrations already applied to this schema. TRUNCATE ... CASCADE needs no
  // knowledge of the dependency graph, which is why it is used here and not in
  // the per-file helpers.
  const tables = await client.$queryRaw`
    select tablename::text as t from pg_tables
    where schemaname = 'public' and tablename <> '_prisma_migrations'`;
  if (tables.length) {
    const list = tables.map((r) => `"public"."${r.t}"`).join(', ');
    await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    note(`emptied ${tables.length} tables`);
  }
}

export async function teardown() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (client) {
    // Releasing explicitly keeps the handover observable; dropping the connection
    // would release it anyway, which is why a killed run cannot wedge the lane.
    // Swallowed because of that: if the session is already gone the unlock
    // errors, and the disconnect below has released the lock regardless — it
    // must not become the run's verdict, least of all masking the throw below.
    try {
      await client.$queryRaw`SELECT pg_advisory_unlock(CAST(${LOCK_KEY} AS bigint))`;
    } catch {
      /* already released with its session */
    } finally {
      await client.$disconnect();
      client = null;
    }
  }

  // Every result above was measured against a database another run was
  // truncating, so passing them off as passes is the one outcome that must not
  // happen. Throwing here is the only lever this file has left by teardown, and
  // it exits non-zero.
  if (stolenBy) {
    const who = stolenBy.app || `(unnamed) backend pid ${stolenBy.pid}`;
    stolenBy = null;
    throw new Error(
      `the test database lock was taken by ${who} while this run was using it.\n` +
        '  Whatever is printed above is not a result: that run empties these tables on\n' +
        '  acquire, so fixtures vanished mid-suite. Re-run alone — and if the suites are\n' +
        '  green then, nothing here was broken.'
    );
  }
}
