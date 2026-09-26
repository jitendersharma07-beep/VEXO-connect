-- LANE tables — covers (pax) and waiter attribution on the order.
--
-- Additive and nullable throughout, so every bill that already exists keeps
-- exactly the information that ever existed for it. Nothing is backfilled: an
-- order rung up last month has no recorded cover count and no server, and
-- inventing one would put a number into a sales-per-cover report that no member
-- of staff ever stated.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "pax" INTEGER,
ADD COLUMN     "waiterId" TEXT,
ADD COLUMN     "waiterSetAt" TIMESTAMP(3),
ADD COLUMN     "waiterSetById" TEXT;

-- CreateIndex
CREATE INDEX "Order_companyId_waiterId_billedAt_idx" ON "Order"("companyId", "waiterId", "billedAt");

-- CreateIndex
CREATE INDEX "Order_waiterSetById_idx" ON "Order"("waiterSetById");

-- AddForeignKey
-- (waiterId, companyId) and not waiterId alone: the tenant on the order is part
-- of the key, so a server from another company cannot be credited with this
-- bill even by a route that forgot to scope its query.
ALTER TABLE "Order" ADD CONSTRAINT "Order_waiterId_companyId_fkey" FOREIGN KEY ("waiterId", "companyId") REFERENCES "PosUser"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_waiterSetById_fkey" FOREIGN KEY ("waiterSetById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Covers are 1 or more, or not stated at all. Zero is not a party, and a
-- sales-per-cover report divides by this column: 0 would either divide by zero
-- or claim a table of four ate for nothing. NULL stays legal and means exactly
-- "nobody has said yet".
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_pax_positive" CHECK ("pax" IS NULL OR "pax" > 0);

-- Attribution is a fact with a witness or it is absent — there is no third
-- state. A row holding a server with no idea when it was credited cannot be
-- used in a shift report, and a waiterSetAt with no server is a record of
-- nothing. Same reasoning as DiningVisit_status_matches_lifecycle: the columns
-- that only make sense together are made to move together by the database
-- rather than by whichever route writes them next.
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_waiter_attribution_complete" CHECK (
    ("waiterId" IS NULL     AND "waiterSetAt" IS NULL     AND "waiterSetById" IS NULL)
    OR
    ("waiterId" IS NOT NULL AND "waiterSetAt" IS NOT NULL AND "waiterSetById" IS NOT NULL)
  );
