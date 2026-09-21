-- Refunds carry the idempotency key they were requested with (contract §13).
--
-- A refund request crosses a network. When the provider does not answer, the
-- outcome is UNKNOWN, not failed: it may already be paying the customer back.
-- The previous shape generated a key per call and kept none of it, so the only
-- possible retry was a brand-new request — a second refund, and a second
-- payout. Keeping the key makes a retry re-send THE SAME request, which the
-- provider deduplicates.
--
-- The unknown state is representable without another column: a GATEWAY refund
-- that is PENDING with a NULL providerRef was reserved here but never
-- confirmed by the provider. It keeps holding its amount so the money cannot
-- be requested back twice, and the reconciliation report surfaces it.
--
-- NULL for MANUAL rows: there is no provider to deduplicate against, and
-- Postgres treats NULLs as distinct, so they coexist under the unique index.
--
-- Backfill evidence, measured 2026-09-21 rather than assumed. The companion
-- migration 20260921070000 defaults every pre-existing refund to
-- MANUAL/SUCCEEDED; that default is only honest if no gateway refund ever
-- existed, so both target databases were counted before it was trusted:
--
--   prod  (pos-prod-postgres-1, atc_pos): "Refund" 0 rows, "Payment" 0 rows,
--         and no "PaymentIntent" table at all — prod is still on
--         20260920180000_pos_phase2_orders, so no gateway row of any kind can
--         exist there. The default is vacuous, not merely safe.
--   dev   (atc-pos-dev-db, atc_pos): "Refund" 3 rows, every one on an order
--         whose only payment is channel=MANUAL, method=CASH, intentId NULL;
--         "PaymentIntent" 0 rows, "GatewayWebhookEvent" 0 rows.
--   test  (atc_pos_test): "Refund" 0 rows.
--
-- So MANUAL/SUCCEEDED is the true channel of every existing row, on evidence.

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");
