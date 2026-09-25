// LANE reporting — /reporting/exceptions, the things somebody is expected to do
// something about.
//
// A report answers "how did we do". This answers "who has to act, and by when",
// and the difference is the whole layout: every row carries a responsible role, a
// due time, and the threshold that made it an exception, because an owner who
// cannot see why a thing was raised cannot argue with it and will eventually stop
// reading it.
//
// The roll-call under the list is not decoration. Six detectors can run in this
// build and four cannot, and a screen that showed only findings would render the
// four as an empty space an owner would read as "nothing wrong with stock".
//
// Nothing here is authorised by being on this screen. The list is what the server
// resolved for this caller's own reach, and closing a row is refused server-side
// with a 404 if it belongs to a store they do not hold.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';
import { DetectorRoll, PeriodBar, PeriodStamp } from '../components/reporting.jsx';
import {
  EXCEPTION_KIND_LABELS,
  EXCEPTION_STATUS_STYLES,
  SEVERITY_STYLES,
  filtersFromSearch,
  fmtWhen,
  reportParams,
  roleLabel,
} from '../lib/reporting.js';

const STATUS_TABS = [
  { key: 'OPEN,ACKNOWLEDGED', label: 'Needs action' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'DISMISSED', label: 'Dismissed' },
];

// The three closes are three different claims, and the wording says which:
// somebody has it, somebody fixed it, somebody looked and decided it was fine.
// Collapsing the third into the second turns "we checked" into "we fixed it" and
// an audit six months later cannot tell them apart.
const ACTIONS = [
  { status: 'ACKNOWLEDGED', label: 'I have this', hint: 'Says somebody has picked it up. The exception stays open.' },
  { status: 'RESOLVED', label: 'Resolved', hint: 'Says the underlying problem was dealt with.' },
  {
    status: 'DISMISSED',
    label: 'Not a problem',
    hint: 'Says somebody looked and decided no action was needed. A reason is required.',
    needsNote: true,
  },
];

// How many rows of one kind are shown before the group folds.
//
// One neglected habit produces a lot of identical findings — an estate that closes
// its drawers on three days out of seventy has seventy-odd unclosed days, all
// equally true and all one problem. Rendered in full they bury every other kind
// under a wall of one, which is how a worklist stops being read. The count in the
// heading is always the real one; only the rows fold.
const GROUP_CAP = 8;

const detailRows = (detail) => {
  if (!detail || typeof detail !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined) continue;
    if (k === 'basis' || k === 'thresholds') continue;
    const label = k
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .trim();
    if (typeof v === 'object') {
      if ('amount' in v) out.push([label, `₹${v.amount}`]);
      else if ('qty' in v) out.push([label, `${v.qty} ${v.unitLabel ?? ''}`.trim()]);
      continue;
    }
    out.push([label, typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)]);
  }
  return out;
};

export default function ReportExceptions() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;
  const mayResolve = can('report.exception.resolve');

  const [filters, setFilters] = useState(() => filtersFromSearch(sp));
  const [status, setStatus] = useState(sp.get('status') ?? STATUS_TABS[0].key);
  const [data, setData] = useState(null);
  const [roll, setRoll] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [acting, setActing] = useState(null);
  const [open, setOpen] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  // The period is in the URL so a link to a worklist is a link to the same
  // worklist. A screen whose state lives only in memory cannot be sent to the
  // person who is supposed to act on it.
  useEffect(() => {
    const next = new URLSearchParams(reportParams(filters));
    next.set('status', status);
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, status]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    try {
      const { data: body } = await api.get('/reporting/exceptions', {
        params: { ...reportParams(filters), status },
      });
      setData(body);
    } catch (err) {
      setError(apiError(err, 'Could not load the exception list'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, status, atc, atcScope?.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get('/reporting/catalog')
      .then(({ data: body }) => setCatalog(body))
      .catch(() => {});
  }, []);

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      const { data: body } = await api.post(
        '/reporting/exceptions/scan',
        {},
        { params: reportParams(filters) },
      );
      setRoll(body);
      await load();
    } catch (err) {
      setError(apiError(err, 'The scan could not run'));
    } finally {
      setScanning(false);
    }
  };

  const act = async (row, action, note) => {
    setActing(row.id);
    setError('');
    try {
      await api.post(`/reporting/exceptions/${row.id}`, {
        status: action.status,
        ...(note ? { note } : {}),
      });
      setOpen(null);
      await load();
    } catch (err) {
      setError(apiError(err, 'Could not update the exception'));
    } finally {
      setActing(null);
    }
  };

  const summary = data?.summary;
  const grouped = useMemo(() => {
    const by = new Map();
    for (const e of data?.exceptions ?? []) {
      const k = e.kind;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(e);
    }
    return [...by.entries()];
  }, [data]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Exceptions" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={ShieldAlert}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Exceptions"
        subtitle="Findings with a responsible role and a due time, not notifications."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost min-h-[38px] text-sm"
              onClick={() => navigate('/reporting')}
            >
              <ArrowLeft className="mr-1.5 inline h-4 w-4" />
              Dashboard
            </button>
            <button
              type="button"
              className="btn-primary min-h-[38px] text-sm"
              onClick={scan}
              disabled={scanning}
              data-testid="scan-now"
            >
              <RefreshCw className={`mr-1.5 inline h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Looking…' : 'Check now'}
            </button>
          </div>
        }
      />

      <PeriodBar
        filters={filters}
        onChange={setFilters}
        presets={catalog?.presets}
        groupings={catalog?.groupings}
        options={{ stores: data?.scope?.stores ?? [] }}
      />

      {error ? <ErrorNote message={error} /> : null}

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-4" data-testid="exception-summary">
          {[
            { label: 'Needs action', value: summary.open, tone: 'text-pos-ink' },
            { label: 'Critical', value: summary.bySeverity?.CRITICAL ?? 0, tone: 'text-red-600' },
            { label: 'Warnings', value: summary.bySeverity?.WARNING ?? 0, tone: 'text-amber-600' },
            { label: 'Past its due time', value: summary.overdue, tone: 'text-red-600' },
          ].map((c) => (
            <div key={c.label} className="card p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {c.label}
              </div>
              <div className={`mt-1 text-3xl font-black tabular-nums ${c.tone}`}>{c.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {roll?.period ? (
        <div className="mt-4">
          <PeriodStamp period={roll.period} generatedAt={roll.scannedAt} />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={status === t.key ? 'btn-primary min-h-[34px] px-3 py-1 text-xs' : 'btn-ghost min-h-[34px] px-3 py-1 text-xs'}
            onClick={() => setStatus(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="card mt-4 flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {data && !grouped.length ? (
        <div className="mt-4">
          <EmptyState
            icon={CheckCircle2}
            title={
              status === STATUS_TABS[0].key
                ? 'Nothing needs action in this period'
                : 'Nothing in this state'
            }
            // The distinction §7 requires, in the empty state itself. An empty
            // list here means the checks below ran and found nothing — it does not
            // mean every kind of problem was looked for.
            note={
              status === STATUS_TABS[0].key
                ? 'The checks listed below ran. The ones that could not run in this build are named there rather than counted as clear.'
                : undefined
            }
          />
        </div>
      ) : null}

      {grouped.map(([kind, rows]) => (
        <div key={kind} className="card mt-4 overflow-hidden" data-testid={`exception-group-${kind}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-bold text-pos-ink">
              {EXCEPTION_KIND_LABELS[kind] ?? kind}
              <span className="ml-2 text-xs font-semibold text-slate-400">{rows.length}</span>
            </h2>
            <span className="text-xs text-slate-500">
              {roleLabel(rows[0].responsibleRole)} is expected to act
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {(expanded.has(kind) ? rows : rows.slice(0, GROUP_CAP)).map((e) => (
              <li key={e.id} className="px-5 py-3" data-testid={`exception-${e.kind}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`badge ${SEVERITY_STYLES[e.severity]}`}>{e.severity}</span>
                      <span className={`badge ${EXCEPTION_STATUS_STYLES[e.status]}`}>{e.status}</span>
                      {e.overdue ? (
                        <span className="badge bg-red-100 text-red-700">
                          <AlertTriangle className="mr-1 inline h-3 w-3" />
                          overdue
                        </span>
                      ) : null}
                      {/* Cleared by the condition going away, not by a person.
                          Both are legitimate; reading one as the other is not. */}
                      {e.clearedBySystem ? (
                        <span className="badge bg-slate-100 text-slate-600">cleared automatically</span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-pos-ink">{e.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {e.storeName ?? 'Company-wide'} · found {fmtWhen(e.detectedAt)}
                      {e.dueAt ? ` · due ${fmtWhen(e.dueAt)}` : ''}
                    </div>
                    {e.resolutionNote ? (
                      <div className="mt-1 text-xs italic text-slate-500">{e.resolutionNote}</div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className="btn-ghost min-h-[32px] px-2.5 py-1 text-xs"
                      onClick={() => setOpen({ row: e, action: null })}
                    >
                      Why
                    </button>
                    {mayResolve && (e.status === 'OPEN' || e.status === 'ACKNOWLEDGED')
                      ? ACTIONS.map((a) =>
                          a.status === 'ACKNOWLEDGED' && e.status === 'ACKNOWLEDGED' ? null : (
                            <button
                              key={a.status}
                              type="button"
                              className="btn-ghost min-h-[32px] px-2.5 py-1 text-xs"
                              disabled={acting === e.id}
                              onClick={() =>
                                a.needsNote ? setOpen({ row: e, action: a }) : act(e, a)
                              }
                            >
                              {a.label}
                            </button>
                          ),
                        )
                      : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {rows.length > GROUP_CAP ? (
            <button
              type="button"
              className="w-full border-t border-slate-100 bg-slate-50 px-5 py-2 text-xs font-semibold text-pos-royal hover:bg-slate-100"
              data-testid={`exception-fold-${kind}`}
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(kind)) next.delete(kind);
                  else next.add(kind);
                  return next;
                })
              }
            >
              {expanded.has(kind)
                ? `Show the first ${GROUP_CAP} only`
                : `Show all ${rows.length} — ${rows.length - GROUP_CAP} more are hidden`}
            </button>
          ) : null}
        </div>
      ))}

      {/* The list is a page, not the whole of what exists, and the counts above are
          of everything. Saying so is the difference between a worklist somebody can
          work through and one that quietly ends. */}
      {data?.truncated ? (
        <p className="mt-3 text-xs text-amber-700" data-testid="exception-truncated">
          Showing the {data.truncated.shown} most severe. There are more in this state than one
          screen carries — close some, or narrow the period or the location.
        </p>
      ) : null}

      {/* The roll-call. Shown from the last scan when there was one, and from the
          list's own detector names before that, so the four kinds this build
          cannot detect are named on first load rather than only after a scan. */}
      {roll?.detectors ? (
        <DetectorRoll detectors={roll.detectors} />
      ) : data?.kinds ? (
        <div className="card mt-4 p-5" data-testid="detector-roll-unscanned">
          <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">
            What can be looked for
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            {data.kinds.length} kinds of exception exist. Press “Check now” to see which of them ran
            in this build and what each one found — the list above is what a previous check left
            behind, not proof that every kind was looked for.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {data.kinds.map((k) => (
              <span key={k} className="badge bg-slate-100 text-slate-600">
                {EXCEPTION_KIND_LABELS[k] ?? k}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {data?.thresholds ? (
        <div className="card mt-4 p-5">
          <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">
            The numbers that make a thing an exception
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            Declared, not learned. A threshold derived from a few weeks of trade would call the first
            busy Saturday an anomaly, and a number nobody can see is a number nobody can argue with.
          </p>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {Object.entries(data.thresholds).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1">
                <dt className="text-slate-600">
                  {k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                </dt>
                <dd className="font-semibold tabular-nums text-slate-700">
                  {/Paise$/.test(k) ? `₹${(v / 100).toLocaleString('en-IN')}` : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <Modal
        open={Boolean(open)}
        wide
        title={open?.action ? open.action.label : 'Why this was raised'}
        onClose={() => setOpen(null)}
      >
        {open ? (
          <div className="space-y-3">
            <div className="text-sm font-semibold text-pos-ink">{open.row.title}</div>
            <div className="text-xs text-slate-500">
              {open.row.storeName ?? 'Company-wide'} ·{' '}
              {roleLabel(open.row.responsibleRole)} is expected to act
            </div>
            {open.row.detail?.basis ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Measured on: {open.row.detail.basis}
              </p>
            ) : null}
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              {detailRows(open.row.detail).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-semibold tabular-nums text-slate-700">{v}</dd>
                </div>
              ))}
            </dl>
            {open.action ? (
              <NoteForm
                hint={open.action.hint}
                busy={acting === open.row.id}
                label={open.action.label}
                onSubmit={(note) => act(open.row, open.action, note)}
              />
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function NoteForm({ hint, label, busy, onSubmit }) {
  const [note, setNote] = useState('');
  return (
    <form
      className="space-y-2 border-t border-slate-100 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(note.trim());
      }}
    >
      <p className="text-xs text-slate-500">{hint}</p>
      <label className="label" htmlFor="exception-note">
        Reason (required)
      </label>
      <textarea
        id="exception-note"
        className="input min-h-[70px]"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        required
        minLength={3}
      />
      <button type="submit" className="btn-primary w-full" disabled={busy || note.trim().length < 3}>
        {busy ? 'Working…' : label}
      </button>
    </form>
  );
}
