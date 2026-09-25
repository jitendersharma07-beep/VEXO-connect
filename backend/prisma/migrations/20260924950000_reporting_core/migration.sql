-- LANE reporting: reporting policy, approved recipients, delivery ledger, exceptions.
-- Deliberately stores no computed figure. Every number in a report is derived at
-- read time from orders/payments/stock; only policy, approvals, delivery outcomes
-- and human acknowledgements live here because they cannot be recomputed.

-- CreateEnum
CREATE TYPE "ReportCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'XLSX', 'PDF');

-- CreateEnum
CREATE TYPE "ReportScheduleState" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ReportDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReportingExceptionKind" AS ENUM ('LOW_STOCK', 'NEAR_EXPIRY', 'OVERDUE_REQUEST', 'CASH_DIFFERENCE', 'UNUSUAL_REFUND', 'UNUSUAL_DISCOUNT', 'DELAYED_KITCHEN_ORDER', 'STALE_BRANCH_DATA', 'UNCLOSED_SHIFT', 'SETTLEMENT_MISMATCH');

-- CreateEnum
CREATE TYPE "ReportingExceptionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReportingExceptionSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "ReportingSetting" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "businessDayCutoffMinutes" INTEGER NOT NULL DEFAULT 0,
    "weekStartDay" INTEGER NOT NULL DEFAULT 1,
    "financialYearStartMonth" INTEGER NOT NULL DEFAULT 4,
    "staleAfterMinutes" INTEGER NOT NULL DEFAULT 180,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ReportingSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRecipient" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "isTestAddress" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ReportRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "cadence" "ReportCadence" NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'CSV',
    "sendAtMinutes" INTEGER NOT NULL DEFAULT 360,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "weekday" INTEGER,
    "dayOfMonth" INTEGER,
    "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" "ReportScheduleState" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportScheduleRecipient" (
    "scheduleId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,

    CONSTRAINT "ReportScheduleRecipient_pkey" PRIMARY KEY ("scheduleId","recipientId")
);

-- CreateTable
CREATE TABLE "ReportDelivery" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "periodFrom" TEXT NOT NULL,
    "periodTo" TEXT NOT NULL,
    "status" "ReportDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rowCount" INTEGER,
    "bytes" INTEGER,
    "lastError" TEXT,
    "firstAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportingException" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "kind" "ReportingExceptionKind" NOT NULL,
    "severity" "ReportingExceptionSeverity" NOT NULL DEFAULT 'WARNING',
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "responsibleRole" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "status" "ReportingExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "ReportingException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportingSetting_companyId_key" ON "ReportingSetting"("companyId");

-- CreateIndex
CREATE INDEX "ReportRecipient_companyId_idx" ON "ReportRecipient"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportRecipient_companyId_email_key" ON "ReportRecipient"("companyId", "email");

-- CreateIndex
CREATE INDEX "ReportSchedule_companyId_state_idx" ON "ReportSchedule"("companyId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSchedule_companyId_name_key" ON "ReportSchedule"("companyId", "name");

-- CreateIndex
CREATE INDEX "ReportScheduleRecipient_recipientId_idx" ON "ReportScheduleRecipient"("recipientId");

-- CreateIndex
CREATE INDEX "ReportDelivery_scheduleId_status_idx" ON "ReportDelivery"("scheduleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDelivery_scheduleId_runKey_key" ON "ReportDelivery"("scheduleId", "runKey");

-- CreateIndex
CREATE INDEX "ReportingException_companyId_status_severity_idx" ON "ReportingException"("companyId", "status", "severity");

-- CreateIndex
CREATE INDEX "ReportingException_branchId_status_idx" ON "ReportingException"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReportingException_companyId_dedupeKey_key" ON "ReportingException"("companyId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "ReportingSetting" ADD CONSTRAINT "ReportingSetting_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportRecipient" ADD CONSTRAINT "ReportRecipient_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportScheduleRecipient" ADD CONSTRAINT "ReportScheduleRecipient_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportScheduleRecipient" ADD CONSTRAINT "ReportScheduleRecipient_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "ReportRecipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingException" ADD CONSTRAINT "ReportingException_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
