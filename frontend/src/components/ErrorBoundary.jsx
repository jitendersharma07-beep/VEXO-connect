import { Component } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

// The last line of defence for a screen that throws while rendering.
//
// React 18 unmounts the entire tree on an uncaught render error, so without
// this the result is a genuinely blank white page: no message, no navigation,
// nothing to read out to support. Measured before this existed — a 200 response
// whose body the Dashboard could not render left the body with *zero*
// characters of text. On a till, mid-service, that is the worst thing the
// screen can do, because the person in front of it cannot even say what broke.
//
// This cannot catch everything, and should not be mistaken for a safety net
// that makes the app robust. It does not fire for errors thrown in event
// handlers or in async code — an axios rejection inside a click handler still
// has to be caught where it happens, which is what the per-page try/catch and
// ErrorNote are for. What it does is guarantee that a *render* failure degrades
// to a readable screen instead of a white one.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the real thing in the console for whoever opens devtools; the user
    // gets the short version below. Deliberately not sent anywhere: there is no
    // error-reporting service wired up, and pretending otherwise would be worse
    // than silence.
    console.error('Render error caught by ErrorBoundary:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="card w-full max-w-lg p-6">
          <div className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" />
            <h1 className="text-lg font-bold">This screen stopped working</h1>
          </div>

          <p className="mt-3 text-sm text-slate-600">
            Something on this page could not be displayed. This is a fault in the screen, not in
            your data — orders, bills and payments that were already saved are on the server and
            are not affected.
          </p>

          <p className="mt-2 text-sm text-slate-600">
            Reload the page to carry on. <strong>If this happened while you were taking a
            payment</strong>, open the order in <strong>Orders</strong> and check whether the
            payment was recorded before taking it again.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              <RotateCcw className="h-4 w-4" /> Reload this page
            </button>
            <a className="btn btn-ghost" href={`${import.meta.env.BASE_URL}orders`}>
              Go to Orders
            </a>
          </div>

          <p className="mt-5 border-t border-slate-100 pt-3 text-xs text-slate-500">
            If it keeps happening, tell VEXO support the time, the branch, and this line:
            <span className="mt-1 block font-mono text-[11px] text-slate-600">
              {String(error?.message || error).slice(0, 200)}
            </span>
          </p>
        </div>
      </div>
    );
  }
}
