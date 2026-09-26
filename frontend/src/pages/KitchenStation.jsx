// VC-103 preparation-station screen. One station's live queue: QUEUED and
// IN_PREP tickets, oldest first, with cancellations and server-recorded delay
// reasons shown where the cook's eyes are. Poll-driven off the branch-level seq
// cursor; every figure and state comes from the server (there is no delay
// endpoint — delayReason is display-only here).
//
// Scoping: the board belongs to ONE store. A BRANCH_MANAGER or CASHIER is
// pinned to theirs by the session; a CUSTOMER_OWNER is not pinned and must
// choose one, or every call answers 400 (see useKitchenBranch).

import { useEffect, useMemo, useState } from 'react';
import { AlarmClock, ChefHat, Flame, Info, Utensils } from 'lucide-react';
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
  NEXT_STATE,
  STATE_STYLES,
  ageSeconds,
  fmtAge,
  listStations,
  orderLabel,
  payloadOmitsNotes,
  setItemState,
  useKitchenBranch,
} from '../lib/kitchen.js';

// The line's kitchen instruction and its modifiers, where the payload carries
// them. Both branches are live code against a field the board does not yet
// serialise (see payloadOmitsNotes) — the screens tell the operator that
// plainly, and these light up with no page change the day the select includes
// the columns. `variantName` is deliberately NOT rendered: it is already inside
// the snapshotted line name.
export function TicketMeta({ item }) {
  const note = item.note ?? item.notes ?? null;
  return (
    <>
      {item.modifiers?.length ? (
        <ul className="mt-1 text-xs text-blue-700">
          {item.modifiers.map((m, i) => (
            <li key={i}>+ {typeof m === 'string' ? m : m.name}</li>
          ))}
        </ul>
      ) : null}
      {note ? (
        <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
          “{note}”
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

// Stated where the cook will see it, because the absence is not visible from a
// ticket that simply has no note on it.
export function MissingNotesNote({ items }) {
  if (!payloadOmitsNotes(items)) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <b>Per-line instructions are not on this board.</b> Item notes (“no onion”) and modifiers are
        recorded on the order and printed on the KOT, but the kitchen feed does not send them yet —
        read the printed KOT before preparing a ticket that may carry one.
      </span>
    </div>
  );
}

function TicketCard({ item, station, now, busy, onAdvance }) {
  const age = ageSeconds(item, now);
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
  const { user } = useAuth();
  const toast = useToast();
  const branch = useKitchenBranch(user);
  const [stations, setStations] = useState(null);
  const [stationId, setStationId] = useState('');
  const [stationError, setStationError] = useState('');

  // Stations are per store, so choosing a different store reloads them and the
  // previous store's selection must not survive.
  useEffect(() => {
    if (!branch.ready) {
      setStations(null);
      setStationId('');
      return undefined;
    }
    let live = true;
    (async () => {
      try {
        const list = await listStations(branch.branchId);
        if (!live) return;
        setStations(list);
        const preferred = list.find((s) => s.isDefault) ?? list[0];
        setStationId(preferred ? preferred.id : '');
        setStationError('');
      } catch (err) {
        if (live) setStationError(apiError(err, 'Could not load kitchen stations'));
      }
    })();
    return () => { live = false; };
  }, [branch.ready, branch.branchId]);

  const feed = useKitchenFeed({
    stationId,
    branchId: branch.branchId,
    ready: branch.ready && !!stationId,
  });
  const action = useItemAction();

  const station = useMemo(
    () => (stations || []).find((s) => s.id === stationId) ?? null,
    [stations, stationId],
  );

  const board = useMemo(() => {
    const all = [...feed.items].sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
    return {
      queued: all.filter((i) => i.state === 'QUEUED'),
      inPrep: all.filter((i) => i.state === 'IN_PREP'),
      cancelled: all.filter((i) => i.state === 'CANCELLED'),
    };
  }, [feed.items]);

  const advance = (item) =>
    action.run(item.id, async () => {
      try {
        feed.apply(await setItemState(item.id, NEXT_STATE[item.state], item.version));
      } catch (err) {
        // 409 = someone else moved it first. The poll that follows shows the
        // truth; this screen never guesses which of the two decisions won.
        toast(apiError(err, 'Could not move the ticket'), 'error');
        feed.poll();
      }
    });

  const columns = [
    { key: 'queued', title: 'Queued', items: board.queued },
    { key: 'inPrep', title: 'In prep', items: board.inPrep },
    { key: 'cancelled', title: 'Cancelled · last 15 min', items: board.cancelled },
  ];

  return (
    <div>
      <PageHeader
        title="Kitchen station"
        subtitle={
          station?.targetPrepSeconds
            ? `Target ${Math.round(station.targetPrepSeconds / 60)} min per ticket`
            : 'Live preparation queue'
        }
        actions={
          <div className="flex items-center gap-2">
            <KitchenStoreSelect branch={branch} />
            {stations && stations.length > 1 ? (
              <select
                className="input"
                value={stationId}
                onChange={(e) => setStationId(e.target.value)}
                aria-label="Station"
              >
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : null}
          </div>
        }
      />

      <KitchenStoreGate branch={branch} />
      <ErrorNote message={stationError} />
      <ErrorNote message={feed.error} />

      {branch.ready ? (
        stations === null ? (
          <div className="card p-6 text-center text-sm text-slate-500">Loading the board…</div>
        ) : stations.length === 0 ? (
          <EmptyState
            icon={ChefHat}
            title="No kitchen stations"
            note="Ask the owner or a branch manager to set up stations for this store before using this screen."
          />
        ) : (
          <>
            <MissingNotesNote items={feed.items} />
            <div className="grid gap-4 lg:grid-cols-3">
              {columns.map((col) => (
                <div key={col.key}>
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
                    {col.title} · {col.items.length}
                  </div>
                  <div className="space-y-3">
                    {col.items.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">
                        {feed.loaded ? 'Nothing here' : 'Loading…'}
                      </div>
                    ) : (
                      col.items.map((item) => (
                        <TicketCard
                          key={item.id}
                          item={item}
                          station={station}
                          now={feed.now}
                          busy={action.isBusy(item.id)}
                          onAdvance={advance}
                        />
                      ))
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
