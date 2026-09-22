-- End-of-day cash declaration, per branch.
--
-- The POS already knows what it thinks is in the drawer. What it has never
-- had is a second, independent measurement to disagree with — so it could
-- report takings beautifully while the till was quietly short every evening
-- and nothing in the system would ever say so.
--
-- Money is stored in integer paise here rather than Decimal(10,2), unlike
-- Order and Payment. Those columns are amounts the system computes and must
-- render back exactly as rupees; these are the results of arithmetic across
-- many rows, and the codebase already does every such aggregation in paise
-- (see paiseOf/toRupees in src/lib/money.js). Keeping the stored form the
-- same as the computed form removes the rounding step entirely.
--
-- businessDate is a TEXT 'YYYY-MM-DD' in IST, not a timestamp. A café's
-- trading day is a calendar day in the local zone; a closing keyed on an
-- instant would land the 23:40 count on tomorrow for anyone reading in UTC.
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "countedCashPaise" INTEGER NOT NULL,
    "openingFloatPaise" INTEGER NOT NULL DEFAULT 0,
    "expectedCashPaise" INTEGER NOT NULL,
    "cashSalesPaise" INTEGER NOT NULL,
    "cashRefundsPaise" INTEGER NOT NULL,
    "cardSalesPaise" INTEGER NOT NULL DEFAULT 0,
    "upiSalesPaise" INTEGER NOT NULL DEFAULT 0,
    "otherSalesPaise" INTEGER NOT NULL DEFAULT 0,
    "gatewaySalesPaise" INTEGER NOT NULL DEFAULT 0,
    "variancePaise" INTEGER NOT NULL,
    "ordersBilled" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededById" TEXT,

    CONSTRAINT "DayClose_pkey" PRIMARY KEY ("id")
);

-- Deliberately NOT unique on (branchId, businessDate). A closing is evidence
-- and is never edited in place; a correction is a new row pointing at the one
-- it replaces, so the original figure survives alongside the corrected one.
-- The unique index below is on the pointer, which stops two rows claiming to
-- correct the same closing.
CREATE UNIQUE INDEX "DayClose_supersededById_key" ON "DayClose"("supersededById");
CREATE INDEX "DayClose_companyId_businessDate_idx" ON "DayClose"("companyId", "businessDate");
CREATE INDEX "DayClose_branchId_businessDate_idx" ON "DayClose"("branchId", "businessDate");

ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_closedById_fkey"
    FOREIGN KEY ("closedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DayClose" ADD CONSTRAINT "DayClose_supersededById_fkey"
    FOREIGN KEY ("supersededById") REFERENCES "DayClose"("id") ON DELETE SET NULL ON UPDATE CASCADE;
