import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, BarChart3, IndianRupee, Info, Layers, Lock, Percent, RotateCcw, ShieldAlert,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader, StatCard } from '../components/ui.jsx';
import { getAtcScope, isAtc, istDaysAgo, istToday, apiErrorCode } from '../lib/pos.js';
import {
  CHANNELS, GROUP_BY, UNKNOWN, costStatusOf, fmtIngredientQty, fmtMilliPaise, fmtPaise,
  fmtPercent, fmtShare, segmentOf,
} from '../lib/vc105.js';

// /reports/menu-profitability — VC-105.
//
// Built against docs/VC105-API-CONTRACT.md v1.1.1 (sha256 182d5a16…). Every
// money figure, percentage and segment on this screen is rendered from the
// server's response; this file does no financial arithmetic (contract §9).
//
// The two rules this screen exists to honour:
//   1. An unknown cost is never shown as zero cost or zero profit.
//   2. It says "contribution margin", never "net business profit".

const StatusPill = ({ status }) => {
  const s = costStatusOf(status);
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${s.className}`} title={s.hint}>
      {s.label}
    </span>
  );
};

const SegmentPill = ({ segment }) => {
  const s = segmentOf(segment);
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${s.className}`} title={s.hint}>
      {s.label}
    </span>
  );
};

// The costing dependency is not a footnote on this screen: until the inventory
// lane lands, every margin here is either absent or synthetic, and the operator
// has to know which before reading a single number.
function CostingBanner({ costing }) {
  if (!costing) return null;
  const synthetic = costing.source === 'SYNTHETIC';
  const blocked = costing.dependency === 'BLOCKED';
  if (!blocked && !synthetic) return null;

  return (
    <div
      data-testid="costing-banner"
      className={`mb-4 rounded-xl border-2 px-4 py-3 ${synthetic ? 'border-rose-300 bg-rose-50' : 'border-amber-300 bg-amber-50'}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${synthetic ? 'text-rose-600' : 'text-amber-600'}`} />
        <div className="min-w-0">
          <p className={`text-sm font-extrabold ${synthetic ? 'text-rose-900' : 'text-amber-900'}`}>
            {synthetic
              ? 'Synthetic cost data — these margins are fixtures, not real cost'
              : 'Ingredient costing is not available yet'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-700">
            {synthetic
              ? 'Every COGS, contribution margin and segment below is computed from a development fixture. It is not evidence about live figures and must not be shown to a client.'
              : 'No recipe or inventory costing is committed, so cost, margin and segment are reported as unknown rather than guessed.'}
            {' '}Costing dependency: <strong>{costing.dependency}</strong> · source{' '}
            <strong>{costing.source}</strong> · valuation method{' '}
            <strong>{costing.method}</strong> ({costing.methodStatus.replaceAll('_', ' ').toLowerCase()}).
          </p>
          {costing.historicalReproducibility === 'NOT_GUARANTEED_SYNTHETIC' ? (
            <p data-testid="repro-warning" className="mt-1 text-[11px] font-semibold text-rose-800">
              A past period is not reproducible here: fixture prices apply at the moment you ask,
              so changing a price moves history. Do not read these as historical facts.
            </p>
          ) : null}
          {costing.missingCapabilities?.length ? (
            <p className="mt-1 text-[11px] text-slate-600">
              Missing: {costing.missingCapabilities.map((c) => c.replaceAll('_', ' ')).join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Coverage is stated wherever a partial total is shown, because a total over
// costed lines only is a different number from a total over everything.
function CoverageStrip({ coverage }) {
  if (!coverage) return null;
  const order = ['ACTUAL', 'ESTIMATED', 'STALE', 'MISSING'];
  return (
    <div data-testid="coverage-strip" className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-extrabold text-pos-ink">Cost coverage</h3>
        <p className="text-xs text-slate-500">
          {coverage.linesCosted} of {coverage.lines} sold lines carry a cost ({coverage.coveragePercent}%)
        </p>
      </div>
      <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {order.map((k) => {
          const n = coverage.byStatus?.[k] ?? 0;
          if (!n || !coverage.lines) return null;
          const colour = { ACTUAL: 'bg-emerald-500', ESTIMATED: 'bg-amber-400', STALE: 'bg-orange-400', MISSING: 'bg-rose-500' }[k];
          return <div key={k} className={colour} style={{ width: `${(n / coverage.lines) * 100}%` }} title={`${k}: ${n}`} />;
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        {order.map((k) => (
          <span key={k} className="flex items-center gap-1.5 text-xs text-slate-600">
            <StatusPill status={k} />
            <strong className="text-pos-ink">{coverage.byStatus?.[k] ?? 0}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

// Popularity versus contribution margin per unit, with the server's own
// thresholds drawn as the quadrant lines.
//
// Items with no cost are NOT plotted. Placing them on the axis would put them
// at zero margin, which is a claim the data does not support — they are listed
// beside the chart instead.
function SegmentChart({ rows, segments }) {
  const plottable = rows.filter((r) => r.marginPerUnitPaise !== null && r.qty > 0);
  const unplottable = rows.filter((r) => r.marginPerUnitPaise === null && r.qty > 0);
  const tx = segments?.thresholds?.popularityShare ?? null;
  const ty = segments?.thresholds?.marginPerUnitPaise ?? null;

  const W = 560;
  const H = 320;
  const pad = { l: 60, r: 16, t: 16, b: 40 };

  const bounds = useMemo(() => {
    const xs = plottable.map((r) => r.popularityShare).concat(tx ?? []);
    const ys = plottable.map((r) => r.marginPerUnitPaise).concat(ty ?? []);
    const xMax = Math.max(0.0001, ...xs) * 1.15;
    const yMin = Math.min(0, ...ys);
    const yMax = Math.max(1, ...ys) * 1.15;
    return { xMax, yMin, yMax };
  }, [plottable, tx, ty]);

  if (!plottable.length) {
    return (
      <div data-testid="segment-chart-empty" className="rounded-xl border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-extrabold text-pos-ink">Popularity vs contribution margin</h3>
        <p className="mt-2 text-sm text-slate-600">
          Nothing can be plotted: no item in this period has a known cost, so no contribution
          margin exists to place it against. {unplottable.length ? `${unplottable.length} item(s) sold without cost data.` : ''}
        </p>
      </div>
    );
  }

  const px = (share) => pad.l + (share / bounds.xMax) * (W - pad.l - pad.r);
  const py = (paise) =>
    H - pad.b - ((paise - bounds.yMin) / (bounds.yMax - bounds.yMin || 1)) * (H - pad.t - pad.b);

  return (
    <div data-testid="segment-chart" className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-extrabold text-pos-ink">Popularity vs contribution margin</h3>
        <p className="text-xs text-slate-500">
          thresholds — popularity {fmtShare(tx)} · margin/unit {fmtPaise(ty)}
        </p>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="Popularity versus contribution margin per unit">
        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="#cbd5e1" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="#cbd5e1" />
        {bounds.yMin < 0 ? (
          <line x1={pad.l} y1={py(0)} x2={W - pad.r} y2={py(0)} stroke="#94a3b8" strokeDasharray="2 3" />
        ) : null}
        {tx !== null ? (
          <line x1={px(tx)} y1={pad.t} x2={px(tx)} y2={H - pad.b} stroke="#6366f1" strokeDasharray="5 4" />
        ) : null}
        {ty !== null ? (
          <line x1={pad.l} y1={py(ty)} x2={W - pad.r} y2={py(ty)} stroke="#6366f1" strokeDasharray="5 4" />
        ) : null}

        {plottable.map((r) => (
          <g key={r.key}>
            <circle cx={px(r.popularityShare)} cy={py(r.marginPerUnitPaise)} r="7" fill={segmentOf(r.segment).dot} fillOpacity="0.85" />
            <text x={px(r.popularityShare)} y={py(r.marginPerUnitPaise) - 12} textAnchor="middle" className="fill-slate-600" style={{ fontSize: 11 }}>
              {r.label.length > 16 ? `${r.label.slice(0, 15)}…` : r.label}
            </text>
          </g>
        ))}

        <text x={(W - pad.l) / 2 + pad.l} y={H - 8} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 11 }}>
          share of quantity sold
        </text>
        <text x={16} y={H / 2} transform={`rotate(-90 16 ${H / 2})`} textAnchor="middle" className="fill-slate-500" style={{ fontSize: 11 }}>
          contribution margin per unit
        </text>
      </svg>

      {unplottable.length ? (
        <div data-testid="chart-unplottable" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900">
          <strong>{unplottable.length} item(s) cannot be placed</strong> — no cost data, so no margin
          exists to plot. They are not zero-margin and not dogs:{' '}
          {unplottable.map((r) => r.label).join(', ')}.
        </div>
      ) : null}
    </div>
  );
}

// Explains one item's figure: where the cost came from, what the yield and the
// modifiers added, and what was discounted or refunded.
function Drilldown({ row, meta, onClose }) {
  if (!row) return null;
  const breakdowns = row.costBreakdowns ?? [];

  return (
    <Modal open={!!row} title={row.label} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ['Quantity sold', row.qty],
            ['Net sales', fmtPaise(row.netSalesPaise)],
            ['Refunded (net)', fmtPaise(row.refundNetPaise)],
            ['Net after refunds', fmtPaise(row.netSalesAfterRefundPaise)],
            ['Ingredient COGS', fmtPaise(row.cogsPaise)],
            ['Contribution margin', fmtPaise(row.contributionMarginPaise)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
              <p className="text-lg font-extrabold text-pos-ink">{value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-slate-200 p-3">
          <h4 className="text-sm font-extrabold text-pos-ink">Calculation basis</h4>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-700">
            <li>
              <strong>Net sales</strong> is tax-exclusive: line subtotal less its own discount and
              its share of the order discount, as allocated on the bill. Discounts attributed to
              this item in the period: <strong>{fmtPaise(row.discountPaise)}</strong>.
            </li>
            <li>
              <strong>Refunds</strong> are order-level in the source data, so the amount above is
              this item's proportional share of the refunds on orders containing it — a stated
              allocation, not a per-dish record.
            </li>
            <li>
              <strong>Contribution margin</strong> = net sales after refunds − ingredient COGS.
              It excludes labour, rent, utilities, packaging, wastage and delivery commission.
              It is <strong>not</strong> net business profit.
            </li>
            <li>
              <strong>COGS</strong> is not reduced by a refund, because whether the stock came back
              is not recorded ({meta?.costing?.refundPolicy?.replaceAll('_', ' ').toLowerCase()}).
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-extrabold text-pos-ink">Cost coverage</h4>
            <span className="flex items-center gap-2">
              <StatusPill status={row.costStatus} />
              <SegmentPill segment={row.segment} />
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-600">
            {row.coverage.linesCosted} of {row.coverage.lines} sold lines costed
            {row.coverage.partial ? ' — this is a PARTIAL total: the uncosted lines are excluded from margin.' : '.'}
          </p>
          {row.costStatusReason ? (
            <p className="mt-1 text-xs font-semibold text-rose-700">
              Reason no cost exists: {row.costStatusReason.replaceAll('_', ' ').toLowerCase()}
            </p>
          ) : null}
        </div>

        {breakdowns.length === 0 ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            <strong>No recipe cost to explain.</strong> This item has no costed line in the period,
            so there is no recipe version, yield or ingredient cost to show. Its margin is unknown
            — not zero.
          </div>
        ) : (
          breakdowns.map((b) => (
            <div key={b.recipeVersion ?? 'v'} className="rounded-lg border border-slate-200 p-3">
              <h4 className="text-sm font-extrabold text-pos-ink">
                Recipe version {b.recipeVersion ?? UNKNOWN} · yield {b.yieldPercent}%
              </h4>
              <p className="mt-1 text-[11px] text-slate-500">
                Per one unit sold, in the unit the recipe is written in (base units where none is named).
              </p>
              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1">Ingredient</th>
                    <th className="py-1 text-right">Quantity</th>
                    <th className="py-1 text-right">Unit cost</th>
                    <th className="py-1 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {b.ingredients.map((ing, i) => (
                    <tr key={`${ing.item}-${i}`} className="border-b border-slate-100">
                      <td className="py-1 text-slate-700">{ing.item ?? UNKNOWN}</td>
                      <td className="py-1 text-right text-slate-600">{fmtIngredientQty(ing)}</td>
                      <td className="py-1 text-right text-slate-600">{fmtPaise(ing.unitCostPaise)}/unit</td>
                      <td className="py-1 text-right font-semibold text-pos-ink">{fmtMilliPaise(ing.costMilliPaise)}</td>
                    </tr>
                  ))}
                  {b.yieldAdjustmentMilliPaise ? (
                    <tr className="border-b border-slate-100">
                      <td className="py-1 text-slate-700" colSpan={3}>
                        Yield adjustment ({b.yieldPercent}% — trim and loss are paid for too)
                      </td>
                      <td className="py-1 text-right font-semibold text-pos-ink">
                        {fmtMilliPaise(b.yieldAdjustmentMilliPaise)}
                      </td>
                    </tr>
                  ) : null}
                  {b.modifiers?.map((m) => (
                    <tr key={m.modifierId} className="border-b border-slate-100">
                      <td className="py-1 text-slate-700">Modifier: {m.item ?? m.modifierId}</td>
                      <td className="py-1 text-right text-slate-600">{fmtIngredientQty(m)}</td>
                      <td className="py-1 text-right text-slate-600">{fmtPaise(m.unitCostPaise)}/unit</td>
                      <td className="py-1 text-right font-semibold text-pos-ink">{fmtMilliPaise(m.costMilliPaise)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1 font-extrabold text-pos-ink" colSpan={3}>Cost per unit</td>
                    <td className="py-1 text-right font-extrabold text-pos-ink">{fmtMilliPaise(b.unitCostMilliPaise)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-slate-500">
                The authoritative figure is the server's <strong>{fmtPaise(row.cogsPaise)}</strong> for
                {' '}{row.costedQty} costed unit(s): it rounds once, at the end, so adding up the rows
                above can land a paisa away.
              </p>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

export default function MenuProfitability() {
  const { user } = useAuth();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  // Filters live in the URL, so a report someone is looking at can be sent to
  // someone else and open on the same figures — and so an automated check can
  // ask for a specific window instead of driving the controls.
  const [params, setParams] = useSearchParams();
  const from = params.get('from') || istDaysAgo(29);
  const to = params.get('to') || istToday();
  const branchId = params.get('branchId') || '';
  const channel = params.get('channel') || '';
  const groupBy = params.get('groupBy') || 'item';

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const setFrom = (v) => setParam('from', v);
  const setTo = (v) => setParam('to', v);
  const setBranchId = (v) => setParam('branchId', v);
  const setChannel = (v) => setParam('channel', v);
  const setGroupBy = (v) => setParam('groupBy', v);
  const [branches, setBranches] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [drill, setDrill] = useState(null);

  useEffect(() => {
    if (!owner && !atc) return;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        setBranches((data.branches || []).filter((b) => b.status === 'ACTIVE'));
      } catch {
        // The store filter is optional; the report is still scoped server-side.
      }
    })();
  }, [owner, atc]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    setDenied(false);
    try {
      const params = { from, to, groupBy };
      if ((owner || atc) && branchId) params.branchId = branchId;
      if (channel) params.channel = channel;
      const { data } = await api.get('/reports/menu-profitability', { params });
      setReport(data);
    } catch (err) {
      if (err?.response?.status === 403 || apiErrorCode(err) === 'POS_FORBIDDEN') {
        setDenied(true);
      } else {
        setError(apiError(err, 'Could not load menu profitability'));
      }
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [atc, atcScope, from, to, owner, branchId, channel, groupBy]);

  useEffect(() => {
    load();
  }, [load]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Menu profitability" subtitle="VEXO support — choose a company first" />
        <EmptyState icon={Layers} title="No company in scope" note="Open a company from the VEXO console to read its menu profitability." />
      </div>
    );
  }

  const totals = report?.totals;
  const meta = report?.meta;
  const rows = report?.rows ?? [];
  const partialTotals = (totals?.excludedLines ?? 0) > 0;

  return (
    <div>
      <PageHeader
        title="Menu profitability"
        subtitle="Contribution margin by item, store, channel or day — not net business profit"
      />

      {/* Filters */}
      <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs font-semibold text-slate-600">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="filter-from"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-pos-ink" />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="filter-to"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-pos-ink" />
        </label>
        {owner || atc ? (
          <label className="text-xs font-semibold text-slate-600">
            Store
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} data-testid="filter-store"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-pos-ink">
              <option value="">All permitted stores</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        ) : (
          <div className="text-xs font-semibold text-slate-600">
            Store
            <p className="mt-1 flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1.5 text-sm text-slate-600" data-testid="filter-store-pinned">
              <Lock className="h-3.5 w-3.5" /> Your store only
            </p>
          </div>
        )}
        <label className="text-xs font-semibold text-slate-600">
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value)} data-testid="filter-channel"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-pos-ink">
            {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">
          Group
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} data-testid="filter-groupby"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-pos-ink">
            {GROUP_BY.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </label>
      </div>

      {denied ? (
        <div data-testid="access-denied" className="rounded-xl border-2 border-rose-300 bg-rose-50 p-6">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-rose-600" />
            <div>
              <p className="text-sm font-extrabold text-rose-900">You do not have access to menu profitability</p>
              <p className="mt-1 text-xs text-slate-700">
                This report is available to store managers, owners and VEXO support. Ask an owner if
                you need it.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <ErrorNote message={error} /> : null}

      {loading && !report ? (
        <div data-testid="loading" className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Loading menu profitability…
        </div>
      ) : null}

      {report && !denied ? (
        <>
          <CostingBanner costing={meta.costing} />

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={IndianRupee} label="Net sales" value={fmtPaise(totals.netSalesPaise)}
              hint="tax-exclusive, after discounts" accent="royal" />
            <StatCard icon={RotateCcw} label="Refunded (net)" value={fmtPaise(totals.refundNetPaise)}
              hint={`net after refunds ${fmtPaise(totals.netSalesAfterRefundPaise)}`} accent="orange" />
            <StatCard icon={BarChart3} label="Contribution margin" value={fmtPaise(totals.contributionMarginPaise)}
              hint={partialTotals ? `costed lines only — ${totals.excludedLines} excluded` : 'all sold lines costed'}
              accent="green" />
            <StatCard icon={Percent} label="Margin" value={fmtPercent(totals.marginPercent)}
              hint={`COGS ${fmtPaise(totals.cogsPaise)}`} accent="slate" />
          </div>

          <p data-testid="margin-label" className="mb-4 flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <span>
              {meta.marginLabel}
              {partialTotals ? (
                <>
                  {' '}<strong>Totals above are computed over costed lines only</strong> —
                  {' '}{totals.excludedLines} sold line(s) are excluded because no cost exists for them.
                </>
              ) : null}
            </span>
          </p>

          <div className="mb-4 grid items-start gap-4 lg:grid-cols-2">
            <CoverageStrip coverage={report.coverage} />
            {groupBy === 'item' ? <SegmentChart rows={rows} segments={report.segments} /> : (
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
                <h3 className="text-sm font-extrabold text-pos-ink">Popularity vs contribution margin</h3>
                <p className="mt-2 text-xs">
                  The segment chart plots menu items. Switch the grouping back to <strong>By item</strong> to
                  see it — a store or a day is not a menu item and cannot be placed on it.
                </p>
              </div>
            )}
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No sales in this period"
              note="Nothing was billed in the selected range, so there is nothing to report. This is not a zero-margin result."
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[860px] text-sm" data-testid="profit-table">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2">{GROUP_BY.find((g) => g.value === groupBy)?.label.replace('By ', '') ?? 'Item'}</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Net sales</th>
                    <th className="px-3 py-2 text-right">Refunded</th>
                    <th className="px-3 py-2 text-right">COGS</th>
                    <th className="px-3 py-2 text-right">Contribution margin</th>
                    <th className="px-3 py-2 text-right">Margin %</th>
                    <th className="px-3 py-2">Cost coverage</th>
                    {groupBy === 'item' ? <th className="px-3 py-2">Segment</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.key}
                      data-testid={`row-${r.key}`}
                      onClick={() => groupBy === 'item' && setDrill(r)}
                      className={`border-b border-slate-100 ${groupBy === 'item' ? 'cursor-pointer hover:bg-slate-50' : ''}`}
                    >
                      <td className="px-3 py-2 font-semibold text-pos-ink">{r.label}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{r.qty}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{fmtPaise(r.netSalesPaise)}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{fmtPaise(r.refundNetPaise)}</td>
                      <td className="px-3 py-2 text-right text-slate-700" data-testid={`cogs-${r.key}`}>{fmtPaise(r.cogsPaise)}</td>
                      <td className={`px-3 py-2 text-right font-bold ${r.contributionMarginPaise === null ? 'text-rose-600' : r.contributionMarginPaise < 0 ? 'text-rose-700' : 'text-pos-ink'}`}
                        data-testid={`cm-${r.key}`}>
                        {fmtPaise(r.contributionMarginPaise)}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-700">{fmtPercent(r.marginPercent)}</td>
                      <td className="px-3 py-2">
                        <StatusPill status={r.costStatus} />
                        {r.coverage.partial ? (
                          <span className="ml-1 text-[10px] font-bold text-amber-700">partial {r.coverage.linesCosted}/{r.coverage.lines}</span>
                        ) : null}
                      </td>
                      {groupBy === 'item' ? <td className="px-3 py-2"><SegmentPill segment={r.segment} /></td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-3 text-[11px] text-slate-500">
            Contract {meta.contractVersion} · base {meta.baseSha.slice(0, 7)} · period {meta.period.from} to{' '}
            {meta.period.to} ({meta.period.timezone}) · stale-cost window {meta.costing.staleCostDays} days ·
            reconciliation {report.reconciliation.agrees ? 'agrees with stored order totals' : 'DOES NOT AGREE — treat this report as broken'}
          </p>
        </>
      ) : null}

      <Drilldown row={drill} meta={meta} onClose={() => setDrill(null)} />
    </div>
  );
}
