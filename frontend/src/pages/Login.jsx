import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Store, ShieldCheck, Building2 } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { apiError } from '../lib/api.js';
import { Logo, LogoMark } from '../components/Logo.jsx';
import { ErrorNote, FullScreenSpinner } from '../components/ui.jsx';

export default function Login() {
  const { loading, user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <FullScreenSpinner />;
  if (user) {
    const to = location.state?.from?.pathname || '/';
    return <Navigate to={to} replace />;
  }

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await login(email, password);
      const home = data.user.role === 'POS_SUPER_ADMIN' ? '/atc/companies' : '/dashboard';
      navigate(location.state?.from?.pathname || home, { replace: true });
    } catch (err) {
      setError(apiError(err, 'Sign-in failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-pos-deep via-pos-royal to-pos-bright p-10 text-white lg:flex">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/5" />
        <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-pos-orange/10" />
        <Logo dark />
        <div className="relative max-w-md">
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight">
            Point of Sale,
            <br />
            built for <span className="text-pos-orange">multi-branch</span> businesses.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-blue-100">
            Run every outlet under one account with company-level isolation, branch-level roles and
            licences controlled by VEXO.
          </p>
          <div className="mt-8 space-y-3 text-sm text-blue-100">
            <div className="flex items-center gap-3">
              <span className="rounded-lg bg-white/10 p-2"><Building2 className="h-4 w-4" /></span>
              One company, many branches — data stays isolated per customer
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-lg bg-white/10 p-2"><Store className="h-4 w-4" /></span>
              Owner, branch manager and cashier roles out of the box
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-lg bg-white/10 p-2"><ShieldCheck className="h-4 w-4" /></span>
              Access, expiry and branch limits managed by VEXO
            </div>
          </div>
        </div>
        <div className="relative text-xs text-blue-200">
          VEXO Connect · © {new Date().getFullYear()} ATC Infocom Solutions Pvt. Ltd.
        </div>
      </div>

      <div className="flex w-full flex-col items-center justify-center bg-pos-surface px-6 py-12 lg:max-w-xl">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo />
          </div>
          <div className="card p-8">
            <div className="mb-6 flex items-center gap-3">
              <LogoMark className="h-10 w-10" />
              <div>
                <h2 className="text-xl font-bold text-pos-ink">Sign in to VEXO Connect</h2>
                <p className="text-xs text-slate-500">Use the account issued for your company.</p>
              </div>
            </div>
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label" htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  className="input"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <div>
                <label className="label" htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <ErrorNote message={error} />
              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
          <p className="mt-6 text-center text-xs text-slate-400">
            VEXO Connect accounts are separate from other ATC and VEXO product logins.
          </p>
        </div>
      </div>
    </div>
  );
}
