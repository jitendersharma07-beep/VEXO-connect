-- Records which code path wrote a GatewayWebhookEvent row.
--
-- Until now the only way to tell an event the provider delivered from one this
-- repository's own tooling posted was the shape of its eventId: our scripts
-- mint `evt_…` and `replay_…`, Razorpay's ids are bare alphanumeric. That is a
-- convention, not a fact about the row. The webhook secret lives on the same
-- box as the tooling, so a locally-signed delivery carrying a bare
-- alphanumeric id verifies and stores identically to a real one — and a
-- reading of the audit trail that leans on the prefix has already gone wrong
-- once in the other direction, promoting four `evt_probe_…` rows into
-- "provider deliveries".
--
-- A column cannot be talked into the wrong answer. It says which of our code
-- paths ran, which is the question the reconciliation report actually needs.
-- It still says nothing about who originated the event — for that the provider
-- has to be asked, which is what backend/scripts/sandbox-reconcile.mjs does.
CREATE TYPE "GatewayEventSource" AS ENUM ('WEBHOOK', 'RECOVERY');

-- Two steps on purpose. The DEFAULT exists only to fill the rows already
-- there, and every one of those did arrive at the webhook route, because that
-- was the sole writer of this table before this migration.
--
-- Dropping it immediately afterwards makes the column required from here on.
-- Leaving it in place would mean a future insert that forgot to set a source
-- would be silently recorded as WEBHOOK — labelling something we generated as
-- something the provider sent, which is the more dangerous of the two
-- mislabellings and precisely the confusion this column is being added to end.
ALTER TABLE "GatewayWebhookEvent"
    ADD COLUMN "source" "GatewayEventSource" NOT NULL DEFAULT 'WEBHOOK';

ALTER TABLE "GatewayWebhookEvent" ALTER COLUMN "source" DROP DEFAULT;

CREATE INDEX "GatewayWebhookEvent_source_idx" ON "GatewayWebhookEvent"("source");
