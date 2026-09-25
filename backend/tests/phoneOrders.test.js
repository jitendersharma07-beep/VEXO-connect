// VC-104 Central phone-order centre.
//
// Covers the acceptance criteria in spec A§3 VC-104: exactly one accepting
// store with operator attribution and correct store pricing; unserviceable
// addresses and closed stores blocked; reassignment recalculating price and tax
// before billing; issued invoices never moving store. Plus tenant isolation,
// permission refusals, scheduling and idempotent submission.
//
// Runs ONLY against a database whose name ends in _test — the guard below
// refuses anything else, because the suite truncates every table.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('phoneOrders.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
// The capacity reservation, called directly by the concurrency test. Two
// requests over HTTP do not overlap inside it (measured), so the lock it takes
// can only be exercised from here.
const { reserveSlot } = await import('../src/api/routes/phoneOrders.js');
// Used to build the rendezvous in the binding-re-check test below: the same
// lock the route takes, and the same grid it takes it on. Imported rather than
// re-derived, so a change to either makes that test fail instead of quietly
// locking a slot the route is not using.
const { lockSlot, slotBoundsFor } = await import('../src/lib/phoneOrders.js');

const app = createApp();

// This lane's tables go first: they reference Order, PosUser, Branch and
// Company, all of which the shared wipe below deletes. The referential actions
// are Cascade/SetNull precisely so a leftover row here cannot fail a peer
// suite's teardown — this wipe is the belt to that design's braces.
const wipe = async () => {
  await prisma.phoneOrderEvent.deleteMany();
  await prisma.phoneOrder.deleteMany();
  await prisma.customerAddress.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.branchServiceArea.deleteMany();
  await prisma.branchHours.deleteMany();
  await prisma.branchPrepCapacity.deleteMany();

  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  // Tables that did not exist when this lane was branched. VC-102 promotions
  // and modifiers, and the kitchen lane's print queue, all hang off the rows
  // below them here, and every FK is RESTRICT — so they go first or the
  // orderItem/kot/branch deletes fail. printJob points at Kot via sourceKotId,
  // which is why the print block precedes the kot delete rather than following
  // it.
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.printJob.deleteMany();
  await prisma.printTarget.deleteMany();
  await prisma.printAgent.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.modifierOption.deleteMany();
  await prisma.modifierGroup.deleteMany();
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

const PW = 'Str0ng-Passw0rd!';
const tokens = {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let companyA, companyB, single;
let a1, a2, b1, singleBranch1, singleBranch2;
let cappuccino, tax5;
let customerA, addrA, addrFar, customerB, customerS;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// Open 00:00-23:59 every day unless a test says otherwise, so hours never
// accidentally decide a test that is about something else.
const openAllWeek = (companyId, branchId) =>
  prisma.branchHours.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      companyId,
      branchId,
      dayOfWeek: d,
      opensMinute: 0,
      closesMinute: 1439,
    })),
  });

const submit = (body, token = tokens.ownerA) =>
  request(app).post('/api/phone-orders').set(auth(token)).send(body);

const options = (body, token = tokens.ownerA) =>
  request(app).post('/api/phone-orders/branch-options').set(auth(token)).send(body);

let keySeq = 0;
const newKey = () => `po-test-key-${(keySeq += 1)}-${Date.now()}`;

const baseSubmission = (over = {}) => ({
  idempotencyKey: newKey(),
  customerId: customerA.id,
  addressId: addrA.id,
  fulfilment: 'DELIVERY',
  branchId: a1.id,
  items: [{ productId: cappuccino.id, qty: 2 }],
  ...over,
});

// Capacity fixtures tear down in a finally, and clear before they build as well
// as after. Without both, one failing assertion leaves a cap row and orders
// behind and the NEXT capacity test dies on the fixture instead of its subject
// — which makes a negative-control run unreadable, since a cascade failure and
// a real one look identical in the output.
const withCapacity = async (branchId, maxOrdersPerSlot, fn) => {
  const clear = async () => {
    await prisma.phoneOrder.deleteMany({ where: { routedBranchId: branchId } });
    await prisma.branchPrepCapacity.deleteMany({ where: { branchId } });
  };
  await clear();
  await prisma.branchPrepCapacity.create({
    data: { companyId: companyA.id, branchId, slotMinutes: 15, maxOrdersPerSlot },
  });
  try {
    await fn();
  } finally {
    await clear();
  }
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const future = new Date(Date.now() + 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Phone', slug: 'alpha-phone',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 4, expiresAt: future } },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Phone', slug: 'bravo-phone',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 2, expiresAt: future } },
    },
  });
  single = await prisma.company.create({
    data: {
      name: 'Solo Phone', slug: 'solo-phone',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: future } },
    },
  });

  a1 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-PH-0001', name: 'Church Street', code: 'CP' } });
  a2 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-PH-0002', name: 'Indiranagar', code: 'IN' } });
  b1 = await prisma.branch.create({ data: { companyId: companyB.id, publicId: 'VC-PH-0003', name: 'Bravo One', code: 'B1' } });
  singleBranch1 = await prisma.branch.create({ data: { companyId: single.id, publicId: 'VC-PH-0004', name: 'Solo One', code: 'S1' } });
  singleBranch2 = await prisma.branch.create({ data: { companyId: single.id, publicId: 'VC-PH-0005', name: 'Solo Two', code: 'S2' } });

  await prisma.posUser.create({ data: { email: 'owner.a@ph.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id, passwordHash } });
  await prisma.posUser.create({ data: { email: 'mgr.a1@ph.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: a1.id, passwordHash } });
  await prisma.posUser.create({ data: { email: 'mgr.a2@ph.local', fullName: 'Manager A2', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: a2.id, passwordHash } });
  await prisma.posUser.create({ data: { email: 'cashier.a1@ph.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: a1.id, passwordHash } });
  await prisma.posUser.create({ data: { email: 'owner.b@ph.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id, passwordHash } });
  await prisma.posUser.create({ data: { email: 'owner.s@ph.local', fullName: 'Owner S', role: 'CUSTOMER_OWNER', companyId: single.id, passwordHash } });

  tokens.ownerA = await login('owner.a@ph.local');
  tokens.mgrA1 = await login('mgr.a1@ph.local');
  tokens.mgrA2 = await login('mgr.a2@ph.local');
  tokens.cashierA1 = await login('cashier.a1@ph.local');
  tokens.ownerB = await login('owner.b@ph.local');
  tokens.ownerS = await login('owner.s@ph.local');

  tax5 = await prisma.taxRate.create({ data: { companyId: companyA.id, name: 'GST 5%', ratePercent: '5.000' } });
  const cat = await prisma.category.create({ data: { companyId: companyA.id, name: 'Coffee' } });
  cappuccino = await prisma.product.create({
    data: { companyId: companyA.id, categoryId: cat.id, name: 'Cappuccino', basePrice: '200.00', taxRateId: tax5.id },
  });

  await openAllWeek(companyA.id, a1.id);
  await openAllWeek(companyA.id, a2.id);
  await openAllWeek(single.id, singleBranch1.id);
  await openAllWeek(single.id, singleBranch2.id);

  // 560001 is served by both A stores, at different charges, so a reassignment
  // has something to recalculate. 560099 is served by nobody.
  await prisma.branchServiceArea.createMany({
    data: [
      { companyId: companyA.id, branchId: a1.id, pincode: '560001', deliveryCharge: '40.00', minOrder: '100.00' },
      { companyId: companyA.id, branchId: a2.id, pincode: '560001', deliveryCharge: '60.00', minOrder: '100.00' },
    ],
  });

  customerA = await prisma.customer.create({ data: { companyId: companyA.id, name: 'Anita Rao', phone: '+919876500011' } });
  customerB = await prisma.customer.create({ data: { companyId: companyB.id, name: 'Bravo Caller', phone: '+919876500022' } });
  customerS = await prisma.customer.create({ data: { companyId: single.id, name: 'Solo Caller', phone: '+919876500044' } });
  addrA = await prisma.customerAddress.create({
    data: { companyId: companyA.id, customerId: customerA.id, label: 'Home', line1: '12 Church St', city: 'Bengaluru', pincode: '560001', isDefault: true },
  });
  addrFar = await prisma.customerAddress.create({
    data: { companyId: companyA.id, customerId: customerA.id, label: 'Farm', line1: 'Far away', city: 'Bengaluru', pincode: '560099' },
  });
});

afterAll(async () => {
  // Leave nothing behind: this suite's rows would otherwise sit in a shared
  // test DB across a full run.
  await wipe();
  await prisma.$disconnect();
});

describe('customer lookup stays inside the tenant', () => {
  it('finds a caller by name and by phone prefix', async () => {
    const byName = await request(app).get('/api/phone-orders/customers?q=Anita').set(auth(tokens.ownerA));
    expect(byName.status).toBe(200);
    expect(byName.body.customers.map((c) => c.id)).toContain(customerA.id);

    const byPhone = await request(app).get('/api/phone-orders/customers?q=%2B91987650001').set(auth(tokens.ownerA));
    expect(byPhone.body.customers.map((c) => c.id)).toContain(customerA.id);
  });

  it('never returns another tenant\'s caller, even on an exact phone match', async () => {
    const res = await request(app)
      .get('/api/phone-orders/customers?q=%2B919876500022')
      .set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(0);
  });

  it('refuses a direct fetch of another tenant\'s caller with 404, not 403', async () => {
    // 404 on purpose: a 403 would confirm the id exists somewhere.
    const res = await request(app).get(`/api/phone-orders/customers/${customerB.id}`).set(auth(tokens.ownerA));
    expect(res.status).toBe(404);
  });

  it('demands a real search term rather than listing every caller', async () => {
    const res = await request(app).get('/api/phone-orders/customers?q=An').set(auth(tokens.ownerA));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('q');
  });

  it('refuses a cashier outright — phone and address data is for authorized staff', async () => {
    const res = await request(app).get('/api/phone-orders/customers?q=Anita').set(auth(tokens.cashierA1));
    expect(res.status).toBe(403);
  });

  it('offers the existing caller back instead of dead-ending on a duplicate number', async () => {
    const res = await request(app)
      .post('/api/phone-orders/customers')
      .set(auth(tokens.ownerA))
      .send({ name: 'Anita R', phone: '+919876500011' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.customerId).toBe(customerA.id);
  });
});

describe('branch options explain themselves', () => {
  it('serves 560001 from both stores, at each store\'s own charge', async () => {
    const res = await options({ fulfilment: 'DELIVERY', addressId: addrA.id });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.options.map((o) => [o.branchId, o]));
    expect(byId[a1.id].available).toBe(true);
    expect(byId[a1.id].deliveryCharge).toBe(40);
    expect(byId[a2.id].deliveryCharge).toBe(60);
  });

  it('returns unserviceable stores WITH a reason rather than hiding them', async () => {
    const res = await options({ fulfilment: 'DELIVERY', addressId: addrFar.id });
    expect(res.status).toBe(200);
    // Both stores still appear; the operator has to be able to say why.
    expect(res.body.options).toHaveLength(2);
    for (const o of res.body.options) {
      expect(o.available).toBe(false);
      expect(o.unavailableReasons.map((r) => r.code)).toContain('NOT_SERVICEABLE');
    }
  });

  it('ignores serviceability for pickup — only delivery needs an address', async () => {
    const res = await options({ fulfilment: 'PICKUP' });
    expect(res.status).toBe(200);
    expect(res.body.options.every((o) => o.available)).toBe(true);
  });

  it('demands an address for delivery', async () => {
    const res = await options({ fulfilment: 'DELIVERY' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('addressId');
  });

  it('reports a closed store as closed at the requested time, not as missing', async () => {
    await prisma.branchHours.updateMany({
      where: { branchId: a2.id },
      data: { closed: true },
    });
    const res = await options({ fulfilment: 'DELIVERY', addressId: addrA.id });
    const a2opt = res.body.options.find((o) => o.branchId === a2.id);
    expect(a2opt.available).toBe(false);
    expect(a2opt.unavailableReasons.map((r) => r.code)).toContain('CLOSED_AT_FULFILMENT');
    expect(a2opt.hours.openAtFulfilment).toBe(false);
    await prisma.branchHours.updateMany({ where: { branchId: a2.id }, data: { closed: false } });
  });

  it('refuses a below-minimum basket with the store\'s own minimum', async () => {
    await prisma.branchServiceArea.updateMany({
      where: { branchId: a1.id, pincode: '560001' },
      data: { minOrder: '5000.00' },
    });
    const res = await options({
      fulfilment: 'DELIVERY',
      addressId: addrA.id,
      items: [{ productId: cappuccino.id, qty: 1 }],
    });
    const a1opt = res.body.options.find((o) => o.branchId === a1.id);
    expect(a1opt.unavailableReasons.map((r) => r.code)).toContain('BELOW_MIN_ORDER');
    await prisma.branchServiceArea.updateMany({
      where: { branchId: a1.id, pincode: '560001' },
      data: { minOrder: '100.00' },
    });
  });

  it('refuses a store whose prep slot is already full', async () => {
    await withCapacity(a2.id, 1, async () => {
      // An explicit scheduledFor, unlike the ASAP tests below: this is the
      // SCHEDULED counting path, where the booking falls inside a slot range.
      const when = new Date(Date.now() + 3600e3);
      const first = await submit(baseSubmission({ branchId: a2.id, scheduledFor: when.toISOString() }));
      expect(first.status, JSON.stringify(first.body)).toBe(201);

      const res = await options({
        fulfilment: 'DELIVERY',
        addressId: addrA.id,
        scheduledFor: when.toISOString(),
      });
      const a2opt = res.body.options.find((o) => o.branchId === a2.id);
      expect(a2opt.unavailableReasons.map((r) => r.code)).toContain('AT_CAPACITY');
      expect(a2opt.capacity.booked).toBe(1);
    });
  });

  it('counts ASAP orders against the slot as well (D-2)', async () => {
    await withCapacity(a2.id, 1, async () => {
      // No scheduledFor, so this is an ASAP order and persists scheduledFor
      // NULL. The sibling test above proves the SCHEDULED path; this one is the
      // path almost every real caller takes, and NULL never falls in a range.
      const first = await submit(baseSubmission({ branchId: a2.id }));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.phoneOrder.scheduledFor).toBeNull();

      const res = await options({ fulfilment: 'DELIVERY', addressId: addrA.id });
      const a2opt = res.body.options.find((o) => o.branchId === a2.id);
      // The kitchen holds one order per slot and is holding one, so the next
      // one has to be refused. A guard that cannot see the booking fails OPEN.
      expect(a2opt.capacity.booked).toBe(1);
      expect(a2opt.unavailableReasons.map((r) => r.code)).toContain('AT_CAPACITY');
    });
  });
});

describe('submission', () => {
  it('creates ONE real order in the routed store, priced by the shared evaluator', async () => {
    const res = await submit(baseSubmission());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const po = res.body.phoneOrder;

    expect(po.status).toBe('SUBMITTED');
    expect(po.routedBranchId).toBe(a1.id);
    expect(po.acceptedBranchId).toBe(null);
    expect(po.operatorName).toBe('Owner A');

    // 2 x 200.00 = 400.00, GST 5% = 20.00 -> 420.00. The delivery charge is
    // quoted beside it, never inside it (contract §12, C-6 open).
    expect(po.order.subtotal).toBe(400);
    expect(po.order.taxAmount).toBe(20);
    expect(po.order.total).toBe(420);
    expect(po.deliveryCharge).toBe(40);
    expect(po.deliveryChargeBillable).toBe(false);
    expect(po.payableQuote).toBe(460);

    const order = await prisma.order.findUnique({ where: { id: po.order.id } });
    expect(order.branchId).toBe(a1.id);
    expect(order.type).toBe('TAKEAWAY');
  });

  it('blocks an unserviceable address and says which reasons applied', async () => {
    const res = await submit(baseSubmission({ addressId: addrFar.id }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_BRANCH_UNAVAILABLE');
    expect(res.body.error.details.unavailableReasons.map((r) => r.code)).toContain('NOT_SERVICEABLE');
  });

  it('blocks a closed store even when the operator\'s screen said otherwise', async () => {
    await prisma.branchHours.updateMany({ where: { branchId: a1.id }, data: { closed: true } });
    const res = await submit(baseSubmission());
    expect(res.status).toBe(409);
    expect(res.body.error.details.unavailableReasons.map((r) => r.code)).toContain('CLOSED_AT_FULFILMENT');
    await prisma.branchHours.updateMany({ where: { branchId: a1.id }, data: { closed: false } });
  });

  it('requires a future time for a scheduled order', async () => {
    const past = new Date(Date.now() - 3600e3).toISOString();
    const res = await submit(baseSubmission({ scheduledFor: past }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('scheduledFor');
  });

  it('keeps the explicit fulfilment time it was given', async () => {
    const when = new Date(Date.now() + 7200e3);
    const res = await submit(baseSubmission({ scheduledFor: when.toISOString() }));
    expect(res.status).toBe(201);
    expect(new Date(res.body.phoneOrder.scheduledFor).getTime()).toBe(when.getTime());
  });

  it('refuses an address belonging to a different caller', async () => {
    const other = await prisma.customer.create({
      data: { companyId: companyA.id, name: 'Other Caller', phone: '+919876500033' },
    });
    const res = await submit(baseSubmission({ customerId: other.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('addressId');
  });

  it('refuses a branch manager routing to a store that is not theirs', async () => {
    const res = await submit(baseSubmission({ branchId: a2.id }), tokens.mgrA1);
    expect(res.status).toBe(403);
  });

  it('refuses a cashier entirely', async () => {
    const res = await submit(baseSubmission(), tokens.cashierA1);
    expect(res.status).toBe(403);
  });

  it('refuses cross-store routing without a multi-store licence', async () => {
    const res = await request(app)
      .post('/api/phone-orders')
      .set(auth(tokens.ownerS))
      .send({
        idempotencyKey: newKey(),
        // This tenant's OWN caller: otherwise tenant isolation answers 404
        // first and the entitlement gate is never reached.
        customerId: customerS.id,
        fulfilment: 'PICKUP',
        branchId: singleBranch2.id,
        items: [{ productId: cappuccino.id, qty: 1 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('POS_HQ_ROUTING_NOT_ENTITLED');
  });
});

describe('idempotent submission', () => {
  it('replays the same key to the SAME order, with 200 and no second order', async () => {
    const body = baseSubmission();
    const first = await submit(body);
    expect(first.status).toBe(201);

    const second = await submit(body);
    expect(second.status).toBe(200);
    expect(second.body.phoneOrder.id).toBe(first.body.phoneOrder.id);
    expect(second.body.phoneOrder.order.id).toBe(first.body.phoneOrder.order.id);

    const count = await prisma.phoneOrder.count({ where: { idempotencyKey: body.idempotencyKey } });
    expect(count).toBe(1);
  });

  it('survives a double-click: two concurrent identical submits make one order', async () => {
    const body = baseSubmission();
    // The test is named "make one order", so count Orders and not just the
    // PhoneOrder sidecar: the loser's whole transaction rolls back, and an
    // orphaned Order with no sidecar would be invisible to the row count below
    // while still being a real order in a real store's list. Safe as a global
    // delta because fileParallelism is off and globalSetup serializes runs.
    const ordersBefore = await prisma.order.count();

    const [r1, r2] = await Promise.all([submit(body), submit(body)]);
    const codes = [r1.status, r2.status].sort();

    // Asserted as an EXACT pair, because the loose version of this test is what
    // hid the defect it was written to catch. It asked only for `codes[0] ===
    // 201` and one row, and its comment tolerated the loser being "rejected" —
    // so the suite stayed green while the loser was in fact answered 500, from
    // an uncaught P2002 on (companyId, idempotencyKey). One operator
    // double-click, and the till showed a server error for an order that had
    // just been created.
    //
    // Both interleavings land on this same pair, so it is not flaky: either the
    // second request's pre-check sees the first already committed (200 by the
    // replay path), or it does not and the clash resolves to the same 200. The
    // key and body are identical, so 409 is unreachable here — that is the
    // reused-key test below.
    expect(codes, JSON.stringify([r1.body, r2.body])).toEqual([200, 201]);

    // The 200 has to be the SAME order, or it is a polite answer rather than a
    // correct one — the caller would be told "done" about somebody else's work.
    expect(r1.body.phoneOrder.id).toBe(r2.body.phoneOrder.id);
    expect(r1.body.phoneOrder.order.id).toBe(r2.body.phoneOrder.order.id);

    const rows = await prisma.phoneOrder.count({ where: { idempotencyKey: body.idempotencyKey } });
    expect(rows).toBe(1);
    expect(await prisma.order.count()).toBe(ordersBefore + 1);
  });

  // The concurrent half of the test below. The race resolves a duplicate by
  // re-reading the committed row and comparing hashes, so it has a 409 branch as
  // well as a 200 one, and that branch is only reachable from here — the
  // sequential test cannot enter it. Without this, a refactor could turn a raced
  // key-reuse back into a 500 and every test would stay green.
  it('refuses a reused key carrying a different order even when the two race', async () => {
    const body = baseSubmission();
    const tampered = { ...body, items: [{ productId: cappuccino.id, qty: 5 }] };

    const [r1, r2] = await Promise.all([submit(body), submit(tampered)]);
    const codes = [r1.status, r2.status].sort();
    // Deterministic whichever way it interleaves and whichever body wins: one
    // submission creates the order, the other is refused for reusing its key to
    // mean something else.
    expect(codes, JSON.stringify([r1.body, r2.body])).toEqual([201, 409]);

    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('POS_IDEMPOTENCY_KEY_REUSED');

    const rows = await prisma.phoneOrder.count({ where: { idempotencyKey: body.idempotencyKey } });
    expect(rows).toBe(1);
  });

  it('refuses a reused key carrying a different order', async () => {
    const body = baseSubmission();
    expect((await submit(body)).status).toBe(201);
    const tampered = { ...body, items: [{ productId: cappuccino.id, qty: 5 }] };
    const res = await submit(tampered);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_IDEMPOTENCY_KEY_REUSED');
  });
});

// --- D-3: a phone order can carry modifiers ----------------------------------
//
// D-3 (docs/VC104-BACKEND-DEFECTS.md) was reported as "the phone-order API has
// no modifier field, so a product with a REQUIRED group cannot be sold by
// phone". The field is only the first of it. Three more things encode modifier
// semantics on this path and each was written as though modifiers could not
// arrive: the idempotency hash, the line-merge key, and the minimum-order-value
// basket. Adding the field alone would have fixed the reported symptom and left
// three quieter wrongs behind — a replayed key handing back the wrong order, two
// different-topping lines collapsing into one, and every paid extra missing from
// the store minimum. Each has a test below, and the ones that would have been
// SILENT are marked, because a silent wrong answer is the expensive kind.
//
// Fixtures are built through prisma rather than the catalog API on purpose: this
// suite's catalog has always been built that way (see `cappuccino` above), and
// going through HTTP would couple these tests to the D-5 two-step group
// workflow, which is a different lane's subject.
describe('a phone order can carry modifiers (D-3)', () => {
  let pizza;
  let sizeRegular, sizeLarge, topCheese, topOlive, archivedOption, foreignOption, otherProductOption;

  const withMinOrder = async (branchId, minOrder, body) => {
    const prior = await prisma.branchServiceArea.findFirst({ where: { branchId, pincode: '560001' } });
    await prisma.branchServiceArea.updateMany({
      where: { branchId, pincode: '560001' },
      data: { minOrder },
    });
    try {
      return await body();
    } finally {
      // try/finally rather than this suite's usual restore-at-the-end, because
      // these tests get deliberately failed during negative-control runs and a
      // minimum left at 350.00 would cascade into the blocks below — turning a
      // readable control into noise about unrelated tests.
      await prisma.branchServiceArea.updateMany({
        where: { branchId, pincode: '560001' },
        data: { minOrder: prior.minOrder },
      });
    }
  };

  const linesOf = (orderId) =>
    prisma.orderItem.findMany({
      where: { orderId, status: 'ACTIVE' },
      include: { modifiers: true },
      orderBy: { unitPrice: 'desc' },
    });

  beforeAll(async () => {
    const cat = await prisma.category.create({ data: { companyId: companyA.id, name: 'Pizza' } });
    pizza = await prisma.product.create({
      data: { companyId: companyA.id, categoryId: cat.id, name: 'Margherita', basePrice: '300.00', taxRateId: tax5.id },
    });

    // Exactly-one Size is what makes this product unsellable before the fix.
    const size = await prisma.modifierGroup.create({
      data: { productId: pizza.id, name: 'Size', minSelect: 1, maxSelect: 1, status: 'ACTIVE' },
    });
    sizeRegular = await prisma.modifierOption.create({
      data: { groupId: size.id, name: 'Regular', price: '0.00', status: 'ACTIVE' },
    });
    sizeLarge = await prisma.modifierOption.create({
      data: { groupId: size.id, name: 'Large', price: '100.00', status: 'ACTIVE' },
    });

    const tops = await prisma.modifierGroup.create({
      data: { productId: pizza.id, name: 'Toppings', minSelect: 0, maxSelect: 2, status: 'ACTIVE' },
    });
    topCheese = await prisma.modifierOption.create({
      data: { groupId: tops.id, name: 'Extra cheese', price: '50.00', status: 'ACTIVE' },
    });
    topOlive = await prisma.modifierOption.create({
      data: { groupId: tops.id, name: 'Olives', price: '30.00', status: 'ACTIVE' },
    });
    archivedOption = await prisma.modifierOption.create({
      data: { groupId: tops.id, name: 'Anchovies', price: '70.00', status: 'ARCHIVED' },
    });

    // Two near-misses that must not be accepted: a live option on a DIFFERENT
    // product of the same tenant, and a live option in a DIFFERENT tenant. The
    // sibling is its own product rather than a group bolted onto `cappuccino`,
    // so nothing here changes what the blocks around this one are selling.
    const sibling = await prisma.product.create({
      data: { companyId: companyA.id, categoryId: cat.id, name: 'Calzone', basePrice: '280.00', taxRateId: tax5.id },
    });
    const otherGroup = await prisma.modifierGroup.create({
      data: { productId: sibling.id, name: 'Filling', minSelect: 0, maxSelect: 1, status: 'ACTIVE' },
    });
    otherProductOption = await prisma.modifierOption.create({
      data: { groupId: otherGroup.id, name: 'Oat', price: '25.00', status: 'ACTIVE' },
    });
    const bCat = await prisma.category.create({ data: { companyId: companyB.id, name: 'Bravo Food' } });
    const bProduct = await prisma.product.create({
      data: { companyId: companyB.id, categoryId: bCat.id, name: 'Bravo Pizza', basePrice: '300.00' },
    });
    const bGroup = await prisma.modifierGroup.create({
      data: { productId: bProduct.id, name: 'Size', minSelect: 0, maxSelect: 1, status: 'ACTIVE' },
    });
    foreignOption = await prisma.modifierOption.create({
      data: { groupId: bGroup.id, name: 'Large', price: '100.00', status: 'ACTIVE' },
    });
  });

  // --- the reported symptom --------------------------------------------------

  it('sells a product whose group is REQUIRED — the thing D-3 says it cannot', async () => {
    const res = await submit(
      baseSubmission({ items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeRegular.id] }] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.phoneOrder.order.subtotal).toBe(300);

    // The snapshot rows are the half `createMany` could not write. Reading them
    // back is what separates "the request was accepted" from "the choice was
    // recorded" — the old path would have thrown rather than drop them, but a
    // future one could drop them quietly.
    const [line] = await linesOf(res.body.phoneOrder.order.id);
    expect(line.modifiers.map((m) => [m.groupName, m.name])).toEqual([['Size', 'Regular']]);
  });

  it('still refuses to skip a required choice, in the catalog\'s own words', async () => {
    const body = baseSubmission({ items: [{ productId: pizza.id, qty: 1 }] });
    const res = await submit(body);
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('modifierOptionIds');
    expect(res.body.error.message).toMatch(/at least 1 from "Size"/);
    // Refused before anything was written, so the key stays usable.
    expect(await prisma.phoneOrder.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(0);
  });

  it('refuses more of a group than it allows', async () => {
    const res = await submit(
      baseSubmission({
        items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeRegular.id, sizeLarge.id] }],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at most 1 from "Size"/);
  });

  it('refuses an archived option, another product\'s option and another tenant\'s', async () => {
    for (const bad of [archivedOption.id, otherProductOption.id, foreignOption.id]) {
      const res = await submit(
        baseSubmission({ items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeRegular.id, bad] }] }),
      );
      expect(res.status, `option ${bad}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.error.field).toBe('modifierOptionIds');
      // The MESSAGE, not just the field. Status and field alone do not
      // discriminate here: an API that ignored `modifierOptionIds` outright
      // would answer 400 on this same field, because the Size group is then
      // unsatisfied — so this test passed against the unfixed code. Naming the
      // reason is what makes it evidence that the option was rejected rather
      // than never read.
      expect(res.body.error.message, `option ${bad}`).toMatch(/Unknown or archived modifier option/);
    }
  });

  // --- price -----------------------------------------------------------------

  it('folds the extras into the line price, the tax and the quote', async () => {
    const res = await submit(
      baseSubmission({
        items: [{ productId: pizza.id, qty: 2, modifierOptionIds: [sizeLarge.id, topCheese.id] }],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const po = res.body.phoneOrder;

    // 300 + 100 + 50 = 450 a pizza, two of them = 900, GST 5% = 45 -> 945.
    // Delivery 40 is quoted beside the order, never inside it.
    expect(po.order.subtotal).toBe(900);
    expect(po.order.taxAmount).toBe(45);
    expect(po.order.total).toBe(945);
    expect(po.payableQuote).toBe(985);

    const [line] = await linesOf(po.order.id);
    expect(Number(line.unitPrice)).toBe(450);
    expect(line.modifiers.map((m) => Number(m.price)).sort((a, b) => a - b)).toEqual([50, 100]);
  });

  // --- the line-merge key ----------------------------------------------------

  it('keeps two lines apart when only the topping differs — SILENT before the fix', async () => {
    const res = await submit(
      baseSubmission({
        items: [
          { productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id] },
          { productId: pizza.id, qty: 1, modifierOptionIds: [sizeRegular.id] },
          { productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id] },
        ],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // The old key was product|variant, so all three collapsed onto one line at
    // whichever size was seen first: a qty-3 Large, billed 1200 instead of 1100,
    // and a kitchen ticket that never mentions the Regular. No error either way.
    const lines = await linesOf(res.body.phoneOrder.order.id);
    expect(lines.map((l) => [Number(l.unitPrice), l.qty])).toEqual([[400, 2], [300, 1]]);
    expect(res.body.phoneOrder.order.subtotal).toBe(1100);
  });

  it('treats one choice written two ways as one line', async () => {
    const res = await submit(
      baseSubmission({
        items: [
          { productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id, topCheese.id] },
          { productId: pizza.id, qty: 1, modifierOptionIds: [topCheese.id, sizeLarge.id] },
          // The same option twice in one item is still one of it, so this must
          // merge too and must not be priced twice or trip Size's maximum.
          { productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id, topCheese.id, sizeLarge.id] },
        ],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lines = await linesOf(res.body.phoneOrder.order.id);
    expect(lines.map((l) => [Number(l.unitPrice), l.qty])).toEqual([[450, 3]]);
  });

  // --- idempotency -----------------------------------------------------------

  it('refuses a reused key whose toppings changed — SILENT before the fix', async () => {
    const body = baseSubmission({
      items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id, topCheese.id] }],
    });
    const first = await submit(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const changed = { ...body, items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeRegular.id] }] };
    const res = await submit(changed);

    // Without the modifiers in the hash this answered 200 and handed back the
    // FIRST order: the operator is told the plain one succeeded, and the caller
    // who asked to change their mind is billed 450 for a 300 pizza. A 409 that
    // says the key is in use is the only honest answer.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('POS_IDEMPOTENCY_KEY_REUSED');

    const [line] = await linesOf(first.body.phoneOrder.order.id);
    expect(Number(line.unitPrice)).toBe(450);
    expect(await prisma.phoneOrder.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);
  });

  it('replays one choice written two ways as the same request, not a clash', async () => {
    const body = baseSubmission({
      items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id, topCheese.id] }],
    });
    const first = await submit(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // The dedupe-and-sort has to be in the hash as well as the merge key. A
    // retry that lists the same two options the other way round is the same
    // request; refusing it would be a new wrong answer invented by the fix.
    const second = await submit({
      ...body,
      items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [topCheese.id, sizeLarge.id] }],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.phoneOrder.id).toBe(first.body.phoneOrder.id);
    expect(await prisma.phoneOrder.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);
  });

  // --- the minimum-order-value basket ----------------------------------------

  it('counts the paid extras towards the store minimum — SILENT before the fix', async () => {
    await withMinOrder(a1.id, '350.00', async () => {
      const large = [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id] }];
      const plain = [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeRegular.id] }];

      // 300 + 100 clears 350. Counting base price alone put this basket at 300
      // and refused a delivery the store would happily have taken.
      const seen = await options({ fulfilment: 'DELIVERY', addressId: addrA.id, items: large });
      const a1opt = seen.body.options.find((o) => o.branchId === a1.id);
      expect(a1opt.unavailableReasons.map((r) => r.code)).not.toContain('BELOW_MIN_ORDER');
      expect((await submit(baseSubmission({ items: large }))).status).toBe(201);

      // And the number is still real: the same pizza without the paid size is
      // 300 and is still refused. Without this half the test above passes on a
      // minimum that was simply never enforced.
      const under = await options({ fulfilment: 'DELIVERY', addressId: addrA.id, items: plain });
      const underOpt = under.body.options.find((o) => o.branchId === a1.id);
      expect(underOpt.unavailableReasons.map((r) => r.code)).toContain('BELOW_MIN_ORDER');
      expect((await submit(baseSubmission({ items: plain }))).status).toBe(409);
    });
  });

  // --- reassignment ----------------------------------------------------------

  it('carries the extras into the new store\'s minimum, and keeps their price', async () => {
    const created = await submit(
      baseSubmission({ items: [{ productId: pizza.id, qty: 1, modifierOptionIds: [sizeLarge.id] }] }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const po = created.body.phoneOrder;

    await withMinOrder(a2.id, '350.00', async () => {
      // Reassign rebuilds the basket from the STORED lines, which is the one
      // place the modifier ids are not in the request. Reading them back out of
      // the order rows is what lets this order move at all: without it the
      // basket is 300 against a 350 minimum and the move is refused.
      const res = await request(app)
        .post(`/api/phone-orders/${po.id}/reassign`)
        .set(auth(tokens.ownerA))
        .send({ branchId: a2.id, reason: 'first store went down' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.phoneOrder.routedBranchId).toBe(a2.id);
      expect(res.body.phoneOrder.deliveryCharge).toBe(60);
    });

    // Recompute runs off the stored rows, so the extra is still paid for and
    // its snapshot survived the move.
    const order = await prisma.order.findUnique({ where: { id: po.order.id } });
    expect(Number(order.total)).toBe(420);
    const [line] = await linesOf(po.order.id);
    expect(Number(line.unitPrice)).toBe(400);
    expect(line.modifiers.map((m) => m.name)).toEqual(['Large']);
  });
});

describe('exactly one accepting store', () => {
  it('lets the routed store accept, with attribution', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;

    const res = await request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.mgrA1)).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.phoneOrder.status).toBe('ACCEPTED');
    expect(res.body.phoneOrder.acceptedBranchId).toBe(a1.id);
    expect(res.body.phoneOrder.acceptedByName).toBe('Manager A1');
  });

  it('refuses a store that was not routed the order', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;
    const res = await request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.mgrA2)).send({});
    expect(res.status).toBe(404);
  });

  it('gives exactly one winner when two accepts race', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.mgrA1)).send({}),
      request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.ownerA)).send({}),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = [r1, r2].find((r) => r.status === 409);
    expect(loser.body.error.code).toBe('POS_PHONE_ORDER_ALREADY_DECIDED');

    const row = await prisma.phoneOrder.findUnique({ where: { id } });
    expect(row.acceptedBranchId).toBe(a1.id);

    // The decisive check: the order and its KOTs were made once, at submission,
    // so a second acceptance cannot have duplicated either.
    const orders = await prisma.order.count({ where: { id: row.orderId } });
    expect(orders).toBe(1);
    const kots = await prisma.kot.count({ where: { orderId: row.orderId } });
    expect(kots).toBe(0);
  });

  it('cannot be accepted twice in sequence either', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;
    expect((await request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.mgrA1)).send({})).status).toBe(200);
    const again = await request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.mgrA1)).send({});
    expect(again.status).toBe(409);
  });

  it('records a rejection with its reason and actor', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;
    const res = await request(app)
      .post(`/api/phone-orders/${id}/reject`)
      .set(auth(tokens.mgrA1))
      .send({ reason: 'kitchen at capacity until 16:00' });
    expect(res.status).toBe(200);
    expect(res.body.phoneOrder.status).toBe('REJECTED');
    expect(res.body.phoneOrder.rejectedByName).toBe('Manager A1');
    expect(res.body.phoneOrder.rejectReason).toMatch(/capacity/);
  });
});

describe('reassignment recalculates, and never moves an issued invoice', () => {
  it('moves the order and recomputes price and tax for the new store', async () => {
    const created = await submit(baseSubmission());
    const po = created.body.phoneOrder;
    expect(po.deliveryCharge).toBe(40);

    const res = await request(app)
      .post(`/api/phone-orders/${po.id}/reassign`)
      .set(auth(tokens.ownerA))
      .send({ branchId: a2.id, reason: 'original store rejected' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(res.body.phoneOrder.routedBranchId).toBe(a2.id);
    // The second store charges 60 for the same pincode.
    expect(res.body.phoneOrder.deliveryCharge).toBe(60);

    const order = await prisma.order.findUnique({ where: { id: po.order.id } });
    expect(order.branchId).toBe(a2.id);
    // Same catalog, so the food total is unchanged — but it was recomputed, not
    // carried over: the tax figure is re-derived from the lines.
    expect(Number(order.total)).toBe(420);
    expect(Number(order.taxAmount)).toBe(20);
  });

  it('reports a price change when only the delivery charge moved (D-1)', async () => {
    const created = await submit(baseSubmission());
    const po = created.body.phoneOrder;
    expect(po.deliveryCharge).toBe(40);
    expect(po.payableQuote).toBe(460);

    const res = await request(app)
      .post(`/api/phone-orders/${po.id}/reassign`)
      .set(auth(tokens.ownerA))
      .send({ branchId: a2.id, reason: 'original store rejected' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The caller pays 480 now instead of 460, and the operator has to be told
    // before they hang up. Food and tax CANNOT move on a reassignment — the
    // catalog is company-wide (C-7) and each line's tax rate is snapshotted at
    // submit — so the delivery charge is the only thing a reassignment changes.
    // A priceChanged derived from total and tax alone is therefore not merely
    // inaccurate here; it can never be true on any reassignment at all.
    expect(res.body.phoneOrder.payableQuote).toBe(480);
    expect(res.body.priceChanged).toBe(true);
  });

  it('stays quiet when the move costs the caller nothing (D-1 control)', async () => {
    // Two stores serving one pincode at the same charge. Without this, a flag
    // hardwired to true would satisfy the test above and still be useless — the
    // operator would re-quote every caller on every move and learn to ignore it.
    await prisma.branchServiceArea.updateMany({
      where: { branchId: a2.id, pincode: '560001' },
      data: { deliveryCharge: '40.00' },
    });

    const created = await submit(baseSubmission());
    const po = created.body.phoneOrder;
    expect(po.payableQuote).toBe(460);

    const res = await request(app)
      .post(`/api/phone-orders/${po.id}/reassign`)
      .set(auth(tokens.ownerA))
      .send({ branchId: a2.id, reason: 'balancing the load' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.phoneOrder.payableQuote).toBe(460);
    expect(res.body.priceChanged).toBe(false);

    await prisma.branchServiceArea.updateMany({
      where: { branchId: a2.id, pincode: '560001' },
      data: { deliveryCharge: '60.00' },
    });
  });

  const moveToA2 = async (reason, backdateMs = 0) => {
    const c = await submit(baseSubmission());
    if (backdateMs) {
      await prisma.phoneOrder.update({
        where: { id: c.body.phoneOrder.id },
        data: { createdAt: new Date(Date.now() - backdateMs) },
      });
    }
    return request(app)
      .post(`/api/phone-orders/${c.body.phoneOrder.id}/reassign`)
      .set(auth(tokens.ownerA))
      .send({ branchId: a2.id, reason });
  };

  // Renamed from "against the slot it was taken in": since the slot anchor
  // landed, a transfer is counted against the slot it ARRIVES in. Here the two
  // are the same slot, because the move follows the call immediately — which is
  // the ordinary operator action and why this case worked even under the defect.
  it('counts a promptly reassigned ASAP order against the destination slot (D-2)', async () => {
    await withCapacity(a2.id, 2, async () => {
      // One order taken natively at a2, leaving room for exactly one more.
      expect((await submit(baseSubmission({ branchId: a2.id }))).status).toBe(201);

      // Two moved in from a1 within the same slot. The first fits; the second
      // must be refused, which is the point of counting ASAP orders at all.
      expect((await moveToA2('load balancing')).status).toBe(200);
      expect((await moveToA2('load balancing')).status).toBe(409);
    });
  });

  // What `booked` is at a2 in the slot containing `instant`. /branch-options
  // takes scheduledFor verbatim and does not require it to be in the future, so
  // this reads any slot — past, present or future — without fake timers and
  // without depending on when the suite runs. Reads capacity, never `available`:
  // availability also folds in opening hours, and these tests are about counting.
  const bookedAtA2 = async (instant) => {
    const res = await options({
      fulfilment: 'DELIVERY',
      addressId: addrA.id,
      ...(instant ? { scheduledFor: instant.toISOString() } : {}),
    });
    return res.body.options.find((o) => o.branchId === a2.id).capacity.booked;
  };

  const liveAtA2 = () =>
    prisma.phoneOrder.count({
      where: { routedBranchId: a2.id, status: { in: ['SUBMITTED', 'ACCEPTED'] } },
    });

  // The source side of the same question. a2 is the branch these tests cap, so
  // a1 is where a refused transfer has to still be found.
  const liveAtA1 = () =>
    prisma.phoneOrder.count({
      where: { routedBranchId: a1.id, status: { in: ['SUBMITTED', 'ACCEPTED'] } },
    });

  // THE INVARIANT, replacing `does NOT count an ASAP order moved after its slot
  // elapsed (D-2 limitation)` — which asserted the undercount and so could only
  // ever prove the bug was still there.
  //
  // An order occupies the slot in which the store holding it was asked. For a
  // transfer that is the moment of the MOVE, not the moment of the call, so a
  // back-dated order cannot arrive for free. The old test moved three hour-old
  // orders into a store capped at two and got three 200s, four live orders and
  // `booked: 1, available: true`.
  it('counts a back-dated transfer against the slot it ARRIVES in, and refuses past the cap', async () => {
    await withCapacity(a2.id, 2, async () => {
      expect((await submit(baseSubmission({ branchId: a2.id }))).status).toBe(201);

      // Each of these was taken an hour ago at a1 — a slot long elapsed. They
      // are being cooked at a2 NOW, so they consume a2's capacity now.
      const first = await moveToA2('moved late', 3600_000);
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const second = await moveToA2('moved late', 3600_000);
      expect(second.status, JSON.stringify(second.body)).toBe(409);
      expect(second.body.error.code).toBe('POS_BRANCH_UNAVAILABLE');
      expect(second.body.error.details.unavailableReasons[0]).toEqual({
        code: 'AT_CAPACITY',
        message: 'Kitchen is full for that time (2/2)',
      });

      // Live orders and reported booked now agree. Under the defect these were
      // 4 and 1.
      expect(await liveAtA2()).toBe(2);
      expect(await bookedAtA2()).toBe(2);

      // And the refusal is not the count merely saturating: the store is shut
      // to the next caller too.
      const opt = await options({ fulfilment: 'DELIVERY', addressId: addrA.id });
      expect(opt.body.options.find((o) => o.branchId === a2.id).available).toBe(false);
    });
  });

  // How many advisory locks in the slot namespace are held / queued, in THIS
  // database. classid is the namespace reserveSlot uses; globalSetup's suite
  // lock is the one-argument form, which Postgres files under classid 0, so it
  // cannot be mistaken for one of these.
  const slotLocks = async (granted) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 5653849
          AND granted = $1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      granted,
    );
    return rows[0].n;
  };

  // Polls a condition instead of sleeping on a guess, and fails with the reason
  // rather than with a bare timeout — because in this test "the condition never
  // became true" IS the defect being detected, and it has to be legible.
  const waitFor = async (what, cond, tries = 200) => {
    for (let i = 0; i < tries; i += 1) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  // THE BINDING RE-CHECK, forced. Every other capacity test here is refused by
  // the ADVISORY read in loadBranchDecision, which runs before the transaction
  // opens — so not one of them ever reaches the check inside it. The mutation
  // battery proved that rather than it being noticed by reading: deleting the
  // in-transaction reserveSlot (M3) left the whole suite GREEN, and moving it
  // to after the commit (M10) left even the source-preservation test green.
  // Both escaped for the same reason — a destination that is ALREADY full is
  // caught early, so the atomicity was argued and never asserted.
  //
  // Reaching it means filling the slot AFTER the advisory read and BEFORE the
  // transaction's re-count. That is arranged deterministically, not with a
  // sleep: a concurrent transaction takes the slot lock and fills the slot
  // without committing, so the advisory read — READ COMMITTED, and it takes no
  // lock — still sees room; the request then queues on the lock inside its own
  // transaction; and the handoff is a waiter appearing in pg_locks, not a timer.
  //
  // If the binding check is absent there is never a waiter, so this fails
  // loudly instead of passing by accident. That is the point of it.
  it('re-checks capacity inside the transaction, after the advisory read said yes', async () => {
    await withCapacity(a2.id, 1, async () => {
      const victim = (await submit(baseSubmission())).body.phoneOrder;
      const { start } = slotBoundsFor(new Date(), 15);

      let release;
      const held = new Promise((r) => { release = r; });
      const blocker = prisma.$transaction(
        async (tx) => {
          await lockSlot(tx, { companyId: companyA.id, branchId: a2.id, start });
          // a2 is now full — but only to this uncommitted transaction.
          await tx.phoneOrder.create({
            data: {
              companyId: companyA.id,
              reference: `PH-LATEFILL-${Date.now()}`,
              customerId: customerA.id,
              fulfilment: 'PICKUP',
              status: 'SUBMITTED',
              routedBranchId: a2.id,
              operatorName: 'late fill',
              idempotencyKey: `latefill-${Date.now()}`,
              requestHash: 'latefill',
            },
          });
          await held;
        },
        { timeout: 20000, maxWait: 20000 },
      );

      let moving;
      try {
        await waitFor('the blocker to hold the slot lock', async () => (await slotLocks(true)) >= 1);

        moving = request(app)
          .post(`/api/phone-orders/${victim.id}/reassign`)
          .set(auth(tokens.ownerA))
          .send({ branchId: a2.id, reason: 'the slot fills while this is in flight' });
        moving.catch(() => {});

        // Past its advisory read (which saw room) and now queued on the lock.
        await waitFor('the request to queue on the slot lock', async () => (await slotLocks(false)) >= 1);
      } finally {
        release();
        await blocker.catch(() => {});
      }

      const refused = await moving;
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.details.unavailableReasons[0].code).toBe('AT_CAPACITY');

      // Refused AND rolled back. M10 keeps the 409 and loses only this.
      const after = await prisma.phoneOrder.findUnique({ where: { id: victim.id } });
      expect(after.routedBranchId).toBe(a1.id);
      expect(
        await prisma.phoneOrderEvent.count({
          where: { phoneOrderId: victim.id, action: 'REASSIGNED' },
        }),
      ).toBe(0);
      expect(await liveAtA2()).toBe(1); // the late fill only

      await prisma.phoneOrder.deleteMany({ where: { id: victim.id } });
    });
  });

  // A refused transfer must leave the SOURCE untouched. Every other test here
  // watches the destination — that the order did not arrive, that the count did
  // not move — and none of them would notice a refusal that had already written
  // half the move before throwing: routedBranchId repointed, status flipped, or
  // the REASSIGNED event logged. reserveSlot throws before any write, so the
  // refusal is a no-op; until now that was an argument from reading the code
  // rather than an assertion, which is exactly the kind of claim this file is
  // supposed to pin.
  it('leaves the source order, its status and its event log untouched when refused', async () => {
    await withCapacity(a2.id, 1, async () => {
      // a2 is full with one native order, so any transfer in must be refused.
      expect((await submit(baseSubmission({ branchId: a2.id }))).status).toBe(201);

      const created = await submit(baseSubmission());
      const po = created.body.phoneOrder;
      try {
        const before = await prisma.phoneOrder.findUnique({ where: { id: po.id } });
        expect(before.routedBranchId).toBe(a1.id);
        const liveAtA1Before = await liveAtA1();

        const refused = await request(app)
          .post(`/api/phone-orders/${po.id}/reassign`)
          .set(auth(tokens.ownerA))
          .send({ branchId: a2.id, reason: 'destination is full' });
        expect(refused.status, JSON.stringify(refused.body)).toBe(409);
        expect(refused.body.error.details.unavailableReasons[0].code).toBe('AT_CAPACITY');

        // The source order is byte-for-byte where it was. updatedAt is the
        // sensitive one: Prisma stamps it on ANY write to the row, so an equal
        // updatedAt rules out a write that was later corrected, not merely a
        // net-zero change.
        const after = await prisma.phoneOrder.findUnique({ where: { id: po.id } });
        expect(after.routedBranchId).toBe(a1.id);
        expect(after.status).toBe(before.status);
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

        // Its reservation at the source survives: still live, still counted there.
        expect(await liveAtA1()).toBe(liveAtA1Before);

        // Nothing was logged. A partial move would have left this behind, and
        // because the slot anchor READS this event, a stray one would also
        // silently re-anchor the order to a store it never reached.
        expect(
          await prisma.phoneOrderEvent.count({
            where: { phoneOrderId: po.id, action: 'REASSIGNED' },
          }),
        ).toBe(0);

        // And the destination did not absorb a phantom place either.
        expect(await bookedAtA2()).toBe(1);
        expect(await liveAtA2()).toBe(1);
      } finally {
        // withCapacity only clears orders routed to a2; this one stayed at a1
        // by design, so it has to take itself away or it leaks into the next test.
        await prisma.phoneOrder.deleteMany({ where: { id: po.id } });
      }
    });
  });

  // An order occupies ONE slot. That sounds too obvious to be worth a test, and
  // it was structurally guaranteed while the anchor was a single COALESCE — a
  // scalar cannot fall inside two windows. It is no longer guaranteed:
  // countBookedInSlot now evaluates the same rule as three UNIONed arms so it
  // can use an index, and arms B and C are kept disjoint only by a NOT EXISTS.
  // Delete that clause and a moved order is counted BOTH in the slot it arrived
  // in and in the stale slot matching its original createdAt.
  //
  // Nothing else catches that: every other test reads the CURRENT slot, and the
  // phantom lands in a past one. So this reads both.
  it('occupies only the slot it arrived in, not also the slot it was called in', async () => {
    await withCapacity(a2.id, 5, async () => {
      const calledAt = new Date(Date.now() - 3600_000);
      const moved = await moveToA2('moved late', 3600_000);
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);

      // The arrival slot holds it...
      expect(await bookedAtA2()).toBe(1);
      // ...and the slot it was originally called in holds nothing. With the
      // NOT EXISTS gone this reads 1, and the order is booked twice over.
      expect(await bookedAtA2(calledAt)).toBe(0);
      // Exactly one order exists, so the two readings cannot both be right.
      expect(await liveAtA2()).toBe(1);
    });
  });

  // The refusal must cost the source nothing. A transfer that bounces has to
  // leave a recoverable order behind, not a half-moved one — and it must not
  // leave a reservation at the destination either, or a store loses a place to
  // an order it never received.
  it('leaves the source order untouched when the destination refuses', async () => {
    await withCapacity(a2.id, 1, async () => {
      expect((await submit(baseSubmission({ branchId: a2.id }))).status).toBe(201);

      const created = await submit(baseSubmission());
      const po = created.body.phoneOrder;
      const before = await prisma.phoneOrder.findUnique({ where: { id: po.id } });

      const res = await request(app)
        .post(`/api/phone-orders/${po.id}/reassign`)
        .set(auth(tokens.ownerA))
        .send({ branchId: a2.id, reason: 'destination is full' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);

      const after = await prisma.phoneOrder.findUnique({ where: { id: po.id } });
      expect(after.routedBranchId).toBe(a1.id);
      expect(after.status).toBe('SUBMITTED');
      expect(after.deliveryCharge).toEqual(before.deliveryCharge);
      // The whole transaction rolled back, so the Order did not move either.
      expect((await prisma.order.findUnique({ where: { id: po.order.id } })).branchId).toBe(a1.id);
      // No REASSIGNED event was written, so nothing anchors at a2...
      expect(
        await prisma.phoneOrderEvent.count({
          where: { phoneOrderId: po.id, action: 'REASSIGNED' },
        }),
      ).toBe(0);
      // ...and a2 still holds exactly the one order it really has.
      expect(await bookedAtA2()).toBe(1);
    });
  });

  // Retry/replay. Reassign has no idempotency key, so a double-click is two real
  // requests. Neither a refused transfer nor a repeated successful one may move
  // the count: the first is rolled back, the second is refused as a no-op move.
  it('does not double-book on retry, whether the first attempt failed or succeeded', async () => {
    await withCapacity(a2.id, 2, async () => {
      const created = await submit(baseSubmission());
      const po = created.body.phoneOrder;
      const move = () =>
        request(app)
          .post(`/api/phone-orders/${po.id}/reassign`)
          .set(auth(tokens.ownerA))
          .send({ branchId: a2.id, reason: 'operator retried' });

      expect((await move()).status).toBe(200);
      expect(await bookedAtA2()).toBe(1);

      // Replay of a move that already happened. Refused as "already routed
      // there" rather than counted again.
      const replay = await move();
      expect(replay.status).toBe(400);
      expect(await bookedAtA2()).toBe(1);
      expect(await liveAtA2()).toBe(1);

      // Exactly one anchor event, so the count cannot double even in principle.
      expect(
        await prisma.phoneOrderEvent.count({
          where: { phoneOrderId: po.id, action: 'REASSIGNED', toBranchId: a2.id },
        }),
      ).toBe(1);
    });
  });

  // THE LOCK ITSELF. The HTTP test below does not exercise it — measured
  // 2026-09-24, two reassigns fired with Promise.all enter reserveSlot 28 ms
  // apart and the first finishes counting 25 ms before the second arrives,
  // because each request makes eight sequential round trips before opening its
  // transaction. That test therefore passed with the lock removed, which makes
  // it worthless as evidence for the lock however much it looks like a race.
  //
  // This one drives the real reserveSlot in two parallel transactions that hold
  // their critical sections open across each other, so the overlap is a fact of
  // the test rather than a hope about scheduling.
  it('serializes two genuinely overlapping reservations for the last place', async () => {
    await withCapacity(a2.id, 1, async () => {
      let n = 0;
      const attempt = () =>
        prisma.$transaction(async (tx) => {
          await reserveSlot(tx, { companyId: companyA.id, branchId: a2.id, when: new Date() });
          // Held open so the other transaction is provably inside its own
          // critical section at the same time. Without the lock both count 0,
          // both sleep, and both write — the cap becomes a suggestion.
          await new Promise((r) => setTimeout(r, 150));
          await tx.phoneOrder.create({
            data: {
              companyId: companyA.id,
              reference: `PH-RACE-${(n += 1)}-${Date.now()}`,
              customerId: customerA.id,
              fulfilment: 'PICKUP',
              status: 'SUBMITTED',
              routedBranchId: a2.id,
              operatorName: 'race probe',
              idempotencyKey: `race-${n}-${Date.now()}`,
              requestHash: 'race',
            },
          });
        });

      const settled = await Promise.allSettled([attempt(), attempt()]);
      const ok = settled.filter((s) => s.status === 'fulfilled');
      const refused = settled.filter((s) => s.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0].reason?.details?.unavailableReasons?.[0]?.code).toBe('AT_CAPACITY');

      // The decisive one: the cap held against a real overlap.
      expect(await liveAtA2()).toBe(1);
      expect(await bookedAtA2()).toBe(1);
    });
  });

  // End-to-end cover for the same rule over HTTP. Kept deliberately even though
  // the two requests do not truly contend (see above): it proves the route
  // refuses the second transfer with the right status and reason, which the
  // direct test cannot show.
  it('lets exactly one of two simultaneous transfers take the last place', async () => {
    await withCapacity(a2.id, 2, async () => {
      expect((await submit(baseSubmission({ branchId: a2.id }))).status).toBe(201);

      const one = await submit(baseSubmission());
      const two = await submit(baseSubmission());
      const race = (po) =>
        request(app)
          .post(`/api/phone-orders/${po.body.phoneOrder.id}/reassign`)
          .set(auth(tokens.ownerA))
          .send({ branchId: a2.id, reason: 'both operators moved at once' });

      const results = await Promise.all([race(one), race(two)]);
      const codes = results.map((r) => r.status).sort();
      expect(codes, JSON.stringify(results.map((r) => r.body))).toEqual([200, 409]);

      // The decisive assertion: the cap held. Two would also be the answer if
      // both had been refused, which is why liveAtA2 is checked as well.
      expect(await bookedAtA2()).toBe(2);
      expect(await liveAtA2()).toBe(2);
    });
  });

  // Slot boundaries are half-open, [start, end). The anchor of a transfer is the
  // instant of the move, so this pins which side of a boundary that instant
  // falls on — asserted against the real grid rather than a re-derivation, by
  // reading the move's own event.
  it('anchors a transfer inclusively at slot start and exclusively at slot end', async () => {
    await withCapacity(a2.id, 5, async () => {
      const created = await submit(baseSubmission());
      const po = created.body.phoneOrder;
      expect(
        (
          await request(app)
            .post(`/api/phone-orders/${po.id}/reassign`)
            .set(auth(tokens.ownerA))
            .send({ branchId: a2.id, reason: 'boundary probe' })
        ).status,
      ).toBe(200);

      const ev = await prisma.phoneOrderEvent.findFirst({
        where: { phoneOrderId: po.id, action: 'REASSIGNED', toBranchId: a2.id },
      });
      const SLOT = 15 * 60_000;
      const start = Math.floor(ev.at.getTime() / SLOT) * SLOT;

      // The anchor is moved ONTO the boundary. Left where it naturally fell —
      // somewhere in the middle of a slot — neither edge of the window is ever
      // tested, and a rule using <= for the slot end passes just as happily.
      await prisma.phoneOrderEvent.update({
        where: { id: ev.id },
        data: { at: new Date(start) },
      });

      // Inclusive at the start: an order anchored exactly at the opening
      // instant belongs to THIS slot.
      expect(await bookedAtA2(new Date(start))).toBe(1);
      expect(await bookedAtA2(new Date(start + SLOT - 1))).toBe(1);

      // Exclusive at the end: the previous slot ends at `start` and must NOT
      // claim it, or two adjacent slots both count the same order.
      expect(await bookedAtA2(new Date(start - 1))).toBe(0);
      expect(await bookedAtA2(new Date(start - SLOT))).toBe(0);
      // Nor does the next slot reach back for it.
      expect(await bookedAtA2(new Date(start + SLOT))).toBe(0);
    });
  });

  // The test above probes ONE arm. countBookedInSlot answers the rule as three
  // UNIONed arms — scheduled, moved-in, and native — so the half-open window is
  // written three times, against three different columns. A mutation run proved
  // that: turning `< end` into `<= end` in the scheduled arm and in the native
  // arm left the whole suite green, because the test above anchors on a
  // PhoneOrderEvent and so only ever exercises the moved-in arm.
  //
  // These two close that. Same assertions, different arm.
  const probeBoundary = async (start) => {
    const SLOT = 15 * 60_000;
    expect(await bookedAtA2(new Date(start))).toBe(1);
    expect(await bookedAtA2(new Date(start + SLOT - 1))).toBe(1);
    expect(await bookedAtA2(new Date(start - 1))).toBe(0);
    expect(await bookedAtA2(new Date(start + SLOT))).toBe(0);
  };

  it('anchors a native ASAP order inclusively at slot start and exclusively at slot end', async () => {
    await withCapacity(a2.id, 5, async () => {
      const created = await submit(baseSubmission({ branchId: a2.id }));
      expect(created.status).toBe(201);
      const SLOT = 15 * 60_000;
      const start = Math.floor(Date.now() / SLOT) * SLOT;
      // Never moved and never scheduled, so createdAt is the anchor: put it
      // exactly on the boundary.
      await prisma.phoneOrder.update({
        where: { id: created.body.phoneOrder.id },
        data: { createdAt: new Date(start) },
      });
      await probeBoundary(start);
    });
  });

  it('anchors a scheduled order inclusively at slot start and exclusively at slot end', async () => {
    await withCapacity(a2.id, 5, async () => {
      const SLOT = 15 * 60_000;
      // scheduledFor is refused unless it is in the future, so take the next
      // whole boundary rather than the current one.
      const start = Math.floor(Date.now() / SLOT) * SLOT + SLOT;
      const created = await submit(
        baseSubmission({ branchId: a2.id, scheduledFor: new Date(start).toISOString() }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      await probeBoundary(start);
    });
  });

  // A SCHEDULED order is due at a named time wherever it is cooked, so moving it
  // must NOT re-anchor it to the move. This is the arm the new rule deliberately
  // leaves alone, and the control that stops "anchor at the move" being applied
  // to everything.
  it('keeps a scheduled order in its scheduled slot when it moves (control)', async () => {
    await withCapacity(a2.id, 5, async () => {
      const at = new Date(Date.now() + 3 * 3600_000);
      const created = await submit(baseSubmission({ scheduledFor: at.toISOString() }));
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const res = await request(app)
        .post(`/api/phone-orders/${created.body.phoneOrder.id}/reassign`)
        .set(auth(tokens.ownerA))
        .send({ branchId: a2.id, reason: 'moved well before it is due' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // Counted in the slot it is DUE in, three hours out...
      expect(await bookedAtA2(at)).toBe(1);
      // ...and not in the slot it was moved in, which is where an ASAP order
      // would have landed.
      expect(await bookedAtA2()).toBe(0);
    });
  });

  // The same control with teeth. The test above pins where a scheduled order is
  // COUNTED; this pins which slot it is CHECKED against, and they are different
  // claims — anchoring the check on the move time instead of scheduledFor leaves
  // the count correct and silently refuses a transfer that should succeed.
  //
  // a2 is full right now and empty at the scheduled time, so the move can only
  // pass if the check looks at the right slot.
  it('judges a scheduled transfer against its due slot, not the moment it moves', async () => {
    await withCapacity(a2.id, 1, async () => {
      // Fill a2's CURRENT slot with a native ASAP order.
      expect((await submit(baseSubmission({ branchId: a2.id }))).status).toBe(201);
      expect(await bookedAtA2()).toBe(1);

      // An ASAP transfer must be refused — the store is full now.
      expect((await moveToA2('asap into a full slot')).status).toBe(409);

      // A scheduled one, due three hours out, must be accepted in the same
      // breath: that slot is empty.
      const at = new Date(Date.now() + 3 * 3600_000);
      const created = await submit(baseSubmission({ scheduledFor: at.toISOString() }));
      const res = await request(app)
        .post(`/api/phone-orders/${created.body.phoneOrder.id}/reassign`)
        .set(auth(tokens.ownerA))
        .send({ branchId: a2.id, reason: 'due much later' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
  });

  // A -> B -> A. The anchor is the LATEST reassign into the branch that holds
  // the order now, so coming back must re-anchor to the return, not to the
  // outbound leg and not to createdAt. The three instants are forced apart into
  // different slots so that reading the wrong event cannot accidentally agree.
  it('re-anchors to the latest move when an order returns to a store it left', async () => {
    await withCapacity(a1.id, 5, async () => {
      const created = await submit(baseSubmission());
      const po = created.body.phoneOrder;

      const move = (branchId, reason) =>
        request(app)
          .post(`/api/phone-orders/${po.id}/reassign`)
          .set(auth(tokens.ownerA))
          .send({ branchId, reason });

      expect((await move(a2.id, 'out to the other store')).status).toBe(200);
      expect((await move(a1.id, 'and back again')).status).toBe(200);

      // Force the history apart: taken 3 h ago, sent to a2 2 h ago, returned
      // to a1 now. Only the last of those is the slot a1 is cooking it in.
      const threeHoursAgo = new Date(Date.now() - 3 * 3600_000);
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await prisma.phoneOrder.update({
        where: { id: po.id },
        data: { createdAt: threeHoursAgo },
      });
      const out = await prisma.phoneOrderEvent.findFirst({
        where: { phoneOrderId: po.id, action: 'REASSIGNED', toBranchId: a2.id },
      });
      await prisma.phoneOrderEvent.update({ where: { id: out.id }, data: { at: twoHoursAgo } });

      const bookedAtA1 = async (instant) => {
        const res = await options({
          fulfilment: 'DELIVERY',
          addressId: addrA.id,
          ...(instant ? { scheduledFor: instant.toISOString() } : {}),
        });
        return res.body.options.find((o) => o.branchId === a1.id).capacity.booked;
      };

      expect(await bookedAtA1()).toBe(1); // the return leg — where it really is
      expect(await bookedAtA1(twoHoursAgo)).toBe(0); // the outbound leg
      expect(await bookedAtA1(threeHoursAgo)).toBe(0); // the original call
    });
  });

  // Exact booked-count changes as an order leaves the live set. There is no
  // cancel route yet — PhoneOrderStatus carries CANCELLED but nothing can
  // produce it while C-6 is open (see the read route's comment) — so reject is
  // the cancellation this API actually has, and it is the transition that
  // returns a place to the kitchen.
  it('returns the place to the slot when the destination rejects the order', async () => {
    await withCapacity(a2.id, 1, async () => {
      const created = await submit(baseSubmission());
      const po = created.body.phoneOrder;
      expect(
        (
          await request(app)
            .post(`/api/phone-orders/${po.id}/reassign`)
            .set(auth(tokens.ownerA))
            .send({ branchId: a2.id, reason: 'moving in' })
        ).status,
      ).toBe(200);
      expect(await bookedAtA2()).toBe(1);

      // Full: the next transfer in is refused.
      expect((await moveToA2('should not fit')).status).toBe(409);

      const rejected = await request(app)
        .post(`/api/phone-orders/${po.id}/reject`)
        .set(auth(tokens.mgrA2))
        .send({ reason: 'out of milk' });
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

      // Exactly one place back, not zero and not two.
      expect(await bookedAtA2()).toBe(0);
      expect((await moveToA2('now it fits')).status).toBe(200);
      expect(await bookedAtA2()).toBe(1);
    });
  });

  it('clears a prior acceptance so the new store must accept for itself', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;
    await request(app).post(`/api/phone-orders/${id}/accept`).set(auth(tokens.mgrA1)).send({});

    const res = await request(app)
      .post(`/api/phone-orders/${id}/reassign`)
      .set(auth(tokens.ownerA))
      .send({ branchId: a2.id, reason: 'moved after acceptance' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_PHONE_ORDER_ALREADY_DECIDED');
  });

  // Invoice immutability is proved against a REAL bill, in the lifecycle block
  // below. An earlier version of this test wrote an invoiceNumber by hand; the
  // fabricated number then collided with the one the billing counter mints, so
  // it was testing its own fixture rather than the guard.

  it('refuses to move an order that already took money', async () => {
    const created = await submit(baseSubmission());
    const po = created.body.phoneOrder;
    await prisma.payment.create({
      data: { orderId: po.order.id, branchId: a1.id, method: 'CASH', amount: '100.00', receivedById: null },
    });
    const res = await request(app)
      .post(`/api/phone-orders/${po.id}/reassign`)
      .set(auth(tokens.ownerA))
      .send({ branchId: a2.id, reason: 'money already taken' });
    expect(res.status).toBe(409);
  });

  it('refuses a branch manager: reassignment is an owner action', async () => {
    const created = await submit(baseSubmission());
    const res = await request(app)
      .post(`/api/phone-orders/${created.body.phoneOrder.id}/reassign`)
      .set(auth(tokens.mgrA1))
      .send({ branchId: a2.id, reason: 'not mine to do' });
    expect(res.status).toBe(403);
  });
});

describe('the existing till lifecycle carries a phone order end to end', () => {
  // Requirement 5 is "reuse the existing order/pricing/tax/payment/KOT
  // lifecycle". That a phone order IS an Order is true by construction, but
  // construction is not evidence - this drives the real till routes over one,
  // with no phone-order endpoint involved after acceptance.
  it('goes accept -> KOT -> bill -> pay without a single VC-104 route', async () => {
    const created = await submit(baseSubmission());
    const po = created.body.phoneOrder;
    const orderId = po.order.id;
    expect((await request(app).post(`/api/phone-orders/${po.id}/accept`).set(auth(tokens.mgrA1)).send({})).status).toBe(200);

    // The cashier at the accepting store, using the ordinary order routes.
    const kot = await request(app).post(`/api/orders/${orderId}/kot`).set(auth(tokens.cashierA1)).send({});
    expect(kot.status, JSON.stringify(kot.body)).toBe(201);
    expect(kot.body.kot.seq).toBe(1);

    const bill = await request(app).post(`/api/orders/${orderId}/bill`).set(auth(tokens.cashierA1)).send({});
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.order.status).toBe('BILLED');
    // A real branch/FY invoice number from the shared counter, not a stub.
    expect(bill.body.order.invoiceNumber).toMatch(/^CP\/\d{2}-\d{2}\/\d{5}$/);
    expect(bill.body.order.total).toBe(420);
    // Tax came from the shared evaluator, broken up the way the till breaks it.
    expect(bill.body.receipt.taxBreakup).toEqual(
      expect.arrayContaining([{ name: 'GST 5%', percent: 5, taxable: 400, tax: 20 }]),
    );

    const pay = await request(app).post(`/api/orders/${orderId}/payments`).set(auth(tokens.cashierA1))
      .send({ method: 'CASH', tendered: 500 });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.order.status).toBe('PAID');
    // 500 tendered against 420 due. The delivery charge is NOT collected here:
    // it is quoted, not billed, while C-6 is open (contract §12).
    expect(pay.body.changeDue).toBe(80);

    // The sidecar still points at the same order, and still reads back.
    const after = await request(app).get(`/api/phone-orders/${po.id}`).set(auth(tokens.ownerA));
    expect(after.body.phoneOrder.order.id).toBe(orderId);
    expect(after.body.phoneOrder.order.invoiceNumber).toBe(bill.body.order.invoiceNumber);
    expect(after.body.phoneOrder.status).toBe('ACCEPTED');
  });

  it('a phone order that has been billed can no longer be moved', async () => {
    const created = await submit(baseSubmission());
    const po = created.body.phoneOrder;
    const bill = await request(app).post(`/api/orders/${po.order.id}/bill`).set(auth(tokens.cashierA1)).send({});
    // Assert the setup, or a failed bill would leave invoiceNumber null and
    // this test would pass for the wrong reason.
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.order.invoiceNumber).toBeTruthy();

    const res = await request(app).post(`/api/phone-orders/${po.id}/reassign`)
      .set(auth(tokens.ownerA)).send({ branchId: a2.id, reason: 'after a real bill' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_INVOICE_ISSUED');

    const order = await prisma.order.findUnique({ where: { id: po.order.id } });
    expect(order.branchId).toBe(a1.id);
  });
});

describe('reads are scoped to what the caller may see', () => {
  it('shows a branch manager only their own store\'s phone orders', async () => {
    const mine = await submit(baseSubmission());
    const theirs = await submit(baseSubmission({ branchId: a2.id }));
    expect(theirs.status).toBe(201);

    const res = await request(app).get('/api/phone-orders').set(auth(tokens.mgrA1));
    expect(res.status).toBe(200);
    const ids = res.body.phoneOrders.map((p) => p.id);
    expect(ids).toContain(mine.body.phoneOrder.id);
    expect(ids).not.toContain(theirs.body.phoneOrder.id);
  });

  it('filters by status, and REFUSES a status nothing can produce', async () => {
    const created = await submit(baseSubmission());
    await request(app).post(`/api/phone-orders/${created.body.phoneOrder.id}/reject`)
      .set(auth(tokens.mgrA1)).send({ reason: 'closing early tonight' });

    const rejected = await request(app).get('/api/phone-orders?status=REJECTED').set(auth(tokens.ownerA));
    expect(rejected.status).toBe(200);
    expect(rejected.body.phoneOrders.every((p) => p.status === 'REJECTED')).toBe(true);

    // The trap: dropping an unknown value empties the filter list, and an empty
    // list means "no filter" - so asking for cancelled orders would hand back
    // every order there is. It must refuse instead.
    const bogus = await request(app).get('/api/phone-orders?status=CANCELLED').set(auth(tokens.ownerA));
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.field).toBe('status');

    const mixed = await request(app).get('/api/phone-orders?status=SUBMITTED,CANCELLED').set(auth(tokens.ownerA));
    expect(mixed.status).toBe(400);
  });

  it('refuses another tenant\'s phone order with 404', async () => {
    const created = await submit(baseSubmission());
    const res = await request(app)
      .get(`/api/phone-orders/${created.body.phoneOrder.id}`)
      .set(auth(tokens.ownerB));
    expect(res.status).toBe(404);
  });

  it('keeps the routing history on the order', async () => {
    const created = await submit(baseSubmission());
    const id = created.body.phoneOrder.id;
    await request(app).post(`/api/phone-orders/${id}/reject`).set(auth(tokens.mgrA1)).send({ reason: 'too busy tonight' });
    await request(app).post(`/api/phone-orders/${id}/reassign`).set(auth(tokens.ownerA)).send({ branchId: a2.id, reason: 'rerouted' });

    const res = await request(app).get(`/api/phone-orders/${id}`).set(auth(tokens.ownerA));
    const actions = res.body.phoneOrder.events.map((e) => e.action);
    expect(actions).toEqual(['SUBMITTED', 'REJECTED', 'REASSIGNED']);
  });

  it('shows permitted history on the customer, scoped per store', async () => {
    const res = await request(app).get(`/api/phone-orders/customers/${customerA.id}`).set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.customer.history.length).toBeGreaterThan(0);
    expect(res.body.customer.addresses.map((a) => a.id)).toContain(addrA.id);

    const scoped = await request(app).get(`/api/phone-orders/customers/${customerA.id}`).set(auth(tokens.mgrA2));
    expect(scoped.body.customer.history.every((h) => h.branchId === a2.id)).toBe(true);
  });
});
