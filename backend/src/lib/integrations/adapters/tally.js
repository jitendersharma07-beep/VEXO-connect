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
//    vouchers into the client's books. That is why `assertPrivateHost` below
//    refuses a public address outright: the honest way to honour "do not expose
//    Tally's local service to the public internet" is to make the settings
//    screen incapable of pointing at one.
//
// 2. TALLY HAS NO IDEMPOTENCY. Its documentation publishes no duplicate-detection
//    mechanism for imports; send the same sales voucher twice and the client has
//    two sales. Duplicate suppression is therefore entirely ours, and it lives in
//    the unique index on AccountingPosting(connectionId, sourceType, sourceId,
//    docType) — before the call, not after it.
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

// --- host safety -------------------------------------------------------------

// RFC1918 plus loopback and link-local. Written out rather than resolved through
// DNS on purpose: this is a syntactic gate on what an operator may type, and it
// is checked again at call time so a config written before this guard existed
// still cannot reach the internet.
const PRIVATE_V4 =
  /^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3})\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3})\.\d{1,3}|127\.(?:\d{1,3}\.){2}\d{1,3}|169\.254\.(?:\d{1,3})\.\d{1,3})$/;

export const isPrivateHost = (host) => {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  if (h === '::1') return true;
  if (PRIVATE_V4.test(h)) return true;
  // A bare hostname with no dots is a LAN name (a Windows machine name, which is
  // exactly how Tally PCs are usually addressed). A dotted public name is not.
  return /^[a-z0-9][a-z0-9-]*$/.test(h);
};

export const assertPrivateHost = (host) => {
  if (isPrivateHost(host)) return;
  throw new ProviderCallError(
    `Tally host "${host}" is not a private/LAN address. TallyPrime has no authentication, so it must never be reached across the public internet.`,
    { kind: 'TERMINAL' },
  );
};

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

const envelope = ({ companyName, requestType = 'Import', type = 'Data', id = 'Vouchers', body }) => `<ENVELOPE>
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
  const errorText = raw.match(/<(?:LINEERROR|ERRORS?)>([\s\S]*?)<\//i)?.[1]?.trim() || null;
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

// --- adapter -----------------------------------------------------------------

const urlFor = (credential) => {
  assertPrivateHost(credential.host);
  return `http://${credential.host}:${credential.port || 9000}`;
};

const send = async (credential, xml) => {
  const result = await providerFetch(urlFor(credential), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body: xml,
    parse: 'xml',
  });
  return parseImportResponse(result.raw);
};

export const adapter = {
  key: 'TALLY',
  operable: true,

  async checkConnection({ credential, config }) {
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
      const result = await providerFetch(urlFor(credential), {
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

  async perform({ kind, payload, credential, config }) {
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
    const result = await send(credential, xml);
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
