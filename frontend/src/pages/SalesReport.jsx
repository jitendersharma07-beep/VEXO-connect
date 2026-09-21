import { useCallback, useEffect, useState } from 'react';
import { BarChart3, IndianRupee, Percent, ReceiptText, RotateCcw, Wallet } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, PageHeader, StatCard } from '../components/ui.jsx';
import { channelStyle, fmtINR, getAtcScope, isAtc, istDaysAgo, istToday } from '../lib/pos.js';

// /reports — sales report (contract §10). Every figure is rendered from the
// server's report object; the note is rendered verbatim. CASHIER gets 403 by
// contract and never reaches this route (nav + route guard).

export default function SalesReport() {
  const { user } = useAuth();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const [from, setFrom] = useState(istDaysAgo(6));
  const [to, setTo] = useState(istToday());
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!owner) return;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        setBranches((data.branches || []).filter((b) => b.status === 'ACTIVE'));
      } catch {
        // branch filter optional
      }
    })();
  }, [owner]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (owner && branchId) params.branchId = branchId;
      const { data } = await api.get('/reports/sales', { params });
      setReport(data.report);
    } catch (err) {
      setError(apiError(err, 'Could not load the sales report'));
    } finally {
      setLoading(false);
    }
  }, [atc, atcScope, from, to, owner, branchId]);

  useEffect(() => {
    load();
  }, [load]);

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Sales report" subtitle="ATC operators browse per company." />
        <EmptyState
          icon={BarChart3}
          title="No company selected"
          note="Open a company from the ATC console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sales report"
        subtitle={
          atcScope
            ? `Company: ${atcScope.name || atcScope.id}`
            : owner
              ? 'All branches, or filter to one'
              : 'Your branch'
        }
      />

      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="rep-from">From (IST)</label>
          <input id="rep-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="rep-to">To (IST)</label>
          <input id="rep-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {owner ? (
          <div>
            <label className="label" htmlFor="rep-branch">Branch</label>
            <select id="rep-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setFrom(istToday()); setTo(istToday()); }}>
            Today
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setFrom(istDaysAgo(6)); setTo(istToday()); }}>
            Last 7 days
          </button>
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => { setFrom(istDaysAgo(29)); setTo(istToday()); }}>
            Last 30 days
          </button>
        </div>
      </div>

      {error ? <ErrorNote message={error} /> : null}
      {!report && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {report ? (
        <div className={loading ? 'opacity-60' : ''}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard icon={IndianRupee} label="Net sales" value={fmtINR(report.sales.netSales)} hint="Σ order totals (PAID + REFUNDED, billed in range)" accent="royal" />
            <StatCard icon={Wallet} label="Collected" value={fmtINR(report.sales.collected)} hint="payments recorded in range" accent="green" />
            <StatCard icon={RotateCcw} label="Refunds" value={fmtINR(report.sales.refunds)} hint="refunds recorded in range" accent="orange" />
            <StatCard icon={Percent} label="Tax" value={fmtINR(report.sales.tax)} hint={`discounts ${fmtINR(report.sales.discounts)} · gross items ${fmtINR(report.sales.grossItems)}`} accent="slate" />
          </div>

          <div className="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
            <span className="flex items-center gap-1.5 font-semibold text-pos-ink">
              <ReceiptText className="h-4 w-4 text-slate-400" /> Orders: {report.orders.total}
            </span>
            <span className="text-slate-600">open {report.orders.open}</span>
            <span className="text-slate-600">billed {report.orders.billed}</span>
            <span className="text-emerald-700">paid {report.orders.paid}</span>
            <span className="text-purple-700">refunded {report.orders.refunded}</span>
            <span className="text-slate-500">voided {report.orders.voided}</span>
          </div>

          {/* How much of the collected money a person asserted versus how much
              a provider confirmed. Given its own row rather than buried in the
              method table, because it is the one figure an owner reconciles. */}
          {report.byChannel?.length ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {report.byChannel.map((c) => (
                <div key={c.channel} className="card flex items-center justify-between px-5 py-4">
                  <div>
                    <span className={`badge ${channelStyle(c.channel)}`}>{c.channel}</span>
                    <p className="mt-1 text-xs text-slate-500">
                      {c.channel === 'GATEWAY'
                        ? 'Settled by the provider, confirmed by webhook'
                        : 'Hand-recorded by staff, not provider-verified'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-extrabold text-pos-ink">{fmtINR(c.amount)}</p>
                    <p className="text-xs text-slate-400">{c.count} payment{c.count === 1 ? '' : 's'}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">By payment method</h2>
              {report.byMethod.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No payments in this range.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2">Method</th>
                      <th className="pb-2">Channel</th>
                      <th className="pb-2 text-right">Count</th>
                      <th className="pb-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byMethod.map((m, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-2 font-semibold text-pos-ink">{m.method}</td>
                        <td className="py-2">
                          <span className={`badge ${channelStyle(m.channel)}`}>{m.channel}</span>
                        </td>
                        <td className="py-2 text-right text-slate-600">{m.count}</td>
                        <td className="py-2 text-right font-semibold text-pos-ink">{fmtINR(m.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {/* §10: render the note verbatim */}
              <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">{report.note}</p>
            </div>

            <div className="card p-5">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">By category</h2>
              {report.byCategory.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">No item sales in this range.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2">Category</th>
                      <th className="pb-2 text-right">Qty</th>
                      <th className="pb-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byCategory.map((c) => (
                      <tr key={c.categoryId} className="border-t border-slate-100">
                        <td className="py-2 font-semibold text-pos-ink">{c.name}</td>
                        <td className="py-2 text-right text-slate-600">{c.qty}</td>
                        <td className="py-2 text-right font-semibold text-pos-ink">{fmtINR(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="card mt-4 p-5">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">By day (IST)</h2>
            {report.byDay.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">No activity in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2">Date</th>
                      <th className="pb-2 text-right">Orders</th>
                      <th className="pb-2 text-right">Net sales</th>
                      <th className="pb-2 text-right">Collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byDay.map((d) => (
                      <tr key={d.date} className="border-t border-slate-100">
                        <td className="py-2 font-semibold text-pos-ink">{d.date}</td>
                        <td className="py-2 text-right text-slate-600">{d.orders}</td>
                        <td className="py-2 text-right text-slate-600">{fmtINR(d.netSales)}</td>
                        <td className="py-2 text-right font-semibold text-pos-ink">{fmtINR(d.collected)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
