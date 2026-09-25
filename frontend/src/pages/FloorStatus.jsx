import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Armchair, Bell, LayoutGrid, List, MapPin } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { EmptyState, ErrorNote, PageHeader } from '../components/ui.jsx';
import { fmtINR } from '../lib/pos.js';
import {
  ATTENTION_ORDER,
  TABLE_STATE_ORDER,
  fmtSeated,
  minutesSince,
  tableStateMeta,
} from '../lib/tableState.js';

// /floor-status — the operational read of the floor, as opposed to
// /floor-designer which edits its geometry. Nothing here writes: every state
// comes from `layout.tables[].service`, derived server-side in
// lib/qr/tableState.js from rows the till, the kitchen and the payment path
// already wrote. There is deliberately no control on this screen that sets a
// state, because a settable state is a second copy of the truth.
//
// The map is the glance and the list is the record. Both are rendered, always,
// because a table drawn 40 px wide cannot show "Order waiting" legibly and a
// colour alone is not a label — the requirement is that occupancy, preparation
// and payment are each readable as words.

const POLL_MS = 10000;

const StateChip = ({ state, className = '' }) => {
  const meta = tableStateMeta(state);
  return (
    <span className={`badge ${meta.chip} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
};

function Legend() {
  return (
    <div className="card p-4">
      <div className="label mb-2">What the colours mean</div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {TABLE_STATE_ORDER.map((s) => {
          const meta = tableStateMeta(s);
          return (
            <li key={s} className="flex items-start gap-2">
              <span className={`mt-0.5 h-4 w-4 shrink-0 rounded border-2 ${meta.tile}`} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-pos-ink">{meta.label}</span>
                <span className="block text-xs text-slate-500">{meta.note}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FloorMap({ layout }) {
  const boxRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const canvasW = layout?.canvasWidth || 1200;
  const canvasH = layout?.canvasHeight || 800;

  // Fit the plan to whatever width the column actually has. Measured rather
  // than assumed: this page is full-width on a manager's desktop and half of
  // that on a tablet propped by the pass.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const fit = () => setZoom(Math.min(1, (el.clientWidth || canvasW) / canvasW));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasW]);

  return (
    <div ref={boxRef} className="overflow-hidden">
      <div
        className="relative rounded-lg border border-slate-200 bg-slate-50"
        style={{ width: canvasW * zoom, height: canvasH * zoom }}
      >
        {(layout.objects || []).map((o) => (
          <div
            key={o.id}
            className="absolute flex items-center justify-center rounded bg-slate-200/70 text-[10px] font-medium text-slate-600"
            style={{
              left: o.x * zoom, top: o.y * zoom,
              width: o.width * zoom, height: o.height * zoom,
              transform: `rotate(${o.rotation}deg)`,
            }}
          >
            {o.label || o.kind}
          </div>
        ))}
        {(layout.tables || []).map((t) => {
          const svc = t.service || { state: 'FREE' };
          const meta = tableStateMeta(svc.state);
          return (
            <div
              key={t.tableId}
              className={`absolute flex flex-col items-center justify-center overflow-hidden border-2 px-1 text-center shadow-sm ${meta.tile}`}
              style={{
                left: t.x * zoom, top: t.y * zoom,
                width: t.width * zoom, height: t.height * zoom,
                borderRadius: t.shape === 'ROUND' ? '9999px' : '8px',
                transform: `rotate(${t.rotation}deg)`,
              }}
            >
              <span className="text-xs font-bold leading-tight">{t.name}</span>
              <span className="text-[10px] font-semibold leading-tight">{meta.label}</span>
              {svc.awaitingStaff > 0 ? (
                <span className="text-[10px] font-bold leading-tight">
                  {svc.awaitingStaff} to accept
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SORTS = {
  name: (t) => t.name || '',
  state: (t) => TABLE_STATE_ORDER.indexOf(t.service?.state ?? 'FREE'),
  guests: (t) => t.service?.guests ?? null,
  seated: (t) => minutesSince(t.service?.seatedAt),
  due: (t) => (t.service?.amountDue ?? null),
  waiting: (t) => (t.service?.awaitingStaff ? t.service.awaitingStaff : null),
};

function SortHeader({ id, label, sort, setSort, numeric = false }) {
  const active = sort.key === id;
  return (
    <th scope="col" className={`px-3 py-2 ${numeric ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => setSort({ key: id, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })}
        className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide ${active ? 'text-pos-royal' : 'text-slate-500 hover:text-slate-700'}`}
      >
        {label}
        <span aria-hidden="true">{active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );
}

function TableList({ tables }) {
  const [sort, setSort] = useState({ key: 'state', dir: 'desc' });

  const rows = useMemo(() => {
    const pick = SORTS[sort.key] || SORTS.name;
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...tables].sort((a, b) => {
      const av = pick(a);
      const bv = pick(b);
      // Empties last in BOTH directions — a table with no bill is not the
      // cheapest bill, and sorting it to the top of "amount due" buries the
      // tables that owe money.
      const aEmpty = av === null || av === undefined || av === '';
      const bEmpty = bv === null || bv === undefined || bv === '';
      if (aEmpty && bEmpty) return (a.name || '').localeCompare(b.name || '');
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof av === 'string') return sign * av.localeCompare(bv);
      return sign * (av - bv);
    });
  }, [tables, sort]);

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <SortHeader id="name" label="Table" sort={sort} setSort={setSort} />
              <SortHeader id="state" label="State" sort={sort} setSort={setSort} />
              <SortHeader id="guests" label="Guests" sort={sort} setSort={setSort} numeric />
              <SortHeader id="seated" label="Seated for" sort={sort} setSort={setSort} numeric />
              <SortHeader id="waiting" label="To accept" sort={sort} setSort={setSort} numeric />
              <SortHeader id="due" label="Amount due" sort={sort} setSort={setSort} numeric />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((t) => {
              const svc = t.service || {};
              return (
                <tr key={t.tableId} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className="block font-semibold text-pos-ink">{t.name}</span>
                    {t.capacity ? (
                      <span className="block text-xs text-slate-500">{t.capacity} seats</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className="block truncate">
                      <StateChip state={svc.state} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{svc.guests || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtSeated(svc.seatedAt) || '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {svc.awaitingStaff ? (
                      <span className="badge bg-amber-100 text-amber-800">{svc.awaitingStaff}</span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {svc.amountDue === null || svc.amountDue === undefined
                      ? '—'
                      : fmtINR(svc.amountDue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FloorStatus() {
  const [floors, setFloors] = useState([]);
  const [floorId, setFloorId] = useState('');
  const [layout, setLayout] = useState(null);
  const [floor, setFloor] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('map');
  const [seenAt, setSeenAt] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/floors');
        const list = data.floors || [];
        setFloors(list);
        if (list.length) setFloorId((cur) => cur || list[0].id);
      } catch (err) {
        setError(apiError(err, 'Could not load floors'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadLayout = useCallback(async () => {
    if (!floorId) return;
    try {
      const { data } = await api.get(`/floors/${floorId}/layout`);
      setLayout(data.layout);
      setFloor(data.floor);
      setSeenAt(new Date());
      setError('');
    } catch (err) {
      setError(apiError(err, 'Could not load the floor'));
    }
  }, [floorId]);

  useEffect(() => { loadLayout(); }, [loadLayout]);

  // Live without a button. A floor plan that needs refreshing by hand is a
  // floor plan that is wrong by the time anyone looks at it; polling stops
  // while the tab is hidden so a screen left open overnight is not a load.
  useEffect(() => {
    let timer = null;
    const tick = () => { if (!document.hidden) loadLayout(); };
    timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadLayout]);

  const tables = useMemo(() => layout?.tables || [], [layout]);

  const counts = useMemo(() => {
    const out = Object.fromEntries(TABLE_STATE_ORDER.map((s) => [s, 0]));
    for (const t of tables) {
      const s = t.service?.state;
      if (s in out) out[s] += 1;
    }
    return out;
  }, [tables]);

  const attention = useMemo(
    () => tables
      .filter((t) => ATTENTION_ORDER.includes(t.service?.state) && (
        t.service.awaitingStaff > 0 || t.service.state === 'BILLED' || t.service.state === 'PAID'
      ))
      .sort((a, b) => ATTENTION_ORDER.indexOf(a.service.state) - ATTENTION_ORDER.indexOf(b.service.state)),
    [tables],
  );

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading the floor…</div>;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Floor Status"
        subtitle={
          seenAt
            ? `Live — derived from open orders, kitchen tickets and payments. Read at ${seenAt.toLocaleTimeString('en-IN')}.`
            : 'Live — derived from open orders, kitchen tickets and payments.'
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView('map')}
              className={view === 'map' ? 'btn-primary' : 'btn-ghost'}
            >
              <LayoutGrid className="h-4 w-4" /> Map
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              className={view === 'list' ? 'btn-primary' : 'btn-ghost'}
            >
              <List className="h-4 w-4" /> List
            </button>
          </div>
        }
      />

      {error ? <ErrorNote message={error} /> : null}

      {floors.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {floors.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFloorId(f.id)}
              className={f.id === floorId ? 'btn-primary' : 'btn-ghost'}
            >
              <MapPin className="h-4 w-4" /> {f.name}
            </button>
          ))}
        </div>
      ) : null}

      {attention.length ? (
        <div className="card border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Bell className="h-4 w-4" />
            {attention.length} {attention.length === 1 ? 'table needs' : 'tables need'} someone
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {attention.map((t) => (
              <li key={t.tableId} className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5">
                <span className="text-sm font-semibold text-pos-ink">{t.name}</span>
                <StateChip state={t.service.state} />
                {t.service.awaitingStaff > 0 ? (
                  <span className="text-xs font-semibold text-amber-800">
                    {t.service.awaitingStaff} to accept
                  </span>
                ) : null}
                {t.service.amountDue > 0 ? (
                  <span className="text-xs font-semibold text-orange-800">
                    {fmtINR(t.service.amountDue)} owing
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {TABLE_STATE_ORDER.map((s) => {
          const meta = tableStateMeta(s);
          return (
            <div key={s} className="card flex h-full flex-col p-3">
              <div className="flex-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {meta.label}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} aria-hidden="true" />
                <span className="text-lg font-extrabold tabular-nums text-pos-ink">{counts[s]}</span>
              </div>
            </div>
          );
        })}
      </div>

      {!tables.length ? (
        <EmptyState
          icon={Armchair}
          title="No published layout for this floor"
          note="Publish a layout in Floor Designer and the tables will appear here."
        />
      ) : view === 'map' ? (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="mb-3 text-sm font-semibold text-pos-ink">
              {floor?.name}
              {layout?.version ? (
                <span className="ml-2 text-xs font-normal text-slate-500">
                  published v{layout.version}
                </span>
              ) : null}
            </div>
            <FloorMap layout={layout} />
          </div>
          <Legend />
        </div>
      ) : (
        <div className="space-y-4">
          <TableList tables={tables} />
          <Legend />
        </div>
      )}
    </div>
  );
}
