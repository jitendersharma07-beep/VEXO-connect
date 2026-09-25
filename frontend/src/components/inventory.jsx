// Pieces every inventory screen needs.
//
// Nine screens read the same nine lists, and the parts that are identical
// across them live here rather than being retyped per page. The reason is the
// same one Layout.jsx gives for SidebarBody: a second hand-maintained copy
// drifts, and the way THIS one drifts is that one screen starts showing a
// blocked batch as available stock while another still shows it blocked.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { ErrorNote } from './ui.jsx';
import { badge, fmtQty, LOCATION_KIND_LABEL, unitLabel } from '../lib/inventory.js';

/* -------------------------------------------------------------- data loading */

// One loader for every screen, with the two properties they all need: a
// `reload` the action buttons can call after a write, and an error that does
// NOT wipe the data already on screen. A failed refresh showing an empty table
// reads as "the stock is gone".
export function useInventory(path, { params, skip = false } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!skip);
  const serialised = JSON.stringify(params ?? {});
  // The request that is allowed to write state. A slow response for an old
  // filter must not overwrite the answer to the current one.
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (skip) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const res = await api.get(path, { params: JSON.parse(serialised) });
      if (mine === generation.current) {
        setData(res.data);
        setError('');
      }
    } catch (err) {
      if (mine === generation.current) setError(apiError(err, 'Could not load this'));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [path, serialised, skip]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setError };
}

// An action button that cannot be double-submitted and that surfaces the
// server's own refusal text. §5 requires that a double-click cannot duplicate
// stock; the server's idempotency is what guarantees that, and this only stops
// the second request being sent in the first place.
export function ActionButton({ onClick, children, className = 'btn-primary', disabled, confirm, title }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      await onClick();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={className} onClick={run} disabled={busy || disabled} title={title}>
      {busy ? 'Working…' : children}
    </button>
  );
}

/* ------------------------------------------------------------------- layout */

export function Toolbar({ children }) {
  return <div className="mb-4 flex flex-wrap items-end gap-3">{children}</div>;
}

export function Field({ label, htmlFor, children, hint }) {
  return (
    <div className="min-w-[10rem]">
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

export function RefreshButton({ onClick, loading }) {
  return (
    <button type="button" className="btn-ghost" onClick={onClick} disabled={loading} title="Reload">
      <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
      <span className="ml-1.5 hidden sm:inline">Refresh</span>
    </button>
  );
}

// Tables here are wide by nature — six stock states, four transfer quantities.
// The wrapper scrolls horizontally rather than letting a column be clipped off
// the right edge where nobody knows it exists.
export function Table({ head, children, empty, emptyNote }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              {head.map((h) => (
                <th
                  key={typeof h === 'string' ? h : h.key}
                  className={`px-4 py-3 ${typeof h !== 'string' && h.right ? 'text-right' : ''}`}
                  title={typeof h !== 'string' ? h.help : undefined}
                >
                  {typeof h === 'string' ? h : h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {hasRows ? (
              children
            ) : (
              <tr>
                <td colSpan={head.length} className="px-4 py-10 text-center">
                  <div className="text-sm font-semibold text-slate-500">{empty || 'Nothing here'}</div>
                  {emptyNote ? <div className="mt-1 text-xs text-slate-400">{emptyNote}</div> : null}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const Td = ({ children, right, className = '', ...rest }) => (
  <td className={`px-4 py-3 ${right ? 'text-right tabular-nums' : ''} ${className}`} {...rest}>
    {children}
  </td>
);

/* ------------------------------------------------------------------ pickers */

// The location list is the caller's SCOPE, straight from the server: an owner
// gets the company's locations, a store manager gets the ones their branch pin
// and their explicit grants reach. §8's "store managers see their assigned
// stores" is therefore not a filter this component applies — it is what the
// endpoint already returned, and there is nothing here that could widen it.
export function useLocations() {
  const { data, error, loading, reload } = useInventory('/inventory/locations');
  const locations = useMemo(() => data?.locations ?? [], [data]);
  const byId = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);
  return { locations, byId, error, loading, reload };
}

export function LocationSelect({ value, onChange, locations, id = 'loc', allLabel = 'All locations I can see', kinds }) {
  const list = kinds ? locations.filter((l) => kinds.includes(l.kind)) : locations;
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {list.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name} · {LOCATION_KIND_LABEL[l.kind] || l.kind}
        </option>
      ))}
    </select>
  );
}

export function ItemSelect({ value, onChange, items, id = 'item', allLabel = 'All items' }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name} ({unitLabel(i.baseUnit)})
        </option>
      ))}
    </select>
  );
}

/* -------------------------------------------------------------- stock states */

// §4 keeps physical, usable, reserved and available apart, and this is where
// that is made visible rather than described. Available is the figure a person
// can act on, so it is the bold one; physical is the shelf, so it is the grey
// one; anything blocked is called out in red because stock that is present and
// unusable is the case a single "quantity" column silently gets wrong.
export function StockStateCells({ row, baseUnit }) {
  const blocked = row.blocked && !/^0+(\.0*)?$/.test(String(row.blocked));
  return (
    <>
      <Td right className="text-slate-500">{fmtQty(row.physical, baseUnit)}</Td>
      <Td right className={blocked ? 'font-semibold text-red-600' : 'text-slate-400'}>
        {fmtQty(row.blocked, baseUnit)}
      </Td>
      <Td right className="text-slate-600">{fmtQty(row.usable, baseUnit)}</Td>
      <Td right className="text-slate-600">{fmtQty(row.reserved, baseUnit)}</Td>
      <Td right className="font-bold text-pos-ink">{fmtQty(row.available, baseUnit)}</Td>
    </>
  );
}

export const STOCK_STATE_HEAD = [
  { key: 'physical', label: 'Physical', right: true, help: 'Everything on the shelf, including stock that may not be used.' },
  { key: 'blocked', label: 'Blocked', right: true, help: 'Expired, recalled or quarantined. Present but unavailable.' },
  { key: 'usable', label: 'Usable', right: true, help: 'Physical minus blocked.' },
  { key: 'reserved', label: 'Reserved', right: true, help: 'Usable stock already promised to an approved request.' },
  { key: 'available', label: 'Available', right: true, help: 'Usable minus reserved — what a new request can draw on.' },
];

/* --------------------------------------------------------------- callouts */

export function Callout({ tone = 'amber', icon: Icon = AlertTriangle, title, children }) {
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    sky: 'border-sky-200 bg-sky-50 text-sky-800',
  };
  return (
    <div className={`mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>
      {Icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0" /> : null}
      <div>
        {title ? <div className="font-semibold">{title}</div> : null}
        <div className={title ? 'mt-0.5 text-xs' : ''}>{children}</div>
      </div>
    </div>
  );
}

export const Badge = ({ map, value, label }) => <span className={badge(map, value)}>{label ?? value}</span>;

// Read-only screens must say WHY a control is absent rather than just not
// drawing it. A store manager who cannot see an approve button and is not told
// the reason files a bug; one who is told "only the owner approves this" does
// not.
export function OwnerOnlyNote({ what }) {
  return <p className="mt-2 text-xs text-slate-400">Only the company owner can {what}. You can see it here.</p>;
}

/* ------------------------------------------------------------------ who did it */

export const ROLE_LABEL = {
  CUSTOMER_OWNER: 'Owner',
  BRANCH_MANAGER: 'Branch manager',
  CASHIER: 'Cashier',
  POS_SUPER_ADMIN: 'ATC operator',
};

// The rendering half of the rule the API's actorOut() encodes. It lives here
// rather than in a page because the ledger and the request trail both draw it,
// and two copies is how "account removed" ends up meaning one thing on one
// screen and a blank on the other.
//
// Three facts, three different things on screen:
//
//   actor is null     nobody was signed in. What that MEANS is local — the
//                     till posting a sale, the planner raising an order — so
//                     the caller supplies the wording via `absent`.
//   role is null      resolveActors() found no row for the id. The account is
//                     gone; the id is still the truth about who acted.
//   role is set       a person.
//
// A blank for any of the three would read as a missing audit trail.
export function Actor({ actor, absent = 'no person recorded', className = '' }) {
  if (!actor) return <div className={`text-slate-400 ${className}`}>{absent}</div>;
  return (
    <div className={className}>
      <div className="text-slate-700">{actor.fullName || actor.email || actor.id}</div>
      {actor.role ? (
        <div className="text-slate-400">{ROLE_LABEL[actor.role] || actor.role}</div>
      ) : (
        <div className="text-slate-400">account removed</div>
      )}
    </div>
  );
}

// One line rather than two, for prose like "approved by Priya (Owner)".
export function ActorInline({ actor, absent = 'no person recorded' }) {
  if (!actor) return <span className="text-slate-400">{absent}</span>;
  return (
    <span>
      <span className="text-slate-700">{actor.fullName || actor.email || actor.id}</span>
      <span className="text-slate-400">{actor.role ? ` (${ROLE_LABEL[actor.role] || actor.role})` : ' (account removed)'}</span>
    </span>
  );
}

export { ErrorNote };
