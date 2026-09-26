-- VC-103: kitchen (stations, routing, item states, change cursor) and Store
-- Agent printing (agents, targets, jobs). Written alongside the schema change
-- (standing rule: schema + migration together).

-- CreateEnum
CREATE TYPE "KitchenItemState" AS ENUM ('QUEUED', 'IN_PREP', 'READY', 'SERVED', 'CANCELLED');
CREATE TYPE "PrintAgentStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');
CREATE TYPE "PrintTransport" AS ENUM ('TCP', 'FILE');
CREATE TYPE "PrintPurpose" AS ENUM ('KOT', 'RECEIPT');
CREATE TYPE "PrintJobKind" AS ENUM ('KOT', 'RECEIPT', 'TEST');
CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'DISPATCHED', 'CONFIRMED', 'FAILED', 'UNCERTAIN');
CREATE TYPE "PrintJobResolution" AS ENUM ('REPRINTED', 'CONFIRMED_BY_STAFF', 'DISMISSED');

-- CreateTable
CREATE TABLE "KitchenStation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetPrepSeconds" INTEGER NOT NULL DEFAULT 600,
    "defaultForBranch" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenStation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KitchenRoute" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenRoute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KitchenItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kotId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "state" "KitchenItemState" NOT NULL DEFAULT 'QUEUED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "changeSeq" INTEGER NOT NULL,
    "targetSeconds" INTEGER NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "delayReason" TEXT,
    "delayedAt" TIMESTAMP(3),
    "lastActorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KitchenCursor" (
    "branchId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenCursor_pkey" PRIMARY KEY ("branchId")
);

CREATE TABLE "PrintAgent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PrintAgentStatus" NOT NULL DEFAULT 'PENDING',
    "enrolCodeHash" TEXT,
    "enrolCodeExpiresAt" TIMESTAMP(3),
    "credentialHash" TEXT,
    "enrolledAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "platform" TEXT,
    "agentVersion" TEXT,
    "hostname" TEXT,
    "health" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintAgent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrintTarget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "PrintPurpose" NOT NULL,
    "stationId" TEXT,
    "transport" "PrintTransport" NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "widthChars" INTEGER NOT NULL DEFAULT 48,
    "cut" BOOLEAN NOT NULL DEFAULT true,
    "drawerKick" BOOLEAN NOT NULL DEFAULT false,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintTarget_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" "PrintJobKind" NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimToken" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastReport" JSONB,
    "sourceKotId" TEXT,
    "sourceOrderId" TEXT,
    "reprintOfId" TEXT,
    "reason" TEXT,
    "resolution" "PrintJobResolution",
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KitchenStation_defaultForBranch_key" ON "KitchenStation"("defaultForBranch");
CREATE UNIQUE INDEX "KitchenStation_branchId_name_key" ON "KitchenStation"("branchId", "name");
CREATE INDEX "KitchenStation_companyId_branchId_idx" ON "KitchenStation"("companyId", "branchId");
CREATE UNIQUE INDEX "KitchenRoute_branchId_matchKey_key" ON "KitchenRoute"("branchId", "matchKey");
CREATE INDEX "KitchenRoute_stationId_idx" ON "KitchenRoute"("stationId");
CREATE UNIQUE INDEX "KitchenItem_orderItemId_key" ON "KitchenItem"("orderItemId");
CREATE INDEX "KitchenItem_branchId_changeSeq_idx" ON "KitchenItem"("branchId", "changeSeq");
CREATE INDEX "KitchenItem_branchId_state_idx" ON "KitchenItem"("branchId", "state");
CREATE INDEX "KitchenItem_stationId_state_idx" ON "KitchenItem"("stationId", "state");
CREATE INDEX "KitchenItem_orderId_idx" ON "KitchenItem"("orderId");
CREATE INDEX "KitchenItem_kotId_idx" ON "KitchenItem"("kotId");
CREATE UNIQUE INDEX "PrintAgent_enrolCodeHash_key" ON "PrintAgent"("enrolCodeHash");
CREATE UNIQUE INDEX "PrintAgent_credentialHash_key" ON "PrintAgent"("credentialHash");
CREATE UNIQUE INDEX "PrintAgent_branchId_name_key" ON "PrintAgent"("branchId", "name");
CREATE INDEX "PrintAgent_companyId_branchId_idx" ON "PrintAgent"("companyId", "branchId");
CREATE UNIQUE INDEX "PrintTarget_branchId_name_key" ON "PrintTarget"("branchId", "name");
CREATE INDEX "PrintTarget_agentId_idx" ON "PrintTarget"("agentId");
CREATE UNIQUE INDEX "PrintJob_reprintOfId_key" ON "PrintJob"("reprintOfId");
CREATE UNIQUE INDEX "PrintJob_branchId_idempotencyKey_key" ON "PrintJob"("branchId", "idempotencyKey");
CREATE INDEX "PrintJob_agentId_status_nextAttemptAt_idx" ON "PrintJob"("agentId", "status", "nextAttemptAt");
CREATE INDEX "PrintJob_branchId_createdAt_idx" ON "PrintJob"("branchId", "createdAt");
CREATE INDEX "PrintJob_sourceKotId_idx" ON "PrintJob"("sourceKotId");

-- AddForeignKey
ALTER TABLE "KitchenStation" ADD CONSTRAINT "KitchenStation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KitchenRoute" ADD CONSTRAINT "KitchenRoute_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KitchenItem" ADD CONSTRAINT "KitchenItem_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "Kot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KitchenItem" ADD CONSTRAINT "KitchenItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KitchenItem" ADD CONSTRAINT "KitchenItem_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintTarget" ADD CONSTRAINT "PrintTarget_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "PrintAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintTarget" ADD CONSTRAINT "PrintTarget_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "PrintAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "PrintTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_reprintOfId_fkey" FOREIGN KEY ("reprintOfId") REFERENCES "PrintJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
