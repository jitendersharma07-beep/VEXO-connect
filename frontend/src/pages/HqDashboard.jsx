// LANE reporting — /reporting, the consolidated owner view.
//
// One screen for a company that is more than one shop. Every figure comes from
// GET /api/reporting/dashboard in a single response, so the company row and the
// store rows are computed from one read and cannot disagree with each other.
//
// Nothing here is authorised by being on this screen. The stores in the table are
// the stores the server resolved from the caller's own assignment; clicking one
// opens a report the server gates again. Hiding a row would not protect it — the
// isolation is on the request, and this screen is only the part a person sees.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Building2, ChevronRight, Settings2 } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';
import {
  BasisNote,
  ComparisonNote,
  CoverageStrip,
  MetricCard,
  PeriodBar,
  PeriodStamp,
  ReportTable,
  ShareChart,
} from '../components/reporting.jsx';
import {
  REPORT_LABELS,
  STATE_LABELS,
  STATE_STYLES,
  filtersFromSearch,
  fmtInt,
  fmtMoney,
  fmtPercent,
  reportParams,
} from '../lib/reporting.js';

// The server names its drill-down targets as API paths. Reading the report key
// out of them — rather than listing the reports again here — keeps the set of
// things a metric can open the server's decision, not the client's.
const keyFromApiHref = (href) => {
  const m = /\/api\/reporting\/reports\/([A-Za-z]+)/.exec(href ?? '');
  return m ? m[1] : null;
};

const optionsFrom = (stores) => {
  const uniq = (list) => [...new Map(list.map((x) => [x.id, x])).values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    stores: (stores ?? []).map((s) => ({ id: s.id, name: s.name, code: s.code })),
    regions: uniq((stores ?? []).filter((s) => s.regionId).map((s) => ({ id: s.regionId, name: s.regionName ?? s.regionId }))),
    brands: uniq((stores ?? []).flatMap((s) => s.brands ?? [])),
    legalEntities: uniq(
      (stores ?? [])
        .filter((s) => s.legalEntityId)
        .map((s) => ({ id: s.legalEntityId, name: s.legalEntityName ?? s.legalEntityId })),
    ),
    hasDemo: (stores ?? []).some((s) => s.isDemo),
  };
};

export default function HqDashboard() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  // The period and filters live in the URL, as they do on every other report
  // screen. Holding them in component state alone made this one screen — the
  // consolidated view an owner is most likely to send to an accountant — the
  // only one where a link arrived showing Today, and a reload silently threw
  // the chosen month away.
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(searchParams), [searchParams]);
  const setFilters = (next) => setSearchParams(reportParams(next), { replace: true });
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState(null);
  // The filter option lists are taken from the FIRST unnarrowed answer and then
  // kept. Recomputing them from every response would delete the option that is
  // currently selected — filter to one region and the region list collapses to
  // that region, leaving no way back.
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (atc && !atcScope) return;
    (async () => {
      try {
        const { data: cat } = await api.get('/reporting/catalog');
        setCatalog(cat);
      } catch {
        // The dashboard stands without the catalog; only the report links and the
        // capability panel need it, and both say less rather than guess.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atc, atcScope?.id]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    try {
      const { data: d } = await api.get('/reporting/dashboard', { params: reportParams(filters) });
      setData(d);
      setOptions((prev) => (prev && d.scope.narrowed ? prev : optionsFrom(d.scope.stores)));
    } catch (err) {
      setError(apiError(err, 'Could not load the dashboard'));
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, atc, atcScope?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const openReport = (key, extra = {}) =>
    navigate(`/reporting/${key}?${new URLSearchParams({ ...reportParams(filters), ...extra })}`);

  const openStore = (row) => openReport('sales', { storeId: row.storeId });

  const openMetric = (metricKey) => {
    const key = keyFromApiHref(data?.drilldown?.metrics?.[metricKey]);
    if (key) openReport(key);
  };

  const t = data?.totals;
  const d = data?.comparison?.delta;

  // A report the caller may not read, or that this build cannot produce, is not
  // offered as a drill-down. A chip that opens onto a refusal teaches an owner to
  // distrust the screen.
  const openableMetrics = useMemo(() => {
    const byKey = new Map((catalog?.reports ?? []).map((r) => [r.key, r]));
    return Object.values(data?.drilldown?.metrics ?? {})
      .map(keyFromApiHref)
      .filter((key) => key && byKey.get(key)?.buildable)
      .filter((key, i, a) => a.indexOf(key) === i);
  }, [data, catalog]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Consolidated dashboard" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={Building2}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Consolidated dashboard"
        subtitle={
          data
            ? `${data.scope.stores.length} store${data.scope.stores.length === 1 ? '' : 's'} in your access${
                data.scope.narrowed ? ' · filtered' : ''
              }`
            : 'All the locations you are authorised to see'
        }
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost min-h-[38px] text-sm" onClick={() => navigate('/reporting/reports')}>
              <BarChart3 className="mr-1.5 inline h-4 w-4" />
              All reports
            </button>
            {can('report.settings.read') ? (
              <button
                type="button"
                className="btn-ghost min-h-[38px] text-sm"
                onClick={() => navigate('/reporting/settings')}
              >
                <Settings2 className="mr-1.5 inline h-4 w-4" />
                Period settings
              </button>
            ) : null}
          </div>
        }
      />

      <PeriodBar
        filters={filters}
        onChange={setFilters}
        presets={catalog?.presets}
        groupings={catalog?.groupings}
        options={options}
      />

      {error ? <ErrorNote message={error} /> : null}

      {!data && loading ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {data ? (
        <div className={loading ? 'opacity-60' : ''}>
          <PeriodStamp period={data.period} generatedAt={data.generatedAt} />
          <ComparisonNote comparison={data.comparison} />
          <CoverageStrip coverage={data.coverage} />

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              testid="kpi-netSales"
              label="Net sales (excl. tax)"
              value={fmtMoney(t.netSales)}
              hint={`invoiced ${fmtMoney(t.invoiced)}`}
              delta={d?.netSales}
              onClick={() => openMetric('netSales')}
            />
            <MetricCard
              testid="kpi-collected"
              label="Collected"
              value={fmtMoney(t.collected)}
              hint={`${fmtPercent(t.collectedVsSalesPercent)} of invoiced`}
              delta={d?.collected}
              onClick={() => openMetric('collected')}
            />
            <MetricCard
              testid="kpi-orders"
              label="Bills"
              value={fmtInt(t.finalizedOrders)}
              hint={`${fmtInt(t.openOrders)} still open · ${fmtInt(t.voidedOrders)} voided`}
              delta={d?.finalizedOrders}
            />
            <MetricCard
              testid="kpi-aov"
              label="Average bill"
              value={fmtMoney(t.averageOrderValue)}
              hint="net sales ÷ bills, recomputed"
              delta={d?.averageOrderValue}
            />
            <MetricCard
              testid="kpi-dues"
              label="Outstanding dues"
              value={fmtMoney(t.dues)}
              hint={`${fmtInt(t.dueOrders)} unpaid bill${t.dueOrders === 1 ? '' : 's'}, whenever raised`}
              higherIsBetter={false}
              onClick={() => openMetric('dues')}
            />
            <MetricCard
              testid="kpi-refunds"
              label="Refunds"
              value={fmtMoney(t.refunds)}
              hint={`${fmtMoney(t.refundsPending)} still pending with the provider`}
              delta={d?.refunds}
              higherIsBetter={false}
              onClick={() => openMetric('refunds')}
            />
            <MetricCard
              testid="kpi-discounts"
              label="Discounts"
              value={fmtMoney(t.discounts)}
              hint={`${fmtPercent(t.discountRatePercent)} of gross items`}
              delta={d?.discounts}
              higherIsBetter={false}
              onClick={() => openMetric('discounts')}
            />
            <MetricCard
              testid="kpi-tax"
              label="Tax collected"
              value={fmtMoney(t.tax)}
              hint="held on the government's behalf, not turnover"
            />
          </div>

          {/* §4's "things to act on" band. Placed above the location table
              because a cash shortfall somebody has to explain outranks the sales
              figure, and it names the undetectable checks rather than implying a
              swept estate: "3 to act on" next to nothing about stock would be read
              as "and stock is fine". */}
          {data.exceptions && can('report.exception.read') ? (
            <button
              type="button"
              className="card mt-4 flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:border-pos-royal/40"
              onClick={() =>
                navigate({
                  pathname: '/reporting/exceptions',
                  search: new URLSearchParams(reportParams(filters)).toString(),
                })
              }
              data-testid="dashboard-exceptions"
            >
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Needs action
                  </div>
                  <div className="text-3xl font-black tabular-nums text-pos-ink">
                    {fmtInt(data.exceptions.open)}
                  </div>
                </div>
                <div className="text-xs text-slate-600">
                  <div>
                    {fmtInt(data.exceptions.bySeverity?.CRITICAL ?? 0)} critical ·{' '}
                    {fmtInt(data.exceptions.bySeverity?.WARNING ?? 0)} warning
                  </div>
                  <div>{fmtInt(data.exceptions.overdue)} past its due time</div>
                </div>
              </div>
              <div className="text-xs text-slate-500">
                Open the worklist
                <ChevronRight className="ml-1 inline h-3.5 w-3.5" />
              </div>
            </button>
          ) : null}

          <div className="mt-4">
            <ShareChart rows={data.rows} onRowClick={openStore} />
          </div>

          <div className="mb-2 mt-6 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
              Location comparison
            </h2>
            <p className="text-xs text-slate-500">Select a store to open its own reports.</p>
          </div>
          <ReportTable
            columns={data.columns}
            rows={data.rows}
            totals={data.totals}
            onRowClick={openStore}
            emptyNote="No store in the selected scope recorded a bill in this period."
          />

          {openableMetrics.length ? (
            <div className="card mt-4 p-5">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">
                Open the records behind a figure
              </h2>
              <div className="flex flex-wrap gap-2">
                {openableMetrics.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="btn-ghost min-h-[36px] px-3 py-1.5 text-xs"
                    onClick={() => openReport(key)}
                  >
                    {REPORT_LABELS[key] ?? key}
                    <ChevronRight className="ml-1 inline h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* The families this deployment cannot answer, named. §4 asks for stock
              variance, wastage and food cost on this screen; they are not here,
              and saying so is the only honest way to show that. */}
          {catalog?.capabilities ? (
            <div className="card mt-4 p-5" data-testid="capability-panel">
              <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">
                Not on this dashboard yet
              </h2>
              <p className="mb-3 text-xs text-slate-500">
                These are absent rather than zero. A zero food cost or a zero wastage figure would be
                acted on.
              </p>
              <div className="space-y-2">
                {Object.values(catalog.capabilities)
                  .filter((c) => c.state !== 'AVAILABLE')
                  .map((c) => (
                    <div key={c.key} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className={`badge ${STATE_STYLES[c.state]}`}>{STATE_LABELS[c.state] ?? c.state}</span>
                      <span className="font-semibold text-slate-700">{c.label}</span>
                      <span className="text-slate-500">{c.note}</span>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          <BasisNote basis={data.basis} caveats={data.caveats} notes={data.notes} />
        </div>
      ) : null}
    </div>
  );
}

const route2key = (href) => {
  const m = /\/api\/reporting\/reports\/([A-Za-z]+)/.exec(href ?? '');
  return m ? m[1] : '';
};
