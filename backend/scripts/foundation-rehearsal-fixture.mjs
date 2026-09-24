// Foundation lane — backfill REHEARSAL fixture. DEV/LAB DATABASE ONLY.
//
// Builds the kind of database the foundation migrations will meet in the
// field: several tenants, several stores each (one of them closed), orders
// that were billed, paid in one tender and in two, refunded, voided, and day
// closes filed. It runs at the BASE schema (38856d3) — before any foundation
// migration exists — so the migrations are rehearsed against rows written by
// the code that really wrote them, not by the new code pretending.
//
// Every write goes through the real API in-process (createApp + supertest),
// the same code paths a till uses, except the tenant bootstrap (company,
// licence, users, catalog), which has no customer-facing API and is written
// the way the VEXO console and seed write it.
//
// Refuses to run unless FOUNDATION_REHEARSAL=1 and the database name is a
// vcx_foundation* lab database. The login password is random per run and never
// leaves this process.

import { randomBytes } from 'node:crypto';

const dbUrl = process.env.DATABASE_URL || '';
if (process.env.FOUNDATION_REHEARSAL !== '1' || !/\/vcx_foundation[a-z_]*\?/.test(dbUrl)) {
  console.error('Refusing: set FOUNDATION_REHEARSAL=1 and point DATABASE_URL at a vcx_foundation lab database.');
  process.exit(2);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing: NODE_ENV=production.');
  process.exit(2);
}

const { default: request } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const app = createApp();
const PW = randomBytes(12).toString('base64url');
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const must = (res, what, status = [200, 201]) => {
  const ok = Array.isArray(status) ? status.includes(res.status) : res.status === status;
  if (!ok) throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

const login = async (email) =>
  must(await request(app).post('/api/auth/login').send({ email, password: PW }), `login ${email}`).token;

// One tenant, bootstrapped the way the VEXO console does it.
const makeTenant = async ({ slug, name, state, branches }) => {
  const company = await prisma.company.create({
    data: {
      name,
      slug,
      state,
      licenses: {
        create: { plan: 'MULTI_STORE', baseBranchLimit: 5, expiresAt: new Date(Date.now() + 365 * 86400e3) },
      },
    },
  });
  const passwordHash = await hashPassword(PW);
  const made = [];
  for (const b of branches) {
    made.push(
      await prisma.branch.create({
        data: { companyId: company.id, name: b.name, code: b.code, state: b.state, city: b.city, status: b.status ?? 'ACTIVE' },
      }),
    );
  }
  const owner = await prisma.posUser.create({
    data: { email: `owner@${slug}.rehearsal`, fullName: `${name} Owner`, role: 'CUSTOMER_OWNER', companyId: company.id, passwordHash },
  });
  const managers = [];
  for (const br of made) {
    managers.push(
      await prisma.posUser.create({
        data: { email: `manager.${br.code.toLowerCase()}@${slug}.rehearsal`, fullName: `Manager ${br.code}`, role: 'BRANCH_MANAGER', companyId: company.id, branchId: br.id, passwordHash },
      }),
    );
    await prisma.posUser.create({
      data: { email: `cashier.${br.code.toLowerCase()}@${slug}.rehearsal`, fullName: `Cashier ${br.code}`, role: 'CASHIER', companyId: company.id, branchId: br.id, passwordHash },
    });
  }
  const gst5 = await prisma.taxRate.create({ data: { companyId: company.id, name: 'GST 5%', ratePercent: 5 } });
  const cat = await prisma.category.create({ data: { companyId: company.id, name: 'Menu' } });
  const products = [];
  for (const [sku, pname, price] of [['TEA', 'Tea', 60], ['SAM', 'Samosa', 45], ['THA', 'Thali', 240]]) {
    products.push(
      await prisma.product.create({
        data: { companyId: company.id, categoryId: cat.id, sku, name: pname, basePrice: price, taxRateId: gst5.id },
      }),
    );
  }
  return { company, branches: made, owner, managers, products };
};

// A day's trading at one store, through the real routes.
const tradeAt = async ({ branch, cashierToken, managerToken, products }) => {
  const mk = async (items) =>
    must(
      await request(app).post('/api/orders').set(auth(cashierToken)).send({ type: 'TAKEAWAY', items }),
      `create order at ${branch.code}`,
    ).order;
  const bill = async (o) => must(await request(app).post(`/api/orders/${o.id}/bill`).set(auth(cashierToken)), 'bill').order;
  const pay = async (o, body) =>
    must(await request(app).post(`/api/orders/${o.id}/payments`).set(auth(cashierToken)).send(body), 'pay').order;

  const [tea, samosa, thali] = products;
  // 1. cash, tendered with change
  let o = await bill(await mk([{ productId: tea.id, qty: 2 }, { productId: samosa.id, qty: 1 }]));
  await pay(o, { method: 'CASH', tendered: 500, idempotencyKey: `reh-${o.id}-1` });
  // 2. card
  o = await bill(await mk([{ productId: thali.id, qty: 1 }]));
  await pay(o, { method: 'CARD', amount: o.total, idempotencyKey: `reh-${o.id}-1` });
  // 3. split cash + UPI, then a partial cash refund by the manager
  o = await bill(await mk([{ productId: thali.id, qty: 2 }, { productId: tea.id, qty: 1 }]));
  const half = Math.round((o.total / 2) * 100) / 100;
  await pay(o, { method: 'UPI', amount: half, idempotencyKey: `reh-${o.id}-1` });
  o = await pay(o, { method: 'CASH', amount: Math.round((o.total - half) * 100) / 100, idempotencyKey: `reh-${o.id}-2` });
  must(
    await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(managerToken)).send({ amount: 20, reason: 'Cold food complaint', method: 'CASH' }),
    'partial refund',
  );
  // 4. full refund → REFUNDED
  o = await bill(await mk([{ productId: samosa.id, qty: 2 }]));
  o = await pay(o, { method: 'CASH', amount: o.total, idempotencyKey: `reh-${o.id}-1` });
  must(
    await request(app).post(`/api/orders/${o.id}/refunds`).set(auth(managerToken)).send({ amount: o.total, reason: 'Order cancelled by guest', method: 'CASH' }),
    'full refund',
  );
  // 5. billed, left unpaid (a tab still open at close)
  await bill(await mk([{ productId: tea.id, qty: 3 }]));
  // 6. opened then voided
  o = await mk([{ productId: samosa.id, qty: 1 }]);
  must(await request(app).post(`/api/orders/${o.id}/void`).set(auth(managerToken)).send({ reason: 'Keyed in error' }), 'void');

  // Day close at the real expected figure, so no variance note is needed.
  const preview = must(
    await request(app).get('/api/reports/day-close/preview').set(auth(managerToken)),
    'day-close preview',
  ).preview;
  must(
    await request(app).post('/api/reports/day-close').set(auth(managerToken)).send({ countedCash: preview.expectedCash }),
    'day close',
  );
};

const tenants = [
  {
    slug: 'rehearsal-alpha',
    name: 'Rehearsal Alpha Foods',
    state: 'Delhi',
    branches: [
      { name: 'Alpha Karol Bagh', code: 'AKB', state: 'Delhi', city: 'New Delhi' },
      { name: 'Alpha Noida 18', code: 'AN18', state: 'Uttar Pradesh', city: 'Noida' },
      { name: 'Alpha Old Mall', code: 'AOLD', state: 'Delhi', city: 'New Delhi', status: 'CLOSED' },
    ],
  },
  {
    slug: 'rehearsal-bravo',
    name: 'Rehearsal Bravo Kitchens',
    state: 'Karnataka',
    branches: [{ name: 'Bravo Indiranagar', code: 'BIN', state: 'Karnataka', city: 'Bengaluru' }],
  },
];

for (const t of tenants) {
  const made = await makeTenant(t);
  for (const [i, br] of made.branches.entries()) {
    if (br.status !== 'ACTIVE') continue;
    const cashierToken = await login(`cashier.${br.code.toLowerCase()}@${t.slug}.rehearsal`);
    const managerToken = await login(made.managers[i].email);
    await tradeAt({ branch: br, cashierToken, managerToken, products: made.products });
  }
  console.log(`tenant ${t.slug}: ${made.branches.length} stores, trading done`);
}

const counts = {
  companies: await prisma.company.count(),
  branches: await prisma.branch.count(),
  orders: await prisma.order.count(),
  payments: await prisma.payment.count(),
  refunds: await prisma.refund.count(),
  dayCloses: await prisma.dayClose.count(),
  users: await prisma.posUser.count(),
};
console.log('rehearsal fixture complete', JSON.stringify(counts));
await prisma.$disconnect();
