-- Slot capacity counting (VC-104). Additive only: two indexes, no column, no
-- data change, no backfill. Rolling back is a DROP INDEX.
--
-- Why: countBookedInSlot counts one 15-minute window of a store's orders. The
-- existing (companyId, routedBranchId, status) index stops before any time
-- column, so the window had to be found by fetching every order the store has
-- ever accepted — and that set only grows, because PhoneOrderStatus has no
-- terminal state. Measured at 120k orders, counting one slot:
--
--     none                                        17.0 ms
--     + the PhoneOrder index below                 6.4 ms
--     + the PhoneOrderEvent index below            4.0 ms
--     (the event index ALONE is worth little:     14.6 ms)
--
-- DEPLOYMENT NOTE, for whoever runs this against a live database:
-- plain CREATE INDEX takes a SHARE lock, which blocks INSERT/UPDATE/DELETE on
-- the table until it completes. Reads are unaffected. On a small PhoneOrder
-- table that is milliseconds; on a large one it is a write pause on the phone
-- ordering path. CREATE INDEX CONCURRENTLY avoids the pause but cannot run
-- inside a transaction, and Prisma wraps each migration in one — so if the
-- table is large, run the two statements by hand with CONCURRENTLY and mark
-- this migration applied, rather than letting it block the tills.

-- CreateIndex
CREATE INDEX "PhoneOrder_companyId_routedBranchId_status_createdAt_idx" ON "PhoneOrder"("companyId", "routedBranchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PhoneOrderEvent_toBranchId_action_at_idx" ON "PhoneOrderEvent"("toBranchId", "action", "at");
