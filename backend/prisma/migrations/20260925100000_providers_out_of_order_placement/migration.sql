-- LANE providers: make a state change that overtakes its own placement survivable.
--
-- Before this, a cancellation arriving before the order it cancels was dropped,
-- and the placement that followed created an Order and a kitchen ticket for an
-- order the provider had already killed. The column below is how a row can say
-- "I am the record of a state, not of an order we have seen".
--
-- Nullable with no default, and back-filled to now() for every EXISTING row: every
-- row that exists today was created by a placement, so "the placement has been
-- received" is true of all of them. Doing it in that order means there is never an
-- instant where a real order looks like a shell.

ALTER TABLE "AggregatorOrder" ADD COLUMN "placementReceivedAt" TIMESTAMP(3);

UPDATE "AggregatorOrder" SET "placementReceivedAt" = "createdAt" WHERE "placementReceivedAt" IS NULL;

-- No index on this column on purpose. A partial index would be the right shape,
-- Prisma's schema language cannot express one, and a migration carrying DDL the
-- schema cannot describe shows up forever as drift in the migrate-diff gate. The
-- only query that filters on it is the daily reconciliation, which is already
-- bounded by companyId and connectionId.
