-- LANE foundation — Expansion Phase 1: organisation, identity, terminals,
-- devices and the permission/scope layer. Spec Part A §7, Part B §3/§5/§11.
--
-- Nothing here renames an existing table or column. `Branch` stays `Branch` and
-- every `branchId` stays `branchId`, however the screens spell it. The only
-- destructive-looking statement in the file is `SET NOT NULL` on a column this
-- same file created and filled.
--
-- Upgrade-safe on a populated database. The one column that cannot simply be
-- added NOT NULL — Branch."publicId" — is added nullable, backfilled from the
-- store's own state, then constrained, in that order, further down.

-- CreateEnum
CREATE TYPE "TerminalStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('COUNTER', 'KDS', 'CUSTOMER_DISPLAY', 'HANDHELD', 'OTHER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "PermissionLevel" AS ENUM ('COMPANY', 'BRANCH', 'USER');

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "pan" TEXT,
    "cin" TEXT,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GstRegistration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "tradeName" TEXT,
    "stateCode" TEXT NOT NULL,
    "stateName" TEXT NOT NULL,
    "addressLine" TEXT,
    "city" TEXT,
    "pincode" TEXT,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GstRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformCounter" (
    "key" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlatformCounter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchBrand" (
    "branchId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchBrand_pkey" PRIMARY KEY ("branchId","brandId")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentId" TEXT,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TerminalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "terminalId" TEXT,
    "name" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL DEFAULT 'COUNTER',
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "enrolledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "level" "PermissionLevel" NOT NULL,
    "branchId" TEXT,
    "userId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStoreAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "UserStoreAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- publicId is added NULLABLE here on purpose. Every statement below it exists to
-- earn the NOT NULL at the end: an existing tenant already has stores, and a
-- column added NOT NULL with a made-up default would hand two different stores
-- the same permanent id.
ALTER TABLE "Branch" ADD COLUMN     "publicId" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "legalEntityId" TEXT,
ADD COLUMN     "gstRegistrationId" TEXT,
ADD COLUMN     "regionId" TEXT,
ADD COLUMN     "invoicePrefix" TEXT,
ADD COLUMN     "fssaiLicenseNo" TEXT,
ADD COLUMN     "fssaiValidUpto" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PosUser" ADD COLUMN     "regionId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "billingSnapshot" JSONB,
ADD COLUMN     "terminalId" TEXT,
ADD COLUMN     "deviceId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "terminalId" TEXT,
ADD COLUMN     "deviceId" TEXT;

-- AlterTable
ALTER TABLE "PosAuditLog" ADD COLUMN     "terminalId" TEXT,
ADD COLUMN     "deviceId" TEXT;

-- ---------------------------------------------------------------------------
-- Backfill: the VEXO Store ID for stores that already exist.
--
-- The series letters are a mnemonic frozen at creation, so they are derived from
-- the only locality fact an existing store has — its free-text `state` — and
-- never from anything editable afterwards. The mapping below is the SQL twin of
-- NAME_SERIES in src/lib/identity.js and must stay in step with it: if the two
-- disagree, a store created after the upgrade lands in a different series from
-- an identical store created before it.
--
-- 'XX' is the honest fallback for a blank or unrecognised state. It is not an
-- error — a store still deserves a permanent id, and guessing a state would
-- write a wrong fact into a column that can never be corrected.
--
-- Numbering is ROW_NUMBER per series ordered by createdAt then id: deterministic,
-- so a rehearsal and the real upgrade produce byte-identical ids, and stable
-- against ties because `id` breaks them.
-- ---------------------------------------------------------------------------
WITH mapped AS (
    SELECT b."id",
           b."createdAt",
           COALESCE(m."series", 'XX') AS "series"
    FROM "Branch" b
    LEFT JOIN (VALUES
        ('jammu and kashmir', 'JK'),
        ('jammu & kashmir', 'JK'),
        ('himachal pradesh', 'HP'),
        ('punjab', 'PB'),
        ('chandigarh', 'CH'),
        ('uttarakhand', 'UK'),
        ('uttaranchal', 'UK'),
        ('haryana', 'HR'),
        ('delhi', 'DL'),
        ('new delhi', 'DL'),
        ('nct of delhi', 'DL'),
        ('delhi ncr', 'DL'),
        ('rajasthan', 'RJ'),
        ('uttar pradesh', 'UP'),
        ('bihar', 'BR'),
        ('sikkim', 'SK'),
        ('arunachal pradesh', 'AR'),
        ('nagaland', 'NL'),
        ('manipur', 'MN'),
        ('mizoram', 'MZ'),
        ('tripura', 'TR'),
        ('meghalaya', 'ML'),
        ('assam', 'AS'),
        ('west bengal', 'WB'),
        ('jharkhand', 'JH'),
        ('odisha', 'OD'),
        ('orissa', 'OD'),
        ('chhattisgarh', 'CG'),
        ('madhya pradesh', 'MP'),
        ('gujarat', 'GJ'),
        ('daman and diu', 'DD'),
        ('daman & diu', 'DD'),
        ('dadra and nagar haveli and daman and diu', 'DN'),
        ('dadra and nagar haveli', 'DN'),
        ('dadra & nagar haveli', 'DN'),
        ('maharashtra', 'MH'),
        ('andhra pradesh (pre-2014)', 'AD'),
        ('karnataka', 'KA'),
        ('goa', 'GA'),
        ('lakshadweep', 'LD'),
        ('kerala', 'KL'),
        ('tamil nadu', 'TN'),
        ('puducherry', 'PY'),
        ('pondicherry', 'PY'),
        ('andaman and nicobar islands', 'AN'),
        ('andaman & nicobar islands', 'AN'),
        ('telangana', 'TS'),
        ('andhra pradesh', 'AP'),
        ('ladakh', 'LA'),
        ('other territory', 'OT')
    ) AS m("name", "series") ON m."name" = lower(btrim(b."state"))
), numbered AS (
    SELECT "id",
           "series",
           ROW_NUMBER() OVER (PARTITION BY "series" ORDER BY "createdAt", "id") AS "seq"
    FROM mapped
)
UPDATE "Branch" b
SET "publicId" = 'VC-' || num."series" || '-' || lpad(num."seq"::text, 4, '0')
FROM numbered num
WHERE b."id" = num."id";

-- The counter has to start above whatever the backfill just used, or the next
-- store created would be handed an id that already exists. GREATEST on conflict
-- so re-running this against a partially-migrated database can only raise the
-- high-water mark, never lower it.
INSERT INTO "PlatformCounter" ("key", "lastNumber")
SELECT 'store:' || split_part("publicId", '-', 2),
       MAX(CAST(split_part("publicId", '-', 3) AS INTEGER))
FROM "Branch"
WHERE "publicId" IS NOT NULL
GROUP BY 1
ON CONFLICT ("key") DO UPDATE
    SET "lastNumber" = GREATEST("PlatformCounter"."lastNumber", EXCLUDED."lastNumber");

-- Every row now has one, so the column can carry the guarantee the rest of the
-- system relies on. On a clean install this passes trivially — there are no rows.
ALTER TABLE "Branch" ALTER COLUMN "publicId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Branch_publicId_key" ON "Branch"("publicId");

-- CreateIndex
CREATE INDEX "Branch_gstRegistrationId_idx" ON "Branch"("gstRegistrationId");

-- CreateIndex
CREATE INDEX "Branch_regionId_idx" ON "Branch"("regionId");

-- CreateIndex
CREATE INDEX "Branch_legalEntityId_idx" ON "Branch"("legalEntityId");

-- CreateIndex
CREATE INDEX "PosUser_regionId_idx" ON "PosUser"("regionId");

-- CreateIndex
CREATE INDEX "Order_terminalId_idx" ON "Order"("terminalId");

-- CreateIndex
CREATE INDEX "Order_deviceId_idx" ON "Order"("deviceId");

-- CreateIndex
CREATE INDEX "Payment_terminalId_idx" ON "Payment"("terminalId");

-- CreateIndex
CREATE INDEX "Payment_deviceId_idx" ON "Payment"("deviceId");

-- CreateIndex
CREATE INDEX "PosAuditLog_deviceId_at_idx" ON "PosAuditLog"("deviceId", "at");

-- CreateIndex
CREATE INDEX "LegalEntity_companyId_idx" ON "LegalEntity"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalEntity_companyId_legalName_key" ON "LegalEntity"("companyId", "legalName");

-- CreateIndex
-- Per tenant, not global, and NULLs stay distinct: a tenant may configure stores
-- before Finance produces the paperwork, so any number of entities may sit with
-- no PAN, while a global unique would answer "does another VEXO customer already
-- hold this PAN?" to anyone who can type one.
CREATE UNIQUE INDEX "LegalEntity_companyId_pan_key" ON "LegalEntity"("companyId", "pan");

-- CreateIndex
CREATE INDEX "GstRegistration_companyId_idx" ON "GstRegistration"("companyId");

-- CreateIndex
CREATE INDEX "GstRegistration_legalEntityId_idx" ON "GstRegistration"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "GstRegistration_companyId_gstin_key" ON "GstRegistration"("companyId", "gstin");

-- CreateIndex
CREATE INDEX "Brand_companyId_idx" ON "Brand"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_companyId_code_key" ON "Brand"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_companyId_name_key" ON "Brand"("companyId", "name");

-- CreateIndex
CREATE INDEX "BranchBrand_brandId_idx" ON "BranchBrand"("brandId");

-- CreateIndex
CREATE INDEX "Region_companyId_idx" ON "Region"("companyId");

-- CreateIndex
CREATE INDEX "Region_parentId_idx" ON "Region"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_companyId_code_key" ON "Region"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Region_companyId_name_key" ON "Region"("companyId", "name");

-- CreateIndex
CREATE INDEX "Terminal_companyId_idx" ON "Terminal"("companyId");

-- CreateIndex
CREATE INDEX "Terminal_branchId_idx" ON "Terminal"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_branchId_code_key" ON "Terminal"("branchId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Device_publicId_key" ON "Device"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_companyId_idx" ON "Device"("companyId");

-- CreateIndex
CREATE INDEX "Device_branchId_idx" ON "Device"("branchId");

-- CreateIndex
CREATE INDEX "Device_terminalId_idx" ON "Device"("terminalId");

-- CreateIndex
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- CreateIndex
CREATE INDEX "PermissionRule_companyId_level_idx" ON "PermissionRule"("companyId", "level");

-- CreateIndex
CREATE INDEX "PermissionRule_branchId_idx" ON "PermissionRule"("branchId");

-- CreateIndex
CREATE INDEX "PermissionRule_userId_idx" ON "PermissionRule"("userId");

-- CreateIndex
-- scopeKey, not the nullable (branchId, userId) pair: Postgres counts NULLs as
-- distinct, so a unique over those columns would happily admit a hundred
-- identical "company default" rows. Same trick DiscountPolicy already uses.
CREATE UNIQUE INDEX "PermissionRule_companyId_scopeKey_action_key" ON "PermissionRule"("companyId", "scopeKey", "action");

-- CreateIndex
CREATE INDEX "UserStoreAssignment_branchId_idx" ON "UserStoreAssignment"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "UserStoreAssignment_userId_branchId_key" ON "UserStoreAssignment"("userId", "branchId");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_companyId_expiresAt_idx" ON "SupportAccessGrant"("companyId", "expiresAt");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_userId_expiresAt_idx" ON "SupportAccessGrant"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_gstRegistrationId_fkey" FOREIGN KEY ("gstRegistrationId") REFERENCES "GstRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosUser" ADD CONSTRAINT "PosUser_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GstRegistration" ADD CONSTRAINT "GstRegistration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GstRegistration" ADD CONSTRAINT "GstRegistration_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchBrand" ADD CONSTRAINT "BranchBrand_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchBrand" ADD CONSTRAINT "BranchBrand_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_enrolledById_fkey" FOREIGN KEY ("enrolledById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStoreAssignment" ADD CONSTRAINT "UserStoreAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStoreAssignment" ADD CONSTRAINT "UserStoreAssignment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStoreAssignment" ADD CONSTRAINT "UserStoreAssignment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Shape constraints.
--
-- Prisma cannot express a CHECK, so these are hand-written and Prisma's diff
-- ignores them — it will not try to drop them on the next migration. They are
-- the last line of the three places every one of these formats is enforced (zod
-- schema on the route, input pattern on the screen, CHECK here); three copies
-- that drift is how a GSTIN the UI accepts starts failing at the database.
--
-- Deliberately NOT checked: the GSTIN checksum digit. An almost-right checksum
-- implementation rejects valid numbers, and a wrong GSTIN that passes a checksum
-- is still wrong — only the GST portal can settle it.
-- ---------------------------------------------------------------------------

-- The store id is permanent, so its shape is worth guaranteeing rather than
-- trusting. Four digits is the pad, not a ceiling: {4,} lets a tenant pass ten
-- thousand stores in one state instead of hitting a wall.
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_publicId_shape" CHECK ("publicId" ~ '^VC-[A-Z]{2}-[0-9]{4,}$');

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_invoicePrefix_shape" CHECK ("invoicePrefix" IS NULL OR "invoicePrefix" ~ '^[A-Z0-9-]{2,12}$');

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_fssai_shape" CHECK ("fssaiLicenseNo" IS NULL OR "fssaiLicenseNo" ~ '^[0-9]{14}$');

ALTER TABLE "Branch" ADD CONSTRAINT "Branch_pincode_shape" CHECK ("pincode" IS NULL OR "pincode" ~ '^[1-9][0-9]{5}$');

ALTER TABLE "Device" ADD CONSTRAINT "Device_publicId_shape" CHECK ("publicId" ~ '^VX-DVC-[0-9]{8,}$');

ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_pan_shape" CHECK ("pan" IS NULL OR "pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

ALTER TABLE "GstRegistration" ADD CONSTRAINT "GstRegistration_gstin_shape" CHECK ("gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$');

-- stateCode is stored rather than derived so the frozen invoice snapshot is
-- self-contained. This is what stops it ever disagreeing with the GSTIN it was
-- taken from.
ALTER TABLE "GstRegistration" ADD CONSTRAINT "GstRegistration_stateCode_matches_gstin" CHECK ("stateCode" = substring("gstin" from 1 for 2));

ALTER TABLE "GstRegistration" ADD CONSTRAINT "GstRegistration_pincode_shape" CHECK ("pincode" IS NULL OR "pincode" ~ '^[1-9][0-9]{5}$');

-- A support grant that expires before it begins is not a grant. Cheap to assert,
-- and it makes "the window was real" a database fact rather than a code comment.
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_window" CHECK ("expiresAt" > "grantedAt");

-- The scope columns have to agree with the level they claim, or a "company"
-- rule carrying a branchId would resolve differently depending on which code
-- path read it.
ALTER TABLE "PermissionRule" ADD CONSTRAINT "PermissionRule_scope_consistent" CHECK (
    ("level" = 'COMPANY' AND "branchId" IS NULL AND "userId" IS NULL AND "scopeKey" = 'company')
 OR ("level" = 'BRANCH'  AND "branchId" IS NOT NULL AND "userId" IS NULL AND "scopeKey" = 'branch:' || "branchId")
 OR ("level" = 'USER'    AND "userId" IS NOT NULL AND "branchId" IS NULL AND "scopeKey" = 'user:' || "userId")
);
