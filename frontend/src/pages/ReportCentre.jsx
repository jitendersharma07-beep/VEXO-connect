// LANE reporting — /reporting/reports, the index of what this deployment answers.
//
// The list is the server's list. GET /api/reporting/catalog already omits every
// report the caller may not read and marks every family this build cannot produce
// with the reason, so a hardcoded menu here would only ever be a second opinion
// that drifts — and the way it drifts is that somebody clicks a report that does
// not exist, or worse, one they cannot open.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, ChevronRight, LayoutDashboard } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import { getAtcScope, isAtc } from '../lib/pos.js';
import {
  FAMILY_GROUPS,
  REPORT_LABELS,
  STATE_LABELS,
  STATE_STYLES,
} from '../lib/reporting.js';

// Anything the server lists whose family is not in a group above still has to
// appear. A report that exists and is readable but falls through the grouping is
// a report nobody can find.
const groupsFor = (reports) => {
  const seen = new Set();
  const groups = FAMILY_GROUPS.map((g) => {
    const items = reports.filter((r) => g.families.includes(r.family));
    items.forEach((r) => seen.add(r.key));
    return { ...g, items };
  }).filter((g) => g.items.length);
  const rest = reports.filter((r) => !seen.has(r.key));
  return rest.length ? [...groups, { key: 'rest', label: 'Other', items: rest }] : groups;
};

export default function ReportCentre() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (atc && !atcScope) return;
    (async () => {
      try {
        const { data } = await api.get('/reporting/catalog');
        setCatalog(data);
      } catch (err) {
        setError(apiError(err, 'Could not load the report list'));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atc, atcScope?.id]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Reports" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={BarChart3}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  const ready = (catalog?.reports ?? []).filter((r) => r.buildable).length;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={
          catalog
            ? `${ready} of ${catalog.reports.length} report${catalog.reports.length === 1 ? '' : 's'} you can read are available in this build`
            : 'Everything this deployment can report on'
        }
        actions={
          <button type="button" className="btn-ghost min-h-[38px] text-sm" onClick={() => navigate('/reporting')}>
            <LayoutDashboard className="mr-1.5 inline h-4 w-4" />
            Consolidated dashboard
          </button>
        }
      />

      {error ? <ErrorNote message={error} /> : null}

      {!catalog && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {catalog && !catalog.reports.length ? (
        <EmptyState
          icon={BarChart3}
          title="No reports in your permissions"
          note="Reports are granted one authority at a time — sales, tax, collections and stock are separate. The account owner can change this from Users & Access."
        />
      ) : null}

      {catalog
        ? groupsFor(catalog.reports).map((g) => (
            <section key={g.key} className="mb-6" data-testid={`report-group-${g.key}`}>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">{g.label}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {g.items.map((r) => {
                  const openable = r.buildable;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      data-testid={`report-card-${r.key}`}
                      disabled={!openable}
                      onClick={() => navigate(`/reporting/${r.key}`)}
                      className={`card p-4 text-left transition-shadow ${
                        openable ? 'hover:shadow-md' : 'cursor-default opacity-70'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-bold text-pos-ink">
                          {REPORT_LABELS[r.key] ?? r.key}
                        </span>
                        {openable ? (
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                        ) : (
                          <span className={`badge shrink-0 ${STATE_STYLES[r.state]}`}>
                            {STATE_LABELS[r.state] ?? r.state}
                          </span>
                        )}
                      </div>
                      {/* The reason, verbatim from the server. "Pending integration"
                          with no explanation is what makes somebody assume zero. */}
                      {r.note ? <p className="mt-1.5 text-xs text-slate-500">{r.note}</p> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        : null}
    </div>
  );
}
