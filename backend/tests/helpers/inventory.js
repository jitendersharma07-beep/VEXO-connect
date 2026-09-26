// Shared fixtures for the inventory suites.
//
// Every suite that touches stock shares one _test database, so the wipe below
// clears the whole inventory graph in foreign-key order rather than just the
// tables one file happens to write. A partial wipe leaves another file's rows
// holding a key and the failure surfaces in the wrong suite.

import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/lib/crypto.js';
// The product's own minter, not a literal. Branch.publicId is globally unique
// with a CHECK pinning ^VC-[A-Z]{2}-[0-9]{4,}$, and this fixture is built once
// per suite — five hardcoded ids would collide on the second suite, and a
// hand-written format would be free to drift away from the constraint the
// moment the constraint changed. Minting draws from PlatformCounter, so it is
// collision-free by construction and correct by the same code the route uses.
import { mintStorePublicId } from '../../src/lib/identity.js';


// Clears every table in the test database.
//
// This used to be three hand-ordered lists of deleteMany() calls, one table per
// line, sequenced by foreign key. That is the wrong shape for a file that lives
// on a lane: every lane that merges brings tables this file has never heard of,
// and the list does not merely go out of date — it FAILS, deep inside an
// unrelated suite. Merging main added KitchenItem, OrderItemModifier and
// PromotionRedemption, all of which hold an OrderItem; the delete of OrderItem
// then aborted inside the inventory suites, which had never created a KOT or a
// promotion in their lives. The error named an inventory test, and the cause
// was three lanes away.
//
// So the table list is asked of the catalog, and the ORDER is asked of nobody:
// the deletes below run with referential integrity switched off for the length
// of one transaction, which makes them order-independent by definition. A table
// added by the next merge is cleared the day it appears, without anyone
// remembering to add a line.
//
// This was TRUNCATE ... CASCADE until 2026-09-26, chosen for that same
// order-independence. What changed is not the requirement but the price: 2274ms
// per call at the median, 11.9s at the worst, ~150 calls per run across the five
// inventory suites. On 2026-09-26 it stopped being merely slow and started
// failing runs — "Hook timed out in 30000ms" in inventoryScheduler's beforeEach,
// which is this function.
//
// The cost was never the rows; a test leaves a couple of dozen. It is that
// TRUNCATE gives all 140 tables AND their 532 indexes a fresh relfilenode every
// time, so each call creates and unlinks ~672 files on a disk four other lanes
// are running their own suites against. DELETE touches no relfilenode, writes
// WAL for the rows actually present, and takes a RowExclusiveLock instead of an
// AccessExclusiveLock. Measured on a private database: 2274ms -> 6ms median.
//
// Narrowing the TRUNCATE to the tables that hold rows is the obvious cheaper
// fix, and it does not work — recorded here so the next reader does not spend
// the afternoon re-deriving it. TRUNCATE refuses to leave a referencing table
// behind, so it needs CASCADE, and the cascade closure of Company alone is 127
// of the 139 tables. Every fixture creates a Company. Measured: 2419ms for all
// 139 against 2404ms for the eight a fixture actually dirties.
//
// _prisma_migrations is excluded: it is the record of what has been applied,
// not test data, and emptying it would make the next run believe the schema
// was never migrated.
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

export const TEST_PASSWORD = 'test-password-1';

// One warehouse, two stores, and the four principals the acceptance walk
// needs. Deliberately small: every test that needs more builds it itself so
// the shared fixture stays readable.
export const buildBaseFixture = async ({ slug = 'inv-co' } = {}) => {
  const company = await prisma.company.create({
    data: { name: 'Inventory Test Co', slug: `${slug}-${Date.now()}` },
  });
  await prisma.license.create({
    data: {
      companyId: company.id,
      plan: 'MULTI_STORE',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 365 * 86400000),
      baseBranchLimit: 10,
      // The fixture company has bought Inventory. Every inventory route is
      // gated on this — see requireInventoryAction — so without it the whole
      // of these suites would answer 403 POS_MODULE_NOT_LICENSED.
      //
      // Granted here rather than in each suite, so the entitlement is the
      // BACKGROUND of these tests and not something any of them is quietly
      // asserting. The suite that tests the gate itself issues its own licence
      // without the module; see inventoryApi.test.js.
      modules: ['INVENTORY'],
    },
  });

  const storeA = await prisma.branch.create({
    data: { companyId: company.id, publicId: await mintStorePublicId(prisma), name: '店 A', code: 'SA' },
  });
  const storeB = await prisma.branch.create({
    data: { companyId: company.id, publicId: await mintStorePublicId(prisma), name: 'Store B', code: 'SB' },
  });

  const passwordHash = await hashPassword(TEST_PASSWORD);
  const owner = await prisma.posUser.create({
    data: {
      companyId: company.id,
      email: `owner-${company.id}@test.local`,
      fullName: 'Owner',
      role: 'CUSTOMER_OWNER',
      passwordHash,
    },
  });
  const managerA = await prisma.posUser.create({
    data: {
      companyId: company.id,
      branchId: storeA.id,
      email: `mgra-${company.id}@test.local`,
      fullName: 'Manager A',
      role: 'BRANCH_MANAGER',
      passwordHash,
    },
  });
  const managerB = await prisma.posUser.create({
    data: {
      companyId: company.id,
      branchId: storeB.id,
      email: `mgrb-${company.id}@test.local`,
      fullName: 'Manager B',
      role: 'BRANCH_MANAGER',
      passwordHash,
    },
  });
  const cashierA = await prisma.posUser.create({
    data: {
      companyId: company.id,
      branchId: storeA.id,
      email: `casha-${company.id}@test.local`,
      fullName: 'Cashier A',
      role: 'CASHIER',
      passwordHash,
    },
  });

  const warehouse = await prisma.inventoryLocation.create({
    data: { companyId: company.id, kind: 'WAREHOUSE', name: 'Central Warehouse', code: 'WH1' },
  });
  const roomA = await prisma.inventoryLocation.create({
    data: {
      companyId: company.id,
      branchId: storeA.id,
      kind: 'STORE',
      name: 'Store A room',
      code: 'SA-ROOM',
      saleSourceBranchId: storeA.id,
    },
  });
  const roomB = await prisma.inventoryLocation.create({
    data: {
      companyId: company.id,
      branchId: storeB.id,
      kind: 'STORE',
      name: 'Store B room',
      code: 'SB-ROOM',
      saleSourceBranchId: storeB.id,
    },
  });

  // The warehouse belongs to no branch, so a branch-pinned manager can only
  // reach it through an explicit grant. Manager A gets one; Manager B does
  // not, which is what the cross-scope negatives assert against.
  await prisma.inventoryLocationAccess.create({
    data: {
      companyId: company.id,
      userId: managerA.id,
      locationId: warehouse.id,
      canDispatch: true,
      canApprove: true,
    },
  });

  // Manager A also receives at the store room they are pinned to; the branch
  // pin already grants that, but the warehouse grant above is explicit about
  // what Manager A may do there and receiving is deliberately not on it.
  const supplier = await prisma.supplier.create({
    data: { companyId: company.id, name: 'Acme Provisions', code: 'ACME' },
  });

  return { company, storeA, storeB, owner, managerA, managerB, cashierA, warehouse, roomA, roomB, supplier };
};

export const makeItem = async (companyId, overrides = {}) =>
  prisma.inventoryItem.create({
    data: {
      companyId,
      kind: 'RAW',
      name: `Item ${Math.random().toString(36).slice(2, 8)}`,
      baseUnit: 'G',
      trackBatches: true,
      trackExpiry: true,
      ...overrides,
    },
  });

export const makeBatch = async (companyId, itemId, overrides = {}) =>
  prisma.stockBatch.create({
    data: {
      companyId,
      itemId,
      batchCode: `B${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      ...overrides,
    },
  });

export const daysFromNow = (n) => new Date(Date.now() + n * 86400000);
