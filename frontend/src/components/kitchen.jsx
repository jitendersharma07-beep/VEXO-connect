// Pieces every kitchen-display screen needs.
//
// The three KDS screens — station, expediter, supervisor — all poll the same
// branch-level seq cursor, merge the same deltas and age the same tickets. That
// loop was written out three times in three files, and it had drifted three
// different ways: the expediter claimed "Nothing at the pass" before its first
// poll returned, every screen disabled the whole board while one ticket was in
// flight, and none of them ever dropped a finished row. The argument
// components/inventory.jsx makes for useInventory holds harder here, because
// the way THIS drifts is that one screen shows a cancelled ticket as still to
// cook.
//
// Nothing in here decides authorization or state: the server owns transitions
// (kitchen.js POST /items/:id/state) and the route gates own who may see the
// screen at all. These are the parts that are identical between screens.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Store } from 'lucide-react';
import { apiError } from '../lib/api.js';
import { EmptyState, ErrorNote } from './ui.jsx';
import { fetchItems, mergeItems, pruneTerminal } from '../lib/kitchen.js';

/* ------------------------------------------------------------- the live feed */

// One poll loop per screen. Callers get plain arrays and a clock; the cursor,
// the merge, the pruning and the scope bookkeeping stay in here.
//
//   stationId  one station's board, or omitted for every station in the store
//   branchId   required for a non-pinned role (see useKitchenBranch)
//   ready      false while the store is still unchosen — polling before that
//              fires a 400 every few seconds and paints an error over an empty
//              board
export function useKitchenFeed({ stationId, branchId, ready = true, pollMs = 4000 } = {}) {
  const [itemMap, setItemMap] = useState(() => new Map());
  const [error, setError] = useState('');
  // A poll has SUCCEEDED at least once. The difference between "no tickets" and
  // "not asked yet" is the difference between a calm kitchen and a broken
  // screen, and a page that cannot tell them apart says the wrong one.
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const cursorRef = useRef(0);

  // The scope a cursor belongs to. Advancing store A's cursor against store B's
  // board would silently skip B's history, and B's tickets would appear under
  // A's name until the next reload.
  const scope = `${branchId ?? ''}|${stationId ?? ''}`;
  const scopeRef = useRef(scope);

  useEffect(() => {
    scopeRef.current = scope;
    cursorRef.current = 0;
    setItemMap(new Map());
    setLoaded(false);
    setError('');
  }, [scope]);

  const poll = useCallback(async () => {
    if (!ready) return;
    const mine = scope;
    try {
      const { items, cursor } = await fetchItems({ since: cursorRef.current, stationId, branchId });
      if (scopeRef.current !== mine) return; // the store changed mid-flight
      cursorRef.current = cursor;
      if (items.length) setItemMap((m) => mergeItems(m, items));
      setError('');
      setLoaded(true);
    } catch (err) {
      if (scopeRef.current !== mine) return;
      // Deliberately does not clear itemMap. A failed refresh that blanked the
      // board would read as "the kitchen has nothing to cook".
      setError(apiError(err, 'Could not reach the kitchen feed'));
    }
  }, [ready, scope, stationId, branchId]);

  useEffect(() => {
    if (!ready) return undefined;
    poll();
    const t = setInterval(poll, pollMs);
    return () => clearInterval(t);
  }, [poll, ready, pollMs]);

  // One clock for the whole screen. Between polls the only thing that changes is
  // how long tickets have been waiting, and a per-card timer means N timers for
  // N tickets. Expiring terminal rows rides along on the same tick.
  useEffect(() => {
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setItemMap((m) => pruneTerminal(m, at));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // A completed write returns the authoritative row: show it at once instead of
  // waiting up to pollMs for the delta to say the same thing.
  const apply = useCallback((item) => setItemMap((m) => mergeItems(m, [item])), []);

  const items = useMemo(() => [...itemMap.values()], [itemMap]);
  return { items, now, loaded, error, poll, apply };
}

/* ---------------------------------------------------------- per-item actions */

// One boolean for the whole board disables every other ticket while one request
// is in flight — on a station screen that means the cook cannot start a second
// dish until the first answer comes back. Busy is per ticket.
export function useItemAction() {
  const inFlight = useRef(new Set());
  const [, bump] = useState(0);

  const run = useCallback(async (id, fn) => {
    // A second click during the first request is the same decision on the same
    // version. The server answers it as a replay (200, replayed:true) rather
    // than moving the ticket twice, but there is no reason to send it.
    if (inFlight.current.has(id)) return undefined;
    inFlight.current.add(id);
    bump((n) => n + 1);
    try {
      return await fn();
    } finally {
      inFlight.current.delete(id);
      bump((n) => n + 1);
    }
  }, []);

  return { isBusy: (id) => inFlight.current.has(id), run };
}

/* ------------------------------------------------------------ store scoping  */

// The store select an owner needs and a pinned role must never see: for a
// BRANCH_MANAGER or CASHIER the server takes the branch from the session and
// answers 404 on a mismatch, so offering them a choice would only offer them a
// way to break their own screen.
export function KitchenStoreSelect({ branch }) {
  if (!branch.needsBranch) return null;
  return (
    <select
      className="input"
      value={branch.branchId ?? ''}
      onChange={(e) => branch.setBranchId(e.target.value)}
      aria-label="Store"
    >
      <option value="">Choose a store…</option>
      {branch.branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
      ))}
    </select>
  );
}

// What a screen shows INSTEAD of a board while no store is chosen. Returns null
// the moment the feed may legally be polled, so a screen can render it
// unconditionally.
export function KitchenStoreGate({ branch, note }) {
  if (!branch.needsBranch || branch.ready) return null;
  if (branch.loading) {
    return (
      <div className="card p-6 text-center text-sm text-slate-500">Loading your stores…</div>
    );
  }
  if (branch.error) {
    return <ErrorNote message={apiError(branch.error, 'Could not load your stores')} />;
  }
  if (branch.branches.length === 0) {
    return (
      <EmptyState
        icon={Store}
        title="No active store"
        note="A kitchen board belongs to one store, and this company has none that is active. Add or reactivate a store first."
      />
    );
  }
  return (
    <EmptyState
      icon={Store}
      title="Choose a store"
      note={note ?? 'A kitchen board belongs to one store — the stations, the tickets and the change cursor are all per store.'}
    />
  );
}
