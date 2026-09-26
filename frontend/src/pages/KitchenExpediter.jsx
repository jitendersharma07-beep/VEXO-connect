// VC-103 expediter screen. Tickets grouped by ORDER: the pass sees each
// order's readiness as x-of-y, serves READY lines, and is told plainly about
// delays and till-side cancellations. Partial readiness is the point of this
// screen — an order goes out line by line, not all at once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ClipboardList, RefreshCw } from 'lucide-react';
import { apiError } from '../lib/api.js';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import { STATE_STYLES, ageSeconds, fetchItems, fmtAge, mergeItems, orderLabel, setItemState } from '../lib/kitchen.js';
import { TicketMeta } from './KitchenStation.jsx';

const POLL_MS = 4000;

export default function KitchenExpediter() {
  const toast = useToast();
  const [itemMap, setItemMap] = useState(new Map());
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const cursorRef = useRef(0);
  const [, force] = useState(0);

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

  // Group by order; an order leaves the board when every line is terminal
  // (SERVED or CANCELLED).
  const orders = useMemo(() => {
    const byOrder = new Map();
    for (const it of itemMap.values()) {
      if (!byOrder.has(it.orderId)) byOrder.set(it.orderId, []);
      byOrder.get(it.orderId).push(it);
    }
    const rows = [];
    for (const [orderId, items] of byOrder) {
      const open = items.filter((i) => i.state !== 'SERVED' && i.state !== 'CANCELLED');
      if (open.length === 0) continue;
      const live = items.filter((i) => i.state !== 'CANCELLED');
      items.sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
      rows.push({
        orderId,
        items,
        readyCount: live.filter((i) => i.state === 'READY' || i.state === 'SERVED').length,
        liveCount: live.length,
        oldest: Math.max(...open.map((i) => ageSeconds(i))),
        sample: items[0],
      });
    }
    return rows.sort((a, b) => b.oldest - a.oldest);
  }, [itemMap]);

  const serve = async (item) => {
    setBusy(true);
    try {
      const next = await setItemState(item.id, 'SERVED', item.version);
      setItemMap((m) => mergeItems(m, [next]));
    } catch (err) {
      toast(apiError(err, 'Could not mark the line served'), 'error');
      poll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Expediter"
        subtitle="Orders at the pass — serve lines as they come up; delays and cancellations show inline."
        actions={
          <button type="button" className="btn-ghost" onClick={poll} title="Refresh" aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
        }
      />
      <ErrorNote message={loadError} />
      {orders.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing at the pass" note="Orders appear here the moment the kitchen has lines for them." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((o) => (
            <div key={o.orderId} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-bold text-pos-ink">
                  {orderLabel(o.sample)}
                  {o.sample.invoiceNumber ? <span className="ml-2 text-xs font-normal text-slate-400">{o.sample.invoiceNumber}</span> : null}
                </div>
                <span className="text-xs text-slate-500">waiting {fmtAge(o.oldest)}</span>
              </div>
              {/* partial readiness, stated not implied */}
              <div className="mt-1 text-xs font-semibold text-slate-600">
                {o.readyCount} of {o.liveCount} lines ready
                {o.readyCount > 0 && o.readyCount < o.liveCount ? (
                  <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">PARTIAL</span>
                ) : null}
              </div>
              <ul className="mt-3 space-y-2">
                {o.items.map((it) => (
                  <li key={it.id} className={`rounded-lg border p-2 ${it.state === 'CANCELLED' ? 'border-red-200 bg-red-50' : 'border-slate-100'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 text-sm">
                        <span className={`font-semibold ${it.state === 'CANCELLED' ? 'text-red-700 line-through' : 'text-pos-ink'}`}>
                          {it.qty} × {it.productName}
                          {it.variantName ? ` · ${it.variantName}` : ''}
                        </span>
                      </div>
                      <span className={`badge shrink-0 ${STATE_STYLES[it.state]}`}>{it.state}</span>
                    </div>
                    <TicketMeta item={it} />
                    {it.state === 'READY' ? (
                      <button type="button" className="btn-primary mt-2 w-full py-1.5 text-xs" disabled={busy} onClick={() => serve(it)}>
                        <CheckCircle2 className="h-3.5 w-3.5" /> Served
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
