import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Check, ChefHat, CircleAlert, Minus, Plus, RefreshCw, Search, Send, Trash2, X,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { ErrorNote, ReasonModal } from '../components/ui.jsx';
import { fmtINR } from '../lib/pos.js';
import { fmtSeated, tableStateMeta } from '../lib/tableState.js';

// /captain — the handheld a captain carries on the floor.
//
// It is the SAME order service the till uses: POST /orders, /orders/:id/items,
// /orders/:id/kot and the QR submission accept/reject routes. There is no
// second pricing path (the phone never sends a price; the server prices every
// line from the catalog) and no second login (the ordinary POS session, cookie
// and all). A captain's authority is order.create, order.item.void and kot.read
// — no payment.record, no order.bill, no promo.apply — so this screen offers no
// bill, no discount and no payment control. Those are not hidden buttons that
// the API happens to refuse: they are absent, because a captain handles no
// money and a screen that showed them would be lying about the role.
//
// It is ALSO not offline order support, and does not claim to be. Nothing is
// queued for later, because a queued order the kitchen has never seen is worse
// than an error: the captain walks away believing the food is coming.

// A failed request is not one thing. It is two, and they must not wear the same
// sentence.
//
// The server ANSWERED and refused — a 4xx carrying a body it wrote on purpose.
// It read the request, declined it, and changed nothing. That is a fact this
// screen may state, and the captain may act on it.
//
// The server did NOT answer — a timeout, a dropped connection, a proxy that
// gave up, or a 5xx that stopped mid-sentence. The request may well have
// arrived: the order may be open, the KOT may already be printing, and only the
// reply was lost on the way back. This screen cannot tell those apart from the
// outside. "Nothing has been queued, and the kitchen has not seen this" is a
// guess dressed as a fact, and when the guess is wrong the captain re-sends and
// the table gets the same dish twice.
//
// So an unanswered write is reported as unknown, the screen reads the order
// back from the server, and it never re-sends the write by itself. The reply
// that came back late is not worth a duplicate KOT.
const isAnswered = (err) => Boolean(err?.response) && err.response.status < 500;

const activeLines = (order) => (order?.items || []).filter((i) => i.status === 'ACTIVE');

function TableCard({ table, pending, onPick }) {
  const svc = table.service || { state: 'FREE' };
  const meta = tableStateMeta(svc.state);
  const seated = fmtSeated(svc.seatedAt);
  return (
    <button
      type="button"
      onClick={() => onPick(table)}
      className={`flex min-h-[96px] w-full flex-col items-start gap-1 rounded-xl border-2 p-3 text-left shadow-sm transition-shadow hover:shadow-md ${meta.tile}`}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="text-base font-bold leading-tight">{table.name}</span>
        {table.capacity ? (
          <span className="text-[11px] font-medium opacity-70">{table.capacity} seats</span>
        ) : null}
      </span>
      <span className="text-xs font-bold uppercase tracking-wide">{meta.label}</span>
      <span className="text-[11px] font-medium opacity-80">
        {svc.guests ? `${svc.guests} guests` : 'No guests recorded'}
        {seated ? ` · ${seated}` : ''}
      </span>
      {pending > 0 ? (
        <span className="badge bg-amber-500 text-white">{pending} waiting to accept</span>
      ) : null}
    </button>
  );
}

function MenuSheet({ open, onClose, onAdd, busy }) {
  const [cats, setCats] = useState([]);
  const [cat, setCat] = useState('ALL');
  const [q, setQ] = useState('');
  const [products, setProducts] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const { data } = await api.get('/catalog/categories');
        setCats(data.categories || []);
      } catch {
        // The menu still works without the category strip.
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      setError('');
      setProducts(null);
      try {
        const params = {};
        if (cat !== 'ALL') params.categoryId = cat;
        if (q.trim()) params.q = q.trim();
        const { data } = await api.get('/catalog/products', { params });
        if (alive) setProducts(data.products || []);
      } catch (err) {
        if (alive) setError(apiError(err, 'Could not load the menu'));
      }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [open, cat, q]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 p-3">
        <button type="button" className="btn-touch border-slate-300" onClick={onClose} aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search the menu"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b border-slate-200 p-2">
        <button
          type="button"
          onClick={() => setCat('ALL')}
          className={cat === 'ALL' ? 'btn-primary shrink-0' : 'btn-ghost shrink-0'}
        >
          All
        </button>
        {cats.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
            className={cat === c.id ? 'btn-primary shrink-0' : 'btn-ghost shrink-0'}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {error ? <ErrorNote message={error} /> : null}
        {products === null && !error ? (
          <p className="p-4 text-sm text-slate-500">Loading the menu…</p>
        ) : null}
        {products && !products.length ? (
          <p className="p-4 text-sm text-slate-500">Nothing matches that.</p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(products || []).map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => onAdd(p)}
              className="card flex min-h-[64px] items-center justify-between gap-2 p-3 text-left disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-pos-ink">{p.name}</span>
                {p.variants?.length ? (
                  <span className="block text-xs text-slate-500">{p.variants.length} options</span>
                ) : null}
              </span>
              <span className="shrink-0 text-sm font-bold tabular-nums text-pos-ink">
                {fmtINR(p.variants?.length ? p.variants[0].price : p.price)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function VariantSheet({ product, onPick, onClose }) {
  if (!product) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" role="dialog" aria-modal="true">
      <div className="max-h-[70vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-pos-ink">{product.name}</h2>
          <button type="button" className="btn-touch border-slate-300" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid gap-2">
          {product.variants.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onPick(v)}
              className="btn-ghost justify-between"
            >
              <span>{v.name}</span>
              <span className="font-bold tabular-nums">{fmtINR(v.price)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Captain() {
  const { user } = useAuth();
  const toast = useToast();

  const [floors, setFloors] = useState([]);
  const [floorId, setFloorId] = useState('');
  const [tables, setTables] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [picked, setPicked] = useState(null);
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [boardError, setBoardError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [variantFor, setVariantFor] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  // A write whose outcome is unknown. While this is set the screen sends no
  // further writes for this table: that, and not a retry, is what stops a
  // duplicate order or a duplicate KOT.
  const [unresolved, setUnresolved] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState('');
  const [readAt, setReadAt] = useState(null);

  // Re-read the table's row from the server.
  //
  // The chip under the table name is a state the SERVER derived — lib/qr/
  // tableState.js is the only thing allowed to compute one, so this screen
  // fetches it rather than working it out again and becoming a second, rival
  // answer. `picked` is the row as it stood when the tile was tapped, and board
  // polling is suspended while a table is open, so after any write it is stale.
  // Stale here is not cosmetic: opening an order moves the table off FREE and
  // sending a KOT moves it to IN_KITCHEN, and a header still reading "Free"
  // over food that is already with the kitchen is how a second party gets shown
  // to an occupied table.
  const refreshPicked = useCallback(async (tableId) => {
    if (!floorId || !tableId) return null;
    const { data } = await api.get(`/floors/${floorId}/layout`);
    const row = (data.layout?.tables || []).find((t) => t.tableId === tableId);
    if (row) setPicked(row);
    return row ?? null;
  }, [floorId]);

  // Reading is not writing. A GET cannot open a second order or cut a second
  // KOT, so re-reading after a lost reply is safe where re-sending is not —
  // and the answer it brings back is the only thing that can say whether the
  // lost write landed.
  const reconcile = useCallback(async () => {
    setReconciling(true);
    setReconcileError('');
    try {
      // Always re-read the row, even when the order id is already known: the
      // state it carries is the other half of what the lost write may have
      // changed. The id may never have reached this screen at all — if the lost
      // reply was the one from POST /orders, the order exists and only its id is
      // missing, and the table is what knows which order is open on it.
      const row = picked ? await refreshPicked(picked.tableId) : null;
      const id = order?.id || row?.service?.orderId || null;
      if (id) {
        const { data } = await api.get(`/orders/${id}`);
        setOrder(data.order);
      } else {
        setOrder(null);
      }
      const subs = await api
        .get('/table-qr/submissions', { params: { status: 'SUBMITTED' } })
        .catch(() => null);
      if (subs) setSubmissions(subs.data.submissions || []);
      setReadAt(new Date());
      setUnresolved(null);
      setError('');
    } catch (err) {
      setReconcileError(
        isAnswered(err)
          ? apiError(err, 'The server refused to show this order.')
          : 'Still no reply from the server.',
      );
    } finally {
      setReconciling(false);
    }
  }, [order, picked, floorId, refreshPicked]);

  // The success path shared by every write that changes the order. Refreshing
  // the row is part of it, not an afterthought a handler can forget: the order
  // and the table's state both moved, and showing one without the other is what
  // froze the header chip at whatever the table was doing when it was opened.
  const afterWrite = useCallback(async (next, tableId) => {
    setOrder(next);
    setReadAt(new Date());
    await refreshPicked(tableId).catch(() => {});
  }, [refreshPicked]);

  // Reads. A read that fails changed nothing by definition, so it says so and
  // may be tried again.
  const surfaceRead = useCallback((err, fallback) => {
    const msg = isAnswered(err) ? apiError(err, fallback) : `${fallback} — no reply from the server.`;
    setError(msg);
    toast(msg, 'error');
  }, [toast]);

  // Writes. An answered refusal is stated. An unanswered one is not guessed at.
  const surfaceWrite = useCallback(async (err, fallback, what) => {
    if (isAnswered(err)) {
      const msg = apiError(err, fallback);
      setError(msg);
      toast(msg, 'error');
      return;
    }
    setError('');
    setUnresolved({ what });
    toast('No reply from the server — reading the order back.', 'error');
    await reconcile();
  }, [toast, reconcile]);

  // Every control that writes is dead until the unknown is resolved.
  const locked = busy || reconciling || Boolean(unresolved);

  // --- the board -------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/floors');
        const list = data.floors || [];
        setFloors(list);
        if (list.length) setFloorId((cur) => cur || list[0].id);
      } catch (err) {
        setBoardError(apiError(err, 'Could not load floors'));
      }
    })();
  }, []);

  const loadBoard = useCallback(async () => {
    if (!floorId) return;
    try {
      const [layout, subs] = await Promise.all([
        api.get(`/floors/${floorId}/layout`),
        // A captain may be refused this list by a tenant rule; the board is
        // still usable without it, so it must not take the screen down.
        api.get('/table-qr/submissions', { params: { status: 'SUBMITTED' } }).catch(() => null),
      ]);
      setTables(layout.data.layout?.tables || []);
      setSubmissions(subs?.data?.submissions || []);
      setReadAt(new Date());
      setBoardError('');
    } catch (err) {
      // The tables already on screen are not cleared — they were true once and
      // are the best information there is. But they are no longer live, and the
      // note below says so with the time they were last confirmed.
      setBoardError(
        isAnswered(err)
          ? apiError(err, 'Could not load the floor')
          : 'No reply from the server.',
      );
    }
  }, [floorId]);

  useEffect(() => { loadBoard(); }, [loadBoard]);

  useEffect(() => {
    if (picked) return undefined;
    const t = setInterval(() => { if (!document.hidden) loadBoard(); }, 10000);
    return () => clearInterval(t);
  }, [picked, loadBoard]);

  const pendingByTable = useMemo(() => {
    const m = {};
    for (const s of submissions) {
      const id = s.tableId || s.table?.id;
      if (id) m[id] = (m[id] || 0) + 1;
    }
    return m;
  }, [submissions]);

  // --- one table -------------------------------------------------------------
  const openTable = async (table) => {
    setPicked(table);
    setOrder(null);
    setError('');
    setUnresolved(null);
    setReconcileError('');
    const orderId = table.service?.orderId;
    if (!orderId) return;
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${orderId}`);
      setOrder(data.order);
      setReadAt(new Date());
    } catch (err) {
      surfaceRead(err, 'Could not open the order');
    } finally {
      setBusy(false);
    }
  };

  const backToBoard = () => {
    setPicked(null);
    setOrder(null);
    setError('');
    // The board re-reads every table from the server, which answers the same
    // question an unresolved write left open.
    setUnresolved(null);
    setReconcileError('');
    loadBoard();
  };

  const addProduct = async (product, variant = null) => {
    if (product.variants?.length && !variant) {
      setVariantFor(product);
      return;
    }
    setVariantFor(null);
    setBusy(true);
    setError('');
    try {
      if (!order) {
        const { data } = await api.post('/orders', {
          type: 'DINE_IN',
          tableId: picked.tableId,
          items: [{ productId: product.id, ...(variant ? { variantId: variant.id } : {}), qty: 1 }],
        });
        await afterWrite(data.order, picked.tableId);
      } else {
        const { data } = await api.post(`/orders/${order.id}/items`, {
          productId: product.id,
          ...(variant ? { variantId: variant.id } : {}),
          qty: 1,
        });
        await afterWrite(data.order, picked.tableId);
      }
      toast(`${product.name} added`, 'success');
    } catch (err) {
      await surfaceWrite(err, 'Could not add the item', `${product.name}`);
    } finally {
      setBusy(false);
    }
  };

  const setQty = async (item, qty) => {
    if (qty < 1) return;
    setBusy(true);
    try {
      const { data } = await api.patch(`/orders/${order.id}/items/${item.id}`, { qty });
      await afterWrite(data.order, picked.tableId);
    } catch (err) {
      await surfaceWrite(err, 'Could not change the quantity', `the new quantity for ${item.name}`);
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (item) => {
    setBusy(true);
    try {
      const { data } = await api.delete(`/orders/${order.id}/items/${item.id}`);
      await afterWrite(data.order, picked.tableId);
    } catch (err) {
      await surfaceWrite(err, 'Could not remove the line', `removing ${item.name}`);
    } finally {
      setBusy(false);
    }
  };

  const sendKot = async () => {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/orders/${order.id}/kot`, {});
      await afterWrite(data.order, picked.tableId);
      toast(`KOT #${data.kot.seq} sent to the kitchen.`, 'success');
    } catch (err) {
      // The one that matters most: a lost reply here can mean the ticket is
      // already on the kitchen printer.
      await surfaceWrite(err, 'Could not send the KOT', 'the kitchen ticket');
    } finally {
      setBusy(false);
    }
  };

  const acceptSubmission = async (s) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/table-qr/submissions/${s.id}/accept`, {});
      await afterWrite(data.order, picked.tableId);
      setSubmissions((list) => list.filter((x) => x.id !== s.id));
      toast(data.kotId ? 'Accepted and sent to the kitchen.' : 'Accepted.', 'success');
    } catch (err) {
      await surfaceWrite(err, 'Could not accept the order', "the guest's order");
    } finally {
      setBusy(false);
    }
  };

  const tableSubs = useMemo(
    () => submissions.filter((s) => (s.tableId || s.table?.id) === picked?.tableId),
    [submissions, picked],
  );

  const lines = activeLines(order);
  const unsent = lines.filter((l) => !l.kotSeq);

  // --- board view ------------------------------------------------------------
  if (!picked) {
    return (
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-lg font-bold text-pos-ink">Tables</h1>
          <span className="text-xs text-slate-500">{user?.fullName}</span>
        </div>

        {boardError ? (
          <ErrorNote
            message={`${boardError}${
              tables.length && readAt
                ? ` These tables are as the server last confirmed them at ${readAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} and are no longer live.`
                : ''
            }`}
          />
        ) : null}

        {floors.length > 1 ? (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {floors.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFloorId(f.id)}
                className={f.id === floorId ? 'btn-primary shrink-0' : 'btn-ghost shrink-0'}
              >
                {f.name}
              </button>
            ))}
          </div>
        ) : null}

        {!tables.length && !boardError ? (
          <p className="card p-6 text-center text-sm text-slate-500">
            No published layout on this floor yet.
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {tables.map((t) => (
            <TableCard
              key={t.tableId}
              table={t}
              pending={pendingByTable[t.tableId] || 0}
              onPick={openTable}
            />
          ))}
        </div>
      </div>
    );
  }

  // --- one table -------------------------------------------------------------
  const svc = picked.service || {};
  const meta = tableStateMeta(svc.state);

  return (
    <div className="space-y-3 pb-28">
      <div className="flex items-center gap-2">
        <button type="button" className="btn-touch border-slate-300" onClick={backToBoard} aria-label="Back to tables">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-pos-ink">{picked.name}</h1>
          <span className={`badge ${meta.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden="true" />
            {meta.label}
          </span>
        </div>
      </div>

      {error ? <ErrorNote message={error} /> : null}

      {unresolved ? (
        <div className="card border-2 border-amber-400 bg-amber-50 p-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-bold text-amber-900">
            <CircleAlert className="h-4 w-4 shrink-0" />
            Not confirmed — the server did not answer
          </div>
          <p className="text-xs leading-relaxed text-amber-900">
            {unresolved.what ? <strong>{unresolved.what}</strong> : 'That change'} may or may not
            have been saved. The request can arrive, be written and cut its ticket with only the
            reply lost coming back, so this screen will not send it again — a second copy is how a
            table gets the same dish twice.
          </p>
          {reconciling ? (
            <p className="mt-2 text-xs font-semibold text-amber-900">
              Reading the order back from the server…
            </p>
          ) : reconcileError ? (
            <>
              <p className="mt-2 text-xs font-semibold text-red-700">
                {reconcileError} What is listed below is the last thing the server confirmed
                {readAt ? `, read at ${readAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
                , and may no longer be true.
              </p>
              <button
                type="button"
                className="btn-ghost mt-2 w-full"
                disabled={reconciling}
                onClick={reconcile}
              >
                <RefreshCw className="h-4 w-4" /> Ask the server again
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {tableSubs.length ? (
        <div className="card border-amber-300 bg-amber-50 p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-900">
            <CircleAlert className="h-4 w-4" />
            {tableSubs.length} guest {tableSubs.length === 1 ? 'order' : 'orders'} waiting
          </div>
          <p className="mb-2 text-xs text-amber-800">
            The kitchen has NOT been told. Accepting cuts the KOT.
          </p>
          {tableSubs.map((s) => (
            <div key={s.id} className="mb-2 rounded-lg border border-amber-200 bg-white p-2">
              <ul className="mb-2 text-sm text-pos-ink">
                {(s.lines || []).map((l, i) => (
                  <li key={l.id || i} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate">{l.name}</span>
                    <span className="shrink-0 font-semibold tabular-nums">×{l.qty}</span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1" disabled={locked} onClick={() => acceptSubmission(s)}>
                  <Check className="h-4 w-4" /> Accept
                </button>
                <button type="button" className="btn-ghost flex-1" disabled={locked} onClick={() => setRejectTarget(s)}>
                  <X className="h-4 w-4" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="card divide-y divide-slate-100">
        {!lines.length ? (
          <p className="p-6 text-center text-sm text-slate-500">
            Nothing on this table yet. Add from the menu below.
          </p>
        ) : null}
        {lines.map((l) => (
          <div key={l.id} className="flex items-center gap-2 p-3">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-pos-ink">{l.name}</span>
              <span className="block text-xs text-slate-500">
                {fmtINR(l.unitPrice)} each
                {l.kotSeq ? ` · sent on KOT #${l.kotSeq}` : ' · not sent yet'}
              </span>
            </div>
            {l.kotSeq ? (
              // Already in the kitchen, so there is nothing here to press.
              // Quantity steppers are gone because silently editing a line the
              // kitchen is cooking is how a table gets food nobody has a record
              // of — and voiding it is a manager's action (the server gates
              // /items/:id/void to BRANCH_MANAGER and up, which refuses a
              // cashier too). A button that always answers 403 would be worse
              // than this sentence.
              <span className="shrink-0 text-[11px] font-semibold text-slate-400">
                With the kitchen
              </span>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-touch border-slate-300"
                  disabled={locked || l.qty <= 1}
                  onClick={() => setQty(l, l.qty - 1)}
                  aria-label={`One fewer ${l.name}`}
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="w-7 text-center text-sm font-bold tabular-nums">{l.qty}</span>
                <button
                  type="button"
                  className="btn-touch border-slate-300"
                  disabled={locked}
                  onClick={() => setQty(l, l.qty + 1)}
                  aria-label={`One more ${l.name}`}
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="btn-touch border-slate-300 text-slate-500"
                  disabled={locked}
                  onClick={() => removeItem(l)}
                  aria-label={`Remove ${l.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {order ? (
        <p className="px-1 text-xs text-slate-500">
          {/* Shown because a captain is asked "how much so far?" all night. It
              is the running total the server calculated, not a bill: raising
              one is a cashier's action and this screen cannot do it. */}
          Running total {fmtINR(order.total)} · the bill is raised at the till.
        </p>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-slate-200 bg-white p-3">
        <button type="button" className="btn-ghost flex-1" onClick={() => setMenuOpen(true)} disabled={locked}>
          <Plus className="h-4 w-4" /> Add items
        </button>
        <button
          type="button"
          className="btn-primary flex-1"
          disabled={locked || !unsent.length}
          onClick={sendKot}
        >
          <Send className="h-4 w-4" />
          {unsent.length ? `Send ${unsent.length} to kitchen` : 'Nothing to send'}
        </button>
      </div>

      <MenuSheet
        open={menuOpen}
        busy={locked}
        onClose={() => setMenuOpen(false)}
        onAdd={(p) => addProduct(p)}
      />
      <VariantSheet
        product={variantFor}
        onClose={() => setVariantFor(null)}
        onPick={(v) => addProduct(variantFor, v)}
      />

      <ReasonModal
        open={Boolean(rejectTarget)}
        title="Reject this guest order"
        hint="The guest is told it was refused. Say why."
        busyLabel="Reject"
        onClose={() => setRejectTarget(null)}
        onSubmit={async (reason) => {
          try {
            await api.post(`/table-qr/submissions/${rejectTarget.id}/reject`, { reason });
          } catch (err) {
            // An answered refusal belongs in the modal, which keeps it open
            // with the reason still typed. An unanswered one does not: the
            // rejection may have been recorded, so the modal closes and the
            // screen goes and finds out rather than offering a second reject.
            if (isAnswered(err)) throw err;
            await surfaceWrite(err, '', 'the rejection');
            return;
          }
          setSubmissions((list) => list.filter((x) => x.id !== rejectTarget.id));
          toast('Guest order rejected.', 'success');
          loadBoard();
          // A rejected basket was the only thing holding the table in ORDERING.
          await refreshPicked(picked.tableId).catch(() => {});
        }}
      />

      {busy ? (
        <div className="fixed inset-x-0 top-0 z-50 bg-pos-royal px-3 py-1 text-center text-xs font-semibold text-white">
          <ChefHat className="mr-1 inline h-3 w-3" /> Working…
        </div>
      ) : null}
    </div>
  );
}
