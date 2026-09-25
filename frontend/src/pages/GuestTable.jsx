import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { LogoMark } from '../components/Logo.jsx';
import { fmtINR } from '../lib/pos.js';
import {
  clearGuestToken,
  fetchOrder,
  lineEstimate,
  loadGuestToken,
  newIdempotencyKey,
  saveGuestToken,
  scanCard,
  startOrJoin,
  submitBasket,
} from '../lib/guestQrClient.js';

// What a guest sees after scanning the card glued to their table (TQ-5).
//
// Built for a phone held in one hand while the other holds a menu: one column,
// large tap targets, and the bill pinned to the bottom of the screen. It lives
// outside RequireAuth and outside Layout — a guest has no staff session and must
// never be shown a login form.
//
// Two rules this page keeps that are easy to break later:
//
//   It names no store, branch or table in any request. The printed token in the
//   URL is the only identity, and the server derives everything from it, so
//   there is nothing here for a guest to tamper with by editing a form.
//
//   It computes no authoritative money. The basket shows an estimate while the
//   guest is still choosing, and the instant an order exists the totals come
//   from the server's own columns — the same ones the printed bill uses. A phone
//   disagreeing with the bill would be the worst defect this lane could ship.

const dot = 'inline-block h-2 w-2 rounded-full';

// Menu prices are tax-exclusive — the server adds tax on top of the subtotal
// (money.js: total = subtotal - discount + tax), so the note must say "plus",
// never "included". Stores commonly name the rate "GST 5%" rather than "GST",
// so the percent is only appended when the name has not already stated it.
const taxNote = (tax) => {
  const rate = `${tax.percent}%`;
  return `plus ${tax.name.includes(rate) ? tax.name : `${tax.name} ${rate}`}`;
};

function Screen({ children, store, subtitle = 'Reading your table code…' }) {
  return (
    <div className="min-h-screen bg-pos-surface pb-40 text-pos-ink">
      <header className="sticky top-0 z-10 bg-pos-deep px-4 py-3 text-white shadow-lg">
        <div className="flex items-center gap-3">
          <LogoMark className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            {/* The card has to say which store it belongs to, not just which
                table: the same "T1" exists in every branch. */}
            <p className="truncate text-sm font-semibold leading-tight">
              {store ? store.name : 'Table ordering'}
            </p>
            <p className="truncate text-xs text-blue-200">
              {store
                ? [store.tableName, store.place, store.city].filter(Boolean).join(' · ')
                : subtitle}
            </p>
          </div>
        </div>
      </header>
      <main className="px-4 py-4">{children}</main>
    </div>
  );
}

function Notice({ tone = 'info', children }) {
  const tones = {
    info: 'bg-blue-50 text-pos-royal',
    warn: 'bg-amber-50 text-amber-900',
    bad: 'bg-red-50 text-red-800',
    good: 'bg-emerald-50 text-emerald-900',
  };
  return <div className={`rounded-2xl px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

// The heading stays generic and the server's own sentence carries the reason —
// an unknown card, a revoked one and a table taken out of service each say
// something different, and none of them may name a store to a stranger.
function Dead({ message }) {
  return (
    <Screen subtitle="Code not recognised">
      <div className="mt-10 text-center">
        <p className="text-lg font-semibold">We can&rsquo;t open this table</p>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    </Screen>
  );
}

// --- joining ----------------------------------------------------------------

/**
 * The gate in front of an occupied table.
 *
 * A party already sitting there has a four-digit code, and asking for it is what
 * stops the next table's phone — or a passer-by's — reading this party's order.
 * An empty table needs no code, so the same component simply offers to start.
 */
function JoinGate({ occupied, busy, error, onStart }) {
  const [code, setCode] = useState('');
  return (
    <div className="space-y-4">
      {occupied ? (
        <>
          <Notice tone="warn">
            Someone at this table has already started an order. Ask them for the four-digit code
            shown on their phone to add to the same bill.
          </Notice>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && code.length === 4) onStart(code);
            }}
            className="space-y-3"
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric"
              autoComplete="off"
              aria-label="Four-digit table code"
              placeholder="0000"
              className="w-full rounded-2xl border-2 border-slate-300 bg-white px-4 py-5 text-center font-mono text-4xl tracking-[0.4em] focus:border-pos-orange focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || code.length !== 4}
              className="w-full rounded-2xl bg-pos-royal px-6 py-4 text-lg font-bold text-white disabled:opacity-40"
            >
              {busy ? 'Joining…' : 'Join this table'}
            </button>
          </form>
        </>
      ) : (
        <button
          type="button"
          onClick={() => !busy && onStart()}
          disabled={busy}
          className="w-full rounded-2xl bg-pos-royal px-6 py-5 text-lg font-bold text-white disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Start my table order'}
        </button>
      )}
      {error ? <Notice tone="bad">{error}</Notice> : null}
    </div>
  );
}

// --- choosing ---------------------------------------------------------------

/**
 * One product, expanded to choose a variant and its modifiers.
 *
 * The minimum/maximum on a group is enforced here so the guest is not sent to
 * the server to be refused, but it is the server that decides: the till's own
 * resolver re-checks every group when the basket arrives.
 */
function ProductSheet({ product, onClose, onAdd }) {
  const [variant, setVariant] = useState(product.variants[0] ?? null);
  const [picked, setPicked] = useState({});
  const [qty, setQty] = useState(1);

  const toggle = (group, option) => {
    setPicked((prev) => {
      const current = prev[group.id] ?? [];
      const has = current.includes(option.id);
      if (has) return { ...prev, [group.id]: current.filter((id) => id !== option.id) };
      // A single-choice group replaces rather than refuses — a guest tapping a
      // second option plainly means "that one instead".
      if (group.maxSelect === 1) return { ...prev, [group.id]: [option.id] };
      if (current.length >= group.maxSelect) return prev;
      return { ...prev, [group.id]: [...current, option.id] };
    });
  };

  const unmet = product.modifierGroups.filter(
    (g) => (picked[g.id] ?? []).length < g.minSelect,
  );

  const options = product.modifierGroups.flatMap((g) =>
    g.options.filter((o) => (picked[g.id] ?? []).includes(o.id)),
  );
  const estimate = lineEstimate({ product, variant, options, qty });

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-black/40">
      <button type="button" className="flex-1" aria-label="Close" onClick={onClose} />
      <div className="max-h-[85vh] overflow-y-auto rounded-t-3xl bg-white px-4 pb-6 pt-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-bold">{product.name}</h2>
          <button type="button" onClick={onClose} className="text-2xl leading-none text-slate-400">
            ×
          </button>
        </div>

        {product.variants.length > 0 ? (
          <section className="mt-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Size</h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {product.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v)}
                  className={`rounded-xl border-2 px-3 py-3 text-left ${
                    variant?.id === v.id
                      ? 'border-pos-royal bg-blue-50'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <span className="block font-semibold">{v.name}</span>
                  <span className="block text-sm text-slate-600">{fmtINR(v.price)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {product.modifierGroups.map((g) => (
          <section key={g.id} className="mt-5">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              {g.name}
              <span className="ml-2 normal-case text-slate-400">
                {g.minSelect > 0 ? `choose ${g.minSelect}` : 'optional'}
                {g.maxSelect > 1 ? `, up to ${g.maxSelect}` : ''}
              </span>
            </h3>
            <div className="mt-2 space-y-2">
              {g.options.map((o) => {
                const on = (picked[g.id] ?? []).includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggle(g, o)}
                    className={`flex w-full items-center justify-between rounded-xl border-2 px-4 py-3 ${
                      on ? 'border-pos-royal bg-blue-50' : 'border-slate-200 bg-white'
                    }`}
                  >
                    <span className="font-medium">{o.name}</span>
                    <span className="text-sm text-slate-600">
                      {o.price ? `+ ${fmtINR(o.price)}` : '—'}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="h-12 w-12 rounded-full border-2 border-slate-300 text-2xl"
              aria-label="Fewer"
            >
              −
            </button>
            <span className="w-8 text-center text-xl font-bold">{qty}</span>
            <button
              type="button"
              onClick={() => setQty((q) => Math.min(99, q + 1))}
              className="h-12 w-12 rounded-full border-2 border-slate-300 text-2xl"
              aria-label="More"
            >
              +
            </button>
          </div>
          <span className="text-lg font-bold">{fmtINR(estimate)}</span>
        </div>

        <button
          type="button"
          disabled={unmet.length > 0}
          onClick={() => onAdd({ product, variant, options, qty })}
          className="mt-4 w-full rounded-2xl bg-pos-royal px-6 py-4 text-lg font-bold text-white disabled:opacity-40"
        >
          {unmet.length > 0 ? `Choose ${unmet[0].name}` : 'Add to the table order'}
        </button>
      </div>
    </div>
  );
}

function Menu({ menu, onPick }) {
  if (menu.categories.length === 0) {
    return <Notice tone="warn">This store has not published a menu yet.</Notice>;
  }
  return (
    <div className="space-y-6">
      {menu.categories.map((c) => (
        <section key={c.id}>
          <h2 className="text-lg font-bold">{c.name}</h2>
          <div className="mt-2 space-y-2">
            {c.products.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-center justify-between gap-3 rounded-2xl bg-white px-4 py-4 text-left shadow-sm"
              >
                <span className="min-w-0">
                  <span className="block font-semibold">{p.name}</span>
                  {p.tax ? (
                    <span className="block text-xs text-slate-500">
                      {taxNote(p.tax)}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-semibold text-pos-royal">
                  {p.variants.length > 0
                    ? `from ${fmtINR(Math.min(...p.variants.map((v) => v.price)))}`
                    : fmtINR(p.price)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// --- the table's order ------------------------------------------------------

/**
 * The bill as the server sees it.
 *
 * Every figure here is a column the till wrote, and the per-line "kitchen has
 * it" flag comes from the KOT existing — not from this phone having pressed
 * Send. That gap is the whole point of §6: a guest is told the truth about
 * whether anyone has started cooking.
 */
function OrderPanel({ order, awaitingStaff }) {
  if (!order) return null;
  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold">Your table&apos;s order</h2>
      {awaitingStaff > 0 ? (
        <div className="mt-2">
          <Notice tone="warn">
            {awaitingStaff === 1 ? 'One basket is' : `${awaitingStaff} baskets are`} waiting for a
            member of staff to confirm. Nothing has been sent to the kitchen yet.
          </Notice>
        </div>
      ) : null}
      <ul className="mt-3 space-y-2">
        {order.lines.map((l) => (
          <li key={l.id} className="rounded-2xl bg-white px-4 py-3 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {l.qty} × {l.name}
                </p>
                {l.modifiers.length > 0 ? (
                  <p className="text-xs text-slate-500">{l.modifiers.join(', ')}</p>
                ) : null}
                <p className="mt-1 text-xs text-slate-500">
                  <span
                    className={`${dot} mr-1 align-middle ${
                      l.sentToKitchen ? 'bg-emerald-500' : 'bg-amber-400'
                    }`}
                  />
                  {l.sentToKitchen ? 'With the kitchen' : 'Waiting for staff'}
                  {' · '}
                  {l.mine ? 'added by you' : `added by ${l.by}`}
                </p>
              </div>
              <span className="shrink-0 font-semibold">{fmtINR(l.lineTotal)}</span>
            </div>
          </li>
        ))}
      </ul>
      <dl className="mt-4 space-y-1 rounded-2xl bg-white px-4 py-3 text-sm shadow-sm">
        <div className="flex justify-between">
          <dt className="text-slate-600">Subtotal</dt>
          <dd>{fmtINR(order.subtotal)}</dd>
        </div>
        {order.discountAmount ? (
          <div className="flex justify-between">
            <dt className="text-slate-600">Discount</dt>
            <dd>− {fmtINR(order.discountAmount)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-slate-600">Tax</dt>
          <dd>{fmtINR(order.taxAmount)}</dd>
        </div>
        <div className="flex justify-between border-t pt-2 text-base font-bold">
          <dt>Total</dt>
          <dd>{fmtINR(order.total)}</dd>
        </div>
      </dl>
      {order.status === 'BILLED' ? (
        <div className="mt-3">
          <Notice tone="info">Your bill has been raised. Please pay at the counter.</Notice>
        </div>
      ) : null}
    </section>
  );
}

// --- page -------------------------------------------------------------------

const POLL_MS = 7000;

export default function GuestTable() {
  const { token } = useParams();

  const [card, setCard] = useState(null);
  const [dead, setDead] = useState(null);
  const [guestToken, setGuestToken] = useState(() => loadGuestToken(token));
  const [visit, setVisit] = useState(null);
  const [order, setOrder] = useState(null);
  const [awaitingStaff, setAwaitingStaff] = useState(0);
  const [basket, setBasket] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [flash, setFlash] = useState('');

  // Held across retries: the server recognises a repeat by this key and answers
  // with the first result, so a double-tap cannot bill the table twice. It is
  // replaced only once a basket has actually been accepted for sending.
  const keyRef = useRef(newIdempotencyKey());

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await scanCard(token);
      if (!live) return;
      if (res.kind === 'ok') return setCard(res.body);
      if (res.kind === 'offline') {
        return setDead('We could not reach the restaurant. Check your connection and try again.');
      }
      setDead(res.message);
    })();
    return () => {
      live = false;
    };
  }, [token]);

  const refresh = useCallback(async () => {
    if (!guestToken) return;
    const res = await fetchOrder(token, guestToken);
    if (res.kind === 'ok') {
      setVisit(res.body.visit);
      setOrder(res.body.order);
      setAwaitingStaff(res.body.awaitingStaff);
      return;
    }
    // The visit this phone belonged to is over — staff closed the table, or the
    // card was re-issued. Dropping the token is what makes the next party a new
    // party on the same printed card.
    if (res.kind === 'error' && (res.status === 409 || res.status === 401)) {
      clearGuestToken(token);
      setGuestToken(null);
      setVisit(null);
      setOrder(null);
      setBasket([]);
      setFlash('This table order was closed. Start again when you are ready.');
    }
  }, [token, guestToken]);

  useEffect(() => {
    if (!guestToken) return undefined;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [guestToken, refresh]);

  const start = async (joinCode) => {
    setBusy(true);
    setJoinError('');
    const res = await startOrJoin(token, joinCode);
    setBusy(false);
    if (res.kind !== 'ok') {
      setJoinError(
        res.kind === 'offline'
          ? 'We could not reach the restaurant. Please try again.'
          : res.message,
      );
      // A wrong code may have been the last one this card allows, so the page
      // re-reads the card rather than leaving a stale "join" screen up.
      if (res.status === 429 || res.status === 404) {
        const again = await scanCard(token);
        if (again.kind === 'ok') setCard(again.body);
      }
      return;
    }
    saveGuestToken(token, res.body.guestToken);
    setGuestToken(res.body.guestToken);
    setVisit(res.body.visit);
  };

  const send = async () => {
    if (basket.length === 0 || busy) return;
    setBusy(true);
    setFlash('');
    const res = await submitBasket(token, guestToken, {
      idempotencyKey: keyRef.current,
      items: basket.map((b) => ({
        productId: b.product.id,
        ...(b.variant ? { variantId: b.variant.id } : {}),
        qty: b.qty,
        ...(b.options.length > 0
          ? { modifierOptionIds: b.options.map((o) => o.id) }
          : {}),
      })),
    });
    setBusy(false);
    if (res.kind !== 'ok') {
      if (res.kind === 'error' && res.status === 409 && res.code === 'POS_QR_SESSION_OVER') {
        clearGuestToken(token);
        setGuestToken(null);
        setFlash(res.message);
        return;
      }
      setFlash(
        res.kind === 'offline'
          ? 'That did not go through. Tap Send again — it will not order twice.'
          : res.message,
      );
      return;
    }
    keyRef.current = newIdempotencyKey();
    setBasket([]);
    setOrder(res.body.submission.order);
    setFlash('Sent. A member of staff will confirm it shortly.');
    refresh();
  };

  const basketTotal = useMemo(() => basket.reduce((a, b) => a + lineEstimate(b), 0), [basket]);

  if (dead) return <Dead message={dead} />;
  if (!card) {
    return (
      <Screen>
        <p className="mt-10 text-center text-slate-500">Reading your table code…</p>
      </Screen>
    );
  }

  if (!guestToken) {
    return (
      <Screen store={card.store}>
        {flash ? (
          <div className="mb-4">
            <Notice tone="info">{flash}</Notice>
          </div>
        ) : null}
        <JoinGate
          occupied={card.table.joinRequired}
          busy={busy}
          error={joinError}
          onStart={start}
        />
        <div className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Today&apos;s menu
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Have a look while you decide. Nothing is ordered until you send it.
          </p>
        </div>
        <div className="mt-4">
          <Menu menu={card.menu} onPick={() => {}} />
        </div>
      </Screen>
    );
  }

  return (
    <Screen store={card.store}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-white px-3 py-1 font-semibold shadow-sm">
            {visit?.guest?.label ?? 'You'}
          </span>
          {visit?.joinCode ? (
            <span className="rounded-full bg-pos-deep px-3 py-1 font-mono text-white">
              Table code {visit.joinCode}
            </span>
          ) : null}
        </div>
        {visit?.joinCode ? (
          <Notice tone="info">
            Share the table code with anyone else at this table so you all order onto one bill.
          </Notice>
        ) : null}
        {flash ? <Notice tone="good">{flash}</Notice> : null}
      </div>

      <OrderPanel order={order} awaitingStaff={awaitingStaff} />

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Add something
        </h2>
        <div className="mt-3">
          <Menu menu={card.menu} onPick={setSheet} />
        </div>
      </section>

      {sheet ? (
        <ProductSheet
          product={sheet}
          onClose={() => setSheet(null)}
          onAdd={(choice) => {
            setBasket((b) => [...b, choice]);
            setSheet(null);
          }}
        />
      ) : null}

      {basket.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-white px-4 py-3 shadow-2xl">
          <ul className="mb-2 max-h-28 space-y-1 overflow-y-auto text-sm">
            {basket.map((b, i) => (
              <li key={`${b.product.id}-${i}`} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {b.qty} × {b.product.name}
                  {b.variant ? ` (${b.variant.name})` : ''}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span>{fmtINR(lineEstimate(b))}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${b.product.name}`}
                    onClick={() => setBasket((prev) => prev.filter((_, j) => j !== i))}
                    className="text-slate-400"
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="w-full rounded-2xl bg-pos-royal px-6 py-4 text-lg font-bold text-white disabled:opacity-40"
          >
            {busy ? 'Sending…' : `Send to the till · ${fmtINR(basketTotal)}`}
          </button>
          <p className="mt-2 text-center text-xs text-slate-500">
            A member of staff confirms every order before the kitchen starts.
          </p>
        </div>
      ) : null}
    </Screen>
  );
}
