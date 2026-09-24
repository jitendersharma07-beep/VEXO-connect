import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireAtc, RequireRoles, useAuth } from './lib/auth.jsx';
import { ToastProvider } from './components/toast.jsx';
import { ApprovalProvider } from './lib/discountApproval.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Branches from './pages/Branches.jsx';
import Team from './pages/Team.jsx';
import Licensing from './pages/Licensing.jsx';
import AtcCompanies from './pages/AtcCompanies.jsx';
import AtcCompanyDetail from './pages/AtcCompanyDetail.jsx';
import Sell from './pages/Sell.jsx';
import Orders from './pages/Orders.jsx';
import CatalogAdmin from './pages/CatalogAdmin.jsx';
import TablesAdmin from './pages/TablesAdmin.jsx';
import SalesReport from './pages/SalesReport.jsx';
import ActivityReport from './pages/ActivityReport.jsx';
import GatewayReconciliation from './pages/GatewayReconciliation.jsx';
import DayClose from './pages/DayClose.jsx';
import Discounts from './pages/Discounts.jsx';
import CustomerDisplay from './pages/CustomerDisplay.jsx';
import PairDisplay from './pages/PairDisplay.jsx';
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
          {/* Inside ToastProvider so a refusal at the till can still speak,
              and around every route because six different requests can be the
              one that needs a manager's signature. */}
          <ApprovalProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* VC-101: the customer-facing screen authenticates with its own
                pairing token, so it lives outside RequireAuth on purpose —
                an unpaired display shows its pairing screen, never login. */}
            <Route path="/display" element={<CustomerDisplay />} />
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
              <Route path="branches" element={<Branches />} />
              <Route path="team" element={<Team />} />
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
                path="reports"
                element={
                  <RequireRoles roles={['BRANCH_MANAGER', 'CUSTOMER_OWNER', 'POS_SUPER_ADMIN']}>
                    <SalesReport />
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
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
          </ApprovalProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
