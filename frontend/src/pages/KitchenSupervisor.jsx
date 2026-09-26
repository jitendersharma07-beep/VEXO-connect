// VC-103 supervisor screen. The whole kitchen at a glance: per-station load
// against its target, every delayed ticket WITH its reason, till-side
// cancellations, and the day's throughput. Read-only by design — a
// supervisor redirects people, not tickets; state moves on the station and
// expediter screens.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, Ban, ChefHat, Gauge, RefreshCw, Timer } from 'lucide-react';
import { apiError } from '../lib/api.js';
import { ErrorNote, PageHeader, StatCard } from '../components/ui.jsx';
import { STATE_STYLES, ageSeconds, fetchItems, fmtAge, listStations, mergeItems, orderLabel } from '../lib/kitchen.js';

const POLL_MS = 5000;

export default function KitchenSupervisor() {
  const [stations, setStations] = useState([]);
  const [itemMap, setItemMap] = useState(new Map());
  const [loadError, setLoadError] = useState('');
  const cursorRef = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        setStations(await listStations());
      } catch (err) {
        setLoadError(apiError(err, 'Could not load kitchen stations'));
      }
    })();
  }, []);

  const poll = useCallback(async () => {
    try {
      const { items, cursor } = await fetchItems({ since: cursorRef.current });
      cursorRef.current = cursor;
      if (items.length) setItemMap((m) => mergeItems(m, items));
      setLoadError('');
    } catch (err) {
      setLoadError(apiError(err, 'Could not reach the kitchen feed'));
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    const tick = setInterval(() => force((n) => n + 1), 1000);
    return () => {
      clearInterval(t);
      clearInterval(tick);
    };
  }, [poll]);

  const view = useMemo(() => {
    const all = [...itemMap.values()];
    const open = all.filter((i) => ['QUEUED', 'IN_PREP', 'READY'].includes(i.state));
    const delayed = open.filter((i) => i.delayReason).sort((a, b) => ageSeconds(b) - ageSeconds(a));
    const cancelled = all.filter((i) => i.state === 'CANCELLED').sort((a, b) => new Date(b.cancelledAt ?? 0) - new Date(a.cancelledAt ?? 0));
    const served = all.filter((i) => i.state === 'SERVED');
    const perStation = stations.map((s) => {
      const mine = open.filter((i) => i.stationId === s.id);
      const overdue = s.targetPrepSeconds !== null && s.targetPrepSeconds !== undefined
        ? mine.filter((i) => i.state !== 'READY' && ageSeconds(i) > s.targetPrepSeconds)
        : [];
      return { station: s, open: mine, overdue, oldest: mine.length ? Math.max(...mine.map((i) => ageSeconds(i))) : 0 };
    });
    return { open, delayed, cancelled, served, perStation };
  }, [itemMap, stations]);

  return (
    <div>
      <PageHeader
        title="Kitchen supervisor"
        subtitle="Every station, every delay, every cancellation — read-only; tickets move on the station and expediter screens."
        actions={
          <button type="button" className="btn-ghost" onClick={poll} title="Refresh" aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
        }
      />
      <ErrorNote message={loadError} />
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <StatCard icon={Gauge} label="Open tickets" value={view.open.length} />
        <StatCard icon={AlarmClock} label="Delayed" value={view.delayed.length} accent="orange" />
        <StatCard icon={Ban} label="Cancelled" value={view.cancelled.length} accent="red" />
        <StatCard icon={Timer} label="Served (session)" value={view.served.length} accent="green" />
      </div>

      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Stations</div>
      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view.perStation.map(({ station, open, overdue, oldest }) => (
          <div key={station.id} className={`card p-4 ${overdue.length ? 'border-orange-300' : ''}`}>
            <div className="flex items-baseline justify-between">
              <div className="flex items-center gap-2 text-sm font-bold text-pos-ink">
                <ChefHat className="h-4 w-4 text-slate-400" /> {station.name}
              </div>
              <span className="text-xs text-slate-500">{open.length} open</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {open.length ? `oldest waiting ${fmtAge(oldest)}` : 'clear'}
              {station.targetPrepSeconds ? ` · target ${Math.round(station.targetPrepSeconds / 60)}m` : ''}
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
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Delayed tickets</div>
          {view.delayed.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">No delays reported</div>
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
                    <div className="mt-0.5">{fmtAge(ageSeconds(it))}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Cancellations</div>
          {view.cancelled.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">No cancellations</div>
          ) : (
            <ul className="space-y-2">
              {view.cancelled.slice(0, 20).map((it) => (
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
    </div>
  );
}
