// LANE reporting — what this deployment can honestly report on.
//
// A report family whose data does not exist in this build must say so. It must
// not render zeros, because a zero is a measurement: "you wasted no stock today"
// and "this deployment cannot see stock" are opposite statements and only one of
// them is true. The same applies to Swiggy, Zomato, Reelo and Tally figures —
// absent integration data is reported as pending, never as nil sales.
//
// Availability is detected from the deployed schema rather than declared in a
// constant, so the day the inventory or providers lane merges, these families
// light up on their own instead of waiting for someone to remember this file.

import { prisma } from '../prisma.js';
import { gatewayAvailable } from '../gateway/index.js';

export const AVAILABLE = 'AVAILABLE';
export const PENDING_INTEGRATION = 'PENDING_INTEGRATION';
export const UNAVAILABLE = 'UNAVAILABLE';

// An unknown model name reads as undefined on the Prisma client, which is the
// only trustworthy signal available at runtime: package.json, migration folders
// and menu entries can all disagree with the client the process actually loaded.
const hasModel = (...names) => names.every((n) => Boolean(prisma?.[n]));

const FAMILIES = [
  { key: 'sales', label: 'Sales, tax and discounts', needs: [] },
  { key: 'collections', label: 'Collections by payment method', needs: [] },
  { key: 'dues', label: 'Outstanding dues', needs: [] },
  { key: 'refunds', label: 'Refunds', needs: [] },
  { key: 'productMix', label: 'Product and menu mix, variants and modifiers', needs: [] },
  { key: 'locationComparison', label: 'Location comparison', needs: [] },
  { key: 'cash', label: 'Cash, shift and day-close differences', needs: [] },
  {
    key: 'settlement',
    label: 'Settlement reconciliation',
    needs: [],
    integration: () => gatewayAvailable(),
    pendingNote: 'No payment provider is configured, so there is nothing to reconcile against.',
  },
  {
    key: 'consumption',
    label: 'Ingredient consumption and variance',
    needs: ['recipe', 'stockMovement'],
    unavailableNote: 'Recipes and stock movements are not part of this deployment.',
  },
  {
    key: 'wastage',
    label: 'Recorded wastage',
    needs: ['stockWastage'],
    unavailableNote: 'Wastage recording is not part of this deployment.',
  },
  {
    key: 'stockValuation',
    label: 'Stock valuation',
    needs: ['stockValuationSnapshot'],
    unavailableNote: 'Stock valuation is not part of this deployment.',
  },
  {
    key: 'expiry',
    label: 'Batch expiry, reserved and quarantined stock',
    needs: ['stockBatch'],
    unavailableNote: 'Batch tracking is not part of this deployment.',
  },
  {
    key: 'transfers',
    label: 'Warehouse requests, dispatches and receipts',
    needs: ['storeRequest'],
    unavailableNote: 'Store requests and transfers are not part of this deployment.',
  },
  {
    key: 'purchasing',
    label: 'Supplier purchases, receiving differences and price changes',
    needs: ['purchaseOrder'],
    unavailableNote: 'Purchasing is not part of this deployment.',
  },
  {
    key: 'kitchenDelays',
    label: 'Kitchen and service delays',
    needs: ['kitchenItem'],
  },
  {
    key: 'loyalty',
    label: 'Customer, repeat visit and loyalty',
    needs: ['loyaltyProfileLink'],
    unavailableNote: 'No loyalty integration is part of this deployment.',
    connection: 'LOYALTY',
  },
  {
    key: 'delivery',
    label: 'Delivery and aggregator channels',
    needs: ['aggregatorOrder'],
    unavailableNote: 'No aggregator integration is part of this deployment.',
    connection: 'AGGREGATOR',
  },
  {
    key: 'accounting',
    label: 'Accounting hand-off',
    needs: ['accountingPosting'],
    unavailableNote: 'No accounting integration is part of this deployment.',
    connection: 'ACCOUNTING',
  },
  {
    key: 'profitability',
    label: 'Food margin and contribution',
    needs: ['recipe'],
    unavailableNote: 'Recipe costs are not part of this deployment.',
    // Named so no screen can quietly promote it. Rent, salaries and utilities are
    // not recorded anywhere in this product, so the figure it produces is a food
    // margin and calling it profit would overstate the business by every expense
    // the POS never sees.
    caveat: 'Food margin only. Rent, salaries and utilities are not recorded, so this is not net profit.',
  },
];

const connectionState = async (companyId, kind) => {
  if (!prisma?.integrationConnection) return null;
  const rows = await prisma.integrationConnection.findMany({
    where: { companyId, kind },
    select: { id: true, provider: true, status: true, lastSyncAt: true, lastError: true },
  });
  return rows;
};

/**
 * What each report family can honestly say, for this company, right now.
 *
 * Three states and they are not interchangeable:
 *   AVAILABLE           — the data exists and the figures are measured
 *   PENDING_INTEGRATION — the module is here, nobody has connected the provider
 *   UNAVAILABLE         — the module is not in this build at all
 */
export const reportingCapabilities = async (companyId) => {
  const out = {};
  for (const f of FAMILIES) {
    const present = f.needs.length === 0 || hasModel(...f.needs);
    if (!present) {
      out[f.key] = {
        key: f.key,
        label: f.label,
        state: UNAVAILABLE,
        note: f.unavailableNote ?? `${f.label} is not part of this deployment.`,
        // A caveat says what the figure MEANS, so it is true whether or not the
        // figure can currently be produced. Emitting it only on the available
        // branch meant that "this is not net profit" vanished from the payload
        // the moment recipes were absent — and reappeared, unread, on the day
        // they landed. It belongs to the family, not to its state.
        caveat: f.caveat ?? null,
        lastSyncAt: null,
      };
      continue;
    }

    if (f.connection) {
      const conns = (await connectionState(companyId, f.connection)) ?? [];
      const live = conns.filter((c) => c.status === 'ACTIVE');
      out[f.key] = {
        key: f.key,
        label: f.label,
        state: live.length ? AVAILABLE : PENDING_INTEGRATION,
        note: live.length
          ? null
          : `No ${f.connection.toLowerCase()} provider is connected, so these figures are not available yet.`,
        caveat: f.caveat ?? null,
        providers: conns.map((c) => ({
          provider: c.provider,
          status: c.status,
          lastSyncAt: c.lastSyncAt ?? null,
          lastError: c.lastError ?? null,
        })),
        lastSyncAt: live.reduce((a, c) => (c.lastSyncAt && (!a || c.lastSyncAt > a) ? c.lastSyncAt : a), null),
      };
      continue;
    }

    const ok = f.integration ? f.integration() : true;
    out[f.key] = {
      key: f.key,
      label: f.label,
      state: ok ? AVAILABLE : PENDING_INTEGRATION,
      note: ok ? (f.caveat ?? null) : (f.pendingNote ?? null),
      caveat: f.caveat ?? null,
      lastSyncAt: null,
    };
  }
  return out;
};

export const requireCapability = (capabilities, key) => {
  const cap = capabilities[key];
  if (!cap) throw Object.assign(new Error(`Unknown report family: ${key}`), { statusCode: 400 });
  return cap;
};

/**
 * What a named report — not its data — can honestly say about itself.
 *
 * The capability above answers a question about the DATA: is the model here, is
 * the provider connected. Whether this build actually computes a given report is
 * a second, independent question, and conflating the two produced a report that
 * announced state AVAILABLE while answering available:false with no reason at
 * all. "Kitchen delays: available" beside an empty table is worse than a missing
 * menu entry, because the reader concludes there were no delays.
 *
 * So: a report with no builder is UNAVAILABLE whatever its data says — which is
 * the existing meaning of that state, "the module is not in this build" — and the
 * note distinguishes the two reasons, because they ask the owner for different
 * things. One needs a provider connected. The other needs a later version.
 *
 * Used by both the catalog and the report route so the menu and the screen behind
 * it cannot give different answers.
 */
export const reportAvailability = ({ key, label, cap, buildable }) => {
  if (buildable) {
    return {
      state: cap?.state ?? AVAILABLE,
      note: cap?.note ?? null,
    };
  }
  if (cap && cap.state !== AVAILABLE) return { state: cap.state, note: cap.note };
  return {
    state: UNAVAILABLE,
    note: cap
      ? `${cap.label} is recorded, but this version does not build the ${label ?? key} report from it. No figures are shown rather than a zero.`
      : 'This report is not part of this deployment.',
  };
};

// A family that cannot be measured answers 200 with this body rather than an
// error. A 500 would look like a fault the customer should report; an empty
// success would look like a measured zero. Neither is true.
export const unavailablePayload = (cap, extra = {}) => ({
  available: false,
  state: cap.state,
  family: cap.key,
  label: cap.label,
  note: cap.note,
  providers: cap.providers ?? null,
  lastSyncAt: cap.lastSyncAt ?? null,
  rows: [],
  totals: null,
  ...extra,
});

export const DATA_ACTIVE = 'ACTIVE';
export const DATA_NO_ACTIVITY = 'NO_ACTIVITY';
export const DATA_NEVER_RECORDED = 'NEVER_RECORDED';
export const DATA_STALE = 'STALE';

/**
 * Why a store's row is empty.
 *
 * "Closed today", "never traded" and "the branch stopped syncing four hours ago"
 * all render as a blank row unless they are told apart, and the third one is an
 * incident. `lastActivityAt` is the store's most recent order of any kind, which
 * is the only clock that moves on its own.
 */
export const storeCoverage = ({ rowsInPeriod, lastActivityAt, everRecorded, period, staleAfterMinutes, now }) => {
  if (rowsInPeriod > 0) {
    if (period.partial && lastActivityAt) {
      const ageMinutes = (now.getTime() - new Date(lastActivityAt).getTime()) / 60000;
      if (ageMinutes > staleAfterMinutes) {
        return {
          state: DATA_STALE,
          lastActivityAt,
          note: `No activity for ${Math.round(ageMinutes)} minutes.`,
        };
      }
    }
    return { state: DATA_ACTIVE, lastActivityAt, note: null };
  }
  if (!everRecorded) {
    return {
      state: DATA_NEVER_RECORDED,
      lastActivityAt: null,
      note: 'This store has never recorded a transaction, so there is no figure to show.',
    };
  }
  if (period.partial && lastActivityAt) {
    const ageMinutes = (now.getTime() - new Date(lastActivityAt).getTime()) / 60000;
    if (ageMinutes > staleAfterMinutes) {
      return {
        state: DATA_STALE,
        lastActivityAt,
        note: `Nothing recorded in this period and nothing for ${Math.round(ageMinutes)} minutes.`,
      };
    }
  }
  return { state: DATA_NO_ACTIVITY, lastActivityAt, note: 'No transactions in this period.' };
};
