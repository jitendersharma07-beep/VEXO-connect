// Table QR management (TQ-3), staff side. Issue, regenerate, revoke and print
// the cards; accept or reject what guests send in; open and close visits.
//
// Tenancy is a foreign key, not a filter: TableQrCode, DiningVisit and
// QrSubmission all reference (tableId, branchId) and (branchId, companyId)
// compositely, so a row that mixes stores cannot be written even by a route that
// forgot to scope. The scoping below is still there — it decides what a caller
// may SEE, and a caller who asks for another tenant's table gets 404, never 403,
// because 403 would confirm the table exists.
//
// Nothing here ever accepts a base URL, a host or a company from the caller. The
// printed URL is built from POS_QR_BASE_URL and the token alone.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit, auditRequired } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  isBranchPinned,
  branchIdFilterFor,
} from '../../middleware/auth.js';
import { requireUsableLicense, denyPlatformSelling } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  scopedBranchIdWhere,
} from '../../middleware/permissions.js';
import { qrToPng } from '../../lib/qr/png.js';
import { renderQrCardsPdf } from '../../lib/qr/pdf.js';
import { buildCard, newJoinCode, newQrToken, placeLineOf, qrUrlFor } from '../../lib/qr/cards.js';
import { serializeOrder } from '../../lib/orders.js';
import { acceptSubmission, rejectSubmission, closeVisit } from '../../lib/qr/visits.js';

const router = Router();
// loadPermissionContext for every route: the reads below are scoped by the
// caller's stores just as the writes are.
router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// Issuing and revoking a card is a store-management action, not a till action: a
// cashier must not be able to mint a new ordering URL or take a table's card out
// of service. Accepting what a guest sent IS a till action, and is gated
// separately below.
//
// Both are now actions from lib/permissions.js rather than role lists. The lists
// these replace excluded CAPTAIN, which is the role that actually works a floor:
// `table.write` still keeps a captain (and a cashier) away from minting cards,
// while `order.create` lets one accept a guest basket — which is literally an
// order-creating act, since acceptSubmission cuts the KOT.
//
// denyPlatformSelling for the same reason as in orders.js: accepting a
// submission trades on a customer's till, and POS_SUPER_ADMIN holds every
// action in the model.
const canManage = [requireUsableLicense, denyPlatformSelling, requireAction('table.write')];
const canOperate = [requireUsableLicense, denyPlatformSelling, requireAction('order.create')];
// Reading the cards and the floor's visits. `table.read` is in every floor-going
// baseline, CAPTAIN included.
const canRead = [requireAction('table.read')];

const OPEN_STATUSES = ['OPEN', 'BILLED'];
const MAX_BULK_CARDS = 300;

const codedConflict = (code, message) => new AppError(409, code, message);

// Where a table sits according to the PUBLISHED layout — the floor plan the
// restaurant is actually running. A draft must never change what a card says.
const publishedPlacement = {
  where: { layout: { status: 'PUBLISHED' } },
  select: {
    area: { select: { id: true, name: true, kind: true, floor: { select: { id: true, name: true } } } },
  },
  take: 1,
};

const placeOf = (table) => {
  const area = table.placements?.[0]?.area ?? null;
  return { area, floor: area?.floor ?? null };
};

const publicQr = (qr, table) => {
  const { floor, area } = table ? placeOf(table) : { floor: null, area: null };
  const currentPlace = placeLineOf({ floor, area });
  return {
    id: qr.id,
    tableId: qr.tableId,
    tableName: table?.name ?? null,
    branchId: qr.branchId,
    status: qr.status,
    rotation: qr.rotation,
    // The URL is not a secret from staff — they have to be able to test the card
    // they just printed. It is never returned to a guest.
    url: qrUrlFor(qr.token),
    issuedAt: qr.createdAt,
    issuedById: qr.issuedById,
    revokedAt: qr.revokedAt,
    revokedReason: qr.revokedReason,
    lastPrintedAt: qr.lastPrintedAt,
    printedPlace: qr.printedPlace,
    currentPlace,
    // The one honest answer to "what happens when a table moves": the card still
    // resolves to the right table, and the text on it is now wrong. Staff decide
    // whether that matters enough to reprint.
    placeStale: Boolean(qr.printedPlace && currentPlace && qr.printedPlace !== currentPlace),
  };
};

const publicVisit = (v) => ({
  id: v.id,
  tableId: v.tableId,
  status: v.status,
  openedAt: v.openedAt,
  closedAt: v.closedAt,
  closedReason: v.closedReason,
  guestCount: v.guests?.length ?? v._count?.guests ?? 0,
  // Staff can read it out to a guest whose phone slept. Never returned publicly.
  joinCode: v.status === 'OPEN' ? v.joinCode : null,
  orderIds: (v.orders ?? []).map((o) => o.id),
});

const publicSubmission = (s) => ({
  id: s.id,
  tableId: s.tableId,
  tableName: s.table?.name ?? null,
  visitId: s.visitId,
  status: s.status,
  lineCount: s.lineCount,
  orderId: s.orderId,
  submittedAt: s.createdAt,
  decidedAt: s.decidedAt,
  decidedById: s.decidedById,
  rejectedReason: s.rejectedReason,
  lines: Array.isArray(s.payload?.lines) ? s.payload.lines : [],
});

/** Loads a table the caller is allowed to act on, or 404s. */
const loadTable = async (req, tableId) => {
  const table = await prisma.diningTable.findFirst({
    where: {
      id: tableId,
      branch: { companyId: req.companyScope.id },
      AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
    },
    include: {
      branch: { select: { id: true, name: true, city: true, status: true, companyId: true } },
      placements: publishedPlacement,
    },
  });
  if (!table) throw notFound('Table not found');
  return table;
};

// ---------------------------------------------------------------- issue/list

router.get(
  '/',
  ...canRead,
  asyncHandler(async (req, res) => {
    const branchId = isBranchPinned(req.user) ? req.user.branchId : req.query.branchId || undefined;
    const tables = await prisma.diningTable.findMany({
      where: {
        branch: { companyId: req.companyScope.id },
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
        ...(branchId ? { branchId } : {}),
      },
      include: {
        placements: publishedPlacement,
        qrCodes: { orderBy: { rotation: 'desc' } },
      },
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
    });

    res.json({
      tables: tables.map((t) => {
        const active = t.qrCodes.find((q) => q.status === 'ACTIVE') ?? null;
        const { floor, area } = placeOf(t);
        return {
          tableId: t.id,
          name: t.name,
          branchId: t.branchId,
          capacity: t.capacity,
          status: t.status,
          floorName: floor?.name ?? null,
          areaName: area?.name ?? null,
          qr: active ? publicQr(active, t) : null,
          revokedCount: t.qrCodes.filter((q) => q.status === 'REVOKED').length,
        };
      }),
    });
  }),
);

const issueSchema = z.object({
  tableIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_CARDS).optional(),
  tableId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  // Re-issue a table that already has a live card. Off by default: silently
  // rotating a card that is glued to a table would strand every guest currently
  // holding a menu on it.
  regenerate: z.boolean().optional(),
  reason: z.string().trim().max(200).optional(),
});

/**
 * Issues cards for one table or for a whole store. Regeneration is a rotation:
 * the old row is REVOKED and points forward at the new one, so a scan of a card
 * still on a table says "ask for a new code" rather than 404, and an order placed
 * on the old card keeps its evidence.
 */
router.post(
  '/issue',
  ...canManage,
  asyncHandler(async (req, res) => {
    const data = issueSchema.parse(req.body);
    const ids = data.tableIds ?? (data.tableId ? [data.tableId] : null);

    let tables;
    if (ids) {
      const unique = [...new Set(ids)];
      tables = await prisma.diningTable.findMany({
        where: {
          id: { in: unique },
          branch: { companyId: req.companyScope.id },
          AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
        },
        include: { placements: publishedPlacement },
      });
      if (tables.length !== unique.length) {
        // One 404 for the set. Naming which id was rejected would let a caller
        // enumerate another tenant's table ids one request at a time.
        throw notFound('One or more tables were not found');
      }
    } else {
      const branchId = isBranchPinned(req.user) ? req.user.branchId : data.branchId;
      if (!branchId) throw badRequest('branchId or tableIds is required', 'branchId');
      const branch = await prisma.branch.findFirst({
        where: { id: branchId, companyId: req.companyScope.id },
      });
      if (!branch) throw notFound('Branch not found');
      tables = await prisma.diningTable.findMany({
        where: { branchId, status: 'ACTIVE' },
        include: { placements: publishedPlacement },
        take: MAX_BULK_CARDS + 1,
      });
      if (tables.length > MAX_BULK_CARDS) {
        throw badRequest(`More than ${MAX_BULK_CARDS} tables; issue them a floor at a time`);
      }
    }
    if (tables.length === 0) throw badRequest('No tables to issue codes for');

    const retired = tables.filter((t) => t.status !== 'ACTIVE').map((t) => t.name);
    if (retired.length > 0) {
      throw codedConflict(
        'POS_QR_TABLE_RETIRED',
        `Cannot issue a code for a retired table: ${retired.join(', ')}`,
      );
    }

    const issued = [];
    const skipped = [];

    for (const table of tables) {
      // Per table, so one clash does not roll back a 200-card store export.
      const result = await prisma.$transaction(async (tx) => {
        const live = await tx.tableQrCode.findUnique({ where: { activeTableId: table.id } });
        if (live && !data.regenerate) return { skipped: true, qr: live };

        const { floor, area } = placeOf(table);
        const printedPlace = placeLineOf({ floor, area });
        const last = await tx.tableQrCode.findFirst({
          where: { tableId: table.id },
          orderBy: { rotation: 'desc' },
          select: { rotation: true },
        });

        if (live) {
          await tx.tableQrCode.update({
            where: { id: live.id },
            data: {
              status: 'REVOKED',
              activeTableId: null,
              revokedAt: new Date(),
              revokedById: req.user.id,
              revokedReason: data.reason || 'Regenerated',
            },
          });
        }

        const qr = await tx.tableQrCode.create({
          data: {
            companyId: req.companyScope.id,
            branchId: table.branchId,
            tableId: table.id,
            token: newQrToken(),
            status: 'ACTIVE',
            activeTableId: table.id,
            rotation: (last?.rotation ?? 0) + 1,
            issuedById: req.user.id,
            printedPlace,
          },
        });

        if (live) {
          await tx.tableQrCode.update({
            where: { id: live.id },
            data: { replacedById: qr.id },
          });
        }

        await auditRequired(tx, req, {
          action: live ? 'TABLE_QR_REGENERATE' : 'TABLE_QR_ISSUE',
          entity: 'TableQrCode',
          entityId: qr.id,
          companyId: req.companyScope.id,
          // The token is the credential in the URL. It is deliberately absent
          // from the audit row: an audit log is read by more people than the
          // cards are, and the row's own id is enough to find the card.
          meta: {
            tableId: table.id,
            tableName: table.name,
            branchId: table.branchId,
            rotation: qr.rotation,
            replaced: live?.id ?? null,
            reason: data.reason || null,
          },
        });
        return { skipped: false, qr };
      });

      if (result.skipped) skipped.push(publicQr(result.qr, table));
      else issued.push(publicQr(result.qr, table));
    }

    res.status(issued.length > 0 ? 201 : 200).json({
      issued,
      skipped,
      // Explicit, because "issued 4 of 6" is the thing the operator needs to see
      // and an array length in a payload is easy to miss.
      summary: { requested: tables.length, issued: issued.length, skipped: skipped.length },
    });
  }),
);

const revokeSchema = z.object({ reason: z.string().trim().min(1).max(200) });

router.post(
  '/:id/revoke',
  ...canManage,
  asyncHandler(async (req, res) => {
    const data = revokeSchema.parse(req.body);
    const qr = await prisma.tableQrCode.findFirst({
      where: {
        id: req.params.id,
        companyId: req.companyScope.id,
        ...(isBranchPinned(req.user) ? { branchId: req.user.branchId } : {}),
      },
      include: { table: { include: { placements: publishedPlacement } } },
    });
    if (!qr) throw notFound('QR code not found');
    if (qr.status === 'REVOKED') throw conflict('This code is already revoked');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.tableQrCode.update({
        where: { id: qr.id },
        data: {
          status: 'REVOKED',
          activeTableId: null,
          revokedAt: new Date(),
          revokedById: req.user.id,
          revokedReason: data.reason,
        },
      });
      await auditRequired(tx, req, {
        action: 'TABLE_QR_REVOKE',
        entity: 'TableQrCode',
        entityId: row.id,
        companyId: req.companyScope.id,
        meta: { tableId: qr.tableId, rotation: row.rotation, reason: data.reason },
      });
      return row;
    });

    // Orders already placed on this card keep pointing at it. Revoking stops the
    // card being usable; it does not rewrite what happened.
    res.json({ qr: publicQr(updated, qr.table) });
  }),
);

// ------------------------------------------------------------------ rendering

const pngQuery = z.object({
  scale: z.coerce.number().int().min(1).max(40).optional(),
  quiet: z.coerce.number().int().min(0).max(16).optional(),
});

const loadQrForPrint = async (req) => {
  const qr = await prisma.tableQrCode.findFirst({
    where: {
      id: req.params.id,
      companyId: req.companyScope.id,
      ...(isBranchPinned(req.user) ? { branchId: req.user.branchId } : {}),
    },
    include: {
      table: {
        include: {
          branch: { select: { id: true, name: true, city: true } },
          placements: publishedPlacement,
        },
      },
    },
  });
  if (!qr) throw notFound('QR code not found');
  return qr;
};

// Table names are free text and end up in a Content-Disposition filename, so
// everything outside [A-Za-z0-9_-] goes — a quote or a newline in there is a
// header-injection primitive, not a cosmetic problem.
const slug = (s) =>
  String(s ?? 'table')
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'table';

router.get(
  '/:id/png',
  ...canRead,
  asyncHandler(async (req, res) => {
    const { scale = 8, quiet = 4 } = pngQuery.parse(req.query);
    const qr = await loadQrForPrint(req);
    const card = buildCard({
      branch: qr.table.branch,
      table: qr.table,
      ...placeOf(qr.table),
      token: qr.token,
      rotation: qr.rotation,
    });
    const png = qrToPng(card.matrix, { scale, quiet });
    res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        // A card is a credential printed on paper. A shared cache holding it
        // would hand the next reader of that cache an ordering URL.
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="qr-${slug(qr.table.name)}-v${qr.rotation}.png"`,
      })
      .send(png);
  }),
);

const pdfQuery = z.object({
  layout: z.enum(['sheet', 'single']).optional(),
  branchId: z.string().min(1).optional(),
  tableIds: z.string().optional(),
  // Issue a card for any ACTIVE table that has none, so "print the store" is one
  // action rather than two. Off by default: printing must not mint credentials
  // as a side effect unless asked.
  issueMissing: z.coerce.boolean().optional(),
});

/**
 * The print-ready sheet. Cards are ordered by floor, then area, then table name
 * — the order someone walking the room puts them down in.
 */
router.get(
  '/export.pdf',
  ...canManage,
  asyncHandler(async (req, res) => {
    const q = pdfQuery.parse(req.query);
    const branchId = isBranchPinned(req.user) ? req.user.branchId : q.branchId;
    const wanted = q.tableIds ? q.tableIds.split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (!branchId && !wanted) throw badRequest('branchId or tableIds is required', 'branchId');

    const tables = await prisma.diningTable.findMany({
      where: {
        branch: { companyId: req.companyScope.id },
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
        ...(branchId ? { branchId } : {}),
        ...(wanted ? { id: { in: wanted } } : { status: 'ACTIVE' }),
      },
      include: {
        branch: { select: { id: true, name: true, city: true } },
        placements: publishedPlacement,
        qrCodes: { where: { status: 'ACTIVE' }, take: 1 },
      },
      take: MAX_BULK_CARDS + 1,
    });
    if (tables.length > MAX_BULK_CARDS) {
      throw badRequest(`More than ${MAX_BULK_CARDS} tables; export a floor at a time`);
    }
    if (tables.length === 0) throw notFound('No tables to export');

    const rows = [];
    for (const table of tables) {
      let qr = table.qrCodes[0] ?? null;
      if (!qr && q.issueMissing) {
        if (table.status !== 'ACTIVE') continue;
        const { floor, area } = placeOf(table);
        qr = await prisma.$transaction(async (tx) => {
          const last = await tx.tableQrCode.findFirst({
            where: { tableId: table.id },
            orderBy: { rotation: 'desc' },
            select: { rotation: true },
          });
          const created = await tx.tableQrCode.create({
            data: {
              companyId: req.companyScope.id,
              branchId: table.branchId,
              tableId: table.id,
              token: newQrToken(),
              status: 'ACTIVE',
              activeTableId: table.id,
              rotation: (last?.rotation ?? 0) + 1,
              issuedById: req.user.id,
              printedPlace: placeLineOf({ floor, area }),
            },
          });
          await auditRequired(tx, req, {
            action: 'TABLE_QR_ISSUE',
            entity: 'TableQrCode',
            entityId: created.id,
            companyId: req.companyScope.id,
            meta: { tableId: table.id, tableName: table.name, rotation: created.rotation, via: 'export' },
          });
          return created;
        });
      }
      if (!qr) continue;
      rows.push({ table, qr });
    }
    if (rows.length === 0) {
      throw codedConflict(
        'POS_QR_NONE_ISSUED',
        'None of these tables has a QR code yet. Issue the codes first, or re-export with issueMissing.',
      );
    }

    rows.sort((a, b) => {
      const pa = placeOf(a.table);
      const pb = placeOf(b.table);
      return (
        (pa.floor?.name ?? '').localeCompare(pb.floor?.name ?? '') ||
        (pa.area?.name ?? '').localeCompare(pb.area?.name ?? '') ||
        a.table.name.localeCompare(b.table.name, undefined, { numeric: true })
      );
    });

    const cards = rows.map(({ table, qr }) =>
      buildCard({
        branch: table.branch,
        table,
        ...placeOf(table),
        token: qr.token,
        rotation: qr.rotation,
      }),
    );
    const pdf = renderQrCardsPdf(cards, { layout: q.layout ?? 'sheet' });

    await prisma.tableQrCode.updateMany({
      where: { id: { in: rows.map((r) => r.qr.id) } },
      data: { lastPrintedAt: new Date() },
    });
    await audit(req, {
      action: 'TABLE_QR_EXPORT',
      entity: 'Branch',
      entityId: branchId ?? rows[0].table.branchId,
      companyId: req.companyScope.id,
      meta: { cards: cards.length, layout: q.layout ?? 'sheet', issueMissing: Boolean(q.issueMissing) },
    });

    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="vexo-table-qr-${cards.length}-cards.pdf"`,
      })
      .send(pdf);
  }),
);

// ------------------------------------------------------------ visits & inbox

router.get(
  '/visits',
  ...canOperate,
  asyncHandler(async (req, res) => {
    const branchId = isBranchPinned(req.user) ? req.user.branchId : req.query.branchId || undefined;
    const status = req.query.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
    const visits = await prisma.diningVisit.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(branchId ? { branchId } : {}),
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
        status,
      },
      include: { guests: { select: { id: true } }, orders: { select: { id: true } } },
      orderBy: { openedAt: 'desc' },
      take: 200,
    });
    res.json({ visits: visits.map(publicVisit) });
  }),
);

const closeSchema = z.object({ reason: z.string().trim().max(200).optional() });

/**
 * Closes a visit and isolates the next party. The printed card is untouched and
 * stays usable — that is the point of the visit being a separate row from the
 * card.
 */
router.post(
  '/visits/:id/close',
  ...canOperate,
  asyncHandler(async (req, res) => {
    const data = closeSchema.parse(req.body);
    const visit = await prisma.diningVisit.findFirst({
      where: {
        id: req.params.id,
        companyId: req.companyScope.id,
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
      },
    });
    if (!visit) throw notFound('Visit not found');
    const closed = await closeVisit({
      visit,
      req,
      closedById: req.user.id,
      reason: data.reason || 'Closed by staff',
    });
    res.json({ visit: publicVisit(closed) });
  }),
);

router.get(
  '/submissions',
  ...canOperate,
  asyncHandler(async (req, res) => {
    const branchId = isBranchPinned(req.user) ? req.user.branchId : req.query.branchId || undefined;
    const status = z
      .enum(['SUBMITTED', 'ACCEPTED', 'REJECTED'])
      .catch('SUBMITTED')
      .parse(req.query.status);
    const submissions = await prisma.qrSubmission.findMany({
      where: {
        companyId: req.companyScope.id,
        ...(branchId ? { branchId } : {}),
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
        status,
      },
      include: { table: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    res.json({ submissions: submissions.map(publicSubmission) });
  }),
);

/**
 * Acceptance. This is the moment a guest's basket becomes an order the kitchen
 * may see: the KOT is cut here, through the same routeKotItems the till uses, so
 * a QR order reaches the same stations by the same rules. Until this runs, the
 * order rows exist and the KDS has never heard of them.
 */
router.post(
  '/submissions/:id/accept',
  ...canOperate,
  asyncHandler(async (req, res) => {
    const submission = await prisma.qrSubmission.findFirst({
      where: {
        id: req.params.id,
        companyId: req.companyScope.id,
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
      },
    });
    if (!submission) throw notFound('Submission not found');
    const { order, kot } = await acceptSubmission({ submission, req, userId: req.user.id });
    res.json({ order: serializeOrder(order), kotId: kot?.id ?? null });
  }),
);

const rejectSchema = z.object({ reason: z.string().trim().min(1).max(200) });

router.post(
  '/submissions/:id/reject',
  ...canOperate,
  asyncHandler(async (req, res) => {
    const data = rejectSchema.parse(req.body);
    const submission = await prisma.qrSubmission.findFirst({
      where: {
        id: req.params.id,
        companyId: req.companyScope.id,
        AND: [branchIdFilterFor(req.user), scopedBranchIdWhere(req)],
      },
    });
    if (!submission) throw notFound('Submission not found');
    const updated = await rejectSubmission({ submission, req, userId: req.user.id, reason: data.reason });
    res.json({ submission: publicSubmission(updated) });
  }),
);

export default router;
