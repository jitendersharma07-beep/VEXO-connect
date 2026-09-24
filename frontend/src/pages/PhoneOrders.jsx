import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  PhoneCall,
  Plus,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/toast.jsx';
import { fmtINR, fmtDateTime } from '../lib/pos.js';
import { EmptyState, ErrorNote, Modal, PageHeader, ReasonModal } from '../components/ui.jsx';
import {
  FULFILMENT_LABELS,
  QUERYABLE_STATUSES,
  errCode,
  phoneStatusStyle,
  reasonLabel,
  unavailableReasonsOf,
} from '../lib/vc104.js';

// VC-104 §5.8–§5.11 — the centre's list and the store decisions. Every status,
// name and amount on this screen is the server's; the screen only renders and
// asks. CANCELLED gets no filter chip: no route can produce it and asking for
// it is a 400 (§4).

const EVENT_LABELS = {
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  REASSIGNED: 'Moved',
};

const addressLine = (a) =>
  a ? [a.line1, a.line2, a.landmark, `${a.city} ${a.pincode}`].filter(Boolean).join(', ') : null;

function ReasonPills({ reasons }) {
  if (!reasons?.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {reasons.map((r) => (
        <li key={`${r.code}-${r.message}`} className="flex items-start gap-2 text-xs">
          <span className="badge shrink-0 bg-amber-100 text-amber-700">{reasonLabel(r.code)}</span>
          <span className="text-slate-600">{r.message}</span>
        </li>
      ))}
    </ul>
  );
}

// §5.10 — owner-only move to another store. Availability is previewed WITHOUT
// the basket (the sidecar does not carry lines); the server re-judges with the
// full basket on the move itself and refuses with reasons if it disagrees.
function ReassignModal({ po, branchName, onClose, onDone }) {
  const [options, setOptions] = useState(null);
  const [optionsError, setOptionsError] = useState('');
  const [targetId, setTargetId] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refusedReasons, setRefusedReasons] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data } = await api.post('/phone-orders/branch-options', {
          fulfilment: po.fulfilment,
          ...(po.addressId ? { addressId: po.addressId } : {}),
          ...(po.scheduledFor ? { scheduledFor: po.scheduledFor } : {}),
        });
        if (live) setOptions(data.options ?? []);
      } catch (err) {
        if (live) setOptionsError(apiError(err, 'Could not load the stores'));
      }
    })();
    return () => {
      live = false;
    };
  }, [po.id]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setRefusedReasons(null);
    try {
      const { data } = await api.post(`/phone-orders/${po.id}/reassign`, {
        branchId: targetId,
        reason: reason.trim(),
      });
      onDone(data);
    } catch (err) {
      if (errCode(err) === 'POS_BRANCH_UNAVAILABLE') {
        setRefusedReasons(unavailableReasonsOf(err));
        setError('That store cannot take this order right now:');
      } else {
        setError(apiError(err, 'Could not move the order'));
      }
      setBusy(false);
    }
  };

  return (
    <Modal open title={`Move ${po.reference} to another store`} onClose={onClose} wide>
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        Availability below is shown without the basket — the final check happens on the move
        itself. Moving re-prices the order for the new store before anything can be billed.
      </p>
      <ErrorNote message={optionsError} />
      {options === null && !optionsError ? <p className="text-sm text-slate-400">Loading stores…</p> : null}
      {options ? (
        <form onSubmit={submit} className="space-y-3">
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {options.map((o) => {
              const isCurrent = o.branchId === po.routedBranchId;
              const selectable = o.available && !isCurrent;
              return (
                <label
                  key={o.branchId}
                  data-testid={`mv-option-${o.branchCode}`}
                  className={`block rounded-lg border p-3 ${
                    selectable
                      ? targetId === o.branchId
                        ? 'cursor-pointer border-pos-royal bg-pos-royal/5'
                        : 'cursor-pointer border-slate-200 hover:bg-slate-50'
                      : 'border-slate-200 bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="target"
                        className="mt-1"
                        disabled={!selectable}
                        checked={targetId === o.branchId}
                        onChange={() => setTargetId(o.branchId)}
                      />
                      <span>
                        <span className="text-sm font-bold text-pos-ink">
                          {o.branchName} <span className="font-mono text-xs text-slate-400">{o.branchCode}</span>
                        </span>
                        {po.fulfilment === 'DELIVERY' ? (
                          <span className="block text-xs text-slate-500">
                            Delivery {fmtINR(o.deliveryCharge)}
                            {o.minOrder !== null && o.minOrder !== undefined ? ` · min order ${fmtINR(o.minOrder)}` : ''}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className={`badge shrink-0 ${isCurrent ? 'bg-sky-100 text-sky-700' : o.available ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                      {isCurrent ? 'Current store' : o.available ? 'Available' : 'Unavailable'}
                    </span>
                  </div>
                  {!isCurrent ? <ReasonPills reasons={o.unavailableReasons} /> : null}
                </label>
              );
            })}
          </div>
          <div>
            <label className="label" htmlFor="move-reason">Reason (required)</label>
            <input
              id="move-reason"
              className="input"
              required
              minLength={3}
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. caller asked for the nearer store"
            />
          </div>
          <ErrorNote message={error} />
          <ReasonPills reasons={refusedReasons} />
          <button
            type="submit"
            className="btn-primary w-full"
            data-testid="mv-submit"
            disabled={busy || !targetId || reason.trim().length < 3}
          >
            {busy ? 'Moving…' : 'Move the order'}
          </button>
        </form>
      ) : null}
      <p className="mt-2 text-xs text-slate-400">
        {branchName(po.routedBranchId)} holds it now. An order with an issued invoice, or with
        money already taken, never moves.
      </p>
    </Modal>
  );
}

export default function PhoneOrders() {
  const { user, branch } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status') || '';
  const openId = params.get('open') || '';

  const isOwner = user.role === 'CUSTOMER_OWNER';
  const myBranchId = branch?.id ?? null;

  const setParam = (key, value) => {
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: key === 'open' },
    );
  };

  // Branch directory for id → name. branch-options is this module's own branch
  // surface (§5.6) — asked as PICKUP with no basket, it returns every store
  // with its name and code, which is all the list needs.
  const [branchMap, setBranchMap] = useState({});
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data } = await api.post('/phone-orders/branch-options', { fulfilment: 'PICKUP' });
        if (!live) return;
        const map = {};
        for (const o of data.options ?? []) map[o.branchId] = { name: o.branchName, code: o.branchCode };
        setBranchMap(map);
      } catch {
        // Names fall back to ids; the list still works.
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const branchName = useCallback(
    (id) => (id ? branchMap[id]?.name ?? `#${String(id).slice(-6)}` : '—'),
    [branchMap],
  );

  // -- list --------------------------------------------------------------------
  const [rows, setRows] = useState(null);
  const [listError, setListError] = useState('');
  const [listBusy, setListBusy] = useState(false);

  const fetchList = useCallback(async () => {
    setListBusy(true);
    try {
      const { data } = await api.get('/phone-orders', {
        params: statusParam ? { status: statusParam } : {},
      });
      setRows(data.phoneOrders ?? []);
      setListError('');
    } catch (err) {
      setListError(apiError(err, 'Could not load phone orders'));
    } finally {
      setListBusy(false);
    }
  }, [statusParam]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // -- detail ------------------------------------------------------------------
  const [detail, setDetail] = useState(null);
  const [detailCustomer, setDetailCustomer] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [moveResult, setMoveResult] = useState(null); // {priceChanged, payableQuote} after a reassign
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!openId) {
      setDetail(null);
      setDetailCustomer(null);
      setDetailError('');
      return;
    }
    try {
      const { data } = await api.get(`/phone-orders/${openId}`);
      setDetail(data.phoneOrder);
      setDetailError('');
      try {
        const c = await api.get(`/phone-orders/customers/${data.phoneOrder.customerId}`);
        setDetailCustomer(c.data.customer);
      } catch {
        setDetailCustomer(null);
      }
    } catch (err) {
      setDetail(null);
      setDetailCustomer(null);
      setDetailError(apiError(err, 'Could not open that phone order'));
    }
  }, [openId]);

  useEffect(() => {
    setMoveResult(null);
    fetchDetail();
  }, [fetchDetail]);

  const refetchAll = async () => {
    await Promise.all([fetchList(), fetchDetail()]);
  };

  const accept = async () => {
    setActionBusy(true);
    try {
      const { data } = await api.post(`/phone-orders/${detail.id}/accept`, {});
      toast(`${data.phoneOrder.reference} accepted by ${data.phoneOrder.acceptedByName}.`, 'success');
    } catch (err) {
      // Someone else decided first (§5.8) — say so and show the truth.
      toast(apiError(err, 'Could not accept'), 'error');
    } finally {
      setActionBusy(false);
      refetchAll();
    }
  };

  const canDecide = detail && detail.status === 'SUBMITTED' && (isOwner || myBranchId === detail.routedBranchId);
  const canMove = detail && isOwner && (detail.status === 'SUBMITTED' || detail.status === 'REJECTED');
  const invoiceIssued = Boolean(detail?.order?.invoiceNumber);
  const detailAddress = detail?.addressId
    ? detailCustomer?.addresses?.find((a) => a.id === detail.addressId) ?? null
    : null;

  return (
    <div>
      <PageHeader
        title="Phone orders"
        subtitle="Central order-taking: every order here was priced by the routed store's own bill."
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={fetchList} disabled={listBusy} aria-label="Refresh">
              <RefreshCw className={`h-4 w-4 ${listBusy ? 'animate-spin' : ''}`} />
            </button>
            <Link to="/phone-orders/new" className="btn-primary whitespace-nowrap">
              <Plus className="h-4 w-4" /> New phone order
            </Link>
          </>
        }
      />

      {/* status filter — queryable statuses only; CANCELLED is unreachable and unqueryable (§4) */}
      <div className="mb-4 flex flex-wrap gap-2" data-testid="po-chips">
        {[['', 'All'], ...QUERYABLE_STATUSES.map((s) => [s, s.charAt(0) + s.slice(1).toLowerCase()])].map(
          ([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                statusParam === value
                  ? 'border-pos-royal bg-pos-royal text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
              onClick={() => setParam('status', value)}
            >
              {label}
            </button>
          ),
        )}
      </div>

      <ErrorNote message={detailError} />

      {detail ? (
        <div className="card mb-6 p-5" data-testid="po-detail">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-lg font-bold text-pos-ink">{detail.reference}</h2>
                <span className={`badge ${phoneStatusStyle(detail.status)}`}>{detail.status}</span>
                <span className="badge bg-slate-100 text-slate-600">
                  {FULFILMENT_LABELS[detail.fulfilment] ?? detail.fulfilment}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {detail.scheduledFor ? `Scheduled for ${fmtDateTime(detail.scheduledFor)}` : 'As soon as possible'}
                {' · '}taken by {detail.operatorName}
              </p>
            </div>
            <button type="button" className="btn-ghost" onClick={() => setParam('open', '')} aria-label="Close detail">
              <X className="h-4 w-4" />
            </button>
          </div>

          {moveResult?.priceChanged ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" data-testid="po-move-banner">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The move re-priced this order for the new store. Read the new quote to the caller:{' '}
                <strong>{fmtINR(moveResult.payableQuote)}</strong>.
              </span>
            </div>
          ) : null}

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Caller</div>
              {detailCustomer ? (
                <div className="mt-1 text-sm">
                  <div className="font-semibold text-pos-ink">{detailCustomer.name}</div>
                  <div className="text-slate-500">{detailCustomer.phone}</div>
                  {detailAddress ? (
                    <div className="mt-1 text-xs text-slate-500">
                      {detailAddress.label}: {addressLine(detailAddress)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-1 text-sm text-slate-400">Caller details unavailable</div>
              )}
              {detail.note ? <div className="mt-2 text-xs text-amber-700">Note: {detail.note}</div> : null}
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Store</div>
              <div className="mt-1 text-sm">
                <div className="font-semibold text-pos-ink">{branchName(detail.routedBranchId)}</div>
                {detail.status === 'ACCEPTED' ? (
                  <div className="text-xs text-emerald-700">
                    Accepted by {detail.acceptedByName} · {fmtDateTime(detail.acceptedAt)}
                  </div>
                ) : null}
                {detail.status === 'REJECTED' ? (
                  <div className="text-xs text-red-700">
                    Rejected by {detail.rejectedByName} · {fmtDateTime(detail.rejectedAt)}
                    {detail.rejectReason ? <div className="mt-0.5">“{detail.rejectReason}”</div> : null}
                  </div>
                ) : null}
                {detail.status === 'SUBMITTED' ? (
                  <div className="text-xs text-slate-500">Waiting for the store to accept</div>
                ) : null}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Money</div>
              <dl className="mt-1 space-y-0.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">Subtotal</dt>
                  <dd className="font-semibold text-pos-ink">{fmtINR(detail.order?.subtotal)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">Tax</dt>
                  <dd className="font-semibold text-pos-ink">{fmtINR(detail.order?.taxAmount)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">Food &amp; tax (order total)</dt>
                  <dd className="font-semibold text-pos-ink">{fmtINR(detail.order?.total)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">Delivery — quoted</dt>
                  <dd className="font-semibold text-pos-ink">{fmtINR(detail.deliveryCharge)}</dd>
                </div>
                <div className="flex justify-between gap-3 border-t border-slate-200 pt-1">
                  <dt className="font-semibold text-slate-700">To collect</dt>
                  <dd className="text-base font-extrabold text-pos-ink" data-testid="po-detail-payable">{fmtINR(detail.payableQuote)}</dd>
                </div>
              </dl>
              {detail.deliveryChargeBillable === false && detail.fulfilment === 'DELIVERY' ? (
                <p className="mt-1 text-[11px] leading-snug text-slate-400">
                  Delivery charge is a quote collected with the bill — not on the tax invoice (C-6 open).
                </p>
              ) : null}
              {invoiceIssued ? (
                <p className="mt-1 text-[11px] font-semibold text-slate-500">
                  Invoice {detail.order.invoiceNumber} issued — this order can no longer move stores.
                </p>
              ) : null}
            </div>
          </div>

          {detail.events?.length ? (
            <div className="mt-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">History</div>
              <ul className="mt-1 space-y-1 text-xs text-slate-600">
                {detail.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="font-mono text-slate-400">{fmtDateTime(e.at)}</span>
                    <span className="font-semibold">{EVENT_LABELS[e.action] ?? e.action}</span>
                    {e.action === 'REASSIGNED' ? (
                      <span>
                        {branchName(e.fromBranchId)} → {branchName(e.toBranchId)}
                      </span>
                    ) : e.toBranchId ? (
                      <span>to {branchName(e.toBranchId)}</span>
                    ) : null}
                    {e.reason ? <span className="text-slate-500">“{e.reason}”</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            {canDecide ? (
              <>
                <button type="button" className="btn-primary" data-testid="po-accept" disabled={actionBusy} onClick={accept}>
                  <CheckCircle2 className="h-4 w-4" /> Accept at {branchName(detail.routedBranchId)}
                </button>
                <button type="button" className="btn-ghost" data-testid="po-reject" disabled={actionBusy} onClick={() => setRejectOpen(true)}>
                  <XCircle className="h-4 w-4" /> Reject
                </button>
              </>
            ) : null}
            {canMove && !invoiceIssued ? (
              <button type="button" className="btn-ghost" data-testid="po-move" disabled={actionBusy} onClick={() => setReassignOpen(true)}>
                <ArrowRightLeft className="h-4 w-4" /> Move to another store
              </button>
            ) : null}
            {!canDecide && detail.status === 'SUBMITTED' && !isOwner ? (
              <p className="text-xs text-slate-400">Only {branchName(detail.routedBranchId)} can decide this order.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <ErrorNote message={listError} />
      {rows === null && !listError ? (
        <div className="card p-6 text-sm text-slate-400">Loading…</div>
      ) : null}
      {rows !== null ? (
        rows.length ? (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="po-list">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Store</th>
                  <th className="px-4 py-3">Fulfilment</th>
                  <th className="px-4 py-3">For</th>
                  <th className="px-4 py-3 text-right">Food &amp; tax</th>
                  <th className="px-4 py-3 text-right">To collect</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((po) => (
                  <tr
                    key={po.id}
                    className={`cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 ${
                      openId === po.id ? 'bg-pos-royal/5' : ''
                    }`}
                    onClick={() => setParam('open', po.id)}
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-pos-ink">{po.reference}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${phoneStatusStyle(po.status)}`}>{po.status}</span>
                    </td>
                    <td className="px-4 py-3">{branchName(po.routedBranchId)}</td>
                    <td className="px-4 py-3">{FULFILMENT_LABELS[po.fulfilment] ?? po.fulfilment}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {po.scheduledFor ? fmtDateTime(po.scheduledFor) : 'ASAP'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">{fmtINR(po.order?.total)}</td>
                    <td className="px-4 py-3 text-right font-bold text-pos-ink">{fmtINR(po.payableQuote)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={PhoneCall}
            title={statusParam ? `No ${statusParam.toLowerCase()} phone orders` : 'No phone orders yet'}
            note="Orders taken over the phone appear here the moment they are submitted to a store."
          />
        )
      ) : null}

      <ReasonModal
        open={rejectOpen}
        title={`Reject ${detail?.reference ?? ''}`}
        hint="The reason is recorded on the order and shown to the centre."
        busyLabel="Reject order"
        onSubmit={async (reason) => {
          await api.post(`/phone-orders/${detail.id}/reject`, { reason });
          toast(`${detail.reference} rejected.`, 'success');
          refetchAll();
        }}
        onClose={() => setRejectOpen(false)}
      />

      {reassignOpen && detail ? (
        <ReassignModal
          po={detail}
          branchName={branchName}
          onClose={() => setReassignOpen(false)}
          onDone={(data) => {
            setReassignOpen(false);
            // The server's priceChanged tracks the BILLED order (total+tax)
            // only; the quoted delivery charge sits outside it (C-6: quoted,
            // never billed), so with a company-wide menu the flag stays false
            // on the very moves that change what the caller pays. The operator
            // must re-read the quote whenever the PAYABLE quote moved — so
            // also compare the two server-computed quotes. No client money
            // math: both numbers arrive from the server; this is only !==.
            const quoteChanged =
              Boolean(data.priceChanged) ||
              data.phoneOrder.payableQuote !== detail?.payableQuote;
            setMoveResult({ priceChanged: quoteChanged, payableQuote: data.phoneOrder.payableQuote });
            toast(
              quoteChanged
                ? `Moved. The price changed — new quote ${fmtINR(data.phoneOrder.payableQuote)}.`
                : 'Moved. The price did not change.',
              quoteChanged ? 'info' : 'success',
            );
            refetchAll();
          }}
        />
      ) : null}
    </div>
  );
}
