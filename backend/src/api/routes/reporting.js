// LANE reporting — the report centre, mounted at /api/reporting.
//
// Separate from the legacy /api/reports rather than replacing it. That router is
// the contract §10 sales report and the POS still calls it; this one is the
// multi-location surface, and it gates on actions instead of on a role list.
// Both can be true at once and nothing that works today stops working.
//
// Three rules hold for every route here:
//
//   1. Authority comes from the action, reach comes from the scope. A caller who
//      holds report.sales.read still only ever sees the stores resolveReportScope
//      returns, and that is computed from the caller's own assignment — never
//      from a query parameter. Passing ?storeId= for somebody else's store
//      answers "Store not found", the same answer as a store that does not exist.
//
//   2. The export is the payload. /export runs the same builder as the screen and
//      hands the result to a writer, so a filter cannot apply to one and not the
//      other. There is no second query path to drift.
//
//   3. A report that cannot be produced says why. A missing model, a missing
//      integration and a period with no trade are three different answers, and
//      none of them is a zero.

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { loadPermissionContext, requireAction } from '../../middleware/permissions.js';
import { audit } from '../../lib/audit.js';

import { env } from '../../config/env.js';
import {
  PRESETS,
  GROUPINGS,
  SETTINGS_BOUNDS,
  isSupportedTimeZone,
  resolvePeriod,
  periodDescriptor,
} from '../../lib/reporting/period.js';
import {
  reportingSettingsFor,
  publicReportingSettings,
  saveReportingSettings,
} from '../../lib/reporting/settings.js';
import { resolveReportScope } from '../../lib/reporting/scope.js';
import {
  reportingCapabilities,
  reportAvailability,
  unavailablePayload,
} from '../../lib/reporting/capability.js';
import { BUILDERS, REPORT_KEYS, FAMILY_OF } from '../../lib/reporting/builders.js';
import { FORMATS, renderExport, exportFilename } from '../../lib/reporting/export.js';
import {
  CADENCES,
  SCHEDULE_STATES,
  DELIVERY_SELECT,
  dueRun,
  deliverRun,
  publicDelivery,
  publicSchedule,
  tick,
} from '../../lib/reporting/schedule.js';
import {
  DETECTOR_KINDS,
  EXCEPTION_THRESHOLDS,
  exceptionSummary,
  publicException,
  scanExceptions,
} from '../../lib/reporting/exceptions.js';
import { prisma } from '../../lib/prisma.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// Which action each report needs. A report is not "a report" — a cash count and
// a menu mix are different authorities, and an owner may reasonably grant one
// without the other.
//
// Every REPORT_KEY appears here, including the families this build cannot yet
// produce. An unlisted key would be refused by the gate before the handler could
// explain itself, and "not found" is the one answer that is certainly wrong: the
// report exists as a concept, it just has no data source connected.
//
// A list means all of them. Food margin is the only one: it puts revenue and
// ingredient cost on the same line, so holding half the authority is not enough
// to read it.
const ACTION_FOR = Object.freeze({
  sales: 'report.sales.read',
  salesByPeriod: 'report.sales.read',
  tax: 'report.tax.read',
  discounts: 'report.sales.read',
  productMix: 'report.sales.read',
  locationComparison: 'report.dashboard.read',
  collections: 'report.payments.read',
  dues: 'report.payments.read',
  refunds: 'report.payments.read',
  settlement: 'report.payments.read',
  cash: 'report.payments.read',
  consumption: 'report.inventory.read',
  wastage: 'report.inventory.read',
  stockValuation: 'report.inventory.read',
  expiry: 'report.inventory.read',
  transfers: 'report.inventory.read',
  purchasing: 'report.inventory.read',
  kitchenDelays: 'report.dashboard.read',
  loyalty: 'report.sales.read',
  delivery: 'report.sales.read',
  profitability: ['report.sales.read', 'report.inventory.read'],
});

// Exported because the scheduler needs the same answer. A schedule is re-checked
// against its owner's authority at send time, and if that check read a second
// copy of this map the timer would eventually deliver a report the screen refuses.
export const actionsFor = (key) => {
  const a = ACTION_FOR[key];
  return a === undefined ? null : Array.isArray(a) ? a : [a];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// How many exception rows one response carries. A worklist is meant to be worked
// through, so this is a page size rather than a limit on what exists — the count
// beside the list is always of every row, and the response says when it was cut.
const EXCEPTION_PAGE = 300;

const querySchema = z.object({
  preset: z.string().optional(),
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  grouping: z.string().optional(),
  storeId: z.string().optional(),
  regionId: z.string().optional(),
  brandId: z.string().optional(),
  legalEntityId: z.string().optional(),
  includeDemo: z.enum(['true', 'false']).optional(),
  groupBy: z.enum(['product', 'variant', 'category']).optional(),
});

const parseQuery = (raw) => {
  const q = querySchema.parse(raw);
  return { ...q, includeDemo: q.includeDemo === 'true' };
};

// Everything a builder needs, resolved once. Assembling it in one place is what
// makes the screen, the drill-down and the export provably the same request:
// they differ only in what they do with the object that comes back.
// The reporting libraries refuse bad input with a plain Error carrying a
// statusCode, deliberately: a pure date engine has no business importing an
// express error type, and its own tests assert that shape. HTTP meaning is
// added here, at the boundary — without this, "from must not be after to"
// reaches the caller as a 500 telling them to report a bug for input they
// could simply correct.
const asHttp = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err?.statusCode === 400) throw badRequest(err.message, err.field);
    throw err;
  }
};

const buildContext = async (req, raw) => {
  const query = parseQuery(raw);
  const settings = await reportingSettingsFor(req.companyScope.id);
  const period = await asHttp(() =>
    resolvePeriod({
      preset: (query.preset ?? 'TODAY').toUpperCase(),
      from: query.from,
      to: query.to,
      grouping: query.grouping?.toUpperCase(),
      settings,
      now: new Date(),
    }),
  );
  const scope = await resolveReportScope(req, query);
  const capability = await reportingCapabilities(req.companyScope.id);
  return { scope, period, settings, now: new Date(), query, capability };
};

// A report family this build cannot produce answers 200 with the reason, not 404
// and not an empty success. "Not found" would send somebody looking for a broken
// link; an empty table would be read as a measured zero. Both are wrong, and the
// second is the one that gets acted on.
const runReport = async (req, key) => {
  if (!REPORT_KEYS.includes(key)) throw notFound(`Unknown report: ${key}`);
  const ctx = await buildContext(req, req.query);
  const builder = BUILDERS[key];
  if (!builder) {
    const cap = ctx.capability[FAMILY_OF[key] ?? key] ?? null;
    // Same resolution the catalog uses, so the reason on this screen is the
    // reason the menu gave for greying out the link to it.
    const { state, note } = reportAvailability({ key, label: cap?.label, cap, buildable: false });
    return {
      ...unavailablePayload({
        key: cap?.key ?? key,
        label: cap?.label ?? key,
        providers: cap?.providers ?? null,
        lastSyncAt: cap?.lastSyncAt ?? null,
        state,
        note,
      }),
      report: key,
      columns: [],
      period: periodDescriptor(ctx.period),
    };
  }
  return builder(ctx);
};

// ---------------------------------------------------------------------------
// Discovery — what this deployment can actually answer
// ---------------------------------------------------------------------------

// Lets the client build its menu from the server's answer rather than from a
// hardcoded list that drifts. A report the caller may not read is not listed,
// and a report whose data this build has no models for is listed as unavailable
// with the reason — which is how a missing integration stops looking like zero.
router.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    const capability = await reportingCapabilities(req.companyScope.id);
    const reports = REPORT_KEYS.filter((key) => {
      const actions = actionsFor(key);
      return actions ? actions.every((a) => req.perm.can(a)) : false;
    }).map((key) => {
      const cap = capability[FAMILY_OF[key]] ?? capability[key] ?? null;
      const buildable = Boolean(BUILDERS[key]);
      // Three different "no", and they ask the owner for different things: not
      // built into this deployment, built but waiting on a provider nobody has
      // connected, or the data is recorded and only the report is missing. The
      // last used to read AVAILABLE, which is how a greyed-out menu entry ended
      // up next to the word "available" and no reason.
      const { state, note } = reportAvailability({ key, label: cap?.label, cap, buildable });
      return {
        key,
        family: FAMILY_OF[key] ?? key,
        actions: actionsFor(key),
        buildable,
        state,
        note,
      };
    });
    res.json({
      reports,
      presets: PRESETS,
      groupings: GROUPINGS,
      formats: FORMATS,
      capabilities: capability,
    });
  }),
);

// ---------------------------------------------------------------------------
// Reporting policy
// ---------------------------------------------------------------------------

router.get(
  '/settings',
  requireAction('report.settings.read'),
  asyncHandler(async (req, res) => {
    res.json(publicReportingSettings(await reportingSettingsFor(req.companyScope.id)));
  }),
);

// Built from the engine's own bounds rather than restated. A range typed twice
// is a range that drifts, and the drift is silent: the patch is accepted, a
// different value is stored, and nothing says so.
const bounded = (key) =>
  z.number().int().min(SETTINGS_BOUNDS[key].min).max(SETTINGS_BOUNDS[key].max).optional();

const settingsPatch = z
  .object({
    timezone: z.string().min(1).optional(),
    businessDayCutoffMinutes: bounded('businessDayCutoffMinutes'),
    weekStartDay: bounded('weekStartDay'),
    financialYearStartMonth: bounded('financialYearStartMonth'),
    staleAfterMinutes: bounded('staleAfterMinutes'),
  })
  .strict();

// Changing the business-day cutoff or the financial year re-cuts every past
// report, so this is audited with the before and after. It is the one setting
// that silently rewrites history, which is why it has its own action rather than
// being implied by being able to read a report.
router.patch(
  '/settings',
  requireAction('report.settings.write'),
  asyncHandler(async (req, res) => {
    const patch = settingsPatch.parse(req.body ?? {});
    if (!Object.keys(patch).length) throw badRequest('No reporting setting was provided');
    const companyId = req.companyScope.id;
    const before = await reportingSettingsFor(companyId);
    const after = await asHttp(() => saveReportingSettings(companyId, patch, req.user.id));
    await audit(req, {
      action: 'reporting.settings.update',
      entity: 'ReportingSetting',
      entityId: companyId,
      companyId,
      meta: { before: publicReportingSettings(before), after: publicReportingSettings(after) },
    });
    res.json(publicReportingSettings(after));
  }),
);

// ---------------------------------------------------------------------------
// The consolidated dashboard
// ---------------------------------------------------------------------------

// One object for the whole HQ view: the company totals, the per-location
// comparison and the coverage statement, all from the same period and the same
// authorised store list. The location table is the comparison builder verbatim,
// so clicking a store and reading the table can never disagree.
router.get(
  '/dashboard',
  requireAction('report.dashboard.read'),
  asyncHandler(async (req, res) => {
    const ctx = await buildContext(req, req.query);
    const comparison = await BUILDERS.locationComparison(ctx);
    res.json({
      ...comparison,
      report: 'dashboard',
      label: 'Consolidated dashboard',
      // The worklist beside the figures, because §4 asks this screen for
      // reconciliation exceptions, overdue items and unclosed shifts — and a
      // number nobody is acting on is the one an owner most needs to see next to
      // the takings. Counts only; the list itself has its own screen and its own
      // action, so a reader without report.exception.read sees a null here rather
      // than a preview of rows they may not open.
      exceptions: req.perm.can('report.exception.read')
        ? await exceptionSummary({ scope: ctx.scope })
        : null,
      // The drill-down targets, named by the server. A client that invented these
      // links could invent one to a store the caller cannot read; these are built
      // from the scope that was just resolved.
      drilldown: {
        stores: ctx.scope.stores.map((s) => ({
          storeId: s.id,
          name: s.name,
          href: `/api/reporting/reports/sales?storeId=${encodeURIComponent(s.id)}`,
        })),
        metrics: {
          netSales: '/api/reporting/reports/sales',
          collected: '/api/reporting/reports/collections',
          refunds: '/api/reporting/reports/refunds',
          dues: '/api/reporting/reports/dues',
          discounts: '/api/reporting/reports/discounts',
          cash: '/api/reporting/reports/cash',
          consumption: '/api/reporting/reports/consumption',
        },
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// The reports themselves
// ---------------------------------------------------------------------------

// One handler for every report. The action is looked up per key, so adding a
// report cannot accidentally inherit another one's authority.
//
// Refusing here rather than inside the handler matters: the 403 is decided
// before any query runs, so a caller who lacks the action cannot learn anything
// about the data — not even how long it took to refuse them.
const reportGate = asyncHandler(async (req, _res, next) => {
  const actions = actionsFor(req.params.key);
  if (!actions) throw notFound(`Unknown report: ${req.params.key}`);
  const missing = actions.find((a) => !req.perm.can(a));
  if (missing) throw forbidden('You do not have permission to perform this action');
  next();
});

router.get(
  '/reports/:key',
  reportGate,
  asyncHandler(async (req, res) => {
    res.json(await runReport(req, req.params.key));
  }),
);

router.get(
  '/reports/:key/export',
  reportGate,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'csv').toLowerCase();
    if (!FORMATS.includes(format)) {
      throw badRequest(`Unsupported export format: ${format}. Use one of ${FORMATS.join(', ')}.`, 'format');
    }
    // The same builder the screen calls, with the same query. Not a second
    // aggregation that happens to be written to agree.
    const report = await runReport(req, req.params.key);
    const { body, contentType } = renderExport(report, format);

    // An export leaves the system and outlives the session that made it, so it is
    // logged with the exact scope and period it contained.
    await audit(req, {
      action: 'reporting.export',
      entity: 'Report',
      entityId: req.params.key,
      companyId: req.companyScope.id,
      meta: {
        format,
        period: { from: report.period.from, to: report.period.to, preset: report.period.preset },
        storeIds: report.scope.storeIds,
        rows: report.rows?.length ?? 0,
      },
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFilename(report, format)}"`,
    );
    res.send(body);
  }),
);

// ---------------------------------------------------------------------------
// Recipients — the addresses a schedule is allowed to reach
// ---------------------------------------------------------------------------
//
// A schedule stores recipient ids, never typed-in addresses. Without this list,
// "configurable recipients" means any manager holding one action can make the
// server produce a company's takings on a timer and send them wherever they like.
// Approving an address is a deliberate, audited act, and withdrawing it stops
// every schedule that used it without anybody having to edit them.

const recipientBody = z
  .object({
    email: z.string().trim().min(3).max(320).email(),
    label: z.string().trim().max(120).optional(),
    // Marks the address as belonging to this deployment's own testing. It is what
    // decides whether this build writes to it at all — see delivery.js.
    isTestAddress: z.boolean().optional(),
  })
  .strict();

router.get(
  '/recipients',
  requireAction('report.schedule.read'),
  asyncHandler(async (req, res) => {
    const rows = await prisma.reportRecipient.findMany({
      where: { companyId: req.companyScope.id },
      orderBy: [{ revokedAt: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        label: true,
        isTestAddress: true,
        approvedAt: true,
        revokedAt: true,
      },
    });
    res.json({
      recipients: rows.map((r) => ({
        id: r.id,
        email: r.email,
        label: r.label,
        isTestAddress: r.isTestAddress,
        approvedAt: r.approvedAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
      })),
      // Said here, on the screen that lists addresses, rather than only in a
      // README: the person adding a recipient is the person who needs to know
      // that this build will not write to it.
      delivery: {
        transport: 'FILE',
        note: 'This build has no mail or messaging transport. A delivery is written to a spool file on the server, and only addresses marked as test addresses are written to at all.',
      },
    });
  }),
);

router.post(
  '/recipients',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const body = recipientBody.parse(req.body ?? {});
    const companyId = req.companyScope.id;
    const email = body.email.toLowerCase();
    // Re-approving a revoked address is the ordinary case — somebody comes back
    // from leave — so it reinstates rather than colliding on the unique index.
    const row = await prisma.reportRecipient.upsert({
      where: { companyId_email: { companyId, email } },
      create: {
        companyId,
        email,
        label: body.label ?? null,
        isTestAddress: body.isTestAddress ?? false,
        approvedById: req.user.id,
      },
      update: {
        label: body.label ?? null,
        isTestAddress: body.isTestAddress ?? false,
        revokedAt: null,
        approvedAt: new Date(),
        approvedById: req.user.id,
      },
      select: { id: true, email: true, label: true, isTestAddress: true, approvedAt: true },
    });
    await audit(req, {
      action: 'reporting.recipient.approve',
      entity: 'ReportRecipient',
      entityId: row.id,
      companyId,
      meta: { email, isTestAddress: row.isTestAddress },
    });
    res.status(201).json(row);
  }),
);

// Revoked, not deleted. A schedule that used this address has deliveries naming
// it, and deleting the row would leave "who received the March figures"
// unanswerable — which is the one question an approval list exists to answer.
router.post(
  '/recipients/:id/revoke',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const found = await prisma.reportRecipient.findFirst({
      where: { id: req.params.id, companyId },
      select: { id: true, email: true },
    });
    if (!found) throw notFound('Recipient not found');
    await prisma.reportRecipient.update({
      where: { id: found.id },
      data: { revokedAt: new Date() },
    });
    await audit(req, {
      action: 'reporting.recipient.revoke',
      entity: 'ReportRecipient',
      entityId: found.id,
      companyId,
      meta: { email: found.email },
    });
    res.json({ id: found.id, revoked: true });
  }),
);

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const SCHEDULE_INCLUDE = Object.freeze({
  recipients: {
    select: {
      recipient: { select: { id: true, email: true, label: true, isTestAddress: true, revokedAt: true } },
    },
  },
  deliveries: { orderBy: { lastAttemptAt: 'desc' }, take: 1, select: DELIVERY_SELECT },
});

const scheduleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    reportKey: z.string().refine((k) => REPORT_KEYS.includes(k), 'Unknown report'),
    cadence: z.enum(CADENCES),
    format: z.enum(['CSV', 'XLSX', 'PDF']).optional(),
    // Minutes past local midnight. 0..1439 — a send time of 1440 is tomorrow,
    // which is a different day's schedule.
    sendAtMinutes: z.number().int().min(0).max(1439).optional(),
    timezone: z.string().min(1).optional(),
    // 0 = Sunday, the same numbering weekStartDay uses.
    weekday: z.number().int().min(0).max(6).nullish(),
    dayOfMonth: z.number().int().min(1).max(31).nullish(),
    storeIds: z.array(z.string()).max(500).optional(),
    recipientIds: z.array(z.string()).max(100).optional(),
  })
  .strict();

// Every store a schedule names must be inside the creator's own reach, checked
// here and again at send time. Checked twice on purpose: this one gives the
// person a clear refusal while they are looking at the form, and the send-time
// one is the control — a store can leave somebody's access long after the
// schedule was saved.
const assertStoresInScope = async (req, storeIds) => {
  if (!storeIds?.length) return [];
  const scope = await resolveReportScope(req, {});
  const allowed = new Set(scope.storeIds);
  const outside = storeIds.filter((id) => !allowed.has(id));
  if (outside.length) throw notFound('Store not found');
  return storeIds;
};

// Schedule names are unique per company, and the name is how people refer to one
// in conversation ("the Monday comparison"), so the constraint is right. It is
// checked here because without it Prisma's unique violation reaches the error
// handler unmapped: somebody who reuses a name gets a 500 and no idea which field
// was wrong, on a form where the obvious next move is to press save again.
const assertNameFree = async (companyId, name, exceptId = null) => {
  const clash = await prisma.reportSchedule.findFirst({
    where: { companyId, name, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, state: true },
  });
  if (clash) {
    throw conflict(
      `A schedule called “${name}” already exists${
        clash.state === 'DRAFT' ? ' as a draft' : ''
      }. Rename this one, or edit that one.`,
    );
  }
};

const assertRecipientsApproved = async (companyId, recipientIds) => {
  if (!recipientIds?.length) return [];
  const rows = await prisma.reportRecipient.findMany({
    where: { id: { in: recipientIds }, companyId, revokedAt: null },
    select: { id: true },
  });
  if (rows.length !== new Set(recipientIds).size) {
    throw badRequest(
      'Every recipient must be an approved, unrevoked address for this company',
      'recipientIds',
    );
  }
  return rows.map((r) => r.id);
};

router.get(
  '/schedules',
  requireAction('report.schedule.read'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const [rows, scope] = await Promise.all([
      prisma.reportSchedule.findMany({
        where: { companyId },
        orderBy: [{ name: 'asc' }],
        include: SCHEDULE_INCLUDE,
      }),
      resolveReportScope(req, {}),
    ]);
    const storesById = new Map(scope.stores.map((s) => [s.id, s]));
    res.json({
      schedules: rows.map((s) => publicSchedule(s, { storesById })),
      cadences: CADENCES,
      states: SCHEDULE_STATES,
      formats: FORMATS.map((f) => f.toUpperCase()),
      // Both facts a person configuring a schedule needs and cannot see from the
      // form: nothing fires unless the process was told to tick, and a new
      // schedule is born inert.
      scheduler: {
        enabled: env.REPORTING_SCHEDULER,
        note: env.REPORTING_SCHEDULER
          ? 'Active schedules fire on their own in this deployment.'
          : 'The scheduler is switched off in this deployment. An active schedule fires only when a run is triggered deliberately.',
      },
    });
  }),
);

router.post(
  '/schedules',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const body = scheduleBody.parse(req.body ?? {});
    const companyId = req.companyScope.id;

    // You cannot schedule a report you may not read. Without this, report-level
    // authority would be enforced on the screen and bypassable by a timer.
    const actions = actionsFor(body.reportKey);
    if (!actions || actions.some((a) => !req.perm.can(a))) {
      throw forbidden('You do not have permission to read the report this schedule would send');
    }
    if (body.cadence === 'WEEKLY' && body.weekday === undefined) {
      throw badRequest('A weekly schedule needs the weekday it sends on', 'weekday');
    }
    if (body.cadence === 'MONTHLY' && body.dayOfMonth === undefined) {
      throw badRequest('A monthly schedule needs the day of month it sends on', 'dayOfMonth');
    }
    if (body.timezone && !isSupportedTimeZone(body.timezone)) {
      throw badRequest(`Unknown timezone: ${body.timezone}`, 'timezone');
    }

    await assertNameFree(companyId, body.name);
    const storeIds = await assertStoresInScope(req, body.storeIds);
    const recipientIds = await assertRecipientsApproved(companyId, body.recipientIds);
    const settings = await reportingSettingsFor(companyId);

    const created = await prisma.reportSchedule.create({
      data: {
        companyId,
        name: body.name,
        reportKey: body.reportKey,
        cadence: body.cadence,
        format: body.format ?? 'CSV',
        sendAtMinutes: body.sendAtMinutes ?? 360,
        timezone: body.timezone ?? settings.timezone,
        weekday: body.cadence === 'WEEKLY' ? (body.weekday ?? 1) : null,
        dayOfMonth: body.cadence === 'MONTHLY' ? (body.dayOfMonth ?? 1) : null,
        branchIds: storeIds,
        // DRAFT, always. A schedule that started sending the moment it was saved
        // would mean somebody experimenting with the form had already mailed a
        // company's figures before deciding whether they meant to.
        state: 'DRAFT',
        createdById: req.user.id,
        recipients: { create: recipientIds.map((id) => ({ recipientId: id })) },
      },
      include: SCHEDULE_INCLUDE,
    });

    await audit(req, {
      action: 'reporting.schedule.create',
      entity: 'ReportSchedule',
      entityId: created.id,
      companyId,
      meta: {
        name: created.name,
        reportKey: created.reportKey,
        cadence: created.cadence,
        storeIds,
        recipientCount: recipientIds.length,
      },
    });
    res.status(201).json(publicSchedule(created));
  }),
);

router.patch(
  '/schedules/:id',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const body = scheduleBody.partial().parse(req.body ?? {});
    const companyId = req.companyScope.id;
    const existing = await prisma.reportSchedule.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!existing) throw notFound('Schedule not found');

    if (body.reportKey) {
      const actions = actionsFor(body.reportKey);
      if (!actions || actions.some((a) => !req.perm.can(a))) {
        throw forbidden('You do not have permission to read the report this schedule would send');
      }
    }
    if (body.timezone && !isSupportedTimeZone(body.timezone)) {
      throw badRequest(`Unknown timezone: ${body.timezone}`, 'timezone');
    }
    if (body.name !== undefined) await assertNameFree(companyId, body.name, existing.id);

    const data = {};
    for (const k of ['name', 'reportKey', 'cadence', 'format', 'sendAtMinutes', 'timezone']) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (body.weekday !== undefined) data.weekday = body.weekday;
    if (body.dayOfMonth !== undefined) data.dayOfMonth = body.dayOfMonth;
    if (body.storeIds !== undefined) data.branchIds = await assertStoresInScope(req, body.storeIds);

    const updated = await prisma.$transaction(async (tx) => {
      if (body.recipientIds !== undefined) {
        const ids = await assertRecipientsApproved(companyId, body.recipientIds);
        await tx.reportScheduleRecipient.deleteMany({ where: { scheduleId: existing.id } });
        await tx.reportScheduleRecipient.createMany({
          data: ids.map((recipientId) => ({ scheduleId: existing.id, recipientId })),
        });
      }
      return tx.reportSchedule.update({
        where: { id: existing.id },
        data,
        include: SCHEDULE_INCLUDE,
      });
    });

    await audit(req, {
      action: 'reporting.schedule.update',
      entity: 'ReportSchedule',
      entityId: existing.id,
      companyId,
      meta: { changed: Object.keys(data), recipientsReplaced: body.recipientIds !== undefined },
    });
    res.json(publicSchedule(updated));
  }),
);

// Activation is its own route and its own audit line, because it is the moment a
// configuration becomes something that acts on its own. A PATCH that could flip
// `state` among twelve other fields would bury that in a diff.
router.post(
  '/schedules/:id/state',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const { state } = z.object({ state: z.enum(SCHEDULE_STATES) }).strict().parse(req.body ?? {});
    const companyId = req.companyScope.id;
    const existing = await prisma.reportSchedule.findFirst({
      where: { id: req.params.id, companyId },
      include: { recipients: { select: { recipient: { select: { revokedAt: true } } } } },
    });
    if (!existing) throw notFound('Schedule not found');

    if (state === 'ACTIVE') {
      const live = existing.recipients.filter((r) => !r.recipient.revokedAt);
      // Activating a schedule with nobody to send to produces a delivery row per
      // period that no human will ever read. Refusing is the kinder answer.
      if (!live.length) {
        throw badRequest(
          'This schedule has no approved recipient, so activating it would send nothing to nobody',
        );
      }
    }

    const updated = await prisma.reportSchedule.update({
      where: { id: existing.id },
      data: {
        state,
        activatedAt: state === 'ACTIVE' ? (existing.activatedAt ?? new Date()) : existing.activatedAt,
      },
      include: SCHEDULE_INCLUDE,
    });
    await audit(req, {
      action: 'reporting.schedule.state',
      entity: 'ReportSchedule',
      entityId: existing.id,
      companyId,
      meta: { from: existing.state, to: state },
    });
    res.json(publicSchedule(updated));
  }),
);

// Send the period that is currently due, now.
//
// The same code path the timer uses, including the deduplication — so pressing
// this twice produces one delivery and one "already delivered", which is exactly
// what has to be true of the timer and is easier to prove here.
router.post(
  '/schedules/:id/run',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const schedule = await prisma.reportSchedule.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!schedule) throw notFound('Schedule not found');
    if (schedule.state === 'DRAFT') {
      throw badRequest(
        'This schedule is still a draft. Activate it first — a draft has deliberately never sent anything.',
      );
    }

    const now = new Date();
    const due = await dueRun({ schedule, now });
    if (!due) throw badRequest('This schedule has no completed period to send yet');

    const outcome = await deliverRun({
      schedule,
      actions: actionsFor(schedule.reportKey) ?? [],
      runKey: due.runKey,
      period: due.period,
      settings: due.settings,
      now,
      trigger: 'MANUAL',
    });
    await prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now } });

    await audit(req, {
      action: 'reporting.schedule.run',
      entity: 'ReportSchedule',
      entityId: schedule.id,
      companyId,
      meta: {
        runKey: due.runKey,
        period: { from: due.period.from, to: due.period.to },
        status: outcome.delivery?.status ?? null,
        deduplicated: Boolean(outcome.deduplicated),
      },
    });

    res.json({
      runKey: due.runKey,
      period: { from: due.period.from, to: due.period.to },
      deduplicated: Boolean(outcome.deduplicated),
      reason: outcome.reason ?? null,
      delivery: outcome.delivery ? publicDelivery(outcome.delivery) : null,
    });
  }),
);

router.get(
  '/schedules/:id/deliveries',
  requireAction('report.schedule.read'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const schedule = await prisma.reportSchedule.findFirst({
      where: { id: req.params.id, companyId },
      select: { id: true, name: true, reportKey: true },
    });
    if (!schedule) throw notFound('Schedule not found');
    const rows = await prisma.reportDelivery.findMany({
      where: { scheduleId: schedule.id },
      orderBy: { firstAttemptAt: 'desc' },
      take: 100,
      select: DELIVERY_SELECT,
    });
    res.json({ schedule, deliveries: rows.map(publicDelivery) });
  }),
);

// One tick, on demand. The timer is off in this deployment, so this is how a due
// schedule is fired — by a person, or by the reviewed owner command, never by
// merely deploying the lane. Scoped to the caller's own company: a tenant may not
// make somebody else's schedules run.
router.post(
  '/schedules/tick',
  requireAction('report.schedule.write'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const result = await tick({ actionsFor, companyId });
    await audit(req, {
      action: 'reporting.schedule.tick',
      entity: 'Company',
      entityId: companyId,
      companyId,
      meta: { considered: result.considered, results: result.results },
    });
    res.json(result);
  }),
);

// ---------------------------------------------------------------------------
// Actionable exceptions
// ---------------------------------------------------------------------------

router.get(
  '/exceptions',
  requireAction('report.exception.read'),
  asyncHandler(async (req, res) => {
    const companyId = req.companyScope.id;
    const scope = await resolveReportScope(req, parseQuery(req.query));
    const status = req.query.status
      ? String(req.query.status).toUpperCase().split(',')
      : ['OPEN', 'ACKNOWLEDGED'];
    // One more than the cap, so the response can say it was capped. The summary
    // beside this list is counted over every row; without this flag an estate with
    // 400 open exceptions would read "400 to act on" above a list of 300 and
    // nothing on the screen would explain the missing hundred.
    const page = await prisma.reportingException.findMany({
      where: {
        companyId,
        status: { in: status },
        // A company-wide exception has no branch. It is included for everybody
        // who can read exceptions at all, because the alternative is an exception
        // nobody sees.
        OR: [{ branchId: { in: scope.storeIds } }, { branchId: null }],
      },
      orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
      take: EXCEPTION_PAGE + 1,
    });
    const rows = page.slice(0, EXCEPTION_PAGE);
    const storesById = new Map(scope.stores.map((s) => [s.id, s]));
    res.json({
      exceptions: rows.map((e) => publicException(e, storesById)),
      // Severity descending, so a cut list has dropped the least urgent rows
      // rather than an arbitrary selection — worth saying, because "some are
      // missing" and "the ones that matter are missing" are different problems.
      truncated: page.length > EXCEPTION_PAGE ? { shown: rows.length, orderedBy: 'severity' } : null,
      summary: await exceptionSummary({ scope }),
      kinds: DETECTOR_KINDS,
      thresholds: EXCEPTION_THRESHOLDS,
      scope: { storeIds: scope.storeIds, stores: scope.stores },
    });
  }),
);

// Detection is a write, so it is a POST — but it is gated on the READ action, not
// on resolve. Looking for problems is part of reading the worklist; it is
// deciding one has been dealt with that needs the stronger authority.
router.post(
  '/exceptions/scan',
  requireAction('report.exception.read'),
  asyncHandler(async (req, res) => {
    const ctx = await buildContext(req, req.query);
    const result = await scanExceptions({
      scope: ctx.scope,
      period: ctx.period,
      settings: ctx.settings,
      now: new Date(),
      actorId: req.user.id,
    });
    await audit(req, {
      action: 'reporting.exception.scan',
      entity: 'Company',
      entityId: req.companyScope.id,
      companyId: req.companyScope.id,
      meta: {
        period: { from: ctx.period.from, to: ctx.period.to },
        raised: result.raised,
        refreshed: result.refreshed,
        cleared: result.cleared,
      },
    });
    res.json({
      ...result,
      period: periodDescriptor(ctx.period),
      summary: await exceptionSummary({ scope: ctx.scope, detectorRoll: result.detectors }),
    });
  }),
);

const resolveBody = z
  .object({
    status: z.enum(['ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

// Acknowledge, resolve or dismiss. Three states because they are three different
// claims: somebody has it, somebody fixed it, and somebody looked and decided it
// was not a problem. Collapsing the third into the second turns "we checked and
// it was fine" into "we fixed it", and an audit six months later cannot tell.
router.post(
  '/exceptions/:id',
  requireAction('report.exception.resolve'),
  asyncHandler(async (req, res) => {
    const body = resolveBody.parse(req.body ?? {});
    const companyId = req.companyScope.id;
    const scope = await resolveReportScope(req, {});
    const found = await prisma.reportingException.findFirst({
      where: {
        id: req.params.id,
        companyId,
        // Reach applies to closing an exception exactly as it does to reading one.
        // A manager cannot sign off the cash difference at a store they do not
        // hold, which is the whole point of naming a responsible role.
        OR: [{ branchId: { in: scope.storeIds } }, { branchId: null }],
      },
    });
    if (!found) throw notFound('Exception not found');
    if (body.status === 'DISMISSED' && !body.note) {
      throw badRequest('Dismissing an exception needs a reason', 'note');
    }

    const now = new Date();
    const data =
      body.status === 'ACKNOWLEDGED'
        ? { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedById: req.user.id }
        : {
            status: body.status,
            resolvedAt: now,
            resolvedById: req.user.id,
            resolutionNote: body.note ?? null,
            // Acknowledgement is implied by resolving: somebody who fixes a thing
            // has plainly seen it, and leaving the field null would make the
            // worklist look as though nobody ever picked it up.
            acknowledgedAt: found.acknowledgedAt ?? now,
            acknowledgedById: found.acknowledgedById ?? req.user.id,
          };

    const updated = await prisma.reportingException.update({ where: { id: found.id }, data });
    await audit(req, {
      action: `reporting.exception.${body.status.toLowerCase()}`,
      entity: 'ReportingException',
      entityId: found.id,
      companyId,
      meta: { kind: found.kind, branchId: found.branchId, from: found.status, note: body.note ?? null },
    });
    res.json(publicException(updated, new Map(scope.stores.map((s) => [s.id, s]))));
  }),
);

export default router;
