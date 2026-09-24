// Generates docs fixtures for VC-104 W2 by calling the REAL API, so the shapes
// cannot drift from the server the way hand-written examples do.
//
// Writes backend/tests/fixtures/vc104/*.json. Requires a DATABASE_URL ending in
// _test — it truncates.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('vc104-fixtures.mjs requires a DATABASE_URL ending in _test');
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'vc104');
mkdirSync(OUT, { recursive: true });

const write = (name, body) => {
  writeFileSync(join(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`  ${name}`);
};

const PW = 'Str0ng-Passw0rd!';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const wipe = async () => {
  for (const t of [
    'phoneOrderEvent', 'phoneOrder', 'customerAddress', 'customer',
    'branchServiceArea', 'branchHours', 'branchPrepCapacity',
    'dayClose', 'refund', 'payment', 'gatewayWebhookEvent', 'paymentIntent',
    'orderItem', 'kot', 'order', 'invoiceCounter', 'productVariant', 'product',
    'category', 'taxRate', 'diningTable', 'posAuditLog', 'posSession',
    'licenseAddon', 'license', 'discountPolicy', 'posUser', 'branch', 'company',
  ]) await prisma[t].deleteMany();
};

console.log('VC-104 fixture generation');
await wipe();

const passwordHash = await hashPassword(PW);
const future = new Date(Date.now() + 86400e3);

const company = await prisma.company.create({
  data: { name: 'Demo Coffee', slug: 'demo-coffee', licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 4, expiresAt: future } } },
});
const cp = await prisma.branch.create({ data: { companyId: company.id, publicId: 'VC-DM-0001', name: 'Church Street', code: 'CP' } });
const ind = await prisma.branch.create({ data: { companyId: company.id, publicId: 'VC-DM-0002', name: 'Indiranagar', code: 'IN' } });
const kor = await prisma.branch.create({ data: { companyId: company.id, publicId: 'VC-DM-0003', name: 'Koramangala', code: 'KR' } });
const clo = await prisma.branch.create({ data: { companyId: company.id, publicId: 'VC-DM-0004', name: 'Whitefield', code: 'WF', status: 'CLOSED' } });

await prisma.posUser.create({ data: { email: 'owner@demo.local', fullName: 'Priya N', role: 'CUSTOMER_OWNER', companyId: company.id, passwordHash } });
await prisma.posUser.create({ data: { email: 'mgr@demo.local', fullName: 'Ravi K', role: 'BRANCH_MANAGER', companyId: company.id, branchId: cp.id, passwordHash } });

const login = async (email) => {
  const r = await request(app).post('/api/auth/login').send({ email, password: PW });
  if (r.status !== 200) throw new Error(`login ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
};
const owner = await login('owner@demo.local');
const mgr = await login('mgr@demo.local');

const tax = await prisma.taxRate.create({ data: { companyId: company.id, name: 'GST 5%', ratePercent: '5.000' } });
const cat = await prisma.category.create({ data: { companyId: company.id, name: 'Coffee' } });
const capp = await prisma.product.create({ data: { companyId: company.id, categoryId: cat.id, name: 'Cappuccino', basePrice: '200.00', taxRateId: tax.id } });
const croi = await prisma.product.create({ data: { companyId: company.id, categoryId: cat.id, name: 'Croissant', basePrice: '120.00', taxRateId: tax.id } });

const hours = (branchId, opensMinute, closesMinute, closedDays = []) =>
  prisma.branchHours.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      companyId: company.id, branchId, dayOfWeek: d, opensMinute, closesMinute,
      closed: closedDays.includes(d),
    })),
  });
await hours(cp.id, 9 * 60, 23 * 60);
await hours(ind.id, 11 * 60, 22 * 60);
await hours(kor.id, 9 * 60, 23 * 60);
await hours(clo.id, 9 * 60, 23 * 60);

await prisma.branchServiceArea.createMany({
  data: [
    { companyId: company.id, branchId: cp.id, pincode: '560001', deliveryCharge: '40.00', minOrder: '200.00' },
    { companyId: company.id, branchId: kor.id, pincode: '560001', deliveryCharge: '55.00', minOrder: '1000.00' },
  ],
});
// Koramangala is deliberately full for the slot the branch-options fixture asks
// about, so AT_CAPACITY appears in the sample alongside BELOW_MIN_ORDER.
await prisma.branchPrepCapacity.create({ data: { companyId: company.id, branchId: kor.id, slotMinutes: 15, maxOrdersPerSlot: 1 } });

const anita = await prisma.customer.create({ data: { companyId: company.id, name: 'Anita Rao', phone: '+919876500011', createdById: null } });
await prisma.customer.create({ data: { companyId: company.id, name: 'Dev Menon', phone: '+919876500012' } });
await prisma.customer.create({ data: { companyId: company.id, name: 'Anita Sharma', phone: '+919876500013' } });

const home = await prisma.customerAddress.create({ data: { companyId: company.id, customerId: anita.id, label: 'Home', line1: '12 Church St', landmark: 'opp. bakery', city: 'Bengaluru', pincode: '560001', isDefault: true } });
await prisma.customerAddress.create({ data: { companyId: company.id, customerId: anita.id, label: 'Old flat', line1: '4 Residency Rd', city: 'Bengaluru', pincode: '560025', archivedAt: new Date() } });

const slot = new Date(Date.now() + 3600e3);

// Fill Koramangala's slot.
await request(app).post('/api/phone-orders').set(auth(owner)).send({
  idempotencyKey: 'fixture-filler-0001', customerId: anita.id, addressId: home.id,
  fulfilment: 'DELIVERY', branchId: kor.id, scheduledFor: slot.toISOString(),
  items: [{ productId: capp.id, qty: 10 }],
});

write('customers.search.json', (await request(app).get('/api/phone-orders/customers?q=Ani').set(auth(owner))).body);
write('branch-options.json', (await request(app).post('/api/phone-orders/branch-options').set(auth(owner)).send({
  fulfilment: 'DELIVERY', addressId: home.id, scheduledFor: slot.toISOString(),
  items: [{ productId: capp.id, qty: 1 }],
})).body);

const submitBody = {
  idempotencyKey: 'po-3f9c1a2b-7d4e', customerId: anita.id, addressId: home.id,
  fulfilment: 'DELIVERY', branchId: cp.id, note: 'ring the bell twice',
  items: [{ productId: capp.id, qty: 2 }, { productId: croi.id, qty: 1 }],
};
const created = await request(app).post('/api/phone-orders').set(auth(owner)).send(submitBody);
write('submit.201.json', created.body);
write('submit.replay.200.json', (await request(app).post('/api/phone-orders').set(auth(owner)).send(submitBody)).body);
write('submit.409.idempotency.json', (await request(app).post('/api/phone-orders').set(auth(owner))
  .send({ ...submitBody, items: [{ productId: capp.id, qty: 9 }] })).body);
write('submit.409.unserviceable.json', (await request(app).post('/api/phone-orders').set(auth(owner))
  .send({ ...submitBody, idempotencyKey: 'po-unserviceable-1', branchId: ind.id })).body);

const poId = created.body.phoneOrder.id;
write('accept.200.json', (await request(app).post(`/api/phone-orders/${poId}/accept`).set(auth(mgr)).send({})).body);
write('accept.409.json', (await request(app).post(`/api/phone-orders/${poId}/accept`).set(auth(mgr)).send({})).body);

// A second order to show reassignment recomputing against a different store.
const forMove = await request(app).post('/api/phone-orders').set(auth(owner)).send({
  ...submitBody, idempotencyKey: 'po-for-reassign-1',
});
write('reassign.200.json', (await request(app).post(`/api/phone-orders/${forMove.body.phoneOrder.id}/reassign`)
  .set(auth(owner)).send({ branchId: kor.id, reason: 'Church Street rejected' })).body);

// A SUBMITTED order carrying an issued invoice. It has to be an undecided one:
// on an already-accepted order the status guard answers first and the fixture
// would document the wrong refusal.
const billed = await request(app).post('/api/phone-orders').set(auth(owner)).send({
  ...submitBody, idempotencyKey: 'po-billed-1',
});
await prisma.order.update({
  where: { id: billed.body.phoneOrder.order.id },
  data: { invoiceNumber: 'CP/26-27/00001', status: 'BILLED', billedAt: new Date() },
});
write('reassign.409.invoice.json', (await request(app).post(`/api/phone-orders/${billed.body.phoneOrder.id}/reassign`)
  .set(auth(owner)).send({ branchId: ind.id, reason: 'must be refused' })).body);

write('customer.detail.json', (await request(app).get(`/api/phone-orders/customers/${anita.id}`).set(auth(owner))).body);
write('phone-orders.list.json', (await request(app).get('/api/phone-orders').set(auth(owner))).body);

await wipe();
await prisma.$disconnect();
console.log('done');
