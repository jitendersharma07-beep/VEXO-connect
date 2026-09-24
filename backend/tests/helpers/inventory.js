// Shared fixtures for the inventory suites.
//
// Every suite that touches stock shares one _test database, so the wipe below
// clears the whole inventory graph in foreign-key order rather than just the
// tables one file happens to write. A partial wipe leaves another file's rows
// holding a key and the failure surfaces in the wrong suite.

import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/lib/crypto.js';

export const wipeInventory = async () => {
  // Keyed by job NAME, not by company, so it survives every other delete here
  // and would carry one suite's lease and run counts into the next one.
  await prisma.inventorySchedulerState.deleteMany();
  await prisma.inventoryNotification.deleteMany();
  await prisma.inventoryReminder.deleteMany();
  await prisma.storeRequestEvent.deleteMany();
  await prisma.storeRequestAttachment.deleteMany();
  await prisma.storeRequestIssue.deleteMany();
  await prisma.stockTransferLineBatch.deleteMany();
  await prisma.stockTransferLine.deleteMany();
  await prisma.stockTransfer.deleteMany();
  await prisma.storeRequestLine.deleteMany();
  await prisma.storeRequest.deleteMany();
  await prisma.replenishmentRun.deleteMany();
  await prisma.replenishmentPlanLine.deleteMany();
  await prisma.replenishmentPlan.deleteMany();
  await prisma.stockReservationLine.deleteMany();
  await prisma.stockReservation.deleteMany();
  await prisma.stockValuationSnapshotLine.deleteMany();
  await prisma.stockValuationSnapshot.deleteMany();
  await prisma.productionBatch.deleteMany();
  await prisma.stockWastageLine.deleteMany();
  await prisma.stockWastage.deleteMany();
  await prisma.stockCountLine.deleteMany();
  await prisma.stockCount.deleteMany();
  await prisma.saleStockReturn.deleteMany();
  await prisma.saleConsumption.deleteMany();
  await prisma.recipeModifierAdjustment.deleteMany();
  await prisma.recipeProductLink.deleteMany();
  await prisma.recipeLine.deleteMany();
  await prisma.recipeVersion.deleteMany();
  await prisma.recipe.deleteMany();
  await prisma.purchaseReturnLine.deleteMany();
  await prisma.purchaseReturn.deleteMany();
  await prisma.goodsReceiptLandedCost.deleteMany();
  await prisma.goodsReceiptLine.deleteMany();
  await prisma.goodsReceipt.deleteMany();
  await prisma.purchaseOrderLine.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.supplierItemPrice.deleteMany();
  await prisma.stockBatchOpening.deleteMany();
  await prisma.stockBatchBalance.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.stockBalance.deleteMany();
  // After the batches: a received batch records the supplier it came from, so
  // the supplier outlives the stock it delivered.
  await prisma.stockBatch.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.stockReorderRule.deleteMany();
  await prisma.inventoryDocCounter.deleteMany();
  await prisma.inventorySettings.deleteMany();
  await prisma.inventoryLocationAccess.deleteMany();
  await prisma.inventoryItemUnit.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.inventoryLocation.deleteMany();
};

export const wipeCore = async () => {
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

export const wipeAll = async () => {
  await wipeInventory();
  await wipeCore();
};

export const TEST_PASSWORD = 'test-password-1';

// One warehouse, two stores, and the four principals the acceptance walk
// needs. Deliberately small: every test that needs more builds it itself so
// the shared fixture stays readable.
export const buildBaseFixture = async ({ slug = 'inv-co' } = {}) => {
  const company = await prisma.company.create({
    data: { name: 'Inventory Test Co', slug: `${slug}-${Date.now()}` },
  });
  await prisma.license.create({
    data: {
      companyId: company.id,
      plan: 'MULTI_STORE',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 365 * 86400000),
      baseBranchLimit: 10,
    },
  });

  const storeA = await prisma.branch.create({
    data: { companyId: company.id, name: '店 A', code: 'SA' },
  });
  const storeB = await prisma.branch.create({
    data: { companyId: company.id, name: 'Store B', code: 'SB' },
  });

  const passwordHash = await hashPassword(TEST_PASSWORD);
  const owner = await prisma.posUser.create({
    data: {
      companyId: company.id,
      email: `owner-${company.id}@test.local`,
      fullName: 'Owner',
      role: 'CUSTOMER_OWNER',
      passwordHash,
    },
  });
  const managerA = await prisma.posUser.create({
    data: {
      companyId: company.id,
      branchId: storeA.id,
      email: `mgra-${company.id}@test.local`,
      fullName: 'Manager A',
      role: 'BRANCH_MANAGER',
      passwordHash,
    },
  });
  const managerB = await prisma.posUser.create({
    data: {
      companyId: company.id,
      branchId: storeB.id,
      email: `mgrb-${company.id}@test.local`,
      fullName: 'Manager B',
      role: 'BRANCH_MANAGER',
      passwordHash,
    },
  });
  const cashierA = await prisma.posUser.create({
    data: {
      companyId: company.id,
      branchId: storeA.id,
      email: `casha-${company.id}@test.local`,
      fullName: 'Cashier A',
      role: 'CASHIER',
      passwordHash,
    },
  });

  const warehouse = await prisma.inventoryLocation.create({
    data: { companyId: company.id, kind: 'WAREHOUSE', name: 'Central Warehouse', code: 'WH1' },
  });
  const roomA = await prisma.inventoryLocation.create({
    data: {
      companyId: company.id,
      branchId: storeA.id,
      kind: 'STORE',
      name: 'Store A room',
      code: 'SA-ROOM',
      saleSourceBranchId: storeA.id,
    },
  });
  const roomB = await prisma.inventoryLocation.create({
    data: {
      companyId: company.id,
      branchId: storeB.id,
      kind: 'STORE',
      name: 'Store B room',
      code: 'SB-ROOM',
      saleSourceBranchId: storeB.id,
    },
  });

  // The warehouse belongs to no branch, so a branch-pinned manager can only
  // reach it through an explicit grant. Manager A gets one; Manager B does
  // not, which is what the cross-scope negatives assert against.
  await prisma.inventoryLocationAccess.create({
    data: {
      companyId: company.id,
      userId: managerA.id,
      locationId: warehouse.id,
      canDispatch: true,
      canApprove: true,
    },
  });

  // Manager A also receives at the store room they are pinned to; the branch
  // pin already grants that, but the warehouse grant above is explicit about
  // what Manager A may do there and receiving is deliberately not on it.
  const supplier = await prisma.supplier.create({
    data: { companyId: company.id, name: 'Acme Provisions', code: 'ACME' },
  });

  return { company, storeA, storeB, owner, managerA, managerB, cashierA, warehouse, roomA, roomB, supplier };
};

export const makeItem = async (companyId, overrides = {}) =>
  prisma.inventoryItem.create({
    data: {
      companyId,
      kind: 'RAW',
      name: `Item ${Math.random().toString(36).slice(2, 8)}`,
      baseUnit: 'G',
      trackBatches: true,
      trackExpiry: true,
      ...overrides,
    },
  });

export const makeBatch = async (companyId, itemId, overrides = {}) =>
  prisma.stockBatch.create({
    data: {
      companyId,
      itemId,
      batchCode: `B${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      ...overrides,
    },
  });

export const daysFromNow = (n) => new Date(Date.now() + n * 86400000);
