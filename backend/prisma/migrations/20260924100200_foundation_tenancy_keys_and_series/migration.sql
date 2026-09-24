-- LANE foundation — tenancy as a foreign key, and an invoice series that is
-- frozen rather than recomputed. Spec Part A §7, Part B §3/§8.
--
-- TWO THINGS HAPPEN HERE.
--
-- 1. Cross-table agreement becomes a database fact. Every link that is supposed
--    to stay inside one tenant — a store's legal entity, its GSTIN, its region;
--    a terminal's store; a device's store and till; an order's till and device;
--    a payment's order, till and device; a permission rule's store and subject;
--    an assignment's store and user — is re-declared as a COMPOSITE foreign key
--    carrying the owning id alongside the child id.
--
--    This is deliberately not a CHECK constraint. A CHECK cannot read another
--    table, and a trigger that pretends to is not a constraint but a race: two
--    concurrent statements each see a world in which the other has not happened
--    yet. A composite foreign key is enforced by the same machinery as any other
--    referential check, on UPDATE as well as INSERT, under concurrency, for
--    every writer including psql.
--
--    The pattern is: the parent gains a redundant UNIQUE (id, ownerId) —
--    redundant because id is already the key — so the child can point at the
--    pair instead of at id alone. MATCH SIMPLE (Postgres's default) skips the
--    check when a referencing column is NULL, which is what keeps optional
--    links optional: a store with no GSTIN yet has nothing to verify.
--
-- 2. InvoiceCounter gains seriesPrefix, so an established series stops depending
--    on mutable master data. See the backfill below — it reads the prefix off
--    the invoices ALREADY ISSUED under each counter, not off today's branch.
--
-- Upgrade-safe on a populated database. Every NOT NULL column is added nullable,
-- backfilled, then constrained, in that order — the same shape as Branch
-- "publicId" in 20260924100100. Nothing is renamed and nothing is dropped
-- except single-column foreign keys that are immediately replaced by a strictly
-- stronger composite one over the same columns.
--
-- Most of the tables touched here were created by 20260924100100, which has not
-- shipped, so they are empty on any real upgrade. The two that hold live data
-- are "Payment" and "InvoiceCounter", and those two backfills are the ones
-- worth reading closely.

-- ---------------------------------------------------------------------------
-- Drop the single-column foreign keys. Each is replaced further down by a
-- composite over the same column plus the owning id, so no link loses
-- protection at any point except within this transaction.
-- ---------------------------------------------------------------------------

ALTER TABLE "Branch" DROP CONSTRAINT "Branch_gstRegistrationId_fkey";
ALTER TABLE "Branch" DROP CONSTRAINT "Branch_legalEntityId_fkey";
ALTER TABLE "Branch" DROP CONSTRAINT "Branch_regionId_fkey";
ALTER TABLE "BranchBrand" DROP CONSTRAINT "BranchBrand_branchId_fkey";
ALTER TABLE "BranchBrand" DROP CONSTRAINT "BranchBrand_brandId_fkey";
ALTER TABLE "Device" DROP CONSTRAINT "Device_branchId_fkey";
ALTER TABLE "Device" DROP CONSTRAINT "Device_terminalId_fkey";
ALTER TABLE "GstRegistration" DROP CONSTRAINT "GstRegistration_legalEntityId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_branchId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_deviceId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_terminalId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_deviceId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orderId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_terminalId_fkey";
ALTER TABLE "PermissionRule" DROP CONSTRAINT "PermissionRule_branchId_fkey";
ALTER TABLE "PermissionRule" DROP CONSTRAINT "PermissionRule_userId_fkey";
ALTER TABLE "PosUser" DROP CONSTRAINT "PosUser_branchId_fkey";
ALTER TABLE "PosUser" DROP CONSTRAINT "PosUser_regionId_fkey";
ALTER TABLE "Region" DROP CONSTRAINT "Region_parentId_fkey";
ALTER TABLE "Terminal" DROP CONSTRAINT "Terminal_branchId_fkey";
ALTER TABLE "UserStoreAssignment" DROP CONSTRAINT "UserStoreAssignment_branchId_fkey";
ALTER TABLE "UserStoreAssignment" DROP CONSTRAINT "UserStoreAssignment_userId_fkey";

-- ---------------------------------------------------------------------------
-- New columns, added nullable. They are filled and constrained below.
-- ---------------------------------------------------------------------------

ALTER TABLE "BranchBrand" ADD COLUMN "companyId" TEXT;
ALTER TABLE "UserStoreAssignment" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "branchId" TEXT;
ALTER TABLE "InvoiceCounter" ADD COLUMN "seriesPrefix" TEXT;

-- ---------------------------------------------------------------------------
-- Backfill: the tenant of a link row is the tenant of the store it names.
-- Empty on any real upgrade — both tables were created by the previous
-- migration — but written correctly rather than assumed empty.
-- ---------------------------------------------------------------------------

UPDATE "BranchBrand" l
SET "companyId" = b."companyId"
FROM "Branch" b
WHERE l."branchId" = b."id";

UPDATE "UserStoreAssignment" a
SET "companyId" = b."companyId"
FROM "Branch" b
WHERE a."branchId" = b."id";

-- ---------------------------------------------------------------------------
-- Backfill: a payment happened at the store that issued the bill.
--
-- This is derived, not guessed. Payment already points at exactly one Order and
-- Order already carries branchId, so there is one correct answer per row and no
-- judgement involved. It is copied onto the payment because it is the column
-- the terminal and device references are checked against — a payment cannot be
-- attributed to another store's till once this lands.
-- ---------------------------------------------------------------------------

UPDATE "Payment" p
SET "branchId" = o."branchId"
FROM "Order" o
WHERE p."orderId" = o."id";

-- ---------------------------------------------------------------------------
-- Backfill: the series each counter's bills were ACTUALLY issued under.
--
-- Read off the invoice numbers already printed, not off today's branch record.
-- An invoice number is <prefix>/<fy>/<seq5> and the <fy> in it is the counter's
-- own fyLabel, so each issued invoice is direct evidence of the series its
-- counter was running. The EARLIEST bill of the year decides, because that is
-- the bill that established the series.
--
-- Filling this from COALESCE(invoicePrefix, code) for a counter that has
-- already issued invoices would be writing today's value into a historical
-- field and calling it the original — exactly what a store rename mid-year
-- would have corrupted, and the thing this column exists to prevent. So the
-- live branch record is consulted only for counters that have issued nothing,
-- where no series exists yet and the current value is a genuine proposal rather
-- than a claim about the past.
-- ---------------------------------------------------------------------------

UPDATE "InvoiceCounter" c
SET "seriesPrefix" = ev."prefix"
FROM (
    SELECT DISTINCT ON (o."branchId", split_part(o."invoiceNumber", '/', 2))
           o."branchId"                          AS "branchId",
           split_part(o."invoiceNumber", '/', 2) AS "fyLabel",
           split_part(o."invoiceNumber", '/', 1) AS "prefix"
    FROM "Order" o
    WHERE o."invoiceNumber" IS NOT NULL
      AND array_length(string_to_array(o."invoiceNumber", '/'), 1) = 3
    ORDER BY o."branchId",
             split_part(o."invoiceNumber", '/', 2),
             o."billedAt" ASC NULLS LAST,
             o."createdAt" ASC
) ev
WHERE c."branchId" = ev."branchId"
  AND c."fyLabel"  = ev."fyLabel";

-- A counter that has issued nothing has no history to preserve. Here, and only
-- here, the branch's current effective prefix is the right answer.
UPDATE "InvoiceCounter" c
SET "seriesPrefix" = COALESCE(b."invoicePrefix", b."code")
FROM "Branch" b
WHERE c."branchId" = b."id"
  AND c."seriesPrefix" IS NULL;

-- Report, without blocking, any year that already holds more than one series.
-- That is the corruption this column prevents from recurring; where it has
-- already happened the bills keep the numbers they were printed with, because
-- Order."invoiceNumber" is stored and never recomputed, and the counter adopts
-- the series the year opened under. Surfacing the count makes it a known
-- finding instead of something the backfill quietly smoothed over.
DO $$
DECLARE
    split_years INT;
BEGIN
    SELECT count(*) INTO split_years FROM (
        SELECT o."branchId", split_part(o."invoiceNumber", '/', 2) AS fy
        FROM "Order" o
        WHERE o."invoiceNumber" IS NOT NULL
          AND array_length(string_to_array(o."invoiceNumber", '/'), 1) = 3
        GROUP BY 1, 2
        HAVING count(DISTINCT split_part(o."invoiceNumber", '/', 1)) > 1
    ) s;
    IF split_years > 0 THEN
        RAISE NOTICE
          'foundation: % (branch, financial year) pair(s) already hold invoices under more than one series prefix. Issued invoice numbers are unchanged; each counter adopts the prefix its year opened under.',
          split_years;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Now the columns can carry NOT NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE "BranchBrand" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "UserStoreAssignment" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "InvoiceCounter" ALTER COLUMN "seriesPrefix" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Parent-side keys. Redundant as uniqueness — id is already the primary key —
-- and present so a child can reference the pair.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "LegalEntity_id_companyId_key" ON "LegalEntity"("id", "companyId");
CREATE UNIQUE INDEX "GstRegistration_id_legalEntityId_companyId_key" ON "GstRegistration"("id", "legalEntityId", "companyId");
CREATE UNIQUE INDEX "Region_id_companyId_key" ON "Region"("id", "companyId");
CREATE UNIQUE INDEX "Brand_id_companyId_key" ON "Brand"("id", "companyId");
CREATE UNIQUE INDEX "Branch_id_companyId_key" ON "Branch"("id", "companyId");
CREATE UNIQUE INDEX "PosUser_id_companyId_key" ON "PosUser"("id", "companyId");
CREATE UNIQUE INDEX "Terminal_id_branchId_key" ON "Terminal"("id", "branchId");
CREATE UNIQUE INDEX "Device_id_branchId_key" ON "Device"("id", "branchId");
CREATE UNIQUE INDEX "Order_id_branchId_key" ON "Order"("id", "branchId");

CREATE INDEX "BranchBrand_companyId_idx" ON "BranchBrand"("companyId");
CREATE INDEX "UserStoreAssignment_companyId_idx" ON "UserStoreAssignment"("companyId");
CREATE INDEX "Payment_branchId_idx" ON "Payment"("branchId");

-- ---------------------------------------------------------------------------
-- The composite foreign keys.
--
-- Branch's GST reference carries legalEntityId as well as companyId, so the
-- registration must belong both to this tenant AND to the entity this store
-- trades as. A store cannot assert a (legal entity, GSTIN) pairing on its
-- invoices that does not exist in GstRegistration.
--
-- PosUser's branch reference is RESTRICT where the single-column version was
-- SET NULL: Postgres nulls every referencing column of a composite key, so the
-- old action would have blanked companyId too and left a customer account
-- looking like a platform operator. Stores are retired by status, never
-- deleted, so refusing the delete costs nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE "GstRegistration" ADD CONSTRAINT "GstRegistration_legalEntityId_companyId_fkey" FOREIGN KEY ("legalEntityId", "companyId") REFERENCES "LegalEntity"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_legalEntityId_companyId_fkey" FOREIGN KEY ("legalEntityId", "companyId") REFERENCES "LegalEntity"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_gstRegistrationId_legalEntityId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "legalEntityId", "companyId") REFERENCES "GstRegistration"("id", "legalEntityId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_regionId_companyId_fkey" FOREIGN KEY ("regionId", "companyId") REFERENCES "Region"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Region" ADD CONSTRAINT "Region_parentId_companyId_fkey" FOREIGN KEY ("parentId", "companyId") REFERENCES "Region"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BranchBrand" ADD CONSTRAINT "BranchBrand_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BranchBrand" ADD CONSTRAINT "BranchBrand_brandId_companyId_fkey" FOREIGN KEY ("brandId", "companyId") REFERENCES "Brand"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PosUser" ADD CONSTRAINT "PosUser_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PosUser" ADD CONSTRAINT "PosUser_regionId_companyId_fkey" FOREIGN KEY ("regionId", "companyId") REFERENCES "Region"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Device" ADD CONSTRAINT "Device_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_terminalId_branchId_fkey" FOREIGN KEY ("terminalId", "branchId") REFERENCES "Terminal"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_terminalId_branchId_fkey" FOREIGN KEY ("terminalId", "branchId") REFERENCES "Terminal"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_deviceId_branchId_fkey" FOREIGN KEY ("deviceId", "branchId") REFERENCES "Device"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_branchId_fkey" FOREIGN KEY ("orderId", "branchId") REFERENCES "Order"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_terminalId_branchId_fkey" FOREIGN KEY ("terminalId", "branchId") REFERENCES "Terminal"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_deviceId_branchId_fkey" FOREIGN KEY ("deviceId", "branchId") REFERENCES "Device"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_userId_companyId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "PosUser"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UserStoreAssignment" ADD CONSTRAINT "UserStoreAssignment_userId_companyId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "PosUser"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserStoreAssignment" ADD CONSTRAINT "UserStoreAssignment_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- One single-table CHECK, closing the one gap MATCH SIMPLE leaves above.
--
-- Branch's GST reference is skipped entirely when ANY of its three columns is
-- NULL — including legalEntityId. So a store could name a GSTIN while leaving
-- its legal entity blank, and the "the GSTIN belongs to this entity" guarantee
-- would simply not be evaluated. This says: name the entity too.
--
-- It reads only columns of its own row, which is the only thing a CHECK can
-- honestly do. Every cross-table rule above is a foreign key.
-- ---------------------------------------------------------------------------

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_gst_needs_entity" CHECK ("gstRegistrationId" IS NULL OR "legalEntityId" IS NOT NULL);
