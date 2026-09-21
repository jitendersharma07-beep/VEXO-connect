import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Store, Users, BadgeCheck, CalendarClock, ReceiptText } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { canSeeReports } from '../lib/pos.js';
import {
  PageHeader,
  StatCard,
  StatusBadge,
  DemoBadge,
  ErrorNote,
  FullScreenSpinner,
} from '../components/ui.jsx';

const daysLeft = (iso) => Math.ceil((new Date(iso) - Date.now()) / 86400000);

export default function Dashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, b] = await Promise.all([api.get('/dashboard/summary'), api.get('/branches')]);
        if (!alive) return;
        setSummary(s.data);
        setBranches(b.data.branches);
      } catch (err) {
        if (alive) setError(apiError(err, 'Could not load the dashboard'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!summary) return <FullScreenSpinner />;

  const lic = summary.license;
  const expiry = lic?.expiresAt ? daysLeft(lic.expiresAt) : null;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Dashboard {summary.company.isDemo ? <DemoBadge /> : null}
          </span>
        }
        subtitle={`Welcome back, ${user.fullName}`}
      />

      {summary.company.isDemo ? (
        <div className="mb-6 rounded-lg border border-pos-orange/30 bg-pos-orange/10 px-4 py-3 text-sm text-pos-ember">
          This is the demo workspace with sample café branches. All figures are counts of sample
          records — there is no live business data here.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Store}
          label="Active branches"
          value={summary.branches.active}
          hint={lic ? `of ${lic.branchLimit} allowed by licence` : `${summary.branches.total} total`}
          accent="royal"
        />
        <StatCard
          icon={Users}
          label="Team members"
          value={summary.users.active}
          hint="active POS accounts in this company"
          accent="orange"
        />
        <StatCard
          icon={BadgeCheck}
          label="Licence"
          value={lic ? lic.plan.replace('_', ' ') : '—'}
          hint={lic ? <StatusBadge status={lic.status} /> : 'No licence issued yet'}
          accent="green"
        />
        <StatCard
          icon={CalendarClock}
          label="Licence expiry"
          value={expiry === null ? '—' : expiry > 0 ? `${expiry}d` : 'Expired'}
          hint={lic?.expiresAt ? new Date(lic.expiresAt).toLocaleDateString() : ''}
          accent={expiry !== null && expiry <= 7 ? 'orange' : 'slate'}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Your branches</h2>
            <Link to="/branches" className="text-sm font-semibold text-pos-royal hover:underline">
              Manage branches →
            </Link>
          </div>
          {branches.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No branches visible to your account yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {branches.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-pos-ink">{b.name}</span>
                      {b.isDemo ? <DemoBadge /> : null}
                    </div>
                    <div className="text-xs text-slate-500">
                      {b.code}
                      {b.city ? ` · ${b.city}` : ''}
                      {b.state ? `, ${b.state}` : ''}
                    </div>
                  </div>
                  <StatusBadge status={b.status} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card flex flex-col items-center justify-center p-6 text-center">
          <div className="rounded-xl bg-slate-100 p-3">
            <ReceiptText className="h-6 w-6 text-slate-400" />
          </div>
          <h2 className="mt-3 text-sm font-bold text-slate-600">Sales &amp; billing</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            {summary.sales.note}, over a date range you choose. Nothing is totalled here, so there
            is only ever one set of figures to reconcile.
          </p>
          {canSeeReports(user) ? (
            <Link to="/reports" className="mt-3 text-xs font-semibold text-pos-royal hover:underline">
              Open the sales report →
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
