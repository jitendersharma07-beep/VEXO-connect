// Invoice numbering — contract §8: <branchCode>/<fy>/<seq5>, Indian financial
// year (April–March) decided in IST. One counter row per branch per FY,
// incremented atomically inside the bill transaction.

const IST_OFFSET_MS = 330 * 60 * 1000;

export const fyLabel = (at = new Date()) => {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1; // months are 0-based; April = 3
  const yy = (n) => String(n % 100).padStart(2, '0');
  return `${yy(startYear)}-${yy(startYear + 1)}`;
};

// Must be called with the transaction client of the bill transaction so the
// counter increment commits (or rolls back) together with the bill itself.
export const nextInvoiceNumber = async (tx, branch, at = new Date()) => {
  const label = fyLabel(at);
  const counter = await tx.invoiceCounter.upsert({
    where: { branchId_fyLabel: { branchId: branch.id, fyLabel: label } },
    update: { lastNumber: { increment: 1 } },
    create: { branchId: branch.id, fyLabel: label, lastNumber: 1 },
  });
  return `${branch.code}/${label}/${String(counter.lastNumber).padStart(5, '0')}`;
};
