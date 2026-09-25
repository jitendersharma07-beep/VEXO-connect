// VC-104 migration rehearsal — populate the scratch database.
//
// Builds a PhoneOrder/PhoneOrderEvent table pair large enough that CREATE INDEX
// has to do real work, so the lock window measured by the rehearsal is a lock
// window and not a rounding error. Sized at the same 120k the migration header
// quotes, so the two numbers are comparable.
//
// Everything below is raw SQL over generate_series rather than client creates:
// 120k round-trips through the query engine would dominate the runtime and tell
// us nothing about the index. One tenant, two branches, one customer — the FK
// parents only have to exist, their contents are not what is being measured.
//
// Refuses to run against anything but a vcx_rehearse_* database.
import { PrismaClient } from '@prisma/client';

const ORDERS = Number(process.env.REHEARSE_ORDERS ?? 120_000);

const url = new URL(process.env.DATABASE_URL);
const dbName = url.pathname.slice(1);
if (!/^vcx_rehearse_[a-z0-9_]+$/.test(dbName)) {
  console.error(`REFUSED: ${dbName} is not a vcx_rehearse_* database`);
  process.exit(2);
}

const prisma = new PrismaClient();
const t0 = Date.now();

try {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Company" (id, name, slug, "createdAt", "updatedAt")
    VALUES ('rh-co', 'Rehearsal Co', 'rehearsal-co', now(), now())
    ON CONFLICT (id) DO NOTHING`);

  for (const [id, code, pub] of [
    ['rh-b1', 'RH1', 'VC-RH-0001'],
    ['rh-b2', 'RH2', 'VC-RH-0002'],
  ]) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Branch" (id, "companyId", name, code, "publicId", "createdAt", "updatedAt")
      VALUES ($1, 'rh-co', $2, $2, $3, now(), now())
      ON CONFLICT (id) DO NOTHING`, id, code, pub);
  }

  await prisma.$executeRawUnsafe(`
    INSERT INTO "Customer" (id, "companyId", name, phone, "createdAt", "updatedAt")
    VALUES ('rh-cu', 'rh-co', 'Rehearsal Customer', '9000000000', now(), now())
    ON CONFLICT (id) DO NOTHING`);

  // Orders spread over 90 days so the createdAt column in the new index is
  // selective rather than one constant value — an index on a single repeated
  // key would look artificially good.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "PhoneOrder"
      (id, "companyId", reference, "customerId", fulfilment, status,
       "routedBranchId", "operatorName", "idempotencyKey", "requestHash",
       "createdAt", "updatedAt")
    SELECT
      'rh-po-' || g,
      'rh-co',
      'RH' || lpad(g::text, 8, '0'),
      'rh-cu',
      (ARRAY['DELIVERY','PICKUP'])[1 + (g % 2)]::"PhoneFulfilment",
      (ARRAY['SUBMITTED','ACCEPTED','REJECTED'])[1 + (g % 3)]::"PhoneOrderStatus",
      CASE WHEN g % 2 = 0 THEN 'rh-b1' ELSE 'rh-b2' END,
      'rehearsal',
      'rh-key-' || g,
      'rh-hash-' || g,
      now() - ((g % 129600) * interval '1 minute'),
      now()
    FROM generate_series(1, ${ORDERS}) AS g`);

  // One in eight orders carries a REASSIGNED event, which is roughly the shape
  // the anchor query walks: the vast majority of rows have no event at all and
  // the anti-join has to prove that cheaply.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "PhoneOrderEvent"
      (id, "companyId", "phoneOrderId", at, action, "fromBranchId", "toBranchId")
    SELECT
      'rh-ev-' || g,
      'rh-co',
      'rh-po-' || g,
      now() - ((g % 129600) * interval '1 minute') + interval '3 minute',
      'REASSIGNED',
      CASE WHEN g % 2 = 0 THEN 'rh-b2' ELSE 'rh-b1' END,
      CASE WHEN g % 2 = 0 THEN 'rh-b1' ELSE 'rh-b2' END
    FROM generate_series(1, ${ORDERS}, 8) AS g`);

  await prisma.$executeRawUnsafe(`ANALYZE "PhoneOrder"`);
  await prisma.$executeRawUnsafe(`ANALYZE "PhoneOrderEvent"`);

  const [{ orders }] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS orders FROM "PhoneOrder"`);
  const [{ events }] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS events FROM "PhoneOrderEvent"`);
  const [sizes] = await prisma.$queryRawUnsafe(`
    SELECT pg_size_pretty(pg_total_relation_size('"PhoneOrder"')) AS po,
           pg_size_pretty(pg_total_relation_size('"PhoneOrderEvent"')) AS ev`);

  console.log(`database    : ${dbName}`);
  console.log(`PhoneOrder  : ${orders} rows, ${sizes.po}`);
  console.log(`PhoneOrderEvent: ${events} rows, ${sizes.ev}`);
  console.log(`elapsed     : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await prisma.$disconnect();
}
