import { useEffect, useState } from 'react';
import { Printer, X } from 'lucide-react';
import api, { apiError } from '../lib/api.js';
import { fmtINR, fmtDateTime } from '../lib/pos.js';
import { ErrorNote } from './ui.jsx';

// Receipt + KOT print views (contract §9).
//
// 80 mm thermal layout. The box is the 72 mm PRINTABLE width (272 px at 96 dpi),
// not the 80 mm paper width — see the @media print block in index.css for why
// those are different and what it cost. The on-screen preview uses the same
// 272 px so the modal shows what the paper will actually carry; a preview wider
// than the printable area is how the clipping went unnoticed.
//
// `.print-area` + `@media print` rules in index.css hide all app chrome when
// printing. Every rupee figure on the receipt is a server-sent value rendered
// verbatim — no client math.

// 72 mm printable width at 96 dpi. Keep in step with .print-area in index.css.
const PAPER_W = 'w-[272px]';

const Line = () => <div className="my-1 border-t border-dashed border-black" />;

function Row({ left, right, bold = false, big = false }) {
  return (
    <div
      className={`flex items-baseline justify-between gap-2 ${bold ? 'font-bold' : ''} ${
        big ? 'text-[13px]' : ''
      }`}
    >
      {/* A 55-character product name has to wrap inside ~68 mm; the amount
          must never be the thing that wraps, so it keeps its own line box and
          tabular digits keep the column straight. */}
      <span className="min-w-0 break-words">{left}</span>
      <span className="shrink-0 whitespace-nowrap text-right tabular-nums">{right}</span>
    </div>
  );
}

export function ReceiptView({ receipt }) {
  if (!receipt) return null;
  const r = receipt;
  return (
    <div className={`print-area mx-auto ${PAPER_W} bg-white px-2 py-3 font-mono text-[11px] leading-snug text-black`}>
      {r.isDemo ? (
        <div className="mb-2 border-2 border-dashed border-black px-2 py-1 text-center text-[12px] font-bold">
          DEMO — sample data, not a real sale
        </div>
      ) : null}
      <div className="text-center">
        <div className="text-[13px] font-bold">{r.company?.name}</div>
        <div>{r.branch?.name}</div>
        {r.branch?.addressLine ? <div>{r.branch.addressLine}</div> : null}
        {r.branch?.city ? <div>{r.branch.city}</div> : null}
      </div>
      <Line />
      <Row left="Invoice" right={<span className="font-bold">{r.invoiceNumber}</span>} />
      <Row
        left={r.order?.type === 'DINE_IN' ? `Dine-in · ${r.order?.tableName || ''}` : 'Takeaway'}
        right={fmtDateTime(r.order?.billedAt)}
      />
      {r.order?.cashier ? <Row left="Cashier" right={r.order.cashier} /> : null}
      <Line />
      {(r.items || []).map((it, i) => (
        <div key={i} className="mb-0.5">
          <Row left={it.name} right={fmtINR(it.amount)} />
          <div className="flex justify-between pl-2 text-[10px]">
            <span>
              {it.qty} × {fmtINR(it.unitPrice)}
              {it.lineDiscount ? ` · disc ${fmtINR(it.lineDiscount)}` : ''}
            </span>
          </div>
        </div>
      ))}
      <Line />
      <Row left="Subtotal" right={fmtINR(r.subtotal)} />
      {r.discountAmount ? <Row left="Discount" right={`-${fmtINR(r.discountAmount)}`} /> : null}
      {(r.taxBreakup || []).map((t, i) => (
        <Row key={i} left={`${t.name} on ${fmtINR(t.taxable)}`} right={fmtINR(t.tax)} />
      ))}
      <Line />
      <Row left="TOTAL" right={fmtINR(r.total)} bold big />
      <Line />
      {(r.payments || []).map((p, i) => (
        <div key={i} className="mb-1">
          <Row left={p.method} right={fmtINR(p.amount)} />
          {p.tendered !== null && p.tendered !== undefined ? (
            <Row left="Tendered" right={fmtINR(p.tendered)} />
          ) : null}
          {p.changeDue !== null && p.changeDue !== undefined ? (
            <Row left="Change due" right={fmtINR(p.changeDue)} />
          ) : null}
          {/* §9: the server-sent label prints verbatim. It states whether this
              payment was hand-recorded or confirmed by the provider, so it is
              never substituted client-side. */}
          {p.label ? <div className="text-[9px] font-bold uppercase">{p.label}</div> : null}
        </div>
      ))}
      {(r.refunds || []).length > 0 ? (
        <>
          <Line />
          {r.refunds.map((f, i) => {
            // §9: the minus prints only for settled money. A REQUESTED
            // gateway refund has moved nothing yet, and this paper is the
            // customer's evidence of what happened to their money — it must
            // not say returned before the provider paid out. The server-sent
            // label prints verbatim, like the payment labels above.
            const settled = f.status ? f.status === 'SUCCEEDED' : true;
            return (
              <div key={i} className="mb-1">
                <Row
                  left={`${settled ? 'Refund' : 'Refund requested'}${f.reason ? ` — ${f.reason}` : ''}`}
                  right={settled ? `-${fmtINR(f.amount)}` : fmtINR(f.amount)}
                />
                {f.label ? <div className="text-[9px] font-bold uppercase">{f.label}</div> : null}
              </div>
            );
          })}
        </>
      ) : null}
      <Row left="Amount paid" right={fmtINR(r.amountPaid)} />
      {Number(r.amountDue) > 0 ? <Row left="BALANCE DUE" right={fmtINR(r.amountDue)} bold big /> : null}
      <Line />
      <div className="text-center">Thank you — VEXO Connect</div>
    </div>
  );
}

export function ReceiptModal({ receipt, onClose }) {
  if (!receipt) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-pos-ink/40 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="no-print mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-pos-ink">Receipt</h2>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200">
          <ReceiptView receipt={receipt} />
        </div>
      </div>
    </div>
  );
}

// KOT print: seq, table/type, time, item names + qty only — no prices (§9).
export function KotView({ kot }) {
  if (!kot) return null;
  return (
    <div className={`print-area mx-auto ${PAPER_W} bg-white px-2 py-3 font-mono text-[12px] leading-snug text-black`}>
      <div className="text-center text-[16px] font-bold">KOT #{kot.seq}</div>
      <div className="text-center text-[13px] font-bold">
        {kot.type === 'DINE_IN' ? `Dine-in · ${kot.tableName || ''}` : 'Takeaway'}
      </div>
      <div className="text-center text-[10px]">{fmtDateTime(kot.createdAt)}</div>
      <Line />
      {/* Kitchen copy is read at arm's length across a pass, often in steam —
          bigger than the receipt body, and the quantity is what the line cook
          scans for, so it stays hard against the right edge. */}
      {(kot.items || []).map((it, i) => (
        <div key={i} className="mb-1.5">
          <Row left={it.name} right={`× ${it.qty}`} bold big />
        </div>
      ))}
      <Line />
    </div>
  );
}

export function KotModal({ kot, onClose }) {
  if (!kot) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-pos-ink/40 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="no-print mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-pos-ink">Kitchen order ticket</h2>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200">
          <KotView kot={kot} />
        </div>
      </div>
    </div>
  );
}

// Lists an order's KOTs for reprint (GET /orders/:id/kots, §5.3).
export function KotListModal({ orderId, onClose }) {
  const [kots, setKots] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    setKots(null);
    setError('');
    (async () => {
      try {
        const { data } = await api.get(`/orders/${orderId}/kots`);
        if (alive) setKots(data.kots || []);
      } catch (err) {
        if (alive) setError(apiError(err, 'Could not load KOTs'));
      }
    })();
    return () => {
      alive = false;
    };
  }, [orderId]);

  if (!orderId) return null;
  if (selected) return <KotModal kot={selected} onClose={() => setSelected(null)} />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-pos-ink/40 p-4" onMouseDown={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-pos-ink">KOTs on this order</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <ErrorNote message={error} />
        {kots === null && !error ? <div className="py-4 text-center text-sm text-slate-400">Loading…</div> : null}
        {kots && kots.length === 0 ? (
          <div className="py-4 text-center text-sm text-slate-400">No KOTs sent yet.</div>
        ) : null}
        <div className="space-y-2">
          {(kots || []).map((k) => (
            <button
              key={k.id}
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
              onClick={() => setSelected(k)}
            >
              <span className="font-semibold">KOT #{k.seq}</span>
              <span className="text-xs text-slate-500">
                {(k.items || []).length} item{(k.items || []).length === 1 ? '' : 's'} · {fmtDateTime(k.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
