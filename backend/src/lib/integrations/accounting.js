// POS → accounting postings (LANE providers).
//
// Turns what VEXO already decided — a billed order, a payment taken, a refund
// given — into a voucher Tally will accept. Nothing here recomputes money.
//
// That last sentence is the whole design. recomputeOrder() in lib/orders.js
// computed the taxable value, the tax and the total, an invoice was printed from
// those numbers, and a customer paid them. If this file derived tax a second way
// there would be two answers to what the bill was, and the one in the books
// would be the one the tax authority reads. So every figure below is a sum of
// stored columns, in paise, and the only arithmetic is addition and the
// CGST/SGST halving that GST itself defines.
//
// DIRECTION AND OWNERSHIP. One way, VEXO → Tally, always. VEXO's own ledger is
// authoritative for the transactions it originates; Tally is authoritative for
// the books. Nothing in this lane reads a balance back from Tally and nothing
// lets Tally alter a POS order — see adapters/tally.js parseInbound, which
// refuses inbound calls outright.
//
// WHAT IS NOT DERIVED. Ledger names. Every one of them is a string in the
// client's own chart of accounts, and guessing them is how an integration posts
// six months of sales into "Suspense". An unmapped ledger therefore does not
// produce a best-effort voucher: it produces a PENDING posting whose lastError
// names the missing key, visible on the integrations screen, and no queued job.

import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { toPaise, toRupees } from '../money.js';
import { enqueue } from './queue.js';
import { payloadHash } from './index.js';

// --- ledger map --------------------------------------------------------------

// The kinds an operator has to fill in, and what each one is for. Used by the
// settings screen to render the mapping form and by requiredLedgers() below to
// say precisely what is missing.
export const LEDGER_KINDS = Object.freeze({
  SALES_BY_TAX: 'Sales ledger for each GST rate you charge',
  TAX_OUTPUT: 'Output duty ledgers — CGST, SGST, and IGST if you use it',
  ROUNDING: 'Where rounding differences go',
  PAYMENT_METHOD: 'Cash and bank ledgers money is received into',
  PARTY_DEFAULT: 'The party a counter sale is billed to',
  COST_CENTRE: 'Optional cost centre per store',
});

export const loadLedgerMap = async (client, { companyId, connectionId }) => {
  const rows = await client.accountingLedgerMap.findMany({ where: { companyId, connectionId } });
  const byKind = new Map();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, new Map());
    byKind.get(row.kind).set(row.key, row);
  }
  return {
    // Returns the row, not just the name, because COST_CENTRE rides along on it.
    get: (kind, key) => byKind.get(kind)?.get(String(key)) ?? null,
    name: (kind, key) => byKind.get(kind)?.get(String(key))?.ledgerName ?? null,
    has: (kind, key) => Boolean(byKind.get(kind)?.get(String(key))),
    all: rows,
  };
};

// --- tax breakup -------------------------------------------------------------

// Grouped by the rate the LINE was taxed at, matching buildReceipt() in
// lib/orders.js so the voucher and the printed bill group identically. Taxable
// value is the line subtotal less its share of the order discount, which is the
// figure recomputeOrder already apportioned — not subtotal, and not total.
export const taxBreakup = (order) => {
  const groups = new Map();
  for (const item of order.items ?? []) {
    if (item.status !== 'ACTIVE') continue;
    // A zero-rated or untaxed line still has to reach a sales ledger, or the
    // voucher will not balance. '0' is a real key here, not a missing one.
    const percent = item.taxRatePercent === null || item.taxRatePercent === undefined
      ? '0'
      : String(Number(item.taxRatePercent));
    const current = groups.get(percent) ?? { percent, taxablePaise: 0, taxPaise: 0 };
    current.taxablePaise += toPaise(item.lineSubtotal) - toPaise(item.discountShare);
    current.taxPaise += toPaise(item.lineTax);
    groups.set(percent, current);
  }
  return [...groups.values()].sort((a, b) => Number(a.percent) - Number(b.percent));
};

// Intra-state, split in half. Stated as an assumption rather than a derivation
// because it IS one: a restaurant serves, and delivers from, the state it stands
// in, so place of supply is the supplier's state (CGST + SGST) for every bill
// this POS issues — including aggregator orders, which are still served from
// that kitchen. Inter-state supply would be IGST at the full rate, and this POS
// has no code path that produces one. If the client ever does supply
// inter-state, this function is where it must be revisited, deliberately, with
// their CA — not inferred from a GSTIN.
//
// The halving is exact by construction: the paise are split with the odd paisa
// going to CGST, so CGST + SGST is always the stored lineTax sum and the voucher
// balances to the invoice total.
export const splitGst = (taxPaise) => {
  const cgst = Math.ceil(taxPaise / 2);
  return { cgstPaise: cgst, sgstPaise: taxPaise - cgst };
};

// --- what an order needs mapped ----------------------------------------------

// Answers "what must the operator still fill in before this bill can post".
// Returned as keys rather than prose so the screen can link straight to the
// field, and so the same list drives both the settings form and the error on a
// held posting.
export const requiredLedgers = (order) => {
  const needs = [{ kind: 'PARTY_DEFAULT', key: 'DEFAULT' }];
  for (const group of taxBreakup(order)) {
    needs.push({ kind: 'SALES_BY_TAX', key: group.percent });
    if (group.taxPaise > 0) {
      needs.push({ kind: 'TAX_OUTPUT', key: 'CGST' });
      needs.push({ kind: 'TAX_OUTPUT', key: 'SGST' });
    }
  }
  // De-duplicated: two 5% lines need one sales ledger, not two.
  const seen = new Set();
  return needs.filter((n) => {
    const id = `${n.kind}:${n.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const missingFrom = (ledgers, needs) => needs.filter((n) => !ledgers.has(n.kind, n.key));

const describeMissing = (missing) =>
  `No Tally ledger is mapped for: ${missing.map((m) => `${m.kind} "${m.key}"`).join(', ')}. Map them on the integration screen and retry.`;

// --- payload builders --------------------------------------------------------

// A sales voucher, as the argument object adapters/tally.js buildSalesVoucher
// expects. The party is debited the invoice total; sales, tax and rounding are
// credited. Amounts are rupees at this boundary because that is what the voucher
// carries; every sum that produced them was in paise.
export const buildSalesPayload = ({ order, ledgers, config }) => {
  const groups = taxBreakup(order);
  const lines = [];
  let creditedPaise = 0;

  for (const group of groups) {
    if (group.taxablePaise !== 0) {
      lines.push({
        ledgerName: ledgers.name('SALES_BY_TAX', group.percent),
        amount: toRupees(group.taxablePaise),
      });
      creditedPaise += group.taxablePaise;
    }
  }

  const totalTaxPaise = groups.reduce((sum, g) => sum + g.taxPaise, 0);
  if (totalTaxPaise > 0) {
    const { cgstPaise, sgstPaise } = splitGst(totalTaxPaise);
    lines.push({ ledgerName: ledgers.name('TAX_OUTPUT', 'CGST'), amount: toRupees(cgstPaise) });
    lines.push({ ledgerName: ledgers.name('TAX_OUTPUT', 'SGST'), amount: toRupees(sgstPaise) });
    creditedPaise += cgstPaise + sgstPaise;
  }

  // Whatever the credits do not account for. In this product it should be zero —
  // total is subtotal − discount + tax by construction — so a non-zero value
  // here means a stored column disagrees with the stored total, and posting a
  // voucher that silently fails to balance would hide it. It goes to the
  // rounding ledger when one is mapped, and holds the posting when it is not.
  const totalPaise = toPaise(order.total);
  const residualPaise = totalPaise - creditedPaise;
  if (residualPaise !== 0) {
    lines.push({
      ledgerName: ledgers.name('ROUNDING', 'ROUNDING'),
      amount: toRupees(residualPaise),
    });
  }

  return {
    payload: {
      date: order.billedAt,
      voucherNumber: order.invoiceNumber,
      narration: `VEXO Connect ${order.channel === 'AGGREGATOR' ? `${order.channelProvider} order` : 'counter sale'} ${order.invoiceNumber}`,
      reference: order.invoiceNumber,
      partyLedgerName: ledgers.name('PARTY_DEFAULT', 'DEFAULT'),
      partyAmount: toRupees(totalPaise),
      lines,
    },
    // Reported separately so the caller can hold the posting with a precise
    // reason instead of sending a voucher with a null ledger name in it.
    needsRounding: residualPaise !== 0 && !ledgers.has('ROUNDING', 'ROUNDING'),
    residualPaise,
    amount: toRupees(totalPaise),
    voucherType: config.salesVoucherType,
  };
};

export const buildReceiptPayload = ({ order, payment, ledgers, config }) => ({
  payload: {
    date: payment.createdAt,
    // Tally accepts a receipt with our own number; scoping it to the payment id
    // rather than the invoice is what keeps a split bill's two receipts distinct.
    voucherNumber: `${order.invoiceNumber}/R${payment.id.slice(-6)}`,
    narration: `Receipt against ${order.invoiceNumber} (${payment.method})`,
    partyLedgerName: ledgers.name('PARTY_DEFAULT', 'DEFAULT'),
    depositLedgerName: ledgers.name('PAYMENT_METHOD', payment.method),
    amount: toRupees(toPaise(payment.amount)),
    // Settles the bill reference the sales voucher opened. Without this the
    // party ledger accumulates an unmatched debit and a credit for every sale.
    againstRef: order.invoiceNumber,
  },
  amount: toRupees(toPaise(payment.amount)),
  voucherType: config.receiptVoucherType,
});

// A credit note reverses part or all of a sale. The tax is apportioned in the
// same ratio the original bill carried rather than recomputed from the refunded
// amount: a partial refund of a mixed-rate bill has no single rate, and inventing
// one would misstate output tax. Proportional apportionment of the stored figures
// is the only answer that sums back to the original voucher.
export const buildCreditNotePayload = ({ order, refund, ledgers, config }) => {
  const totalPaise = toPaise(order.total);
  const refundPaise = toPaise(refund.amount);
  const groups = taxBreakup(order);
  const lines = [];
  let debitedPaise = 0;

  // Proportion applied to each component, with the last line absorbing the
  // remainder so the voucher balances to the refunded amount exactly.
  const share = (amountPaise) => (totalPaise === 0 ? 0 : Math.round((amountPaise * refundPaise) / totalPaise));

  for (const group of groups) {
    const portion = share(group.taxablePaise);
    if (portion !== 0) {
      lines.push({ ledgerName: ledgers.name('SALES_BY_TAX', group.percent), amount: toRupees(portion) });
      debitedPaise += portion;
    }
  }

  const totalTaxPaise = groups.reduce((sum, g) => sum + g.taxPaise, 0);
  if (totalTaxPaise > 0) {
    const taxPortion = share(totalTaxPaise);
    const { cgstPaise, sgstPaise } = splitGst(taxPortion);
    lines.push({ ledgerName: ledgers.name('TAX_OUTPUT', 'CGST'), amount: toRupees(cgstPaise) });
    lines.push({ ledgerName: ledgers.name('TAX_OUTPUT', 'SGST'), amount: toRupees(sgstPaise) });
    debitedPaise += cgstPaise + sgstPaise;
  }

  const residualPaise = refundPaise - debitedPaise;
  if (residualPaise !== 0) {
    lines.push({ ledgerName: ledgers.name('ROUNDING', 'ROUNDING'), amount: toRupees(residualPaise) });
  }

  return {
    payload: {
      date: refund.settledAt ?? refund.createdAt,
      voucherNumber: `${order.invoiceNumber}/CN${refund.id.slice(-6)}`,
      narration: `Credit note against ${order.invoiceNumber}: ${refund.reason}`.slice(0, 500),
      partyLedgerName: ledgers.name('PARTY_DEFAULT', 'DEFAULT'),
      partyAmount: toRupees(refundPaise),
      lines,
      againstRef: order.invoiceNumber,
    },
    needsRounding: residualPaise !== 0 && !ledgers.has('ROUNDING', 'ROUNDING'),
    amount: toRupees(refundPaise),
    voucherType: config.creditNoteVoucherType,
  };
};

// --- posting -----------------------------------------------------------------

// The enabled, credentialled Tally connection for a tenant, or null. Read fresh
// each time rather than cached: an operator switching the integration off must
// stop new postings, not the next process restart.
const tallyConnection = (companyId) =>
  prisma.integrationConnection.findFirst({
    where: { companyId, provider: 'TALLY', enabled: true, credentialCiphertext: { not: null } },
  });

const businessDate = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Records a posting and, when it is complete, queues its delivery. Both in one
// transaction, so a job never exists without the row that explains it.
//
// `docType` + `sourceType` + `sourceId` is unique per connection, which is what
// makes this safe to call more than once for the same document: the second call
// updates the held row or does nothing, it does not post a second voucher.
const upsertPosting = async ({
  connection,
  docType,
  sourceType,
  sourceId,
  branchId,
  voucherType,
  voucherNumber,
  voucherDate,
  amount,
  payload,
  jobKind,
  blockedReason,
}) =>
  prisma.$transaction(async (tx) => {
    const hash = payloadHash(payload ?? {});
    const existing = await tx.accountingPosting.findUnique({
      where: {
        connectionId_sourceType_sourceId_docType: {
          connectionId: connection.id,
          sourceType,
          sourceId,
          docType,
        },
      },
    });

    // Already delivered. Nothing may touch it again — not a retry, not a sweep,
    // not an operator pressing the button twice. This is the duplicate-voucher
    // guard, and it is a read of state rather than a hope about call counts.
    if (existing && ['SENT', 'ACKNOWLEDGED'].includes(existing.status)) {
      return { posting: existing, queued: false, reason: 'already posted' };
    }

    const posting = await tx.accountingPosting.upsert({
      where: {
        connectionId_sourceType_sourceId_docType: {
          connectionId: connection.id,
          sourceType,
          sourceId,
          docType,
        },
      },
      create: {
        companyId: connection.companyId,
        connectionId: connection.id,
        branchId: branchId ?? null,
        docType,
        sourceType,
        sourceId,
        voucherType,
        voucherNumber,
        voucherDate,
        amount,
        payloadHash: hash,
        status: blockedReason ? 'PENDING' : 'QUEUED',
        lastError: blockedReason ?? null,
      },
      update: {
        // The payload is rebuilt from current ledger mappings on every attempt,
        // which is the point: a posting held because a ledger was unmapped must
        // pick up the mapping when the operator supplies it.
        payloadHash: hash,
        voucherType,
        voucherNumber,
        amount,
        status: blockedReason ? 'PENDING' : 'QUEUED',
        lastError: blockedReason ?? null,
      },
    });

    if (blockedReason) return { posting, queued: false, reason: blockedReason };

    await enqueue(tx, {
      companyId: connection.companyId,
      connectionId: connection.id,
      kind: jobKind,
      payload: { ...payload, postingId: posting.id },
      dedupe: [docType, sourceType, sourceId],
    });

    return { posting, queued: true, reason: null };
  });

// Every public entry point below contains its own failures. An accounting
// integration must not be able to fail a sale: the customer has paid, the
// invoice is printed, and a misconfigured ledger map is not a reason to refuse
// the bill. Called AFTER the billing transaction commits, never inside it — a
// swallowed Prisma error inside a transaction leaves it aborted, so containment
// and enrolment in someone else's transaction cannot both be had.
const contained = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, label }, 'accounting posting could not be recorded');
    return { posting: null, queued: false, reason: String(err?.message ?? err) };
  }
};

export const postOrder = (order) =>
  contained('sales', async () => {
    const connection = await tallyConnection(order.companyId);
    if (!connection) return { posting: null, queued: false, reason: 'no Tally connection' };
    const config = connection.config ?? {};
    if (!order.invoiceNumber || !order.billedAt) {
      return { posting: null, queued: false, reason: 'order is not billed' };
    }
    if (!config.postFrom || businessDate(order.billedAt) < config.postFrom) {
      return { posting: null, queued: false, reason: 'before the configured posting start date' };
    }

    const ledgers = await loadLedgerMap(prisma, {
      companyId: order.companyId,
      connectionId: connection.id,
    });
    const built = buildSalesPayload({ order, ledgers, config });
    const missing = missingFrom(ledgers, requiredLedgers(order));
    const blockedReason = missing.length
      ? describeMissing(missing)
      : built.needsRounding
        ? `This bill does not balance to its line values by ${built.residualPaise} paise and no rounding ledger is mapped.`
        : null;

    return upsertPosting({
      connection,
      docType: 'SALES',
      sourceType: 'ORDER',
      sourceId: order.id,
      branchId: order.branchId,
      voucherType: built.voucherType,
      voucherNumber: order.invoiceNumber,
      voucherDate: order.billedAt,
      amount: built.amount,
      payload: built.payload,
      jobKind: 'TALLY_SALES',
      blockedReason,
    });
  });

export const postPayment = (order, payment) =>
  contained('receipt', async () => {
    const connection = await tallyConnection(order.companyId);
    if (!connection) return { posting: null, queued: false, reason: 'no Tally connection' };
    const config = connection.config ?? {};
    if (!config.postReceipts) return { posting: null, queued: false, reason: 'receipt posting is switched off' };
    if (!order.invoiceNumber) return { posting: null, queued: false, reason: 'order is not billed' };
    if (!config.postFrom || businessDate(payment.createdAt) < config.postFrom) {
      return { posting: null, queued: false, reason: 'before the configured posting start date' };
    }

    const ledgers = await loadLedgerMap(prisma, {
      companyId: order.companyId,
      connectionId: connection.id,
    });
    const built = buildReceiptPayload({ order, payment, ledgers, config });
    const missing = missingFrom(ledgers, [
      { kind: 'PARTY_DEFAULT', key: 'DEFAULT' },
      { kind: 'PAYMENT_METHOD', key: payment.method },
    ]);

    return upsertPosting({
      connection,
      docType: 'RECEIPT',
      sourceType: 'PAYMENT',
      sourceId: payment.id,
      branchId: payment.branchId,
      voucherType: built.voucherType,
      voucherNumber: built.payload.voucherNumber,
      voucherDate: payment.createdAt,
      amount: built.amount,
      payload: built.payload,
      jobKind: 'TALLY_RECEIPT',
      blockedReason: missing.length ? describeMissing(missing) : null,
    });
  });

export const postRefund = (order, refund) =>
  contained('credit note', async () => {
    const connection = await tallyConnection(order.companyId);
    if (!connection) return { posting: null, queued: false, reason: 'no Tally connection' };
    const config = connection.config ?? {};
    if (!config.postCreditNotes) {
      return { posting: null, queued: false, reason: 'credit note posting is switched off' };
    }
    // A gateway refund that the provider has not paid out yet is not money
    // returned, and posting a credit note for it would overstate the reversal in
    // the books. Waits for settlement, which arrives as a second call here.
    if (refund.status !== 'SUCCEEDED') {
      return { posting: null, queued: false, reason: `refund is ${refund.status}, not settled` };
    }
    if (!order.invoiceNumber) return { posting: null, queued: false, reason: 'order is not billed' };

    const ledgers = await loadLedgerMap(prisma, {
      companyId: order.companyId,
      connectionId: connection.id,
    });
    const built = buildCreditNotePayload({ order, refund, ledgers, config });
    const missing = missingFrom(ledgers, requiredLedgers(order));

    return upsertPosting({
      connection,
      docType: 'CREDIT_NOTE',
      sourceType: 'REFUND',
      sourceId: refund.id,
      branchId: order.branchId,
      voucherType: built.voucherType,
      voucherNumber: built.payload.voucherNumber,
      voucherDate: refund.settledAt ?? refund.createdAt,
      amount: built.amount,
      payload: built.payload,
      jobKind: 'TALLY_CREDIT_NOTE',
      blockedReason: missing.length
        ? describeMissing(missing)
        : built.needsRounding
          ? 'This credit note does not apportion evenly and no rounding ledger is mapped.'
          : null,
    });
  });

// --- the backstop ------------------------------------------------------------

// Finds bills that should have posted and have not, and posts them.
//
// This exists because the after-commit call is an optimisation, not a guarantee.
// A process restarted between the commit and the call, a Tally connection enabled
// after a day of trading, a posting held for a ledger that has since been mapped
// — all three leave a correct bill with no voucher, and the operator cannot be
// expected to find them by eye. Reconciliation by construction: the sweep asks
// the books' question ("which sales have no voucher"), not the queue's.
export const sweepUnposted = async ({ companyId, limit = 200 }) => {
  const connection = await tallyConnection(companyId);
  if (!connection) return { swept: 0, queued: 0, held: 0, reason: 'no Tally connection' };
  const config = connection.config ?? {};
  if (!config.postFrom) return { swept: 0, queued: 0, held: 0, reason: 'no posting start date configured' };

  // Two queries rather than a relation filter: AccountingPosting names its
  // subject by (sourceType, sourceId) strings, not a foreign key, so that it can
  // hold a payment, a refund and an order without three nullable columns. The
  // cost is that "orders with no posting" is not expressible as one Prisma
  // where-clause, and pretending otherwise would be a relation that does not
  // exist.
  const candidates = await prisma.order.findMany({
    where: {
      companyId,
      invoiceNumber: { not: null },
      billedAt: { gte: new Date(`${config.postFrom}T00:00:00.000Z`) },
      status: { in: ['BILLED', 'PAID'] },
    },
    orderBy: { billedAt: 'asc' },
    take: limit,
    include: { items: true },
  });
  if (!candidates.length) return { swept: 0, queued: 0, held: 0, reason: null };

  // A posting that is SENT or ACKNOWLEDGED is done. PENDING, QUEUED, FAILED and
  // DEAD are all worth rebuilding — a row held for an unmapped ledger must pick
  // up the mapping once the operator supplies it.
  const done = await prisma.accountingPosting.findMany({
    where: {
      connectionId: connection.id,
      docType: 'SALES',
      sourceType: 'ORDER',
      sourceId: { in: candidates.map((o) => o.id) },
      status: { in: ['SENT', 'ACKNOWLEDGED'] },
    },
    select: { sourceId: true },
  });
  const finished = new Set(done.map((p) => p.sourceId));
  const orders = candidates.filter((o) => !finished.has(o.id));

  let queued = 0;
  let held = 0;
  for (const order of orders) {
    const result = await postOrder(order);
    if (result.queued) queued += 1;
    else held += 1;
  }
  return { swept: orders.length, queued, held, reason: null };
};
