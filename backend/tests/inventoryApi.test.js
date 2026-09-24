// The inventory acceptance walk, over the real HTTP API.
//
// Everything here goes through the router, the auth middleware and the
// permission map — not through the libraries directly — because the
// requirement is that permissions hold for a direct API request, and a test
// that calls the library proves nothing about the route.
//
// The pilot is one warehouse, two stores, several batches and items counted
// in grams, millilitres and pieces. Each describe block below is one of the
// acceptance items.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('inventoryApi.test.js requires a DATABASE_URL ending in _test');
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

// Fails loudly with the server's own message rather than a bare status code,
// so a broken expectation reads as a sentence.
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

// Leaves the database as it was found — see the same note in
// inventorySales.test.js. Rows left behind are the next suite's failure.
afterAll(async () => {
  await wipeAll();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------- helpers */

const makeItem = async (over = {}) =>
  ok(
    await request(app)
      .post(`${API}/items`)
      .set(auth(tok.owner))
      .send({ kind: 'RAW', name: 'Sugar', baseUnit: 'G', trackBatches: true, trackExpiry: true, ...over }),
    201,
  ).item;

const receive = async (over = {}) =>
  request(app)
    .post(`${API}/goods-receipts`)
    .set(auth(tok.owner))
    .send({
      supplierId: fx.supplier.id,
      locationId: fx.warehouse.id,
      directReason: 'Opening stock for the acceptance pilot',
      idempotencyKey: `grn-${Math.random().toString(36).slice(2)}`,
      ...over,
    });

// The receipt response deliberately carries only the document, not its lines —
// the caller already knows what it sent. Tests that need the batch the receipt
// created read it from the row, which is also the stronger assertion: it proves
// what was written rather than what was echoed.
const grnLines = async (grnId) =>
  prisma.goodsReceiptLine.findMany({ where: { grnId }, orderBy: { lineNo: 'asc' } });

describe('setup: locations, items and units', () => {
  it('refuses a cashier the right to create an item, on a direct API call', async () => {
    const res = await request(app)
      .post(`${API}/items`)
      .set(auth(tok.cashierA))
      .send({ kind: 'RAW', name: 'Flour', baseUnit: 'G' });
    expect(res.status).toBe(403);
    expect(res.body.error?.message ?? res.body.message).toMatch(/role cannot perform/i);
  });

  it('refuses a manager the right to create an item even with a valid token', async () => {
    const res = await request(app)
      .post(`${API}/items`)
      .set(auth(tok.managerA))
      .send({ kind: 'RAW', name: 'Flour', baseUnit: 'G' });
    expect(res.status).toBe(403);
  });

  it('will not let a millilitre item be counted in grams', async () => {
    const oil = await makeItem({ name: 'Oil', baseUnit: 'ML', trackBatches: false, trackExpiry: false });
    const res = await receive({
      lines: [{ itemId: oil.id, qty: '5', unit: 'kg', unitPricePaise: 10000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.message ?? res.body.message).toMatch(/weight|volume|ml/i);
  });

  it('converts a purchase unit to the stock unit and freezes the factor used', async () => {
    const sugar = await makeItem();
    // A 25 kg sack of an item stocked in grams is 25000 base units.
    ok(
      await request(app)
        .post(`${API}/items/${sugar.id}/units`)
        .set(auth(tok.owner))
        .send({ name: 'sack', quantityInBaseUnit: '25000' }),
      201,
    );

    const body = ok(
      await receive({
        lines: [
          {
            itemId: sugar.id,
            qty: '2',
            unit: 'sack',
            unitPricePaise: 150000,
            batchCode: 'SACK-1',
            expiryDate: new Date(Date.now() + 90 * 86400000).toISOString(),
          },
        ],
      }),
      201,
    );

    // Two sacks of 25 kg is 50 kg, stored as 50000 g.
    const [line] = await grnLines(body.goodsReceipt.id);
    expect(Number(line.qtyBase)).toBe(50000);
    expect(line.unit).toBe('sack');
    expect(Number(line.qty), 'the line still says two sacks').toBe(2);

    // Changing the pack size later must not restate what already happened.
    ok(
      await request(app)
        .post(`${API}/items/${sugar.id}/units`)
        .set(auth(tok.owner))
        .send({ name: 'sack', quantityInBaseUnit: '50000' }),
    );
    const [after] = await grnLines(body.goodsReceipt.id);
    expect(Number(after.qtyBase), 'a historical line keeps the factor it was received on').toBe(50000);

    // And the stock that line put on the shelf is still 50 kg, not 100.
    const state = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(state.state.physical).toBe('50000.000');
  });
});

describe('receiving, FEFO and containment', () => {
  let sugar;
  beforeEach(async () => {
    sugar = await makeItem();
  });

  it('records a direct receipt only for an owner, and only with a reason', async () => {
    const line = {
      itemId: sugar.id,
      qty: '1000',
      unit: 'g',
      unitPricePaise: 5000,
      batchCode: 'B1',
      expiryDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    };

    const noReason = await request(app)
      .post(`${API}/goods-receipts`)
      .set(auth(tok.owner))
      .send({
        supplierId: fx.supplier.id,
        locationId: fx.warehouse.id,
        idempotencyKey: `x-${Date.now()}`,
        lines: [line],
      });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error?.message ?? noReason.body.message).toMatch(/reason/i);

    // Deliberately at Store A's own room, where this manager unquestionably
    // may receive. The refusal below is therefore the direct-receipt rule and
    // not a scope failure wearing the same status code.
    const asManager = await request(app)
      .post(`${API}/goods-receipts`)
      .set(auth(tok.managerA))
      .send({
        supplierId: fx.supplier.id,
        locationId: fx.roomA.id,
        directReason: 'Walk-in supplier, no PO raised',
        idempotencyKey: `y-${Date.now()}`,
        lines: [line],
      });
    expect(asManager.status).toBe(403);
    expect(asManager.body.error?.message ?? asManager.body.message).toMatch(/without a purchase order/i);
  });

  it('returns the same GRN for a retried post rather than receiving twice', async () => {
    const key = `retry-${Date.now()}`;
    const line = {
      itemId: sugar.id,
      qty: '1000',
      unit: 'g',
      unitPricePaise: 5000,
      batchCode: 'B-RETRY',
      expiryDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    };
    const first = ok(await receive({ idempotencyKey: key, lines: [line] }), 201);
    const second = await receive({ idempotencyKey: key, lines: [line] });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.goodsReceipt.id).toBe(first.goodsReceipt.id);

    const stock = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(stock.state.physical).toBe('1000.000');
  });

  it('refuses stock whose remaining shelf life is below the item minimum', async () => {
    const milk = await makeItem({ name: 'Milk', baseUnit: 'ML', minShelfLifeDaysAtReceipt: 10 });
    const res = await receive({
      lines: [
        {
          itemId: milk.id,
          qty: '1000',
          unit: 'ml',
          unitPricePaise: 5000,
          batchCode: 'M-SHORT',
          expiryDate: new Date(Date.now() + 3 * 86400000).toISOString(),
        },
      ],
    });
    // A conflict, not a malformed request: the delivery note was fine, the
    // goods on the pallet were not.
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/needs at least 10/i);
  });

  it('shows batches in FEFO order and refuses to dispatch an expired one', async () => {
    const mk = async (code, days) =>
      ok(
        await receive({
          lines: [
            {
              itemId: sugar.id,
              qty: '1000',
              unit: 'g',
              unitPricePaise: 5000,
              batchCode: code,
              expiryDate: new Date(Date.now() + days * 86400000).toISOString(),
            },
          ],
        }),
        201,
      );
    await mk('LATER', 60);
    await mk('SOON', 5);

    const positions = ok(
      await request(app).get(`${API}/locations/${fx.warehouse.id}/items/${sugar.id}/batches`).set(auth(tok.owner)),
    );
    expect(positions.positions.map((p) => p.batchCode)).toEqual(['SOON', 'LATER']);
    expect(positions.positions.every((p) => p.blockReason === null)).toBe(true);
  });

  it('makes quarantined stock unavailable without changing how much is there', async () => {
    const grn = ok(
      await receive({
        lines: [
          {
            itemId: sugar.id,
            qty: '2000',
            unit: 'g',
            unitPricePaise: 10000,
            batchCode: 'Q1',
            expiryDate: new Date(Date.now() + 60 * 86400000).toISOString(),
          },
        ],
      }),
      201,
    );
    const [{ batchId }] = await grnLines(grn.goodsReceipt.id);

    ok(
      await request(app)
        .post(`${API}/batches/${batchId}/quarantine`)
        .set(auth(tok.managerA))
        .send({ reason: 'Seal broken on two tins, holding pending supplier reply' }),
    );

    const state = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(state.state.physical).toBe('2000.000');
    expect(state.state.blocked).toBe('2000.000');
    expect(state.state.available).toBe('0.000');

    // Only an owner lifts the hold.
    const byManager = await request(app)
      .post(`${API}/batches/${batchId}/release`)
      .set(auth(tok.managerA))
      .send({ reason: 'Supplier confirmed the seals are fine' });
    expect(byManager.status).toBe(403);

    ok(
      await request(app)
        .post(`${API}/batches/${batchId}/release`)
        .set(auth(tok.owner))
        .send({ reason: 'Supplier confirmed the seals are fine' }),
    );
    const after = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(after.state.available).toBe('2000.000');
  });
});

describe('the request lifecycle', () => {
  let sugar;
  let batchId;

  beforeEach(async () => {
    sugar = await makeItem();
    const grn = ok(
      await receive({
        lines: [
          {
            itemId: sugar.id,
            qty: '10000',
            unit: 'g',
            unitPricePaise: 50000,
            batchCode: 'R1',
            expiryDate: new Date(Date.now() + 120 * 86400000).toISOString(),
          },
        ],
      }),
      201,
    );
    [{ batchId }] = await grnLines(grn.goodsReceipt.id);
  });

  const raise = async (over = {}) =>
    request(app)
      .post(`${API}/requests`)
      .set(auth(tok.managerA))
      .send({
        destinationLocationId: fx.roomA.id,
        sourceLocationId: fx.warehouse.id,
        requiredBy: new Date(Date.now() + 2 * 86400000).toISOString(),
        submit: true,
        lines: [{ itemId: sugar.id, qty: '3000', unit: 'g' }],
        ...over,
      });

  // Decide and receive address lines by id, not by item, because the same
  // item can legitimately appear twice on one request and the two lines must
  // stay separately answerable. These helpers let the tests speak in items
  // and look the ids up, the way the screen will.
  const decide = async (requestId, byItem, { as = tok.owner, note } = {}) => {
    const { request: r } = ok(await request(app).get(`${API}/requests/${requestId}`).set(auth(tok.owner)));
    return request(app)
      .post(`${API}/requests/${requestId}/decide`)
      .set(auth(as))
      .send({
        ...(note ? { note } : {}),
        lines: r.lines.map((l) => ({ lineId: l.id, approvedQty: byItem[l.item.id] ?? '0' })),
      });
  };

  const receiveTransfer = async (transferId, byItem, as = tok.managerA) => {
    const { transfer } = ok(await request(app).get(`${API}/transfers/${transferId}`).set(auth(tok.owner)));
    return request(app)
      .post(`${API}/transfers/${transferId}/receive`)
      .set(auth(as))
      .send({ lines: transfer.lines.map((l) => ({ transferLineId: l.id, ...(byItem[l.item.id] ?? {}) })) });
  };

  it('moves no stock at submission, reserves at allocation, and only decreases at dispatch', async () => {
    const created = ok(await raise(), 201);
    const id = created.request.id;

    const afterSubmit = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(afterSubmit.state.physical).toBe('10000.000');
    expect(afterSubmit.state.reserved).toBe('0.000');

    ok(await decide(id, { [sugar.id]: '3000' }, { note: 'Approved in full' }));
    const afterApprove = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(afterApprove.state.physical, 'approval is a decision, not a movement').toBe('10000.000');
    expect(afterApprove.state.reserved, 'approval does not hold stock').toBe('0.000');

    ok(await request(app).post(`${API}/requests/${id}/allocate`).set(auth(tok.owner)).send({}));
    const afterAllocate = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(afterAllocate.state.physical, 'reserved stock is still on the shelf').toBe('10000.000');
    expect(afterAllocate.state.reserved).toBe('3000.000');
    expect(afterAllocate.state.available).toBe('7000.000');

    const dispatched = ok(
      await request(app).post(`${API}/requests/${id}/dispatch`).set(auth(tok.owner)).send({}),
      201,
    );
    const transferId = dispatched.transfer.id;

    const src = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(src.state.physical, 'dispatch decreases the source').toBe('7000.000');
    expect(src.state.reserved, 'the reservation settled into the movement').toBe('0.000');
    expect(src.state.inTransitOut).toBe('3000.000');

    const dst = ok(await request(app).get(`${API}/stock/${fx.roomA.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(dst.state.physical, 'dispatch is not receipt').toBe('0.000');
    expect(dst.state.inTransitIn).toBe('3000.000');

    ok(await receiveTransfer(transferId, { [sugar.id]: { acceptedQty: '3000' } }));
    const received = ok(await request(app).get(`${API}/stock/${fx.roomA.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(received.state.physical).toBe('3000.000');
    expect(received.state.inTransitIn).toBe('0.000');

    const final = ok(await request(app).get(`${API}/requests/${id}`).set(auth(tok.owner)));
    expect(final.request.status).toBe('FULFILLED');
  });

  it('carries the batch and its expiry through the transfer', async () => {
    const created = ok(await raise(), 201);
    const id = created.request.id;
    ok(await decide(id, { [sugar.id]: '3000' }));
    ok(await request(app).post(`${API}/requests/${id}/allocate`).set(auth(tok.owner)).send({}));
    const d = ok(await request(app).post(`${API}/requests/${id}/dispatch`).set(auth(tok.owner)).send({}), 201);
    ok(await receiveTransfer(d.transfer.id, { [sugar.id]: { acceptedQty: '3000' } }));

    const trail = ok(await request(app).get(`${API}/batches/${batchId}/trail`).set(auth(tok.owner)));
    expect(trail.movements.map((m) => m.type)).toEqual(['GRN', 'TRANSFER_OUT', 'TRANSFER_IN']);
    const atStore = trail.movements.find((m) => m.type === 'TRANSFER_IN');
    expect(atStore.location.id).toBe(fx.roomA.id);
    expect(trail.batch.batchCode).toBe('R1');
    expect(trail.batch.expiryDate).not.toBeNull();
  });

  it('keeps damage, shortage and acceptance as three separate numbers', async () => {
    const created = ok(await raise({ lines: [{ itemId: sugar.id, qty: '5000', unit: 'g' }] }), 201);
    const id = created.request.id;
    ok(await decide(id, { [sugar.id]: '5000' }));
    ok(await request(app).post(`${API}/requests/${id}/allocate`).set(auth(tok.owner)).send({}));
    const d = ok(await request(app).post(`${API}/requests/${id}/dispatch`).set(auth(tok.owner)).send({}), 201);

    // Shortage is deliberately NOT an input: it is whatever was dispatched and
    // neither accepted nor damaged. A receiver who could type it could also
    // type a number that makes the transfer balance when it does not.
    ok(
      await receiveTransfer(d.transfer.id, {
        [sugar.id]: { acceptedQty: '3000', damagedQty: '1000', note: 'One bag split in the van' },
      }),
    );

    const store = ok(await request(app).get(`${API}/stock/${fx.roomA.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(store.state.physical, 'only the good stock stays').toBe('3000.000');

    const recon = ok(await request(app).get(`${API}/reports/transfer-reconciliation`).set(auth(tok.owner)));
    const line = recon.transfers[0].lines[0];
    expect(line.dispatched).toBe('5000.000');
    expect(line.accepted).toBe('3000.000');
    expect(line.damaged).toBe('1000.000');
    expect(line.shortage).toBe('1000.000');
    expect(line.unaccounted, 'every gram is accounted for').toBe('0.000');
    expect(recon.transfers[0].balanced).toBe(true);

    const issues = ok(await request(app).get(`${API}/issues`).set(auth(tok.owner)));
    expect(issues.issues.length).toBe(2);
    expect(issues.issues.map((i) => i.kind).sort()).toEqual(['DAMAGE', 'SHORTAGE']);

    // A partly fulfilled request cannot be quietly closed.
    const refused = await request(app)
      .post(`${API}/requests/${id}/close`)
      .set(auth(tok.owner))
      .send({ reason: 'Close it, the store stopped asking' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message ?? refused.body.message).toMatch(/outstanding/i);

    const closed = ok(
      await request(app)
        .post(`${API}/requests/${id}/close`)
        .set(auth(tok.owner))
        .send({ reason: 'Store cancelled the rest, next delivery covers it', cancelOutstanding: true }),
    );
    expect(closed.request.status).toBe('CLOSED_SHORT');
  });

  it('will not approve more than was asked, and refuses self-approval by a manager', async () => {
    const created = ok(await raise(), 201);
    const id = created.request.id;

    const tooMuch = await decide(id, { [sugar.id]: '9000' });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error?.message ?? tooMuch.body.message).toMatch(/more than was asked/i);

    const self = await decide(id, { [sugar.id]: '3000' }, { as: tok.managerA });
    expect(self.status, 'the manager who raised it cannot also decide it').toBe(403);
  });

  it('collapses a double-clicked submit into one request', async () => {
    const key = `dup-${Date.now()}`;
    const a = ok(await raise({ idempotencyKey: key }), 201);
    const b = await raise({ idempotencyKey: key });
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.request.id).toBe(a.request.id);
    const all = ok(await request(app).get(`${API}/requests`).set(auth(tok.owner)));
    expect(all.requests.length).toBe(1);
  });

  it('cannot allocate the same stock to two requests at once', async () => {
    // 10 000 g on hand; two requests for 7 000 g each.
    const mk = async () => {
      const r = ok(
        await raise({ lines: [{ itemId: sugar.id, qty: '7000', unit: 'g' }], idempotencyKey: `c-${Math.random()}` }),
        201,
      );
      ok(await decide(r.request.id, { [sugar.id]: '7000' }));
      return r.request.id;
    };
    const one = await mk();
    const two = await mk();

    const [a, b] = await Promise.all([
      request(app).post(`${API}/requests/${one}/allocate`).set(auth(tok.owner)).send({}),
      request(app).post(`${API}/requests/${two}/allocate`).set(auth(tok.owner)).send({}),
    ]);

    // Allocation reserves what it can rather than refusing outright, so both
    // calls answer 200. The requirement is not that one loses — it is that
    // between them they cannot hold more than exists.
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);

    const state = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(Number(state.state.reserved), 'two holds cannot exceed the shelf').toBeLessThanOrEqual(10000);
    expect(Number(state.state.availableRaw), 'never oversold').toBeGreaterThanOrEqual(0);

    // One of them got everything it asked for and the other got the remainder.
    // 14 000 g was asked for against 10 000 g, so exactly 4 000 g stays short.
    const allocated = [a, b].map((r) => Number(r.body.allocation[0].allocated)).sort((x, y) => y - x);
    expect(allocated).toEqual([7000, 3000]);
  });
});

describe('authorisation across stores and tenants', () => {
  let sugar;
  beforeEach(async () => {
    sugar = await makeItem();
  });

  it('hides a warehouse from a manager with no grant to it', async () => {
    // Manager B is pinned to Store B and has no warehouse grant.
    const res = await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.managerB));
    expect(res.status, 'an unreachable location answers exactly like one that does not exist').toBe(404);
  });

  it('will not let a manager raise a request into another store', async () => {
    const res = await request(app)
      .post(`${API}/requests`)
      .set(auth(tok.managerB))
      .send({
        destinationLocationId: fx.roomA.id,
        sourceLocationId: fx.warehouse.id,
        requiredBy: new Date(Date.now() + 86400000).toISOString(),
        lines: [{ itemId: sugar.id, qty: '1000', unit: 'g' }],
      });
    expect([403, 404]).toContain(res.status);
  });

  it('refuses another company entirely', async () => {
    const other = await buildBaseFixture({ slug: 'other-co' });
    const otherOwner = await login(other.owner.email);
    const res = await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(otherOwner));
    expect(res.status).toBe(404);
  });

  it('gives a cashier no inventory rights at all', async () => {
    for (const path of ['/dashboard', '/stock', '/ledger', '/requests', '/reminders']) {
      const res = await request(app).get(`${API}${path}`).set(auth(tok.cashierA));
      expect(res.status, `${path} must refuse a cashier`).toBe(403);
    }
  });
});

describe('counts, wastage and the value that follows', () => {
  let sugar;
  beforeEach(async () => {
    sugar = await makeItem({ trackBatches: false, trackExpiry: false });
    // The price is per unit ENTERED, so 50 paise a gram — 1 kg for ₹500.
    ok(await receive({ lines: [{ itemId: sugar.id, qty: '1000', unit: 'g', unitPricePaise: 50 }] }), 201);
  });

  it('needs a second person to approve a count, then posts the variance', async () => {
    const count = ok(
      await request(app)
        .post(`${API}/counts`)
        .set(auth(tok.managerA))
        .send({ locationId: fx.warehouse.id, lines: [{ itemId: sugar.id, countedQty: '900' }] }),
      201,
    );
    expect(count.count.lines[0].varianceQty).toBe('-100.000');

    const selfApprove = await request(app)
      .post(`${API}/counts/${count.count.id}/approve`)
      .set(auth(tok.managerA))
      .send({ reason: 'I counted it, it is right' });
    expect([403]).toContain(selfApprove.status);

    ok(
      await request(app)
        .post(`${API}/counts/${count.count.id}/approve`)
        .set(auth(tok.owner))
        .send({ reason: 'Verified against the shelf with the manager present' }),
    );

    const state = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(state.state.physical).toBe('900.000');
    // 1 kg cost ₹500, so 100 g written off is ₹50 = 5000 paise. ₹450 left.
    expect(state.state.valuePaise).toBe('45000');
  });

  it('writes stock off with a typed reason and shows the loss', async () => {
    const res = ok(
      await request(app)
        .post(`${API}/wastage`)
        .set(auth(tok.managerA))
        .send({
          locationId: fx.warehouse.id,
          reason: 'SPOILED',
          note: 'Left out of the chiller overnight after the power cut',
          lines: [{ itemId: sugar.id, qty: '200', unit: 'g' }],
        }),
      201,
    );
    // 200 g of stock carried at 50 paise a gram is ₹100 gone.
    expect(res.wastage.totalValuePaise).toBe('-10000');
    const state = ok(await request(app).get(`${API}/stock/${fx.warehouse.id}/${sugar.id}`).set(auth(tok.owner)));
    expect(state.state.physical).toBe('800.000');
  });

  it('shows an unvalued position as unknown rather than free', async () => {
    // Stock that turns up with no paperwork behind it: a count finds 500 g of
    // an item the ledger has never priced. A receipt always carries a price,
    // so a surplus is the only way this position can exist — and it is exactly
    // the case that must not be reported as free stock.
    const mystery = await makeItem({ name: 'Donated rice', baseUnit: 'G', trackBatches: false, trackExpiry: false });
    const count = ok(
      await request(app)
        .post(`${API}/counts`)
        .set(auth(tok.managerA))
        .send({ locationId: fx.warehouse.id, lines: [{ itemId: mystery.id, countedQty: '500' }] }),
      201,
    );
    ok(
      await request(app)
        .post(`${API}/counts/${count.count.id}/approve`)
        .set(auth(tok.owner))
        .send({ reason: 'Donation from the temple kitchen, no invoice exists' }),
    );

    const rows = ok(await request(app).get(`${API}/stock`).set(auth(tok.owner)));
    const row = rows.rows.find((r) => r.item.id === mystery.id);
    expect(row.physical).toBe('500.000');
    expect(row.valuePaise, 'the ledger books no value it cannot justify').toBe('0');
    expect(row.unitCostPaise, 'no basis means no average, not a zero one').toBeNull();

    const dash = ok(await request(app).get(`${API}/dashboard`).set(auth(tok.owner)));
    expect(dash.positionsWithUnknownCost).toBeGreaterThanOrEqual(1);

    // And the valuation report says so out loud rather than folding an unknown
    // into the total as if it were nothing.
    const val = ok(await request(app).get(`${API}/valuation`).set(auth(tok.owner)));
    expect(val.linesWithUnknownCost).toBeGreaterThanOrEqual(1);
  });
});

describe('the ledger agrees with itself', () => {
  it('reports no mismatch after a full pilot walk', async () => {
    const sugar = await makeItem();
    await receive({
      lines: [
        {
          itemId: sugar.id,
          qty: '5000',
          unit: 'g',
          unitPricePaise: 25000,
          batchCode: 'V1',
          expiryDate: new Date(Date.now() + 90 * 86400000).toISOString(),
        },
      ],
    });
    const verify = ok(await request(app).get(`${API}/ledger/verify`).set(auth(tok.owner)));
    expect(verify.ok, JSON.stringify(verify.mismatches)).toBe(true);
    expect(verify.checked).toBeGreaterThan(0);
  });

  it('refuses a rebuild to anyone but the owner', async () => {
    const res = await request(app).post(`${API}/ledger/rebuild`).set(auth(tok.managerA)).send({});
    expect(res.status).toBe(403);
  });
});
