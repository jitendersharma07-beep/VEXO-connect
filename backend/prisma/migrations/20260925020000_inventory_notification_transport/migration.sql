-- Notification delivery gains a provider reference and a terminal state.
--
-- Both columns belong to InventoryNotification, which 20260924400000_inventory_core
-- created in this same lane. Nothing outside inventory reads either one.

-- The transport's own id for the message, so a delivery can be checked against
-- the provider rather than only asserted from our row. Nullable: in-app has no
-- provider, and every row written before this migration has no reference to
-- backfill from. A NULL here means "no provider id", which for the in-app rows
-- that exist today is the accurate answer rather than a gap.
ALTER TABLE "InventoryNotification" ADD COLUMN "providerRef" TEXT;

-- FAILED means "did not arrive, will try again"; UNDELIVERABLE means "did not
-- arrive, and trying again cannot help". The scheduler stops on the second and
-- not the first.
--
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction block
-- provided the new value is not USED in that same transaction. This statement
-- only adds it; the first row to carry it is written by application code long
-- after this migration commits. Server checked at 16.15.
ALTER TYPE "InventoryNotificationState" ADD VALUE 'UNDELIVERABLE';
