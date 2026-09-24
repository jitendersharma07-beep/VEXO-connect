import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, MailCheck, ShieldAlert } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import PublicShell from '../components/PublicShell.jsx';
import { ErrorNote } from '../components/ui.jsx';
import { digitsPhrase } from '../lib/pos.js';

// Password recovery, in the three steps the API actually has:
//
//   ask → type the code from the mailbox → choose a new password
//
// The screen is written to match the backend's refusal to be an account
// oracle. Step two looks identical whether or not the address is registered,
// and this page must not undo that by, say, skipping ahead only for real
// accounts or wording the two cases differently. There is one path.

const errDetails = (err) => err?.response?.data?.error?.details ?? {};

// Live countdown for a resend. Server-authoritative: the number comes from the
// 429 the backend returns, so a reload cannot shorten it — this only stops the
// button inviting a press that is certain to be refused.
const useCountdown = () => {
  const [left, setLeft] = useState(0);
  const timer = useRef(null);
  useEffect(() => {
    if (left <= 0) return undefined;
    timer.current = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer.current);
  }, [left]);
  return [left, setLeft];
};

export default function ForgotPassword() {
  const navigate = useNavigate();
  // Arriving from an email that ALREADY carries a code — the one an
  // administrator sends when they create an account or reset a password.
  //
  // Those people must not be dropped on step one. Asking for a code they are
  // holding mints a second one and supersedes the first, or, inside the resend
  // cooldown, refuses and tells them to wait — either way the code in front of
  // them stops working for a reason the screen never explains. Only `step` and
  // `email` come from the URL; the code itself is typed, never linked.
  const [params] = useSearchParams();
  const sentAlready = params.get('step') === 'code' && Boolean(params.get('email'));
  const [step, setStep] = useState(sentAlready ? 'code' : 'request'); // request | code | password | done
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [policy, setPolicy] = useState({ expiresInMinutes: 10, codeLength: 8 });
  const [attemptsRemaining, setAttemptsRemaining] = useState(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useCountdown();

  const request = async (e) => {
    e?.preventDefault();
    setError('');
    setNote('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { email });
      setPolicy({ expiresInMinutes: data.expiresInMinutes, codeLength: data.codeLength });
      setStep('code');
      setAttemptsRemaining(null);
    } catch (err) {
      setError(apiError(err, 'Could not start password recovery'));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError('');
    setNote('');
    setBusy(true);
    try {
      await api.post('/auth/forgot-password/resend', { email });
      setCode('');
      setAttemptsRemaining(null);
      setNote('A new code is on its way. The previous one no longer works.');
    } catch (err) {
      const wait = errDetails(err).retryAfterSeconds;
      if (wait) setCooldown(wait);
      setError(apiError(err, 'Could not send another code'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    setError('');
    setNote('');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/forgot-password/verify', { email, code: code.trim() });
      setResetToken(data.resetToken);
      setStep('password');
    } catch (err) {
      const remaining = errDetails(err).attemptsRemaining;
      setAttemptsRemaining(remaining === undefined ? null : remaining);
      setError(apiError(err, 'That code is not valid or has expired'));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/forgot-password/reset', { resetToken, password, confirmPassword });
      setStep('done');
    } catch (err) {
      setError(apiError(err, 'Could not set your new password'));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'done') {
    return (
      <PublicShell title="Password updated" subtitle={email}>
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <p className="text-sm text-emerald-900">
            Every device that was signed in to this account has been signed out. Sign in again with
            your new password.
          </p>
        </div>
        <button type="button" className="btn-primary mt-5 w-full" onClick={() => navigate('/login', { replace: true })}>
          Go to sign in
        </button>
      </PublicShell>
    );
  }

  if (step === 'password') {
    return (
      <PublicShell title="Choose a new password" subtitle={email}>
        <form onSubmit={reset} className="space-y-4">
          <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
          <div>
            <label className="label" htmlFor="password">New password</label>
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
            <label className="label" htmlFor="confirmPassword">Confirm new password</label>
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
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </PublicShell>
    );
  }

  if (step === 'code') {
    return (
      <PublicShell title="Enter your verification code" subtitle={email}>
        {/* Worded so it says exactly what the backend's answer means. It is
            NOT a confirmation that the address is registered, and it must not
            read like one.

            The link case is different and may be plainer: that code was sent
            because somebody who is already signed in asked for it, so there is
            no address to give away — the person reading it is holding the mail. */}
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 p-3">
          <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-pos-royal" />
          <p className="text-xs leading-relaxed text-slate-600">
            {sentAlready ? (
              <>
                Enter the {policy.codeLength}-digit code from the email just sent to this address.
                It is valid for {policy.expiresInMinutes} minutes from when it was sent.
                {/* "the …-digit code" needs no article, so this branch is safe
                    to interpolate directly; the one below is not. */}
              </>
            ) : (
              <>
                If that address belongs to an active account, {digitsPhrase(policy.codeLength)} code
                has been sent to it. It is valid for {policy.expiresInMinutes} minutes.
              </>
            )}
          </p>
        </div>
        <form onSubmit={verify} className="space-y-4">
          <div>
            <label className="label" htmlFor="code">Verification code</label>
            <input
              id="code"
              className="input text-center font-mono text-lg tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, policy.codeLength))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={'•'.repeat(policy.codeLength)}
              required
              autoFocus
            />
          </div>
          <ErrorNote message={error} />
          {attemptsRemaining !== null && attemptsRemaining > 0 ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {attemptsRemaining} {attemptsRemaining === 1 ? 'attempt' : 'attempts'} left before this
                code is locked. Request a new one if you are not sure.
              </span>
            </div>
          ) : null}
          {note ? (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">{note}</p>
          ) : null}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Checking…' : 'Verify code'}
          </button>
        </form>
        <div className="mt-4 flex items-center justify-between text-xs">
          <button
            type="button"
            className="font-semibold text-pos-royal hover:underline disabled:cursor-not-allowed disabled:text-slate-300 disabled:no-underline"
            onClick={resend}
            disabled={busy || cooldown > 0}
          >
            {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
          </button>
          <button
            type="button"
            className="text-slate-400 hover:underline"
            onClick={() => {
              setStep('request');
              setCode('');
              setError('');
              setNote('');
              setAttemptsRemaining(null);
            }}
          >
            Use a different email
          </button>
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell title="Reset your password" subtitle="We will email you a verification code.">
      <form onSubmit={request} className="space-y-4">
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
            autoFocus
            autoComplete="email"
          />
        </div>
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Sending…' : 'Send verification code'}
        </button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-400">
        Remembered it? <Link to="/login" className="font-semibold text-pos-royal hover:underline">Sign in</Link>
      </p>
    </PublicShell>
  );
}
