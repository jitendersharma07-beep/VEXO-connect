// LANE foundation — the store registry (spec B§3, B§5.1). This page is where
// a store is MAPPED: to the GST registration it bills under (which implies
// the legal entity), to a region, to its invoice series and FSSAI licence.
// The registration is authoritative for tax — never the typed address state.
// Store code and VEXO Store ID are minted once and never editable here.

import { useCallback, useEffect, useState } from 'react';
import { Store, Plus, MapPin } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { fmtDate } from '../lib/pos.js';
import {
  PageHeader,
  StatusBadge,
  DemoBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

// '' from a cleared input becomes null so the server clears the column; an
// untouched optional field is omitted so the server leaves it alone.
const orNull = (v) => (v && v.trim() !== '' ? v.trim() : null);

function BranchForm({ onDone }) {
  const [form, setForm] = useState({ name: '', code: '', addressLine: '', city: '', state: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
      await api.post('/branches', payload);
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="b-name">Branch name</label>
        <input id="b-name" className="input" value={form.name} onChange={set('name')} required minLength={2} placeholder="Main Street Outlet" />
      </div>
      <div>
        <label className="label" htmlFor="b-code">Branch code (unique in your company)</label>
        <input
          id="b-code"
          className="input uppercase"
          value={form.code}
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
          required
          pattern="[A-Za-z0-9-]{2,12}"
          placeholder="MAIN-01"
        />
      </div>
      <div>
        <label className="label" htmlFor="b-address">Address</label>
        <input id="b-address" className="input" value={form.addressLine} onChange={set('addressLine')} placeholder="Street address (optional)" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="b-city">City</label>
          <input id="b-city" className="input" value={form.city} onChange={set('city')} />
        </div>
        <div>
          <label className="label" htmlFor="b-state">State</label>
          <input id="b-state" className="input" value={form.state} onChange={set('state')} />
        </div>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create branch'}
      </button>
    </form>
  );
}

function BranchEditForm({ branch, entities, regs, regions, onDone }) {
  const [form, setForm] = useState({
    name: branch.name ?? '',
    addressLine: branch.addressLine ?? '',
    city: branch.city ?? '',
    state: branch.state ?? '',
    pincode: branch.pincode ?? '',
    gstRegistrationId: branch.gstRegistrationId ?? '',
    legalEntityId: branch.legalEntityId ?? '',
    regionId: branch.regionId ?? '',
    invoicePrefix: branch.invoicePrefix ?? '',
    fssaiLicenseNo: branch.fssaiLicenseNo ?? '',
    fssaiValidUpto: branch.fssaiValidUpto ? String(branch.fssaiValidUpto).slice(0, 10) : '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const activeRegs = regs.filter((r) => r.status === 'ACTIVE' || r.id === branch.gstRegistrationId);
  const activeEntities = entities.filter((en) => en.status === 'ACTIVE' || en.id === branch.legalEntityId);
  const activeRegions = regions.filter((rg) => rg.status === 'ACTIVE' || rg.id === branch.regionId);

  const chosenReg = activeRegs.find((r) => r.id === form.gstRegistrationId) || null;

  // Choosing a registration decides the entity — the server enforces the pair,
  // the form just stops offering a contradiction.
  const chooseReg = (e) => {
    const id = e.target.value;
    const reg = activeRegs.find((r) => r.id === id);
    setForm((f) => ({ ...f, gstRegistrationId: id, legalEntityId: reg ? reg.legalEntityId : f.legalEntityId }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.patch(`/branches/${branch.id}`, {
        name: form.name,
        addressLine: orNull(form.addressLine),
        city: orNull(form.city),
        state: orNull(form.state),
        pincode: orNull(form.pincode),
        gstRegistrationId: form.gstRegistrationId || null,
        legalEntityId: form.legalEntityId || null,
        regionId: form.regionId || null,
        invoicePrefix: orNull(form.invoicePrefix),
        fssaiLicenseNo: orNull(form.fssaiLicenseNo),
        fssaiValidUpto: form.fssaiValidUpto || null,
      });
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-lg bg-slate-50 px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Store — fixed</div>
        <div className="font-mono text-sm font-bold text-pos-ink">{branch.publicId ?? branch.code}</div>
        <div className="text-xs text-slate-500">code {branch.code} — neither ever changes; bills already issued keep what they were printed with</div>
      </div>

      <div>
        <label className="label" htmlFor="be-name">Branch name</label>
        <input id="be-name" className="input" value={form.name} onChange={set('name')} required minLength={2} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label" htmlFor="be-address">Address</label>
          <input id="be-address" className="input" value={form.addressLine} onChange={set('addressLine')} />
        </div>
        <div>
          <label className="label" htmlFor="be-city">City</label>
          <input id="be-city" className="input" value={form.city} onChange={set('city')} />
        </div>
        <div>
          <label className="label" htmlFor="be-state">State (address only)</label>
          <input id="be-state" className="input" value={form.state} onChange={set('state')} />
        </div>
        <div>
          <label className="label" htmlFor="be-pin">PIN code</label>
          <input id="be-pin" className="input" value={form.pincode} onChange={set('pincode')} maxLength={6} inputMode="numeric" />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="be-gst">Bills under GST registration</label>
        <select id="be-gst" className="input" value={form.gstRegistrationId} onChange={chooseReg}>
          <option value="">— none (unregistered) —</option>
          {activeRegs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.gstin} · {r.stateName} — {r.legalEntityName}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">
          The registration decides the GSTIN and state on every bill — never the address above.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="be-entity">Legal entity</label>
        {chosenReg ? (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            {chosenReg.legalEntityName} <span className="text-xs text-slate-400">— set by the registration</span>
          </div>
        ) : (
          <select id="be-entity" className="input" value={form.legalEntityId} onChange={set('legalEntityId')}>
            <option value="">— none —</option>
            {activeEntities.map((en) => (
              <option key={en.id} value={en.id}>{en.legalName}</option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="be-region">Region</label>
          <select id="be-region" className="input" value={form.regionId} onChange={set('regionId')}>
            <option value="">— none —</option>
            {activeRegions.map((rg) => (
              <option key={rg.id} value={rg.id}>{rg.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="be-prefix">Invoice prefix</label>
          <input
            id="be-prefix"
            className="input uppercase font-mono"
            value={form.invoicePrefix}
            onChange={(e) => setForm((f) => ({ ...f, invoicePrefix: e.target.value.toUpperCase() }))}
            maxLength={12}
            placeholder={branch.code}
          />
          <p className="mt-1 text-xs text-slate-400">
            Blank uses the store code. Changing it relabels the running series — numbering never restarts mid-year.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="be-fssai">FSSAI licence no.</label>
          <input
            id="be-fssai"
            className="input font-mono"
            value={form.fssaiLicenseNo}
            onChange={set('fssaiLicenseNo')}
            maxLength={14}
            inputMode="numeric"
            placeholder="14 digits"
          />
        </div>
        <div>
          <label className="label" htmlFor="be-fssai-to">FSSAI valid up to</label>
          <input id="be-fssai-to" type="date" className="input" value={form.fssaiValidUpto} onChange={set('fssaiValidUpto')} />
        </div>
      </div>

      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

export default function Branches() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const [data, setData] = useState(null);
  const [entities, setEntities] = useState([]);
  const [regs, setRegs] = useState([]);
  const [regions, setRegions] = useState([]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {kind:'create'|'edit', row?}

  const canManage = can('org.store.write');
  // The mapping selects need the org registries; a role that may edit stores
  // does not necessarily read all three, so each is fetched only if held and
  // an absent list just narrows the form.
  const wantEntities = canManage && can('org.legalEntity.read');
  const wantRegs = canManage && can('org.gst.read');
  const wantRegions = canManage && can('org.region.read');

  const load = useCallback(async () => {
    try {
      const [b, en, gr, rg] = await Promise.all([
        api.get('/branches'),
        wantEntities ? api.get('/legal-entities') : Promise.resolve(null),
        wantRegs ? api.get('/gst-registrations') : Promise.resolve(null),
        wantRegions ? api.get('/regions') : Promise.resolve(null),
      ]);
      setData(b.data);
      setEntities(en ? en.data.legalEntities : []);
      setRegs(gr ? gr.data.gstRegistrations : []);
      setRegions(rg ? rg.data.regions : []);
    } catch (err) {
      setError(apiError(err, 'Could not load branches'));
    }
  }, [wantEntities, wantRegs, wantRegions]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleStatus = async (branch) => {
    try {
      await api.patch(`/branches/${branch.id}`, {
        status: branch.status === 'ACTIVE' ? 'CLOSED' : 'ACTIVE',
      });
      await load();
    } catch (err) {
      setError(apiError(err));
    }
  };

  const closeModal = () => setModal(null);
  const done = () => {
    closeModal();
    load();
  };

  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <FullScreenSpinner />;

  const activeCount = data.branches.filter((b) => b.status === 'ACTIVE').length;

  return (
    <div>
      <PageHeader
        title="Branches"
        subtitle={
          user.role === 'BRANCH_MANAGER' || user.role === 'CASHIER'
            ? 'Your account is scoped to a single branch.'
            : // No licence on file reaches the client as a 0, and "0 allowed by
              // your licence" asserts a limit that no licence ever set. The
              // write path already refuses honestly — "this company has no
              // licence; VEXO must issue one first" — so say the same thing here
              // rather than inventing a number to blame it on.
              data.branchLimit > 0
              ? `${activeCount} active of ${data.branchLimit} allowed by your licence`
              : `${activeCount} active — no licence on file, so VEXO must issue one before a branch can be added`
        }
        actions={
          canManage ? (
            <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'create' })}>
              <Plus className="h-4 w-4" /> Add branch
            </button>
          ) : null
        }
      />

      <ErrorNote message={error} />

      {data.branches.length === 0 ? (
        <EmptyState
          icon={Store}
          title="No branches yet"
          note="Create your first branch to start setting up VEXO Connect."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.branches.map((b) => (
            <div key={b.id} className="card p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-base font-bold text-pos-ink">{b.name}</span>
                    {b.isDemo ? <DemoBadge /> : null}
                  </div>
                  <div className="mt-0.5 text-xs font-semibold text-slate-400">
                    {b.code}
                    {b.publicId ? <span className="font-mono font-normal"> · {b.publicId}</span> : null}
                  </div>
                </div>
                <StatusBadge status={b.status} />
              </div>

              {(b.addressLine || b.city) && (
                <div className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {[b.addressLine, b.city, b.state].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}

              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">GST</dt>
                  <dd className="text-right font-mono text-slate-600">
                    {b.gstin ? `${b.gstin}${b.gstStateName ? ` · ${b.gstStateName}` : ''}` : '—'}
                  </dd>
                </div>
                {b.legalEntityName ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-400">Entity</dt>
                    <dd className="text-right text-slate-600">{b.legalEntityName}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Series</dt>
                  <dd className="text-right font-mono text-slate-600">{b.effectiveInvoicePrefix ?? b.code}</dd>
                </div>
                {b.regionName ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-400">Region</dt>
                    <dd className="text-right text-slate-600">{b.regionName}</dd>
                  </div>
                ) : null}
                {b.fssaiLicenseNo ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-400">FSSAI</dt>
                    <dd className="text-right font-mono text-slate-600">
                      {b.fssaiLicenseNo}
                      {b.fssaiValidUpto ? ` · till ${fmtDate(b.fssaiValidUpto)}` : ''}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {canManage ? (
                <div className="mt-4 flex gap-4 border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    className="text-xs font-semibold text-pos-royal hover:underline"
                    onClick={() => setModal({ kind: 'edit', row: b })}
                  >
                    Edit details
                  </button>
                  <button type="button" className="text-xs font-semibold text-slate-500 hover:underline" onClick={() => toggleStatus(b)}>
                    {b.status === 'ACTIVE' ? 'Mark closed' : 'Reopen branch'}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Modal open={modal?.kind === 'create'} title="Add branch" onClose={closeModal}>
        <BranchForm onDone={done} />
      </Modal>
      <Modal open={modal?.kind === 'edit'} title="Edit store details" onClose={closeModal} wide>
        {modal?.kind === 'edit' ? (
          <BranchEditForm
            branch={modal.row}
            entities={entities}
            regs={regs}
            regions={regions}
            onDone={done}
          />
        ) : null}
      </Modal>
    </div>
  );
}
