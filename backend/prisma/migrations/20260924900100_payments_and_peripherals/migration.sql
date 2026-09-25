-- LANE payments — payment taxonomy, attempt records, per-tenant merchant
-- accounts, and the device command channel that drives a cash drawer.
--
-- Additive throughout. No column is dropped, no existing row changes meaning:
-- every payment written before today keeps the weakest honest claim
-- (entrySource = MANUAL_ENTRY) unless it carries independent evidence, and the
-- backfill below promotes only those.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "PaymentEntrySource" AS ENUM ('MANUAL_ENTRY', 'PROVIDER_CONFIRMED', 'TERMINAL_CONFIRMED', 'RECONCILED');
CREATE TYPE "PaymentFlow" AS ENUM ('CHECKOUT_LINK', 'TERMINAL', 'UPI_COLLECT');
CREATE TYPE "PaymentAccountMode" AS ENUM ('TEST', 'LIVE');
CREATE TYPE "DeviceCommandKind" AS ENUM ('DRAWER_OPEN');
CREATE TYPE "DeviceCommandStatus" AS ENUM ('QUEUED', 'DISPATCHED', 'CONFIRMED', 'FAILED', 'UNCERTAIN', 'EXPIRED');
CREATE TYPE "DeviceCommandCause" AS ENUM ('CASH_RECEIPT', 'CASH_REFUND', 'MANUAL');

-- Members added to the EXISTING enums live in 20260924900000_payments_enum_values,
-- one migration earlier, because the CHECK at the foot of this file names
-- PaymentChannel 'TERMINAL' and Postgres refuses to read an enum value inside
-- the transaction that created it.

-- ---------------------------------------------------------------------------
-- Payment: the dimensions `channel` alone used to conflate
-- ---------------------------------------------------------------------------

ALTER TABLE "Payment"
  ADD COLUMN "entrySource" "PaymentEntrySource" NOT NULL DEFAULT 'MANUAL_ENTRY',
  ADD COLUMN "provider"    TEXT,
  ADD COLUMN "accountId"   TEXT;

-- ---------------------------------------------------------------------------
-- PaymentIntent: a full attempt record
-- ---------------------------------------------------------------------------

ALTER TABLE "PaymentIntent"
  ADD COLUMN "companyId"         TEXT,
  ADD COLUMN "branchId"          TEXT,
  ADD COLUMN "terminalId"        TEXT,
  ADD COLUMN "deviceId"          TEXT,
  ADD COLUMN "flow"              "PaymentFlow" NOT NULL DEFAULT 'CHECKOUT_LINK',
  ADD COLUMN "accountId"         TEXT,
  ADD COLUMN "failureCode"       TEXT,
  ADD COLUMN "lastStatusCheckAt" TIMESTAMP(3),
  ADD COLUMN "statusCheckCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancelledAt"       TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- PrintTarget: the drawer profile
--
-- ESC/POS generalised pulse is `ESC p m t1 t2` — m selects the connector pin,
-- t1/t2 are on/off times in units of 2 ms (so 0-255 encodes 0-510 ms). Stored
-- as the pin number a technician reads off the cable and as milliseconds,
-- converted at the agent.
-- ---------------------------------------------------------------------------

ALTER TABLE "PrintTarget"
  ADD COLUMN "drawerPin"    INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "drawerOnMs"   INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "drawerOffMs"  INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "drawerSensor" BOOLEAN NOT NULL DEFAULT false;

-- Hardware safety, in the database rather than only in a request validator,
-- because a solenoid held energised is a coil that burns out and the code that
-- writes these values is not the only thing that will ever touch the table.
-- Pin 2 and pin 5 are the two drawer lines on the standard RJ11/RJ12 kick
-- connector; the off time is bounded by what the two-millisecond unit can
-- encode, and the on time well below it.
ALTER TABLE "PrintTarget"
  ADD CONSTRAINT "PrintTarget_drawer_profile" CHECK (
    "drawerPin" IN (2, 5)
    AND "drawerOnMs"  BETWEEN 10 AND 200
    AND "drawerOffMs" BETWEEN 10 AND 510
  );

-- ---------------------------------------------------------------------------
-- PaymentProviderAccount — one customer's merchant account with one provider
-- ---------------------------------------------------------------------------

CREATE TABLE "PaymentProviderAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" "PaymentAccountMode" NOT NULL DEFAULT 'TEST',
    "keyId" TEXT NOT NULL,
    "keySecretEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastVerifyNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderAccount_pkey" PRIMARY KEY ("id")
);

-- Ciphertext or nothing. The application encrypts with AES-256-GCM and writes
-- `v1:<iv>:<tag>:<ct>`; this refuses a plaintext secret pasted in by any other
-- route into the database, which is the failure this column exists to prevent.
ALTER TABLE "PaymentProviderAccount"
  ADD CONSTRAINT "PaymentProviderAccount_secrets_encrypted" CHECK (
    ("keySecretEnc" IS NULL OR "keySecretEnc" LIKE 'v1:%')
    AND ("webhookSecretEnc" IS NULL OR "webhookSecretEnc" LIKE 'v1:%')
  );

CREATE INDEX "PaymentProviderAccount_companyId_idx" ON "PaymentProviderAccount"("companyId");
CREATE INDEX "PaymentProviderAccount_branchId_idx" ON "PaymentProviderAccount"("branchId");

-- One account per provider per scope. NULL branchId is the company-wide row;
-- Postgres treats NULLs as distinct, so this unique index does NOT constrain
-- it — the partial index below does that half.
CREATE UNIQUE INDEX "PaymentProviderAccount_companyId_branchId_provider_key"
  ON "PaymentProviderAccount"("companyId", "branchId", "provider");
CREATE UNIQUE INDEX "PaymentProviderAccount_company_default_key"
  ON "PaymentProviderAccount"("companyId", "provider")
  WHERE "branchId" IS NULL;

-- ---------------------------------------------------------------------------
-- DeviceCommand — authenticated, expiring, auditable requests to store devices
-- ---------------------------------------------------------------------------

CREATE TABLE "DeviceCommand" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "terminalId" TEXT,
    "deviceId" TEXT,
    "kind" "DeviceCommandKind" NOT NULL,
    "status" "DeviceCommandStatus" NOT NULL DEFAULT 'QUEUED',
    "cause" "DeviceCommandCause" NOT NULL,
    "causeRefId" TEXT,
    "reason" TEXT,
    "drawerPin" INTEGER NOT NULL,
    "drawerOnMs" INTEGER NOT NULL,
    "drawerOffMs" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastReport" JSONB,
    "ackAt" TIMESTAMP(3),
    "sensorConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- Same hardware bounds as the profile it was frozen from.
ALTER TABLE "DeviceCommand"
  ADD CONSTRAINT "DeviceCommand_drawer_profile" CHECK (
    "drawerPin" IN (2, 5)
    AND "drawerOnMs"  BETWEEN 10 AND 200
    AND "drawerOffMs" BETWEEN 10 AND 510
  );

-- Every drawer-open carries its own justification: a committed cash row, or a
-- person's typed reason. Enforced here and not only in the route, because
-- "the drawer opened and nobody can say why" is the state this whole table
-- exists to make impossible.
ALTER TABLE "DeviceCommand"
  ADD CONSTRAINT "DeviceCommand_cause_evidence" CHECK (
    ("cause" = 'MANUAL' AND "reason" IS NOT NULL)
    OR ("cause" <> 'MANUAL' AND "causeRefId" IS NOT NULL)
  );

-- A sensor reading is a claim about physical hardware. It may only ever sit on
-- a command an agent actually acknowledged — never on a QUEUED one, and never
-- on one that failed.
ALTER TABLE "DeviceCommand"
  ADD CONSTRAINT "DeviceCommand_sensor_needs_ack" CHECK (
    "sensorConfirmed" = false OR "ackAt" IS NOT NULL
  );

CREATE INDEX "DeviceCommand_agentId_status_expiresAt_idx" ON "DeviceCommand"("agentId", "status", "expiresAt");
CREATE INDEX "DeviceCommand_companyId_createdAt_idx" ON "DeviceCommand"("companyId", "createdAt");
CREATE INDEX "DeviceCommand_branchId_createdAt_idx" ON "DeviceCommand"("branchId", "createdAt");
CREATE INDEX "DeviceCommand_causeRefId_idx" ON "DeviceCommand"("causeRefId");
CREATE UNIQUE INDEX "DeviceCommand_branchId_idempotencyKey_key" ON "DeviceCommand"("branchId", "idempotencyKey");

-- ---------------------------------------------------------------------------
-- Indexes and foreign keys on the extended tables
-- ---------------------------------------------------------------------------

CREATE INDEX "Payment_accountId_idx" ON "Payment"("accountId");
CREATE INDEX "PaymentIntent_companyId_status_idx" ON "PaymentIntent"("companyId", "status");
CREATE INDEX "PaymentIntent_accountId_idx" ON "PaymentIntent"("accountId");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PaymentProviderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PaymentProviderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentProviderAccount" ADD CONSTRAINT "PaymentProviderAccount_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentProviderAccount" ADD CONSTRAINT "PaymentProviderAccount_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "PrintAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_targetId_fkey"
  FOREIGN KEY ("targetId") REFERENCES "PrintTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- An attempt's tenant, taken from the order that asked for the money. These are
-- the columns a webhook — which carries no tenant of its own — is attributed
-- through, so leaving them null on historical rows would leave exactly the
-- attempts most likely to need reconciling unattributable.
UPDATE "PaymentIntent" i
   SET "companyId" = o."companyId",
       "branchId"  = o."branchId"
  FROM "Order" o
 WHERE o."id" = i."orderId"
   AND i."companyId" IS NULL;

-- A gateway payment carries its provider on the intent that opened it.
UPDATE "Payment" p
   SET "provider" = i."provider"
  FROM "PaymentIntent" i
 WHERE i."id" = p."intentId"
   AND p."provider" IS NULL;

-- Which of the two evidence paths wrote it. A RECOVERY event on the intent
-- means the provider's API was ASKED after the fact (the pull half); anything
-- else on channel GATEWAY arrived as a signature-verified webhook. Rows with
-- no intent at all stay MANUAL_ENTRY, which is what they are.
UPDATE "Payment" p
   SET "entrySource" = 'RECONCILED'
 WHERE p."channel" = 'GATEWAY'
   AND EXISTS (
     SELECT 1 FROM "GatewayWebhookEvent" e
      WHERE e."intentId" = p."intentId"
        AND e."source" = 'RECOVERY'
        AND e."processedAt" IS NOT NULL
   );

UPDATE "Payment"
   SET "entrySource" = 'PROVIDER_CONFIRMED'
 WHERE "channel" = 'GATEWAY'
   AND "entrySource" = 'MANUAL_ENTRY';

-- The pairing, asserted only after the backfill has made every existing row
-- satisfy it. A row may not say "settled by the provider" on one column and
-- "a cashier typed it" on another.
--
-- NOT VALID is deliberately NOT used: if any row fails this, the migration
-- must stop rather than leave an unenforced constraint and a database whose
-- payment evidence cannot be trusted.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_channel_entry_source" CHECK (
    ("channel" = 'MANUAL'   AND "entrySource" = 'MANUAL_ENTRY')
    OR ("channel" = 'GATEWAY'  AND "entrySource" IN ('PROVIDER_CONFIRMED', 'RECONCILED'))
    OR ("channel" = 'TERMINAL' AND "entrySource" = 'TERMINAL_CONFIRMED')
  );
