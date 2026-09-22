#!/usr/bin/env node
// Seeds the fixture that deploy/render-discount-screens.mjs drives through a
// browser: two tenants, two branches, a manager in each, a cashier in each.
//
// It is the SAME shape as backend/tests/discountSettings.test.js on purpose.
// The suite proves the rules hold when supertest asks; this seed exists so a
// real browser can be pointed at the same situation and the answer compared.
//
// WIPES the database it is given. It refuses any DATABASE_URL whose name does
// not end in _test, for the same reason the test files do — that suffix is the
// only thing standing between this script and somebody's real till.
//
//   DATABASE_URL=postgresql://.../atc_pos_discounts_test node deploy/seed-discount-render.mjs
//
// Prints the fixture's ids and emails. The password is read from
// RENDER_PASSWORD and is never printed.

// Reads its own settings out of a mode-600 file rather than taking them on the
// command line. A password in argv is visible to every other process on the
// box via ps, and ends up in shell history; this way the only copy is the file.
import { readFileSync } from 'node:fs';

const ENV_FILE = process.env.RENDER_ENV_FILE || '/tmp/discount-render.env';
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^export ([A-Z_]+)='(.*)'$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
} catch {
  console.error(`FAIL: cannot read ${ENV_FILE}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(url)) {
  console.error('FAIL: seed-discount-render requires a DATABASE_URL ending in _test');
  process.exit(1);
}
const PW = process.env.RENDER_PASSWORD;
if (!PW || PW.length < 8) {
  console.error('FAIL: export RENDER_PASSWORD (>=8 chars) before seeding');
  process.exit(1);
}

const { prisma } = await import('../backend/src/lib/prisma.js');
const { hashPassword } = await import('../backend/src/lib/crypto.js');

const wipe = async () => {
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
  // RESTRICT foreign keys: policies go before the rows they point at.
  await prisma.discountPolicy.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.company.deleteMany();
};

await wipe();

const passwordHash = await hashPassword(PW);
const inAYear = new Date(Date.now() + 365 * 86400e3);

const fox = await prisma.company.create({
  data: {
    name: 'Foxtrot Foods',
    slug: 'foxtrot-foods',
    licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inAYear } },
  },
});
const golf = await prisma.company.create({
  data: {
    name: 'Golf Grill',
    slug: 'golf-grill',
    licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inAYear } },
  },
});

const f1 = await prisma.branch.create({ data: { companyId: fox.id, name: 'Foxtrot One', code: 'F1' } });
const f2 = await prisma.branch.create({ data: { companyId: fox.id, name: 'Foxtrot Two', code: 'F2' } });
await prisma.branch.create({ data: { companyId: golf.id, name: 'Golf One', code: 'G1' } });

const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });

const ownerF = await mk({
  email: 'owner.f@test.local', fullName: 'Owner F', role: 'CUSTOMER_OWNER', companyId: fox.id,
});
// A manager in EACH branch. mgrF2 is the cross-branch case: a real manager,
// with a real approval ceiling, who is simply not at the till that is asking.
const mgrF1 = await mk({
  email: 'mgr.f1@test.local', fullName: 'Manager F1', role: 'BRANCH_MANAGER', companyId: fox.id, branchId: f1.id,
});
const mgrF2 = await mk({
  email: 'mgr.f2@test.local', fullName: 'Manager F2', role: 'BRANCH_MANAGER', companyId: fox.id, branchId: f2.id,
});
const cashierF1 = await mk({
  email: 'cashier.f1@test.local', fullName: 'Cashier F1', role: 'CASHIER', companyId: fox.id, branchId: f1.id,
});
await mk({
  email: 'cashier.f2@test.local', fullName: 'Cashier F2', role: 'CASHIER', companyId: fox.id, branchId: f2.id,
});
await mk({ email: 'owner.g@test.local', fullName: 'Owner G', role: 'CUSTOMER_OWNER', companyId: golf.id });

const tax = await prisma.taxRate.create({
  data: { companyId: fox.id, name: 'GST 5', ratePercent: '5.000' },
});
const cat = await prisma.category.create({ data: { companyId: fox.id, name: 'Drinks' } });
const coffee = await prisma.product.create({
  data: {
    companyId: fox.id, categoryId: cat.id, taxRateId: tax.id,
    name: 'Filter Coffee', basePrice: '500.00',
  },
});
await prisma.product.create({
  data: {
    companyId: fox.id, categoryId: cat.id, taxRateId: tax.id,
    name: 'Masala Chai', basePrice: '120.00',
  },
});
await prisma.diningTable.create({ data: { companyId: fox.id, branchId: f1.id, name: 'T1' } });

// NOTHING is configured. The render run starts from the state a company is in
// on the day it is handed the product: no company default, no branch override,
// no staff grant, every cashier at zero. The browser then types the policy in.
const policies = await prisma.discountPolicy.count();

console.log(JSON.stringify({
  companyFox: fox.id,
  branchF1: f1.id,
  branchF2: f2.id,
  ownerF: ownerF.id,
  mgrF1: mgrF1.id,
  mgrF2: mgrF2.id,
  cashierF1: cashierF1.id,
  coffee: coffee.id,
  policiesAtStart: policies,
}, null, 2));
console.log('PASS seed: fixture ready, 0 discount policies configured');

await prisma.$disconnect();
