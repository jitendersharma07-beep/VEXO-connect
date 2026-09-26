// Empties the test database between suites.
//
// Every file in tests/ points at one database, and until 2026-09-26 each one
// carried its own wipe(): thirty to fifty prisma.<model>.deleteMany() calls,
// hand-sequenced by foreign key, listing only the tables that file knew about.
// That shape has failed this lane three times, and never in the file that was
// wrong:
//
//   - integrations.test.js owns twelve tables whose FKs into Branch and
//     Customer are RESTRICT. Leaving its rows behind turned the NEXT file's
//     customer.deleteMany() into a foreign-key error; the full suite failed 17
//     of 23 files that way. The fix at the time was an afterAll in that one
//     file, which restored the invariant without making it true.
//   - printJobs.test.js fired the same way once two new tests grew the file and
//     vitest's size-descending sequencer moved it up behind promotions.
//   - merging main added KitchenItem, OrderItemModifier and PromotionRedemption,
//     all of which hold an OrderItem. The OrderItem delete then aborted inside
//     the INVENTORY suites, which had never created a KOT or a promotion in
//     their lives. The error named an inventory test; the cause was three lanes
//     away.
//
// The common cause is not carelessness in any one list. It is that a per-file
// list encodes two things a lane cannot keep true: which tables exist, and
// which order they must go in. Both change when someone else merges.
//
// So both are asked of the database instead. The table list comes from the
// catalog, and the ORDER is asked of nobody: the deletes run with referential
// integrity switched off for the length of one transaction, which makes them
// order-independent by definition. A table added by the next merge is cleared
// the day it appears, and no file can leave residue for another to trip on,
// because every file starts from an empty database rather than from one that is
// empty of the tables it happens to name.
//
// WHY DELETE AND NOT TRUNCATE. The inventory helper used TRUNCATE ... CASCADE
// for this same order-independence, and it had to stop: 2274ms per call at the
// median, 11.9s at the worst, ~150 calls per run, and on 2026-09-26 a "Hook
// timed out in 30000ms" in inventoryScheduler's beforeEach, which is this
// function. The cost was never the rows — a test leaves a couple of dozen. It
// is that TRUNCATE gives all 140 tables AND their 532 indexes a fresh
// relfilenode every time, so each call creates and unlinks ~672 files on a disk
// four other lanes are running their own suites against. DELETE touches no
// relfilenode, writes WAL only for the rows really there, and takes a
// RowExclusiveLock instead of an AccessExclusiveLock. Measured: 2274ms -> 6ms
// median, and the five inventory files went from 681.80s to 193.41s.
//
// Narrowing the TRUNCATE to the tables that hold rows is the obvious cheaper
// fix and it does not work — recorded here so the next reader does not spend
// the afternoon re-deriving it. TRUNCATE refuses to leave a referencing table
// behind, so it needs CASCADE, and the cascade closure of Company alone is 127
// of the 139 tables. Every fixture creates a Company. Measured: 2419ms for all
// 139 against 2404ms for the eight a fixture actually dirties.
//
// Against a per-file deleteMany() list this is also faster, but only by tens of
// milliseconds a call (39.6ms -> 18.8ms median for kitchen.test.js's 37 round
// trips), and those lists run once per file rather than once per test. Speed is
// not the reason to prefer it there; the three incidents above are.
//
// _prisma_migrations is excluded: it is the record of what has been applied,
// not test data, and emptying it would make the next run believe the schema was
// never migrated.

import { prisma } from '../../src/lib/prisma.js';

let cachedPlan = null;

const wipePlan = async () => {
  if (cachedPlan) return cachedPlan;

  // The guard is not decoration. This helper empties EVERY table it is pointed
  // at, so it refuses to run anywhere but a database whose name ends in _test —
  // the same rule the lane's test runner enforces on the URL. A misread .env
  // that pointed this at the dev database would otherwise empty it silently and
  // the only symptom would be a passing test suite.
  const [{ current_database: db }] = await prisma.$queryRawUnsafe('select current_database()');
  if (!/_test$/.test(db)) {
    throw new Error(`refusing to wipe "${db}": this helper only runs against a *_test database`);
  }

  // format('%I') rather than hand-written quotes: these identifiers are mixed
  // case, and an unquoted Company is folded to lowercase by Postgres and
  // matches nothing.
  const tables = await prisma.$queryRawUnsafe(
    `select format('%I.%I', schemaname, tablename) as ident,
            quote_literal(format('%I.%I', schemaname, tablename)) as literal
       from pg_tables
      where schemaname = 'public' and tablename <> '_prisma_migrations'`,
  );
  if (!tables.length) throw new Error('no tables found to wipe — is this database migrated?');

  // RESTART IDENTITY used to do this as part of the TRUNCATE.
  const sequences = await prisma.$queryRawUnsafe(
    `select quote_literal(format('%I.%I', n.nspname, c.relname)) as literal
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'S'`,
  );

  // Whether this role may switch referential integrity off for a transaction,
  // asked once and by doing it. session_replication_role is superuser-only on
  // the databases this suite runs against, but PG15 allows it to be GRANTed, so
  // is_superuser is the wrong question and the honest test is the attempt. A
  // role that cannot falls back to the TRUNCATE, which is slow but correct.
  let unordered = true;
  try {
    await prisma.$executeRawUnsafe(
      "do $$ begin perform set_config('session_replication_role', 'replica', true); end $$",
    );
  } catch {
    unordered = false;
  }

  cachedPlan = {
    unordered,
    // One statement, one round trip, one EXISTS per table. EXISTS stops at the
    // first row, and reads no pages at all for a table that is already empty.
    probe: tables
      .map((t) => `select ${t.literal} as ident where exists (select 1 from ${t.ident})`)
      .join(' union all '),
    resets: sequences.map((s) => `  perform setval(${s.literal}, 1, false);`).join('\n'),
    truncate: `truncate table ${tables.map((t) => t.ident).join(', ')} restart identity cascade`,
  };
  return cachedPlan;
};

export const wipeAll = async () => {
  const plan = await wipePlan();
  if (!plan.unordered) {
    await prisma.$executeRawUnsafe(plan.truncate);
    return;
  }

  const dirty = await prisma.$queryRawUnsafe(plan.probe);
  if (!dirty.length) return;

  // set_config's third argument is is_local, so referential integrity comes
  // back when this statement commits OR rolls back. A pooled connection can
  // never be handed on with foreign keys still disabled, and a delete that
  // throws leaves the database untouched rather than half-emptied.
  await prisma.$executeRawUnsafe(
    [
      'do $$',
      'begin',
      "  perform set_config('session_replication_role', 'replica', true);",
      ...dirty.map((r) => `  delete from ${r.ident};`),
      plan.resets,
      'end $$',
    ]
      .filter(Boolean)
      .join('\n'),
  );
};
