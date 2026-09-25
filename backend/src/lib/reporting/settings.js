// LANE reporting — the company's reporting policy.
//
// A company with no row has never chosen, so it gets the documented defaults
// rather than an error or an empty screen. Every read goes through here so no
// report can quietly resolve its own boundaries differently from another.

import { prisma } from '../prisma.js';
import { REPORTING_DEFAULTS, isSupportedTimeZone, normalizeSettings } from './period.js';

export const reportingSettingsFor = async (companyId) => {
  const row = await prisma.reportingSetting.findUnique({ where: { companyId } });
  return {
    ...normalizeSettings(row ?? {}),
    configured: Boolean(row),
    updatedAt: row?.updatedAt ?? null,
    updatedById: row?.updatedById ?? null,
  };
};

export const publicReportingSettings = (s) => ({
  timezone: s.timezone,
  businessDayCutoffMinutes: s.businessDayCutoffMinutes,
  weekStartDay: s.weekStartDay,
  financialYearStartMonth: s.financialYearStartMonth,
  staleAfterMinutes: s.staleAfterMinutes,
  configured: s.configured,
  updatedAt: s.updatedAt,
  defaults: REPORTING_DEFAULTS,
});

export const saveReportingSettings = async (companyId, patch, actorId) => {
  const current = await reportingSettingsFor(companyId);
  const merged = normalizeSettings({ ...current, ...patch });
  // A timezone ICU cannot resolve would make every boundary silently fall back
  // to the default, so it is refused with the reason instead of accepted.
  if (patch.timezone !== undefined && !isSupportedTimeZone(patch.timezone)) {
    throw Object.assign(new Error(`Unknown timezone: ${patch.timezone}`), {
      statusCode: 400,
      field: 'timezone',
    });
  }
  const row = await prisma.reportingSetting.upsert({
    where: { companyId },
    create: { companyId, ...merged, updatedById: actorId ?? null },
    update: { ...merged, updatedById: actorId ?? null },
  });
  return { ...normalizeSettings(row), configured: true, updatedAt: row.updatedAt, updatedById: row.updatedById };
};
