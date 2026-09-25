// LANE reporting — period resolution against company policy, not the server clock.
//
// Three settings decide where a "day" begins and all three belong to the
// customer, not to this process: the timezone the shop trades in, the minute its
// business day rolls over, and the weekday its week starts on. A bar that closes
// at 3am books those sales to the previous trading day; a franchise reporting
// across Dubai and Kolkata cannot share one offset.
//
// The rest of reporting takes every boundary from this module — screen, drill-down,
// export and scheduled send alike — so two views cannot disagree about when
// "yesterday" was. src/lib/orders.js keeps its hardcoded IST helpers because the
// existing day-close rows were written with them; nothing here rewrites history.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const REPORTING_DEFAULTS = Object.freeze({
  timezone: 'Asia/Kolkata',
  businessDayCutoffMinutes: 0,
  weekStartDay: 1,
  financialYearStartMonth: 4,
  staleAfterMinutes: 180,
});

const formatters = new Map();
const formatterFor = (timeZone) => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
};

export const isSupportedTimeZone = (timeZone) => {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const zonedParts = (timeZone, instant) => {
  const out = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(instant)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
};

export const zoneOffsetMs = (timeZone, instant) => {
  const ms = instant.getTime();
  const p = zonedParts(timeZone, instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
};

// Wall-clock → instant. Two passes, because the offset needed depends on the
// instant still being computed. A first guess using the offset at the naive time
// lands within an hour of the answer; re-reading the offset there settles it.
// The second pass is what puts 1:30am on a DST-shift night on the correct side
// of the jump instead of an hour out.
export const zonedTimeToUtc = (timeZone, { year, month, day, minutes = 0 }) => {
  const naive = Date.UTC(year, month - 1, day) + minutes * MINUTE_MS;
  const guess = new Date(naive - zoneOffsetMs(timeZone, new Date(naive)));
  return new Date(naive - zoneOffsetMs(timeZone, guess));
};

const dayMsOf = (isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const isoOfDayMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (isoDate, n) => isoOfDayMs(dayMsOf(isoDate) + n * DAY_MS);
export const daysBetween = (fromIso, toIso) => Math.round((dayMsOf(toIso) - dayMsOf(fromIso)) / DAY_MS);
export const weekdayOf = (isoDate) => new Date(dayMsOf(isoDate)).getUTCDay();

// Every business date in a period, inclusive. Business dates, not instants: a
// report about day closes is a report about the days staff worked, and that is
// what the calendar in the company's timezone calls them.
export const businessDatesIn = ({ from, to }) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export const addMonths = (isoDate, n) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
};

export const startOfMonth = (isoDate) => `${isoDate.slice(0, 7)}-01`;
export const endOfMonth = (isoDate) => addDays(addMonths(startOfMonth(isoDate), 1), -1);

export const startOfWeek = (settings, isoDate) =>
  addDays(isoDate, -((weekdayOf(isoDate) - settings.weekStartDay + 7) % 7));
export const endOfWeek = (settings, isoDate) => addDays(startOfWeek(settings, isoDate), 6);

export const startOfFinancialYear = (settings, isoDate) => {
  const [year, month] = isoDate.split('-').map(Number);
  const startYear = month >= settings.financialYearStartMonth ? year : year - 1;
  return `${String(startYear).padStart(4, '0')}-${String(settings.financialYearStartMonth).padStart(2, '0')}-01`;
};
export const endOfFinancialYear = (settings, isoDate) =>
  addDays(addMonths(startOfFinancialYear(settings, isoDate), 12), -1);

// The instant a named business day opens.
export const businessDayStartUtc = (settings, isoDate) => {
  const [year, month, day] = isoDate.split('-').map(Number);
  return zonedTimeToUtc(settings.timezone, {
    year,
    month,
    day,
    minutes: settings.businessDayCutoffMinutes,
  });
};

// Which business day an instant trades in. With a 5am cutoff a 2am sale belongs
// to the day before, which is the whole point of the setting.
export const businessDateOf = (settings, instant) => {
  const p = zonedParts(settings.timezone, instant);
  const minuteOfDay = p.hour * 60 + p.minute;
  const base = Date.UTC(p.year, p.month - 1, p.day);
  return isoOfDayMs(minuteOfDay < settings.businessDayCutoffMinutes ? base - DAY_MS : base);
};

export const PRESETS = Object.freeze([
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'LAST_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_FINANCIAL_YEAR',
  'LAST_FINANCIAL_YEAR',
  'CUSTOM',
]);

export const GROUPINGS = Object.freeze(['DAY', 'WEEK', 'MONTH']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The accepted range for each policy value, stated once so the API that
// validates a patch and the normaliser that stores it cannot disagree. When
// they were written separately the route accepted weekStartDay 7 and the
// normaliser silently wrote 1 — the owner was told their week now starts on
// Sunday while every report still cut it on Monday.
//
// weekStartDay is JS weekday numbering, 0 = Sunday, because that is what
// getUTCDay returns and what indexes the weekday names in the export. The
// cutoff stops before noon on purpose: past that, most of the calendar day
// would belong to the previous business day, which is not a cutoff but a
// different calendar.
export const SETTINGS_BOUNDS = Object.freeze({
  businessDayCutoffMinutes: { min: 0, max: 12 * 60 - 1 },
  weekStartDay: { min: 0, max: 6 },
  financialYearStartMonth: { min: 1, max: 12 },
  staleAfterMinutes: { min: 5, max: 7 * 24 * 60 },
});

export const normalizeSettings = (raw = {}) => {
  const timezone =
    typeof raw.timezone === 'string' && isSupportedTimeZone(raw.timezone)
      ? raw.timezone
      : REPORTING_DEFAULTS.timezone;
  const int = (key) => {
    const { min, max } = SETTINGS_BOUNDS[key];
    const n = Number(raw[key]);
    if (!Number.isInteger(n) || n < min || n > max) return REPORTING_DEFAULTS[key];
    return n;
  };
  return {
    timezone,
    businessDayCutoffMinutes: int('businessDayCutoffMinutes'),
    weekStartDay: int('weekStartDay'),
    financialYearStartMonth: int('financialYearStartMonth'),
    staleAfterMinutes: int('staleAfterMinutes'),
  };
};

const presetRange = (preset, settings, today) => {
  switch (preset) {
    case 'TODAY':
      return { from: today, to: today, label: 'Today' };
    case 'YESTERDAY': {
      const d = addDays(today, -1);
      return { from: d, to: d, label: 'Yesterday' };
    }
    case 'THIS_WEEK': {
      const from = startOfWeek(settings, today);
      return { from, to: addDays(from, 6), label: 'This week' };
    }
    case 'LAST_WEEK': {
      const from = addDays(startOfWeek(settings, today), -7);
      return { from, to: addDays(from, 6), label: 'Last week' };
    }
    case 'THIS_MONTH':
      return { from: startOfMonth(today), to: endOfMonth(today), label: 'This month' };
    case 'LAST_MONTH': {
      const anchor = addMonths(startOfMonth(today), -1);
      return { from: anchor, to: endOfMonth(anchor), label: 'Last month' };
    }
    case 'THIS_FINANCIAL_YEAR':
      return {
        from: startOfFinancialYear(settings, today),
        to: endOfFinancialYear(settings, today),
        label: 'This financial year',
      };
    case 'LAST_FINANCIAL_YEAR': {
      const anchor = addDays(startOfFinancialYear(settings, today), -1);
      return {
        from: startOfFinancialYear(settings, anchor),
        to: endOfFinancialYear(settings, anchor),
        label: 'Last financial year',
      };
    }
    default:
      return null;
  }
};

// Chosen so a caller that names no grouping still gets a readable number of
// buckets: two months of days, half a year of weeks, longer than that in months.
// A financial year drawn as 52 weekly bars is not a report anyone reads.
const defaultGrouping = (from, to) => {
  const days = daysBetween(from, to) + 1;
  if (days <= 62) return 'DAY';
  if (days <= 180) return 'WEEK';
  return 'MONTH';
};

const bucketsFor = (settings, from, to, grouping, endUtcCap) => {
  const out = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard++ < 4000) {
    let last;
    let label;
    if (grouping === 'DAY') {
      last = cursor;
      label = cursor;
    } else if (grouping === 'WEEK') {
      last = endOfWeek(settings, cursor);
      label = `Week of ${startOfWeek(settings, cursor)}`;
    } else {
      last = endOfMonth(cursor);
      label = cursor.slice(0, 7);
    }
    if (last > to) last = to;
    const startUtc = businessDayStartUtc(settings, cursor);
    const rawEnd = businessDayStartUtc(settings, addDays(last, 1));
    // Clamp only the bucket the cap falls inside. Clamping every later bucket too
    // would set their end before their own start, producing windows that quietly
    // match nothing instead of empty windows that honestly have not happened yet.
    const live = Boolean(endUtcCap) && endUtcCap > startUtc && endUtcCap < rawEnd;
    out.push({
      key: grouping === 'MONTH' ? cursor.slice(0, 7) : cursor,
      label,
      from: cursor,
      to: last,
      startUtc,
      endUtc: live ? endUtcCap : rawEnd,
      partial: live,
      future: Boolean(endUtcCap) && startUtc >= endUtcCap,
    });
    cursor = addDays(last, 1);
  }
  return out;
};

const comparisonRange = (preset, settings, period) => {
  switch (preset) {
    case 'TODAY':
    case 'YESTERDAY': {
      const d = addDays(period.from, -1);
      return { from: d, to: d, label: preset === 'TODAY' ? 'Yesterday' : 'Day before' };
    }
    case 'THIS_WEEK':
    case 'LAST_WEEK': {
      const from = addDays(period.from, -7);
      return { from, to: addDays(from, 6), label: 'Previous week' };
    }
    case 'THIS_MONTH':
    case 'LAST_MONTH': {
      const from = addMonths(period.from, -1);
      return { from, to: endOfMonth(from), label: 'Previous month' };
    }
    case 'THIS_FINANCIAL_YEAR':
    case 'LAST_FINANCIAL_YEAR': {
      const anchor = addDays(period.from, -1);
      return {
        from: startOfFinancialYear(settings, anchor),
        to: endOfFinancialYear(settings, anchor),
        label: 'Previous financial year',
      };
    }
    default: {
      // A custom window compares against the window of equal length that ends
      // the day before it starts, which is the only choice that needs no guess
      // about what the user meant.
      const span = daysBetween(period.from, period.to);
      const to = addDays(period.from, -1);
      return { from: addDays(to, -span), to, label: 'Preceding period' };
    }
  }
};

/**
 * Resolve a reporting period. `endUtc` is exclusive throughout.
 *
 * A period that contains the live business day is `partial`: it ends at `now`,
 * not at midnight. Its comparison is then clipped to the same elapsed duration,
 * because 09:00-to-now against a whole previous day is the single most common
 * way a dashboard lies about a drop in sales.
 */
export const resolvePeriod = ({
  preset = 'TODAY',
  from,
  to,
  grouping,
  now = new Date(),
  settings: rawSettings,
} = {}) => {
  const settings = normalizeSettings(rawSettings);
  const today = businessDateOf(settings, now);

  let range;
  let resolvedPreset = preset;
  if (preset === 'CUSTOM' || (from && to && !PRESETS.includes(preset))) {
    resolvedPreset = 'CUSTOM';
    if (!ISO_DATE.test(from ?? '') || !ISO_DATE.test(to ?? '')) {
      throw Object.assign(new Error('A custom period needs from and to as YYYY-MM-DD'), {
        statusCode: 400,
        field: 'from',
      });
    }
    if (from > to) {
      throw Object.assign(new Error('from must not be after to'), { statusCode: 400, field: 'from' });
    }
    range = { from, to, label: from === to ? from : `${from} to ${to}` };
  } else {
    range = presetRange(preset, settings, today);
    if (!range) {
      throw Object.assign(new Error(`Unknown period preset: ${preset}`), {
        statusCode: 400,
        field: 'preset',
      });
    }
  }

  const usedGrouping = GROUPINGS.includes(grouping) ? grouping : defaultGrouping(range.from, range.to);
  const startUtc = businessDayStartUtc(settings, range.from);
  const fullEndUtc = businessDayStartUtc(settings, addDays(range.to, 1));
  const partial = now < fullEndUtc && now > startUtc;
  const endUtc = partial ? now : fullEndUtc;

  const cmp = comparisonRange(resolvedPreset, settings, range);
  const cmpStartUtc = businessDayStartUtc(settings, cmp.from);
  const cmpFullEndUtc = businessDayStartUtc(settings, addDays(cmp.to, 1));
  const sameElapsed = partial;
  const cmpEndUtc = sameElapsed
    ? new Date(Math.min(cmpStartUtc.getTime() + (endUtc.getTime() - startUtc.getTime()), cmpFullEndUtc.getTime()))
    : cmpFullEndUtc;

  return {
    preset: resolvedPreset,
    label: range.label,
    from: range.from,
    to: range.to,
    startUtc,
    endUtc,
    fullEndUtc,
    partial,
    grouping: usedGrouping,
    timezone: settings.timezone,
    businessDayCutoffMinutes: settings.businessDayCutoffMinutes,
    weekStartDay: settings.weekStartDay,
    financialYearStartMonth: settings.financialYearStartMonth,
    today,
    buckets: bucketsFor(settings, range.from, range.to, usedGrouping, partial ? endUtc : null),
    comparison: {
      label: cmp.label,
      from: cmp.from,
      to: cmp.to,
      startUtc: cmpStartUtc,
      endUtc: cmpEndUtc,
      basis: sameElapsed ? 'SAME_ELAPSED' : 'FULL_PERIOD',
      elapsedMs: endUtc.getTime() - startUtc.getTime(),
    },
  };
};

// What a report exposes about its own boundaries. Every payload carries this so
// an export can be checked against the screen it came from.
export const periodDescriptor = (period) => ({
  preset: period.preset,
  label: period.label,
  from: period.from,
  to: period.to,
  startUtc: period.startUtc.toISOString(),
  endUtc: period.endUtc.toISOString(),
  partial: period.partial,
  grouping: period.grouping,
  timezone: period.timezone,
  businessDayCutoffMinutes: period.businessDayCutoffMinutes,
  weekStartDay: period.weekStartDay,
  financialYearStartMonth: period.financialYearStartMonth,
  comparison: {
    label: period.comparison.label,
    from: period.comparison.from,
    to: period.comparison.to,
    startUtc: period.comparison.startUtc.toISOString(),
    endUtc: period.comparison.endUtc.toISOString(),
    basis: period.comparison.basis,
  },
});

export const bucketOf = (period, instant) => {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  for (const b of period.buckets) {
    if (t >= b.startUtc.getTime() && t < b.endUtc.getTime()) return b.key;
  }
  return null;
};
