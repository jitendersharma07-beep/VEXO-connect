// Zomato adapter (LANE providers).
//
// WHAT IS VERIFIED AND WHAT IS NOT — read this before changing anything here.
//
// VERIFIED from Zomato's public developer pages (2026-09-24): the endpoint paths
// in providers.js, the existence and names of the inbound webhook types, and the
// fact that inbound authentication is a header Zomato is configured to send.
//
// NOT VERIFIED, because Zomato gates its API reference behind an organisation
// login: the request bodies, the response bodies, the header names, the error
// codes. Everything below marked UNSPECIFIED-BODY is our reading of a documented
// path, and MUST be checked against Zomato's partner reference before go-live.
//
// The design consequence is the important bit: the INBOUND half is fully ours to
// get right and is implemented completely, because dedupe, ordering, outlet
// resolution and KOT routing do not depend on field names. The normaliser below
// reads defensively and records what it could not understand instead of guessing
// — an order with an unreadable total becomes a recorded discrepancy and a
// visible exception, never a bill for the wrong amount.

import { providerDef } from '../providers.js';
import { ProviderCallError, providerFetch, joinUrl } from '../http.js';

const PATHS = providerDef('ZOMATO').paths;

// Zomato issues the API key; the base is configurable so a partner sandbox or a
// local contract stub can be pointed at without editing code. env.js already
// refuses a plain-http base outside test/development for the gateway; this one
// is validated as a URL by the provider's configSchema.
const baseOf = (config) => config?.apiBase || null;

// UNSPECIFIED-BODY. Zomato's public prerequisites say API keys come from the
// POC but do not say which header carries them. Bearer is the overwhelming
// convention and is what we send; if the partner reference says otherwise this
// is the single line that changes.
const authHeaders = (credential) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${credential.apiKey}`,
});

// --- inbound -----------------------------------------------------------------

// Pull a value from the first key that exists, case-insensitively at the top
// level. This is not laziness about the schema — it is the only responsible way
// to read a body whose field names are behind a login. Each lookup lists the
// plausible names, and anything not found stays null and is reported as missing
// rather than defaulted to zero. A silent 0 in a money field is the single worst
// outcome available here.
const pick = (obj, names) => {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const name of names) {
    const key = lower.get(name.toLowerCase());
    if (key !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
};

// Money arrives as a string, a number, or in paise, depending on the provider
// and the endpoint. Returns null rather than 0 for anything unreadable, and the
// caller turns null into a recorded discrepancy.
const amount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[, ]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
};

const asDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Zomato's published webhook list, mapped to what this lane does about each.
// Kinds we do not act on are still RECORDED — a complaint relay we ignore today
// is evidence tomorrow, and an unrecognised kind must never 4xx, or Zomato will
// redeliver it forever.
const EVENT_KIND = Object.freeze({
  order_relay: 'ORDER_PLACED',
  order_status_update: 'ORDER_STATUS',
  fetch_order_status_update: 'ORDER_STATUS',
  delivery_partner_status_update: 'RIDER_STATUS',
  menu_processing_status: 'MENU_STATUS',
  menu_moderation_status: 'MENU_STATUS',
  outlet_serviceability: 'OUTLET_STATUS',
  complaint_relay: 'COMPLAINT',
  mac_relay: 'CANCELLATION_REQUEST',
  order_rating_update: 'RATING',
});

// Provider state strings mapped onto our AggregatorOrderState. Unknown strings
// return null and the event is parked with a reason — inventing a state for an
// unrecognised string is how an order silently skips acceptance.
const STATE = Object.freeze({
  placed: 'RECEIVED',
  new: 'RECEIVED',
  confirmed: 'ACCEPTED',
  accepted: 'ACCEPTED',
  acknowledged: 'ACCEPTED',
  rejected: 'REJECTED',
  preparing: 'PREPARING',
  food_prepared: 'READY',
  ready: 'READY',
  pickedup: 'PICKED_UP',
  picked_up: 'PICKED_UP',
  dispatched: 'PICKED_UP',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
});

export const normalizeInbound = (kindHint, body) => {
  const order = pick(body, ['order', 'order_details', 'data']) ?? body;

  const externalOrderId = pick(order, ['order_id', 'orderId', 'id', 'zomato_order_id']);
  const externalEventId = pick(body, ['event_id', 'eventId', 'callback_id', 'request_id']);
  const externalOutletId = pick(order, ['res_id', 'restaurant_id', 'outlet_id', 'merchant_id', 'store_id']);
  const rawState = pick(body, ['status', 'order_status', 'event', 'event_type']) ?? pick(order, ['status', 'order_status']);

  const money = {
    grossAmount: amount(pick(order, ['total_cost', 'order_total', 'gross_amount', 'subtotal'])),
    providerDiscountAmount: amount(pick(order, ['zomato_discount', 'aggregator_discount', 'provider_discount'])),
    restaurantDiscountAmount: amount(pick(order, ['restaurant_discount', 'merchant_discount', 'discount'])),
    commissionAmount: amount(pick(order, ['commission', 'commission_amount', 'commissionable_amount'])),
    taxAmount: amount(pick(order, ['taxes', 'tax_amount', 'total_taxes', 'gst'])),
    deliveryFeeAmount: amount(pick(order, ['delivery_charge', 'delivery_fee', 'delivery_charges'])),
    packagingFeeAmount: amount(pick(order, ['packaging_charge', 'packing_charge', 'container_charge'])),
    netPayoutAmount: amount(pick(order, ['net_payable', 'payout', 'net_amount', 'merchant_payout'])),
  };

  return {
    // Zomato may not send an event id at all. Falling back to order+state+time
    // keeps the dedupe key deterministic for a redelivery of the SAME event
    // while staying distinct across genuinely different events for one order.
    externalEventId: externalEventId
      ? String(externalEventId)
      : `derived:${externalOrderId ?? 'unknown'}:${rawState ?? kindHint}:${pick(body, ['updated_at', 'timestamp', 'event_time']) ?? ''}`,
    kind: EVENT_KIND[String(kindHint || '').toLowerCase()] ?? 'UNKNOWN',
    externalOrderId: externalOrderId != null ? String(externalOrderId) : null,
    externalOrderDisplayId: (() => {
      const v = pick(order, ['order_display_id', 'display_id', 'short_order_id']);
      return v != null ? String(v) : null;
    })(),
    externalOutletId: externalOutletId != null ? String(externalOutletId) : null,
    state: STATE[String(rawState || '').toLowerCase()] ?? null,
    rawState: rawState != null ? String(rawState) : null,
    providerSequence: (() => {
      const v = pick(body, ['sequence', 'seq', 'version']);
      const n = Number(v);
      return Number.isInteger(n) ? n : null;
    })(),
    providerEventAt: asDate(pick(body, ['event_time', 'timestamp', 'updated_at', 'created_at'])),
    placedAt: asDate(pick(order, ['order_date_time', 'created_at', 'placed_at'])),
    paymentMode: (() => {
      const v = pick(order, ['payment_mode', 'payment_method', 'mode_of_payment']);
      return v != null ? String(v).slice(0, 40) : null;
    })(),
    cancelReason: (() => {
      const v = pick(body, ['cancellation_reason', 'reason', 'cancel_reason']);
      return v != null ? String(v).slice(0, 300) : null;
    })(),
    items: normalizeItems(order),
    money,
    // Which money fields we could not read. This is what turns an unknown field
    // name into a visible exception rather than a wrong number.
    unreadable: Object.entries(money).filter(([, v]) => v === null).map(([k]) => k),
  };
};

const normalizeItems = (order) => {
  const list = pick(order, ['items', 'order_items', 'dishes', 'line_items']);
  if (!Array.isArray(list)) return [];
  return list.map((raw) => ({
    externalItemId: (() => {
      const v = pick(raw, ['item_id', 'id', 'pos_item_id', 'external_id']);
      return v != null ? String(v) : null;
    })(),
    name: (() => {
      const v = pick(raw, ['name', 'item_name', 'title']);
      return v != null ? String(v).slice(0, 200) : null;
    })(),
    quantity: (() => {
      const n = Number(pick(raw, ['quantity', 'qty', 'count']) ?? 1);
      return Number.isFinite(n) && n > 0 ? n : 1;
    })(),
    unitPrice: amount(pick(raw, ['unit_price', 'price', 'item_price', 'rate'])),
    total: amount(pick(raw, ['total_cost', 'total', 'amount', 'net_amount'])),
    // Zomato variants/modifiers arrive nested under several possible names.
    // Kept raw and un-interpreted: a modifier we map wrongly changes what the
    // kitchen makes, so an unmapped one has to be visible, not approximated.
    modifiersRaw: pick(raw, ['variants', 'modifiers', 'addons', 'variant_groups']) ?? null,
  }));
};

// --- outbound ----------------------------------------------------------------

// Job kind → documented path. Only paths Zomato publishes appear here; the
// bodies are UNSPECIFIED-BODY, built from the job payload our own code created.
const JOB_PATH = Object.freeze({
  ZOMATO_ORDER_CONFIRM: PATHS.orderConfirm,
  ZOMATO_ORDER_REJECT: PATHS.orderReject,
  ZOMATO_ORDER_READY: PATHS.orderReady,
  ZOMATO_ORDER_PICKED_UP: PATHS.orderPickedUp,
  ZOMATO_ORDER_DELIVERED: PATHS.orderDelivered,
  ZOMATO_MENU_PUSH: PATHS.menuAdd,
  ZOMATO_ITEM_STOCK: PATHS.itemStock,
  ZOMATO_MAC_UPDATE: PATHS.macUpdate,
});

export const adapter = {
  key: 'ZOMATO',
  // True in the sense that a wire implementation exists and will run. It is NOT
  // a claim that it has been verified against Zomato — see this file's header
  // and the CONTRACT.PATH_ONLY markers in providers.js.
  operable: true,

  async checkConnection({ credential, config }) {
    const base = baseOf(config);
    if (!base) {
      return { ok: false, detail: 'No Zomato API base is configured. Zomato supplies it with your POS ID.' };
    }
    // Menu-get is the only published read-shaped endpoint, so it is the least
    // invasive way to ask "do these keys work". A write would be a worse probe:
    // a connection test must not change anything at the provider.
    try {
      await providerFetch(joinUrl(base, PATHS.menuGet), {
        method: 'POST',
        headers: authHeaders(credential),
        body: JSON.stringify({ res_id: config?.posId ?? null }),
      });
      return { ok: true, detail: 'Zomato answered the menu-read endpoint.' };
    } catch (err) {
      // A TERMINAL 401/403 is a real answer and a useful one: the credential is
      // wrong. Reported as not-ok with the reason, not thrown, because a failed
      // test is a normal outcome of pressing Test.
      return { ok: false, detail: err instanceof ProviderCallError ? err.message : 'Zomato could not be reached' };
    }
  },

  parseInbound({ headers, body }) {
    const kindHint =
      headers['x-zomato-event'] ||
      headers['x-event-type'] ||
      body?.event ||
      body?.event_type ||
      body?.type;
    return normalizeInbound(kindHint, body);
  },

  async perform({ kind, payload, credential, config }) {
    const path = JOB_PATH[kind];
    if (!path) {
      throw new ProviderCallError(`Zomato adapter has no path for job kind ${kind}`, { kind: 'TERMINAL' });
    }
    const base = baseOf(config);
    if (!base) {
      throw new ProviderCallError('No Zomato API base is configured', { kind: 'TERMINAL' });
    }
    const result = await providerFetch(joinUrl(base, path), {
      method: 'POST',
      headers: authHeaders(credential),
      body: JSON.stringify(payload),
    });
    return {
      externalRef: result.json?.order_id ?? result.json?.id ?? null,
      detail: result.json ?? null,
    };
  },
};

export default adapter;
