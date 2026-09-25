// Pure unit tests for the reporting period engine. No DB, no HTTP.
//
// Every assertion below is a boundary someone gets wrong by hand: the UTC instant
// an IST day opens, an after-midnight sale landing on the previous trading day, a
// week that starts on Sunday, a 23-hour day on a DST shift, and a partial period
// whose comparison must be clipped to the same elapsed time rather than a whole day.
import { describe, it, expect } from 'vitest';
import {
  REPORTING_DEFAULTS,
  addDays,
  addMonths,
  businessDateOf,
  businessDayStartUtc,
  endOfFinancialYear,
  endOfMonth,
  isSupportedTimeZone,
  normalizeSettings,
  resolvePeriod,
  startOfFinancialYear,
  startOfWeek,
  zoneOffsetMs,
} from '../src/lib/reporting/period.js';

const ist = normalizeSettings({});
const dubai = normalizeSettings({ timezone: 'Asia/Dubai' });
const newYork = normalizeSettings({ timezone: 'America/New_York' });

describe('calendar arithmetic on business-date labels', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('clamps month arithmetic to the shorter month instead of overflowing', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('finds month ends including leap February', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-09-01')).toBe('2026-09-30');
  });
});

describe('week start is the company policy, not the locale', () => {
  // 2026-09-24 is a Thursday.
  it('walks back to Monday when weekStartDay is 1', () => {
    expect(startOfWeek(normalizeSettings({ weekStartDay: 1 }), '2026-09-24')).toBe('2026-09-21');
  });

  it('walks back to Sunday when weekStartDay is 0', () => {
    expect(startOfWeek(normalizeSettings({ weekStartDay: 0 }), '2026-09-24')).toBe('2026-09-20');
  });

  it('leaves a date that is already the week start alone', () => {
    expect(startOfWeek(normalizeSettings({ weekStartDay: 4 }), '2026-09-24')).toBe('2026-09-24');
  });
});

describe('financial year', () => {
  it('April start puts September in the year that opened in April', () => {
    const s = normalizeSettings({ financialYearStartMonth: 4 });
    expect(startOfFinancialYear(s, '2026-09-24')).toBe('2026-04-01');
    expect(endOfFinancialYear(s, '2026-09-24')).toBe('2027-03-31');
  });

  it('April start puts February in the year that opened the previous April', () => {
    const s = normalizeSettings({ financialYearStartMonth: 4 });
    expect(startOfFinancialYear(s, '2026-02-10')).toBe('2025-04-01');
    expect(endOfFinancialYear(s, '2026-02-10')).toBe('2026-03-31');
  });

  it('January start degenerates to the calendar year', () => {
    const s = normalizeSettings({ financialYearStartMonth: 1 });
    expect(startOfFinancialYear(s, '2026-09-24')).toBe('2026-01-01');
    expect(endOfFinancialYear(s, '2026-09-24')).toBe('2026-12-31');
  });
});

describe('timezone offsets come from the zone, not a constant', () => {
  it('reads IST as +05:30 and Dubai as +04:00', () => {
    const t = new Date('2026-09-24T12:00:00.000Z');
    expect(zoneOffsetMs('Asia/Kolkata', t)).toBe(330 * 60 * 1000);
    expect(zoneOffsetMs('Asia/Dubai', t)).toBe(240 * 60 * 1000);
    expect(zoneOffsetMs('UTC', t)).toBe(0);
  });

  it('reads New York as -05:00 in winter and -04:00 in summer', () => {
    expect(zoneOffsetMs('America/New_York', new Date('2026-01-15T12:00:00.000Z'))).toBe(-5 * 3600 * 1000);
    expect(zoneOffsetMs('America/New_York', new Date('2026-07-15T12:00:00.000Z'))).toBe(-4 * 3600 * 1000);
  });

  it('rejects a zone ICU does not know', () => {
    expect(isSupportedTimeZone('Asia/Kolkata')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('business day boundaries', () => {
  it('opens an IST day at 18:30 UTC the previous evening', () => {
    expect(businessDayStartUtc(ist, '2026-09-24').toISOString()).toBe('2026-09-23T18:30:00.000Z');
  });

  it('opens a Dubai day at 20:00 UTC the previous evening', () => {
    expect(businessDayStartUtc(dubai, '2026-09-24').toISOString()).toBe('2026-09-23T20:00:00.000Z');
  });

  it('shifts the opening instant by the configured cutoff', () => {
    const late = normalizeSettings({ businessDayCutoffMinutes: 300 });
    expect(businessDayStartUtc(late, '2026-09-24').toISOString()).toBe('2026-09-23T23:30:00.000Z');
  });

  it('books an after-midnight sale to the previous trading day when a cutoff is set', () => {
    const late = normalizeSettings({ businessDayCutoffMinutes: 300 });
    // 02:30 IST on the 25th.
    const afterMidnight = new Date('2026-09-24T21:00:00.000Z');
    expect(businessDateOf(late, afterMidnight)).toBe('2026-09-24');
    expect(businessDateOf(ist, afterMidnight)).toBe('2026-09-25');
  });

  it('books a sale just after the cutoff to the new trading day', () => {
    const late = normalizeSettings({ businessDayCutoffMinutes: 300 });
    // 05:01 IST on the 25th.
    expect(businessDateOf(late, new Date('2026-09-24T23:31:00.000Z'))).toBe('2026-09-25');
  });

  it('keeps midnight-cutoff IST days exactly 24 hours long', () => {
    const open = businessDayStartUtc(ist, '2026-09-24').getTime();
    const next = businessDayStartUtc(ist, '2026-09-25').getTime();
    expect(next - open).toBe(24 * 3600 * 1000);
  });

  // A day is not always 24 hours. If a report assumes it is, every figure on a
  // DST-shift day is drawn from the wrong window.
  it('makes the spring-forward day 23 hours in New York', () => {
    const open = businessDayStartUtc(newYork, '2026-03-08').getTime();
    const next = businessDayStartUtc(newYork, '2026-03-09').getTime();
    expect(next - open).toBe(23 * 3600 * 1000);
  });

  it('makes the fall-back day 25 hours in New York', () => {
    const open = businessDayStartUtc(newYork, '2026-11-01').getTime();
    const next = businessDayStartUtc(newYork, '2026-11-02').getTime();
    expect(next - open).toBe(25 * 3600 * 1000);
  });
});

describe('preset resolution', () => {
  const now = new Date('2026-09-24T10:00:00.000Z'); // 15:30 IST, Thursday

  it('resolves TODAY as the live business day ending now, not at midnight', () => {
    const p = resolvePeriod({ preset: 'TODAY', now, settings: ist });
    expect(p.from).toBe('2026-09-24');
    expect(p.to).toBe('2026-09-24');
    expect(p.startUtc.toISOString()).toBe('2026-09-23T18:30:00.000Z');
    expect(p.endUtc.toISOString()).toBe(now.toISOString());
    expect(p.fullEndUtc.toISOString()).toBe('2026-09-24T18:30:00.000Z');
    expect(p.partial).toBe(true);
  });

  it('resolves YESTERDAY as a closed whole day', () => {
    const p = resolvePeriod({ preset: 'YESTERDAY', now, settings: ist });
    expect(p.from).toBe('2026-09-23');
    expect(p.to).toBe('2026-09-23');
    expect(p.partial).toBe(false);
    expect(p.endUtc.getTime() - p.startUtc.getTime()).toBe(24 * 3600 * 1000);
  });

  it('resolves THIS_WEEK from the configured week start through today', () => {
    const p = resolvePeriod({ preset: 'THIS_WEEK', now, settings: ist });
    expect(p.from).toBe('2026-09-21');
    expect(p.to).toBe('2026-09-27');
    expect(p.partial).toBe(true);
    expect(p.endUtc.toISOString()).toBe(now.toISOString());
  });

  it('resolves LAST_WEEK as the seven closed days before it', () => {
    const p = resolvePeriod({ preset: 'LAST_WEEK', now, settings: ist });
    expect(p.from).toBe('2026-09-14');
    expect(p.to).toBe('2026-09-20');
    expect(p.partial).toBe(false);
  });

  it('resolves THIS_MONTH and LAST_MONTH', () => {
    const t = resolvePeriod({ preset: 'THIS_MONTH', now, settings: ist });
    expect([t.from, t.to, t.partial]).toEqual(['2026-09-01', '2026-09-30', true]);
    const l = resolvePeriod({ preset: 'LAST_MONTH', now, settings: ist });
    expect([l.from, l.to, l.partial]).toEqual(['2026-08-01', '2026-08-31', false]);
  });

  it('resolves the financial year presets from company policy', () => {
    const p = resolvePeriod({ preset: 'THIS_FINANCIAL_YEAR', now, settings: ist });
    expect([p.from, p.to]).toEqual(['2026-04-01', '2027-03-31']);
    const l = resolvePeriod({ preset: 'LAST_FINANCIAL_YEAR', now, settings: ist });
    expect([l.from, l.to]).toEqual(['2025-04-01', '2026-03-31']);
    expect(l.partial).toBe(false);
  });

  it('accepts a custom window', () => {
    const p = resolvePeriod({ preset: 'CUSTOM', from: '2026-09-01', to: '2026-09-10', now, settings: ist });
    expect([p.from, p.to, p.partial]).toEqual(['2026-09-01', '2026-09-10', false]);
  });

  it('refuses a malformed or inverted custom window with a field-level reason', () => {
    expect(() => resolvePeriod({ preset: 'CUSTOM', from: '2026-9-1', to: '2026-09-10', now, settings: ist }))
      .toThrowError(/YYYY-MM-DD/);
    expect(() => resolvePeriod({ preset: 'CUSTOM', from: '2026-09-10', to: '2026-09-01', now, settings: ist }))
      .toThrowError(/must not be after/);
  });

  it('refuses an unknown preset rather than silently defaulting to today', () => {
    expect(() => resolvePeriod({ preset: 'LAST_FORTNIGHT', now, settings: ist })).toThrowError(/Unknown period preset/);
  });
});

describe('comparison against the previous comparable period', () => {
  const now = new Date('2026-09-24T10:00:00.000Z'); // 15:30 IST

  it('clips a partial period comparison to the same elapsed time', () => {
    const p = resolvePeriod({ preset: 'TODAY', now, settings: ist });
    expect(p.comparison.basis).toBe('SAME_ELAPSED');
    expect(p.comparison.from).toBe('2026-09-23');
    const elapsed = p.endUtc.getTime() - p.startUtc.getTime();
    expect(p.comparison.endUtc.getTime() - p.comparison.startUtc.getTime()).toBe(elapsed);
    // 15:30 IST is 15h30m after the 00:00 IST open.
    expect(elapsed).toBe((15 * 60 + 30) * 60 * 1000);
  });

  it('compares a closed period against the whole previous one', () => {
    const p = resolvePeriod({ preset: 'YESTERDAY', now, settings: ist });
    expect(p.comparison.basis).toBe('FULL_PERIOD');
    expect([p.comparison.from, p.comparison.to]).toEqual(['2026-09-22', '2026-09-22']);
    expect(p.comparison.endUtc.getTime() - p.comparison.startUtc.getTime()).toBe(24 * 3600 * 1000);
  });

  it('compares this week against last week, clipped to the elapsed part', () => {
    const p = resolvePeriod({ preset: 'THIS_WEEK', now, settings: ist });
    expect([p.comparison.from, p.comparison.to]).toEqual(['2026-09-14', '2026-09-20']);
    expect(p.comparison.basis).toBe('SAME_ELAPSED');
    expect(p.comparison.endUtc.getTime() - p.comparison.startUtc.getTime()).toBe(
      p.endUtc.getTime() - p.startUtc.getTime(),
    );
  });

  it('compares this month against last month without running past the shorter month', () => {
    const p = resolvePeriod({ preset: 'THIS_MONTH', now, settings: ist });
    expect([p.comparison.from, p.comparison.to]).toEqual(['2026-08-01', '2026-08-31']);
    expect(p.comparison.endUtc.getTime()).toBeLessThanOrEqual(
      businessDayStartUtc(ist, '2026-09-01').getTime(),
    );
  });

  it('compares a custom window against the equal-length window before it', () => {
    const p = resolvePeriod({ preset: 'CUSTOM', from: '2026-09-11', to: '2026-09-20', now, settings: ist });
    expect([p.comparison.from, p.comparison.to]).toEqual(['2026-09-01', '2026-09-10']);
  });
});

describe('buckets', () => {
  const now = new Date('2026-09-24T10:00:00.000Z');

  it('defaults a month to daily buckets and a year to monthly ones', () => {
    expect(resolvePeriod({ preset: 'THIS_MONTH', now, settings: ist }).grouping).toBe('DAY');
    expect(resolvePeriod({ preset: 'THIS_FINANCIAL_YEAR', now, settings: ist }).grouping).toBe('MONTH');
  });

  it('covers the period exactly once, with no bucket overlapping its neighbour', () => {
    const p = resolvePeriod({ preset: 'THIS_MONTH', grouping: 'DAY', now, settings: ist });
    expect(p.buckets).toHaveLength(30);
    expect(p.buckets[0].from).toBe('2026-09-01');
    expect(p.buckets[29].to).toBe('2026-09-30');
    for (let i = 1; i < p.buckets.length; i += 1) {
      const prev = p.buckets[i - 1];
      // Closed days abut exactly, so no row can fall in two buckets or none. The
      // live day is the one exception: it stops at `now`, and the gap to the next
      // bucket is simply the part of today that has not traded yet.
      if (prev.partial) expect(p.buckets[i].startUtc.getTime()).toBeGreaterThan(prev.endUtc.getTime());
      else expect(p.buckets[i].startUtc.getTime()).toBe(prev.endUtc.getTime());
    }
    expect(p.buckets.filter((b) => b.partial)).toHaveLength(1);
  });

  it('keeps future buckets as real forward windows rather than inverted ones', () => {
    const p = resolvePeriod({ preset: 'THIS_MONTH', grouping: 'DAY', now, settings: ist });
    const future = p.buckets.filter((b) => b.future);
    expect(future).toHaveLength(6); // 25th to 30th
    for (const b of future) {
      expect(b.endUtc.getTime()).toBeGreaterThan(b.startUtc.getTime());
      expect(b.partial).toBe(false);
      expect(b.startUtc.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    expect(p.buckets.filter((b) => b.from <= '2026-09-24' && b.future)).toHaveLength(0);
  });

  it('caps the live bucket at now and marks it partial', () => {
    const p = resolvePeriod({ preset: 'THIS_MONTH', grouping: 'DAY', now, settings: ist });
    const live = p.buckets.find((b) => b.from === '2026-09-24');
    expect(live.partial).toBe(true);
    expect(live.endUtc.toISOString()).toBe(now.toISOString());
    // Days after today still exist as buckets but are already closed windows with
    // no activity, so a monthly grid does not silently lose its shape.
    expect(p.buckets.filter((b) => b.from > '2026-09-24')).toHaveLength(6);
  });

  it('respects the configured week start when grouping weekly', () => {
    const sunday = normalizeSettings({ weekStartDay: 0 });
    const p = resolvePeriod({ preset: 'CUSTOM', from: '2026-09-01', to: '2026-09-30', grouping: 'WEEK', now, settings: sunday });
    expect(p.buckets[0].from).toBe('2026-09-01');
    expect(p.buckets[0].to).toBe('2026-09-05'); // first Saturday
    expect(p.buckets[1].from).toBe('2026-09-06'); // Sunday
  });

  it('groups monthly with month keys', () => {
    const p = resolvePeriod({ preset: 'CUSTOM', from: '2026-07-01', to: '2026-09-30', grouping: 'MONTH', now, settings: ist });
    expect(p.buckets.map((b) => b.key)).toEqual(['2026-07', '2026-08', '2026-09']);
  });
});

describe('settings normalisation fails safe', () => {
  it('falls back to defaults for junk rather than throwing mid-report', () => {
    const s = normalizeSettings({
      timezone: 'Not/AZone',
      businessDayCutoffMinutes: -5,
      weekStartDay: 9,
      financialYearStartMonth: 0,
      staleAfterMinutes: 1,
    });
    expect(s).toEqual(REPORTING_DEFAULTS);
  });

  it('keeps legitimate values', () => {
    const s = normalizeSettings({
      timezone: 'Asia/Dubai',
      businessDayCutoffMinutes: 300,
      weekStartDay: 0,
      financialYearStartMonth: 1,
      staleAfterMinutes: 45,
    });
    expect(s).toEqual({
      timezone: 'Asia/Dubai',
      businessDayCutoffMinutes: 300,
      weekStartDay: 0,
      financialYearStartMonth: 1,
      staleAfterMinutes: 45,
    });
  });
});
