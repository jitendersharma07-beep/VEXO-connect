import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, MailCheck } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import PublicShell from '../components/PublicShell.jsx';
import { ErrorNote } from '../components/ui.jsx';

// The page at the end of the emailed link. It is the first thing a new
// colleague ever sees of the product, and the only screen in the portal that
// creates an account without anyone being signed in — so it is written to be
// checkable by the person reading it.

// The token arrives in the URL FRAGMENT, and is read exactly once, here.
//
// A fragment is never sent to a server: not to ours, not to whatever the
// browser fetches next, not in a Referer header. So the one credential that
// turns into an account cannot land in an access log, a proxy log or an
// analytics payload just because somebody opened the link. The backend mints
// it into `/invite#<token>` for the same reason.
//
// Having read it we drop it from the address bar with replaceState — the
// history entry keeps no copy, so a later "back" or a shared screen does not
// bring it back. Keeping it in component state is the point: the page still
// holds it for the POST, but nothing outside this tab does.
const takeTokenFromHash = () => {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return '';
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return decodeURIComponent(raw);
};

const Row = ({ label, value }) =>
  value ? (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-semibold text-pos-ink">{value}</span>
    </div>
  ) : null;

export default function AcceptInvitation() {
  const navigate = useNavigate();
  const [token, setToken] = useState(null); // null = not read yet, '' = absent
  const [offer, setOffer] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    setToken(takeTokenFromHash());
  }, []);

  useEffect(() => {
    if (token === null) return;
    if (!token) {
      setLoadError('This link is incomplete. Open the link from your invitation email again, in full.');
      return;
    }
    let cancelled = false;
    api
      .post('/invite/lookup', { token })
      .then(({ data }) => {
        if (!cancelled) setOffer(data.invitation);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(apiError(err, 'This invitation link is not valid, or it has expired.'));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post('/invite/accept', { token, password, confirmPassword });
      // Deliberately NOT signed in. Accepting proves the mailbox, not the
      // person at the keyboard; the backend issues no session and this page
      // does not ask for one. They type the password they just chose.
      setDone(data);
    } catch (err) {
      setError(apiError(err, 'Could not set up your account'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <PublicShell title="Your account is ready" subtitle={done.email}>
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <p className="text-sm text-emerald-900">
            Sign in with the password you just chose. For your security you are not signed in
            automatically from an email link.
          </p>
        </div>
        <button type="button" className="btn-primary mt-5 w-full" onClick={() => navigate('/login', { replace: true })}>
          Go to sign in
        </button>
      </PublicShell>
    );
  }

  if (loadError) {
    return (
      <PublicShell title="Invitation unavailable">
        <ErrorNote message={loadError} />
        <p className="mt-4 text-sm text-slate-500">
          Invitations expire, and they can be withdrawn. Ask whoever invited you to send a fresh one —
          the new link will replace this one.
        </p>
      </PublicShell>
    );
  }

  if (!offer) {
    return (
      <PublicShell title="Checking your invitation…">
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-pos-royal" />
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell
      title="Set your password"
      subtitle={offer.companyName ? `Join ${offer.companyName}` : 'VEXO Connect platform administration'}
    >
      {/* What the invitation actually says, shown before anything is typed.
          Somebody who was not expecting this — or who was sent a lure dressed
          up as one — can see the company, the role and the address it was
          issued to, and stop here if any of it is wrong. */}
      <div className="mb-5 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <Row label="Email" value={offer.email} />
        <Row label="Name" value={offer.fullName} />
        <Row label="Role" value={offer.roleLabel || offer.role} />
        <Row label="Company" value={offer.companyName} />
        <Row label="Store" value={offer.storeName} />
        <Row label="Region" value={offer.regionName} />
        <Row
          label="Link expires"
          value={offer.expiresAt ? new Date(offer.expiresAt).toLocaleString() : null}
        />
      </div>

      <div className="mb-5 flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 p-3">
        <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-pos-royal" />
        <p className="text-xs leading-relaxed text-slate-600">
          You choose this password yourself. Nobody at VEXO Connect or at your company can see it,
          and it was never sent by email.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {/* A hidden username field so password managers file the saved
            credential under the right account instead of the bare origin. */}
        <input type="hidden" name="username" autoComplete="username" value={offer.email} readOnly />
        <div>
          <label className="label" htmlFor="password">Choose a password</label>
          <input
            id="password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            required
            autoFocus
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-slate-400">At least 10 characters. Longer is better than complicated.</p>
        </div>
        <div>
          <label className="label" htmlFor="confirmPassword">Confirm password</label>
          <input
            id="confirmPassword"
            type="password"
            className="input"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={10}
            required
            autoComplete="new-password"
          />
        </div>
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Setting up…' : 'Create my account'}
        </button>
      </form>
    </PublicShell>
  );
}
