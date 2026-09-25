// Invoice numbering — contract §8: <prefix>/<fy>/<seq5>, Indian financial
// year (April–March) decided in IST. One counter row per branch per FY,
// incremented atomically inside the bill transaction.
//
// LANE foundation — an ESTABLISHED SERIES DOES NOT MOVE.
//
// The prefix a store's first bill of a financial year is issued under is frozen
// onto that year's counter row (InvoiceCounter.seriesPrefix) in the same
// statement that issues the number. Every later bill in the same series reads it
// back from there. Nothing about the live store record — `code`, `invoicePrefix`
// or anything else an administrator can edit — is consulted again once a series
// has started.
//
// Before this the prefix was recomputed per bill from `branch.invoicePrefix ??
// branch.code`. Editing either mid-year relabelled a series that was already
// running, so one financial year's books held invoices under two different
// series with one shared sequence, and no row anywhere recorded that it had
// happened. A GST series is supposed to be the one thing about an invoice that
// is boringly predictable.
//
// The counter is keyed by branch and FY, never by the prefix, so the sequence
// itself is unaffected either way: a tenant can never issue a second 00001 in
// one year. Bills already issued keep what they were printed with regardless —
// the number is stored on the order and is never recomputed.

const IST_OFFSET_MS = 330 * 60 * 1000;

export const fyLabel = (at = new Date()) => {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1; // months are 0-based; April = 3
  const yy = (n) => String(n % 100).padStart(2, '0');
  return `${yy(startYear)}-${yy(startYear + 1)}`;
};

// The series a store's NEXT new year would open under. Only ever read when no
// counter exists yet for that year; once one does, the stored prefix wins.
export const proposedSeriesPrefix = (branch) => branch.invoicePrefix ?? branch.code;

// Must be called with the transaction client of the bill transaction so the
// counter increment commits (or rolls back) together with the bill itself.
//
// The upsert is what makes the freeze atomic: `create` writes the prefix, and
// two tills billing the same store in the same instant both come back with
// whichever row won, never with two different series.
// Returns the number AND the series it was issued under. Both, because the
// snapshot has to record the same prefix the number was built from; deriving it
// a second time from the live store is how the two came to disagree.
export const nextInvoiceNumber = async (tx, branch, at = new Date()) => {
  const label = fyLabel(at);
  const counter = await tx.invoiceCounter.upsert({
    where: { branchId_fyLabel: { branchId: branch.id, fyLabel: label } },
    update: { lastNumber: { increment: 1 } },
    create: {
      branchId: branch.id,
      fyLabel: label,
      lastNumber: 1,
      seriesPrefix: proposedSeriesPrefix(branch),
    },
  });
  return {
    invoiceNumber: `${counter.seriesPrefix}/${label}/${String(counter.lastNumber).padStart(5, '0')}`,
    seriesPrefix: counter.seriesPrefix,
  };
};

// --- the seller of record, frozen -------------------------------------------
//
// LANE foundation, spec §3. A tax invoice is a legal document about a moment:
// the name, GSTIN, address and FSSAI licence it carries are claims about who
// sold what, on that date, from that counter. Master data is editable — a store
// moves, a trade name changes, a licence is renewed, a registration is remapped
// to a different entity. None of that may reach back and restate a bill that
// has already been handed to a customer.
//
// So the facts are copied onto the order at bill time and read back from there
// for the rest of the order's life. The live records stay the source of truth
// for the NEXT bill only.
//
// Orders billed before this column existed have null here. They are not
// backfilled: writing today's GSTIN onto last year's invoice would be inventing
// a tax fact, which §3 forbids outright. Those receipts keep reading the live
// store record, exactly as they did when they were printed.

export const sellerOfRecord = async (db, branch) => {
  const [legalEntity, gst] = await Promise.all([
    branch.legalEntityId
      ? db.legalEntity.findUnique({
          where: { id: branch.legalEntityId },
          select: { id: true, legalName: true, tradeName: true, pan: true, cin: true },
        })
      : null,
    branch.gstRegistrationId
      ? db.gstRegistration.findUnique({
          where: { id: branch.gstRegistrationId },
          select: {
            id: true,
            gstin: true,
            tradeName: true,
            stateCode: true,
            stateName: true,
            addressLine: true,
            city: true,
            pincode: true,
          },
        })
      : null,
  ]);
  return { legalEntity, gst };
};

// A plain JSON object, not a Prisma payload: it is stored in a Json column and
// must stay readable years from now without the schema that produced it. Dates
// become ISO strings for the same reason.
export const billingSnapshot = ({ branch, seller, invoiceNumber, seriesPrefix, at = new Date() }) => ({
  version: 1,
  billedAt: at.toISOString(),
  fyLabel: fyLabel(at),
  series: {
    // The series the number was actually issued under, handed in by
    // nextInvoiceNumber. It used to be recomputed here as `branch.invoicePrefix
    // ?? branch.code`, which meant that after an administrator edited either
    // one, a bill carried a prefix that disagreed with the invoice number
    // printed beside it — the live value presented as the original.
    prefix: seriesPrefix,
    invoiceNumber,
  },
  store: {
    id: branch.id,
    publicId: branch.publicId,
    name: branch.name,
    code: branch.code,
    addressLine: branch.addressLine ?? null,
    city: branch.city ?? null,
    state: branch.state ?? null,
    pincode: branch.pincode ?? null,
  },
  legalEntity: seller?.legalEntity
    ? {
        id: seller.legalEntity.id,
        legalName: seller.legalEntity.legalName,
        tradeName: seller.legalEntity.tradeName ?? null,
        pan: seller.legalEntity.pan ?? null,
        cin: seller.legalEntity.cin ?? null,
      }
    : null,
  gst: seller?.gst
    ? {
        id: seller.gst.id,
        gstin: seller.gst.gstin,
        tradeName: seller.gst.tradeName ?? null,
        stateCode: seller.gst.stateCode,
        stateName: seller.gst.stateName,
        addressLine: seller.gst.addressLine ?? null,
        city: seller.gst.city ?? null,
        pincode: seller.gst.pincode ?? null,
      }
    : null,
  // Recorded even when absent, so a later audit can tell "this store had no
  // licence on file that day" apart from "we forgot to snapshot it".
  fssai: {
    licenseNo: branch.fssaiLicenseNo ?? null,
    validUpto: branch.fssaiValidUpto ? new Date(branch.fssaiValidUpto).toISOString() : null,
  },
});
