import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireAtc, useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Branches from './pages/Branches.jsx';
import Team from './pages/Team.jsx';
import Licensing from './pages/Licensing.jsx';
import AtcCompanies from './pages/AtcCompanies.jsx';
import AtcCompanyDetail from './pages/AtcCompanyDetail.jsx';
import NotFound from './pages/NotFound.jsx';

function Home() {
  const { user } = useAuth();
  return <Navigate to={user.role === 'POS_SUPER_ADMIN' ? '/atc/companies' : '/dashboard'} replace />;
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
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
      </AuthProvider>
    </BrowserRouter>
  );
}
