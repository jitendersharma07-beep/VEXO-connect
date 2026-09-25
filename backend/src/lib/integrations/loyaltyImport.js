// Historical loyalty import (LANE providers).
//
// WHY THIS IS A FILE IMPORT AND NOT AN API SYNC. Reelo's published POS API has no
// bulk export, no bulk import and no historical customer endpoint — customers come
// into existence implicitly through bill sync. There is therefore no API by which
// the client's existing ~100,000 customers and balances can be read out, and any
// design that loops over one would be looping over an endpoint that does not
// exist. The migration consumes a Reelo-PROVIDED export instead, which is a
// support/commercial request to Reelo, not a code problem.
//
// WHAT THIS IMPORT DOES AND DOES NOT DO. It creates VEXO Customer rows and links
// them to the provider profiles they already have, so that a customer walking in
// tomorrow is recognised. It records the balance each profile had at export time,
// as a cache with a timestamp. It does NOT write points anywhere authoritative,
// does not enrol anybody at Reelo, does not adjust a balance, does not recompute
// history and does not send a message — all four of which the user's instruction
// forbids, and all four of which would be destructive against a live loyalty
// programme.
//
// WHAT "DONE" MEANS. A run that reports "99,412 of 100,000" without saying which
// 588 and why is not a reportable result. Every row that does not import produces
// a LoyaltyImportException naming the row number, the raw phone as it appeared,
// and the reason. The totals reconcile: fetched = matched + created + skipped +
// failed, asserted at the end of every run.
//
// RESUMABILITY. `cursor` is the row number last committed. A run interrupted at
// row 64,000 resumes at 64,001 rather than starting again, because re-reading
// 64,000 rows is slow and because a re-run must not be the only way to recover.
// resumeRun() below is what makes that true — for a while the cursor was written
// and reported and nothing read it, which is the most misleading shape a defect
// can take: the report displays a row number that looks like a place to continue
// from, and there is no way to continue from it.

import { createHash } from 'node:crypto';

import { prisma } from '../prisma.js';
import { normalizePhone } from './adapters/reelo.js';

// Batch size trades transaction length against restart cost. 500 keeps each
// transaction well inside the interactive-transaction budget this codebase
// already declares, and caps replayed work after a crash at 500 rows.
export const BATCH_SIZE = 500;

// --- parsing -----------------------------------------------------------------

// A minimal CSV reader. Written rather than taken as a dependency because the
// lane forbids npm install, and because the requirement is narrow: quoted fields,
// escaped quotes, embedded commas and CRLF. Anything more exotic in a provider
// export should fail loudly as an exception row, not be silently reinterpreted.
export const parseCsvLine = (line) => {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
};

// Column names differ between exports, and an export whose header we cannot
// recognise must stop the run before it writes anything — not import 100,000
// rows into the wrong columns. Returns null for a header we cannot map, and the
// caller refuses the run.
const HEADER_ALIASES = Object.freeze({
  externalCustomerId: ['customer_id', 'customerid', 'id', 'reelo_id', 'reelo_customer_id'],
  phone: ['phone', 'mobile', 'phone_number', 'mobile_number', 'contact'],
  name: ['name', 'customer_name', 'full_name'],
  points: ['points', 'balance', 'points_balance', 'available_points', 'loyalty_points'],
  tier: ['tier', 'membership', 'membership_tier', 'segment'],
  expiresAt: ['points_expiry', 'expiry', 'expires_at', 'points_expire_at'],
  email: ['email', 'email_address'],
});

export const mapHeader = (headerCells) => {
  const lower = headerCells.map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const index = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const at = lower.findIndex((h) => aliases.includes(h));
    if (at >= 0) index[field] = at;
  }
  // Phone is the only genuinely mandatory column: it is what matches a customer.
  // Without an external id we can still link by phone after a lookup; without a
  // phone there is nothing to match on and the row is unusable.
  if (index.phone === undefined) return null;
  return index;
};

const intOrNull = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(String(raw).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const dateOrNull = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

// One row → either a record to import or a reason it cannot be.
export const interpretRow = (cells, index, rowNumber) => {
  const phoneRaw = cells[index.phone] ?? '';
  const norm = normalizePhone(phoneRaw);
  if (!phoneRaw) {
    return { ok: false, rowNumber, phoneRaw, reason: 'no phone number in this row' };
  }
  if (!norm.confident) {
    // Deliberately an exception and not a best-effort import. A number we cannot
    // read confidently would either fail to match the customer later — leaving
    // them looking like a new customer with no points — or match the WRONG
    // customer. Both are worse than a row on an exception report.
    return {
      ok: false,
      rowNumber,
      phoneRaw,
      externalCustomerId: index.externalCustomerId !== undefined ? cells[index.externalCustomerId] : null,
      reason: `phone "${phoneRaw}" is not a recognisable Indian mobile number`,
    };
  }
  const points = index.points !== undefined ? intOrNull(cells[index.points]) : null;
  if (index.points !== undefined && points === null && cells[index.points] !== '') {
    return { ok: false, rowNumber, phoneRaw, reason: `points value "${cells[index.points]}" is not a number` };
  }
  return {
    ok: true,
    rowNumber,
    phoneRaw,
    normalizedPhone: norm.national,
    externalCustomerId: index.externalCustomerId !== undefined ? (cells[index.externalCustomerId] || null) : null,
    name: index.name !== undefined ? (cells[index.name] || null) : null,
    email: index.email !== undefined ? (cells[index.email] || null) : null,
    points,
    tier: index.tier !== undefined ? (cells[index.tier] || null) : null,
    expiresAt: index.expiresAt !== undefined ? dateOrNull(cells[index.expiresAt]) : null,
  };
};

// --- the run -----------------------------------------------------------------

// Which file this is. Content, not name or size: two exports taken a day apart
// are the same length and both called customers.csv, and the row numbers a resume
// relies on have moved between them.
export const fingerprint = (csv) => createHash('sha256').update(csv).digest('hex');

// A run is resumable when it stopped without finishing and we can prove the file
// is the same one. Each refusal returns its own reason, because "cannot resume"
// on its own leaves an operator holding 100,000 records with nothing to do next.
export const resumableFrom = (run, csv) => {
  if (!run) return { ok: false, reason: 'Import run not found' };
  if (run.state === 'COMPLETED') {
    return { ok: false, reason: 'That import already finished. Start a new one if the file has changed.' };
  }
  if (run.state === 'PREVIEW') {
    // A preview wrote nothing, so there is nothing to continue: the honest
    // instruction is to run it again, not to resume half of a dry run.
    return { ok: false, reason: 'That was a preview, which changed nothing. Run the preview again, or start a real import.' };
  }
  if (run.state === 'CANCELLED') {
    return { ok: false, reason: 'That import was cancelled. Start a new one.' };
  }
  if (!run.sourceFingerprint) {
    return {
      ok: false,
      reason: 'That import did not record which file it was reading, so it cannot be resumed safely. Start a new import.',
    };
  }
  if (run.sourceFingerprint !== fingerprint(csv)) {
    return {
      ok: false,
      reason:
        'This is not the file that import was reading. Resuming part-way through a different export would import the wrong rows — start a new import instead.',
    };
  }
  const from = Number(run.cursor ?? 0);
  return { ok: true, resumeAfterRow: Number.isFinite(from) ? from : 0 };
};

// Reopen a stopped run rather than creating a second one. Its counters, its
// exceptions and its cursor are the record of what the migration has already
// done; a fresh run would report "created: 0, matched: 64,000" and lose the
// answer to the only question anybody asks afterwards — how many of these
// customers did we bring across.
export const resumeRun = (runId) =>
  prisma.loyaltyImportRun.update({
    where: { id: runId },
    data: { state: 'RUNNING', lastError: null, finishedAt: null, lastHeartbeatAt: new Date() },
  });

export const createRun = (client, { companyId, connectionId, dryRun, startedById, totalReported, sourceFingerprint }) =>
  client.loyaltyImportRun.create({
    data: {
      companyId,
      connectionId,
      sourceFingerprint: sourceFingerprint ?? null,
      // A real run always begins as a PREVIEW in the operator's workflow, but the
      // state here reflects what was actually asked for, so a report never claims
      // a dry run was a live one or the reverse.
      state: dryRun ? 'PREVIEW' : 'RUNNING',
      dryRun,
      startedById: startedById ?? null,
      totalReported: totalReported ?? null,
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });

// Apply one batch. Everything in a batch commits or nothing does, and the cursor
// moves with it — so a crash between batches loses no work and repeats none.
//
// `dryRun` is the difference between a preview and a migration, and it is checked
// here rather than at the caller: the counting, matching and exception logic is
// identical, which is what makes the preview trustworthy. A preview that walked a
// different code path would be predicting a different program's behaviour.
export const applyBatch = async (run, rows, { dryRun }) => {
  const counts = { fetched: 0, matchedExisting: 0, created: 0, skipped: 0, failed: 0, balanceSum: 0 };
  const exceptions = [];
  let lastRowNumber = null;

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      counts.fetched += 1;
      lastRowNumber = row.rowNumber;

      if (!row.ok) {
        counts.failed += 1;
        exceptions.push({
          runId: run.id,
          rowNumber: row.rowNumber,
          externalCustomerId: row.externalCustomerId ?? null,
          phoneRaw: row.phoneRaw ?? null,
          reason: row.reason,
        });
        continue;
      }

      if (row.points != null) counts.balanceSum += row.points;

      // Match on the phone, within the company. Customer(companyId, phone) is
      // unique, so this is the tenant-safe identity — a number belonging to
      // another company's customer is invisible here, which is what stops a
      // shared phone number leaking a balance across tenants.
      const existing = await tx.customer.findUnique({
        where: { companyId_phone: { companyId: run.companyId, phone: row.normalizedPhone } },
      });

      let customerId = existing?.id ?? null;

      if (existing) {
        counts.matchedExisting += 1;
        // The existing customer's name is NOT overwritten from the export. The
        // POS record was entered by somebody at a till who spoke to this person;
        // the export is a third party's copy. Overwriting 100,000 names from a
        // file is not a migration, it is a data loss event with a progress bar.
      } else if (dryRun) {
        counts.created += 1;
      } else {
        try {
          const made = await tx.customer.create({
            data: {
              companyId: run.companyId,
              // A loyalty profile with no name is normal; the phone is the
              // identity. Naming them after their number is honest and makes the
              // row searchable, where an empty string would not be.
              name: row.name || row.normalizedPhone,
              phone: row.normalizedPhone,
              email: row.email || null,
              note: 'Imported from the existing loyalty programme',
            },
          });
          customerId = made.id;
          counts.created += 1;
        } catch (err) {
          counts.failed += 1;
          exceptions.push({
            runId: run.id,
            rowNumber: row.rowNumber,
            externalCustomerId: row.externalCustomerId ?? null,
            phoneRaw: row.phoneRaw,
            reason: `could not create customer: ${String(err?.message ?? err).slice(0, 200)}`,
          });
          continue;
        }
      }

      // The link is what makes the balance findable later. Skipped when the export
      // carries no provider id: we can still recognise the customer by phone at
      // the till and look their balance up live, which is better than inventing
      // an id and pinning the wrong profile to them.
      if (!dryRun && customerId && row.externalCustomerId) {
        try {
          await tx.loyaltyProfileLink.upsert({
            where: { connectionId_customerId: { connectionId: run.connectionId, customerId } },
            create: {
              companyId: run.companyId,
              connectionId: run.connectionId,
              customerId,
              externalCustomerId: row.externalCustomerId,
              normalizedPhone: row.normalizedPhone,
              // Recorded as at the export, with its own timestamp. This is the
              // only balance figure this import writes anywhere, and it is
              // explicitly a cache — the till reads live from the provider.
              lastKnownBalance: row.points,
              balanceAsOf: new Date(),
              membershipTier: row.tier,
              pointsExpireAt: row.expiresAt,
              source: 'HISTORICAL_IMPORT',
            },
            update: {
              lastKnownBalance: row.points,
              balanceAsOf: new Date(),
              membershipTier: row.tier,
              pointsExpireAt: row.expiresAt,
            },
          });
        } catch (err) {
          // Almost always the (connectionId, externalCustomerId) unique index:
          // the export lists one provider profile against two phone numbers, or
          // two VEXO customers share a provider id. Reported, never resolved by
          // guessing — the wrong resolution lets two people spend one balance.
          counts.skipped += 1;
          exceptions.push({
            runId: run.id,
            rowNumber: row.rowNumber,
            externalCustomerId: row.externalCustomerId,
            phoneRaw: row.phoneRaw,
            reason: `loyalty profile ${row.externalCustomerId} could not be linked (it may already be linked to a different customer)`,
          });
        }
      }
    }

    if (exceptions.length) {
      await tx.loyaltyImportException.createMany({ data: exceptions });
    }

    await tx.loyaltyImportRun.update({
      where: { id: run.id },
      data: {
        fetched: { increment: counts.fetched },
        matchedExisting: { increment: counts.matchedExisting },
        created: { increment: counts.created },
        skipped: { increment: counts.skipped },
        failed: { increment: counts.failed },
        balanceSumPoints: { increment: counts.balanceSum },
        cursor: lastRowNumber != null ? String(lastRowNumber) : run.cursor,
        lastHeartbeatAt: new Date(),
      },
    });
  }, { timeout: 120_000 });

  return counts;
};

// Close the run and check its own arithmetic. An import that cannot account for
// every row it read has a bug, and saying so is more useful than a green tick.
export const finishRun = async (runId, { failed = false, error = null } = {}) => {
  const run = await prisma.loyaltyImportRun.findUnique({ where: { id: runId } });
  const accounted = run.matchedExisting + run.created + run.skipped + run.failed;
  const reconciles = accounted === run.fetched;
  return prisma.loyaltyImportRun.update({
    where: { id: runId },
    data: {
      state: failed ? 'FAILED' : run.dryRun ? 'PREVIEW' : 'COMPLETED',
      finishedAt: new Date(),
      lastError: error
        ? String(error).slice(0, 500)
        : reconciles
          ? null
          // Surfaced as the run's error even on an otherwise clean finish: a
          // total that does not add up means the report cannot be trusted, and
          // that is exactly when somebody is about to trust it.
          : `totals do not reconcile: ${run.fetched} rows read but ${accounted} accounted for`,
    },
  });
};

// The report. Built from stored counters rather than recounted, so the number the
// operator saw during the run is the number in the report.
export const runReport = async (runId) => {
  const run = await prisma.loyaltyImportRun.findUnique({
    where: { id: runId },
    include: { exceptions: { orderBy: { at: 'asc' }, take: 200 } },
  });
  if (!run) return null;
  const exceptionCount = await prisma.loyaltyImportException.count({ where: { runId } });
  const accounted = run.matchedExisting + run.created + run.skipped + run.failed;
  return {
    id: run.id,
    state: run.state,
    dryRun: run.dryRun,
    totals: {
      reportedByProvider: run.totalReported,
      rowsRead: run.fetched,
      matchedExistingCustomers: run.matchedExisting,
      customersCreated: run.created,
      skipped: run.skipped,
      failed: run.failed,
      accountedFor: accounted,
      reconciles: accounted === run.fetched,
      // Summed as reported in the export, for comparison against the total the
      // provider states. A points sum that does not match is the single best
      // signal that the export is partial.
      balanceSumPoints: Number(run.balanceSumPoints),
    },
    cursor: run.cursor,
    // Said in the report rather than left for the operator to work out from the
    // state name, because the moment this matters is the moment an import of
    // 100,000 records has just stopped and somebody is deciding whether to run
    // the whole thing again. The fingerprint has to be there too: a run from
    // before that column existed records no file and cannot be continued.
    canResume: ['RUNNING', 'PAUSED', 'FAILED'].includes(run.state) && Boolean(run.sourceFingerprint),
    resumeAfterRow: Number(run.cursor ?? 0),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastError: run.lastError,
    exceptionCount,
    // Capped, with the true count beside it, so a 588-row exception list is
    // visible as 588 even when only 200 are shown.
    exceptions: run.exceptions.map((e) => ({
      rowNumber: e.rowNumber,
      phoneRaw: e.phoneRaw,
      externalCustomerId: e.externalCustomerId,
      reason: e.reason,
    })),
    note:
      'This report describes the import of a provider-supplied export file. It is NOT evidence that the provider API can export history — Reelo publishes no such endpoint.',
  };
};
