-- LANE reporting — say what carried a delivery, and who it deliberately did not reach.
--
-- A second migration rather than an edit to 20260924950000_reporting_core, which
-- has already been applied: rewriting an applied migration leaves every database
-- that ran the old one silently different from the one a fresh clone builds.
--
-- All three columns are additive with defaults, so this applies to a populated
-- database without touching a row's meaning. Existing rows read transport 'FILE'
-- and no withheld addresses, which is exactly what they were.

ALTER TABLE "ReportDelivery"
  ADD COLUMN "withheld" TEXT[] DEFAULT ARRAY[]::TEXT[],
  -- Not nullable and not free text by accident: every delivery was carried by
  -- something, and a row that cannot say what carried it is a row that invites
  -- "SENT" to be read as "emailed".
  ADD COLUMN "transport" TEXT NOT NULL DEFAULT 'FILE',
  ADD COLUMN "artifactPath" TEXT;
