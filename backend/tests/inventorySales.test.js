// Where the till meets the shelf.
//
// Everything here goes through the real order routes, because the claim under
// test is not "the consumption library can subtract" — it is "billing an order
// takes the ingredients once, printing the ticket takes nothing, taking the
// money takes nothing, and refunding it puts nothing back". Only the HTTP
// walk can show that.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('inventorySales.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll, buildBaseFixture, TEST_PASSWORD } = await import('./helpers/inventory.js');

const app = createApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const API = '/api/inventory';

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const ok = (res, expected = 200) => {
  expect(res.status, `${res.req?.method} ${res.req?.path} → ${res.status}: ${JSON.stringify(res.body)}`).toBe(expected);
  return res.body;
};

let fx;
let tok;

beforeEach(async () => {
  await wipeAll();
  fx = await buildBaseFixture();
  tok = {
    owner: await login(fx.owner.email),
    managerA: await login(fx.managerA.email),
    managerB: await login(fx.managerB.email),
    cashierA: await login(fx.cashierA.email),
  };
});

// Leaves the database as it was found. Every suite here shares one _test
// database and vitest runs the files one after another, so rows left behind
// are rows the NEXT file trips over: a RecipeProductLink holding a key on a
// Product makes some other suite's product.deleteMany() fail, in that suite,
// for a reason that has nothing to do with it.
afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------- helpers */

const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

const makeItem = async (over = {}) =>
  ok(
    await request(app)
      .post(`${API}/items`)
      .set(auth(tok.owner))
      .send({ kind: 'RAW', name: 'Milk', baseUnit: 'ML', trackBatches: true, trackExpiry: true, ...over }),
    201,
  ).item;

// Stock straight into the store room the till sells from, so the sale has
// something to take. Direct receipts are owner-only and always carry a reason.
const stockRoom = async (lines, locationId = fx.roomA.id) =>
  ok(
    await request(app)
      .post(`${API}/goods-receipts`)
      .set(auth(tok.owner))
      .send({
        supplierId: fx.supplier.id,
        locationId,
        directReason: 'Opening stock for the sales acceptance walk',
        idempotencyKey: `grn-${Math.random().toString(36).slice(2)}`,
        lines,
      }),
    201,
  ).goodsReceipt;

const makeProduct = async (name, over = {}) => {
  const tax = await request(app)
    .post('/api/catalog/tax-rates')
    .set(auth(tok.owner))
    .send({ name: `GST 5% ${name}`, ratePercent: 5 });
  const category = await request(app)
    .post('/api/catalog/categories')
    .set(auth(tok.owner))
    .send({ name: `Cat ${name}` });
  return ok(
    await request(app)
      .post('/api/catalog/products')
      .set(auth(tok.owner))
      .send({
        categoryId: category.body.category.id,
        name,
        basePrice: 180,
        taxRateId: tax.body.taxRate.id,
        ...over,
      }),
    201,
  ).product;
};

// A recipe, a version and the link, in the three calls a screen would make.
const makeRecipe = async (name, lines, { yieldPercent, outputQty } = {}) => {
  const recipe = ok(
    await request(app).post(`${API}/recipes`).set(auth(tok.owner)).send({ name }),
    201,
  ).recipe;
  const version = ok(
    await request(app)
      .post(`${API}/recipes/${recipe.id}/versions`)
      .set(auth(tok.owner))
      .send({ lines, ...(yieldPercent ? { yieldPercent } : {}), ...(outputQty ? { outputQty } : {}) }),
    201,
  ).version;
  ok(await request(app).post(`${API}/recipes/${recipe.id}/versions/${version.id}/activate`).set(auth(tok.owner)));
  return { recipe, version };
};

const linkRecipe = (recipeId, productId, variantId) =>
  request(app)
    .post(`${API}/recipes/${recipeId}/links`)
    .set(auth(tok.owner))
    .send({ productId, ...(variantId ? { variantId } : {}) });

const openOrder = async (items, as = tok.cashierA) =>
  ok(await request(app).post('/api/orders').set(auth(as)).send({ type: 'TAKEAWAY', items }), 201).order;

const bill = (orderId, as = tok.cashierA) => request(app).post(`/api/orders/${orderId}/bill`).set(auth(as));

// Read from the ledger, not from a response. The question is always what was
// written, and the response is only what was said.
const movementsFor = (orderItemId) =>
  prisma.stockMovement.findMany({ where: { sourceType: 'ORDER_ITEM', sourceId: orderItemId }, orderBy: { seq: 'asc' } });

const stockAt = async (locationId, itemId) =>
  ok(await request(app).get(`${API}/stock/${locationId}/${itemId}`).set(auth(tok.owner))).state;

const consumptionsFor = (orderId) => prisma.saleConsumption.findMany({ where: { orderId } });

/* --------------------------------------------------- single deduction */

describe('a sale takes stock exactly once', () => {
  let milk;
  let latte;

  beforeEach(async () => {
    milk = await makeItem({ name: 'Milk', baseUnit: 'ML' });
    await stockRoom([{ itemId: milk.id, qty: '10', unit: 'l', unitPricePaise: 5, batchCode: 'MILK-1', expiryDate: day(30) }]);
    latte = await makeProduct('Latte');
    const { recipe } = await makeRecipe('Latte recipe', [{ itemId: milk.id, qty: '150', unit: 'ml' }]);
    ok(await linkRecipe(recipe.id, latte.id), 201);
  });

  it('deducts at the bill, and not at the kitchen ticket or the payment', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 2 }]);
    const itemId = order.items[0].id;

    // The ticket goes to the kitchen. The kitchen has not been to the store
    // room yet as far as the ledger is concerned.
    ok(await request(app).post(`/api/orders/${order.id}/kot`).set(auth(tok.cashierA)), 201);
    expect(await movementsFor(itemId), 'a KOT must not move stock').toEqual([]);
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical)).toBe(10000);

    ok(await bill(order.id));
    const afterBill = await movementsFor(itemId);
    expect(afterBill.length, 'one batch on the shelf, one movement').toBe(1);
    expect(Number(afterBill[0].qty), 'two lattes at 150 ml').toBe(-300);
    expect(afterBill[0].type).toBe('SALE_CONSUMPTION');

    // Money changing hands is not stock changing hands.
    ok(
      await request(app)
        .post(`/api/orders/${order.id}/payments`)
        .set(auth(tok.cashierA))
        .send({ method: 'CASH', tendered: 400 }),
      201,
    );
    expect(await movementsFor(itemId), 'a payment must not move stock').toHaveLength(1);
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical)).toBe(9700);
  });

  it('refuses a second bill and posts nothing a second time', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(await bill(order.id));
    const again = await bill(order.id);
    expect(again.status).toBe(409);
    expect(await movementsFor(order.items[0].id)).toHaveLength(1);
    expect(await consumptionsFor(order.id)).toHaveLength(1);
  });

  it('survives two bills racing: one wins, one line is consumed', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 3 }]);
    const [a, b] = await Promise.all([bill(order.id), bill(order.id)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body])).toEqual([200, 409]);

    const rows = await consumptionsFor(order.id);
    expect(rows, 'one consumption row per sold line, whoever won').toHaveLength(1);
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), '3 × 150 ml, once').toBe(9550);
  });

  it('does not consume a line that was voided before billing', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 4 }]);
    ok(
      await request(app)
        .delete(`/api/orders/${order.id}/items/${order.items[0].id}`)
        .set(auth(tok.managerA))
        .send({ reason: 'Customer changed their mind' }),
    );
    const res = await bill(order.id);
    expect(res.status, 'nothing active left to bill').toBe(409);
    expect(await movementsFor(order.items[0].id)).toEqual([]);
  });

  it('follows the quantity the line ended on, not the one it started with', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(
      await request(app)
        .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
        .set(auth(tok.cashierA))
        .send({ qty: 4 }),
    );
    ok(await bill(order.id));
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), '4 × 150 ml').toBe(9400);
  });
});

/* ----------------------------------------------------- recipe resolution */

describe('which recipe a sold line uses', () => {
  let milk;
  let oat;
  let coldBrew;
  let large;

  beforeEach(async () => {
    milk = await makeItem({ name: 'Dairy milk', baseUnit: 'ML' });
    oat = await makeItem({ name: 'Oat milk', baseUnit: 'ML' });
    await stockRoom([
      { itemId: milk.id, qty: '10', unit: 'l', unitPricePaise: 5, batchCode: 'DAIRY-1', expiryDate: day(30) },
      { itemId: oat.id, qty: '10', unit: 'l', unitPricePaise: 9, batchCode: 'OAT-1', expiryDate: day(60) },
    ]);
    coldBrew = await makeProduct('Cold Brew');
    const variant = ok(
      await request(app)
        .post(`/api/catalog/products/${coldBrew.id}/variants`)
        .set(auth(tok.owner))
        .send({ name: 'Large', price: 220 }),
      201,
    ).product;
    large = variant.variants.find((v) => v.name === 'Large').id;
  });

  it('prefers the variant’s own recipe over the product’s', async () => {
    const base = await makeRecipe('Cold Brew regular', [{ itemId: milk.id, qty: '100', unit: 'ml' }]);
    const big = await makeRecipe('Cold Brew large', [{ itemId: milk.id, qty: '250', unit: 'ml' }]);
    ok(await linkRecipe(base.recipe.id, coldBrew.id), 201);
    ok(await linkRecipe(big.recipe.id, coldBrew.id, large), 201);

    const order = await openOrder([
      { productId: coldBrew.id, qty: 1 },
      { productId: coldBrew.id, variantId: large, qty: 1 },
    ]);
    ok(await bill(order.id));
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), '100 + 250').toBe(9650);
  });

  it('falls back to the product’s recipe when the variant has none', async () => {
    const base = await makeRecipe('Cold Brew any size', [{ itemId: milk.id, qty: '120', unit: 'ml' }]);
    ok(await linkRecipe(base.recipe.id, coldBrew.id), 201);

    const order = await openOrder([{ productId: coldBrew.id, variantId: large, qty: 2 }]);
    ok(await bill(order.id));
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical)).toBe(9760);
  });

  it('divides every input by the yield, because the trim comes out of the store too', async () => {
    // 80% yield: a recipe that lists 200 ml really takes 250 ml off the shelf.
    const r = await makeRecipe('Lossy brew', [{ itemId: milk.id, qty: '200', unit: 'ml' }], { yieldPercent: '80' });
    ok(await linkRecipe(r.recipe.id, coldBrew.id), 201);

    const order = await openOrder([{ productId: coldBrew.id, qty: 1 }]);
    ok(await bill(order.id));
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), '200 / 0.8 = 250').toBe(9750);
  });

  it('splits a batch recipe across the portions it yields', async () => {
    // One pot of 4 portions uses 1 litre; selling 2 portions uses half of it.
    const r = await makeRecipe('Pot of four', [{ itemId: milk.id, qty: '1', unit: 'l' }], { outputQty: '4' });
    ok(await linkRecipe(r.recipe.id, coldBrew.id), 201);

    const order = await openOrder([{ productId: coldBrew.id, qty: 2 }]);
    ok(await bill(order.id));
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), '2 of 4 portions of a 1 l pot').toBe(9500);
  });

  it('freezes what a sale consumed: a later version does not restate an earlier bill', async () => {
    const r = await makeRecipe('Versioned brew', [{ itemId: milk.id, qty: '100', unit: 'ml' }]);
    ok(await linkRecipe(r.recipe.id, coldBrew.id), 201);

    const first = await openOrder([{ productId: coldBrew.id, qty: 1 }]);
    ok(await bill(first.id));
    const firstRow = (await consumptionsFor(first.id))[0];

    const v2 = ok(
      await request(app)
        .post(`${API}/recipes/${r.recipe.id}/versions`)
        .set(auth(tok.owner))
        .send({ lines: [{ itemId: milk.id, qty: '400', unit: 'ml' }] }),
      201,
    ).version;
    ok(await request(app).post(`${API}/recipes/${r.recipe.id}/versions/${v2.id}/activate`).set(auth(tok.owner)));

    const second = await openOrder([{ productId: coldBrew.id, qty: 1 }]);
    ok(await bill(second.id));
    const secondRow = (await consumptionsFor(second.id))[0];

    expect(firstRow.recipeVersionId, 'the old bill still points at the old version').toBe(r.version.id);
    expect(secondRow.recipeVersionId).toBe(v2.id);
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), '100 then 400').toBe(9500);

    const stillFirst = await prisma.saleConsumption.findUnique({ where: { id: firstRow.id } });
    expect(Number(stillFirst.costPaise), 'and its cost is untouched').toBe(Number(firstRow.costPaise));
  });

  it('applies a modifier as a signed change on top of the recipe', async () => {
    const r = await makeRecipe('Modifiable brew', [{ itemId: milk.id, qty: '200', unit: 'ml' }]);
    ok(await linkRecipe(r.recipe.id, coldBrew.id), 201);

    // Oat milk: take the dairy back out, put oat in. Both rows for one id.
    ok(
      await request(app)
        .post(`${API}/recipe-modifiers`)
        .set(auth(tok.owner))
        .send({ modifierId: 'mod-oat', recipeId: r.recipe.id, itemId: milk.id, qtyDelta: '-200', unit: 'ml' }),
      201,
    );
    const added = ok(
      await request(app)
        .post(`${API}/recipe-modifiers`)
        .set(auth(tok.owner))
        .send({ modifierId: 'mod-oat', recipeId: r.recipe.id, itemId: oat.id, qtyDelta: '200', unit: 'ml' }),
      201,
    );
    expect(added.adjustment.qtyDelta).toBe('200.000');

    // INTEGRATION(promotions): an order line carries no modifier ids yet, so
    // the arithmetic is asserted at the library. When the promotions lane
    // lands the model, the bill hook reads the ids and this becomes an HTTP
    // walk without the library changing.
    const { requirementFor } = await import('../src/lib/inventory/consumption.js');
    const need = requirementFor({
      lines: [{ itemId: milk.id, qtyBase: '200.000' }],
      qtySold: 2,
      yieldPercent: '100',
      outputQty: '1',
      adjustments: [
        { itemId: milk.id, qtyDelta: '-200.000' },
        { itemId: oat.id, qtyDelta: '200.000' },
      ],
    });
    // The dairy nets to nothing and drops out; the oat takes its place, 200 ml
    // a cup for two cups. A sale can never ADD stock, so a net-negative item
    // is dropped rather than posted as a receipt.
    expect(need).toEqual([{ itemId: oat.id, qtyMilli: 400000 }]);
  });
});

/* ------------------------------------------------- uncosted, not silent */

describe('a sale the ledger cannot cost is visibly uncosted, never free', () => {
  let latte;

  beforeEach(async () => {
    latte = await makeProduct('Plain Latte');
  });

  it('records NO_RECIPE and still bills the customer', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    const body = ok(await bill(order.id));
    expect(body.order.status).toBe('BILLED');

    const [row] = await consumptionsFor(order.id);
    expect(row.status).toBe('UNCOSTED');
    expect(row.uncostedReason).toBe('NO_RECIPE');
    expect(row.costStatus, 'zero cost with MISSING beside it, never a zero-cost profit').toBe('MISSING');
    expect(Number(row.costPaise)).toBe(0);
    expect(await movementsFor(order.items[0].id)).toEqual([]);
  });

  it('records NO_STOCK_LOCATION for a branch that does not stock anything', async () => {
    // Store B sells, but nobody has told the system where from.
    await prisma.inventoryLocation.update({
      where: { id: fx.roomB.id },
      data: { saleSourceBranchId: null },
    });
    const cashierB = await prisma.posUser.create({
      data: {
        companyId: fx.company.id,
        branchId: fx.storeB.id,
        email: `cashb-${fx.company.id}@test.local`,
        fullName: 'Cashier B',
        role: 'CASHIER',
        passwordHash: (await prisma.posUser.findUnique({ where: { id: fx.cashierA.id } })).passwordHash,
      },
    });
    const tokB = await login(cashierB.email);

    const order = await openOrder([{ productId: latte.id, qty: 1 }], tokB);
    ok(await bill(order.id, tokB));
    const [row] = await consumptionsFor(order.id);
    expect(row.uncostedReason).toBe('NO_STOCK_LOCATION');
    expect(row.locationId).toBeNull();
  });

  it('records NO_ACTIVE_VERSION when the recipe exists but nothing is live yet', async () => {
    const milk = await makeItem({ name: 'Draft milk', baseUnit: 'ML' });
    const recipe = ok(
      await request(app).post(`${API}/recipes`).set(auth(tok.owner)).send({ name: 'Draft only' }),
      201,
    ).recipe;
    ok(
      await request(app)
        .post(`${API}/recipes/${recipe.id}/versions`)
        .set(auth(tok.owner))
        .send({ lines: [{ itemId: milk.id, qty: '10', unit: 'ml' }] }),
      201,
    );
    ok(await linkRecipe(recipe.id, latte.id), 201);

    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(await bill(order.id));
    const [row] = await consumptionsFor(order.id);
    expect(row.uncostedReason).toBe('NO_ACTIVE_VERSION');
  });

  it('sells what it does not have rather than refusing the bill, and says the cost is estimated', async () => {
    const beans = await makeItem({ name: 'Beans', baseUnit: 'G', trackBatches: false, trackExpiry: false });
    await stockRoom([{ itemId: beans.id, qty: '100', unit: 'g', unitPricePaise: 2 }]);
    const r = await makeRecipe('Heavy pour', [{ itemId: beans.id, qty: '80', unit: 'g' }]);
    ok(await linkRecipe(r.recipe.id, latte.id), 201);

    const order = await openOrder([{ productId: latte.id, qty: 3 }]);
    // 240 g wanted against 100 g on the shelf. The customer is holding three
    // coffees; the ledger's opinion is a report, not a veto.
    ok(await bill(order.id));

    const state = await stockAt(fx.roomA.id, beans.id);
    expect(Number(state.physical), 'the shortfall is visible, not hidden').toBe(-140);
    const [row] = await consumptionsFor(order.id);
    expect(row.status).toBe('POSTED');
    expect(row.costStatus, 'part of it was valued at a stale average').toBe('ESTIMATED');
  });

  it('shows the uncosted lines in the sales report instead of burying them', async () => {
    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(await bill(order.id));
    const body = ok(await request(app).get(`${API}/sales/consumptions`).set(auth(tok.owner)));
    expect(body.summary.lines).toBe(1);
    expect(body.summary.uncostedLines).toBe(1);
    expect(body.summary.linesWithUnknownCost).toBe(1);
  });
});

/* ------------------------------------------------------------ FEFO + expiry */

describe('which batch the sale takes', () => {
  let milk;
  let latte;

  beforeEach(async () => {
    milk = await makeItem({ name: 'Batched milk', baseUnit: 'ML' });
    latte = await makeProduct('Batched Latte');
    const r = await makeRecipe('Batched recipe', [{ itemId: milk.id, qty: '600', unit: 'ml' }]);
    ok(await linkRecipe(r.recipe.id, latte.id), 201);
  });

  it('takes the first-expiring batch first and rolls onto the next', async () => {
    await stockRoom([
      { itemId: milk.id, qty: '500', unit: 'ml', unitPricePaise: 5, batchCode: 'LATE', expiryDate: day(30) },
      { itemId: milk.id, qty: '500', unit: 'ml', unitPricePaise: 5, batchCode: 'SOON', expiryDate: day(3) },
    ]);
    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(await bill(order.id));

    const moved = await movementsFor(order.items[0].id);
    const byBatch = {};
    for (const m of moved) {
      const b = await prisma.stockBatch.findUnique({ where: { id: m.batchId } });
      byBatch[b.batchCode] = Number(m.qty);
    }
    expect(byBatch, 'the soonest to die empties first').toEqual({ SOON: -500, LATE: -100 });
  });

  it('will not sell an expired batch even though it is physically there', async () => {
    await stockRoom([
      { itemId: milk.id, qty: '1000', unit: 'ml', unitPricePaise: 5, batchCode: 'DEAD', expiryDate: day(30) },
    ]);
    const dead = await prisma.stockBatch.findFirst({ where: { batchCode: 'DEAD' } });
    // Backdated directly: the receipt route refuses to book stock that is
    // already expired, which is the right behaviour and the wrong fixture.
    await prisma.stockBatch.update({ where: { id: dead.id }, data: { expiryDate: new Date(Date.now() - 86400000) } });

    const before = await stockAt(fx.roomA.id, milk.id);
    expect(Number(before.physical), 'it is on the shelf').toBe(1000);
    expect(Number(before.usable), 'and none of it is usable').toBe(0);

    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(await bill(order.id));

    const moved = await movementsFor(order.items[0].id);
    expect(moved).toHaveLength(1);
    expect(moved[0].batchId, 'no expired batch was dressed up as the source').toBeNull();
    const after = await stockAt(fx.roomA.id, milk.id);
    expect(Number(after.physical)).toBe(400);
    expect(Number(after.usable), 'still nothing usable: the dead litre is untouched').toBe(-600);
  });

  it('will not sell a quarantined batch, whatever the scheduler is doing', async () => {
    await stockRoom([
      { itemId: milk.id, qty: '1000', unit: 'ml', unitPricePaise: 5, batchCode: 'HOLD', expiryDate: day(30) },
    ]);
    const held = await prisma.stockBatch.findFirst({ where: { batchCode: 'HOLD' } });
    ok(
      await request(app)
        .post(`${API}/batches/${held.id}/quarantine`)
        .set(auth(tok.managerA))
        .send({ reason: 'Chiller failed overnight and this crate was warm' }),
    );

    const order = await openOrder([{ productId: latte.id, qty: 1 }]);
    ok(await bill(order.id));
    const moved = await movementsFor(order.items[0].id);
    expect(moved.every((m) => m.batchId === null), 'nothing came out of quarantine').toBe(true);
  });
});

/* ---------------------------------------------- refund ≠ return to stock */

describe('money coming back is not food coming back', () => {
  let milk;
  let latte;

  beforeEach(async () => {
    milk = await makeItem({ name: 'Return milk', baseUnit: 'ML' });
    await stockRoom([
      // unitPricePaise is per ENTERED unit, so this is ₹60 a litre — 6 paise
      // a millilitre once it is on the shelf in the item's base unit.
      { itemId: milk.id, qty: '10', unit: 'l', unitPricePaise: 6000, batchCode: 'RET-1', expiryDate: day(30) },
    ]);
    latte = await makeProduct('Refundable Latte');
    const r = await makeRecipe('Refundable recipe', [{ itemId: milk.id, qty: '200', unit: 'ml' }]);
    ok(await linkRecipe(r.recipe.id, latte.id), 201);
  });

  const soldOrder = async (qty = 2) => {
    const order = await openOrder([{ productId: latte.id, qty }]);
    const billed = ok(await bill(order.id));
    ok(
      await request(app)
        .post(`/api/orders/${order.id}/payments`)
        .set(auth(tok.cashierA))
        .send({ method: 'CASH', tendered: Number(billed.order.total) }),
      201,
    );
    return order;
  };

  it('refunds the money and leaves the shelf exactly where it was', async () => {
    const order = await soldOrder(2);
    const afterSale = Number((await stockAt(fx.roomA.id, milk.id)).physical);
    expect(afterSale).toBe(9600);

    const refund = await request(app)
      .post(`/api/orders/${order.id}/refunds`)
      .set(auth(tok.managerA))
      .send({ amount: 100, reason: 'Customer was unhappy with the coffee', method: 'CASH' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);

    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), 'the coffee was drunk').toBe(afterSale);
    const [row] = await consumptionsFor(order.id);
    expect(row.returnedQty).toBe(0);
  });

  it('returns stock only when somebody asks for it, and puts it back in its own batch', async () => {
    const order = await soldOrder(2);
    const [row] = await consumptionsFor(order.id);

    const body = ok(
      await request(app)
        .post(`${API}/sales/consumptions/${row.id}/return`)
        .set(auth(tok.managerA))
        .send({ qty: 1, reason: 'Sealed carton came straight back, unopened' }),
      201,
    );
    expect(body.consumption.returnedQty).toBe(1);

    const state = await stockAt(fx.roomA.id, milk.id);
    expect(Number(state.physical), 'one latte’s 200 ml back').toBe(9800);
    expect(state.batches.map((b) => b.batchCode)).toEqual(['RET-1']);
    expect(Number(state.usable), 'and it kept its expiry, so it is usable').toBe(9800);

    const reversal = await prisma.stockMovement.findFirst({ where: { type: 'SALE_REVERSAL' } });
    expect(Number(reversal.qty)).toBe(200);
    expect(Number(reversal.valuePaise), '200 ml at 6 paise a millilitre').toBe(1200);

    // What came back is worth what went out, not what the recipe says it
    // should have been worth. Value follows the movements.
    const after = await prisma.saleConsumption.findUnique({ where: { id: body.consumption.id } });
    expect(Number(after.costPaise), 'two lattes at 200 ml each').toBe(2400);
    expect(Number(body.stockReturn.valuePaise), 'half of it returned').toBe(1200);
  });

  it('is idempotent: the same return key twice puts stock back once', async () => {
    const order = await soldOrder(2);
    const [row] = await consumptionsFor(order.id);
    const send = () =>
      request(app)
        .post(`${API}/sales/consumptions/${row.id}/return`)
        .set(auth(tok.managerA))
        .send({ qty: 1, reason: 'Sealed carton came straight back', idempotencyKey: 'return-key-0001' });

    const first = await send();
    const second = await send();
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), 'once, not twice').toBe(9800);
    expect((await prisma.saleStockReturn.findMany()).length).toBe(1);
  });

  it('cannot return more than was sold', async () => {
    const order = await soldOrder(2);
    const [row] = await consumptionsFor(order.id);
    const res = await request(app)
      .post(`${API}/sales/consumptions/${row.id}/return`)
      .set(auth(tok.managerA))
      .send({ qty: 3, reason: 'Trying to put back more than left' });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/Only 2 of 2/);
  });

  it('refuses a cashier and refuses a manager at somebody else’s store', async () => {
    const order = await soldOrder(1);
    const [row] = await consumptionsFor(order.id);

    const cashier = await request(app)
      .post(`${API}/sales/consumptions/${row.id}/return`)
      .set(auth(tok.cashierA))
      .send({ qty: 1, reason: 'A till should not be able to restock' });
    expect(cashier.status, 'the till cannot change what it is selling').toBe(403);

    const otherStore = await request(app)
      .post(`${API}/sales/consumptions/${row.id}/return`)
      .set(auth(tok.managerB))
      .send({ qty: 1, reason: 'Another store’s manager reaching across' });
    expect([403, 404], JSON.stringify(otherStore.body)).toContain(otherStore.status);
    expect(Number((await stockAt(fx.roomA.id, milk.id)).physical), 'and neither of them moved anything').toBe(9800);
  });

  it('refuses to return a line that never took stock', async () => {
    const plain = await makeProduct('Unrecipe Latte');
    const order = await openOrder([{ productId: plain.id, qty: 1 }]);
    ok(await bill(order.id));
    const [row] = await consumptionsFor(order.id);
    const res = await request(app)
      .post(`${API}/sales/consumptions/${row.id}/return`)
      .set(auth(tok.managerA))
      .send({ qty: 1, reason: 'Nothing ever left, so nothing can come back' });
    expect(res.status).toBe(409);
  });
});

/* ------------------------------------------------ which till rang it up */

// The claim under test is narrow and it is the whole of INV-B2: a stock
// movement caused by a sale names the till the SALE belonged to, and a
// movement caused by anything else names no till at all.
//
// Everything here goes through the real routes with a real activated device
// token, because the interesting cases are the ones where the order's till and
// the request's device disagree, and only the HTTP walk can produce that
// disagreement.
describe('which till a sale’s stock is attributed to', () => {
  let milk;
  let latte;
  let counter1;
  let counter2;
  let dev1;
  let dev2;

  // A till, and a device activated onto it. The token comes back exactly once,
  // in the activation response, so it is captured here or not at all.
  const makeTerminal = async (code, name) =>
    ok(
      await request(app).post('/api/terminals').set(auth(tok.owner)).send({ branchId: fx.storeA.id, code, name }),
      201,
    ).terminal;

  const makeDevice = async (terminalId, name) => {
    const device = ok(
      await request(app)
        .post('/api/devices')
        .set(auth(tok.owner))
        .send({ branchId: fx.storeA.id, terminalId, type: 'COUNTER', name }),
      201,
    ).device;
    const activated = ok(await request(app).post(`/api/devices/${device.id}/activate`).set(auth(tok.owner)));
    expect(activated.deviceToken, 'activation must hand back a token').toMatch(/^vxd_/);
    return { device: activated.device, token: activated.deviceToken };
  };

  const onDevice = (req_, token) => (token ? req_.set('x-pos-device-token', token) : req_);

  const openOn = async (token, items, as = tok.cashierA) =>
    ok(await onDevice(request(app).post('/api/orders').set(auth(as)), token).send({ type: 'TAKEAWAY', items }), 201)
      .order;

  const billOn = (orderId, token, as = tok.cashierA) =>
    onDevice(request(app).post(`/api/orders/${orderId}/bill`).set(auth(as)), token);

  // Read off the row, not off the response: serializeOrder does not publish
  // the till, and the question here is what was STORED — the same discipline
  // movementsFor follows above.
  const orderTerminal = async (orderId) =>
    (await prisma.order.findUnique({ where: { id: orderId }, select: { terminalId: true } })).terminalId;

  const consumptionMovements = (orderItemId) =>
    prisma.stockMovement.findMany({
      where: { sourceType: 'ORDER_ITEM', sourceId: orderItemId, type: 'SALE_CONSUMPTION' },
      orderBy: { seq: 'asc' },
    });

  beforeEach(async () => {
    milk = await makeItem({ name: 'Till milk', baseUnit: 'ML' });
    await stockRoom([{ itemId: milk.id, qty: '10', unit: 'l', unitPricePaise: 6000, batchCode: 'TILL-1', expiryDate: day(30) }]);
    latte = await makeProduct('Counter Latte');
    const r = await makeRecipe('Counter recipe', [{ itemId: milk.id, qty: '200', unit: 'ml' }]);
    ok(await linkRecipe(r.recipe.id, latte.id), 201);

    counter1 = await makeTerminal('C1', 'Counter 1');
    counter2 = await makeTerminal('C2', 'Counter 2');
    dev1 = await makeDevice(counter1.id, 'Counter 1 till');
    dev2 = await makeDevice(counter2.id, 'Counter 2 till');
  });

  it('stamps the order’s till on every movement the sale posts', async () => {
    const order = await openOn(dev1.token, [{ productId: latte.id, qty: 2 }]);
    expect(await orderTerminal(order.id), 'the order itself was rung up on Counter 1').toBe(counter1.id);
    ok(await billOn(order.id, dev1.token));

    const rows = await consumptionMovements(order.items[0].id);
    expect(rows.length, 'one movement, from the one eligible batch').toBe(1);
    for (const m of rows) expect(m.terminalId).toBe(counter1.id);

    // The point of the exercise: the sales report and the stock report can be
    // joined on the till and will agree about this sale.
    const onOrder = await orderTerminal(order.id);
    expect(rows.map((m) => m.terminalId)).toEqual(rows.map(() => onOrder));
  });

  // The decisive case for the documented rule. Opening at one counter and
  // settling at another is ordinary — a queue moves, a counter closes — and
  // the two candidate answers differ here and nowhere else.
  it('follows the order’s till, not the device that pressed bill', async () => {
    const order = await openOn(dev1.token, [{ productId: latte.id, qty: 1 }]);
    const billed = await billOn(order.id, dev2.token);
    ok(billed);

    const rows = await consumptionMovements(order.items[0].id);
    expect(rows.length).toBeGreaterThan(0);
    for (const m of rows) {
      expect(m.terminalId, 'Counter 1 sold it; Counter 2 only closed it out').toBe(counter1.id);
      expect(m.terminalId).not.toBe(counter2.id);
    }
  });

  // A browser till sends no token. That is the state every existing
  // installation is in, and it must record an absence rather than a guess.
  it('records no till when the sale was never rung up on one', async () => {
    const order = await openOn(null, [{ productId: latte.id, qty: 1 }]);
    expect(await orderTerminal(order.id)).toBeNull();
    ok(await billOn(order.id, null));

    const rows = await consumptionMovements(order.items[0].id);
    expect(rows.length).toBeGreaterThan(0);
    for (const m of rows) expect(m.terminalId, 'null is the honest answer, not a borrowed till').toBeNull();
  });

  // A reversal undoes a specific posting, so it has to net to zero on the same
  // till. Attributing it to whoever processed the return would leave two tills
  // wrong by the same amount for as long as the report is kept.
  it('returns the stock to the till it left, not to whoever processed the return', async () => {
    const order = await openOn(dev1.token, [{ productId: latte.id, qty: 2 }]);
    ok(await billOn(order.id, dev2.token));
    const [row] = await consumptionsFor(order.id);

    ok(
      await request(app)
        .post(`${API}/sales/consumptions/${row.id}/return`)
        .set(auth(tok.managerA))
        .send({ qty: 1, reason: 'One of the two came straight back, unopened' }),
      201,
    );

    const reversal = await prisma.stockMovement.findFirst({ where: { type: 'SALE_REVERSAL' } });
    expect(reversal.terminalId, 'the till that sold it is the till that un-sells it').toBe(counter1.id);

    // Net to zero per till, which is the property the attribution exists for.
    const perTill = await prisma.stockMovement.groupBy({
      by: ['terminalId'],
      where: { terminalId: counter1.id },
      _sum: { qty: true },
    });
    expect(Number(perTill[0]._sum.qty), 'two lattes out at 200 ml, one back').toBe(-200);
  });

  // Nothing but a sale has a till, and the ledger screen relies on that to know
  // when to print the line at all.
  it('leaves the till empty on postings no till caused', async () => {
    const receipts = await prisma.stockMovement.findMany({ where: { type: 'GRN' } });
    expect(receipts.length).toBeGreaterThan(0);
    for (const m of receipts) expect(m.terminalId, 'a delivery is not rung up anywhere').toBeNull();
  });

  it('shows the till on the ledger screen, and nothing where there was none', async () => {
    const order = await openOn(dev1.token, [{ productId: latte.id, qty: 1 }]);
    ok(await billOn(order.id, dev1.token));

    const body = ok(await request(app).get(`${API}/ledger`).set(auth(tok.owner)).query({ locationId: fx.roomA.id }));
    const sale = body.movements.find((m) => m.type === 'SALE_CONSUMPTION');
    const receipt = body.movements.find((m) => m.type === 'GRN');
    expect(sale.terminal, 'the screen names the counter, not a bare id').toEqual({
      id: counter1.id,
      code: 'C1',
      name: 'Counter 1',
    });
    expect(receipt.terminal, 'and says nothing at all about a delivery').toBeNull();
  });

  // The negative control, and the reason the constraint is a PAIR. The check
  // is asserted by its Prisma code, not merely by "something threw": a test
  // that accepted any rejection would still pass if the row were refused for
  // the wrong reason, or if the FK were on terminalId alone and the tenant
  // boundary were not being enforced at all.
  it('refuses a movement stamped with another tenant’s till', async () => {
    const other = await prisma.company.create({
      data: { name: 'Somebody Else Ltd', slug: `other-co-${Date.now()}` },
    });
    // Minted, not hand-rolled: Branch.publicId carries a CHECK constraint on
    // its shape, so a made-up string is refused before the interesting
    // constraint is ever reached.
    const { mintStorePublicId } = await import('../src/lib/identity.js');
    const otherStore = await prisma.branch.create({
      data: { companyId: other.id, publicId: await mintStorePublicId(prisma), name: 'Their store', code: 'XS' },
    });
    const theirTill = await prisma.terminal.create({
      data: { companyId: other.id, branchId: otherStore.id, code: 'X1', name: 'Their counter' },
    });

    const attempt = prisma.stockMovement.create({
      data: {
        companyId: fx.company.id,
        locationId: fx.roomA.id,
        itemId: milk.id,
        type: 'COUNT_ADJUSTMENT',
        qty: '-1',
        valuePaise: 0n,
        costStatus: 'MISSING',
        balanceQtyAfter: '0',
        balanceValueAfter: 0n,
        sourceType: 'STOCK_COUNT',
        sourceId: 'cross-tenant-till-probe',
        idempotencyKey: `cross-tenant-till-${Date.now()}`,
        occurredAt: new Date(),
        terminalId: theirTill.id,
      },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'P2003' });

    // Positive control on the same statement: it is the PAIRING that refused,
    // not the shape of the row. The identical insert naming this tenant's own
    // till is accepted.
    const allowed = await prisma.stockMovement.create({
      data: {
        companyId: fx.company.id,
        locationId: fx.roomA.id,
        itemId: milk.id,
        type: 'COUNT_ADJUSTMENT',
        qty: '-1',
        valuePaise: 0n,
        costStatus: 'MISSING',
        balanceQtyAfter: '0',
        balanceValueAfter: 0n,
        sourceType: 'STOCK_COUNT',
        sourceId: 'same-tenant-till-probe',
        idempotencyKey: `same-tenant-till-${Date.now()}`,
        occurredAt: new Date(),
        terminalId: counter1.id,
      },
    });
    expect(allowed.terminalId).toBe(counter1.id);
  });
});
