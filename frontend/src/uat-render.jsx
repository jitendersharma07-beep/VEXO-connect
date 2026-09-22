// Fixture harness behind /uat-render.html (dev server only — see that file).
// Renders the REAL ReceiptView/KotView with server-shaped fixtures so the
// 80 mm print layout can be screenshot-verified without a live sale. Fixture
// shapes mirror backend buildReceipt (backend/src/lib/orders.js) exactly,
// including the verbatim payment/refund label strings.
import { createRoot } from 'react-dom/client';
import './index.css';
import { ReceiptView, KotView } from './components/Receipt.jsx';
import { installPrintPageSize } from './lib/printPageSize.js';

// Mirrors main.jsx. This harness is a second Vite entry, so nothing in
// main.jsx runs here — and the page size is installed from JS because
// Chromium ignores `@page { size: 80mm auto }`. Without this line the
// harness would render the real receipt onto a US Letter page and report
// the print geometry of a document the app never produces.
installPrintPageSize();

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
    // A real café catalog carries names this long; the kitchen copy has to
    // wrap them without pushing the quantity off the paper.
    { name: 'Double Chocolate Fudge Brownie with Vanilla Bean Ice Cream', qty: 1 },
    { name: 'Masala Fries — extra peri peri, no coriander', qty: 3 },
    { name: 'Espresso', qty: 12 },
  ],
};

// A long, multi-item bill: the case that shows whether the 72 mm column holds
// when names wrap, quantities reach two digits and the paper runs on.
const receiptLong = {
  invoiceNumber: 'BSC-CP/2026/000483',
  isDemo: false,
  company: { name: 'Brew Street Café' },
  branch: { name: 'Connaught Place', code: 'BSC-CP', addressLine: 'N-12, Connaught Place', city: 'New Delhi' },
  order: { id: 'fix-3', type: 'DINE_IN', tableName: 'T-11', billedAt: '2026-09-22T20:15:00.000+05:30', cashier: 'Demo Cashier' },
  items: [
    { name: 'Double Chocolate Fudge Brownie with Vanilla Bean Ice Cream', qty: 2, unitPrice: 320, lineDiscount: 0, amount: 640 },
    { name: 'Masala Fries — extra peri peri, no coriander', qty: 3, unitPrice: 140, lineDiscount: 20, amount: 400 },
    { name: 'Cappuccino', qty: 12, unitPrice: 180, lineDiscount: 0, amount: 2160 },
    { name: 'Veg Club Sandwich', qty: 4, unitPrice: 240, lineDiscount: 0, amount: 960 },
    { name: 'Fresh Lime Soda (Sweet & Salted, no ice)', qty: 6, unitPrice: 110, lineDiscount: 0, amount: 660 },
    { name: 'Paneer Tikka Wrap', qty: 2, unitPrice: 260, lineDiscount: 0, amount: 520 },
    { name: 'Blueberry Cheesecake', qty: 1, unitPrice: 280, lineDiscount: 0, amount: 280 },
    { name: 'Espresso', qty: 8, unitPrice: 120, lineDiscount: 0, amount: 960 },
  ],
  subtotal: 6580,
  discountAmount: 0,
  taxBreakup: [
    { name: 'CGST 2.5%', percent: 2.5, taxable: '6580.00', tax: '164.50' },
    { name: 'SGST 2.5%', percent: 2.5, taxable: '6580.00', tax: '164.50' },
  ],
  total: 6909,
  payments: [
    { method: 'CARD', channel: 'MANUAL', amount: 6909, tendered: null, changeDue: null, label: LABEL_MANUAL },
  ],
  amountPaid: '6909.00',
  amountDue: '0.00',
  refunds: [],
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
    {/* `receipt-demo` matches the data-shot name so a caller can request one
        view by the same string it uses to name the artefact; `receipt` is kept
        as an alias because it is the older spelling. */}
    {(view === 'all' || view === 'receipt' || view === 'receipt-demo') && (
      <Block title="receipt-demo"><ReceiptView receipt={receiptDemo} /></Block>
    )}
    {(view === 'all' || view === 'receipt-due') && (
      <Block title="receipt-due"><ReceiptView receipt={receiptDue} /></Block>
    )}
    {(view === 'all' || view === 'receipt-long') && (
      <Block title="receipt-long"><ReceiptView receipt={receiptLong} /></Block>
    )}
    {(view === 'all' || view === 'kot') && (
      <Block title="kot"><KotView kot={kot} /></Block>
    )}
  </main>,
);
