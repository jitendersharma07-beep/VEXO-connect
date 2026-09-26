// Document → ESC/POS. One function per `PrintJob.kind`.
//
// The documents rendered here are built server-side by `buildReceipt()` and by
// the KOT branch of `POST /api/print-jobs`. This module reads them and must not
// compute anything a receipt asserts: every number printed below is a number
// the server put in the document. In particular the agent never re-adds a
// total. If the subtotal and the tax lines do not sum to TOTAL, that is a
// server defect and the paper should show it, because a till that silently
// corrects its own bills is worse than one that prints a wrong one.

import { Builder } from './escpos.js';
import { center, columns, fold, money, rule, wrap } from './text.js';

const dt = (iso, tz) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return d.toISOString();
  }
};

// Matches ReceiptView in frontend/src/components/Receipt.jsx, which prints
// `Dine-in · <table>` or a bare `Takeaway`. The middle dot is written as a
// hyphen here for the same reason the rupee sign is written `Rs.` — see
// text.js. Two paper paths that word the same bill differently is itself a
// defect, so this tracks that component rather than improving on it.
const orderLabel = (order) => (
  order?.type === 'DINE_IN' ? `Dine-in - ${order?.tableName ?? ''}`.trimEnd() : 'Takeaway'
);

export const renderReceipt = (doc, opts = {}) => {
  const w = opts.widthChars ?? 48;
  const sym = opts.currencySymbol ?? 'Rs.';
  const b = new Builder().init();
  const m = (n) => money(n, sym);

  if (doc.isDemo) {
    b.align('center').bold(true)
      .lines(center('* DEMO - sample data, not a real sale *', w).map((l) => l.trim()))
      .bold(false).align('left').line();
  }

  b.align('center').bold(true).lines(center(doc.company?.name ?? '', w).map((l) => l.trim())).bold(false);
  const br = doc.branch ?? {};
  for (const part of [br.name, br.addressLine, [br.city, br.state, br.pincode].filter(Boolean).join(' ')]) {
    if (part) b.lines(center(part, w).map((l) => l.trim()));
  }
  const s = doc.seller;
  if (s?.legalName) b.lines(center(s.legalName, w).map((l) => l.trim()));
  if (s?.gstin) b.lines(center(`GSTIN: ${s.gstin}`, w).map((l) => l.trim()));
  if (s?.fssaiLicenseNo) b.lines(center(`FSSAI: ${s.fssaiLicenseNo}`, w).map((l) => l.trim()));
  b.align('left').line(rule(w));

  b.lines(columns('Invoice', doc.invoiceNumber ?? '', w));
  b.lines(columns(orderLabel(doc.order), dt(doc.order?.billedAt, opts.timeZone), w));
  if (doc.order?.cashier) b.lines(columns('Cashier', doc.order.cashier, w));
  b.line(rule(w));

  for (const it of doc.items ?? []) {
    // A wrapped name continues indented. Unindented, the tail of "Veg Club
    // Sandwich with Sweet Potato Fries" printed as a bare "Fries" line with no
    // amount beside it, which reads as a second item that was given away.
    const nameLines = columns(it.name ?? '', m(it.amount), w);
    b.line(nameLines[0]);
    b.lines(nameLines.slice(1).map((l) => `  ${l}`));
    const qtyLine = `${it.qty} x ${m(it.unitPrice)}`
      + (Number(it.lineDiscount) ? ` - disc ${m(it.lineDiscount)}` : '');
    b.lines(columns(qtyLine, '', w, 2).map((l) => l.trimEnd()));
    for (const mod of it.modifiers ?? []) {
      // Modifier prices are already inside unitPrice. Printing them as amounts
      // in the right-hand column would read as extra charges and would not add
      // up against the line total, so they stay descriptive.
      b.lines(wrap(`+ ${mod.name}`, w - 4).map((l) => `    ${l}`));
    }
  }
  b.line(rule(w));

  b.lines(columns('Subtotal', m(doc.subtotal), w));
  // Discount first, then the promotions that explain it, indented. The server's
  // discountAmount ALREADY contains the promotion amounts, so a single promotion
  // printed flush left above the total showed -Rs.92.00 twice in succession and
  // read as two deductions of 92 against a bill that only took one. The indent
  // is what makes them a breakdown rather than further charges.
  if (Number(doc.discountAmount)) b.lines(columns('Discount', `-${m(doc.discountAmount)}`, w));
  for (const p of doc.promotions ?? []) {
    b.lines(columns(`${p.name}${p.code ? ` (${p.code})` : ''}`, `-${m(p.amount)}`, w, 2));
  }
  for (const t of doc.taxBreakup ?? []) {
    // `name` already reads "CGST 2.5%" or "GST 5%", so the separate `percent`
    // field is not printed — appending it gives "CGST 2.5% 2.5% on ...".
    b.lines(columns(`${t.name} on ${m(t.taxable)}`, m(t.tax), w));
  }

  b.line(rule(w)).bold(true).lines(columns('TOTAL', m(doc.total), w)).bold(false).line(rule(w));

  for (const p of doc.payments ?? []) {
    b.lines(columns(String(p.method ?? '').replace(/_/g, ' '), m(p.amount), w));
    // The server-sent label prints verbatim. It is the sentence that says
    // whether money was verified by a gateway or written down by a human, and
    // rephrasing it here would be the agent editing a financial statement.
    if (p.label) b.lines(wrap(p.label.toUpperCase(), w));
    if (p.tendered !== null && p.tendered !== undefined) {
      b.lines(columns('Tendered', m(p.tendered), w, 2));
      b.lines(columns('Change due', m(p.changeDue), w, 2));
    }
  }
  b.lines(columns('Amount paid', m(doc.amountPaid), w));
  if (Number(doc.amountDue)) b.bold(true).lines(columns('Amount due', m(doc.amountDue), w)).bold(false);

  const refunds = doc.refunds ?? [];
  if (refunds.length) {
    b.line(rule(w));
    for (const r of refunds) {
      // A REQUESTED refund is printed without a minus sign: nothing has left
      // the till yet, and the customer is holding this paper as evidence of
      // what happened to their money.
      const settled = r.status !== 'REQUESTED' && r.status !== 'PENDING';
      b.lines(columns('Refund', `${settled ? '-' : ''}${m(r.amount)}`, w));
      if (r.label) b.lines(wrap(r.label.toUpperCase(), w));
      if (r.reason) b.lines(wrap(r.reason, w).map((l) => `  ${l}`));
    }
  }

  b.line(rule(w));
  b.align('center').lines(center('Thank you - VEXO Connect', w).map((l) => l.trim())).align('left');
  return b;
};

export const renderKot = (doc, opts = {}) => {
  const w = opts.widthChars ?? 48;
  const b = new Builder().init();

  b.align('center').size('tall').bold(true)
    .lines(center(doc.type === 'VOID' ? 'VOID KOT' : 'KOT', w).map((l) => l.trim()))
    .bold(false).size('normal');
  if (doc.seq !== undefined && doc.seq !== null) {
    b.size('double').lines(center(`#${doc.seq}`, w).map((l) => l.trim())).size('normal');
  }
  b.align('left').line(rule(w));
  if (doc.station) b.lines(columns('Station', doc.station, w));
  if (doc.tableName) b.lines(columns('Table', doc.tableName, w));
  if (doc.createdAt) b.lines(columns('Time', dt(doc.createdAt, opts.timeZone), w));
  b.line(rule(w));

  for (const it of doc.items ?? []) {
    // Quantity is the number a cook reads first and the number that costs a
    // dish if it is misread, so the line is double HEIGHT — which leaves the
    // column count alone, unlike double width. A long name therefore wraps at
    // the full width, and its continuation is indented under the name: an
    // unindented second line reads as another dish, and the kitchen makes it.
    const prefix = `${it.qty} x `;
    const nameLines = wrap(it.name ?? '', w - prefix.length);
    b.size('tall').bold(true)
      .line(`${prefix}${nameLines[0] ?? ''}`)
      .lines(nameLines.slice(1).map((l) => `${' '.repeat(prefix.length)}${l}`))
      .bold(false).size('normal');
    if (it.note) b.lines(wrap(`** ${it.note}`, w - 3).map((l) => `   ${l}`));
  }

  if (doc.note) {
    // Continuations indented under the label, like the per-item notes above. An
    // allergy note that wrapped left "the sauce." alone at the left margin,
    // which reads as a separate instruction rather than the end of this one.
    const noteLines = wrap(`ORDER NOTE: ${doc.note}`, w - 2);
    b.line(rule(w)).bold(true)
      .line(noteLines[0] ?? '')
      .lines(noteLines.slice(1).map((l) => `  ${l}`))
      .bold(false);
  }
  b.line(rule(w));
  return b;
};

// The character ruler. This is the diagnostic that settles how wide the roll
// actually is, and it is the reason the agent ships a self-test at all: the
// browser path rasterises, so nothing it prints can answer the question. These
// bytes are Font A text, exactly the mode a real KOT prints in, so the number
// of columns that fit here is the number that belongs in PrintTarget.widthChars.
export const renderSelfTest = (opts = {}) => {
  const w = opts.widthChars ?? 48;
  const b = new Builder().init();

  b.align('center').bold(true).line('VEXO CONNECT PRINT AGENT').bold(false)
    .line(`self-test  v${opts.version ?? '?'}`).align('left').line(rule(w));

  for (const [k, v] of Object.entries(opts.info ?? {})) b.lines(columns(k, String(v), w));
  b.line(rule(w));

  // Wrapped, and worded to fit the narrowest roll this is ever run on. A
  // diagnostic whose own heading spills onto a second line is a diagnostic that
  // has answered its question before the operator reaches the ruler.
  b.lines(wrap(`CHARACTER RULER - ${w} columns`, w)).line();
  // Tens markers above a digit ruler: column 10 is under the "0" of "10".
  let tens = '';
  for (let i = 1; i <= w; i += 1) tens += i % 10 === 0 ? String((i / 10) % 10) : ' ';
  b.line(tens);
  let ones = '';
  for (let i = 1; i <= w; i += 1) ones += String(i % 10);
  b.line(ones);
  b.line('#'.repeat(w));
  b.line();
  b.lines(wrap(
    `The row of ${w} hashes above must sit on ONE line and reach the right edge `
    + 'of the paper. If it wrapped onto a second line this printer is narrower '
    + 'than the configured width and widthChars must be lowered to the last '
    + 'number visible on the ruler. If it stopped well short of the edge, raise it.',
    w,
  ));
  b.line(rule(w));
  b.lines(wrap('Font B (narrower):', w));
  b.raw(Buffer.from([0x1b, 0x4d, 1]));
  b.line('#'.repeat(Math.round(w * 4 / 3)));
  b.raw(Buffer.from([0x1b, 0x4d, 0]));
  b.line(rule(w));
  b.lines(wrap('If this strip printed, the agent formed ESC/POS bytes and the '
    + 'transport delivered them. It does NOT prove any later job printed.', w));
  return b;
};
