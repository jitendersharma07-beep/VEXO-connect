-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('TILL', 'PHONE', 'QR');

-- CreateEnum
CREATE TYPE "QrCodeStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DiningVisitStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "QrSubmissionStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "qrCodeId" TEXT,
ADD COLUMN     "source" "OrderSource" NOT NULL DEFAULT 'TILL',
ADD COLUMN     "visitId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "addedByGuestId" TEXT;

-- CreateTable
CREATE TABLE "TableQrCode" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "QrCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "rotation" INTEGER NOT NULL DEFAULT 1,
    "activeTableId" TEXT,
    "issuedById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedReason" TEXT,
    "replacedById" TEXT,
    "printedPlace" TEXT,
    "lastPrintedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableQrCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningVisit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "qrCodeId" TEXT,
    "status" "DiningVisitStatus" NOT NULL DEFAULT 'OPEN',
    "openTableId" TEXT,
    "joinCode" TEXT NOT NULL,
    "joinAttempts" INTEGER NOT NULL DEFAULT 0,
    "guestSeq" INTEGER NOT NULL DEFAULT 0,
    "openedById" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedReason" TEXT,

    CONSTRAINT "DiningVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningVisitGuest" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "isHost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "DiningVisitGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrSubmission" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "qrCodeId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "guestId" TEXT,
    "status" "QrSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "orderId" TEXT,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QrSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TableQrCode_token_key" ON "TableQrCode"("token");

-- CreateIndex
CREATE UNIQUE INDEX "TableQrCode_activeTableId_key" ON "TableQrCode"("activeTableId");

-- CreateIndex
CREATE UNIQUE INDEX "TableQrCode_replacedById_key" ON "TableQrCode"("replacedById");

-- CreateIndex
CREATE INDEX "TableQrCode_companyId_branchId_status_idx" ON "TableQrCode"("companyId", "branchId", "status");

-- CreateIndex
CREATE INDEX "TableQrCode_tableId_idx" ON "TableQrCode"("tableId");

-- CreateIndex
CREATE INDEX "TableQrCode_issuedById_idx" ON "TableQrCode"("issuedById");

-- CreateIndex
CREATE INDEX "TableQrCode_revokedById_idx" ON "TableQrCode"("revokedById");

-- CreateIndex
CREATE UNIQUE INDEX "TableQrCode_tableId_rotation_key" ON "TableQrCode"("tableId", "rotation");

-- CreateIndex
CREATE UNIQUE INDEX "DiningVisit_openTableId_key" ON "DiningVisit"("openTableId");

-- CreateIndex
CREATE INDEX "DiningVisit_companyId_branchId_status_idx" ON "DiningVisit"("companyId", "branchId", "status");

-- CreateIndex
CREATE INDEX "DiningVisit_tableId_status_idx" ON "DiningVisit"("tableId", "status");

-- CreateIndex
CREATE INDEX "DiningVisit_qrCodeId_idx" ON "DiningVisit"("qrCodeId");

-- CreateIndex
CREATE INDEX "DiningVisit_openedById_idx" ON "DiningVisit"("openedById");

-- CreateIndex
CREATE INDEX "DiningVisit_closedById_idx" ON "DiningVisit"("closedById");

-- CreateIndex
CREATE UNIQUE INDEX "DiningVisitGuest_tokenHash_key" ON "DiningVisitGuest"("tokenHash");

-- CreateIndex
CREATE INDEX "DiningVisitGuest_visitId_idx" ON "DiningVisitGuest"("visitId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningVisitGuest_visitId_seq_key" ON "DiningVisitGuest"("visitId", "seq");

-- CreateIndex
CREATE INDEX "QrSubmission_companyId_branchId_status_idx" ON "QrSubmission"("companyId", "branchId", "status");

-- CreateIndex
CREATE INDEX "QrSubmission_visitId_idx" ON "QrSubmission"("visitId");

-- CreateIndex
CREATE INDEX "QrSubmission_qrCodeId_idx" ON "QrSubmission"("qrCodeId");

-- CreateIndex
CREATE INDEX "QrSubmission_orderId_idx" ON "QrSubmission"("orderId");

-- CreateIndex
CREATE INDEX "QrSubmission_tableId_idx" ON "QrSubmission"("tableId");

-- CreateIndex
CREATE INDEX "QrSubmission_decidedById_idx" ON "QrSubmission"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "QrSubmission_companyId_idempotencyKey_key" ON "QrSubmission"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_id_branchId_key" ON "DiningTable"("id", "branchId");

-- CreateIndex
CREATE INDEX "Order_visitId_idx" ON "Order"("visitId");

-- CreateIndex
CREATE INDEX "Order_qrCodeId_idx" ON "Order"("qrCodeId");

-- CreateIndex
CREATE INDEX "OrderItem_addedByGuestId_idx" ON "OrderItem"("addedByGuestId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "DiningVisit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "TableQrCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_addedByGuestId_fkey" FOREIGN KEY ("addedByGuestId") REFERENCES "DiningVisitGuest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableQrCode" ADD CONSTRAINT "TableQrCode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableQrCode" ADD CONSTRAINT "TableQrCode_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableQrCode" ADD CONSTRAINT "TableQrCode_tableId_branchId_fkey" FOREIGN KEY ("tableId", "branchId") REFERENCES "DiningTable"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableQrCode" ADD CONSTRAINT "TableQrCode_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableQrCode" ADD CONSTRAINT "TableQrCode_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableQrCode" ADD CONSTRAINT "TableQrCode_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "TableQrCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisit" ADD CONSTRAINT "DiningVisit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisit" ADD CONSTRAINT "DiningVisit_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisit" ADD CONSTRAINT "DiningVisit_tableId_branchId_fkey" FOREIGN KEY ("tableId", "branchId") REFERENCES "DiningTable"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisit" ADD CONSTRAINT "DiningVisit_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "TableQrCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisit" ADD CONSTRAINT "DiningVisit_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisit" ADD CONSTRAINT "DiningVisit_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningVisitGuest" ADD CONSTRAINT "DiningVisitGuest_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "DiningVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_tableId_branchId_fkey" FOREIGN KEY ("tableId", "branchId") REFERENCES "DiningTable"("id", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "TableQrCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "DiningVisit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrSubmission" ADD CONSTRAINT "QrSubmission_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariants Prisma's datamodel cannot express. `migrate diff` does not track
-- CHECK constraints, so these stay put and the empty-diff gate stays green --
-- the same arrangement the foundation and discount-policy migrations already
-- rely on.

-- activeTableId and openTableId exist only to make "at most one live card per
-- table" and "at most one open visit per table" rules the DATABASE holds, using
-- a unique column that goes NULL when the row stops being live (Postgres treats
-- NULLs as distinct). That only works if the live value is the row's own table;
-- without this, a bug could park another table's id there and quietly take out
-- the wrong table's uniqueness.
ALTER TABLE "TableQrCode"
  ADD CONSTRAINT "TableQrCode_active_is_own_table"
  CHECK ("activeTableId" IS NULL OR "activeTableId" = "tableId");

ALTER TABLE "DiningVisit"
  ADD CONSTRAINT "DiningVisit_open_is_own_table"
  CHECK ("openTableId" IS NULL OR "openTableId" = "tableId");

-- A revoked card must say who revoked it and when; an ACTIVE one must still be
-- claiming its table. Otherwise "revoked" is a word in a column rather than a
-- state, and a card could read ACTIVE while holding no uniqueness at all.
ALTER TABLE "TableQrCode"
  ADD CONSTRAINT "TableQrCode_status_matches_lifecycle"
  CHECK (
    ("status" = 'ACTIVE'  AND "activeTableId" IS NOT NULL AND "revokedAt" IS NULL)
    OR
    ("status" = 'REVOKED' AND "activeTableId" IS NULL     AND "revokedAt" IS NOT NULL)
  );

ALTER TABLE "DiningVisit"
  ADD CONSTRAINT "DiningVisit_status_matches_lifecycle"
  CHECK (
    ("status" = 'OPEN'   AND "openTableId" IS NOT NULL AND "closedAt" IS NULL)
    OR
    ("status" = 'CLOSED' AND "openTableId" IS NULL     AND "closedAt" IS NOT NULL)
  );

-- Rotation starts at 1 and counts up; 0 or negative would break the "which card
-- is on the table" reading printed on the card itself.
ALTER TABLE "TableQrCode"
  ADD CONSTRAINT "TableQrCode_rotation_positive" CHECK ("rotation" >= 1);

ALTER TABLE "DiningVisit"
  ADD CONSTRAINT "DiningVisit_join_attempts_non_negative" CHECK ("joinAttempts" >= 0);

-- A QR order must carry the card it came in on, and only a QR order may. This is
-- what stops `source` drifting away from the evidence for it.
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_qr_needs_code"
  CHECK (("source" = 'QR') = ("qrCodeId" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Backfill. Order.source defaults to TILL, which is correct for every row that
-- predates the column except the phone orders, which have their own sidecar and
-- are therefore knowable rather than guessed. Nothing is backfilled to QR: no
-- QR order has ever existed, and inventing one would put a fact in the database
-- that never happened.
UPDATE "Order" o
SET "source" = 'PHONE'
FROM "PhoneOrder" p
WHERE p."orderId" = o."id" AND o."source" = 'TILL';
