// Floor plan designer suite (TQ-1): floors, areas, draft/publish layouts,
// stable table identity, concurrent-edit conflicts, occupied-table guards,
// role gates and tenant isolation.
//
// Runs ONLY against a database whose name ends in _test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('floorplan.test.js requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();

const wipeFloorplan = async () => {
  await prisma.floorLayoutTable.deleteMany();
  await prisma.floorLayoutObject.deleteMany();
  await prisma.floorLayout.deleteMany();
  await prisma.diningArea.deleteMany();
  await prisma.floor.deleteMany();
};

const wipe = async () => {
  await wipeFloorplan();
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
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
let companyA, companyB, branchA1, branchA2, managerA1User;
const tokens = {};

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

const auth = (t) => ({ Authorization: `Bearer ${t}` });

const place = (tableId, x, y, extra = {}) => ({
  tableId,
  shape: 'SQUARE',
  x,
  y,
  width: 80,
  height: 80,
  rotation: 0,
  ...extra,
});

beforeAll(async () => {
  await wipe();
  const passwordHash = await hashPassword(PW);
  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Diner',
      slug: 'alpha-diner',
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 2, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  companyB = await prisma.company.create({
    data: {
      name: 'Bravo Bistro',
      slug: 'bravo-bistro',
      licenses: {
        create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: new Date(Date.now() + 86400e3) },
      },
    },
  });
  branchA1 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-FP-0001', name: 'Alpha One', code: 'A1' } });
  branchA2 = await prisma.branch.create({ data: { companyId: companyA.id, publicId: 'VC-FP-0002', name: 'Alpha Two', code: 'A2' } });
  await prisma.branch.create({ data: { companyId: companyB.id, publicId: 'VC-FP-0003', name: 'Bravo One', code: 'B1' } });

  await prisma.posUser.create({
    data: { email: 'owner.a@fp.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id, passwordHash },
  });
  managerA1User = await prisma.posUser.create({
    data: { email: 'manager.a1@fp.local', fullName: 'Manager A1', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA1.id, passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'manager.a2@fp.local', fullName: 'Manager A2', role: 'BRANCH_MANAGER', companyId: companyA.id, branchId: branchA2.id, passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'cashier.a1@fp.local', fullName: 'Cashier A1', role: 'CASHIER', companyId: companyA.id, branchId: branchA1.id, passwordHash },
  });
  await prisma.posUser.create({
    data: { email: 'owner.b@fp.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id, passwordHash },
  });

  tokens.ownerA = await login('owner.a@fp.local');
  tokens.managerA1 = await login('manager.a1@fp.local');
  tokens.managerA2 = await login('manager.a2@fp.local');
  tokens.cashierA1 = await login('cashier.a1@fp.local');
  tokens.ownerB = await login('owner.b@fp.local');
});

afterAll(async () => {
  // Peer suites' wipe helpers predate these tables; leaving rows here would
  // break their diningTable.deleteMany with a foreign-key error.
  await wipeFloorplan();
  await prisma.$disconnect();
});

describe('floors and areas', () => {
  let floorId;

  it('owner creates a floor with indoor and outdoor areas', async () => {
    const f = await request(app)
      .post('/api/floors')
      .set(auth(tokens.ownerA))
      .send({ name: 'Ground Floor', branchId: branchA1.id });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    floorId = f.body.floor.id;

    const indoor = await request(app)
      .post(`/api/floors/${floorId}/areas`)
      .set(auth(tokens.ownerA))
      .send({ name: 'Main Hall', kind: 'INDOOR' });
    expect(indoor.status).toBe(201);
    const outdoor = await request(app)
      .post(`/api/floors/${floorId}/areas`)
      .set(auth(tokens.ownerA))
      .send({ name: 'Garden', kind: 'OUTDOOR' });
    expect(outdoor.status).toBe(201);

    const list = await request(app).get('/api/floors').set(auth(tokens.ownerA));
    expect(list.status).toBe(200);
    const floor = list.body.floors.find((x) => x.id === floorId);
    expect(floor.areas.map((a) => a.kind).sort()).toEqual(['INDOOR', 'OUTDOOR']);
  });

  it('refuses a duplicate floor name in the same branch', async () => {
    const res = await request(app)
      .post('/api/floors')
      .set(auth(tokens.ownerA))
      .send({ name: 'Ground Floor', branchId: branchA1.id });
    expect(res.status).toBe(409);
  });

  it('cashier cannot create floors; branch manager cannot touch another branch', async () => {
    const cashier = await request(app)
      .post('/api/floors')
      .set(auth(tokens.cashierA1))
      .send({ name: 'Cashier Floor', branchId: branchA1.id });
    expect(cashier.status).toBe(403);
    const wrongBranch = await request(app)
      .patch(`/api/floors/${floorId}`)
      .set(auth(tokens.managerA2))
      .send({ name: 'Hijack' });
    expect(wrongBranch.status).toBe(403);
  });

  it('another company sees nothing (404 identical to absent)', async () => {
    const res = await request(app).get(`/api/floors/${floorId}/layout`).set(auth(tokens.ownerB));
    expect(res.status).toBe(404);
  });
});

describe('draft → publish lifecycle', () => {
  let floorId, areaIndoor, areaOutdoor, revision;
  let t1Id, t2Id;

  beforeAll(async () => {
    const f = await request(app)
      .post('/api/floors')
      .set(auth(tokens.ownerA))
      .send({ name: 'First Floor', branchId: branchA1.id });
    floorId = f.body.floor.id;
    const a1 = await request(app)
      .post(`/api/floors/${floorId}/areas`)
      .set(auth(tokens.ownerA))
      .send({ name: 'Dining', kind: 'INDOOR' });
    areaIndoor = a1.body.area.id;
    const a2 = await request(app)
      .post(`/api/floors/${floorId}/areas`)
      .set(auth(tokens.ownerA))
      .send({ name: 'Terrace', kind: 'ROOFTOP' });
    areaOutdoor = a2.body.area.id;
  });

  it('creates an empty draft and saves tables and layout objects', async () => {
    const draft = await request(app).post(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA)).send({});
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    revision = draft.body.layout.revision;

    const save = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.ownerA))
      .send({
        revision,
        gridSize: 20,
        tables: [
          { create: { name: 'T1', capacity: 4 }, areaId: areaIndoor, shape: 'ROUND', seats: 4, x: 100, y: 100, width: 80, height: 80, rotation: 0 },
          { create: { name: 'T2', capacity: 2 }, areaId: areaOutdoor, shape: 'RECT', seats: 2, x: 300, y: 120, width: 120, height: 60, rotation: 90 },
        ],
        objects: [
          { kind: 'WALL', x: 0, y: 0, width: 600, height: 10, rotation: 0 },
          { kind: 'KITCHEN', label: 'Kitchen', x: 500, y: 400, width: 150, height: 100, rotation: 0 },
        ],
      });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.layout.revision).toBe(revision + 1);
    revision = save.body.layout.revision;
    expect(save.body.layout.tables).toHaveLength(2);
    t1Id = save.body.layout.tables.find((t) => t.name === 'T1').tableId;
    t2Id = save.body.layout.tables.find((t) => t.name === 'T2').tableId;
    expect(save.body.layout.objects.map((o) => o.kind).sort()).toEqual(['KITCHEN', 'WALL']);
  });

  it('a second draft is refused while one exists', async () => {
    const res = await request(app).post(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_DRAFT_EXISTS');
  });

  it('a stale revision is a concurrent-edit conflict', async () => {
    const res = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.ownerA))
      .send({ revision: revision - 1, tables: [], objects: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POS_LAYOUT_CONFLICT');
  });

  it('publishes as version 1; published layout is readable by a cashier', async () => {
    const pub = await request(app)
      .post(`/api/floors/${floorId}/draft/publish`)
      .set(auth(tokens.ownerA))
      .send({ revision });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.layout.status).toBe('PUBLISHED');
    expect(pub.body.layout.version).toBe(1);

    const read = await request(app).get(`/api/floors/${floorId}/layout`).set(auth(tokens.cashierA1));
    expect(read.status).toBe(200);
    expect(read.body.layout.tables).toHaveLength(2);
  });

  it('rename + move via a new draft preserves table ids (QR/order links stable)', async () => {
    const draft = await request(app).post(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA)).send({});
    expect(draft.status).toBe(201);
    // Draft copied from published — placements carried over.
    expect(draft.body.layout.tables).toHaveLength(2);
    const rev = draft.body.layout.revision;

    const save = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.ownerA))
      .send({
        revision: rev,
        tables: [
          place(t1Id, 400, 400, { rename: 'Window 1', shape: 'ROUND', seats: 4, areaId: areaIndoor }),
          place(t2Id, 300, 120, { shape: 'RECT', width: 120, height: 60, seats: 2, areaId: areaOutdoor }),
        ],
        objects: [],
      });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    const pub = await request(app)
      .post(`/api/floors/${floorId}/draft/publish`)
      .set(auth(tokens.ownerA))
      .send({ revision: save.body.layout.revision });
    expect(pub.status).toBe(200);
    expect(pub.body.layout.version).toBe(2);
    const renamed = pub.body.layout.tables.find((t) => t.tableId === t1Id);
    expect(renamed.name).toBe('Window 1');
    expect(renamed.x).toBe(400);
    // Same DiningTable row — identity preserved across rename and move.
    const row = await prisma.diningTable.findUnique({ where: { id: t1Id } });
    expect(row.name).toBe('Window 1');
  });

  it('archives superseded layouts instead of deleting them (history retained)', async () => {
    const archived = await prisma.floorLayout.findMany({ where: { floorId, status: 'ARCHIVED' } });
    expect(archived).toHaveLength(1);
    expect(archived[0].version).toBe(1);
  });

  it('refuses to publish a draft that drops an occupied table', async () => {
    await prisma.order.create({
      data: {
        companyId: companyA.id,
        branchId: branchA1.id,
        type: 'DINE_IN',
        status: 'OPEN',
        tableId: t1Id,
        openedById: managerA1User.id,
      },
    });
    const draft = await request(app).post(`/api/floors/${floorId}/draft`).set(auth(tokens.managerA1)).send({});
    expect(draft.status).toBe(201);
    const save = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.managerA1))
      .send({
        revision: draft.body.layout.revision,
        tables: [place(t2Id, 300, 120, { shape: 'RECT', width: 120, height: 60 })],
        objects: [],
      });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    const pub = await request(app)
      .post(`/api/floors/${floorId}/draft/publish`)
      .set(auth(tokens.managerA1))
      .send({ revision: save.body.layout.revision });
    expect(pub.status).toBe(409);
    expect(pub.body.error.code).toBe('POS_OCCUPIED_TABLES');
    expect(pub.body.error.message).toContain('Window 1');
  });

  it('refuses to rename an occupied table', async () => {
    const save = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.ownerA))
      .send({
        revision: (await request(app).get(`/api/floors/${floorId}/layout?mode=draft`).set(auth(tokens.ownerA))).body.layout.revision,
        tables: [place(t1Id, 100, 100, { rename: 'Busy' }), place(t2Id, 300, 120)],
        objects: [],
      });
    expect(save.status).toBe(409);
    expect(save.body.error.message).toContain('open order');
  });

  it('keeps the occupied table when the draft retains it, and publish succeeds', async () => {
    const cur = await request(app).get(`/api/floors/${floorId}/layout?mode=draft`).set(auth(tokens.ownerA));
    const save = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.ownerA))
      .send({
        revision: cur.body.layout.revision,
        tables: [place(t1Id, 150, 150), place(t2Id, 320, 140)],
        objects: [],
      });
    expect(save.status).toBe(200);
    const pub = await request(app)
      .post(`/api/floors/${floorId}/draft/publish`)
      .set(auth(tokens.ownerA))
      .send({ revision: save.body.layout.revision });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.layout.version).toBe(3);
    const occupied = pub.body.layout.tables.find((t) => t.tableId === t1Id);
    expect(occupied.occupied).toBe(true);
  });

  it('refuses to retire a floor whose published layout has occupied tables', async () => {
    const res = await request(app)
      .patch(`/api/floors/${floorId}`)
      .set(auth(tokens.ownerA))
      .send({ status: 'RETIRED' });
    expect(res.status).toBe(409);
  });

  it('discarding a draft leaves published intact', async () => {
    const draft = await request(app).post(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA)).send({});
    expect(draft.status).toBe(201);
    const del = await request(app).delete(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA));
    expect(del.status).toBe(200);
    const read = await request(app).get(`/api/floors/${floorId}/layout`).set(auth(tokens.ownerA));
    expect(read.body.layout.version).toBe(3);
    const gone = await request(app).get(`/api/floors/${floorId}/layout?mode=draft`).set(auth(tokens.ownerA));
    expect(gone.body.layout).toBeNull();
  });

  it('rejects a background image that is not a data:image URL', async () => {
    const draft = await request(app).post(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA)).send({});
    const res = await request(app)
      .put(`/api/floors/${floorId}/draft`)
      .set(auth(tokens.ownerA))
      .send({ revision: draft.body.layout.revision, backgroundImage: 'https://evil.example/x.png', tables: [], objects: [] });
    expect(res.status).toBe(400);
    await request(app).delete(`/api/floors/${floorId}/draft`).set(auth(tokens.ownerA));
  });
});
