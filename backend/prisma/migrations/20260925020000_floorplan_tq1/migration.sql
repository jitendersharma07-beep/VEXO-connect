-- CreateEnum
CREATE TYPE "AreaKind" AS ENUM ('INDOOR', 'OUTDOOR', 'PATIO', 'ROOFTOP', 'CUSTOM');

-- CreateEnum
CREATE TYPE "TableShape" AS ENUM ('ROUND', 'SQUARE', 'RECT');

-- CreateEnum
CREATE TYPE "LayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LayoutObjectKind" AS ENUM ('WALL', 'ENTRANCE', 'PILLAR', 'KITCHEN', 'COUNTER');

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "TableStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Floor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningArea" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AreaKind" NOT NULL DEFAULT 'INDOOR',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "TableStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiningArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorLayout" (
    "id" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "status" "LayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "gridSize" INTEGER NOT NULL DEFAULT 20,
    "canvasWidth" INTEGER NOT NULL DEFAULT 1200,
    "canvasHeight" INTEGER NOT NULL DEFAULT 800,
    "backgroundImage" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorLayoutTable" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "areaId" TEXT,
    "shape" "TableShape" NOT NULL DEFAULT 'SQUARE',
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 80,
    "height" INTEGER NOT NULL DEFAULT 80,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "seats" INTEGER,

    CONSTRAINT "FloorLayoutTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorLayoutObject" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "kind" "LayoutObjectKind" NOT NULL,
    "label" TEXT,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 100,
    "height" INTEGER NOT NULL DEFAULT 20,
    "rotation" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FloorLayoutObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Floor_branchId_idx" ON "Floor"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_branchId_name_key" ON "Floor"("branchId", "name");

-- CreateIndex
CREATE INDEX "DiningArea_floorId_idx" ON "DiningArea"("floorId");

-- CreateIndex
CREATE UNIQUE INDEX "DiningArea_floorId_name_key" ON "DiningArea"("floorId", "name");

-- CreateIndex
CREATE INDEX "FloorLayout_floorId_status_idx" ON "FloorLayout"("floorId", "status");

-- CreateIndex
CREATE INDEX "FloorLayoutTable_tableId_idx" ON "FloorLayoutTable"("tableId");

-- CreateIndex
CREATE INDEX "FloorLayoutTable_areaId_idx" ON "FloorLayoutTable"("areaId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorLayoutTable_layoutId_tableId_key" ON "FloorLayoutTable"("layoutId", "tableId");

-- CreateIndex
CREATE INDEX "FloorLayoutObject_layoutId_idx" ON "FloorLayoutObject"("layoutId");

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningArea" ADD CONSTRAINT "DiningArea_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayout" ADD CONSTRAINT "FloorLayout_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayoutTable" ADD CONSTRAINT "FloorLayoutTable_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "FloorLayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayoutTable" ADD CONSTRAINT "FloorLayoutTable_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DiningTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayoutTable" ADD CONSTRAINT "FloorLayoutTable_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "DiningArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloorLayoutObject" ADD CONSTRAINT "FloorLayoutObject_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "FloorLayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

