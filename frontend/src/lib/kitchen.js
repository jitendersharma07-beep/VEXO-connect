// VC-103 kitchen client — the ONE place the kitchen screens talk to the
// backend. Verified against the LANDED Window-3 backend (x/kitchen @ 1e92440,
// backend/src/api/routes/kitchen.js, mounted at /api/kitchen):
//
//   GET  /kitchen/stations[?branchId=]        → { stations }
//        (branchId required only when the session user is not branch-scoped)
//   GET  /kitchen/stations/:id/board          → { seq, items }
//        live snapshot: QUEUED/IN_PREP/READY, queuedAt ascending
//   GET  /kitchen/stations/:id/board?sinceSeq=N
//        → { seq, items } — every row with changeSeq > N, terminal included
//   POST /kitchen/items/:id/state { to, version, reason? } → { item, replayed }
//        reason is REQUIRED when to=CANCELLED; a replay of an already-applied
//        decision answers 200, a stale version or bad transition is a 409
//
// There is NO delay endpoint — delayReason is server-owned and read-only on
// these screens. The seq cursor is BRANCH-level (one KitchenCursor per
// branch), so one cursor spans every station's board; the cross-station feed
// below leans on that. Item rows carry `name`/`qty`/`kotSeq` — NOT
// productName, variantName, orderType, tableCode, invoiceNumber, modifiers or
// notes; normalizeItem maps name → productName and orderLabel copes with the
// absent fields.
//
// Every mutation carries the row's `version` (optimistic lock): a 409 means
// someone else moved the ticket first — refetch, never overwrite.

import { useCallback, useEffect, useState } from 'react';
import api from './api.js';

export const KITCHEN_STATES = ['QUEUED', 'IN_PREP', 'READY', 'SERVED', 'CANCELLED'];

// The forward transition each active state offers. SERVED and CANCELLED are
// terminal; cancelling requires a reason and stays off these screens.
export const NEXT_STATE = { QUEUED: 'IN_PREP', IN_PREP: 'READY', READY: 'SERVED' };

export const STATE_STYLES = {
  QUEUED: 'bg-slate-100 text-slate-600',
  IN_PREP: 'bg-blue-100 text-blue-700',
  READY: 'bg-emerald-100 text-emerald-700',
  SERVED: 'bg-slate-100 text-slate-400',
  CANCELLED: 'bg-red-100 text-red-700',
};

// The board serialises the order line's display name as `name`; the screens
// render productName. variantName never arrives separately and must not be
// rendered separately — orders.js:272 snapshots the line name as
// `Product (Variant)`, so the variant is already inside it.
const normalizeItem = (it) => ({ ...it, productName: it.name });

// Does the board payload carry the line's kitchen instruction at all?
//
// OrderItem.note exists, and its own schema comment says it is "Printed on the
// KOT and shown on the station" — but publicItem (kitchen.js:54) selects only
// { name, qty } from orderItem, so "no peanuts" is stored on the line, printed
// on the KOT, and never reaches this screen. Same for OrderItemModifier. The fix
// is a one-line change to the select in W3's file and is not this window's to
// make; until it lands, the screens say so out loud rather than showing a cook a
// ticket that looks complete.
//
// The test is presence of the KEY, not a truthy value: today no row has it, and
// the moment the select includes the column every row carries it (usually null)
// and this notice goes quiet on its own with no page change.
export const payloadOmitsNotes = (items) =>
  items.length > 0 && !items.some((it) => 'note' in it || 'notes' in it || 'modifiers' in it);

// One display label per ticket. orderType/tableCode are not in today's board
// payload, so this usually shows the KOT number; if the backend later adds
// them, the richer label lights up here with no page changes.
export const orderLabel = (item) => {
  const kot = item.kotSeq ? `KOT #${item.kotSeq}` : '';
  let where = '';
  if (item.orderType === 'DINE_IN') where = `Table ${item.tableCode ?? '—'}`;
  else if (item.orderType) where = 'Takeaway';
  if (where && kot) return `${where} · ${kot}`;
  return where || kot || (item.orderId ? `Order ${String(item.orderId).slice(-6).toUpperCase()}` : '—');
};

export const listStations = async (branchId) => {
  const { data } = await api.get('/kitchen/stations', branchId ? { params: { branchId } } : undefined);
  return data.stations || [];
};

// Supervisor figures the board cannot compute: per-station queue depth, the
// oldest QUEUED age, and ordersKitchenReady — whole-order readiness, which is a
// question about every line of an order and so cannot be derived from one
// station's rows. managerUp only (kitchen.js:241).
export const fetchOverview = async (branchId) => {
  const { data } = await api.get('/kitchen/overview', branchId ? { params: { branchId } } : undefined);
  return data;
};

// --- branch scoping ---------------------------------------------------------
// Every kitchen route resolves its branch through callerBranchId
// (kitchen.js:29): the SESSION's branchId if the role is pinned, otherwise the
// explicit ?branchId=, and if neither exists it throws
// badRequest('branchId is required'). BRANCH_PINNED_ROLES is
// {BRANCH_MANAGER, CASHIER} (middleware/auth.js:86) — a CUSTOMER_OWNER's
// PosUser.branchId is null, so an owner who sends no branchId gets a 400 on
// EVERY call: not an empty board, not a 403, just a dead screen for the one
// role that exists in every company.
//
// So an owner picks a store first, the same way DayClose.jsx:139-153 does for a
// cash drawer. Two deliberate differences from that page: the kitchen's role
// list excludes POS_SUPER_ADMIN (kitchen.js:26-27), so there is no ATC branch
// case to handle here; and a failed /branches load is NOT swallowed the way
// DayClose swallows it, because there the picker is a convenience and here it
// is the only way to address the API at all.
const BRANCH_PINNED_ROLES = ['BRANCH_MANAGER', 'CASHIER'];

export const useKitchenBranch = (user) => {
  const needsBranch = !!user?.role && !BRANCH_PINNED_ROLES.includes(user.role);
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [loading, setLoading] = useState(needsBranch);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!needsBranch) {
      setLoading(false);
      return;
    }
    let live = true;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        const active = (data.branches || []).filter((b) => b.status === 'ACTIVE');
        if (!live) return;
        setBranches(active);
        // One store is the common case and picking from a list of one is
        // friction, not a decision.
        if (active.length === 1) setBranchId(active[0].id);
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [needsBranch]);

  // `ready` is the gate the screens poll behind: a pinned role is ready at
  // once, an owner only once a store is chosen. Polling before that would fire
  // a 400 every few seconds and paint an error over an empty board.
  return {
    needsBranch,
    branches,
    branchId: needsBranch ? branchId : undefined,
    setBranchId,
    loading,
    error,
    ready: needsBranch ? !!branchId : true,
  };
};

// The cross-station feed re-lists stations at most once a minute; a station
// added mid-shift appears on the next cache expiry or a screen reload.
let stationsCache = { at: 0, key: '', list: [] };
const cachedStations = async (branchId) => {
  const key = branchId || '';
  if (stationsCache.key === key && Date.now() - stationsCache.at < 60_000) return stationsCache.list;
  const list = await listStations(branchId);
  stationsCache = { at: Date.now(), key, list };
  return list;
};

const board = async (stationId, since) => {
  const { data } = await api.get(
    `/kitchen/stations/${stationId}/board`,
    since > 0 ? { params: { sinceSeq: since } } : undefined,
  );
  return data;
};

// since=0 boots from the live snapshot (no terminal history — deliberately
// not sinceSeq=0, which would replay every finished line ever); since>0 pulls
// deltas. With no stationId this aggregates every station's board: the seq
// cursor is branch-level, so the SAME `since` fans out to each board, and the
// cursor advances to the MINIMUM returned seq — a change that lands between
// two boards' reads gets re-fetched next poll instead of skipped, and
// mergeItems makes the re-delivery idempotent.
export const fetchItems = async ({ since = 0, stationId, branchId } = {}) => {
  if (stationId) {
    const data = await board(stationId, since);
    return { items: (data.items || []).map(normalizeItem), cursor: data.seq ?? since };
  }
  const stations = await cachedStations(branchId);
  if (stations.length === 0) return { items: [], cursor: since };
  const boards = await Promise.all(stations.map((s) => board(s.id, since)));
  return {
    items: boards.flatMap((b) => (b.items || []).map(normalizeItem)),
    cursor: Math.min(...boards.map((b) => b.seq ?? since)),
  };
};

export const setItemState = async (id, to, version, reason) => {
  const { data } = await api.post(`/kitchen/items/${id}/state`, {
    to,
    version,
    ...(reason ? { reason } : {}),
  });
  return normalizeItem(data.item);
};

// Merge a poll's delta into the map keyed by item id. The server's changeSeq
// cursor means a delta can carry the same item twice across polls; last write
// (highest changeSeq) wins.
export const mergeItems = (map, items) => {
  const next = new Map(map);
  for (const it of items) {
    const prev = next.get(it.id);
    if (!prev || (it.changeSeq ?? 0) >= (prev.changeSeq ?? 0)) next.set(it.id, it);
  }
  return next;
};

// A delta carries terminal rows too (kitchen.js:138 — deliberately, so a
// reconnect learns what finished while it was away), and a terminal row never
// changes again. So a screen left open for a shift accumulates the whole day's
// finished lines: the map grows without bound, and worse, the station board's
// "Cancelled" column becomes a wall of tickets voided six hours ago. Keep a
// terminal row only while it is still worth a cook's attention.
export const TERMINAL_WINDOW_MS = 15 * 60_000;

export const pruneTerminal = (map, now = Date.now()) => {
  let next = null;
  for (const [id, it] of map) {
    if (it.state !== 'SERVED' && it.state !== 'CANCELLED') continue;
    const at = it.servedAt ?? it.cancelledAt ?? null;
    // A terminal row with no terminal timestamp is a server oddity, not a
    // licence to drop it. Keep it; a reload clears it.
    if (!at) continue;
    if (now - new Date(at).getTime() <= TERMINAL_WINDOW_MS) continue;
    if (!next) next = new Map(map);
    next.delete(id);
  }
  // Same Map identity when nothing expired, so the once-a-second call this sits
  // behind does not re-render the board 60 times a minute for nothing.
  return next ?? map;
};

// Seconds this ticket has been in the kitchen's hands (queuedAt → readyAt or
// now). Rendering only — the server owns every timestamp.
export const ageSeconds = (item, now = Date.now()) => {
  if (!item.queuedAt) return 0;
  const end = item.readyAt ? new Date(item.readyAt).getTime() : now;
  return Math.max(0, Math.round((end - new Date(item.queuedAt).getTime()) / 1000));
};

export const fmtAge = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
