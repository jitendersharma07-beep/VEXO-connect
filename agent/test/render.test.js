// What ends up on the roll.
//
// Two rules are being defended here. The first is that nothing runs off the edge
// of the paper, at either width a store might have. The second, and the one worth
// a test rather than a review, is that the agent computes nothing: every figure on
// the paper is a figure the server put in the document. A till that quietly
// corrects its own arithmetic is worse than one that prints a wrong bill, because
// the wrong bill can be found again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderKot, renderReceipt, renderSelfTest } from '../src/render.js';
import { fold, money } from '../src/text.js';
import { ALL, kot, kotWithNotes, receiptDemo, receiptFull } from './fixtures.js';

// The printable text of a rendered document, escapes removed, as a human reads
// it off the roll.
const paper = (builder) => builder.build().toString('latin1')
  .replace(/\x1b@|\x1b[aEM].|\x1d!.|\x1b\x64.|\x1bp.../gs, '')
  .replace(/\x1dV../gs, '\n');

const linesOf = (builder) => paper(builder).split('\n');

// For the server-sent labels, which are long sentences and wrap on purpose: the
// assertion is that the words survive verbatim, not that they fit on one line.
const flat = (builder) => paper(builder).replace(/\s+/g, ' ');

const render = (doc, opts) => (
  doc.items?.some?.((i) => i.unitPrice !== undefined) || doc.invoiceNumber
    ? renderReceipt(doc, opts) : renderKot(doc, opts)
);

// 42 is here because it is a width the real printer may actually be: 72 mm printable
// is 576 dots at 203 dpi or 512 at 180 dpi, and a Font A character is 12 dots wide.
// 32 stays as a narrow boundary case for the wrapping itself, not as a paper size —
// no supported roll is 32 columns.
test('no line runs off the paper, at 48, 42 or 32 columns', () => {
  for (const w of [48, 42, 32]) {
    for (const [name, doc] of Object.entries(ALL)) {
      for (const line of linesOf(render(doc, { widthChars: w }))) {
        assert.ok(
          line.length <= w,
          `${name} at ${w} cols produced a ${line.length}-char line: ${JSON.stringify(line)}`,
        );
      }
    }
    for (const line of linesOf(renderSelfTest({ widthChars: w, version: 't' }))) {
      // Except the Font B comparison strip, which is deliberately wider than the
      // Font A column count — that is the measurement it exists to make.
      if (line.length > w) assert.match(line, /^#+$/);
    }
  }
});

test('every character on the roll is 7-bit', () => {
  for (const [name, doc] of Object.entries(ALL)) {
    const bytes = render(doc, { widthChars: 48 }).build();
    for (const b of bytes) {
      assert.ok(b <= 0x7f, `${name} emitted byte 0x${b.toString(16)} — the code page would decide what it prints`);
    }
  }
});

test('an accented café and a rupee sign survive as something readable', () => {
  const text = paper(renderReceipt(receiptDemo, { widthChars: 48 }));

  // The browser path rasterises and prints `Café` and `₹` as themselves. This
  // path cannot, so it prints a spelling rather than a code-page gamble.
  assert.match(text, /Brew Street Cafe \(Demo\)/);
  assert.ok(!text.includes('?'), 'nothing in a normal bill should fold to a question mark');
  assert.equal(fold('Masala Fries — extra peri peri'), 'Masala Fries - extra peri peri');
  assert.equal(money(632.1), 'Rs.632.10');
  assert.equal(money(69090.5), 'Rs.69,090.50');
});

test('the total printed is the total the server sent, even when it does not add up', () => {
  // Deliberately inconsistent: 100 + 10 is not 500. The paper must show 500,
  // because the document said 500 and a receipt that silently fixes itself hides
  // the server defect that produced it.
  const wrong = {
    ...receiptDemo,
    items: [{ name: 'Thing', qty: 1, unitPrice: 100, lineDiscount: 0, amount: 100 }],
    subtotal: 100,
    discountAmount: 0,
    promotions: [],
    taxBreakup: [{ name: 'GST 5%', percent: 5, taxable: '100.00', tax: '10.00' }],
    total: 500,
    payments: [],
    amountPaid: '0.00',
    amountDue: '500.00',
    refunds: [],
  };

  const text = paper(renderReceipt(wrong, { widthChars: 48 }));

  assert.match(text, /TOTAL {2,}Rs\.500\.00/);
  assert.match(text, /Subtotal {2,}Rs\.100\.00/);
  assert.match(text, /Amount due {2,}Rs\.500\.00/);
});

test('a receipt carries every figure the document asserts', () => {
  const text = paper(renderReceipt(receiptDemo, { widthChars: 48 }));

  assert.match(text, /Invoice {2,}BSC-CP\/2026\/000482/);
  assert.match(text, /Dine-in - T-4/);
  assert.match(text, /Cappuccino {2,}Rs\.360\.00/);
  assert.match(text, /2 x Rs\.180\.00/);
  assert.match(text, /Veg Club Sandwich {2,}Rs\.200\.00/);
  assert.match(text, /1 x Rs\.240\.00 - disc Rs\.40\.00/);
  assert.match(text, /Discount {2,}-Rs\.50\.00/);
  assert.match(text, /CGST 2\.5% on Rs\.650\.00 {2,}Rs\.16\.25/);
  assert.match(text, /TOTAL {2,}Rs\.682\.50/);
  assert.match(text, /CASH {2,}Rs\.482\.50/);
  assert.match(text, /Tendered {2,}Rs\.500\.00/);
  assert.match(text, /Change due {2,}Rs\.17\.50/);
  // The label is the sentence that says whether a gateway verified this money or
  // a human wrote it down, and it prints verbatim.
  assert.match(
    flat(renderReceipt(receiptDemo, { widthChars: 48 })),
    /MANUAL PAYMENT RECORD - NOT GATEWAY-VERIFIED/,
  );
});

test('a tax name already carrying its rate is not given a second one', () => {
  // The regression: appending `percent` to a name that reads "CGST 2.5%" printed
  // "CGST 2.5% 2.5% on Rs.496.00".
  const text = paper(renderReceipt(receiptFull, { widthChars: 48 }));

  assert.match(text, /CGST 2\.5% on Rs\.496\.00/);
  assert.ok(!/2\.5% 2\.5%/.test(text));
});

test('a GST invoice prints the seller block the document supplies', () => {
  const text = paper(renderReceipt(receiptFull, { widthChars: 48 }));

  assert.match(text, /Brew Street Hospitality Private Limited/);
  assert.match(text, /GSTIN: 07AABCB1234K1Z5/);
  assert.match(text, /FSSAI: 13324005000123/);
  assert.match(text, /Happy Hours 20% \(HH20\) {2,}-Rs\.124\.00/);
  // A modifier's price is already inside unitPrice, so it reads as a description
  // and not as an extra charge that fails to add up.
  assert.match(text, /\+ Oat milk/);
  assert.ok(!/Oat milk.*Rs\./.test(text));
});

test('a requested refund prints without a minus sign', () => {
  const requested = renderReceipt(ALL.receiptDue, { widthChars: 48 });
  const settled = renderReceipt(receiptDemo, { widthChars: 48 });

  // Nothing has left the till yet, and the customer is holding this paper as
  // evidence of what happened to their money.
  assert.match(paper(requested), /Refund {2,}Rs\.100\.00/);
  assert.match(flat(requested), /REFUND REQUESTED - NOT YET PAID OUT BY THE PROVIDER/);
  assert.match(paper(settled), /Refund {2,}-Rs\.60\.00/);
  assert.match(flat(settled), /REFUND HANDED BACK - RECORDED BY STAFF/);
});

test('a demo receipt says so on the paper', () => {
  const text = paper(renderReceipt(receiptDemo, { widthChars: 48 }));
  assert.match(text, /\* DEMO - sample data, not a real sale \*/);
  assert.ok(!paper(renderReceipt(receiptFull, { widthChars: 48 })).includes('DEMO'));
});

test('a long dish name wraps under itself, not into a second dish', () => {
  // The regression that matters most to a kitchen. Double HEIGHT leaves the column
  // count alone, so a name wraps at the full width; an unindented continuation
  // reads as another dish and the kitchen makes it.
  const lines = linesOf(renderKot(kot, { widthChars: 48 }));
  const first = lines.findIndex((l) => l.startsWith('1 x Double Chocolate'));

  assert.ok(first > 0);
  assert.match(lines[first + 1], /^ {4}Bean Ice Cream$/);
  for (const l of lines) assert.ok(!/^Bean Ice Cream/.test(l));
  // A three-of-something line must never be read as one.
  assert.match(lines.find((l) => l.includes('Masala Fries')), /^3 x Masala Fries/);
});

test('a KOT prints the station, the notes and no money', () => {
  const b = renderKot(kotWithNotes, { widthChars: 48 });
  const text = paper(b);

  assert.match(text, /Station {2,}Hot Kitchen/);
  assert.match(text, /#41/);
  assert.match(text, /\*\* no mayo, toast well/);
  assert.match(flat(b), /ORDER NOTE: Guest is allergic to peanuts - check the sauce\./);
  assert.ok(!text.includes('Rs.'), 'a kitchen copy is not a bill');
});

test('a void KOT is titled as one', () => {
  assert.match(paper(renderKot({ ...kot, type: 'VOID' }, { widthChars: 48 })), /VOID KOT/);
  assert.match(paper(renderKot(kot, { widthChars: 48 })), /\bKOT\b/);
});

test('the self-test ruler is the width measurement, on one line', () => {
  for (const w of [48, 42, 32]) {
    const b = renderSelfTest({ widthChars: w, version: '1.0.0' });
    const lines = linesOf(b);
    const hashes = lines.filter((l) => /^#+$/.test(l));

    // Exactly one Font A row of w hashes, plus the wider Font B strip. If the
    // Font A row wraps on real paper, the configured width is too high — which is
    // the whole diagnostic.
    assert.ok(hashes.some((l) => l.length === w), `no ${w}-hash row at ${w} columns`);
    assert.ok(hashes.some((l) => l.length === Math.round(w * 4 / 3)));
    assert.match(flat(b), new RegExp(`CHARACTER RULER - ${w} columns`));
    // The ones ruler must be exactly w long, so an operator can read the last
    // visible number off the paper and use it directly.
    const ones = lines.find((l) => /^1234567890/.test(l));
    assert.equal(ones.length, w);
  }
});

test('a self-test needs no document, no server and no printer', () => {
  const bytes = renderSelfTest({ widthChars: 48, version: '1.0.0', info: { target: 'tgt_1' } }).build();
  assert.ok(bytes.length > 500);
  // The sentence that stops a printed strip being read as proof of anything else.
  assert.match(flat(renderSelfTest({ widthChars: 48 })), /It does NOT prove any later job printed\./);
});

test('a promotion is a breakdown of the discount, not a second deduction', () => {
  // The regression: discountAmount ALREADY contains the promotion amounts, and
  // both printed flush left, so a bill with one promotion showed -Rs.92.00 twice
  // in succession — 184 of deductions on a bill that took 92.
  const doc = {
    ...receiptDemo,
    subtotal: 920,
    discountAmount: 92,
    promotions: [{ name: 'Happy Hours 10%', code: 'HH20', version: 3, amount: 92 }],
    taxBreakup: [{ name: 'GST 5%', percent: 5, taxable: '828.00', tax: '41.40' }],
    total: 869.4,
  };
  const lines = linesOf(renderReceipt(doc, { widthChars: 48 }));

  const discount = lines.findIndex((l) => /^Discount /.test(l));
  const promo = lines.findIndex((l) => l.includes('Happy Hours 10%'));

  // Total first, explanation under it, and the explanation is indented — that
  // indent is the whole difference between a breakdown and a further charge.
  assert.ok(discount > 0 && promo === discount + 1, `Discount at ${discount}, promotion at ${promo}`);
  assert.match(lines[promo], /^ {2}Happy Hours 10% \(HH20\) {2,}-Rs\.92\.00$/);
  // And exactly one line begins at the left margin claiming a deduction.
  assert.equal(lines.filter((l) => /^\S.*-Rs\.92\.00$/.test(l)).length, 1);
});

test('a wrapped item name continues indented, not as a free second item', () => {
  // Unindented, the tail printed as a bare "Fries" with no amount beside it,
  // which reads as another dish that was given away.
  const doc = {
    ...receiptDemo,
    items: [{
      name: 'Veg Club Sandwich with Sweet Potato Fries',
      qty: 1, unitPrice: 240, lineDiscount: 40, amount: 200, modifiers: [],
    }],
  };
  const lines = linesOf(renderReceipt(doc, { widthChars: 48 }));
  const first = lines.findIndex((l) => l.startsWith('Veg Club Sandwich'));

  assert.ok(first > 0);
  assert.match(lines[first], /Rs\.200\.00$/);
  assert.match(lines[first + 1], /^ {2}Fries$/);
  for (const l of lines) assert.ok(!/^Fries/.test(l), 'a continuation reached the left margin');
});

test('a KOT carries only what the server actually sends', () => {
  // This is the real document shape, copied from renderDocument() in
  // backend/src/api/routes/printing.js: { seq, type, note, items, createdAt }.
  // Nothing else. The assertions below are deliberately about ABSENCE, because
  // three fields this renderer can print are never populated on that route —
  // `station`, `tableName`, and a KOT `type` (the server sends order.type). If a
  // later server change starts sending them, this test is what says so.
  const serverDoc = {
    seq: 41,
    type: 'DINE_IN',
    note: 'Guest is allergic to peanuts — check the sauce.',
    items: [
      { name: 'Cappuccino', qty: 2, note: null },
      { name: 'Veg Club Sandwich with Sweet Potato Fries', qty: 1, note: 'no mayo, toast well' },
    ],
    createdAt: '2026-09-26T13:12:00.000Z',
  };
  const b = renderKot(serverDoc, { widthChars: 48, timeZone: 'Asia/Kolkata' });
  const text = paper(b);

  assert.match(text, /#41/);
  assert.match(text, /2 x Cappuccino/);
  assert.match(text, /\*\* no mayo, toast well/);

  // The gaps, pinned. A dine-in ticket naming no table is the one that costs a
  // restaurant service, and it is a server-side omission, not a render bug.
  assert.ok(!/^Station/m.test(text), 'server sends no station');
  assert.ok(!/^Table/m.test(text), 'server sends no tableName');
  assert.ok(!text.includes('DINE_IN') && !text.includes('Dine-in'), 'order type is not printed');
  // `type` is order.type, so the VOID title this renderer supports is
  // unreachable through the real route — order.type is never 'VOID'.
  assert.match(text, /\bKOT\b/);
  assert.ok(!text.includes('VOID'));

  // A wrapped order note continues indented, so "the sauce." cannot be read as
  // an instruction of its own.
  const lines = linesOf(b);
  const note = lines.findIndex((l) => l.startsWith('ORDER NOTE:'));
  assert.ok(note > 0);
  assert.match(lines[note + 1], /^ {2}\S/);
});

test('an empty or partial document prints a short receipt rather than throwing', () => {
  // Defensive only where the boundary is real: these documents come off the wire.
  for (const doc of [{}, { items: [] }, { total: null, items: null, payments: null }]) {
    const text = paper(renderReceipt(doc, { widthChars: 48 }));
    assert.match(text, /TOTAL {2,}Rs\.0\.00/);
    assert.match(text, /Thank you - VEXO Connect/);
  }
  assert.doesNotThrow(() => renderKot({}, { widthChars: 48 }));
});
