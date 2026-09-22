import { useCallback, useEffect, useState } from 'react';
import { Percent, RotateCcw, ScrollText, Users, XCircle } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { EmptyState, ErrorNote, PageHeader, RoleBadge, StatCard } from '../components/ui.jsx';
import { fmtDateTime, fmtINR, getAtcScope, isAtc, istDaysAgo, istToday } from '../lib/pos.js';

// /reports/activity — who gave the discount, who voided the bill, who refunded.
//
// Every row here has been written to "PosAuditLog" since the first release and
// nothing read it, which made "discounts are recorded against the person who
// applied them" sound like a control an owner could check when no owner could.
//
// The design point is that a TOTAL is the wrong shape for the question. "₹4,200
// of discounts this week" is not something anyone can act on; "one cashier gave
// 40 of the 46" is. So the per-person split leads, with a share bar, and the
// event list is underneath for when a name stands out and you want the detail.

// `cleared` is deliberately its own kind and its own colour. Removing a
// discount is not giving one, and counting the undo alongside the discount
// inflates the figure an owner acts on — against the person who fixed the
// mistake. Slate, not orange: nothing was given away.
const KIND_STYLES = {
  discount: 'bg-pos-orange/15 text-pos-ember',
  cleared: 'bg-slate-100 text-slate-600',
  void: 'bg-red-100 text-red-700',
  refund: 'bg-purple-100 text-purple-700',
};

// One filter per kind the API can return, keyed by the kind itself so the two
// cannot drift. '' is All. A kind with no button here would be visible in the
// list but unreachable from the filters.
const KIND_FILTERS = {
  '': 'All',
  discount: 'Discounts',
  cleared: 'Removed',
  void: 'Voids',
  refund: 'Refunds',
};

// The action name is the record; this is only what to call it on screen.
const ACTION_LABELS = {
  ORDER_DISCOUNT_SET: 'Order discount',
  ORDER_DISCOUNT_CLEAR: 'Discount removed',
  ORDER_ITEM_UPDATE: 'Line discount',
  ORDER_VOID: 'Order voided',
  ORDER_ITEM_VOID: 'Line voided',
  ORDER_REFUND: 'Refund',
  ORDER_REFUND_REQUESTED: 'Refund requested',
  ORDER_REFUND_SETTLED: 'Refund settled',
  ORDER_REFUND_FAILED: 'Refund failed',
  ORDER_REFUND_RECONCILED: 'Refund reconciled',
};

// Falls back to the raw action rather than to a friendly guess. A name nobody
// has mapped yet is a real event, and showing it as "Other" would hide it.
const labelFor = (action) => ACTION_LABELS[action] || action;

function detailText(ev) {
  const d = ev.detail || {};
  if (ev.action === 'ORDER_DISCOUNT_SET') {
    if (d.discountType === 'PERCENT') return `${d.value}% off the order`;
    if (d.discountType === 'FLAT') return `${fmtINR(d.value)} off the order`;
    return '—';
  }
  if (ev.action === 'ORDER_ITEM_UPDATE') return `${fmtINR(d.lineDiscount)} off one line`;
  if (ev.action === 'ORDER_ITEM_VOID') return [d.item, d.reason].filter(Boolean).join(' — ') || '—';
  if (ev.action === 'ORDER_VOID') return d.reason || '—';
  if (ev.kind === 'refund') {
    const bits = [];
    if (d.amount) bits.push(fmtINR(d.amount));
    if (d.reason) bits.push(d.reason);
    return bits.join(' — ') || '—';
  }
  return '—';
}

export default function ActivityReport() {
  const { user } = useAuth();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const [from, setFrom] = useState(istDaysAgo(6));
  const [to, setTo] = useState(istToday());
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState([]);
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!owner) return;
    (async () => {
      try {
        const { data: res } = await api.get('/branches');
        setBranches((res.branches || []).filter((b) => b.status === 'ACTIVE'));
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
      const { data: res } = await api.get('/reports/activity', { params });
      setData(res);
    } catch (err) {
      setError(apiError(err, 'Could not load the activity report'));
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
        <PageHeader title="Discounts, voids and refunds" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={ScrollText}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  const byActor = data?.byActor || [];
  const events = data?.events || [];
  const shown = kind ? events.filter((e) => e.kind === kind) : events;
  const totals = byActor.reduce(
    (a, p) => ({
      discounts: a.discounts + p.discounts,
      cleared: a.cleared + p.cleared,
      voids: a.voids + p.voids,
      refunds: a.refunds + p.refunds,
    }),
    { discounts: 0, cleared: 0, voids: 0, refunds: 0 },
  );
  const busiest = byActor.length ? byActor[0].total : 0;

  return (
    <div>
      <PageHeader
        title="Discounts, voids and refunds"
        subtitle={
          atcScope
            ? `Company: ${atcScope.name || atcScope.id}`
            : owner
              ? 'Who did it, across all branches or one'
              : 'Who did it, in your branch'
        }
      />

      <div className="card mb-5 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="act-from">From (IST)</label>
          <input id="act-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="act-to">To (IST)</label>
          <input id="act-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {owner ? (
          <div>
            <label className="label" htmlFor="act-branch">Branch</label>
            <select id="act-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
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
      {!data && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {data ? (
        <div className={loading ? 'opacity-60' : ''}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {/* The number is discounts GIVEN. Removals are named beside it
                rather than added into it — an owner reading "46" needs that to
                mean 46 discounts, not 45 and a correction. */}
            <StatCard
              icon={Percent}
              label="Discounts"
              value={totals.discounts}
              hint={
                totals.cleared
                  ? `order and line discounts given · ${totals.cleared} later removed`
                  : 'order and line discounts given'
              }
              accent="orange"
            />
            <StatCard icon={XCircle} label="Voids" value={totals.voids} hint="orders and kitchen-sent lines voided" accent="red" />
            <StatCard icon={RotateCcw} label="Refunds" value={totals.refunds} hint="every stage, manual and gateway" accent="royal" />
            <StatCard icon={Users} label="People" value={byActor.length} hint="staff with activity in this range" accent="slate" />
          </div>

          {/* The headline. Counts per person, busiest first, with a share bar —
              because the question an owner actually has is whether one name is
              doing most of it, and a column of numbers does not answer that at
              a glance. */}
          <div className="card mt-4 p-5">
            <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-slate-500">By person</h2>
            <p className="mb-4 text-xs text-slate-500">
              A rupee total is not the signal. One person doing most of the discounting is.
            </p>
            {byActor.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">
                Nobody discounted, voided or refunded anything in this range.
              </p>
            ) : (
              <div className="space-y-3">
                {byActor.map((p) => (
                  <div key={p.actorId || p.actorEmail || 'unknown'}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-pos-ink">
                          {p.name || p.actorEmail || 'Unattributed'}
                        </span>
                        {p.role ? <RoleBadge role={p.role} /> : null}
                        {/* A gateway refund settles on a webhook, with no human
                            behind it. Saying so beats showing a blank name. */}
                        {!p.actorEmail ? (
                          <span className="badge bg-slate-200 text-slate-600">system</span>
                        ) : null}
                        {p.stillActive === false ? (
                          <span className="badge bg-slate-200 text-slate-600">no longer active</span>
                        ) : null}
                      </div>
                      <div className="flex items-baseline gap-2 text-xs text-slate-500">
                        <span>{p.discounts} discount{p.discounts === 1 ? '' : 's'}</span>
                        {/* Shown only when it happened. A "0 removed" on every
                            row would bury the rows where it did. */}
                        {p.cleared ? <span>· {p.cleared} removed</span> : null}
                        <span>· {p.voids} void{p.voids === 1 ? '' : 's'}</span>
                        <span>· {p.refunds} refund{p.refunds === 1 ? '' : 's'}</span>
                        <span className="text-lg font-extrabold text-pos-ink">{p.total}</span>
                      </div>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-pos-royal"
                        style={{ width: `${busiest ? Math.round((p.total / busiest) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card mt-4 p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">
                Every event ({shown.length})
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(KIND_FILTERS).map(([k, label]) => (
                  <button
                    key={k || 'all'}
                    type="button"
                    className={`px-2 py-1 text-xs ${kind === k ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setKind(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">Nothing in this range.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                      <th className="pb-2">When (IST)</th>
                      <th className="pb-2">Who</th>
                      <th className="pb-2">What</th>
                      <th className="pb-2">Bill</th>
                      <th className="pb-2">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((ev) => (
                      <tr key={ev.id} className="border-t border-slate-100 align-top">
                        <td className="whitespace-nowrap py-2 text-slate-600">{fmtDateTime(ev.at)}</td>
                        <td className="py-2 font-semibold text-pos-ink">
                          {ev.actorName || ev.actorEmail || 'system'}
                        </td>
                        <td className="py-2">
                          <span className={`badge ${KIND_STYLES[ev.kind] || 'bg-slate-100 text-slate-600'}`}>
                            {labelFor(ev.action)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap py-2 text-slate-500">{ev.invoiceNumber || '—'}</td>
                        <td className="py-2 text-slate-600">
                          {detailText(ev)}
                          {/* A refund a person asserted is not the same fact as
                              one the provider confirmed. §10 of the owner guide
                              turns on that difference, so it is not collapsed. */}
                          {ev.kind === 'refund' && ev.detail?.channel === 'GATEWAY' ? (
                            <span
                              className={`badge ml-2 ${
                                ev.detail.providerConfirmed
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-amber-100 text-amber-700'
                              }`}
                            >
                              {ev.detail.providerConfirmed ? 'provider confirmed' : 'not confirmed'}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.truncated ? (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Showing the most recent {data.cap} events only — there are more in this range.
                Narrow the dates or pick one branch to see the rest.
              </p>
            ) : null}

            {/* Stated on the screen, not just in the handover pack. Audit writes
                are deliberately best-effort so a logging fault can never fail a
                customer's bill, which makes every count above a floor. An owner
                reading this as a complete ledger would be reading it wrong. */}
            <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">
              These are the actions recorded against each person. Recording is deliberately
              best-effort — a logging fault never blocks a customer's bill — so treat these
              counts as a minimum, not a guaranteed total.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
