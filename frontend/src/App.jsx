import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireAtc, RequireRoles, useAuth } from './lib/auth.jsx';
import { ToastProvider } from './components/toast.jsx';
import { PermissionProvider, RequireAction } from './lib/permissions.jsx';
import { ApprovalProvider } from './lib/discountApproval.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Branches from './pages/Branches.jsx';
import Team from './pages/Team.jsx';
import Licensing from './pages/Licensing.jsx';
import AtcCompanies from './pages/AtcCompanies.jsx';
import AtcCompanyDetail from './pages/AtcCompanyDetail.jsx';
import AtcPlatformAdmins from './pages/AtcPlatformAdmins.jsx';
import AcceptInvitation from './pages/AcceptInvitation.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import Sell from './pages/Sell.jsx';
import Orders from './pages/Orders.jsx';
import PhoneOrders from './pages/PhoneOrders.jsx';
import PhoneOrderNew from './pages/PhoneOrderNew.jsx';
import CatalogAdmin from './pages/CatalogAdmin.jsx';
import TablesAdmin from './pages/TablesAdmin.jsx';
import FloorDesigner from './pages/FloorDesigner.jsx';
import FloorStatus from './pages/FloorStatus.jsx';
import Captain from './pages/Captain.jsx';
import SalesReport from './pages/SalesReport.jsx';
import MenuProfitability from './pages/MenuProfitability.jsx';
import ActivityReport from './pages/ActivityReport.jsx';
import GatewayReconciliation from './pages/GatewayReconciliation.jsx';
import DayClose from './pages/DayClose.jsx';
import HqDashboard from './pages/HqDashboard.jsx';
import ReportCentre from './pages/ReportCentre.jsx';
import ReportView from './pages/ReportView.jsx';
import ReportingSettings from './pages/ReportingSettings.jsx';
import ReportSchedules from './pages/ReportSchedules.jsx';
import ReportExceptions from './pages/ReportExceptions.jsx';
import Discounts from './pages/Discounts.jsx';
import Organisation from './pages/Organisation.jsx';
import Brands from './pages/Brands.jsx';
import Regions from './pages/Regions.jsx';
import Devices from './pages/Devices.jsx';
import Permissions from './pages/Permissions.jsx';
import Integrations from './pages/Integrations.jsx';
import CustomerDisplay from './pages/CustomerDisplay.jsx';
import PairDisplay from './pages/PairDisplay.jsx';
import GuestTable from './pages/GuestTable.jsx';
import NotFound from './pages/NotFound.jsx';
// ==== LANE inventory ==== (VC-105 prerequisite, spec Part B §8)
import InventoryOverview from './pages/inventory/Overview.jsx';
import InventoryStock from './pages/inventory/Stock.jsx';
import InventoryBatches from './pages/inventory/Batches.jsx';
import InventoryRequests from './pages/inventory/Requests.jsx';
import InventoryTransfers from './pages/inventory/Transfers.jsx';
import InventoryPlanning from './pages/inventory/Planning.jsx';
import InventoryReceiving from './pages/inventory/Receiving.jsx';
import InventoryAdjustments from './pages/inventory/Adjustments.jsx';
import InventoryLedger from './pages/inventory/Ledger.jsx';
import InventoryRecipes from './pages/inventory/Recipes.jsx';
import InventoryProduction from './pages/inventory/Production.jsx';
import InventorySetup from './pages/inventory/Setup.jsx';
// ==== /LANE inventory ====

function Home() {
  const { user } = useAuth();
  if (user.role === 'POS_SUPER_ADMIN') return <Navigate to="/atc/companies" replace />;
  if (user.role === 'CASHIER') return <Navigate to="/sell" replace />;
  return <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <ToastProvider>
          {/* LANE foundation — inside AuthProvider and the router (the
              permission fetch is keyed on the signed-in user and, for VEXO
              operators, on the company scope a navigation just changed).
              Presentation only; the server re-judges every request. */}
          <PermissionProvider>
          {/* Inside ToastProvider so a refusal at the till can still speak,
              and around every route because six different requests can be the
              one that needs a manager's signature. */}
          <ApprovalProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* LANE accounts — the two routes a person reaches BEFORE they have
                an account, or when they can no longer get into the one they
                have. Outside RequireAuth by necessity: wrapping them would
                bounce every invited colleague to a sign-in page they cannot
                yet pass, and every locked-out owner to the screen they are
                locked out of.

                Neither issues a session. Accepting an invitation and completing
                a reset both end at /login, because an emailed link proves the
                mailbox and not the person holding it. */}
            <Route path="/invite" element={<AcceptInvitation />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            {/* VC-101: the customer-facing screen authenticates with its own
                pairing token, so it lives outside RequireAuth on purpose —
                an unpaired display shows its pairing screen, never login. */}
            <Route path="/display" element={<CustomerDisplay />} />
            {/* LANE floorplan — the address printed on a table card. Outside
                RequireAuth because the credential is the token in the path: a
                guest has no staff session and must never meet a login form.
                This path is half of POS_QR_BASE_URL/t/<token> and cannot be
                renamed without reprinting every card already on a table. */}
            <Route path="/t/:token" element={<GuestTable />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route index element={<Home />} />
              <Route path="dashboard" element={<Dashboard />} />
              {/* Gated by the same action the server checks on GET /branches —
                  till-only roles were being shown a screen that answered 403. */}
              <Route
                path="branches"
                element={
                  <RequireAction action="org.store.read" what="branches">
                    <Branches />
                  </RequireAction>
                }
              />
              {/* LANE foundation — same action the server checks on
                  GET /users; the team screen is no longer owner-only. */}
              <Route
                path="team"
                element={
                  <RequireAction action="user.read" what="the team">
                    <Team />
                  </RequireAction>
                }
              />
              <Route path="licence" element={<Licensing />} />
              {/* Phase 2 (contract §11): role-gated in nav AND at the route;
                  the server stays the authority on every call. */}
              <Route
                path="sell"
                element={
                  <RequireRoles roles={['CASHIER', 'BRANCH_MANAGER', 'CUSTOMER_OWNER']}>
                    <Sell />
                  </RequireRoles>
                }
              />
              <Route path="orders" element={<Orders />} />
              {/* VC-104: RequireRoles, not RequireAction — the phone routes
                  are role-gated on the server (requireRole), so phone.*
                  actions never appear in GET /permissions/me. */}
              <Route
                path="phone-orders"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <PhoneOrders />
                  </RequireRoles>
                }
              />
              <Route
                path="phone-orders/new"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <PhoneOrderNew />
                  </RequireRoles>
                }
              />
              {/* VC-101: staff side of display pairing — same roles the Sell
                  screen admits. */}
              <Route
                path="display/pair"
                element={
                  <RequireRoles roles={['CASHIER', 'BRANCH_MANAGER', 'CUSTOMER_OWNER']}>
                    <PairDisplay />
                  </RequireRoles>
                }
              />
              <Route
                path="catalog"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <CatalogAdmin />
                  </RequireRoles>
                }
              />
              <Route
                path="tables"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <TablesAdmin />
                  </RequireRoles>
                }
              />
              <Route
                path="floor-designer"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <FloorDesigner />
                  </RequireRoles>
                }
              />
              {/* Reading the floor is not editing it. GET /floors and
                  /floors/:id/layout are open to every role inside the tenant,
                  so the operational view is too — a captain or cashier needs
                  to see which table is waiting far more often than a manager
                  needs to move one. */}
              <Route path="floor-status" element={<FloorStatus />} />
              {/* The handheld. CASHIER and up are admitted as well as CAPTAIN
                  because a manager covering the floor carries the same device;
                  the screen offers no money control to any of them. */}
              <Route
                path="captain"
                element={
                  <RequireRoles
                    roles={['CAPTAIN', 'CASHIER', 'BRANCH_MANAGER', 'CUSTOMER_OWNER']}
                  >
                    <Captain />
                  </RequireRoles>
                }
              />
              <Route
                path="reports"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <SalesReport />
                  </RequireRoles>
                }
              />
              {/* VC-105. Same gate as the other reports: a CASHIER is refused
                  by the server (403) and never reaches the route. */}
              <Route
                path="reports/menu-profitability"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <MenuProfitability />
                  </RequireRoles>
                }
              />
              <Route
                path="reports/activity"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <ActivityReport />
                  </RequireRoles>
                }
              />
              <Route
                path="reports/reconciliation"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <GatewayReconciliation />
                  </RequireRoles>
                }
              />
              {/* ATC is admitted here to READ. The server refuses it the
                  closing itself (a count of someone else's drawer is not
                  ATC's to file), and the page hides the form accordingly —
                  but support cannot help with a variance it cannot see. */}
              <Route
                path="reports/day-close"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <DayClose />
                  </RequireRoles>
                }
              />
              {/* LANE reporting — the multi-location report centre, gated by
                  ACTION rather than by the role list the legacy /reports routes
                  use. That difference is the point: the permission catalog grants
                  report.*.read to FINANCE, REGIONAL_MANAGER and AUDITOR, and the
                  role list above refuses all three. The server gates each report
                  on its own action, so the route admits anyone holding any of
                  them and each screen shows only what its own action allows.
                  Static paths are declared before ":key" so the settings and
                  index routes are not swallowed by it. */}
              <Route
                path="reporting"
                element={
                  <RequireAction action="report.dashboard.read" what="the consolidated dashboard">
                    <HqDashboard />
                  </RequireAction>
                }
              />
              <Route
                path="reporting/reports"
                element={
                  <RequireAction
                    action={[
                      'report.sales.read',
                      'report.tax.read',
                      'report.payments.read',
                      'report.inventory.read',
                      'report.dashboard.read',
                    ]}
                    what="reports"
                  >
                    <ReportCentre />
                  </RequireAction>
                }
              />
              <Route
                path="reporting/settings"
                element={
                  <RequireAction action="report.settings.read" what="the reporting periods">
                    <ReportingSettings />
                  </RequireAction>
                }
              />
              {/* Reading the schedule list is the lower authority; creating and
                  activating one needs report.schedule.write, which the screen
                  checks for the buttons and the server checks for the request.
                  BRANCH_MANAGER deliberately holds neither. */}
              <Route
                path="reporting/schedules"
                element={
                  <RequireAction action="report.schedule.read" what="scheduled reports">
                    <ReportSchedules />
                  </RequireAction>
                }
              />
              <Route
                path="reporting/exceptions"
                element={
                  <RequireAction action="report.exception.read" what="the exception worklist">
                    <ReportExceptions />
                  </RequireAction>
                }
              />
              {/* One route for every report. The gate here is deliberately the
                  broad "may read some report" test, because which action a given
                  key needs is the server's mapping, not a list to be copied — and
                  the server refuses the request itself with a 403 the page shows.
                  Copying that map here is how the two would drift into a link
                  that opens onto a refusal. */}
              <Route
                path="reporting/:key"
                element={
                  <RequireAction
                    action={[
                      'report.sales.read',
                      'report.tax.read',
                      'report.payments.read',
                      'report.inventory.read',
                      'report.dashboard.read',
                    ]}
                    what="reports"
                  >
                    <ReportView />
                  </RequireAction>
                }
              />
              {/* Owner only, and the server says so too. A branch manager who
                  could widen their own ceiling would not have a ceiling. */}
              <Route
                path="discounts"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER']}>
                    <Discounts />
                  </RequireRoles>
                }
              />
              {/* ==== LANE inventory ==== (spec Part B §8)
                  Every inventory screen admits exactly the two roles the
                  server's INVENTORY_ACTIONS map admits, and no more. A cashier
                  is refused here and refused again at the API, which is the
                  point: this gate exists so a cashier is not shown a screen
                  that would only fill with refusals, NOT to be the check.
                  Owner-only actions — approving a count, releasing a recalled
                  batch, rebuilding the ledger cache — are gated inside the
                  pages and re-checked on every request. */}
              <Route
                path="inventory"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryOverview />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/stock"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryStock />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/batches"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryBatches />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/requests"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryRequests />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/transfers"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryTransfers />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/planning"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryPlanning />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/receiving"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryReceiving />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/adjustments"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryAdjustments />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/ledger"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryLedger />
                  </RequireRoles>
                }
              />
              <Route
                path="inventory/recipes"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryRecipes />
                  </RequireRoles>
                }
              />
              {/* A production run needs both dispatch and receive on the
                  kitchen, which the server checks separately so the refusal
                  names the missing half. The role gate here is the coarser
                  one: it decides who may reach the screen at all. */}
              <Route
                path="inventory/production"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventoryProduction />
                  </RequireRoles>
                }
              />
              {/* Reference data is the owner's to change, but a manager who
                  cannot see which location their sales come out of cannot read
                  any other screen here. Admitted to look; refused to write, by
                  the server first and this page second. */}
              <Route
                path="inventory/setup"
                element={
                  <RequireRoles roles={['CUSTOMER_OWNER', 'BRANCH_MANAGER']}>
                    <InventorySetup />
                  </RequireRoles>
                }
              />
              {/* ==== /LANE inventory ==== */}
              {/* LANE foundation — the organisation registry (spec B§3, B§7):
                  legal entities & GST, brands, regions, tills & devices.
                  Gated by ACTION, not role, from the same list the server
                  answers on GET /permissions/me — so Finance reaches Legal &
                  GST and a store manager reaches Brands without either being
                  an "admin". A two-action gate admits whoever can read one of
                  the page's sections; the page hides the other section. */}
              <Route
                path="organisation"
                element={
                  <RequireAction
                    action={['org.legalEntity.read', 'org.gst.read']}
                    what="the organisation registry"
                  >
                    <Organisation />
                  </RequireAction>
                }
              />
              <Route
                path="brands"
                element={
                  <RequireAction action="org.brand.read" what="brands">
                    <Brands />
                  </RequireAction>
                }
              />
              <Route
                path="regions"
                element={
                  <RequireAction action="org.region.read" what="regions">
                    <Regions />
                  </RequireAction>
                }
              />
              <Route
                path="devices"
                element={
                  <RequireAction action={['terminal.read', 'device.read']} what="tills and devices">
                    <Devices />
                  </RequireAction>
                }
              />
              {/* Whoever may read the rules OR the support grants gets in;
                  the page hides the half they cannot read. */}
              <Route
                path="permissions"
                element={
                  <RequireAction
                    action={['permission.read', 'support.grant.read']}
                    what="permissions"
                  >
                    <Permissions />
                  </RequireAction>
                }
              />
              {/* LANE providers — integration.read is the floor, and every
                  control inside the page hides itself against its own action.
                  Finance holds read plus discrepancy resolution, a store manager
                  holds read plus retry: both get in, and both see a different
                  screen. */}
              <Route
                path="integrations"
                element={
                  <RequireAction action="integration.read" what="integrations">
                    <Integrations />
                  </RequireAction>
                }
              />
              <Route
                path="atc/companies"
                element={
                  <RequireAtc>
                    <AtcCompanies />
                  </RequireAtc>
                }
              />
              <Route
                path="atc/companies/:companyId"
                element={
                  <RequireAtc>
                    <AtcCompanyDetail />
                  </RequireAtc>
                }
              />
              {/* LANE accounts — RequireAtc, the same gate as the rest of the
                  VEXO console. The server re-judges it anyway: every route
                  under /atc refuses a tenant account, platform admins included
                  in the refusal. */}
              <Route
                path="atc/platform-admins"
                element={
                  <RequireAtc>
                    <AtcPlatformAdmins />
                  </RequireAtc>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
          </ApprovalProvider>
          </PermissionProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
