// LANE foundation — who may do what, and where (spec B§5). Three sections:
// the role baselines (read-only reference, served by the API so the screen can
// never offer a toggle the server does not enforce), the rules that narrow
// them, and VEXO support access. The picker only offers actions the CALLER
// holds — you cannot hand out what you do not hold — and every refusal shown
// here is the server's own wording, re-checked on the request.

import { useCallback, useEffect, useState } from 'react';
import { Check, LifeBuoy, Minus, Plus, Puzzle, ShieldCheck } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { usePermissions } from '../lib/permissions.jsx';
import { roleLabel, ROLE_NOTES } from '../lib/roles.js';
import {
  PageHeader,
  StatusBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';
import { fmtDateTime } from '../lib/pos.js';

const EFFECT_STYLES = {
  ALLOW: 'bg-emerald-100 text-emerald-700',
  DENY: 'bg-red-100 text-red-700',
};

function EffectBadge({ effect }) {
  return <span className={`badge ${EFFECT_STYLES[effect] || 'bg-slate-100 text-slate-600'}`}>{effect}</span>;
}

// ACTIVE / REVOKED / EXPIRED, in that order of interest. `active` is computed
// by the server against its own clock, so an expired-but-unrevoked grant never
// shows green just because the browser's clock is behind.
const grantStatus = (g) => (g.active ? 'ACTIVE' : g.revokedAt ? 'REVOKED' : 'EXPIRED');

const LEVEL_CAPTIONS = { COMPANY: 'Whole company', BRANCH: 'Store', USER: 'Person' };

function ruleTarget(rule) {
  if (rule.level === 'BRANCH') return rule.branchName ?? '—';
  if (rule.level === 'USER') return rule.userEmail ?? '—';
  return 'Everyone in the company';
}

function RoleBaseline({ roles, actions }) {
  const [selected, setSelected] = useState(
    roles.some((r) => r.role === 'COMPANY_ADMIN') ? 'COMPANY_ADMIN' : roles[0]?.role ?? '',
  );
  const entry = roles.find((r) => r.role === selected);
  const held = new Set(entry?.baseline ?? []);
  const off = new Set(entry?.defaultOff ?? []);
  const groups = [...new Set(actions.map((a) => a.group))];

  return (
    <div className="card p-5">
      <div className="max-w-sm">
        <label className="label" htmlFor="pm-role">Role</label>
        <select id="pm-role" className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {roles.map((r) => (
            <option key={r.role} value={r.role}>{roleLabel(r.role)}</option>
          ))}
        </select>
        {ROLE_NOTES[selected] ? <p className="mt-1 text-xs text-slate-400">{ROLE_NOTES[selected]}</p> : null}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <div key={group} className="rounded-lg border border-slate-200 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{group}</div>
            <ul className="space-y-1.5">
              {actions
                .filter((a) => a.group === group)
                .map((a) => {
                  const has = held.has(a.key);
                  return (
                    <li key={a.key} className="flex items-center gap-2 text-sm">
                      {has ? (
                        <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                      ) : (
                        <Minus className="h-4 w-4 shrink-0 text-slate-300" />
                      )}
                      <span className={`min-w-0 flex-1 truncate ${has ? 'text-pos-ink' : 'text-slate-400'}`}>
                        {a.label}
                        {a.scope === 'STORE' ? <span className="text-slate-400"> · per store</span> : null}
                      </span>
                      {off.has(a.key) ? (
                        <span className="badge shrink-0 bg-amber-100 text-amber-700">off by default</span>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        The baseline is a ceiling. A rule below can switch an action off, or switch an
        &ldquo;off by default&rdquo; one on — it can never add an action the role does not hold.
      </p>
    </div>
  );
}

// Create prefills nothing; edit freezes the rule's identity (where + action —
// the upsert key) and offers only effect and note, so "edit" can never quietly
// become "create a second rule".
function RuleForm({ rule, actions, branches, users, onDone }) {
  const [form, setForm] = useState({
    level: rule?.level ?? 'COMPANY',
    branchId: rule?.branchId ?? '',
    userId: rule?.userId ?? '',
    action: rule?.action ?? '',
    effect: rule?.effect ?? 'DENY',
    note: rule?.note ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // The server refuses a per-store rule for a company-wide action; the picker
  // simply does not offer one.
  const actionChoices = form.level === 'BRANCH' ? actions.filter((a) => a.scope === 'STORE') : actions;
  const groups = [...new Set(actionChoices.map((a) => a.group))];
  const chosen = actions.find((a) => a.key === form.action);

  const setLevel = (level) =>
    setForm((f) => ({
      ...f,
      level,
      branchId: '',
      userId: '',
      action:
        level === 'BRANCH' && f.action && actions.find((a) => a.key === f.action)?.scope !== 'STORE'
          ? ''
          : f.action,
    }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.put('/permissions/rules', {
        level: form.level,
        action: form.action,
        effect: form.effect,
        ...(form.level === 'BRANCH' ? { branchId: form.branchId } : {}),
        ...(form.level === 'USER' ? { userId: form.userId } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
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
      {rule ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {LEVEL_CAPTIONS[rule.level]} — fixed
          </div>
          <div className="text-sm font-semibold text-pos-ink">{ruleTarget(rule)}</div>
          <div className="mt-1 text-sm text-slate-600">{chosen?.label ?? rule.action}</div>
          <div className="font-mono text-xs text-slate-400">{rule.action}</div>
        </div>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="pr-level">Applies to</label>
            <select id="pr-level" className="input" value={form.level} onChange={(e) => setLevel(e.target.value)}>
              <option value="COMPANY">The whole company</option>
              {branches.length ? <option value="BRANCH">One store</option> : null}
              {users.length ? <option value="USER">One person</option> : null}
            </select>
          </div>
          {form.level === 'BRANCH' ? (
            <div>
              <label className="label" htmlFor="pr-branch">Store</label>
              <select
                id="pr-branch"
                className="input"
                value={form.branchId}
                onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
                required
              >
                <option value="">— choose a store —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.publicId ?? b.code})
                    {b.status !== 'ACTIVE' ? ` · ${b.status.toLowerCase()}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {form.level === 'USER' ? (
            <div>
              <label className="label" htmlFor="pr-user">Person</label>
              <select
                id="pr-user"
                className="input"
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                required
              >
                <option value="">— choose a person —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} — {u.email} ({roleLabel(u.role)})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="pr-action">Action</label>
            <select
              id="pr-action"
              className="input"
              value={form.action}
              onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}
              required
            >
              <option value="">— choose an action —</option>
              {groups.map((group) => (
                <optgroup key={group} label={group}>
                  {actionChoices
                    .filter((a) => a.group === group)
                    .map((a) => (
                      <option key={a.key} value={a.key}>{a.label}</option>
                    ))}
                </optgroup>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">
              Only actions you hold yourself are offered — nobody hands out what they do not have.
            </p>
          </div>
        </>
      )}

      <div>
        <label className="label" htmlFor="pr-effect">Effect</label>
        <select
          id="pr-effect"
          className="input"
          value={form.effect}
          onChange={(e) => setForm((f) => ({ ...f, effect: e.target.value }))}
        >
          <option value="DENY">Deny</option>
          <option value="ALLOW">Allow</option>
        </select>
        <p className="mt-1 text-xs text-slate-400">
          A company-wide deny cannot be lifted by a store or person allow.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="pr-note">Note (optional)</label>
        <input
          id="pr-note"
          className="input"
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          maxLength={200}
          placeholder="Why this rule exists"
        />
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Saving…' : rule ? 'Save changes' : 'Add rule'}
      </button>
    </form>
  );
}

function GrantForm({ onDone }) {
  const [form, setForm] = useState({ email: '', reason: '', hours: 24 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/permissions/support-grants', {
        email: form.email,
        reason: form.reason,
        hours: Number(form.hours),
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
      <p className="text-sm text-slate-500">
        Gives one named VEXO operator time-boxed access to this account&rsquo;s permissions and
        support screens. It expires on its own, and you can revoke it sooner.
      </p>
      <div>
        <label className="label" htmlFor="sg-email">VEXO operator email</label>
        <input
          id="sg-email"
          type="email"
          className="input"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          required
          placeholder="support@vexo.example"
        />
      </div>
      <div>
        <label className="label" htmlFor="sg-reason">Reason</label>
        <input
          id="sg-reason"
          className="input"
          value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          required
          minLength={4}
          maxLength={200}
          placeholder="Ticket number or what they are helping with"
        />
      </div>
      <div>
        <label className="label" htmlFor="sg-hours">Window (hours)</label>
        <input
          id="sg-hours"
          type="number"
          className="input"
          value={form.hours}
          onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
          required
          min={1}
          max={168}
        />
        <p className="mt-1 text-xs text-slate-400">Up to 168 hours (one week).</p>
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Granting…' : 'Grant access'}
      </button>
    </form>
  );
}

export default function Permissions() {
  const { user: me } = useAuth();
  const { role, can } = usePermissions();
  const canReadRules = can('permission.read');
  const canWriteRules = can('permission.write');
  const canReadGrants = can('support.grant.read');
  const canWriteGrants = can('support.grant.write');
  const canReadStores = can('org.store.read');
  const canReadUsers = can('user.read');
  // A platform operator is refused by the server (consent must come from
  // inside the tenant), so the buttons are not offered to one.
  const isPlatform = role === 'POS_SUPER_ADMIN';
  const ownerAuthority = me?.role === 'CUSTOMER_OWNER' || isPlatform;

  const [catalog, setCatalog] = useState(null);
  const [rules, setRules] = useState(null);
  const [grants, setGrants] = useState(null);
  const [branches, setBranches] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {kind:'rule-create'|'rule-edit'|'rule-remove'|'grant-create'|'grant-revoke', row?}
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cat, ru, gr, br, us] = await Promise.all([
        canReadRules ? api.get('/permissions/catalog') : Promise.resolve(null),
        canReadRules ? api.get('/permissions/rules') : Promise.resolve(null),
        canReadGrants ? api.get('/permissions/support-grants') : Promise.resolve(null),
        canWriteRules && canReadStores ? api.get('/branches') : Promise.resolve(null),
        canWriteRules && canReadUsers ? api.get('/users') : Promise.resolve(null),
      ]);
      setCatalog(cat ? cat.data : { actions: [], roles: [], extensionPoints: [] });
      setRules(ru ? ru.data.rules : []);
      setGrants(gr ? gr.data.grants : []);
      setBranches(br ? br.data.branches : []);
      setUsers(us ? us.data.users : []);
    } catch (err) {
      setError(apiError(err, 'Could not load permissions'));
    }
  }, [canReadRules, canReadGrants, canWriteRules, canReadStores, canReadUsers]);

  useEffect(() => {
    load();
  }, [load]);

  const closeModal = () => setModal(null);
  const done = () => {
    closeModal();
    load();
  };

  const removeRule = async (rule) => {
    setError('');
    setBusy(true);
    try {
      await api.delete(`/permissions/rules/${rule.id}`);
      done();
    } catch (err) {
      setError(apiError(err));
      closeModal();
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = async (grant) => {
    setError('');
    setBusy(true);
    try {
      await api.post(`/permissions/support-grants/${grant.id}/revoke`);
      done();
    } catch (err) {
      setError(apiError(err));
      closeModal();
    } finally {
      setBusy(false);
    }
  };

  if (error && catalog === null && grants === null) return <ErrorNote message={error} />;
  if (catalog === null || rules === null || grants === null) return <FullScreenSpinner />;

  const actionByKey = new Map(catalog.actions.map((a) => [a.key, a]));
  // vetRule on the server refuses actions the caller does not hold and rules a
  // non-owner writes about the owner; the pickers mirror that instead of
  // offering choices that can only come back 403.
  const grantableActions = catalog.actions.filter((a) => can(a.key));
  const pickableUsers = (users ?? []).filter(
    (u) => u.id !== me?.id && (ownerAuthority || u.role !== 'CUSTOMER_OWNER'),
  );

  return (
    <div>
      <PageHeader
        title="Permissions"
        subtitle="Role baselines, the rules that narrow them, and VEXO support access. A rule can never add what a role never had."
        actions={
          canWriteRules && grantableActions.length ? (
            <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'rule-create' })}>
              <Plus className="h-4 w-4" /> Add rule
            </button>
          ) : null
        }
      />

      <ErrorNote message={error} />

      {canReadRules ? (
        <>
          <RoleBaseline roles={catalog.roles} actions={catalog.actions} />

          <div className="mb-3 mt-8 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-bold text-pos-ink">Rules</h2>
              <p className="text-sm text-slate-500">
                The most specific rule wins: a person rule beats a store rule beats a company rule.
              </p>
            </div>
          </div>

          {rules.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No rules yet"
              note="Every role runs on its baseline until a rule narrows it — or switches on an off-by-default action."
            />
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Applies to</th>
                    <th className="px-4 py-3 font-semibold">Action</th>
                    <th className="px-4 py-3 font-semibold">Effect</th>
                    <th className="px-4 py-3 font-semibold">Note</th>
                    <th className="px-4 py-3 font-semibold">Updated</th>
                    <th className="px-4 py-3 font-semibold" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-pos-ink">{ruleTarget(rule)}</div>
                        <div className="text-xs text-slate-400">{LEVEL_CAPTIONS[rule.level]}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-600">{actionByKey.get(rule.action)?.label ?? rule.action}</div>
                        <div className="font-mono text-xs text-slate-400">{rule.action}</div>
                      </td>
                      <td className="px-4 py-3"><EffectBadge effect={rule.effect} /></td>
                      <td className="px-4 py-3 text-slate-600">{rule.note || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{fmtDateTime(rule.updatedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        {canWriteRules ? (
                          <div className="flex justify-end gap-3">
                            <button
                              type="button"
                              className="text-xs font-semibold text-pos-royal hover:underline"
                              onClick={() => setModal({ kind: 'rule-edit', row: rule })}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="text-xs font-semibold text-slate-500 hover:underline"
                              onClick={() => setModal({ kind: 'rule-remove', row: rule })}
                            >
                              Remove
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
        </>
      ) : null}

      {canReadGrants ? (
        <>
          <div className="mb-3 mt-8 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-bold text-pos-ink">VEXO support access</h2>
              <p className="text-sm text-slate-500">
                {isPlatform
                  ? 'Only someone inside this account can grant or revoke VEXO support access.'
                  : 'VEXO staff cannot change this account’s permissions unless someone here grants a window.'}
              </p>
            </div>
            {canWriteGrants && !isPlatform ? (
              <button type="button" className="btn-orange" onClick={() => setModal({ kind: 'grant-create' })}>
                <Plus className="h-4 w-4" /> Grant access
              </button>
            ) : null}
          </div>

          {grants.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              title="No support access has been granted"
              note="When VEXO support needs to act inside this account, grant their named operator a time-boxed window here."
            />
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Operator</th>
                    <th className="px-4 py-3 font-semibold">Reason</th>
                    <th className="px-4 py-3 font-semibold">Granted by</th>
                    <th className="px-4 py-3 font-semibold">Window</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {grants.map((g) => (
                    <tr key={g.id}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-pos-ink">{g.operatorName ?? '—'}</div>
                        <div className="text-xs text-slate-400">{g.operatorEmail ?? '—'}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{g.reason}</td>
                      <td className="px-4 py-3 text-slate-600">{g.grantedByEmail ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">
                        <div>{fmtDateTime(g.grantedAt)}</div>
                        <div className="text-xs text-slate-400">
                          {g.revokedAt ? `revoked ${fmtDateTime(g.revokedAt)}` : `until ${fmtDateTime(g.expiresAt)}`}
                        </div>
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={grantStatus(g)} /></td>
                      <td className="px-4 py-3 text-right">
                        {g.active && canWriteGrants && !isPlatform ? (
                          <button
                            type="button"
                            className="text-xs font-semibold text-slate-500 hover:underline"
                            onClick={() => setModal({ kind: 'grant-revoke', row: g })}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {canReadRules && catalog.extensionPoints.length ? (
        <div className="mt-8">
          <h2 className="mb-3 text-lg font-bold text-pos-ink">Coming with later modules</h2>
          <div className="card p-5">
            <ul className="space-y-2">
              {catalog.extensionPoints.map((ep) => (
                <li key={ep.module} className="flex flex-wrap items-center gap-2 text-sm">
                  <Puzzle className="h-4 w-4 shrink-0 text-slate-300" />
                  <span className="font-semibold text-pos-ink">{ep.module}</span>
                  <span className="badge bg-slate-100 text-slate-500">not available yet</span>
                  <span className="min-w-0 flex-1 text-slate-500">{ep.note}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-400">
              These modules will register their own permissions when they arrive. Nothing here is
              configurable yet, and nothing pretends to be.
            </p>
          </div>
        </div>
      ) : null}

      <Modal open={modal?.kind === 'rule-create'} title="Add rule" onClose={closeModal}>
        {modal?.kind === 'rule-create' ? (
          <RuleForm actions={grantableActions} branches={branches ?? []} users={pickableUsers} onDone={done} />
        ) : null}
      </Modal>
      <Modal open={modal?.kind === 'rule-edit'} title="Edit rule" onClose={closeModal}>
        {modal?.kind === 'rule-edit' ? (
          <RuleForm
            rule={modal.row}
            actions={grantableActions.some((a) => a.key === modal.row.action)
              ? grantableActions
              : [...grantableActions, actionByKey.get(modal.row.action) ?? { key: modal.row.action, label: modal.row.action, group: 'Other', scope: 'COMPANY' }]}
            branches={branches ?? []}
            users={pickableUsers}
            onDone={done}
          />
        ) : null}
      </Modal>
      <Modal open={modal?.kind === 'rule-remove'} title="Remove rule" onClose={closeModal}>
        {modal?.kind === 'rule-remove' ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              Removing this rule reverts{' '}
              <span className="font-semibold text-pos-ink">{ruleTarget(modal.row)}</span> to the role
              baseline for{' '}
              <span className="font-semibold text-pos-ink">
                {actionByKey.get(modal.row.action)?.label ?? modal.row.action}
              </span>
              {' '}— which may be looser or stricter than the rule was.
            </p>
            <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => removeRule(modal.row)}>
              {busy ? 'Removing…' : 'Remove rule'}
            </button>
          </div>
        ) : null}
      </Modal>

      <Modal open={modal?.kind === 'grant-create'} title="Grant VEXO support access" onClose={closeModal}>
        {modal?.kind === 'grant-create' ? <GrantForm onDone={done} /> : null}
      </Modal>
      <Modal open={modal?.kind === 'grant-revoke'} title="Revoke support access" onClose={closeModal}>
        {modal?.kind === 'grant-revoke' ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              Ends <span className="font-semibold text-pos-ink">{modal.row.operatorEmail}</span>&rsquo;s
              access now instead of at {fmtDateTime(modal.row.expiresAt)}. They keep nothing.
            </p>
            <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => revokeGrant(modal.row)}>
              {busy ? 'Revoking…' : 'Revoke access'}
            </button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
