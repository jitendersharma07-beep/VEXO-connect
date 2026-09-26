// Shared fixtures for the inventory suites.
//
// wipeAll is re-exported rather than defined here. It started in this file and
// is now what every suite in tests/ uses, so it lives in ./wipe.js; the
// re-export keeps the five inventory files importing one helper.

import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/lib/crypto.js';
// The product's own minter, not a literal. Branch.publicId is globally unique
// with a CHECK pinning ^VC-[A-Z]{2}-[0-9]{4,}$, and this fixture is built once
// per suite — five hardcoded ids would collide on the second suite, and a
// hand-written format would be free to drift away from the constraint the
// moment the constraint changed. Minting draws from PlatformCounter, so it is
// collision-free by construction and correct by the same code the route uses.
import { mintStorePublicId } from '../../src/lib/identity.js';

export { wipeAll } from './wipe.js';

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
      // The fixture company has bought Inventory. Every inventory route is
      // gated on this — see requireInventoryAction — so without it the whole
      // of these suites would answer 403 POS_MODULE_NOT_LICENSED.
      //
      // Granted here rather than in each suite, so the entitlement is the
      // BACKGROUND of these tests and not something any of them is quietly
      // asserting. The suite that tests the gate itself issues its own licence
      // without the module; see inventoryApi.test.js.
      modules: ['INVENTORY'],
    },
  });

  const storeA = await prisma.branch.create({
    data: { companyId: company.id, publicId: await mintStorePublicId(prisma), name: '店 A', code: 'SA' },
  });
  const storeB = await prisma.branch.create({
    data: { companyId: company.id, publicId: await mintStorePublicId(prisma), name: 'Store B', code: 'SB' },
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
