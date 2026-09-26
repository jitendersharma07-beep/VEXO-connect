// VC-103 expediter screen. Tickets grouped by ORDER: the pass sees each order's
// readiness as x-of-y, serves READY lines, and is told plainly about delays and
// till-side cancellations. Partial readiness is the point of this screen — an
// order goes out line by line, not all at once.
//
// This is the whole store, not one station: the feed aggregates every station's
// board off the single branch-level cursor. A CUSTOMER_OWNER therefore chooses a
// store first; a pinned manager or cashier gets theirs from the session.

import { useMemo } from 'react';
import { CheckCircle2, ClipboardList } from 'lucide-react';
import { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import {
  KitchenStoreGate,
  KitchenStoreSelect,
  useItemAction,
  useKitchenFeed,
} from '../components/kitchen.jsx';
import {
  STATE_STYLES,
  ageSeconds,
  fmtAge,
  orderLabel,
  setItemState,
  useKitchenBranch,
} from '../lib/kitchen.js';
import { MissingNotesNote, TicketMeta } from './KitchenStation.jsx';

export default function KitchenExpediter() {
  const { user } = useAuth();
  const toast = useToast();
  const branch = useKitchenBranch(user);
  const feed = useKitchenFeed({ branchId: branch.branchId, ready: branch.ready });
  const action = useItemAction();

  // Group by order; an order leaves the board when every line is terminal
  // (SERVED or CANCELLED).
  const orders = useMemo(() => {
    const byOrder = new Map();
    for (const it of feed.items) {
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
        oldest: Math.max(...open.map((i) => ageSeconds(i, feed.now))),
        sample: items[0],
      });
    }
    return rows.sort((a, b) => b.oldest - a.oldest);
  }, [feed.items, feed.now]);

  const serve = (item) =>
    action.run(item.id, async () => {
      try {
        feed.apply(await setItemState(item.id, 'SERVED', item.version));
      } catch (err) {
        toast(apiError(err, 'Could not mark the line served'), 'error');
        feed.poll();
      }
    });

  return (
    <div>
      <PageHeader
        title="Expediter"
        subtitle="Orders at the pass — serve lines as they come up; delays and cancellations show inline."
        actions={<KitchenStoreSelect branch={branch} />}
      />

      <KitchenStoreGate
        branch={branch}
        note="The pass works one store at a time — choose which store's orders this screen runs."
      />
      <ErrorNote message={feed.error} />

      {branch.ready ? (
        !feed.loaded ? (
          <div className="card p-6 text-center text-sm text-slate-500">Loading the pass…</div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Nothing at the pass"
            note="Orders appear here the moment the kitchen has lines for them."
          />
        ) : (
          <>
            <MissingNotesNote items={feed.items} />
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {orders.map((o) => (
                <div key={o.orderId} className="card p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-bold text-pos-ink">{orderLabel(o.sample)}</div>
                    <span className="text-xs text-slate-500">waiting {fmtAge(o.oldest)}</span>
                  </div>
                  {/* partial readiness, stated not implied */}
                  <div className="mt-1 text-xs font-semibold text-slate-600">
                    {o.readyCount} of {o.liveCount} lines ready
                    {o.readyCount > 0 && o.readyCount < o.liveCount ? (
                      <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">
                        PARTIAL
                      </span>
                    ) : null}
                  </div>
                  <ul className="mt-3 space-y-2">
                    {o.items.map((it) => (
                      <li
                        key={it.id}
                        className={`rounded-lg border p-2 ${
                          it.state === 'CANCELLED' ? 'border-red-200 bg-red-50' : 'border-slate-100'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 text-sm">
                            <span
                              className={`font-semibold ${
                                it.state === 'CANCELLED'
                                  ? 'text-red-700 line-through'
                                  : 'text-pos-ink'
                              }`}
                            >
                              {it.qty} × {it.productName}
                            </span>
                          </div>
                          <span className={`badge shrink-0 ${STATE_STYLES[it.state]}`}>{it.state}</span>
                        </div>
                        <TicketMeta item={it} />
                        {it.state === 'READY' ? (
                          <button
                            type="button"
                            className="btn-primary mt-2 w-full py-1.5 text-xs"
                            disabled={action.isBusy(it.id)}
                            onClick={() => serve(it)}
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Served
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
