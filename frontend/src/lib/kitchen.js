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
// render productName. variantName never arrives separately — the line name
// already carries the variant where one exists.
const normalizeItem = (it) => ({ ...it, productName: it.name });

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

// Seconds this ticket has been in the kitchen's hands (queuedAt → readyAt or
// now). Rendering only — the server owns every timestamp.
export const ageSeconds = (item, now = Date.now()) => {
  if (!item.queuedAt) return 0;
  const end = item.readyAt ? new Date(item.readyAt).getTime() : now;
  return Math.max(0, Math.round((end - new Date(item.queuedAt).getTime()) / 1000));
};

export const fmtAge = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
