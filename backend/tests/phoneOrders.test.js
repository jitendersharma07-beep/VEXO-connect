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
    await prisma.branchPrepCapacity.create({
      data: { companyId: companyA.id, branchId: a2.id, slotMinutes: 15, maxOrdersPerSlot: 1 },
    });
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

    await prisma.phoneOrder.deleteMany({ where: { routedBranchId: a2.id } });
    await prisma.branchPrepCapacity.deleteMany({ where: { branchId: a2.id } });
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
    const [r1, r2] = await Promise.all([submit(body), submit(body)]);
    const codes = [r1.status, r2.status].sort();
    // Either the second saw the first (200), or both raced into the unique
    // index and one was rejected. Never two orders.
    expect(codes[0]).toBe(201);
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
