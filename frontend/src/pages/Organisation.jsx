// LANE foundation — legal entities and GST registrations (spec B§3, B§5.1).
// Stores are MAPPED to a registration on the Branches page; this screen owns
// the registry itself. No delete anywhere: these rows are the tax record, and
// archive already refuses while anything live points at a row.

import { useCallback, useEffect, useState } from 'react';
import { Landmark, Plus, ReceiptText } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { usePermissions } from '../lib/permissions.jsx';
import {
  PageHeader,
  StatusBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

// '' from a cleared input becomes null so the server clears the column; an
// untouched optional field is omitted so the server leaves it alone.
const orNull = (v) => (v && v.trim() !== '' ? v.trim() : null);
const dropEmpty = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '' && v !== null));

function EntityForm({ entity, onDone }) {
  const [form, setForm] = useState({
    legalName: entity?.legalName ?? '',
    tradeName: entity?.tradeName ?? '',
    pan: entity?.pan ?? '',
    cin: entity?.cin ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, upper = false) => (e) =>
    setForm((f) => ({ ...f, [k]: upper ? e.target.value.toUpperCase() : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (entity) {
        await api.patch(`/legal-entities/${entity.id}`, {
          legalName: form.legalName,
          tradeName: orNull(form.tradeName),
          pan: orNull(form.pan),
          cin: orNull(form.cin),
        });
      } else {
        await api.post('/legal-entities', dropEmpty(form));
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
      <div>
        <label className="label" htmlFor="le-name">Registered legal name</label>
        <input id="le-name" className="input" value={form.legalName} onChange={set('legalName')} required minLength={2} placeholder="Brew Street Hospitality Pvt. Ltd." />
      </div>
      <div>
        <label className="label" htmlFor="le-trade">Trade name (optional)</label>
        <input id="le-trade" className="input" value={form.tradeName} onChange={set('tradeName')} placeholder="Brew Street" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="le-pan">PAN (optional)</label>
          <input id="le-pan" className="input uppercase font-mono" value={form.pan} onChange={set('pan', true)} maxLength={10} placeholder="AAACB1234F" />
        </div>
        <div>
          <label className="label" htmlFor="le-cin">CIN (optional)</label>
          <input id="le-cin" className="input uppercase font-mono" value={form.cin} onChange={set('cin', true)} maxLength={21} />
        </div>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : entity ? 'Save changes' : 'Add legal entity'}
      </button>
    </form>
  );
}

function GstCreateForm({ entities, onDone }) {
  const [form, setForm] = useState({
    legalEntityId: entities.length === 1 ? entities[0].id : '',
    gstin: '',
    tradeName: '',
    addressLine: '',
    city: '',
    pincode: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, upper = false) => (e) =>
    setForm((f) => ({ ...f, [k]: upper ? e.target.value.toUpperCase() : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/gst-registrations', dropEmpty(form));
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
        <label className="label" htmlFor="gst-entity">Legal entity</label>
        <select id="gst-entity" className="input" value={form.legalEntityId} onChange={set('legalEntityId')} required>
          <option value="" disabled>Select the entity this GSTIN belongs to…</option>
          {entities.map((en) => (
            <option key={en.id} value={en.id}>{en.legalName}{en.pan ? ` (${en.pan})` : ''}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="gst-gstin">GSTIN</label>
        <input id="gst-gstin" className="input uppercase font-mono" value={form.gstin} onChange={set('gstin', true)} required maxLength={15} placeholder="07AAACB1234F1Z5" />
        <p className="mt-1 text-xs text-slate-400">
          The state is read from the first two digits. The GSTIN cannot be edited later — a
          corrected GSTIN is a new registration.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="gst-trade">Trade name on this registration (optional)</label>
        <input id="gst-trade" className="input" value={form.tradeName} onChange={set('tradeName')} />
      </div>
      <div>
        <label className="label" htmlFor="gst-address">Registered address (optional)</label>
        <input id="gst-address" className="input" value={form.addressLine} onChange={set('addressLine')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="gst-city">City</label>
          <input id="gst-city" className="input" value={form.city} onChange={set('city')} />
        </div>
        <div>
          <label className="label" htmlFor="gst-pin">PIN code</label>
          <input id="gst-pin" className="input" value={form.pincode} onChange={set('pincode')} maxLength={6} inputMode="numeric" />
        </div>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Adding…' : 'Add GST registration'}
      </button>
    </form>
  );
}

function GstEditForm({ reg, onDone }) {
  const [form, setForm] = useState({
    tradeName: reg.tradeName ?? '',
    addressLine: reg.addressLine ?? '',
    city: reg.city ?? '',
    pincode: reg.pincode ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.patch(`/gst-registrations/${reg.id}`, {
        tradeName: orNull(form.tradeName),
        addressLine: orNull(form.addressLine),
        city: orNull(form.city),
        pincode: orNull(form.pincode),
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
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">GSTIN — fixed</div>
        <div className="font-mono text-sm font-bold text-pos-ink">{reg.gstin}</div>
        <div className="text-xs text-slate-500">{reg.stateName} ({reg.stateCode}) · {reg.legalEntityName}</div>
      </div>
      <div>
        <label className="label" htmlFor="ge-trade">Trade name</label>
        <input id="ge-trade" className="input" value={form.tradeName} onChange={set('tradeName')} />
      </div>
      <div>
        <label className="label" htmlFor="ge-address">Registered address</label>
        <input id="ge-address" className="input" value={form.addressLine} onChange={set('addressLine')} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="ge-city">City</label>
          <input id="ge-city" className="input" value={form.city} onChange={set('city')} />
        </div>
        <div>
          <label className="label" htmlFor="ge-pin">PIN code</label>
          <input id="ge-pin" className="input" value={form.pincode} onChange={set('pincode')} maxLength={6} inputMode="numeric" />
        </div>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

export default function Organisation() {
  const { can } = usePermissions();
  const canReadEntity = can('org.legalEntity.read');
  const canReadGst = can('org.gst.read');
  const canWriteEntity = can('org.legalEntity.write');
  const canWriteGst = can('org.gst.write');

  const [entities, setEntities] = useState(null);
  const [regs, setRegs] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {kind:'entity'|'entity-edit'|'gst'|'gst-edit', row?}

  const load = useCallback(async () => {
    try {
      // Asked for separately because the two reads are separate actions. A
      // request the caller may not make would 403 the whole screen over a
      // section they were never meant to see.
      const [e, g] = await Promise.all([
        canReadEntity ? api.get('/legal-entities') : Promise.resolve(null),
        canReadGst ? api.get('/gst-registrations') : Promise.resolve(null),
      ]);
      setEntities(e ? e.data.legalEntities : []);
      setRegs(g ? g.data.gstRegistrations : []);
    } catch (err) {
      setError(apiError(err, 'Could not load the organisation'));
    }
  }, [canReadEntity, canReadGst]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (path, row, status) => {
    setError('');
    try {
      await api.patch(`${path}/${row.id}`, { status });
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

  if (error && entities === null) return <ErrorNote message={error} />;
  if (entities === null || regs === null) return <FullScreenSpinner />;

  const activeEntities = entities.filter((e) => e.status === 'ACTIVE');

  return (
    <div>
      <PageHeader
        title="Organisation"
        subtitle="The legal entities your business trades as, and their GST registrations. Stores are mapped to a registration from the Branches page."
      />

      <ErrorNote message={error} />

      {canReadEntity ? (
      <section className="mt-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-pos-ink">Legal entities</h2>
          {canWriteEntity ? (
            <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'entity' })}>
              <Plus className="h-4 w-4" /> Add legal entity
            </button>
          ) : null}
        </div>
        {entities.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No legal entities yet"
            note={
              canWriteEntity
                ? 'Add the registered business that issues your invoices. Every GST registration belongs to one.'
                : 'Nothing has been registered yet. Your role can read this registry but not add to it.'
            }
          />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Legal name</th>
                  <th className="px-4 py-3 font-semibold">PAN</th>
                  <th className="px-4 py-3 font-semibold">CIN</th>
                  <th className="px-4 py-3 font-semibold">GST regs</th>
                  <th className="px-4 py-3 font-semibold">Stores</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entities.map((en) => (
                  <tr key={en.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-pos-ink">{en.legalName}</div>
                      {en.tradeName ? <div className="text-xs text-slate-500">trades as {en.tradeName}</div> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{en.pan || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{en.cin || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{en.gstCount ?? 0}</td>
                    <td className="px-4 py-3 text-slate-600">{en.storeCount ?? 0}</td>
                    <td className="px-4 py-3"><StatusBadge status={en.status} /></td>
                    <td className="px-4 py-3 text-right">
                      {canWriteEntity ? (
                        <div className="flex justify-end gap-3">
                          <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={() => setModal({ kind: 'entity-edit', row: en })}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-xs font-semibold text-slate-500 hover:underline"
                            onClick={() => setStatus('/legal-entities', en, en.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}
                          >
                            {en.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {canReadGst ? (
      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-pos-ink">GST registrations</h2>
          {canWriteGst ? (
            <button
              type="button"
              className="btn-orange"
              onClick={() => setModal({ kind: 'gst' })}
              disabled={activeEntities.length === 0}
              title={activeEntities.length === 0 ? 'Add a legal entity first' : undefined}
            >
              <Plus className="h-4 w-4" /> Add GST registration
            </button>
          ) : null}
        </div>
        {regs.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="No GST registrations yet"
            note="Each state you bill from has its own GSTIN. A store issues invoices under exactly one registration."
          />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">GSTIN</th>
                  <th className="px-4 py-3 font-semibold">State</th>
                  <th className="px-4 py-3 font-semibold">Legal entity</th>
                  <th className="px-4 py-3 font-semibold">Stores</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {regs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-sm font-semibold text-pos-ink">{r.gstin}</div>
                      {r.tradeName ? <div className="text-xs text-slate-500">{r.tradeName}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.stateName} <span className="text-xs text-slate-400">({r.stateCode})</span></td>
                    <td className="px-4 py-3 text-slate-600">{r.legalEntityName}</td>
                    <td className="px-4 py-3 text-slate-600">{r.storeCount ?? 0}</td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    <td className="px-4 py-3 text-right">
                      {canWriteGst ? (
                        <div className="flex justify-end gap-3">
                          <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={() => setModal({ kind: 'gst-edit', row: r })}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-xs font-semibold text-slate-500 hover:underline"
                            onClick={() => setStatus('/gst-registrations', r, r.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}
                          >
                            {r.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      <Modal open={modal?.kind === 'entity'} title="Add legal entity" onClose={closeModal}>
        <EntityForm onDone={done} />
      </Modal>
      <Modal open={modal?.kind === 'entity-edit'} title="Edit legal entity" onClose={closeModal}>
        {modal?.kind === 'entity-edit' ? <EntityForm entity={modal.row} onDone={done} /> : null}
      </Modal>
      <Modal open={modal?.kind === 'gst'} title="Add GST registration" onClose={closeModal}>
        {modal?.kind === 'gst' ? <GstCreateForm entities={activeEntities} onDone={done} /> : null}
      </Modal>
      <Modal open={modal?.kind === 'gst-edit'} title="Edit GST registration" onClose={closeModal}>
        {modal?.kind === 'gst-edit' ? <GstEditForm reg={modal.row} onDone={done} /> : null}
      </Modal>
    </div>
  );
}
