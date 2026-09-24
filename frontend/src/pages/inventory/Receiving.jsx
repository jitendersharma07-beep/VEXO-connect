// Goods coming in: what was ordered, and what actually turned up.
//
// §4 allows a receipt with no purchase order behind it, because it genuinely
// happens — but it is owner-only and always carries a written reason, and this
// screen marks those receipts as direct rather than letting them sit in the
// list looking like every other delivery.

import { useState } from 'react';
import { CheckCircle2, FileText, PackagePlus, ShoppingCart } from 'lucide-react';
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

export default function InventoryReceiving() {
  const { user } = useAuth();
  const owner = isInventoryOwner(user);
  const pos = useInventory('/inventory/purchase-orders');
  const grns = useInventory('/inventory/goods-receipts');
  const [openPo, setOpenPo] = useState(null);

  if (!pos.data && pos.loading) return <FullScreenSpinner />;
  if (!pos.data) return <ErrorNote message={pos.error || 'Could not load purchase orders'} />;

  const orders = pos.data.purchaseOrders ?? [];
  const receipts = grns.data?.goodsReceipts ?? [];
  const awaitingApproval = orders.filter((o) => o.status === 'DRAFT');
  const direct = receipts.filter((g) => g.direct);

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

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={ShoppingCart}
          label="Awaiting approval"
          value={awaitingApproval.length}
          hint="Draft orders nobody has signed"
          accent={awaitingApproval.length ? 'orange' : 'slate'}
        />
        <StatCard icon={PackagePlus} label="Deliveries recorded" value={receipts.length} hint="Most recent 200" accent="slate" />
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
        head={['Receipt', 'Supplier', 'Into', 'Against', 'Invoice', { key: 'l', label: 'Lines', right: true }, { key: 'v', label: 'Stock value', right: true }, 'When']}
        empty="Nothing received yet"
      >
        {receipts.map((g) => (
          <tr key={g.id}>
            <Td className="font-semibold text-pos-ink">{g.number}</Td>
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
    </div>
  );
}
