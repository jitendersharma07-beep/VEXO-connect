-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PromotionRuleKind" AS ENUM ('INCLUDE_CATEGORY', 'EXCLUDE_CATEGORY', 'INCLUDE_PRODUCT', 'EXCLUDE_PRODUCT');

-- CreateEnum
CREATE TYPE "PromotionRedemptionStatus" AS ENUM ('APPLIED', 'REVERSED');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "benefitType" "DiscountType" NOT NULL,
    "percent" DECIMAL(6,3),
    "flatPaise" INTEGER,
    "minSpendPaise" INTEGER,
    "maxBenefitPaise" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "weekdayMask" INTEGER,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "channel" "OrderType",
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "precedence" INTEGER NOT NULL DEFAULT 100,
    "totalLimit" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "perCustomerLimit" INTEGER,
    "createdById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionItemRule" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "PromotionRuleKind" NOT NULL,
    "categoryId" TEXT,
    "productId" TEXT,

    CONSTRAINT "PromotionItemRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionStore" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,

    CONSTRAINT "PromotionStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionRedemption" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "promotionName" TEXT NOT NULL,
    "promotionVersion" INTEGER NOT NULL,
    "code" TEXT,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "PromotionRedemptionStatus" NOT NULL DEFAULT 'APPLIED',
    "reversedReason" TEXT,
    "reversedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "customerKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- Money guards at the last line of defence (adopted from the x/promotions
-- lane's 20260924150000_promotions_core draft during reconciliation; that
-- migration is superseded by this one and was never applied to a retained DB).
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_percent_range"
    CHECK ("percent" IS NULL OR ("percent" > 0 AND "percent" <= 100));
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_flatPaise_positive"
    CHECK ("flatPaise" IS NULL OR "flatPaise" > 0);
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_weekdayMask_range"
    CHECK ("weekdayMask" IS NULL OR ("weekdayMask" >= 1 AND "weekdayMask" <= 127));
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_totalLimit_positive"
    CHECK ("totalLimit" IS NULL OR "totalLimit" >= 1);
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_perCustomerLimit_positive"
    CHECK ("perCustomerLimit" IS NULL OR "perCustomerLimit" >= 1);

-- CreateIndex
CREATE INDEX "Promotion_companyId_status_idx" ON "Promotion"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_companyId_code_key" ON "Promotion"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_id_companyId_key" ON "Promotion"("id", "companyId");

-- CreateIndex
CREATE INDEX "PromotionItemRule_promotionId_idx" ON "PromotionItemRule"("promotionId");

-- CreateIndex
CREATE INDEX "PromotionItemRule_categoryId_idx" ON "PromotionItemRule"("categoryId");

-- CreateIndex
CREATE INDEX "PromotionItemRule_productId_idx" ON "PromotionItemRule"("productId");

-- CreateIndex
CREATE INDEX "PromotionStore_branchId_idx" ON "PromotionStore"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionStore_promotionId_branchId_key" ON "PromotionStore"("promotionId", "branchId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_orderId_idx" ON "PromotionRedemption"("orderId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_companyId_createdAt_idx" ON "PromotionRedemption"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionRedemption_promotionId_orderId_key" ON "PromotionRedemption"("promotionId", "orderId");

-- CreateIndex
CREATE INDEX "PromotionRedemption_promotionId_customerKey_idx" ON "PromotionRedemption"("promotionId", "customerKey");

-- CreateIndex
CREATE UNIQUE INDEX "Category_id_companyId_key" ON "Category"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_companyId_branchId_key" ON "Order"("id", "companyId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_companyId_key" ON "Product"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItemRule" ADD CONSTRAINT "PromotionItemRule_promotionId_companyId_fkey" FOREIGN KEY ("promotionId", "companyId") REFERENCES "Promotion"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItemRule" ADD CONSTRAINT "PromotionItemRule_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "Category"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionItemRule" ADD CONSTRAINT "PromotionItemRule_productId_companyId_fkey" FOREIGN KEY ("productId", "companyId") REFERENCES "Product"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionStore" ADD CONSTRAINT "PromotionStore_promotionId_companyId_fkey" FOREIGN KEY ("promotionId", "companyId") REFERENCES "Promotion"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionStore" ADD CONSTRAINT "PromotionStore_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_promotionId_companyId_fkey" FOREIGN KEY ("promotionId", "companyId") REFERENCES "Promotion"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_orderId_companyId_branchId_fkey" FOREIGN KEY ("orderId", "companyId", "branchId") REFERENCES "Order"("id", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionRedemption" ADD CONSTRAINT "PromotionRedemption_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
