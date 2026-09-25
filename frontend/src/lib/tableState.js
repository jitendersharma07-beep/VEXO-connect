// The ONE place a derived table state becomes English and colour.
//
// Mirrors TABLE_STATES in the backend's lib/qr/tableState.js, which derives
// these from rows the till, the kitchen and the payment path wrote. Nothing
// here computes a state; this file only decides how one is shown. Same reason
// roles.js exists: the floor plan, the Captain handheld and the Kiosk must not
// call the same state three different things.
//
// Two of these labels are the requirement, not decoration:
//
//   SERVED is "Served", never "Ready". Ready is a kitchen word — it means the
//   pass has the food — and a plate on the pass is not a plate on the table.
//   A manager reading "Ready" as "done" stops sending anyone.
//
//   PAID says "clear table" out loud. Money arriving does not free a table:
//   the party is still sitting there. A plan that turned a settled table green
//   next to the empty ones would seat the next party into occupied chairs.
//
// Every state carries a `label`. Colour is the second channel, never the only
// one — the state must survive being printed in mono or read by someone who
// cannot separate the hues.

export const TABLE_STATE_ORDER = [
  'FREE',
  'SEATED',
  'ORDERING',
  'IN_KITCHEN',
  'SERVED',
  'BILLED',
  'PAID',
];

const STATES = Object.freeze({
  FREE: {
    label: 'Free',
    note: 'No party, no open order',
    tile: 'border-slate-300 bg-white text-slate-600',
    chip: 'bg-slate-100 text-slate-600',
    dot: 'bg-slate-400',
  },
  SEATED: {
    label: 'Seated',
    note: 'Party seated, nothing sent yet',
    tile: 'border-sky-400 bg-sky-50 text-sky-800',
    chip: 'bg-sky-100 text-sky-700',
    dot: 'bg-sky-500',
  },
  ORDERING: {
    label: 'Order waiting',
    note: 'A guest has sent a basket — staff must accept or reject it',
    tile: 'border-amber-500 bg-amber-50 text-amber-900',
    chip: 'bg-amber-100 text-amber-800',
    dot: 'bg-amber-500',
  },
  IN_KITCHEN: {
    label: 'In kitchen',
    note: 'Accepted and cooking — something is still not on the table',
    tile: 'border-indigo-400 bg-indigo-50 text-indigo-800',
    chip: 'bg-indigo-100 text-indigo-700',
    dot: 'bg-indigo-500',
  },
  SERVED: {
    label: 'Served',
    note: 'Every active line is on the table; no bill raised yet',
    tile: 'border-emerald-400 bg-emerald-50 text-emerald-800',
    chip: 'bg-emerald-100 text-emerald-700',
    dot: 'bg-emerald-500',
  },
  BILLED: {
    label: 'Billed',
    note: 'Bill raised, money still owed',
    tile: 'border-orange-500 bg-orange-50 text-orange-900',
    chip: 'bg-orange-100 text-orange-800',
    dot: 'bg-orange-500',
  },
  PAID: {
    label: 'Paid · clear table',
    note: 'Settled. The table is NOT free until the party leaves and it is cleared',
    tile: 'border-violet-400 bg-violet-50 text-violet-800',
    chip: 'bg-violet-100 text-violet-700',
    dot: 'bg-violet-500',
  },
});

const UNKNOWN = Object.freeze({
  label: 'Unknown',
  note: 'The server reported a state this build does not know',
  tile: 'border-slate-300 bg-white text-slate-600',
  chip: 'bg-slate-100 text-slate-600',
  dot: 'bg-slate-400',
});

// A state this build has never heard of is shown as Unknown rather than
// silently styled as FREE. A newer server adding a state must not make a busy
// table look empty on an older screen.
export const tableStateMeta = (state) => STATES[state] || UNKNOWN;

export const tableStateLabel = (state) => tableStateMeta(state).label;

// Tables a human owes something to, most urgent first. Used to order the
// "needs attention" list and nothing else — the floor map keeps its geometry.
export const ATTENTION_ORDER = ['ORDERING', 'BILLED', 'PAID', 'IN_KITCHEN', 'SERVED'];

/** Minutes since an ISO instant, or null. */
export const minutesSince = (iso, now = Date.now()) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60000));
};

/** "1h 20m" / "8m" / null — a table's seated duration, read at a glance. */
export const fmtSeated = (iso, now = Date.now()) => {
  const m = minutesSince(iso, now);
  if (m === null) return null;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
