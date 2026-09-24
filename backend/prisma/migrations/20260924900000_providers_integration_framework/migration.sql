-- LANE providers — third-party provider integration framework.
--
-- Additive only. Every new table is empty on arrival, and the one existing
-- table touched, "Order", gains three nullable-or-defaulted columns:
--
--   channel          NOT NULL DEFAULT 'POS'  — every order that already exists
--                    WAS rung up at a counter, so the default states a fact
--                    rather than guessing one. No backfill statement is needed
--                    and none is included; inventing a channel for historical
--                    orders would be the kind of retro-assertion B§5 p5 forbids.
--   channelProvider  NULL — only an aggregator order has one.
--   externalOrderId  NULL — likewise.
--
-- ROLLBACK: drop the tables created below, then
--   ALTER TABLE "Order" DROP COLUMN "channel", DROP COLUMN "channelProvider",
--                       DROP COLUMN "externalOrderId";
-- then drop the types created below, last, after the tables that use them.
-- Nothing pre-existing in the product reads these columns, so a rollback loses
-- integration configuration and provider event history and nothing else — no
-- bill, no payment, no stock movement.

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('SWIGGY', 'ZOMATO', 'REELO', 'TALLY');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrationJobStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "DiscrepancyState" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('POS', 'PHONE', 'AGGREGATOR', 'ONLINE', 'API');

-- CreateEnum
CREATE TYPE "AggregatorOrderState" AS ENUM ('RECEIVED', 'ACCEPTED', 'REJECTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoyaltyOpKind" AS ENUM ('BILL_SYNC', 'REDEEM', 'REVERSE');

-- CreateEnum
CREATE TYPE "LoyaltyOpStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ImportRunState" AS ENUM ('PREVIEW', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccountingDocType" AS ENUM ('SALES', 'CREDIT_NOTE', 'RECEIPT', 'PAYMENT', 'PURCHASE');

-- CreateEnum
CREATE TYPE "AccountingPostingStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'DEAD');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "channel" "OrderChannel" NOT NULL DEFAULT 'POS',
ADD COLUMN     "channelProvider" "IntegrationProvider",
ADD COLUMN     "externalOrderId" TEXT;

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "credentialCiphertext" TEXT,
    "credentialFingerprint" TEXT,
    "credentialUpdatedAt" TIMESTAMP(3),
    "config" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationOutlet" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "externalOutletId" TEXT NOT NULL,
    "externalOutletName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "menuSyncedAt" TIMESTAMP(3),
    "menuSyncHash" TEXT,
    "menuSyncStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationOutlet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "IntegrationEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "lastError" TEXT,
    "externalOrderId" TEXT,
    "providerSequence" INTEGER,
    "providerEventAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntegrationJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "externalRef" TEXT,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationDiscrepancy" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalRef" TEXT,
    "orderId" TEXT,
    "expectedAmount" DECIMAL(12,2),
    "observedAmount" DECIMAL(12,2),
    "detail" JSONB,
    "state" "DiscrepancyState" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "IntegrationDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "outletId" TEXT,
    "branchId" TEXT,
    "provider" "IntegrationProvider" NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "externalOrderDisplayId" TEXT,
    "orderId" TEXT,
    "state" "AggregatorOrderState" NOT NULL DEFAULT 'RECEIVED',
    "grossAmount" DECIMAL(12,2),
    "providerDiscountAmount" DECIMAL(12,2),
    "restaurantDiscountAmount" DECIMAL(12,2),
    "commissionAmount" DECIMAL(12,2),
    "taxAmount" DECIMAL(12,2),
    "deliveryFeeAmount" DECIMAL(12,2),
    "packagingFeeAmount" DECIMAL(12,2),
    "netPayoutAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "paymentMode" TEXT,
    "normalised" JSONB NOT NULL,
    "placedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "lastSequence" INTEGER,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyProfileLink" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "externalCustomerId" TEXT NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "lastKnownBalance" INTEGER,
    "balanceAsOf" TIMESTAMP(3),
    "membershipTier" TEXT,
    "pointsExpireAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "LoyaltyProfileLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyOperation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT,
    "kind" "LoyaltyOpKind" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "pointsDelta" INTEGER,
    "amount" DECIMAL(12,2),
    "status" "LoyaltyOpStatus" NOT NULL DEFAULT 'PENDING',
    "externalRef" TEXT,
    "reversesId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "LoyaltyOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyImportRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "state" "ImportRunState" NOT NULL DEFAULT 'PREVIEW',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "cursor" TEXT,
    "totalReported" INTEGER,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "matchedExisting" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "balanceSumPoints" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastError" TEXT,
    "startedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyImportException" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rowNumber" INTEGER,
    "externalCustomerId" TEXT,
    "phoneRaw" TEXT,
    "reason" TEXT NOT NULL,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyImportException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPosting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "branchId" TEXT,
    "docType" "AccountingDocType" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "voucherType" TEXT NOT NULL,
    "voucherNumber" TEXT,
    "voucherDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "externalMasterId" TEXT,
    "externalVoucherKey" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "status" "AccountingPostingStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingLedgerMap" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ledgerName" TEXT NOT NULL,
    "costCentre" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingLedgerMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_companyId_provider_key" ON "IntegrationConnection"("companyId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_id_companyId_key" ON "IntegrationConnection"("id", "companyId");

-- CreateIndex
CREATE INDEX "IntegrationOutlet_companyId_branchId_idx" ON "IntegrationOutlet"("companyId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOutlet_connectionId_externalOutletId_key" ON "IntegrationOutlet"("connectionId", "externalOutletId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOutlet_connectionId_branchId_key" ON "IntegrationOutlet"("connectionId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationOutlet_id_companyId_key" ON "IntegrationOutlet"("id", "companyId");

-- CreateIndex
CREATE INDEX "IntegrationEvent_companyId_status_receivedAt_idx" ON "IntegrationEvent"("companyId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "IntegrationEvent_connectionId_externalOrderId_idx" ON "IntegrationEvent"("connectionId", "externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationEvent_connectionId_externalEventId_key" ON "IntegrationEvent"("connectionId", "externalEventId");

-- CreateIndex
CREATE INDEX "IntegrationJob_companyId_status_nextAttemptAt_idx" ON "IntegrationJob"("companyId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "IntegrationJob_status_nextAttemptAt_idx" ON "IntegrationJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationJob_connectionId_dedupeKey_key" ON "IntegrationJob"("connectionId", "dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationDiscrepancy_companyId_state_detectedAt_idx" ON "IntegrationDiscrepancy"("companyId", "state", "detectedAt");

-- CreateIndex
CREATE INDEX "IntegrationDiscrepancy_connectionId_kind_idx" ON "IntegrationDiscrepancy"("connectionId", "kind");

-- CreateIndex
CREATE INDEX "IntegrationDiscrepancy_resolvedById_idx" ON "IntegrationDiscrepancy"("resolvedById");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorOrder_orderId_key" ON "AggregatorOrder"("orderId");

-- CreateIndex
CREATE INDEX "AggregatorOrder_companyId_state_idx" ON "AggregatorOrder"("companyId", "state");

-- CreateIndex
CREATE INDEX "AggregatorOrder_branchId_placedAt_idx" ON "AggregatorOrder"("branchId", "placedAt");

-- CreateIndex
CREATE INDEX "AggregatorOrder_outletId_idx" ON "AggregatorOrder"("outletId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorOrder_connectionId_externalOrderId_key" ON "AggregatorOrder"("connectionId", "externalOrderId");

-- CreateIndex
CREATE INDEX "LoyaltyProfileLink_connectionId_normalizedPhone_idx" ON "LoyaltyProfileLink"("connectionId", "normalizedPhone");

-- CreateIndex
CREATE INDEX "LoyaltyProfileLink_companyId_idx" ON "LoyaltyProfileLink"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyProfileLink_connectionId_externalCustomerId_key" ON "LoyaltyProfileLink"("connectionId", "externalCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyProfileLink_connectionId_customerId_key" ON "LoyaltyProfileLink"("connectionId", "customerId");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_companyId_status_idx" ON "LoyaltyOperation"("companyId", "status");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_customerId_idx" ON "LoyaltyOperation"("customerId");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_orderId_idx" ON "LoyaltyOperation"("orderId");

-- CreateIndex
CREATE INDEX "LoyaltyOperation_reversesId_idx" ON "LoyaltyOperation"("reversesId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyOperation_connectionId_idempotencyKey_key" ON "LoyaltyOperation"("connectionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LoyaltyImportRun_companyId_state_idx" ON "LoyaltyImportRun"("companyId", "state");

-- CreateIndex
CREATE INDEX "LoyaltyImportRun_startedById_idx" ON "LoyaltyImportRun"("startedById");

-- CreateIndex
CREATE INDEX "LoyaltyImportException_runId_at_idx" ON "LoyaltyImportException"("runId", "at");

-- CreateIndex
CREATE INDEX "AccountingPosting_companyId_status_idx" ON "AccountingPosting"("companyId", "status");

-- CreateIndex
CREATE INDEX "AccountingPosting_connectionId_voucherNumber_idx" ON "AccountingPosting"("connectionId", "voucherNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPosting_connectionId_sourceType_sourceId_docType_key" ON "AccountingPosting"("connectionId", "sourceType", "sourceId", "docType");

-- CreateIndex
CREATE INDEX "AccountingLedgerMap_companyId_idx" ON "AccountingLedgerMap"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingLedgerMap_connectionId_kind_key_key" ON "AccountingLedgerMap"("connectionId", "kind", "key");

-- CreateIndex
CREATE INDEX "Order_companyId_channel_billedAt_idx" ON "Order"("companyId", "channel", "billedAt");

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOutlet" ADD CONSTRAINT "IntegrationOutlet_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationOutlet" ADD CONSTRAINT "IntegrationOutlet_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationEvent" ADD CONSTRAINT "IntegrationEvent_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationJob" ADD CONSTRAINT "IntegrationJob_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDiscrepancy" ADD CONSTRAINT "IntegrationDiscrepancy_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDiscrepancy" ADD CONSTRAINT "IntegrationDiscrepancy_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorOrder" ADD CONSTRAINT "AggregatorOrder_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorOrder" ADD CONSTRAINT "AggregatorOrder_outletId_companyId_fkey" FOREIGN KEY ("outletId", "companyId") REFERENCES "IntegrationOutlet"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorOrder" ADD CONSTRAINT "AggregatorOrder_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorOrder" ADD CONSTRAINT "AggregatorOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyProfileLink" ADD CONSTRAINT "LoyaltyProfileLink_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyProfileLink" ADD CONSTRAINT "LoyaltyProfileLink_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "Customer"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "Customer"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOperation" ADD CONSTRAINT "LoyaltyOperation_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "LoyaltyOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyImportRun" ADD CONSTRAINT "LoyaltyImportRun_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyImportRun" ADD CONSTRAINT "LoyaltyImportRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyImportException" ADD CONSTRAINT "LoyaltyImportException_runId_fkey" FOREIGN KEY ("runId") REFERENCES "LoyaltyImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingPosting" ADD CONSTRAINT "AccountingPosting_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingLedgerMap" ADD CONSTRAINT "AccountingLedgerMap_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "IntegrationConnection"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

