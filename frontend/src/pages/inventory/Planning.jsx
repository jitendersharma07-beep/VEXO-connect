// Recurring plans, the suggestions they produce, and the chasing that follows
// — §6 on one screen.
//
// The suggestion panel exists to be argued with. Every number that went into
// "order 8 kg" is shown next to it: what is usable, what is already reserved,
// what is genuinely coming, and what is merely requested and not yet approved.
// That last distinction is the one §6 singles out — an unapproved request is
// NOT guaranteed incoming stock — so it is shown in its own column and in its
// own colour rather than being folded into "incoming".

import { useState } from 'react';
import { CalendarClock, CirclePlay, Inbox, MailWarning, Timer, TriangleAlert } from 'lucide-react';
import { PageHeader, FullScreenSpinner, Modal } from '../../components/ui.jsx';
import {
  ActionButton,
  Badge,
  Callout,
  ErrorNote,
  OwnerOnlyNote,
  RefreshButton,
  Table,
  Td,
  useInventory,
} from '../../components/inventory.jsx';
import api, { apiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/pos.js';
import {
  fmtDeliveryDays,
  fmtMinuteOfDay,
  fmtQty,
  isInventoryOwner,
  REMINDER_STATE_STYLES,
  reminderKindLabel,
} from '../../lib/inventory.js';

const RUN_OUTCOME_LABEL = {
  COMPLETED: 'Raised an order',
  SKIPPED_NOTHING_NEEDED: 'Nothing needed ordering',
  SKIPPED_ALREADY_COVERED: 'An order already covers this delivery',
  FAILED: 'Failed',
};

const RUN_OUTCOME_STYLES = {
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  SKIPPED_NOTHING_NEEDED: 'bg-slate-100 text-slate-600',
  SKIPPED_ALREADY_COVERED: 'bg-sky-100 text-sky-700',
  FAILED: 'bg-red-100 text-red-700',
};

// Delivery states, in the words someone reads rather than the enum's.
//
// "Not delivered" and "Given up" are deliberately different sentences. The
// first is a message still being retried; the second is one that will never
// arrive, and telling someone their reminder is still in flight when it is not
// is the failure this whole inbox exists to prevent.
const NOTIFY_STATE_LABEL = {
  QUEUED: 'Sending',
  DELIVERED: 'Delivered',
  FAILED: 'Not delivered',
  UNDELIVERABLE: 'Given up',
  READ: 'Read',
};

const NOTIFY_STATE_STYLES = {
  QUEUED: 'bg-slate-100 text-slate-600',
  DELIVERED: 'bg-emerald-100 text-emerald-700',
  FAILED: 'bg-red-100 text-red-700',
  // Amber, not red: red is the thing that still needs chasing. This one has
  // stopped, and it needs a different action — fix the contact details —
  // rather than more of the same waiting.
  UNDELIVERABLE: 'bg-amber-100 text-amber-800',
  READ: 'bg-slate-100 text-slate-600',
};

/* -------------------------------------------------------------- suggestion */

function SuggestionPanel({ planId, onClose, onRan, canRun }) {
  const { data, error, loading, reload } = useInventory(`/inventory/plans/${planId}/suggestion`, { skip: !planId });
  const [runError, setRunError] = useState('');
  const [runResult, setRunResult] = useState(null);

  const run = async () => {
    setRunError('');
    try {
      const res = await api.post(`/inventory/plans/${planId}/run`, {});
      setRunResult(res.data);
      await reload();
      await onRan();
    } catch (err) {
      setRunError(apiError(err));
    }
  };

  return (
    <Modal open={Boolean(planId)} title={data ? `Suggestion — ${data.plan.name}` : 'Suggestion'} onClose={onClose} wide>
      {loading && !data ? <div className="py-6 text-center text-sm text-slate-400">Working it out…</div> : null}
      <ErrorNote message={runError || error} />
      {data ? (
        <div className="space-y-4">
          {data.cycle ? (
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="font-semibold text-pos-ink">
                For delivery on {fmtDate(data.cycle.cycleDate)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Ordering closes {fmtDateTime(data.cycle.cutoffAt)} · wanted by {fmtDateTime(data.cycle.requiredBy)} ·
                plan timezone {data.plan.timezone}
              </div>
            </div>
          ) : (
            <Callout tone="slate" icon={null}>
              This plan has no next delivery cycle — it has no delivery days left to run on.
            </Callout>
          )}

          {data.existingRequest ? (
            <Callout tone="sky" icon={null} title={`Request ${data.existingRequest.number} already covers this delivery`}>
              Running the plan again will not raise a second one. The requirement is held unique per
              company, so the scheduled pass, a retry after a crash and this button all land on the same
              order.
            </Callout>
          ) : null}

          {data.cappedByCapacity ? (
            <Callout tone="amber" title="Scaled down to fit the room">
              The full suggestion is more than this location can hold ({fmtQty(data.headroom)} of headroom),
              so every line has been scaled proportionally. The scaling is applied to the suggestion, not
              hidden inside it.
            </Callout>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full min-w-[46rem] text-xs">
              <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Available</th>
                  <th className="px-3 py-2 text-right">In transit</th>
                  <th className="px-3 py-2 text-right" title="Approved and not yet dispatched. This is counted as incoming.">
                    Approved
                  </th>
                  <th className="px-3 py-2 text-right" title="Requested but NOT yet approved. Deliberately not counted as incoming stock.">
                    Only requested
                  </th>
                  <th className="px-3 py-2 text-right">Uses per day</th>
                  <th className="px-3 py-2 text-right">At delivery</th>
                  <th className="px-3 py-2 text-right">Min / target</th>
                  <th className="px-3 py-2 text-right">Suggest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.lines.map((l) => (
                  <tr key={l.itemId} className={l.reason.triggered ? 'bg-amber-50/60' : ''}>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-pos-ink">{l.item?.name ?? l.itemId}</div>
                      {l.suppressed === 'ALREADY_REQUESTED' ? (
                        <div className="text-slate-400">already asked for — not re-ordered</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.reason.available)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-700">{fmtQty(l.reason.inTransit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sky-700">{fmtQty(l.reason.approvedNotDispatched)}</td>
                    {/* §6: an unapproved request is not guaranteed incoming
                        stock. Shown, so the manager knows it exists — and in
                        the "not counted" colour, because the suggestion above
                        has not counted it. */}
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{fmtQty(l.reason.awaitingApproval)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.reason.dailyConsumption === null ? (
                        <span className="text-slate-300" title="Never measured — different from a measured zero.">
                          not measured
                        </span>
                      ) : (
                        fmtQty(l.reason.dailyConsumption)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.reason.projectedAtDelivery)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {fmtQty(l.reason.minQty)} / {fmtQty(l.reason.targetQty)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-pos-ink">
                      {fmtQty(l.suggestedQty)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400">
            "Only requested" is stock somebody has asked for and nobody has approved. It is shown because
            it explains why a colleague may be surprised by this order, and it is not subtracted from the
            suggestion because an unapproved request is not stock that is coming.
          </p>

          {runResult ? (
            <Callout tone={runResult.run?.outcome === 'FAILED' ? 'red' : 'sky'} icon={null} title="Run finished">
              {/* "Nothing needed ordering" and "did not run" are different
                  outcomes and are labelled differently. A run that skipped is
                  still a run, and its row proves the plan was examined. */}
              <Badge
                map={RUN_OUTCOME_STYLES}
                value={runResult.run?.outcome}
                label={RUN_OUTCOME_LABEL[runResult.run?.outcome] || runResult.run?.outcome || 'No run row'}
              />{' '}
              · {runResult.result.requestsRaised} request{runResult.result.requestsRaised === 1 ? '' : 's'} raised ·{' '}
              attempt {runResult.run?.attempts ?? 1}
              {runResult.run?.lastError ? <div className="mt-1 text-red-700">{runResult.run.lastError}</div> : null}
            </Callout>
          ) : null}

          {canRun ? (
            <ActionButton className="btn-orange w-full" onClick={run}>
              <CirclePlay className="h-4 w-4" /> Raise this order now
            </ActionButton>
          ) : (
            <OwnerOnlyNote what="run a plan for a store they can reach" />
          )}
        </div>
      ) : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------- reminders */

function Reminders({ onChanged }) {
  const { data, error, loading, reload } = useInventory('/inventory/reminders');
  const [ackError, setAckError] = useState('');

  const ack = async (id) => {
    setAckError('');
    try {
      await api.post(`/inventory/reminders/${id}/acknowledge`, {});
      await reload();
      await onChanged();
    } catch (err) {
      setAckError(apiError(err));
      throw err;
    }
  };

  const reminders = data?.reminders ?? [];
  const overdue = reminders.filter((r) => r.overdue);
  const escalated = reminders.filter((r) => r.state === 'ESCALATED');

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Reminders</h2>
        <RefreshButton loading={loading} onClick={reload} />
      </div>

      {escalated.length ? (
        <Callout tone="red" icon={TriangleAlert} title={`${escalated.length} reminder${escalated.length === 1 ? '' : 's'} escalated`}>
          Nobody acted on these in time, so they were raised to the next person. A reminder climbs a fixed
          number of levels and then stops climbing rather than notifying forever.
        </Callout>
      ) : null}

      <ErrorNote message={ackError || error} />

      <Table
        head={['What', 'Due', 'State', 'About', { key: 'a', label: '', right: true }]}
        empty="Nothing is being chased"
        emptyNote="Reminders appear when a cutoff is near, a decision is overdue, a delivery is late, or a batch is about to expire."
      >
        {reminders.map((r) => (
          <tr key={r.id} className={r.overdue ? 'bg-amber-50/50' : ''}>
            <Td>
              <div className="font-semibold text-pos-ink">{reminderKindLabel(r.kind)}</div>
              <div className="max-w-[22rem] text-xs text-slate-500">{r.title}</div>
              {r.body ? <div className="max-w-[22rem] text-xs text-slate-400">{r.body}</div> : null}
            </Td>
            <Td className="text-xs">
              <div className={r.overdue ? 'font-semibold text-amber-700' : 'text-slate-600'}>{fmtDateTime(r.dueAt)}</div>
              {r.overdue ? <div className="text-amber-700">overdue</div> : null}
            </Td>
            <Td>
              <Badge map={REMINDER_STATE_STYLES} value={r.state} />
              {r.escalationLevel > 0 ? (
                <div className="mt-1 text-xs text-red-600">escalated {r.escalationLevel}×</div>
              ) : null}
            </Td>
            <Td className="text-xs text-slate-600">
              {r.request ? `${r.request.number} (${r.request.status})` : r.locationId ? 'a location' : '—'}
            </Td>
            <Td right>
              <ActionButton className="btn-ghost text-xs" onClick={() => ack(r.id)}>
                Acknowledge
              </ActionButton>
            </Td>
          </tr>
        ))}
      </Table>
      {overdue.length ? (
        <p className="mt-2 text-xs text-slate-400">
          Acknowledging records that a person has seen it. A reminder also stops on its own the moment the
          thing it is about happens — an approved request does not keep being chased for approval.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the inbox */

// §6 again: "failed notification delivery must be visible". A message that did
// not get through is shown as failed, with the error, rather than disappearing
// — otherwise a reminder nobody received looks exactly like one that was
// ignored, and the wrong person gets blamed.
function NotificationInbox() {
  const { data, error, loading, reload } = useInventory('/inventory/notifications');
  const notifications = data?.notifications ?? [];
  // Counted apart, because they ask for different things. A failure is still
  // being retried and may yet arrive; an abandonment will not, and no amount
  // of waiting changes it — somebody has to correct the contact details.
  const failed = notifications.filter((n) => n.state === 'FAILED');
  const abandoned = notifications.filter((n) => n.state === 'UNDELIVERABLE');

  const markRead = async (id) => {
    await api.post(`/inventory/notifications/${id}/read`, {});
    await reload();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
          <Inbox className="h-4 w-4" /> My inbox
          {data?.unread ? <span className="badge bg-pos-royal/10 text-pos-royal">{data.unread} unread</span> : null}
        </h2>
        <RefreshButton loading={loading} onClick={reload} />
      </div>

      {failed.length ? (
        <Callout tone="red" icon={MailWarning} title={`${failed.length} message${failed.length === 1 ? '' : 's'} could not be delivered`}>
          These were retried and still did not get through. They are kept and shown here so the reminder
          behind them is not silently lost.
        </Callout>
      ) : null}

      {abandoned.length ? (
        <Callout
          tone="amber"
          icon={MailWarning}
          title={`${abandoned.length} message${abandoned.length === 1 ? ' will' : 's will'} never arrive`}
        >
          Delivery was refused for a reason that retrying cannot fix, so we stopped trying. The reason is
          on each message below. Until it is corrected, the person these were addressed to is not being
          told anything.
        </Callout>
      ) : null}

      <ErrorNote message={error} />

      <Table head={['Message', 'Channel', 'State', 'When', { key: 'a', label: '', right: true }]} empty="No messages">
        {notifications.map((n) => (
          <tr key={n.id} className={n.readAt ? '' : 'bg-sky-50/40'}>
            <Td>
              <div className="font-semibold text-pos-ink">{n.title}</div>
              <div className="max-w-[24rem] text-xs text-slate-500">{n.body}</div>
              {n.lastError ? <div className="mt-1 text-xs font-semibold text-red-600">{n.lastError}</div> : null}
            </Td>
            <Td className="text-xs text-slate-500">{n.channel}</Td>
            <Td>
              <span className={`badge ${NOTIFY_STATE_STYLES[n.state] ?? 'bg-slate-100 text-slate-600'}`}>
                {NOTIFY_STATE_LABEL[n.state] ?? n.state}
              </span>
              {/* How many goes it took. Shown only once it is more than one,
                  because "1 attempt" on every delivered row is noise — but a
                  message that took four is a transport worth looking at. */}
              {n.attempts > 1 ? (
                <div className="mt-1 text-[11px] text-slate-400">{n.attempts} attempts</div>
              ) : null}
            </Td>
            <Td className="text-xs text-slate-500">{fmtDateTime(n.createdAt)}</Td>
            <Td right>
              {n.readAt ? (
                <span className="text-xs text-slate-300">read</span>
              ) : (
                <ActionButton className="btn-ghost text-xs" onClick={() => markRead(n.id)}>
                  Mark read
                </ActionButton>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

/* --------------------------------------------------------------------- page */

export default function InventoryPlanning() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const { data, error, loading, reload } = useInventory('/inventory/plans');
  const sched = useInventory('/inventory/scheduler');
  const [suggestFor, setSuggestFor] = useState(null);
  const [tickResult, setTickResult] = useState(null);
  const [tickError, setTickError] = useState('');

  const tick = async () => {
    setTickError('');
    setTickResult(null);
    try {
      const res = await api.post('/inventory/scheduler/tick', {});
      setTickResult(res.data.result);
      await Promise.all([reload(), sched.reload()]);
    } catch (err) {
      setTickError(apiError(err));
    }
  };

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || 'Could not load plans'} />;

  const plans = data.plans ?? [];
  const schedulerJobs = sched.data?.jobs ?? [];
  const neverRan = (sched.data?.missing ?? []).length > 0;

  return (
    <div>
      <PageHeader
        title="Planning and reminders"
        subtitle="What each store should be ordering, and who is being chased for it"
        actions={
          <div className="flex gap-2">
            {owner ? (
              <ActionButton className="btn-ghost" onClick={tick}>
                <Timer className="h-4 w-4" /> Run a pass now
              </ActionButton>
            ) : null}
            <RefreshButton
              loading={loading}
              onClick={() => {
                reload();
                sched.reload();
              }}
            />
          </div>
        }
      />

      <ErrorNote message={tickError || error} />

      {tickResult ? (
        <Callout tone={tickResult.skipped ? 'amber' : 'sky'} icon={null} title={tickResult.skipped ? 'That pass did not run' : 'Pass finished'}>
          {tickResult.skipped
            ? 'Another pass already holds the job. Nothing was done, and this is reported as skipped rather than as success.'
            : `${tickResult.plans} plan(s) examined · ${tickResult.requestsRaised} order(s) raised · ${tickResult.reminders} reminder(s) raised · ${tickResult.notified} notified · ${tickResult.escalated} escalated · ${tickResult.redelivered} redelivered`}
          {tickResult.errors?.length ? (
            <div className="mt-1 font-semibold text-red-700">{tickResult.errors.join('; ')}</div>
          ) : null}
        </Callout>
      ) : null}

      {neverRan ? (
        <Callout tone="amber" icon={Timer} title="The background scheduler has no record of running">
          Until it runs, plans below will not raise their own orders and nothing will be chased
          automatically. Everything here still works by hand.
        </Callout>
      ) : schedulerJobs.some((j) => j.failing) ? (
        <Callout tone="red" icon={Timer} title="The last scheduled pass did not finish cleanly">
          Orders a plan should have raised may be late. Check the run history on the plans below.
        </Callout>
      ) : null}

      <Table
        head={[
          'Plan',
          'Route',
          'Delivery days',
          { key: 'c', label: 'Cutoff', help: 'In the plan timezone — a cutoff is a local time, not a UTC instant.' },
          'Next pass',
          'Last pass',
          { key: 'a', label: '', right: true },
        ]}
        empty="No replenishment plans"
        emptyNote="A plan says which items a store keeps, how much of each, and which days they arrive."
      >
        {plans.map((p) => (
          <tr key={p.id}>
            <Td>
              <div className="font-semibold text-pos-ink">{p.name}</div>
              <div className="text-xs text-slate-400">
                {p.lines.length} item{p.lines.length === 1 ? '' : 's'} ·{' '}
                {p.autoSubmit ? 'submits for approval automatically' : 'raises a draft for a person to submit'} ·{' '}
                <span className={p.status === 'ACTIVE' ? 'text-emerald-600' : 'text-slate-400'}>{p.status}</span>
              </div>
            </Td>
            <Td className="text-xs text-slate-600">
              {p.source?.name} to {p.destination?.name}
            </Td>
            <Td className="text-xs text-slate-600">{fmtDeliveryDays(p.deliveryDays)}</Td>
            <Td className="text-xs">
              <div className="font-semibold text-slate-700">{fmtMinuteOfDay(p.cutoffMinute)}</div>
              <div className="text-slate-400">{p.timezone}</div>
            </Td>
            <Td className="text-xs text-slate-600">{fmtDateTime(p.nextRunAt)}</Td>
            <Td className="text-xs text-slate-600">{fmtDateTime(p.lastRunAt)}</Td>
            <Td right>
              <button type="button" className="btn-ghost text-xs" onClick={() => setSuggestFor(p.id)}>
                <CalendarClock className="h-3.5 w-3.5" /> What should we order
              </button>
            </Td>
          </tr>
        ))}
      </Table>

      {!owner ? <OwnerOnlyNote what="create or change a replenishment plan" /> : null}

      <div className="mt-8">
        <Reminders onChanged={reload} />
      </div>

      <div className="mt-8">
        <NotificationInbox />
      </div>

      <SuggestionPanel
        planId={suggestFor}
        canRun
        onClose={() => setSuggestFor(null)}
        onRan={async () => {
          await reload();
          await sched.reload();
        }}
      />
    </div>
  );
}
