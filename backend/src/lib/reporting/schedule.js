// LANE reporting — standing instructions to produce a report and deliver it.
//
// A scheduled report is the only part of this lane that acts with nobody
// watching, which makes two properties load-bearing rather than nice to have.
//
// REACH. A schedule runs as its owner, and its owner's authority is read again at
// send time from the same resolver the HTTP request uses — not stored on the
// schedule, not trusted from what it was when it was created. A manager who
// creates a daily report and is later moved to one store starts receiving one
// store. The alternative is a timer that keeps delivering a reach the screen
// would now refuse, which is the quietest possible way to leak a company's
// figures.
//
// EXACTLY ONCE. Every run has a period identity — `DAILY:2026-09-23` — unique per
// schedule in the database. That uniqueness is the deduplication: a retry, a
// double tick, two processes racing and an owner pressing "send now" all converge
// on the same row, and only one of them can move it to SENT. Retries update the
// row they own. An owner cannot be sent the same morning report twice, which
// matters more than being sent it at all: the first is a bug people forgive and
// the second is one they stop trusting the numbers over.

import { prisma } from '../prisma.js';
import { permissionContextFor } from '../../middleware/permissions.js';
import { logger } from '../logger.js';
import { reportingSettingsFor } from './settings.js';
import { resolveReportScope } from './scope.js';
import { reportingCapabilities, reportAvailability } from './capability.js';
import { BUILDERS, REPORT_KEYS, FAMILY_OF } from './builders.js';
import { renderExport, exportFilename } from './export.js';
import { deliver, partitionRecipients } from './delivery.js';
import {
  addDays,
  addMonths,
  businessDayStartUtc,
  endOfMonth,
  resolvePeriod,
  weekdayOf,
  zoneOffsetMs,
} from './period.js';

export const CADENCES = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY']);
export const SCHEDULE_STATES = Object.freeze(['DRAFT', 'ACTIVE', 'PAUSED']);

// Which window each cadence reports on. Always a COMPLETED period: a daily report
// that fires at 06:00 and covers "today" covers six hours of one shift, and an
// owner comparing Monday's email to Monday's screen would find two different
// numbers with no way to know which was wrong.
const PRESET_FOR = Object.freeze({ DAILY: 'YESTERDAY', WEEKLY: 'LAST_WEEK', MONTHLY: 'LAST_MONTH' });

// Wall-clock in a zone, as an ISO string whose fields read as local. Used only to
// ask "what is the local date and time there", which is the whole of what a
// send-time comparison needs.
const localParts = (timezone, instant) => {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(timezone, instant));
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
};

/**
 * The most recent firing of this schedule at or before `now`.
 *
 * Returned as the local date it fired on, or null if it has never fired. Working
 * backwards from now rather than forwards from the last send is deliberate: a
 * process that was down for three days then computes the run it should send
 * TODAY, rather than queueing three days of backlog into an owner's morning.
 */
export const lastFiringDate = ({ schedule, now }) => {
  const tz = schedule.timezone;
  const { date, minutes } = localParts(tz, now);
  const firedToday = minutes >= schedule.sendAtMinutes;

  if (schedule.cadence === 'DAILY') {
    return firedToday ? date : addDays(date, -1);
  }

  if (schedule.cadence === 'WEEKLY') {
    // weekStartDay numbering, 0 = Sunday, matching weekdayOf and the reporting
    // settings. Sharing one convention is what stops a schedule saying Monday and
    // the week it reports on starting on Sunday.
    const want = schedule.weekday ?? 1;
    const back = (weekdayOf(date) - want + 7) % 7;
    const candidate = addDays(date, -back);
    if (candidate === date && !firedToday) return addDays(candidate, -7);
    return candidate;
  }

  // MONTHLY. The requested day is clamped to the month's own length, so "the
  // 31st" still fires in February rather than skipping the month silently.
  const wanted = schedule.dayOfMonth ?? 1;
  const dayIn = (isoMonthDate) => {
    const last = Number(endOfMonth(isoMonthDate).slice(8, 10));
    return `${isoMonthDate.slice(0, 7)}-${String(Math.min(wanted, last)).padStart(2, '0')}`;
  };
  const thisMonth = dayIn(date);
  if (thisMonth < date || (thisMonth === date && firedToday)) return thisMonth;
  return dayIn(addMonths(`${date.slice(0, 7)}-01`, -1));
};

/**
 * Which run of this schedule is due now, if any.
 *
 * `runKey` is the period identity and nothing else: it names the window, so two
 * attempts at the same window collide in the database however they were triggered.
 */
export const dueRun = async ({ schedule, now = new Date() }) => {
  const firedOn = lastFiringDate({ schedule, now });
  if (!firedOn) return null;
  const settings = await reportingSettingsFor(schedule.companyId);
  const period = await periodForFiring({ schedule, settings, firedOn });
  return { runKey: runKeyOf(schedule, period), period, settings, firedOn };
};

export const runKeyOf = (schedule, period) => `${schedule.cadence}:${period.from}`;

// The completed window, resolved relative to the instant the schedule fired
// rather than to now. Reusing resolvePeriod is what keeps a scheduled month the
// same month the screen shows: week start, business-day cutoff and financial year
// are applied once, in one place, for both.
const periodForFiring = async ({ schedule, settings, firedOn }) =>
  resolvePeriod({
    preset: PRESET_FOR[schedule.cadence],
    settings,
    now: businessDayStartUtc(settings, firedOn),
  });

/**
 * A report context for a principal with no request attached.
 *
 * The authority and the reach both come from stored state, through the same
 * functions the HTTP path uses. `req` is faked only as far as those two functions
 * read it — companyScope and perm — because inventing a wider fake would be
 * inventing a second definition of who this user is.
 */
export const contextForUser = async ({ userId, companyId, query = {}, now = new Date() }) => {
  const user = await prisma.posUser.findFirst({
    where: { id: userId, companyId },
    // branchId and regionId are here because storeScopeFor reads them. Selecting
    // only the role would resolve a branch manager's reach to the empty list —
    // fail-closed, so not a leak, but it would silently stop every store-pinned
    // and regional owner's schedule while the screen kept working.
    select: {
      id: true,
      role: true,
      companyId: true,
      branchId: true,
      regionId: true,
      status: true,
      email: true,
      fullName: true,
    },
  });
  if (!user) return { ok: false, reason: 'The user who created this schedule no longer exists.' };
  if (user.status !== 'ACTIVE') {
    return {
      ok: false,
      // A disabled account is usually somebody who left. Continuing to mail
      // reports resolved through their access is exactly what disabling them was
      // meant to stop.
      reason: `The user who created this schedule is ${user.status.toLowerCase()}, so their access can no longer be resolved.`,
    };
  }
  const perm = await permissionContextFor(user, companyId);
  const req = { companyScope: { id: companyId }, perm, user };
  const settings = await reportingSettingsFor(companyId);
  const scope = await resolveReportScope(req, query);
  const capability = await reportingCapabilities(companyId);
  return { ok: true, user, perm, settings, scope, capability, ctxBase: { settings, capability, now } };
};

// The action a schedule's owner must still hold for the report it names. Imported
// from the router would be circular, so the map lives there and is handed in —
// see ACTION_FOR in api/routes/reporting.js, which is also what the screen gates
// on. One map, two readers.
export const scheduleAuthorised = ({ perm, actions }) =>
  Array.isArray(actions) && actions.length > 0 && actions.every((a) => perm.can(a));

/**
 * Produce and deliver one run of one schedule, at most once.
 *
 * `actions` is the authority the report needs, handed in by the caller. Returns
 * the delivery row as stored. Never throws for an ordinary failure — a schedule
 * whose report cannot be built records FAILED and stays eligible for a retry,
 * because the alternative is a scheduler that dies on one tenant's bad data and
 * silently stops sending for everybody.
 */
export const runScheduleOnce = async ({ schedule, actions, now = new Date(), trigger = 'TIMER' }) => {
  const due = await dueRun({ schedule, now });
  if (!due) return { skipped: true, reason: 'This schedule has not fired yet.' };
  return deliverRun({ schedule, actions, ...due, now, trigger });
};

const claim = async ({ schedule, runKey, period, now }) => {
  // Create-or-find on the period identity. The unique index is what makes this
  // safe: the loser of a race gets a constraint violation rather than a second
  // delivery.
  const existing = await prisma.reportDelivery.findUnique({
    where: { scheduleId_runKey: { scheduleId: schedule.id, runKey } },
    select: { id: true, status: true, attempts: true, sentAt: true },
  });

  if (!existing) {
    try {
      const created = await prisma.reportDelivery.create({
        data: {
          scheduleId: schedule.id,
          runKey,
          periodFrom: period.from,
          periodTo: period.to,
          status: 'PENDING',
          attempts: 1,
          firstAttemptAt: now,
          lastAttemptAt: now,
        },
        select: { id: true },
      });
      return { id: created.id };
    } catch (err) {
      // Somebody else created it between the read and the write. Fall through to
      // the compare-and-swap below, which is the same path a retry takes.
      if (err?.code !== 'P2002') throw err;
    }
  }

  // Already delivered. This is the case the whole design exists for, and it is
  // not an error: a retry of a successful run is a no-op, loudly.
  const row = await prisma.reportDelivery.findUnique({
    where: { scheduleId_runKey: { scheduleId: schedule.id, runKey } },
    select: { id: true, status: true, sentAt: true },
  });
  if (row.status === 'SENT') return { id: row.id, alreadySent: true };

  // Claim the attempt. The status guard is the compare-and-swap: exactly one
  // caller can move a row out of PENDING/FAILED, so two ticks arriving together
  // produce one attempt and one no-op rather than two sends.
  const claimed = await prisma.reportDelivery.updateMany({
    where: { id: row.id, status: { in: ['PENDING', 'FAILED', 'SKIPPED'] } },
    data: { status: 'PENDING', attempts: { increment: 1 }, lastAttemptAt: now },
  });
  if (claimed.count !== 1) return { id: row.id, raced: true };
  return { id: row.id };
};

export const deliverRun = async ({
  schedule,
  actions,
  runKey,
  period,
  settings,
  now = new Date(),
  trigger = 'TIMER',
}) => {
  const claimed = await claim({ schedule, runKey, period, now });
  if (claimed.alreadySent || claimed.raced) {
    // The row that already exists, in the same shape a fresh send returns.
    //
    // Answering "already delivered" without saying WHICH delivery makes the caller
    // fetch it separately to find out what was sent, and the callers that do not
    // read it as nothing having happened: the tick summary reports
    // `outcome.delivery?.status ?? null`, so a deduplicated tick would print a null
    // status beside a schedule that is in fact fully sent — no activity and already
    // done, rendered identically.
    const existing = await prisma.reportDelivery.findUnique({
      where: { id: claimed.id },
      select: DELIVERY_SELECT,
    });
    return {
      deduplicated: true,
      delivery: existing,
      runKey,
      reason: claimed.alreadySent
        ? 'This period has already been delivered.'
        : 'Another attempt at this period is already in flight.',
    };
  }

  const finish = (data) =>
    prisma.reportDelivery.update({ where: { id: claimed.id }, data, select: DELIVERY_SELECT });

  try {
    const ctx = await contextForUser({
      userId: schedule.createdById,
      companyId: schedule.companyId,
      // The schedule's own store list, applied as a filter on top of whatever the
      // owner can still reach. An id that has left their access simply yields no
      // store rather than granting one.
      query: {},
      now,
    });
    if (!ctx.ok) {
      return { delivery: await finish({ status: 'SKIPPED', lastError: ctx.reason, lastAttemptAt: now }) };
    }
    if (!scheduleAuthorised({ perm: ctx.perm, actions })) {
      return {
        delivery: await finish({
          status: 'SKIPPED',
          // The permission check is repeated here, at send time, because a
          // schedule outlives the authority that created it. This is the branch
          // that stops a revoked manager's nightly email.
          lastError: `The owner of this schedule no longer has permission to read ${schedule.reportKey}.`,
          lastAttemptAt: now,
        }),
      };
    }

    const recipientRows = await prisma.reportScheduleRecipient.findMany({
      where: { scheduleId: schedule.id, recipient: { revokedAt: null } },
      select: { recipient: { select: { email: true, isTestAddress: true } } },
    });
    const recipients = recipientRows.map((r) => r.recipient);
    if (!recipients.length) {
      return {
        delivery: await finish({
          status: 'SKIPPED',
          lastError:
            'This schedule has no approved recipient. An owner who stops receiving a report is owed the reason, so the run is recorded rather than passed over.',
          lastAttemptAt: now,
        }),
      };
    }

    const { deliverable, withheld, withheldReason } = partitionRecipients(recipients);

    const scope = narrowScope(ctx.scope, schedule.branchIds);
    if (!scope.storeIds.length) {
      return {
        delivery: await finish({
          status: 'SKIPPED',
          lastError:
            'No store this schedule names is still inside its owner’s access, so there is nothing it may report on.',
          lastAttemptAt: now,
          withheld: withheld.map((r) => r.email),
        }),
      };
    }

    const builder = BUILDERS[schedule.reportKey];
    if (!builder) {
      const cap = ctx.capability[FAMILY_OF[schedule.reportKey] ?? schedule.reportKey] ?? null;
      const { note } = reportAvailability({ key: schedule.reportKey, label: cap?.label, cap, buildable: false });
      // Not FAILED: nothing went wrong, this deployment cannot produce the report.
      // Recording it as a failure would invite retries that can never succeed.
      return { delivery: await finish({ status: 'SKIPPED', lastError: note, lastAttemptAt: now }) };
    }

    const report = await builder({
      scope,
      period,
      settings: settings ?? ctx.settings,
      now,
      query: {},
      capability: ctx.capability,
    });
    const format = schedule.format.toLowerCase();
    const { body } = renderExport(report, format);
    const filename = exportFilename(report, format);

    if (!deliverable.length) {
      return {
        delivery: await finish({
          status: 'SKIPPED',
          lastError: withheldReason,
          withheld: withheld.map((r) => r.email),
          rowCount: report.rows?.length ?? 0,
          lastAttemptAt: now,
        }),
        report,
      };
    }

    const written = await deliver({ schedule, runKey, format, body, filename });

    return {
      delivery: await finish({
        status: 'SENT',
        sentAt: now,
        lastAttemptAt: now,
        // Snapshotted, because the approved list changes and "who received the
        // March figures" has to stay answerable.
        sentTo: deliverable.map((r) => r.email),
        withheld: withheld.map((r) => r.email),
        transport: written.transport,
        artifactPath: written.artifactPath,
        bytes: written.bytes,
        rowCount: report.rows?.length ?? 0,
        lastError: withheldReason,
      }),
      report,
      trigger,
    };
  } catch (err) {
    logger?.error?.({ err, scheduleId: schedule.id, runKey }, 'reporting schedule delivery failed');
    return {
      delivery: await finish({
        status: 'FAILED',
        lastAttemptAt: now,
        // The message, not the stack: this string is shown to an owner, and a
        // stack trace tells them nothing they can act on.
        lastError: err?.message ?? String(err),
      }),
    };
  }
};

// The schedule's own store list, intersected with what its owner can still
// reach. An intersection rather than a replacement — the list narrows, it never
// grants, which is the same rule resolveReportScope applies to query filters.
const narrowScope = (scope, wanted) => {
  if (!wanted?.length) return scope;
  const allowed = new Set(scope.storeIds);
  const storeIds = wanted.filter((id) => allowed.has(id));
  return {
    ...scope,
    storeIds,
    stores: scope.stores.filter((s) => storeIds.includes(s.id)),
    narrowed: true,
  };
};

export const DELIVERY_SELECT = Object.freeze({
  id: true,
  scheduleId: true,
  runKey: true,
  periodFrom: true,
  periodTo: true,
  status: true,
  attempts: true,
  sentTo: true,
  withheld: true,
  transport: true,
  artifactPath: true,
  rowCount: true,
  bytes: true,
  lastError: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  sentAt: true,
});

export const publicDelivery = (d) => ({
  id: d.id,
  runKey: d.runKey,
  period: { from: d.periodFrom, to: d.periodTo },
  status: d.status,
  attempts: d.attempts,
  sentTo: d.sentTo,
  withheld: d.withheld,
  // Named so nothing reads SENT as "emailed". This build writes a spool file and
  // the row says which transport did it.
  transport: d.transport,
  // The path is operational detail for whoever fetches the artifact, and it is
  // already inside the company's own directory tree.
  artifact: d.artifactPath ? d.artifactPath.split('/').slice(-1)[0] : null,
  rowCount: d.rowCount ?? null,
  bytes: d.bytes ?? null,
  note: d.lastError ?? null,
  firstAttemptAt: d.firstAttemptAt.toISOString(),
  lastAttemptAt: d.lastAttemptAt.toISOString(),
  sentAt: d.sentAt?.toISOString() ?? null,
});

export const publicSchedule = (s, { storesById = new Map() } = {}) => ({
  id: s.id,
  name: s.name,
  reportKey: s.reportKey,
  cadence: s.cadence,
  format: s.format,
  sendAtMinutes: s.sendAtMinutes,
  timezone: s.timezone,
  weekday: s.weekday ?? null,
  dayOfMonth: s.dayOfMonth ?? null,
  state: s.state,
  // Empty means "every store the owner can reach at send time", which is a
  // different thing from "no stores" and has to be said in words somewhere.
  storeIds: s.branchIds,
  stores: s.branchIds.map((id) => ({ id, name: storesById.get(id)?.name ?? null })),
  allAuthorisedStores: s.branchIds.length === 0,
  recipients: (s.recipients ?? []).map((r) => ({
    id: r.recipient.id,
    email: r.recipient.email,
    label: r.recipient.label ?? null,
    isTestAddress: r.recipient.isTestAddress,
    revoked: Boolean(r.recipient.revokedAt),
  })),
  createdAt: s.createdAt.toISOString(),
  activatedAt: s.activatedAt?.toISOString() ?? null,
  lastRunAt: s.lastRunAt?.toISOString() ?? null,
  lastDelivery: s.deliveries?.length ? publicDelivery(s.deliveries[0]) : null,
});

/**
 * Fire every schedule that is due.
 *
 * Only ACTIVE ones: DRAFT is the state a new schedule is born in and PAUSED is a
 * deliberate stop, and neither may be woken by a tick. `actionsFor` is handed in
 * so the authority map has exactly one definition, in the router.
 */
export const tick = async ({ now = new Date(), actionsFor, companyId = null } = {}) => {
  const schedules = await prisma.reportSchedule.findMany({
    where: { state: 'ACTIVE', ...(companyId ? { companyId } : {}) },
  });
  const results = [];
  for (const schedule of schedules) {
    if (!REPORT_KEYS.includes(schedule.reportKey)) {
      results.push({ scheduleId: schedule.id, skipped: true, reason: 'Unknown report key.' });
      continue;
    }
    const outcome = await runScheduleOnce({
      schedule,
      actions: actionsFor(schedule.reportKey) ?? [],
      now,
      trigger: 'TIMER',
    });
    // A deduplicated tick now carries the earlier delivery, so the presence of one
    // no longer means this tick sent anything. `lastRunAt` records a send attempt.
    if (outcome.delivery && !outcome.deduplicated) {
      await prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now },
      });
    }
    results.push({
      scheduleId: schedule.id,
      name: schedule.name,
      runKey: outcome.runKey ?? outcome.delivery?.runKey ?? null,
      status: outcome.delivery?.status ?? null,
      deduplicated: Boolean(outcome.deduplicated),
      reason: outcome.reason ?? outcome.delivery?.lastError ?? null,
    });
  }
  return { at: now.toISOString(), considered: schedules.length, results };
};
