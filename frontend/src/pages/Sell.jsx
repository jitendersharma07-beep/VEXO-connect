import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Armchair,
  Ban,
  CreditCard,
  IndianRupee,
  Minus,
  Package,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Send,
  ShoppingBag,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { openRazorpayCheckout } from '../lib/checkout.js';
import { useToast } from '../components/toast.jsx';
import { ErrorNote, Modal, ReasonModal } from '../components/ui.jsx';
import { KotListModal, KotModal, ReceiptModal } from '../components/Receipt.jsx';
import {
  MANUAL_PAYMENT_LABEL,
  ORDER_STATUS_STYLES,
  channelStyle,
  fmtINR,
  fmtTime,
  paymentLabelFor,
  isLicenseError,
  isManagerUp,
  licenseUsable,
} from '../lib/pos.js';

// /sell — cashier screen (contract §11): catalog grid + server-driven cart.
// The order object is ALWAYS the server's latest response; no rupee amount on
// this screen is computed client-side.

function OrderStatusBadge({ status }) {
  return <span className={`badge ${ORDER_STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

function DiscountModal({ open, order, onClose, onOrder }) {
  const [type, setType] = useState('FLAT');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The operator's own ceiling, so the number they type is an informed one.
  // The server still decides; this only saves a refusal at the counter.
  const { discountPolicy } = useAuth();

  useEffect(() => {
    if (open) {
      setType(order?.discount?.type || 'FLAT');
      setValue(order?.discount ? String(order.discount.value) : '');
      setError('');
      setBusy(false);
    }
  }, [open, order?.id]);

  if (!open || !order) return null;

  const apply = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/discount`, { type, value: Number(value) });
      onOrder(data.order);
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setError('');
    setBusy(true);
    try {
      const { data } = await api.delete(`/orders/${order.id}/discount`);
      onOrder(data.order);
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="Order discount" onClose={onClose}>
      <form onSubmit={apply} className="space-y-4">
        <div className="flex gap-2">
          {['FLAT', 'PERCENT'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`btn flex-1 ${type === t ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
            >
              {t === 'FLAT' ? '₹ Flat' : '% Percent'}
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="disc-value">
            {type === 'FLAT' ? `Amount in ₹ (up to subtotal ${fmtINR(order.subtotal)})` : 'Percent (0–100)'}
          </label>
          <input
            id="disc-value"
            type="number"
            inputMode="decimal"
            className="input text-lg tabular-nums"
            min="0"
            max={type === 'PERCENT' ? 100 : undefined}
            step={type === 'FLAT' ? '0.01' : '0.001'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            autoFocus
          />
        </div>
        {discountPolicy ? (
          <p className="text-xs text-slate-500">
            {discountPolicy.allowOrderDiscount
              ? `Your limit is ${discountPolicy.ceiling}, counting item and order discounts together. Above that, a manager can approve it.`
              : 'You are not permitted to apply order discounts. A manager can approve this one.'}
          </p>
        ) : null}
        <ErrorNote message={error} />
        <div className="flex gap-2">
          {order.discount ? (
            <button type="button" className="btn-ghost flex-1" onClick={clear} disabled={busy}>
              Remove discount
            </button>
          ) : null}
          <button type="submit" className="btn-primary flex-1" disabled={busy || value === ''}>
            {busy ? 'Applying…' : 'Apply discount'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function VariantModal({ product, onPick, onClose }) {
  if (!product) return null;
  const variants = (product.variants || []).filter((v) => v.status === 'ACTIVE');
  return (
    <Modal open title={product.name} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-500">Choose a size / variant.</p>
      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold hover:border-pos-royal hover:bg-pos-royal/5"
          onClick={() => onPick(product, null)}
        >
          <span>Regular</span>
          <span>{fmtINR(product.basePrice)}</span>
        </button>
        {variants.map((v) => (
          <button
            key={v.id}
            type="button"
            className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold hover:border-pos-royal hover:bg-pos-royal/5"
            onClick={() => onPick(product, v)}
          >
            <span>{v.name}</span>
            <span>{fmtINR(v.price)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// One value per tender attempt, sent with the payment and held across retries.
// It has to be random rather than derived from the order and the amount: two
// guests splitting a bill down the middle produce two genuinely different
// payments with identical fields, and a derived key would make the second look
// like a retry of the first and silently drop it.
//
// randomUUID needs a secure context, which /pos (https) and localhost both
// are; the fallback is there so a plain-http staging host degrades to a
// slightly weaker key instead of throwing in the middle of taking money.
const newPaymentKey = () =>
  globalThis.crypto?.randomUUID?.() ??
  `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// Records a MANUAL payment (contract §5.3). Change due comes from the server
// response — never computed here.
function PaymentModal({ open, order, onClose, onOrder, onPaid }) {
  const [method, setMethod] = useState('CASH');
  const [tendered, setTendered] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { payment, changeDue, orderStatus }
  const [payKey, setPayKey] = useState(newPaymentKey);

  useEffect(() => {
    if (open && order) {
      setMethod('CASH');
      setTendered('');
      setAmount(String(order.amountDue ?? ''));
      setNote('');
      setError('');
      setBusy(false);
      setResult(null);
      setPayKey(newPaymentKey());
    }
  }, [open, order?.id]);

  // Editing the tender makes it a different tender, so it gets a different
  // key. Without this, a cashier who retries after a failure with a corrected
  // amount would be sending the new figure under the old key, and if the
  // original had in fact landed the server would refuse the correction as a
  // mismatched replay instead of judging it on the amount still due.
  //
  // This does NOT cover starting a second tender with identical fields — the
  // even split — because nothing changes for it to react to. startAnother
  // rolls the key itself for that case.
  useEffect(() => {
    setPayKey(newPaymentKey());
  }, [method, tendered, amount, note]);

  if (!open || !order) return null;

  const due = order.amountDue;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const payload =
        method === 'CASH'
          ? { method, tendered: Number(tendered), idempotencyKey: payKey }
          : {
              method,
              amount: Number(amount),
              idempotencyKey: payKey,
              ...(note.trim() ? { note: note.trim() } : {}),
            };
      const { data } = await api.post(`/orders/${order.id}/payments`, payload);
      onOrder(data.order);
      setResult({ payment: data.payment, changeDue: data.changeDue, orderStatus: data.order.status });
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const startAnother = () => {
    setMethod('CASH');
    setTendered('');
    setAmount(String(order.amountDue ?? ''));
    setNote('');
    setError('');
    setResult(null);
    // Explicit, not left to the effect above: on an evenly split bill the
    // second half is CASH for the same figure as the first, nothing in the
    // form changes, and reusing the key would make the server answer with the
    // first payment and pocket nothing for the second.
    setPayKey(newPaymentKey());
  };

  return (
    <Modal open title="Record payment" onClose={onClose}>
      {/* §5.3: manual records are labelled exactly like this — no gateway wording. */}
      <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-amber-800">
        {MANUAL_PAYMENT_LABEL}
      </div>
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="text-sm font-bold text-emerald-800">Payment recorded.</div>
            <div className="mt-1 text-sm text-emerald-800">
              {result.payment?.method} · {fmtINR(result.payment?.amount)}
              {result.payment?.tendered !== null && result.payment?.tendered !== undefined
                ? ` (tendered ${fmtINR(result.payment.tendered)})`
                : ''}
            </div>
          </div>
          {result.changeDue !== null && result.changeDue !== undefined && Number(result.changeDue) > 0 ? (
            <div className="rounded-lg bg-pos-royal/5 px-4 py-3 text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Change due</div>
              <div className="text-3xl font-extrabold text-pos-ink">{fmtINR(result.changeDue)}</div>
            </div>
          ) : null}
          {result.orderStatus === 'PAID' ? (
            <button type="button" className="btn-primary w-full" onClick={() => onPaid()}>
              Order paid in full — view receipt
            </button>
          ) : (
            <div className="space-y-2">
              <div className="text-center text-sm text-slate-600">
                Amount still due: <span className="font-bold">{fmtINR(order.amountDue)}</span>
              </div>
              <button type="button" className="btn-primary w-full" onClick={startAnother}>
                Record another payment
              </button>
              <button type="button" className="btn-ghost w-full" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-lg bg-slate-50 px-4 py-2 text-center">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Amount due</div>
            <div className="text-2xl font-extrabold text-pos-ink">{fmtINR(due)}</div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {['CASH', 'CARD', 'UPI', 'OTHER'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`btn px-2 ${method === m ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
              >
                {m}
              </button>
            ))}
          </div>
          {method === 'CASH' ? (
            <div>
              <label className="label" htmlFor="pay-tendered">Cash tendered (₹)</label>
              <div className="flex gap-2">
                {/* Cash is counted at the counter with a queue behind it:
                    big type, numeric keypad, tabular digits so a mistyped
                    figure is visible at a glance before it is submitted. */}
                <input
                  id="pay-tendered"
                  type="number"
                  inputMode="decimal"
                  className="input h-14 text-2xl font-bold tabular-nums"
                  min="0"
                  step="0.01"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  required
                  autoFocus
                />
                <button type="button" className="btn-ghost h-14 shrink-0 px-5" onClick={() => setTendered(String(due))}>
                  Exact
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">Change due is calculated by the server.</p>
            </div>
          ) : (
            <>
              <div>
                <label className="label" htmlFor="pay-amount">Amount received (₹)</label>
                <input
                  id="pay-amount"
                  type="number"
                  inputMode="decimal"
                  className="input h-14 text-2xl font-bold tabular-nums"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="label" htmlFor="pay-note">Note (optional, e.g. "GPay, manual entry")</label>
                <input
                  id="pay-note"
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                />
              </div>
            </>
          )}
          <ErrorNote message={error} />
          <button
            type="submit"
            className="btn-orange w-full"
            disabled={busy || (method === 'CASH' ? tendered === '' || Number(tendered) <= 0 : amount === '' || Number(amount) <= 0)}
          >
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </form>
      )}
    </Modal>
  );
}

// Collects a payment through the provider's own checkout.
//
// The distinction this screen exists to hold: the customer finishing checkout
// and the money arriving are two different events, and only the second one is
// a payment. Checkout's success callback is relayed to the server to be
// signature-checked, and even then it buys the cashier nothing but the words
// "confirmation on its way". Until the provider's webhook lands, this screen
// will not say the order is paid — because it is not.
const HANDOFF_POLL_MS = 2000;
const HANDOFF_POLL_LIMIT = 15; // ~30s, then the cashier is told to reconcile

function OnlinePaymentModal({ open, order, company, onClose, onOrder, onPaid }) {
  // idle → opening → waiting (customer is in the widget) → confirming
  //   → settled | unconfirmed | cancelled | failed | error
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    // A handoff may still be polling when the modal closes; this lets the
    // async chain below see that it should stop touching state.
    let live = true;
    setPhase('opening');
    setError('');
    setDetail('');

    const poll = async (intentId) => {
      for (let i = 0; i < HANDOFF_POLL_LIMIT; i += 1) {
        await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
        if (!live) return false;
        try {
          const { data } = await api.get(`/orders/${order.id}`);
          if (!live) return false;
          onOrder(data.order);
          if (data.order.payments.some((p) => p.intentId === intentId)) return true;
        } catch {
          // A failed poll says nothing about the money; keep waiting.
        }
      }
      return false;
    };

    (async () => {
      let intent;
      try {
        const { data } = await api.post(`/orders/${order.id}/payment-intents`, {});
        if (!live) return;
        intent = data;
      } catch (err) {
        if (live) { setPhase('error'); setError(apiError(err)); }
        return;
      }

      if (intent.provider !== 'razorpay' || !intent.keyId || !intent.intent?.providerRef) {
        if (live) {
          setPhase('error');
          setError('This payment provider has no in-browser checkout on this screen.');
          setDetail(intent.intent?.providerRef ? `Reference: ${intent.intent.providerRef}` : '');
        }
        return;
      }

      setPhase('waiting');
      let result;
      try {
        result = await openRazorpayCheckout({
          keyId: intent.keyId,
          orderRef: intent.intent.providerRef,
          amountPaise: Math.round(Number(order.amountDue) * 100),
          companyName: company?.name,
          description: order.invoiceNumber ? `Invoice ${order.invoiceNumber}` : 'Order payment',
        });
      } catch (err) {
        if (live) { setPhase('error'); setError(err?.message || 'Checkout could not be opened'); }
        return;
      }
      if (!live) return;

      if (!result.ok) {
        // Dismissal leaves the intent open on purpose: the same attempt is
        // resumed if the cashier tries again, so the customer is never shown
        // two payable pages for one bill.
        setPhase(result.reason === 'failed' ? 'failed' : 'cancelled');
        setDetail(result.detail || '');
        return;
      }

      setPhase('confirming');
      try {
        const { data } = await api.post(
          `/orders/${order.id}/payment-intents/${intent.intent.id}/handoff`,
          { paymentId: result.paymentId, signature: result.signature },
        );
        if (!live) return;
        onOrder(data.order);
        if (data.settled) return setPhase('settled');
      } catch (err) {
        // The handoff is a hint, and a hint that fails to verify is not a
        // failed payment — the webhook may still be on its way. Say exactly
        // that and keep watching.
        if (live) setDetail(apiError(err));
      }

      const arrived = await poll(intent.intent.id);
      if (live) setPhase(arrived ? 'settled' : 'unconfirmed');
    })();

    return () => { live = false; };
  }, [open, order?.id]);

  if (!open || !order) return null;

  const waiting = phase === 'opening' || phase === 'waiting' || phase === 'confirming';
  const waitingText = {
    opening: 'Opening a payment with the provider…',
    waiting: 'Waiting for the customer to complete payment…',
    confirming: 'Customer completed checkout. Waiting for the provider to confirm…',
  }[phase];

  return (
    <Modal open title="Take payment online" onClose={onClose}>
      {/* NOT the GATEWAY_PAYMENT_LABEL: that one asserts a confirmed payment
          and belongs on a payment record that has one. Nothing is confirmed
          while this modal is open, and the header has to stay true in every
          phase below, including the ones where no money moved. */}
      <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-700">
        ONLINE PAYMENT — RECORDED ONLY WHEN THE PROVIDER CONFIRMS IT
      </div>
      <div className="mb-4 rounded-lg bg-slate-50 px-4 py-2 text-center">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Amount due</div>
        <div className="text-2xl font-extrabold text-pos-ink">{fmtINR(order.amountDue)}</div>
      </div>

      {waiting ? (
        <div className="space-y-3 text-center">
          <RefreshCw className="mx-auto h-6 w-6 animate-spin text-pos-royal" />
          <div className="text-sm font-semibold text-slate-700">{waitingText}</div>
          {phase === 'confirming' ? (
            <p className="text-xs text-slate-500">
              The order stays unpaid until the provider confirms it. Do not hand over goods yet.
            </p>
          ) : null}
        </div>
      ) : null}

      {phase === 'settled' ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">
            Provider confirmed the payment.
          </div>
          <button type="button" className="btn-primary w-full" onClick={onPaid}>
            View receipt
          </button>
        </div>
      ) : null}

      {phase === 'unconfirmed' ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <div className="text-sm font-bold text-amber-900">Payment not confirmed yet.</div>
            <p className="mt-1 text-xs text-amber-900">
              The customer completed checkout but the provider has not confirmed it. The money may
              still arrive. Do not record a second payment for this order — check Gateway
              reconciliation before taking anything by hand.
            </p>
          </div>
          {detail ? <p className="text-xs text-slate-500">{detail}</p> : null}
          <button type="button" className="btn-ghost w-full" onClick={onClose}>Close</button>
        </div>
      ) : null}

      {phase === 'cancelled' || phase === 'failed' ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="text-sm font-bold text-slate-700">
              {phase === 'failed' ? 'The payment failed.' : 'The customer closed the payment window.'}
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Nothing was charged. The order is still due and can be paid online again or recorded
              by hand.
            </p>
          </div>
          {detail ? <p className="text-xs text-slate-500">{detail}</p> : null}
          <button type="button" className="btn-ghost w-full" onClick={onClose}>Close</button>
        </div>
      ) : null}

      {phase === 'error' ? (
        <div className="space-y-3">
          <ErrorNote message={error} />
          {detail ? <p className="text-xs text-slate-500">{detail}</p> : null}
          <button type="button" className="btn-ghost w-full" onClick={onClose}>Close</button>
        </div>
      ) : null}
    </Modal>
  );
}

export default function Sell() {
  const { user, license, company, onlinePayment } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const owner = user.role === 'CUSTOMER_OWNER';
  const managerUp = isManagerUp(user);
  const licenseBlocked = !licenseUsable(license, user);
  const [licMsg, setLicMsg] = useState('');

  // catalog
  const [cats, setCats] = useState(null);
  const [catError, setCatError] = useState('');
  const [activeCat, setActiveCat] = useState('ALL');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [products, setProducts] = useState(null);
  const [prodError, setProdError] = useState('');

  // Whether this grid shows a photo row at all — decided once for the whole
  // grid, not per tile.
  //
  // Photos are opt-in and most shops will start with none, so a per-tile
  // decision would be the worst of both: a shop with two photos out of forty
  // gets two tall tiles and thirty-eight short ones, and because grid rows
  // stretch to their tallest cell, the two photos also punch empty space into
  // every neighbour on their row. Deciding per grid means a catalogue with no
  // photos renders EXACTLY the layout that shipped before this feature — no
  // reserved space, no placeholder, no regression for anyone who never uploads
  // one — while a catalogue that uses photos gets a uniform grid, with the
  // not-yet-photographed items carrying a neutral initial instead of a hole.
  //
  // `products` is null while loading, hence the guard.
  const showPhotos = (products || []).some((p) => p.imageUrl);

  // order context
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // TAKEAWAY | DINE_IN (pre-order)
  const [tableId, setTableId] = useState(null);
  const [tables, setTables] = useState(null);
  const [tablesError, setTablesError] = useState('');
  const [branches, setBranches] = useState(null); // owner only
  const [branchId, setBranchId] = useState('');
  const [openOrders, setOpenOrders] = useState([]);

  // modals
  const [variantFor, setVariantFor] = useState(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [kot, setKot] = useState(null);
  const [kotListFor, setKotListFor] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [voidItemTarget, setVoidItemTarget] = useState(null);
  const [voidOrderOpen, setVoidOrderOpen] = useState(false);
  const [editLineId, setEditLineId] = useState(null);
  const [editLineValue, setEditLineValue] = useState('');

  const surfaceError = useCallback(
    (err, fallback) => {
      const msg = apiError(err, fallback);
      if (isLicenseError(err)) setLicMsg(msg);
      toast(msg, 'error');
    },
    [toast],
  );

  // --- VC-101 customer display (marked block; owner: display sprint) --------
  // Mirrors this station's active order onto the paired customer display.
  // Fire-and-forget on purpose: a till with no display paired gets a cheap
  // in-memory no-op, and a failed push must never disturb the sale.
  const displayOrderId = order?.id ?? null;
  useEffect(() => {
    api.put('/display/state', { orderId: displayOrderId }).catch(() => {});
  }, [displayOrderId]);
  useEffect(
    () => () => {
      // Leaving the Sell screen blanks the customer display.
      api.put('/display/state', { orderId: null }).catch(() => {});
    },
    [],
  );
  // --- end VC-101 marked block ----------------------------------------------

  // --- catalog ---------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/catalog/categories');
        if (alive) setCats(data.categories || []);
      } catch (err) {
        if (alive) setCatError(apiError(err, 'Could not load categories'));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQ(qLive.trim()), 300);
    return () => clearTimeout(t);
  }, [qLive]);

  const loadProducts = useCallback(async () => {
    setProdError('');
    setProducts(null);
    try {
      const query = {};
      if (activeCat !== 'ALL') query.categoryId = activeCat;
      if (q) query.q = q;
      const { data } = await api.get('/catalog/products', { params: query });
      setProducts(data.products || []);
    } catch (err) {
      setProdError(apiError(err, 'Could not load products'));
    }
  }, [activeCat, q]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // --- board (tables + open orders) ------------------------------------------
  const loadTables = useCallback(async () => {
    setTablesError('');
    try {
      const query = owner && branchId ? { branchId } : {};
      const { data } = await api.get('/tables', { params: query });
      setTables((data.tables || []).filter((t) => t.status === 'ACTIVE'));
    } catch (err) {
      setTablesError(apiError(err, 'Could not load tables'));
    }
  }, [owner, branchId]);

  const loadOpenOrders = useCallback(async () => {
    try {
      const query = { status: 'OPEN,BILLED', pageSize: 20 };
      if (owner && branchId) query.branchId = branchId;
      const { data } = await api.get('/orders', { params: query });
      setOpenOrders(data.orders || []);
    } catch {
      // strip is a convenience — never block the screen on it
      setOpenOrders([]);
    }
  }, [owner, branchId]);

  useEffect(() => {
    loadTables();
    loadOpenOrders();
  }, [loadTables, loadOpenOrders]);

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get('/branches');
        if (!alive) return;
        const active = (data.branches || []).filter((b) => b.status === 'ACTIVE');
        setBranches(active);
        if (active.length && !branchId) setBranchId(active[0].id);
      } catch (err) {
        if (alive) toast(apiError(err, 'Could not load branches'), 'error');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  // --- resume (?order=…) -----------------------------------------------------
  useEffect(() => {
    const id = params.get('order');
    if (!id) return;
    (async () => {
      try {
        const { data } = await api.get(`/orders/${id}`);
        setOrder(data.order);
        setMode(data.order.type);
      } catch (err) {
        surfaceError(err, 'Could not load the order');
      } finally {
        params.delete('order');
        setParams(params, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resumeOrder = async (id) => {
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${id}`);
      setOrder(data.order);
      setMode(data.order.type);
    } catch (err) {
      surfaceError(err, 'Could not load the order');
    } finally {
      setBusy(false);
    }
  };

  // --- order mutations -------------------------------------------------------
  const addItem = async (product, variant) => {
    if (licenseBlocked) return;
    if (!order) {
      if (!mode) {
        toast('Choose Takeaway or pick a table first.', 'info');
        return;
      }
      if (mode === 'DINE_IN' && !tableId) {
        toast('Pick a free table for this dine-in order.', 'info');
        return;
      }
      if (owner && !branchId) {
        toast('Choose a branch first.', 'info');
        return;
      }
      setBusy(true);
      try {
        const payload = {
          type: mode,
          ...(mode === 'DINE_IN' ? { tableId } : {}),
          ...(owner ? { branchId } : {}),
          items: [{ productId: product.id, ...(variant ? { variantId: variant.id } : {}), qty: 1 }],
        };
        const { data } = await api.post('/orders', payload);
        setOrder(data.order);
        loadTables();
        loadOpenOrders();
      } catch (err) {
        surfaceError(err, 'Could not start the order');
        if (err?.response?.status === 409) {
          setTableId(null);
          loadTables();
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/items`, {
        productId: product.id,
        ...(variant ? { variantId: variant.id } : {}),
        qty: 1,
      });
      setOrder(data.order);
    } catch (err) {
      surfaceError(err, 'Could not add the item');
    } finally {
      setBusy(false);
    }
  };

  const patchItem = async (item, body, fallback) => {
    setBusy(true);
    try {
      const { data } = await api.patch(`/orders/${order.id}/items/${item.id}`, body);
      setOrder(data.order);
    } catch (err) {
      surfaceError(err, fallback);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (item) => {
    setBusy(true);
    try {
      const { data } = await api.delete(`/orders/${order.id}/items/${item.id}`);
      setOrder(data.order);
    } catch (err) {
      surfaceError(err, 'Could not remove the line');
    } finally {
      setBusy(false);
    }
  };

  const sendKot = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/kot`, {});
      setOrder(data.order);
      setKot(data.kot);
      toast(`KOT #${data.kot.seq} sent to kitchen.`, 'success');
    } catch (err) {
      surfaceError(err, 'Could not send the KOT');
    } finally {
      setBusy(false);
    }
  };

  const billOrder = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/bill`, {});
      setOrder(data.order);
      toast(`Billed — invoice ${data.order.invoiceNumber}`, 'success');
      setPayOpen(true);
      loadOpenOrders();
    } catch (err) {
      surfaceError(err, 'Could not bill the order');
    } finally {
      setBusy(false);
    }
  };

  const showReceipt = async (orderId) => {
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${orderId}/receipt`);
      setReceipt(data.receipt);
    } catch (err) {
      surfaceError(err, 'Could not load the receipt');
    } finally {
      setBusy(false);
    }
  };

  const newSale = () => {
    if (order && (order.status === 'OPEN' || order.status === 'BILLED')) {
      toast(`Order stays ${order.status} — resume it from the table board or Orders.`, 'info');
    }
    setOrder(null);
    setMode(null);
    setTableId(null);
    setReceipt(null);
    loadTables();
    loadOpenOrders();
  };

  const lineEditorSave = async (item) => {
    const v = editLineValue === '' ? 0 : Number(editLineValue);
    await patchItem(item, { lineDiscount: v }, 'Could not set the line discount');
    setEditLineId(null);
  };

  // --- derived hints (non-authoritative, per §3) -----------------------------
  const activeLines = order ? order.items.filter((i) => i.status === 'ACTIVE') : [];
  const hasUnsentKotLines = activeLines.some((i) => i.kotSeq === null || i.kotSeq === undefined);
  const canBill = activeLines.length > 0;
  const orderOpen = order?.status === 'OPEN';
  const netCollected =
    order && Number(order.amountPaid ?? 0) - Number(order.amountRefunded ?? 0) === 0;
  const anyKot = order ? order.items.some((i) => i.kotSeq !== null && i.kotSeq !== undefined) : false;

  const freeTables = (tables || []).filter((t) => !t.currentOrder);

  return (
    // Two columns from 1024 px, not 1280 px. A 1024×768 terminal is the
    // smallest screen this POS is sold against, and at the old xl: breakpoint
    // it fell back to stacked — which put the order panel underneath the whole
    // product grid, so "Bill" sat ~400 px below the fold and the cashier had
    // to scroll to take money. Below 1024 px (tablet portrait) stacking is
    // right, and the sticky bar at the foot of this file keeps the total and
    // the primary action on screen there.
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* ---------------- left: catalog ---------------- */}
      <div className="min-w-0 flex-1">
        {licenseBlocked || licMsg ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {licMsg ||
              'Your licence does not allow POS actions right now. Viewing stays available; new orders and payments are disabled. Contact VEXO to restore the licence.'}
          </div>
        ) : null}

        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Search products…"
              value={qLive}
              onChange={(e) => setQLive(e.target.value)}
              aria-label="Search products"
            />
          </div>
          <button type="button" className="btn-ghost" onClick={loadProducts} title="Reload products">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {catError ? (
          <ErrorNote message={catError} />
        ) : (
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setActiveCat('ALL')}
              className={`btn shrink-0 ${activeCat === 'ALL' ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
            >
              All
            </button>
            {(cats || []).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveCat(c.id)}
                className={`btn shrink-0 ${activeCat === c.id ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {prodError ? (
          <div className="space-y-2">
            <ErrorNote message={prodError} />
            <button type="button" className="btn-ghost" onClick={loadProducts}>
              Try again
            </button>
          </div>
        ) : products === null ? (
          <div className="card flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
          </div>
        ) : products.length === 0 ? (
          <div className="card flex flex-col items-center px-6 py-12 text-center">
            <Package className="mb-3 h-10 w-10 text-slate-300" />
            <div className="text-sm font-semibold text-slate-600">No products found</div>
            <div className="mt-1 text-xs text-slate-400">
              {q ? 'Try a different search.' : 'The catalog for this company is empty.'}
            </div>
          </div>
        ) : (
          // Column count follows the CATALOG's width, not the window's. From
          // lg the order panel takes ~380 px out of the row, so a 1024 px
          // terminal leaves ~356 px here — three columns made 105 px tiles
          // that no thumb can hit accurately. Drop back to two there and
          // climb again once the window can actually afford it.
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {products.map((p) => {
              const hasVariants = (p.variants || []).some((v) => v.status === 'ACTIVE');
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy || licenseBlocked}
                  onClick={() => (hasVariants ? setVariantFor(p) : addItem(p, null))}
                  className="card flex min-h-[104px] flex-col items-start justify-between gap-2 p-3 text-left transition-colors hover:border-pos-royal hover:bg-pos-royal/5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {/* Photo row, present only when this catalogue actually uses
                      photos — see showPhotos above. object-cover because a menu
                      photo arrives in whatever aspect the phone took it in, and
                      letterboxing every tile to fit would waste the height this
                      grid is short of. Fixed height rather than an aspect ratio:
                      aspect scales with tile width, and at 2xl the tiles are
                      wide enough that a 4:3 box would push the price off the
                      first screen of a long menu.

                      aria-hidden and empty alt: the name is right underneath in
                      the same button, so a screen reader announcing the photo
                      would read every item twice. */}
                  {showPhotos ? (
                    <div className="mb-0.5 h-20 w-full shrink-0 overflow-hidden rounded-lg bg-slate-100 sm:h-24">
                      {p.imageUrl ? (
                        <img
                          src={p.imageUrl}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                          /* A row can outlive its file — a restore from an older
                             database, or a half-finished migration of the image
                             directory. Drop the broken-image glyph and leave the
                             neutral placeholder, so one missing file looks like
                             an item without a photo instead of a broken till. */
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-lg font-bold text-slate-300">
                          {p.name.trim().charAt(0).toUpperCase()}
                        </div>
                      )}
                    </div>
                  ) : null}
                  {/* Clamped to three lines. A real café catalog carries names
                      like "Double Chocolate Fudge Brownie with Vanilla Bean
                      Ice Cream", and unclamped it stretched its whole grid row
                      to six lines, pushing the rest of the menu off screen.
                      The full name stays available via title= and on the
                      cart line, which is not width-constrained.

                      Drops to two lines once photos are on, because the tile is
                      carrying a 96 px image as well by then. */}
                  <div
                    className={`${showPhotos ? 'line-clamp-2' : 'line-clamp-3'} w-full text-sm font-bold leading-tight text-pos-ink`}
                    title={p.name}
                  >
                    {p.name}
                  </div>
                  <div className="flex w-full items-center justify-between gap-1">
                    <span className="text-sm font-semibold tabular-nums text-pos-royal">{fmtINR(p.basePrice)}</span>
                    {hasVariants ? (
                      /* Abbreviated: at 1024 px the tile is ~190 px wide and
                         the full word pushed past the tile's right edge. */
                      <span className="badge shrink-0 bg-pos-orange/10 px-1.5 text-[10px] text-pos-ember">opt</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------------- right: order panel ---------------- */}
      {/* Pinned to the top of the viewport on two-column screens so the
          catalog can be scrolled the length of a long menu without carrying
          the totals and the payment button off screen with it. self-start is
          required: a stretched flex child is full-height and sticky has
          nothing left to travel against. */}
      <div className="w-full shrink-0 lg:sticky lg:top-6 lg:w-[380px] lg:self-start 2xl:w-[400px]">
        <div className="card flex min-h-[420px] flex-col lg:max-h-[calc(100vh-3rem)]">
          {!order ? (
            <div className="flex flex-1 flex-col p-4">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">New order</h2>

              {owner ? (
                <div className="mt-3">
                  <label className="label" htmlFor="sell-branch">Branch</label>
                  <select
                    id="sell-branch"
                    className="input"
                    value={branchId}
                    onChange={(e) => {
                      setBranchId(e.target.value);
                      setTableId(null);
                    }}
                  >
                    {(branches || []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMode('TAKEAWAY');
                    setTableId(null);
                  }}
                  className={`btn ${mode === 'TAKEAWAY' ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
                >
                  <ShoppingBag className="h-4 w-4" /> Takeaway
                </button>
                <button
                  type="button"
                  onClick={() => setMode('DINE_IN')}
                  className={`btn ${mode === 'DINE_IN' ? 'bg-pos-royal text-white' : 'border border-slate-200 bg-white text-slate-700'}`}
                >
                  <Armchair className="h-4 w-4" /> Dine-in
                </button>
              </div>

              {mode === 'DINE_IN' ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="label mb-0">Tables (occupied ones resume their order)</span>
                    <button type="button" className="text-xs font-semibold text-pos-royal hover:underline" onClick={loadTables}>
                      Refresh
                    </button>
                  </div>
                  {tablesError ? <ErrorNote message={tablesError} /> : null}
                  {tables === null && !tablesError ? (
                    <div className="py-6 text-center text-sm text-slate-400">Loading tables…</div>
                  ) : null}
                  {tables && tables.length === 0 ? (
                    <div className="py-4 text-center text-sm text-slate-400">
                      No active tables in this branch. Ask a manager to add tables.
                    </div>
                  ) : null}
                  <div className="grid grid-cols-3 gap-2">
                    {(tables || []).map((t) =>
                      t.currentOrder ? (
                        <button
                          key={t.id}
                          type="button"
                          disabled={busy}
                          onClick={() => resumeOrder(t.currentOrder.id)}
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-2 text-center hover:bg-amber-100"
                          title={`Occupied — resume order (${t.currentOrder.status})`}
                        >
                          <div className="text-sm font-bold text-amber-800">{t.name}</div>
                          <div className="text-[10px] font-semibold text-amber-700">
                            {t.currentOrder.status} · {fmtINR(t.currentOrder.total)}
                          </div>
                        </button>
                      ) : (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTableId(t.id)}
                          className={`rounded-lg border px-2 py-2 text-center ${
                            tableId === t.id
                              ? 'border-pos-royal bg-pos-royal text-white'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          }`}
                        >
                          <div className="text-sm font-bold">{t.name}</div>
                          <div className="text-[10px] font-semibold opacity-80">
                            {t.capacity ? `${t.capacity} seats` : 'free'}
                          </div>
                        </button>
                      ),
                    )}
                  </div>
                </div>
              ) : null}

              {mode ? (
                <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  {mode === 'TAKEAWAY'
                    ? 'Takeaway — tap a product to start the order.'
                    : tableId
                      ? `Table ${freeTables.find((t) => t.id === tableId)?.name || ''} selected — tap a product to start the order.`
                      : 'Pick a free (green) table, then tap a product.'}
                </div>
              ) : (
                <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
                  Choose Takeaway or Dine-in to begin.
                </div>
              )}

              {openOrders.length > 0 ? (
                <div className="mt-5">
                  <div className="label">Open orders</div>
                  <div className="flex flex-wrap gap-2">
                    {openOrders.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        disabled={busy}
                        onClick={() => resumeOrder(o.id)}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left text-xs hover:border-pos-royal"
                      >
                        <span className="font-bold text-pos-ink">{o.tableName || 'Takeaway'}</span>{' '}
                        <span className="text-slate-500">{fmtINR(o.total)}</span>{' '}
                        <OrderStatusBadge status={o.status} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-pos-ink">
                      {order.type === 'DINE_IN' ? `Dine-in · ${order.table?.name || ''}` : 'Takeaway'}
                    </span>
                    <OrderStatusBadge status={order.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {order.invoiceNumber ? (
                      <span className="font-semibold">{order.invoiceNumber}</span>
                    ) : (
                      <span>Opened {fmtTime(order.createdAt)} by {order.openedBy?.fullName}</span>
                    )}
                  </div>
                </div>
                <button type="button" className="btn-ghost" onClick={newSale}>
                  New sale
                </button>
              </div>

              {/* min-h-0 lets this shrink inside the capped card; without it a
                  flex child refuses to go below its content height and the
                  totals get pushed out of the pinned panel instead. */}
              <div className="max-h-[46vh] min-h-0 flex-1 overflow-y-auto px-4 py-2 lg:max-h-none">
                {order.items.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">No items on this order.</div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {order.items.map((it) => (
                      <li key={it.id} className={`py-2 ${it.status === 'VOIDED' ? 'opacity-60' : ''}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className={`text-sm font-semibold text-pos-ink ${it.status === 'VOIDED' ? 'line-through' : ''}`}>
                              {it.name}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                              <span>{fmtINR(it.unitPrice)} × {it.qty}</span>
                              {it.kotSeq !== null && it.kotSeq !== undefined ? (
                                <span className="badge bg-sky-100 text-sky-700">KOT #{it.kotSeq}</span>
                              ) : null}
                              {Number(it.lineDiscount) > 0 ? (
                                <span className="badge bg-pos-orange/10 text-pos-ember">disc {fmtINR(it.lineDiscount)}</span>
                              ) : null}
                            </div>
                            {it.status === 'VOIDED' ? (
                              <div className="mt-0.5 text-xs font-semibold text-red-600">
                                VOIDED{it.voidReason ? ` — ${it.voidReason}` : ''}
                              </div>
                            ) : null}
                          </div>
                          <div className="shrink-0 text-right text-sm font-bold text-pos-ink">
                            {it.status === 'VOIDED' ? '—' : fmtINR(it.lineTotal)}
                          </div>
                        </div>

                        {orderOpen && it.status === 'ACTIVE' ? (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            {it.kotSeq === null || it.kotSeq === undefined ? (
                              <>
                                {/* Quantity is the control a cashier hits most
                                    and it used to be a 22 px box — under half
                                    the 44 px touch floor, and a mis-hit here
                                    changes what the customer is charged. */}
                                <button
                                  type="button"
                                  className="btn-touch border-slate-200 text-slate-600 hover:bg-slate-50"
                                  disabled={busy || it.qty <= 1}
                                  onClick={() => patchItem(it, { qty: it.qty - 1 }, 'Could not change quantity')}
                                  aria-label="Decrease quantity"
                                >
                                  <Minus className="h-5 w-5" />
                                </button>
                                <span className="w-8 text-center text-base font-bold tabular-nums">{it.qty}</span>
                                <button
                                  type="button"
                                  className="btn-touch border-slate-200 text-slate-600 hover:bg-slate-50"
                                  disabled={busy}
                                  onClick={() => patchItem(it, { qty: it.qty + 1 }, 'Could not change quantity')}
                                  aria-label="Increase quantity"
                                >
                                  <Plus className="h-5 w-5" />
                                </button>
                                <button
                                  type="button"
                                  className="btn-touch ml-1 border-slate-200 text-red-500 hover:bg-red-50"
                                  disabled={busy}
                                  onClick={() => deleteItem(it)}
                                  aria-label="Remove line"
                                >
                                  <Trash2 className="h-5 w-5" />
                                </button>
                              </>
                            ) : (
                              <span className="text-[11px] text-slate-400">Sent to kitchen — qty locked</span>
                            )}
                            {editLineId === it.id ? (
                              <span className="ml-auto flex items-center gap-1">
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="0.01"
                                  className="input w-24 px-2 py-1 text-sm tabular-nums"
                                  value={editLineValue}
                                  onChange={(e) => setEditLineValue(e.target.value)}
                                  aria-label="Line discount in rupees"
                                  autoFocus
                                />
                                <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={busy} onClick={() => lineEditorSave(it)}>
                                  Set
                                </button>
                                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditLineId(null)}>
                                  <X className="h-3 w-3" />
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="link-touch ml-auto text-[11px] text-pos-royal"
                                onClick={() => {
                                  setEditLineId(it.id);
                                  setEditLineValue(Number(it.lineDiscount) > 0 ? String(it.lineDiscount) : '');
                                }}
                              >
                                <Pencil className="h-4 w-4" /> line disc
                              </button>
                            )}
                            {managerUp && (it.kotSeq !== null && it.kotSeq !== undefined) ? (
                              <button
                                type="button"
                                className="link-touch text-[11px] text-red-600"
                                onClick={() => setVoidItemTarget(it)}
                              >
                                <Ban className="h-4 w-4" /> void
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* totals — server values only */}
              <div className="shrink-0 border-t border-slate-100 px-4 py-3 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span>{fmtINR(order.subtotal)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-slate-600">
                  <span className="flex items-center gap-1.5">
                    Discount
                    {order.discount ? (
                      <span className="badge bg-pos-orange/10 text-pos-ember">
                        {order.discount.type === 'PERCENT' ? `${order.discount.value}%` : fmtINR(order.discount.value)}
                      </span>
                    ) : null}
                    {orderOpen ? (
                      <button
                        type="button"
                        className="link-touch text-pos-royal"
                        onClick={() => setDiscountOpen(true)}
                        aria-label="Edit order discount"
                      >
                        <Tags className="h-4 w-4" />
                      </button>
                    ) : null}
                  </span>
                  <span>{Number(order.discountAmount) > 0 ? `-${fmtINR(order.discountAmount)}` : fmtINR(0)}</span>
                </div>
                <div className="mt-1 flex justify-between text-slate-600">
                  <span>Tax</span>
                  <span>{fmtINR(order.taxAmount)}</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between border-t border-slate-200 pt-2">
                  <span className="text-base font-bold text-pos-ink">Total</span>
                  <span className="text-2xl font-extrabold text-pos-ink">{fmtINR(order.total)}</span>
                </div>
                {order.payments.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                    {order.payments.map((p) => (
                      <div key={p.id}>
                        <div className="flex justify-between text-xs text-slate-600">
                          <span>
                            {p.method}
                            {p.tendered !== null && p.tendered !== undefined ? ` (tendered ${fmtINR(p.tendered)})` : ''}
                          </span>
                          <span>{fmtINR(p.amount)}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span className={`badge px-1.5 py-0 text-[9px] ${channelStyle(p.channel)}`}>{p.channel}</span>
                          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                            {paymentLabelFor(p.channel)}
                          </span>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-between text-xs font-semibold text-slate-700">
                      <span>Paid</span>
                      <span>{fmtINR(order.amountPaid)}</span>
                    </div>
                    {Number(order.amountDue) > 0 ? (
                      <div className="flex justify-between text-xs font-bold text-pos-ember">
                        <span>Balance due</span>
                        <span>{fmtINR(order.amountDue)}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* actions */}
              <div className="shrink-0 space-y-2 border-t border-slate-100 px-4 py-3">
                {orderOpen ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" className="btn-ghost" disabled={busy || !hasUnsentKotLines || licenseBlocked} onClick={sendKot}>
                        <Send className="h-4 w-4" /> Send KOT
                      </button>
                      <button type="button" className="btn-primary" disabled={busy || !canBill || licenseBlocked} onClick={billOrder}>
                        <IndianRupee className="h-4 w-4" /> Bill
                      </button>
                    </div>
                  </>
                ) : null}
                {order.status === 'BILLED' ? (
                  <>
                    {/* Offered only where a provider is actually configured, which
                        is nowhere today — a button that can only answer 501 is
                        worse than no button with a customer at the counter. */}
                    {onlinePayment?.available ? (
                      <button
                        type="button"
                        className="btn-primary w-full"
                        disabled={busy || licenseBlocked}
                        onClick={() => setOnlineOpen(true)}
                      >
                        <CreditCard className="h-4 w-4" /> Pay online · {fmtINR(order.amountDue)} due
                      </button>
                    ) : null}
                    <button type="button" className="btn-orange w-full" disabled={busy || licenseBlocked} onClick={() => setPayOpen(true)}>
                      <IndianRupee className="h-4 w-4" /> Record payment · {fmtINR(order.amountDue)} due
                    </button>
                  </>
                ) : null}
                {order.status === 'PAID' ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center text-sm font-bold text-emerald-800">
                    Payment recorded — order PAID
                  </div>
                ) : null}
                {['BILLED', 'PAID', 'REFUNDED'].includes(order.status) ? (
                  <button type="button" className="btn-ghost w-full" disabled={busy} onClick={() => showReceipt(order.id)}>
                    <Printer className="h-4 w-4" /> Receipt
                  </button>
                ) : null}
                <div className="flex items-center justify-between text-xs">
                  {anyKot ? (
                    <button type="button" className="link-touch text-pos-royal" onClick={() => setKotListFor(order.id)}>
                      Reprint KOTs
                    </button>
                  ) : (
                    <span />
                  )}
                  {managerUp && ['OPEN', 'BILLED'].includes(order.status) ? (
                    <button
                      type="button"
                      className="link-touch text-red-600"
                      disabled={!netCollected}
                      title={netCollected ? 'Void this order' : 'Refund collected payments before voiding'}
                      onClick={() => setVoidOrderOpen(true)}
                    >
                      Void order
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------------- stacked-layout action bar ----------------
          Below 1024 px the order panel sits under the full product grid, so
          the total and the primary action are off screen for as long as the
          cashier is tapping products — on a 768×1024 tablet that measured
          ~470 px below the fold. This bar keeps both on screen. It is not a
          second source of truth: the figures are the same server-sent
          order.total / order.amountDue the panel renders, and the buttons
          call the same handlers with the same guards, so it cannot offer an
          action the panel would refuse. Hidden at lg+, where the pinned
          panel already does this job. */}
      {order && (orderOpen || order.status === 'BILLED') ? (
        <div className="sticky bottom-0 z-30 -mx-4 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_16px_rgba(10,20,36,0.08)] backdrop-blur lg:hidden">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {order.status === 'BILLED' && Number(order.amountDue) > 0 ? 'Balance due' : 'Total'}
              </div>
              <div className="truncate text-xl font-extrabold text-pos-ink">
                {order.status === 'BILLED' && Number(order.amountDue) > 0
                  ? fmtINR(order.amountDue)
                  : fmtINR(order.total)}
              </div>
            </div>
            {orderOpen ? (
              <>
                <button
                  type="button"
                  className="btn-ghost shrink-0"
                  disabled={busy || !hasUnsentKotLines || licenseBlocked}
                  onClick={sendKot}
                >
                  <Send className="h-4 w-4" /> KOT
                </button>
                <button
                  type="button"
                  className="btn-primary shrink-0"
                  disabled={busy || !canBill || licenseBlocked}
                  onClick={billOrder}
                >
                  <IndianRupee className="h-4 w-4" /> Bill
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-orange shrink-0"
                disabled={busy || licenseBlocked}
                onClick={() => setPayOpen(true)}
              >
                <IndianRupee className="h-4 w-4" /> Record payment
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* ---------------- modals ---------------- */}
      <VariantModal
        product={variantFor}
        onClose={() => setVariantFor(null)}
        onPick={(p, v) => {
          setVariantFor(null);
          addItem(p, v);
        }}
      />
      <DiscountModal open={discountOpen} order={order} onClose={() => setDiscountOpen(false)} onOrder={setOrder} />
      <PaymentModal
        open={payOpen}
        order={order}
        onClose={() => setPayOpen(false)}
        onOrder={(o) => {
          setOrder(o);
          loadOpenOrders();
          loadTables();
        }}
        onPaid={() => {
          setPayOpen(false);
          showReceipt(order.id);
        }}
      />
      <OnlinePaymentModal
        open={onlineOpen}
        order={order}
        company={company}
        onClose={() => {
          setOnlineOpen(false);
          loadOpenOrders();
          loadTables();
        }}
        onOrder={setOrder}
        onPaid={() => {
          setOnlineOpen(false);
          showReceipt(order.id);
        }}
      />
      <KotModal kot={kot} onClose={() => setKot(null)} />
      {kotListFor ? <KotListModal orderId={kotListFor} onClose={() => setKotListFor(null)} /> : null}
      {receipt ? <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      <ReasonModal
        open={Boolean(voidItemTarget)}
        title={`Void line — ${voidItemTarget?.name || ''}`}
        hint="The line stays visible as VOIDED and leaves all totals. Manager action — it is audited."
        busyLabel="Void line"
        onClose={() => setVoidItemTarget(null)}
        onSubmit={async (reason) => {
          const { data } = await api.post(`/orders/${order.id}/items/${voidItemTarget.id}/void`, { reason });
          setOrder(data.order);
        }}
      />
      <ReasonModal
        open={voidOrderOpen}
        title="Void order"
        hint="Allowed only while nothing is collected (net of refunds). The invoice number, if assigned, is kept as an audited gap."
        busyLabel="Void order"
        onClose={() => setVoidOrderOpen(false)}
        onSubmit={async (reason) => {
          const { data } = await api.post(`/orders/${order.id}/void`, { reason });
          setOrder(data.order);
          loadTables();
          loadOpenOrders();
        }}
      />
    </div>
  );
}
