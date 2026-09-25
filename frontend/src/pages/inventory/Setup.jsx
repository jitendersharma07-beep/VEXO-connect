// Locations, items and their packaging units, suppliers, settings, and who may
// do what where.
//
// Two things on this screen are dangerous in a way a form does not normally
// suggest, so both are spelled out where they are edited rather than in a wiki:
//
//   - An item's stock unit cannot be changed once anything has moved in it
//     (§2). The server refuses and names what is in the way; this screen shows
//     that refusal rather than disabling the field silently, because "you
//     cannot, and here is why" is the useful answer.
//   - A packaging factor applies to the NEXT line that uses it. Historical
//     lines froze their own factor at the time, so correcting "case" from 10 to
//     12 does not restate a single past receipt.

import { useMemo, useState } from 'react';
import {
  Boxes,
  Building2,
  KeyRound,
  Package,
  Plus,
  Settings2,
  Trash2,
  Truck,
  Warehouse,
} from 'lucide-react';
import { PageHeader, Modal } from '../../components/ui.jsx';
import {
  ActionButton,
  Badge,
  Callout,
  ErrorNote,
  Field,
  RefreshButton,
  Table,
  Td,
  Toolbar,
  useInventory,
  useLocations,
} from '../../components/inventory.jsx';
import api, { apiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import {
  fmtMilli,
  fmtQty,
  isInventoryOwner,
  ITEM_KIND_LABEL,
  LOCATION_KIND_LABEL,
  unitLabel,
} from '../../lib/inventory.js';

const KIND_STYLES = {
  WAREHOUSE: 'bg-pos-royal/10 text-pos-royal',
  STORE: 'bg-emerald-100 text-emerald-700',
  CENTRAL_KITCHEN: 'bg-amber-100 text-amber-700',
};

const ITEM_KIND_STYLES = {
  RAW: 'bg-slate-200 text-slate-600',
  SEMI_FINISHED: 'bg-sky-100 text-sky-700',
  FINISHED: 'bg-emerald-100 text-emerald-700',
  PACKAGING: 'bg-violet-100 text-violet-700',
};

const STORAGE_KINDS = ['AMBIENT', 'DRY', 'CHILLED', 'FROZEN', 'KITCHEN', 'BAR'];

const TABS = [
  { key: 'locations', label: 'Locations', icon: Warehouse },
  { key: 'items', label: 'Items and units', icon: Package },
  { key: 'suppliers', label: 'Suppliers', icon: Truck },
  { key: 'settings', label: 'Settings', icon: Settings2 },
];

/* ------------------------------------------------------------- locations */

function LocationForm({ open, onClose, onSaved, branches, locations }) {
  const [form, setForm] = useState({
    kind: 'WAREHOUSE',
    name: '',
    code: '',
    branchId: '',
    parentId: '',
    storageKind: 'AMBIENT',
    capacityBaseQty: '',
    isSaleSource: false,
  });
  const [error, setError] = useState('');

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  // A sublocation inherits its kind and its store from the room it stands in,
  // so the server ignores both fields. Hiding them here keeps the form honest
  // about which of its inputs actually decide anything.
  const isSub = Boolean(form.parentId);
  const parents = locations.filter((l) => !l.parentId);

  const submit = async () => {
    setError('');
    try {
      await api.post('/inventory/locations', {
        kind: form.kind,
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        branchId: form.branchId || null,
        parentId: form.parentId || null,
        storageKind: form.storageKind,
        capacityBaseQty: form.capacityBaseQty.trim() || null,
        isSaleSource: form.isSaleSource,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  return (
    <Modal open={open} title="Add a stock location" onClose={onClose}>
      <div className="space-y-3">
        <ErrorNote message={error} />

        <Field label="Inside another location" htmlFor="loc-parent">
          <select id="loc-parent" className="input" value={form.parentId} onChange={set('parentId')}>
            <option value="">It is a place in its own right</option>
            {parents.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </Field>

        {isSub ? (
          <Callout tone="slate" icon={null}>
            A sublocation takes its kind and its store from the location it sits inside, so a freezer
            cannot end up belonging to a different store than the room it stands in.
          </Callout>
        ) : (
          <>
            <Field label="What kind of place is it" htmlFor="loc-kind">
              <select id="loc-kind" className="input" value={form.kind} onChange={set('kind')}>
                <option value="WAREHOUSE">Warehouse</option>
                <option value="STORE">Store stock room</option>
                <option value="CENTRAL_KITCHEN">Central kitchen</option>
              </select>
            </Field>

            <Field label="Store it belongs to" htmlFor="loc-branch">
              <select id="loc-branch" className="input" value={form.branchId} onChange={set('branchId')}>
                <option value="">Not tied to a store</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              {form.kind === 'STORE' ? (
                <p className="mt-1 text-xs text-slate-400">A store stock room must name its store.</p>
              ) : null}
            </Field>
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="loc-name">
            <input id="loc-name" className="input" value={form.name} onChange={set('name')} placeholder="Main warehouse" />
          </Field>
          <Field label="Short code" htmlFor="loc-code">
            <input
              id="loc-code"
              className="input uppercase"
              value={form.code}
              onChange={set('code')}
              placeholder="WH-1"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="How it is stored" htmlFor="loc-storage">
            <select id="loc-storage" className="input" value={form.storageKind} onChange={set('storageKind')}>
              {STORAGE_KINDS.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Capacity in stock units" htmlFor="loc-cap">
            <input
              id="loc-cap"
              className="input"
              value={form.capacityBaseQty}
              onChange={set('capacityBaseQty')}
              placeholder="optional"
            />
            <p className="mt-1 text-xs text-slate-400">Caps what a replenishment suggestion may propose.</p>
          </Field>
        </div>

        {!isSub ? (
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={form.isSaleSource} onChange={set('isSaleSource')} />
            <span>
              Sales at this store come out of here
              <span className="block text-xs text-slate-400">
                Exactly one location per store may be this, held unique in the database so two cannot both
                claim a store's tills.
              </span>
            </span>
          </label>
        ) : null}

        <ActionButton className="btn-primary w-full" onClick={submit} disabled={!form.name.trim() || !form.code.trim()}>
          <Plus className="h-4 w-4" /> Create location
        </ActionButton>
      </div>
    </Modal>
  );
}

// Who may dispatch, receive and approve at one location. A cashier cannot
// appear here at all — the server refuses the grant, because a row that grants
// nothing is a row somebody later reads as access.
function AccessPanel({ location, onClose }) {
  const { data, error, loading, reload } = useInventory(`/inventory/locations/${location.id}/access`, {
    skip: !location,
  });
  const staff = useInventory('/users');
  const [userId, setUserId] = useState('');
  const [flags, setFlags] = useState({ canDispatch: false, canReceive: false, canApprove: false });
  const [actionError, setActionError] = useState('');

  const grants = data?.grants ?? [];
  const granted = new Set(grants.map((g) => g.user?.id));
  const candidates = (staff.data?.users ?? []).filter(
    (u) => !['CASHIER', 'POS_SUPER_ADMIN'].includes(u.role) && !granted.has(u.id),
  );

  const save = async () => {
    setActionError('');
    try {
      await api.put(`/inventory/locations/${location.id}/access`, { userId, ...flags });
      setUserId('');
      setFlags({ canDispatch: false, canReceive: false, canApprove: false });
      await reload();
    } catch (err) {
      setActionError(apiError(err));
      throw err;
    }
  };

  const revoke = async (id) => {
    setActionError('');
    try {
      await api.delete(`/inventory/locations/${location.id}/access/${id}`);
      await reload();
    } catch (err) {
      setActionError(apiError(err));
      throw err;
    }
  };

  const toggle = (k) => (e) => setFlags((f) => ({ ...f, [k]: e.target.checked }));

  return (
    <Modal open title={`Who may work at ${location.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <ErrorNote message={actionError || error} />

        <Callout tone="slate" icon={KeyRound}>
          A grant widens reach, it does not widen role. A manager granted dispatch here can dispatch
          here; nothing on this panel can let anyone approve a stock count or release a recalled batch,
          because those are the owner's and are checked on the server every time.
        </Callout>

        {loading && !data ? <div className="py-4 text-center text-sm text-slate-400">Loading…</div> : null}

        <Table
          head={['Person', 'Role', 'Dispatch', 'Receive', 'Approve', '']}
          empty="Nobody has been granted access here"
          emptyNote="People still reach this location through their own store if it is theirs."
        >
          {grants.map((g) => (
            <tr key={g.id}>
              <Td>
                <div className="font-semibold text-pos-ink">{g.user?.fullName}</div>
                <div className="text-xs text-slate-400">{g.user?.email}</div>
              </Td>
              <Td className="text-xs text-slate-600">{g.user?.role}</Td>
              <Td className="text-xs">{g.canDispatch ? 'yes' : '—'}</Td>
              <Td className="text-xs">{g.canReceive ? 'yes' : '—'}</Td>
              <Td className="text-xs">{g.canApprove ? 'yes' : '—'}</Td>
              <Td>
                <ActionButton
                  className="btn-ghost text-xs text-red-600"
                  confirm={`Remove ${g.user?.fullName}'s access to ${location.name}?`}
                  onClick={() => revoke(g.user?.id)}
                >
                  Revoke
                </ActionButton>
              </Td>
            </tr>
          ))}
        </Table>

        <div className="rounded-lg border border-slate-200 p-3">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Grant access</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Person" htmlFor="grant-user">
              <select id="grant-user" className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose somebody</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} · {u.role}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-col justify-center gap-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={flags.canDispatch} onChange={toggle('canDispatch')} /> May dispatch
                from here
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={flags.canReceive} onChange={toggle('canReceive')} /> May receive into
                here
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={flags.canApprove} onChange={toggle('canApprove')} /> May approve
                requests here
              </label>
            </div>
          </div>
          <ActionButton className="btn-primary mt-3" onClick={save} disabled={!userId}>
            Save grant
          </ActionButton>
        </div>
      </div>
    </Modal>
  );
}

function Locations({ owner }) {
  const { locations, error, loading, reload } = useLocations();
  const branches = useInventory('/branches');
  const [adding, setAdding] = useState(false);
  const [access, setAccess] = useState(null);

  // Sublocations are listed under the place they are inside, so the tree reads
  // the way the building does.
  const ordered = useMemo(() => {
    const roots = locations.filter((l) => !l.parentId);
    const kids = new Map();
    locations.filter((l) => l.parentId).forEach((l) => {
      if (!kids.has(l.parentId)) kids.set(l.parentId, []);
      kids.get(l.parentId).push(l);
    });
    return roots.flatMap((r) => [{ ...r, depth: 0 }, ...(kids.get(r.id) ?? []).map((k) => ({ ...k, depth: 1 }))]);
  }, [locations]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Warehouses, store stock rooms and central kitchens. Stock exists at a location, never at a
          company, which is what makes "how much have we got" a question with a place in it.
        </p>
        <div className="flex gap-2">
          <RefreshButton loading={loading} onClick={reload} />
          {owner ? (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add location
            </button>
          ) : null}
        </div>
      </div>

      <ErrorNote message={error} />

      <Table
        head={['Location', 'Kind', 'Stored', { key: 'c', label: 'Capacity', right: true }, 'Sales source', 'Status', '']}
        empty="No stock locations yet"
        emptyNote="Nothing can be received, held or moved until there is somewhere to hold it."
      >
        {ordered.map((l) => (
          <tr key={l.id}>
            <Td>
              <div className={l.depth ? 'pl-5 text-sm text-slate-600' : 'font-semibold text-pos-ink'}>
                {l.depth ? '↳ ' : ''}
                {l.name}
              </div>
              <div className={`text-xs text-slate-400 ${l.depth ? 'pl-5' : ''}`}>{l.code}</div>
            </Td>
            <Td>
              <Badge map={KIND_STYLES} value={l.kind} label={LOCATION_KIND_LABEL[l.kind] || l.kind} />
            </Td>
            <Td className="text-xs text-slate-600">
              {l.storageKind ? l.storageKind.charAt(0) + l.storageKind.slice(1).toLowerCase() : '—'}
            </Td>
            <Td right className="text-xs tabular-nums text-slate-500">
              {l.capacityBaseQty ? fmtQty(l.capacityBaseQty) : '—'}
            </Td>
            <Td className="text-xs">
              {l.saleSourceBranchId ? (
                <span className="badge bg-emerald-100 text-emerald-700">sales come from here</span>
              ) : (
                <span className="text-slate-300">no</span>
              )}
            </Td>
            <Td className="text-xs text-slate-600">{l.status}</Td>
            <Td>
              {owner ? (
                <button type="button" className="btn-ghost text-xs" onClick={() => setAccess(l)}>
                  <KeyRound className="h-3.5 w-3.5" /> Access
                </button>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>

      <LocationForm
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={reload}
        branches={branches.data?.branches ?? []}
        locations={locations}
      />
      {access ? <AccessPanel location={access} onClose={() => setAccess(null)} /> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- items */

function ItemForm({ open, onClose, onSaved }) {
  const [form, setForm] = useState({
    kind: 'RAW',
    name: '',
    sku: '',
    baseUnit: 'G',
    trackBatches: true,
    trackExpiry: true,
    variableWeight: false,
    weightUnit: 'G',
    minShelfLifeDaysAtReceipt: '',
    openedShelfLifeHours: '',
  });
  const [error, setError] = useState('');

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const submit = async () => {
    setError('');
    try {
      await api.post('/inventory/items', {
        kind: form.kind,
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        baseUnit: form.baseUnit,
        trackBatches: form.trackBatches,
        trackExpiry: form.trackExpiry,
        variableWeight: form.variableWeight,
        weightUnit: form.variableWeight ? form.weightUnit : null,
        minShelfLifeDaysAtReceipt: form.minShelfLifeDaysAtReceipt
          ? Number(form.minShelfLifeDaysAtReceipt)
          : null,
        openedShelfLifeHours: form.openedShelfLifeHours ? Number(form.openedShelfLifeHours) : null,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  return (
    <Modal open={open} title="Add an item" onClose={onClose}>
      <div className="space-y-3">
        <ErrorNote message={error} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="item-name">
            <input id="item-name" className="input" value={form.name} onChange={set('name')} placeholder="Refined flour" />
          </Field>
          <Field label="Code" htmlFor="item-sku">
            <input id="item-sku" className="input" value={form.sku} onChange={set('sku')} placeholder="optional" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What it is" htmlFor="item-kind">
            <select id="item-kind" className="input" value={form.kind} onChange={set('kind')}>
              {Object.keys(ITEM_KIND_LABEL).map((k) => (
                <option key={k} value={k}>
                  {ITEM_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Counted in" htmlFor="item-unit">
            <select id="item-unit" className="input" value={form.baseUnit} onChange={set('baseUnit')}>
              <option value="G">Grams — weight</option>
              <option value="ML">Millilitres — volume</option>
              <option value="PCS">Pieces — count</option>
            </select>
          </Field>
        </div>

        <Callout tone="slate" icon={null}>
          The stock unit is the smallest one, and it is permanent in practice: once anything has moved in
          it, changing it would restate every past quantity, so the server refuses. Kilograms and litres
          are entered as packaging on top of this, never as a second stock unit — a kilogram is not a
          litre and nothing here will treat them as interchangeable.
        </Callout>

        <div className="space-y-1 text-sm text-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.trackBatches} onChange={set('trackBatches')} /> Track batches
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.trackExpiry}
              onChange={set('trackExpiry')}
              disabled={!form.trackBatches}
            />{' '}
            Track expiry
            {!form.trackBatches ? (
              <span className="text-xs text-slate-400">— an expiry date belongs to a batch</span>
            ) : null}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.variableWeight}
              onChange={set('variableWeight')}
              disabled={form.baseUnit !== 'PCS'}
            />{' '}
            Sold by the piece, weighed individually
            {form.baseUnit !== 'PCS' ? (
              <span className="text-xs text-slate-400">— only for items counted in pieces</span>
            ) : null}
          </label>
        </div>

        {form.variableWeight ? (
          <Field label="Weighed in" htmlFor="item-wunit">
            <select id="item-wunit" className="input" value={form.weightUnit} onChange={set('weightUnit')}>
              <option value="G">Grams</option>
              <option value="ML">Millilitres</option>
            </select>
          </Field>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Least shelf life on arrival (days)" htmlFor="item-shelf">
            <input
              id="item-shelf"
              className="input"
              value={form.minShelfLifeDaysAtReceipt}
              onChange={set('minShelfLifeDaysAtReceipt')}
              placeholder="optional"
            />
            <p className="mt-1 text-xs text-slate-400">A delivery with less than this is refused at receipt.</p>
          </Field>
          <Field label="Once opened, good for (hours)" htmlFor="item-opened">
            <input
              id="item-opened"
              className="input"
              value={form.openedShelfLifeHours}
              onChange={set('openedShelfLifeHours')}
              placeholder="optional"
            />
            <p className="mt-1 text-xs text-slate-400">Starts when the container is recorded as opened.</p>
          </Field>
        </div>

        <ActionButton className="btn-primary w-full" onClick={submit} disabled={!form.name.trim()}>
          <Plus className="h-4 w-4" /> Create item
        </ActionButton>
      </div>
    </Modal>
  );
}

function UnitsPanel({ item, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [error, setError] = useState('');

  const add = async () => {
    setError('');
    try {
      await api.post(`/inventory/items/${item.id}/units`, {
        name: name.trim(),
        quantityInBaseUnit: qty.trim(),
      });
      setName('');
      setQty('');
      await onSaved();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  const remove = async (unitId) => {
    setError('');
    try {
      await api.delete(`/inventory/items/${item.id}/units/${unitId}`);
      await onSaved();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  return (
    <Modal open title={`How ${item.name} is packed`} onClose={onClose}>
      <div className="space-y-4">
        <ErrorNote message={error} />

        <Callout tone="slate" icon={null}>
          Stock is held in {unitLabel(item.baseUnit)}. These are the other ways people say the same
          quantity — a case, a tray, a 5 kg bag. Changing a factor affects the next line that uses it and
          no past one: every receipt, request and transfer stored the factor it was created with, so a
          correction here never rewrites what a past delivery contained.
        </Callout>

        <Table head={['Unit', { key: 'f', label: `One of these is`, right: true }, '']} empty="No packaging defined">
          {(item.units ?? []).map((u) => (
            <tr key={u.id}>
              <Td className="font-semibold text-pos-ink">{u.name}</Td>
              <Td right className="tabular-nums">
                {fmtMilli(u.factorMilli, item.baseUnit)}
              </Td>
              <Td>
                <ActionButton
                  className="btn-ghost text-xs text-red-600"
                  confirm={`Remove "${u.name}" from ${item.name}? Past lines keep the factor they used.`}
                  onClick={() => remove(u.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </ActionButton>
              </Td>
            </tr>
          ))}
        </Table>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Unit name" htmlFor="unit-name">
            <input id="unit-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="case" />
          </Field>
          <Field label={`How many ${unitLabel(item.baseUnit)} in one`} htmlFor="unit-qty">
            <input id="unit-qty" className="input" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="5000" />
          </Field>
        </div>
        <p className="text-xs text-slate-400">
          kg, g, litre, ml, pcs and their spellings are understood already and cannot be redefined here —
          letting someone declare a kilogram to be something other than a kilogram would corrupt every
          past line that read kg.
        </p>

        <ActionButton className="btn-primary w-full" onClick={add} disabled={!name.trim() || !qty.trim()}>
          <Plus className="h-4 w-4" /> Add packaging
        </ActionButton>
      </div>
    </Modal>
  );
}

function Items({ owner }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const params = useMemo(() => ({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) }), [q, kind]);
  const { data, error, loading, reload } = useInventory('/inventory/items', { params });
  const [adding, setAdding] = useState(false);
  const [units, setUnits] = useState(null);

  const items = data?.items ?? [];
  const open = units ? items.find((i) => i.id === units) : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Everything stock can be held in. An item carries one stock unit and as many packaging units as
          the business actually says out loud.
        </p>
        <div className="flex gap-2">
          <RefreshButton loading={loading} onClick={reload} />
          {owner ? (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add item
            </button>
          ) : null}
        </div>
      </div>

      <Toolbar>
        <Field label="Search" htmlFor="item-q">
          <input id="item-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name contains…" />
        </Field>
        <Field label="Kind" htmlFor="item-kind-f">
          <select id="item-kind-f" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any kind</option>
            {Object.keys(ITEM_KIND_LABEL).map((k) => (
              <option key={k} value={k}>
                {ITEM_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
      </Toolbar>

      <ErrorNote message={error} />

      <Table
        head={['Item', 'Kind', 'Stock unit', 'Packaging', 'Batches', 'Shelf life', 'Status', '']}
        empty="No items"
        emptyNote="An item is the thing stock is counted in — flour, oil, a cup lid."
      >
        {items.map((i) => (
          <tr key={i.id}>
            <Td>
              <div className="font-semibold text-pos-ink">{i.name}</div>
              {i.sku ? <div className="text-xs text-slate-400">{i.sku}</div> : null}
            </Td>
            <Td>
              <Badge map={ITEM_KIND_STYLES} value={i.kind} label={ITEM_KIND_LABEL[i.kind] || i.kind} />
            </Td>
            <Td className="text-xs text-slate-600">
              {unitLabel(i.baseUnit)}
              {i.variableWeight ? (
                <div className="text-slate-400">weighed in {unitLabel(i.weightUnit)}</div>
              ) : null}
            </Td>
            <Td className="text-xs text-slate-600">
              {(i.units ?? []).length ? i.units.map((u) => u.name).join(', ') : <span className="text-slate-300">—</span>}
            </Td>
            <Td className="text-xs">
              {i.trackBatches ? (
                <span className="text-slate-600">{i.trackExpiry ? 'with expiry' : 'no expiry'}</span>
              ) : (
                <span className="text-slate-300">not tracked</span>
              )}
            </Td>
            <Td className="text-xs text-slate-600">
              {i.minShelfLifeDaysAtReceipt ? <div>{i.minShelfLifeDaysAtReceipt}d on arrival</div> : null}
              {i.openedShelfLifeHours ? <div>{i.openedShelfLifeHours}h once opened</div> : null}
              {!i.minShelfLifeDaysAtReceipt && !i.openedShelfLifeHours ? <span className="text-slate-300">—</span> : null}
            </Td>
            <Td className="text-xs text-slate-600">{i.status}</Td>
            <Td>
              {owner ? (
                <button type="button" className="btn-ghost text-xs" onClick={() => setUnits(i.id)}>
                  <Boxes className="h-3.5 w-3.5" /> Packaging
                </button>
              ) : null}
            </Td>
          </tr>
        ))}
      </Table>

      <ItemForm open={adding} onClose={() => setAdding(false)} onSaved={reload} />
      {open ? <UnitsPanel item={open} onClose={() => setUnits(null)} onSaved={reload} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------- suppliers */

function SupplierForm({ open, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', code: '', gstin: '', contactName: '', phone: '', email: '', paymentTermsDays: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setError('');
    try {
      await api.post('/inventory/suppliers', {
        name: form.name.trim(),
        code: form.code.trim() || null,
        gstin: form.gstin.trim().toUpperCase() || null,
        contactName: form.contactName.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        paymentTermsDays: form.paymentTermsDays ? Number(form.paymentTermsDays) : null,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(apiError(err));
      throw err;
    }
  };

  return (
    <Modal open={open} title="Add a supplier" onClose={onClose}>
      <div className="space-y-3">
        <ErrorNote message={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="sup-name">
            <input id="sup-name" className="input" value={form.name} onChange={set('name')} />
          </Field>
          <Field label="Code" htmlFor="sup-code">
            <input id="sup-code" className="input" value={form.code} onChange={set('code')} placeholder="optional" />
          </Field>
        </div>
        <Field label="GSTIN" htmlFor="sup-gstin">
          <input id="sup-gstin" className="input uppercase" value={form.gstin} onChange={set('gstin')} placeholder="optional" />
          <p className="mt-1 text-xs text-slate-400">Checked for shape, not with the department.</p>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Contact" htmlFor="sup-contact">
            <input id="sup-contact" className="input" value={form.contactName} onChange={set('contactName')} />
          </Field>
          <Field label="Phone" htmlFor="sup-phone">
            <input id="sup-phone" className="input" value={form.phone} onChange={set('phone')} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="sup-email">
            <input id="sup-email" className="input" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Pays in (days)" htmlFor="sup-terms">
            <input id="sup-terms" className="input" value={form.paymentTermsDays} onChange={set('paymentTermsDays')} />
          </Field>
        </div>
        <ActionButton className="btn-primary w-full" onClick={submit} disabled={!form.name.trim()}>
          <Plus className="h-4 w-4" /> Create supplier
        </ActionButton>
      </div>
    </Modal>
  );
}

function Suppliers({ owner }) {
  const { data, error, loading, reload } = useInventory('/inventory/suppliers');
  const [adding, setAdding] = useState(false);
  const suppliers = data?.suppliers ?? [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">Who goods are bought from, and what is owed to them.</p>
        <div className="flex gap-2">
          <RefreshButton loading={loading} onClick={reload} />
          {owner ? (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add supplier
            </button>
          ) : null}
        </div>
      </div>

      <ErrorNote message={error} />

      <Table head={['Supplier', 'GSTIN', 'Contact', 'Terms', 'Status']} empty="No suppliers">
        {suppliers.map((s) => (
          <tr key={s.id}>
            <Td>
              <div className="font-semibold text-pos-ink">{s.name}</div>
              {s.code ? <div className="text-xs text-slate-400">{s.code}</div> : null}
            </Td>
            <Td className="text-xs text-slate-600">{s.gstin || '—'}</Td>
            <Td className="text-xs text-slate-600">
              {s.contactName ? <div>{s.contactName}</div> : null}
              {s.phone ? <div className="text-slate-400">{s.phone}</div> : null}
              {!s.contactName && !s.phone ? <span className="text-slate-300">—</span> : null}
            </Td>
            <Td className="text-xs text-slate-600">
              {s.paymentTermsDays === null || s.paymentTermsDays === undefined ? '—' : `${s.paymentTermsDays} days`}
            </Td>
            <Td className="text-xs text-slate-600">{s.status}</Td>
          </tr>
        ))}
      </Table>

      <SupplierForm open={adding} onClose={() => setAdding(false)} onSaved={reload} />
    </div>
  );
}

/* -------------------------------------------------------------- settings */

function SettingsPanel({ owner }) {
  const { data, error, loading, reload } = useInventory('/inventory/settings');
  const [saveError, setSaveError] = useState('');
  const [draft, setDraft] = useState(null);

  const s = draft ?? data?.settings;

  const save = async () => {
    setSaveError('');
    try {
      await api.put('/inventory/settings', {
        purchaseTaxIsCost: s.purchaseTaxIsCost,
        staleCostDays: Number(s.staleCostDays),
      });
      setDraft(null);
      await reload();
    } catch (err) {
      setSaveError(apiError(err));
      throw err;
    }
  };

  if (loading && !data) return <div className="py-6 text-center text-sm text-slate-400">Loading…</div>;
  if (!s) return <ErrorNote message={error || 'Could not load settings'} />;

  return (
    <div className="max-w-2xl space-y-4">
      <ErrorNote message={saveError || error} />

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={s.purchaseTaxIsCost}
            disabled={!owner}
            onChange={(e) => setDraft({ ...s, purchaseTaxIsCost: e.target.checked })}
          />
          <span className="text-sm">
            <span className="font-semibold text-pos-ink">Purchase tax is part of what stock cost us</span>
            <span className="mt-1 block text-xs text-slate-500">
              A business that reclaims its input tax does not carry that tax as stock cost; one that
              cannot, does. This is the whole difference, and it changes every valuation from here on —
              it does not restate a single past receipt, because each one stored the figure it was taken
              in at.
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <Field label="Treat a cost as stale after (days)" htmlFor="set-stale">
          <input
            id="set-stale"
            className="input max-w-[10rem]"
            value={s.staleCostDays}
            disabled={!owner}
            onChange={(e) => setDraft({ ...s, staleCostDays: e.target.value })}
          />
        </Field>
        <p className="mt-2 text-xs text-slate-500">
          A cost older than this is still used — there is nothing better — but it is labelled ESTIMATED
          rather than ACTUAL wherever it appears, so a margin built on a year-old price is not presented
          with the same confidence as one built on last week's.
        </p>
      </div>

      {owner ? (
        <ActionButton className="btn-primary" onClick={save} disabled={!draft}>
          Save settings
        </ActionButton>
      ) : (
        <p className="text-xs text-slate-400">
          Only the company owner changes these. They are shown because knowing whether tax is counted as
          stock cost is needed to read any valuation on this system.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function InventorySetup() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const [tab, setTab] = useState('locations');

  return (
    <div>
      <PageHeader
        title="Inventory setup"
        subtitle="The places, things, packs and suppliers everything else is recorded against"
      />

      {!owner ? (
        <Callout tone="slate" icon={Building2} title="You can see this, and you cannot change it">
          Reference data is the owner's to set, because changing a stock unit or a pack size after stock
          has moved is how historical quantities quietly stop meaning what they said. Every control below
          is hidden for that reason, and the server refuses the same requests regardless of what this
          page draws.
        </Callout>
      ) : null}

      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition ${
                tab === t.key
                  ? 'border-pos-royal text-pos-royal'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'locations' ? <Locations owner={owner} /> : null}
      {tab === 'items' ? <Items owner={owner} /> : null}
      {tab === 'suppliers' ? <Suppliers owner={owner} /> : null}
      {tab === 'settings' ? <SettingsPanel owner={owner} /> : null}
    </div>
  );
}
