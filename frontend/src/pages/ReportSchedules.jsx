// LANE reporting — /reporting/schedules, reports that arrive without being asked
// for, and the approved list of addresses they may go to.
//
// Two facts sit at the top of this screen rather than in a README, because they
// are the two a person configuring a schedule cannot see from the form and would
// otherwise learn by being surprised:
//
//   1. Whether anything fires on its own in this deployment. A schedule marked
//      ACTIVE in a build with the scheduler switched off will sit there forever,
//      and a screen that showed only "Active" would be lying by omission.
//   2. What a delivery actually does. This build writes a spool file; it has no
//      mail transport, and only addresses marked as test addresses are written to
//      at all. "Sent" must not be read as "emailed to my accountant".
//
// A new schedule is born DRAFT — the server insists on it — so nobody mails a
// company's figures while deciding whether they meant to.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Mail, Play, Plus } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';
import {
  CADENCE_LABELS,
  DELIVERY_STATUS_STYLES,
  FORMAT_LABELS,
  REPORT_LABELS,
  SCHEDULE_STATE_STYLES,
  cadenceSentence,
  fmtInt,
  fmtWhen,
  hhmm,
  weekdayName,
} from '../lib/reporting.js';

const STATE_ACTIONS = {
  DRAFT: [{ to: 'ACTIVE', label: 'Activate' }],
  ACTIVE: [{ to: 'PAUSED', label: 'Pause' }],
  PAUSED: [{ to: 'ACTIVE', label: 'Resume' }, { to: 'DRAFT', label: 'Back to draft' }],
};

const blankSchedule = (timezone) => ({
  name: '',
  reportKey: 'sales',
  cadence: 'DAILY',
  format: 'CSV',
  sendAt: '06:00',
  timezone,
  weekday: 1,
  dayOfMonth: 1,
  storeIds: [],
  recipientIds: [],
});

export default function ReportSchedules() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;
  const mayWrite = can('report.schedule.write');

  const [data, setData] = useState(null);
  const [recipients, setRecipients] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [settings, setSettings] = useState(null);
  const [stores, setStores] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const [deliveries, setDeliveries] = useState(null);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setError('');
    try {
      const [s, r, c] = await Promise.all([
        api.get('/reporting/schedules'),
        api.get('/reporting/recipients'),
        api.get('/reporting/catalog'),
      ]);
      setData(s.data);
      setRecipients(r.data);
      setCatalog(c.data);
      // The stores a schedule may name are the stores this caller can reach, and
      // the server is the only thing that knows which those are. Asking the
      // dashboard for them rather than listing branches keeps the form's options
      // and the server's refusal in agreement.
      const dash = await api.get('/reporting/dashboard', { params: { preset: 'TODAY' } });
      setStores(dash.data?.scope?.stores ?? []);
      setSettings({ timezone: dash.data?.period?.timezone ?? 'Asia/Kolkata' });
    } catch (err) {
      setError(apiError(err, 'Could not load the schedules'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atc, atcScope?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const scheduleReports = (catalog?.reports ?? []).filter((r) => r.buildable);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const [h, m] = form.sendAt.split(':').map(Number);
      const body = {
        name: form.name.trim(),
        reportKey: form.reportKey,
        cadence: form.cadence,
        format: form.format,
        sendAtMinutes: (Number.isFinite(h) ? h : 6) * 60 + (Number.isFinite(m) ? m : 0),
        timezone: form.timezone,
        storeIds: form.storeIds,
        recipientIds: form.recipientIds,
        ...(form.cadence === 'WEEKLY' ? { weekday: Number(form.weekday) } : {}),
        ...(form.cadence === 'MONTHLY' ? { dayOfMonth: Number(form.dayOfMonth) } : {}),
      };
      if (form.id) await api.patch(`/reporting/schedules/${form.id}`, body);
      else await api.post('/reporting/schedules', body);
      setForm(null);
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not save the schedule'));
    } finally {
      setBusy(false);
    }
  };

  const setState = async (row, to) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/reporting/schedules/${row.id}/state`, { state: to });
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not change the state'));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (row) => {
    setBusy(true);
    setError('');
    try {
      const { data: result } = await api.post(`/reporting/schedules/${row.id}/run`);
      // The run result carries the outcome of this attempt; the history carries
      // every attempt. Both are shown, because "it says SENT" and "it has sent
      // once" are different claims and only the second one survives a retry.
      const { data: history } = await api.get(`/reporting/schedules/${row.id}/deliveries`);
      setDeliveries({ schedule: row, result, ...history });
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not run the schedule'));
    } finally {
      setBusy(false);
    }
  };

  const openDeliveries = async (row) => {
    setError('');
    try {
      const { data: body } = await api.get(`/reporting/schedules/${row.id}/deliveries`);
      setDeliveries({ schedule: row, ...body });
    } catch (err) {
      setError(apiError(err, 'Could not load the delivery history'));
    }
  };

  const addRecipient = async (payload) => {
    setBusy(true);
    setError('');
    try {
      await api.post('/reporting/recipients', payload);
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not approve that address'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/reporting/recipients/${row.id}/revoke`);
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not revoke that address'));
    } finally {
      setBusy(false);
    }
  };

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Scheduled reports" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={CalendarClock}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Scheduled reports"
        subtitle="Reports that arrive on their own, and the addresses they may go to."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost min-h-[38px] text-sm" onClick={() => navigate('/reporting')}>
              <ArrowLeft className="mr-1.5 inline h-4 w-4" />
              Dashboard
            </button>
            {mayWrite ? (
              <button
                type="button"
                className="btn-primary min-h-[38px] text-sm"
                data-testid="new-schedule"
                onClick={() => setForm(blankSchedule(settings?.timezone ?? 'Asia/Kolkata'))}
              >
                <Plus className="mr-1.5 inline h-4 w-4" />
                New schedule
              </button>
            ) : null}
          </div>
        }
      />

      {error ? <ErrorNote message={error} /> : null}

      {/* The two facts the form cannot show. Both are about whether a schedule
          does anything, which is not something to discover by waiting. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {data?.scheduler ? (
          <div
            className={`card p-4 ${data.scheduler.enabled ? '' : 'border-l-4 border-l-amber-400'}`}
            data-testid="scheduler-state"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Automatic sending
            </div>
            <div className="mt-1 text-sm font-bold text-pos-ink">
              {data.scheduler.enabled ? 'On in this deployment' : 'Off in this deployment'}
            </div>
            <p className="mt-1 text-xs text-slate-500">{data.scheduler.note}</p>
          </div>
        ) : null}
        {recipients?.delivery ? (
          <div className="card border-l-4 border-l-amber-400 p-4" data-testid="transport-state">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              How a delivery is carried
            </div>
            <div className="mt-1 text-sm font-bold text-pos-ink">
              {recipients.delivery.transport}
            </div>
            <p className="mt-1 text-xs text-slate-500">{recipients.delivery.note}</p>
          </div>
        ) : null}
      </div>

      {data && !data.schedules.length ? (
        <div className="mt-4">
          <EmptyState
            icon={CalendarClock}
            title="No schedule yet"
            note={
              mayWrite
                ? 'A new schedule is created as a draft and sends nothing until it is activated.'
                : 'Finance and the company owner can create schedules.'
            }
          />
        </div>
      ) : null}

      {(data?.schedules ?? []).map((s) => (
        <div key={s.id} className="card mt-4 p-5" data-testid={`schedule-${s.name}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-pos-ink">{s.name}</h2>
                <span className={`badge ${SCHEDULE_STATE_STYLES[s.state]}`}>{s.state}</span>
                <span className="badge bg-slate-100 text-slate-600">{FORMAT_LABELS[s.format?.toLowerCase()] ?? s.format}</span>
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {REPORT_LABELS[s.reportKey] ?? s.reportKey} · {cadenceSentence(s)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {/* Empty means "every store the owner can reach at send time",
                    which is a different promise from a fixed list and has to be
                    said in words. */}
                {s.allAuthorisedStores
                  ? 'Every store the schedule’s owner can reach when it sends'
                  : s.stores.map((st) => st.name ?? st.id).join(', ')}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {s.recipients.length
                  ? s.recipients
                      .map(
                        (r) =>
                          `${r.email}${r.isTestAddress ? ' (test)' : ''}${r.revoked ? ' — revoked' : ''}`,
                      )
                      .join(', ')
                  : 'No recipient yet — it cannot be activated without one.'}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Last run {fmtWhen(s.lastRunAt)}
                {s.lastDelivery ? (
                  <>
                    {' · '}
                    <span className={`badge ${DELIVERY_STATUS_STYLES[s.lastDelivery.status]}`}>
                      {s.lastDelivery.status}
                    </span>{' '}
                    via {s.lastDelivery.transport}
                    {s.lastDelivery.note ? ` — ${s.lastDelivery.note}` : ''}
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="btn-ghost min-h-[32px] px-2.5 py-1 text-xs"
                onClick={() => openDeliveries(s)}
              >
                History
              </button>
              {mayWrite ? (
                <>
                  <button
                    type="button"
                    className="btn-ghost min-h-[32px] px-2.5 py-1 text-xs"
                    onClick={() =>
                      setForm({
                        id: s.id,
                        name: s.name,
                        reportKey: s.reportKey,
                        cadence: s.cadence,
                        format: s.format,
                        sendAt: hhmm(s.sendAtMinutes),
                        timezone: s.timezone,
                        weekday: s.weekday ?? 1,
                        dayOfMonth: s.dayOfMonth ?? 1,
                        storeIds: s.storeIds,
                        recipientIds: s.recipients.filter((r) => !r.revoked).map((r) => r.id),
                      })
                    }
                  >
                    Edit
                  </button>
                  {(STATE_ACTIONS[s.state] ?? []).map((a) => (
                    <button
                      key={a.to}
                      type="button"
                      className="btn-ghost min-h-[32px] px-2.5 py-1 text-xs"
                      disabled={busy}
                      onClick={() => setState(s, a.to)}
                    >
                      {a.label}
                    </button>
                  ))}
                  {/* Refused on a DRAFT by the server, deliberately: "send it
                      now" on something that has never been reviewed is the same
                      mistake as activating on save. */}
                  {s.state !== 'DRAFT' ? (
                    <button
                      type="button"
                      className="btn-ghost min-h-[32px] px-2.5 py-1 text-xs"
                      disabled={busy}
                      onClick={() => runNow(s)}
                    >
                      <Play className="mr-1 inline h-3 w-3" />
                      Run now
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ))}

      <div className="card mt-6 p-5">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
            Approved recipients
          </h2>
          <span className="text-xs text-slate-500">
            A schedule can only name an address from this list.
          </span>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Revoked rather than deleted. A delivery names the addresses it went to, and removing the row
          would make “who received the March figures” unanswerable — which is the one question an
          approval list exists to answer.
        </p>
        <ul className="divide-y divide-slate-100">
          {(recipients?.recipients ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <span className={r.revokedAt ? 'text-slate-400 line-through' : 'font-semibold text-pos-ink'}>
                  {r.email}
                </span>
                {r.label ? <span className="ml-2 text-xs text-slate-500">{r.label}</span> : null}
                {r.isTestAddress ? (
                  <span className="badge ml-2 bg-sky-100 text-sky-700">test address</span>
                ) : null}
                {r.revokedAt ? (
                  <span className="badge ml-2 bg-slate-100 text-slate-600">revoked</span>
                ) : null}
              </div>
              {mayWrite && !r.revokedAt ? (
                <button
                  type="button"
                  className="btn-ghost min-h-[30px] px-2.5 py-1 text-xs"
                  disabled={busy}
                  onClick={() => revoke(r)}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
          {!recipients?.recipients?.length ? (
            <li className="py-2 text-xs text-slate-500">No address has been approved yet.</li>
          ) : null}
        </ul>
        {mayWrite ? <RecipientForm busy={busy} onSubmit={addRecipient} /> : null}
      </div>

      <Modal open={Boolean(form)} wide title={form?.id ? 'Edit schedule' : 'New schedule'} onClose={() => setForm(null)}>
        {form ? (
          <form className="space-y-3" onSubmit={submit}>
            <div>
              <label className="label" htmlFor="sch-name">Name</label>
              <input
                id="sch-name"
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                minLength={2}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="sch-report">Report</label>
                <select
                  id="sch-report"
                  className="input"
                  value={form.reportKey}
                  onChange={(e) => setForm({ ...form, reportKey: e.target.value })}
                >
                  {scheduleReports.map((r) => (
                    <option key={r.key} value={r.key}>
                      {REPORT_LABELS[r.key] ?? r.key}
                    </option>
                  ))}
                </select>
                {/* Only reports this caller may read are listed, because the
                    server refuses to schedule one they cannot — a timer must not
                    be a way around report-level permission. */}
                <p className="mt-1 text-[11px] text-slate-500">
                  Only reports you may read yourself can be scheduled.
                </p>
              </div>
              <div>
                <label className="label" htmlFor="sch-format">Format</label>
                <select
                  id="sch-format"
                  className="input"
                  value={form.format}
                  onChange={(e) => setForm({ ...form, format: e.target.value })}
                >
                  {(data?.formats ?? ['CSV']).map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f.toLowerCase()] ?? f}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="sch-cadence">How often</label>
                <select
                  id="sch-cadence"
                  className="input"
                  value={form.cadence}
                  onChange={(e) => setForm({ ...form, cadence: e.target.value })}
                >
                  {(data?.cadences ?? ['DAILY']).map((c) => (
                    <option key={c} value={c}>
                      {CADENCE_LABELS[c] ?? c}
                    </option>
                  ))}
                </select>
              </div>
              {form.cadence === 'WEEKLY' ? (
                <div>
                  <label className="label" htmlFor="sch-weekday">On</label>
                  <select
                    id="sch-weekday"
                    className="input"
                    value={form.weekday}
                    onChange={(e) => setForm({ ...form, weekday: e.target.value })}
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {weekdayName(n)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {form.cadence === 'MONTHLY' ? (
                <div>
                  <label className="label" htmlFor="sch-dom">Day of month</label>
                  <input
                    id="sch-dom"
                    type="number"
                    min="1"
                    max="31"
                    className="input"
                    value={form.dayOfMonth}
                    onChange={(e) => setForm({ ...form, dayOfMonth: e.target.value })}
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    29–31 sends on the last day of a shorter month.
                  </p>
                </div>
              ) : null}
              <div>
                <label className="label" htmlFor="sch-time">At</label>
                <input
                  id="sch-time"
                  type="time"
                  className="input"
                  value={form.sendAt}
                  onChange={(e) => setForm({ ...form, sendAt: e.target.value })}
                />
                <p className="mt-1 text-[11px] text-slate-500">{form.timezone}</p>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="sch-stores">Stores</label>
              <select
                id="sch-stores"
                multiple
                className="input min-h-[92px]"
                value={form.storeIds}
                onChange={(e) =>
                  setForm({ ...form, storeIds: [...e.target.selectedOptions].map((o) => o.value) })
                }
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                Select none for every store the schedule’s owner can reach at the moment it sends.
                Reach is checked again then, so a store leaving their access removes it from the
                report.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="sch-recipients">Recipients</label>
              <select
                id="sch-recipients"
                multiple
                className="input min-h-[92px]"
                value={form.recipientIds}
                onChange={(e) =>
                  setForm({ ...form, recipientIds: [...e.target.selectedOptions].map((o) => o.value) })
                }
              >
                {(recipients?.recipients ?? [])
                  .filter((r) => !r.revokedAt)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.email}
                      {r.isTestAddress ? ' (test)' : ''}
                    </option>
                  ))}
              </select>
            </div>
            <ErrorNote message={error} />
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Saving…' : form.id ? 'Save changes' : 'Create as draft'}
            </button>
            {!form.id ? (
              <p className="text-center text-[11px] text-slate-500">
                Created as a draft. It sends nothing until it is activated.
              </p>
            ) : null}
          </form>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(deliveries)}
        wide
        title={deliveries ? `Deliveries — ${deliveries.schedule.name}` : ''}
        onClose={() => setDeliveries(null)}
      >
        {deliveries ? (
          <div className="space-y-3">
            {deliveries.result ? (
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {/* A second run of the same period is answered with the first
                    result, not a second file. This is the line that says so. */}
                {deliveries.result.deduplicated
                  ? 'This period had already been delivered. The existing delivery is shown; nothing was sent again.'
                  : `Run recorded: ${deliveries.result.delivery?.status ?? 'no delivery'}.`}
                {deliveries.result.reason ? ` ${deliveries.result.reason}` : ''}
              </div>
            ) : null}
            <ul className="divide-y divide-slate-100">
              {(deliveries.deliveries ?? []).map((d) => (
                <li key={d.id ?? d.runKey} className="py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`badge ${DELIVERY_STATUS_STYLES[d.status]}`}>{d.status}</span>
                    <span className="font-semibold text-slate-700">
                      {d.period?.from} → {d.period?.to}
                    </span>
                    <span className="text-slate-500">via {d.transport}</span>
                    {d.attempts > 1 ? (
                      <span className="text-slate-500">{d.attempts} attempts</span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-slate-500">
                    {d.rowCount === null || d.rowCount === undefined
                      ? 'No rows recorded'
                      : `${fmtInt(d.rowCount)} row${d.rowCount === 1 ? '' : 's'}`}
                    {d.bytes ? ` · ${fmtInt(d.bytes)} bytes` : ''}
                    {d.artifact ? ` · ${d.artifact}` : ''}
                    {' · '}
                    {fmtWhen(d.lastAttemptAt)}
                  </div>
                  {/* Who it reached and who it deliberately did not. A withheld
                      address is a policy decision, not a failure, and hiding it
                      would make an incomplete delivery look complete. */}
                  <div className="mt-1 text-slate-500">
                    Written to: {d.sentTo?.length ? d.sentTo.join(', ') : 'nobody'}
                    {d.withheld?.length ? ` · withheld: ${d.withheld.join(', ')}` : ''}
                  </div>
                  {d.note ? <div className="mt-1 text-amber-700">{d.note}</div> : null}
                </li>
              ))}
            </ul>
            {!(deliveries.deliveries ?? []).length && !deliveries.result ? (
              <p className="text-xs text-slate-500">This schedule has never run.</p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function RecipientForm({ busy, onSubmit }) {
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [isTestAddress, setIsTestAddress] = useState(true);
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ email: email.trim(), label: label.trim() || undefined, isTestAddress });
        setEmail('');
        setLabel('');
      }}
    >
      <div className="grow">
        <label className="label" htmlFor="rec-email">Address</label>
        <input
          id="rec-email"
          type="email"
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="grow">
        <label className="label" htmlFor="rec-label">Who this is</label>
        <input
          id="rec-label"
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Finance director"
        />
      </div>
      <label className="flex min-h-[42px] items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={isTestAddress}
          onChange={(e) => setIsTestAddress(e.target.checked)}
        />
        Test address
      </label>
      <button type="submit" className="btn-primary min-h-[42px] text-sm" disabled={busy || !email.trim()}>
        <Mail className="mr-1.5 inline h-4 w-4" />
        Approve
      </button>
      <p className="w-full text-[11px] text-slate-500">
        Only test addresses are written to in this build. Approving a real address records the
        approval; a delivery to it is withheld and the delivery row says so.
      </p>
    </form>
  );
}
