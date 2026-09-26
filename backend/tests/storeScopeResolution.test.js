// resolveStoreInScope: the store half of the authorisation model.
//
// This file exists because of a defect found while writing the brand-store
// tests in orgIdentity.test.js, and it is kept separate because the defect is
// not in any one router — it is in the middleware that eleven call sites across
// nine files depend on: eight routers plus lib/userAuthority.js, with a twelfth
// call inside requireStoreParam in the middleware itself. Counted from
// `git grep -n resolveStoreInScope -- 'backend/src/**'`; an earlier revision of
// this header said "ten call sites across nine routers", which undercounted and
// mislabelled the lib.
//
// THE DEFECT (middleware/permissions.js, resolveStoreInScope)
//
//   where: {
//     id: String(branchId),                        // the store the caller named
//     companyId: req.companyScope.id,
//     ...branchWhereForScope(req.perm.scope),      // ← for a LIST scope this is
//   }                                              //   { id: { in: [...] } }
//
// Later keys win in an object spread, so for a LIST scope the `id` of the store
// the caller actually asked for is DISCARDED and replaced by "any store in my
// own scope". The lookup then succeeds — returning a DIFFERENT branch — and the
// guard never fires.
//
// It bites exactly the principals the guard exists for:
//   LIST     → broken. Every store-pinned role (BRANCH_MANAGER, CASHIER, CAPTAIN,
//              KITCHEN, DELIVERY) resolves to a LIST, as does any role narrowed
//              by a UserStoreAssignment row.
//   REGION   → unaffected: the fragment is { regionId }, a different key, so both
//              constraints survive.
//   COMPANY  → unaffected: the fragment is {}.
//   ALL      → unaffected: the fragment is {}.
//
// Reads degrade to "wrong store, silently". The authorisation bypass is on the
// writes, wherever a route discards the returned branch and then trusts the
// caller-supplied id — brands.js:147 and permissions.js:359 both do, and the
// second is the one that hands out scope a caller does not itself hold.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('storeScopeResolution.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { resolveStoreInScope } = await import('../src/middleware/permissions.js');

const app = createApp();
const PW = 'test-password-1';

let company, otherCompany;
let regionNorth, regionSouth;
let storeA, storeB, storeC, foreignStore;
let brand, pinnedAdmin, cashier, regionalManager;
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};
const auth = (t) => ({ Authorization: `Bearer ${t}` });

// resolveStoreInScope reads exactly two things off the request, so it can be
// driven directly. This is how each scope kind gets covered without inventing a
// router for every one of them.
const reqWith = (scope) => ({ companyScope: { id: company.id }, perm: { scope } });

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword(PW);

  company = await prisma.company.create({
    data: {
      name: 'Scope Test Co',
      slug: 'scope-test-co',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 9, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  otherCompany = await prisma.company.create({
    data: {
      name: 'Other Co',
      slug: 'other-co',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 9, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });

  regionNorth = await prisma.region.create({ data: { companyId: company.id, name: 'North', code: 'N' } });
  regionSouth = await prisma.region.create({ data: { companyId: company.id, name: 'South', code: 'S' } });

  storeA = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-XX-9201', name: 'Store A', code: 'SA', regionId: regionNorth.id },
  });
  storeB = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-XX-9202', name: 'Store B', code: 'SB', regionId: regionSouth.id },
  });
  storeC = await prisma.branch.create({
    data: { companyId: company.id, publicId: 'VC-XX-9203', name: 'Store C', code: 'SC', regionId: regionNorth.id },
  });
  foreignStore = await prisma.branch.create({
    data: { companyId: otherCompany.id, publicId: 'VC-XX-9204', name: 'Foreign', code: 'FS' },
  });

  brand = await prisma.brand.create({ data: { companyId: company.id, name: 'House Brand', code: 'HB' } });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'owner@scope.local', fullName: 'Owner', role: 'CUSTOMER_OWNER', companyId: company.id });
  // COMPANY_ADMIN narrowed by assignment to storeA only: the reachable principal
  // that holds both `org.brand.write` and `user.write` while having a LIST scope.
  pinnedAdmin = await mk({
    email: 'pinned@scope.local',
    fullName: 'Pinned Admin',
    role: 'COMPANY_ADMIN',
    companyId: company.id,
  });
  await prisma.userStoreAssignment.create({
    data: { userId: pinnedAdmin.id, companyId: company.id, branchId: storeA.id },
  });
  cashier = await mk({
    email: 'cashier@scope.local',
    fullName: 'Cashier',
    role: 'CASHIER',
    companyId: company.id,
    branchId: storeA.id,
  });
  regionalManager = await mk({
    email: 'regional@scope.local',
    fullName: 'Regional',
    role: 'REGIONAL_MANAGER',
    companyId: company.id,
    regionId: regionNorth.id,
  });

  tokens.owner = await login('owner@scope.local');
  tokens.pinned = await login('pinned@scope.local');
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The middleware itself, one case per scope kind
// ---------------------------------------------------------------------------

describe('resolveStoreInScope', () => {
  it('returns the store that was actually asked for, not merely some store in scope', async () => {
    // The heart of it. A LIST-scoped caller asks for storeA and must get storeA —
    // asserting the returned id, because a guard that returns the wrong branch
    // while still returning *a* branch is how the bypass hid.
    const got = await resolveStoreInScope(reqWith({ kind: 'LIST', branchIds: [storeA.id, storeC.id] }), storeC.id);
    expect(got.id).toBe(storeC.id);
  });

  it('refuses a store outside a LIST scope', async () => {
    await expect(
      resolveStoreInScope(reqWith({ kind: 'LIST', branchIds: [storeA.id] }), storeB.id),
    ).rejects.toMatchObject({ status: 404, message: 'Store not found' });
  });

  it('refuses every store when the LIST is empty', async () => {
    // storeScopeFor fails closed to an empty LIST for a principal whose scope
    // cannot be established. That must mean "nothing", never "anything".
    await expect(
      resolveStoreInScope(reqWith({ kind: 'LIST', branchIds: [] }), storeA.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a store outside a REGION scope and allows one inside it', async () => {
    const inside = await resolveStoreInScope(reqWith({ kind: 'REGION', regionId: regionNorth.id }), storeC.id);
    expect(inside.id).toBe(storeC.id);
    await expect(
      resolveStoreInScope(reqWith({ kind: 'REGION', regionId: regionNorth.id }), storeB.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('allows any store of the tenant for a COMPANY scope, and none of another tenant', async () => {
    for (const store of [storeA, storeB, storeC]) {
      expect((await resolveStoreInScope(reqWith({ kind: 'COMPANY' }), store.id)).id).toBe(store.id);
    }
    // The tenant filter is independent of the scope filter and must hold even
    // for the widest scope a customer principal can have.
    await expect(
      resolveStoreInScope(reqWith({ kind: 'COMPANY' }), foreignStore.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      resolveStoreInScope(reqWith({ kind: 'ALL' }), foreignStore.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a missing, empty or absent id', async () => {
    for (const bad of [undefined, null, '', 'cl00000000000000000absent']) {
      await expect(
        resolveStoreInScope(reqWith({ kind: 'COMPANY' }), bad),
      ).rejects.toMatchObject({ status: 404, message: 'Store not found' });
    }
  });
});

// ---------------------------------------------------------------------------
// The two consumers where the defect was an authorisation bypass
// ---------------------------------------------------------------------------

describe('store scope through the routers that trust the caller-supplied id', () => {
  // brands.js:147 checks each id and then writes the caller's ids, so a check
  // that silently matched a different store let the write through.
  it('a store-narrowed admin cannot attach a brand to a store outside their scope', async () => {
    const res = await request(app)
      .put(`/api/brands/${brand.id}/stores`)
      .set(auth(tokens.pinned))
      .send({ storeIds: [storeB.id] });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Store not found');
    // The refusal has to mean nothing was written. The route empties the link
    // table inside its transaction, so this also proves the check runs before
    // the delete takes effect.
    expect(await prisma.branchBrand.count({ where: { brandId: brand.id } })).toBe(0);
  });

  it('…and a mixed payload is refused whole, not partially applied', async () => {
    // One id inside scope, one outside. A loop that wrote as it validated would
    // leave storeA attached.
    const res = await request(app)
      .put(`/api/brands/${brand.id}/stores`)
      .set(auth(tokens.pinned))
      .send({ storeIds: [storeA.id, storeB.id] });
    expect(res.status).toBe(404);
    expect(await prisma.branchBrand.count({ where: { brandId: brand.id } })).toBe(0);
  });

  it('…while the same caller may still attach the store they do run', async () => {
    // Positive control. Without it the two refusals above would also pass if the
    // endpoint were simply broken for this principal.
    const res = await request(app)
      .put(`/api/brands/${brand.id}/stores`)
      .set(auth(tokens.pinned))
      .send({ storeIds: [storeA.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.brand.storeIds).toEqual([storeA.id]);
  });

  // The serious one. storeScopeFor documents three checks that stop "assignments
  // REPLACE the scope" from meaning "help yourself", and "every store named must
  // already be inside the CALLER's own scope" is the second of them. Until the
  // middleware fix that check did nothing for a LIST-scoped caller, so a store-
  // narrowed admin could hand a subordinate a store the admin cannot reach — new
  // scope created out of nothing.
  it('a store-narrowed admin cannot assign a colleague to a store they do not hold', async () => {
    const res = await request(app)
      .put(`/api/permissions/assignments/${cashier.id}`)
      .set(auth(tokens.pinned))
      .send({ storeIds: [storeB.id] });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Store not found');
    expect(await prisma.userStoreAssignment.count({ where: { userId: cashier.id } })).toBe(0);
  });

  it('…and may assign the store they do hold', async () => {
    const res = await request(app)
      .put(`/api/permissions/assignments/${cashier.id}`)
      .set(auth(tokens.pinned))
      .send({ storeIds: [storeA.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await prisma.userStoreAssignment.findMany({ where: { userId: cashier.id } });
    expect(rows.map((r) => r.branchId)).toEqual([storeA.id]);
  });

  // ---------------------------------------------------------------------------
  // The second harm mode: callers that DO use the returned branch
  //
  // These never wrote another tenant's data, so they are not the bypass — but
  // pre-fix they resolved a request for store B into store A and then wrote
  // store A, reporting success. The operator was told the thing they asked for
  // had happened somewhere they never named.
  // ---------------------------------------------------------------------------

  // terminals.js:73 — the clearest case, because the wrong row is left behind
  // and can be counted.
  it('a store-narrowed admin cannot create a till at a store outside their scope', async () => {
    const res = await request(app)
      .post('/api/terminals')
      .set(auth(tokens.pinned))
      .send({ branchId: storeB.id, code: 'T1', name: 'Front Till' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Store not found');
    // Pre-fix this returned 201 with a till created at storeA — the caller's own
    // store — for a request that named storeB. Neither store may have one now,
    // and storeA is the half that discriminates: a fix that only stopped the
    // cross-store write would still leave a till here.
    expect(await prisma.terminal.count({ where: { branchId: { in: [storeA.id, storeB.id] } } })).toBe(0);
  });

  it('…and may create one at the store they do run', async () => {
    const res = await request(app)
      .post('/api/terminals')
      .set(auth(tokens.pinned))
      .send({ branchId: storeA.id, code: 'T1', name: 'Front Till' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await prisma.terminal.findMany({ where: { code: 'T1' } });
    expect(rows.map((r) => r.branchId)).toEqual([storeA.id]);
  });

  // userAuthority.js:105, reached through PATCH /api/users/:userId. The status is
  // the discriminator here, not the row: the subject already sits at storeA (the
  // only store this caller can see a user in), so pre-fix the silent rewrite to
  // storeA was a no-op that still answered 200 — "moved", to a store the request
  // never mentioned.
  it('a store-narrowed admin cannot move a colleague to a store outside their scope', async () => {
    const res = await request(app)
      .patch(`/api/users/${cashier.id}`)
      .set(auth(tokens.pinned))
      .send({ branchId: storeB.id });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Store not found');
    const after = await prisma.posUser.findUnique({ where: { id: cashier.id } });
    expect(after.branchId).toBe(storeA.id);
  });

  it('…and the same request naming their own store is accepted', async () => {
    const res = await request(app)
      .patch(`/api/users/${cashier.id}`)
      .set(auth(tokens.pinned))
      .send({ branchId: storeA.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user.branch.id).toBe(storeA.id);
  });

  it('the owner, whose scope is the whole tenant, is unaffected in both directions', async () => {
    // Guards the fix against over-correction: COMPANY scope must not lose the
    // ability to reach every store, and must still not reach another tenant's.
    const wide = await request(app)
      .put(`/api/brands/${brand.id}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [storeA.id, storeB.id, storeC.id] });
    expect(wide.status, JSON.stringify(wide.body)).toBe(200);
    expect([...wide.body.brand.storeIds].sort()).toEqual([storeA.id, storeB.id, storeC.id].sort());

    const foreign = await request(app)
      .put(`/api/brands/${brand.id}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [foreignStore.id] });
    expect(foreign.status).toBe(404);
    // Unchanged from the successful call above: the refusal rolled back.
    expect(await prisma.branchBrand.count({ where: { brandId: brand.id } })).toBe(3);
  });
});
