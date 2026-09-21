-- Payment gateway groundwork (contract §13). Additive and forward-only:
-- existing MANUAL payments are untouched, and no gateway row can exist until a
-- provider is configured.
--
-- Postgres allows ALTER TYPE ... ADD VALUE inside a transaction from 12
-- onwards provided the new value is not *used* in the same transaction. This
-- migration only adds it, so it is safe under Prisma's transactional apply.

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "PaymentChannel" ADD VALUE 'GATEWAY';

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_receivedById_fkey";

-- AlterTable
-- receivedById becomes nullable: a GATEWAY payment was settled by the provider
-- and no member of staff received anything. Widening only, so every existing
-- MANUAL row stays valid.
ALTER TABLE "Payment" ADD COLUMN     "intentId" TEXT,
ALTER COLUMN "receivedById" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "intentId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "skippedReason" TEXT,

    CONSTRAINT "GatewayWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_idempotencyKey_key" ON "PaymentIntent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentIntent_orderId_idx" ON "PaymentIntent"("orderId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_idx" ON "PaymentIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_provider_providerRef_key" ON "PaymentIntent"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "GatewayWebhookEvent_receivedAt_idx" ON "GatewayWebhookEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "GatewayWebhookEvent_processedAt_idx" ON "GatewayWebhookEvent"("processedAt");

-- CreateIndex
-- The idempotency guard. Only signature-VERIFIED deliveries are inserted here,
-- so a forged payload cannot squat an eventId and block the genuine event.
CREATE UNIQUE INDEX "GatewayWebhookEvent_provider_eventId_key" ON "GatewayWebhookEvent"("provider", "eventId");

-- CreateIndex
-- One intent settles at most once, however often the provider redelivers.
CREATE UNIQUE INDEX "Payment_intentId_key" ON "Payment"("intentId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
