import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Armchair,
  BadgeCheck,
  BadgePercent,
  BarChart3,
  Boxes,
  Building2,
  CalendarCheck,
  CalendarClock,
  ChefHat,
  ClipboardCheck,
  CookingPot,
  KeyRound,
  Landmark,
  Layers,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Map,
  Menu,
  MonitorSmartphone,
  Package,
  PackagePlus,
  PhoneCall,
  ReceiptText,
  ScrollText,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tags,
  TrendingUp,
  Truck,
  Users,
  Warehouse,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import api, { apiError } from '../lib/api.js';
import { usePermissions } from '../lib/permissions.jsx';
import { canSeeReports, canSell, canWriteTables, clearAtcScope, fmtDate, getAtcScope, isManagerUp } from '../lib/pos.js';
import { canUseInventory } from '../lib/inventory.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import { Logo } from './Logo.jsx';
import { DemoBadge, ErrorNote, Modal, RoleBadge, StatusBadge } from './ui.jsx';

// min-h-[44px]: these were the last controls in the app still under the WCAG
// 2.5.5 floor (208x40). The sidebar is the one surface a manager uses on a
// tablet while standing, so it gets the same floor as the till screen.
function NavItem({ to, icon: Icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${
          isActive ? 'bg-white/10 text-white' : 'text-blue-200 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      {label}
    </NavLink>
  );
}

// The ONE definition of the navigation tree.
//
// It is rendered twice — in the md+ sidebar and in the below-md drawer — and
// that is exactly why it is a component rather than copied markup. Every
// branch below is a permission decision (canSell, canSeeReports, isOwner,
// atcScope). A second hand-maintained copy would drift, and the way it drifts
// is that the drawer shows a cashier the owner's links. Render this; never
// retype it.
function SidebarBody({ user, license, isAtc, isOwner, atcScope, onExitAtcScope }) {
  const { can, canAny } = usePermissions();
  // LANE foundation — the organisation group, shown by held ACTION so the
  // list matches what the server will actually answer: Finance reaches Legal
  // & GST, a store manager reaches Brands, and a scoped VEXO operator sees
  // the group inside the company they are looking at. Computed once, rendered
  // in whichever branch below applies; no action held — no heading either.
  const orgLinks = [
    canAny('org.legalEntity.read', 'org.gst.read') ? (
      <NavItem key="organisation" to="/organisation" icon={Landmark} label="Legal & GST" />
    ) : null,
    can('org.brand.read') ? <NavItem key="brands" to="/brands" icon={Tags} label="Brands" /> : null,
    can('org.region.read') ? <NavItem key="regions" to="/regions" icon={Map} label="Regions" /> : null,
    canAny('terminal.read', 'device.read') ? (
      <NavItem key="devices" to="/devices" icon={MonitorSmartphone} label="Tills & devices" />
    ) : null,
  ].filter(Boolean);
  // LANE reporting — the multi-location report centre, by held action rather
  // than by the role list the legacy /reports links use. FINANCE, REGIONAL_MANAGER
  // and AUDITOR hold report.*.read and are refused by that role list, so they
  // would otherwise have permissions with nowhere to use them.
  const reportingLinks = [
    can('report.dashboard.read') ? (
      <NavItem key="hq" to="/reporting" icon={Building2} label="Consolidated" end />
    ) : null,
    canAny(
      'report.sales.read',
      'report.tax.read',
      'report.payments.read',
      'report.inventory.read',
      'report.dashboard.read',
    ) ? (
      <NavItem key="reports" to="/reporting/reports" icon={BarChart3} label="All reports" />
    ) : null,
    can('report.exception.read') ? (
      <NavItem key="exceptions" to="/reporting/exceptions" icon={ShieldAlert} label="Exceptions" />
    ) : null,
    can('report.schedule.read') ? (
      <NavItem key="schedules" to="/reporting/schedules" icon={Send} label="Scheduled reports" />
    ) : null,
    can('report.settings.read') ? (
      <NavItem key="periods" to="/reporting/settings" icon={CalendarClock} label="Reporting periods" />
    ) : null,
  ].filter(Boolean);
  const reportingGroup = reportingLinks.length ? (
    <>
      <div className="mt-4 px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
        Reporting
      </div>
      {reportingLinks}
    </>
  ) : null;
  const orgGroup = orgLinks.length ? (
    <>
      <div className="mt-4 px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
        Organisation
      </div>
      {orgLinks}
    </>
  ) : null;
  return (
    <nav className="mt-8 flex-1 space-y-1 overflow-y-auto">
      {isAtc ? (
        <>
          <div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
            VEXO Console
          </div>
          <NavItem to="/atc/companies" icon={Building2} label="Companies" />
          {/* LANE accounts — the accounts that own this console. Sits beside
              Companies rather than under one, because it belongs to no tenant. */}
          <NavItem to="/atc/platform-admins" icon={ShieldCheck} label="Administrators" />
          {atcScope ? (
            <>
              <div className="mt-4 flex items-center justify-between gap-1 px-3 pb-1">
                <span className="truncate text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
                  POS · {atcScope.name || 'company'}
                </span>
                <button
                  type="button"
                  className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded text-blue-300/60 hover:bg-white/10 hover:text-white"
                  title="Exit company view"
                  aria-label="Exit company view"
                  onClick={onExitAtcScope}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <NavItem to="/orders" icon={ReceiptText} label="Orders" />
              <NavItem to="/catalog" icon={Package} label="Catalog" />
              <NavItem to="/tables" icon={Armchair} label="Tables" />
              <NavItem to="/reports" icon={BarChart3} label="Sales report" end />
              <NavItem to="/reports/menu-profitability" icon={TrendingUp} label="Menu profitability" />
              <NavItem to="/reports/activity" icon={ScrollText} label="Discounts & voids" />
              <NavItem to="/reports/reconciliation" icon={ListChecks} label="Reconciliation" />
              <NavItem to="/reports/day-close" icon={CalendarCheck} label="Daily closing" />
              {reportingGroup}
              {orgGroup}
              {/* A scoped VEXO operator holds user.read inside the tenant;
                  the grant-gated links appear only while a grant is live. */}
              {can('user.read') ? <NavItem to="/team" icon={Users} label="Team" /> : null}
              {canAny('permission.read', 'support.grant.read') ? (
                <NavItem to="/permissions" icon={ShieldCheck} label="Permissions" />
              ) : null}
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
              {/* VC-104: managers and owners only — the same role set the
                  server's rolesFor('phone.*') admits. Cashiers get no link;
                  the route guard and the API refuse them anyway. */}
              {isManagerUp(user) ? (
                <NavItem to="/phone-orders" icon={PhoneCall} label="Phone orders" />
              ) : null}
              {canWriteTables(user) ? <NavItem to="/tables" icon={Armchair} label="Tables" /> : null}
              {isOwner ? <NavItem to="/catalog" icon={Package} label="Catalog" /> : null}
              {canSeeReports(user) ? (
                <>
                  <NavItem to="/reports" icon={BarChart3} label="Sales report" end />
                  <NavItem to="/reports/menu-profitability" icon={TrendingUp} label="Menu profitability" />
                  <NavItem to="/reports/activity" icon={ScrollText} label="Discounts & voids" />
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
          {/* The server refuses GET /branches to till-only roles; a link that
              opens onto a refusal is worse than no link. */}
          {can('org.store.read') ? <NavItem to="/branches" icon={Store} label="Branches" /> : null}
          {/* LANE foundation — by held action, not owner: the server admits
              any user.read holder to GET /users, and the permission screen
              admits readers of either of its halves. */}
          {can('user.read') ? <NavItem to="/team" icon={Users} label="Team" /> : null}
          {canAny('permission.read', 'support.grant.read') ? (
            <NavItem to="/permissions" icon={ShieldCheck} label="Permissions" />
          ) : null}
          {isOwner ? <NavItem to="/discounts" icon={BadgePercent} label="Discounts" /> : null}
          {isOwner ? <NavItem to="/licence" icon={BadgeCheck} label="Licence" /> : null}
          {/* ==== LANE inventory ==== (spec Part B §8)
              One condition for the whole section, matching the route gate in
              App.jsx and the server's INVENTORY_ACTIONS map. Setup is listed
              for a manager too: it is where they see which stock location
              their own sales come out of, and every control on it is the
              owner's and refused server-side for anyone else.

              Note these are links, not permissions. Removing one hides a
              screen; it does not close an endpoint.

              The licence is part of the condition now, not only the role: a
              company whose licence does not include the INVENTORY module is
              refused at the API with POS_MODULE_NOT_LICENSED whatever the
              role, so showing the section would be showing twelve screens that
              can only fill with the same refusal. Typing the URL still reaches
              the route — the route gate is roles, as it was — and the screen
              then shows the server's own sentence about the licence, which is
              the accurate one. */}
          {canUseInventory(user, license) ? (
            <>
              <div className="mt-4 px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-blue-300/60">
                Inventory
              </div>
              <NavItem to="/inventory" icon={Boxes} label="Overview" end />
              <NavItem to="/inventory/stock" icon={Warehouse} label="Stock on hand" />
              <NavItem to="/inventory/batches" icon={Layers} label="Batches & expiry" />
              <NavItem to="/inventory/requests" icon={ClipboardCheck} label="Store requests" />
              <NavItem to="/inventory/transfers" icon={Truck} label="Transfers" />
              <NavItem to="/inventory/planning" icon={CalendarClock} label="Planning & reminders" />
              <NavItem to="/inventory/receiving" icon={PackagePlus} label="Receiving" />
              <NavItem to="/inventory/adjustments" icon={ListChecks} label="Counts & wastage" />
              <NavItem to="/inventory/recipes" icon={ChefHat} label="Recipes & food cost" />
              <NavItem to="/inventory/production" icon={CookingPot} label="Central kitchen" />
              <NavItem to="/inventory/ledger" icon={ScrollText} label="Stock ledger" />
              <NavItem to="/inventory/setup" icon={Settings2} label="Inventory setup" />
            </>
          ) : null}
          {/* ==== /LANE inventory ==== */}
          {reportingGroup}
          {orgGroup}
        </>
      )}
    </nav>
  );
}

// The payment-channel note. Rendered beside the nav in both mounts so the
// drawer carries the same standing statement the sidebar does.
function SidebarNote() {
  return (
    <div className="mt-4 shrink-0 rounded-lg bg-white/5 p-3 text-[11px] leading-relaxed text-blue-200">
      <div className="flex items-center gap-1.5 font-bold text-white">
        <ShieldCheck className="h-3.5 w-3.5 text-pos-orange" /> VEXO Connect
      </div>
      {/* States the rule, never a count. Both channels coexist, so any
          sentence beginning "all payments..." is wrong the moment one
          order is settled the other way. */}
      Every payment shows how it was taken — recorded by staff, or confirmed by the payment
      provider.
    </div>
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
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer whenever the route changes. Without this, tapping a link
  // navigates the page underneath and leaves the drawer covering it, which
  // reads as "the tap did nothing" and invites a second tap.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Escape closes it too — and if the viewport grows past md the drawer must
  // go, or it sits on top of the sidebar that just reappeared.
  useEffect(() => {
    if (!navOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    const mq = window.matchMedia('(min-width: 768px)');
    const onWide = (e) => {
      if (e.matches) setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    mq.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onWide);
    };
  }, [navOpen]);

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

  // license travels with user: the inventory section is gated on the module
  // being licensed as well as on the role, and both sidebars render the same
  // SidebarBody, so passing it here is what keeps the drawer and the sidebar
  // from disagreeing about what exists.
  const navProps = { user, license, isAtc, isOwner, atcScope, onExitAtcScope: exitAtcScope };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 flex-col bg-pos-deep px-4 py-5 md:flex">
        <Logo dark className="px-2" />
        <SidebarBody {...navProps} />
        <SidebarNote />
      </aside>

      {/* Below md the sidebar is hidden, and until now nothing replaced it:
          on a phone-width screen the operator had no way to leave the page
          they landed on. This drawer is that replacement. It renders the same
          SidebarBody the sidebar does, so it cannot show a link the user's
          role would not have been given. */}
      {navOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default bg-pos-deep/60 backdrop-blur-sm"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-pos-deep px-4 py-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-2">
              <Logo dark className="px-2" />
              <button
                type="button"
                className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-blue-200 hover:bg-white/10 hover:text-white"
                aria-label="Close navigation"
                onClick={() => setNavOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <SidebarBody {...navProps} />
            <SidebarNote />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden"
                aria-label="Open navigation"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(true)}
              >
                <Menu className="h-6 w-6" />
              </button>
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
            {/* lg, not sm. At exactly 768px the sidebar has just appeared and
                the company block with it, so the old sm: breakpoints put the
                user's name and the word "Sign out" into a bar that no longer
                had room: the company name truncated to "Brew Stree…" and the
                button wrapped onto two lines. Both are decoration — the name
                is on every screen the user opens and the button keeps its
                icon, its title and its aria-label. */}
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden text-right lg:block">
                <div className="text-sm font-semibold text-pos-ink">{user.fullName}</div>
                <RoleBadge role={user.role} />
              </div>
              <button
                type="button"
                onClick={() => setPwOpen(true)}
                className="btn-ghost"
                title="Change password"
                aria-label="Change password"
              >
                <KeyRound className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={doLogout}
                className="btn-ghost whitespace-nowrap"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden lg:inline">Sign out</span>
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
