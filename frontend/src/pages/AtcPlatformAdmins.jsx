import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, MailPlus, Plus, UserCog } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import {
  PageHeader,
  StatCard,
  StatusBadge,
  ErrorNote,
  Modal,
  EmptyState,
  FullScreenSpinner,
} from '../components/ui.jsx';

// The console that administers the console.
//
// Three things about it are load-bearing enough to say out loud on the page
// itself, because an administrator who does not know them will eventually try
// to do one of them and read the refusal as a bug:
//
//   1. New administrators arrive by invitation. There is no "create with a
//      password" here, and no promotion of an existing tenant account — a
//      mailbox alone must never become ownership of the platform.
//   2. The last active administrator cannot be disabled. Nothing left in the
//      product could undo it.
//   3. Disabling one ends their live sessions immediately.

const fmt = (v) => (v ? new Date(v).toLocaleString() : '—');

function InviteForm({ onDone }) {
  const [form, setForm] = useState({ fullName: '', email: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post('/atc/platform-admins', form);
      onDone(data.invitation);
    } catch (err) {
      setError(apiError(err, 'Could not send the invitation'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="pa-name">Full name</label>
        <input id="pa-name" className="input" value={form.fullName} onChange={set('fullName')} required minLength={2} />
      </div>
      <div>
        <label className="label" htmlFor="pa-email">Work email</label>
        <input id="pa-email" type="email" className="input" value={form.email} onChange={set('email')} required />
        <p className="mt-1 text-xs text-slate-500">
          They receive a sign-up link at this address and choose their own password. Nobody here ever
          sees it, and no password is ever emailed.
        </p>
      </div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        A platform administrator can create customer companies, issue licences, reach every tenant
        console and appoint further administrators. Invite only people who should hold all of that.
      </div>
      <ErrorNote message={error} />
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? 'Sending…' : 'Send invitation'}
      </button>
    </form>
  );
}

export default function AtcPlatformAdmins() {
  const { user } = useAuth();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/atc/platform-admins');
      setState(data);
    } catch (err) {
      setError(apiError(err, 'Could not load platform administrators'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (admin, status) => {
    setError('');
    setBusyId(admin.id);
    try {
      await api.patch(`/atc/platform-admins/${admin.id}/status`, { status });
      toast(
        status === 'ACTIVE'
          ? `${admin.email} re-enabled`
          : `${admin.email} disabled — any signed-in sessions have been ended`,
        'success',
      );
      await load();
    } catch (err) {
      // Shown as an error note rather than swallowed: the two refusals this
      // call can return — "last active administrator" and "not your own
      // account" — are the whole point of the screen, and both are worth
      // reading in full.
      setError(apiError(err, 'Could not change that account'));
    } finally {
      setBusyId('');
    }
  };

  if (error && state === null) return <ErrorNote message={error} />;
  if (state === null) return <FullScreenSpinner />;

  const { admins, invitations, activeCount } = state;
  const pending = invitations.filter((i) => i.status === 'PENDING');

  return (
    <div>
      <PageHeader
        title="Platform administrators"
        subtitle="The accounts that own this console. Created by invitation or by the bootstrap script — never by registering an email."
        actions={
          <button type="button" className="btn-orange" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Invite administrator
          </button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={ShieldCheck}
          label="Active administrators"
          value={activeCount}
          hint={activeCount === 1 ? 'Only one — invite a second' : 'Enough to recover from a lockout'}
          accent={activeCount === 1 ? 'orange' : 'green'}
        />
        <StatCard
          icon={MailPlus}
          label="Invitations open"
          value={pending.length}
          hint={pending.length ? 'Awaiting acceptance' : 'None outstanding'}
          accent="royal"
        />
        <StatCard
          icon={UserCog}
          label="Accounts on record"
          value={admins.length}
          hint="Including disabled — history is kept"
          accent="slate"
        />
      </div>

      {activeCount === 1 ? (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <span className="font-semibold">This platform has one active administrator.</span>{' '}
            If that account is lost there is no screen left that can create companies, issue licences
            or restore access — recovery would mean direct database work. Invite a second one.
          </div>
        </div>
      ) : null}

      <ErrorNote message={error} />

      <div className="card mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3 font-semibold">Administrator</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">Email verified</th>
              <th className="px-4 py-3 font-semibold">Last sign-in</th>
              <th className="px-4 py-3 font-semibold" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {admins.map((a) => {
              const isSelf = a.id === user.id;
              // Greyed for exactly the reasons the server refuses, so the
              // screen never offers a button that is certain to fail.
              const lastActive = a.status === 'ACTIVE' && activeCount <= 1;
              const blocked = a.status === 'ACTIVE' && (lastActive || isSelf);
              const why = lastActive
                ? 'The last active administrator cannot be disabled'
                : isSelf
                  ? 'You cannot disable your own account'
                  : '';
              return (
                <tr key={a.id} className="hover:bg-pos-surface/60">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-pos-ink">{a.fullName}</span>
                      {isSelf ? <span className="badge bg-pos-royal/10 text-pos-royal">YOU</span> : null}
                    </div>
                    <div className="text-xs text-slate-400">{a.email}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                  <td className="px-4 py-3 text-xs text-slate-600">{fmt(a.emailVerifiedAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{fmt(a.lastLoginAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {a.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        title={why}
                        className="text-xs font-semibold text-red-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
                        disabled={blocked || busyId === a.id}
                        onClick={() => setStatus(a, 'DISABLED')}
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-xs font-semibold text-pos-royal hover:underline disabled:text-slate-300"
                        disabled={busyId === a.id}
                        onClick={() => setStatus(a, 'ACTIVE')}
                      >
                        Re-enable
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Invitations</h2>
      {invitations.length === 0 ? (
        <EmptyState icon={MailPlus} title="No invitations yet" note="Invited administrators appear here until they accept." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Invited</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Expires</th>
                <th className="px-4 py-3 font-semibold">Sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invitations.map((i) => (
                <tr key={i.id} className="hover:bg-pos-surface/60">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-pos-ink">{i.fullName}</div>
                    <div className="text-xs text-slate-400">{i.email}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={i.status} /></td>
                  <td className="px-4 py-3 text-xs text-slate-600">{fmt(i.expiresAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {i.sentCount}× · last {fmt(i.lastSentAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} title="Invite a platform administrator" onClose={() => setOpen(false)}>
        <InviteForm
          onDone={(invitation) => {
            setOpen(false);
            toast(`Invitation sent to ${invitation.email}`, 'success');
            load();
          }}
        />
      </Modal>
    </div>
  );
}
