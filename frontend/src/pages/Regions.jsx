// LANE foundation — regions / clusters (spec B§3, B§11). A region is a
// reporting and permission scope: a Regional Manager sees the stores of their
// region, nothing else. Regions can nest (West → Mumbai), and the server
// refuses a parent choice that would loop the tree.

import { useCallback, useEffect, useState } from 'react';
// Aliased: plain `Map` would shadow the Map constructor used for the
// parent-name lookup below.
import { Map as MapIcon, Plus } from 'lucide-react';
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

function RegionForm({ region, regions, onDone }) {
  const [form, setForm] = useState({
    name: region?.name ?? '',
    code: region?.code ?? '',
    parentId: region?.parentId ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Self can never be its own parent; deeper loops are the server's call.
  const parentChoices = regions.filter((r) => r.status === 'ACTIVE' && r.id !== region?.id);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (region) {
        await api.patch(`/regions/${region.id}`, {
          name: form.name,
          parentId: form.parentId || null,
        });
      } else {
        await api.post('/regions', {
          name: form.name,
          code: form.code,
          ...(form.parentId ? { parentId: form.parentId } : {}),
        });
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
        <label className="label" htmlFor="rg-name">Region name</label>
        <input
          id="rg-name"
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          minLength={2}
          placeholder="Mumbai"
        />
      </div>
      {region ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Code — fixed</div>
          <div className="font-mono text-sm font-bold text-pos-ink">{region.code}</div>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="rg-code">Code</label>
          <input
            id="rg-code"
            className="input uppercase font-mono"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
            required
            minLength={2}
            maxLength={12}
            placeholder="MUM"
          />
        </div>
      )}
      <div>
        <label className="label" htmlFor="rg-parent">Part of (optional)</label>
        <select
          id="rg-parent"
          className="input"
          value={form.parentId}
          onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))}
        >
          <option value="">— top level —</option>
          {parentChoices.map((r) => (
            <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
          ))}
        </select>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : region ? 'Save changes' : 'Add region'}
      </button>
    </form>
  );
}

export default function Regions() {
  const { can } = usePermissions();
  const canWrite = can('org.region.write');

  const [regions, setRegions] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {kind:'create'|'edit', row?}

  const load = useCallback(async () => {
    try {
      const r = await api.get('/regions');
      setRegions(r.data.regions);
    } catch (err) {
      setError(apiError(err, 'Could not load regions'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (row, status) => {
    setError('');
    try {
      await api.patch(`/regions/${row.id}`, { status });
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

  if (error && regions === null) return <ErrorNote message={error} />;
  if (regions === null) return <FullScreenSpinner />;

  const nameById = new Map(regions.map((r) => [r.id, r.name]));

  return (
    <div>
      <PageHeader
        title="Regions"
        subtitle="Clusters of stores for reporting and scoped roles. A Regional Manager's reach is exactly their region."
        actions={
          canWrite ? (
            <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'create' })}>
              <Plus className="h-4 w-4" /> Add region
            </button>
          ) : null
        }
      />

      <ErrorNote message={error} />

      {regions.length === 0 ? (
        <EmptyState
          icon={MapIcon}
          title="No regions yet"
          note="Group stores into regions when one person manages a slice of the estate, or reports roll up by area."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Region</th>
                <th className="px-4 py-3 font-semibold">Part of</th>
                <th className="px-4 py-3 font-semibold">Stores</th>
                <th className="px-4 py-3 font-semibold">Managers</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {regions.map((rg) => (
                <tr key={rg.id}>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-pos-ink">{rg.name}</div>
                    <div className="font-mono text-xs text-slate-400">{rg.code}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {rg.parentId ? nameById.get(rg.parentId) ?? '—' : '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{rg.storeCount ?? 0}</td>
                  <td className="px-4 py-3 text-slate-600">{rg.managerCount ?? 0}</td>
                  <td className="px-4 py-3"><StatusBadge status={rg.status} /></td>
                  <td className="px-4 py-3 text-right">
                    {canWrite ? (
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          className="text-xs font-semibold text-pos-royal hover:underline"
                          onClick={() => setModal({ kind: 'edit', row: rg })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-xs font-semibold text-slate-500 hover:underline"
                          onClick={() => setStatus(rg, rg.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}
                        >
                          {rg.status === 'ACTIVE' ? 'Archive' : 'Restore'}
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

      <Modal open={modal?.kind === 'create'} title="Add region" onClose={closeModal}>
        <RegionForm regions={regions} onDone={done} />
      </Modal>
      <Modal open={modal?.kind === 'edit'} title="Edit region" onClose={closeModal}>
        {modal?.kind === 'edit' ? <RegionForm region={modal.row} regions={regions} onDone={done} /> : null}
      </Modal>
    </div>
  );
}
