import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import api from './api.js';
import { clearAtcScope } from './pos.js';
import { FullScreenSpinner } from '../components/ui.jsx';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

const EMPTY = { user: null, company: null, branch: null, license: null };

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(EMPTY);

  // Session state is always re-fetched from the server on mount so revocation,
  // role changes and licence changes take effect on the next page load.
  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      setSession({ user: data.user, company: data.company, branch: data.branch, license: data.license });
    } catch {
      setSession(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    clearAtcScope(); // a fresh session never inherits a previous ATC company scope
    setSession({ user: data.user, company: data.company, branch: data.branch, license: data.license });
    return data;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Session may already be gone; local state clears either way.
    }
    clearAtcScope();
    setSession(EMPTY);
  };

  return (
    <AuthContext.Provider value={{ loading, ...session, refresh, login, logout, setSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function RequireAuth({ children }) {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

export function RequireAtc({ children }) {
  const { loading, user } = useAuth();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'POS_SUPER_ADMIN') return <Navigate to="/dashboard" replace />;
  return children;
}

// Generic role gate for phase-2 routes (contract §5 role table). The server
// stays the authority — this only keeps users off screens their role can
// never use.
export function RequireRoles({ roles, children }) {
  const { loading, user } = useAuth();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) {
    return <Navigate to={user.role === 'POS_SUPER_ADMIN' ? '/atc/companies' : '/dashboard'} replace />;
  }
  return children;
}
