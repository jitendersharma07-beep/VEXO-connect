import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Armchair, Pencil, Plus, RefreshCw } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader, StatusBadge } from '../components/ui.jsx';
import { ORDER_STATUS_STYLES, canSell, canWriteTables, fmtINR, getAtcScope, isAtc } from '../lib/pos.js';

// /tables — manager/owner table CRUD + live occupancy board (contract §5.2).
// Occupancy (`currentOrder`) is polled from the server every 15 s.

const POLL_MS = 15000;

function TableForm({ initial, owner, branches, onDone }) {
  const [name, setName] = useState(initial?.name || '');
  const [capacity, setCapacity] = useState(initial?.capacity ?? '');
  const [branchId, setBranchId] = useState(initial?.branchId || branches?.[0]?.id || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        ...(capacity !== '' ? { capacity: Number(capacity) } : {}),
      };
      if (initial) {
        await api.patch(`/tables/${initial.id}`, payload);
      } else {
        await api.post('/tables', { ...payload, ...(owner ? { branchId } : {}) });
      }
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {!initial && owner ? (
        <div>
          <label className="label" htmlFor="t-branch">Branch</label>
          <select id="t-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
            {(branches || []).map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>
        </div>
      ) : null}
      <div>
        <label className="label" htmlFor="t-name">Table name</label>
        <input id="t-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} placeholder="T7" autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="t-capacity">Capacity (seats, optional)</label>
        <input id="t-capacity" type="number" className="input" min="1" max="99" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy || !name.trim()}>
        {busy ? 'Saving…' : initial ? 'Save changes' : 'Create table'}
      </button>
    </form>
  );
}

export default function TablesAdmin() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;
  const writer = canWriteTables(user);

  const [tables, setTables] = useState(null);
  const [error, setError] = useState('');
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [modal, setModal] = useState(null); // 'new' | table
  const [toRetire, setToRetire] = useState(null);
  const [busy, setBusy] = useState(false);

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
    setError('');
    try {
      const params = owner && branchId ? { branchId } : {};
      const { data } = await api.get('/tables', { params });
      setTables(data.tables || []);
    } catch (err) {
      setError(apiError(err, 'Could not load tables'));
    }
  }, [atc, atcScope, owner, branchId]);

  useEffect(() => {
    setTables(null);
    load();
  }, [load]);

  // live occupancy: poll while the tab is visible
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const retire = async () => {
    await api.delete(`/tables/${toRetire.id}`);
    await load();
  };

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Tables" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={Armchair}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  const visible = (tables || []).filter((t) => (showRetired ? true : t.status === 'ACTIVE'));

  return (
    <div>
      <PageHeader
        title="Tables"
        subtitle={
          atcScope
            ? `Company: ${atcScope.name || atcScope.id}`
            : 'Live occupancy — refreshes automatically every 15 seconds'
        }
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={load}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            {writer ? (
              <button type="button" className="btn-orange" onClick={() => setModal('new')}>
                <Plus className="h-4 w-4" /> Add table
              </button>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {owner ? (
          <select className="input w-auto" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Filter by branch">
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired tables
        </label>
        <span className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> free</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /> occupied</span>
        </span>
      </div>

      {error ? <ErrorNote message={error} /> : null}
      {tables === null && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}
      {tables && visible.length === 0 ? (
        <EmptyState
          icon={Armchair}
          title="No tables yet"
          note={writer ? 'Add tables so the sell screen can seat dine-in orders.' : 'A manager or the owner adds tables here.'}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {visible.map((t) => {
          const occupied = Boolean(t.currentOrder);
          const retired = t.status === 'RETIRED';
          return (
            <div
              key={t.id}
              className={`card p-3 ${
                retired
                  ? 'opacity-60'
                  : occupied
                    ? 'border-amber-300 bg-amber-50/60'
                    : 'border-emerald-200 bg-emerald-50/40'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-base font-bold text-pos-ink">{t.name}</div>
                  <div className="text-xs text-slate-500">
                    {t.capacity ? `${t.capacity} seats` : 'no capacity set'}
                  </div>
                </div>
                {retired ? <StatusBadge status="RETIRED" /> : occupied ? (
                  <span className={`badge ${ORDER_STATUS_STYLES[t.currentOrder.status] || 'bg-amber-100 text-amber-700'}`}>
                    {t.currentOrder.status}
                  </span>
                ) : (
                  <span className="badge bg-emerald-100 text-emerald-700">FREE</span>
                )}
              </div>

              {occupied ? (
                <div className="mt-2 rounded-lg bg-white/70 px-2 py-1.5 text-xs text-slate-600">
                  <div className="flex justify-between">
                    <span>{t.currentOrder.type === 'DINE_IN' ? 'Dine-in' : 'Takeaway'}</span>
                    <span className="font-bold text-pos-ink">{fmtINR(t.currentOrder.total)}</span>
                  </div>
                  {canSell(user) ? (
                    <button
                      type="button"
                      className="mt-1 font-semibold text-pos-royal hover:underline"
                      onClick={() => navigate(`/sell?order=${t.currentOrder.id}`)}
                    >
                      Open in sell screen →
                    </button>
                  ) : null}
                </div>
              ) : null}

              {writer && !retired ? (
                <div className="mt-2 flex items-center gap-3 border-t border-slate-100 pt-2 text-xs">
                  <button type="button" className="flex items-center gap-1 font-semibold text-pos-royal hover:underline" onClick={() => setModal(t)}>
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    className="font-semibold text-red-600 hover:underline disabled:opacity-40"
                    disabled={occupied}
                    title={occupied ? 'Close the open order first' : 'Retire this table'}
                    onClick={() => setToRetire(t)}
                  >
                    Retire
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <Modal open={Boolean(modal)} title={modal === 'new' ? 'Add table' : `Edit ${modal?.name || ''}`} onClose={() => setModal(null)}>
        {modal ? (
          <TableForm
            initial={modal === 'new' ? null : modal}
            owner={owner}
            branches={branches}
            onDone={() => {
              setModal(null);
              load();
            }}
          />
        ) : null}
      </Modal>

      <Modal open={Boolean(toRetire)} title="Retire table" onClose={() => setToRetire(null)}>
        <p className="mb-4 text-sm text-slate-600">
          Retire “{toRetire?.name}”? It stops appearing on the sell screen. The server refuses while an
          open order sits on it.
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={() => setToRetire(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn flex-1 bg-red-600 text-white hover:bg-red-700"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await retire();
                setToRetire(null);
              } catch (err) {
                toast(apiError(err), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Retire table
          </button>
        </div>
      </Modal>
    </div>
  );
}
