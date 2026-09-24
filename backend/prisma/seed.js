// Seeds the ATC POS foundation:
//   1. one ATC platform operator (POS_SUPER_ADMIN)
//   2. one clearly-marked DEMO company with two sample café branches
// Idempotent — safe to re-run; existing rows are kept, passwords are NOT reset
// unless POS_SEED_RESET_PASSWORDS=true.
//
// No credential lives in this file or in git. Passwords come from the
// environment (POS_SEED_*_PASSWORD) or are generated per-run and printed once
// to stdout for the operator to record.

import { PrismaClient } from '@prisma/client';
import { hash as argon2Hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { mintStorePublicId } from '../src/lib/identity.js';

const prisma = new PrismaClient();

const genPassword = () => randomBytes(9).toString('base64url');
const resetPasswords = process.env.POS_SEED_RESET_PASSWORDS === 'true';

// POS_SEED_ALLOW_FIXED_PASSWORDS lets env-provided passwords skip the forced
// first-login change — for the fixed, documented DEV logins only. Refused
// outright in production so a prod seed can never mint accounts that skip the
// forced change; a prod rotation via env passwords still forces it.
const allowFixedPasswords = process.env.POS_SEED_ALLOW_FIXED_PASSWORDS === 'true';
if (allowFixedPasswords && process.env.NODE_ENV === 'production') {
  console.error('POS_SEED_ALLOW_FIXED_PASSWORDS is dev/test-only; refusing to run with NODE_ENV=production.');
  process.exit(1);
}

// A typo here mints an operator nobody can sign in as and no API can delete,
// so the address is checked before it reaches the database.
const platformAdminEmail = () => {
  const raw = process.env.POS_SEED_ADMIN_EMAIL?.trim().toLowerCase();
  if (!raw) return 'pos.admin@atcinfocom.in';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    console.error(`POS_SEED_ADMIN_EMAIL is not a valid email address: ${raw}`);
    process.exit(1);
  }
  return raw;
};

const issued = [];

const ensureUser = async ({ email, fullName, role, companyId = null, branchId = null, passwordEnv }) => {
  const existing = await prisma.posUser.findUnique({ where: { email } });
  if (existing && !resetPasswords) {
    issued.push({ email, role, password: '(unchanged)' });
    return existing;
  }
  // Forced first-login change is skipped ONLY when the password came from the
  // environment AND the explicit dev-only flag is set. Generated (print-once)
  // passwords and prod env rotations always force a change.
  const skipForcedChange = Boolean(process.env[passwordEnv]) && allowFixedPasswords;
  const password = process.env[passwordEnv] || genPassword();
  const passwordHash = await argon2Hash(password);
  const user = existing
    ? await prisma.posUser.update({ where: { email }, data: { passwordHash, mustChangePassword: !skipForcedChange } })
    : await prisma.posUser.create({
        data: { email, fullName, role, companyId, branchId, passwordHash, mustChangePassword: !skipForcedChange },
      });
  issued.push({ email, role, password });
  return user;
};

const main = async () => {
  // --- ATC platform operator -------------------------------------------------
  // This is the one account no API can mint: /api/users excludes
  // POS_SUPER_ADMIN from its assignable roles on purpose, and nothing under
  // /api/atc creates operators either. So the address has to be settable here,
  // or a deployment is stuck with the built-in name and can never hold a
  // second operator to fall back on if the first one is lost. Re-running with
  // a different POS_SEED_ADMIN_EMAIL adds one rather than replacing it.
  await ensureUser({
    email: platformAdminEmail(),
    fullName: process.env.POS_SEED_ADMIN_NAME?.trim() || 'ATC POS Platform Admin',
    role: 'POS_SUPER_ADMIN',
    passwordEnv: 'POS_SEED_ADMIN_PASSWORD',
  });

  // --- Demo tenant -----------------------------------------------------------
  const demo = await prisma.company.upsert({
    where: { slug: 'demo-brew-street' },
    update: {},
    create: {
      name: 'Brew Street Café (Demo)',
      slug: 'demo-brew-street',
      status: 'ACTIVE',
      isDemo: true,
      contactName: 'Demo Contact',
      contactEmail: 'demo@atcpos.example',
      city: 'New Delhi',
      state: 'Delhi',
    },
  });

  const cp = await prisma.branch.upsert({
    where: { companyId_code: { companyId: demo.id, code: 'BSC-CP' } },
    update: {},
    create: {
      companyId: demo.id,
      name: 'Brew Street Café — Connaught Place',
      code: 'BSC-CP',
      // Permanent store id, minted the same way the branches route mints it.
      // Required since 20260924100100 made Branch.publicId NOT NULL.
      publicId: await mintStorePublicId(prisma, { stateName: 'Delhi' }),
      isDemo: true,
      addressLine: 'Block A, Connaught Place (sample address)',
      city: 'New Delhi',
      state: 'Delhi',
    },
  });

  const ch = await prisma.branch.upsert({
    where: { companyId_code: { companyId: demo.id, code: 'BSC-CH' } },
    update: {},
    create: {
      companyId: demo.id,
      name: 'Brew Street Café — Cyber Hub',
      code: 'BSC-CH',
      publicId: await mintStorePublicId(prisma, { stateName: 'Haryana' }),
      isDemo: true,
      addressLine: 'DLF Cyber Hub (sample address)',
      city: 'Gurugram',
      state: 'Haryana',
    },
  });

  const existingLicense = await prisma.license.findFirst({ where: { companyId: demo.id } });
  if (!existingLicense) {
    await prisma.license.create({
      data: {
        companyId: demo.id,
        plan: 'FREE_TRIAL',
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        baseBranchLimit: 2,
        notes: 'Demo tenant — sample data only, not a commercial licence',
      },
    });
  }

  await ensureUser({
    email: 'demo.owner@atcpos.example',
    fullName: 'Demo Café Owner',
    role: 'CUSTOMER_OWNER',
    companyId: demo.id,
    passwordEnv: 'POS_SEED_OWNER_PASSWORD',
  });
  await ensureUser({
    email: 'demo.manager@atcpos.example',
    fullName: 'Demo Branch Manager',
    role: 'BRANCH_MANAGER',
    companyId: demo.id,
    branchId: cp.id,
    passwordEnv: 'POS_SEED_MANAGER_PASSWORD',
  });
  await ensureUser({
    email: 'demo.cashier@atcpos.example',
    fullName: 'Demo Cashier',
    role: 'CASHIER',
    companyId: demo.id,
    branchId: cp.id,
    passwordEnv: 'POS_SEED_CASHIER_PASSWORD',
  });

  // --- Demo catalog + tables (phase 2) --------------------------------------
  // Prices/taxes deliberately reproduce the worked example in
  // docs/PHASE2-CONTRACT.md §6, so the money-math can be checked by hand.
  const ensureTaxRate = async (name, ratePercent) => {
    const found = await prisma.taxRate.findFirst({ where: { companyId: demo.id, name } });
    return found || prisma.taxRate.create({ data: { companyId: demo.id, name, ratePercent } });
  };
  const gst5 = await ensureTaxRate('GST 5%', 5);
  const gst12 = await ensureTaxRate('GST 12%', 12);

  const ensureCategory = (name, sortOrder) =>
    prisma.category.upsert({
      where: { companyId_name: { companyId: demo.id, name } },
      update: { sortOrder },
      create: { companyId: demo.id, name, sortOrder },
    });
  const coffee = await ensureCategory('Coffee', 1);
  const food = await ensureCategory('Food', 2);
  const coldBrews = await ensureCategory('Cold Brews', 3);

  const ensureProduct = ({ sku, name, categoryId, basePrice, taxRateId }) =>
    prisma.product.upsert({
      where: { companyId_sku: { companyId: demo.id, sku } },
      update: {},
      create: { companyId: demo.id, sku, name, categoryId, basePrice, taxRateId },
    });
  await ensureProduct({ sku: 'CAP-01', name: 'Cappuccino', categoryId: coffee.id, basePrice: 180, taxRateId: gst5.id });
  await ensureProduct({ sku: 'ESP-01', name: 'Espresso', categoryId: coffee.id, basePrice: 140, taxRateId: gst5.id });
  await ensureProduct({ sku: 'CHA-01', name: 'Masala Chai', categoryId: coffee.id, basePrice: 90, taxRateId: gst5.id });
  await ensureProduct({ sku: 'SND-01', name: 'Veg Sandwich', categoryId: food.id, basePrice: 150, taxRateId: gst5.id });
  await ensureProduct({ sku: 'CRS-01', name: 'Butter Croissant', categoryId: food.id, basePrice: 120, taxRateId: gst5.id });
  const coldBrew = await ensureProduct({ sku: 'CBR-01', name: 'Cold Brew', categoryId: coldBrews.id, basePrice: 180, taxRateId: gst12.id });
  for (const [name, price] of [['Small', 180], ['Large', 220]]) {
    const existing = await prisma.productVariant.findFirst({ where: { productId: coldBrew.id, name } });
    if (!existing) await prisma.productVariant.create({ data: { productId: coldBrew.id, name, price } });
  }

  const ensureTable = (branchId, name, capacity) =>
    prisma.diningTable.upsert({
      where: { branchId_name: { branchId, name } },
      update: {},
      create: { branchId, name, capacity },
    });
  for (const [name, capacity] of [['T1', 2], ['T2', 2], ['T3', 4], ['T4', 4], ['T5', 6], ['T6', 2]]) {
    await ensureTable(cp.id, name, capacity);
  }
  for (const [name, capacity] of [['T1', 2], ['T2', 4], ['T3', 4], ['T4', 6]]) {
    await ensureTable(ch.id, name, capacity);
  }
  console.log('Demo catalog ready: 2 tax rates, 3 categories, 6 products (Cold Brew has variants), 10 tables.');

  // LANE vc104-api
  await seedPhoneOrderCentre(demo, cp, ch);

  console.log('\nATC POS seed complete. Credentials (record these now — not stored anywhere):');
  for (const { email, role, password } of issued) {
    console.log(`  ${role.padEnd(16)} ${email.padEnd(34)} ${password}`);
  }
  console.log('');
};

// ============================================================================
// ==== LANE vc104-api ====
// VC-104 phone-order centre demo data: opening hours, delivery serviceability,
// preparation capacity and two callers with addresses.
//
// Shaped so the three things worth demonstrating are actually reachable:
//   - 110001 is served by BOTH stores at different charges, so a reassignment
//     visibly changes the delivery quote instead of being a no-op
//   - Chandni Chowk is closed on Mondays, so CLOSED_AT_FULFILMENT has a real
//     case rather than needing a hand-edited row
//   - its prep capacity is deliberately small, so AT_CAPACITY is reachable
//     without creating a dozen orders first
//
// Idempotent like the rest of this file: re-seeding updates nothing it does
// not own and creates nothing twice.
// ============================================================================

const seedPhoneOrderCentre = async (company, cp, ch) => {
  const hoursFor = async (branch, opensMinute, closesMinute, closedDays = []) => {
    for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
      await prisma.branchHours.upsert({
        where: { branchId_dayOfWeek: { branchId: branch.id, dayOfWeek } },
        update: {},
        create: {
          companyId: company.id,
          branchId: branch.id,
          dayOfWeek,
          opensMinute,
          closesMinute,
          closed: closedDays.includes(dayOfWeek),
        },
      });
    }
  };
  await hoursFor(cp, 9 * 60, 23 * 60);
  // Closed Mondays (dayOfWeek 1).
  await hoursFor(ch, 11 * 60, 22 * 60, [1]);

  const areaFor = (branch, pincode, deliveryCharge, minOrder) =>
    prisma.branchServiceArea.upsert({
      where: { branchId_pincode: { branchId: branch.id, pincode } },
      update: {},
      create: { companyId: company.id, branchId: branch.id, pincode, deliveryCharge, minOrder },
    });
  await areaFor(cp, '110001', '40.00', '200.00');
  await areaFor(cp, '110002', '50.00', '200.00');
  // Same pincode as cp, dearer: this is the pair a reassignment demo needs.
  await areaFor(ch, '110001', '65.00', '300.00');
  await areaFor(ch, '122001', '45.00', '250.00');

  const capacityFor = (branch, slotMinutes, maxOrdersPerSlot) =>
    prisma.branchPrepCapacity.upsert({
      where: { branchId_companyId: { branchId: branch.id, companyId: company.id } },
      update: {},
      create: { companyId: company.id, branchId: branch.id, slotMinutes, maxOrdersPerSlot },
    });
  await capacityFor(cp, 15, 6);
  await capacityFor(ch, 15, 2);

  const callerFor = async (name, phone, addresses) => {
    const customer = await prisma.customer.upsert({
      where: { companyId_phone: { companyId: company.id, phone } },
      update: {},
      create: { companyId: company.id, name, phone },
    });
    for (const a of addresses) {
      // CustomerAddress has no natural key - a label is not unique by design,
      // because two "Home" addresses is a real thing a caller can have. So the
      // idempotency check is explicit rather than an upsert.
      const existing = await prisma.customerAddress.findFirst({
        where: { customerId: customer.id, label: a.label, line1: a.line1 },
      });
      if (!existing) {
        await prisma.customerAddress.create({
          data: { companyId: company.id, customerId: customer.id, ...a },
        });
      }
    }
    return customer;
  };

  await callerFor('Anita Rao', '+919876500011', [
    { label: 'Home', line1: '12 Church Street', landmark: 'opposite the bakery', city: 'New Delhi', pincode: '110001', isDefault: true },
    { label: 'Office', line1: '4th floor, Connaught Tower', city: 'New Delhi', pincode: '110002' },
  ]);
  await callerFor('Dev Menon', '+919876500012', [
    { label: 'Home', line1: '88 Sector 29', city: 'Gurugram', pincode: '122001', isDefault: true },
  ]);

  console.log(
    'Phone-order centre ready: hours for 2 stores (Chandni Chowk closed Mondays), ' +
      '4 delivery areas (110001 served by both), prep capacity, 2 callers with 3 addresses.',
  );
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
