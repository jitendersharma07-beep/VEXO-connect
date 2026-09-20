import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Users } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  PageHeader,
  StatusBadge,
  RoleBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
  TempPasswordReveal,
} from '../components/ui.jsx';

const ROLES = [
  { value: 'CUSTOMER_OWNER', label: 'Owner — full company access' },
  { value: 'BRANCH_MANAGER', label: 'Branch Manager — one branch' },
  { value: 'CASHIER', label: 'Cashier — one branch' },
];

function InviteForm({ branches, onCreated }) {
  const [form, setForm] = useState({ fullName: '', email: '', role: 'CASHIER', branchId: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const branchPinned = form.role === 'BRANCH_MANAGER' || form.role === 'CASHIER';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload = {
        fullName: form.fullName,
        email: form.email,
        role: form.role,
        ...(branchPinned ? { branchId: form.branchId } : {}),
      };
      const { data } = await api.post('/users', payload);
      onCreated({ email: data.user.email, tempPassword: data.tempPassword });
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="u-name">Full name</label>
        <input id="u-name" className="input" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} required minLength={2} />
      </div>
      <div>
        <label className="label" htmlFor="u-email">Email</label>
        <input id="u-email" type="email" className="input" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
      </div>
      <div>
        <label className="label" htmlFor="u-role">Role</label>
        <select id="u-role" className="input" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>
      {branchPinned ? (
        <div>
          <label className="label" htmlFor="u-branch">Branch</label>
          <select id="u-branch" className="input" value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))} required>
            <option value="" disabled>Select a branch…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>
        </div>
      ) : null}
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}

export default function Team() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [credential, setCredential] = useState(null);

  const load = useCallback(async () => {
    try {
      const [u, b] = await Promise.all([api.get('/users'), api.get('/branches')]);
      setUsers(u.data.users);
      setBranches(b.data.branches);
    } catch (err) {
      setError(apiError(err, 'Could not load the team'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleStatus = async (target) => {
    try {
      await api.patch(`/users/${target.id}/status`, {
        status: target.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      await load();
    } catch (err) {
      setError(apiError(err));
    }
  };

  if (error && users === null) return <ErrorNote message={error} />;
  if (users === null) return <FullScreenSpinner />;

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="POS accounts in your company. Temporary passwords are shown once at creation."
        actions={
          <button type="button" className="btn-orange" onClick={() => { setCredential(null); setOpen(true); }}>
            <UserPlus className="h-4 w-4" /> Add team member
          </button>
        }
      />

      <ErrorNote message={error} />

      {users.length === 0 ? (
        <EmptyState icon={Users} title="No team members yet" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Branch</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Last sign-in</th>
                <th className="px-4 py-3 font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-pos-ink">{u.fullName}</div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                  <td className="px-4 py-3 text-slate-600">{u.branch ? `${u.branch.name} (${u.branch.code})` : '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id !== user.id ? (
                      <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={() => toggleStatus(u)}>
                        {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-300">you</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} title={credential ? 'Account created' : 'Add team member'} onClose={() => setOpen(false)}>
        {credential ? (
          <div className="space-y-4">
            <TempPasswordReveal credential={credential} />
            <button type="button" className="btn-primary w-full" onClick={() => { setOpen(false); load(); }}>
              Done
            </button>
          </div>
        ) : (
          <InviteForm branches={branches.filter((b) => b.status === 'ACTIVE')} onCreated={setCredential} />
        )}
      </Modal>
    </div>
  );
}
