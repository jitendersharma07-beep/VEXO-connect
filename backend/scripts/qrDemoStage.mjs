// Stages the table-QR demo on a LOCAL dev database, and prints the scan URLs.
//
// This is a demo fixture, not a seed: it builds one small restaurant with a
// published floor plan, a real menu and printed cards, so the guest flow can be
// driven in an actual mobile browser. It refuses to run against anything but a
// database named vcx_floorplan, because the whole point of staging data is that
// it is not somebody's real service.
//
//   node scripts/qrDemoStage.mjs
//
// Re-runnable: it removes its own company first and rebuilds, so a broken demo
// is fixed by running it again rather than by hand-editing rows.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const envPath = join(homedir(), 'vcx-floorplan-local', '.env');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!/\/vcx_floorplan(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('qrDemoStage refuses to run outside the vcx_floorplan dev database');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { default: supertest } = await import('supertest');

const app = supertest(createApp());
const PW = process.env.QR_DEMO_PASSWORD ?? 'demo-password-1';
const SLUG = 'vexo-qr-demo';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const ok = (res, what, want) => {
  if (res.status !== want) {
    throw new Error(`${what}: expected ${want}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
};

// --- clear the previous run -------------------------------------------------

// Only ever this demo's own company, found by its slug. Every delete below is
// filtered to ids reached from that one row, so re-running cannot touch anything
// else that happens to be in the dev database. The ids are collected up front
// because the scoping column differs per model — Floor hangs off Branch, Kot off
// Order — and a sweep that assumed companyId everywhere would silently skip rows
// and then fail on a RESTRICT key half way through.
const prior = await prisma.company.findUnique({ where: { slug: SLUG } });
if (prior) {
  const c = { companyId: prior.id };
  const idsOf = async (model, where) =>
    (await prisma[model].findMany({ where, select: { id: true } })).map((r) => r.id);
  const only = (ids) => ({ in: ids });

  const branchIds = await idsOf('branch', c);
  const floorIds = await idsOf('floor', { branchId: only(branchIds) });
  const layoutIds = await idsOf('floorLayout', { floorId: only(floorIds) });
  const orderIds = await idsOf('order', c);
  const itemIds = await idsOf('orderItem', { orderId: only(orderIds) });
  const visitIds = await idsOf('diningVisit', c);
  const productIds = await idsOf('product', c);
  const groupIds = await idsOf('modifierGroup', { productId: only(productIds) });
  const userIds = await idsOf('posUser', c);
  const licenseIds = await idsOf('license', c);

  await prisma.floorLayoutTable.deleteMany({ where: { layoutId: only(layoutIds) } });
  await prisma.floorLayoutObject.deleteMany({ where: { layoutId: only(layoutIds) } });
  await prisma.floorLayout.deleteMany({ where: { id: only(layoutIds) } });
  await prisma.diningArea.deleteMany({ where: { floorId: only(floorIds) } });
  await prisma.floor.deleteMany({ where: { id: only(floorIds) } });
  await prisma.kitchenItem.deleteMany({ where: c });
  await prisma.kitchenRoute.deleteMany({ where: c });
  await prisma.kitchenStation.deleteMany({ where: c });
  await prisma.payment.deleteMany({ where: { orderId: only(orderIds) } });
  await prisma.orderItemModifier.deleteMany({ where: { orderItemId: only(itemIds) } });
  await prisma.orderItem.deleteMany({ where: { id: only(itemIds) } });
  await prisma.kot.deleteMany({ where: { orderId: only(orderIds) } });
  // Order and QrSubmission point at each other in opposite directions and every
  // QR key is ON DELETE RESTRICT, so the order of these five is load-bearing.
  await prisma.qrSubmission.deleteMany({ where: c });
  await prisma.order.deleteMany({ where: { id: only(orderIds) } });
  await prisma.diningVisitGuest.deleteMany({ where: { visitId: only(visitIds) } });
  await prisma.diningVisit.deleteMany({ where: { id: only(visitIds) } });
  await prisma.tableQrCode.deleteMany({ where: c });
  await prisma.invoiceCounter.deleteMany({ where: { branchId: only(branchIds) } });
  await prisma.modifierOption.deleteMany({ where: { groupId: only(groupIds) } });
  await prisma.modifierGroup.deleteMany({ where: { id: only(groupIds) } });
  await prisma.productVariant.deleteMany({ where: { productId: only(productIds) } });
  await prisma.product.deleteMany({ where: { id: only(productIds) } });
  await prisma.category.deleteMany({ where: c });
  await prisma.taxRate.deleteMany({ where: c });
  await prisma.diningTable.deleteMany({ where: { branchId: only(branchIds) } });
  await prisma.posAuditLog.deleteMany({ where: c });
  await prisma.posSession.deleteMany({ where: { userId: only(userIds) } });
  await prisma.discountPolicy.deleteMany({ where: c });
  await prisma.licenseAddon.deleteMany({ where: { licenseId: only(licenseIds) } });
  await prisma.license.deleteMany({ where: { id: only(licenseIds) } });
  await prisma.posUser.deleteMany({ where: { id: only(userIds) } });
  await prisma.branch.deleteMany({ where: { id: only(branchIds) } });
  await prisma.company.delete({ where: { id: prior.id } });
}

// --- the restaurant ---------------------------------------------------------

const passwordHash = await hashPassword(PW);

const company = await prisma.company.create({
  data: {
    name: 'Saffron Grill',
    slug: SLUG,
    licenses: {
      create: {
        plan: 'MULTI_STORE',
        baseBranchLimit: 3,
        expiresAt: new Date(Date.now() + 365 * 86400e3),
      },
    },
  },
});

// Two stores, and "T1" exists in both. A card must resolve to its own store, so
// the demo cannot accidentally pass by having only one candidate.
const stores = {};
for (const [key, spec] of Object.entries({
  cp: { publicId: 'VC-DM-0001', name: 'Saffron Grill — Connaught Place', code: 'CP', city: 'Delhi' },
  kor: { publicId: 'VC-DM-0002', name: 'Saffron Grill — Koramangala', code: 'KOR', city: 'Bengaluru' },
})) {
  stores[key] = await prisma.branch.create({ data: { companyId: company.id, ...spec } });
}

const tables = {};
for (const [key, spec] of Object.entries({
  cpT1: { branch: 'cp', name: 'T1', capacity: 4 },
  cpT2: { branch: 'cp', name: 'T2', capacity: 2 },
  cpT3: { branch: 'cp', name: 'T3', capacity: 6 },
  cpP1: { branch: 'cp', name: 'P1', capacity: 4 },
  korT1: { branch: 'kor', name: 'T1', capacity: 4 },
})) {
  tables[key] = await prisma.diningTable.create({
    data: { branchId: stores[spec.branch].id, name: spec.name, capacity: spec.capacity },
  });
}

const users = {
  owner: { email: 'owner@saffron.demo', fullName: 'Rhea Kapoor', role: 'CUSTOMER_OWNER' },
  manager: { email: 'manager@saffron.demo', fullName: 'Imran Shah', role: 'BRANCH_MANAGER', branch: 'cp' },
  cashier: { email: 'cashier@saffron.demo', fullName: 'Divya Rao', role: 'CASHIER', branch: 'cp' },
};
for (const u of Object.values(users)) {
  await prisma.posUser.create({
    data: {
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      companyId: company.id,
      ...(u.branch ? { branchId: stores[u.branch].id } : {}),
      passwordHash,
    },
  });
}

const login = async (email) => {
  const body = ok(
    await app.post('/api/auth/login').send({ email, password: PW }),
    `login ${email}`,
    200,
  );
  return body.token;
};
const ownerToken = await login(users.owner.email);

// --- the menu ---------------------------------------------------------------

const gst5 = await prisma.taxRate.create({
  data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.000' },
});
const gst18 = await prisma.taxRate.create({
  data: { companyId: company.id, name: 'GST 18%', ratePercent: '18.000' },
});

const menu = [
  {
    category: 'Starters',
    products: [
      { name: 'Paneer Tikka', price: '280.00', tax: gst5 },
      {
        name: 'Chicken 65',
        price: '320.00',
        tax: gst5,
        groups: [
          { name: 'Heat', minSelect: 1, maxSelect: 1, options: [['Mild', '0.00'], ['Medium', '0.00'], ['Fiery', '0.00']] },
        ],
      },
    ],
  },
  {
    category: 'Biryani',
    products: [
      {
        name: 'Hyderabadi Dum Biryani',
        price: '340.00',
        tax: gst5,
        variants: [['Half', '340.00'], ['Full', '520.00']],
        groups: [
          { name: 'Add on', minSelect: 0, maxSelect: 3, options: [['Extra raita', '40.00'], ['Boiled egg', '30.00'], ['Mirchi ka salan', '50.00']] },
        ],
      },
      { name: 'Veg Biryani', price: '290.00', tax: gst5 },
    ],
  },
  {
    category: 'Drinks',
    products: [
      { name: 'Masala Chaas', price: '90.00', tax: gst5 },
      { name: 'Cold Coffee', price: '180.00', tax: gst18 },
    ],
  },
];

let sortOrder = 0;
for (const section of menu) {
  const category = await prisma.category.create({
    data: { companyId: company.id, name: section.category, sortOrder: (sortOrder += 1) },
  });
  for (const p of section.products) {
    const product = await prisma.product.create({
      data: {
        companyId: company.id,
        categoryId: category.id,
        name: p.name,
        basePrice: p.price,
        taxRateId: p.tax.id,
      },
    });
    for (const [name, price] of p.variants ?? []) {
      await prisma.productVariant.create({ data: { productId: product.id, name, price } });
    }
    for (const g of p.groups ?? []) {
      const group = await prisma.modifierGroup.create({
        data: { productId: product.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect },
      });
      for (const [name, price] of g.options) {
        await prisma.modifierOption.create({ data: { groupId: group.id, name, price } });
      }
    }
  }
}

// --- the floor plan ---------------------------------------------------------

// Built through the real API so the cards carry a genuine floor/section line
// rather than one written straight into the database.
const floor = ok(
  await app.post('/api/floors').set(auth(ownerToken)).send({ name: 'Ground Floor', branchId: stores.cp.id }),
  'create floor',
  201,
).floor;

const indoor = ok(
  await app.post(`/api/floors/${floor.id}/areas`).set(auth(ownerToken)).send({ name: 'Window Row', kind: 'INDOOR' }),
  'create indoor area',
  201,
).area;
const outdoor = ok(
  await app.post(`/api/floors/${floor.id}/areas`).set(auth(ownerToken)).send({ name: 'Terrace', kind: 'OUTDOOR' }),
  'create outdoor area',
  201,
).area;

const draft = ok(
  await app.post(`/api/floors/${floor.id}/draft`).set(auth(ownerToken)).send({}),
  'open draft',
  201,
).layout;

const placed = ok(
  await app
    .put(`/api/floors/${floor.id}/draft`)
    .set(auth(ownerToken))
    .send({
      revision: draft.revision,
      tables: [
        { tableId: tables.cpT1.id, areaId: indoor.id, shape: 'SQUARE', x: 40, y: 40, width: 80, height: 80, rotation: 0 },
        { tableId: tables.cpT2.id, areaId: indoor.id, shape: 'ROUND', x: 160, y: 40, width: 80, height: 80, rotation: 0 },
        { tableId: tables.cpT3.id, areaId: indoor.id, shape: 'RECT', x: 40, y: 160, width: 160, height: 80, rotation: 0 },
        { tableId: tables.cpP1.id, areaId: outdoor.id, shape: 'ROUND', x: 260, y: 40, width: 80, height: 80, rotation: 0 },
      ],
      objects: [],
    }),
  'save draft',
  200,
).layout;

ok(
  await app.post(`/api/floors/${floor.id}/draft/publish`).set(auth(ownerToken)).send({ revision: placed.revision }),
  'publish layout',
  200,
);

// --- the cards --------------------------------------------------------------

const issuedCp = ok(
  await app.post('/api/table-qr/issue').set(auth(ownerToken)).send({ branchId: stores.cp.id }),
  'issue CP cards',
  201,
);
const issuedKor = ok(
  await app.post('/api/table-qr/issue').set(auth(ownerToken)).send({ branchId: stores.kor.id }),
  'issue KOR cards',
  201,
);

const all = await prisma.tableQrCode.findMany({
  where: { companyId: company.id, status: 'ACTIVE' },
  include: { branch: { select: { name: true } }, table: { select: { name: true } } },
  orderBy: [{ branchId: 'asc' }, { id: 'asc' }],
});

const report = {
  company: company.name,
  stores: Object.values(stores).map((b) => ({ id: b.id, name: b.name, city: b.city })),
  staff: Object.values(users).map((u) => ({ email: u.email, role: u.role })),
  password: PW,
  issued: { cp: issuedCp.summary, kor: issuedKor.summary },
  cards: all.map((c) => ({
    store: c.branch.name,
    table: c.table.name,
    url: `${process.env.POS_QR_BASE_URL.replace(/\/+$/, '')}/t/${c.token}`,
  })),
};
// Handed to scripts/qrDemoBrowser.mjs, which drives these exact cards in a real
// phone-sized Chromium rather than being told a token by hand.
mkdirSync('/tmp/qr-demo', { recursive: true });
writeFileSync('/tmp/qr-demo/cards.json', `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
