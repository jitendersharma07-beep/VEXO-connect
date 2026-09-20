-- Phase 2: catalog (tax rates, categories, products, variants), dining
-- tables, orders/items/KOT, manual payments, refunds, invoice counters.
-- Hand-written (prisma migrate dev is not used in this environment); applied
-- with prisma migrate deploy. Additive only — no existing table is touched.

-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "TableStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEAWAY');
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'BILLED', 'PAID', 'VOID', 'REFUNDED');
CREATE TYPE "OrderItemStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "DiscountType" AS ENUM ('FLAT', 'PERCENT');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'UPI', 'OTHER');
CREATE TYPE "PaymentChannel" AS ENUM ('MANUAL');

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratePercent" DECIMAL(6,3) NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "taxRateId" TEXT,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiningTable" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "status" "TableStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "OrderType" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "tableId" TEXT,
    "invoiceNumber" TEXT,
    "openedById" TEXT NOT NULL,
    "discountType" "DiscountType",
    "discountValue" DECIMAL(10,2),
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "voidReason" TEXT,
    "voidedById" TEXT,
    "billedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "qty" INTEGER NOT NULL,
    "lineDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxRateName" TEXT,
    "taxRatePercent" DECIMAL(6,3),
    "lineSubtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discountShare" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lineTax" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "kotId" TEXT,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "voidReason" TEXT,
    "voidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Kot" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Kot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "channel" "PaymentChannel" NOT NULL DEFAULT 'MANUAL',
    "amount" DECIMAL(10,2) NOT NULL,
    "tendered" DECIMAL(10,2),
    "note" TEXT,
    "receivedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "byId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceCounter" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "fyLabel" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxRate_companyId_idx" ON "TaxRate"("companyId");
CREATE UNIQUE INDEX "Category_companyId_name_key" ON "Category"("companyId", "name");
CREATE INDEX "Category_companyId_idx" ON "Category"("companyId");
CREATE UNIQUE INDEX "Product_companyId_sku_key" ON "Product"("companyId", "sku");
CREATE INDEX "Product_companyId_categoryId_idx" ON "Product"("companyId", "categoryId");
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");
CREATE UNIQUE INDEX "DiningTable_branchId_name_key" ON "DiningTable"("branchId", "name");
CREATE INDEX "DiningTable_branchId_idx" ON "DiningTable"("branchId");
CREATE UNIQUE INDEX "Order_companyId_invoiceNumber_key" ON "Order"("companyId", "invoiceNumber");
CREATE INDEX "Order_companyId_branchId_status_idx" ON "Order"("companyId", "branchId", "status");
CREATE INDEX "Order_companyId_billedAt_idx" ON "Order"("companyId", "billedAt");
CREATE INDEX "Order_tableId_idx" ON "Order"("tableId");
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");
CREATE UNIQUE INDEX "Kot_orderId_seq_key" ON "Kot"("orderId", "seq");
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");
CREATE UNIQUE INDEX "InvoiceCounter_branchId_fyLabel_key" ON "InvoiceCounter"("branchId", "fyLabel");

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Category" ADD CONSTRAINT "Category_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "TaxRate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "Kot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Kot" ADD CONSTRAINT "Kot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_byId_fkey" FOREIGN KEY ("byId") REFERENCES "PosUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
