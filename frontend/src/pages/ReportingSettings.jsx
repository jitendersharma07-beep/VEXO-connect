// LANE reporting — /reporting/settings, the four values that decide where a day ends.
//
// This screen is not cosmetic and is not a preference. Changing the business-day
// cutoff or the financial year re-cuts every past report: the same bills land in
// different days, weeks and years, and yesterday's figure changes without anybody
// editing a bill. That is why it has its own write action, why the server audits
// the before and after, and why this page says so above the form rather than
// leaving somebody to discover it from a changed total.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// A short list, not every IANA zone. These are the zones this product is sold
// into; a free-text field invites a typo the server would then have to refuse,
// and "Asia/Calcutta" looks right enough to be typed.
const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Kathmandu',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Singapore',
  'Europe/London',
  'UTC',
];

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutesOf = (value) => {
  const [h, m] = String(value).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

export default function ReportingSettings() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;
  const mayWrite = can('report.settings.write');

  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setError('');
    try {
      const { data } = await api.get('/reporting/settings');
      setSettings(data);
      setDraft(data);
    } catch (err) {
      setError(apiError(err, 'Could not load the reporting settings'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atc, atcScope?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const { data } = await api.patch('/reporting/settings', {
        timezone: draft.timezone,
        businessDayCutoffMinutes: draft.businessDayCutoffMinutes,
        weekStartDay: draft.weekStartDay,
        financialYearStartMonth: draft.financialYearStartMonth,
        staleAfterMinutes: draft.staleAfterMinutes,
      });
      setSettings(data);
      setDraft(data);
      setSaved(true);
    } catch (err) {
      setError(apiError(err, 'Could not save the reporting settings'));
    } finally {
      setBusy(false);
    }
  };

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Reporting periods" subtitle="VEXO operators browse per company." />
        <EmptyState title="No company selected" note="Open a company from the VEXO console first." />
      </div>
    );
  }

  const set = (patch) => {
    setSaved(false);
    setDraft((s) => ({ ...s, ...patch }));
  };

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Reporting periods"
        subtitle="Where a trading day, week and financial year begin for this company"
        actions={
          <button type="button" className="btn-ghost min-h-[38px] text-sm" onClick={() => navigate('/reporting')}>
            <ArrowLeft className="mr-1.5 inline h-4 w-4" />
            Dashboard
          </button>
        }
      />

      <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <p className="text-xs text-amber-900">
          These values re-cut <strong>every past report</strong>. Moving the business-day cutoff moves
          after-midnight bills between days; changing the financial year moves them between years. No
          bill changes, but the totals do. The change is recorded with who made it and what it was
          before.
        </p>
      </div>

      {error ? <ErrorNote message={error} /> : null}

      {draft ? (
        <form onSubmit={save} className="card space-y-4 p-5">
          <div>
            <label className="label" htmlFor="rs-tz">Timezone</label>
            <select
              id="rs-tz"
              className="input"
              value={draft.timezone}
              disabled={!mayWrite}
              onChange={(e) => set({ timezone: e.target.value })}
            >
              {/* A zone already stored but not in the list stays selectable, so
                  opening this page can never silently change it. */}
              {[...new Set([draft.timezone, ...TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Every date in every report is cut in this zone, including exports and scheduled sends.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="rs-cutoff">A trading day starts at</label>
            <input
              id="rs-cutoff"
              type="time"
              className="input"
              value={hhmm(draft.businessDayCutoffMinutes)}
              disabled={!mayWrite}
              max="11:59"
              onChange={(e) => set({ businessDayCutoffMinutes: minutesOf(e.target.value) })}
            />
            <p className="mt-1 text-xs text-slate-500">
              A café serving until 01:30 with a cutoff of 05:00 counts that last order in the
              previous day&apos;s takings — which is the day the staff who served it were working.
              Must be before noon: past that, most of the calendar day would belong to the day
              before, which is a different calendar rather than a cutoff.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="rs-week">A week starts on</label>
            <select
              id="rs-week"
              className="input"
              value={draft.weekStartDay}
              disabled={!mayWrite}
              onChange={(e) => set({ weekStartDay: Number(e.target.value) })}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="rs-fy">The financial year starts in</label>
            <select
              id="rs-fy"
              className="input"
              value={draft.financialYearStartMonth}
              disabled={!mayWrite}
              onChange={(e) => set({ financialYearStartMonth: Number(e.target.value) })}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">April for an Indian company filing on the
              April–March year.</p>
          </div>

          <div>
            <label className="label" htmlFor="rs-stale">Call a store&apos;s data stale after</label>
            <div className="flex items-center gap-2">
              <input
                id="rs-stale"
                type="number"
                className="input w-32"
                min={5}
                max={10080}
                step={5}
                value={draft.staleAfterMinutes}
                disabled={!mayWrite}
                onChange={(e) => set({ staleAfterMinutes: Number(e.target.value) })}
              />
              <span className="text-sm text-slate-500">minutes without activity</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Past this, a silent store is labelled stale instead of counted as a quiet one. A till
              that stopped syncing looks exactly like a shop with no customers until something says
              otherwise.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            {mayWrite ? (
              <button type="submit" className="btn-primary min-h-[42px]" disabled={busy}>
                {busy ? 'Saving…' : 'Save reporting periods'}
              </button>
            ) : (
              <p className="text-xs text-slate-500">
                You can see these values but not change them. They are edited by whoever holds the
                reporting settings authority.
              </p>
            )}
            {saved ? (
              <span className="flex items-center gap-1 text-sm font-semibold text-emerald-600">
                <Check className="h-4 w-4" /> Saved
              </span>
            ) : null}
            {settings && !settings.configured ? (
              <span className="text-xs text-slate-500">
                Not yet configured — reports are using the defaults shown.
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
