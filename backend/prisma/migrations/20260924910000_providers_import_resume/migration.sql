-- LANE providers — resumable loyalty import: record which file a run is reading.
--
-- Additive and nullable. Runs that already exist carry NULL, which is read as
-- "this run cannot be resumed" rather than "any file will do" — the safe
-- direction, because the whole purpose of the column is to refuse a resume that
-- would step over row 64,000 of a DIFFERENT export and import the wrong people.

ALTER TABLE "LoyaltyImportRun" ADD COLUMN "sourceFingerprint" TEXT;
