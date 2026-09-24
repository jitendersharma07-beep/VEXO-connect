// Runs ONCE before the whole suite, against the test database.
//
// Every test file clears the tables it uses in its own `beforeEach`, and the
// files run sequentially against a single database. That is sound while every
// run finishes. A run that CRASHES — or one stopped halfway — leaves rows that
// the NEXT file's wipe has no statement for, and the RESTRICT foreign keys
// then fail on residue with nothing to do with the code under test. The first
// such failure cascades into the rest of the run, so the suite reports a dozen
// red files for one stale row and the real result is unreadable.
//
// Starting from empty makes a run's result depend only on the code, which is
// the whole point of running it.
//
// TRUNCATE ... CASCADE needs no knowledge of the dependency graph, which is
// exactly why it is used here and not in the per-file helpers.
import { PrismaClient } from '@prisma/client';

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  // Guarded on the database NAME, not on NODE_ENV: an env var is precisely what
  // gets inherited by accident from a sourced .env, and being wrong here costs
  // a development database.
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to run the suite against "${name}": the test database name must end in "_test"`);
  }

  const prisma = new PrismaClient();
  try {
    // _prisma_migrations is excluded deliberately: emptying it would make the
    // next `migrate deploy` re-run migrations already applied to this schema.
    const tables = await prisma.$queryRaw`
      select tablename::text as t from pg_tables
      where schemaname = 'public' and tablename <> '_prisma_migrations'`;
    if (tables.length) {
      const list = tables.map((r) => `"public"."${r.t}"`).join(', ');
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
