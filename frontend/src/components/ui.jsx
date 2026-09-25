import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { roleLabel } from '../lib/roles.js';
import { digitsPhrase } from '../lib/pos.js';

export function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-pos-surface">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-pos-ink">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({ icon: Icon, label, value, hint, accent = 'royal' }) {
  const accents = {
    royal: 'bg-pos-royal/10 text-pos-royal',
    orange: 'bg-pos-orange/10 text-pos-ember',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    slate: 'bg-slate-100 text-slate-600',
  };
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
          <div className="mt-2 text-3xl font-extrabold tracking-tight text-pos-ink">{value}</div>
          {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
        </div>
        {Icon ? (
          <div className={`rounded-lg p-2.5 ${accents[accent]}`}>
            <Icon className="h-5 w-5" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const STATUS_STYLES = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  PENDING: 'bg-amber-100 text-amber-700',
  SUSPENDED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-200 text-slate-600',
  EXPIRED: 'bg-red-100 text-red-700',
  CLOSED: 'bg-slate-200 text-slate-600',
  DISABLED: 'bg-slate-200 text-slate-600',
  // LANE foundation — both are deliberate administrative states, so they read
  // like CLOSED rather than like a fault. Red is for something that broke.
  ARCHIVED: 'bg-slate-200 text-slate-600',
  REVOKED: 'bg-slate-200 text-slate-600',
};

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

export function DemoBadge() {
  return <span className="badge bg-pos-orange/15 text-pos-ember">DEMO</span>;
}

// LANE foundation — the label map moved to lib/permissions.jsx when the role
// set grew to thirteen, so the badge and every role picker read one list.
export function RoleBadge({ role }) {
  return <span className="badge bg-pos-royal/10 text-pos-royal">{roleLabel(role)}</span>;
}

export function ErrorNote({ message }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>
  );
}

export function Modal({ open, title, onClose, children, wide = false }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-pos-ink/40 p-4" onMouseDown={onClose}>
      <div
        className={`card w-full ${wide ? 'max-w-2xl' : 'max-w-md'} p-6`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-pos-ink">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, note }) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon ? <Icon className="mb-3 h-10 w-10 text-slate-300" /> : null}
      <div className="text-sm font-semibold text-slate-600">{title}</div>
      {note ? <div className="mt-1 max-w-sm text-xs text-slate-400">{note}</div> : null}
    </div>
  );
}

// Generic "type a reason" modal for audited manager actions (item void, order
// void — contract §5.3). onSubmit may throw; the server's error.message is
// shown inline.
export function ReasonModal({ open, title, hint, busyLabel = 'Confirm', onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setError('');
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={title} onClose={onClose}>
      {hint ? <p className="mb-3 text-sm text-slate-500">{hint}</p> : null}
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="reason-field">Reason (required)</label>
          <textarea
            id="reason-field"
            className="input min-h-[80px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            autoFocus
          />
        </div>
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary w-full" disabled={busy || reason.trim().length < 3}>
          {busy ? 'Working…' : busyLabel}
        </button>
      </form>
    </Modal>
  );
}

// What an administrator sees after creating an account or resetting a
// password: confirmation that a code is on its way to the person, and never a
// credential.
//
// This replaced a TempPasswordReveal panel that printed the new password on
// screen for the creator to "share securely" — which meant every staff
// account began life with a credential known to two people and travelling by
// whatever channel came to hand, and put a password on a screen that gets
// screenshotted. Nothing to reveal is the point; there is no plaintext
// anywhere to put here.
export function CodeSentNote({ outcome }) {
  if (!outcome) return null;
  const { sent, sentTo, expiresInMinutes, codeLength } = outcome;
  return sent ? (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Code sent</div>
      <div className="mt-2 text-sm text-emerald-900">
        {digitsPhrase(codeLength, { capital: true })} code is on its way to{' '}
        <span className="font-semibold">{sentTo}</span>.
        The link in that email takes them straight to the box they type it into.
      </div>
      <div className="mt-2 text-xs text-emerald-800">
        It is valid for {expiresInMinutes} minutes. They choose their own password — nobody else,
        here or at VEXO Connect, ever sees it. If it expires, use this button again.
      </div>
    </div>
  ) : (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-amber-800">
        Email not delivered
      </div>
      <div className="mt-2 text-sm text-amber-900">
        The account is in place, but the code could not be sent to{' '}
        <span className="font-semibold">{sentTo}</span>
        {outcome.reason === 'throttled' ? ' — one was sent very recently.' : '.'}
      </div>
      <div className="mt-2 text-xs text-amber-800">
        They can get in themselves with “Forgot password?” on the sign-in page, or you can try
        again in a minute.
      </div>
    </div>
  );
}
