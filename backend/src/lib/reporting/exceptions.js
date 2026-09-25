// LANE reporting — the exceptions somebody is expected to do something about.
//
// A dashboard figure answers "how did we do". An exception answers "who has to
// act, and by when", and the difference is the whole point of this file: a cash
// shortfall of ₹4,000 is not a number on a card, it is a conversation with the
// person who counted the drawer.
//
// Three rules hold for every detector here.
//
//   1. A detector that cannot run says so. It never reports zero. "No low-stock
//      alerts" and "this build cannot see stock" look identical on a screen and
//      only one of them means nobody has to act, so a detector whose data source
//      is absent returns state UNAVAILABLE with the reason and `found: null`.
//
//   2. Detection is idempotent. Every finding carries a dedupeKey derived from
//      the thing it is about — a day-close row, a refund, one store — so running
//      the scan twice, or three schedules running it at once, leaves one row per
//      finding rather than a pile of the same one.
//
//   3. The thresholds are declared, not buried. An owner asking "why is this an
//      exception" is owed the number that made it one, so every finding carries
//      the threshold it crossed in `detail` and the thresholds are exported for
//      the screen to print.

import { prisma } from '../prisma.js';
import { gatewayAvailable } from '../gateway/index.js';
import { toRupees } from '../money.js';
import { paiseOf } from '../orders.js';
import { businessDateOf, businessDatesIn } from './period.js';
import { UNAVAILABLE, PENDING_INTEGRATION, AVAILABLE } from './capability.js';

const hasModel = (...names) => names.every((n) => Boolean(prisma?.[n]));

const rupees = (paise) => ({ paise, amount: toRupees(paise) });

/**
 * What makes a thing worth somebody's morning.
 *
 * Fixed figures rather than a learned baseline, deliberately: this product has
 * months of history for some tenants and four days for others, and a threshold
 * derived from four days of trade would call the first busy Saturday an anomaly.
 * A declared number can be argued with. A model that quietly re-learns cannot.
 */
export const EXCEPTION_THRESHOLDS = Object.freeze({
  // Over or short by more than this in one closing.
  cashVariancePaise: 10_000,
  cashVarianceCriticalPaise: 100_000,
  // One refund this large is worth reading whatever the reason.
  refundPaise: 200_000,
  refundCriticalPaise: 500_000,
  // A single bill discounted by this share of its menu value.
  discountRatePercent: 40,
  discountPaise: 100_000,
  // An item that took more than this multiple of its own station target.
  kitchenOverrunFactor: 2,
});

// A detector whose finding is a historical fact, and one whose finding is a
// condition that can clear on its own, need opposite treatment on re-scan. A
// cash difference on the 14th happened; it stays open until a person signs it
// off. A branch that was silent and has since reported is no longer anybody's
// job, and leaving it open turns the worklist into a list of things that used to
// be wrong — which is the fastest way to get a worklist ignored.
const TRANSIENT = new Set(['STALE_BRANCH_DATA', 'UNCLOSED_SHIFT']);

// Resolved by the scan rather than by a person. `resolvedById` stays null and
// the note says so, because "who cleared this" must not silently answer with
// the name of whoever happened to open the page.
const SYSTEM_CLEARED = 'Cleared automatically: ';

const detectors = [
  // -------------------------------------------------------------------------
  // Money the till could not account for
  // -------------------------------------------------------------------------
  {
    kind: 'CASH_DIFFERENCE',
    label: 'Cash differences at closing',
    responsibleRole: 'BRANCH_MANAGER',
    needs: ['dayClose'],
    run: async ({ storeIds, from, to, settings }) => {
      const rows = await prisma.dayClose.findMany({
        where: {
          branchId: { in: storeIds },
          businessDate: { gte: from, lte: to },
          // A closing that has been corrected is not the current answer. Raising
          // an exception for the figure somebody has already superseded asks them
          // to explain a number they withdrew.
          correctedBy: { is: null },
        },
        select: {
          id: true,
          branchId: true,
          businessDate: true,
          variancePaise: true,
          countedCashPaise: true,
          expectedCashPaise: true,
          note: true,
          closedAt: true,
        },
      });
      return rows
        .filter((r) => Math.abs(r.variancePaise) >= EXCEPTION_THRESHOLDS.cashVariancePaise)
        .map((r) => ({
          dedupeKey: `CASH_DIFFERENCE:${r.id}`,
          branchId: r.branchId,
          severity:
            Math.abs(r.variancePaise) >= EXCEPTION_THRESHOLDS.cashVarianceCriticalPaise
              ? 'CRITICAL'
              : 'WARNING',
          title: `${r.businessDate}: drawer ${r.variancePaise < 0 ? 'short' : 'over'} by ₹${toRupees(
            Math.abs(r.variancePaise),
          )}`,
          // 24 hours from the closing, not from the scan: the clock starts when
          // the mistake was made, so a difference found a week late is already
          // overdue rather than freshly due.
          dueAt: new Date(new Date(r.closedAt).getTime() + 24 * 3600_000),
          detail: {
            businessDate: r.businessDate,
            variance: rupees(r.variancePaise),
            counted: rupees(r.countedCashPaise),
            expected: rupees(r.expectedCashPaise),
            noteGiven: r.note ?? null,
            threshold: rupees(EXCEPTION_THRESHOLDS.cashVariancePaise),
            basis: 'DayClose.variancePaise — counted cash less float less expected cash',
          },
        }));
    },
  },

  // -------------------------------------------------------------------------
  // A day that traded and was never closed
  // -------------------------------------------------------------------------
  {
    kind: 'UNCLOSED_SHIFT',
    label: 'Business days that traded and were never closed',
    responsibleRole: 'BRANCH_MANAGER',
    needs: ['dayClose'],
    run: async ({ storeIds, from, to, settings, now }) => {
      // Only days that have finished. Today is still being traded and its absent
      // closing is not an exception, it is the evening.
      const today = businessDateOf(settings, now);
      const days = businessDatesIn({ from, to }).filter((d) => d < today);
      if (!days.length) return [];

      const [orders, closes] = await Promise.all([
        prisma.order.findMany({
          where: {
            branchId: { in: storeIds },
            status: { in: ['BILLED', 'PAID', 'REFUNDED'] },
            billedAt: { not: null },
          },
          select: { branchId: true, billedAt: true },
        }),
        prisma.dayClose.findMany({
          where: { branchId: { in: storeIds }, businessDate: { in: days } },
          select: { branchId: true, businessDate: true },
        }),
      ]);

      const closed = new Set(closes.map((c) => `${c.branchId}|${c.businessDate}`));
      const traded = new Map();
      for (const o of orders) {
        const date = businessDateOf(settings, o.billedAt);
        if (!days.includes(date)) continue;
        const key = `${o.branchId}|${date}`;
        traded.set(key, (traded.get(key) ?? 0) + 1);
      }

      return [...traded.entries()]
        .filter(([key]) => !closed.has(key))
        .map(([key, bills]) => {
          const [branchId, businessDate] = key.split('|');
          return {
            dedupeKey: `UNCLOSED_SHIFT:${branchId}:${businessDate}`,
            branchId,
            severity: 'WARNING',
            title: `${businessDate}: ${bills} bill${bills === 1 ? '' : 's'} taken, no day close`,
            dueAt: null,
            detail: {
              businessDate,
              billsTaken: bills,
              basis: 'Orders billed on this business day with no DayClose row for it',
            },
          };
        });
    },
  },

  // -------------------------------------------------------------------------
  // Money going back out
  // -------------------------------------------------------------------------
  {
    kind: 'UNUSUAL_REFUND',
    label: 'Large refunds',
    responsibleRole: 'FINANCE',
    needs: ['refund'],
    run: async ({ storeIds, startUtc, endUtc }) => {
      const rows = await prisma.refund.findMany({
        where: {
          order: { branchId: { in: storeIds } },
          createdAt: { gte: startUtc, lt: endUtc },
          status: { in: ['PENDING', 'SUCCEEDED'] },
        },
        select: {
          id: true,
          amount: true,
          reason: true,
          status: true,
          method: true,
          createdAt: true,
          order: { select: { branchId: true, invoiceNumber: true } },
        },
      });
      return rows
        .filter((r) => paiseOf(r.amount) >= EXCEPTION_THRESHOLDS.refundPaise)
        .map((r) => ({
          dedupeKey: `UNUSUAL_REFUND:${r.id}`,
          branchId: r.order?.branchId ?? null,
          severity:
            paiseOf(r.amount) >= EXCEPTION_THRESHOLDS.refundCriticalPaise ? 'CRITICAL' : 'WARNING',
          title: `Refund of ₹${toRupees(paiseOf(r.amount))} on ${r.order?.invoiceNumber ?? 'a bill'}`,
          dueAt: null,
          detail: {
            amount: rupees(paiseOf(r.amount)),
            reason: r.reason ?? null,
            status: r.status,
            method: r.method ?? null,
            invoiceNumber: r.order?.invoiceNumber ?? null,
            threshold: rupees(EXCEPTION_THRESHOLDS.refundPaise),
            basis: 'Refund.createdAt — the date the refund was made',
          },
        }));
    },
  },

  {
    kind: 'UNUSUAL_DISCOUNT',
    label: 'Heavily discounted bills',
    responsibleRole: 'BRANCH_MANAGER',
    needs: ['order'],
    run: async ({ storeIds, startUtc, endUtc }) => {
      const orders = await prisma.order.findMany({
        where: {
          branchId: { in: storeIds },
          status: { in: ['BILLED', 'PAID', 'REFUNDED'] },
          billedAt: { gte: startUtc, lt: endUtc },
        },
        select: {
          id: true,
          branchId: true,
          invoiceNumber: true,
          billedAt: true,
          subtotal: true,
          discountAmount: true,
          items: { where: { status: 'ACTIVE' }, select: { lineDiscount: true, lineSubtotal: true } },
        },
      });

      const out = [];
      for (const o of orders) {
        const itemDisc = o.items.reduce((a, i) => a + paiseOf(i.lineDiscount), 0);
        const lineSubtotal = o.items.length
          ? o.items.reduce((a, i) => a + paiseOf(i.lineSubtotal), 0)
          : paiseOf(o.subtotal);
        const discount = itemDisc + paiseOf(o.discountAmount);
        const gross = lineSubtotal + itemDisc;
        // A bill with nothing on it has no discount rate. Dividing by zero gross
        // would put every voided-to-empty order at the top of the worklist.
        const rate = gross > 0 ? Math.round((discount / gross) * 10000) / 100 : null;
        const bigRate = rate !== null && rate >= EXCEPTION_THRESHOLDS.discountRatePercent;
        const bigValue = discount >= EXCEPTION_THRESHOLDS.discountPaise;
        if (!bigRate && !bigValue) continue;
        out.push({
          dedupeKey: `UNUSUAL_DISCOUNT:${o.id}`,
          branchId: o.branchId,
          severity: bigValue && bigRate ? 'CRITICAL' : 'WARNING',
          title: `${o.invoiceNumber ?? 'A bill'} discounted ₹${toRupees(discount)}${
            rate === null ? '' : ` (${rate}% of menu value)`
          }`,
          dueAt: null,
          detail: {
            discount: rupees(discount),
            itemDiscounts: rupees(itemDisc),
            orderDiscount: rupees(paiseOf(o.discountAmount)),
            grossItems: rupees(gross),
            discountRatePercent: rate,
            invoiceNumber: o.invoiceNumber ?? null,
            thresholds: {
              ratePercent: EXCEPTION_THRESHOLDS.discountRatePercent,
              value: rupees(EXCEPTION_THRESHOLDS.discountPaise),
            },
            basis: 'Item and order discounts against the menu value of the active lines',
          },
        });
      }
      return out;
    },
  },

  // -------------------------------------------------------------------------
  // The kitchen
  // -------------------------------------------------------------------------
  {
    kind: 'DELAYED_KITCHEN_ORDER',
    label: 'Items that overran their station target',
    responsibleRole: 'BRANCH_MANAGER',
    needs: ['kitchenItem'],
    run: async ({ storeIds, startUtc, endUtc, now }) => {
      const rows = await prisma.kitchenItem.findMany({
        where: {
          branchId: { in: storeIds },
          queuedAt: { gte: startUtc, lt: endUtc },
          state: { not: 'CANCELLED' },
        },
        select: {
          id: true,
          branchId: true,
          state: true,
          targetSeconds: true,
          queuedAt: true,
          readyAt: true,
          delayReason: true,
          orderItem: { select: { name: true } },
        },
      });

      const out = [];
      for (const r of rows) {
        // An item still in the pass is measured against the clock now; a finished
        // one against when it was actually ready. Measuring both against now
        // would make every item in the history look worse every day.
        const endedAt = r.readyAt ?? now;
        const seconds = Math.round((new Date(endedAt).getTime() - new Date(r.queuedAt).getTime()) / 1000);
        const limit = r.targetSeconds * EXCEPTION_THRESHOLDS.kitchenOverrunFactor;
        if (!(seconds > limit)) continue;
        out.push({
          dedupeKey: `DELAYED_KITCHEN_ORDER:${r.id}`,
          branchId: r.branchId,
          // Still waiting is worse than took-too-long-and-went-out: one is a
          // customer sitting at a table right now.
          severity: r.readyAt ? 'WARNING' : 'CRITICAL',
          title: `${r.orderItem?.name ?? 'An item'} took ${Math.round(seconds / 60)} min against a ${Math.round(
            r.targetSeconds / 60,
          )} min target`,
          dueAt: null,
          detail: {
            takenSeconds: seconds,
            targetSeconds: r.targetSeconds,
            overrunFactor: Math.round((seconds / r.targetSeconds) * 100) / 100,
            state: r.state,
            stillWaiting: !r.readyAt,
            delayReason: r.delayReason ?? null,
            basis: r.readyAt
              ? 'KitchenItem.queuedAt to readyAt against the station target'
              : 'KitchenItem.queuedAt to now — this item has not been marked ready',
          },
        });
      }
      return out;
    },
  },

  // -------------------------------------------------------------------------
  // A branch that stopped talking
  // -------------------------------------------------------------------------
  {
    kind: 'STALE_BRANCH_DATA',
    label: 'Stores whose data has stopped arriving',
    responsibleRole: 'REGIONAL_MANAGER',
    needs: ['order'],
    // Measured against now, not against the report period. "Has this till been
    // silent since lunch" is a question about the present, and asking it of last
    // month's window would answer about a store that has since recovered.
    run: async ({ storeIds, storesById, settings, now }) => {
      const latest = await prisma.order.groupBy({
        by: ['branchId'],
        where: { branchId: { in: storeIds } },
        _max: { createdAt: true },
      });
      const seen = new Map(latest.map((r) => [r.branchId, r._max.createdAt]));
      const out = [];
      for (const branchId of storeIds) {
        const store = storesById.get(branchId);
        const last = seen.get(branchId) ?? null;
        // A store that has never recorded anything is not stale — nothing has
        // stopped. It may be opening next month, and paging a regional manager
        // about it every hour until it does is how alerting gets switched off.
        if (!last) continue;
        const minutes = Math.round((now.getTime() - new Date(last).getTime()) / 60000);
        if (minutes <= settings.staleAfterMinutes) continue;
        out.push({
          dedupeKey: `STALE_BRANCH_DATA:${branchId}`,
          branchId,
          severity: minutes > settings.staleAfterMinutes * 8 ? 'CRITICAL' : 'WARNING',
          title: `${store?.name ?? 'A store'} has recorded nothing for ${
            minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`
          }`,
          dueAt: null,
          detail: {
            lastActivityAt: last,
            silentMinutes: minutes,
            staleAfterMinutes: settings.staleAfterMinutes,
            basis: 'The most recent order of any status at this store',
          },
        });
      }
      return out;
    },
  },

  // -------------------------------------------------------------------------
  // Detectors this build cannot run. Listed on purpose.
  //
  // Leaving them out would be the more comfortable choice and the wrong one: the
  // screen would show six kinds of exception and an owner would reasonably read
  // the absence of a stock alert as the absence of a stock problem.
  //
  // `implemented: false` is what keeps that promise. Model presence is NOT
  // enough: each `run` below is a stub, so a detector whose models arrive from
  // another lane would start answering `found: 0` — "looked, found none" — for a
  // check nobody has written. That is worse than saying nothing.
  // -------------------------------------------------------------------------
  {
    kind: 'LOW_STOCK',
    label: 'Items below their reorder level',
    responsibleRole: 'INVENTORY',
    needs: ['stockItem', 'stockLevel'],
    implemented: false,
    unavailableNote:
      'Stock levels are not recorded in this deployment, so low stock cannot be detected. This is not a statement that stock is sufficient.',
    run: async () => [],
  },
  {
    kind: 'NEAR_EXPIRY',
    label: 'Batches near expiry or on hold',
    responsibleRole: 'INVENTORY',
    needs: ['stockBatch'],
    implemented: false,
    unavailableNote:
      'Expiry is not detected in this build. StockBatch now exists, but nothing here reads it, so no batch is being checked and none is being reported as safe.',
    run: async () => [],
  },
  {
    kind: 'OVERDUE_REQUEST',
    label: 'Warehouse requests past their due date',
    responsibleRole: 'INVENTORY',
    needs: ['storeRequest'],
    implemented: false,
    unavailableNote:
      'Overdue requests are not detected in this build. StoreRequest now exists, but nothing here reads its due date, so no request is being checked against one.',
    run: async () => [],
  },
  {
    kind: 'SETTLEMENT_MISMATCH',
    label: 'Provider settlements that do not match takings',
    responsibleRole: 'FINANCE',
    needs: [],
    integration: () => gatewayAvailable(),
    implemented: false,
    pendingNote:
      'No payment provider is connected, so there is no settlement file to compare takings against.',
    unavailableNote:
      'Settlement comparison is not written in this build, so takings are not being checked against any settlement file.',
    run: async () => [],
  },
];

export const DETECTOR_KINDS = Object.freeze(detectors.map((d) => d.kind));

const detectorState = (d) => {
  if (d.needs?.length && !hasModel(...d.needs)) {
    return { state: UNAVAILABLE, note: d.unavailableNote ?? 'Not part of this deployment.' };
  }
  if (d.integration && !d.integration()) {
    return { state: PENDING_INTEGRATION, note: d.pendingNote ?? 'Waiting on an integration.' };
  }
  // Last, so a missing model or a missing provider still gets the more specific
  // answer. Reached when the data arrived but the detector was never written.
  if (d.implemented === false) {
    return { state: UNAVAILABLE, note: d.unavailableNote ?? 'Not implemented in this build.' };
  }
  return { state: AVAILABLE, note: null };
};

/**
 * Run every detector that can run, and record what they found.
 *
 * Returns the detector roll-call as well as the findings, because "nothing
 * found" and "not looked for" are the two answers a worklist must never merge.
 * A caller rendering this is expected to print both.
 *
 * Writes are per-finding upserts keyed on dedupeKey. Re-running changes nothing
 * about a finding a person has already acknowledged: `detectedAt` stays, the
 * status stays, only the title and detail are refreshed so the row keeps
 * describing the thing accurately if the underlying figure was corrected.
 */
export const scanExceptions = async ({ scope, period, settings, now = new Date(), actorId = null }) => {
  const storeIds = scope.storeIds;
  const storesById = new Map(scope.stores.map((s) => [s.id, s]));
  const input = {
    storeIds,
    storesById,
    settings,
    now,
    from: period.from,
    to: period.to,
    startUtc: period.startUtc,
    endUtc: period.endUtc,
  };

  const roll = [];
  const found = [];

  for (const d of detectors) {
    const { state, note } = detectorState(d);
    if (state !== AVAILABLE || !storeIds.length) {
      roll.push({
        kind: d.kind,
        label: d.label,
        state: storeIds.length ? state : UNAVAILABLE,
        // found: null, never 0 — see the header. The screen prints the note
        // instead of a count.
        found: null,
        note: storeIds.length ? note : 'No store in your access matches these filters.',
        responsibleRole: d.responsibleRole,
      });
      continue;
    }
    const hits = await d.run(input);
    roll.push({
      kind: d.kind,
      label: d.label,
      state: AVAILABLE,
      found: hits.length,
      note: null,
      responsibleRole: d.responsibleRole,
    });
    for (const h of hits) found.push({ ...h, kind: d.kind, responsibleRole: d.responsibleRole });
  }

  const companyId = scope.companyId;
  let raised = 0;
  let refreshed = 0;

  for (const f of found) {
    const data = {
      companyId,
      branchId: f.branchId ?? null,
      kind: f.kind,
      severity: f.severity,
      dedupeKey: f.dedupeKey,
      title: f.title,
      detail: f.detail ?? null,
      responsibleRole: f.responsibleRole,
      dueAt: f.dueAt ?? null,
    };
    const result = await prisma.reportingException.upsert({
      where: { companyId_dedupeKey: { companyId, dedupeKey: f.dedupeKey } },
      create: { ...data, detectedAt: now },
      // Not `status: 'OPEN'`. Re-opening what somebody has already dealt with
      // would make the acknowledgement meaningless and the list unfinishable.
      update: {
        severity: data.severity,
        title: data.title,
        detail: data.detail,
        dueAt: data.dueAt,
      },
      select: { id: true, detectedAt: true },
    });
    if (result.detectedAt.getTime() === now.getTime()) raised += 1;
    else refreshed += 1;
  }

  // Conditions that have cleared. Only for the transient kinds, and only for the
  // detectors that actually ran — a detector that could not run has found
  // nothing, and closing its open exceptions on that basis would quietly mark a
  // real problem as fixed because the module that sees it was removed.
  const ranKinds = new Set(roll.filter((r) => r.state === AVAILABLE).map((r) => r.kind));
  const stillOpen = new Set(found.map((f) => f.dedupeKey));
  const transientKinds = [...TRANSIENT].filter((k) => ranKinds.has(k));
  let cleared = 0;
  if (transientKinds.length) {
    const open = await prisma.reportingException.findMany({
      where: {
        companyId,
        kind: { in: transientKinds },
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        OR: [{ branchId: { in: storeIds } }, { branchId: null }],
      },
      select: { id: true, dedupeKey: true, kind: true },
    });
    const gone = open.filter((o) => !stillOpen.has(o.dedupeKey));
    for (const o of gone) {
      await prisma.reportingException.update({
        where: { id: o.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: now,
          // Deliberately not actorId. The person who happened to run the scan did
          // not fix this, and naming them would be a false audit trail.
          resolvedById: null,
          resolutionNote: `${SYSTEM_CLEARED}the condition was no longer present when the exceptions were next checked.`,
        },
      });
      cleared += 1;
    }
  }

  return { detectors: roll, raised, refreshed, cleared, scannedAt: now.toISOString() };
};

export const publicException = (e, storesById = new Map()) => ({
  id: e.id,
  kind: e.kind,
  severity: e.severity,
  status: e.status,
  title: e.title,
  detail: e.detail ?? null,
  branchId: e.branchId ?? null,
  storeName: e.branchId ? (storesById.get(e.branchId)?.name ?? null) : null,
  responsibleRole: e.responsibleRole,
  dueAt: e.dueAt?.toISOString() ?? null,
  // An exception past its due time with nobody on it is the one an owner is
  // looking for, and asking a client to compute that from two fields is asking
  // for two clients to disagree about it.
  overdue: Boolean(e.dueAt && e.status !== 'RESOLVED' && e.status !== 'DISMISSED' && e.dueAt < new Date()),
  detectedAt: e.detectedAt.toISOString(),
  acknowledgedAt: e.acknowledgedAt?.toISOString() ?? null,
  resolvedAt: e.resolvedAt?.toISOString() ?? null,
  resolutionNote: e.resolutionNote ?? null,
  // Whether a human closed this, or the condition simply stopped being true.
  // Both are legitimate; reading one as the other is not.
  clearedBySystem: Boolean(e.resolvedAt && !e.resolvedById),
});

/**
 * Which detectors this deployment cannot run, and why — without running any.
 *
 * `detectorState` only asks whether the tables and integrations a detector needs
 * are present, so this costs nothing. It exists so that "what was not looked for"
 * is answerable by a caller that has no business running a scan: the dashboard
 * needs to name the gaps and must not perform detection to do it.
 */
export const undetectableKinds = () =>
  detectors
    .map((d) => ({ d, ...detectorState(d) }))
    .filter((x) => x.state !== AVAILABLE)
    .map((x) => ({ kind: x.d.kind, note: x.note }));

/**
 * The dashboard's one-line summary of the worklist.
 *
 * Counts only what is genuinely open, and carries the detectors that could not run
 * so the dashboard can say "6 open, 4 kinds not detectable here" rather than
 * implying the estate has been swept clean.
 *
 * `detectorRoll` is the roll a scan just produced, which additionally knows what
 * each detector FOUND. It is optional, and when it is absent the gaps are still
 * named from capability rather than reported as unknown — a summary that answered
 * `undetectable: null` would put the caller in the position of rendering "3 to act
 * on" beside nothing about stock, which reads as "and stock is fine".
 */
export const exceptionSummary = async ({ scope, detectorRoll = null }) => {
  const rows = await prisma.reportingException.groupBy({
    by: ['severity'],
    where: {
      companyId: scope.companyId,
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      OR: [{ branchId: { in: scope.storeIds } }, { branchId: null }],
    },
    _count: { _all: true },
  });
  const bySeverity = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  for (const r of rows) bySeverity[r.severity] = r._count._all;
  const overdue = await prisma.reportingException.count({
    where: {
      companyId: scope.companyId,
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      dueAt: { lt: new Date() },
      OR: [{ branchId: { in: scope.storeIds } }, { branchId: null }],
    },
  });
  return {
    open: bySeverity.CRITICAL + bySeverity.WARNING + bySeverity.INFO,
    bySeverity,
    overdue,
    undetectable: detectorRoll
      ? detectorRoll.filter((d) => d.state !== AVAILABLE).map((d) => ({ kind: d.kind, note: d.note }))
      : undetectableKinds(),
  };
};
