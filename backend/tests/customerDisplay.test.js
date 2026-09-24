// VC-101 customer display suite: pairing lifecycle, credential separation,
// station isolation, and — the point of the feature — that every figure the
// display shows equals the figure the order routes serve, because both come
// from the same rows. No display number is ever computed in this suite; each
// assertion compares the display payload against GET /api/orders/:id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('customerDisplay.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { _expireCodeForTest } = await import('../src/lib/displayState.js');

const app = createApp();

const wipe = async () => {
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
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
  await prisma.userInvitation.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
let companyA, companyB, branchA1, branchA2, branchB1;
let coffeeA, chaiA, coffeeB;
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const auth = (t) => ({ Authorization: `Bearer ${t}` });

// Mint a code as the staff token, redeem it as the display. Returns the
// pair response body ({ displayToken, branch, company, expiresAt }).
const pairDisplay = async (staffToken, branchId) => {
  const minted = await request(app)
    .post('/api/display/pair-code')
    .set(auth(staffToken))
    .send(branchId ? { branchId } : {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const paired = await request(app).post('/api/display/pair').send({ code: minted.body.code });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  return paired.body;
};

const newOrder = async (staffToken, productId, qty, extra = {}) => {
  const created = await request(app)
    .post('/api/orders')
    .set(auth(staffToken))
    .send({ type: 'TAKEAWAY', items: [{ productId, qty }], ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.order;
};

const serverOrder = async (staffToken, id) => {
  const res = await request(app).get(`/api/orders/${id}`).set(auth(staffToken));
  expect(res.status).toBe(200);
  return res.body.order;
};

const displayState = (displayToken, etag) => {
  const req = request(app).get('/api/display/state').set(auth(displayToken));
  return etag ? req.set('If-None-Match', etag) : req;
};

const pointDisplay = async (staffToken, orderId) => {
  const res = await request(app).put('/api/display/state').set(auth(staffToken)).send({ orderId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Cafe',
      slug: 'alpha-cafe',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 2, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Diner',
      slug: 'bravo-diner',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  branchA1 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-CD-0001', name: 'Alpha One', code: 'A1' } });
  branchA2 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-CD-0002', name: 'Alpha Two', code: 'A2' } });
  branchB1 = await prisma.branch.create({ data: { companyId: companyB.id, publicId: 'VC-CD-0003', name: 'Bravo One', code: 'B1' } });

  const mk = (email, fullName, role, companyId, branchId = null) =>
    prisma.posUser.create({ data: { email, fullName, role, companyId, branchId, passwordHash } });
  await mk('till1@a.test', 'Till One', 'CASHIER', companyA.id, branchA1.id);
  await mk('till1b@a.test', 'Till One B', 'CASHIER', companyA.id, branchA1.id);
  await mk('till2@a.test', 'Till Two', 'CASHIER', companyA.id, branchA2.id);
  await mk('owner@a.test', 'Alpha Owner', 'CUSTOMER_OWNER', companyA.id);
  await mk('till@b.test', 'Bravo Till', 'CASHIER', companyB.id, branchB1.id);

  // Generous company-wide discount room, so the discount leg below tests the
  // display's mirroring of a discount, not the policy floor.
  await prisma.discountPolicy.create({
    data: {
      companyId: companyA.id,
      level: 'COMPANY',
      scopeKey: 'company',
      allowLineDiscount: true,
      allowOrderDiscount: true,
      maxPercent: '50.000',
      note: 'test room',
    },
  });

  const catalog = async (companyId, name) => {
    const tax = await prisma.taxRate.create({ data: { companyId, name: 'GST 5%', ratePercent: '5.00' } });
    const cat = await prisma.category.create({ data: { companyId, name: 'Drinks', sortOrder: 1 } });
    const mkP = (n, price) =>
      prisma.product.create({ data: { companyId, categoryId: cat.id, name: n, basePrice: price, taxRateId: tax.id } });
    return { first: (await mkP(`${name} Coffee`, '500.00')).id, second: (await mkP(`${name} Chai`, '120.00')).id };
  };
  const catA = await catalog(companyA.id, 'Alpha');
  coffeeA = catA.first;
  chaiA = catA.second;
  coffeeB = (await catalog(companyB.id, 'Bravo')).first;

  tokens.till1 = await login('till1@a.test');
  tokens.till1b = await login('till1b@a.test');
  tokens.till2 = await login('till2@a.test');
  tokens.owner = await login('owner@a.test');
  tokens.tillB = await login('till@b.test');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pair-code minting', () => {
  it('requires a signed-in staff member', async () => {
    const res = await request(app).post('/api/display/pair-code').send({});
    expect(res.status).toBe(401);
  });

  it('a cashier mints for their own branch and may not name another', async () => {
    const ok = await request(app).post('/api/display/pair-code').set(auth(tokens.till1)).send({});
    expect(ok.status).toBe(201);
    expect(ok.body.code).toMatch(/^\d{6}$/);
    expect(ok.body.expiresInSeconds).toBe(300);

    const other = await request(app)
      .post('/api/display/pair-code')
      .set(auth(tokens.till1))
      .send({ branchId: branchA2.id });
    expect(other.status).toBe(403);
  });

  it('an owner must name a branch, inside their company', async () => {
    const missing = await request(app).post('/api/display/pair-code').set(auth(tokens.owner)).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.field).toBe('branchId');

    const foreign = await request(app)
      .post('/api/display/pair-code')
      .set(auth(tokens.owner))
      .send({ branchId: branchB1.id });
    expect(foreign.status).toBe(404);

    const ok = await request(app)
      .post('/api/display/pair-code')
      .set(auth(tokens.owner))
      .send({ branchId: branchA1.id });
    expect(ok.status).toBe(201);
  });
});

describe('pairing', () => {
  it('rejects a malformed and an unknown code with one message', async () => {
    const malformed = await request(app).post('/api/display/pair').send({ code: 'abc' });
    expect(malformed.status).toBe(400);

    const minted = await request(app).post('/api/display/pair-code').set(auth(tokens.till1)).send({});
    const flipped =
      String((Number(minted.body.code[0]) + 1) % 10) + minted.body.code.slice(1);
    const unknown = await request(app).post('/api/display/pair').send({ code: flipped });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe('Invalid or expired pairing code');
  });

  it('a code works once, names the branch, and dies expired', async () => {
    const minted = await request(app).post('/api/display/pair-code').set(auth(tokens.till1)).send({});
    const first = await request(app).post('/api/display/pair').send({ code: minted.body.code });
    expect(first.status).toBe(201);
    expect(first.body.displayToken).toBeTruthy();
    expect(first.body.branch.name).toBe('Alpha One');
    expect(first.body.company.name).toBe('Alpha Cafe');

    const again = await request(app).post('/api/display/pair').send({ code: minted.body.code });
    expect(again.status).toBe(400);

    const stale = await request(app).post('/api/display/pair-code').set(auth(tokens.till1)).send({});
    _expireCodeForTest(stale.body.code);
    const expired = await request(app).post('/api/display/pair').send({ code: stale.body.code });
    expect(expired.status).toBe(400);
  });

  it('a code minted by a session that signed out no longer pairs', async () => {
    const t = await login('till1b@a.test');
    const minted = await request(app).post('/api/display/pair-code').set(auth(t)).send({});
    const out = await request(app).post('/api/auth/logout').set(auth(t)).send({});
    expect(out.status).toBe(200);
    const res = await request(app).post('/api/display/pair').send({ code: minted.body.code });
    expect(res.status).toBe(400);
  });
});

describe('credential separation', () => {
  it('display endpoints refuse missing and staff credentials', async () => {
    expect((await request(app).get('/api/display/state')).status).toBe(401);
    expect((await request(app).get('/api/display/state').set(auth(tokens.till1))).status).toBe(401);
  });

  it('a display token opens no staff route and cannot point itself', async () => {
    const paired = await pairDisplay(tokens.till1);
    const d = paired.displayToken;
    expect((await request(app).get('/api/orders').set(auth(d))).status).toBe(401);
    expect((await request(app).get('/api/dashboard').set(auth(d))).status).toBe(401);
    expect(
      (await request(app).put('/api/display/state').set(auth(d)).send({ orderId: 'x' })).status,
    ).toBe(401);
  });
});

describe('the display mirrors the order routes', () => {
  let display;

  const expectMirror = (shown, server) => {
    const activeItems = server.items.filter((i) => i.status === 'ACTIVE');
    expect(shown.items).toEqual(
      activeItems.map((i) => ({
        name: i.name,
        qty: i.qty,
        unitPrice: i.unitPrice,
        lineDiscount: i.lineDiscount,
      })),
    );
    expect(shown.subtotal).toBe(server.subtotal);
    expect(shown.discountAmount).toBe(server.discountAmount);
    expect(shown.taxAmount).toBe(server.taxAmount);
    expect(shown.total).toBe(server.total);
    expect(shown.due).toBe(server.amountDue);
    expect(shown.orderStatus).toBe(server.status);
    expect(shown.invoiceNumber).toBe(server.invoiceNumber);
  };

  it('starts idle, with a working ETag', async () => {
    display = (await pairDisplay(tokens.till1)).displayToken;
    const idle = await displayState(display);
    expect(idle.status).toBe(200);
    expect(idle.body).toEqual({ view: 'IDLE' });
    const revisit = await displayState(display, idle.headers.etag);
    expect(revisit.status).toBe(304);
  });

  it('shows exactly the order the till is on, through items, discount, bill and payments', async () => {
    const order = await newOrder(tokens.till1, coffeeA, 2);
    await pointDisplay(tokens.till1, order.id);

    // Ringing up.
    let shown = await displayState(display);
    expect(shown.status).toBe(200);
    expect(shown.body.view).toBe('ACTIVE');
    expectMirror(shown.body, await serverOrder(tokens.till1, order.id));

    // The allowlist is exact — nothing else ever rides along.
    expect(Object.keys(shown.body).sort()).toEqual([
      'discountAmount', 'due', 'invoiceNumber', 'items', 'orderStatus',
      'subtotal', 'taxAmount', 'total', 'view',
    ]);
    expect(Object.keys(shown.body.items[0]).sort()).toEqual(['lineDiscount', 'name', 'qty', 'unitPrice']);

    // Second line changes the ETag and the mirror still holds.
    const beforeEtag = shown.headers.etag;
    await request(app)
      .post(`/api/orders/${order.id}/items`)
      .set(auth(tokens.till1))
      .send({ productId: chaiA, qty: 1 })
      .expect(200);
    shown = await displayState(display, beforeEtag);
    expect(shown.status).toBe(200);
    expectMirror(shown.body, await serverOrder(tokens.till1, order.id));

    // Discount (well inside the seeded policy room).
    await request(app)
      .post(`/api/orders/${order.id}/discount`)
      .set(auth(tokens.till1))
      .send({ type: 'FLAT', value: 50 })
      .expect(200);
    shown = await displayState(display);
    expectMirror(shown.body, await serverOrder(tokens.till1, order.id));
    expect(shown.body.discountAmount).toBe(50);

    // Bill: the display now carries the invoice number and the full due.
    await request(app).post(`/api/orders/${order.id}/bill`).set(auth(tokens.till1)).send({}).expect(200);
    let server = await serverOrder(tokens.till1, order.id);
    shown = await displayState(display);
    expect(shown.body.orderStatus).toBe('BILLED');
    expect(shown.body.invoiceNumber).toBeTruthy();
    expect(shown.body.due).toBe(server.total);
    expectMirror(shown.body, server);

    // Partial payment: still ACTIVE, due shrinks to what the order route says.
    await request(app)
      .post(`/api/orders/${order.id}/payments`)
      .set(auth(tokens.till1))
      .send({ method: 'CASH', amount: 100 })
      .expect(201);
    server = await serverOrder(tokens.till1, order.id);
    expect(server.status).toBe('BILLED');
    shown = await displayState(display);
    expect(shown.body.view).toBe('ACTIVE');
    expectMirror(shown.body, server);

    // Settling flips one poll to THANKYOU, then the screen is blank again.
    await request(app)
      .post(`/api/orders/${order.id}/payments`)
      .set(auth(tokens.till1))
      .send({ method: 'CASH', amount: server.amountDue })
      .expect(201);
    server = await serverOrder(tokens.till1, order.id);
    expect(server.status).toBe('PAID');
    shown = await displayState(display);
    expect(shown.body).toEqual({
      view: 'THANKYOU',
      total: server.total,
      invoiceNumber: server.invoiceNumber,
    });
    const after = await displayState(display);
    expect(after.body).toEqual({ view: 'IDLE' });
  });

  it('a voided bill goes straight to idle, never to a thank-you', async () => {
    const order = await newOrder(tokens.till1, coffeeA, 1);
    await pointDisplay(tokens.till1, order.id);
    expect((await displayState(display)).body.view).toBe('ACTIVE');
    await request(app)
      .post(`/api/orders/${order.id}/void`)
      .set(auth(tokens.owner))
      .send({ reason: 'rung on the wrong till' })
      .expect(200);
    expect((await displayState(display)).body).toEqual({ view: 'IDLE' });
  });
});

describe('station isolation', () => {
  it('another till, another branch, another company — none of them reach this screen', async () => {
    const display = (await pairDisplay(tokens.till1)).displayToken;

    // Same branch, different cashier: their pointer is their own station's.
    const near = await newOrder(tokens.till1b, coffeeA, 1);
    await pointDisplay(tokens.till1b, near.id);
    expect((await displayState(display)).body).toEqual({ view: 'IDLE' });

    // Other branch: pointing is refused for a pinned role.
    const far = await newOrder(tokens.till2, coffeeA, 1);
    const cross = await request(app)
      .put('/api/display/state')
      .set(auth(tokens.till1))
      .send({ orderId: far.id });
    expect(cross.status).toBe(403);

    // Other company: indistinguishable from a missing order.
    const foreign = await newOrder(tokens.tillB, coffeeB, 1);
    const alien = await request(app)
      .put('/api/display/state')
      .set(auth(tokens.till1))
      .send({ orderId: foreign.id });
    expect(alien.status).toBe(404);

    // An owner pointing the other branch lights the owner's own station only.
    await pointDisplay(tokens.owner, far.id);
    expect((await displayState(display)).body).toEqual({ view: 'IDLE' });
  });
});

describe('sign-out ends the display', () => {
  it('a paired display dies on its cashier logout and cannot come back', async () => {
    const t = await login('till1b@a.test');
    const display = (await pairDisplay(t)).displayToken;
    const order = await newOrder(t, coffeeA, 1);
    await request(app).put('/api/display/state').set(auth(t)).send({ orderId: order.id }).expect(200);
    expect((await displayState(display)).body.view).toBe('ACTIVE');

    await request(app).post('/api/auth/logout').set(auth(t)).send({}).expect(200);
    const dead = await displayState(display);
    expect(dead.status).toBe(401);
    // And it stays dead: a later poll is not somehow revived by re-login.
    await login('till1b@a.test');
    expect((await displayState(display)).status).toBe(401);
  });
});
