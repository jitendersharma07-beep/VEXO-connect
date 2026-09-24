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
import MenuProfitability from './pages/MenuProfitability.jsx';
import ActivityReport from './pages/ActivityReport.jsx';
import GatewayReconciliation from './pages/GatewayReconciliation.jsx';
import DayClose from './pages/DayClose.jsx';
import Discounts from './pages/Discounts.jsx';
import CustomerDisplay from './pages/CustomerDisplay.jsx';
import PairDisplay from './pages/PairDisplay.jsx';
import NotFound from './pages/NotFound.jsx';

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
