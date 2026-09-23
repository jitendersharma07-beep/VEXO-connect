import { useEffect, useRef, useState } from 'react';
import { Logo, LogoMark } from '../components/Logo.jsx';
import { fmtINR } from '../lib/pos.js';
import {
  loadPairing,
  savePairing,
  clearPairing,
  pairWithCode,
  fetchState,
  pollDelayMs,
} from '../lib/displayClient.js';

// VC-101 customer display — the customer-facing screen at the counter.
//
// This page holds a pairing token, never a staff credential, and it renders
// exactly what GET /api/display/state sends: no figure on this screen is
// computed in the browser. Line rows therefore show the stored qty, unit
// price and line discount side by side rather than a multiplied amount —
// the authoritative sums live in the totals block.
//
// It lives outside the authenticated shell: an unpaired display shows its
// own pairing screen, not the staff login.

const THANK_YOU_DWELL_MS = 8000;

function PairScreen({ note, onPaired }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      const paired = await pairWithCode(code);
      onPaired({
        token: paired.displayToken,
        branch: paired.branch?.name || '',
        company: paired.company?.name || '',
        expiresAt: paired.expiresAt,
      });
    } catch (err) {
      setError(err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
      <Logo dark />
      <div className="text-center">
        <h1 className="text-3xl font-bold">Pair this display</h1>
        <p className="mt-2 text-blue-200">
          Ask the cashier for a pairing code, then type it below.
        </p>
      </div>
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col items-center gap-4">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="••••••"
          aria-label="Pairing code"
          className="w-full rounded-2xl border-2 border-blue-800 bg-pos-ink px-4 py-5 text-center font-mono text-4xl tracking-[0.5em] text-white placeholder:text-blue-900 focus:border-pos-orange focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || code.length !== 6}
          className="w-full rounded-2xl bg-pos-orange px-6 py-4 text-xl font-bold text-pos-deep disabled:opacity-40"
        >
          {busy ? 'Pairing…' : 'Pair display'}
        </button>
        {error ? <p className="text-center text-red-300">{error}</p> : null}
        {!error && note ? <p className="text-center text-amber-300">{note}</p> : null}
      </form>
    </div>
  );
}

function IdleScreen({ pairing }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <LogoMark className="h-24 w-24" />
      <div>
        <div className="text-5xl font-extrabold tracking-tight">{pairing.branch || 'Welcome'}</div>
        {pairing.company ? <div className="mt-2 text-2xl text-blue-200">{pairing.company}</div> : null}
      </div>
      <div className="text-xl text-blue-300">Welcome — your order will appear here</div>
    </div>
  );
}

function ThankYouScreen({ thanks }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="text-6xl font-extrabold text-pos-orange">Thank you!</div>
      <div className="text-4xl font-bold">{fmtINR(thanks.total)}</div>
      {thanks.invoiceNumber ? (
        <div className="text-xl text-blue-200">Invoice {thanks.invoiceNumber}</div>
      ) : null}
      <div className="text-lg text-blue-300">Please visit again</div>
    </div>
  );
}

function SaleScreen({ pairing, sale, listRef }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between border-b border-blue-900 px-6 py-4">
        <div className="text-2xl font-bold">{pairing.branch}</div>
        <div className="text-lg text-blue-200">
          {sale.invoiceNumber ? `Invoice ${sale.invoiceNumber}` : 'Your order'}
        </div>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <ul className="space-y-3">
          {sale.items.map((item, idx) => (
            <li key={idx} className="flex items-baseline justify-between gap-4 text-2xl">
              <div className="min-w-0">
                <span className="font-semibold">{item.name}</span>
                <span className="ml-3 text-blue-200">× {item.qty}</span>
                {item.lineDiscount > 0 ? (
                  <span className="ml-3 text-lg text-emerald-300">
                    less {fmtINR(item.lineDiscount)}
                  </span>
                ) : null}
              </div>
              <div className="whitespace-nowrap text-blue-100">{fmtINR(item.unitPrice)} each</div>
            </li>
          ))}
        </ul>
      </div>

      <footer className="border-t border-blue-900 px-6 py-4">
        <dl className="space-y-1 text-xl">
          <div className="flex justify-between text-blue-200">
            <dt>Subtotal</dt>
            <dd>{fmtINR(sale.subtotal)}</dd>
          </div>
          {sale.discountAmount > 0 ? (
            <div className="flex justify-between text-emerald-300">
              <dt>Discount</dt>
              <dd>− {fmtINR(sale.discountAmount)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between text-blue-200">
            <dt>Tax</dt>
            <dd>{fmtINR(sale.taxAmount)}</dd>
          </div>
          <div className="mt-2 flex items-baseline justify-between border-t border-blue-800 pt-3">
            <dt className="text-2xl font-bold">Total</dt>
            <dd className="text-5xl font-extrabold tracking-tight">{fmtINR(sale.total)}</dd>
          </div>
        </dl>
        {sale.orderStatus === 'BILLED' ? (
          <div className="mt-4 rounded-2xl bg-pos-orange px-5 py-3 text-center text-2xl font-bold text-pos-deep">
            Please pay {fmtINR(sale.due)}
          </div>
        ) : null}
      </footer>
    </div>
  );
}

export default function CustomerDisplay() {
  const [pairing, setPairing] = useState(() => loadPairing());
  const [note, setNote] = useState('');
  const [view, setView] = useState(null);
  const [thanks, setThanks] = useState(null);
  const [link, setLink] = useState('live'); // 'live' | 'reconnecting'
  const [lastSeen, setLastSeen] = useState(null);
  const etagRef = useRef(null);
  const viewRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!pairing) return undefined;
    let stopped = false;
    let timer = null;
    let dwell = null;

    const tick = async () => {
      const result = await fetchState(pairing.token, etagRef.current);
      if (stopped) return;
      let delay;
      if (result.kind === 'state') {
        etagRef.current = result.etag;
        setLink('live');
        setLastSeen(new Date());
        viewRef.current = result.body;
        setView(result.body);
        if (result.body.view === 'THANKYOU') {
          // The server sends THANKYOU for one poll and then clears; the
          // customer gets a readable dwell regardless of poll timing.
          setThanks(result.body);
          clearTimeout(dwell);
          dwell = setTimeout(() => setThanks(null), THANK_YOU_DWELL_MS);
        } else if (result.body.view === 'ACTIVE') {
          // The next customer's first line replaces a lingering thank-you.
          setThanks(null);
        }
        delay = pollDelayMs(result.body.view);
      } else if (result.kind === 'unchanged') {
        setLink('live');
        setLastSeen(new Date());
        delay = pollDelayMs(viewRef.current?.view);
      } else if (result.kind === 'unpaired') {
        clearPairing();
        setPairing(null);
        setNote('This display was signed out. Ask the cashier for a new code.');
        return;
      } else if (result.kind === 'ratelimited') {
        delay = result.retryAfterMs;
      } else {
        // offline — keep the last screen, say so, keep trying.
        setLink('reconnecting');
        delay = 5000;
      }
      timer = setTimeout(tick, delay);
    };

    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(dwell);
    };
  }, [pairing]);

  // A new line lands at the bottom of the list; keep it in view.
  const itemCount = view?.view === 'ACTIVE' ? view.items.length : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [itemCount]);

  const onPaired = (next) => {
    etagRef.current = null;
    viewRef.current = null;
    setView(null);
    setThanks(null);
    setNote('');
    savePairing(next);
    setPairing(next);
  };

  let body;
  if (!pairing) {
    body = <PairScreen note={note} onPaired={onPaired} />;
  } else if (thanks) {
    body = <ThankYouScreen thanks={thanks} />;
  } else if (view?.view === 'ACTIVE') {
    body = <SaleScreen pairing={pairing} sale={view} listRef={listRef} />;
  } else {
    body = <IdleScreen pairing={pairing} />;
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-pos-deep font-sans text-white">
      {pairing && link === 'reconnecting' ? (
        <div className="flex items-center justify-center gap-2 bg-amber-500/90 px-4 py-2 text-sm font-semibold text-pos-deep">
          <span className="h-2 w-2 animate-pulse rounded-full bg-pos-deep" />
          Reconnecting…
          {lastSeen ? ` last updated ${lastSeen.toLocaleTimeString('en-IN', { hour12: false })}` : ''}
        </div>
      ) : null}
      {body}
    </div>
  );
}
