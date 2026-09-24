-- CreateTable
CREATE TABLE "InventoryLocationAccess" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "canDispatch" BOOLEAN NOT NULL DEFAULT false,
    "canReceive" BOOLEAN NOT NULL DEFAULT false,
    "canApprove" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLocationAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryLocationAccess_companyId_idx" ON "InventoryLocationAccess"("companyId");

-- CreateIndex
CREATE INDEX "InventoryLocationAccess_locationId_idx" ON "InventoryLocationAccess"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocationAccess_userId_locationId_key" ON "InventoryLocationAccess"("userId", "locationId");

-- AddForeignKey
ALTER TABLE "InventoryLocationAccess" ADD CONSTRAINT "InventoryLocationAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PosUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLocationAccess" ADD CONSTRAINT "InventoryLocationAccess_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

