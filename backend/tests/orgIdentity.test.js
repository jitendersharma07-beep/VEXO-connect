// Organisation identity suite: legal entities, GST registrations, brands and
// regions — the four routers mounted at app.js:270-273 that carried no supertest
// coverage on any branch.
//
//   src/api/routes/legalEntities.js     GET /  POST /  PATCH /:id
//   src/api/routes/gstRegistrations.js  GET /  POST /  PATCH /:id
//   src/api/routes/brands.js            GET /  POST /  PATCH /:id  PUT /:id/stores
//   src/api/routes/regions.js           GET /  POST /  PATCH /:id
//
// 13 endpoints. All four carry `requireAction` over `loadPermissionContext`, all
// four are company-scoped, and all four have a live admin screen — so the things
// worth pinning are the authorisation matrix, the tenant boundary, and the
// refusals that protect the tax record. What is deliberately NOT asserted is
// anything that merely restates the schema.
//
// Two tenants exist throughout, and company B's rows are created for one reason:
// so that a real, existing id from another customer can be posted into company
// A's requests. A cross-tenant test against a made-up id proves only that the id
// was made up.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('orgIdentity.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { requiredModuleFor } = await import('../src/lib/permissions.js');

const app = createApp();

const PW = 'test-password-1';

// Statutory numbers that satisfy the shapes in lib/identity.js. The PAN sits at
// characters 3-12 of the GSTIN, so these are built as matched pairs on purpose —
// an accidentally mismatched pair would make the cross-check test below pass for
// the wrong reason.
const PAN_ALPHA = 'AAACA1234A';
const PAN_CATERING = 'AAACA5678B';
const PAN_BRAVO = 'AAACB9876C';
const GSTIN_ALPHA_DL = `07${PAN_ALPHA}1Z5`; // Delhi
const GSTIN_ALPHA_KA = `29${PAN_ALPHA}1Z9`; // Karnataka, same entity
const GSTIN_CATERING_DL = `07${PAN_CATERING}1Z7`;
const GSTIN_BRAVO_DL = `07${PAN_BRAVO}1Z3`;
const CIN_ALPHA = 'U55209DL2015PTC123456';

let companyA, companyB;
let regionNorth, regionSouth, regionBravo;
let storeDelhi, storeBengaluru, storeBravo;
let entityAlpha, entityCatering, entityBravo;
let gstAlphaDelhi, gstBravo;
let brandBravo;
let pinnedAdmin;
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const auth = (t) => ({ Authorization: `Bearer ${t}` });

const namesOf = (rows, key = 'name') => rows.map((r) => r[key]).sort();

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword(PW);

  // modules: [] on purpose — see the entitlement group at the bottom of the file.
  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Hospitality',
      slug: 'alpha-hospitality',
      licenses: {
        create: {
          plan: 'MULTI_STORE',
          baseBranchLimit: 5,
          modules: [],
          expiresAt: new Date(Date.now() + 86400e3),
        },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Kitchens',
      slug: 'bravo-kitchens',
      licenses: {
        create: {
          plan: 'MULTI_STORE',
          baseBranchLimit: 5,
          modules: [],
          expiresAt: new Date(Date.now() + 86400e3),
        },
      },
    },
  });

  regionNorth = await prisma.region.create({
    data: { companyId: companyA.id, name: 'North', code: 'NORTH' },
  });
  regionSouth = await prisma.region.create({
    data: { companyId: companyA.id, name: 'South', code: 'SOUTH' },
  });
  regionBravo = await prisma.region.create({
    data: { companyId: companyB.id, name: 'Bravo West', code: 'BW' },
  });

  entityAlpha = await prisma.legalEntity.create({
    data: {
      companyId: companyA.id,
      legalName: 'Alpha Hospitality Private Limited',
      tradeName: 'Alpha',
      pan: PAN_ALPHA,
    },
  });
  entityCatering = await prisma.legalEntity.create({
    data: {
      companyId: companyA.id,
      legalName: 'Alpha Catering LLP',
      pan: PAN_CATERING,
    },
  });
  entityBravo = await prisma.legalEntity.create({
    data: {
      companyId: companyB.id,
      legalName: 'Bravo Kitchens Private Limited',
      pan: PAN_BRAVO,
    },
  });

  gstAlphaDelhi = await prisma.gstRegistration.create({
    data: {
      companyId: companyA.id,
      legalEntityId: entityAlpha.id,
      gstin: GSTIN_ALPHA_DL,
      stateCode: '07',
      stateName: 'Delhi',
    },
  });
  gstBravo = await prisma.gstRegistration.create({
    data: {
      companyId: companyB.id,
      legalEntityId: entityBravo.id,
      gstin: GSTIN_BRAVO_DL,
      stateCode: '07',
      stateName: 'Delhi',
    },
  });

  // storeDelhi carries the full identity chain (entity + GSTIN + region) because
  // the archive refusals are counted off exactly these links.
  storeDelhi = await prisma.branch.create({
    data: {
      companyId: companyA.id,
      publicId: 'VC-DL-9101',
      name: 'Alpha Connaught Place',
      code: 'ACP',
      regionId: regionNorth.id,
      legalEntityId: entityAlpha.id,
      gstRegistrationId: gstAlphaDelhi.id,
    },
  });
  storeBengaluru = await prisma.branch.create({
    data: {
      companyId: companyA.id,
      publicId: 'VC-KA-9102',
      name: 'Alpha Indiranagar',
      code: 'AIN',
      regionId: regionSouth.id,
    },
  });
  storeBravo = await prisma.branch.create({
    data: {
      companyId: companyB.id,
      publicId: 'VC-DL-9103',
      name: 'Bravo Saket',
      code: 'BSK',
      regionId: regionBravo.id,
    },
  });

  brandBravo = await prisma.brand.create({
    data: { companyId: companyB.id, name: 'Bravo Biryani', code: 'BB' },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });

  await mk({ email: 'owner.a@test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  await mk({ email: 'finance.a@test.local', fullName: 'Finance A', role: 'FINANCE', companyId: companyA.id });
  await mk({
    email: 'regional.a@test.local',
    fullName: 'Regional A',
    role: 'REGIONAL_MANAGER',
    companyId: companyA.id,
    regionId: regionNorth.id,
  });
  await mk({
    email: 'manager.a@test.local',
    fullName: 'Manager A',
    role: 'BRANCH_MANAGER',
    companyId: companyA.id,
    branchId: storeDelhi.id,
  });
  await mk({
    email: 'cashier.a@test.local',
    fullName: 'Cashier A',
    role: 'CASHIER',
    companyId: companyA.id,
    branchId: storeDelhi.id,
  });
  await mk({ email: 'owner.b@test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });

  // A COMPANY_ADMIN narrowed by assignment to one store. This is the only
  // reachable principal that holds `org.brand.write` AND has a store scope
  // narrower than the tenant — see the note on the brand-store group.
  pinnedAdmin = await mk({
    email: 'admin.pinned@test.local',
    fullName: 'Pinned Admin',
    role: 'COMPANY_ADMIN',
    companyId: companyA.id,
  });
  await prisma.userStoreAssignment.create({
    data: { userId: pinnedAdmin.id, companyId: companyA.id, branchId: storeDelhi.id },
  });

  tokens.owner = await login('owner.a@test.local');
  tokens.finance = await login('finance.a@test.local');
  tokens.regional = await login('regional.a@test.local');
  tokens.manager = await login('manager.a@test.local');
  tokens.cashier = await login('cashier.a@test.local');
  tokens.ownerB = await login('owner.b@test.local');
  tokens.pinnedAdmin = await login('admin.pinned@test.local');
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The authorisation matrix
// ---------------------------------------------------------------------------
//
// Asymmetric in ways no reader would guess, which is the reason to pin it:
// Finance may re-register the business but may not name a brand; a store manager
// may see the GSTIN they bill under but not the entity that holds it, and not the
// region they sit in.

const READ_PATHS = {
  legalEntities: '/api/legal-entities',
  gst: '/api/gst-registrations',
  brands: '/api/brands',
  regions: '/api/regions',
};

const READ_MATRIX = {
  owner: { legalEntities: 200, gst: 200, brands: 200, regions: 200 },
  finance: { legalEntities: 200, gst: 200, brands: 200, regions: 200 },
  regional: { legalEntities: 200, gst: 200, brands: 200, regions: 200 },
  manager: { legalEntities: 403, gst: 200, brands: 200, regions: 403 },
  cashier: { legalEntities: 403, gst: 403, brands: 403, regions: 403 },
};

const WRITE_MATRIX = {
  owner: { legalEntities: true, gst: true, brands: true, regions: true },
  finance: { legalEntities: true, gst: true, brands: false, regions: false },
  regional: { legalEntities: false, gst: false, brands: false, regions: false },
  manager: { legalEntities: false, gst: false, brands: false, regions: false },
  cashier: { legalEntities: false, gst: false, brands: false, regions: false },
};

describe('organisation identity — authorisation matrix', () => {
  for (const [who, expected] of Object.entries(READ_MATRIX)) {
    it(`${who} reads exactly the four lists their role allows`, async () => {
      const actual = {};
      for (const [key, path] of Object.entries(READ_PATHS)) {
        const res = await request(app).get(path).set(auth(tokens[who]));
        actual[key] = res.status;
      }
      // One object comparison rather than four assertions: a mistake shows the
      // whole row at once, and no arm of it can be skipped.
      expect(actual).toEqual(expected);
    });
  }

  // The discriminator is 400-vs-403, not 200-vs-403. An empty body reaches the
  // zod parse only if `requireAction` and `requireUsableLicense` both passed, so
  // 400 proves the gate opened without this test having to create a row — and it
  // can never be confused with the 403 it is distinguishing itself from.
  for (const [who, expected] of Object.entries(WRITE_MATRIX)) {
    it(`${who} is refused at the gate on exactly the writes their role denies`, async () => {
      const actual = {};
      for (const [key, path] of Object.entries(READ_PATHS)) {
        const res = await request(app).post(path).set(auth(tokens[who])).send({});
        actual[key] = res.status;
        if (res.status === 403) expect(res.body.error.code).toBe('POS_FORBIDDEN');
      }
      expect(actual).toEqual(
        Object.fromEntries(Object.entries(expected).map(([k, allowed]) => [k, allowed ? 400 : 403])),
      );
    });
  }

  it('an unauthenticated caller is refused before any of it', async () => {
    for (const path of Object.values(READ_PATHS)) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// The tenant boundary
// ---------------------------------------------------------------------------

describe('organisation identity — tenant isolation', () => {
  it('each list contains this tenant only, by exact membership', async () => {
    // Exact equality, so a list that came back empty fails too. A `.every()`
    // over the rows would be vacuously true for a caller who saw nothing.
    const entities = await request(app).get('/api/legal-entities').set(auth(tokens.owner));
    expect(namesOf(entities.body.legalEntities, 'legalName')).toEqual([
      'Alpha Catering LLP',
      'Alpha Hospitality Private Limited',
    ]);

    const gst = await request(app).get('/api/gst-registrations').set(auth(tokens.owner));
    expect(gst.body.gstRegistrations.map((r) => r.gstin)).toEqual([GSTIN_ALPHA_DL]);

    const regions = await request(app).get('/api/regions').set(auth(tokens.owner));
    expect(namesOf(regions.body.regions)).toEqual(['North', 'South']);

    // And the mirror: B sees B's, never A's. One direction alone would pass for
    // a filter that hid everything from A and showed everything to B.
    const bGst = await request(app).get('/api/gst-registrations').set(auth(tokens.ownerB));
    expect(bGst.body.gstRegistrations.map((r) => r.gstin)).toEqual([GSTIN_BRAVO_DL]);
    const bRegions = await request(app).get('/api/regions').set(auth(tokens.ownerB));
    expect(namesOf(bRegions.body.regions)).toEqual(['Bravo West']);
  });

  it('no list leaks the companyId it was filtered on', async () => {
    const res = await request(app).get('/api/legal-entities').set(auth(tokens.owner));
    for (const row of res.body.legalEntities) expect(row).not.toHaveProperty('companyId');
    const brands = await request(app).get('/api/brands').set(auth(tokens.owner));
    for (const row of brands.body.brands) expect(row).not.toHaveProperty('companyId');
  });

  // Each of these targets a row that genuinely exists, in another tenant, and
  // each asserts the row is untouched afterwards. A 4xx on its own does not
  // prove nothing was written — the error could have been raised after the
  // update.
  it('patching another tenant row is refused and changes nothing', async () => {
    const entity = await request(app)
      .patch(`/api/legal-entities/${entityBravo.id}`)
      .set(auth(tokens.owner))
      .send({ legalName: 'Renamed By Alpha' });
    expect(entity.status).toBe(400);
    expect(entity.body.error.message).toBe('Legal entity not found');
    expect((await prisma.legalEntity.findUnique({ where: { id: entityBravo.id } })).legalName).toBe(
      'Bravo Kitchens Private Limited',
    );

    const gst = await request(app)
      .patch(`/api/gst-registrations/${gstBravo.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(gst.status).toBe(400);
    expect(gst.body.error.message).toBe('GST registration not found');
    expect((await prisma.gstRegistration.findUnique({ where: { id: gstBravo.id } })).status).toBe('ACTIVE');

    const brand = await request(app)
      .patch(`/api/brands/${brandBravo.id}`)
      .set(auth(tokens.owner))
      .send({ name: 'Taken Over' });
    expect(brand.status).toBe(400);
    expect(brand.body.error.message).toBe('Brand not found');
    expect((await prisma.brand.findUnique({ where: { id: brandBravo.id } })).name).toBe('Bravo Biryani');

    const region = await request(app)
      .patch(`/api/regions/${regionBravo.id}`)
      .set(auth(tokens.owner))
      .send({ name: 'Annexed' });
    expect(region.status).toBe(400);
    expect(region.body.error.message).toBe('Region not found');
    expect((await prisma.region.findUnique({ where: { id: regionBravo.id } })).name).toBe('Bravo West');
  });

  it('a foreign id and an absent id are answered identically', async () => {
    const foreign = await request(app)
      .patch(`/api/legal-entities/${entityBravo.id}`)
      .set(auth(tokens.owner))
      .send({ tradeName: 'x' });
    const absent = await request(app)
      .patch('/api/legal-entities/cl00000000000000000absent')
      .set(auth(tokens.owner))
      .send({ tradeName: 'x' });
    // Identical down to the code: an id that answers differently is an oracle
    // for "does this id exist in some other VEXO customer's account".
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body.error.code).toBe(absent.body.error.code);
    expect(foreign.body.error.message).toBe(absent.body.error.message);
  });

  it('a GST registration cannot be filed against another tenant legal entity', async () => {
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityBravo.id, gstin: GSTIN_BRAVO_DL });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Legal entity not found');
    expect(res.body.error.field).toBe('legalEntityId');
    // Nothing landed under either tenant.
    expect(await prisma.gstRegistration.count({ where: { legalEntityId: entityBravo.id } })).toBe(1);
  });

  it('a region cannot be nested inside another tenant region', async () => {
    const res = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Smuggled', code: 'SMG', parentId: regionBravo.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Parent region not found');
    expect(res.body.error.field).toBe('parentId');
    expect(await prisma.region.count({ where: { companyId: companyA.id, code: 'SMG' } })).toBe(0);
  });

  // Uniqueness is per tenant by design, and the reason is a disclosure one: a
  // globally unique GSTIN or PAN would answer "is this number already on VEXO?"
  // to anybody who can type one in.
  it('the same GSTIN and the same PAN are accepted in a second tenant', async () => {
    const entity = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.ownerB))
      .send({ legalName: 'Bravo Second Entity', pan: PAN_ALPHA });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);

    const gst = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.ownerB))
      .send({ legalEntityId: entity.body.legalEntity.id, gstin: GSTIN_ALPHA_DL });
    expect(gst.status, JSON.stringify(gst.body)).toBe(201);

    // …while a repeat inside one tenant is still a conflict.
    const repeat = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.ownerB))
      .send({ legalEntityId: entity.body.legalEntity.id, gstin: GSTIN_ALPHA_DL });
    expect(repeat.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Legal entities
// ---------------------------------------------------------------------------

describe('legal entities', () => {
  it('uppercases PAN and CIN rather than rejecting them', async () => {
    const res = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({
        legalName: '  Alpha Beverages Private Limited  ',
        pan: 'aaaca1111z',
        cin: CIN_ALPHA.toLowerCase(),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.legalEntity.pan).toBe('AAACA1111Z');
    expect(res.body.legalEntity.cin).toBe(CIN_ALPHA);
    // Trimmed, so the name cannot be duplicated by leading whitespace.
    expect(res.body.legalEntity.legalName).toBe('Alpha Beverages Private Limited');
  });

  it('refuses a malformed PAN with the reason, not a bare 400', async () => {
    const res = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Badly Typed Entity', pan: 'AAAC1234A' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/5 letters, 4 digits and a letter/);
    expect(res.body.error.field).toBe('pan');
  });

  it('separates a name clash from a PAN clash in the message', async () => {
    const byName = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Alpha Catering LLP' });
    expect(byName.status).toBe(409);
    expect(byName.body.error.message).toBe('Alpha Catering LLP already exists in this account');

    // Same PAN, different name: the operator needs to be told which entity
    // already holds the number, because that is the row they have to go and fix.
    const byPan = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Some Other Name Entirely', pan: PAN_CATERING });
    expect(byPan.status).toBe(409);
    expect(byPan.body.error.message).toBe(`PAN ${PAN_CATERING} is already on Alpha Catering LLP`);
  });

  // Nullable PAN with @@unique([companyId, pan]): Postgres treats NULLs as
  // distinct, so a tenant may hold several entities whose paperwork has not
  // arrived. If that index is ever made non-null-distinct this test is the one
  // that notices.
  it('allows more than one entity with no PAN yet', async () => {
    const first = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Alpha Pending One' });
    const second = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Alpha Pending Two' });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect([first.body.legalEntity.pan, second.body.legalEntity.pan]).toEqual([null, null]);
  });

  it('reports how many registrations and stores hang off each entity', async () => {
    const res = await request(app).get('/api/legal-entities').set(auth(tokens.owner));
    const alpha = res.body.legalEntities.find((e) => e.id === entityAlpha.id);
    expect({ gstCount: alpha.gstCount, storeCount: alpha.storeCount }).toEqual({ gstCount: 1, storeCount: 1 });
    const catering = res.body.legalEntities.find((e) => e.id === entityCatering.id);
    expect({ gstCount: catering.gstCount, storeCount: catering.storeCount }).toEqual({ gstCount: 0, storeCount: 0 });
  });

  it('refuses to archive an entity that still holds a registration or a store', async () => {
    const res = await request(app)
      .patch(`/api/legal-entities/${entityAlpha.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Move its GST registrations and stores/);
    expect((await prisma.legalEntity.findUnique({ where: { id: entityAlpha.id } })).status).toBe('ACTIVE');
  });

  it('archives an entity nothing points at, and a renamed entity keeps its id', async () => {
    const created = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Alpha Dormant Holdings' });
    const { id } = created.body.legalEntity;

    // A genuine change of name has to be recordable: the invoices already issued
    // carry the name they were issued under in Order.billingSnapshot, not a read
    // back through this row.
    const renamed = await request(app)
      .patch(`/api/legal-entities/${id}`)
      .set(auth(tokens.owner))
      .send({ legalName: 'Alpha Dormant Holdings Private Limited' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.legalEntity.id).toBe(id);

    const archived = await request(app)
      .patch(`/api/legal-entities/${id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(archived.status).toBe(200);
    expect(archived.body.legalEntity.status).toBe('ARCHIVED');
  });

  it('has no DELETE, because an entity that has invoiced is part of the tax record', async () => {
    const res = await request(app)
      .delete(`/api/legal-entities/${entityCatering.id}`)
      .set(auth(tokens.owner));
    expect(res.status).toBe(404);
    expect(await prisma.legalEntity.count({ where: { id: entityCatering.id } })).toBe(1);
  });

  it('writes an audit row naming the entity and the actor', async () => {
    const created = await request(app)
      .post('/api/legal-entities')
      .set(auth(tokens.owner))
      .send({ legalName: 'Alpha Audited Entity', pan: 'AAACA2222Y' });
    expect(created.status).toBe(201);
    const rows = await prisma.posAuditLog.findMany({
      where: { companyId: companyA.id, entityId: created.body.legalEntity.id },
    });
    expect(rows.map((r) => r.action)).toEqual(['LEGAL_ENTITY_CREATE']);
    // Who did it, not just what happened — an audit row that cannot name the
    // actor does not answer the question it exists for.
    expect(rows[0].actorEmail).toBe('owner.a@test.local');
    expect(rows[0].entity).toBe('LegalEntity');
  });
});

// ---------------------------------------------------------------------------
// GST registrations
// ---------------------------------------------------------------------------

describe('GST registrations', () => {
  it('derives the state from the GSTIN and stores it', async () => {
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({
        legalEntityId: entityAlpha.id,
        gstin: GSTIN_ALPHA_KA,
        city: 'Bengaluru',
        pincode: '560038',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Not echoed from the request — the request never mentioned Karnataka.
    expect({
      stateCode: res.body.gstRegistration.stateCode,
      stateName: res.body.gstRegistration.stateName,
    }).toEqual({ stateCode: '29', stateName: 'Karnataka' });
    expect(res.body.gstRegistration.legalEntityName).toBe('Alpha Hospitality Private Limited');
  });

  // The whole reason this check exists: nothing else would notice until an
  // invoice had already been issued naming the wrong seller.
  it('refuses a GSTIN whose embedded PAN is not the chosen entity', async () => {
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityCatering.id, gstin: GSTIN_ALPHA_DL });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('gstin');
    // Both numbers in the message, because "they do not match" does not tell the
    // operator which of the two they mistyped.
    expect(res.body.error.message).toContain(PAN_ALPHA);
    expect(res.body.error.message).toContain(PAN_CATERING);
    expect(await prisma.gstRegistration.count({ where: { legalEntityId: entityCatering.id } })).toBe(0);
  });

  it('accepts the matching pair for the same entity', async () => {
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityCatering.id, gstin: GSTIN_CATERING_DL });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('refuses a well-formed GSTIN carrying an unissued state code', async () => {
    // Passes GSTIN_RE — the shape is right and only the state is impossible, so
    // the regex cannot catch this one and stateNameFor has to.
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityAlpha.id, gstin: `99${PAN_ALPHA}1Z1` });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('99 is not a valid GST state code');
    expect(res.body.error.field).toBe('gstin');
  });

  it('uppercases a GSTIN typed in lower case', async () => {
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityAlpha.id, gstin: `06${PAN_ALPHA}1Z2`.toLowerCase() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.gstRegistration.gstin).toBe(`06${PAN_ALPHA}1Z2`);
    expect(res.body.gstRegistration.stateName).toBe('Haryana');
  });

  it('refuses to file a registration under an archived entity', async () => {
    const dormant = await prisma.legalEntity.create({
      data: {
        companyId: companyA.id,
        legalName: 'Alpha Wound Up LLP',
        pan: 'AAACA3333X',
        status: 'ARCHIVED',
      },
    });
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: dormant.id, gstin: `07AAACA3333X1Z4` });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That legal entity is archived');
    expect(res.body.error.field).toBe('legalEntityId');
  });

  // The GSTIN is the identity of the row. Editing it would silently move every
  // store mapped here onto a different registration, and every invoice already
  // issued would have been issued under the old one.
  it('ignores an attempt to edit the GSTIN, the state code or the state name', async () => {
    const res = await request(app)
      .patch(`/api/gst-registrations/${gstAlphaDelhi.id}`)
      .set(auth(tokens.owner))
      .send({
        gstin: GSTIN_CATERING_DL,
        stateCode: '27',
        stateName: 'Maharashtra',
        tradeName: 'Alpha CP',
      });
    expect(res.status).toBe(200);
    // The editable field took; the three identity fields did not.
    expect(res.body.gstRegistration.tradeName).toBe('Alpha CP');
    const row = await prisma.gstRegistration.findUnique({ where: { id: gstAlphaDelhi.id } });
    expect({ gstin: row.gstin, stateCode: row.stateCode, stateName: row.stateName }).toEqual({
      gstin: GSTIN_ALPHA_DL,
      stateCode: '07',
      stateName: 'Delhi',
    });
  });

  it('names the stores blocking an archive instead of counting them', async () => {
    const res = await request(app)
      .patch(`/api/gst-registrations/${gstAlphaDelhi.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(400);
    // "3 stores" makes the owner go looking; the point of the refusal is to tell
    // them where to look.
    expect(res.body.error.message).toContain('Alpha Connaught Place');
    expect((await prisma.gstRegistration.findUnique({ where: { id: gstAlphaDelhi.id } })).status).toBe('ACTIVE');
  });

  it('archives a registration no store maps to', async () => {
    const created = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityAlpha.id, gstin: `08${PAN_ALPHA}1Z6` });
    expect(created.status).toBe(201);
    const res = await request(app)
      .patch(`/api/gst-registrations/${created.body.gstRegistration.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(200);
    expect(res.body.gstRegistration.status).toBe('ARCHIVED');
  });

  it('refuses a malformed PIN code', async () => {
    const res = await request(app)
      .post('/api/gst-registrations')
      .set(auth(tokens.owner))
      .send({ legalEntityId: entityAlpha.id, gstin: `05${PAN_ALPHA}1Z8`, pincode: '01234' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/PIN code must be 6 digits/);
  });

  it('lists registrations grouped by state code', async () => {
    const res = await request(app).get('/api/gst-registrations').set(auth(tokens.owner));
    const codes = res.body.gstRegistrations.map((r) => r.stateCode);
    expect(codes).toEqual([...codes].sort());
    expect(codes.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

describe('brands', () => {
  let brandId;

  it('creates a brand, uppercasing the code', async () => {
    const res = await request(app)
      .post('/api/brands')
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Grill', code: 'ag-1' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.brand.code).toBe('AG-1');
    expect(res.body.brand.storeIds).toEqual([]);
    brandId = res.body.brand.id;
  });

  it('refuses a code that is not 2-12 letters, digits or dashes', async () => {
    const res = await request(app)
      .post('/api/brands')
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Bad Code', code: 'A' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/2-12 letters, digits or dashes/);
  });

  it('conflicts on a repeated name or code, naming the holder', async () => {
    const sameName = await request(app)
      .post('/api/brands')
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Grill', code: 'AG-2' });
    expect(sameName.status).toBe(409);
    expect(sameName.body.error.message).toBe('Alpha Grill (AG-1) already uses that name or code');

    const sameCode = await request(app)
      .post('/api/brands')
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Grill Express', code: 'AG-1' });
    expect(sameCode.status).toBe(409);
  });

  // The screen replaces the whole list every save, so each step has to be the
  // list and not a union with what was there before.
  it('replaces the store list wholesale, in both directions', async () => {
    const both = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [storeDelhi.id, storeBengaluru.id] });
    expect(both.status, JSON.stringify(both.body)).toBe(200);
    expect([...both.body.brand.storeIds].sort()).toEqual([storeDelhi.id, storeBengaluru.id].sort());

    const narrowed = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [storeBengaluru.id] });
    expect(narrowed.status).toBe(200);
    // Exactly one, and the right one: a union would have kept Delhi.
    expect(narrowed.body.brand.storeIds).toEqual([storeBengaluru.id]);

    const cleared = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.brand.storeIds).toEqual([]);
    expect(await prisma.branchBrand.count({ where: { brandId } })).toBe(0);
  });

  // Without the de-duplication in the route, createMany would violate the
  // composite primary key and this would be a 500 rather than a 200.
  it('de-duplicates a store id repeated in the payload', async () => {
    const res = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [storeDelhi.id, storeDelhi.id, storeDelhi.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.brand.storeIds).toEqual([storeDelhi.id]);
  });

  it('refuses another tenant store id and writes no link', async () => {
    const res = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [storeBravo.id] });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Store not found');
    expect(await prisma.branchBrand.count({ where: { branchId: storeBravo.id } })).toBe(0);
    // And the list it had before the refused call is intact — the route empties
    // the table inside the transaction, so a check that ran outside it would
    // have left this brand with no stores at all.
    const after = await request(app).get('/api/brands').set(auth(tokens.owner));
    expect(after.body.brands.find((b) => b.id === brandId).storeIds).toEqual([storeDelhi.id]);
  });

  // brands.js says the store-scope check stops "a regional manager" attaching a
  // brand outside their region. A REGIONAL_MANAGER cannot reach this code at
  // all: it has no `org.brand.write`, so `requireAction` refuses it first (the
  // matrix above pins that). The check is still load-bearing, and this is the
  // principal it is load-bearing for — a COMPANY_ADMIN narrowed by assignment,
  // whose scope is a LIST rather than the tenant.
  it('a store-narrowed admin may attach only the stores in their own scope', async () => {
    const outside = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.pinnedAdmin))
      .send({ storeIds: [storeBengaluru.id] });
    expect(outside.status).toBe(404);
    expect(outside.body.error.message).toBe('Store not found');

    // Positive control: the same caller, the same endpoint, a store inside their
    // scope. Without this the 404 above could equally mean the endpoint is
    // broken for this principal.
    const inside = await request(app)
      .put(`/api/brands/${brandId}/stores`)
      .set(auth(tokens.pinnedAdmin))
      .send({ storeIds: [storeDelhi.id] });
    expect(inside.status, JSON.stringify(inside.body)).toBe(200);
    expect(inside.body.brand.storeIds).toEqual([storeDelhi.id]);
  });

  it('refuses to attach stores to an archived brand', async () => {
    const created = await request(app)
      .post('/api/brands')
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Retired', code: 'AR-9' });
    const id = created.body.brand.id;
    const archived = await request(app)
      .patch(`/api/brands/${id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(archived.status).toBe(200);

    const res = await request(app)
      .put(`/api/brands/${id}/stores`)
      .set(auth(tokens.owner))
      .send({ storeIds: [storeDelhi.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That brand is archived');
  });

  it('ignores an attempt to edit the code, which is the stable handle', async () => {
    const res = await request(app)
      .patch(`/api/brands/${brandId}`)
      .set(auth(tokens.owner))
      .send({ code: 'ZZ-9', name: 'Alpha Grill House' });
    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe('Alpha Grill House');
    expect(res.body.brand.code).toBe('AG-1');
  });

  it('refuses a rename onto another brand name', async () => {
    const res = await request(app)
      .patch(`/api/brands/${brandId}`)
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Retired' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Another brand already uses that name');
  });

  it('accepts a no-op rename to the brand own name', async () => {
    // The clash check is skipped when the name has not changed; without that
    // guard a save with the form untouched would 409 against the row itself.
    const res = await request(app)
      .patch(`/api/brands/${brandId}`)
      .set(auth(tokens.owner))
      .send({ name: 'Alpha Grill House' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

describe('regions', () => {
  it('creates a region, uppercasing the code, and nests one inside another', async () => {
    const parent = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'West', code: 'west' });
    expect(parent.status, JSON.stringify(parent.body)).toBe(201);
    expect(parent.body.region.code).toBe('WEST');
    expect(parent.body.region.parentId).toBe(null);

    const child = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Mumbai Cluster', code: 'MUM', parentId: parent.body.region.id });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.region.parentId).toBe(parent.body.region.id);
  });

  it('conflicts on a repeated name or code', async () => {
    const res = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'North', code: 'N2' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('North (NORTH) already uses that name or code');
  });

  it('refuses a region as its own parent', async () => {
    const res = await request(app)
      .patch(`/api/regions/${regionNorth.id}`)
      .set(auth(tokens.owner))
      .send({ parentId: regionNorth.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That would make a region its own parent');
    expect(res.body.error.field).toBe('parentId');
    expect((await prisma.region.findUnique({ where: { id: regionNorth.id } })).parentId).toBe(null);
  });

  // The test the walk exists for. A one-level check — "is parentId my own id?" —
  // passes this, and Postgres will not stop it either: a self-referencing FK is
  // perfectly happy with A→B→C→A. The cycle would then make the scope resolver
  // and every "stores in this region" read loop for ever.
  it('refuses a cycle three levels deep', async () => {
    const a = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Cycle A', code: 'CYA' });
    const b = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Cycle B', code: 'CYB', parentId: a.body.region.id });
    const c = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Cycle C', code: 'CYC', parentId: b.body.region.id });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);

    // A→B→C already; pointing A at C closes the loop.
    const res = await request(app)
      .patch(`/api/regions/${a.body.region.id}`)
      .set(auth(tokens.owner))
      .send({ parentId: c.body.region.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That would make a region its own parent');
    expect((await prisma.region.findUnique({ where: { id: a.body.region.id } })).parentId).toBe(null);

    // Positive control: the same shape of request that is NOT a cycle is
    // accepted, so the walk is refusing cycles rather than refusing re-parenting.
    const ok = await request(app)
      .patch(`/api/regions/${c.body.region.id}`)
      .set(auth(tokens.owner))
      .send({ parentId: a.body.region.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('counts the stores and the managers scoped to a region', async () => {
    const res = await request(app).get('/api/regions').set(auth(tokens.owner));
    const north = res.body.regions.find((r) => r.id === regionNorth.id);
    // One store and one REGIONAL_MANAGER were fixtured onto North.
    expect({ storeCount: north.storeCount, managerCount: north.managerCount }).toEqual({
      storeCount: 1,
      managerCount: 1,
    });
    const south = res.body.regions.find((r) => r.id === regionSouth.id);
    expect({ storeCount: south.storeCount, managerCount: south.managerCount }).toEqual({
      storeCount: 1,
      managerCount: 0,
    });
  });

  // Archiving a region that still scopes a manager would widen that manager to
  // nothing, because storeScopeFor fails closed to an empty LIST. Refused with
  // the reason rather than applied quietly.
  it('refuses to archive a region that still holds stores, managers or children', async () => {
    const res = await request(app)
      .patch(`/api/regions/${regionNorth.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Move its stores, managers and child regions/);
    expect((await prisma.region.findUnique({ where: { id: regionNorth.id } })).status).toBe('ACTIVE');

    // A region blocked only by a child is refused for the same reason — the
    // three-way OR means a test that only ever had stores would not prove the
    // children arm is wired.
    const parent = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'East', code: 'EAST' });
    const childRes = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Kolkata Cluster', code: 'KOL', parentId: parent.body.region.id });
    expect(childRes.status).toBe(201);
    const blocked = await request(app)
      .patch(`/api/regions/${parent.body.region.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/child regions/);
  });

  it('archives an empty region', async () => {
    const created = await request(app)
      .post('/api/regions')
      .set(auth(tokens.owner))
      .send({ name: 'Unused Territory', code: 'UNU' });
    const res = await request(app)
      .patch(`/api/regions/${created.body.region.id}`)
      .set(auth(tokens.owner))
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(200);
    expect(res.body.region.status).toBe('ARCHIVED');
  });
});

// ---------------------------------------------------------------------------
// The ENTITLEMENT() headers on three of these four files
// ---------------------------------------------------------------------------
//
// gstRegistrations.js is headed ENTITLEMENT(MULTI_GST), brands.js
// ENTITLEMENT(BRANDS) and regions.js ENTITLEMENT(REGIONS). None of those three
// names is in the entitlement vocabulary: `License.modules` is documented in
// schema.prisma as holding EXTENSION_POINTS values, and EXTENSION_POINTS is
// INVENTORY, PURCHASE, KITCHEN and DELIVERY. `requiredModuleFor` therefore
// returns null for every `org.*` action and the module gate in requireAction
// never fires for these routers.
//
// That is not a hole — nothing is gated on a name that does not exist, and
// treating these as core POS is the safe direction. But the headers read as
// enforcement and are not, so the behaviour is pinned here rather than left to
// be rediscovered. If MULTI_GST, BRANDS or REGIONS are meant to be sellable,
// that is a product decision plus an EXTENSION_POINTS entry, and these tests are
// what will go red when it lands.

describe('entitlement labels on the identity routers', () => {
  it('no org.* action maps to a licensable module', () => {
    // The control is the first line: requiredModuleFor is not simply returning
    // null for everything.
    expect(requiredModuleFor('inventory.item.read')).toBe('INVENTORY');
    expect([
      requiredModuleFor('org.legalEntity.read'),
      requiredModuleFor('org.gst.write'),
      requiredModuleFor('org.brand.write'),
      requiredModuleFor('org.region.write'),
    ]).toEqual([null, null, null, null]);
  });

  it('all four routers answer on a licence that entitles no module at all', async () => {
    const license = await prisma.license.findFirst({ where: { companyId: companyA.id } });
    expect(license.modules).toEqual([]);
    for (const path of Object.values(READ_PATHS)) {
      const res = await request(app).get(path).set(auth(tokens.owner));
      expect(res.status, `${path} on modules: []`).toBe(200);
    }
  });

  it('an expired licence still allows the reads but blocks the writes', async () => {
    // requireAction runs before requireUsableLicense in all four routers, so the
    // order of the two refusals is observable: a permitted caller on a dead
    // licence is licence-blocked, not forbidden.
    await prisma.license.updateMany({
      where: { companyId: companyB.id },
      data: { expiresAt: new Date(Date.now() - 86400e3) },
    });
    const read = await request(app).get('/api/brands').set(auth(tokens.ownerB));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/api/brands')
      .set(auth(tokens.ownerB))
      .send({ name: 'Bravo Expired Brand', code: 'BEB' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).not.toBe('POS_FORBIDDEN');
    expect(await prisma.brand.count({ where: { companyId: companyB.id, code: 'BEB' } })).toBe(0);
  });
});
