-- LANE foundation — Expansion Phase 1, spec Part B §5.
--
-- The nine roles the spec names that the Core four could not express. APPENDED,
-- never reordered: a Postgres enum value carries an ordinal, and the four
-- existing values are already written into live PosUser rows.
--
-- BRANCH_MANAGER is the spec's "Store Manager" and deliberately keeps its old
-- name. Renaming it would rewrite every row that holds it, for a label that only
-- ever appears in the UI — src/lib/permissions.js maps the two.
--
-- This migration is ON ITS OWN, and contains nothing but these statements. A
-- value added by ALTER TYPE cannot be USED by any statement in the same
-- transaction, and Prisma runs each migration file in one transaction, so any
-- later migration that seeds or references these roles would fail if they were
-- added alongside it.

-- AlterEnum
ALTER TYPE "PosRole" ADD VALUE 'COMPANY_ADMIN';
ALTER TYPE "PosRole" ADD VALUE 'FINANCE';
ALTER TYPE "PosRole" ADD VALUE 'REGIONAL_MANAGER';
ALTER TYPE "PosRole" ADD VALUE 'CAPTAIN';
ALTER TYPE "PosRole" ADD VALUE 'KITCHEN';
ALTER TYPE "PosRole" ADD VALUE 'INVENTORY';
ALTER TYPE "PosRole" ADD VALUE 'PURCHASE';
ALTER TYPE "PosRole" ADD VALUE 'DELIVERY';
ALTER TYPE "PosRole" ADD VALUE 'AUDITOR';
