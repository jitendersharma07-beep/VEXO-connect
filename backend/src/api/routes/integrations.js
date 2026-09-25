// Integration settings and operations (LANE providers).
// ENTITLEMENT(INTEGRATIONS)
//
// The permission-controlled surface behind the Integrations screen: what is
// configured, what it is mapped to, what it last did, what is stuck, and the
// controls to fix each of those. Eight actions, registered in lib/permissions.js
// — this router repeats no role lists.
//
// Three rules this file enforces that the screen cannot:
//
//   * A credential goes IN and never comes back out. There is no endpoint here
//     that returns a stored key, not to an owner, not to a platform operator.
//     What a caller gets is whether one exists and when it changed.
//
//   * Status is read, never asserted. Every status on this surface comes from
//     deriveStatus() reading columns that a real call wrote. "Test" writes
//     lastCheckedAt and, on success, lastSuccessfulSyncAt — so pressing Test is
//     the only way a connection becomes CONNECTED, and pressing it against a
//     provider that is down turns it back to ERROR.
//
//   * A destructive operation names itself. The loyalty import — the one action
//     here that touches a hundred thousand real customer records — defaults to a
//     dry run and requires an explicit confirmation string to do otherwise.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { integrationSecretsEnabled } from '../../config/env.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction, auditPlatformWrite } from '../../middleware/permissions.js';

import { PROVIDER_KEYS, providerSummary } from '../../lib/integrations/providers.js';
import {
  deriveStatus,
  publicConnection,
  prepareCredential,
  prepareConfig,
  sealFor,
  openFor,
  sanitizeProviderError,
  assertOperable,
} from '../../lib/integrations/index.js';
import { resolveAdapter } from '../../lib/integrations/adapters/index.js';
import { queueSummary, requeue } from '../../lib/integrations/queue.js';
import { reconcileDay } from '../../lib/integrations/aggregatorOrders.js';
import { LEDGER_KINDS, loadLedgerMap, sweepUnposted } from '../../lib/integrations/accounting.js';
import { runOnce } from '../../lib/integrations/worker.js';
import {
  BATCH_SIZE,
  createRun,
  applyBatch,
  finishRun,
  runReport,
  mapHeader,
  interpretRow,
  parseCsvLine,
  fingerprint,
  resumableFrom,
  resumeRun,
} from '../../lib/integrations/loyaltyImport.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const providerParam = z.enum(PROVIDER_KEYS);

// Loads the tenant's connection for a provider, or 404s. Scoped by companyId in
// the same query as the id, never checked afterwards, so there is no window in
// which another tenant's row has been read.
//
// Takes the two values it needs rather than the request, so the routes that name
// their provider in the path (/TALLY/ledgers, /REELO/import) can call it without
// fabricating a request object around a params override.
const connectionFor = async (companyId, provider) => {
  const connection = await prisma.integrationConnection.findUnique({
    where: { companyId_provider: { companyId, provider } },
  });
  if (!connection) throw notFound('This integration has not been set up yet');
  return connection;
};

const loadConnection = (req) =>
  connectionFor(req.companyScope.id, providerParam.parse(req.params.provider));

// --- catalogue ---------------------------------------------------------------

// What VEXO can integrate with, what each one's documentation actually supports,
// and what is blocking it. Read straight from providers.js so the screen and
// docs/INTEGRATION-VERIFICATION.md cannot drift apart: there is one inventory
// and both render it.
router.get(
  '/providers',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connections = await prisma.integrationConnection.findMany({
      where: { companyId: req.companyScope.id },
    });
    const byProvider = new Map(connections.map((c) => [c.provider, c]));
    res.json({
      // Surfaced so the screen can say "credential storage is not configured on
      // this deployment" rather than offering a form that will refuse to save.
      credentialStorageAvailable: integrationSecretsEnabled,
      providers: PROVIDER_KEYS.map((key) => ({
        ...providerSummary(key),
        connection: publicConnection(byProvider.get(key) ?? null),
        status: deriveStatus(byProvider.get(key) ?? null),
      })),
    });
  }),
);

// --- one integration ---------------------------------------------------------

router.get(
  '/:provider',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    const connection = await prisma.integrationConnection.findUnique({
      where: { companyId_provider: { companyId: req.companyScope.id, provider } },
      include: {
        outlets: { include: { branch: { select: { name: true, code: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!connection) {
      return res.json({
        provider: providerSummary(provider),
        connection: null,
        status: 'NOT_CONFIGURED',
        outlets: [],
        queue: null,
      });
    }
    res.json({
      provider: providerSummary(provider),
      connection: publicConnection(connection),
      status: deriveStatus(connection),
      outlets: connection.outlets.map((o) => ({
        id: o.id,
        externalOutletId: o.externalOutletId,
        externalOutletName: o.externalOutletName,
        branchId: o.branchId,
        branchName: o.branch?.name ?? null,
        branchCode: o.branch?.code ?? null,
        active: o.active,
        menuSyncedAt: o.menuSyncedAt,
        menuSyncStatus: o.menuSyncStatus,
      })),
      queue: await queueSummary(req.companyScope.id, connection.id),
    });
  }),
);

// Create or update the non-secret half: enabled, plus the provider's own config.
// Separate from the credential endpoint below so that changing a Tally company
// name does not require re-typing the host, and so the audit trail can tell
// "they edited settings" from "they replaced the key".
router.put(
  '/:provider',
  requireAction('integration.configure'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    // Refuses here rather than at the first call, with the provider's own
    // reason — an operator should be told "Swiggy publishes no partner API"
    // while they are still on the screen, not by a job that dies at midnight.
    assertOperable(provider);

    const { enabled, config } = z
      .object({ enabled: z.boolean().optional(), config: z.record(z.unknown()).optional() })
      .parse(req.body);

    let parsedConfig;
    try {
      parsedConfig = prepareConfig(provider, config ?? {});
    } catch (err) {
      throw badRequest(err?.errors?.[0]?.message ?? 'The configuration is not valid for this provider');
    }

    const connection = await prisma.integrationConnection.upsert({
      where: { companyId_provider: { companyId: req.companyScope.id, provider } },
      create: {
        companyId: req.companyScope.id,
        provider,
        enabled: enabled ?? false,
        config: parsedConfig,
      },
      update: { ...(enabled === undefined ? {} : { enabled }), config: parsedConfig },
    });

    await audit(req, {
      action: 'INTEGRATION_CONFIGURE',
      entity: 'IntegrationConnection',
      entityId: connection.id,
      companyId: req.companyScope.id,
      // Config is provider settings, not secrets — the credential schema is
      // what carries keys, and it never reaches this endpoint. Recorded so
      // "who changed the Tally company name" is answerable.
      meta: { provider, enabled: connection.enabled, config: parsedConfig },
    });
    await auditPlatformWrite(req);
    res.json({ connection: publicConnection(connection), status: deriveStatus(connection) });
  }),
);

// The credential. Goes in, never comes out.
router.put(
  '/:provider/credential',
  requireAction('integration.credential.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    assertOperable(provider);
    if (!integrationSecretsEnabled) {
      // Refusing is the honest answer. Storing it in the clear "for now" is how
      // a plaintext API key ends up in a database backup nobody remembers.
      throw conflict(
        'Credential storage is not configured on this deployment. Set POS_INTEGRATION_SECRET_KEY and restart before storing provider credentials.',
      );
    }

    let credential;
    try {
      credential = prepareCredential(provider, req.body?.credential ?? {});
    } catch (err) {
      throw badRequest(err?.errors?.[0]?.message ?? 'The credential is not valid for this provider');
    }

    const existing = await prisma.integrationConnection.findUnique({
      where: { companyId_provider: { companyId: req.companyScope.id, provider } },
    });
    if (!existing) throw notFound('Configure this integration before storing its credential');

    const sealed = sealFor(existing, credential);
    const connection = await prisma.integrationConnection.update({
      where: { id: existing.id },
      data: {
        credentialCiphertext: sealed.ciphertext,
        credentialFingerprint: sealed.fingerprint,
        credentialUpdatedAt: new Date(),
        // A new credential invalidates what the old one proved. Dropping back
        // to CONFIGURED is correct: nothing has yet been shown to work with
        // these keys, and leaving CONNECTED on screen would say otherwise.
        lastSuccessfulSyncAt: null,
        lastError: null,
        lastErrorAt: null,
      },
    });

    await audit(req, {
      action: 'INTEGRATION_CREDENTIAL_WRITE',
      entity: 'IntegrationConnection',
      entityId: connection.id,
      companyId: req.companyScope.id,
      // The fingerprint is an HMAC, not the key, and it is what makes "was this
      // actually rotated, or did they re-paste the same one" answerable without
      // ever storing the key anywhere an audit reader can reach.
      meta: { provider, fingerprint: sealed.fingerprint.slice(0, 16) },
    });
    await auditPlatformWrite(req);
    res.json({ connection: publicConnection(connection), status: deriveStatus(connection) });
  }),
);

// --- test --------------------------------------------------------------------

// The only way a connection becomes CONNECTED from this surface. Calls the
// provider for real and writes what came back — including a failure, which is a
// perfectly good outcome for a test and is recorded as one.
router.post(
  '/:provider/test',
  requireAction('integration.test'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    if (!connection.credentialCiphertext) throw conflict('Store a credential before testing');

    let credential;
    try {
      credential = openFor(connection);
    } catch {
      throw conflict('The stored credential could not be opened. Re-enter it and try again.');
    }

    const adapter = resolveAdapter(connection.provider);
    // A refusal, a timeout and a DNS failure all arrive here as a thrown
    // ProviderCallError, and every one of them is a legitimate ANSWER to "is
    // this configured correctly" — in fact the likeliest one. Letting it escape
    // would mean the single most common outcome of pressing Test reaches the
    // operator as "Something went wrong handling that request" and leaves
    // lastError empty, so the screen would still be showing whatever it said
    // before. Caught and folded into the same shape a returned failure takes.
    const result = await adapter
      .checkConnection({ credential, config: connection.config ?? {} })
      .catch((err) => ({ ok: false, detail: err?.message ?? String(err) }));
    const now = new Date();

    const updated = await prisma.integrationConnection.update({
      where: { id: connection.id },
      data: {
        lastCheckedAt: now,
        ...(result.ok
          ? { lastSuccessfulSyncAt: now, lastError: null, lastErrorAt: null }
          : { lastError: sanitizeProviderError(result.detail), lastErrorAt: now }),
      },
    });

    await audit(req, {
      action: 'INTEGRATION_TEST',
      entity: 'IntegrationConnection',
      entityId: connection.id,
      companyId: req.companyScope.id,
      meta: { provider: connection.provider, ok: result.ok, detail: sanitizeProviderError(result.detail) },
    });

    res.json({
      ok: result.ok,
      detail: sanitizeProviderError(result.detail),
      connection: publicConnection(updated),
      status: deriveStatus(updated),
    });
  }),
);

// --- outlet mapping ----------------------------------------------------------

// Explicit, one provider outlet to one store, both directions unique. No name
// matching and no "there is only one store so it must be that one": a wrongly
// inferred mapping sends another branch's orders to this kitchen, and the
// failure mode of getting it wrong is worse than the inconvenience of typing it.
router.put(
  '/:provider/outlets',
  requireAction('integration.outlet.map'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    const { outlets } = z
      .object({
        outlets: z
          .array(
            z.object({
              externalOutletId: z.string().trim().min(1).max(120),
              externalOutletName: z.string().trim().max(200).nullish(),
              branchId: z.string().min(1),
              active: z.boolean().optional(),
            }),
          )
          .max(500),
      })
      .parse(req.body);

    const branchIds = [...new Set(outlets.map((o) => o.branchId))];
    const found = await prisma.branch.count({
      where: { id: { in: branchIds }, companyId: req.companyScope.id },
    });
    if (found !== branchIds.length) throw badRequest('One or more stores do not exist');

    const externalIds = outlets.map((o) => o.externalOutletId);
    if (new Set(externalIds).size !== externalIds.length) {
      throw badRequest('The same provider outlet appears twice');
    }
    if (new Set(branchIds).size !== outlets.length) {
      throw badRequest('Two provider outlets cannot map to the same store');
    }

    await prisma.$transaction(async (tx) => {
      for (const outlet of outlets) {
        await tx.integrationOutlet.upsert({
          where: {
            connectionId_externalOutletId: {
              connectionId: connection.id,
              externalOutletId: outlet.externalOutletId,
            },
          },
          create: {
            companyId: req.companyScope.id,
            connectionId: connection.id,
            externalOutletId: outlet.externalOutletId,
            externalOutletName: outlet.externalOutletName ?? null,
            branchId: outlet.branchId,
            active: outlet.active ?? true,
          },
          update: {
            externalOutletName: outlet.externalOutletName ?? null,
            branchId: outlet.branchId,
            active: outlet.active ?? true,
          },
        });
      }
    });

    await audit(req, {
      action: 'INTEGRATION_OUTLET_MAP',
      entity: 'IntegrationConnection',
      entityId: connection.id,
      companyId: req.companyScope.id,
      meta: { provider: connection.provider, count: outlets.length },
    });
    await auditPlatformWrite(req);

    const rows = await prisma.integrationOutlet.findMany({
      where: { connectionId: connection.id },
      include: { branch: { select: { name: true, code: true } } },
    });
    res.json({
      outlets: rows.map((o) => ({
        id: o.id,
        externalOutletId: o.externalOutletId,
        externalOutletName: o.externalOutletName,
        branchId: o.branchId,
        branchName: o.branch?.name ?? null,
        active: o.active,
      })),
    });
  }),
);

// --- the work queue ----------------------------------------------------------

// What is stuck and why. DEAD first, because that is the list that needs a
// person; the rest is context.
router.get(
  '/:provider/jobs',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    const jobs = await prisma.integrationJob.findMany({
      where: { connectionId: connection.id, companyId: req.companyScope.id },
      orderBy: [{ status: 'asc' }, { nextAttemptAt: 'asc' }],
      take: 200,
    });
    res.json({
      summary: await queueSummary(req.companyScope.id, connection.id),
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        attempts: j.attempts,
        maxAttempts: j.maxAttempts,
        nextAttemptAt: j.nextAttemptAt,
        // Already sanitized on write, in queue.fail. Sanitized again rather
        // than trusted, because a column is not a boundary.
        lastError: sanitizeProviderError(j.lastError),
        lastErrorAt: j.lastErrorAt,
        externalRef: j.externalRef,
        createdAt: j.createdAt,
      })),
    });
  }),
);

router.post(
  '/:provider/jobs/:jobId/retry',
  requireAction('integration.job.retry'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    const job = await prisma.integrationJob.findFirst({
      where: { id: req.params.jobId, connectionId: connection.id, companyId: req.companyScope.id },
    });
    if (!job) throw notFound('Job not found');
    if (job.status === 'SUCCEEDED') throw conflict('That job already succeeded');

    await requeue(job.id);
    await audit(req, {
      action: 'INTEGRATION_JOB_RETRY',
      entity: 'IntegrationJob',
      entityId: job.id,
      companyId: req.companyScope.id,
      meta: { provider: connection.provider, kind: job.kind, attempts: job.attempts },
    });
    await auditPlatformWrite(req);

    // Run the pass inline so the operator sees the outcome of the button they
    // pressed, rather than a "queued" toast and a screen they have to refresh.
    // Scoped to this tenant, so a retry cannot drain another company's queue.
    const results = await runOnce({ companyId: req.companyScope.id, max: 5 });
    res.json({ retried: true, results });
  }),
);

// --- discrepancies -----------------------------------------------------------

// Recorded, never corrected — this is the list of places where our figures and
// the provider's disagree. Resolving one is an acknowledgement, not an edit:
// neither amount moves.
router.get(
  '/:provider/discrepancies',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    const state = z.enum(['OPEN', 'RESOLVED', 'IGNORED']).optional().parse(req.query.state);
    const rows = await prisma.integrationDiscrepancy.findMany({
      where: { connectionId: connection.id, companyId: req.companyScope.id, ...(state ? { state } : {}) },
      orderBy: { detectedAt: 'desc' },
      take: 200,
    });
    res.json({
      discrepancies: rows.map((d) => ({
        id: d.id,
        kind: d.kind,
        externalRef: d.externalRef,
        orderId: d.orderId,
        expectedAmount: d.expectedAmount === null ? null : String(d.expectedAmount),
        observedAmount: d.observedAmount === null ? null : String(d.observedAmount),
        detail: d.detail,
        state: d.state,
        detectedAt: d.detectedAt,
        resolvedAt: d.resolvedAt,
        resolutionNote: d.resolutionNote,
      })),
    });
  }),
);

router.post(
  '/:provider/discrepancies/:id/resolve',
  requireAction('integration.discrepancy.resolve'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    const { state, note } = z
      .object({
        state: z.enum(['RESOLVED', 'IGNORED']),
        // Required, and required for IGNORED too. "Why was this ignored" is
        // precisely the question an auditor asks six months later.
        note: z.string().trim().min(1).max(1000),
      })
      .parse(req.body);

    const found = await prisma.integrationDiscrepancy.findFirst({
      where: { id: req.params.id, connectionId: connection.id, companyId: req.companyScope.id },
    });
    if (!found) throw notFound('Discrepancy not found');
    if (found.state !== 'OPEN') throw conflict('That discrepancy has already been closed');

    const updated = await prisma.integrationDiscrepancy.update({
      where: { id: found.id },
      data: { state, resolvedAt: new Date(), resolvedById: req.user.id, resolutionNote: note },
    });
    await audit(req, {
      action: 'INTEGRATION_DISCREPANCY_RESOLVE',
      entity: 'IntegrationDiscrepancy',
      entityId: updated.id,
      companyId: req.companyScope.id,
      meta: { provider: connection.provider, kind: updated.kind, state },
    });
    await auditPlatformWrite(req);
    res.json({ discrepancy: { id: updated.id, state: updated.state, resolvedAt: updated.resolvedAt } });
  }),
);

// --- reconciliation ----------------------------------------------------------

// A day's aggregator orders, our totals and theirs, side by side and unnetted.
//
// NOT a settlement report, and it says so on the response. Neither Zomato nor
// Swiggy publishes a settlement or payout API, so what a payout actually was can
// only come from a statement the provider issues. Deriving one by summing orders
// and subtracting a commission percentage would produce a confident number that
// nobody has verified — which is worse than no number.
router.get(
  '/:provider/reconciliation',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connection = await loadConnection(req);
    const date = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
      .parse(req.query.date);
    res.json(await reconcileDay({ companyId: req.companyScope.id, connectionId: connection.id, isoDate: date }));
  }),
);

// --- accounting --------------------------------------------------------------

router.get(
  '/TALLY/ledgers',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connection = await connectionFor(req.companyScope.id, 'TALLY');
    const ledgers = await loadLedgerMap(prisma, {
      companyId: req.companyScope.id,
      connectionId: connection.id,
    });
    res.json({
      kinds: LEDGER_KINDS,
      ledgers: ledgers.all.map((l) => ({
        id: l.id,
        kind: l.kind,
        key: l.key,
        ledgerName: l.ledgerName,
        costCentre: l.costCentre,
      })),
    });
  }),
);

router.put(
  '/TALLY/ledgers',
  requireAction('integration.configure'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const connection = await connectionFor(req.companyScope.id, 'TALLY');
    const { ledgers } = z
      .object({
        ledgers: z
          .array(
            z.object({
              kind: z.enum(Object.keys(LEDGER_KINDS)),
              key: z.string().trim().min(1).max(120),
              // Tally ledger names are the client's own strings and may contain
              // almost anything. Bounded, trimmed, and never interpreted — the
              // XML builder escapes them at the wire.
              ledgerName: z.string().trim().min(1).max(200),
              costCentre: z.string().trim().max(200).nullish(),
            }),
          )
          .max(200),
      })
      .parse(req.body);

    await prisma.$transaction(async (tx) => {
      for (const l of ledgers) {
        await tx.accountingLedgerMap.upsert({
          where: {
            connectionId_kind_key: { connectionId: connection.id, kind: l.kind, key: l.key },
          },
          create: {
            companyId: req.companyScope.id,
            connectionId: connection.id,
            kind: l.kind,
            key: l.key,
            ledgerName: l.ledgerName,
            costCentre: l.costCentre ?? null,
          },
          update: { ledgerName: l.ledgerName, costCentre: l.costCentre ?? null },
        });
      }
    });

    await audit(req, {
      action: 'INTEGRATION_LEDGER_MAP',
      entity: 'IntegrationConnection',
      entityId: connection.id,
      companyId: req.companyScope.id,
      meta: { count: ledgers.length },
    });
    await auditPlatformWrite(req);

    // Mapping a ledger is the fix for every posting held on a missing ledger, so
    // the sweep runs here rather than waiting for a timer: the operator who just
    // supplied the answer should see the held bills clear.
    const swept = await sweepUnposted({ companyId: req.companyScope.id });
    res.json({ saved: ledgers.length, swept });
  }),
);

// Bills that should be in Tally and are not, with the reason for each. The
// operator-visible error queue the accounting side of this lane is required to
// have — built by asking the books' question, not the queue's.
router.get(
  '/TALLY/postings',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connection = await connectionFor(req.companyScope.id, 'TALLY');
    const rows = await prisma.accountingPosting.findMany({
      where: { connectionId: connection.id, companyId: req.companyScope.id },
      orderBy: { voucherDate: 'desc' },
      take: 200,
    });
    const counts = await prisma.accountingPosting.groupBy({
      by: ['status'],
      where: { connectionId: connection.id, companyId: req.companyScope.id },
      _count: { _all: true },
      _sum: { amount: true },
    });
    res.json({
      // Voucher count and value by state, which is what reconciles against
      // Tally's own day book. A count that matches and a sum that does not is a
      // different problem from neither matching, so both are reported.
      totals: counts.map((c) => ({
        status: c.status,
        count: c._count._all,
        amount: c._sum.amount === null ? '0' : String(c._sum.amount),
      })),
      postings: rows.map((p) => ({
        id: p.id,
        docType: p.docType,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        voucherType: p.voucherType,
        voucherNumber: p.voucherNumber,
        voucherDate: p.voucherDate,
        amount: String(p.amount),
        status: p.status,
        attempts: p.attempts,
        acknowledgedAt: p.acknowledgedAt,
        lastError: sanitizeProviderError(p.lastError),
      })),
    });
  }),
);

router.post(
  '/TALLY/sweep',
  requireAction('integration.job.retry'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const result = await sweepUnposted({ companyId: req.companyScope.id });
    await audit(req, {
      action: 'INTEGRATION_ACCOUNTING_SWEEP',
      entity: 'Company',
      entityId: req.companyScope.id,
      companyId: req.companyScope.id,
      meta: result,
    });
    res.json(result);
  }),
);

// --- loyalty import ----------------------------------------------------------

// The 100,000-customer path, and the most dangerous endpoint in this router.
//
// It consumes a file the client exports from their Reelo account. It is NOT an
// API sync, because Reelo publishes no bulk export endpoint — see the header of
// lib/integrations/loyaltyImport.js. The response says so explicitly rather than
// letting a green "import complete" imply a capability that does not exist.
//
// Dry run by default. A real run requires the operator to type the confirmation
// string, which exists so that the irreversible version of this cannot be
// reached by a mis-click on a form that was already filled in.
const IMPORT_CONFIRM = 'IMPORT CUSTOMERS';

router.post(
  '/REELO/import',
  requireAction('integration.import.run'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const connection = await connectionFor(req.companyScope.id, 'REELO');
    const { csv, dryRun, confirm, totalReported, resumeRunId } = z
      .object({
        // Bounded at roughly 150k rows of typical width. A file larger than this
        // is a signal to split it, not to raise the limit: one request holding
        // 40MB of customer records in memory is its own kind of outage.
        csv: z.string().min(1).max(40_000_000),
        dryRun: z.boolean().default(true),
        confirm: z.string().optional(),
        // What the client's Reelo dashboard says the total is, so finishRun can
        // report "we processed 99,412 of the 100,000 you told us to expect"
        // rather than only what it happened to find in the file.
        totalReported: z.number().int().min(0).nullish(),
        // The run to continue. Supplied instead of starting over, and checked
        // against the file before a single row is stepped over.
        resumeRunId: z.string().min(1).nullish(),
      })
      .parse(req.body);

    if (!dryRun && confirm !== IMPORT_CONFIRM) {
      throw badRequest(`Type "${IMPORT_CONFIRM}" to confirm a real import. Nothing has been changed.`);
    }

    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw badRequest('The file has no data rows');

    const header = mapHeader(parseCsvLine(lines[0]));
    if (!header) {
      throw badRequest(
        'No phone column was found in the header row. A phone number is the only field this import can match on.',
      );
    }

    const digest = fingerprint(csv);
    let run;
    let resumeAfterRow = 0;

    if (resumeRunId) {
      const prior = await prisma.loyaltyImportRun.findFirst({
        where: { id: resumeRunId, connectionId: connection.id, companyId: req.companyScope.id },
      });
      // Scoped to this company's connection before anything else is read, so a
      // run id guessed from another tenant is a 404 and not a resumable one.
      if (!prior) throw notFound('Import run not found');
      const verdict = resumableFrom(prior, csv);
      if (!verdict.ok) throw badRequest(verdict.reason);
      if (prior.dryRun !== dryRun) {
        throw badRequest(
          prior.dryRun
            ? 'That run was a preview. A real import cannot continue from it — start a real import from the beginning.'
            : 'That run was a real import. Continuing it as a preview would report progress that is not being made.',
        );
      }
      run = await resumeRun(prior.id);
      resumeAfterRow = verdict.resumeAfterRow;
    } else {
      run = await createRun(prisma, {
        companyId: req.companyScope.id,
        connectionId: connection.id,
        dryRun,
        startedById: req.user.id,
        totalReported: totalReported ?? lines.length - 1,
        sourceFingerprint: digest,
      });
    }

    await audit(req, {
      action: resumeRunId
        ? 'INTEGRATION_IMPORT_RESUME'
        : dryRun
          ? 'INTEGRATION_IMPORT_PREVIEW'
          : 'INTEGRATION_IMPORT_RUN',
      entity: 'LoyaltyImportRun',
      entityId: run.id,
      companyId: req.companyScope.id,
      meta: { rows: lines.length - 1, dryRun, resumeAfterRow },
    });

    try {
      let batch = [];
      // Row 1 is the header, so a cursor of N means line index N is the next
      // unread data row. Math.max keeps a fresh run and a cursor of 0 on the
      // same code path rather than making the normal case a special case.
      for (let i = Math.max(1, resumeAfterRow); i < lines.length; i += 1) {
        batch.push(interpretRow(parseCsvLine(lines[i]), header, i + 1));
        if (batch.length >= BATCH_SIZE) {
          await applyBatch(run, batch, { dryRun });
          batch = [];
        }
      }
      if (batch.length) await applyBatch(run, batch, { dryRun });
      await finishRun(run.id);
    } catch (err) {
      // The run is finished as FAILED with its cursor intact rather than
      // deleted. A half-finished import that nobody can see the shape of is the
      // worst possible outcome for 100,000 customer records; a half-finished
      // import with a row number to resume from is a recoverable one.
      await finishRun(run.id, { failed: true, error: String(err?.message ?? err) });
      throw err;
    }

    res.json(await runReport(run.id));
  }),
);

router.get(
  '/REELO/import/:runId',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const connection = await connectionFor(req.companyScope.id, 'REELO');
    const run = await prisma.loyaltyImportRun.findFirst({
      where: { id: req.params.runId, connectionId: connection.id, companyId: req.companyScope.id },
      select: { id: true },
    });
    if (!run) throw notFound('Import run not found');
    res.json(await runReport(run.id));
  }),
);

// --- audit trail -------------------------------------------------------------

// Who changed what on this surface. Its own endpoint because /reports/activity
// answers a different question — it selects discount, void and refund actions
// only, and gates on ROLE rather than on integration.read, so a Finance user who
// may read integrations would be refused there and a manager who may read it
// would see nothing about integrations in the rows they got back.
//
// Every meta value written by this router is non-secret by construction (the
// credential endpoint audits an HMAC fingerprint, never the key), but the
// projection below is an allow-list rather than a pass-through: meta is a JSON
// column that any future action here can write into, and "we checked at the time"
// is not a property that survives the next person adding a field. A key not on
// this list does not reach the browser.
const AUDIT_META_KEYS = [
  'provider',
  'enabled',
  'ok',
  'detail',
  'kind',
  'attempts',
  'rows',
  'dryRun',
  'resumeAfterRow',
  'outlets',
  'resolution',
  'posted',
  'skipped',
];

const AUDIT_ACTION_PREFIX = 'INTEGRATION_';

router.get(
  '/audit/trail',
  requireAction('integration.read'),
  asyncHandler(async (req, res) => {
    const { provider, limit } = z
      .object({ provider: providerParam.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);

    const rows = await prisma.posAuditLog.findMany({
      where: {
        companyId: req.companyScope.id,
        action: { startsWith: AUDIT_ACTION_PREFIX },
        // Filtering on the JSON path rather than on entityId: the entity differs
        // by action (a connection, a job, a discrepancy), and `provider` is the
        // one field every action here records.
        ...(provider ? { meta: { path: ['provider'], equals: provider } } : {}),
      },
      orderBy: { at: 'desc' },
      take: limit,
    });

    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at,
        action: r.action,
        actorEmail: r.actorEmail,
        actorRole: r.actorRole,
        entity: r.entity,
        entityId: r.entityId,
        meta: Object.fromEntries(
          Object.entries(r.meta ?? {}).filter(
            ([k, v]) => AUDIT_META_KEYS.includes(k) && v !== null && v !== undefined,
          ),
        ),
      })),
      // So the screen can say "the 50 most recent" instead of implying this is
      // everything that ever happened.
      limit,
      complete: rows.length < limit,
    });
  }),
);

export default router;
