// The documents the agent is tested against.
//
// The first four are copied value-for-value from frontend/src/uat-render.jsx,
// which is Window 3's fixture harness for the browser print path. They are
// duplicated rather than imported because that file is JSX behind a Vite entry,
// and duplicated rather than re-invented because the point is that both paths
// render the SAME document: what comes off the roll through ESC/POS can then be
// held against the screenshot the browser path produced. If those fixtures
// change, these should be re-copied.
//
// `receiptFull` is mine and covers what the harness does not: buildReceipt has
// since grown `seller` (GSTIN/FSSAI), `promotions` and per-item `modifiers`,
// and none of the four fixtures exercise them.

const LABEL_MANUAL = 'MANUAL PAYMENT RECORD — not gateway-verified';
const LABEL_GATEWAY = 'GATEWAY PAYMENT — confirmed by the provider';

export const receiptDemo = {
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

export const receiptDue = {
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

export const receiptLong = {
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

export const kot = {
  seq: 12,
  type: 'DINE_IN',
  tableName: 'T-4',
  createdAt: '2026-09-22T13:48:00.000+05:30',
  items: [
    { name: 'Cappuccino', qty: 2 },
    { name: 'Veg Club Sandwich', qty: 1 },
    { name: 'Double Chocolate Fudge Brownie with Vanilla Bean Ice Cream', qty: 1 },
    { name: 'Masala Fries — extra peri peri, no coriander', qty: 3 },
    { name: 'Espresso', qty: 12 },
  ],
};

// Everything buildReceipt can emit that the harness fixtures predate: the seller
// block a GST invoice legally needs, a promotion line, item modifiers whose
// price is already inside unitPrice, and an item note on the kitchen copy.
export const receiptFull = {
  invoiceNumber: 'BSC-CP/2026/000901',
  isDemo: false,
  company: { name: 'Brew Street Café' },
  branch: {
    name: 'Connaught Place', code: 'BSC-CP', publicId: 'BR-CP-001',
    addressLine: 'N-12, Connaught Place', city: 'New Delhi', state: 'Delhi', pincode: '110001',
  },
  seller: {
    legalName: 'Brew Street Hospitality Private Limited',
    tradeName: 'Brew Street Café',
    pan: 'AABCB1234K',
    gstin: '07AABCB1234K1Z5',
    gstStateName: 'Delhi',
    gstAddressLine: 'N-12, Connaught Place, New Delhi 110001',
    fssaiLicenseNo: '13324005000123',
    fssaiValidUpto: '2027-03-31',
  },
  order: { id: 'fix-5', type: 'DINE_IN', tableName: 'T-7', billedAt: '2026-09-24T19:20:00.000+05:30', cashier: 'Demo Cashier' },
  items: [
    {
      name: 'Cappuccino', qty: 2, unitPrice: 210, lineDiscount: 0, amount: 420,
      modifiers: [{ name: 'Oat milk', price: 30 }, { name: 'Extra shot', price: 0 }],
    },
    {
      name: 'Veg Club Sandwich', qty: 1, unitPrice: 240, lineDiscount: 40, amount: 200,
      modifiers: [{ name: 'No mayo', price: 0 }],
    },
  ],
  subtotal: 620,
  promotions: [{ name: 'Happy Hours 20%', code: 'HH20', version: 3, amount: 124 }],
  discountAmount: 0,
  taxBreakup: [
    { name: 'CGST 2.5%', percent: 2.5, taxable: '496.00', tax: '12.40' },
    { name: 'SGST 2.5%', percent: 2.5, taxable: '496.00', tax: '12.40' },
  ],
  total: 520.8,
  payments: [
    { method: 'UPI', channel: 'GATEWAY', amount: 520.8, tendered: null, changeDue: null, label: LABEL_GATEWAY },
  ],
  amountPaid: '520.80',
  amountDue: '0.00',
  refunds: [],
};

export const kotWithNotes = {
  seq: 41,
  type: 'DINE_IN',
  station: 'Hot Kitchen',
  tableName: 'T-7',
  createdAt: '2026-09-24T19:18:00.000+05:30',
  note: 'Guest is allergic to peanuts — check the sauce.',
  items: [
    { name: 'Veg Club Sandwich', qty: 1, note: 'no mayo, toast well' },
    { name: 'Masala Fries — extra peri peri, no coriander', qty: 3 },
  ],
};

export const ALL = { receiptDemo, receiptDue, receiptLong, receiptFull, kot, kotWithNotes };
