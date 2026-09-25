// LANE reporting — the pieces the dashboard and the report centre both use.
//
// One period bar, one table, one coverage strip. Two copies of a period bar is
// how a dashboard and a report end up answering different questions while
// claiming the same heading, so this is rendered, never retyped.
//
// The table is driven by the server's own `columns` array rather than by markup
// per report. That is the reason a new report family needs no frontend work to
// become readable, and more importantly it is why the screen and the CSV cannot
// list different columns: they read the same list.

import { AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarClock, Info, Minus } from 'lucide-react';
import {
  COVERAGE_LABELS,
  COVERAGE_STYLES,
  FORMAT_LABELS,
  GROUPING_LABELS,
  PRESET_LABELS,
  RIGHT_ALIGNED,
  STATE_LABELS,
  STATE_STYLES,
  fmtCell,
  fmtDelta,
  fmtMoney,
  deltaTone,
} from '../lib/reporting.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * What period this is, in words, including the parts that change the answer.
 *
 * The timezone and the business-day cutoff are on the screen rather than in a
 * settings page nobody opens, because a café that trades to 01:30 has a "day"
 * that is not the calendar's, and a figure that looks wrong is usually a figure
 * cut on a boundary the reader did not know about.
 */
export function PeriodStamp({ period, generatedAt }) {
  if (!period) return null;
  return (
    <div
      data-testid="period-stamp"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500"
    >
      <span className="flex items-center gap-1.5 font-semibold text-slate-600">
        <CalendarClock className="h-3.5 w-3.5" />
        {period.label}
      </span>
      <span>
        {period.from} → {period.to}
      </span>
      <span>{period.timezone}</span>
      {period.businessDayCutoffMinutes ? (
        <span>Business day starts {hhmm(period.businessDayCutoffMinutes)}</span>
      ) : null}
      <span>Week starts {WEEKDAYS[period.weekStartDay] ?? period.weekStartDay}</span>
      {period.partial ? (
        <span className="badge bg-amber-100 text-amber-700">In progress — not a full period</span>
      ) : null}
      {generatedAt ? <span className="text-slate-400">as at {new Date(generatedAt).toLocaleString('en-IN')}</span> : null}
    </div>
  );
}

const presetButton = (active) =>
  `min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
    active ? 'bg-pos-royal text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
  }`;

/**
 * The period, grouping and scope controls.
 *
 * `options` are derived from the stores the server already returned, not fetched
 * from a separate endpoint. A region the caller cannot reach therefore never
 * appears in the list — and if one somehow did, naming it would still narrow to
 * nothing rather than widen, because the server intersects filters with the
 * caller's own reach.
 */
export function PeriodBar({ filters, onChange, presets, groupings, options, showGrouping = false }) {
  const set = (patch) => onChange({ ...filters, ...patch });
  return (
    <div data-testid="period-bar" className="card mb-5 space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {(presets ?? []).map((p) => (
          <button
            key={p}
            type="button"
            className={presetButton(filters.preset === p)}
            onClick={() => set({ preset: p })}
          >
            {PRESET_LABELS[p] ?? p}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {filters.preset === 'CUSTOM' ? (
          <>
            <div>
              <label className="label" htmlFor="rc-from">From</label>
              <input
                id="rc-from"
                type="date"
                className="input"
                value={filters.from ?? ''}
                onChange={(e) => set({ from: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="rc-to">To</label>
              <input
                id="rc-to"
                type="date"
                className="input"
                value={filters.to ?? ''}
                onChange={(e) => set({ to: e.target.value })}
              />
            </div>
          </>
        ) : null}

        {showGrouping ? (
          <div>
            <label className="label" htmlFor="rc-grouping">Group by</label>
            <select
              id="rc-grouping"
              className="input"
              value={filters.grouping ?? 'DAY'}
              onChange={(e) => set({ grouping: e.target.value })}
            >
              {(groupings ?? []).map((g) => (
                <option key={g} value={g}>{GROUPING_LABELS[g] ?? g}</option>
              ))}
            </select>
          </div>
        ) : null}

        {options?.stores?.length > 1 ? (
          <div>
            <label className="label" htmlFor="rc-store">Store</label>
            <select
              id="rc-store"
              className="input"
              value={filters.storeId ?? ''}
              onChange={(e) => set({ storeId: e.target.value })}
            >
              <option value="">All my stores ({options.stores.length})</option>
              {options.stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>
              ))}
            </select>
          </div>
        ) : null}

        {options?.regions?.length > 1 ? (
          <div>
            <label className="label" htmlFor="rc-region">Region</label>
            <select
              id="rc-region"
              className="input"
              value={filters.regionId ?? ''}
              onChange={(e) => set({ regionId: e.target.value })}
            >
              <option value="">All regions</option>
              {options.regions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {options?.brands?.length > 1 ? (
          <div>
            <label className="label" htmlFor="rc-brand">Brand</label>
            <select
              id="rc-brand"
              className="input"
              value={filters.brandId ?? ''}
              onChange={(e) => set({ brandId: e.target.value })}
            >
              <option value="">All brands</option>
              {options.brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {options?.legalEntities?.length > 1 ? (
          <div>
            <label className="label" htmlFor="rc-entity">Legal entity</label>
            <select
              id="rc-entity"
              className="input"
              value={filters.legalEntityId ?? ''}
              onChange={(e) => set({ legalEntityId: e.target.value })}
            >
              <option value="">All entities</option>
              {options.legalEntities.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
        ) : null}

        {/* Off by default and stated, not hidden. A demo store's practice takings
            inside a consolidated figure is the quiet way a company total stops
            being true. */}
        {options?.hasDemo ? (
          <label className="flex min-h-[38px] items-center gap-2 text-xs font-semibold text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={Boolean(filters.includeDemo)}
              onChange={(e) => set({ includeDemo: e.target.checked })}
            />
            Include demo stores
          </label>
        ) : null}
      </div>
    </div>
  );
}

/** A KPI with its movement against the comparable previous period. */
export function MetricCard({ label, value, hint, delta, higherIsBetter = true, onClick, testid }) {
  const d = fmtDelta(delta);
  const Arrow = !d || d.flat ? Minus : d.up ? ArrowUpRight : ArrowDownRight;
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      {...(onClick ? { type: 'button', onClick } : {})}
      data-testid={testid}
      className={`card p-5 text-left ${onClick ? 'transition-shadow hover:shadow-md' : ''}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-extrabold tracking-tight text-pos-ink">{value}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
        {d ? (
          <span className={`flex items-center gap-0.5 font-semibold ${deltaTone(delta, higherIsBetter)}`}>
            <Arrow className="h-3.5 w-3.5" />
            {d.text}
          </span>
        ) : null}
        {hint ? <span className="text-slate-500">{hint}</span> : null}
      </div>
    </Wrapper>
  );
}

export function CoverageBadge({ coverage }) {
  if (!coverage) return null;
  // How long a branch has been silent is the difference between "quiet evening"
  // and "the till has been offline since lunch", and only the second one is
  // somebody's job. It used to live in the title attribute, where it is
  // invisible to anyone not hovering the exact word and to every screenshot,
  // print-out and export of this screen.
  const age = coverage.state === 'STALE' ? sinceLabel(coverage.lastActivityAt) : null;
  return (
    <span
      className={`badge ${COVERAGE_STYLES[coverage.state] ?? 'bg-slate-100 text-slate-600'}`}
      title={coverage.note ?? undefined}
    >
      {COVERAGE_LABELS[coverage.state] ?? coverage.state}
      {age ? ` · silent ${age}` : ''}
    </span>
  );
}

/** Compact age of a timestamp: "35 minutes", "6 hours", "3 days". */
const sinceLabel = (iso) => {
  if (!iso) return null;
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
};

/**
 * How much of the company the figures above actually cover.
 *
 * §7's three distinct answers, side by side. Without this a consolidated total
 * silently means "the stores that happened to report", and the day a till stops
 * syncing the company looks like it had a quiet week.
 */
export function CoverageStrip({ coverage }) {
  const s = coverage?.summary;
  if (!s) return null;
  const chip = (n, state) =>
    n > 0 ? (
      <span key={state} className={`badge ${COVERAGE_STYLES[state]}`}>
        {n} {COVERAGE_LABELS[state].toLowerCase()}
      </span>
    ) : null;
  return (
    <div data-testid="coverage-strip" className="card mb-4 flex flex-wrap items-center gap-2 px-5 py-3">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Data coverage</span>
      <span className="text-sm font-semibold text-pos-ink">
        {s.active} of {s.total} store{s.total === 1 ? '' : 's'} reporting
      </span>
      {chip(s.noActivity, 'NO_ACTIVITY')}
      {chip(s.neverRecorded, 'NEVER_RECORDED')}
      {chip(s.stale, 'STALE')}
      {s.stale > 0 ? (
        <span className="text-xs text-red-700">
          A stale store's figures are incomplete, not low — treat its totals as unknown.
        </span>
      ) : null}
    </div>
  );
}

/** Column-driven table. Rows may be clickable for drill-down. */
export function ReportTable({ columns, rows, totals, onRowClick, emptyNote }) {
  if (!columns?.length) return null;
  if (!rows?.length) {
    return (
      <div data-testid="report-empty" className="card px-5 py-10 text-center">
        <Info className="mx-auto mb-2 h-8 w-8 text-slate-300" />
        <p className="text-sm font-semibold text-slate-600">Nothing to show for this period</p>
        <p className="mx-auto mt-1 max-w-lg text-xs text-slate-500">
          {emptyNote ?? 'No transactions were recorded in this period for the selected stores.'}
        </p>
      </div>
    );
  }
  const totalCell = (c) => {
    if (totals === null || totals === undefined) return '';
    const v = totals[c.key];
    if (v === null || v === undefined) return '';
    return fmtCell(totals, c);
  };
  const hasTotals = Boolean(totals) && columns.some((c) => totalCell(c) !== '');
  return (
    <div className="card overflow-x-auto">
      <table data-testid="report-table" className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`whitespace-nowrap px-4 py-3 ${RIGHT_ALIGNED.has(c.type) ? 'text-right' : ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.storeId ?? row.key ?? row.bucket ?? i}
              className={`border-b border-slate-100 last:border-0 ${
                onRowClick && row.storeId ? 'cursor-pointer hover:bg-slate-50' : ''
              }`}
              onClick={onRowClick && row.storeId ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`whitespace-nowrap px-4 py-2.5 ${
                    RIGHT_ALIGNED.has(c.type) ? 'text-right tabular-nums' : ''
                  } ${c.type === 'text' ? 'font-semibold text-pos-ink' : 'text-slate-600'}`}
                >
                  {c.type === 'coverage' ? <CoverageBadge coverage={row[c.key]} /> : fmtCell(row, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasTotals ? (
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-pos-ink">
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={`whitespace-nowrap px-4 py-3 ${
                    RIGHT_ALIGNED.has(c.type) ? 'text-right tabular-nums' : ''
                  }`}
                >
                  {i === 0 ? 'Company total' : totalCell(c)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/**
 * A horizontal bar per store, so the shape of the company is visible before any
 * number is read. Share is the server's own `sharePercent`; the bar width is the
 * only thing computed here, and it is relative to the largest row rather than to
 * the total so a six-store company does not render six slivers.
 */
export function ShareChart({ rows, onRowClick }) {
  const withSales = (rows ?? []).filter((r) => r.netSales?.paise > 0);
  if (withSales.length < 2) return null;
  const max = Math.max(...withSales.map((r) => r.netSales.paise));
  return (
    <div data-testid="share-chart" className="card mb-4 p-5">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">
        Net sales by store
      </h2>
      <div className="space-y-2.5">
        {withSales.map((r) => (
          <button
            key={r.storeId}
            type="button"
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            className="block w-full text-left"
          >
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-semibold text-pos-ink">{r.storeName}</span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {fmtMoney(r.netSales)}
                {r.sharePercent === null ? '' : ` · ${r.sharePercent}%`}
              </span>
            </div>
            <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-pos-royal"
                style={{ width: `${Math.max(2, (r.netSales.paise / max) * 100)}%` }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Net sales per bucket, as a line.
 *
 * Deliberately an inline SVG and not a charting dependency: this lane adds no
 * package to a till application for one trend line. A single bucket draws no
 * line — a one-point trend is not a trend.
 */
export function TrendChart({ rows, label = 'Net sales' }) {
  const pts = (rows ?? []).filter((r) => r.netSales);
  if (pts.length < 2) return null;
  const W = 720;
  const H = 180;
  const pad = { l: 56, r: 12, t: 14, b: 28 };
  const max = Math.max(...pts.map((r) => r.netSales.paise), 1);
  const px = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const py = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const line = pts.map((r, i) => `${i === 0 ? 'M' : 'L'} ${px(i).toFixed(1)} ${py(r.netSales.paise).toFixed(1)}`).join(' ');
  const area = `${line} L ${px(pts.length - 1).toFixed(1)} ${H - pad.b} L ${px(0).toFixed(1)} ${H - pad.b} Z`;
  // First, middle and last only. Every label on a 31-day month overlaps into an
  // unreadable smear, which is a chart that looks fine in a screenshot and
  // cannot be read on a screen.
  const ticks = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i,
  );
  return (
    <div data-testid="trend-chart" className="card mb-4 p-5">
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">{label} by period</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${label} per period`}>
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} className="stroke-slate-200" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} className="stroke-slate-200" />
        <path d={area} className="fill-pos-royal/10" />
        <path d={line} className="fill-none stroke-pos-royal" strokeWidth="2" />
        {pts.map((r, i) => (
          <circle key={r.bucket ?? i} cx={px(i)} cy={py(r.netSales.paise)} r="3" className="fill-pos-royal" />
        ))}
        <text x={pad.l - 6} y={py(max) + 4} textAnchor="end" className="fill-slate-500" style={{ fontSize: 10 }}>
          {fmtMoney({ amount: max / 100 })}
        </text>
        <text x={pad.l - 6} y={H - pad.b + 4} textAnchor="end" className="fill-slate-500" style={{ fontSize: 10 }}>
          ₹0
        </text>
        {ticks.map((i) => (
          <text
            key={i}
            x={px(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
            className="fill-slate-500"
            style={{ fontSize: 10 }}
          >
            {pts[i].label ?? pts[i].bucket}
          </text>
        ))}
      </svg>
    </div>
  );
}

/**
 * A report this deployment cannot produce, and why.
 *
 * Not an empty table. An empty table is read as a measured zero, and a zero food
 * cost or a zero wastage figure is the kind of number somebody acts on.
 */
export function UnavailableCard({ report }) {
  const state = report?.state ?? 'UNAVAILABLE';
  return (
    <div data-testid="report-unavailable" className="card p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-pos-ink">{report?.label ?? 'Report unavailable'}</h2>
            <span className={`badge ${STATE_STYLES[state]}`}>{STATE_LABELS[state] ?? state}</span>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            {report?.note ?? 'This report is not part of this deployment.'}
          </p>
          {report?.missing?.length ? (
            <p className="mt-2 text-xs text-slate-500">
              Waiting on: {report.missing.join(', ')}
            </p>
          ) : null}
          <p className="mt-3 max-w-2xl text-xs text-slate-500">
            No figures are shown rather than zeros. A zero here would read as a measurement.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Every detector, whether or not it found anything — the exception worklist's
 * equivalent of UnavailableCard.
 *
 * A worklist that lists only findings cannot be read. "No low-stock alerts" and
 * "this build cannot see stock" produce exactly the same empty screen, and only
 * one of them means nobody has to act. So each detector gets a line: a count when
 * it ran, and the reason in words when it could not. `found === null` is the
 * server saying it did not look, and it is never rendered as 0.
 */
export function DetectorRoll({ detectors }) {
  if (!detectors?.length) return null;
  const ran = detectors.filter((d) => d.found !== null);
  const not = detectors.filter((d) => d.found === null);
  return (
    <div className="card mt-4 p-5" data-testid="detector-roll">
      <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">
        What was looked for
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        {ran.length} check{ran.length === 1 ? '' : 's'} ran
        {not.length ? ` · ${not.length} could not run here` : ''}. A check that could not run shows
        the reason instead of a count, because a zero would read as “looked, found none”.
      </p>
      <div className="space-y-1.5">
        {detectors.map((d) => (
          <div
            key={d.kind}
            className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 pb-1.5 text-xs last:border-0"
            data-testid={`detector-${d.kind}`}
          >
            <span className={`badge ${STATE_STYLES[d.state] ?? STATE_STYLES.UNAVAILABLE}`}>
              {d.found === null ? (STATE_LABELS[d.state] ?? d.state) : `${d.found} found`}
            </span>
            <span className="font-semibold text-slate-700">{d.label}</span>
            {d.note ? <span className="text-slate-500">{d.note}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The date each figure is counted on — §3's requirement, rendered verbatim. */
export function BasisNote({ basis, caveats, notes }) {
  const entries = Object.entries(basis ?? {});
  if (!entries.length && !caveats?.length && !notes?.length) return null;
  return (
    <div data-testid="basis-note" className="card mt-4 p-5">
      {entries.length ? (
        <>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
            What each figure is counted on
          </h2>
          <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            {entries.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="shrink-0 font-semibold capitalize text-slate-600">{k}:</dt>
                <dd className="text-slate-500">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      {(notes ?? []).map((n) => (
        <p key={n} className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">{n}</p>
      ))}
      {(caveats ?? []).map((c) => (
        <p key={c} className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{c}</p>
      ))}
    </div>
  );
}

export function ExportButtons({ formats, onExport, busy }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(formats ?? []).map((f) => (
        <button
          key={f}
          type="button"
          className="btn-ghost min-h-[36px] px-3 py-1.5 text-xs"
          disabled={Boolean(busy)}
          onClick={() => onExport(f)}
        >
          {busy === f ? 'Preparing…' : FORMAT_LABELS[f] ?? f.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/**
 * The comparison line: what the previous comparable period did, and on what
 * basis it was chosen. "Same elapsed time" is stated because comparing five
 * hours of today against all of yesterday always looks like a collapse.
 */
export function ComparisonNote({ comparison }) {
  if (!comparison) return null;
  return (
    <p data-testid="comparison-note" className="mb-4 text-xs text-slate-500">
      Compared with <strong className="text-slate-600">{comparison.label}</strong> ({comparison.from} →{' '}
      {comparison.to}). {comparison.note}
    </p>
  );
}
