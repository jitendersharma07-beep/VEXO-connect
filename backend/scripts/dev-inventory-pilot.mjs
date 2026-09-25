// The inventory acceptance pilot: one warehouse, two stores, real HTTP calls.
//
// WHY THIS DRIVES THE API RATHER THAN THE DATABASE
//
// A fixture written straight into Postgres can produce a warehouse holding
// stock that no receipt ever created and no ledger line explains. That is
// exactly the state this module exists to make impossible, so building the
// demo data that way would hide the bug it is meant to demonstrate. Every row
// below arrives through the same router, the same permission map and the same
// ledger the portal uses, which means the pilot also doubles as a walk of the
// acceptance list: where a step is supposed to be refused, it is issued and
// the refusal is asserted rather than assumed.
//
// It is repeatable. A second run removes the pilot company's own graph and
// rebuilds it. The delete is scoped to that one company by id — no table is
// ever truncated, so another worker's tenant in the same development database
// is untouched.
//
// DEVELOPMENT DATABASE ONLY. The guard below refuses to start anywhere else,
// and it refuses by default rather than by blocklist: the database has to be
// named, not merely fail to look like production.
//
//   INVENTORY_PILOT_DB        the exact database name this run may touch
//   INVENTORY_PILOT_PASSWORD  the login password for the pilot accounts;
//                             generated and printed once if not supplied
//
// Nothing here prints a connection string, a token or a hash. The e-mail
// addresses use the RFC 2606 reserved .invalid domain, so no notification
// adapter can reach a real person even if one were wired to a live transport.

import { randomBytes } from 'node:crypto';

const fail = (message) => {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
};

/* ------------------------------------------------------------------ guard */

const DSN = process.env.DATABASE_URL;
if (!DSN) fail('DATABASE_URL is not set');

let dbName = '';
try {
  dbName = decodeURIComponent(new URL(DSN).pathname.replace(/^\//, ''));
} catch {
  fail('DATABASE_URL is not a URL this script can read');
}
if (!dbName) fail('DATABASE_URL names no database');

if (process.env.NODE_ENV === 'production') fail('NODE_ENV is production');

const allowed = (process.env.INVENTORY_PILOT_DB || '').trim();
if (allowed) {
  if (dbName !== allowed) {
    fail(`DATABASE_URL points at "${dbName}", but INVENTORY_PILOT_DB names "${allowed}"`);
  }
} else if (!/^vcx_inventory(_[a-z0-9]+)?$/.test(dbName)) {
  fail(
    `"${dbName}" is not the isolated development database this script was written for. ` +
      'Set INVENTORY_PILOT_DB to the exact name if that is genuinely where the pilot should go.',
  );
}
// Belt and braces: even a named database may not carry one of these words.
if (/(prod|production|live)/i.test(dbName)) fail(`"${dbName}" reads like a production database`);

process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'silent';
// Reminders and escalations stay inside the portal. No adapter is handed a
// live transport by this script, ever.
process.env.INVENTORY_NOTIFY_TRANSPORT = 'inapp';

const PASSWORD = process.env.INVENTORY_PILOT_PASSWORD || randomBytes(9).toString('base64url');
const generatedPassword = !process.env.INVENTORY_PILOT_PASSWORD;

/* --------------------------------------------------------------- machinery */

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const supertest = (await import('supertest')).default;

const app = createApp();

const SLUG = 'pilot-inventory';
const API = '/api/inventory';

let stepNo = 0;
const log = (text = '') => console.log(text);
const step = (text) => console.log(`  ${String(++stepNo).padStart(2, '0')}. ${text}`);

// Fails with the server's own sentence rather than a bare status code. Every
// call states the status it expects, refusals included: a 403 that quietly
// became a 200 is exactly the regression this pilot exists to catch.
const call = async (method, path, { token, body, expect = 200, query } = {}) => {
  let r = supertest(app)[method](path);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  if (query) r = r.query(query);
  if (body !== undefined) r = r.send(body);
  const res = await r;
  const wanted = Array.isArray(expect) ? expect : [expect];
  if (!wanted.includes(res.status)) {
    const said = res.body?.error?.message ?? res.body?.message ?? JSON.stringify(res.body);
    throw new Error(`${method.toUpperCase()} ${path} returned ${res.status}, expected ${wanted.join(' or ')} — ${said}`);
  }
  return res.body;
};

const get = (p, o) => call('get', p, o);
const post = (p, o) => call('post', p, o);
const put = (p, o) => call('put', p, o);

const login = async (email) => {
  const body = await post('/api/auth/login', { body: { email, password: PASSWORD } });
  if (!body.token) throw new Error(`login ${email} returned no token`);
  return body.token;
};

const key = (prefix) => `${prefix}-${randomBytes(6).toString('hex')}`;
const days = (n) => new Date(Date.now() + n * 86400000);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const rupees = (paise) => `₹${(Number(paise) / 100).toFixed(2)}`;

/* ------------------------------------------------------- scoped demolition */

const idsOf = async (model, where) => (await prisma[model].findMany({ where, select: { id: true } })).map((r) => r.id);

// Removes one company and everything hanging off it, child rows first.
//
// Written out in full rather than as a loop over model names because the order
// is the point: a delete that runs too early hits a foreign key and fails
// loudly, and a delete that is missing leaves a row the next run trips over.
// Scoped by companyId — or by a parent id list where the child table has no
// company column — so a second tenant in the same database is never touched.
const removeCompany = async (companyId) => {
  await prisma.inventorySchedulerState.deleteMany({ where: { name: { contains: companyId } } });
  await prisma.inventoryNotification.deleteMany({ where: { companyId } });
  await prisma.inventoryReminder.deleteMany({ where: { companyId } });

  const transferIds = await idsOf('stockTransfer', { companyId });
  const transferLineIds = await idsOf('stockTransferLine', { transferId: { in: transferIds } });
  await prisma.stockTransferLineBatch.deleteMany({ where: { transferLineId: { in: transferLineIds } } });

  const requestIds = await idsOf('storeRequest', { companyId });
  await prisma.storeRequestEvent.deleteMany({ where: { requestId: { in: requestIds } } });
  await prisma.storeRequestAttachment.deleteMany({ where: { requestId: { in: requestIds } } });
  await prisma.storeRequestIssue.deleteMany({ where: { companyId } });
  await prisma.stockTransferLine.deleteMany({ where: { transferId: { in: transferIds } } });
  await prisma.stockTransfer.deleteMany({ where: { companyId } });
  await prisma.storeRequestLine.deleteMany({ where: { requestId: { in: requestIds } } });
  await prisma.storeRequest.deleteMany({ where: { companyId } });

  await prisma.replenishmentRun.deleteMany({ where: { companyId } });
  const planIds = await idsOf('replenishmentPlan', { companyId });
  await prisma.replenishmentPlanLine.deleteMany({ where: { planId: { in: planIds } } });
  await prisma.replenishmentPlan.deleteMany({ where: { companyId } });

  const reservationIds = await idsOf('stockReservation', { companyId });
  await prisma.stockReservationLine.deleteMany({ where: { reservationId: { in: reservationIds } } });
  await prisma.stockReservation.deleteMany({ where: { companyId } });

  const snapshotIds = await idsOf('stockValuationSnapshot', { companyId });
  await prisma.stockValuationSnapshotLine.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
  await prisma.stockValuationSnapshot.deleteMany({ where: { companyId } });

  await prisma.productionBatch.deleteMany({ where: { companyId } });

  const wastageIds = await idsOf('stockWastage', { companyId });
  await prisma.stockWastageLine.deleteMany({ where: { wastageId: { in: wastageIds } } });
  await prisma.stockWastage.deleteMany({ where: { companyId } });

  const countIds = await idsOf('stockCount', { companyId });
  await prisma.stockCountLine.deleteMany({ where: { countId: { in: countIds } } });
  await prisma.stockCount.deleteMany({ where: { companyId } });

  await prisma.saleStockReturn.deleteMany({ where: { companyId } });
  await prisma.saleConsumption.deleteMany({ where: { companyId } });
  await prisma.recipeModifierAdjustment.deleteMany({ where: { companyId } });
  await prisma.recipeProductLink.deleteMany({ where: { companyId } });
  const recipeIds = await idsOf('recipe', { companyId });
  const versionIds = await idsOf('recipeVersion', { recipeId: { in: recipeIds } });
  await prisma.recipeLine.deleteMany({ where: { versionId: { in: versionIds } } });
  await prisma.recipeVersion.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await prisma.recipe.deleteMany({ where: { companyId } });

  const returnIds = await idsOf('purchaseReturn', { companyId });
  await prisma.purchaseReturnLine.deleteMany({ where: { returnId: { in: returnIds } } });
  await prisma.purchaseReturn.deleteMany({ where: { companyId } });

  const grnIds = await idsOf('goodsReceipt', { companyId });
  await prisma.goodsReceiptLandedCost.deleteMany({ where: { grnId: { in: grnIds } } });
  await prisma.goodsReceiptLine.deleteMany({ where: { grnId: { in: grnIds } } });
  await prisma.goodsReceipt.deleteMany({ where: { companyId } });

  const poIds = await idsOf('purchaseOrder', { companyId });
  await prisma.purchaseOrderLine.deleteMany({ where: { poId: { in: poIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { companyId } });

  await prisma.supplierItemPrice.deleteMany({ where: { companyId } });
  await prisma.stockBatchOpening.deleteMany({ where: { companyId } });
  await prisma.stockBatchBalance.deleteMany({ where: { companyId } });
  await prisma.stockMovement.deleteMany({ where: { companyId } });
  await prisma.stockBalance.deleteMany({ where: { companyId } });
  await prisma.stockBatch.deleteMany({ where: { companyId } });
  await prisma.supplier.deleteMany({ where: { companyId } });
  await prisma.stockReorderRule.deleteMany({ where: { companyId } });
  await prisma.inventoryDocCounter.deleteMany({ where: { companyId } });
  await prisma.inventorySettings.deleteMany({ where: { companyId } });
  await prisma.inventoryLocationAccess.deleteMany({ where: { companyId } });

  const itemIds = await idsOf('inventoryItem', { companyId });
  await prisma.inventoryItemUnit.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { companyId } });
  // Sublocations hold a parent key, so they go before the locations they hang
  // off; a warehouse freezer outliving its warehouse is a foreign key error.
  await prisma.inventoryLocation.deleteMany({ where: { companyId, parentId: { not: null } } });
  await prisma.inventoryLocation.deleteMany({ where: { companyId } });

  // --- the POS side of the same tenant ---
  const orderIds = await idsOf('order', { companyId });
  const intentIds = await idsOf('paymentIntent', { orderId: { in: orderIds } });
  await prisma.dayClose.deleteMany({ where: { companyId } });
  await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.gatewayWebhookEvent.deleteMany({ where: { intentId: { in: intentIds } } });
  await prisma.paymentIntent.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.kot.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { companyId } });

  const branchIds = await idsOf('branch', { companyId });
  await prisma.invoiceCounter.deleteMany({ where: { branchId: { in: branchIds } } });
  await prisma.diningTable.deleteMany({ where: { branchId: { in: branchIds } } });

  const productIds = await idsOf('product', { companyId });
  await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.product.deleteMany({ where: { companyId } });
  await prisma.category.deleteMany({ where: { companyId } });
  await prisma.taxRate.deleteMany({ where: { companyId } });
  await prisma.posAuditLog.deleteMany({ where: { companyId } });

  const userIds = await idsOf('posUser', { companyId });
  await prisma.posSession.deleteMany({ where: { userId: { in: userIds } } });
  const licenseIds = await idsOf('license', { companyId });
  await prisma.licenseAddon.deleteMany({ where: { licenseId: { in: licenseIds } } });
  await prisma.license.deleteMany({ where: { companyId } });
  await prisma.discountPolicy.deleteMany({ where: { companyId } });
  await prisma.posUser.deleteMany({ where: { companyId } });
  await prisma.branch.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
};

/* ------------------------------------------------------------ tenant build */

// The company, its branches, its people and its menu. These have no inventory
// API to create them through — a company cannot bootstrap itself over HTTP —
// so they are the only rows this script writes directly.
const buildTenant = async () => {
  const passwordHash = await hashPassword(PASSWORD);
  const company = await prisma.company.create({
    data: {
      name: 'VEXO Pilot Foods (Pilot)',
      slug: SLUG,
      status: 'ACTIVE',
      isDemo: true,
      contactName: 'Pilot Contact',
      contactEmail: 'pilot@pilot.invalid',
      city: 'New Delhi',
      state: 'Delhi',
    },
  });
  await prisma.license.create({
    data: {
      companyId: company.id,
      plan: 'MULTI_STORE',
      status: 'ACTIVE',
      expiresAt: days(365),
      baseBranchLimit: 10,
      notes: 'Inventory pilot tenant — synthetic data, not a commercial licence',
    },
  });

  const north = await prisma.branch.create({
    data: { companyId: company.id, name: 'Pilot Kitchen — North', code: 'PN', isDemo: true, city: 'New Delhi', state: 'Delhi' },
  });
  const south = await prisma.branch.create({
    data: { companyId: company.id, name: 'Pilot Kitchen — South', code: 'PS', isDemo: true, city: 'Gurugram', state: 'Haryana' },
  });

  const mkUser = (email, fullName, role, branchId = null) =>
    prisma.posUser.create({
      data: { companyId: company.id, branchId, email, fullName, role, passwordHash, mustChangePassword: false },
    });

  const owner = await mkUser('pilot.owner@pilot.invalid', 'Pilot Owner', 'CUSTOMER_OWNER');
  const mgrN = await mkUser('pilot.north@pilot.invalid', 'North Manager', 'BRANCH_MANAGER', north.id);
  const mgrS = await mkUser('pilot.south@pilot.invalid', 'South Manager', 'BRANCH_MANAGER', south.id);
  const cashier = await mkUser('pilot.cashier@pilot.invalid', 'North Cashier', 'CASHIER', north.id);

  // Two dishes, on purpose: one fully costed, one deliberately left without an
  // active recipe version so its sales have to show as uncosted.
  const gst5 = await prisma.taxRate.create({ data: { companyId: company.id, name: 'GST 5%', ratePercent: 5 } });
  const mains = await prisma.category.create({ data: { companyId: company.id, name: 'Mains', sortOrder: 1 } });
  const drinks = await prisma.category.create({ data: { companyId: company.id, name: 'Drinks', sortOrder: 2 } });
  const biryani = await prisma.product.create({
    data: { companyId: company.id, sku: 'BIR-01', name: 'Paneer Biryani', categoryId: mains.id, basePrice: 320, taxRateId: gst5.id },
  });
  const chai = await prisma.product.create({
    data: { companyId: company.id, sku: 'CHA-01', name: 'Masala Chai', categoryId: drinks.id, basePrice: 60, taxRateId: gst5.id },
  });
  for (const [name, capacity] of [['T1', 2], ['T2', 4], ['T3', 6]]) {
    await prisma.diningTable.create({ data: { branchId: north.id, name, capacity } });
  }

  return { company, north, south, owner, mgrN, mgrS, cashier, biryani, chai };
};

/* -------------------------------------------------------------------- walk */

const main = async () => {
  log();
  log('VEXO Connect — inventory acceptance pilot');
  log(`database: ${dbName}`);

  const existing = await prisma.company.findUnique({ where: { slug: SLUG } });
  if (existing) {
    log(`existing pilot tenant found (${SLUG}); removing it and rebuilding`);
    await removeCompany(existing.id);
  }

  const fx = await buildTenant();
  const token = {
    owner: await login(fx.owner.email),
    north: await login(fx.mgrN.email),
    south: await login(fx.mgrS.email),
    cashier: await login(fx.cashier.email),
  };
  const asOwner = { token: token.owner };
  const asNorth = { token: token.north };
  const asSouth = { token: token.south };

  const stockAt = async (locationId, itemId) =>
    (await get(`${API}/stock/${locationId}/${itemId}`, asOwner)).state;

  log();
  log('Reference data');

  const mkLocation = async (body) => (await post(`${API}/locations`, { ...asOwner, body, expect: 201 })).location;
  const warehouse = await mkLocation({ kind: 'WAREHOUSE', name: 'Main Warehouse', code: 'WH-MAIN', storageKind: 'DRY' });
  const freezer = await mkLocation({
    kind: 'WAREHOUSE',
    name: 'Warehouse freezer',
    code: 'WH-FRZ',
    parentId: warehouse.id,
    storageKind: 'FROZEN',
  });
  const roomN = await mkLocation({ kind: 'STORE', name: 'North store room', code: 'PN-ROOM', branchId: fx.north.id, isSaleSource: true });
  const roomS = await mkLocation({ kind: 'STORE', name: 'South store room', code: 'PS-ROOM', branchId: fx.south.id, isSaleSource: true });
  const kitchen = await mkLocation({ kind: 'CENTRAL_KITCHEN', name: 'Central kitchen', code: 'CK-1', storageKind: 'KITCHEN' });
  step(`5 locations: ${[warehouse, freezer, roomN, roomS, kitchen].map((l) => l.code).join(', ')}`);

  // North's manager may dispatch and approve at the warehouse but NOT receive
  // there. South's manager gets nothing, which is what makes the cross-store
  // refusals below real tests rather than coincidences.
  await put(`${API}/locations/${warehouse.id}/access`, {
    ...asOwner,
    body: { userId: fx.mgrN.id, canDispatch: true, canApprove: true },
  });
  step('warehouse access granted to the North manager: dispatch and approve, deliberately not receive');

  await put(`${API}/locations/${warehouse.id}/access`, {
    ...asOwner,
    body: { userId: fx.cashier.id, canDispatch: true },
    expect: 400,
  });
  step('REFUSED as expected: a cashier cannot be granted inventory access at a location');

  const mkItem = async (body) => (await post(`${API}/items`, { ...asOwner, body, expect: 201 })).item;
  const rice = await mkItem({ kind: 'RAW', name: 'Basmati Rice', sku: 'RAW-RICE', baseUnit: 'G', trackBatches: true, trackExpiry: true, minShelfLifeDaysAtReceipt: 30 });
  const oil = await mkItem({ kind: 'RAW', name: 'Sunflower Oil', sku: 'RAW-OIL', baseUnit: 'ML', trackBatches: true, trackExpiry: true, openedShelfLifeHours: 72 });
  const milk = await mkItem({ kind: 'RAW', name: 'Full Cream Milk', sku: 'RAW-MILK', baseUnit: 'ML', trackBatches: true, trackExpiry: true, minShelfLifeDaysAtReceipt: 2 });
  const paneer = await mkItem({ kind: 'RAW', name: 'Paneer', sku: 'RAW-PANEER', baseUnit: 'G', trackBatches: true, trackExpiry: true, minShelfLifeDaysAtReceipt: 3 });
  const chicken = await mkItem({ kind: 'RAW', name: 'Whole Chicken', sku: 'RAW-CHKN', baseUnit: 'PCS', trackBatches: true, trackExpiry: true, variableWeight: true, weightUnit: 'G' });
  const box = await mkItem({ kind: 'PACKAGING', name: 'Takeaway Box', sku: 'PKG-BOX', baseUnit: 'PCS' });
  const premix = await mkItem({ kind: 'SEMI_FINISHED', name: 'Chai Premix', sku: 'SF-PREMIX', baseUnit: 'G', trackBatches: true, trackExpiry: true });
  step('7 items stocked in grams, millilitres and pieces — one variable-weight, one packaging');

  const mkUnit = (itemId, name, quantityInBaseUnit) =>
    post(`${API}/items/${itemId}/units`, { ...asOwner, body: { name, quantityInBaseUnit }, expect: 201 });
  await mkUnit(rice.id, 'sack', '25000');
  await mkUnit(oil.id, 'tin', '15000');
  await mkUnit(milk.id, 'crate', '12000');
  await mkUnit(box.id, 'carton', '100');
  step('item-specific packing units: sack 25 kg, tin 15 l, crate 12 l, carton 100 pcs');

  await post(`${API}/items/${rice.id}/units`, { ...asOwner, body: { name: 'kg', quantityInBaseUnit: '25000' }, expect: [400, 409] });
  step('REFUSED as expected: "kg" cannot be redefined to mean 25 kg');

  await post(`${API}/items`, { ...asNorth, body: { kind: 'RAW', name: 'Unauthorised Item', baseUnit: 'G' }, expect: 403 });
  step('REFUSED as expected: a branch manager cannot create an item on a direct API call');

  const supplier = (
    await post(`${API}/suppliers`, {
      ...asOwner,
      body: {
        name: 'Sunrise Foods',
        code: 'SUNRISE',
        gstin: '07AABCS1429B1ZQ',
        contactName: 'Pilot Supplier Desk',
        email: 'orders@sunrise.invalid',
        paymentTermsDays: 15,
      },
      expect: 201,
    })
  ).supplier;
  await put(`${API}/settings`, { ...asOwner, body: { purchaseTaxIsCost: true, staleCostDays: 60 } });
  step(`supplier ${supplier.name} recorded; purchase tax treated as cost, stale-cost window 60 days`);

  log();
  log('Receiving');

  const po = (
    await post(`${API}/purchase-orders`, {
      ...asOwner,
      body: {
        supplierId: supplier.id,
        locationId: warehouse.id,
        expectedAt: days(1),
        note: 'Opening order for the pilot walk',
        lines: [
          { itemId: rice.id, unit: 'sack', qty: '4', unitPricePaise: 145000, taxPctMilli: 5000 },
          { itemId: oil.id, unit: 'tin', qty: '6', unitPricePaise: 198000, taxPctMilli: 5000 },
          { itemId: milk.id, unit: 'crate', qty: '10', unitPricePaise: 64000, taxPctMilli: 5000 },
          { itemId: box.id, unit: 'carton', qty: '5', unitPricePaise: 35000, taxPctMilli: 18000 },
        ],
      },
      expect: 201,
    })
  ).purchaseOrder;
  await post(`${API}/purchase-orders/${po.id}/approve`, asOwner);
  const poFull = (await get(`${API}/purchase-orders/${po.id}`, asOwner)).purchaseOrder;
  step(`purchase order ${po.number} approved: ${poFull.lines.length} lines, ${rupees(poFull.totalPaise)} including tax`);

  await post(`${API}/goods-receipts`, {
    ...asOwner,
    body: {
      supplierId: supplier.id,
      locationId: warehouse.id,
      poId: po.id,
      idempotencyKey: key('grn-short'),
      lines: [
        { itemId: rice.id, poLineId: poFull.lines[0].id, unit: 'sack', qty: '1', unitPricePaise: 145000, batchCode: 'RICE-SHORT', expiryDate: days(10) },
      ],
    },
    expect: 409,
  });
  step('REFUSED as expected: rice arriving 10 days before expiry fails the item\'s 30-day minimum shelf life at receipt');

  const grn1 = (
    await post(`${API}/goods-receipts`, {
      ...asOwner,
      body: {
        supplierId: supplier.id,
        locationId: warehouse.id,
        poId: po.id,
        supplierInvoiceNo: 'SUN/2026/0041',
        supplierInvoiceDate: days(0),
        idempotencyKey: key('grn-main'),
        lines: [
          { itemId: rice.id, poLineId: poFull.lines[0].id, unit: 'sack', qty: '2', unitPricePaise: 145000, taxPctMilli: 5000, batchCode: 'RICE-A', supplierBatchCode: 'SF/R/9001', expiryDate: days(400) },
          { itemId: rice.id, poLineId: poFull.lines[0].id, unit: 'sack', qty: '2', unitPricePaise: 149000, taxPctMilli: 5000, batchCode: 'RICE-B', supplierBatchCode: 'SF/R/9002', expiryDate: days(210) },
          { itemId: oil.id, poLineId: poFull.lines[1].id, unit: 'tin', qty: '6', unitPricePaise: 198000, taxPctMilli: 5000, batchCode: 'OIL-1', expiryDate: days(300) },
          { itemId: milk.id, poLineId: poFull.lines[2].id, unit: 'crate', qty: '6', unitPricePaise: 64000, taxPctMilli: 5000, batchCode: 'MILK-1', expiryDate: days(9) },
          { itemId: milk.id, poLineId: poFull.lines[2].id, unit: 'crate', qty: '4', unitPricePaise: 64000, taxPctMilli: 5000, batchCode: 'MILK-2', expiryDate: days(4) },
          { itemId: box.id, poLineId: poFull.lines[3].id, unit: 'carton', qty: '5', unitPricePaise: 35000, taxPctMilli: 18000 },
        ],
      },
      expect: 201,
    })
  ).goodsReceipt;
  step(`goods receipt ${grn1.number} against ${po.number}: 6 lines, 5 batches, two expiry dates each for rice and milk`);

  const grn2 = (
    await post(`${API}/goods-receipts`, {
      ...asOwner,
      body: {
        supplierId: supplier.id,
        locationId: warehouse.id,
        directReason: 'Chilled delivery arrived ahead of its purchase order and was accepted on the dock',
        idempotencyKey: key('grn-direct'),
        lines: [
          { itemId: paneer.id, unit: 'kg', qty: '4', unitPricePaise: 38000, batchCode: 'PAN-1', expiryDate: days(12) },
          { itemId: premix.id, unit: 'kg', qty: '2', unitPricePaise: 52000, batchCode: 'MIX-1', expiryDate: days(120) },
        ],
      },
      expect: 201,
    })
  ).goodsReceipt;
  step(`direct receipt ${grn2.number} accepted by the owner with a written reason and no purchase order`);

  const grn3 = (
    await post(`${API}/goods-receipts`, {
      ...asOwner,
      body: {
        supplierId: supplier.id,
        locationId: freezer.id,
        directReason: 'Frozen poultry weighed in on the dock scale on arrival',
        idempotencyKey: key('grn-chkn'),
        lines: [
          { itemId: chicken.id, unit: 'pcs', qty: '6', unitPricePaise: 27000, batchCode: 'CHK-1', expiryDate: days(45), measuredWeight: '9420' },
        ],
      },
      expect: 201,
    })
  ).goodsReceipt;
  step(`variable-weight receipt ${grn3.number}: 6 birds counted, 9,420 g weighed, booked into the freezer`);

  // A delivery that cost money to get here. The charges are deliberately an odd
  // total over two unequal lines, so the division does not come out whole and
  // the receipt is a real test of the apportionment rather than a decorative
  // one: 10001 paise over goods of 114000 and 52000 truncates to 6868 + 3132,
  // which is 10000, and the paise that truncation drops has to be handed back.
  const grn4 = (
    await post(`${API}/goods-receipts`, {
      ...asOwner,
      body: {
        supplierId: supplier.id,
        locationId: warehouse.id,
        supplierInvoiceNo: 'SUN/2026/0058',
        supplierInvoiceDate: days(0),
        directReason: 'Chilled top-up brought in by road freight, billed separately by the transporter',
        idempotencyKey: key('grn-landed'),
        lines: [
          { itemId: paneer.id, unit: 'kg', qty: '3', unitPricePaise: 38000, batchCode: 'PAN-2', expiryDate: days(14) },
          { itemId: premix.id, unit: 'kg', qty: '1', unitPricePaise: 52000, batchCode: 'MIX-2', expiryDate: days(150) },
        ],
        landedCosts: [
          { kind: 'FREIGHT', description: 'Refrigerated road freight, Sunrise depot to warehouse', amountPaise: 7500 },
          { kind: 'UNLOADING', description: 'Dock labour, two hands for forty minutes', amountPaise: 2501 },
        ],
      },
      expect: 201,
    })
  ).goodsReceipt;

  // The pilot checks the arithmetic rather than reporting that a document was
  // created. A receipt whose header says one thing and whose lines say another
  // is the exact defect this receipt exists to catch, so the walk fails here
  // rather than printing a number nobody adds up.
  const grn4Full = (await get(`${API}/goods-receipts/${grn4.id}`, asOwner)).goodsReceipt;
  const shareTotal = grn4Full.lines.reduce((a, l) => a + BigInt(l.landedCostPaise), 0n);
  if (shareTotal !== BigInt(grn4Full.landedCostPaise)) {
    fail(
      `landed cost was lost in apportionment: lines carry ${shareTotal} paise but the receipt charges ${grn4Full.landedCostPaise}`,
    );
  }
  const valueTotal = grn4Full.lines.reduce((a, l) => a + BigInt(l.valuePaise), 0n);
  if (valueTotal !== BigInt(grn4Full.stockValuePaise)) {
    fail(`stock value disagrees with its own lines: ${valueTotal} against ${grn4Full.stockValuePaise}`);
  }
  step(
    `landed-cost receipt ${grn4.number}: ${rupees(grn4Full.landedCostPaise)} of freight and unloading spread over 2 lines as ` +
      `${grn4Full.lines.map((l) => l.landedCostPaise).join(' + ')} = ${shareTotal} paise, losing nothing`,
  );

  // A second order, approved and left open, so the receiving screen has work
  // on it — and so the refusal below is genuinely about the missing receive
  // right rather than about the direct-receipt rule.
  const po2 = (
    await post(`${API}/purchase-orders`, {
      ...asOwner,
      body: {
        supplierId: supplier.id,
        locationId: warehouse.id,
        expectedAt: days(2),
        note: 'Mid-week chilled top-up, awaiting delivery',
        lines: [
          { itemId: paneer.id, unit: 'kg', qty: '3', unitPricePaise: 38000, taxPctMilli: 5000 },
          { itemId: premix.id, unit: 'kg', qty: '2', unitPricePaise: 52000, taxPctMilli: 5000 },
        ],
      },
      expect: 201,
    })
  ).purchaseOrder;
  await post(`${API}/purchase-orders/${po2.id}/approve`, asOwner);
  const po2Full = (await get(`${API}/purchase-orders/${po2.id}`, asOwner)).purchaseOrder;
  step(`purchase order ${po2.number} approved and left outstanding, so the receiving screen is not empty`);

  await post(`${API}/goods-receipts`, {
    ...asNorth,
    body: {
      supplierId: supplier.id,
      locationId: warehouse.id,
      poId: po2.id,
      idempotencyKey: key('grn-denied'),
      lines: [{ itemId: paneer.id, poLineId: po2Full.lines[0].id, unit: 'kg', qty: '3', unitPricePaise: 38000, batchCode: 'PAN-X', expiryDate: days(14) }],
    },
    expect: [403, 404],
  });
  step('REFUSED as expected: the North manager may dispatch from the warehouse but not receive into it');

  log();
  log('Batches, expiry and containment');

  const milkBatches = (await get(`${API}/batches`, { ...asOwner, query: { itemId: milk.id } })).batches;
  const milk2 = milkBatches.find((b) => b.batchCode === 'MILK-2');
  await post(`${API}/batches/${milk2.id}/quarantine`, {
    ...asOwner,
    body: { reason: 'Seals on two crates looked disturbed on the pallet; held pending supplier confirmation' },
  });
  const held = await stockAt(warehouse.id, milk.id);
  await post(`${API}/batches/${milk2.id}/release`, {
    ...asOwner,
    body: { reason: 'Supplier confirmed the seals were intact at loading; released back to available' },
  });
  const releasedState = await stockAt(warehouse.id, milk.id);
  step(
    `MILK-2 quarantined: usable fell to ${held.usable} of ${held.physical} ml while the stock stayed on the shelf; ` +
      `released again at ${releasedState.usable} ml usable`,
  );

  const oilBatch = (await get(`${API}/batches`, { ...asOwner, query: { itemId: oil.id } })).batches[0];
  const opened = await post(`${API}/batches/open`, {
    ...asOwner,
    body: { locationId: warehouse.id, batchId: oilBatch.id, qty: '15000', note: 'One tin opened for the kitchen' },
    expect: 201,
  });
  step(
    `one 15 l tin of ${oilBatch.batchCode} opened: use by ${ymd(opened.opening.useByAt)}, ` +
      `while the sealed tins keep their own ${ymd(opened.batchExpiryDate)} date`,
  );

  log();
  log('Store request — North');

  const req1 = (
    await post(`${API}/requests`, {
      ...asNorth,
      body: {
        destinationLocationId: roomN.id,
        sourceLocationId: warehouse.id,
        requiredBy: days(2),
        priority: 'NORMAL',
        reason: 'Weekly top-up for the North kitchen',
        idempotencyKey: key('req-north'),
        submit: true,
        lines: [
          { itemId: rice.id, qty: '15', unit: 'kg' },
          { itemId: oil.id, qty: '2', unit: 'tin' },
          { itemId: milk.id, qty: '3', unit: 'crate' },
          { itemId: paneer.id, qty: '2', unit: 'kg' },
          { itemId: box.id, qty: '1', unit: 'carton' },
        ],
      },
      expect: 201,
    })
  ).request;
  const atSubmit = await stockAt(warehouse.id, rice.id);
  step(
    `request ${req1.number} submitted with ${req1.lines.length} lines; warehouse rice still ` +
      `${atSubmit.physical} g physical and ${atSubmit.reserved} g reserved — submitting moves nothing`,
  );

  await post(`${API}/requests/${req1.id}/decide`, {
    ...asNorth,
    body: { lines: req1.lines.map((l) => ({ lineId: l.id, approvedQty: l.requestedQty })) },
    expect: 403,
  });
  step('REFUSED as expected: the manager who raised the request cannot be the one who approves it');

  const decided = (
    await post(`${API}/requests/${req1.id}/decide`, {
      ...asOwner,
      body: {
        note: 'Rice cut back to what the warehouse can spare before the next delivery',
        lines: req1.lines.map((l) => ({
          lineId: l.id,
          approvedQty: l.item.id === rice.id ? '12000.000' : l.requestedQty,
          ...(l.item.id === rice.id ? { rejectedReason: 'Warehouse holding the balance for the South kitchen' } : {}),
        })),
      },
    })
  ).request;
  const afterDecision = await stockAt(warehouse.id, rice.id);
  step(
    `${decided.status.replace('_', ' ').toLowerCase()}: rice approved at 12,000 g of 15,000 g asked for; ` +
      `warehouse rice unchanged at ${afterDecision.physical} g — a decision is not a promise of stock`,
  );

  await post(`${API}/requests/${req1.id}/allocate`, asNorth);
  const allocatedState = await stockAt(warehouse.id, rice.id);
  step(
    `allocated: rice reserved ${allocatedState.reserved} g, still physically ${allocatedState.physical} g, ` +
      `available ${allocatedState.available} g`,
  );

  const transfer = (
    await post(`${API}/requests/${req1.id}/dispatch`, {
      ...asNorth,
      body: { note: 'Loaded on the 07:30 van', idempotencyKey: key('dispatch') },
      expect: 201,
    })
  ).transfer;
  const dispatchedState = await stockAt(warehouse.id, rice.id);
  const transferFull = (await get(`${API}/transfers/${transfer.id}`, asOwner)).transfer;
  step(
    `transfer ${transfer.number} dispatched: warehouse rice down to ${dispatchedState.physical} g, ` +
      `${dispatchedState.inTransitOut} g in transit, nothing on the North shelf yet`,
  );

  const lineFor = (itemId) => transferFull.lines.find((l) => l.item.id === itemId);
  const riceLine = lineFor(rice.id);
  const milkLine = lineFor(milk.id);
  const receipt = await post(`${API}/transfers/${transfer.id}/receive`, {
    ...asNorth,
    body: {
      note: 'Checked in at the North door',
      idempotencyKey: key('receive'),
      lines: transferFull.lines.map((l) => {
        if (l.id === riceLine.id) return { transferLineId: l.id, acceptedQty: '11000.000', note: 'One bag short off the van' };
        if (l.id === milkLine.id) {
          return { transferLineId: l.id, acceptedQty: '30000.000', damagedQty: '6000.000', note: 'Half a crate split in transit' };
        }
        return { transferLineId: l.id, acceptedQty: l.dispatchedQty };
      }),
    },
  });
  const riceAtStore = await stockAt(roomN.id, rice.id);
  step(
    `received at ${roomN.code}: rice ${riceAtStore.physical} g on the shelf, ` +
      `${receipt.issues.length} issue(s) raised (${receipt.issues.map((i) => i.kind.toLowerCase()).join(', ')}), ` +
      `request now ${receipt.requestStatus.replace('_', ' ').toLowerCase()}`,
  );

  const openIssues = (await get(`${API}/issues`, asOwner)).issues;
  const damage = openIssues.find((i) => i.kind === 'DAMAGE');
  if (damage) {
    await post(`${API}/issues/${damage.id}/resolve`, {
      ...asOwner,
      body: { resolution: 'WRITTEN_OFF', note: 'Split milk crate written off; no supplier credit pursued for one crate' },
    });
  }
  step(`${openIssues.length} open issue(s) after the receipt; the damage one resolved as written off`);

  const closed = (
    await post(`${API}/requests/${req1.id}/close`, {
      ...asOwner,
      body: {
        reason: 'Outstanding rice cancelled — the North kitchen is covered until the next delivery',
        cancelOutstanding: true,
      },
    })
  ).request;
  step(`request ${req1.number} closed as ${closed.status.replace('_', ' ').toLowerCase()} with the shortfall explicitly cancelled`);

  log();
  log('Store request — South, left waiting on purpose');

  const req2 = (
    await post(`${API}/requests`, {
      ...asSouth,
      body: {
        destinationLocationId: roomS.id,
        sourceLocationId: warehouse.id,
        requiredBy: days(3),
        priority: 'HIGH',
        reason: 'Opening stock for the South kitchen',
        idempotencyKey: key('req-south'),
        submit: true,
        lines: [
          { itemId: rice.id, qty: '10', unit: 'kg' },
          { itemId: oil.id, qty: '1', unit: 'tin' },
          { itemId: paneer.id, qty: '1', unit: 'kg' },
        ],
      },
      expect: 201,
    })
  ).request;
  step(`request ${req2.number} submitted and left awaiting a decision, so the approval queue is not empty`);

  await get(`${API}/stock`, { ...asSouth, query: { locationId: warehouse.id }, expect: [403, 404] });
  step('REFUSED as expected: the South manager cannot read warehouse stock they hold no grant at');

  log();
  log('Planned requests and reminders');

  // Raised before the plan is read on purpose. An unapproved request is a
  // hope, not a delivery, and the suggestion below has to say so.
  const reqPending = (
    await post(`${API}/requests`, {
      ...asNorth,
      body: {
        destinationLocationId: roomN.id,
        sourceLocationId: warehouse.id,
        requiredBy: days(2),
        reason: 'Top-up raised but not yet decided',
        idempotencyKey: key('req-pending'),
        submit: true,
        lines: [{ itemId: rice.id, qty: '1', unit: 'kg' }],
      },
      expect: 201,
    })
  ).request;
  step(`request ${reqPending.number} raised at ${roomN.code} for 1 kg of rice and left undecided on purpose`);

  const planned = await post(`${API}/plans`, {
    ...asOwner,
    body: {
      name: 'North daily replenishment',
      destinationLocationId: roomN.id,
      sourceLocationId: warehouse.id,
      timezone: 'Asia/Kolkata',
      deliveryDays: [1, 2, 3, 4, 5, 6],
      cutoffMinute: 600,
      requiredByMinute: 1020,
      leadTimeDays: 1,
      coverDays: 3,
      autoSubmit: false,
      lines: [
        { itemId: rice.id, minQty: '8000', targetQty: '20000', safetyQty: '2000' },
        { itemId: oil.id, minQty: '10000', targetQty: '30000', safetyQty: '5000' },
        { itemId: milk.id, minQty: '12000', targetQty: '36000', safetyQty: '6000' },
        // Below its minimum: the store took 2 kg and burns through it.
        { itemId: paneer.id, minQty: '3000', targetQty: '8000', safetyQty: '1000' },
        // Packaging runs out like anything else, and the plan has to say so.
        { itemId: box.id, minQty: '200', targetQty: '1000', safetyQty: '100' },
      ],
    },
    expect: 201,
  });
  const plan = planned.plan;
  const suggestion = await get(`${API}/plans/${plan.id}/suggestion`, asOwner);
  const nonZero = (q) => q && Number(q) > 0;
  const suggested = suggestion.lines.filter((l) => nonZero(l.suggestedQty));
  if (!suggested.length) {
    const why = suggestion.lines
      .map(
        (l) =>
          `${l.item.name}: available ${l.reason.available}, min ${l.reason.minQty} + safety ${l.reason.safetyQty}, ` +
          `projected ${l.reason.projectedAtDelivery}, triggered ${l.reason.triggered}, suppressed ${l.suppressed ?? 'no'}`,
      )
      .join('\n      ');
    throw new Error(`the plan suggested nothing at all; the pilot cannot demonstrate replenishment\n      ${why}`);
  }
  step(
    `plan "${plan.name}" created for ${roomN.code}; next cutoff ${planned.cycle ? ymd(planned.cycle.cutoffAt) : 'n/a'}, ` +
      `${suggested.length} of ${suggestion.lines.length} line(s) suggest an order: ` +
      suggested.map((l) => `${l.item.name} ${l.suggestedQty}`).join(', '),
  );

  // §6, stated as arithmetic rather than as a claim: the projection counts
  // stock in transit and stock already approved, and pointedly does not count
  // the 1 kg still sitting in an approval queue.
  const riceSuggestion = suggestion.lines.find((l) => l.itemId === rice.id);
  if (!riceSuggestion) throw new Error('the rice line is missing from the suggestion');
  const r = riceSuggestion.reason;
  if (!nonZero(r.awaitingApproval)) {
    throw new Error(`expected rice to show an unapproved request awaiting approval, saw "${r.awaitingApproval}"`);
  }
  const daily = r.dailyConsumption === null ? 0 : Number(r.dailyConsumption);
  const expectedProjection =
    Number(r.available) + Number(r.inTransit) + Number(r.approvedNotDispatched) - daily * Number(r.leadTimeDays);
  const drift = Math.abs(expectedProjection - Number(r.projectedAtDelivery));
  if (drift > 1) {
    throw new Error(
      `projected-at-delivery does not reconcile: available ${r.available} + in transit ${r.inTransit} + approved ` +
        `${r.approvedNotDispatched} - ${daily}/day over ${r.leadTimeDays} day(s) = ${expectedProjection}, ` +
        `but the API said ${r.projectedAtDelivery}`,
    );
  }
  // The decisive check: had the unapproved kilo been treated as incoming, the
  // projection would have been exactly that much higher.
  if (Number(r.projectedAtDelivery) >= expectedProjection + Number(r.awaitingApproval)) {
    throw new Error('the projection counted an unapproved request as incoming stock');
  }
  step(
    `suggestion is interrogable: rice available ${r.available}, in transit ${r.inTransit}, approved-not-dispatched ` +
      `${r.approvedNotDispatched}, ${r.dailyConsumption ?? 'no measured'} consumption/day over ${r.leadTimeDays} ` +
      `day(s) lead time, projected ${r.projectedAtDelivery} — the ${r.awaitingApproval} awaiting approval is ` +
      `reported but deliberately NOT counted as incoming stock`,
  );

  const tick = (await post(`${API}/scheduler/tick`, { ...asOwner, expect: [200, 202] })).result;
  if (tick.errors.length) throw new Error(`scheduler reported errors: ${JSON.stringify(tick.errors)}`);
  step(
    `scheduler pass over ${tick.plans} plan(s): ${tick.reminders} reminder(s) raised, ${tick.notified} notified, ` +
      `${tick.errors.length} error(s)`,
  );

  // Reminders are routed to whoever can actually act, which is the manager
  // holding the grant — not the owner, who is only ever the backstop. So the
  // inbox worth checking is the assignee's.
  // The default board deliberately shows only what is still worth chasing.
  const live = (await get(`${API}/reminders`, asOwner)).reminders;
  const inbox = await get(`${API}/notifications`, asNorth);
  const undelivered = (inbox.notifications ?? []).filter((n) => n.state !== 'DELIVERED');
  if (!live.length) throw new Error('no live reminders were raised; the reminder board would be empty');
  if (!inbox.unread) throw new Error('reminders were raised but nobody was notified');
  if (undelivered.length) {
    throw new Error(`${undelivered.length} notification(s) failed to deliver: ${undelivered.map((n) => n.lastError).join('; ')}`);
  }
  step(
    `reminder board holds ${live.length} live reminder(s) (${[...new Set(live.map((r) => r.kind))].join(', ')}); ` +
      `the assignee's in-app inbox has ${inbox.unread} unread and 0 failed deliveries — no external message was sent`,
  );

  // §6's other half: a reminder about something that has since been dealt with
  // must stop chasing. These were raised while the North request was moving and
  // retired by its own status changes, not by a sweep.
  const obsolete = (await get(`${API}/reminders`, { ...asOwner, query: { state: 'OBSOLETE' } })).reminders;
  if (!obsolete.length) throw new Error('no reminder was ever retired; obsolete reminders are not being stopped');
  step(
    `${obsolete.length} reminder(s) retired as obsolete by the status changes that settled them ` +
      `(${[...new Set(obsolete.map((r) => r.kind))].join(', ')}) — kept, not deleted, so "why did nobody chase this" has an answer`,
  );

  log();
  log('Counts and wastage');

  const countN = (
    await post(`${API}/counts`, {
      ...asNorth,
      body: {
        locationId: roomN.id,
        note: 'Evening shelf count, North kitchen',
        lines: [
          { itemId: rice.id, countedQty: '10600', unit: 'g' },
          { itemId: oil.id, countedQty: '29000', unit: 'ml' },
        ],
      },
      expect: 201,
    })
  ).count;
  step(`count ${countN.number} submitted at ${roomN.code} and left awaiting the owner — counting alone posts nothing`);

  await post(`${API}/counts/${countN.id}/approve`, {
    ...asNorth,
    body: { reason: 'Attempting to approve my own count', idempotencyKey: key('self-approve') },
    expect: 403,
  });
  step('REFUSED as expected: a count cannot be approved by the person who counted it');

  const countW = (
    await post(`${API}/counts`, {
      ...asNorth,
      body: {
        locationId: warehouse.id,
        note: 'Warehouse spot check on the rice bay',
        lines: [{ itemId: rice.id, countedQty: '86000', unit: 'g' }],
      },
      expect: 201,
    })
  ).count;
  const approvedCount = await post(`${API}/counts/${countW.id}/approve`, {
    ...asOwner,
    body: { reason: 'Spot check verified against the bay; variance posted to the ledger', idempotencyKey: key('count-approve') },
  });
  step(
    `count ${countW.number} approved by the owner: ${approvedCount.movementsPosted} variance movement(s) posted, ` +
      `count now ${approvedCount.count.status.toLowerCase()}`,
  );

  const wastage = (
    await post(`${API}/wastage`, {
      ...asNorth,
      body: {
        locationId: roomN.id,
        reason: 'SPOILED',
        note: 'Milk left out of the chiller during the evening rush',
        idempotencyKey: key('wastage'),
        lines: [{ itemId: milk.id, qty: '2000', unit: 'ml' }],
      },
      expect: 201,
    })
  ).wastage;
  // Negative by design: the value is leaving. Reported as a loss, not a cost.
  step(
    `wastage ${wastage.number} written off at ${roomN.code}: a loss of ` +
      `${rupees(String(-BigInt(wastage.totalValuePaise)))}, carrying a reason and an author`,
  );

  log();
  log('Recipes, a sale and a return');

  const biryaniRecipe = (await post(`${API}/recipes`, { ...asOwner, body: { name: 'Paneer Biryani' }, expect: 201 })).recipe;
  const v1 = (
    await post(`${API}/recipes/${biryaniRecipe.id}/versions`, {
      ...asOwner,
      body: {
        yieldPercent: '95',
        outputQty: '1',
        note: 'Opening version for the pilot',
        lines: [
          { itemId: rice.id, qty: '180', unit: 'g' },
          { itemId: oil.id, qty: '20', unit: 'ml' },
          { itemId: paneer.id, qty: '120', unit: 'g' },
        ],
      },
      expect: 201,
    })
  ).version;
  await post(`${API}/recipes/${biryaniRecipe.id}/versions/${v1.id}/activate`, asOwner);
  await post(`${API}/recipes/${biryaniRecipe.id}/links`, { ...asOwner, body: { productId: fx.biryani.id }, expect: 201 });
  step(`recipe "${biryaniRecipe.name}" version ${v1.version} activated and linked to the menu product`);

  const chaiRecipe = (await post(`${API}/recipes`, { ...asOwner, body: { name: 'Masala Chai' }, expect: 201 })).recipe;
  await post(`${API}/recipes/${chaiRecipe.id}/versions`, {
    ...asOwner,
    body: { lines: [{ itemId: premix.id, qty: '18', unit: 'g' }, { itemId: milk.id, qty: '120', unit: 'ml' }] },
    expect: 201,
  });
  await post(`${API}/recipes/${chaiRecipe.id}/links`, { ...asOwner, body: { productId: fx.chai.id }, expect: 201 });
  step('recipe "Masala Chai" linked but left in draft on purpose — its sales must read as uncosted, never as free');

  const riceBeforeSale = await stockAt(roomN.id, rice.id);
  const order = (
    await post('/api/orders', {
      token: token.cashier,
      body: { type: 'TAKEAWAY', items: [{ productId: fx.biryani.id, qty: 2 }, { productId: fx.chai.id, qty: 1 }] },
      expect: 201,
    })
  ).order;
  await post(`/api/orders/${order.id}/bill`, { token: token.cashier });
  const sold = await get(`${API}/sales/consumptions`, { ...asOwner, query: { orderId: order.id } });
  const riceAfterSale = await stockAt(roomN.id, rice.id);
  step(
    `order billed: ${sold.summary.lines} consumption line(s), ${sold.summary.uncostedLines} uncosted, ` +
      `cost of goods ${rupees(sold.summary.costPaise)}; rice at ${roomN.code} ${riceBeforeSale.physical} → ${riceAfterSale.physical} g`,
  );

  const uncosted = sold.consumptions.filter((c) => c.status === 'UNCOSTED');
  step(
    uncosted.length
      ? `the chai line is recorded as uncosted for the reason "${uncosted[0].uncostedReason}" — shown as missing, not as zero cost`
      : 'no uncosted line was produced, which the draft chai recipe was supposed to cause',
  );

  const posted = sold.consumptions.find((c) => c.status === 'POSTED');
  if (posted) {
    await post(`${API}/sales/consumptions/${posted.id}/return`, {
      ...asOwner,
      body: { qty: 1, reason: 'One biryani sent back untouched and returned to the kitchen line', idempotencyKey: key('sale-return') },
      expect: [200, 201],
    });
    const riceAfterReturn = await stockAt(roomN.id, rice.id);
    step(
      `one portion explicitly returned: rice back to ${riceAfterReturn.physical} g — ` +
        'a deliberate stock decision, never a side-effect of refunding money',
    );
  }

  log();
  log('Reports');

  const verify = await get(`${API}/ledger/verify`, asOwner);
  if (!verify.ok) throw new Error(`ledger/verify found ${verify.mismatches.length} cache mismatch(es); the pilot is not clean`);
  step(`ledger check: ${verify.checked} position(s) compared against the movements, 0 mismatches`);

  const valuation = await get(`${API}/valuation`, asOwner);
  step(
    `valuation ${rupees(valuation.totalValuePaise)} across ${valuation.lines.length} position(s); ` +
      `${valuation.linesWithUnknownCost} line(s) with no known cost, stated separately and never folded into the total`,
  );

  const dashboard = await get(`${API}/dashboard`, asOwner);
  step(
    `dashboard: ${dashboard.positions} position(s) worth ${rupees(dashboard.totalValuePaise)}, ` +
      `${dashboard.openRequests} open request(s), ${dashboard.requestsAwaitingApproval} awaiting approval, ` +
      `${dashboard.batchesExpiringIn7Days} batch(es) expiring within 7 days, ` +
      `${dashboard.unresolvedIssues} unresolved issue(s), ${dashboard.remindersOverdue} overdue reminder(s)`,
  );

  const ledger = await get(`${API}/ledger`, { ...asOwner, query: { limit: 500 } });
  const kinds = [...new Set(ledger.movements.map((m) => m.type))].sort();
  step(`stock ledger holds ${ledger.movements.length} movement(s) of ${kinds.length} kinds: ${kinds.join(', ')}`);

  // Answering a recall notice by code: the trail has to name every location the
  // batch reached, not merely confirm the batch exists.
  // RICE-B is the batch FEFO chose, because it expires first. Tracing it walks
  // the whole trail: received at the warehouse, transferred out, received into
  // the store under the SAME batch identity, sold, partly returned.
  const traceB = (await get(`${API}/reports/traceability`, { ...asOwner, query: { batchCode: 'RICE-B' } })).traces ?? [];
  const movesB = traceB.flatMap((t) => t.movements);
  const placesB = [...new Set(traceB.flatMap((t) => t.touchedLocations.map((l) => l.name)))];
  const kindsB = movesB.map((m) => m.type);
  for (const needed of ['GRN', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE_CONSUMPTION']) {
    if (!kindsB.includes(needed)) throw new Error(`RICE-B's trail is missing a ${needed} movement: saw ${kindsB.join(', ')}`);
  }
  if (placesB.length < 2) throw new Error(`RICE-B should have been traced across two locations, saw ${placesB.join(', ')}`);
  step(
    `traceability on RICE-B: ${movesB.length} movement(s) across ${placesB.length} location(s) (${placesB.join(', ')}), ` +
      `covering ${[...new Set(kindsB)].join(', ')} — batch identity survived the transfer, so a recall is answerable by code alone`,
  );

  // The other half of the same proof: the later-expiring batch was left alone.
  const traceA = (await get(`${API}/reports/traceability`, { ...asOwner, query: { batchCode: 'RICE-A' } })).traces ?? [];
  const kindsA = traceA.flatMap((t) => t.movements.map((m) => m.type));
  if (kindsA.some((k) => k !== 'GRN')) {
    throw new Error(`FEFO took from the later-expiring RICE-A: ${kindsA.join(', ')}`);
  }
  step(
    `RICE-A (expiring ${ymd(traceA[0].batch.expiryDate)}) shows only its receipt, while RICE-B ` +
      `(expiring ${ymd(traceB[0].batch.expiryDate)}) was the one drawn down — FEFO by outcome, not by assertion`,
  );

  /* ---------------------------------------------------------------- report */

  log();
  log('Pilot tenant is ready.');
  log();
  log('  company        VEXO Pilot Foods (Pilot)');
  log(`  slug           ${SLUG}`);
  log(`  database       ${dbName}`);
  log('  locations      WH-MAIN (with WH-FRZ), PN-ROOM, PS-ROOM, CK-1');
  log(`  logins         ${fx.owner.email}     owner`);
  log(`                 ${fx.mgrN.email}     North manager — warehouse dispatch and approve`);
  log(`                 ${fx.mgrS.email}     South manager — no warehouse grant`);
  log(`                 ${fx.cashier.email}   cashier — refused every inventory screen`);
  if (generatedPassword) {
    log();
    log(`  password       ${PASSWORD}`);
    log('                 Generated for this run and printed once. Record it now, or re-run with');
    log('                 INVENTORY_PILOT_PASSWORD set to choose your own.');
  } else {
    log();
    log('  password       as supplied in INVENTORY_PILOT_PASSWORD (not printed)');
  }
  log();
};

main()
  .catch((err) => {
    console.error('');
    console.error(`PILOT FAILED: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
