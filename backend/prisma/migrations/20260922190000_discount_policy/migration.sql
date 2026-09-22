-- Discount authority: who may take money off a bill, and how far.
--
-- Until now the answer was "anybody at the till, by any amount". The routes
-- checked that a line discount did not exceed its own line and that a percent
-- discount did not exceed 100, and that was the whole of it — so a cashier
-- could discount an order to zero, and could also stack a 50% discount on
-- every line UNDER a 50% order discount, because the two were never looked at
-- together. This migration creates the table that holds the real answer.
--
-- Deliberately NO backfill. Creating this table grants nobody anything: with
-- no rows, cashiers and branch managers may not discount at all, and the
-- company's own owner remains the tenant's unlimited principal (see
-- src/lib/discountPolicy.js, which states that floor in one place instead of
-- scattering role checks through the routes). Permission is granted by the
-- customer's admin through the settings screen, never assumed by a migration.
--
-- Checked before writing this: production carries 0 orders with an
-- order-level discount and 0 lines with a line discount, so deny-by-default
-- changes the behaviour of no existing bill.

CREATE TYPE "DiscountPolicyLevel" AS ENUM ('COMPANY', 'BRANCH', 'USER');

CREATE TABLE "DiscountPolicy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "level" "DiscountPolicyLevel" NOT NULL,
    "branchId" TEXT,
    "userId" TEXT,

    -- Postgres counts NULLs in a unique index as distinct from each other, so
    -- a unique index over the nullable (branchId, userId) pair would happily
    -- hold a hundred rows all claiming to be the company default. scopeKey is
    -- the same fact written so the index can actually bite:
    --   'company' | 'branch:<id>' | 'user:<id>'
    "scopeKey" TEXT NOT NULL,

    -- NULL = inherit from the level above. At COMPANY level there is nothing
    -- above, so NULL there reads as "not allowed".
    "allowLineDiscount" BOOLEAN,
    "allowOrderDiscount" BOOLEAN,

    -- Ceilings on the COMBINED discount — every line discount plus the
    -- order-level discount — measured against the order's gross. Both kinds
    -- may be set at once, in which case both bind and the tighter decides.
    -- Percent is DECIMAL(6,3) like the tax rates; the cash cap is integer
    -- paise, so no float ever takes part in a limit comparison.
    "maxPercent" DECIMAL(6,3),
    "maxFlatPaise" INTEGER,

    -- What this principal may authorise: for somebody else, or for themselves
    -- above their own operating ceiling.
    "canApprove" BOOLEAN,
    "maxApprovalPercent" DECIMAL(6,3),
    "maxApprovalFlatPaise" INTEGER,

    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscountPolicy_companyId_scopeKey_key"
    ON "DiscountPolicy"("companyId", "scopeKey");
CREATE INDEX "DiscountPolicy_companyId_level_idx" ON "DiscountPolicy"("companyId", "level");
CREATE INDEX "DiscountPolicy_branchId_idx" ON "DiscountPolicy"("branchId");
CREATE INDEX "DiscountPolicy_userId_idx" ON "DiscountPolicy"("userId");

ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Percent ceilings are percentages. A negative or >100 ceiling is not a
-- tighter or looser policy, it is a typo, and the database is the last place
-- that can still refuse it.
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_maxPercent_range"
    CHECK ("maxPercent" IS NULL OR ("maxPercent" >= 0 AND "maxPercent" <= 100));
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_maxApprovalPercent_range"
    CHECK ("maxApprovalPercent" IS NULL OR ("maxApprovalPercent" >= 0 AND "maxApprovalPercent" <= 100));
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_maxFlatPaise_range"
    CHECK ("maxFlatPaise" IS NULL OR "maxFlatPaise" >= 0);
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_maxApprovalFlatPaise_range"
    CHECK ("maxApprovalFlatPaise" IS NULL OR "maxApprovalFlatPaise" >= 0);

-- The level and its subject columns have to agree, or the resolver would be
-- reading a branch override that names no branch.
ALTER TABLE "DiscountPolicy" ADD CONSTRAINT "DiscountPolicy_level_subject"
    CHECK (
        ("level" = 'COMPANY' AND "branchId" IS NULL AND "userId" IS NULL)
     OR ("level" = 'BRANCH'  AND "branchId" IS NOT NULL AND "userId" IS NULL)
     OR ("level" = 'USER'    AND "userId" IS NOT NULL)
    );

-- Who allowed the discount a bill carries, and why. Snapshotted onto the
-- order rather than re-derived, because tomorrow's policy edit must never
-- make yesterday's invoice unexplainable. NULL means the discount sat inside
-- the operator's own limit and needed nobody — or that there is no discount.
ALTER TABLE "Order" ADD COLUMN "discountApprovedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "discountApprovedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "discountReason" TEXT;

CREATE INDEX "Order_discountApprovedById_idx" ON "Order"("discountApprovedById");

ALTER TABLE "Order" ADD CONSTRAINT "Order_discountApprovedById_fkey"
    FOREIGN KEY ("discountApprovedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
