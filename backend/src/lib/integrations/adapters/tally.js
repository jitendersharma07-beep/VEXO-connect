// TallyPrime accounting adapter (LANE providers).
//
// Built from Tally's own public documentation (checked 2026-09-24, TallyPrime
// release 7.1): XML over HTTP on every release, native JSON from 7.0, default
// port 9000, a company must be LOADED in Tally for any request to work.
//
// Three documented facts drive every design decision in this file.
//
// 1. TALLY HAS NO AUTHENTICATION. The documented request format contains no
//    credential field of any kind. Anything that can reach port 9000 can write
//    vouchers into the client's books. So the settings screen is made incapable
//    of pointing at a public host, AND the host is resolved and re-checked
//    immediately before every call — see lanHost.js for why the first of those
//    alone is not enough.
//
// 2. TALLY HAS NO IDEMPOTENCY. Its documentation publishes no duplicate-detection
//    mechanism for imports; send the same sales voucher twice and the client has
//    two sales.
//
//    The unique index on AccountingPosting(connectionId, sourceType, sourceId,
//    docType) stops us creating a second POSTING. It cannot stop a second SEND of
//    the one posting, because a retry uses the same row — so it does nothing at
//    all about the case that matters: Tally accepts the import and the answer is
//    lost on the way back. Read as idempotency, that index is a false comfort.
//
//    What this adapter relies on instead is that the voucher carries an identity
//    we control and can look up. VOUCHERNUMBER is VEXO's own invoice number (see
//    accounting.js), which is stable across every retry because it comes from the
//    order, not from the attempt. So when a send fails without an answer, the
//    adapter ASKS TALLY whether the voucher is there before anything resends —
//    confirmVoucher() below. Present: the voucher exists, record it and stop.
//    Absent: we say so and stop anyway, because Tally's absence is not proof.
//
// 3. MASTERS MUST ALREADY EXIST, BY EXACT NAME. Tally's guidance is to ensure
//    dependent ledgers and groups are present before importing. So a posting
//    whose ledger is not mapped is held in the error queue with a readable
//    reason; it is never sent hopefully. AccountingLedgerMap is where the
//    operator states those names once.
//
// DIRECTION: VEXO -> Tally, one way. VEXO's own sales, refunds and receipts are
// authoritative for VEXO's operational transactions; this adapter reports them.
// It never reads a balance back and calls it truth, and it never lets Tally
// overwrite a POS order.

import { ProviderCallError, providerFetch } from '../http.js';
import { LanHostError, assertLanDestination } from '../lanHost.js';

// --- XML ---------------------------------------------------------------------

// Escaping is not cosmetic here. A ledger named "Sales - Dine In & Takeaway" or
// a customer named "O'Brien" produces malformed XML unescaped, and Tally's
// response to malformed XML is a failure whose message does not say which
// character broke it.
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;

// Tally's DATE is yyyymmdd with no separators. Taking the first 10 characters of
// an ISO string keeps this in IST-agnostic territory: callers pass the business
// date they already computed with istDateOf(), and this only reformats it.
export const tallyDate = (isoDate) => String(isoDate).slice(0, 10).replace(/-/g, '');

const envelope = ({ companyName, requestType = 'Import', type = 'Data', id = 'Vouchers', body, variables = {} }) => `<ENVELOPE>
<HEADER>
<VERSION>1</VERSION>
<TALLYREQUEST>${esc(requestType)}</TALLYREQUEST>
<TYPE>${esc(type)}</TYPE>
<ID>${esc(id)}</ID>
</HEADER>
<BODY>
<DESC>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY>
${Object.entries(variables).map(([k, v]) => tag(k, v)).join('\n')}
</STATICVARIABLES>
</DESC>
${body}
</BODY>
</ENVELOPE>`;

const importData = ({ companyName, reportName, messages }) =>
  envelope({
    companyName,
    id: reportName,
    body: `<IMPORTDATA>
<REQUESTDESC>
<REPORTNAME>${esc(reportName)}</REPORTNAME>
<STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
${messages.join('\n')}
</REQUESTDATA>
</IMPORTDATA>`,
  });

// A ledger line. ISDEEMEDPOSITIVE is Tally's way of saying debit: YES for a
// debit, NO for a credit. In a sales voucher the party ledger is debited and the
// sales and tax ledgers are credited, which is the opposite of what most people
// expect the first time they read it — hence naming the parameter `debit` and
// translating here, once, rather than at every call site.
const ledgerEntry = ({ ledgerName, amount, debit, isParty = false, billAllocation = null }) => {
  // Tally signs the amount as well as flagging it. A debit is negative in the
  // AMOUNT field. Both must agree or Tally silently posts the wrong side.
  const signed = debit ? -Math.abs(amount) : Math.abs(amount);
  return `<ALLLEDGERENTRIES.LIST>
${tag('LEDGERNAME', ledgerName)}
${tag('ISDEEMEDPOSITIVE', debit ? 'Yes' : 'No')}
${isParty ? tag('ISPARTYLEDGER', 'Yes') : ''}
${tag('AMOUNT', signed.toFixed(2))}
${billAllocation
      ? `<BILLALLOCATIONS.LIST>
${tag('NAME', billAllocation.name)}
${tag('BILLTYPE', billAllocation.billType || 'New Ref')}
${tag('AMOUNT', signed.toFixed(2))}
</BILLALLOCATIONS.LIST>`
      : ''}
</ALLLEDGERENTRIES.LIST>`;
};

// A sales voucher. `lines` are already-resolved ledger postings — this function
// does no arithmetic and no tax derivation, because VEXO computed those in
// recomputeOrder() and re-deriving them here would create a second, divergent
// answer to what the bill was.
export const buildSalesVoucher = ({
  voucherTypeName,
  date,
  voucherNumber,
  narration,
  partyLedgerName,
  partyAmount,
  lines,
  reference,
}) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
${tag('DATE', tallyDate(date))}
${tag('EFFECTIVEDATE', tallyDate(date))}
${tag('VOUCHERTYPENAME', voucherTypeName)}
${tag('VOUCHERNUMBER', voucherNumber)}
${tag('PERSISTEDVIEW', 'Accounting Voucher View')}
${tag('ISINVOICE', 'No')}
${narration ? tag('NARRATION', narration) : ''}
${reference ? tag('REFERENCE', reference) : ''}
${ledgerEntry({ ledgerName: partyLedgerName, amount: partyAmount, debit: true, isParty: true, billAllocation: { name: voucherNumber, billType: 'New Ref' } })}
${lines.map((l) => ledgerEntry({ ledgerName: l.ledgerName, amount: l.amount, debit: false })).join('\n')}
</VOUCHER>
</TALLYMESSAGE>`;

// A receipt: money in. The bank/cash ledger is debited, the party credited
// against the bill the sales voucher opened — which is why the sales voucher
// above always writes a BILLALLOCATIONS "New Ref" named for the invoice: without
// it the receipt has nothing to settle against and the party ledger accumulates
// unmatched balances.
export const buildReceiptVoucher = ({
  voucherTypeName,
  date,
  voucherNumber,
  narration,
  partyLedgerName,
  depositLedgerName,
  amount,
  againstRef,
}) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
${tag('DATE', tallyDate(date))}
${tag('VOUCHERTYPENAME', voucherTypeName)}
${tag('VOUCHERNUMBER', voucherNumber)}
${tag('PERSISTEDVIEW', 'Accounting Voucher View')}
${narration ? tag('NARRATION', narration) : ''}
${ledgerEntry({ ledgerName: depositLedgerName, amount, debit: true })}
${ledgerEntry({ ledgerName: partyLedgerName, amount, debit: false, isParty: true, billAllocation: { name: againstRef, billType: 'Agst Ref' } })}
</VOUCHER>
</TALLYMESSAGE>`;

// A credit note reverses a sale. Tally's own sample XML documents only Sales, so
// the tag set here is the sales shape with the sides swapped and the voucher type
// taken from configuration — the client's company decides what their credit note
// is called. Marked PATH_ONLY in providers.js for exactly this reason: confirm
// against an export of a real credit note in the client's company before
// enabling it.
export const buildCreditNote = ({
  voucherTypeName,
  date,
  voucherNumber,
  narration,
  partyLedgerName,
  partyAmount,
  lines,
  againstRef,
}) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${esc(voucherTypeName)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
${tag('DATE', tallyDate(date))}
${tag('VOUCHERTYPENAME', voucherTypeName)}
${tag('VOUCHERNUMBER', voucherNumber)}
${tag('PERSISTEDVIEW', 'Accounting Voucher View')}
${narration ? tag('NARRATION', narration) : ''}
${ledgerEntry({ ledgerName: partyLedgerName, amount: partyAmount, debit: false, isParty: true, billAllocation: { name: againstRef, billType: 'Agst Ref' } })}
${lines.map((l) => ledgerEntry({ ledgerName: l.ledgerName, amount: l.amount, debit: true })).join('\n')}
</VOUCHER>
</TALLYMESSAGE>`;

export const buildLedgerMaster = ({ name, parent }) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<LEDGER NAME="${esc(name)}" Action="Create">
${tag('NAME', name)}
${tag('PARENT', parent)}
</LEDGER>
</TALLYMESSAGE>`;

// --- response ----------------------------------------------------------------

// Tally answers with XML carrying STATUS (1 success, 0 failure) and counters.
// Parsed with regexes rather than an XML parser because adding an XML dependency
// is not allowed in this lane and the response shape is three integers and a
// possible error string — a parser would be more surface for no more certainty.
export const parseImportResponse = (raw) => {
  const num = (name) => {
    const m = raw.match(new RegExp(`<${name}>\\s*(-?\\d+)\\s*</${name}>`, 'i'));
    return m ? Number(m[1]) : null;
  };
  // LINEERROR is where Tally puts a readable import failure; ERROR is the
  // envelope-level variant. ERRORS is a COUNT and must not be read as a message:
  // matching it was a real defect, because a SUCCESSFUL import response contains
  // <ERRORS>0</ERRORS>, which made `ok` false for every voucher Tally accepted.
  // Hence the `>` anchored immediately after ERROR, and the digits guard for any
  // Tally variant that reports a count in a singular tag.
  const errorMatch = raw.match(/<(?:LINEERROR|ERROR)>([\s\S]*?)<\//i)?.[1]?.trim() || null;
  const errorText = errorMatch && !/^\d+$/.test(errorMatch) ? errorMatch : null;
  const created = num('CREATED');
  const altered = num('ALTERED');
  const errors = num('ERRORS');
  const exceptions = num('EXCEPTIONS');
  return {
    // STATUS is absent from some Tally error responses, so success is not
    // assumed from its absence: a response with no STATUS and no CREATED is a
    // failure we could not read, which is different from a success.
    status: num('STATUS'),
    created,
    altered,
    errors,
    exceptions,
    errorText,
    ok: (num('STATUS') === 1 || created > 0) && !(errors > 0) && !errorText,
  };
};

// --- looking a voucher up again ----------------------------------------------

// Was this voucher written? Asked of the Day Book, which is a collection type
// verified to be valid against this client's TallyPrime — that matters, because
// an unrecognised collection type does not return an error, it WEDGES Tally's
// HTTP server until somebody clears it at the console. Guessing a report name
// here would take the client's accounting offline.
//
// SVFROMDATE/SVTODATE are sent, and the answer is filtered by voucher number
// anyway. Not belt-and-braces: the Bills collection on this Tally ignores both
// date variables and answers "as of now" regardless, so a narrowed request is
// not something this code is entitled to assume it got.
const dayBookRequest = ({ companyName, date }) =>
  envelope({
    companyName,
    requestType: 'Export',
    type: 'Collection',
    id: 'Day Book',
    variables: { SVFROMDATE: tallyDate(date), SVTODATE: tallyDate(date) },
    body: '',
  });

// Split on voucher boundaries before matching, so a voucher number is only ever
// read together with the voucher it belongs to. A flat regex over the whole
// document would happily pair our number with another voucher's master id.
//
// Safe against <VOUCHERNUMBER> and <VOUCHERTYPENAME>: the separator requires
// whitespace or '>' immediately after "VOUCHER", which neither of those has.
export const findVoucherInExport = (raw, voucherNumber) => {
  const target = String(voucherNumber ?? '').trim();
  if (!target) return { found: false, masterId: null, voucherTypeName: null };
  const vouchers = String(raw ?? '').split(/<VOUCHER[\s>]/i).slice(1);
  for (const v of vouchers) {
    const number = v.match(/<VOUCHERNUMBER>([\s\S]*?)<\/VOUCHERNUMBER>/i)?.[1]?.trim();
    if (number !== target) continue;
    return {
      found: true,
      // Opportunistic. Tally's own id for the voucher is worth keeping when the
      // export carries one, and null is the honest answer when it does not —
      // this adapter does not manufacture an identifier to fill a column.
      masterId:
        v.match(/<MASTERID>([\s\S]*?)<\/MASTERID>/i)?.[1]?.trim() ||
        v.match(/^[^>]*\bREMOTEID="([^"]+)"/i)?.[1]?.trim() ||
        null,
      voucherTypeName: v.match(/<VOUCHERTYPENAME>([\s\S]*?)<\/VOUCHERTYPENAME>/i)?.[1]?.trim() ?? null,
    };
  }
  return { found: false, masterId: null, voucherTypeName: null };
};

// Connection failures where the request demonstrably never arrived. The socket
// was refused or the host was unreachable, so Tally read no bytes and cannot
// have imported anything — a plain retry is safe and needs no lookup. Every
// OTHER failure is treated as "Tally may have applied it", including a timeout
// and a 5xx, because in both of those our request was delivered.
const NEVER_ARRIVED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);

// --- adapter -----------------------------------------------------------------

// Resolves the configured host, refuses unless EVERY answer is a private
// address, and then dials the VERIFIED ADDRESS rather than the name.
//
// That last part is the load-bearing detail. Handing the name to fetch would
// make fetch resolve it a second time, and a second resolution can return a
// different answer than the one we just approved — which reopens the exact
// window this check closes. Dialling the address we verified leaves no gap
// between the decision and the connection. Tally is a raw XML-over-HTTP service
// with no name-based virtual hosting, so addressing it by IP is equivalent.
const urlFor = async (credential, { resolver } = {}) => {
  let verified;
  try {
    verified = await assertLanDestination(credential.host, resolver ? { resolver } : {});
  } catch (err) {
    if (err instanceof LanHostError) throw new ProviderCallError(err.message, { kind: 'TERMINAL' });
    throw err;
  }
  const target = verified.addresses[0];
  const host = target.includes(':') ? `[${target.replace(/^\[|\]$/g, '')}]` : target;
  return `http://${host}:${credential.port || 9000}`;
};

const send = async (credential, xml, opts) => {
  const result = await providerFetch(await urlFor(credential, opts), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body: xml,
    parse: 'xml',
  });
  return parseImportResponse(result.raw);
};

// The lost acknowledgement. Tally imported the voucher and the answer never
// reached us — a timeout, a reset, a proxy 502 — and the queue's instinct is to
// retry. For a Tally voucher that instinct puts a second sale in the client's
// books, because nothing on Tally's side rejects the repeat.
//
// So: look before retrying. Three outcomes, and only one of them lets the delivery
// be called done.
//
//   found     -> the voucher is in the books. Report success, and DO NOT resend.
//                The only thing that went wrong was the answer.
//   not found -> refuse in a way the queue will not retry, and say so plainly.
//                Absence in an export is weaker evidence than presence: the Day
//                Book may have answered for a period we did not ask for, the
//                voucher may sit under a type the report excludes. Resending on
//                that would be gambling the client's revenue figure on a report's
//                filter, so a person decides. The error queue has a retry control
//                for exactly this, and pressing it is a decision with a name on it.
//   cannot ask -> Tally is not answering reads either, so we have learnt nothing.
//                Fall through to the original error and let the backoff run: a
//                Tally that is unreachable now will be asked again later, which is
//                better than declaring an outcome we cannot see.
//
// Returns a success object, throws a TERMINAL, or returns null meaning "no verdict,
// use the original error".
const recoverLostAck = async (err, { kind, payload, credential, config, opts }) => {
  if (!(err instanceof ProviderCallError)) return null;
  // Tally answered and refused; nothing was applied and nothing needs looking up.
  if (err.providerRefused) return null;
  if (NEVER_ARRIVED.has(err.code)) return null;

  // A ledger master is matched by NAME inside Tally, so importing the same one
  // twice converges instead of duplicating. There is no voucher to look up and no
  // harm in the retry, which is why this is the one kind left on the old path.
  if (kind === 'TALLY_LEDGER_MASTER') return null;

  const voucherNumber = payload?.voucherNumber;
  if (!voucherNumber) return null;

  let raw;
  try {
    const answer = await providerFetch(await urlFor(credential, opts), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8' },
      body: dayBookRequest({ companyName: config.companyName, date: payload.date }),
      parse: 'xml',
    });
    raw = answer.raw;
  } catch {
    return null;
  }

  const hit = findVoucherInExport(raw, voucherNumber);
  if (hit.found) {
    return {
      externalRef: hit.masterId,
      detail: {
        // Shaped like an import response because that is what the worker reads to
        // decide ACKNOWLEDGED, and this is the same fact arrived at differently:
        // the voucher exists in the client's books.
        status: 1,
        created: 1,
        altered: 0,
        errors: 0,
        exceptions: 0,
        errorText: null,
        ok: true,
        recoveredFromLostAcknowledgement: true,
        confirmedBy: 'Day Book export',
        voucherNumber: String(voucherNumber),
        voucherTypeName: hit.voucherTypeName,
        originalError: err.message,
      },
    };
  }

  throw new ProviderCallError(
    `TallyPrime did not answer this import (${err.message}), and voucher ${voucherNumber} was not found in the Day Book for ${tallyDate(payload.date)}. ` +
      'It has NOT been sent again, because an export that does not list a voucher is not proof the voucher is absent, and a second attempt would risk a duplicate sale. ' +
      'Check this voucher in Tally and use Retry if it is genuinely missing.',
    { kind: 'TERMINAL', code: err.code, body: JSON.stringify({ lostAcknowledgement: true, voucherNumber: String(voucherNumber) }) },
  );
};

export const adapter = {
  key: 'TALLY',
  operable: true,

  async checkConnection({ credential, config, resolver }) {
    // Export (Get) of the company's own name: the smallest request that proves
    // all three prerequisites at once — Tally is running, the HTTP server is
    // enabled, and a company is loaded with the name the operator configured.
    // Chosen over an import because a connection test must write nothing.
    try {
      const xml = envelope({
        companyName: config.companyName,
        requestType: 'Export',
        type: 'Collection',
        id: 'List of Companies',
        body: '',
      });
      const result = await providerFetch(await urlFor(credential, { resolver }), {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=utf-8' },
        body: xml,
        parse: 'xml',
      });
      // Tally answering at all is the load-bearing part: an unreachable port and
      // a disabled HTTP server both fail before this point. Confirming the
      // configured company appears in the answer is what turns "Tally is up"
      // into "Tally is up with the right books open".
      const named = result.raw.includes(esc(config.companyName)) || result.raw.includes(config.companyName);
      return named
        ? { ok: true, detail: `TallyPrime answered and has "${config.companyName}" loaded.` }
        : {
            ok: false,
            detail: `TallyPrime answered, but no company named "${config.companyName}" is loaded. Open that company in Tally, or correct the name.`,
          };
    } catch (err) {
      return {
        ok: false,
        detail:
          err instanceof ProviderCallError
            ? err.message
            : 'TallyPrime could not be reached. Check that Tally is running, a company is loaded, and the HTTP server is enabled on the configured port.',
      };
    }
  },

  parseInbound() {
    // Tally can be configured to act as a client and call out, but this lane
    // never accepts that: an unauthenticated peer on a shop LAN must not be able
    // to drive POS state. One-way is a design decision, not a missing feature.
    throw new ProviderCallError('This lane does not accept inbound calls from Tally; the integration is VEXO -> Tally only', {
      kind: 'TERMINAL',
    });
  },

  async perform({ kind, payload, credential, config, resolver }) {
    const messages = {
      TALLY_SALES: () => buildSalesVoucher({ voucherTypeName: config.salesVoucherType, ...payload }),
      TALLY_CREDIT_NOTE: () => buildCreditNote({ voucherTypeName: config.creditNoteVoucherType, ...payload }),
      TALLY_RECEIPT: () => buildReceiptVoucher({ voucherTypeName: config.receiptVoucherType, ...payload }),
      TALLY_LEDGER_MASTER: () => buildLedgerMaster(payload),
    };
    const build = messages[kind];
    if (!build) {
      throw new ProviderCallError(`Tally adapter has no handler for job kind ${kind}`, { kind: 'TERMINAL' });
    }
    const reportName = kind === 'TALLY_LEDGER_MASTER' ? 'All Masters' : 'Vouchers';
    const xml = importData({ companyName: config.companyName, reportName, messages: [build()] });
    const opts = resolver ? { resolver } : undefined;

    let result;
    try {
      result = await send(credential, xml, opts);
    } catch (err) {
      const recovered = await recoverLostAck(err, { kind, payload, credential, config, opts });
      if (recovered) return recovered;
      throw err;
    }

    if (!result.ok) {
      // A Tally import that reports errors HAS answered, so this is TERMINAL,
      // not UNKNOWN: retrying an XML Tally has already rejected produces the
      // same rejection and buries the real problem under eight identical
      // failures. The operator needs to see it once, with Tally's own words.
      throw new ProviderCallError(
        result.errorText
          ? `TallyPrime rejected the voucher: ${result.errorText}`
          : 'TallyPrime did not accept the voucher',
        { kind: 'TERMINAL', body: JSON.stringify(result) },
      );
    }
    return {
      // Tally's import response does not return a voucher identifier, so there
      // is nothing honest to put in externalRef. The acknowledgement itself, and
      // our own reference in the voucher, are what tie the two sides together.
      externalRef: null,
      detail: result,
    };
  },
};

export default adapter;
