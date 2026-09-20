import { X } from 'lucide-react';

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
};

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

export function DemoBadge() {
  return <span className="badge bg-pos-orange/15 text-pos-ember">DEMO</span>;
}

export function RoleBadge({ role }) {
  const labels = {
    POS_SUPER_ADMIN: 'ATC Admin',
    CUSTOMER_OWNER: 'Owner',
    BRANCH_MANAGER: 'Branch Manager',
    CASHIER: 'Cashier',
  };
  return <span className="badge bg-pos-royal/10 text-pos-royal">{labels[role] || role}</span>;
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

export function TempPasswordReveal({ credential }) {
  if (!credential) return null;
  return (
    <div className="rounded-lg border border-pos-orange/40 bg-pos-orange/10 p-4">
      <div className="text-xs font-bold uppercase tracking-wide text-pos-ember">
        Temporary password — shown only once
      </div>
      <div className="mt-2 font-mono text-sm text-pos-ink">
        <div>{credential.email}</div>
        <div className="mt-1 select-all text-base font-bold">{credential.tempPassword}</div>
      </div>
      <div className="mt-2 text-xs text-slate-600">
        Share it securely. The user must change it at first sign-in; it is not stored anywhere else.
      </div>
    </div>
  );
}
