import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
// WHY THESE MODALS ARE PORTALLED, and it is not a styling preference.
// Both print dialogs mount straight onto <body> carrying `data-print-root`,
// because index.css takes every OTHER body child out of the printed flow. When
// the modal lived inside #root instead, printing one receipt produced THREE:
// the old rule only made the app `visibility:hidden`, which hides ink but keeps
// the app occupying its full height, so the print job ran to three pages — and
// a `position:fixed` element (this overlay) is repainted on EVERY page of a
// print job. Three pages behind it meant three receipts, i.e. three cuts of
// roll and a customer handed a duplicate bill. Measured on the deployed build:
// 3 pages before, 1 page after. Keep these mounted on <body>.
//
// Every rupee figure on the receipt is a server-sent value rendered verbatim —
// no client math.

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

// The one print dialog. Mounted on <body>, not inside #root — see the note at
// the top of this file for what that is load-bearing for. `data-print-root` is
// the hook index.css uses to decide what survives onto the paper; the class
// names below (`print-shell`, `print-frame`) are the hooks it uses to strip the
// on-screen chrome — rounded corners, shadow, the 24rem modal width — off the
// printed copy. Do not rename them without changing that block.
// Explicit Print click only — merely opening the modal is viewing, not a
// print request, and stays unaudited. Fire-and-forget: an audit hiccup must
// never block the dialog. The row records a REQUEST; the browser gives no
// delivery status, so nothing here may be read as "printed on paper".
// The server now answers { printEvent: { copyNumber, reprint } } (reprint
// marker contract, Phase 2). This caller deliberately ignores it: stamping
// DUPLICATE on the rendered copy is Window 2/3's print-UI work, and doing it
// here would mean awaiting the network before window.print(), which must
// stay inside the user gesture. Do not wire that in without W1 sign-off.
const recordPrintRequest = (printEvent) => {
  if (!printEvent?.orderId) return;
  api
    .post(`/orders/${printEvent.orderId}/print-events`, {
      document: printEvent.document,
      ...(printEvent.kotSeq ? { kotSeq: printEvent.kotSeq } : {}),
    })
    .catch(() => {});
};

function PrintDialog({ title, onClose, printEvent, children }) {
  return createPortal(
    <div
      data-print-root
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-pos-ink/40 p-4"
      onMouseDown={onClose}
    >
      <div
        className="print-shell w-full max-w-sm rounded-xl bg-white p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="no-print mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-pos-ink">{title}</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                recordPrintRequest(printEvent);
                window.print();
              }}
            >
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
        <div className="print-frame rounded-lg border border-slate-200">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ReceiptModal({ receipt, onClose }) {
  if (!receipt) return null;
  return (
    <PrintDialog
      title="Receipt"
      onClose={onClose}
      printEvent={{ orderId: receipt.order?.id, document: 'RECEIPT' }}
    >
      <ReceiptView receipt={receipt} />
    </PrintDialog>
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
    <PrintDialog
      title="Kitchen order ticket"
      onClose={onClose}
      printEvent={{ orderId: kot.orderId, document: 'KOT', kotSeq: kot.seq }}
    >
      <KotView kot={kot} />
    </PrintDialog>
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
