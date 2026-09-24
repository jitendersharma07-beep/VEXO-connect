// LANE foundation — the people of the tenant. The role picker offers exactly
// what the server said THIS caller may assign (`assignableRoles` from
// GET /users): the reach rule — you cannot mint authority you do not hold —
// lives on the server, and a picker computed in the browser would drift from
// it. Store-pinned roles ask for a store, a regional manager asks for a
// region, company roles ask for neither.

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, UserPlus, Users } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { roleLabel, ROLE_NOTES, isStorePinnedRole } from '../lib/roles.js';
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
import { fmtDateTime } from '../lib/pos.js';

function UserForm({ user, assignableRoles, branches, regions, onDone }) {
  const [form, setForm] = useState({
    fullName: user?.fullName ?? '',
    email: user?.email ?? '',
    role: user?.role ?? (assignableRoles.includes('CASHIER') ? 'CASHIER' : assignableRoles[0] ?? ''),
    branchId: user?.branch?.id ?? '',
    regionId: user?.region?.id ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const storePinned = isStorePinnedRole(form.role);
  const regionScoped = form.role === 'REGIONAL_MANAGER';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Only the field the chosen role can use is sent — the server refuses a
      // store on a company role rather than ignoring it.
      const placement = storePinned
        ? { branchId: form.branchId }
        : regionScoped
          ? { regionId: form.regionId }
          : {};
      if (user) {
        await api.patch(`/users/${user.id}`, {
          fullName: form.fullName,
          ...(form.role !== user.role ? { role: form.role } : {}),
          ...placement,
        });
        onDone();
      } else {
        const { data } = await api.post('/users', {
          fullName: form.fullName,
          email: form.email,
          role: form.role,
          ...placement,
        });
        onDone({ email: data.user.email, tempPassword: data.tempPassword });
      }
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
        <input
          id="u-name"
          className="input"
          value={form.fullName}
          onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
          required
          minLength={2}
        />
      </div>
      {user ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email — fixed</div>
          <div className="font-mono text-sm font-bold text-pos-ink">{user.email}</div>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="u-email">Email</label>
          <input
            id="u-email"
            type="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            required
          />
        </div>
      )}
      <div>
        <label className="label" htmlFor="u-role">Role</label>
        <select
          id="u-role"
          className="input"
          value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
          required
        >
          {assignableRoles.map((r) => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
        {ROLE_NOTES[form.role] ? (
          <p className="mt-1 text-xs text-slate-400">{ROLE_NOTES[form.role]}</p>
        ) : null}
      </div>
      {storePinned ? (
        <div>
          <label className="label" htmlFor="u-branch">Store</label>
          <select
            id="u-branch"
            className="input"
            value={form.branchId}
            onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
            required
          >
            <option value="" disabled>Select a store…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
            ))}
          </select>
        </div>
      ) : null}
      {regionScoped ? (
        <div>
          <label className="label" htmlFor="u-region">Region</label>
          <select
            id="u-region"
            className="input"
            value={form.regionId}
            onChange={(e) => setForm((f) => ({ ...f, regionId: e.target.value }))}
            required
          >
            <option value="" disabled>Select a region…</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
            ))}
          </select>
          {regions.length === 0 ? (
            <p className="mt-1 text-xs text-slate-400">No active regions yet — create one under Regions first.</p>
          ) : null}
        </div>
      ) : null}
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : user ? 'Save changes' : 'Create account'}
      </button>
    </form>
  );
}

// Explicit multi-store reach. Ticked stores REPLACE the role's usual reach for
// this person; unticking everything returns them to it. The server refuses a
// store outside the caller's own scope.
function AssignmentsForm({ user, branches, assigned, onDone }) {
  const [selected, setSelected] = useState(() => new Set(assigned));
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
      await api.put(`/permissions/assignments/${user.id}`, { storeIds: [...selected] });
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
        Tick the stores <span className="font-semibold text-pos-ink">{user.fullName}</span> should
        work across. Ticked stores replace their usual reach; untick everything to restore it.
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
        {busy ? 'Saving…' : selected.size ? `Save stores (${selected.size})` : 'Clear — use the role’s own reach'}
      </button>
    </form>
  );
}

export default function Team() {
  const { user: me } = useAuth();
  const { can } = usePermissions();
  const canWrite = can('user.write');
  const canReset = can('user.resetPassword');
  // Store and region lists feed the placement pickers and the assignment
  // names; a caller who may not read them still gets the people list, with
  // each person's own store or region named from the user row itself.
  const canReadStores = can('org.store.read');
  const canReadRegions = can('org.region.read');

  const [data, setData] = useState(null); // {users, assignableRoles}
  const [branches, setBranches] = useState([]);
  const [regions, setRegions] = useState([]);
  const [assignments, setAssignments] = useState(new Map());
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {kind:'invite'|'edit'|'stores'|'reset', row?}
  const [credential, setCredential] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, a, b, r] = await Promise.all([
        api.get('/users'),
        api.get('/permissions/assignments'),
        canReadStores ? api.get('/branches') : Promise.resolve(null),
        canWrite && canReadRegions ? api.get('/regions') : Promise.resolve(null),
      ]);
      setData({ users: u.data.users, assignableRoles: u.data.assignableRoles ?? [] });
      const byUser = new Map();
      for (const row of a.data.assignments ?? []) {
        const list = byUser.get(row.userId) ?? [];
        list.push(row.branchId);
        byUser.set(row.userId, list);
      }
      setAssignments(byUser);
      setBranches(b ? b.data.branches : []);
      setRegions(r ? r.data.regions : []);
    } catch (err) {
      setError(apiError(err, 'Could not load the team'));
    }
  }, [canWrite, canReadStores, canReadRegions]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleStatus = async (target) => {
    setError('');
    try {
      await api.patch(`/users/${target.id}/status`, {
        status: target.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      await load();
    } catch (err) {
      setError(apiError(err));
    }
  };

  const resetPassword = async (target) => {
    setError('');
    setBusy(true);
    try {
      const { data: d } = await api.post(`/users/${target.id}/reset-password`);
      setCredential({ email: d.email, tempPassword: d.tempPassword });
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const closeModal = () => {
    setModal(null);
    setCredential(null);
  };
  const done = () => {
    closeModal();
    load();
  };

  if (error && data === null) return <ErrorNote message={error} />;
  if (data === null) return <FullScreenSpinner />;

  const { users, assignableRoles } = data;
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  // Mirrors the server's owner guard: an owner account is only editable by the
  // owner (or VEXO support inside a granted window) — hiding the buttons here
  // is presentation, the refusal itself is the server's.
  const ownerAuthority = me.role === 'CUSTOMER_OWNER' || me.role === 'POS_SUPER_ADMIN';
  const canTouch = (u) => u.role !== 'CUSTOMER_OWNER' || ownerAuthority;

  const worksAt = (u) => {
    const extra = assignments.get(u.id) ?? [];
    if (extra.length) {
      const names = extra.map((id) => branchName.get(id)).filter(Boolean);
      if (names.length && names.length <= 2) return names.join(', ');
      return `${extra.length} assigned stores`;
    }
    if (u.branch) return `${u.branch.name} (${u.branch.code})`;
    if (u.region) return `Region: ${u.region.name}`;
    return 'All stores';
  };

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="Staff accounts and where they apply. Temporary passwords are shown once, at creation or reset."
        actions={
          canWrite ? (
            <button
              type="button"
              className="btn-orange"
              onClick={() => { setCredential(null); setModal({ kind: 'invite' }); }}
            >
              <UserPlus className="h-4 w-4" /> Add team member
            </button>
          ) : null
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
                <th className="px-4 py-3 font-semibold">Works at</th>
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
                  <td className="px-4 py-3 text-slate-600">{worksAt(u)}</td>
                  <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                  {/* fmtDateTime, not toLocaleString: every other date in the
                      POS is IST, and a login stamp that silently follows the
                      till's own timezone is the one you would quote back at
                      somebody during a dispute. */}
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id === me.id ? (
                      <span className="text-xs text-slate-300">you</span>
                    ) : canTouch(u) ? (
                      <div className="flex justify-end gap-3">
                        {canWrite ? (
                          <button
                            type="button"
                            className="text-xs font-semibold text-pos-royal hover:underline"
                            onClick={() => setModal({ kind: 'edit', row: u })}
                          >
                            Edit
                          </button>
                        ) : null}
                        {canWrite && canReadStores ? (
                          <button
                            type="button"
                            className="text-xs font-semibold text-pos-royal hover:underline"
                            onClick={() => setModal({ kind: 'stores', row: u })}
                          >
                            Stores
                          </button>
                        ) : null}
                        {canReset ? (
                          <button
                            type="button"
                            className="text-xs font-semibold text-pos-royal hover:underline"
                            onClick={() => { setCredential(null); setModal({ kind: 'reset', row: u }); }}
                          >
                            Reset password
                          </button>
                        ) : null}
                        {canWrite ? (
                          <button
                            type="button"
                            className="text-xs font-semibold text-slate-500 hover:underline"
                            onClick={() => toggleStatus(u)}
                          >
                            {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={modal?.kind === 'invite'}
        title={credential ? 'Account created' : 'Add team member'}
        onClose={closeModal}
      >
        {credential ? (
          <div className="space-y-4">
            <TempPasswordReveal credential={credential} />
            <button type="button" className="btn-primary w-full" onClick={done}>Done</button>
          </div>
        ) : (
          <UserForm
            assignableRoles={assignableRoles}
            branches={branches.filter((b) => b.status === 'ACTIVE')}
            regions={regions.filter((r) => r.status === 'ACTIVE')}
            onDone={(cred) => setCredential(cred)}
          />
        )}
      </Modal>

      <Modal open={modal?.kind === 'edit'} title="Edit team member" onClose={closeModal}>
        {modal?.kind === 'edit' ? (
          <UserForm
            user={modal.row}
            assignableRoles={
              // A role the caller could not create is not offered as a change
              // either — except the row's current role, so the form can open.
              assignableRoles.includes(modal.row.role)
                ? assignableRoles
                : [modal.row.role, ...assignableRoles]
            }
            branches={branches.filter((b) => b.status === 'ACTIVE')}
            regions={regions.filter((r) => r.status === 'ACTIVE')}
            onDone={done}
          />
        ) : null}
      </Modal>

      <Modal open={modal?.kind === 'stores'} title="Assigned stores" onClose={closeModal}>
        {modal?.kind === 'stores' ? (
          <AssignmentsForm
            user={modal.row}
            branches={branches}
            assigned={assignments.get(modal.row.id) ?? []}
            onDone={done}
          />
        ) : null}
      </Modal>

      <Modal
        open={modal?.kind === 'reset'}
        title={credential ? 'Password reset' : 'Reset password'}
        onClose={credential ? done : closeModal}
      >
        {credential ? (
          <div className="space-y-4">
            <TempPasswordReveal credential={credential} />
            <button type="button" className="btn-primary w-full" onClick={done}>Done</button>
          </div>
        ) : modal?.kind === 'reset' ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              This signs <span className="font-semibold text-pos-ink">{modal.row.fullName}</span> out
              everywhere and replaces their password with a temporary one, shown once. They must set
              a new password at their next sign-in.
            </p>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 shrink-0 text-pos-ember" />
              <span className="text-xs text-slate-500">Their current password stops working immediately.</span>
            </div>
            <ErrorNote message={error} />
            <button
              type="button"
              className="btn-primary w-full"
              disabled={busy}
              onClick={() => resetPassword(modal.row)}
            >
              {busy ? 'Resetting…' : 'Reset and show temporary password'}
            </button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
