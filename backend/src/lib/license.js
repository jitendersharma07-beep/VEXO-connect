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
  let effectiveStatus = license.status;
  if (license.status === 'ACTIVE' && license.expiresAt < now) effectiveStatus = 'EXPIRED';

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

  return { ...license, effectiveStatus, branchLimit, activeAddonBranches };
};

export const licenseUsable = (license) => Boolean(license && license.effectiveStatus === 'ACTIVE');
