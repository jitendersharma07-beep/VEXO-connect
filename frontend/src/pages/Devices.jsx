// LANE foundation — tills and devices (spec B§7, B§10). A till (terminal) is
// the logical counter; a device is the physical machine bound to it. The
// device token is shown exactly once at activation — the server keeps only a
// hash, so there is nothing to "show again" later, only rotate. Revoking is
// final: the machine comes back by enrolling a fresh device, so history keeps
// pointing at the hardware that really took each payment.

import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Monitor, MonitorSmartphone, Plus } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { fmtDateTime } from '../lib/pos.js';
import {
  PageHeader,
  StatusBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

const DEVICE_TYPES = [
  ['COUNTER', 'Counter (POS)'],
  ['KDS', 'Kitchen display'],
  ['CUSTOMER_DISPLAY', 'Customer display'],
  ['HANDHELD', 'Handheld'],
  ['OTHER', 'Other'],
];
const typeLabel = (t) => DEVICE_TYPES.find(([k]) => k === t)?.[1] ?? t;

function TillForm({ till, branches, onDone }) {
  const [form, setForm] = useState({
    branchId: till?.branchId ?? (branches.length === 1 ? branches[0].id : ''),
    code: till?.code ?? '',
    name: till?.name ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (till) {
        await api.patch(`/terminals/${till.id}`, { name: form.name });
      } else {
        await api.post('/terminals', form);
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
      {till ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Till — fixed</div>
          <div className="font-mono text-sm font-bold text-pos-ink">{till.code}</div>
          <div className="text-xs text-slate-500">{till.branchName}</div>
        </div>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="tl-store">Store</label>
            <select
              id="tl-store"
              className="input"
              value={form.branchId}
              onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
              required
            >
              <option value="" disabled>Select the store this till lives in…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tl-code">Till code</label>
            <input
              id="tl-code"
              className="input uppercase font-mono"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              required
              maxLength={12}
              placeholder="T1"
            />
            <p className="mt-1 text-xs text-slate-400">
              Unique within the store, printed in reports. Cannot be changed later.
            </p>
          </div>
        </>
      )}
      <div>
        <label className="label" htmlFor="tl-name">Name</label>
        <input
          id="tl-name"
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          minLength={2}
          placeholder="Front counter"
        />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : till ? 'Save changes' : 'Add till'}
      </button>
    </form>
  );
}

function DeviceForm({ device, branches, terminals, onDone }) {
  const [form, setForm] = useState({
    branchId: device?.branchId ?? (branches.length === 1 ? branches[0].id : ''),
    terminalId: device?.terminalId ?? '',
    type: device?.type ?? 'COUNTER',
    name: device?.name ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const tillChoices = terminals.filter((t) => t.branchId === form.branchId && t.status === 'ACTIVE');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (device) {
        await api.patch(`/devices/${device.id}`, {
          name: form.name,
          terminalId: form.terminalId || null,
        });
      } else {
        await api.post('/devices', {
          branchId: form.branchId,
          type: form.type,
          name: form.name,
          ...(form.terminalId ? { terminalId: form.terminalId } : {}),
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
      {device ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Device — fixed</div>
          <div className="font-mono text-sm font-bold text-pos-ink">{device.publicId}</div>
          <div className="text-xs text-slate-500">{typeLabel(device.type)} · {device.branchName}</div>
        </div>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="dv-store">Store</label>
            <select
              id="dv-store"
              className="input"
              value={form.branchId}
              onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value, terminalId: '' }))}
              required
            >
              <option value="" disabled>Select the store this machine works in…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dv-type">Kind of device</label>
            <select
              id="dv-type"
              className="input"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
            >
              {DEVICE_TYPES.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
        </>
      )}
      <div>
        <label className="label" htmlFor="dv-till">Till (optional)</label>
        <select
          id="dv-till"
          className="input"
          value={form.terminalId}
          onChange={(e) => setForm((f) => ({ ...f, terminalId: e.target.value }))}
          disabled={!form.branchId && !device}
        >
          <option value="">— no till —</option>
          {tillChoices.map((t) => (
            <option key={t.id} value={t.id}>{t.code} — {t.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="dv-name">Name</label>
        <input
          id="dv-name"
          className="input"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          minLength={2}
          placeholder="Counter iPad 1"
        />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : device ? 'Save changes' : 'Enrol device'}
      </button>
    </form>
  );
}

// The one and only screen that ever shows the token — modelled on the temp
// password reveal. Once this modal closes, the server can only rotate.
function TokenReveal({ device, token }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Paste this token into <span className="font-semibold text-pos-ink">{device.name}</span>{' '}
        ({device.publicId}). It is shown <span className="font-semibold">only this once</span> —
        the server keeps a fingerprint, not the token. Lose it and you rotate, not recover.
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-3">
        <KeyRound className="h-4 w-4 shrink-0 text-amber-400" />
        <code className="min-w-0 flex-1 break-all font-mono text-sm text-emerald-300">{token}</code>
        <button
          type="button"
          className="shrink-0 rounded-lg bg-slate-700 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-600"
          onClick={copy}
        >
          <span className="flex items-center gap-1"><Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
    </div>
  );
}

export default function Devices() {
  const [terminals, setTerminals] = useState(null);
  const [devices, setDevices] = useState(null);
  const [branches, setBranches] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  // {kind:'till'|'till-edit'|'device'|'device-edit'|'rotate'|'revoke', row?}
  // {kind:'token', row, token} — set only from an activate response
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, d, b] = await Promise.all([
        api.get('/terminals'),
        api.get('/devices'),
        api.get('/branches'),
      ]);
      setTerminals(t.data.terminals);
      setDevices(d.data.devices);
      setBranches(b.data.branches.filter((br) => br.status === 'ACTIVE'));
    } catch (err) {
      setError(apiError(err, 'Could not load tills and devices'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setTillStatus = async (till, status) => {
    setError('');
    try {
      await api.patch(`/terminals/${till.id}`, { status });
      await load();
    } catch (err) {
      setError(apiError(err));
    }
  };

  const activate = async (device) => {
    setError('');
    setBusy(true);
    try {
      const res = await api.post(`/devices/${device.id}/activate`);
      setModal({ kind: 'token', row: res.data.device, token: res.data.deviceToken });
      await load();
    } catch (err) {
      setError(apiError(err));
      setModal(null);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device) => {
    setBusy(true);
    try {
      await api.post(`/devices/${device.id}/revoke`);
      setModal(null);
      await load();
    } catch (err) {
      setError(apiError(err));
      setModal(null);
    } finally {
      setBusy(false);
    }
  };

  const closeModal = () => setModal(null);
  const done = () => {
    closeModal();
    load();
  };

  if (error && terminals === null) return <ErrorNote message={error} />;
  if (terminals === null || devices === null || branches === null) return <FullScreenSpinner />;

  return (
    <div>
      <PageHeader
        title="Tills & devices"
        subtitle="Tills are the counters money moves through; devices are the machines signed in at them. Every order and payment records both."
      />

      <ErrorNote message={error} />

      <section className="mt-2">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-pos-ink">Tills</h2>
          <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'till' })}>
            <Plus className="h-4 w-4" /> Add till
          </button>
        </div>
        {terminals.length === 0 ? (
          <EmptyState
            icon={Monitor}
            title="No tills yet"
            note="Add a till for each counter — front counter, drive-through window, kitchen pass."
          />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Till</th>
                  <th className="px-4 py-3 font-semibold">Store</th>
                  <th className="px-4 py-3 font-semibold">Devices</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {terminals.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-pos-ink">{t.name}</div>
                      <div className="font-mono text-xs text-slate-400">{t.code}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{t.branchName}</td>
                    <td className="px-4 py-3 text-slate-600">{t.deviceCount ?? 0}</td>
                    <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          className="text-xs font-semibold text-pos-royal hover:underline"
                          onClick={() => setModal({ kind: 'till-edit', row: t })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-xs font-semibold text-slate-500 hover:underline"
                          onClick={() => setTillStatus(t, t.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
                        >
                          {t.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-pos-ink">Devices</h2>
          <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'device' })}>
            <Plus className="h-4 w-4" /> Enrol device
          </button>
        </div>
        {devices.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title="No devices enrolled"
            note="Enrol each machine that signs in — activation issues its token, shown exactly once."
          />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Device</th>
                  <th className="px-4 py-3 font-semibold">Kind</th>
                  <th className="px-4 py-3 font-semibold">Store / till</th>
                  <th className="px-4 py-3 font-semibold">Last seen</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-pos-ink">{d.name}</div>
                      <div className="font-mono text-xs text-slate-400">{d.publicId}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{typeLabel(d.type)}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {d.branchName}
                      {d.terminalCode ? <span className="text-xs text-slate-400"> · {d.terminalCode}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{d.lastSeenAt ? fmtDateTime(d.lastSeenAt) : '—'}</td>
                    <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                    <td className="px-4 py-3 text-right">
                      {d.status === 'REVOKED' ? null : (
                        <div className="flex justify-end gap-3">
                          {d.status === 'ACTIVE' ? (
                            <button
                              type="button"
                              className="text-xs font-semibold text-pos-royal hover:underline"
                              onClick={() => setModal({ kind: 'rotate', row: d })}
                            >
                              Rotate token
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-xs font-semibold text-pos-royal hover:underline"
                              disabled={busy}
                              onClick={() => activate(d)}
                            >
                              Activate
                            </button>
                          )}
                          <button
                            type="button"
                            className="text-xs font-semibold text-pos-royal hover:underline"
                            onClick={() => setModal({ kind: 'device-edit', row: d })}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="text-xs font-semibold text-red-500 hover:underline"
                            onClick={() => setModal({ kind: 'revoke', row: d })}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal open={modal?.kind === 'till'} title="Add till" onClose={closeModal}>
        <TillForm branches={branches} onDone={done} />
      </Modal>
      <Modal open={modal?.kind === 'till-edit'} title="Edit till" onClose={closeModal}>
        {modal?.kind === 'till-edit' ? <TillForm till={modal.row} branches={branches} onDone={done} /> : null}
      </Modal>
      <Modal open={modal?.kind === 'device'} title="Enrol device" onClose={closeModal}>
        {modal?.kind === 'device' ? (
          <DeviceForm branches={branches} terminals={terminals} onDone={done} />
        ) : null}
      </Modal>
      <Modal open={modal?.kind === 'device-edit'} title="Edit device" onClose={closeModal}>
        {modal?.kind === 'device-edit' ? (
          <DeviceForm device={modal.row} branches={branches} terminals={terminals} onDone={done} />
        ) : null}
      </Modal>

      <Modal open={modal?.kind === 'rotate'} title="Rotate device token" onClose={closeModal}>
        {modal?.kind === 'rotate' ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Rotating issues a new token for{' '}
              <span className="font-semibold text-pos-ink">{modal.row.name}</span> ({modal.row.publicId})
              and the current token <span className="font-semibold">stops working immediately</span>.
              The machine will need the new token pasted in before it can take another order.
            </p>
            <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => activate(modal.row)}>
              {busy ? 'Rotating…' : 'Rotate now'}
            </button>
          </div>
        ) : null}
      </Modal>

      <Modal open={modal?.kind === 'revoke'} title="Revoke device" onClose={closeModal}>
        {modal?.kind === 'revoke' ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Revoking signs <span className="font-semibold text-pos-ink">{modal.row.name}</span>{' '}
              ({modal.row.publicId}) out for good. This cannot be undone — to bring the machine
              back you enrol it as a new device, so past orders keep pointing at this record.
            </p>
            <button
              type="button"
              className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              disabled={busy}
              onClick={() => revoke(modal.row)}
            >
              {busy ? 'Revoking…' : 'Revoke this device'}
            </button>
          </div>
        ) : null}
      </Modal>

      <Modal open={modal?.kind === 'token'} title="Device token — shown once" onClose={closeModal}>
        {modal?.kind === 'token' ? <TokenReveal device={modal.row} token={modal.token} /> : null}
      </Modal>
    </div>
  );
}
