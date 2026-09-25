import { prisma } from './prisma.js';

// The licence a company is currently operating under: the most recently
// issued one. ATC issues a new row to change plan; history stays intact.
export const currentLicense = async (companyId) => {
  const license = await prisma.license.findFirst({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
    include: { addons: true },
  });
  if (!license) return null;
  return withDerived(license);
};

export const withDerived = (license) => {
  const now = new Date();
  // Grace is part of the licence that was sold: a customer promised a
  // fortnight past renewal keeps trading for a fortnight. It extends the
  // deadline; it does not change what EXPIRED means, and like expiry it is
  // derived, so no forgotten job can leave a lapsed licence looking current.
  const graceEndsAt =
    license.graceDays > 0
      ? new Date(license.expiresAt.getTime() + license.graceDays * 24 * 3600 * 1000)
      : license.expiresAt;
  const inGrace =
    license.status === 'ACTIVE' && license.expiresAt < now && graceEndsAt >= now;

  let effectiveStatus = license.status;
  if (license.status === 'ACTIVE' && graceEndsAt < now) effectiveStatus = 'EXPIRED';

  const activeAddonBranches = (license.addons || [])
    .filter((a) => a.kind === 'ADDITIONAL_BRANCH' && (!a.expiresAt || a.expiresAt > now))
    .reduce((sum, a) => sum + a.quantity, 0);

  // SINGLE_STORE is one store by definition, whatever the stored number says.
  const branchLimit =
    license.plan === 'SINGLE_STORE'
      ? 1
      : license.plan === 'MULTI_STORE'
        ? license.baseBranchLimit + activeAddonBranches
        : license.baseBranchLimit;

  return { ...license, effectiveStatus, branchLimit, activeAddonBranches, graceEndsAt, inGrace };
};

export const licenseUsable = (license) => Boolean(license && license.effectiveStatus === 'ACTIVE');

// Whether an extension module is entitled. An empty `modules` means core POS
// only — which is what every licence issued before this column existed says,
// and the safe reading of it.
export const licenseHasModule = (license, module) =>
  Boolean(license && Array.isArray(license.modules) && license.modules.includes(module));
