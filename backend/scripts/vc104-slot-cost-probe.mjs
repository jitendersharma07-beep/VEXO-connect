// Does the slot count stay cheap as a store's history grows? (The peer's open
// question from 7ab9cee.) And does the additive index earn its place?
//
//   node scripts/vc104-slot-cost-probe.mjs
//
// Needs DATABASE_URL pointing at a SCRATCH database — it seeds 120k orders and
// creates/drops indexes. It cleans up after itself and verifies the cleanup.
//
// This measures the REAL countBookedInSlot by importing it, not a copy of its
// SQL — a probe with its own copy of the query measures the copy. The
// expression form it replaced is kept inline only as the comparison baseline
// and as the equivalence oracle.
//
// Two traps this probe already fell into, now guarded:
//   - every shape looked fast because the measured slot was EMPTY. The seed
//     stepped createdAt by (g % 2880) and picked a branch by (g % 5); 2880 is a
//     multiple of 5, so every order in the slot landed in one branch while the
//     probe queried another. 97 is prime, and a zero count now voids the run.
//   - Company does NOT cascade to Branch, so the first teardown left 50k rows.
//     Teardown is ordered and verified.
import { PrismaClient } from '@prisma/client';
import { countBookedInSlot } from '../src/lib/phoneOrders.js';

const prisma = new PrismaClient();
let CO;
const BRANCHES = [];
let CUST;

// What countBookedInSlot used to be: the anchor as one COALESCE, filtered
// directly. Correct, unindexable, and the thing being compared against.
const ANCHOR_EXPR = `SELECT count(*)::int AS n
   FROM "PhoneOrder" po
   CROSS JOIN LATERAL (SELECT
     COALESCE(
       po."scheduledFor",
       (SELECT max(e."at")
          FROM "PhoneOrderEvent" e
         WHERE e."phoneOrderId" = po.id
           AND e.action = 'REASSIGNED'
           AND e."toBranchId" = po."routedBranchId"),
       po."createdAt") AS anchor) a
  WHERE po."companyId" = $1
    AND po."routedBranchId" = $2
    AND po.status IN ('SUBMITTED','ACCEPTED')
    AND a.anchor >= $3
    AND a.anchor < $4`;

// The pre-fix query: counts by createdAt alone. Included because it is the
// speed everyone was used to, and the honest denominator for "how much did
// correctness cost".
const BY_CREATED_AT = `SELECT count(*)::int AS n
   FROM "PhoneOrder" po
  WHERE po."companyId" = $1
    AND po."routedBranchId" = $2
    AND po.status IN ('SUBMITTED','ACCEPTED')
    AND po."createdAt" >= $3
    AND po."createdAt" < $4`;

// The seed folds all history into ~24h in 15-minute steps of (g % 97), so every
// slot is densely populated; 97 is prime so it shares no factor with the
// 5-branch or 10-status cycles. This slot must sit inside that span.
const SLOT_START = new Date('2026-06-01T10:00:00.000Z');
const SLOT_END = new Date('2026-06-01T10:15:00.000Z');

const raw = async (sql) => {
  const r = await prisma.$queryRawUnsafe(sql, CO, BRANCHES[0], SLOT_START, SLOT_END);
  return r[0].n;
};

const real = () => countBookedInSlot(prisma, {
  companyId: CO, branchId: BRANCHES[0], start: SLOT_START, end: SLOT_END,
});

// Wall clock around the real call, median of 7. This includes Prisma overhead,
// which EXPLAIN ANALYZE hides and production pays.
const median = async (fn) => {
  const ms = [];
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint();
    await fn();
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  return ms[3];
};

const total = async () => {
  const r = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "PhoneOrder" WHERE "companyId" = $1`, CO);
  return r[0].n;
};

const PO_IDX = `CREATE INDEX IF NOT EXISTS "tmp_po_slot_idx"
   ON "PhoneOrder" ("companyId", "routedBranchId", status, "createdAt")`;
const POE_IDX = `CREATE INDEX IF NOT EXISTS "tmp_poe_slot_idx"
   ON "PhoneOrderEvent" ("toBranchId", action, at)`;

const seed = async (target) => {
  const have = await total();
  if (target <= have) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PhoneOrder"
       (id, "companyId", reference, "customerId", fulfilment, status,
        "routedBranchId", "scheduledFor", "operatorName", "idempotencyKey",
        "requestHash", "createdAt", "updatedAt")
     SELECT 'tc-' || g, $1, 'TC' || g, $8, 'DELIVERY',
            (CASE WHEN g % 10 = 0 THEN 'REJECTED'
                  WHEN g % 10 = 1 THEN 'CANCELLED'
                  WHEN g % 10 = 2 THEN 'CANCELLED'
                  WHEN g % 3 = 0  THEN 'ACCEPTED'
                  ELSE 'SUBMITTED' END)::"PhoneOrderStatus",
            (ARRAY[$2,$3,$4,$5,$6])[1 + (g % 5)],
            (CASE WHEN g % 12 = 0
                  THEN timestamptz '2026-06-01 00:00:00+00' + (g % 97) * interval '15 minutes'
                  ELSE NULL END),
            'probe', 'tc-idem-' || g, 'tc-hash',
            timestamptz '2026-06-01 00:00:00+00' + (g % 97) * interval '15 minutes',
            now()
       FROM generate_series($7::int, $9::int) g`,
    CO, ...BRANCHES, have + 1, CUST, target,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PhoneOrderEvent"
       (id, "companyId", "phoneOrderId", at, action, "toBranchId")
     SELECT 'tce-' || g, $1, 'tc-' || g,
            timestamptz '2026-06-01 00:00:00+00' + (g % 97) * interval '15 minutes'
              + interval '2 minutes',
            'REASSIGNED', (ARRAY[$2,$3,$4,$5,$6])[1 + (g % 5)]
       FROM generate_series($7::int, $8::int) g
      WHERE g % 7 = 0`,
    CO, ...BRANCHES, have + 1, target,
  );
  await prisma.$executeRawUnsafe(`ANALYZE "PhoneOrder"`);
  await prisma.$executeRawUnsafe(`ANALYZE "PhoneOrderEvent"`);
};

try {
  const co = await prisma.company.create({
    data: {
      name: 'Cost Probe Co',
      slug: `cost-probe-${Date.now()}`,
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 9, expiresAt: new Date(Date.now() + 86400e3) } },
    },
  });
  CO = co.id;
  // publicId is CHECK-constrained to the VC-XX-NNNN shape.
  for (let i = 1; i <= 5; i += 1) {
    BRANCHES.push((await prisma.branch.create({
      data: { companyId: CO, publicId: `VC-CP-000${i}`, name: `Probe ${i}`, code: `P${i}` },
    })).id);
  }
  CUST = (await prisma.customer.create({
    data: { companyId: CO, name: 'Probe Caller', phone: '+919000000001' },
  })).id;

  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "tmp_po_slot_idx"`);
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "tmp_poe_slot_idx"`);

  console.log('  no added index');
  console.log('  history   counted   by createdAt (wrong)   anchor expr (old)   shipped arms');
  console.log('  -------   -------   --------------------   -----------------   ------------');
  for (const target of [5000, 20000, 50000, 120000]) {
    await seed(target);
    const [expr, arms] = [await raw(ANCHOR_EXPR), await real()];
    if (expr !== arms) {
      console.log(`  DISAGREE at ${target}: expression=${expr} shipped=${arms} — timings withheld`);
      break;
    }
    if (arms === 0) {
      console.log(`  VOID at ${target}: the measured slot is EMPTY, no timing here means anything`);
      break;
    }
    console.log(`  ${String(target).padStart(7)}   ${String(arms).padStart(7)}` +
      `   ${(await median(() => raw(BY_CREATED_AT))).toFixed(2).padStart(20)}` +
      `   ${(await median(() => raw(ANCHOR_EXPR))).toFixed(2).padStart(17)}` +
      `   ${(await median(real)).toFixed(2).padStart(12)}`);
  }

  // Which index actually earns its place? Add them one at a time at the largest
  // size rather than assuming both are needed.
  console.log('\n  at 120000, by index configuration (shipped arms only)');
  console.log('  configuration                          counted   ms');
  console.log('  -----------------------------------   -------   -----');
  const line = async (label) => {
    await prisma.$executeRawUnsafe(`ANALYZE "PhoneOrder"`);
    await prisma.$executeRawUnsafe(`ANALYZE "PhoneOrderEvent"`);
    const n = await real();
    console.log(`  ${label.padEnd(35)}   ${String(n).padStart(7)}   ${(await median(real)).toFixed(2).padStart(5)}`);
  };
  await line('none');
  await prisma.$executeRawUnsafe(PO_IDX);
  await line('+ PhoneOrder(.., status, createdAt)');
  await prisma.$executeRawUnsafe(POE_IDX);
  await line('+ PhoneOrderEvent(toBranchId, action, at)');
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "tmp_po_slot_idx"`);
  await line('only PhoneOrderEvent index');
} finally {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "tmp_po_slot_idx"`);
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "tmp_poe_slot_idx"`);
  if (CO) {
    await prisma.phoneOrderEvent.deleteMany({ where: { companyId: CO } });
    await prisma.phoneOrder.deleteMany({ where: { companyId: CO } });
    await prisma.customer.deleteMany({ where: { companyId: CO } });
    await prisma.branch.deleteMany({ where: { companyId: CO } });
    await prisma.license.deleteMany({ where: { companyId: CO } });
    await prisma.company.delete({ where: { id: CO } });
    console.log(`\ncleaned up: ${await total()} scratch phone orders remain (expected 0)`);
  }
  await prisma.$disconnect();
}
