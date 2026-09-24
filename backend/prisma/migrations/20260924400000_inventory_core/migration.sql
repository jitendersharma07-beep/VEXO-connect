-- CreateEnum
CREATE TYPE "InventoryLocationKind" AS ENUM ('STORE', 'WAREHOUSE', 'CENTRAL_KITCHEN');

-- CreateEnum
CREATE TYPE "InventoryItemKind" AS ENUM ('RAW', 'SEMI_FINISHED', 'FINISHED', 'PACKAGING');

-- CreateEnum
CREATE TYPE "InventoryStorageKind" AS ENUM ('AMBIENT', 'DRY', 'CHILLED', 'FROZEN', 'KITCHEN', 'BAR');

-- CreateEnum
CREATE TYPE "StockBatchState" AS ENUM ('AVAILABLE', 'QUARANTINED', 'RECALLED');

-- CreateEnum
CREATE TYPE "InventoryBaseUnit" AS ENUM ('G', 'ML', 'PCS');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InventoryProductionMode" AS ENUM ('BATCH', 'MADE_TO_ORDER');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('GRN', 'PURCHASE_RETURN', 'SALE_CONSUMPTION', 'SALE_REVERSAL', 'WASTAGE', 'COUNT_ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'PRODUCTION_IN', 'PRODUCTION_OUT');

-- CreateEnum
CREATE TYPE "StockCostStatus" AS ENUM ('ACTUAL', 'ESTIMATED', 'MISSING');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('REQUESTED', 'DISPATCHED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WastageReason" AS ENUM ('EXPIRED', 'SPOILED', 'DAMAGED', 'PREP_ERROR', 'OTHER');

-- CreateEnum
CREATE TYPE "RecipeVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "SaleConsumptionStatus" AS ENUM ('POSTED', 'UNCOSTED');

-- CreateEnum
CREATE TYPE "LandedCostBasis" AS ENUM ('VALUE', 'QUANTITY');

-- CreateEnum
CREATE TYPE "StockReservationState" AS ENUM ('HELD', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "StoreRequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED', 'IN_FULFILMENT', 'FULFILLED', 'CLOSED_SHORT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StoreRequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "StoreRequestIssueKind" AS ENUM ('SHORTAGE', 'DAMAGE');

-- CreateEnum
CREATE TYPE "StoreRequestIssueResolution" AS ENUM ('REPLACED', 'CREDITED', 'WRITTEN_OFF', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReplenishmentPlanStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "InventoryReminderKind" AS ENUM ('SUBMISSION_CUTOFF', 'PENDING_APPROVAL', 'DISPATCH_DUE', 'DELIVERY_OVERDUE', 'RECEIPT_PENDING', 'UNRESOLVED_SHORTAGE', 'BATCH_EXPIRING', 'OPENED_CONTAINER_EXPIRING');

-- CreateEnum
CREATE TYPE "InventoryReminderState" AS ENUM ('PENDING', 'NOTIFIED', 'ESCALATED', 'ACKNOWLEDGED', 'OBSOLETE');

-- CreateEnum
CREATE TYPE "InventoryNotificationState" AS ENUM ('QUEUED', 'DELIVERED', 'FAILED', 'READ');

-- CreateTable
CREATE TABLE "InventoryLocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "kind" "InventoryLocationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "saleSourceBranchId" TEXT,
    "parentId" TEXT,
    "storageKind" "InventoryStorageKind" NOT NULL DEFAULT 'AMBIENT',
    "capacityBaseQty" DECIMAL(18,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "InventoryItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "baseUnit" "InventoryBaseUnit" NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "trackBatches" BOOLEAN NOT NULL DEFAULT false,
    "trackExpiry" BOOLEAN NOT NULL DEFAULT false,
    "productionMode" "InventoryProductionMode" NOT NULL DEFAULT 'BATCH',
    "variableWeight" BOOLEAN NOT NULL DEFAULT false,
    "weightUnit" "InventoryBaseUnit",
    "minShelfLifeDaysAtReceipt" INTEGER,
    "openedShelfLifeHours" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItemUnit" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "factorMilli" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryItemUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "expiryDate" DATE,
    "supplierBatchCode" TEXT,
    "manufacturedOn" DATE,
    "receivedAt" TIMESTAMP(3),
    "supplierId" TEXT,
    "state" "StockBatchState" NOT NULL DEFAULT 'AVAILABLE',
    "stateReason" TEXT,
    "stateChangedAt" TIMESTAMP(3),
    "stateChangedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBatchBalance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBatchBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBatchOpening" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "useByAt" TIMESTAMP(3) NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "openedById" TEXT,
    "note" TEXT,

    CONSTRAINT "StockBatchOpening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "batchId" TEXT,
    "type" "StockMovementType" NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "valuePaise" BIGINT NOT NULL,
    "unitCostPaise" DECIMAL(20,6),
    "costStatus" "StockCostStatus" NOT NULL,
    "costBasisAt" TIMESTAMP(3),
    "balanceQtyAfter" DECIMAL(18,3) NOT NULL,
    "balanceValueAfter" BIGINT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceLineId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "terminalId" TEXT,
    "note" TEXT,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "valuePaise" BIGINT NOT NULL DEFAULT 0,
    "lastUnitCostPaise" DECIMAL(20,6),
    "costBasisAt" TIMESTAMP(3),
    "lastSeq" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReorderRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "minQty" DECIMAL(18,3) NOT NULL,
    "reorderQty" DECIMAL(18,3) NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReorderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySettings" (
    "companyId" TEXT NOT NULL,
    "purchaseTaxIsCost" BOOLEAN NOT NULL DEFAULT true,
    "staleCostDays" INTEGER NOT NULL DEFAULT 90,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventorySettings_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "InventoryDocCounter" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fyLabel" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InventoryDocCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "gstin" TEXT,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "paymentTermsDays" INTEGER,
    "status" "InventoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierItemPrice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "taxPctMilli" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierItemPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedAt" TIMESTAMP(3),
    "note" TEXT,
    "subtotalPaise" BIGINT NOT NULL DEFAULT 0,
    "taxPaise" BIGINT NOT NULL DEFAULT 0,
    "totalPaise" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "qtyBase" DECIMAL(18,3) NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "taxPctMilli" INTEGER NOT NULL DEFAULT 0,
    "linePaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "receivedQtyBase" DECIMAL(18,3) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "poId" TEXT,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supplierInvoiceNo" TEXT,
    "supplierInvoiceDate" DATE,
    "note" TEXT,
    "goodsPaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "landedCostPaise" BIGINT NOT NULL DEFAULT 0,
    "stockValuePaise" BIGINT NOT NULL,
    "taxIsCost" BOOLEAN NOT NULL,
    "idempotencyKey" TEXT,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "poLineId" TEXT,
    "itemId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "qtyBase" DECIMAL(18,3) NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "poUnitPricePaise" INTEGER,
    "outstandingQtyBase" DECIMAL(18,3),
    "qtyVarianceBase" DECIMAL(18,3),
    "priceVariancePaise" BIGINT,
    "taxPctMilli" INTEGER NOT NULL DEFAULT 0,
    "goodsPaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "landedCostPaise" BIGINT NOT NULL DEFAULT 0,
    "valuePaise" BIGINT NOT NULL,
    "batchId" TEXT,
    "returnedQtyBase" DECIMAL(18,3) NOT NULL DEFAULT 0,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLandedCost" (
    "id" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT,
    "amountPaise" BIGINT NOT NULL,
    "basis" "LandedCostBasis" NOT NULL DEFAULT 'VALUE',

    CONSTRAINT "GoodsReceiptLandedCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturn" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "creditPaise" BIGINT NOT NULL,
    "stockValuePaise" BIGINT NOT NULL,
    "idempotencyKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturnLine" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "grnLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,3) NOT NULL,
    "creditPaise" BIGINT NOT NULL,
    "stockValuePaise" BIGINT NOT NULL,

    CONSTRAINT "PurchaseReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outputItemId" TEXT,
    "status" "InventoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeVersion" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RecipeVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "yieldPercent" DECIMAL(6,3) NOT NULL DEFAULT 100,
    "outputQty" DECIMAL(18,3) NOT NULL DEFAULT 1,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "RecipeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeLine" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "RecipeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeProductLink" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "variantKey" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeProductLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeModifierAdjustment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,
    "recipeId" TEXT,
    "recipeKey" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qtyDelta" DECIMAL(18,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeModifierAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleConsumption" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "locationId" TEXT,
    "recipeVersionId" TEXT,
    "status" "SaleConsumptionStatus" NOT NULL,
    "uncostedReason" TEXT,
    "qtySold" INTEGER NOT NULL,
    "costPaise" BIGINT NOT NULL DEFAULT 0,
    "costStatus" "StockCostStatus" NOT NULL,
    "costBasisAt" TIMESTAMP(3),
    "returnedQty" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleStockReturn" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "saleConsumptionId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "valuePaise" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleStockReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "enteredQty" DECIMAL(18,3),
    "enteredUnit" TEXT,
    "countedQty" DECIMAL(18,3),
    "systemQty" DECIMAL(18,3),
    "varianceQty" DECIMAL(18,3),
    "unitCostPaise" DECIMAL(20,6),
    "postedValuePaise" BIGINT,
    "costStatus" "StockCostStatus",

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockWastage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reason" "WastageReason" NOT NULL,
    "note" TEXT,
    "totalValuePaise" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockWastage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockWastageLine" (
    "id" TEXT NOT NULL,
    "wastageId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "enteredQty" DECIMAL(18,3) NOT NULL,
    "enteredUnit" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,3) NOT NULL,
    "batchId" TEXT,
    "valuePaise" BIGINT NOT NULL,
    "costStatus" "StockCostStatus" NOT NULL,

    CONSTRAINT "StockWastageLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "storeRequestId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "storeRequestLineId" TEXT,
    "requestedQty" DECIMAL(18,3) NOT NULL,
    "dispatchedQty" DECIMAL(18,3),
    "dispatchValuePaise" BIGINT,
    "acceptedQty" DECIMAL(18,3),
    "acceptedValuePaise" BIGINT,
    "damagedQty" DECIMAL(18,3),
    "damagedValuePaise" BIGINT,
    "shortageQty" DECIMAL(18,3),
    "shortageValuePaise" BIGINT,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLineBatch" (
    "id" TEXT NOT NULL,
    "transferLineId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "dispatchedQty" DECIMAL(18,3) NOT NULL,
    "acceptedQty" DECIMAL(18,3),
    "damagedQty" DECIMAL(18,3),
    "shortageQty" DECIMAL(18,3),

    CONSTRAINT "StockTransferLineBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "outputItemId" TEXT NOT NULL,
    "outputQty" DECIMAL(18,3) NOT NULL,
    "inputValuePaise" BIGINT NOT NULL,
    "batchId" TEXT,
    "note" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockValuationSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL,
    "totalValuePaise" BIGINT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "takenById" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockValuationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockValuationSnapshotLine" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "valuePaise" BIGINT NOT NULL,

    CONSTRAINT "StockValuationSnapshotLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "state" "StockReservationState" NOT NULL DEFAULT 'HELD',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "heldById" TEXT,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservationLine" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "StockReservationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "sourceLocationId" TEXT,
    "status" "StoreRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "StoreRequestPriority" NOT NULL DEFAULT 'NORMAL',
    "requiredBy" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "assignedApproverId" TEXT,
    "raisedById" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "originPlanId" TEXT,
    "originRunId" TEXT,
    "requirementKey" TEXT,
    "idempotencyKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "enteredQty" DECIMAL(18,3) NOT NULL,
    "enteredUnit" TEXT NOT NULL,
    "enteredFactorMilli" INTEGER NOT NULL,
    "requestedQty" DECIMAL(18,3) NOT NULL,
    "approvedQty" DECIMAL(18,3),
    "allocatedQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "dispatchedQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "acceptedQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "damagedQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "shortageQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "outstandingQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "rejectedReason" TEXT,
    "note" TEXT,

    CONSTRAINT "StoreRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRequestAttachment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "byteSize" INTEGER,
    "url" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreRequestAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRequestIssue" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestLineId" TEXT NOT NULL,
    "kind" "StoreRequestIssueKind" NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "valuePaise" BIGINT NOT NULL,
    "note" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raisedById" TEXT,
    "resolution" "StoreRequestIssueResolution",
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "replacementRequestId" TEXT,

    CONSTRAINT "StoreRequestIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" "StoreRequestStatus",
    "toStatus" "StoreRequestStatus",
    "actorId" TEXT,
    "actorRole" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentPlan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "sourceLocationId" TEXT NOT NULL,
    "status" "ReplenishmentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "deliveryDays" INTEGER[],
    "cutoffMinute" INTEGER NOT NULL,
    "requiredByMinute" INTEGER NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 1,
    "coverDays" INTEGER NOT NULL DEFAULT 7,
    "autoSubmit" BOOLEAN NOT NULL DEFAULT false,
    "status_note" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplenishmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentPlanLine" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "minQty" DECIMAL(18,3) NOT NULL,
    "targetQty" DECIMAL(18,3) NOT NULL,
    "safetyQty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReplenishmentPlanLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "cycleDate" DATE NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "detail" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,

    CONSTRAINT "ReplenishmentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReminder" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "InventoryReminderKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "storeRequestId" TEXT,
    "issueId" TEXT,
    "locationId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "state" "InventoryReminderState" NOT NULL DEFAULT 'PENDING',
    "assigneeId" TEXT,
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "escalateAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "obsoletedAt" TIMESTAMP(3),
    "obsoleteReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryNotification" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reminderId" TEXT,
    "recipientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'INAPP',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "state" "InventoryNotificationState" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySchedulerState" (
    "name" TEXT NOT NULL,
    "lastTickAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "cursorAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventorySchedulerState_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_saleSourceBranchId_key" ON "InventoryLocation"("saleSourceBranchId");

-- CreateIndex
CREATE INDEX "InventoryLocation_companyId_idx" ON "InventoryLocation"("companyId");

-- CreateIndex
CREATE INDEX "InventoryLocation_branchId_idx" ON "InventoryLocation"("branchId");

-- CreateIndex
CREATE INDEX "InventoryLocation_parentId_idx" ON "InventoryLocation"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_companyId_code_key" ON "InventoryLocation"("companyId", "code");

-- CreateIndex
CREATE INDEX "InventoryItem_companyId_kind_idx" ON "InventoryItem"("companyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_companyId_name_key" ON "InventoryItem"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_companyId_sku_key" ON "InventoryItem"("companyId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItemUnit_itemId_name_key" ON "InventoryItemUnit"("itemId", "name");

-- CreateIndex
CREATE INDEX "StockBatch_companyId_expiryDate_idx" ON "StockBatch"("companyId", "expiryDate");

-- CreateIndex
CREATE INDEX "StockBatch_companyId_state_idx" ON "StockBatch"("companyId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "StockBatch_itemId_batchCode_key" ON "StockBatch"("itemId", "batchCode");

-- CreateIndex
CREATE INDEX "StockBatchBalance_companyId_itemId_idx" ON "StockBatchBalance"("companyId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBatchBalance_locationId_itemId_batchId_key" ON "StockBatchBalance"("locationId", "itemId", "batchId");

-- CreateIndex
CREATE INDEX "StockBatchOpening_companyId_useByAt_idx" ON "StockBatchOpening"("companyId", "useByAt");

-- CreateIndex
CREATE INDEX "StockBatchOpening_locationId_batchId_idx" ON "StockBatchOpening"("locationId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_idempotencyKey_key" ON "StockMovement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_locationId_itemId_seq_idx" ON "StockMovement"("companyId", "locationId", "itemId", "seq");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_type_occurredAt_idx" ON "StockMovement"("companyId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_companyId_postedAt_idx" ON "StockMovement"("companyId", "postedAt");

-- CreateIndex
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "StockMovement_locationId_itemId_batchId_idx" ON "StockMovement"("locationId", "itemId", "batchId");

-- CreateIndex
CREATE INDEX "StockBalance_companyId_idx" ON "StockBalance"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_locationId_itemId_key" ON "StockBalance"("locationId", "itemId");

-- CreateIndex
CREATE INDEX "StockReorderRule_companyId_idx" ON "StockReorderRule"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReorderRule_locationId_itemId_key" ON "StockReorderRule"("locationId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDocCounter_companyId_docType_fyLabel_key" ON "InventoryDocCounter"("companyId", "docType", "fyLabel");

-- CreateIndex
CREATE INDEX "Supplier_companyId_idx" ON "Supplier"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_companyId_name_key" ON "Supplier"("companyId", "name");

-- CreateIndex
CREATE INDEX "SupplierItemPrice_supplierId_itemId_effectiveFrom_idx" ON "SupplierItemPrice"("supplierId", "itemId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_status_idx" ON "PurchaseOrder"("companyId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_locationId_idx" ON "PurchaseOrder"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_companyId_number_key" ON "PurchaseOrder"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_poId_lineNo_key" ON "PurchaseOrderLine"("poId", "lineNo");

-- CreateIndex
CREATE INDEX "GoodsReceipt_companyId_receivedAt_idx" ON "GoodsReceipt"("companyId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_poId_idx" ON "GoodsReceipt"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_companyId_number_key" ON "GoodsReceipt"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_companyId_idempotencyKey_key" ON "GoodsReceipt"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_grnId_lineNo_key" ON "GoodsReceiptLine"("grnId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_companyId_number_key" ON "PurchaseReturn"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_companyId_idempotencyKey_key" ON "PurchaseReturn"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_outputItemId_key" ON "Recipe"("outputItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_companyId_name_key" ON "Recipe"("companyId", "name");

-- CreateIndex
CREATE INDEX "RecipeVersion_recipeId_status_idx" ON "RecipeVersion"("recipeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_recipeId_version_key" ON "RecipeVersion"("recipeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeLine_versionId_lineNo_key" ON "RecipeLine"("versionId", "lineNo");

-- CreateIndex
CREATE INDEX "RecipeProductLink_companyId_idx" ON "RecipeProductLink"("companyId");

-- CreateIndex
CREATE INDEX "RecipeProductLink_recipeId_idx" ON "RecipeProductLink"("recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeProductLink_productId_variantKey_key" ON "RecipeProductLink"("productId", "variantKey");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeModifierAdjustment_companyId_modifierId_recipeKey_ite_key" ON "RecipeModifierAdjustment"("companyId", "modifierId", "recipeKey", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleConsumption_orderItemId_key" ON "SaleConsumption"("orderItemId");

-- CreateIndex
CREATE INDEX "SaleConsumption_companyId_occurredAt_idx" ON "SaleConsumption"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "SaleConsumption_orderId_idx" ON "SaleConsumption"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleStockReturn_saleConsumptionId_idempotencyKey_key" ON "SaleStockReturn"("saleConsumptionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockCount_companyId_status_idx" ON "StockCount"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_companyId_number_key" ON "StockCount"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_itemId_key" ON "StockCountLine"("countId", "itemId");

-- CreateIndex
CREATE INDEX "StockWastage_companyId_createdAt_idx" ON "StockWastage"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockWastage_companyId_number_key" ON "StockWastage"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "StockWastage_companyId_idempotencyKey_key" ON "StockWastage"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockTransfer_companyId_status_idx" ON "StockTransfer"("companyId", "status");

-- CreateIndex
CREATE INDEX "StockTransfer_fromLocationId_idx" ON "StockTransfer"("fromLocationId");

-- CreateIndex
CREATE INDEX "StockTransfer_toLocationId_idx" ON "StockTransfer"("toLocationId");

-- CreateIndex
CREATE INDEX "StockTransfer_storeRequestId_idx" ON "StockTransfer"("storeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_companyId_number_key" ON "StockTransfer"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_companyId_idempotencyKey_key" ON "StockTransfer"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockTransferLine_storeRequestLineId_idx" ON "StockTransferLine"("storeRequestLineId");

-- CreateIndex
CREATE INDEX "StockTransferLineBatch_batchId_idx" ON "StockTransferLineBatch"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferLineBatch_transferLineId_batchId_key" ON "StockTransferLineBatch"("transferLineId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBatch_companyId_number_key" ON "ProductionBatch"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBatch_companyId_idempotencyKey_key" ON "ProductionBatch"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockValuationSnapshot_companyId_asOf_idx" ON "StockValuationSnapshot"("companyId", "asOf");

-- CreateIndex
CREATE INDEX "StockValuationSnapshotLine_snapshotId_idx" ON "StockValuationSnapshotLine"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservation_idempotencyKey_key" ON "StockReservation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockReservation_companyId_state_idx" ON "StockReservation"("companyId", "state");

-- CreateIndex
CREATE INDEX "StockReservation_locationId_itemId_state_idx" ON "StockReservation"("locationId", "itemId", "state");

-- CreateIndex
CREATE INDEX "StockReservation_sourceType_sourceId_idx" ON "StockReservation"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "StockReservationLine_batchId_idx" ON "StockReservationLine"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservationLine_reservationId_batchId_key" ON "StockReservationLine"("reservationId", "batchId");

-- CreateIndex
CREATE INDEX "StoreRequest_companyId_status_idx" ON "StoreRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "StoreRequest_destinationLocationId_status_idx" ON "StoreRequest"("destinationLocationId", "status");

-- CreateIndex
CREATE INDEX "StoreRequest_sourceLocationId_status_idx" ON "StoreRequest"("sourceLocationId", "status");

-- CreateIndex
CREATE INDEX "StoreRequest_companyId_requiredBy_idx" ON "StoreRequest"("companyId", "requiredBy");

-- CreateIndex
CREATE UNIQUE INDEX "StoreRequest_companyId_number_key" ON "StoreRequest"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "StoreRequest_companyId_requirementKey_key" ON "StoreRequest"("companyId", "requirementKey");

-- CreateIndex
CREATE UNIQUE INDEX "StoreRequest_companyId_idempotencyKey_key" ON "StoreRequest"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StoreRequestLine_itemId_idx" ON "StoreRequestLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreRequestLine_requestId_itemId_key" ON "StoreRequestLine"("requestId", "itemId");

-- CreateIndex
CREATE INDEX "StoreRequestAttachment_requestId_idx" ON "StoreRequestAttachment"("requestId");

-- CreateIndex
CREATE INDEX "StoreRequestIssue_companyId_resolvedAt_idx" ON "StoreRequestIssue"("companyId", "resolvedAt");

-- CreateIndex
CREATE INDEX "StoreRequestIssue_requestId_idx" ON "StoreRequestIssue"("requestId");

-- CreateIndex
CREATE INDEX "StoreRequestEvent_requestId_createdAt_idx" ON "StoreRequestEvent"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "ReplenishmentPlan_companyId_status_idx" ON "ReplenishmentPlan"("companyId", "status");

-- CreateIndex
CREATE INDEX "ReplenishmentPlan_status_nextRunAt_idx" ON "ReplenishmentPlan"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentPlan_companyId_name_key" ON "ReplenishmentPlan"("companyId", "name");

-- CreateIndex
CREATE INDEX "ReplenishmentPlanLine_itemId_idx" ON "ReplenishmentPlanLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentPlanLine_planId_itemId_key" ON "ReplenishmentPlanLine"("planId", "itemId");

-- CreateIndex
CREATE INDEX "ReplenishmentRun_companyId_startedAt_idx" ON "ReplenishmentRun"("companyId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentRun_planId_cycleDate_key" ON "ReplenishmentRun"("planId", "cycleDate");

-- CreateIndex
CREATE INDEX "InventoryReminder_companyId_state_dueAt_idx" ON "InventoryReminder"("companyId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "InventoryReminder_assigneeId_state_idx" ON "InventoryReminder"("assigneeId", "state");

-- CreateIndex
CREATE INDEX "InventoryReminder_state_escalateAt_idx" ON "InventoryReminder"("state", "escalateAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReminder_companyId_dedupeKey_key" ON "InventoryReminder"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "InventoryNotification_recipientId_state_createdAt_idx" ON "InventoryNotification"("recipientId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryNotification_companyId_state_idx" ON "InventoryNotification"("companyId", "state");

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItemUnit" ADD CONSTRAINT "InventoryItemUnit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatchBalance" ADD CONSTRAINT "StockBatchBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatchBalance" ADD CONSTRAINT "StockBatchBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatchBalance" ADD CONSTRAINT "StockBatchBalance_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatchOpening" ADD CONSTRAINT "StockBatchOpening_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatchOpening" ADD CONSTRAINT "StockBatchOpening_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReorderRule" ADD CONSTRAINT "StockReorderRule_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReorderRule" ADD CONSTRAINT "StockReorderRule_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItemPrice" ADD CONSTRAINT "SupplierItemPrice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItemPrice" ADD CONSTRAINT "SupplierItemPrice_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLandedCost" ADD CONSTRAINT "GoodsReceiptLandedCost_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnLine" ADD CONSTRAINT "PurchaseReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "PurchaseReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnLine" ADD CONSTRAINT "PurchaseReturnLine_grnLineId_fkey" FOREIGN KEY ("grnLineId") REFERENCES "GoodsReceiptLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeVersion" ADD CONSTRAINT "RecipeVersion_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeProductLink" ADD CONSTRAINT "RecipeProductLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeProductLink" ADD CONSTRAINT "RecipeProductLink_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeProductLink" ADD CONSTRAINT "RecipeProductLink_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeModifierAdjustment" ADD CONSTRAINT "RecipeModifierAdjustment_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeModifierAdjustment" ADD CONSTRAINT "RecipeModifierAdjustment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleStockReturn" ADD CONSTRAINT "SaleStockReturn_saleConsumptionId_fkey" FOREIGN KEY ("saleConsumptionId") REFERENCES "SaleConsumption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockWastage" ADD CONSTRAINT "StockWastage_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockWastageLine" ADD CONSTRAINT "StockWastageLine_wastageId_fkey" FOREIGN KEY ("wastageId") REFERENCES "StockWastage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockWastageLine" ADD CONSTRAINT "StockWastageLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_storeRequestId_fkey" FOREIGN KEY ("storeRequestId") REFERENCES "StoreRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_storeRequestLineId_fkey" FOREIGN KEY ("storeRequestLineId") REFERENCES "StoreRequestLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLineBatch" ADD CONSTRAINT "StockTransferLineBatch_transferLineId_fkey" FOREIGN KEY ("transferLineId") REFERENCES "StockTransferLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLineBatch" ADD CONSTRAINT "StockTransferLineBatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionBatch" ADD CONSTRAINT "ProductionBatch_outputItemId_fkey" FOREIGN KEY ("outputItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuationSnapshotLine" ADD CONSTRAINT "StockValuationSnapshotLine_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "StockValuationSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservationLine" ADD CONSTRAINT "StockReservationLine_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "StockReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservationLine" ADD CONSTRAINT "StockReservationLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequest" ADD CONSTRAINT "StoreRequest_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequest" ADD CONSTRAINT "StoreRequest_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequest" ADD CONSTRAINT "StoreRequest_originPlanId_fkey" FOREIGN KEY ("originPlanId") REFERENCES "ReplenishmentPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequest" ADD CONSTRAINT "StoreRequest_originRunId_fkey" FOREIGN KEY ("originRunId") REFERENCES "ReplenishmentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequestLine" ADD CONSTRAINT "StoreRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StoreRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequestLine" ADD CONSTRAINT "StoreRequestLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequestAttachment" ADD CONSTRAINT "StoreRequestAttachment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StoreRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequestIssue" ADD CONSTRAINT "StoreRequestIssue_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StoreRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequestIssue" ADD CONSTRAINT "StoreRequestIssue_requestLineId_fkey" FOREIGN KEY ("requestLineId") REFERENCES "StoreRequestLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRequestEvent" ADD CONSTRAINT "StoreRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StoreRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentPlan" ADD CONSTRAINT "ReplenishmentPlan_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentPlan" ADD CONSTRAINT "ReplenishmentPlan_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentPlanLine" ADD CONSTRAINT "ReplenishmentPlanLine_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ReplenishmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentPlanLine" ADD CONSTRAINT "ReplenishmentPlanLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentRun" ADD CONSTRAINT "ReplenishmentRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ReplenishmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReminder" ADD CONSTRAINT "InventoryReminder_storeRequestId_fkey" FOREIGN KEY ("storeRequestId") REFERENCES "StoreRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReminder" ADD CONSTRAINT "InventoryReminder_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "StoreRequestIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryNotification" ADD CONSTRAINT "InventoryNotification_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "InventoryReminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

