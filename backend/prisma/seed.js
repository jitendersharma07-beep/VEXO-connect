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

const prisma = new PrismaClient();

const genPassword = () => randomBytes(9).toString('base64url');
const resetPasswords = process.env.POS_SEED_RESET_PASSWORDS === 'true';

const issued = [];

const ensureUser = async ({ email, fullName, role, companyId = null, branchId = null, passwordEnv }) => {
  const existing = await prisma.posUser.findUnique({ where: { email } });
  if (existing && !resetPasswords) {
    issued.push({ email, role, password: '(unchanged)' });
    return existing;
  }
  const password = process.env[passwordEnv] || genPassword();
  const passwordHash = await argon2Hash(password);
  const user = existing
    ? await prisma.posUser.update({ where: { email }, data: { passwordHash } })
    : await prisma.posUser.create({
        data: { email, fullName, role, companyId, branchId, passwordHash, mustChangePassword: true },
      });
  issued.push({ email, role, password });
  return user;
};

const main = async () => {
  // --- ATC platform operator -------------------------------------------------
  await ensureUser({
    email: 'pos.admin@atcinfocom.in',
    fullName: 'ATC POS Platform Admin',
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
      isDemo: true,
      addressLine: 'Block A, Connaught Place (sample address)',
      city: 'New Delhi',
      state: 'Delhi',
    },
  });

  await prisma.branch.upsert({
    where: { companyId_code: { companyId: demo.id, code: 'BSC-CH' } },
    update: {},
    create: {
      companyId: demo.id,
      name: 'Brew Street Café — Cyber Hub',
      code: 'BSC-CH',
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

  console.log('\nATC POS seed complete. Credentials (record these now — not stored anywhere):');
  for (const { email, role, password } of issued) {
    console.log(`  ${role.padEnd(16)} ${email.padEnd(34)} ${password}`);
  }
  console.log('');
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
