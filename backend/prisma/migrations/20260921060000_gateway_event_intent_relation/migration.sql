-- GatewayWebhookEvent.intentId already exists as a plain column. Promoting it
-- to a real foreign key is what lets reconciliation filter events by tenant:
-- an event carries no company of its own, so it can only be attributed through
-- its intent's order, and Prisma will not traverse a relation that is not
-- declared.
--
-- ON DELETE SET NULL, not RESTRICT: losing the link turns the event into an
-- unattributable one, which reconciliation already handles and shows to ATC
-- only. Blocking the intent delete instead would gain nothing.

-- AddForeignKey
ALTER TABLE "GatewayWebhookEvent" ADD CONSTRAINT "GatewayWebhookEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
