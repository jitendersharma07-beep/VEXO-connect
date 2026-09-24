// Catalog modifier groups and options, over HTTP. Contract §5.1.
//
// Why this file exists. tests/promotions.test.js already covers the ORDER side
// of modifiers well — price folding into unitPrice, the promotion eligible
// base, line merging by modifier key, minSelect/maxSelect enforced at the till,
// receipt immutability against later catalog edits. Every one of those tests
// builds its groups and options with prisma.modifierGroup.create and
// prisma.modifierOption.create, writing straight into the database. So the four
// routes that are the only way a customer can ever author a modifier had no
// coverage of any kind:
//
//   POST   /api/catalog/products/:id/modifier-groups
//   PATCH  /api/catalog/products/:id/modifier-groups/:groupId
//   POST   /api/catalog/products/:id/modifier-groups/:groupId/options
//   PATCH  /api/catalog/products/:id/modifier-groups/:groupId/options/:optionId
//
// Not their zod schemas, not their duplicate-name 409s, not their 404s, not
// their audit rows, not the role and licence gates in front of them. Nothing
// else in the repo reaches them either — grep frontend/src for "modifier-groups"
// returns nothing, so there is no modifier management UI and this HTTP surface
// has only ever been exercised by hand, if at all. A suite that only ever
// reaches a table through Prisma proves the table works, not the product.
//
// One test below is a TRIPWIRE, not an approval: it asserts what the code does
// today and says so at the assertion. It was three; the other two were the D-5
// pair in docs/VC104-BACKEND-DEFECTS.md, and fixing D-5 turned them into the
// refusal tests at the bottom of this file, which is what a tripwire is for.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('catalogModifiers.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const wipe = async () => {
  // Shared test database: rows another suite left behind RESTRICT the deletes
  // below, so this clears children before parents in full FK order rather than
  // only the tables this file happens to write.
  await prisma.printJob.deleteMany();
  await prisma.printTarget.deleteMany();
  await prisma.printAgent.deleteMany();
  await prisma.kitchenItem.deleteMany();
  await prisma.kitchenRoute.deleteMany();
  await prisma.kitchenStation.deleteMany();
  await prisma.kitchenCursor.deleteMany();
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.phoneOrderEvent.deleteMany();
  await prisma.phoneOrder.deleteMany();
  await prisma.customerAddress.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.branchServiceArea.deleteMany();
  await prisma.branchHours.deleteMany();
  await prisma.branchPrepCapacity.deleteMany();
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
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

const PW = 'test-password-1';
const tokens = {};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

let companyA, companyB, companyC, branchA1;
let categoryA, categoryB;
let productB; // lives in the other company, for the isolation checks

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// A product per test. Modifier groups are unique per product by name, so
// sharing one product between tests would make every duplicate-name assertion
// depend on which test ran first.
let seq = 0;
const freshProduct = (companyId = companyA.id, categoryId = categoryA) =>
  prisma.product.create({
    data: { companyId, categoryId, name: `Widget ${++seq}`, basePrice: '100.00' },
  });

// --- the four routes under test ----------------------------------------------

const postGroup = (token, productId, body, q = '') =>
  request(app)
    .post(`/api/catalog/products/${productId}/modifier-groups${q}`)
    .set(auth(token))
    .send(body);

const patchGroup = (token, productId, groupId, body) =>
  request(app)
    .patch(`/api/catalog/products/${productId}/modifier-groups/${groupId}`)
    .set(auth(token))
    .send(body);

const postOption = (token, productId, groupId, body) =>
  request(app)
    .post(`/api/catalog/products/${productId}/modifier-groups/${groupId}/options`)
    .set(auth(token))
    .send(body);

const patchOption = (token, productId, groupId, optionId, body) =>
  request(app)
    .patch(`/api/catalog/products/${productId}/modifier-groups/${groupId}/options/${optionId}`)
    .set(auth(token))
    .send(body);

// Every one of the four routes answers with the whole product, so the group is
// read back out of the response rather than out of the database — that is what
// a client sees, and a route that wrote correctly but serialised wrongly would
// otherwise pass.
const groupsOf = (res) => res.body.product.modifierGroups;
const groupNamed = (res, name) => groupsOf(res).find((g) => g.name === name);

// Create a group and return its id, failing loudly here rather than three
// assertions later if the setup call did not do what the test assumed.
const makeGroup = async (productId, body) => {
  const res = await postGroup(tokens.ownerA, productId, body);
  expect(res.status, `makeGroup ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`).toBe(201);
  return groupNamed(res, body.name.trim()).id;
};

// The three-step flow a required group now needs, since D-5 was fixed: open it
// with no minimum, fill it, then raise the minimum. Every intermediate state is
// satisfiable, which is the whole point of the fix. Returns [groupId, ...optionIds].
const makeRequiredGroup = async (productId, { name, minSelect, maxSelect }, options) => {
  const groupId = await makeGroup(productId, { name, ...(maxSelect ? { maxSelect } : {}) });
  const optionIds = [];
  for (const o of options) optionIds.push(await makeOption(productId, groupId, o));
  const res = await patchGroup(tokens.ownerA, productId, groupId, { minSelect });
  expect(res.status, `makeRequiredGroup ${name}: ${JSON.stringify(res.body)}`).toBe(200);
  return [groupId, ...optionIds];
};

const makeOption = async (productId, groupId, body) => {
  const res = await postOption(tokens.ownerA, productId, groupId, body);
  expect(res.status, `makeOption ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`).toBe(201);
  return groupsOf(res)
    .find((g) => g.id === groupId)
    .options.find((o) => o.name === body.name.trim()).id;
};

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);
  const yesterday = new Date(Date.now() - 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Modifier Cafe',
      slug: 'modifier-cafe',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inADay } },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Other Cafe',
      slug: 'other-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  // Deliberately expired: canWrite is [requireRole, requireUsableLicense] and
  // the licence half of that pair has never been proven on these routes.
  companyC = await prisma.company.create({
    data: {
      name: 'Lapsed Cafe',
      slug: 'lapsed-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: yesterday } },
    },
  });

  // MO = modifiers. Branch.publicId is NOT NULL, unique, and carries CHECK
  // Branch_publicId_shape pinning ^VC-[A-Z]{2}-[0-9]{4,}$ — a lane tag made of
  // digits is refused by Postgres, not by Prisma. No other suite uses MO.
  branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-MO-0001', name: 'Modifier One', code: 'M1' },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'atc.mod@test.local', fullName: 'ATC Admin', role: 'POS_SUPER_ADMIN' });
  await mk({ email: 'owner.mod.a@test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  await mk({ email: 'cashier.mod.a@test.local', fullName: 'Cashier A', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id });
  await mk({ email: 'owner.mod.b@test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });
  await mk({ email: 'owner.mod.c@test.local', fullName: 'Owner C', role: 'CUSTOMER_OWNER', companyId: companyC.id });

  tokens.atc = await login('atc.mod@test.local');
  tokens.ownerA = await login('owner.mod.a@test.local');
  tokens.cashierA = await login('cashier.mod.a@test.local');
  tokens.ownerB = await login('owner.mod.b@test.local');
  tokens.ownerC = await login('owner.mod.c@test.local');

  categoryA = (await prisma.category.create({ data: { companyId: companyA.id, name: 'Drinks' } })).id;
  categoryB = (await prisma.category.create({ data: { companyId: companyB.id, name: 'Drinks' } })).id;
  productB = await freshProduct(companyB.id, categoryB);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('creating a modifier group', () => {
  it('creates the group and answers with the whole reloaded product', async () => {
    const p = await freshProduct();
    const res = await postGroup(tokens.ownerA, p.id, { name: 'Extras', minSelect: 0, maxSelect: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const g = groupNamed(res, 'Extras');
    expect(g).toMatchObject({ name: 'Extras', minSelect: 0, maxSelect: 2, status: 'ACTIVE' });
    expect(g.options).toEqual([]);
    expect(res.body.product.id).toBe(p.id);
  });

  it('defaults to optional and unbounded when only a name is sent', async () => {
    const p = await freshProduct();
    const res = await postGroup(tokens.ownerA, p.id, { name: 'Sauces' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Null maxSelect means no upper bound, not "zero allowed" — the order path
    // reads `g.maxSelect !== null` and skips the check entirely.
    expect(groupNamed(res, 'Sauces')).toMatchObject({ minSelect: 0, maxSelect: null });
  });

  it('trims the name before storing and before checking for a clash', async () => {
    const p = await freshProduct();
    const first = await postGroup(tokens.ownerA, p.id, { name: '  Milk  ' });
    expect(first.status).toBe(201);
    expect(groupsOf(first).map((g) => g.name)).toEqual(['Milk']);
    // Untrimmed it would look like a different name and slip past the clash
    // check, only to be stopped by @@unique([productId, name]) as a 500.
    const second = await postGroup(tokens.ownerA, p.id, { name: 'Milk ' });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
  });

  it('refuses an upper bound below the lower one', async () => {
    const p = await freshProduct();
    const res = await postGroup(tokens.ownerA, p.id, { name: 'Bad', minSelect: 2, maxSelect: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('POS_BAD_REQUEST');
    expect(res.body.error.field).toBe('maxSelect');
    expect(res.body.error.message).toMatch(/at least minSelect/);
  });

  it('refuses a maxSelect of zero, which would make the group unsatisfiable', async () => {
    const p = await freshProduct();
    const res = await postGroup(tokens.ownerA, p.id, { name: 'Zero', minSelect: 0, maxSelect: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('maxSelect');
  });

  it('refuses a minimum on a group that cannot have options yet (D-5)', async () => {
    const p = await freshProduct();
    // An exactly-one group is the commonest shape on a menu, and it can still
    // be built — just not in one call, because between this call and the first
    // option the product would be unsellable.
    const res = await postGroup(tokens.ownerA, p.id, { name: 'Size', minSelect: 1, maxSelect: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('POS_CONFLICT');
    expect(res.body.error.message).toMatch(/"Size" would require 1 choice but only 0 are available/);
    // The remedy has to be in the message: without it this reads as "required
    // groups are banned", which would be a worse bug than D-5.
    expect(res.body.error.message).toMatch(/add its options, then raise the minimum/);
  });

  it('builds an exactly-one group the supported way, and it sells', async () => {
    const p = await freshProduct();
    const [gid, whole] = await makeRequiredGroup(
      p.id, { name: 'Milk', minSelect: 1, maxSelect: 1 }, [{ name: 'Whole', price: 0 }],
    );
    const read = await patchGroup(tokens.ownerA, p.id, gid, {});
    expect(groupNamed(read, 'Milk')).toMatchObject({ minSelect: 1, maxSelect: 1 });
    // The point of the whole exercise: the finished group is enforced at the till.
    expect((await sell(p.id, [])).status).toBe(400);
    expect((await sell(p.id, [whole])).status).toBe(201);
  });

  it('refuses a duplicate name on the same product, naming it in the message', async () => {
    const p = await freshProduct();
    await makeGroup(p.id, { name: 'Extras' });
    const res = await postGroup(tokens.ownerA, p.id, { name: 'Extras' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_CONFLICT');
    expect(res.body.error.message).toMatch(/Extras/);
  });

  it('allows the same group name on a different product', async () => {
    const one = await freshProduct();
    const two = await freshProduct();
    await makeGroup(one.id, { name: 'Extras' });
    const res = await postGroup(tokens.ownerA, two.id, { name: 'Extras' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('TRIPWIRE: archiving a group burns its name for good', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Seasonal' });
    expect((await patchGroup(tokens.ownerA, p.id, id, { status: 'ARCHIVED' })).status).toBe(200);

    // The clash check is findFirst({ productId, name }) with no status filter,
    // and it could not usefully have one: @@unique([productId, name]) covers
    // archived rows too, so filtering would only turn this 409 into a 500. The
    // consequence is real and undocumented — once "Seasonal" is archived, that
    // product can never have a group called "Seasonal" again, and the message
    // says the group "already exists" while it is invisible in every list.
    const again = await postGroup(tokens.ownerA, p.id, { name: 'Seasonal' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already exists/);
  });

  it('404s on an unknown product and on another company\'s product alike', async () => {
    const absent = await postGroup(tokens.ownerA, 'no-such-product', { name: 'Extras' });
    const foreign = await postGroup(tokens.ownerA, productB.id, { name: 'Extras' });
    expect(absent.status).toBe(404);
    expect(foreign.status).toBe(404);
    // Identical answers on purpose: a different code would let one company
    // probe another's product ids.
    expect(foreign.body.error.code).toBe(absent.body.error.code);
    expect(foreign.body.error.message).toBe(absent.body.error.message);
  });
});

describe('updating a modifier group', () => {
  it('renames and re-bounds in one call', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras', minSelect: 0, maxSelect: 3 });
    await makeOption(p.id, id, { name: 'Nuts', price: 10 });
    const res = await patchGroup(tokens.ownerA, p.id, id, { name: 'Add-ons', minSelect: 1, maxSelect: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(groupNamed(res, 'Add-ons')).toMatchObject({ id, minSelect: 1, maxSelect: 2 });
  });

  it('checks a lowered maxSelect against the STORED minSelect', async () => {
    const p = await freshProduct();
    const [id] = await makeRequiredGroup(
      p.id,
      { name: 'Extras', minSelect: 2, maxSelect: 3 },
      [{ name: 'Nuts', price: 10 }, { name: 'Choc', price: 10 }],
    );
    // Only maxSelect is sent, so a schema-level .refine like groupCreate's
    // could not catch this — there is no minSelect in the payload to compare
    // against. groupUpdate deliberately has no refine and the check is written
    // out longhand in the route, against the row. That is a second code path
    // and this is the only test of it.
    const res = await patchGroup(tokens.ownerA, p.id, id, { maxSelect: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('maxSelect');
    expect(res.body.error.message).toBe('maxSelect must be at least minSelect');
  });

  it('checks a raised minSelect against the STORED maxSelect', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras', maxSelect: 2 });
    // 400 and not D-5's 409: the bounds contradict each other on their own
    // terms, before anyone counts options, and the route checks them in that
    // order on purpose. The narrower, older error is the more useful one.
    const res = await patchGroup(tokens.ownerA, p.id, id, { minSelect: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.field).toBe('maxSelect');
  });

  it('clears the upper bound with an explicit null, and then a high minSelect is allowed', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras', maxSelect: 2 });
    for (const name of ['Nuts', 'Choc', 'Jam']) await makeOption(p.id, id, { name, price: 10 });

    // Three options exist, so D-5 is satisfied either way and the only thing
    // standing between this group and minSelect 3 is the stored upper bound.
    expect((await patchGroup(tokens.ownerA, p.id, id, { minSelect: 3 })).status).toBe(400);

    // null and absent mean different things here: `data.maxSelect !== undefined`
    // distinguishes "clear it" from "leave it alone", which is why the schema
    // uses .nullish() rather than .optional().
    const cleared = await patchGroup(tokens.ownerA, p.id, id, { maxSelect: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(groupNamed(cleared, 'Extras').maxSelect).toBeNull();

    const raised = await patchGroup(tokens.ownerA, p.id, id, { minSelect: 3 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(groupNamed(raised, 'Extras')).toMatchObject({ minSelect: 3, maxSelect: null });
  });

  it('a no-op rename to the group\'s own name is not a conflict', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras' });
    await makeOption(p.id, id, { name: 'Nuts', price: 10 });
    // The route guards the clash lookup with `data.name !== group.name`. Without
    // it, saving an unchanged form would 409 against the row being saved.
    const res = await patchGroup(tokens.ownerA, p.id, id, { name: 'Extras', minSelect: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(groupNamed(res, 'Extras').minSelect).toBe(1);
  });

  it('refuses a rename onto a sibling group', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras' });
    await makeGroup(p.id, { name: 'Sauces' });
    const res = await patchGroup(tokens.ownerA, p.id, id, { name: 'Sauces' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Sauces/);
  });

  it('archives a group, and the order path stops enforcing it', async () => {
    const p = await freshProduct();
    const [id] = await makeRequiredGroup(
      p.id, { name: 'Size', minSelect: 1, maxSelect: 1 }, [{ name: 'Large', price: 20 }],
    );

    const blocked = await sell(p.id, []);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(400);

    const res = await patchGroup(tokens.ownerA, p.id, id, { status: 'ARCHIVED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(groupNamed(res, 'Size').status).toBe('ARCHIVED');

    // resolveCatalogLine filters to ACTIVE groups before enforcing minSelect,
    // so archiving is the supported way to retire a required choice.
    const after = await sell(p.id, []);
    expect(after.status, JSON.stringify(after.body)).toBe(201);
  });

  it('404s for a group belonging to another product of the same company', async () => {
    const mine = await freshProduct();
    const other = await freshProduct();
    const id = await makeGroup(other.id, { name: 'Extras' });
    // loadGroup searches the loaded product's own groups, so a real group id
    // under the wrong product is a 404 rather than a cross-product edit.
    const res = await patchGroup(tokens.ownerA, mine.id, id, { name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Modifier group not found/);
  });

  it('404s for an unknown group id', async () => {
    const p = await freshProduct();
    const res = await patchGroup(tokens.ownerA, p.id, 'no-such-group', { name: 'X' });
    expect(res.status).toBe(404);
  });

  it('refuses a status the catalog does not have', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras' });
    const res = await patchGroup(tokens.ownerA, p.id, id, { status: 'DELETED' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('status');
  });
});

describe('creating a modifier option', () => {
  it('creates the option at a 2dp price and returns it inside its group', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras', maxSelect: 2 });
    const res = await postOption(tokens.ownerA, p.id, id, { name: 'Oat milk', price: 30 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const opts = groupsOf(res).find((g) => g.id === id).options;
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ name: 'Oat milk', price: 30, status: 'ACTIVE' });
  });

  it('allows a free option', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Milk', maxSelect: 1 });
    const res = await postOption(tokens.ownerA, p.id, id, { name: 'Regular', price: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(groupsOf(res).find((g) => g.id === id).options[0].price).toBe(0);
  });

  it('refuses a price with more than two decimals', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras' });
    const res = await postOption(tokens.ownerA, p.id, id, { name: 'Odd', price: 10.125 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('price');
    expect(res.body.error.message).toMatch(/at most 2 decimals/);
  });

  it('refuses a negative price', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras' });
    // A negative modifier would fold a discount into unitPrice where no
    // discount policy, approval or audit row could ever see it.
    const res = await postOption(tokens.ownerA, p.id, id, { name: 'Rebate', price: -10 });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('price');
  });

  it('refuses a duplicate option name within the group', async () => {
    const p = await freshProduct();
    const id = await makeGroup(p.id, { name: 'Extras' });
    await makeOption(p.id, id, { name: 'Syrup', price: 50 });
    const res = await postOption(tokens.ownerA, p.id, id, { name: 'Syrup', price: 60 });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already exists in this group/);
  });

  it('allows the same option name in a sibling group of the same product', async () => {
    const p = await freshProduct();
    const hot = await makeGroup(p.id, { name: 'Hot extras' });
    const cold = await makeGroup(p.id, { name: 'Cold extras' });
    await makeOption(p.id, hot, { name: 'Syrup', price: 50 });
    // The clash lookup is scoped by groupId, not productId — "Syrup" under two
    // different groups is a normal menu, and a product-wide check would ban it.
    const res = await postOption(tokens.ownerA, p.id, cold, { name: 'Syrup', price: 40 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('404s for an unknown group', async () => {
    const p = await freshProduct();
    const res = await postOption(tokens.ownerA, p.id, 'no-such-group', { name: 'Syrup', price: 10 });
    expect(res.status).toBe(404);
  });
});

describe('updating a modifier option', () => {
  it('reprices without touching the name or status', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras' });
    const o = await makeOption(p.id, g, { name: 'Syrup', price: 50 });
    const res = await patchOption(tokens.ownerA, p.id, g, o, { price: 65.5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(groupsOf(res).find((x) => x.id === g).options[0]).toMatchObject({
      name: 'Syrup', price: 65.5, status: 'ACTIVE',
    });
  });

  it('renames, and a rename to its own name is not a conflict', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras' });
    const o = await makeOption(p.id, g, { name: 'Syrup', price: 50 });
    const same = await patchOption(tokens.ownerA, p.id, g, o, { name: 'Syrup', price: 51 });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const res = await patchOption(tokens.ownerA, p.id, g, o, { name: 'Vanilla syrup' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(groupsOf(res).find((x) => x.id === g).options[0].name).toBe('Vanilla syrup');
  });

  it('refuses a rename onto a sibling option', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras' });
    const o = await makeOption(p.id, g, { name: 'Syrup', price: 50 });
    await makeOption(p.id, g, { name: 'Cream', price: 30 });
    const res = await patchOption(tokens.ownerA, p.id, g, o, { name: 'Cream' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Cream/);
  });

  it('archives an option and the order path stops offering it', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras', maxSelect: 2 });
    const o = await makeOption(p.id, g, { name: 'Syrup', price: 50 });
    await makeOption(p.id, g, { name: 'Cream', price: 30 });

    expect((await sell(p.id, [o])).status).toBe(201);
    const res = await patchOption(tokens.ownerA, p.id, g, o, { status: 'ARCHIVED' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await sell(p.id, [o]);
    expect(after.status).toBe(400);
    expect(after.body.error.message).toMatch(/Unknown or archived modifier option/);
  });

  it('404s for an option that belongs to a different group', async () => {
    const p = await freshProduct();
    const g1 = await makeGroup(p.id, { name: 'Hot extras' });
    const g2 = await makeGroup(p.id, { name: 'Cold extras' });
    const o2 = await makeOption(p.id, g2, { name: 'Ice', price: 0 });
    const res = await patchOption(tokens.ownerA, p.id, g1, o2, { price: 99 });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/Modifier option not found/);
  });

  it('404s for an unknown option id', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras' });
    const res = await patchOption(tokens.ownerA, p.id, g, 'no-such-option', { price: 1 });
    expect(res.status).toBe(404);
  });
});

describe('who may author a modifier', () => {
  it('a cashier may not, on any of the four routes', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras' });
    const o = await makeOption(p.id, g, { name: 'Syrup', price: 50 });

    const attempts = await Promise.all([
      postGroup(tokens.cashierA, p.id, { name: 'Rogue' }),
      patchGroup(tokens.cashierA, p.id, g, { name: 'Rogue' }),
      postOption(tokens.cashierA, p.id, g, { name: 'Rogue', price: 1 }),
      patchOption(tokens.cashierA, p.id, g, o, { price: 1 }),
    ]);
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    // Negative control for the assertion above: the same four calls as the
    // owner must succeed, or a broken route would read as a passing RBAC test.
    const allowed = await Promise.all([
      postGroup(tokens.ownerA, p.id, { name: 'Allowed' }),
      patchGroup(tokens.ownerA, p.id, g, { name: 'Renamed' }),
      postOption(tokens.ownerA, p.id, g, { name: 'Allowed', price: 1 }),
      patchOption(tokens.ownerA, p.id, g, o, { price: 2 }),
    ]);
    expect(allowed.map((r) => r.status)).toEqual([201, 200, 201, 200]);
  });

  it('an expired licence blocks the write even for the owner', async () => {
    const p = await prisma.product.create({
      data: {
        companyId: companyC.id,
        categoryId: (await prisma.category.create({ data: { companyId: companyC.id, name: 'Drinks' } })).id,
        name: 'Lapsed Widget',
        basePrice: '100.00',
      },
    });
    const res = await postGroup(tokens.ownerC, p.id, { name: 'Extras' });
    expect(res.status).toBe(403);
    // The code, not just the status: the screen tells an expired licence and a
    // forbidden role apart and must not send the owner to the wrong remedy.
    expect(res.body.error.code).toBe('POS_LICENSE_EXPIRED');
  });

  it('ATC may author once a company scope is given, and not before', async () => {
    const p = await freshProduct();
    const unscoped = await postGroup(tokens.atc, p.id, { name: 'Extras' });
    expect(unscoped.status).toBe(400);
    const scoped = await postGroup(tokens.atc, p.id, { name: 'Extras' }, `?companyId=${companyA.id}`);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(201);
  });
});

describe('the audit trail for modifier authoring', () => {
  it('records all four actions against the product, with the group in the meta', async () => {
    const p = await freshProduct();
    const g = await makeGroup(p.id, { name: 'Extras', maxSelect: 2 });
    const o = await makeOption(p.id, g, { name: 'Syrup', price: 50 });
    expect((await patchGroup(tokens.ownerA, p.id, g, { name: 'Add-ons' })).status).toBe(200);
    expect((await patchOption(tokens.ownerA, p.id, g, o, { price: 55 })).status).toBe(200);

    // Scoped to this product: the table accumulates across the whole file.
    const rows = await prisma.posAuditLog.findMany({
      where: { entityId: p.id },
      orderBy: { at: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual([
      'MODIFIER_GROUP_CREATE',
      'MODIFIER_OPTION_CREATE',
      'MODIFIER_GROUP_UPDATE',
      'MODIFIER_OPTION_UPDATE',
    ]);
    for (const r of rows) {
      expect(r.entity).toBe('Product');
      expect(r.companyId).toBe(companyA.id);
      // Stored, not joined — the row has to answer "who were they then".
      expect(r.actorEmail).toBe('owner.mod.a@test.local');
      expect(r.actorRole).toBe('CUSTOMER_OWNER');
      expect(r.meta.groupId).toBe(g);
    }
    expect(rows[1].meta).toMatchObject({ option: 'Syrup', price: 50 });
    expect(rows[2].meta).toMatchObject({ name: 'Add-ons' });
    expect(rows[3].meta).toMatchObject({ optionId: o, price: 55 });
  });

  it('a refused write leaves no audit row behind', async () => {
    const p = await freshProduct();
    await makeGroup(p.id, { name: 'Extras' });
    const before = await prisma.posAuditLog.count({ where: { entityId: p.id } });
    expect((await postGroup(tokens.ownerA, p.id, { name: 'Extras' })).status).toBe(409);
    expect((await postGroup(tokens.cashierA, p.id, { name: 'Nope' })).status).toBe(403);
    expect(await prisma.posAuditLog.count({ where: { entityId: p.id } })).toBe(before);
  });
});

// --- D-5, fixed ------------------------------------------------------------------
//
// The invariant the four routes now hold: an ACTIVE modifier group must have at
// least `minSelect` ACTIVE options. Until this was fixed, four ordinary catalog
// edits could break it and every one of them answered 200 or 201. The product
// then could not be sold on ANY channel, because orders.js `resolveCatalogLine`
// enforces minSelect over ACTIVE groups while building its option index from
// ACTIVE options only. See docs/VC104-BACKEND-DEFECTS.md D-5.
//
// The two tests that used to live here were TRIPWIREs asserting exactly that
// damage. They are now turned inside out: the same edits, refused. That is what
// a tripwire is for, and it is why the `sell` calls below are kept rather than
// replaced by a status-code check — a 409 on the write is only worth anything if
// the product is still sellable after it, and THAT is the claim.

// A group in the state the guard now prevents. Written straight through Prisma
// because every route into it is refused — which is precisely the position of a
// database that predates the fix, so this is also the fixture for the repairs.
const brokenGroup = async (productId, { name = 'Milk', minSelect = 1, options = [] } = {}) => {
  const group = await prisma.modifierGroup.create({
    data: { productId, name, minSelect, maxSelect: null, status: 'ACTIVE' },
  });
  const ids = [];
  for (const o of options) {
    const row = await prisma.modifierOption.create({
      data: {
        groupId: group.id,
        name: o.name,
        price: o.price.toFixed(2),
        status: o.status ?? 'ACTIVE',
      },
    });
    ids.push(row.id);
  }
  return [group.id, ...ids];
};

describe('a required group cannot be left unsatisfiable (D-5)', () => {
  describe('the four ways in', () => {
    // The first way in — POST with a minimum on a group that is born empty — is
    // asserted up in 'creating a modifier group', next to the rest of that
    // route's validation, rather than duplicated here.

    it('refuses archiving the last active option of a required group', async () => {
      const p = await freshProduct();
      const [g, whole] = await makeRequiredGroup(
        p.id,
        { name: 'Milk', minSelect: 1, maxSelect: 1 },
        [{ name: 'Whole', price: 0 }],
      );
      expect((await sell(p.id, [whole])).status).toBe(201);

      const res = await patchOption(tokens.ownerA, p.id, g, whole, { status: 'ARCHIVED' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe('POS_CONFLICT');
      expect(res.body.error.message).toMatch(
        /"Milk" would require 1 choice but only 0 are available/,
      );
      expect(res.body.error.message).toMatch(/Archive the whole group instead/);

      // The refusal has to be complete, not cosmetic: the option is still
      // ACTIVE and the product still sells. A guard that 409s after writing
      // would pass every assertion above and still have broken the catalog.
      expect((await sell(p.id, [whole])).status).toBe(201);
    });

    it('refuses raising minSelect above the options that exist', async () => {
      const p = await freshProduct();
      const g = await makeGroup(p.id, { name: 'Toppings' });
      const a = await makeOption(p.id, g, { name: 'Nuts', price: 10 });
      const b = await makeOption(p.id, g, { name: 'Choc', price: 10 });

      // maxSelect is null here, so the route's pre-existing `max < min` check is
      // skipped entirely. This is the case that check never covered.
      const res = await patchGroup(tokens.ownerA, p.id, g, { minSelect: 3 });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.message).toMatch(
        /"Toppings" would require 3 choices but only 2 are available/,
      );
      expect(res.body.error.message).toMatch(/lower the minimum, or archive the whole group/);

      // Two is the number it does have, and two is allowed.
      const ok = await patchGroup(tokens.ownerA, p.id, g, { minSelect: 2 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(groupNamed(ok, 'Toppings').minSelect).toBe(2);
      expect((await sell(p.id, [a, b])).status).toBe(201);
    });

    it('refuses re-activating a group whose options were all archived meanwhile', async () => {
      const p = await freshProduct();
      const [g, whole] = await makeRequiredGroup(
        p.id,
        { name: 'Milk', minSelect: 1 },
        [{ name: 'Whole', price: 0 }],
      );
      // Archiving the group is allowed, and so is emptying it afterwards — an
      // archived group constrains nothing, so neither step can hurt anyone.
      expect((await patchGroup(tokens.ownerA, p.id, g, { status: 'ARCHIVED' })).status).toBe(200);
      expect((await patchOption(tokens.ownerA, p.id, g, whole, { status: 'ARCHIVED' })).status).toBe(200);
      expect((await sell(p.id, [])).status).toBe(201);

      // Bringing it back is where it would start hurting, so that is where it stops.
      const res = await patchGroup(tokens.ownerA, p.id, g, { status: 'ACTIVE' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.message).toMatch(
        /"Milk" would require 1 choice but only 0 are available/,
      );
      expect((await sell(p.id, [])).status).toBe(201);
    });
  });

  describe('what the guard must not get in the way of', () => {
    it('archiving an option that is not the last one', async () => {
      const p = await freshProduct();
      const [g, whole, skim] = await makeRequiredGroup(
        p.id,
        { name: 'Milk', minSelect: 1, maxSelect: 1 },
        [{ name: 'Whole', price: 0 }, { name: 'Skim', price: 5 }],
      );
      expect((await patchOption(tokens.ownerA, p.id, g, skim, { status: 'ARCHIVED' })).status).toBe(200);
      expect((await sell(p.id, [whole])).status).toBe(201);
      // And now Whole IS the last one.
      expect((await patchOption(tokens.ownerA, p.id, g, whole, { status: 'ARCHIVED' })).status).toBe(409);
    });

    it('archiving the last option of a group that requires nothing', async () => {
      const p = await freshProduct();
      const g = await makeGroup(p.id, { name: 'Extras' });
      const nuts = await makeOption(p.id, g, { name: 'Nuts', price: 10 });
      expect((await patchOption(tokens.ownerA, p.id, g, nuts, { status: 'ARCHIVED' })).status).toBe(200);
      expect((await sell(p.id, [])).status).toBe(201);
    });

    it('editing an option without touching its status', async () => {
      // minSelect 1 with exactly one option: the count is on the edge, and a
      // guard that read `data.status` as ARCHIVED-when-absent would refuse this.
      const p = await freshProduct();
      const [g, whole] = await makeRequiredGroup(
        p.id,
        { name: 'Milk', minSelect: 1 },
        [{ name: 'Whole', price: 0 }],
      );
      const res = await patchOption(tokens.ownerA, p.id, g, whole, { price: 7.5 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(groupNamed(res, 'Milk').options[0].price).toBe(7.5);
    });

    it('archiving the whole group, which is the documented way to retire it', async () => {
      const p = await freshProduct();
      const [g] = await makeRequiredGroup(
        p.id,
        { name: 'Milk', minSelect: 1 },
        [{ name: 'Whole', price: 0 }],
      );
      expect((await patchGroup(tokens.ownerA, p.id, g, { status: 'ARCHIVED' })).status).toBe(200);
      expect((await sell(p.id, [])).status).toBe(201);
    });
  });

  describe('a group that was already broken before the guard existed', () => {
    // Rows like these are in any database that ran the old code. The guard is
    // checked against the RESULT of the write, so it refuses unrelated edits to
    // them too — deliberately, because that is the only moment anyone is looking.

    it('refuses an unrelated edit, which is how the owner finds out at all', async () => {
      const p = await freshProduct();
      const [g] = await brokenGroup(p.id, {
        minSelect: 1,
        options: [{ name: 'Whole', price: 0, status: 'ARCHIVED' }],
      });
      // The premise: this product is already unsellable, and nothing in the
      // catalog says so.
      const blocked = await sell(p.id, []);
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.message).toMatch(/Choose at least 1 from "Milk"/);

      const res = await patchGroup(tokens.ownerA, p.id, g, { name: 'Dairy' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      // The name in the message is the one the write asked for, not the stored
      // one, because the guard describes the state the write would leave behind.
      expect(res.body.error.message).toMatch(/"Dairy" would require 1 choice but only 0 are available/);
    });

    it('lets you lower the minimum', async () => {
      const p = await freshProduct();
      const [g] = await brokenGroup(p.id, {
        minSelect: 1,
        options: [{ name: 'Whole', price: 0, status: 'ARCHIVED' }],
      });
      expect((await patchGroup(tokens.ownerA, p.id, g, { minSelect: 0 })).status).toBe(200);
      expect((await sell(p.id, [])).status).toBe(201);
    });

    it('lets you restore the archived option', async () => {
      const p = await freshProduct();
      const [g, whole] = await brokenGroup(p.id, {
        minSelect: 1,
        options: [{ name: 'Whole', price: 0, status: 'ARCHIVED' }],
      });
      // The rule must never refuse the repair for the breakage it is reporting.
      expect((await patchOption(tokens.ownerA, p.id, g, whole, { status: 'ACTIVE' })).status).toBe(200);
      expect((await sell(p.id, [whole])).status).toBe(201);
    });

    it('lets you add a fresh option', async () => {
      const p = await freshProduct();
      const [g] = await brokenGroup(p.id, { minSelect: 1, options: [] });
      const skim = await makeOption(p.id, g, { name: 'Skim', price: 5 });
      expect((await sell(p.id, [skim])).status).toBe(201);
    });

    it('lets you archive the group', async () => {
      const p = await freshProduct();
      const [g] = await brokenGroup(p.id, { minSelect: 2, options: [{ name: 'Whole', price: 0 }] });
      expect((await patchGroup(tokens.ownerA, p.id, g, { status: 'ARCHIVED' })).status).toBe(200);
      expect((await sell(p.id, [])).status).toBe(201);
    });
  });
});

// Sells one of the product through the ordinary till route. The order path is
// the only place that can prove a catalog edit had the effect the edit claimed,
// and a D-5 refusal is worth nothing unless the product still sells afterwards.
async function sell(productId, modifierOptionIds) {
  return request(app)
    .post('/api/orders')
    .set(auth(tokens.cashierA))
    .send({
      type: 'TAKEAWAY',
      branchId: branchA1.id,
      items: [{ productId, qty: 1, modifierOptionIds }],
    });
}
