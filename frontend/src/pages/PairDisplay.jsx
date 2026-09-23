import { useEffect, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

// VC-101 — the staff side of pairing: mint a code here, type it on the
// customer display. A pinned role pairs their own branch; an owner picks
// one, because a display stands at one counter of one branch.

const displayUrl = () => `${window.location.origin}${import.meta.env.BASE_URL}display`;

export default function PairDisplay() {
  const { user } = useAuth();
  const pinned = user.role === 'CASHIER' || user.role === 'BRANCH_MANAGER';
  const [branches, setBranches] = useState(null);
  const [branchId, setBranchId] = useState('');
  const [minted, setMinted] = useState(null); // { code, deadline }
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pinned) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        if (!alive) return;
        const list = data.branches ?? [];
        setBranches(list);
        if (list.length === 1) setBranchId(list[0].id);
      } catch (err) {
        if (alive) setError(apiError(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [pinned]);

  // Countdown against a fixed deadline, so a slow render never drifts it.
  useEffect(() => {
    if (!minted) return undefined;
    const update = () => setRemaining(Math.max(0, Math.round((minted.deadline - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [minted]);

  const mint = async () => {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/display/pair-code', pinned ? {} : { branchId });
      setMinted({ code: data.code, deadline: Date.now() + data.expiresInSeconds * 1000 });
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const mmss = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-6 flex items-center gap-3">
        <MonitorSmartphone className="h-7 w-7 shrink-0 text-pos-royal" />
        <div>
          <h1 className="text-xl font-bold text-pos-ink">Customer display</h1>
          <p className="text-sm text-slate-500">
            Pair the screen your customers see at this counter.
          </p>
        </div>
      </div>

      <ol className="mb-6 list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>
          On the customer-facing device, open{' '}
          <span className="select-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-pos-royal">
            {displayUrl()}
          </span>
        </li>
        <li>Generate a code below and type it on that screen.</li>
        <li>
          The display follows this sign-in: it clears when the bill is settled and ends when you
          sign out.
        </li>
      </ol>

      {!pinned ? (
        <label className="mb-4 block text-sm font-medium text-slate-700">
          Branch
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">Select a branch…</option>
            {(branches ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <button
        type="button"
        onClick={mint}
        disabled={busy || (!pinned && !branchId)}
        className="rounded-xl bg-pos-royal px-5 py-2.5 font-semibold text-white disabled:opacity-40"
      >
        {busy ? 'Generating…' : minted ? 'Generate a new code' : 'Generate pairing code'}
      </button>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {minted ? (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          {remaining > 0 ? (
            <>
              <div className="font-mono text-6xl font-bold tracking-[0.3em] text-pos-ink">
                {minted.code}
              </div>
              <div className="mt-3 text-sm text-slate-500">
                Single use · expires in <span className="font-semibold tabular-nums">{mmss}</span>
              </div>
            </>
          ) : (
            <div className="text-lg text-slate-500">That code expired — generate a new one.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
