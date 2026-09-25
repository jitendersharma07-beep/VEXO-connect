// LANE reporting — /reporting/:key, one screen for every report.
//
// Twelve report families and one component, because the payload describes itself:
// `columns` say what the table holds, `totals` say what the company row is,
// `coverage` says how much of the company the figures cover and `basis` says which
// date each figure is counted on. A page per report would be twelve places for the
// same formatting bug to be fixed eleven times.
//
// The filters live in the URL rather than in component state alone. That is what
// makes a report shareable: a manager who sends "last week, Cyber Hub" as a link
// sends the same request, and the server still resolves the recipient's own store
// list — so the link cannot carry reach with it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BarChart3, Download } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';
import {
  BasisNote,
  ComparisonNote,
  CoverageStrip,
  ExportButtons,
  MetricCard,
  PeriodBar,
  PeriodStamp,
  ReportTable,
  TrendChart,
  UnavailableCard,
} from '../components/reporting.jsx';
import {
  REPORT_LABELS,
  downloadReport,
  filtersFromSearch,
  fmtInt,
  fmtMoney,
  fmtPercent,
  reportParams,
} from '../lib/reporting.js';

// Reports whose rows are periods rather than stores, and which therefore get a
// grouping control and a trend line.
const PERIOD_REPORTS = new Set(['salesByPeriod']);

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

export default function ReportView() {
  const { key } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const filters = useMemo(() => filtersFromSearch(searchParams), [searchParams]);
  const [report, setReport] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState('');

  const setFilters = (next) => setSearchParams(reportParams(next), { replace: true });

  useEffect(() => {
    if (atc && !atcScope) return;
    (async () => {
      try {
        const { data } = await api.get('/reporting/catalog');
        setCatalog(data);
      } catch {
        // Only the preset list and the store options need it; both degrade to a
        // smaller set of controls rather than to a wrong report.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atc, atcScope?.id]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/reporting/reports/${key}`, { params: reportParams(filters) });
      setReport(data);
      if (data.scope) setOptions((prev) => (prev && data.scope.narrowed ? prev : optionsFrom(data.scope.stores)));
    } catch (err) {
      setError(apiError(err, 'Could not load this report'));
      setReport(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, searchParams.toString(), atc, atcScope?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const doExport = async (format) => {
    setExporting(format);
    setError('');
    try {
      await downloadReport(key, filters, format);
    } catch (err) {
      setError(apiError(err, `Could not export as ${format.toUpperCase()}`));
    } finally {
      setExporting('');
    }
  };

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Report" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={BarChart3}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  const t = report?.totals;
  const d = report?.comparison?.delta;
  const isPeriodReport = PERIOD_REPORTS.has(key);
  // publicTotals reports are the ones with a money summary worth a KPI strip. A
  // tax-by-rate or a cash-difference report has its own totals shape and only the
  // table footer to put it in.
  const hasMoneyTotals = Boolean(t?.netSales && t?.collected);
  const storeFiltered = report?.scope?.filters?.storeId;

  return (
    <div>
      <PageHeader
        title={report?.label ?? REPORT_LABELS[key] ?? key}
        // A report that cannot be produced carries no scope: there is no store
        // list to summarise, because nothing was measured over one. Reading
        // through to .stores threw here, and the error boundary replaced the
        // whole screen — so every unavailable report, which is the case this
        // lane exists to report honestly, crashed instead of explaining itself.
        subtitle={
          report?.scope?.stores
            ? `${report.scope.stores.length} store${report.scope.stores.length === 1 ? '' : 's'}${
                storeFiltered ? ` · ${report.scope.stores[0]?.name ?? 'filtered'}` : ''
              }`
            : null
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost min-h-[38px] text-sm" onClick={() => navigate('/reporting/reports')}>
              <ArrowLeft className="mr-1.5 inline h-4 w-4" />
              All reports
            </button>
            {report?.available ? (
              <>
                <span className="flex items-center gap-1 text-xs font-semibold text-slate-500">
                  <Download className="h-3.5 w-3.5" /> Export
                </span>
                <ExportButtons
                  formats={catalog?.formats ?? ['csv', 'xlsx', 'pdf']}
                  onExport={doExport}
                  busy={exporting}
                />
              </>
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
        showGrouping={isPeriodReport}
      />

      {error ? <ErrorNote message={error} /> : null}

      {!report && loading ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {report && !report.available ? (
        <>
          <PeriodStamp period={report.period} />
          <UnavailableCard report={report} />
        </>
      ) : null}

      {report?.available ? (
        <div className={loading ? 'opacity-60' : ''}>
          <PeriodStamp period={report.period} generatedAt={report.generatedAt} />
          <ComparisonNote comparison={report.comparison} />
          {report.coverage?.summary ? <CoverageStrip coverage={report.coverage} /> : null}

          {hasMoneyTotals ? (
            <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                testid="kpi-netSales"
                label="Net sales (excl. tax)"
                value={fmtMoney(t.netSales)}
                hint={`invoiced ${fmtMoney(t.invoiced)}`}
                delta={d?.netSales}
              />
              <MetricCard
                testid="kpi-collected"
                label="Collected"
                value={fmtMoney(t.collected)}
                hint={`${fmtPercent(t.collectedVsSalesPercent)} of invoiced`}
                delta={d?.collected}
              />
              <MetricCard
                testid="kpi-orders"
                label="Bills"
                value={fmtInt(t.finalizedOrders)}
                hint={`average ${fmtMoney(t.averageOrderValue)}`}
                delta={d?.finalizedOrders}
              />
              <MetricCard
                testid="kpi-discounts"
                label="Discounts"
                value={fmtMoney(t.discounts)}
                hint={`${fmtPercent(t.discountRatePercent)} of gross items`}
                delta={d?.discounts}
                higherIsBetter={false}
              />
            </div>
          ) : null}

          {isPeriodReport ? <TrendChart rows={report.rows} /> : null}

          <ReportTable
            columns={report.columns}
            rows={report.rows}
            totals={report.totals}
            emptyNote={report.coverage?.note ?? undefined}
          />

          {/* Menu quantities sold, shown on the consumption screen because they
              are the one strand of the five that IS measured today. Kept visibly
              apart from the four that are not, so nobody reads a sales quantity
              as an ingredient usage. */}
          {report.meta?.figures ? (
            <div className="card mt-4 p-5" data-testid="consumption-figures">
              <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">
                The five figures, kept apart
              </h2>
              <p className="mb-3 text-xs text-slate-500">
                Menu sales, expected recipe usage, physical depletion, recorded wastage and
                unexplained variance are five different measurements. Collapsing them is what turns a
                book balance into a claim about the shelves.
              </p>
              <div className="space-y-1.5">
                {report.meta.figures.map((f) => (
                  <div key={f.key} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span
                      className={`badge ${
                        f.measured ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {f.measured ? 'Measured' : 'Not measured'}
                    </span>
                    <span className="font-semibold text-slate-700">{f.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <BasisNote
            basis={report.basis}
            caveats={report.caveats}
            // The coverage note reached the screen only as the empty table's
            // message, so it vanished the moment a report had rows to show —
            // which is exactly when consumption needs it, since its rows fill two
            // columns and leave four deliberately blank. Shown here only when the
            // table is not showing it, so it appears once and always.
            notes={[
              ...(report.notes ?? []),
              ...(report.coverage?.note && report.rows?.length ? [report.coverage.note] : []),
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
