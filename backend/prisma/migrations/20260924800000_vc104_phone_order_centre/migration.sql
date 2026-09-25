-- CreateEnum
CREATE TYPE "PhoneFulfilment" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "PhoneOrderStatus" AS ENUM ('SUBMITTED', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliverySupplier" AS ENUM ('UNRESOLVED', 'RESTAURANT', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "DeliveryChargeTreatment" AS ENUM ('UNRESOLVED_POST_TAX_FALLBACK', 'COMPOSITE_SUPPLY', 'SEPARATE_CONSIDERATION');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "landmark" TEXT,
    "city" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchServiceArea" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "minOrder" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchServiceArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchHours" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "opensMinute" INTEGER NOT NULL,
    "closesMinute" INTEGER NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BranchHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchPrepCapacity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "slotMinutes" INTEGER NOT NULL DEFAULT 15,
    "maxOrdersPerSlot" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchPrepCapacity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "addressId" TEXT,
    "fulfilment" "PhoneFulfilment" NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "status" "PhoneOrderStatus" NOT NULL DEFAULT 'SUBMITTED',
    "routedBranchId" TEXT NOT NULL,
    "acceptedBranchId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "acceptedByName" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedByName" TEXT,
    "rejectReason" TEXT,
    "orderId" TEXT,
    "operatorId" TEXT,
    "operatorName" TEXT NOT NULL,
    "terminalId" TEXT,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deliverySupplier" "DeliverySupplier" NOT NULL DEFAULT 'UNRESOLVED',
    "deliveryChargeTreatment" "DeliveryChargeTreatment" NOT NULL DEFAULT 'UNRESOLVED_POST_TAX_FALLBACK',
    "note" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneOrderEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "phoneOrderId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "fromBranchId" TEXT,
    "toBranchId" TEXT,
    "reason" TEXT,
    "meta" JSONB,

    CONSTRAINT "PhoneOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_companyId_name_idx" ON "Customer"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_companyId_phone_key" ON "Customer"("companyId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_id_companyId_key" ON "Customer"("id", "companyId");

-- CreateIndex
CREATE INDEX "CustomerAddress_customerId_idx" ON "CustomerAddress"("customerId");

-- CreateIndex
CREATE INDEX "CustomerAddress_companyId_pincode_idx" ON "CustomerAddress"("companyId", "pincode");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAddress_id_companyId_key" ON "CustomerAddress"("id", "companyId");

-- CreateIndex
CREATE INDEX "BranchServiceArea_companyId_pincode_idx" ON "BranchServiceArea"("companyId", "pincode");

-- CreateIndex
CREATE UNIQUE INDEX "BranchServiceArea_branchId_pincode_key" ON "BranchServiceArea"("branchId", "pincode");

-- CreateIndex
CREATE INDEX "BranchHours_companyId_idx" ON "BranchHours"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchHours_branchId_dayOfWeek_key" ON "BranchHours"("branchId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BranchPrepCapacity_companyId_idx" ON "BranchPrepCapacity"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchPrepCapacity_branchId_companyId_key" ON "BranchPrepCapacity"("branchId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneOrder_orderId_key" ON "PhoneOrder"("orderId");

-- CreateIndex
CREATE INDEX "PhoneOrder_companyId_status_idx" ON "PhoneOrder"("companyId", "status");

-- CreateIndex
CREATE INDEX "PhoneOrder_companyId_routedBranchId_status_idx" ON "PhoneOrder"("companyId", "routedBranchId", "status");

-- CreateIndex
CREATE INDEX "PhoneOrder_customerId_idx" ON "PhoneOrder"("customerId");

-- CreateIndex
CREATE INDEX "PhoneOrder_scheduledFor_idx" ON "PhoneOrder"("scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneOrder_companyId_idempotencyKey_key" ON "PhoneOrder"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneOrder_companyId_reference_key" ON "PhoneOrder"("companyId", "reference");

-- CreateIndex
CREATE INDEX "PhoneOrderEvent_phoneOrderId_at_idx" ON "PhoneOrderEvent"("phoneOrderId", "at");

-- CreateIndex
CREATE INDEX "PhoneOrderEvent_companyId_at_idx" ON "PhoneOrderEvent"("companyId", "at");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "Customer"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchServiceArea" ADD CONSTRAINT "BranchServiceArea_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchHours" ADD CONSTRAINT "BranchHours_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPrepCapacity" ADD CONSTRAINT "BranchPrepCapacity_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_customerId_companyId_fkey" FOREIGN KEY ("customerId", "companyId") REFERENCES "Customer"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_addressId_companyId_fkey" FOREIGN KEY ("addressId", "companyId") REFERENCES "CustomerAddress"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_routedBranchId_companyId_fkey" FOREIGN KEY ("routedBranchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_acceptedBranchId_companyId_fkey" FOREIGN KEY ("acceptedBranchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrder" ADD CONSTRAINT "PhoneOrder_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PosUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneOrderEvent" ADD CONSTRAINT "PhoneOrderEvent_phoneOrderId_fkey" FOREIGN KEY ("phoneOrderId") REFERENCES "PhoneOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

