// Goods coming in: what was ordered, and what actually turned up.
//
// §4 allows a receipt with no purchase order behind it, because it genuinely
// happens — but it is owner-only and always carries a written reason, and this
// screen marks those receipts as direct rather than letting them sit in the
// list looking like every other delivery.

import { useState } from 'react';
import { CheckCircle2, FileText, PackagePlus, ShoppingCart, Truck } from 'lucide-react';
import { PageHeader, StatCard, FullScreenSpinner, Modal } from '../../components/ui.jsx';
import {
  ActionButton,
  Badge,
  Callout,
  ErrorNote,
  OwnerOnlyNote,
  RefreshButton,
  Table,
  Td,
  useInventory,
} from '../../components/inventory.jsx';
import api, { apiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime } from '../../lib/pos.js';
import { fmtPaise, fmtQty, isInventoryOwner } from '../../lib/inventory.js';

const PO_STATUS_STYLES = {
  DRAFT: 'bg-slate-200 text-slate-600',
  APPROVED: 'bg-sky-100 text-sky-700',
  PARTIALLY_RECEIVED: 'bg-amber-100 text-amber-700',
  RECEIVED: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-slate-200 text-slate-600',
  CANCELLED: 'bg-slate-200 text-slate-500',
};

function PoDetail({ poId, onClose, onChanged, canApprove }) {
  const { data, error, loading, reload } = useInventory(`/inventory/purchase-orders/${poId}`, { skip: !poId });
  const [actionError, setActionError] = useState('');
  const po = data?.purchaseOrder;

  const approve = async () => {
    setActionError('');
    try {
      await api.post(`/inventory/purchase-orders/${po.id}/approve`, {});
      await reload();
      await onChanged();
    } catch (err) {
      setActionError(apiError(err));
      throw err;
    }
  };

  return (
    <Modal open={Boolean(poId)} title={po ? `Purchase order ${po.number}` : 'Purchase order'} onClose={onClose} wide>
      {loading && !data ? <div className="py-6 text-center text-sm text-slate-400">Loading…</div> : null}
      <ErrorNote message={actionError || error} />
      {po ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge map={PO_STATUS_STYLES} value={po.status} />
            <span className="text-slate-600">{po.supplier.name}</span>
            <span className="text-slate-400">into {po.location.name}</span>
            {po.expectedAt ? <span className="text-slate-400">· expected {fmtDate(po.expectedAt)}</span> : null}
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full min-w-[34rem] text-xs">
              <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Ordered in</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right" title="Per entered unit — per box, not per gram.">
                    Price each
                  </th>
                  <th className="px-3 py-2 text-right">In stock units</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Still due</th>
                  <th className="px-3 py-2 text-right">Line</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {po.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-semibold text-pos-ink">{l.item.name}</td>
                    <td className="px-3 py-2 text-slate-500">{l.unit}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPaise(l.unitPricePaise)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {fmtQty(l.qtyBase, l.item.baseUnit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.receivedQtyBase)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-amber-700">
                      {fmtQty(l.outstandingQtyBase)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPaise(l.linePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-6 text-sm">
            <div className="text-slate-500">
              Goods <span className="font-semibold text-pos-ink">{fmtPaise(po.subtotalPaise)}</span>
            </div>
            <div className="text-slate-500">
              Tax <span className="font-semibold text-pos-ink">{fmtPaise(po.taxPaise)}</span>
            </div>
            <div className="text-slate-500">
              Total <span className="font-bold text-pos-ink">{fmtPaise(po.totalPaise)}</span>
            </div>
          </div>

          <p className="text-xs text-slate-400">
            The price is quoted per unit ordered — per case, per box, per tray — and the stock column is the
            same quantity expressed in the item's own stock unit. The conversion factor used is frozen onto
            the line, so changing the item's packaging later does not rewrite what this order cost.
          </p>

          {po.status === 'DRAFT' ? (
            canApprove ? (
              <ActionButton className="btn-primary w-full" onClick={approve}>
                <CheckCircle2 className="h-4 w-4" /> Approve this order
              </ActionButton>
            ) : (
              <OwnerOnlyNote what="approve a purchase order" />
            )
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

// What a delivery actually cost, once the freight is spread over it.
//
// Landed cost is the one number on a receipt nobody typed per line — it was
// apportioned — so it is the one most worth showing worked out rather than
// asserted. The charges are listed as they were entered, each line shows the
// share it was given, and the totals are laid out as the sum they are so a
// reader can check it rather than take it on trust.
function GrnDetail({ grnId, onClose }) {
  const { data, error, loading } = useInventory(`/inventory/goods-receipts/${grnId}`, { skip: !grnId });
  const g = data?.goodsReceipt;
  const hasLanded = g ? BigInt(g.landedCostPaise) > 0n : false;

  return (
    <Modal open={Boolean(grnId)} title={g ? `Goods receipt ${g.number}` : 'Goods receipt'} onClose={onClose} wide>
      {loading && !data ? <div className="py-6 text-center text-sm text-slate-400">Loading…</div> : null}
      <ErrorNote message={error} />
      {g ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {g.direct ? (
              <span className="badge bg-amber-100 text-amber-700">no order</span>
            ) : (
              <span className="badge bg-slate-100 text-slate-600">against an order</span>
            )}
            <span className="text-slate-600">{g.supplier.name}</span>
            <span className="text-slate-400">into {g.location.name}</span>
            {g.supplierInvoiceNo ? <span className="text-slate-400">· invoice {g.supplierInvoiceNo}</span> : null}
          </div>
          <div className="text-xs text-slate-400">
            Booked in by {g.receivedBy?.fullName ?? 'an account since removed'} · {fmtDateTime(g.receivedAt)}
          </div>

          {hasLanded ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Landed cost</h3>
                <div className="text-lg font-bold tabular-nums text-pos-ink">{fmtPaise(g.landedCostPaise)}</div>
              </div>
              <ul className="space-y-1 text-xs">
                {g.landedCosts.map((c) => (
                  <li key={c.id} className="flex justify-between gap-4">
                    <span className="text-slate-600">
                      <span className="font-semibold">{c.kind}</span>
                      {c.description ? <span className="text-slate-400"> · {c.description}</span> : null}
                    </span>
                    <span className="tabular-nums text-slate-700">{fmtPaise(c.amountPaise)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full min-w-[34rem] text-xs">
              <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Batch</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Goods</th>
                  <th className="px-3 py-2 text-right">Tax</th>
                  {hasLanded ? (
                    <th className="px-3 py-2 text-right" title="This line's share of the charges above, split by value.">
                      Landed share
                    </th>
                  ) : null}
                  <th className="px-3 py-2 text-right">On the shelf at</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {g.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 font-semibold text-pos-ink">{l.item.name}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {l.batch?.batchCode ?? <span className="text-slate-300">—</span>}
                      {l.batch?.expiryDate ? (
                        <div className="text-slate-400">expires {fmtDate(l.batch.expiryDate)}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(l.qtyBase, l.item.baseUnit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPaise(l.goodsPaise)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtPaise(l.taxPaise)}</td>
                    {hasLanded ? (
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-pos-royal">
                        {fmtPaise(l.landedCostPaise)}
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtPaise(l.valuePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Written as the sum it is, so the apportionment can be checked by
              eye rather than believed. The shares on the lines add up to the
              landed cost exactly — no paise is dropped in the division. */}
          <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
            <div className="text-slate-500">
              Goods <span className="font-semibold text-pos-ink">{fmtPaise(g.goodsPaise)}</span>
            </div>
            <div className="text-slate-500">
              {g.taxIsCost ? 'Tax (carried)' : 'Tax (reclaimed, not carried)'}{' '}
              <span className={g.taxIsCost ? 'font-semibold text-pos-ink' : 'font-semibold text-slate-400 line-through'}>
                {fmtPaise(g.taxPaise)}
              </span>
            </div>
            {hasLanded ? (
              <div className="text-slate-500">
                Landed <span className="font-semibold text-pos-ink">{fmtPaise(g.landedCostPaise)}</span>
              </div>
            ) : null}
            <div className="text-slate-500">
              Stock value <span className="font-bold text-pos-ink">{fmtPaise(g.stockValuePaise)}</span>
            </div>
          </div>

          <p className="text-xs text-slate-400">
            {hasLanded
              ? 'Freight, duty and the rest ride on value, so a line worth three times another carries three times the charge. The shares add up to the total exactly: whatever the division truncates is handed back to the lines with the largest remainders rather than dropped.'
              : 'No freight, duty or other charge was recorded against this delivery, so each line is carried at its own goods cost.'}
            {g.taxIsCost
              ? ' Purchase tax is carried as part of stock cost on this company.'
              : ' Purchase tax is reclaimable on this company, so it is shown but not carried.'}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

export default function InventoryReceiving() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const pos = useInventory('/inventory/purchase-orders');
  const grns = useInventory('/inventory/goods-receipts');
  const [openPo, setOpenPo] = useState(null);
  const [openGrn, setOpenGrn] = useState(null);

  if (!pos.data && pos.loading) return <FullScreenSpinner />;
  if (!pos.data) return <ErrorNote message={pos.error || 'Could not load purchase orders'} />;

  const orders = pos.data.purchaseOrders ?? [];
  const receipts = grns.data?.goodsReceipts ?? [];
  const awaitingApproval = orders.filter((o) => o.status === 'DRAFT');
  const direct = receipts.filter((g) => g.direct);
  const withLanded = receipts.filter((g) => BigInt(g.landedCostPaise ?? '0') > 0n);
  const landedTotal = receipts.reduce((a, g) => a + BigInt(g.landedCostPaise ?? '0'), 0n);

  return (
    <div>
      <PageHeader
        title="Receiving"
        subtitle="Purchase orders, and the deliveries that answered them"
        actions={
          <RefreshButton
            loading={pos.loading || grns.loading}
            onClick={() => {
              pos.reload();
              grns.reload();
            }}
          />
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={ShoppingCart}
          label="Awaiting approval"
          value={awaitingApproval.length}
          hint="Draft orders nobody has signed"
          accent={awaitingApproval.length ? 'orange' : 'slate'}
        />
        <StatCard icon={PackagePlus} label="Deliveries recorded" value={receipts.length} hint="Most recent 200" accent="slate" />
        <StatCard
          icon={Truck}
          label="Landed cost carried"
          value={fmtPaise(landedTotal)}
          hint={
            withLanded.length
              ? `Freight and duty on ${withLanded.length} deliver${withLanded.length === 1 ? 'y' : 'ies'}`
              : 'No delivery has carried a charge yet'
          }
          accent={landedTotal > 0n ? 'royal' : 'slate'}
        />
        <StatCard
          icon={FileText}
          label="Received with no order"
          value={direct.length}
          hint="Owner-only, and each carries a written reason"
          accent={direct.length ? 'orange' : 'slate'}
        />
      </div>

      {direct.length ? (
        <Callout tone="amber" title={`${direct.length} deliver${direct.length === 1 ? 'y was' : 'ies were'} received with no purchase order`}>
          That is allowed and is sometimes the only honest option, but it is deliberately visible: a
          delivery with no order behind it has nothing to check the price and quantity against, so each one
          required an owner and a reason.
        </Callout>
      ) : null}

      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Purchase orders</h2>
      <ErrorNote message={pos.error} />
      <Table
        head={['Order', 'Supplier', 'Into', 'Status', 'Expected', { key: 'l', label: 'Lines', right: true }, { key: 't', label: 'Total', right: true }]}
        empty="No purchase orders"
        emptyNote="An order records what was asked of a supplier, so what turns up can be checked against it."
      >
        {orders.map((o) => (
          <tr key={o.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenPo(o.id)}>
            <Td>
              <div className="font-semibold text-pos-royal">{o.number}</div>
              <div className="text-xs text-slate-400">raised {fmtDate(o.createdAt)}</div>
            </Td>
            <Td className="text-slate-700">{o.supplier?.name}</Td>
            <Td className="text-xs text-slate-600">{o.location?.name}</Td>
            <Td>
              <Badge map={PO_STATUS_STYLES} value={o.status} />
            </Td>
            <Td className="text-xs text-slate-600">{fmtDate(o.expectedAt)}</Td>
            <Td right>{o.lineCount}</Td>
            <Td right className="font-semibold">{fmtPaise(o.totalPaise)}</Td>
          </tr>
        ))}
      </Table>

      <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Goods received</h2>
      <ErrorNote message={grns.error} />
      <Table
        head={[
          'Receipt',
          'Supplier',
          'Into',
          'Against',
          'Invoice',
          { key: 'l', label: 'Lines', right: true },
          { key: 'c', label: 'Landed', right: true },
          { key: 'v', label: 'Stock value', right: true },
          'When',
        ]}
        empty="Nothing received yet"
      >
        {receipts.map((g) => (
          <tr key={g.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpenGrn(g.id)}>
            <Td className="font-semibold text-pos-royal">{g.number}</Td>
            <Td className="text-slate-700">{g.supplier?.name}</Td>
            <Td className="text-xs text-slate-600">{g.location?.name}</Td>
            <Td>
              {g.direct ? (
                <span className="badge bg-amber-100 text-amber-700">no order</span>
              ) : (
                <span className="text-xs text-slate-500">a purchase order</span>
              )}
            </Td>
            <Td className="text-xs text-slate-500">{g.supplierInvoiceNo || '—'}</Td>
            <Td right>{g.lineCount}</Td>
            <Td right className={BigInt(g.landedCostPaise ?? '0') > 0n ? 'font-semibold text-pos-royal' : 'text-slate-300'}>
              {BigInt(g.landedCostPaise ?? '0') > 0n ? fmtPaise(g.landedCostPaise) : '—'}
            </Td>
            <Td right className="font-semibold">{fmtPaise(g.stockValuePaise)}</Td>
            <Td className="text-xs text-slate-500">{fmtDateTime(g.receivedAt)}</Td>
          </tr>
        ))}
      </Table>

      <p className="mt-3 text-xs text-slate-400">
        "Stock value" is what the goods were taken onto the shelf at. Whether purchase tax forms part of
        that is a company setting, because a business that reclaims its input tax does not carry it as
        stock cost and one that cannot, does.
      </p>

      <PoDetail poId={openPo} onClose={() => setOpenPo(null)} onChanged={pos.reload} canApprove={owner} />
      <GrnDetail grnId={openGrn} onClose={() => setOpenGrn(null)} />
    </div>
  );
}
