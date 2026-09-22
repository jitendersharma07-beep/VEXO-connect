import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Armchair,
  BadgeCheck,
  BarChart3,
  Building2,
  CalendarCheck,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Package,
  ReceiptText,
  ShieldCheck,
  ShoppingCart,
  Store,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import api, { apiError } from '../lib/api.js';
import { canSeeReports, canSell, canWriteTables, clearAtcScope, fmtDate, getAtcScope } from '../lib/pos.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import { Logo } from './Logo.jsx';
import { DemoBadge, ErrorNote, Modal, RoleBadge, StatusBadge } from './ui.jsx';

function NavItem({ to, icon: Icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
          isActive ? 'bg-white/10 text-white' : 'text-blue-200 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      <Icon className="h-5 w-5" />
      {label}
    </NavLink>
  );
}

function ChangePasswordModal({ open, onClose, forced }) {
  const { refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setDone(true);
      await refresh();
      setTimeout(onClose, 900);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={forced ? 'Set a new password' : 'Change password'} onClose={onClose}>
      {forced ? (
        <p className="mb-4 text-sm text-slate-500">
          You signed in with a temporary password. Please set your own before continuing.
        </p>
      ) : null}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="currentPassword">Current password</label>
          <input
            id="currentPassword"
            type="password"
            className="input"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        <div>
          <label className="label" htmlFor="newPassword">New password (min 8 characters)</label>
          <input
            id="newPassword"
            type="password"
            className="input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </div>
        <ErrorNote message={error} />
        {done ? <div className="text-sm font-semibold text-emerald-600">Password updated.</div> : null}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Update password'}
        </button>
      </form>
    </Modal>
  );
}

export default function Layout() {
  const { user, company, branch, license, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [pwOpen, setPwOpen] = useState(false);

  const isAtc = user.role === 'POS_SUPER_ADMIN';
  const isOwner = user.role === 'CUSTOMER_OWNER';
  // Read on every render — navigation re-renders the layout after the ATC
  // console sets/clears the scope.
  const atcScope = isAtc ? getAtcScope() : null;

  const doLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const exitAtcScope = () => {
    clearAtcScope();
    navigate('/atc/companies');
  };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 flex-col bg-pos-deep px-4 py-5 md:flex">
        <Logo dark className="px-2" />
        <nav className="mt-8 flex-1 space-y-1">
          {isAtc ? (
            <>
              <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
                VEXO Console
              </div>
              <NavItem to="/atc/companies" icon={Building2} label="Companies" />
              {atcScope ? (
                <>
                  <div className="mt-4 flex items-center justify-between px-3 pb-1">
                    <span className="truncate text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
                      POS · {atcScope.name || 'company'}
                    </span>
                    <button
                      type="button"
                      className="rounded p-0.5 text-blue-300/60 hover:bg-white/10 hover:text-white"
                      title="Exit company view"
                      onClick={exitAtcScope}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <NavItem to="/orders" icon={ReceiptText} label="Orders" />
                  <NavItem to="/catalog" icon={Package} label="Catalog" />
                  <NavItem to="/tables" icon={Armchair} label="Tables" />
                  <NavItem to="/reports" icon={BarChart3} label="Sales report" end />
                  <NavItem to="/reports/reconciliation" icon={ListChecks} label="Reconciliation" />
                  <NavItem to="/reports/day-close" icon={CalendarCheck} label="Daily closing" />
                </>
              ) : null}
            </>
          ) : (
            <>
              {canSell(user) ? (
                <>
                  <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
                    Point of Sale
                  </div>
                  <NavItem to="/sell" icon={ShoppingCart} label="Sell" />
                  <NavItem to="/orders" icon={ReceiptText} label="Orders" />
                  {canWriteTables(user) ? <NavItem to="/tables" icon={Armchair} label="Tables" /> : null}
                  {isOwner ? <NavItem to="/catalog" icon={Package} label="Catalog" /> : null}
                  {canSeeReports(user) ? (
                    <>
                      <NavItem to="/reports" icon={BarChart3} label="Sales report" end />
                      <NavItem to="/reports/reconciliation" icon={ListChecks} label="Reconciliation" />
                      <NavItem to="/reports/day-close" icon={CalendarCheck} label="Daily closing" />
                    </>
                  ) : null}
                  <div className="mt-4 px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
                    Manage
                  </div>
                </>
              ) : null}
              <NavItem to="/dashboard" icon={LayoutDashboard} label="Dashboard" end />
              <NavItem to="/branches" icon={Store} label="Branches" />
              {isOwner ? <NavItem to="/team" icon={Users} label="Team" /> : null}
              {isOwner ? <NavItem to="/licence" icon={BadgeCheck} label="Licence" /> : null}
            </>
          )}
        </nav>
        <div className="rounded-lg bg-white/5 p-3 text-[11px] leading-relaxed text-blue-200">
          <div className="flex items-center gap-1.5 font-bold text-white">
            <ShieldCheck className="h-3.5 w-3.5 text-pos-orange" /> VEXO Connect
          </div>
          {/* States the rule, never a count. Both channels coexist, so any
              sentence beginning "all payments..." is wrong the moment one
              order is settled the other way. */}
          Every payment shows how it was taken — recorded by staff, or confirmed by the payment
          provider.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="md:hidden">
                <Logo />
              </div>
              <div className="hidden min-w-0 md:block">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-bold text-pos-ink">
                    {isAtc ? 'VEXO Platform Console' : company?.name}
                  </span>
                  {company?.isDemo ? <DemoBadge /> : null}
                  {branch ? (
                    <span className="badge bg-slate-100 text-slate-600">{branch.code}</span>
                  ) : null}
                </div>
                {!isAtc && license ? (
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-semibold">{license.plan?.replace('_', ' ')}</span>
                    <StatusBadge status={license.status} />
                    {license.expiresAt ? (
                      <span>until {fmtDate(license.expiresAt)}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden text-right sm:block">
                <div className="text-sm font-semibold text-pos-ink">{user.fullName}</div>
                <RoleBadge role={user.role} />
              </div>
              <button type="button" onClick={() => setPwOpen(true)} className="btn-ghost" title="Change password">
                <KeyRound className="h-4 w-4" />
              </button>
              <button type="button" onClick={doLogout} className="btn-ghost" title="Sign out">
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </div>
          {user.mustChangePassword ? (
            <div className="border-t border-pos-orange/30 bg-pos-orange/10 px-4 py-2 text-sm text-pos-ember md:px-6">
              You are using a temporary password.{' '}
              <button type="button" className="font-bold underline" onClick={() => setPwOpen(true)}>
                Set a new one now
              </button>
              .
            </div>
          ) : null}
        </header>

        <main className="flex-1 px-4 py-6 md:px-6">
          {/* Keyed on the path so the boundary RESETS when the user navigates.
              Without the key an error latches: React keeps the errored state,
              so every subsequent screen shows the same message and the only
              escape is a full reload. The key is what makes "Go to Orders"
              actually work. Inside <main>, so the nav survives the crash. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        <footer className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-400 md:px-6">
          VEXO Connect · a product of ATC Infocom Solutions Pvt. Ltd.
        </footer>
      </div>

      <ChangePasswordModal open={pwOpen || user.mustChangePassword} onClose={() => setPwOpen(false)} forced={user.mustChangePassword} />
    </div>
  );
}
