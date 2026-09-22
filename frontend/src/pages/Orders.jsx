import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Ban, ChevronLeft, ChevronRight, Printer, ReceiptText, RefreshCw, RotateCcw, X } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { EmptyState, ErrorNote, Modal, PageHeader, ReasonModal } from '../components/ui.jsx';
import { KotListModal, ReceiptModal } from '../components/Receipt.jsx';
import {
  ORDER_STATUS_STYLES,
  canSell,
  channelStyle,
  fmtDateTime,
  fmtINR,
  getAtcScope,
  isAtc,
  isManagerUp,
  isUnconfirmedRefund,
  paymentLabelFor,
  refundLabelFor,
  refundStatusStyle,
} from '../lib/pos.js';

// /orders — history with filters + detail drawer (contract §5.3 reads,
// manager refund/void actions). All amounts are server values.

const STATUSES = ['OPEN', 'BILLED', 'PAID', 'REFUNDED', 'VOID'];
const PAGE_SIZE = 20;

function StatusChip({ status }) {
  return <span className={`badge ${ORDER_STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

// Refund needs amount + mandatory reason (§5.3) — its own modal.
function RefundModal({ open, order, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount('');
      setReason('');
      setError('');
      setBusy(false);
    }
  }, [open, order?.id]);

  if (!open || !order) return null;

  // Display-only hint. The server picks the leg and is the authority; this
  // only warns that provider money cannot come back across the counter, so
  // submitting may REQUEST rather than return.
  const payments = order.payments || [];
  const viaProvider = payments.some((p) => p.channel === 'GATEWAY');
  const mixed = viaProvider && payments.some((p) => p.channel !== 'GATEWAY');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/refunds`, {
        amount: Number(amount),
        reason: reason.trim(),
      });
      // 202 — recorded and holding its money, but the provider never answered.
      // Closing silently here would hide the one state that must be
      // reconciled rather than retried as a fresh refund.
      if (data.warning) toast(data.warning, 'error');
      onDone(data.order);
      onClose();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={viaProvider ? 'Request refund' : 'Record refund'} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-500">
        Collected so far {fmtINR(order.amountPaid)} · already refunded {fmtINR(order.amountRefunded)}
        {Number(order.amountRefundPending) > 0
          ? ` · requested, not yet paid out ${fmtINR(order.amountRefundPending)}`
          : ''}
        . The server refuses refunds beyond the collected amount. This action is audited.
      </p>
      {viaProvider ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Money collected by the payment provider can only be returned by the provider, so a refund
          of that part stays REQUESTED until the provider confirms the payout — submitting it
          returns nothing by itself.
          {mixed
            ? ' This order was paid in more than one part, and a refund has to come out of one of'
              + ' them: refund the card share and the cash share separately.'
            : ''}
        </p>
      ) : null}
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label" htmlFor="refund-amount">Refund amount (₹)</label>
          <input
            id="refund-amount"
            type="number"
            className="input"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div>
          <label className="label" htmlFor="refund-reason">Reason (required)</label>
          <textarea
            id="refund-reason"
            className="input min-h-[70px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
          />
        </div>
        <ErrorNote message={error} />
        <button
          type="submit"
          className="btn-primary w-full"
          disabled={busy || amount === '' || Number(amount) <= 0 || reason.trim().length < 3}
        >
          {busy
            ? viaProvider
              ? 'Requesting…'
              : 'Recording…'
            : viaProvider
              ? 'Request refund'
              : 'Record refund'}
        </button>
      </form>
    </Modal>
  );
}

function DetailDrawer({ orderId, onClose, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [kotsOpen, setKotsOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidItem, setVoidItem] = useState(null);

  const managerUp = isManagerUp(user);

  const load = useCallback(async () => {
    setError('');
    try {
      const { data } = await api.get(`/orders/${orderId}`);
      setOrder(data.order);
    } catch (err) {
      setError(apiError(err, 'Could not load the order'));
    }
  }, [orderId]);

  useEffect(() => {
    setOrder(null);
    load();
  }, [load]);

  const updated = (o) => {
    setOrder(o);
    onChanged();
  };

  const showReceipt = async () => {
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${orderId}/receipt`);
      setReceipt(data.receipt);
    } catch (err) {
      toast(apiError(err, 'Could not load the receipt'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Re-sends an unanswered request under its ORIGINAL idempotency key, so the
  // provider returns the same refund rather than opening a second one. This is
  // the only safe response to an unconfirmed refund — never a new refund.
  const reconcile = async (refundId) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/orders/${orderId}/refunds/${refundId}/reconcile`, {});
      updated(data.order);
      toast(data.warning || 'The provider confirmed the refund; awaiting payout', data.warning ? 'error' : 'success');
    } catch (err) {
      toast(apiError(err, 'Could not reconcile the refund'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Non-authoritative hint (§3): the server refuses a second refund while one
  // is unconfirmed. Mirroring it here means the screen never offers an action
  // whose only outcome is a refusal — and never invites paying the customer twice.
  const holdsUnconfirmed = order ? order.refunds.some(isUnconfirmedRefund) : false;
  const netCollected = order ? Number(order.amountPaid ?? 0) - Number(order.amountRefunded ?? 0) === 0 : false;
  const anyKot = order ? order.items.some((i) => i.kotSeq !== null && i.kotSeq !== undefined) : false;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-pos-ink/40" onMouseDown={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-pos-ink">
                {order?.invoiceNumber || (order ? 'Order (not billed)' : 'Order')}
              </h2>
              {order ? <StatusChip status={order.status} /> : null}
            </div>
            {order ? (
              <div className="mt-0.5 text-xs text-slate-500">
                {order.type === 'DINE_IN' ? `Dine-in · ${order.table?.name || ''}` : 'Takeaway'} ·{' '}
                {order.branch?.code}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 px-5 py-4">
          <ErrorNote message={error} />
          {!order && !error ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
            </div>
          ) : null}

          {order ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs text-slate-600">
                <div>
                  <div className="label mb-0">Opened</div>
                  {fmtDateTime(order.createdAt)}
                  <div className="text-slate-400">by {order.openedBy?.fullName}</div>
                </div>
                <div>
                  <div className="label mb-0">Billed</div>
                  {fmtDateTime(order.billedAt)}
                </div>
                {order.closedAt ? (
                  <div>
                    <div className="label mb-0">Closed</div>
                    {fmtDateTime(order.closedAt)}
                  </div>
                ) : null}
                {order.note ? (
                  <div className="col-span-2">
                    <div className="label mb-0">Note</div>
                    {order.note}
                  </div>
                ) : null}
              </div>

              <h3 className="label mt-5">Items</h3>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                {order.items.map((it) => (
                  <li key={it.id} className={`px-3 py-2 ${it.status === 'VOIDED' ? 'opacity-60' : ''}`}>
                    <div className="flex items-start justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <span className={`font-semibold text-pos-ink ${it.status === 'VOIDED' ? 'line-through' : ''}`}>
                          {it.name}
                        </span>
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
                      <div className="shrink-0 text-right">
                        <div className="font-bold text-pos-ink">{it.status === 'VOIDED' ? '—' : fmtINR(it.lineTotal)}</div>
                        {managerUp &&
                        order.status === 'OPEN' &&
                        it.status === 'ACTIVE' &&
                        it.kotSeq !== null &&
                        it.kotSeq !== undefined ? (
                          <button
                            type="button"
                            className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:underline"
                            onClick={() => setVoidItem(it)}
                          >
                            <Ban className="h-3 w-3" /> void line
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span>{fmtINR(order.subtotal)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>
                    Discount
                    {order.discount ? (
                      <span className="ml-1 text-xs">
                        ({order.discount.type === 'PERCENT' ? `${order.discount.value}%` : fmtINR(order.discount.value)})
                      </span>
                    ) : null}
                  </span>
                  <span>{Number(order.discountAmount) > 0 ? `-${fmtINR(order.discountAmount)}` : fmtINR(0)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Tax</span>
                  <span>{fmtINR(order.taxAmount)}</span>
                </div>
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-base font-bold text-pos-ink">
                  <span>Total</span>
                  <span>{fmtINR(order.total)}</span>
                </div>
                <div className="flex justify-between text-xs text-slate-600">
                  <span>Paid</span>
                  <span>{fmtINR(order.amountPaid)}</span>
                </div>
                {Number(order.amountRefunded) > 0 ? (
                  <div className="flex justify-between text-xs text-slate-600">
                    <span>Refunded</span>
                    <span>-{fmtINR(order.amountRefunded)}</span>
                  </div>
                ) : null}
                {/* Kept apart from Refunded, exactly as the server keeps them:
                    requested money has not come back, so it never gets the
                    minus sign or a place in the refunded figure. */}
                {Number(order.amountRefundPending) > 0 ? (
                  <div className="flex justify-between text-xs font-semibold text-amber-700">
                    <span>Refund requested (not yet paid out)</span>
                    <span>{fmtINR(order.amountRefundPending)}</span>
                  </div>
                ) : null}
                {Number(order.amountDue) > 0 ? (
                  <div className="flex justify-between text-xs font-bold text-pos-ember">
                    <span>Balance due</span>
                    <span>{fmtINR(order.amountDue)}</span>
                  </div>
                ) : null}
              </div>

              {order.payments.length > 0 ? (
                <>
                  <h3 className="label mt-4">Payments</h3>
                  <ul className="space-y-2">
                    {order.payments.map((p) => (
                      <li key={p.id} className="rounded-lg border border-slate-100 px-3 py-2 text-xs">
                        <div className="flex justify-between font-semibold text-pos-ink">
                          <span>{p.method}</span>
                          <span>{fmtINR(p.amount)}</span>
                        </div>
                        {p.tendered !== null && p.tendered !== undefined ? (
                          <div className="flex justify-between text-slate-500">
                            <span>Tendered {fmtINR(p.tendered)}</span>
                            <span>Change {fmtINR(p.changeDue)}</span>
                          </div>
                        ) : null}
                        {p.note ? <div className="text-slate-500">{p.note}</div> : null}
                        <div className="mt-0.5 text-slate-400">
                          {/* A gateway payment has no receiver: the provider
                              settled it and no member of staff took anything.
                              Naming nobody beats a dangling separator. */}
                          {p.receivedBy?.fullName || 'Settled by the provider'} · {fmtDateTime(p.createdAt)}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className={`badge px-2 py-0 text-[9px] ${channelStyle(p.channel)}`}>{p.channel}</span>
                          <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                            {paymentLabelFor(p.channel)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {order.refunds.length > 0 ? (
                <>
                  <h3 className="label mt-4">Refunds</h3>
                  <ul className="space-y-2">
                    {order.refunds.map((f) => {
                      // The minus sign is earned by settlement: a PENDING
                      // request has returned nothing yet, and a FAILED one
                      // never moved any money at all.
                      const settled = f.status === 'SUCCEEDED';
                      const failed = f.status === 'FAILED';
                      const unconfirmed = isUnconfirmedRefund(f);
                      return (
                        <li
                          key={f.id}
                          className={`rounded-lg border px-3 py-2 text-xs ${
                            settled
                              ? 'border-red-100 bg-red-50/50'
                              : failed
                                ? 'border-slate-200 bg-slate-50'
                                : unconfirmed
                                  ? 'border-orange-300 bg-orange-50'
                                  : 'border-amber-200 bg-amber-50/60'
                          }`}
                        >
                          <div
                            className={`flex justify-between font-semibold ${
                              settled ? 'text-red-700' : failed ? 'text-slate-500' : 'text-amber-700'
                            }`}
                          >
                            <span>
                              {settled
                                ? 'Refund'
                                : failed
                                  ? 'Refund (failed)'
                                  : unconfirmed
                                    ? 'Refund unconfirmed'
                                    : 'Refund requested'}
                            </span>
                            <span>{settled ? `-${fmtINR(f.amount)}` : fmtINR(f.amount)}</span>
                          </div>
                          <div className="text-slate-600">{f.reason}</div>
                          {failed && f.failureReason ? (
                            <div className="mt-0.5 font-semibold text-red-600">{f.failureReason}</div>
                          ) : null}
                          {unconfirmed ? (
                            <div className="mt-1 rounded border border-orange-200 bg-white/70 px-2 py-1.5 text-orange-800">
                              <div className="font-semibold">
                                The provider never confirmed this request.
                              </div>
                              <div className="mt-0.5">
                                It may still pay out, so its amount stays held. Reconcile it — raising a
                                new refund could return this money twice.
                              </div>
                              {managerUp ? (
                                <button
                                  type="button"
                                  onClick={() => reconcile(f.id)}
                                  disabled={busy}
                                  className="mt-1.5 rounded-lg bg-orange-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                                >
                                  {busy ? 'Reconciling…' : 'Reconcile with the provider'}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="mt-0.5 text-slate-400">
                            {f.by?.fullName} · {fmtDateTime(f.createdAt)}
                            {settled && f.settledAt ? ` · paid out ${fmtDateTime(f.settledAt)}` : ''}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className={`badge px-2 py-0 text-[9px] ${channelStyle(f.channel)}`}>{f.channel}</span>
                            <span className={`badge px-2 py-0 text-[9px] ${refundStatusStyle(f.status)}`}>{f.status}</span>
                            <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                              {refundLabelFor(f)}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
        </div>

        {order ? (
          <div className="sticky bottom-0 space-y-2 border-t border-slate-200 bg-white px-5 py-3">
            <div className="grid grid-cols-2 gap-2">
              {['BILLED', 'PAID', 'REFUNDED'].includes(order.status) ? (
                <button type="button" className="btn-ghost" disabled={busy} onClick={showReceipt}>
                  <Printer className="h-4 w-4" /> Receipt
                </button>
              ) : null}
              {anyKot ? (
                <button type="button" className="btn-ghost" onClick={() => setKotsOpen(true)}>
                  KOTs
                </button>
              ) : null}
              {canSell(user) && ['OPEN', 'BILLED'].includes(order.status) ? (
                <button type="button" className="btn-primary col-span-2" onClick={() => navigate(`/sell?order=${order.id}`)}>
                  Open in sell screen
                </button>
              ) : null}
            </div>
            {managerUp ? (
              <div className="flex items-center justify-between text-xs">
                {['BILLED', 'PAID'].includes(order.status) ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 font-semibold text-pos-royal hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline"
                    disabled={holdsUnconfirmed}
                    title={
                      holdsUnconfirmed
                        ? 'A refund on this order was never confirmed by the provider. Reconcile that one first — a second refund could return the money twice.'
                        : undefined
                    }
                    onClick={() => setRefundOpen(true)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Refund…
                  </button>
                ) : (
                  <span />
                )}
                {['OPEN', 'BILLED'].includes(order.status) ? (
                  <button
                    type="button"
                    className="font-semibold text-red-600 hover:underline disabled:opacity-40"
                    disabled={!netCollected}
                    title={netCollected ? 'Void this order' : 'Refund collected payments before voiding'}
                    onClick={() => setVoidOpen(true)}
                  >
                    Void order…
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {receipt ? <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      {kotsOpen ? <KotListModal orderId={orderId} onClose={() => setKotsOpen(false)} /> : null}
      <RefundModal open={refundOpen} order={order} onClose={() => setRefundOpen(false)} onDone={updated} />
      <ReasonModal
        open={voidOpen}
        title="Void order"
        hint="Allowed only while nothing is collected (net of refunds). Voided bills keep their invoice number as an audited gap."
        busyLabel="Void order"
        onClose={() => setVoidOpen(false)}
        onSubmit={async (reason) => {
          const { data } = await api.post(`/orders/${order.id}/void`, { reason });
          updated(data.order);
        }}
      />
      <ReasonModal
        open={Boolean(voidItem)}
        title={`Void line — ${voidItem?.name || ''}`}
        hint="The line stays visible as VOIDED and leaves all totals. This action is audited."
        busyLabel="Void line"
        onClose={() => setVoidItem(null)}
        onSubmit={async (reason) => {
          const { data } = await api.post(`/orders/${order.id}/items/${voidItem.id}/void`, { reason });
          updated(data.order);
        }}
      />
    </div>
  );
}

export default function Orders() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const owner = user.role === 'CUSTOMER_OWNER';
  const atc = isAtc(user);
  const atcScope = atc ? getAtcScope() : null;

  const [statusSet, setStatusSet] = useState(new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(params.get('open') || null);

  useEffect(() => {
    if (!owner) return;
    (async () => {
      try {
        const { data: d } = await api.get('/branches');
        setBranches((d.branches || []).filter((b) => b.status === 'ACTIVE'));
      } catch {
        // branch filter is optional; the list still works unfiltered
      }
    })();
  }, [owner]);

  const load = useCallback(async () => {
    if (atc && !atcScope) return;
    setLoading(true);
    setError('');
    try {
      const query = { page, pageSize: PAGE_SIZE };
      if (statusSet.size) query.status = [...statusSet].join(',');
      if (from) query.from = from;
      if (to) query.to = to;
      if (owner && branchId) query.branchId = branchId;
      const { data: d } = await api.get('/orders', { params: query });
      setData(d);
    } catch (err) {
      setError(apiError(err, 'Could not load orders'));
    } finally {
      setLoading(false);
    }
  }, [atc, atcScope, page, statusSet, from, to, owner, branchId]);

  useEffect(() => {
    load();
  }, [load]);

  // drop the ?open param once consumed
  useEffect(() => {
    if (params.get('open')) {
      params.delete('open');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleStatus = (s) => {
    setPage(1);
    setStatusSet((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  if (atc && !atcScope) {
    return (
      <div>
        <PageHeader title="Orders" subtitle="VEXO operators browse per company." />
        <EmptyState
          icon={ReceiptText}
          title="No company selected"
          note="Open a company from the VEXO console and choose “Browse POS data” to scope these screens."
        />
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || PAGE_SIZE))) : 1;

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle={atcScope ? `Company: ${atcScope.name || atcScope.id}` : 'Order history for your scope'}
        actions={
          <button type="button" className="btn-ghost" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        }
      />

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div>
          <div className="label">Status</div>
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`badge border ${
                  statusSet.has(s)
                    ? `${ORDER_STATUS_STYLES[s]} border-transparent ring-2 ring-pos-royal/40`
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="orders-from">From</label>
          <input
            id="orders-from"
            type="date"
            className="input"
            value={from}
            onChange={(e) => {
              setPage(1);
              setFrom(e.target.value);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="orders-to">To</label>
          <input
            id="orders-to"
            type="date"
            className="input"
            value={to}
            onChange={(e) => {
              setPage(1);
              setTo(e.target.value);
            }}
          />
        </div>
        {owner ? (
          <div>
            <label className="label" htmlFor="orders-branch">Branch</label>
            <select
              id="orders-branch"
              className="input"
              value={branchId}
              onChange={(e) => {
                setPage(1);
                setBranchId(e.target.value);
              }}
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {error ? <ErrorNote message={error} /> : null}
      {!data && !error ? (
        <div className="card flex justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-pos-royal/20 border-t-pos-royal" />
        </div>
      ) : null}

      {data && data.orders.length === 0 ? (
        <EmptyState
          icon={ReceiptText}
          title="No orders match these filters"
          note="Orders appear here as soon as the sell screen creates them."
        />
      ) : null}

      {data && data.orders.length > 0 ? (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Invoice</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Items</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Paid</th>
                <th className="px-4 py-3">Opened by</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr
                  key={o.id}
                  className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                  onClick={() => setOpenId(o.id)}
                >
                  <td className="px-4 py-2.5 font-semibold text-pos-ink">{o.invoiceNumber || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {o.type === 'DINE_IN' ? o.tableName || 'Dine-in' : 'Takeaway'}
                  </td>
                  <td className="px-4 py-2.5"><StatusChip status={o.status} /></td>
                  <td className="px-4 py-2.5 text-slate-600">{o.itemCount}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-pos-ink">{fmtINR(o.total)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-600">{fmtINR(o.amountPaid)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{o.openedBy}</td>
                  <td className="px-4 py-2.5 text-slate-500">{fmtDateTime(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
            <span>
              {data.total} order{data.total === 1 ? '' : 's'} · page {data.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                disabled={loading || page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1"
                disabled={loading || page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {openId ? <DetailDrawer orderId={openId} onClose={() => setOpenId(null)} onChanged={load} /> : null}
    </div>
  );
}
