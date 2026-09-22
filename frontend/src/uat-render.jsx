// Fixture harness behind /uat-render.html (dev server only — see that file).
// Renders the REAL ReceiptView/KotView with server-shaped fixtures so the
// 80 mm print layout can be screenshot-verified without a live sale. Fixture
// shapes mirror backend buildReceipt (backend/src/lib/orders.js) exactly,
// including the verbatim payment/refund label strings.
import { createRoot } from 'react-dom/client';
import './index.css';
import { ReceiptView, KotView } from './components/Receipt.jsx';

const LABEL_MANUAL = 'MANUAL PAYMENT RECORD — not gateway-verified';
const LABEL_GATEWAY = 'GATEWAY PAYMENT — confirmed by the provider';

// Demo dine-in bill: banner, line discount, order discount, GST breakup,
// cash with change, second manual method, settled staff refund (minus sign).
const receiptDemo = {
  invoiceNumber: 'BSC-CP/2026/000482',
  isDemo: true,
  company: { name: 'Brew Street Café (Demo)' },
  branch: { name: 'Connaught Place', code: 'BSC-CP', addressLine: 'N-12, Connaught Place', city: 'New Delhi' },
  order: { id: 'fix-1', type: 'DINE_IN', tableName: 'T-4', billedAt: '2026-09-22T14:05:00.000+05:30', cashier: 'Demo Cashier' },
  items: [
    { name: 'Cappuccino', qty: 2, unitPrice: 180, lineDiscount: 0, amount: 360 },
    { name: 'Veg Club Sandwich', qty: 1, unitPrice: 240, lineDiscount: 40, amount: 200 },
    { name: 'Masala Fries', qty: 1, unitPrice: 140, lineDiscount: 0, amount: 140 },
  ],
  subtotal: 700,
  discountAmount: 50,
  taxBreakup: [
    { name: 'CGST 2.5%', percent: 2.5, taxable: '650.00', tax: '16.25' },
    { name: 'SGST 2.5%', percent: 2.5, taxable: '650.00', tax: '16.25' },
  ],
  total: 682.5,
  payments: [
    { method: 'CASH', channel: 'MANUAL', amount: 482.5, tendered: 500, changeDue: '17.50', label: LABEL_MANUAL },
    { method: 'UPI', channel: 'MANUAL', amount: 200, tendered: null, changeDue: null, label: LABEL_MANUAL },
  ],
  amountPaid: '682.50',
  amountDue: '0.00',
  refunds: [
    {
      amount: 60, reason: 'Spilled drink', status: 'SUCCEEDED', channel: 'MANUAL',
      label: 'REFUND HANDED BACK — recorded by staff', createdAt: '2026-09-22T14:20:00.000+05:30',
    },
  ],
};

// Non-demo takeaway composite: no banner, gateway payment label, pending
// gateway refund ("requested", no minus), and a BALANCE DUE row.
const receiptDue = {
  invoiceNumber: 'BSC-CH/2026/000091',
  isDemo: false,
  company: { name: 'Brew Street Café' },
  branch: { name: 'Cyber Hub', code: 'BSC-CH', addressLine: 'DLF Cyber Hub', city: 'Gurugram' },
  order: { id: 'fix-2', type: 'TAKEAWAY', tableName: null, billedAt: '2026-09-22T19:42:00.000+05:30', cashier: 'Demo Manager' },
  items: [{ name: 'Cold Brew Tower', qty: 1, unitPrice: 480, lineDiscount: 0, amount: 480 }],
  subtotal: 480,
  discountAmount: 0,
  taxBreakup: [
    { name: 'CGST 2.5%', percent: 2.5, taxable: '480.00', tax: '12.00' },
    { name: 'SGST 2.5%', percent: 2.5, taxable: '480.00', tax: '12.00' },
  ],
  total: 504,
  payments: [
    { method: 'UPI', channel: 'GATEWAY', amount: 300, tendered: null, changeDue: null, label: LABEL_GATEWAY },
  ],
  amountPaid: '300.00',
  amountDue: '204.00',
  refunds: [
    {
      amount: 100, reason: 'Order changed', status: 'PENDING', channel: 'GATEWAY',
      label: 'REFUND REQUESTED — not yet paid out by the provider', createdAt: '2026-09-22T19:50:00.000+05:30',
    },
  ],
};

const kot = {
  seq: 12,
  type: 'DINE_IN',
  tableName: 'T-4',
  createdAt: '2026-09-22T13:48:00.000+05:30',
  items: [
    { name: 'Cappuccino', qty: 2 },
    { name: 'Veg Club Sandwich', qty: 1 },
    { name: 'Masala Fries', qty: 1 },
  ],
};

const view = new URLSearchParams(window.location.search).get('view') || 'all';
const Block = ({ title, children }) => (
  <section data-shot={title} className="mb-8">
    <h2 className="no-print mb-2 text-sm font-bold text-slate-500">{title}</h2>
    {children}
  </section>
);

createRoot(document.getElementById('root')).render(
  <main className="mx-auto max-w-md p-6">
    {(view === 'all' || view === 'receipt') && (
      <Block title="receipt-demo"><ReceiptView receipt={receiptDemo} /></Block>
    )}
    {(view === 'all' || view === 'receipt-due') && (
      <Block title="receipt-due"><ReceiptView receipt={receiptDue} /></Block>
    )}
    {(view === 'all' || view === 'kot') && (
      <Block title="kot"><KotView kot={kot} /></Block>
    )}
  </main>,
);
