// The two ways stock changes without anyone buying, selling or moving it:
// somebody counted the shelf, or somebody threw something away.
//
// Both are sensitive, so both are gated the way §8 asks. A count is a claim
// until a second person approves it — and the server refuses an approval by
// the person who submitted it, which is a rule a role list cannot express and
// this screen must not pretend to work around. Wastage always carries a
// written reason.

import { useMemo, useState } from 'react';
import { ClipboardCheck, Trash2, TriangleAlert } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner, Modal, ReasonModal } from '../../components/ui.jsx';
import {
  ActionButton,
  Badge,
  Callout,
  ErrorNote,
  Field,
  LocationSelect,
  RefreshButton,
  Table,
  Td,
  Toolbar,
  useInventory,
  useLocations,
} from '../../components/inventory.jsx';
import api, { apiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateTime } from '../../lib/pos.js';
import { COST_STATUS_STYLES, fmtPaise, fmtQty, isInventoryOwner, qtyIsNegative, qtyIsZero } from '../../lib/inventory.js';

const COUNT_STATUS_STYLES = {
  DRAFT: 'bg-slate-200 text-slate-600',
  SUBMITTED: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-700',
};

function CountDetail({ count, onClose, onChanged, canApprove }) {
  const [actionError, setActionError] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const act = async (verb, body) => {
    setActionError('');
    try {
      await api.post(`/inventory/counts/${count.id}/${verb}`, body ?? {});
      await onChanged();
      onClose();
    } catch (err) {
      setActionError(apiError(err));
      throw err;
    }
  };

  if (!count) return null;

  const variance = count.lines.filter((l) => !qtyIsZero(l.varianceQty));

  return (
    <Modal open title={`Stock count ${count.number}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge map={COUNT_STATUS_STYLES} value={count.status} />
          <span className="text-slate-600">{count.location?.name}</span>
          <span className="text-slate-400">· counted {fmtDateTime(count.submittedAt || count.createdAt)}</span>
        </div>

        <ErrorNote message={actionError} />

        {count.status === 'SUBMITTED' ? (
          <Callout tone="amber" icon={null} title="Nothing has moved yet">
            A count is a claim about the shelf until somebody approves it. Approving posts the difference
            to the ledger as its own movement, so the correction is visible as a correction rather than
            appearing as if the stock had always been that figure.
          </Callout>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full min-w-[32rem] text-xs">
            <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Counted in</th>
                <th className="px-3 py-2 text-right">On the shelf</th>
                <th className="px-3 py-2 text-right">System said</th>
                <th className="px-3 py-2 text-right">Difference</th>
                <th className="px-3 py-2 text-right">Value posted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {count.lines.map((l) => (
                <tr key={l.id} className={qtyIsZero(l.varianceQty) ? '' : 'bg-amber-50/50'}>
                  <td className="px-3 py-2 font-semibold text-pos-ink">{l.item?.name}</td>
                  <td className="px-3 py-2 text-slate-500">{l.enteredUnit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.countedQty, l.item?.baseUnit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtQty(l.systemQty, l.item?.baseUnit)}</td>
                  <td
                    className={`px-3 py-2 text-right font-bold tabular-nums ${
                      qtyIsZero(l.varianceQty) ? 'text-slate-300' : qtyIsNegative(l.varianceQty) ? 'text-red-600' : 'text-emerald-700'
                    }`}
                  >
                    {fmtQty(l.varianceQty, l.item?.baseUnit)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {l.postedValuePaise === null ? (
                      <span className="text-slate-300">not posted</span>
                    ) : (
                      <>
                        {fmtPaise(l.postedValuePaise)}
                        {l.costStatus && l.costStatus !== 'ACTUAL' ? (
                          <div className={`badge mt-1 ${COST_STATUS_STYLES[l.costStatus]}`}>{l.costStatus}</div>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {variance.length ? (
          <p className="text-xs text-slate-400">
            {variance.length} line{variance.length === 1 ? '' : 's'} differ from the ledger. A negative
            difference is stock the ledger thought was there and the shelf did not have.
          </p>
        ) : (
          <p className="text-xs text-emerald-700">Every line matches the ledger exactly.</p>
        )}

        {count.status === 'SUBMITTED' ? (
          canApprove ? (
            <div className="flex gap-2">
              <ActionButton
                className="btn-primary grow"
                confirm="Approving posts the difference to the ledger. Continue?"
                onClick={() => act('approve')}
              >
                <ClipboardCheck className="h-4 w-4" /> Approve and post
              </ActionButton>
              <button type="button" className="btn-ghost text-red-600" onClick={() => setRejecting(true)}>
                Reject
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Only the company owner approves a stock count, and never the person who submitted it. That
              second rule is enforced by the server on the request itself, not by hiding this button.
            </p>
          )
        ) : null}

        <ReasonModal
          open={rejecting}
          title={`Reject ${count.number}`}
          hint="Rejecting posts nothing. The count stays on file with the reason, so a disputed count is still evidence."
          busyLabel="Reject count"
          onSubmit={(reason) => act('reject', { reason })}
          onClose={() => setRejecting(false)}
        />
      </div>
    </Modal>
  );
}

export default function InventoryAdjustments() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const { locations } = useLocations();
  const [locationId, setLocationId] = useState('');
  const [openCount, setOpenCount] = useState(null);

  const params = useMemo(() => (locationId ? { locationId } : {}), [locationId]);
  const counts = useInventory('/inventory/counts', { params });
  const wastage = useInventory('/inventory/wastage', { params });

  if (!counts.data && counts.loading) return <FullScreenSpinner />;
  if (!counts.data) return <ErrorNote message={counts.error || 'Could not load stock counts'} />;

  const rows = counts.data.counts ?? [];
  const waiting = rows.filter((c) => c.status === 'SUBMITTED');
  const waste = wastage.data?.wastage ?? [];
  const unvaluedWaste = waste.filter((w) => w.lines.some((l) => l.costStatus === 'MISSING'));

  return (
    <div>
      <PageHeader
        title="Counts and wastage"
        subtitle="Corrections to the ledger, each one attributable to a person and a reason"
        actions={
          <RefreshButton
            loading={counts.loading || wastage.loading}
            onClick={() => {
              counts.reload();
              wastage.reload();
            }}
          />
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={ClipboardCheck}
          label="Counts awaiting approval"
          value={waiting.length}
          hint="Nothing posted until a second person signs"
          accent={waiting.length ? 'orange' : 'slate'}
        />
        <StatCard icon={Trash2} label="Wastage records" value={waste.length} hint="Most recent 200" accent="slate" />
        <StatCard
          icon={TriangleAlert}
          label="Written off at unknown cost"
          value={unvaluedWaste.length}
          hint={unvaluedWaste.length ? 'Shown as unknown, not as zero' : 'Every write-off is valued'}
          accent={unvaluedWaste.length ? 'orange' : 'slate'}
        />
      </div>

      {unvaluedWaste.length ? (
        <Callout tone="amber" title="Some write-offs have no cost behind them">
          Stock that was never received at a known price cannot be written off at a known value. Those
          lines say so. Counting them as ₹0.00 would make throwing food away look free.
        </Callout>
      ) : null}

      <Toolbar>
        <Field label="Location" htmlFor="adj-loc">
          <LocationSelect id="adj-loc" value={locationId} onChange={setLocationId} locations={locations} />
        </Field>
      </Toolbar>

      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Stock counts</h2>
      <ErrorNote message={counts.error} />
      <Table
        head={['Count', 'Location', 'Status', { key: 'l', label: 'Lines', right: true }, { key: 'v', label: 'Lines differing', right: true }, 'When']}
        empty="No stock counts"
        emptyNote="A count records what is physically on the shelf so the ledger can be corrected against it."
      >
        {rows.map((c) => {
          const diff = c.lines.filter((l) => !qtyIsZero(l.varianceQty)).length;
          return (
            <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenCount(c)}>
              <Td className="font-semibold text-pos-royal">{c.number}</Td>
              <Td className="text-xs text-slate-600">{c.location?.name}</Td>
              <Td>
                <Badge map={COUNT_STATUS_STYLES} value={c.status} />
              </Td>
              <Td right>{c.lines.length}</Td>
              <Td right className={diff ? 'font-semibold text-amber-700' : 'text-slate-300'}>{diff}</Td>
              <Td className="text-xs text-slate-500">{fmtDateTime(c.submittedAt || c.createdAt)}</Td>
            </tr>
          );
        })}
      </Table>

      <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Wastage</h2>
      <ErrorNote message={wastage.error} />
      <Table
        head={['Record', 'Location', 'Reason', 'What was thrown away', { key: 'v', label: 'Value', right: true }, 'When']}
        empty="No wastage recorded"
      >
        {waste.map((w) => (
          <tr key={w.id}>
            <Td className="font-semibold text-pos-ink">{w.number}</Td>
            <Td className="text-xs text-slate-600">{w.location?.name}</Td>
            <Td>
              <div className="text-sm text-slate-700">{w.reason}</div>
              {w.note ? <div className="max-w-[16rem] text-xs text-slate-400">{w.note}</div> : null}
            </Td>
            <Td>
              <div className="space-y-0.5 text-xs">
                {w.lines.map((l, i) => (
                  <div key={`${w.id}:${l.item?.id ?? i}`}>
                    <span className="text-slate-500">{l.item?.name}</span>{' '}
                    <span className="tabular-nums font-semibold">{fmtQty(l.qtyBase)}</span>
                    {l.costStatus === 'MISSING' ? <span className="ml-1 text-amber-700">cost unknown</span> : null}
                  </div>
                ))}
              </div>
            </Td>
            <Td right className="font-semibold">{fmtPaise(w.totalValuePaise)}</Td>
            <Td className="text-xs text-slate-500">{fmtDateTime(w.createdAt)}</Td>
          </tr>
        ))}
      </Table>

      {openCount ? (
        <CountDetail
          count={openCount}
          canApprove={owner}
          onClose={() => setOpenCount(null)}
          onChanged={counts.reload}
        />
      ) : null}
    </div>
  );
}
