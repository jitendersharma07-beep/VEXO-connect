-- Foundation lane — proof that the tenancy constraints actually refuse.
--
-- Every cross-table rule finding 2 asks for is a composite FOREIGN KEY: not a
-- CHECK, which cannot see another table, and not a trigger, which under
-- concurrency is a race rather than a constraint. This file demonstrates each
-- one by attempting the invalid link and reporting whether the database
-- refused it — on UPDATE as well as on INSERT, because editing a store on an
-- admin screen is exactly how a bad link would get written in practice.
--
-- Cases marked 'accept' exist so a pass cannot be earned by refusing
-- everything.
--
-- Runs inside one transaction, rolls back, and every individual case rolls back
-- to its own savepoint whether it was accepted or refused — so no case can
-- affect the next and the database is left exactly as it was found.
--
-- Expects the rehearsal fixture's two tenants. DEV/LAB DATABASE ONLY.
--   docker exec -i <c> psql -v ON_ERROR_STOP=1 -U <u> -d <db> -f this.sql

BEGIN;

CREATE TEMP TABLE probe_case (
  ord    INT,
  expect TEXT,
  label  TEXT,
  sql    TEXT
);

-- Valid organisation data for both tenants, so the invalid links below are
-- invalid ONLY in the way each case is testing.
INSERT INTO "LegalEntity" (id, "companyId", "legalName", "updatedAt")
SELECT 'le_a',  id, 'Alpha Foods Pvt Ltd',    now() FROM "Company" WHERE slug = 'rehearsal-alpha'
UNION ALL
SELECT 'le_a2', id, 'Alpha Catering LLP',     now() FROM "Company" WHERE slug = 'rehearsal-alpha'
UNION ALL
SELECT 'le_b',  id, 'Bravo Kitchens Pvt Ltd', now() FROM "Company" WHERE slug = 'rehearsal-bravo';

INSERT INTO "GstRegistration" (id, "companyId", "legalEntityId", gstin, "stateCode", "stateName", "updatedAt")
SELECT 'gst_a',  id, 'le_a',  '07AAAAA0000A1Z5', '07', 'Delhi',     now() FROM "Company" WHERE slug = 'rehearsal-alpha'
UNION ALL
SELECT 'gst_a2', id, 'le_a2', '07BBBBB1111B1Z5', '07', 'Delhi',     now() FROM "Company" WHERE slug = 'rehearsal-alpha'
UNION ALL
SELECT 'gst_b',  id, 'le_b',  '29CCCCC2222C1Z5', '29', 'Karnataka', now() FROM "Company" WHERE slug = 'rehearsal-bravo';

INSERT INTO "Region" (id, "companyId", name, code, "updatedAt")
SELECT 'rg_a', id, 'North', 'N', now() FROM "Company" WHERE slug = 'rehearsal-alpha'
UNION ALL
SELECT 'rg_b', id, 'South', 'S', now() FROM "Company" WHERE slug = 'rehearsal-bravo';

INSERT INTO "Brand" (id, "companyId", name, code, "updatedAt")
SELECT 'bd_a', id, 'Alpha Cafe',    'ACAFE', now() FROM "Company" WHERE slug = 'rehearsal-alpha'
UNION ALL
SELECT 'bd_b', id, 'Bravo Biryani', 'BBIR',  now() FROM "Company" WHERE slug = 'rehearsal-bravo';

INSERT INTO "Terminal" (id, "companyId", "branchId", code, name, "updatedAt")
SELECT 'tm_a', "companyId", id, 'C1', 'Counter 1', now() FROM "Branch" WHERE code = 'AKB'
UNION ALL
SELECT 'tm_b', "companyId", id, 'C1', 'Counter 1', now() FROM "Branch" WHERE code = 'BIN';

INSERT INTO "Device" (id, "publicId", "companyId", "branchId", "terminalId", name, "updatedAt")
SELECT 'dv_a', 'VX-DVC-90000001', "companyId", id, 'tm_a', 'Alpha till PC', now() FROM "Branch" WHERE code = 'AKB'
UNION ALL
SELECT 'dv_b', 'VX-DVC-90000002', "companyId", id, 'tm_b', 'Bravo till PC', now() FROM "Branch" WHERE code = 'BIN';

-- --------------------------------------------------------------------------
-- Finding 2, case by case.
-- --------------------------------------------------------------------------
INSERT INTO probe_case VALUES

-- GST registration belongs to the selected company and legal entity
(1, 'refuse', 'store cannot trade as another tenant''s legal entity',
 $q$UPDATE "Branch" SET "legalEntityId" = 'le_b' WHERE code = 'AKB'$q$),

(2, 'refuse', 'store''s GSTIN must belong to the store''s own legal entity',
 $q$UPDATE "Branch" SET "legalEntityId" = 'le_a', "gstRegistrationId" = 'gst_a2' WHERE code = 'AKB'$q$),

(3, 'refuse', 'store cannot name a GSTIN with no legal entity to check it against',
 $q$UPDATE "Branch" SET "legalEntityId" = NULL, "gstRegistrationId" = 'gst_a' WHERE code = 'AKB'$q$),

(4, 'refuse', 'GST registration cannot sit under another tenant''s legal entity',
 $q$INSERT INTO "GstRegistration" (id, "companyId", "legalEntityId", gstin, "stateCode", "stateName", "updatedAt")
    SELECT 'gst_x', id, 'le_a', '29DDDDD3333D1Z5', '29', 'Karnataka', now()
    FROM "Company" WHERE slug = 'rehearsal-bravo'$q$),

-- Region parents and brand links within company
(5, 'refuse', 'region cannot nest inside another tenant''s region',
 $q$UPDATE "Region" SET "parentId" = 'rg_b' WHERE id = 'rg_a'$q$),

(6, 'refuse', 'store cannot be placed in another tenant''s region',
 $q$UPDATE "Branch" SET "regionId" = 'rg_b' WHERE code = 'AKB'$q$),

(7, 'refuse', 'store cannot be linked to another tenant''s brand',
 $q$INSERT INTO "BranchBrand" ("branchId", "companyId", "brandId")
    SELECT id, "companyId", 'bd_b' FROM "Branch" WHERE code = 'AKB'$q$),

-- Terminal belongs to the recorded company and branch
(8, 'refuse', 'terminal''s denormalised company must match its store',
 $q$INSERT INTO "Terminal" (id, "companyId", "branchId", code, name, "updatedAt")
    SELECT 'tm_x', (SELECT id FROM "Company" WHERE slug = 'rehearsal-alpha'), id, 'C9', 'Counter 9', now()
    FROM "Branch" WHERE code = 'BIN'$q$),

-- Device belongs to that company/branch and its selected terminal
(9, 'refuse', 'device cannot be enrolled onto a till in another store',
 $q$INSERT INTO "Device" (id, "publicId", "companyId", "branchId", "terminalId", name, "updatedAt")
    SELECT 'dv_x', 'VX-DVC-90000003', "companyId", id, 'tm_b', 'Wrong till', now()
    FROM "Branch" WHERE code = 'AKB'$q$),

(10, 'refuse', 'device cannot be MOVED onto a till in another store',
 $q$UPDATE "Device" SET "terminalId" = 'tm_b' WHERE id = 'dv_a'$q$),

(11, 'refuse', 'device''s denormalised company must match its store',
 $q$UPDATE "Device" SET "companyId" = (SELECT id FROM "Company" WHERE slug = 'rehearsal-bravo') WHERE id = 'dv_a'$q$),

-- Order and payment device attribution agrees with the transaction's store
(12, 'refuse', 'order cannot be attributed to a till in another store',
 $q$UPDATE "Order" SET "terminalId" = 'tm_b'
    WHERE id = (SELECT id FROM "Order" WHERE "branchId" = (SELECT id FROM "Branch" WHERE code = 'AKB') LIMIT 1)$q$),

(13, 'refuse', 'order cannot be attributed to a device in another store',
 $q$UPDATE "Order" SET "deviceId" = 'dv_b'
    WHERE id = (SELECT id FROM "Order" WHERE "branchId" = (SELECT id FROM "Branch" WHERE code = 'AKB') LIMIT 1)$q$),

(14, 'refuse', 'payment cannot be attributed to a till in another store',
 $q$UPDATE "Payment" SET "terminalId" = 'tm_b'
    WHERE id = (SELECT p.id FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
                WHERE o."branchId" = (SELECT id FROM "Branch" WHERE code = 'AKB') LIMIT 1)$q$),

(15, 'refuse', 'payment cannot be moved to a store other than the one that billed it',
 $q$UPDATE "Payment" SET "branchId" = (SELECT id FROM "Branch" WHERE code = 'BIN')
    WHERE id = (SELECT p.id FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
                WHERE o."branchId" = (SELECT id FROM "Branch" WHERE code = 'AKB') LIMIT 1)$q$),

-- Scope and permission rows stay inside one tenant
(16, 'refuse', 'assignment cannot give a user a store in another tenant',
 $q$INSERT INTO "UserStoreAssignment" (id, "userId", "companyId", "branchId")
    SELECT 'usa_x',
           (SELECT id FROM "PosUser" WHERE email LIKE '%@rehearsal-alpha.rehearsal' AND role = 'BRANCH_MANAGER' LIMIT 1),
           (SELECT id FROM "Company" WHERE slug = 'rehearsal-alpha'),
           (SELECT id FROM "Branch" WHERE code = 'BIN')$q$),

(17, 'refuse', 'assignment cannot name a user from another tenant',
 $q$INSERT INTO "UserStoreAssignment" (id, "userId", "companyId", "branchId")
    SELECT 'usa_y',
           (SELECT id FROM "PosUser" WHERE email LIKE '%@rehearsal-bravo.rehearsal' AND role = 'BRANCH_MANAGER' LIMIT 1),
           (SELECT id FROM "Company" WHERE slug = 'rehearsal-alpha'),
           (SELECT id FROM "Branch" WHERE code = 'AKB')$q$),

(18, 'refuse', 'permission rule cannot bind to another tenant''s store',
 $q$INSERT INTO "PermissionRule" (id, "companyId", level, "branchId", "scopeKey", action, effect, "updatedAt")
    SELECT 'pr_x', (SELECT id FROM "Company" WHERE slug = 'rehearsal-alpha'), 'BRANCH',
           (SELECT id FROM "Branch" WHERE code = 'BIN'), 'branch:x', 'order.refund', 'DENY', now()$q$),

(19, 'refuse', 'permission rule cannot name a subject from another tenant',
 $q$INSERT INTO "PermissionRule" (id, "companyId", level, "userId", "scopeKey", action, effect, "updatedAt")
    SELECT 'pr_y', (SELECT id FROM "Company" WHERE slug = 'rehearsal-alpha'), 'USER',
           (SELECT id FROM "PosUser" WHERE email LIKE '%@rehearsal-bravo.rehearsal' LIMIT 1),
           'user:x', 'order.refund', 'DENY', now()$q$),

-- Valid links are still accepted. Without these the suite could pass by
-- refusing everything, which would be a different bug wearing the same result.
(20, 'accept', 'store CAN trade as its own tenant''s entity with that entity''s GSTIN',
 $q$UPDATE "Branch" SET "legalEntityId" = 'le_a', "gstRegistrationId" = 'gst_a' WHERE code = 'AKB'$q$),

(21, 'accept', 'terminal CAN be created at a store in its own tenant',
 $q$INSERT INTO "Terminal" (id, "companyId", "branchId", code, name, "updatedAt")
    SELECT 'tm_ok', "companyId", id, 'C2', 'Counter 2', now() FROM "Branch" WHERE code = 'AKB'$q$),

(22, 'accept', 'assignment CAN give a user a second store in their own tenant',
 $q$INSERT INTO "UserStoreAssignment" (id, "userId", "companyId", "branchId")
    SELECT 'usa_ok',
           (SELECT id FROM "PosUser" WHERE email LIKE '%@rehearsal-alpha.rehearsal' AND role = 'BRANCH_MANAGER' LIMIT 1),
           (SELECT id FROM "Company" WHERE slug = 'rehearsal-alpha'),
           (SELECT id FROM "Branch" WHERE code = 'AN18')$q$),

(23, 'accept', 'order CAN be attributed to a till in its own store',
 $q$UPDATE "Order" SET "terminalId" = 'tm_a'
    WHERE id = (SELECT id FROM "Order" WHERE "branchId" = (SELECT id FROM "Branch" WHERE code = 'AKB') LIMIT 1)$q$);

DO $probe$
DECLARE
  c         RECORD;
  accepted  BOOLEAN;
  failures  INT := 0;
  total     INT;
BEGIN
  SELECT count(*) INTO total FROM probe_case;
  FOR c IN SELECT * FROM probe_case ORDER BY ord LOOP
    BEGIN
      EXECUTE c.sql;
      -- Raised deliberately so an ACCEPTED case rolls back to this block's
      -- savepoint exactly as a refused one does. Nothing a case writes can
      -- reach the next case.
      RAISE EXCEPTION 'PROBE_ACCEPTED';
    EXCEPTION
      WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
        accepted := FALSE;
      WHEN raise_exception THEN
        IF SQLERRM <> 'PROBE_ACCEPTED' THEN RAISE; END IF;
        accepted := TRUE;
    END;

    IF (c.expect = 'refuse') = accepted THEN
      failures := failures + 1;
      RAISE WARNING 'FAIL  %: expected the database to % — %', c.ord, c.expect, c.label;
    ELSE
      RAISE NOTICE 'pass  %: %', c.ord, c.label;
    END IF;
  END LOOP;

  IF failures > 0 THEN
    RAISE EXCEPTION 'tenancy probe: % of % case(s) FAILED', failures, total;
  END IF;
  RAISE NOTICE 'tenancy probe: all % case(s) behaved as specified', total;
END
$probe$;

ROLLBACK;
