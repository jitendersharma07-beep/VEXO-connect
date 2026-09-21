-- The provider's id for the charge itself, which is not its id for the attempt.
-- Razorpay refunds post to /payments/<pay_id>/refund while PaymentIntent
-- .providerRef holds the order_… we opened, so a gateway payment could not be
-- refunded at all without somewhere to keep this.
--
-- Nullable because every existing row is either MANUAL money or a payment
-- settled before this column existed; unique because one charge settles once,
-- which makes this a second, database-level guard against a redelivered
-- webhook creating a duplicate payment.
ALTER TABLE "Payment" ADD COLUMN "providerRef" TEXT;

CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");
