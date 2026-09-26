// VC-103 preparation-station screen. One station's live queue: QUEUED and
// IN_PREP tickets, oldest first, with cancellations and server-recorded delay
// reasons shown where the cook's eyes are. Poll-driven off the branch-level
// seq cursor; every figure and state comes from the server (there is no delay
// endpoint — delayReason is display-only here).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, ChefHat, Flame, RefreshCw, Utensils } from 'lucide-react';
import { apiError } from '../lib/api.js';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import {
  NEXT_STATE,
  STATE_STYLES,
  ageSeconds,
  fetchItems,
  fmtAge,
  listStations,
  mergeItems,
  orderLabel,
  setItemState,
} from '../lib/kitchen.js';

const POLL_MS = 4000;

export function TicketMeta({ item }) {
  return (
    <>
      {item.modifiers?.length ? (
        <ul className="mt-1 text-xs text-blue-700">
          {item.modifiers.map((m, i) => (
            <li key={i}>+ {typeof m === 'string' ? m : m.name}</li>
          ))}
        </ul>
      ) : null}
      {item.notes ? (
        <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
          “{item.notes}”
        </div>
      ) : null}
      {item.delayReason ? (
        <div className="mt-1 flex items-center gap-1 text-xs font-semibold text-orange-700">
          <AlarmClock className="h-3.5 w-3.5" /> Delayed: {item.delayReason}
        </div>
      ) : null}
    </>
  );
}

function TicketCard({ item, station, busy, onAdvance }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const age = ageSeconds(item);
  // Routing sets a per-item target; the station's own target is the fallback.
  const target = item.targetSeconds ?? station?.targetPrepSeconds ?? null;
  const overdue = target !== null && age > target && item.state !== 'READY';
  const cancelled = item.state === 'CANCELLED';
  return (
    <div
      className={`rounded-xl border p-3 ${
        cancelled
          ? 'border-red-300 bg-red-50'
          : overdue
            ? 'border-orange-300 bg-orange-50'
            : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 text-sm font-bold text-pos-ink">
          {item.qty} × {item.productName}
          {item.variantName ? <span className="text-slate-500"> · {item.variantName}</span> : null}
        </div>
        <span className={`badge shrink-0 ${STATE_STYLES[item.state]}`}>{item.state}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between text-xs text-slate-500">
        <span>{orderLabel(item)}</span>
        <span className={overdue ? 'font-bold text-orange-700' : ''}>{fmtAge(age)}</span>
      </div>
      <TicketMeta item={item} />
      {cancelled ? (
        <div className="mt-2 text-xs font-bold uppercase tracking-wide text-red-700">
          Cancelled at the till — do not prepare
        </div>
      ) : NEXT_STATE[item.state] && item.state !== 'READY' ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1 py-1.5 text-xs"
            disabled={busy}
            onClick={() => onAdvance(item)}
          >
            {item.state === 'QUEUED' ? (
              <>
                <Flame className="h-3.5 w-3.5" /> Start
              </>
            ) : (
              <>
                <Utensils className="h-3.5 w-3.5" /> Ready
              </>
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function KitchenStation() {
  const toast = useToast();
  const [stations, setStations] = useState(null);
  const [stationId, setStationId] = useState('');
  const [itemMap, setItemMap] = useState(new Map());
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const cursorRef = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const list = await listStations();
        setStations(list);
        const preferred = list.find((s) => s.isDefault) ?? list[0];
        if (preferred) setStationId(preferred.id);
      } catch (err) {
        setLoadError(apiError(err, 'Could not load kitchen stations'));
      }
    })();
  }, []);

  const poll = useCallback(async () => {
    if (!stationId) return;
    try {
      const { items, cursor } = await fetchItems({ since: cursorRef.current, stationId });
      cursorRef.current = cursor;
      if (items.length) setItemMap((m) => mergeItems(m, items));
      setLoadError('');
    } catch (err) {
      setLoadError(apiError(err, 'Could not reach the kitchen feed'));
    }
  }, [stationId]);

  useEffect(() => {
    // Station change restarts the cursor: "everything after 0" repaints the
    // board from scratch, which is exactly what a fresh screen wants.
    cursorRef.current = 0;
    setItemMap(new Map());
    if (!stationId) return undefined;
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [stationId, poll]);

  const station = useMemo(() => (stations || []).find((s) => s.id === stationId) ?? null, [stations, stationId]);
  const board = useMemo(() => {
    const all = [...itemMap.values()].sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
    return {
      queued: all.filter((i) => i.state === 'QUEUED'),
      inPrep: all.filter((i) => i.state === 'IN_PREP'),
      cancelled: all.filter((i) => i.state === 'CANCELLED' && !i.servedAt),
    };
  }, [itemMap]);

  const advance = async (item) => {
    setBusy(true);
    try {
      const next = await setItemState(item.id, NEXT_STATE[item.state], item.version);
      setItemMap((m) => mergeItems(m, [next]));
    } catch (err) {
      // 409 = someone else moved it first; the next poll shows the truth.
      toast(apiError(err, 'Could not move the ticket'), 'error');
      poll();
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'queued', title: 'Queued', items: board.queued },
    { key: 'inPrep', title: 'In prep', items: board.inPrep },
    { key: 'cancelled', title: 'Cancelled', items: board.cancelled },
  ];

  return (
    <div>
      <PageHeader
        title="Kitchen station"
        subtitle={station?.targetPrepSeconds ? `Target ${Math.round(station.targetPrepSeconds / 60)} min per ticket` : 'Live preparation queue'}
        actions={
          <div className="flex items-center gap-2">
            <select className="input" value={stationId} onChange={(e) => setStationId(e.target.value)} aria-label="Station">
              {(stations || []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button type="button" className="btn-ghost" onClick={poll} title="Refresh" aria-label="Refresh">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <ErrorNote message={loadError} />
      {stations && stations.length === 0 ? (
        <EmptyState icon={ChefHat} title="No kitchen stations" note="Ask the owner to set up stations before using this screen." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {columns.map((col) => (
            <div key={col.key}>
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                {col.title} · {col.items.length}
              </div>
              <div className="space-y-3">
                {col.items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                    Nothing here
                  </div>
                ) : (
                  col.items.map((item) => (
                    <TicketCard key={item.id} item={item} station={station} busy={busy} onAdvance={advance} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
