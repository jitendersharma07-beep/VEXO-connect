// Provider registry for third-party integrations (LANE providers).
//
// This file is the honest inventory. Every other file in this lane reads its
// capabilities from here, so "Zomato cannot report settlements" is one fact in
// one place rather than a comment in a route and a paragraph in a document that
// drift apart.
//
// The `docs` field on each provider records HOW MUCH of that provider's API is
// publicly specified, verified on 2026-09-24 by fetching the vendors' own pages.
// It is the difference between code we can write correctly and code we would be
// guessing at, and it is the reason two of these four providers ship as
// interfaces with no wire format.
//
// RULE OBSERVED THROUGHOUT: no endpoint in this file came from a blog, a
// scraping vendor or an LLM's recollection. A path is present only if the
// provider publishes it. Where a provider publishes a path but gates the
// request body, the path is here and the body is marked UNSPECIFIED — because a
// half-known contract must fail loudly at build time, not silently at the till.

import { z } from 'zod';

// --- capability vocabulary ---------------------------------------------------

// How well we know a capability's wire contract. This is deliberately not a
// boolean: "we have not built it" and "the provider will not tell us what to
// build" are different problems with different owners, and collapsing them is
// how a project reports itself complete while being unable to ship.
export const CONTRACT = Object.freeze({
  // Provider publishes the full request/response contract; our code implements it.
  SPECIFIED: 'SPECIFIED',
  // Provider publishes the path/existence but gates the schema behind a partner
  // login. We can queue and route, but the body we send is our best reading and
  // must be confirmed against the partner reference before go-live.
  PATH_ONLY: 'PATH_ONLY',
  // Provider publishes nothing usable. We expose the interface and refuse.
  UNSPECIFIED: 'UNSPECIFIED',
  // Provider has no such feature. Not a gap in our build.
  NOT_OFFERED: 'NOT_OFFERED',
});

// --- shared field shapes -----------------------------------------------------

const nonEmpty = (label, max = 200) =>
  z.string().trim().min(1, `${label} is required`).max(max);

// Tally is the only provider reached over a LAN rather than the internet, so it
// is the only one with a host field — and the only one that needs this guard.
// A hostname here that resolves off-LAN is how "do not expose Tally to the
// internet" gets violated from the settings screen rather than from a firewall.
const lanHost = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => !/^https?:\/\//i.test(v), 'enter a host or IP, not a URL');

// --- SWIGGY ------------------------------------------------------------------

// Swiggy publishes NO merchant/POS API documentation. developers.swiggy.com
// exists, renders no API content unauthenticated ("API categories will appear
// here once they are configured"), and gates login behind a single-tenant
// Microsoft Entra org directory — i.e. access is granted through a commercial
// partnership, not a developer signup.
//
// Consequence, stated plainly: there is no correct Swiggy adapter to write. The
// connector below records a mapping and refuses every call. Writing plausible
// endpoints would produce a build that passes its own tests and fails on the
// first real order, which is the exact failure this lane is meant to prevent.
const swiggy = {
  key: 'SWIGGY',
  label: 'Swiggy',
  kind: 'AGGREGATOR',
  docs: {
    status: 'NONE_PUBLIC',
    portal: 'https://developers.swiggy.com/',
    checkedOn: '2026-09-24',
    note: 'Portal exposes no API content without a Swiggy-issued org login (Microsoft Entra, single tenant). No endpoint, auth scheme or payload is publicly specified.',
  },
  // Every capability is UNSPECIFIED on purpose. This is not a to-do list.
  capabilities: {
    menuPush: CONTRACT.UNSPECIFIED,
    itemAvailability: CONTRACT.UNSPECIFIED,
    orderReceive: CONTRACT.UNSPECIFIED,
    orderStatusPush: CONTRACT.UNSPECIFIED,
    cancellation: CONTRACT.UNSPECIFIED,
    settlement: CONTRACT.UNSPECIFIED,
    webhookSignature: CONTRACT.UNSPECIFIED,
  },
  blockedReason:
    'Swiggy publishes no merchant/POS API documentation. Integration requires a Swiggy partnership account on developers.swiggy.com, or connection through a middleware provider that already holds one.',
  // Recorded so the owner can compare routes rather than re-discover them.
  alternatives: [
    'Swiggy POS partnership (developers.swiggy.com org login) — obtained via partner-with-us.swiggy.com and a commercial conversation.',
    'Middleware aggregator that publishes its own POS contract and holds the Swiggy relationship (e.g. UrbanPiper). Changes the integration target from Swiggy to the middleware, and adds a third-party commercial dependency.',
  ],
  // No fields, because there is nothing to ask for. The settings screen renders
  // whatever is declared here, so an empty list is how "we do not know what
  // Swiggy would need" reaches the operator as an absence of boxes rather than
  // as a form that looks fillable and saves nothing.
  credentialFields: [],
  configFields: [],
  credentialSchema: z
    .object({})
    .strict()
    .describe('No credential shape is knowable until Swiggy publishes one.'),
  configSchema: z.object({}).strict(),
};

// --- ZOMATO ------------------------------------------------------------------

// Zomato publishes its integration GUIDES and its endpoint PATHS openly, and
// gates the API reference (request bodies, headers, error codes) behind an
// organisation login. So the paths below are quoted from Zomato's own public
// pages; the bodies are not, and are marked PATH_ONLY.
//
// Inbound authentication is, per Zomato's public prerequisites, a set of HEADERS
// THAT ZOMATO CONFIGURES for your POS ID — supplied by the integrator on the
// onboarding form. There is NO publicly documented HMAC signature. We therefore
// verify a configured shared-secret header in constant time and record on every
// event whether it verified; we do not pretend to a signature scheme Zomato has
// not published.
const ZOMATO_PATHS = Object.freeze({
  menuAdd: '/online-ordering/v3/menu/add',
  menuGet: '/online-ordering/v3/menu/get',
  itemStock: '/online-ordering/v3/menu/item/stock',
  orderConfirm: '/online-ordering/v1/order/confirm',
  orderReject: '/online-ordering/v1/order/reject',
  orderReady: '/online-ordering/v1/order/ready',
  orderPickedUp: '/online-ordering/v1/order/pickedup',
  orderDelivered: '/online-ordering/v1/order/delivered',
  riderAssigned: '/online-ordering/v1/order/assigned',
  contactDetails: '/online-ordering/v1/order/get-contact-details',
  macUpdate: '/online-ordering/v1/mac/update',
  complaintUpdate: '/online-ordering/v1/complaints/update',
});

const zomato = {
  key: 'ZOMATO',
  label: 'Zomato',
  kind: 'AGGREGATOR',
  docs: {
    status: 'PARTNER_GATED_SCHEMA',
    portal: 'https://www.zomato.com/developer/integration/',
    checkedOn: '2026-09-24',
    note: 'Guides, endpoint paths and the critical-feature list are public (docs updated 2026-05-26). The API reference — request/response bodies, headers, error codes — requires an organisation login.',
  },
  paths: ZOMATO_PATHS,
  capabilities: {
    // Inbound: Zomato calls us. We own the receiving end completely, so the
    // pipeline (dedupe, ordering, normalisation, routing to KOT) is ours to get
    // right regardless of the body shape — an unrecognised field becomes a
    // recorded discrepancy, not a dropped order.
    orderReceive: CONTRACT.PATH_ONLY,
    orderStatusPush: CONTRACT.PATH_ONLY,
    menuPush: CONTRACT.PATH_ONLY,
    itemAvailability: CONTRACT.PATH_ONLY,
    cancellation: CONTRACT.PATH_ONLY,
    // Zomato's public documentation contains no settlement or payout report
    // API, and no refunds API — cancellation is handled as merchant-agreed
    // cancellation plus complaints. Recorded as NOT_OFFERED rather than left
    // blank so nobody builds a payout reconciliation against an API that the
    // published surface does not contain.
    settlement: CONTRACT.NOT_OFFERED,
    refunds: CONTRACT.NOT_OFFERED,
    // No HMAC scheme is published. A configured shared-secret header is what
    // the prerequisites describe, so that is what we verify.
    webhookSignature: CONTRACT.PATH_ONLY,
  },
  blockedReason:
    'Request/response schemas require a Zomato organisation login. Go-live additionally requires a signed agreement and Zomato POC configuration; Zomato states an eligibility bar of 50+ onboarded restaurants OR 10,000+ monthly orders, plus 100% parity with their critical feature list, <10 min support TAT and load-test reports.',
  activation: [
    'Vendor Onboarding Form (declares POS webhook URLs and the header names/tokens Zomato will send).',
    'Zomato POC issues a POS ID and the API keys; NDA signed; domains, test-store emails and IPs whitelisted.',
    'Demo videos, product demo, technical architecture document and load-test reports reviewed.',
    'Signed legal agreement, then the POC maps each live restaurant. Per-outlet mapping is a manual request to posintegrations@zomato.com.',
  ],
  credentialFields: [
    { name: 'apiKey', label: 'Zomato API key', type: 'text', required: true, secret: true, help: 'Issued by your Zomato POC. Not available through self-signup.' },
    { name: 'inboundHeaderName', label: 'Inbound auth header name', type: 'text', required: true, help: 'The header name Zomato is configured to send on callbacks, exactly as agreed on the onboarding form.' },
    { name: 'inboundHeaderValue', label: 'Inbound auth header value', type: 'text', required: true, secret: true, help: 'Compared in constant time on every callback. Zomato publishes no signature scheme, so this shared value is the whole of inbound authentication.' },
  ],
  configFields: [
    { name: 'posId', label: 'Zomato POS ID', type: 'text', help: 'Issued by the POC.' },
    { name: 'apiBase', label: 'API base URL', type: 'text', help: 'Leave blank unless your POC gave you a different base.' },
    { name: 'orderActorUserId', label: 'Order actor user ID', type: 'text', help: 'A dedicated non-login service account. Aggregator orders are attributed to it rather than to whichever cashier is on shift.' },
    { name: 'autoAccept', label: 'Accept orders automatically', type: 'boolean', help: 'Off by default. Leaving it off holds every order for someone at the till, so the kitchen is never committed to food it has not seen.' },
  ],
  credentialSchema: z
    .object({
      // "Obtain API keys to access Zomato APIs from your Zomato POC."
      apiKey: nonEmpty('Zomato API key', 400),
      // Zomato is configured to send agreed headers on inbound calls. We store
      // the expected name and value so inbound verification is a comparison
      // against something the operator entered, not a hard-coded guess.
      inboundHeaderName: nonEmpty('inbound auth header name', 120),
      inboundHeaderValue: nonEmpty('inbound auth header value', 400),
    })
    .strict(),
  configSchema: z
    .object({
      // Issued by the Zomato POC, not chosen by us.
      posId: nonEmpty('Zomato POS ID', 80).optional(),
      apiBase: z.string().trim().url().max(300).optional(),
      // Order.openedById is required, and an aggregator order has no cashier.
      // Rather than weaken that column — it is what makes every order in this
      // system attributable — the connection names the account aggregator orders
      // belong to. It should be a dedicated non-login service account: attributing
      // a Zomato order to whichever cashier happens to be on shift puts a sale in
      // their name that they never touched, and audit trails that lie are worse
      // than audit trails that are boring.
      orderActorUserId: nonEmpty('order actor user id', 60).optional(),
      // Accept automatically, or hold every order for a human to accept at the
      // till. Defaults to holding: auto-accepting an order the kitchen has not
      // seen is how a restaurant ends up committed to food it cannot make.
      autoAccept: z.boolean().default(false),
    })
    .strict(),
};

// --- REELO -------------------------------------------------------------------

// Identity resolved before anything was built: the client's loyalty provider is
// REELO — reelo.io, Reelo Technologies Private Limited, an India-focused
// restaurant loyalty/CRM platform. It is NOT "Relo"/reelo.me (relocation
// services), NOT RELO Direct (US corporate relocation) and NOT Reloy (a
// different Indian loyalty company). The confusion is a real one and the wrong
// answer would have pointed this connector at an unrelated company's API.
//
// Reelo publishes a POS integration collection publicly, so these paths and the
// two-step redemption flow are SPECIFIED rather than guessed.
//
// THE ONE THING TO KNOW ABOUT THE 100,000 EXISTING CUSTOMERS: Reelo's published
// POS API has no bulk export, no bulk import and no historical customer export.
// Customer records are created implicitly by bill sync. There is therefore NO
// API by which 100,000 existing customers and balances can be read out. The
// import machinery in this lane consumes a Reelo-PROVIDED export file for that
// reason — and "future bills synchronise" is a separate claim from "history is
// available", which is why they are reported separately.
const REELO_PATHS = Object.freeze({
  // Lookup: balance and redeemable rewards for a phone number.
  customerRewards: '/rewards/customer',
  // Step 1 of redemption: Reelo sends the customer an OTP.
  authenticate: '/points/authenticate',
  // Step 2: redeem, carrying the OTP the customer read out.
  redeemCoupon: '/redeem/coupon',
  redeemPoints: '/redeem/points',
  // Bill sync. Also the only documented way a customer comes into existence.
  billCustomer: '/bill/customer',
  updateBill: '/update-bill',
  // Reversal for a voided bill — the counterpart to a POS void.
  revertPoints: '/revert-points',
  saleReturn: '/sale-return',
  menu: '/menu',
  paymentTypes: '/payment-types',
});

const reelo = {
  key: 'REELO',
  label: 'Reelo',
  kind: 'LOYALTY',
  docs: {
    status: 'PUBLIC',
    portal: 'https://documenter.getpostman.com/view/14784368/TzzBov5g',
    checkedOn: '2026-09-24',
    note: 'Public POS integration collection. Paths and flow are specified. The authentication scheme is only partially specified — identity travels in the body as merchant_id + customer_key with vendor_id in the path, and one request additionally shows an auth-key header; confirm with Reelo before go-live.',
  },
  paths: REELO_PATHS,
  capabilities: {
    customerLookup: CONTRACT.SPECIFIED,
    balanceLookup: CONTRACT.SPECIFIED,
    billSync: CONTRACT.SPECIFIED,
    // Two-step, and the second step needs an OTP the CUSTOMER receives. This is
    // a till-workflow fact, not just an API fact: the cashier has to be able to
    // ask for and enter a code, so any UI that redeems without an OTP prompt
    // cannot work against Reelo.
    redeem: CONTRACT.SPECIFIED,
    reversal: CONTRACT.SPECIFIED,
    // Documented as sale-return and bill-edit, both present.
    saleReturn: CONTRACT.SPECIFIED,
    // Not in the published collection. Asserting these would invent an API.
    bulkExport: CONTRACT.NOT_OFFERED,
    bulkImport: CONTRACT.NOT_OFFERED,
    webhooks: CONTRACT.NOT_OFFERED,
  },
  blockedReason:
    'Needs the client\'s own Reelo credentials (vendor_id, per-branch merchant_id and customer_key) and written confirmation of the auth header scheme. Historical migration of the existing ~100,000 customers needs a Reelo-side export, which is a support/commercial request — their POS API cannot produce it.',
  credentialFields: [
    { name: 'vendorId', label: 'Reelo vendor ID', type: 'text', required: true, help: 'Issued by Reelo to the POS vendor. Travels in the URL path.' },
    { name: 'merchantId', label: 'Reelo merchant ID', type: 'text', required: true, help: 'Reelo-generated, per branch. Held here as the company default; per-branch values live on the outlet mapping.' },
    { name: 'customerKey', label: 'Reelo customer key', type: 'text', required: true, secret: true },
    { name: 'authKey', label: 'Auth-key header', type: 'text', secret: true, help: 'Optional. Only one documented Reelo request carries this header — leave it blank if your account does not use one, and the header is not sent.' },
  ],
  configFields: [
    { name: 'apiBase', label: 'API base URL', type: 'text', help: 'Leave blank to use the documented base.' },
    {
      name: 'redemptionEnabled',
      label: 'Allow points to be spent at the till',
      type: 'boolean',
      help: 'Off by default. With it off, balances are read and bills are synced but no customer’s points can be moved — the safer first step against a live loyalty programme.',
    },
  ],
  credentialSchema: z
    .object({
      // Path segment, one per POS vendor. Reelo issues it.
      vendorId: nonEmpty('Reelo vendor ID', 120),
      // Reelo-generated, per branch. Held here as the company-level default;
      // per-branch values live on IntegrationOutlet.
      merchantId: nonEmpty('Reelo merchant ID', 120),
      // POS-provided, per branch, paired with merchantId.
      customerKey: nonEmpty('Reelo customer key', 200),
      // Only one documented request carries this. Optional so a deployment whose
      // Reelo account does not use it is not forced to invent a value — the
      // adapter sends the header only when it is present.
      authKey: z.string().trim().min(1).max(400).optional(),
    })
    .strict(),
  configSchema: z
    .object({
      apiBase: z.string().trim().url().max(300).optional(),
      // Reelo is the authority on points. This flag exists so the owner can run
      // bill sync with redemption still disabled — reading balances and posting
      // bills is far lower risk than moving a real customer's points.
      redemptionEnabled: z.boolean().default(false),
    })
    .strict(),
};

// --- TALLY -------------------------------------------------------------------

// TallyPrime (current release 7.1, 2026-05-20) integrates over HTTP on its own
// machine: XML on every release, native JSON from 7.0. It is LAN-only by design
// — the documented request carries no authentication field at all — so the
// connector treats Tally as an on-premise endpoint reached from inside the shop
// network and never as a public URL.
//
// Two facts from Tally's documentation shape this connector more than anything
// else:
//  1. Dependent masters (ledgers, groups, stock items) must already exist, with
//     exactly the right names. Hence AccountingLedgerMap: the operator states
//     the mapping once, and a posting that references an unmapped ledger is
//     held in the error queue rather than sent hopefully.
//  2. Tally publishes no idempotency or duplicate-prevention mechanism for
//     imports. That is not an omission we can paper over: duplicate suppression
//     has to be ours, which is what the unique key on AccountingPosting is for.
const tally = {
  key: 'TALLY',
  label: 'TallyPrime',
  kind: 'ACCOUNTING',
  docs: {
    status: 'PUBLIC',
    portal: 'https://help.tallysolutions.com/xml-integration/',
    checkedOn: '2026-09-24',
    note: 'Official public documentation: XML (all releases) and native JSON (7.0+) over HTTP, default port 9000, company must be loaded. Envelope, import shape and sales-voucher tags are documented; GST tags, cost centres, an enumerated voucher-type list and any idempotency mechanism are not.',
  },
  capabilities: {
    salesVoucher: CONTRACT.SPECIFIED,
    // Documented as a voucher type that exists in Tally, but with no official
    // sample XML. Tally's own guidance is to create the entry by hand and
    // export it to learn the tags — so the shape must be confirmed against the
    // client's actual company, whose voucher-type names are theirs, not ours.
    creditNote: CONTRACT.PATH_ONLY,
    receipt: CONTRACT.PATH_ONLY,
    purchase: CONTRACT.PATH_ONLY,
    ledgerMasters: CONTRACT.SPECIFIED,
    // Tally answers with STATUS 1/0 on import. That is an acknowledgement, and
    // we store it; it is not a duplicate check.
    acknowledgement: CONTRACT.SPECIFIED,
    idempotency: CONTRACT.NOT_OFFERED,
    // No GSTIN or COSTCENTRE tag appears in the official sample XML. Both are
    // real in Tally; their wire tags must be derived from a real export.
    gstBreakup: CONTRACT.PATH_ONLY,
    costCentre: CONTRACT.PATH_ONLY,
  },
  blockedReason:
    'Needs a reachable TallyPrime instance with a company loaded, the exact company name, financial-year dates, and the client\'s own ledger/voucher-type names. Credit-note, receipt, purchase, GST and cost-centre tags must be confirmed from an XML export of a real voucher in the client\'s company before those posting types are enabled.',
  credentialFields: [
    {
      name: 'host',
      label: 'Tally machine on the shop network',
      type: 'text',
      required: true,
      help: 'A host name or IP, never a URL. Tally’s documented request carries no authentication at all, so this endpoint must stay inside the shop network — a scheme here is refused for that reason.',
    },
    { name: 'port', label: 'Port', type: 'number', help: 'Tally’s default is 9000.' },
  ],
  configFields: [
    { name: 'companyName', label: 'Tally company name', type: 'text', required: true, help: 'Must match the loaded company exactly, character for character.' },
    { name: 'financialYearFrom', label: 'Financial year from', type: 'date', required: true },
    { name: 'financialYearTo', label: 'Financial year to', type: 'date', required: true },
    {
      name: 'postFrom',
      label: 'Post bills dated on or after',
      type: 'date',
      required: true,
      help: 'Your accountant chooses this date. Nothing in this system can: too early posts into books that are already closed and signed, too late posts nothing and looks broken.',
    },
    { name: 'wireFormat', label: 'Wire format', type: 'select', options: ['XML', 'JSON'], help: 'XML works on every release. JSON only from TallyPrime 7.0.' },
    { name: 'salesVoucherType', label: 'Sales voucher type', type: 'text', help: 'Voucher type names are per-company strings in Tally, not a fixed list.' },
    { name: 'creditNoteVoucherType', label: 'Credit note voucher type', type: 'text' },
    { name: 'receiptVoucherType', label: 'Receipt voucher type', type: 'text' },
    {
      name: 'postReceipts',
      label: 'Post receipts',
      type: 'boolean',
      help: 'Off by default. Tally documents no sample XML for this voucher type, so its tags must be confirmed against an export from your own company first.',
    },
    { name: 'postCreditNotes', label: 'Post credit notes', type: 'boolean', help: 'Off by default, for the same reason as receipts.' },
  ],
  credentialSchema: z
    .object({
      // Not a secret in Tally's model — there is no auth — but it is deployment
      // topology, and topology is exactly what an attacker wants from a dump.
      // Sealed with everything else rather than sitting in a plaintext column.
      host: lanHost,
      port: z.coerce.number().int().min(1).max(65535).default(9000),
    })
    .strict(),
  configSchema: z
    .object({
      // SVCURRENTCOMPANY. Must match the loaded company exactly.
      companyName: nonEmpty('Tally company name', 200),
      // SVFROMDATE / SVTODATE. Stored as yyyy-mm-dd and formatted to Tally's
      // yyyymmdd at the wire, so an operator never types a wire format.
      financialYearFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
      financialYearTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
      // XML works everywhere; JSON only from 7.0. Default to the one that
      // cannot be wrong.
      wireFormat: z.enum(['XML', 'JSON']).default('XML'),
      // Voucher type names are per-company strings in Tally, never a fixed
      // vocabulary, so they are configuration rather than constants.
      salesVoucherType: nonEmpty('sales voucher type', 120).default('Sales'),
      creditNoteVoucherType: nonEmpty('credit note voucher type', 120).default('Credit Note'),
      receiptVoucherType: nonEmpty('receipt voucher type', 120).default('Receipt'),
      // The first business date whose bills may post. Required, with no default,
      // because both defaults are wrong in opposite directions: switching Tally
      // on either posts nothing and looks broken, or posts every bill since the
      // shop opened into books an accountant has already closed and signed. The
      // client's accountant chooses this date; nothing in this codebase can.
      postFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
      // Receipts and credit notes are PATH_ONLY (see capabilities above) and are
      // the two posting types whose tags have not been confirmed against a real
      // export from the client's company. Default off so enabling Tally starts by
      // posting only the voucher type Tally itself documents.
      postReceipts: z.boolean().default(false),
      postCreditNotes: z.boolean().default(false),
    })
    .strict()
    .refine((v) => v.financialYearFrom <= v.financialYearTo, {
      message: 'financial year cannot end before it starts',
      path: ['financialYearTo'],
    })
    .refine((v) => v.postFrom >= v.financialYearFrom, {
      message: 'the posting start date is before the financial year it would post into',
      path: ['postFrom'],
    }),
};

// --- registry ----------------------------------------------------------------

export const PROVIDERS = Object.freeze({ SWIGGY: swiggy, ZOMATO: zomato, REELO: reelo, TALLY: tally });

export const PROVIDER_KEYS = Object.freeze(Object.keys(PROVIDERS));

export const providerDef = (key) => PROVIDERS[key] || null;

// A provider is operable when there is at least one capability we know how to
// ADDRESS — a published path, whether or not the body is confirmed. That is a
// deliberately lower bar than "fully specified", and the line is drawn there
// because the two sides of it need different things from the reader:
//
//   inoperable (Swiggy)  nothing is published, so there is no endpoint to send
//                        to and no credential shape to collect. Configuring it
//                        is meaningless and the screen must refuse.
//   operable  (Zomato)   the endpoints are published; the request bodies need
//                        the client's own POC reference. Mapping outlets,
//                        storing the agreed inbound header and RECEIVING order
//                        callbacks are all real, working, testable work — and
//                        the inbound half is the half that functions today.
//
// Drawing the line at SPECIFIED instead would make Zomato unconfigurable, which
// does not make the integration safer: it makes the callback endpoint
// unreachable and hides the one direction that works. What keeps this honest is
// that blockedReason travels with every provider through providerSummary(), so
// an operable provider still shows the operator exactly what remains unproven.
export const isOperable = (key) => {
  const def = providerDef(key);
  if (!def) return false;
  return Object.values(def.capabilities).some(
    (c) => c === CONTRACT.SPECIFIED || c === CONTRACT.PATH_ONLY,
  );
};

// What the portal shows, and what docs/INTEGRATION-VERIFICATION.md is generated
// from, so the screen and the document cannot disagree.
export const providerSummary = (key) => {
  const def = providerDef(key);
  if (!def) return null;
  return {
    key: def.key,
    label: def.label,
    kind: def.kind,
    docs: def.docs,
    capabilities: def.capabilities,
    operable: isOperable(key),
    blockedReason: def.blockedReason,
    activation: def.activation || null,
    alternatives: def.alternatives || null,
    // The settings form is generated from these rather than written out again in
    // React. Two hand-maintained lists of the same fields drift, and the way
    // they drift is that the form stops offering a field the schema still
    // requires — so saving fails with a validation error about something the
    // operator was never shown a box for.
    credentialFields: def.credentialFields ?? [],
    configFields: def.configFields ?? [],
  };
};
