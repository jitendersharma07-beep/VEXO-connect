// VC-103 supervisor screen. The whole kitchen at a glance: per-station load
// against its target, every delayed ticket WITH its reason, till-side
// cancellations, and whole-order readiness. Read-only by design — a supervisor
// redirects people, not tickets; state moves on the station and expediter
// screens.
//
// Two sources, deliberately. GET /kitchen/overview is the authority for the
// counts: it is computed from rows on every request, so it is the same number
// after a reload and it can answer ordersKitchenReady, which is a question about
// every line of an order and cannot be derived from one station's board. The
// board feed supplies what overview does not carry — which tickets are delayed
// and why, and which were cancelled at the till.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlarmClock, Ban, ChefHat, Gauge, PackageCheck, Timer } from 'lucide-react';
import { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { ErrorNote, PageHeader, StatCard } from '../components/ui.jsx';
import { KitchenStoreGate, KitchenStoreSelect, useKitchenFeed } from '../components/kitchen.jsx';
import {
  STATE_STYLES,
  ageSeconds,
  fetchOverview,
  fmtAge,
  listStations,
  orderLabel,
  useKitchenBranch,
} from '../lib/kitchen.js';

const OVERVIEW_MS = 5000;

export default function KitchenSupervisor() {
  const { user } = useAuth();
  const branch = useKitchenBranch(user);
  const feed = useKitchenFeed({ branchId: branch.branchId, ready: branch.ready, pollMs: OVERVIEW_MS });

  const [stations, setStations] = useState([]);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  // Station rows carry targetPrepSeconds, which overview does not return and
  // which is what turns a queue depth into "past target".
  useEffect(() => {
    if (!branch.ready) {
      setStations([]);
      return undefined;
    }
    let live = true;
    (async () => {
      try {
        const list = await listStations(branch.branchId);
        if (live) setStations(list);
      } catch (err) {
        if (live) setError(apiError(err, 'Could not load kitchen stations'));
      }
    })();
    return () => { live = false; };
  }, [branch.ready, branch.branchId]);

  const loadOverview = useCallback(async () => {
    if (!branch.ready) return;
    try {
      setOverview(await fetchOverview(branch.branchId));
      setError('');
    } catch (err) {
      setError(apiError(err, 'Could not load the kitchen overview'));
    }
  }, [branch.ready, branch.branchId]);

  useEffect(() => {
    setOverview(null);
    if (!branch.ready) return undefined;
    loadOverview();
    const t = setInterval(loadOverview, OVERVIEW_MS);
    return () => clearInterval(t);
  }, [loadOverview, branch.ready]);

  // Per station: the server's own queue depth, plus the delay/target reading the
  // board rows make possible. targetPrepSeconds may legitimately be null, and a
  // null target means "no target", not "target zero" — which would mark every
  // ticket overdue the moment it was queued.
  const perStation = useMemo(() => {
    const byId = new Map((overview?.stations || []).map((s) => [s.stationId, s]));
    const open = feed.items.filter((i) => ['QUEUED', 'IN_PREP', 'READY'].includes(i.state));
    return stations.map((s) => {
      const o = byId.get(s.id);
      const mine = open.filter((i) => i.stationId === s.id);
      const target = s.targetPrepSeconds ?? null;
      const overdue = target === null
        ? []
        : mine.filter((i) => i.state !== 'READY' && ageSeconds(i, feed.now) > target);
      return {
        station: s,
        // Authoritative when overview has answered; the board is the fallback so
        // one failed overview poll does not blank every card.
        queued: o ? o.queued : mine.filter((i) => i.state === 'QUEUED').length,
        inPrep: o ? o.inPrep : mine.filter((i) => i.state === 'IN_PREP').length,
        oldest: o?.oldestQueuedAgeSec ?? (mine.length ? Math.max(...mine.map((i) => ageSeconds(i, feed.now))) : 0),
        overdue,
      };
    });
  }, [stations, overview, feed.items, feed.now]);

  const view = useMemo(() => {
    const open = feed.items.filter((i) => ['QUEUED', 'IN_PREP', 'READY'].includes(i.state));
    return {
      open,
      delayed: open
        .filter((i) => i.delayReason)
        .sort((a, b) => ageSeconds(b, feed.now) - ageSeconds(a, feed.now)),
      cancelled: feed.items
        .filter((i) => i.state === 'CANCELLED')
        .sort((a, b) => new Date(b.cancelledAt ?? 0) - new Date(a.cancelledAt ?? 0)),
      ready: open.filter((i) => i.state === 'READY'),
    };
  }, [feed.items, feed.now]);

  return (
    <div>
      <PageHeader
        title="Kitchen supervisor"
        subtitle="Every station, every delay, every cancellation — read-only; tickets move on the station and expediter screens."
        actions={<KitchenStoreSelect branch={branch} />}
      />

      <KitchenStoreGate
        branch={branch}
        note="Kitchen load is per store — choose which store this overview reports on."
      />
      <ErrorNote message={error} />
      <ErrorNote message={feed.error} />

      {branch.ready ? (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-4">
            <StatCard
              icon={Gauge}
              label="In the kitchen"
              value={overview ? overview.stations.reduce((n, s) => n + s.queued + s.inPrep, 0) : view.open.length}
            />
            {/* Whole-order readiness: every live line of an open order is READY.
                Only the server can answer it, so it is blank until it has. */}
            <StatCard
              icon={PackageCheck}
              label="Orders ready to serve"
              value={overview ? overview.ordersKitchenReady : '—'}
              accent="green"
            />
            <StatCard icon={AlarmClock} label="Delayed" value={view.delayed.length} accent="orange" />
            <StatCard
              icon={Ban}
              label="Cancelled · last 15 min"
              value={view.cancelled.length}
              accent="red"
            />
          </div>

          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Stations</div>
          <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {perStation.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                No kitchen stations in this store
              </div>
            ) : perStation.map(({ station, queued, inPrep, oldest, overdue }) => (
              <div key={station.id} className={`card p-4 ${overdue.length ? 'border-orange-300' : ''}`}>
                <div className="flex items-baseline justify-between">
                  <div className="flex items-center gap-2 text-sm font-bold text-pos-ink">
                    <ChefHat className="h-4 w-4 text-slate-400" /> {station.name}
                  </div>
                  <span className="text-xs text-slate-500">{queued + inPrep} open</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {queued} queued · {inPrep} cooking
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {oldest ? `oldest waiting ${fmtAge(oldest)}` : 'clear'}
                  {station.targetPrepSeconds
                    ? ` · target ${Math.round(station.targetPrepSeconds / 60)}m`
                    : ' · no target set'}
                </div>
                {overdue.length ? (
                  <div className="mt-2 rounded-lg bg-orange-50 px-2 py-1.5 text-xs font-semibold text-orange-800">
                    {overdue.length} ticket{overdue.length > 1 ? 's' : ''} past target
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                Delayed tickets
              </div>
              {view.delayed.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                  {feed.loaded ? 'No delays reported' : 'Loading…'}
                </div>
              ) : (
                <ul className="space-y-2">
                  {view.delayed.map((it) => (
                    <li key={it.id} className="card flex items-center justify-between gap-3 p-3 text-sm">
                      <div className="min-w-0">
                        <div className="font-semibold text-pos-ink">{it.qty} × {it.productName}</div>
                        <div className="text-xs text-orange-700">{it.delayReason}</div>
                      </div>
                      <div className="shrink-0 text-right text-xs text-slate-500">
                        <span className={`badge ${STATE_STYLES[it.state]}`}>{it.state}</span>
                        <div className="mt-0.5">{fmtAge(ageSeconds(it, feed.now))}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                Cancellations
              </div>
              {/* Cancellations are read off the live feed, which starts from the
                  current snapshot and then follows changes — so this is "since
                  this screen opened, within the last 15 minutes", not the day's
                  total. The day's total belongs in a report, not on a wallboard. */}
              {view.cancelled.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                  {feed.loaded ? 'No recent cancellations' : 'Loading…'}
                </div>
              ) : (
                <ul className="space-y-2">
                  {view.cancelled.map((it) => (
                    <li key={it.id} className="card flex items-center justify-between gap-3 p-3 text-sm">
                      <div className="min-w-0 font-semibold text-red-700 line-through">
                        {it.qty} × {it.productName}
                      </div>
                      <span className="shrink-0 text-xs text-slate-500">{orderLabel(it)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {overview?.lastChangeAt ? (
            <div className="mt-6 flex items-center gap-1.5 text-xs text-slate-400">
              <Timer className="h-3.5 w-3.5" />
              Last kitchen change {new Date(overview.lastChangeAt).toLocaleTimeString('en-IN')} · updates
              every {OVERVIEW_MS / 1000}s
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
