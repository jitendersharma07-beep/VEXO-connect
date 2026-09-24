// LANE foundation — brands as a separate dimension (spec B§3). A brand is
// many-to-many with stores: one food court till can serve two brands, one
// brand can run in twenty stores. Mapping is edited here as a whole list per
// brand (PUT replaces), so what you see checked is exactly what will be true.

import { useCallback, useEffect, useState } from 'react';
import { Plus, Tags } from 'lucide-react';
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

function BrandForm({ brand, onDone }) {
  const [form, setForm] = useState({
    name: brand?.name ?? '',
    code: brand?.code ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (brand) {
        await api.patch(`/brands/${brand.id}`, { name: form.name });
      } else {
        await api.post('/brands', { name: form.name, code: form.code });
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
        <label className="label" htmlFor="br-name">Brand name</label>
        <input
          id="br-name"
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          minLength={2}
          placeholder="Brew Street Coffee"
        />
      </div>
      {brand ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Code — fixed</div>
          <div className="font-mono text-sm font-bold text-pos-ink">{brand.code}</div>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="br-code">Code</label>
          <input
            id="br-code"
            className="input uppercase font-mono"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            required
            minLength={2}
            maxLength={12}
            placeholder="BREW"
          />
          <p className="mt-1 text-xs text-slate-400">
            Letters, digits and dashes. The code appears in reports and cannot be changed later.
          </p>
        </div>
      )}
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : brand ? 'Save changes' : 'Add brand'}
      </button>
    </form>
  );
}

function BrandStoresForm({ brand, branches, onDone }) {
  const [selected, setSelected] = useState(() => new Set(brand.storeIds ?? []));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.put(`/brands/${brand.id}/stores`, { storeIds: [...selected] });
      onDone();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-slate-500">
        Tick every store that runs <span className="font-semibold text-pos-ink">{brand.name}</span>.
        Saving replaces the whole list with what is ticked here.
      </p>
      {branches.length === 0 ? (
        <p className="text-sm text-slate-400">No stores exist yet.</p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {branches.map((b) => (
            <label
              key={b.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-pos-royal"
                checked={selected.has(b.id)}
                onChange={() => toggle(b.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-pos-ink">{b.name}</span>
                <span className="block text-xs text-slate-400">
                  {b.publicId ?? b.code}
                  {b.status !== 'ACTIVE' ? ` · ${b.status.toLowerCase()}` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : `Save stores (${selected.size})`}
      </button>
    </form>
  );
}

export default function Brands() {
  const { can } = usePermissions();
  const canWrite = can('org.brand.write');
  // The store list is only needed to EDIT the mapping, and a role that can read
  // brands need not be able to read stores — so it is fetched only when it will
  // be used, and its absence is not an error.
  const canReadStores = can('org.store.read');

  const [brands, setBrands] = useState(null);
  const [branches, setBranches] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {kind:'create'|'edit'|'stores', row?}

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([
        api.get('/brands'),
        canWrite && canReadStores ? api.get('/branches') : Promise.resolve(null),
      ]);
      setBrands(b.data.brands);
      setBranches(s ? s.data.branches : []);
    } catch (err) {
      setError(apiError(err, 'Could not load brands'));
    }
  }, [canWrite, canReadStores]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (row, status) => {
    setError('');
    try {
      await api.patch(`/brands/${row.id}`, { status });
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

  if (error && brands === null) return <ErrorNote message={error} />;
  if (brands === null || branches === null) return <FullScreenSpinner />;

  return (
    <div>
      <PageHeader
        title="Brands"
        subtitle="The consumer brands your stores trade under. A store can carry several brands; a brand can run in several stores."
        actions={
          canWrite ? (
            <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'create' })}>
              <Plus className="h-4 w-4" /> Add brand
            </button>
          ) : null
        }
      />

      <ErrorNote message={error} />

      {brands.length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No brands yet"
          note="Add a brand when one menu identity runs across stores — or two identities share one till."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Brand</th>
                <th className="px-4 py-3 font-semibold">Code</th>
                <th className="px-4 py-3 font-semibold">Stores</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {brands.map((br) => (
                <tr key={br.id}>
                  <td className="px-4 py-3 font-semibold text-pos-ink">{br.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{br.code}</td>
                  <td className="px-4 py-3 text-slate-600">{br.storeCount ?? 0}</td>
                  <td className="px-4 py-3"><StatusBadge status={br.status} /></td>
                  <td className="px-4 py-3 text-right">
                    {canWrite ? (
                      <div className="flex justify-end gap-3">
                        {br.status === 'ACTIVE' && canReadStores ? (
                          <button
                            type="button"
                            className="text-xs font-semibold text-pos-royal hover:underline"
                            onClick={() => setModal({ kind: 'stores', row: br })}
                          >
                            Stores
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="text-xs font-semibold text-pos-royal hover:underline"
                          onClick={() => setModal({ kind: 'edit', row: br })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-xs font-semibold text-slate-500 hover:underline"
                          onClick={() => setStatus(br, br.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}
                        >
                          {br.status === 'ACTIVE' ? 'Archive' : 'Restore'}
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

      <Modal open={modal?.kind === 'create'} title="Add brand" onClose={closeModal}>
        <BrandForm onDone={done} />
      </Modal>
      <Modal open={modal?.kind === 'edit'} title="Edit brand" onClose={closeModal}>
        {modal?.kind === 'edit' ? <BrandForm brand={modal.row} onDone={done} /> : null}
      </Modal>
      <Modal open={modal?.kind === 'stores'} title="Stores carrying this brand" onClose={closeModal}>
        {modal?.kind === 'stores' ? (
          <BrandStoresForm brand={modal.row} branches={branches} onDone={done} />
        ) : null}
      </Modal>
    </div>
  );
}
