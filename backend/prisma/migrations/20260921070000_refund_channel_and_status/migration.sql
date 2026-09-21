-- Refunds gain a channel and a status (contract §13).
--
-- Until now every refund was a local row that flipped the order to REFUNDED
-- the moment it was written. That is correct for cash handed back across the
-- counter, and wrong for gateway-collected money: only the provider can return
-- it, so writing a row returns nothing to anybody. A gateway refund is now a
-- REQUEST that stays PENDING until a signature-verified webhook confirms the
-- provider actually paid it out.
--
-- Additive and forward-only. Every existing row defaults to MANUAL/SUCCEEDED,
-- which is true of all of them: no gateway refund has ever existed, and every
-- hand-recorded refund was completed when it was recorded.

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "channel" "PaymentChannel" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "intentId" TEXT,
ADD COLUMN     "providerRef" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "status" "RefundStatus" NOT NULL DEFAULT 'SUCCEEDED';

-- CreateIndex
-- Unique so a redelivered refund webhook lands on exactly one row. NULLs are
-- distinct in Postgres, so every manual refund coexists happily.
CREATE UNIQUE INDEX "Refund_providerRef_key" ON "Refund"("providerRef");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
