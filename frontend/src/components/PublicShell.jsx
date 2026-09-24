import { Link } from 'react-router-dom';
import { Logo, LogoMark } from './Logo.jsx';

// The frame around the three pages a person can reach WITHOUT an account:
// accepting an invitation, and the two steps of password recovery.
//
// Shared with Login on purpose rather than by coincidence. Someone who has
// clicked a link in an email is in exactly the position a phishing page needs
// them to be in — no signed-in session to compare against, and an unfamiliar
// screen. A page that looks nothing like the product is one they cannot check.
export default function PublicShell({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-pos-surface px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="card p-8">
          <div className="mb-6 flex items-center gap-3">
            <LogoMark className="h-10 w-10" />
            <div>
              <h2 className="text-xl font-bold text-pos-ink">{title}</h2>
              {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
            </div>
          </div>
          {children}
        </div>
        {footer ?? (
          <p className="mt-6 text-center text-xs text-slate-400">
            <Link to="/login" className="font-semibold text-pos-royal hover:underline">
              Back to sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
