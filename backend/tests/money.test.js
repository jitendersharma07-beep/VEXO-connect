// Pure unit tests for the order money engine (contract §6). No DB, no HTTP.
import { describe, it, expect } from 'vitest';
import {
  toPaise,
  toRupees,
  pctToMilli,
  percentOf,
  distributeProportional,
  computeOrderTotals,
} from '../src/lib/money.js';

describe('money primitives', () => {
  it('toPaise/toRupees round-trip 2dp amounts exactly', () => {
    expect(toPaise(675.36)).toBe(67536);
    expect(toPaise('180')).toBe(18000);
    expect(toRupees(67536)).toBe(675.36);
  });

  it('pctToMilli keeps 3dp rates exact', () => {
    expect(pctToMilli(5)).toBe(5000);
    expect(pctToMilli(12.5)).toBe(12500);
    expect(pctToMilli('0.125')).toBe(125);
  });

  it('percentOf rounds half-up in paise', () => {
    expect(percentOf(10, 5000)).toBe(1); // 0.5p → 1
    expect(percentOf(9, 5000)).toBe(0); // 0.45p → 0
    expect(percentOf(30, 5000)).toBe(2); // 1.5p → 2
    expect(percentOf(10000, 12500)).toBe(1250); // 12.5% of ₹100 = ₹12.50
  });
});

describe('distributeProportional (largest remainder)', () => {
  it('contract micro-example: FLAT ₹1.00 over 3.33/3.33/3.34', () => {
    expect(distributeProportional(100, [333, 333, 334])).toEqual([33, 33, 34]);
  });

  it('breaks remainder ties by lowest index', () => {
    expect(distributeProportional(101, [1, 1, 1])).toEqual([34, 34, 33]);
  });

  it('always sums exactly to the total (incl. BigInt-sized products)', () => {
    const cases = [
      [7000, [36000, 12000, 22000]],
      [999999, [123456789, 987654321, 555555]],
      [1, [7, 11, 13]],
      [0, [5, 5]],
      [12345, [1]],
    ];
    for (const [total, weights] of cases) {
      const shares = distributeProportional(total, weights);
      expect(shares.reduce((a, s) => a + s, 0)).toBe(total);
      expect(shares).toHaveLength(weights.length);
    }
  });

  it('zero weight-sum yields zero shares', () => {
    expect(distributeProportional(500, [0, 0])).toEqual([0, 0]);
  });
});

describe('computeOrderTotals — contract §6 worked example', () => {
  // Cappuccino ₹180×2 (GST 5%), Veg Sandwich ₹150×1 line-discount ₹30 (GST 5%),
  // Cold Brew Large ₹220×1 (GST 12%), order discount PERCENT 10.
  const lines = [
    { unitPrice: 18000, qty: 2, lineDiscount: 0, taxPctMilli: 5000 },
    { unitPrice: 15000, qty: 1, lineDiscount: 3000, taxPctMilli: 5000 },
    { unitPrice: 22000, qty: 1, lineDiscount: 0, taxPctMilli: 12000 },
  ];

  it('reproduces every figure of the worked example', () => {
    const r = computeOrderTotals(lines, { type: 'PERCENT', value: 10000 });
    expect(r.subtotal).toBe(70000);
    expect(r.discountAmount).toBe(7000);
    expect(r.lines.map((l) => l.lineSubtotal)).toEqual([36000, 12000, 22000]);
    expect(r.lines.map((l) => l.discountShare)).toEqual([3600, 1200, 2200]);
    expect(r.lines.map((l) => l.taxable)).toEqual([32400, 10800, 19800]);
    expect(r.lines.map((l) => l.lineTax)).toEqual([1620, 540, 2376]);
    expect(r.taxAmount).toBe(4536);
    expect(r.total).toBe(67536); // ₹675.36
    expect(toRupees(r.total)).toBe(675.36);
  });

  it('tax breakup by rate matches the contract receipt example', () => {
    const r = computeOrderTotals(lines, { type: 'PERCENT', value: 10000 });
    const byRate = new Map();
    for (const l of r.lines) {
      const cur = byRate.get(l.taxPctMilli) || { taxable: 0, tax: 0 };
      cur.taxable += l.taxable;
      cur.tax += l.lineTax;
      byRate.set(l.taxPctMilli, cur);
    }
    expect(byRate.get(5000)).toEqual({ taxable: 43200, tax: 2160 }); // GST 5%
    expect(byRate.get(12000)).toEqual({ taxable: 19800, tax: 2376 }); // GST 12%
  });
});

describe('computeOrderTotals — edges', () => {
  it('no discount, no tax rate → total equals subtotal', () => {
    const r = computeOrderTotals([{ unitPrice: 9000, qty: 3 }]);
    expect(r.subtotal).toBe(27000);
    expect(r.discountAmount).toBe(0);
    expect(r.taxAmount).toBe(0);
    expect(r.total).toBe(27000);
  });

  it('PERCENT 100 → total 0, tax 0', () => {
    const r = computeOrderTotals(
      [{ unitPrice: 18000, qty: 2, taxPctMilli: 5000 }],
      { type: 'PERCENT', value: 100000 },
    );
    expect(r.discountAmount).toBe(36000);
    expect(r.taxAmount).toBe(0);
    expect(r.total).toBe(0);
  });

  it('FLAT equal to subtotal → total 0', () => {
    const r = computeOrderTotals(
      [{ unitPrice: 15000, qty: 1, lineDiscount: 3000, taxPctMilli: 5000 }],
      { type: 'FLAT', value: 12000 },
    );
    expect(r.total).toBe(0);
  });

  it('line discounts reduce the taxable base before order discount', () => {
    const r = computeOrderTotals(
      [{ unitPrice: 10000, qty: 1, lineDiscount: 1000, taxPctMilli: 5000 }],
      { type: 'FLAT', value: 900 },
    );
    expect(r.lines[0].taxable).toBe(8100);
    expect(r.lines[0].lineTax).toBe(405);
    expect(r.total).toBe(8505);
  });
});
