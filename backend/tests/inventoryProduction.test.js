// The central kitchen: milk going in and paneer coming out.
//
// The claim under test is narrower and harder than "production posts two
// movements". It is that a production run moves value without creating or
// destroying any of it, that the inputs are charged against the run that was
// SET UP rather than the one that came out, and that a kitchen which cannot
// cover a batch is told so instead of being handed a negative shelf.
//
// Every assertion about money reads the ledger, not the response. The response
// is what the route said; StockMovement is what actually happened.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('inventoryProduction.test.js requires a DATABASE_URL ending in _test');
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

afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

const makeItem = async (over = {}) =>
  ok(
    await request(app)
      .post(`${API}/items`)
      .set(auth(tok.owner))
      .send({ kind: 'RAW', name: 'Milk', baseUnit: 'ML', trackBatches: true, trackExpiry: true, ...over }),
    201,
  ).item;

const stock = async (lines, locationId = fx.warehouse.id) =>
  ok(
    await request(app)
      .post(`${API}/goods-receipts`)
      .set(auth(tok.owner))
      .send({
        supplierId: fx.supplier.id,
        locationId,
        directReason: 'Opening stock for the production acceptance walk',
        idempotencyKey: `grn-${Math.random().toString(36).slice(2)}`,
        lines,
      }),
    201,
  ).goodsReceipt;

// A recipe that names the item it MAKES. That is what separates a production
// recipe from a menu one: a latte has no output item because nobody stocks
// lattes, paneer does because the next recipe down the line uses it.
const makeRecipe = async (name, outputItemId, lines, { yieldPercent, outputQty, activate = true } = {}) => {
  const recipe = ok(
    await request(app).post(`${API}/recipes`).set(auth(tok.owner)).send({ name, outputItemId }),
    201,
  ).recipe;
  const version = ok(
    await request(app)
      .post(`${API}/recipes/${recipe.id}/versions`)
      .set(auth(tok.owner))
      .send({ lines, ...(yieldPercent ? { yieldPercent } : {}), ...(outputQty ? { outputQty } : {}) }),
    201,
  ).version;
  if (activate) {
    ok(await request(app).post(`${API}/recipes/${recipe.id}/versions/${version.id}/activate`).set(auth(tok.owner)));
  }
  return { recipe, version };
};

const produce = (body, as = tok.owner) => request(app).post(`${API}/production`).set(auth(as)).send(body);

const movementsFor = (key) =>
  prisma.stockMovement.findMany({ where: { sourceType: 'PRODUCTION', sourceId: key }, orderBy: { seq: 'asc' } });

// Every paise at a location, straight from the ledger. The conservation claim
// is about this number and nothing else.
const valueAt = async (locationId) => {
  const rows = await prisma.stockBalance.findMany({ where: { locationId } });
  return rows.reduce((a, r) => a + BigInt(r.valuePaise), 0n);
};

const stateOf = async (locationId, itemId) =>
  ok(await request(app).get(`${API}/stock/${locationId}/${itemId}`).set(auth(tok.owner))).state;

/* ------------------------------------------------------------------------ */

describe('a production run moves value without creating any', () => {
  let milk;
  let culture;
  let paneer;
  let version;

  // 20 l of milk at ₹60/l = 120000 paise, 500 g of culture at 40p/g = 20000
  // paise. 140000 paise on the shelf, and it has to still be 140000 after the
  // kitchen has finished.
  beforeEach(async () => {
    milk = await makeItem({ name: 'Milk', baseUnit: 'ML' });
    culture = await makeItem({ name: 'Culture', baseUnit: 'G' });
    paneer = await makeItem({ name: 'Paneer', baseUnit: 'G', kind: 'SEMI_FINISHED' });
    await stock([
      { itemId: milk.id, qty: '20', unit: 'l', unitPricePaise: 6000, batchCode: 'MILK-1', expiryDate: day(10) },
      { itemId: culture.id, qty: '500', unit: 'g', unitPricePaise: 40, batchCode: 'CUL-1', expiryDate: day(90) },
    ]);
    // Per 1000 g of paneer: 5 l of milk and 10 g of culture.
    ({ version } = await makeRecipe(
      'Paneer',
      paneer.id,
      [
        { itemId: milk.id, qty: '5', unit: 'l' },
        { itemId: culture.id, qty: '10', unit: 'g' },
      ],
      { outputQty: '1000' },
    ));
  });

  it('gives the output exactly what the inputs were worth, to the paise', async () => {
    const before = await valueAt(fx.warehouse.id);
    expect(before, 'the shelf starts at the two receipts').toBe(140000n);

    const key = 'prod-conservation-1';
    const body = ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: version.id,
        batchQty: '2000',
        batchCode: 'PAN-1',
        expiryDate: day(7),
        idempotencyKey: key,
      }),
      201,
    ).production;

    const moves = await movementsFor(key);
    const out = moves.filter((m) => m.type === 'PRODUCTION_OUT');
    const ins = moves.filter((m) => m.type === 'PRODUCTION_IN');
    expect(out.length, 'one input movement per batch picked').toBe(2);
    expect(ins.length, 'one output movement').toBe(1);

    // Half the milk is exactly half the milk's value, and 20 g of 500 g of
    // culture is exactly 800 paise. Asserted as the figures they are, not as
    // "greater than zero".
    const outValue = out.reduce((a, m) => a - BigInt(m.valuePaise), 0n);
    expect(outValue, '60000 of milk plus 800 of culture').toBe(60800n);
    expect(BigInt(ins[0].valuePaise), 'the output carries the inputs, unchanged').toBe(outValue);
    expect(body.inputValuePaise).toBe('60800');

    // The claim that matters. Not "the numbers look right" — the shelf is
    // worth what it was worth.
    expect(await valueAt(fx.warehouse.id), 'a kitchen neither mints nor burns money').toBe(before);

    // And the quantities moved the way a person would describe them.
    expect((await stateOf(fx.warehouse.id, milk.id)).physical).toBe('10000.000');
    expect((await stateOf(fx.warehouse.id, culture.id)).physical).toBe('480.000');
    expect((await stateOf(fx.warehouse.id, paneer.id)).physical).toBe('2000.000');
  });

  it('charges the run that was set up, not the one that came out', async () => {
    const key = 'prod-variance-1';
    const body = ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: version.id,
        // Set up for 2 kg, got 1.6 kg: 400 g went up the extractor fan.
        batchQty: '2000',
        outputQty: '1600',
        batchCode: 'PAN-2',
        idempotencyKey: key,
      }),
      201,
    ).production;

    const moves = await movementsFor(key);
    const out = moves.filter((m) => m.type === 'PRODUCTION_OUT');

    // The inputs are the 2 kg run's inputs. Scaling them down to match the
    // 1.6 kg that appeared would make the loss disappear by construction,
    // which is the one number the kitchen manager is looking for.
    const milkOut = out.filter((m) => m.itemId === milk.id).reduce((a, m) => a - Number(m.qty), 0);
    expect(milkOut, '2 kg of paneer needs 10 l of milk however much paneer appears').toBe(10000);
    expect((await stateOf(fx.warehouse.id, milk.id)).physical).toBe('10000.000');
    expect((await stateOf(fx.warehouse.id, paneer.id)).physical).toBe('1600.000');

    expect(body.plannedQty).toBe('2000.000');
    expect(body.outputQty).toBe('1600.000');
    expect(body.yieldVarianceQty, 'the 400 g that never arrived is stated, not buried').toBe('-400.000');

    // A bad yield loses PRODUCT, not money: the same 60800 paise is now
    // carried by less paneer, so the unit cost rises. That is the whole
    // reason to cost a kitchen at all.
    expect(body.inputValuePaise).toBe('60800');
    expect(await valueAt(fx.warehouse.id), 'value is conserved even when the yield is not').toBe(140000n);
    const inRow = moves.find((m) => m.type === 'PRODUCTION_IN');
    expect(Number(inRow.unitCostPaise), '60800 over 1600 g, not over 2000').toBeCloseTo(38, 6);

    // The same three figures read back from the DETAIL endpoint, which is the
    // one a person opens a week later when they ask where the 400 g went.
    // Asserting them only on the POST response would pass while the variance
    // was visible exactly once, to the person who already knew it.
    const later = ok(await request(app).get(`${API}/production/${body.id}`).set(auth(tok.owner))).production;
    expect(later.plannedQty, 'the run remembers what it was set up for').toBe('2000.000');
    expect(later.outputQty).toBe('1600.000');
    expect(later.yieldVarianceQty, 'and still says so when it is read back later').toBe('-400.000');

    // And on the list, so a shortfall is visible without opening each run.
    const listed = ok(await request(app).get(`${API}/production`).set(auth(tok.owner))).production.find(
      (r) => r.id === body.id,
    );
    expect(listed.yieldVarianceQty).toBe('-400.000');
  });

  it('divides the inputs by the recipe’s own yield before anything else', async () => {
    const { version: lossy } = await makeRecipe(
      'Paneer, honest about the trim',
      // A second recipe may not claim the same output item — outputItemId is
      // unique — so this one makes something else out of the same milk.
      (await makeItem({ name: 'Khoya', baseUnit: 'G', kind: 'SEMI_FINISHED' })).id,
      [{ itemId: milk.id, qty: '5', unit: 'l' }],
      { outputQty: '1000', yieldPercent: '80' },
    );

    const key = 'prod-yield-1';
    ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: lossy.id,
        batchQty: '1000',
        batchCode: 'KHO-1',
        idempotencyKey: key,
      }),
      201,
    );

    // 5 l ÷ 0.8 = 6.25 l. The evaporation comes out of the store too.
    const out = (await movementsFor(key)).filter((m) => m.type === 'PRODUCTION_OUT');
    expect(out.reduce((a, m) => a - Number(m.qty), 0)).toBe(6250);
  });

  it('takes the first-expiring batch first, across two batches', async () => {
    // A second milk batch that dies sooner than the first.
    await stock([{ itemId: milk.id, qty: '4', unit: 'l', unitPricePaise: 7000, batchCode: 'MILK-0', expiryDate: day(2) }]);

    const key = 'prod-fefo-1';
    ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: version.id,
        batchQty: '1000',
        batchCode: 'PAN-3',
        idempotencyKey: key,
      }),
      201,
    );

    const milkOut = (await movementsFor(key)).filter((m) => m.type === 'PRODUCTION_OUT' && m.itemId === milk.id);
    const codes = await prisma.stockBatch.findMany({
      where: { id: { in: milkOut.map((m) => m.batchId) } },
      select: { id: true, batchCode: true },
    });
    const byId = new Map(codes.map((c) => [c.id, c.batchCode]));
    const taken = milkOut.map((m) => [byId.get(m.batchId), -Number(m.qty)]);

    // 5 l needed, 4 l of the sooner batch exists, so 1 l comes off the other.
    expect(taken).toEqual([
      ['MILK-0', 4000],
      ['MILK-1', 1000],
    ]);
  });

  it('refuses a run the kitchen cannot cover, and writes nothing at all', async () => {
    const res = await produce({
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      // 5 kg of paneer needs 25 l of milk. There are 20.
      batchQty: '5000',
      batchCode: 'PAN-X',
      idempotencyKey: 'prod-short-1',
    });
    expect(res.status, 'unlike a sale, nobody is holding the food yet').toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/20000\.000 of Milk.*needs 25000\.000/);

    // A refused run is not a partly-done run. The check happens before the
    // transaction opens; this asserts it stays there.
    expect(await prisma.productionBatch.count()).toBe(0);
    expect(await movementsFor('prod-short-1')).toEqual([]);
    expect(await valueAt(fx.warehouse.id), 'nothing moved').toBe(140000n);
  });

  it('posts once when the same run is submitted twice', async () => {
    const body = {
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      batchQty: '1000',
      batchCode: 'PAN-4',
      idempotencyKey: 'prod-idem-1',
    };
    const first = ok(await produce(body), 201).production;
    const second = ok(await produce(body), 200);

    expect(second.duplicate, 'the retry is answered, not re-posted').toBe(true);
    expect(second.production.id).toBe(first.id);
    expect(second.production.number).toBe(first.number);
    expect(await prisma.productionBatch.count()).toBe(1);
    // Three movements, not six: two inputs and one output.
    expect((await movementsFor('prod-idem-1')).length).toBe(3);
    expect((await stateOf(fx.warehouse.id, paneer.id)).physical).toBe('1000.000');
  });

  it('stamps the made batch as made, not as bought', async () => {
    const key = 'prod-batch-1';
    const body = ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: version.id,
        batchQty: '1000',
        batchCode: 'PAN-5',
        expiryDate: day(7),
        idempotencyKey: key,
      }),
      201,
    ).production;

    const made = await prisma.stockBatch.findUnique({ where: { id: body.batch.id } });
    expect(made.batchCode).toBe('PAN-5');
    // The milk came from Acme. The paneer did not — borrowing the milk's
    // supplier would put the wrong company on a recall notice.
    expect(made.supplierId, 'nobody sold us this batch').toBeNull();
    expect(made.manufacturedOn, 'it was made today, and says so').not.toBeNull();
  });

  it('reads back as a document, with its inputs and who ran it', async () => {
    const created = ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: version.id,
        batchQty: '2000',
        batchCode: 'PAN-6',
        note: 'Morning batch for the two stores',
        idempotencyKey: 'prod-read-1',
      }),
      201,
    ).production;

    const got = ok(await request(app).get(`${API}/production/${created.id}`).set(auth(tok.owner))).production;
    expect(got.number).toMatch(/^PRD\//);
    expect(got.recipe.name).toBe('Paneer');
    expect(got.outputItem.name).toBe('Paneer');
    expect(got.costStatus).toBe('ACTUAL');
    expect(got.createdBy.fullName, 'a run is attributable to a person').toBe('Owner');
    expect(got.note).toBe('Morning batch for the two stores');

    // One row per input item, sorted, with what each contributed.
    expect(got.inputs.map((i) => [i.item.name, i.qtyBase, i.valuePaise])).toEqual([
      ['Culture', '20.000', '800'],
      ['Milk', '10000.000', '60000'],
    ]);
    expect(got.inputs.reduce((a, i) => a + BigInt(i.valuePaise), 0n)).toBe(BigInt(got.inputValuePaise));

    const list = ok(await request(app).get(`${API}/production`).set(auth(tok.owner))).production;
    expect(list.map((p) => p.number)).toContain(got.number);
  });
});

/* ---------------------------------------------------------- uncosted input */

describe('a kitchen cannot make something free out of something unpriced', () => {
  it('marks the output MISSING rather than booking it in at zero', async () => {
    const herb = await makeItem({ name: 'Herb', baseUnit: 'G', trackBatches: false, trackExpiry: false });
    const rub = await makeItem({ name: 'Herb rub', baseUnit: 'G', kind: 'SEMI_FINISHED', trackBatches: false, trackExpiry: false });

    // Stock that arrived without a cost basis: counted in, with nobody
    // willing to say what it was worth. The count route's own rule.
    const count = ok(
      await request(app)
        .post(`${API}/counts`)
        .set(auth(tok.managerA))
        .send({ locationId: fx.roomA.id, lines: [{ itemId: herb.id, countedQty: '500' }] }),
      201,
    ).count;
    ok(
      await request(app)
        .post(`${API}/counts/${count.id}/approve`)
        .set(auth(tok.owner))
        .send({ reason: 'Herb found in the dry store with no paperwork behind it' }),
    );

    const surplus = await prisma.stockMovement.findFirst({ where: { itemId: herb.id, type: 'COUNT_ADJUSTMENT' } });
    expect(surplus.costStatus, 'the premise: this stock has no cost basis').toBe('MISSING');

    const { version } = await makeRecipe('Herb rub', rub.id, [{ itemId: herb.id, qty: '100', unit: 'g' }], {
      outputQty: '100',
    });

    const key = 'prod-missing-1';
    const body = ok(
      await produce(
        { locationId: fx.roomA.id, recipeVersionId: version.id, batchQty: '100', idempotencyKey: key },
        tok.owner,
      ),
      201,
    ).production;

    const inRow = (await movementsFor(key)).find((m) => m.type === 'PRODUCTION_IN');
    // Zero value is not the same fact as zero cost. Booking the rub in at an
    // ACTUAL zero would make it free for the rest of its life and every dish
    // containing it would read as pure margin.
    expect(inRow.costStatus, 'unpriced in, unpriced out').toBe('MISSING');
    expect(String(inRow.valuePaise)).toBe('0');
    expect(inRow.costBasisAt, 'no basis was invented').toBeNull();
    expect(body.costStatus).toBe('MISSING');
  });
});

/* ------------------------------------------------------------- what is not */

describe('what a production run refuses to be', () => {
  let milk;
  let paneer;

  beforeEach(async () => {
    milk = await makeItem({ name: 'Milk', baseUnit: 'ML' });
    paneer = await makeItem({ name: 'Paneer', baseUnit: 'G', kind: 'SEMI_FINISHED' });
    await stock([{ itemId: milk.id, qty: '20', unit: 'l', unitPricePaise: 6000, batchCode: 'MILK-1', expiryDate: day(10) }]);
    await stock([{ itemId: milk.id, qty: '20', unit: 'l', unitPricePaise: 6000, batchCode: 'MILK-2', expiryDate: day(10) }], fx.roomA.id);
  });

  it('refuses a menu recipe, which is consumed by selling it', async () => {
    // No output item: nobody stocks lattes.
    const recipe = ok(await request(app).post(`${API}/recipes`).set(auth(tok.owner)).send({ name: 'Latte' }), 201).recipe;
    const version = ok(
      await request(app)
        .post(`${API}/recipes/${recipe.id}/versions`)
        .set(auth(tok.owner))
        .send({ lines: [{ itemId: milk.id, qty: '150', unit: 'ml' }] }),
      201,
    ).version;
    ok(await request(app).post(`${API}/recipes/${recipe.id}/versions/${version.id}/activate`).set(auth(tok.owner)));

    const res = await produce({
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      batchQty: '1',
      idempotencyKey: 'prod-menu-1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/does not name an output item/);
  });

  it('refuses a draft version, because nobody has agreed to that formula yet', async () => {
    const { version } = await makeRecipe('Paneer', paneer.id, [{ itemId: milk.id, qty: '5', unit: 'l' }], {
      outputQty: '1000',
      activate: false,
    });
    const res = await produce({
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      batchQty: '1000',
      batchCode: 'PAN-D',
      idempotencyKey: 'prod-draft-1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/draft, not active/i);
    expect(await prisma.productionBatch.count()).toBe(0);
  });

  it('refuses an archived recipe even though its version is still active', async () => {
    // Archiving the parent is what stops a dish being made; the version rows
    // underneath keep their own ACTIVE status so past sales still read back
    // against the formula they actually used. That leaves a live version
    // hanging off a dead recipe, which is exactly the state the picker hides
    // and the server therefore has to refuse on its own.
    const { recipe, version } = await makeRecipe('Paneer', paneer.id, [{ itemId: milk.id, qty: '5', unit: 'l' }], {
      outputQty: '1000',
    });
    await prisma.recipe.update({ where: { id: recipe.id }, data: { status: 'ARCHIVED' } });
    const still = await prisma.recipeVersion.findUnique({ where: { id: version.id } });
    expect(still.status, 'the premise: the version is untouched by archiving its recipe').toBe('ACTIVE');

    const res = await produce({
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      batchQty: '1000',
      batchCode: 'PAN-A',
      idempotencyKey: 'prod-archived-1',
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/archived and is no longer made/);
    expect(await prisma.productionBatch.count()).toBe(0);
  });

  it('refuses a recipe that eats its own output', async () => {
    const { version } = await makeRecipe(
      'Paneer from paneer',
      paneer.id,
      [
        { itemId: milk.id, qty: '5', unit: 'l' },
        { itemId: paneer.id, qty: '100', unit: 'g' },
      ],
      { outputQty: '1000' },
    );
    const res = await produce({
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      batchQty: '1000',
      batchCode: 'PAN-L',
      idempotencyKey: 'prod-loop-1',
    });
    expect(res.status, 'a loop has no cost, only a last value').toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/both an input and the output/);
  });

  it('refuses a batch-tracked output with no batch code', async () => {
    const { version } = await makeRecipe('Paneer', paneer.id, [{ itemId: milk.id, qty: '5', unit: 'l' }], {
      outputQty: '1000',
    });
    const res = await produce({
      locationId: fx.warehouse.id,
      recipeVersionId: version.id,
      batchQty: '1000',
      idempotencyKey: 'prod-nobatch-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.message ?? res.body.message).toMatch(/batch tracked/);
  });

  // Four callers, four different answers, on direct API calls rather than
  // through a screen. Without the last one the three refusals are equally
  // consistent with "the route is broken", which is not the rule under test.
  it('answers a cashier, a stranger, a half-granted manager and the right manager differently', async () => {
    const { version } = await makeRecipe('Paneer', paneer.id, [{ itemId: milk.id, qty: '5', unit: 'l' }], {
      outputQty: '1000',
    });
    const body = (locationId, k) => ({
      locationId,
      recipeVersionId: version.id,
      batchQty: '1000',
      batchCode: `PAN-${k}`,
      idempotencyKey: `prod-rbac-${k}`,
    });

    // No inventory rights at all, whatever location is named.
    expect((await produce(body(fx.roomA.id, 'a'), tok.cashierA)).status, 'a cashier holds no inventory rights').toBe(403);

    // Manager B is pinned to Store B and has no grant at Store A's room.
    // 404, not 403: an unreachable location answers exactly like one that
    // does not exist, so a probe cannot map the estate.
    expect((await produce(body(fx.roomA.id, 'b'), tok.managerB)).status, 'existence is not leaked').toBe(404);

    // The interesting one. Manager A HAS a warehouse grant — canDispatch and
    // canApprove — but not canReceive. A production run both takes stock off
    // the shelf and puts stock back on it, so half a grant is not enough, and
    // the refusal says which half is missing.
    const half = await produce(body(fx.warehouse.id, 'c'), tok.managerA);
    expect(half.status, 'dispatch alone cannot book the output in').toBe(403);
    expect(half.body.error?.message ?? half.body.message).toMatch(/receive/);

    // The control: the same manager, at the room their branch pin covers.
    expect((await produce(body(fx.roomA.id, 'd'), tok.managerA)).status, 'the kitchen may run its own kitchen').toBe(201);
  });

  it('hides a run at a location the caller cannot reach', async () => {
    const { version } = await makeRecipe('Paneer', paneer.id, [{ itemId: milk.id, qty: '5', unit: 'l' }], {
      outputQty: '1000',
    });
    const made = ok(
      await produce({
        locationId: fx.warehouse.id,
        recipeVersionId: version.id,
        batchQty: '1000',
        batchCode: 'PAN-H',
        idempotencyKey: 'prod-hide-1',
      }),
      201,
    ).production;

    // The detail route is a new way to read a document and inherits nothing
    // from the list, so it is asserted separately.
    expect((await request(app).get(`${API}/production/${made.id}`).set(auth(tok.managerB))).status).toBe(404);

    // And the list does not leak it either: Manager B sees their own room,
    // which has had no runs.
    const list = ok(await request(app).get(`${API}/production`).set(auth(tok.managerB))).production;
    expect(list.map((p) => p.number)).not.toContain(made.number);
  });
});
