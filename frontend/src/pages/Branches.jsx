import { useCallback, useEffect, useState } from 'react';
import { Store, Plus, MapPin } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader,
  StatusBadge,
  DemoBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

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

export default function Branches() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const canManage = user.role === 'CUSTOMER_OWNER' || user.role === 'POS_SUPER_ADMIN';

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/branches');
      setData(data);
    } catch (err) {
      setError(apiError(err, 'Could not load branches'));
    }
  }, []);

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
            <button type="button" className="btn-orange" onClick={() => setOpen(true)}>
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
                  <div className="mt-0.5 text-xs font-semibold text-slate-400">{b.code}</div>
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
              {canManage ? (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={() => toggleStatus(b)}>
                    {b.status === 'ACTIVE' ? 'Mark closed' : 'Reopen branch'}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <Modal open={open} title="Add branch" onClose={() => setOpen(false)}>
        <BranchForm
          onDone={() => {
            setOpen(false);
            load();
          }}
        />
      </Modal>
    </div>
  );
}
