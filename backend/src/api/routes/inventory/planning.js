// ENTITLEMENT(INVENTORY)
// Replenishment plans, their suggestions, and the reminder inbox.
//
// A plan does not move stock and does not, by itself, order anything. It
// produces a SUGGESTION, which a person accepts or edits into a request —
// unless someone has deliberately switched autoSubmit on for that plan.
//
// The scheduler in src/jobs/inventoryScheduler.js runs the same functions
// this router exposes, so "what the portal shows me" and "what the plan does
// at 6pm" cannot drift apart: there is one engine, called from two places.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../../lib/errors.js';
import { audit } from '../../../lib/audit.js';
import { requireUsableLicense } from '../../../middleware/rbac.js';
import { requireInventoryAction, loadLocationInScope, locationScopeFilter } from '../../../lib/inventory/permissions.js';
import { nextCycle, requirementKeyFor, suggestForPlan } from '../../../lib/inventory/replenish.js';
import { acknowledgeReminder } from '../../../lib/inventory/reminders.js';
import { JOB_NAME, emptyTickResult, runPlanCycle, tickInventory } from '../../../jobs/inventoryScheduler.js';
import { qtyString } from './shared.js';

const router = Router();

const PLAN_INCLUDE = {
  destinationLocation: { select: { id: true, name: true, code: true, kind: true } },
  sourceLocation: { select: { id: true, name: true, code: true, kind: true } },
  lines: { include: { item: { select: { id: true, name: true, baseUnit: true } } }, orderBy: { id: 'asc' } },
};

const publicPlan = (p) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  timezone: p.timezone,
  deliveryDays: p.deliveryDays,
  cutoffMinute: p.cutoffMinute,
  requiredByMinute: p.requiredByMinute,
  leadTimeDays: p.leadTimeDays,
  coverDays: p.coverDays,
  autoSubmit: p.autoSubmit,
  lastRunAt: p.lastRunAt,
  nextRunAt: p.nextRunAt,
  destination: p.destinationLocation,
  source: p.sourceLocation,
  lines: (p.lines ?? []).map((l) => ({
    id: l.id,
    item: l.item,
    itemId: l.itemId,
    minQty: String(l.minQty),
    targetQty: String(l.targetQty),
    safetyQty: String(l.safetyQty),
    active: l.active,
  })),
});

const minuteOfDay = z.number().int().min(0).max(1439);

const planLineSchema = z.object({
  itemId: z.string().cuid(),
  minQty: qtyString,
  targetQty: qtyString,
  safetyQty: qtyString.optional(),
  active: z.boolean().optional(),
});

const planSchema = z.object({
  name: z.string().trim().min(2).max(120),
  destinationLocationId: z.string().cuid(),
  sourceLocationId: z.string().cuid(),
  timezone: z.string().trim().min(3).max(64).default('Asia/Kolkata'),
  deliveryDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  cutoffMinute: minuteOfDay,
  requiredByMinute: minuteOfDay,
  leadTimeDays: z.number().int().min(0).max(30).default(1),
  coverDays: z.number().int().min(1).max(90).default(7),
  autoSubmit: z.boolean().default(false),
  lines: z.array(planLineSchema).min(1).max(300),
});

const assertTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date());
  } catch {
    throw badRequest(`"${tz}" is not a timezone this server recognises`);
  }
};

const loadPlanInScope = async (req, planId, need = 'view') => {
  const plan = await prisma.replenishmentPlan.findUnique({ where: { id: planId }, include: PLAN_INCLUDE });
  if (!plan || plan.companyId !== req.companyScope.id) throw notFound('Plan not found');
  // The destination is the store that receives; reaching either end is
  // enough to look, but acting needs the right at the end being acted on.
  await loadLocationInScope(prisma, req, plan.destinationLocationId, need);
  return plan;
};

router.get(
  '/plans',
  requireInventoryAction('inventory.plan.view'),
  asyncHandler(async (req, res) => {
    const scope = await locationScopeFilter(prisma, req);
    const reachable = await prisma.inventoryLocation.findMany({ where: scope, select: { id: true } });
    const ids = reachable.map((l) => l.id);

    const plans = await prisma.replenishmentPlan.findMany({
      where: {
        companyId: req.companyScope.id,
        OR: [{ destinationLocationId: { in: ids } }, { sourceLocationId: { in: ids } }],
      },
      include: PLAN_INCLUDE,
      orderBy: { name: 'asc' },
    });
    res.json({ plans: plans.map(publicPlan) });
  }),
);

router.get(
  '/plans/:planId',
  requireInventoryAction('inventory.plan.view'),
  asyncHandler(async (req, res) => {
    const plan = await loadPlanInScope(req, req.params.planId);
    const runs = await prisma.replenishmentRun.findMany({
      where: { planId: plan.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    res.json({
      plan: publicPlan(plan),
      cycle: nextCycle(plan),
      runs: runs.map((r) => ({
        id: r.id,
        cycleDate: r.cycleDate,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        outcome: r.outcome,
        attempts: r.attempts,
        lastError: r.lastError,
        detail: r.detail,
      })),
    });
  }),
);

router.post(
  '/plans',
  requireInventoryAction('inventory.plan.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = planSchema.parse(req.body);
    assertTimezone(data.timezone);

    const destination = await loadLocationInScope(prisma, req, data.destinationLocationId, 'approve');
    const source = await loadLocationInScope(prisma, req, data.sourceLocationId);
    if (destination.id === source.id) throw badRequest('A plan cannot replenish a location from itself');

    const itemIds = [...new Set(data.lines.map((l) => l.itemId))];
    if (itemIds.length !== data.lines.length) throw badRequest('An item appears more than once in this plan');
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: itemIds }, companyId: req.companyScope.id },
      select: { id: true },
    });
    if (items.length !== itemIds.length) throw badRequest('One or more items do not exist in this company');

    const plan = await prisma.replenishmentPlan
      .create({
        data: {
          companyId: req.companyScope.id,
          name: data.name,
          destinationLocationId: destination.id,
          sourceLocationId: source.id,
          timezone: data.timezone,
          deliveryDays: [...new Set(data.deliveryDays)].sort((a, b) => a - b),
          cutoffMinute: data.cutoffMinute,
          requiredByMinute: data.requiredByMinute,
          leadTimeDays: data.leadTimeDays,
          coverDays: data.coverDays,
          autoSubmit: data.autoSubmit,
          createdById: req.user.id,
          lines: {
            create: data.lines.map((l) => ({
              itemId: l.itemId,
              minQty: l.minQty,
              targetQty: l.targetQty,
              safetyQty: l.safetyQty ?? '0',
              active: l.active ?? true,
            })),
          },
        },
        include: PLAN_INCLUDE,
      })
      .catch((e) => {
        if (e?.code === 'P2002') throw conflict(`A plan called "${data.name}" already exists`);
        throw e;
      });

    const cycle = nextCycle(plan);
    const updated = cycle
      ? await prisma.replenishmentPlan.update({
          where: { id: plan.id },
          data: { nextRunAt: cycle.cutoffAt },
          include: PLAN_INCLUDE,
        })
      : plan;

    await audit(req, {
      action: 'INVENTORY_PLAN_CREATE',
      entity: 'ReplenishmentPlan',
      entityId: plan.id,
      companyId: req.companyScope.id,
      meta: { name: plan.name, lines: data.lines.length, autoSubmit: data.autoSubmit },
    });
    res.status(201).json({ plan: publicPlan(updated), cycle });
  }),
);

const planPatchSchema = planSchema.partial().omit({ lines: true }).extend({
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  lines: z.array(planLineSchema).min(1).max(300).optional(),
});

router.patch(
  '/plans/:planId',
  requireInventoryAction('inventory.plan.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = planPatchSchema.parse(req.body);
    const plan = await loadPlanInScope(req, req.params.planId, 'approve');
    if (data.timezone) assertTimezone(data.timezone);

    const updated = await prisma.$transaction(async (tx) => {
      if (data.lines) {
        // Replace the line set wholesale. The plan's numbers are settings, not
        // history — the requests it raised keep their own frozen copies.
        await tx.replenishmentPlanLine.deleteMany({ where: { planId: plan.id } });
        await tx.replenishmentPlanLine.createMany({
          data: data.lines.map((l) => ({
            planId: plan.id,
            itemId: l.itemId,
            minQty: l.minQty,
            targetQty: l.targetQty,
            safetyQty: l.safetyQty ?? '0',
            active: l.active ?? true,
          })),
        });
      }
      return tx.replenishmentPlan.update({
        where: { id: plan.id },
        data: {
          ...(data.name ? { name: data.name } : {}),
          ...(data.status ? { status: data.status } : {}),
          ...(data.timezone ? { timezone: data.timezone } : {}),
          ...(data.deliveryDays ? { deliveryDays: [...new Set(data.deliveryDays)].sort((a, b) => a - b) } : {}),
          ...(data.cutoffMinute !== undefined ? { cutoffMinute: data.cutoffMinute } : {}),
          ...(data.requiredByMinute !== undefined ? { requiredByMinute: data.requiredByMinute } : {}),
          ...(data.leadTimeDays !== undefined ? { leadTimeDays: data.leadTimeDays } : {}),
          ...(data.coverDays !== undefined ? { coverDays: data.coverDays } : {}),
          ...(data.autoSubmit !== undefined ? { autoSubmit: data.autoSubmit } : {}),
        },
        include: PLAN_INCLUDE,
      });
    });

    const cycle = updated.status === 'ACTIVE' ? nextCycle(updated) : null;
    await prisma.replenishmentPlan.update({
      where: { id: updated.id },
      data: { nextRunAt: cycle?.cutoffAt ?? null },
    });

    await audit(req, {
      action: 'INVENTORY_PLAN_UPDATE',
      entity: 'ReplenishmentPlan',
      entityId: plan.id,
      companyId: req.companyScope.id,
      meta: { name: updated.name, status: updated.status, linesReplaced: Boolean(data.lines) },
    });
    res.json({ plan: publicPlan(updated), cycle });
  }),
);

// What this plan would ask for right now, and why. Read-only: nothing is
// written, nothing is reserved, and calling it twice changes nothing.
router.get(
  '/plans/:planId/suggestion',
  requireInventoryAction('inventory.plan.view'),
  asyncHandler(async (req, res) => {
    const plan = await loadPlanInScope(req, req.params.planId);
    const suggestion = await suggestForPlan(prisma, plan, {
      rateDays: req.query.rateDays ? Number(req.query.rateDays) : 28,
    });

    let existing = null;
    if (suggestion.cycle) {
      const key = requirementKeyFor(plan, suggestion.cycle.cycleDate);
      const found = await prisma.storeRequest.findFirst({
        where: { companyId: plan.companyId, requirementKey: key },
        select: { id: true, number: true, status: true },
      });
      existing = found ?? null;
    }

    res.json({
      plan: { id: plan.id, name: plan.name, timezone: plan.timezone, autoSubmit: plan.autoSubmit },
      ...suggestion,
      lines: suggestion.lines.map(({ suggestMilli, ...rest }) => rest),
      // A request already covers this cycle. The portal shows it rather than
      // offering a button that would be refused.
      existingRequest: existing,
    });
  }),
);

// Stock-based suggestions for a whole location, independent of any plan.
// Uses the plan lines that cover this location where they exist, so a manager
// looking at one screen and a plan running at 6pm agree.
router.get(
  '/locations/:locationId/suggestions',
  requireInventoryAction('inventory.plan.view'),
  asyncHandler(async (req, res) => {
    const location = await loadLocationInScope(prisma, req, req.params.locationId);
    const plans = await prisma.replenishmentPlan.findMany({
      where: { companyId: req.companyScope.id, destinationLocationId: location.id, status: 'ACTIVE' },
      include: PLAN_INCLUDE,
    });
    if (!plans.length) {
      return res.json({
        location: { id: location.id, name: location.name },
        plans: [],
        note: 'No active replenishment plan covers this location, so there is nothing to compare stock against.',
      });
    }
    const out = [];
    for (const plan of plans) {
      const s = await suggestForPlan(prisma, plan, {});
      out.push({
        plan: { id: plan.id, name: plan.name, source: plan.sourceLocation },
        cycle: s.cycle,
        lines: s.lines.map(({ suggestMilli, ...rest }) => rest),
      });
    }
    res.json({ location: { id: location.id, name: location.name }, plans: out });
  }),
);

/* ------------------------------------------------------------ reminders */

router.get(
  '/reminders',
  requireInventoryAction('inventory.reminder.view'),
  asyncHandler(async (req, res) => {
    const { state, mine, kind } = req.query;
    const states = state ? [String(state)] : ['PENDING', 'NOTIFIED', 'ESCALATED'];

    const reminders = await prisma.inventoryReminder.findMany({
      where: {
        companyId: req.companyScope.id,
        state: { in: states },
        ...(kind ? { kind: String(kind) } : {}),
        ...(mine === 'true' ? { assigneeId: req.user.id } : {}),
      },
      include: { storeRequest: { select: { id: true, number: true, status: true } } },
      orderBy: [{ dueAt: 'asc' }],
      take: 300,
    });

    res.json({
      reminders: reminders.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        dueAt: r.dueAt,
        state: r.state,
        escalationLevel: r.escalationLevel,
        assigneeId: r.assigneeId,
        locationId: r.locationId,
        request: r.storeRequest,
        issueId: r.issueId,
        lastNotifiedAt: r.lastNotifiedAt,
        // Past its time and still nobody has picked it up.
        overdue: r.dueAt.getTime() < Date.now(),
      })),
    });
  }),
);

router.post(
  '/reminders/:reminderId/acknowledge',
  requireInventoryAction('inventory.reminder.acknowledge'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const reminder = await prisma.inventoryReminder.findUnique({ where: { id: req.params.reminderId } });
    if (!reminder || reminder.companyId !== req.companyScope.id) throw notFound('Reminder not found');
    if (reminder.state === 'OBSOLETE') throw conflict('That reminder no longer applies');
    const updated = await acknowledgeReminder(prisma, { reminderId: reminder.id, userId: req.user.id });
    res.json({ reminder: { id: updated.id, state: updated.state, acknowledgedAt: updated.acknowledgedAt } });
  }),
);

// The in-app inbox. This is the only transport that runs during development:
// nothing here sends an email or a message to a real person.
router.get(
  '/notifications',
  requireInventoryAction('inventory.reminder.view'),
  asyncHandler(async (req, res) => {
    const notifications = await prisma.inventoryNotification.findMany({
      where: { companyId: req.companyScope.id, recipientId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({
      notifications: notifications.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        channel: n.channel,
        state: n.state,
        // A delivery that failed is shown as failed. A reminder nobody
        // received must not look like one that was ignored.
        lastError: n.lastError,
        createdAt: n.createdAt,
        readAt: n.readAt,
        reminderId: n.reminderId,
      })),
      unread: notifications.filter((n) => !n.readAt).length,
    });
  }),
);

/* ------------------------------------------------------------ scheduler */

// What the background job has been doing, and whether it is still doing it.
//
// A scheduler that has silently stopped looks exactly like one with nothing to
// do, so its last tick, its last clean finish and its last error are all shown
// rather than inferred from an empty reminder list.
router.get(
  '/scheduler',
  requireInventoryAction('inventory.plan.view'),
  asyncHandler(async (req, res) => {
    const names = [JOB_NAME, `${JOB_NAME}:${req.companyScope.id}`];
    const rows = await prisma.inventorySchedulerState.findMany({ where: { name: { in: names } } });
    const now = Date.now();
    res.json({
      jobs: rows.map((r) => {
        const global = r.name === JOB_NAME;
        return {
          name: r.name,
          // The company-scoped row is this tenant's own "run now"; the global
          // one is the estate-wide pass. Both matter and they are not the
          // same job.
          scope: global ? 'GLOBAL' : 'COMPANY',
          lastTickAt: r.lastTickAt,
          lastOkAt: r.lastOkAt,
          runCount: r.runCount,
          failCount: r.failCount,
          // The estate-wide pass fails with a message naming whichever plan
          // broke, and that plan belongs to somebody else. This tenant is told
          // THAT it failed — which is what tells them their own orders may be
          // late — and not whose plan it was.
          lastError: global ? null : r.lastError,
          failing: Boolean(r.lastError),
          running: Boolean(r.lockedUntil && r.lockedUntil.getTime() > now),
        };
      }),
      // Named so a portal can say "never run" instead of drawing an empty table.
      missing: names.filter((n) => !rows.some((r) => r.name === n)),
    });
  }),
);

// Run one plan's cycle now. The same function the scheduled pass calls, so a
// manager pressing this and the 6pm run cannot produce different orders.
router.post(
  '/plans/:planId/run',
  requireInventoryAction('inventory.plan.run'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const plan = await loadPlanInScope(req, req.params.planId, 'approve');
    if (plan.status !== 'ACTIVE') throw conflict('A paused plan does not raise orders');

    const result = emptyTickResult(`plan:${plan.id}`, new Date());
    await runPlanCycle(prisma, plan, new Date(), result, { force: true });
    const run = await prisma.replenishmentRun.findFirst({
      where: { planId: plan.id },
      orderBy: { startedAt: 'desc' },
    });

    await audit(req, {
      action: 'INVENTORY_PLAN_RUN',
      entity: 'ReplenishmentPlan',
      entityId: plan.id,
      companyId: req.companyScope.id,
      meta: { outcome: run?.outcome ?? null, requestsRaised: result.requestsRaised },
    });
    res.json({
      result,
      run: run
        ? { id: run.id, cycleDate: run.cycleDate, outcome: run.outcome, attempts: run.attempts, lastError: run.lastError, detail: run.detail }
        : null,
    });
  }),
);

// Run one pass now, for this company only.
//
// Scoped to the caller's company and leased under its own name, so an owner
// pressing this cannot block — or be blocked by — the estate-wide pass, and
// cannot reach another tenant's plans at all.
router.post(
  '/scheduler/tick',
  requireInventoryAction('inventory.plan.manage'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const result = await tickInventory(prisma, { companyId: req.companyScope.id });
    await audit(req, {
      action: 'INVENTORY_SCHEDULER_TICK',
      entity: 'InventorySchedulerState',
      entityId: result.job,
      companyId: req.companyScope.id,
      meta: { plans: result.plans, reminders: result.reminders, errors: result.errors.length },
    });
    // A tick that could not claim the lease is reported as skipped, not as
    // success: the caller asked for a pass and did not get one.
    res.status(result.skipped ? 202 : 200).json({ result });
  }),
);

router.post(
  '/notifications/:notificationId/read',
  requireInventoryAction('inventory.reminder.view'),
  asyncHandler(async (req, res) => {
    const n = await prisma.inventoryNotification.findUnique({ where: { id: req.params.notificationId } });
    if (!n || n.companyId !== req.companyScope.id || n.recipientId !== req.user.id) throw notFound('Notification not found');
    const updated = await prisma.inventoryNotification.update({
      where: { id: n.id },
      data: { state: 'READ', readAt: new Date() },
    });
    res.json({ notification: { id: updated.id, state: updated.state, readAt: updated.readAt } });
  }),
);

export default router;
