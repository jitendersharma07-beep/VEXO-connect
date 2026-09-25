// Human-readable document numbers, one series per company per financial year.
//
// Same shape and the same Indian FY rule as invoice numbering, reusing
// fyLabel() rather than re-deciding when April starts. The counter row is
// incremented inside the caller's transaction, so a document that rolls back
// does not burn a number and leave a hole an auditor has to explain.

import { fyLabel } from '../invoice.js';

const PREFIX = Object.freeze({
  PO: 'PO',
  GRN: 'GRN',
  TRANSFER: 'TRF',
  REQUEST: 'REQ',
  COUNT: 'CNT',
  WASTAGE: 'WST',
  PURCHASE_RETURN: 'PRT',
  PRODUCTION: 'PRD',
});

export const nextDocNumber = async (tx, companyId, docType, at = new Date()) => {
  const prefix = PREFIX[docType];
  if (!prefix) throw new Error(`Unknown inventory document type: ${docType}`);
  const label = fyLabel(at);
  const counter = await tx.inventoryDocCounter.upsert({
    where: { companyId_docType_fyLabel: { companyId, docType, fyLabel: label } },
    update: { lastNumber: { increment: 1 } },
    create: { companyId, docType, fyLabel: label, lastNumber: 1 },
  });
  return `${prefix}/${label}/${String(counter.lastNumber).padStart(5, '0')}`;
};
