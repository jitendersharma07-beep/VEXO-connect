-- Binds a card reader to the store that operates it.
--
-- Device.readerRef is the vendor's own id for one physical reader: the string a
-- terminal connector addresses the device by. Nullable and unconstrained
-- otherwise, because no vendor connector exists yet and the format is the
-- vendor's to define.
--
-- The unique index is per BRANCH, so two devices in one shop cannot claim the
-- same reader — which would make "which device is holding this customer's
-- card?" unanswerable, and that question is the entire reason the column is on
-- the device rather than in configuration. Postgres treats NULLs as distinct,
-- so every device that is not a reader keeps a null and none of them collide.

ALTER TABLE "Device" ADD COLUMN "readerRef" TEXT;

CREATE UNIQUE INDEX "Device_branchId_readerRef_key" ON "Device"("branchId", "readerRef");
