// The store request, from "we need this" to "we got it" — §5 end to end.
//
// The five stages are five different things and this screen never blurs them:
//
//   submit    asks. Nothing physical moves.
//   approve   decides how much. Still nothing moves.
//   allocate  reserves it at the source. The shelf still holds it; it is spoken for.
//   dispatch  source goes down, in-transit goes up.
//   receive   in-transit goes down, destination goes up — and damage and
//             shortage are recorded as their own numbers, not rounded away.
//
// "Do not mark dispatch as receipt" is a rule about buttons as much as about
// the ledger, so the dispatch and receive controls are never the same control
// and never appear to the same person for the same transfer by accident.

import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, ClipboardList, PackageCheck, Send, Truck, XCircle } from 'lucide-react';
import { PageHeader, FullScreenSpinner, Modal, ReasonModal } from '../../components/ui.jsx';
import {
  ActionButton,
  Badge,
  Callout,
  ErrorNote,
  Field,
  RefreshButton,
  Table,
  Td,
  Toolbar,
  useInventory,
} from '../../components/inventory.jsx';
import api, { apiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/pos.js';
import { fmtQty, REQUEST_STATUS_STYLES, requestStatusLabel, unitLabel } from '../../lib/inventory.js';

const PRIORITY_STYLES = {
  URGENT: 'bg-red-100 text-red-700',
  HIGH: 'bg-orange-100 text-orange-700',
  NORMAL: 'bg-slate-100 text-slate-600',
  LOW: 'bg-slate-100 text-slate-400',
};

// A random key per button press, so a retry after a timeout replays the same
// dispatch instead of sending a second one. The server is what makes this
// safe; this is what gives it the chance to.
const freshKey = () => `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------------------------------------------------ decide */

// Approving less than was asked for is normal, and it is recorded as its own
// number: the requested quantity is never overwritten, so "we asked for 20 and
// got 12" stays answerable months later.
function DecideForm({ request, onDone, onError }) {
  const [lines, setLines] = useState(() =>
    request.lines.map((l) => ({ lineId: l.id, approvedQty: l.requestedQty, rejectedReason: '' })),
  );
  const [note, setNote] = useState('');
  const set = (id, k) => (e) => setLines((ls) => ls.map((l) => (l.lineId === id ? { ...l, [k]: e.target.value } : l)));

  const submit = async () => {
    try {
      await api.post(`/inventory/requests/${request.id}/decide`, {
        note: note.trim() || undefined,
        lines: lines.map((l) => ({
          lineId: l.lineId,
          approvedQty: String(l.approvedQty ?? '0'),
          rejectedReason: l.rejectedReason.trim() || undefined,
        })),
      });
      await onDone();
    } catch (err) {
      onError(apiError(err));
    }
  };

  return (
    <div className="space-y-3">
      <Callout tone="sky" icon={null}>
        Deciding this changes no stock. It records how much of each line is approved; the shelf is not
        touched until the request is allocated.
      </Callout>
      {request.lines.map((l) => {
        const row = lines.find((x) => x.lineId === l.id);
        return (
          <div key={l.id} className="rounded-lg border border-slate-100 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-pos-ink">{l.item.name}</span>
              <span className="text-xs text-slate-500">asked for {fmtQty(l.requestedQty, l.item.baseUnit)}</span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor={`ap-${l.id}`}>Approve ({unitLabel(l.item.baseUnit)})</label>
                <input
                  id={`ap-${l.id}`}
                  className="input"
                  inputMode="decimal"
                  value={row?.approvedQty ?? ''}
                  onChange={set(l.id, 'approvedQty')}
                />
              </div>
              <div>
                <label className="label" htmlFor={`rr-${l.id}`}>If less, why</label>
                <input
                  id={`rr-${l.id}`}
                  className="input"
                  value={row?.rejectedReason ?? ''}
                  onChange={set(l.id, 'rejectedReason')}
                  placeholder="Optional, recorded on the line"
                />
              </div>
            </div>
          </div>
        );
      })}
      <div>
        <label className="label" htmlFor="decide-note">Note on the decision</label>
        <input id="decide-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <ActionButton className="btn-primary w-full" onClick={submit}>
        <CheckCircle2 className="h-4 w-4" /> Record this decision
      </ActionButton>
    </div>
  );
}

/* ----------------------------------------------------------------- receive */

// Accepted, damaged and short are three separate figures and the form makes
// the operator produce all three. Anything dispatched and neither accepted nor
// damaged is short — it did not arrive — and the arithmetic is shown live so
// nobody signs off a transfer whose numbers do not add up.
function ReceiveForm({ transfer, itemsById, onDone, onError }) {
  const [rows, setRows] = useState(() =>
    transfer.lines.map((l) => ({
      transferLineId: l.id,
      dispatched: l.dispatchedQty ?? '0.000',
      acceptedQty: l.dispatchedQty ?? '0.000',
      damagedQty: '0',
      note: '',
      // The transfer payload carries itemId; the name and base unit come from
      // the request's own lines, which are already on screen.
      item: itemsById.get(l.itemId),
    })),
  );
  const set = (id, k) => (e) => setRows((rs) => rs.map((r) => (r.transferLineId === id ? { ...r, [k]: e.target.value } : r)));

  // Milli arithmetic on strings, for a live hint only. The server recomputes
  // every one of these and its answer is the one that is stored.
  const milli = (s) => {
    const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(s ?? '').trim());
    if (!m) return null;
    return Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
  };

  const submit = async () => {
    try {
      await api.post(`/inventory/transfers/${transfer.id}/receive`, {
        idempotencyKey: freshKey(),
        lines: rows.map((r) => ({
          transferLineId: r.transferLineId,
          acceptedQty: String(r.acceptedQty || '0'),
          damagedQty: String(r.damagedQty || '0'),
          note: r.note.trim() || undefined,
        })),
      });
      await onDone();
    } catch (err) {
      onError(apiError(err));
    }
  };

  return (
    <div className="space-y-3">
      <Callout tone="sky" icon={null}>
        Receiving moves stock out of in-transit and into this location. What is accepted increases the
        shelf; what is damaged and what is short are recorded separately and raise an issue somebody has
        to settle.
      </Callout>
      {rows.map((r) => {
        const d = milli(r.dispatched);
        const a = milli(r.acceptedQty);
        const dm = milli(r.damagedQty);
        const shortMilli = d !== null && a !== null && dm !== null ? d - a - dm : null;
        return (
          <div key={r.transferLineId} className="rounded-lg border border-slate-100 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-pos-ink">{r.item?.name}</span>
              <span className="text-xs text-slate-500">dispatched {fmtQty(r.dispatched, r.item?.baseUnit)}</span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor={`ac-${r.transferLineId}`}>Accepted</label>
                <input id={`ac-${r.transferLineId}`} className="input" inputMode="decimal" value={r.acceptedQty} onChange={set(r.transferLineId, 'acceptedQty')} />
              </div>
              <div>
                <label className="label" htmlFor={`dm-${r.transferLineId}`}>Damaged</label>
                <input id={`dm-${r.transferLineId}`} className="input" inputMode="decimal" value={r.damagedQty} onChange={set(r.transferLineId, 'damagedQty')} />
              </div>
              <div>
                <label className="label" htmlFor={`nt-${r.transferLineId}`}>Note</label>
                <input id={`nt-${r.transferLineId}`} className="input" value={r.note} onChange={set(r.transferLineId, 'note')} />
              </div>
            </div>
            {shortMilli === null ? (
              <div className="mt-2 text-xs font-semibold text-red-600">Those numbers are not a quantity.</div>
            ) : shortMilli > 0 ? (
              <div className="mt-2 text-xs font-semibold text-amber-700">
                {fmtQty((shortMilli / 1000).toFixed(3), r.item?.baseUnit)} will be recorded as short —
                dispatched but neither accepted nor damaged.
              </div>
            ) : shortMilli < 0 ? (
              <div className="mt-2 text-xs font-semibold text-red-600">
                That is more than was dispatched. The server will refuse it.
              </div>
            ) : (
              <div className="mt-2 text-xs text-emerald-700">Fully accounted for.</div>
            )}
          </div>
        );
      })}
      <ActionButton className="btn-primary w-full" onClick={submit}>
        <PackageCheck className="h-4 w-4" /> Record what arrived
      </ActionButton>
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function RequestDetail({ requestId, onClose, onChanged }) {
  const { data, error, loading, reload } = useInventory(`/inventory/requests/${requestId}`, { skip: !requestId });
  const [actionError, setActionError] = useState('');
  const [mode, setMode] = useState(null);

  const refresh = async () => {
    setMode(null);
    await reload();
    await onChanged();
  };

  const post = async (path, body) => {
    setActionError('');
    try {
      await api.post(path, body);
      await refresh();
    } catch (err) {
      setActionError(apiError(err));
      throw err;
    }
  };

  const r = data?.request;
  const transfers = data?.transfers ?? [];
  const receivable = transfers.filter((t) => t.status === 'DISPATCHED');

  return (
    <Modal open={Boolean(requestId)} title={r ? `Request ${r.number}` : 'Request'} onClose={onClose} wide>
      {loading && !data ? <div className="py-6 text-center text-sm text-slate-400">Loading…</div> : null}
      <ErrorNote message={actionError || error} />
      {r ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge map={REQUEST_STATUS_STYLES} value={r.status} label={requestStatusLabel(r.status)} />
            <Badge map={PRIORITY_STYLES} value={r.priority} />
            <span className="text-slate-500">
              {r.source?.name || 'no source yet'} <ArrowRight className="inline h-3 w-3" /> {r.destination?.name}
            </span>
            <span className="text-slate-400">· needed by {fmtDate(r.requiredBy)}</span>
          </div>

          {r.reason ? <p className="text-sm text-slate-600">{r.reason}</p> : null}

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full min-w-[34rem] text-xs">
              <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Asked</th>
                  <th className="px-3 py-2 text-right">Approved</th>
                  <th className="px-3 py-2 text-right">Allocated</th>
                  <th className="px-3 py-2 text-right">Dispatched</th>
                  <th className="px-3 py-2 text-right">Accepted</th>
                  <th className="px-3 py-2 text-right">Damaged</th>
                  <th className="px-3 py-2 text-right">Short</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-pos-ink">{l.item.name}</div>
                      {l.rejectedReason ? <div className="text-slate-400">{l.rejectedReason}</div> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtQty(l.requestedQty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.approvedQty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.allocatedQty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.dispatchedQty)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700">{fmtQty(l.acceptedQty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">{fmtQty(l.damagedQty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-700">{fmtQty(l.shortageQty)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtQty(l.outstandingQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {r.issues?.length ? (
            <Callout tone="amber" title={`${r.issues.length} unsettled issue${r.issues.length === 1 ? '' : 's'}`}>
              {r.issues.map((i) => (
                <div key={i.id}>
                  {i.kind} · {fmtQty(i.qty)} · {i.resolvedAt ? `settled: ${i.resolution}` : 'not settled'}
                </div>
              ))}
            </Callout>
          ) : null}

          {/* Actions offered by status. Every one of these is re-checked on the
              server against the caller's role AND their reach to the location
              being acted on — this only decides what to draw. */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {r.status === 'DRAFT' ? (
              <ActionButton className="btn-primary" onClick={() => post(`/inventory/requests/${r.id}/submit`, {})}>
                <Send className="h-4 w-4" /> Submit for approval
              </ActionButton>
            ) : null}

            {r.status === 'SUBMITTED' ? (
              <button type="button" className="btn-primary" onClick={() => setMode('decide')}>
                <CheckCircle2 className="h-4 w-4" /> Approve or reduce
              </button>
            ) : null}

            {['APPROVED', 'PARTIALLY_APPROVED', 'IN_FULFILMENT'].includes(r.status) ? (
              <>
                <ActionButton className="btn-ghost" onClick={() => post(`/inventory/requests/${r.id}/allocate`, {})}>
                  Reserve at source
                </ActionButton>
                <ActionButton
                  className="btn-orange"
                  onClick={() => post(`/inventory/requests/${r.id}/dispatch`, { idempotencyKey: freshKey() })}
                  confirm="Dispatch reduces stock at the source and puts it in transit. Continue?"
                >
                  <Truck className="h-4 w-4" /> Dispatch
                </ActionButton>
              </>
            ) : null}

            {receivable.map((t) => (
              <button key={t.id} type="button" className="btn-primary" onClick={() => setMode(`receive:${t.id}`)}>
                <PackageCheck className="h-4 w-4" /> Receive {t.number}
              </button>
            ))}

            {!['FULFILLED', 'CLOSED_SHORT', 'CANCELLED', 'REJECTED'].includes(r.status) ? (
              <>
                <button type="button" className="btn-ghost" onClick={() => setMode('close')}>
                  Close
                </button>
                {['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_APPROVED'].includes(r.status) ? (
                  <button type="button" className="btn-ghost text-red-600" onClick={() => setMode('cancel')}>
                    <XCircle className="h-4 w-4" /> Cancel
                  </button>
                ) : null}
              </>
            ) : null}
          </div>

          {mode === 'decide' ? (
            <div className="border-t border-slate-100 pt-3">
              <DecideForm request={r} onDone={refresh} onError={setActionError} />
            </div>
          ) : null}

          {mode?.startsWith('receive:') ? (
            <div className="border-t border-slate-100 pt-3">
              <ReceiveForm
                transfer={transfers.find((t) => t.id === mode.slice(8))}
                itemsById={new Map(r.lines.map((l) => [l.item.id, l.item]))}
                onDone={refresh}
                onError={setActionError}
              />
            </div>
          ) : null}

          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">History</div>
            <ul className="space-y-1 text-xs text-slate-500">
              {(data.events ?? []).map((e) => (
                <li key={e.id}>
                  <span className="font-semibold text-slate-700">{e.action}</span>
                  {e.fromStatus ? ` · ${e.fromStatus} → ${e.toStatus}` : ''} ·{' '}
                  {e.actorRole === 'SYSTEM' ? 'raised by the planner' : e.actorRole || 'system'} ·{' '}
                  {fmtDateTime(e.createdAt)}
                </li>
              ))}
            </ul>
          </div>

          <ReasonModal
            open={mode === 'close'}
            title={`Close ${r.number}`}
            hint="A request with an outstanding quantity cannot be closed quietly. If anything is still outstanding the server will refuse this until you confirm you are cancelling the rest."
            busyLabel="Close request"
            onSubmit={(reason) => post(`/inventory/requests/${r.id}/close`, { reason, cancelOutstanding: true })}
            onClose={() => setMode(null)}
          />
          <ReasonModal
            open={mode === 'cancel'}
            title={`Cancel ${r.number}`}
            hint="Any stock reserved for this request is released back to available."
            busyLabel="Cancel request"
            onSubmit={(reason) => post(`/inventory/requests/${r.id}/cancel`, { reason })}
            onClose={() => setMode(null)}
          />
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------- page */

const OPEN_STATUSES = 'DRAFT,SUBMITTED,PARTIALLY_APPROVED,APPROVED,IN_FULFILMENT';

export default function InventoryRequests() {
  const { user } = useAuth();
  const [filter, setFilter] = useState('open');
  const [openId, setOpenId] = useState(null);

  const params = useMemo(() => {
    if (filter === 'mine') return { mine: 'true' };
    if (filter === 'all') return {};
    return { status: OPEN_STATUSES };
  }, [filter]);

  const { data, error, loading, reload } = useInventory('/inventory/requests', { params });
  const queue = useInventory('/inventory/requests/queue');

  if (!data && loading) return <FullScreenSpinner />;
  if (!data) return <ErrorNote message={error || 'Could not load requests'} />;

  const requests = data.requests ?? [];
  const waiting = queue.data?.requests ?? [];

  return (
    <div>
      <PageHeader
        title="Store requests"
        subtitle="Ask, approve, reserve, dispatch, receive — five stages, never merged"
        actions={
          <RefreshButton
            loading={loading}
            onClick={() => {
              reload();
              queue.reload();
            }}
          />
        }
      />

      {waiting.length ? (
        <Callout tone="amber" icon={ClipboardList} title={`${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting on a decision`}>
          Highest priority and soonest needed first: {waiting.slice(0, 4).map((w) => w.number).join(', ')}
          {waiting.length > 4 ? ` and ${waiting.length - 4} more` : ''}. Nothing has moved for any of them —
          a submitted request changes no stock at all until it is approved and allocated.
        </Callout>
      ) : null}

      <Toolbar>
        <Field label="Show" htmlFor="req-filter">
          <select id="req-filter" className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="open">Still open</option>
            <option value="mine">Assigned to me</option>
            <option value="all">Everything I can see</option>
          </select>
        </Field>
      </Toolbar>

      <ErrorNote message={error} />

      <Table
        head={['Request', 'Route', 'Status', 'Needed by', { key: 'l', label: 'Lines', right: true }, { key: 'o', label: 'Outstanding', right: true }]}
        empty="No requests"
        emptyNote="A store asks for stock here, or a replenishment plan raises the request for them."
      >
        {requests.map((r) => {
          const outstanding = r.lines.filter((l) => l.outstandingQty && l.outstandingQty !== '0.000').length;
          return (
            <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenId(r.id)}>
              <Td>
                <div className="font-semibold text-pos-royal">{r.number}</div>
                <div className="text-xs text-slate-400">
                  raised {fmtDateTime(r.raisedAt)}
                  {r.originPlanId ? ' · by a plan' : ''}
                </div>
              </Td>
              <Td className="text-xs text-slate-600">
                {r.source?.name || <span className="text-slate-300">source not chosen</span>}
                <ArrowRight className="mx-1 inline h-3 w-3 text-slate-300" />
                {r.destination?.name}
              </Td>
              <Td>
                <Badge map={REQUEST_STATUS_STYLES} value={r.status} label={requestStatusLabel(r.status)} />
                {r.assignedApproverId === user.id && r.status === 'SUBMITTED' ? (
                  <div className="mt-1 text-xs font-semibold text-amber-700">waiting on you</div>
                ) : null}
              </Td>
              <Td className="text-xs text-slate-600">{fmtDate(r.requiredBy)}</Td>
              <Td right>{r.lines.length}</Td>
              <Td right className={outstanding ? 'font-semibold text-amber-700' : 'text-slate-400'}>
                {outstanding ? `${outstanding} line${outstanding === 1 ? '' : 's'}` : 'none'}
              </Td>
            </tr>
          );
        })}
      </Table>

      <RequestDetail requestId={openId} onClose={() => setOpenId(null)} onChanged={reload} />
    </div>
  );
}
