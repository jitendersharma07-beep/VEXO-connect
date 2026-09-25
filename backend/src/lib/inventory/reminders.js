// Reminders: who has to do what, by when, and who hears about it if they don't.
//
// A reminder is derived state, not an event log. Callers raise the same
// reminder as often as they like — the (companyId, dedupeKey) unique index
// collapses the repeats into one live row — and mark it OBSOLETE when the
// thing it was about has happened. That is what makes "recreate on every
// tick" safe to run every minute for a year, and it is why a status change
// stops the chasing without anyone remembering to cancel anything.
//
// Nothing here throws into a caller's request path. A reminder that cannot be
// written must not undo a dispatch that has already moved stock, so failures
// are logged and recorded, never propagated. The one thing that is NOT
// allowed is silence: a notification that could not be delivered is stored
// FAILED with its error, so the portal can show it.

import { logger } from '../logger.js';
import { attemptDelivery, channelFor } from './notifyTransport.js';

const OWNER = 'CUSTOMER_OWNER';
const MANAGER = 'BRANCH_MANAGER';

// Per kind: which grant makes someone responsible, how long after the due
// time we start escalating, and the default title.
const KIND_RULE = Object.freeze({
  SUBMISSION_CUTOFF: { need: null, escalateAfterMs: 3600000, title: 'Order cutoff approaching' },
  PENDING_APPROVAL: { need: 'canApprove', escalateAfterMs: 3600000, title: 'Request waiting for a decision' },
  DISPATCH_DUE: { need: 'canDispatch', escalateAfterMs: 3600000, title: 'Stock due to be dispatched' },
  DELIVERY_OVERDUE: { need: 'canDispatch', escalateAfterMs: 0, title: 'Delivery overdue' },
  RECEIPT_PENDING: { need: 'canReceive', escalateAfterMs: 7200000, title: 'Transfer waiting to be received' },
  UNRESOLVED_SHORTAGE: { need: 'canReceive', escalateAfterMs: 86400000, title: 'Shortage or damage unresolved' },
  BATCH_EXPIRING: { need: null, escalateAfterMs: 86400000, title: 'Batch expiring' },
  OPENED_CONTAINER_EXPIRING: { need: null, escalateAfterMs: 43200000, title: 'Opened container expiring' },
});

export const REMINDER_KINDS = Object.freeze(Object.keys(KIND_RULE));

// One live reminder per kind per subject. When a kind recurs on a schedule —
// a weekly submission cutoff, say — the caller passes the CYCLE as the
// subject, not the plan, so each week gets its own row and last week's
// silence stays on the record.
const dedupeKeyFor = (kind, subjectType, subjectId) => `${kind}:${subjectType}:${subjectId}`;

const subjectOf = ({ issueId, requestId, subjectType, subjectId }) => {
  if (subjectType && subjectId) return { subjectType, subjectId };
  if (issueId) return { subjectType: 'StoreRequestIssue', subjectId: issueId };
  if (requestId) return { subjectType: 'StoreRequest', subjectId: requestId };
  return null;
};

// Everyone who could actually do the thing, most specific first.
//
// A grant with the right flag is the strongest signal. A manager pinned to
// the location's branch is the next. Owners are the backstop, because a
// reminder with nobody on it is a reminder nobody reads.
export const responsibleUsers = async (client, { companyId, locationId, need }) => {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (u && !seen.has(u.id)) {
      seen.add(u.id);
      out.push(u);
    }
  };

  if (locationId) {
    const grants = await client.inventoryLocationAccess.findMany({
      where: { locationId, ...(need ? { [need]: true } : {}) },
      include: { user: { select: { id: true, role: true, status: true, companyId: true } } },
    });
    for (const g of grants) {
      if (g.user?.status === 'ACTIVE' && g.user.companyId === companyId) push(g.user);
    }

    const location = await client.inventoryLocation.findUnique({
      where: { id: locationId },
      select: { branchId: true },
    });
    if (location?.branchId) {
      const managers = await client.posUser.findMany({
        where: { companyId, branchId: location.branchId, role: MANAGER, status: 'ACTIVE' },
        select: { id: true, role: true },
      });
      managers.forEach(push);
    }
  }

  const owners = await client.posUser.findMany({
    where: { companyId, role: OWNER, status: 'ACTIVE' },
    select: { id: true, role: true },
  });
  owners.forEach(push);

  return out;
};

// Write the notification, then try to deliver it, then record what happened.
//
// The row is created BEFORE the attempt and updated after, rather than being
// written once with the outcome already known. An external transport is a
// network call that can hang or crash the process mid-flight, and a row that
// exists in QUEUED is recoverable by the scheduler's retry pass, while an
// attempt made before there is anything to update is simply lost. The extra
// UPDATE buys the difference between "we will try this again" and "nobody
// will ever know this was supposed to be sent".
const queueNotification = async (client, { companyId, reminderId, recipientId, title, body }) => {
  const channel = channelFor();
  const row = await client.inventoryNotification.create({
    data: { companyId, reminderId, recipientId, channel, title, body, state: 'QUEUED', attempts: 0 },
  });

  const outcome = await attemptDelivery({
    notificationId: row.id,
    companyId,
    recipientId,
    channel,
    title,
    body,
    attempt: 1,
  });

  await client.inventoryNotification.update({
    where: { id: row.id },
    data: { ...outcome, attempts: 1 },
  });
};

// Raise (or refresh) a reminder. Safe to call repeatedly.
//
// Returns the reminder, or null if it could not be written — callers treat
// the null as information, never as a reason to abandon what they were doing.
export const raiseReminder = async (client, opts) => {
  const {
    companyId,
    kind,
    requestId = null,
    issueId = null,
    locationId = null,
    dueAt,
    assigneeId = null,
    subject,
    body = null,
  } = opts;

  try {
    const rule = KIND_RULE[kind];
    if (!rule) throw new Error(`Unknown reminder kind: ${kind}`);
    const subj = subjectOf(opts);
    if (!subj) throw new Error(`Reminder ${kind} has no subject`);

    const due = dueAt ? new Date(dueAt) : new Date();
    const dedupeKey = dedupeKeyFor(kind, subj.subjectType, subj.subjectId);
    const escalateAt = new Date(due.getTime() + rule.escalateAfterMs);

    let assignee = assigneeId;
    if (!assignee) {
      const candidates = await responsibleUsers(client, { companyId, locationId, need: rule.need });
      assignee = candidates[0]?.id ?? null;
    }

    const title = rule.title;
    const text = body ?? subject ?? title;

    const existing = await client.inventoryReminder.findUnique({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
    });

    if (existing) {
      // A reminder that was obsolete and is being raised again means the
      // subject came back — a request reopened, a shortage re-recorded. It
      // starts chasing from zero rather than resuming a stale escalation.
      const revived = existing.state === 'OBSOLETE';
      const updated = await client.inventoryReminder.update({
        where: { id: existing.id },
        data: {
          dueAt: due,
          escalateAt,
          title,
          body: text,
          assigneeId: assignee,
          storeRequestId: requestId,
          issueId,
          locationId,
          ...(revived
            ? { state: 'PENDING', escalationLevel: 0, obsoletedAt: null, obsoleteReason: null, acknowledgedAt: null, acknowledgedById: null }
            : {}),
        },
      });
      return updated;
    }

    const created = await client.inventoryReminder.create({
      data: {
        companyId,
        kind,
        dedupeKey,
        subjectType: subj.subjectType,
        subjectId: subj.subjectId,
        storeRequestId: requestId,
        issueId,
        locationId,
        dueAt: due,
        escalateAt,
        assigneeId: assignee,
        title,
        body: text,
        state: assignee ? 'NOTIFIED' : 'PENDING',
        lastNotifiedAt: assignee ? new Date() : null,
      },
    });

    if (assignee) {
      await queueNotification(client, { companyId, reminderId: created.id, recipientId: assignee, title, body: text });
    }
    return created;
  } catch (err) {
    logger.error({ err, kind, companyId }, 'inventory: failed to raise reminder');
    return null;
  }
};

// Stop chasing. Obsolete reminders are kept, not deleted, so "why did nobody
// chase this" has an answer months later.
export const dropObsoleteReminders = async (client, { requestId = null, issueId = null, kinds = null, reason = 'Subject moved on' } = {}) => {
  try {
    if (!requestId && !issueId) return 0;
    const where = {
      state: { in: ['PENDING', 'NOTIFIED', 'ESCALATED'] },
      ...(requestId ? { storeRequestId: requestId } : {}),
      ...(issueId ? { issueId } : {}),
      ...(kinds ? { kind: { in: kinds } } : {}),
    };
    const result = await client.inventoryReminder.updateMany({
      where,
      data: { state: 'OBSOLETE', obsoletedAt: new Date(), obsoleteReason: reason },
    });
    return result.count;
  } catch (err) {
    logger.error({ err, requestId, issueId }, 'inventory: failed to drop reminders');
    return 0;
  }
};

// Notify the assignee of a reminder that has not been told yet. Used by the
// scheduler for reminders raised without an assignee — ones that had nobody
// to tell at the time.
export const notifyReminder = async (client, reminder) => {
  if (!reminder.assigneeId) return false;
  await queueNotification(client, {
    companyId: reminder.companyId,
    reminderId: reminder.id,
    recipientId: reminder.assigneeId,
    title: reminder.title,
    body: reminder.body,
  });
  await client.inventoryReminder.update({
    where: { id: reminder.id },
    data: { state: reminder.state === 'PENDING' ? 'NOTIFIED' : reminder.state, lastNotifiedAt: new Date() },
  });
  return true;
};

// One rung up. Level 1 is everyone else who can do the job at that location,
// level 2 and beyond is the owner. Each step is recorded on the reminder, so
// an escalation that happened and an escalation that was claimed are
// distinguishable.
export const escalateReminder = async (client, reminder) => {
  try {
    const rule = KIND_RULE[reminder.kind] ?? { need: null, escalateAfterMs: 3600000 };
    const level = reminder.escalationLevel + 1;
    const candidates = await responsibleUsers(client, {
      companyId: reminder.companyId,
      locationId: reminder.locationId,
      need: rule.need,
    });
    const targets = level === 1
      ? candidates.filter((c) => c.id !== reminder.assigneeId)
      : candidates.filter((c) => c.role === OWNER && c.id !== reminder.assigneeId);

    for (const t of targets) {
      await queueNotification(client, {
        companyId: reminder.companyId,
        reminderId: reminder.id,
        recipientId: t.id,
        title: `Escalated: ${reminder.title}`,
        body: reminder.body,
      });
    }

    await client.inventoryReminder.update({
      where: { id: reminder.id },
      data: {
        state: 'ESCALATED',
        escalationLevel: level,
        lastNotifiedAt: new Date(),
        // Beyond the owner there is nowhere left to go, so stop rather than
        // notify the same person forever.
        escalateAt: level >= 2 ? null : new Date(Date.now() + rule.escalateAfterMs),
      },
    });
    return targets.length;
  } catch (err) {
    logger.error({ err, reminderId: reminder.id }, 'inventory: failed to escalate reminder');
    return 0;
  }
};

export const acknowledgeReminder = async (client, { reminderId, userId }) =>
  client.inventoryReminder.update({
    where: { id: reminderId },
    data: { state: 'ACKNOWLEDGED', acknowledgedById: userId, acknowledgedAt: new Date() },
  });
