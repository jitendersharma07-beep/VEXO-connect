// Floor plan designer — TQ-1. Store → Floor → Dining Area → Table, with
// draft/preview/publish layout versions. Reads: every role (pinned roles see
// their own branch). Writes: CUSTOMER_OWNER anywhere, BRANCH_MANAGER in their
// own branch. Geometry lives on layout rows; DiningTable ids never change, so
// QR and order links survive renames and moves. Publishing refuses to drop a
// table that currently has an open or billed order; superseded published
// layouts are ARCHIVED, never deleted.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';

// 409s the designer must tell apart: reload-and-retry vs a business refusal.
const codedConflict = (code, message) => new AppError(409, code, message);
import { audit } from '../../lib/audit.js';
import {
  requirePosAuth,
  resolveCompanyScope,
  isBranchPinned,
  branchIdFilterFor,
} from '../../middleware/auth.js';
import { requireRole, requireUsableLicense } from '../../middleware/rbac.js';
import { TABLE_STATE_INCLUDE, tableStateOf } from '../../lib/qr/tableState.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope);

const canWrite = [requireRole('CUSTOMER_OWNER', 'BRANCH_MANAGER'), requireUsableLicense];

const OPEN_STATUSES = ['OPEN', 'BILLED'];
// express.json is capped at 1mb; leave headroom for the rest of the payload.
const MAX_BACKGROUND_CHARS = 700_000;

const publicArea = (a) => ({
  id: a.id,
  floorId: a.floorId,
  name: a.name,
  kind: a.kind,
  sortOrder: a.sortOrder,
  status: a.status,
});

const publicFloor = (f) => ({
  id: f.id,
  branchId: f.branchId,
  name: f.name,
  sortOrder: f.sortOrder,
  status: f.status,
  areas: (f.areas || []).map(publicArea),
  hasDraft: (f.layouts || []).some((l) => l.status === 'DRAFT'),
  publishedVersion: (f.layouts || []).find((l) => l.status === 'PUBLISHED')?.version ?? null,
});

const publicLayout = (l) => ({
  id: l.id,
  floorId: l.floorId,
  status: l.status,
  version: l.version,
  revision: l.revision,
  gridSize: l.gridSize,
  canvasWidth: l.canvasWidth,
  canvasHeight: l.canvasHeight,
  backgroundImage: l.backgroundImage,
  publishedAt: l.publishedAt,
  tables: (l.tables || []).map((p) => ({
    tableId: p.tableId,
    name: p.table?.name,
    capacity: p.table?.capacity,
    tableStatus: p.table?.status,
    occupied: (p.table?.orders?.length ?? 0) > 0,
    // Service state derived from the rows the till, the kitchen and the payment
    // path wrote — never stored, never settable, and never advanced by a scan.
    // `occupied` above is kept as it was: it is what an open order means and
    // existing callers read it.
    ...(p.table ? { service: tableStateOf(p.table) } : {}),
    areaId: p.areaId,
    shape: p.shape,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    seats: p.seats,
  })),
  objects: (l.objects || []).map((o) => ({
    id: o.id,
    kind: o.kind,
    label: o.label,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    rotation: o.rotation,
  })),
});

// The open-order read the designer already did is now the same read the service
// state needs, so there is one of it. `take: 1` is gone deliberately: a table can
// carry a staff-rung order alongside a guest's, and the amount owing is the sum
// of both. `occupied` still means exactly what it meant — at least one open or
// billed order — because the WHERE clause is unchanged.
const LAYOUT_INCLUDE = {
  tables: { include: { table: { include: TABLE_STATE_INCLUDE } } },
  objects: true,
};

const loadFloor = async (req) => {
  const floor = await prisma.floor.findFirst({
    where: { id: req.params.id, branch: { companyId: req.companyScope.id } },
    include: { areas: { orderBy: { sortOrder: 'asc' } }, layouts: { where: { status: { in: ['DRAFT', 'PUBLISHED'] } } } },
  });
  if (!floor) throw notFound('Floor not found');
  if (isBranchPinned(req.user) && floor.branchId !== req.user.branchId) {
    throw forbidden('Your role is limited to your own branch');
  }
  return floor;
};

// ---------- floors ----------

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const queryBranch = req.query.branchId ? String(req.query.branchId) : null;
    const floors = await prisma.floor.findMany({
      where: {
        branch: { companyId: req.companyScope.id },
        ...branchIdFilterFor(req.user),
        ...(!isBranchPinned(req.user) && queryBranch ? { branchId: queryBranch } : {}),
      },
      include: {
        areas: { orderBy: { sortOrder: 'asc' } },
        layouts: { where: { status: { in: ['DRAFT', 'PUBLISHED'] } } },
      },
      orderBy: [{ branchId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ floors: floors.map(publicFloor) });
  }),
);

const floorCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  branchId: z.string().min(1).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

router.post(
  '/',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const data = floorCreateSchema.parse(req.body);
    const branchId = isBranchPinned(req.user) ? req.user.branchId : data.branchId;
    if (!branchId) throw badRequest('branchId is required', 'branchId');
    const branch = await prisma.branch.findFirst({
      where: { id: branchId, companyId: req.companyScope.id },
    });
    if (!branch) throw notFound('Branch not found');
    if (branch.status !== 'ACTIVE') throw conflict('Branch is closed');
    const clash = await prisma.floor.findUnique({
      where: { branchId_name: { branchId, name: data.name } },
    });
    if (clash) throw conflict(`Floor "${data.name}" already exists in this branch`);
    const floor = await prisma.floor.create({
      data: { branchId, name: data.name, sortOrder: data.sortOrder ?? 0 },
    });
    await audit(req, {
      action: 'FLOOR_CREATE',
      entity: 'Floor',
      entityId: floor.id,
      companyId: req.companyScope.id,
      meta: { name: floor.name, branchId },
    });
    res.status(201).json({ floor: publicFloor({ ...floor, areas: [], layouts: [] }) });
  }),
);

const floorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});

router.patch(
  '/:id',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const data = floorUpdateSchema.parse(req.body);
    if (data.status === 'RETIRED') {
      const occupied = await prisma.diningTable.count({
        where: {
          placements: { some: { layout: { floorId: floor.id, status: 'PUBLISHED' } } },
          orders: { some: { status: { in: OPEN_STATUSES } } },
        },
      });
      if (occupied > 0) {
        throw conflict('Floor has occupied tables on its published layout; settle them first');
      }
    }
    if (data.name && data.name !== floor.name) {
      const clash = await prisma.floor.findUnique({
        where: { branchId_name: { branchId: floor.branchId, name: data.name } },
      });
      if (clash) throw conflict(`Floor "${data.name}" already exists in this branch`);
    }
    const updated = await prisma.floor.update({
      where: { id: floor.id },
      data,
      include: { areas: { orderBy: { sortOrder: 'asc' } }, layouts: { where: { status: { in: ['DRAFT', 'PUBLISHED'] } } } },
    });
    await audit(req, {
      action: 'FLOOR_UPDATE',
      entity: 'Floor',
      entityId: floor.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ floor: publicFloor(updated) });
  }),
);

// ---------- areas ----------

const areaCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(['INDOOR', 'OUTDOOR', 'PATIO', 'ROOFTOP', 'CUSTOM']).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

router.post(
  '/:id/areas',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const data = areaCreateSchema.parse(req.body);
    const clash = await prisma.diningArea.findUnique({
      where: { floorId_name: { floorId: floor.id, name: data.name } },
    });
    if (clash) throw conflict(`Area "${data.name}" already exists on this floor`);
    const area = await prisma.diningArea.create({
      data: {
        floorId: floor.id,
        name: data.name,
        kind: data.kind ?? 'INDOOR',
        sortOrder: data.sortOrder ?? 0,
      },
    });
    await audit(req, {
      action: 'AREA_CREATE',
      entity: 'DiningArea',
      entityId: area.id,
      companyId: req.companyScope.id,
      meta: { name: area.name, kind: area.kind, floorId: floor.id },
    });
    res.status(201).json({ area: publicArea(area) });
  }),
);

const areaUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  kind: z.enum(['INDOOR', 'OUTDOOR', 'PATIO', 'ROOFTOP', 'CUSTOM']).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});

router.patch(
  '/:id/areas/:areaId',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const area = await prisma.diningArea.findFirst({
      where: { id: req.params.areaId, floorId: floor.id },
    });
    if (!area) throw notFound('Area not found');
    const data = areaUpdateSchema.parse(req.body);
    if (data.status === 'RETIRED') {
      const referenced = await prisma.floorLayoutTable.count({
        where: { areaId: area.id, layout: { status: { in: ['DRAFT', 'PUBLISHED'] } } },
      });
      if (referenced > 0) throw conflict('Area still holds tables on a draft or published layout');
    }
    if (data.name && data.name !== area.name) {
      const clash = await prisma.diningArea.findUnique({
        where: { floorId_name: { floorId: floor.id, name: data.name } },
      });
      if (clash) throw conflict(`Area "${data.name}" already exists on this floor`);
    }
    const updated = await prisma.diningArea.update({ where: { id: area.id }, data });
    await audit(req, {
      action: 'AREA_UPDATE',
      entity: 'DiningArea',
      entityId: area.id,
      companyId: req.companyScope.id,
      meta: data,
    });
    res.json({ area: publicArea(updated) });
  }),
);

// ---------- layouts ----------

router.get(
  '/:id/layout',
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const mode = req.query.mode === 'draft' ? 'DRAFT' : 'PUBLISHED';
    const layout = await prisma.floorLayout.findFirst({
      where: { floorId: floor.id, status: mode },
      include: LAYOUT_INCLUDE,
    });
    res.json({
      floor: publicFloor(floor),
      layout: layout ? publicLayout(layout) : null,
    });
  }),
);

// Create a draft — a copy of the published layout, or empty. One draft per
// floor; 409 tells a second editor a draft already exists.
router.post(
  '/:id/draft',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const existing = await prisma.floorLayout.findFirst({
      where: { floorId: floor.id, status: 'DRAFT' },
    });
    if (existing) throw codedConflict('POS_DRAFT_EXISTS', 'A draft already exists for this floor');
    const published = await prisma.floorLayout.findFirst({
      where: { floorId: floor.id, status: 'PUBLISHED' },
      include: { tables: true, objects: true },
    });
    const draft = await prisma.$transaction(async (tx) => {
      const created = await tx.floorLayout.create({
        data: {
          floorId: floor.id,
          status: 'DRAFT',
          gridSize: published?.gridSize ?? 20,
          canvasWidth: published?.canvasWidth ?? 1200,
          canvasHeight: published?.canvasHeight ?? 800,
          backgroundImage: published?.backgroundImage ?? null,
          createdById: req.user.id,
        },
      });
      if (published) {
        if (published.tables.length) {
          await tx.floorLayoutTable.createMany({
            data: published.tables.map((t) => ({
              layoutId: created.id,
              tableId: t.tableId,
              areaId: t.areaId,
              shape: t.shape,
              x: t.x,
              y: t.y,
              width: t.width,
              height: t.height,
              rotation: t.rotation,
              seats: t.seats,
            })),
          });
        }
        if (published.objects.length) {
          await tx.floorLayoutObject.createMany({
            data: published.objects.map((o) => ({
              layoutId: created.id,
              kind: o.kind,
              label: o.label,
              x: o.x,
              y: o.y,
              width: o.width,
              height: o.height,
              rotation: o.rotation,
            })),
          });
        }
      }
      return created;
    });
    const full = await prisma.floorLayout.findUnique({
      where: { id: draft.id },
      include: LAYOUT_INCLUDE,
    });
    await audit(req, {
      action: 'LAYOUT_DRAFT_CREATE',
      entity: 'FloorLayout',
      entityId: draft.id,
      companyId: req.companyScope.id,
      meta: { floorId: floor.id, copiedFrom: published?.id ?? null },
    });
    res.status(201).json({ layout: publicLayout(full) });
  }),
);

const geom = {
  x: z.number().int().min(-5000).max(10000),
  y: z.number().int().min(-5000).max(10000),
  width: z.number().int().min(10).max(2000),
  height: z.number().int().min(10).max(2000),
  rotation: z.number().int().min(0).max(359),
};

const draftTableSchema = z.object({
  // Existing table keeps its id; a new one is created from `create`.
  tableId: z.string().min(1).optional(),
  create: z
    .object({
      name: z.string().trim().min(1).max(40),
      capacity: z.number().int().min(1).max(99).optional(),
    })
    .optional(),
  rename: z.string().trim().min(1).max(40).optional(),
  areaId: z.string().min(1).nullish(),
  shape: z.enum(['ROUND', 'SQUARE', 'RECT']),
  seats: z.number().int().min(1).max(99).nullish(),
  ...geom,
});

const draftObjectSchema = z.object({
  kind: z.enum(['WALL', 'ENTRANCE', 'PILLAR', 'KITCHEN', 'COUNTER']),
  label: z.string().trim().max(40).nullish(),
  ...geom,
});

const draftSaveSchema = z.object({
  revision: z.number().int().min(0),
  gridSize: z.number().int().min(5).max(200).optional(),
  canvasWidth: z.number().int().min(200).max(10000).optional(),
  canvasHeight: z.number().int().min(200).max(10000).optional(),
  backgroundImage: z.string().max(MAX_BACKGROUND_CHARS).nullish(),
  tables: z.array(draftTableSchema).max(500),
  objects: z.array(draftObjectSchema).max(500),
});

router.put(
  '/:id/draft',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const data = draftSaveSchema.parse(req.body);
    if (data.backgroundImage && !data.backgroundImage.startsWith('data:image/')) {
      throw badRequest('backgroundImage must be a data:image/* URL', 'backgroundImage');
    }
    const draft = await prisma.floorLayout.findFirst({
      where: { floorId: floor.id, status: 'DRAFT' },
    });
    if (!draft) throw notFound('No draft exists for this floor');

    const areaIds = new Set(
      (await prisma.diningArea.findMany({ where: { floorId: floor.id }, select: { id: true } })).map(
        (a) => a.id,
      ),
    );
    for (const t of data.tables) {
      if (t.areaId && !areaIds.has(t.areaId)) throw badRequest('Unknown areaId on this floor', 'areaId');
      if (!t.tableId && !t.create) throw badRequest('Each table needs tableId or create', 'tables');
    }

    const result = await prisma.$transaction(async (tx) => {
      // Optimistic concurrency: the revision the editor loaded must still be
      // current, or a concurrent edit landed in between → 409.
      const guarded = await tx.floorLayout.updateMany({
        where: { id: draft.id, status: 'DRAFT', revision: data.revision },
        data: {
          revision: { increment: 1 },
          updatedById: req.user.id,
          ...(data.gridSize !== undefined ? { gridSize: data.gridSize } : {}),
          ...(data.canvasWidth !== undefined ? { canvasWidth: data.canvasWidth } : {}),
          ...(data.canvasHeight !== undefined ? { canvasHeight: data.canvasHeight } : {}),
          ...(data.backgroundImage !== undefined ? { backgroundImage: data.backgroundImage } : {}),
        },
      });
      if (guarded.count === 0) return { conflict: true };

      const placements = [];
      for (const t of data.tables) {
        let tableId = t.tableId ?? null;
        if (tableId) {
          const table = await tx.diningTable.findFirst({
            where: { id: tableId, branchId: floor.branchId },
            include: { orders: { where: { status: { in: OPEN_STATUSES } }, select: { id: true }, take: 1 } },
          });
          if (!table) throw notFound('Table not found in this branch');
          if (t.rename && t.rename !== table.name) {
            if (table.orders.length > 0) {
              throw conflict(`Table "${table.name}" has an open order; settle it before renaming`);
            }
            const clash = await tx.diningTable.findUnique({
              where: { branchId_name: { branchId: floor.branchId, name: t.rename } },
            });
            if (clash && clash.id !== tableId) {
              throw conflict(`Table "${t.rename}" already exists in this branch`);
            }
            await tx.diningTable.update({ where: { id: tableId }, data: { name: t.rename } });
          }
        } else {
          const clash = await tx.diningTable.findUnique({
            where: { branchId_name: { branchId: floor.branchId, name: t.create.name } },
          });
          if (clash) throw conflict(`Table "${t.create.name}" already exists in this branch`);
          const created = await tx.diningTable.create({
            data: {
              branchId: floor.branchId,
              name: t.create.name,
              capacity: t.create.capacity ?? t.seats ?? null,
            },
          });
          tableId = created.id;
        }
        placements.push({
          layoutId: draft.id,
          tableId,
          areaId: t.areaId ?? null,
          shape: t.shape,
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
          rotation: t.rotation,
          seats: t.seats ?? null,
        });
      }
      const seen = new Set();
      for (const p of placements) {
        if (seen.has(p.tableId)) throw conflict('The same table appears twice in the layout');
        seen.add(p.tableId);
      }
      await tx.floorLayoutTable.deleteMany({ where: { layoutId: draft.id } });
      if (placements.length) await tx.floorLayoutTable.createMany({ data: placements });
      await tx.floorLayoutObject.deleteMany({ where: { layoutId: draft.id } });
      if (data.objects.length) {
        await tx.floorLayoutObject.createMany({
          data: data.objects.map((o) => ({
            layoutId: draft.id,
            kind: o.kind,
            label: o.label ?? null,
            x: o.x,
            y: o.y,
            width: o.width,
            height: o.height,
            rotation: o.rotation,
          })),
        });
      }
      return { conflict: false };
    });

    if (result.conflict) {
      throw codedConflict('POS_LAYOUT_CONFLICT', 'Someone else changed this draft; reload before saving');
    }
    const full = await prisma.floorLayout.findUnique({
      where: { id: draft.id },
      include: LAYOUT_INCLUDE,
    });
    await audit(req, {
      action: 'LAYOUT_DRAFT_SAVE',
      entity: 'FloorLayout',
      entityId: draft.id,
      companyId: req.companyScope.id,
      meta: { floorId: floor.id, tables: data.tables.length, objects: data.objects.length },
    });
    res.json({ layout: publicLayout(full) });
  }),
);

router.delete(
  '/:id/draft',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const draft = await prisma.floorLayout.findFirst({
      where: { floorId: floor.id, status: 'DRAFT' },
    });
    if (!draft) throw notFound('No draft exists for this floor');
    await prisma.$transaction([
      prisma.floorLayoutTable.deleteMany({ where: { layoutId: draft.id } }),
      prisma.floorLayoutObject.deleteMany({ where: { layoutId: draft.id } }),
      prisma.floorLayout.delete({ where: { id: draft.id } }),
    ]);
    await audit(req, {
      action: 'LAYOUT_DRAFT_DISCARD',
      entity: 'FloorLayout',
      entityId: draft.id,
      companyId: req.companyScope.id,
      meta: { floorId: floor.id },
    });
    res.json({ ok: true });
  }),
);

const publishSchema = z.object({ revision: z.number().int().min(0) });

router.post(
  '/:id/draft/publish',
  ...canWrite,
  asyncHandler(async (req, res) => {
    const floor = await loadFloor(req);
    const { revision } = publishSchema.parse(req.body);
    const outcome = await prisma.$transaction(async (tx) => {
      const draft = await tx.floorLayout.findFirst({
        where: { floorId: floor.id, status: 'DRAFT' },
        include: { tables: true },
      });
      if (!draft) return { missing: true };
      if (draft.revision !== revision) return { conflict: true };
      const published = await tx.floorLayout.findFirst({
        where: { floorId: floor.id, status: 'PUBLISHED' },
        include: { tables: true },
      });
      // Occupied-table guard: a table on the live layout with an open or
      // billed order must survive into the new layout, or the party at it is
      // orphaned off every screen.
      if (published) {
        const draftIds = new Set(draft.tables.map((t) => t.tableId));
        const dropped = published.tables.filter((t) => !draftIds.has(t.tableId));
        if (dropped.length) {
          const occupied = await tx.diningTable.findMany({
            where: {
              id: { in: dropped.map((t) => t.tableId) },
              orders: { some: { status: { in: OPEN_STATUSES } } },
            },
            select: { name: true },
          });
          if (occupied.length) {
            return { orphans: occupied.map((t) => t.name) };
          }
        }
      }
      const nextVersion =
        ((await tx.floorLayout.aggregate({
          where: { floorId: floor.id },
          _max: { version: true },
        }))._max.version ?? 0) + 1;
      if (published) {
        await tx.floorLayout.update({
          where: { id: published.id },
          data: { status: 'ARCHIVED', archivedAt: new Date() },
        });
      }
      await tx.floorLayout.update({
        where: { id: draft.id },
        data: {
          status: 'PUBLISHED',
          version: nextVersion,
          publishedAt: new Date(),
          updatedById: req.user.id,
        },
      });
      return { publishedId: draft.id, version: nextVersion };
    });
    if (outcome.missing) throw notFound('No draft exists for this floor');
    if (outcome.conflict) {
      throw codedConflict('POS_LAYOUT_CONFLICT', 'Someone else changed this draft; reload before publishing');
    }
    if (outcome.orphans) {
      throw codedConflict(
        'POS_OCCUPIED_TABLES',
        `Occupied tables cannot be removed: ${outcome.orphans.join(', ')}`,
      );
    }
    const full = await prisma.floorLayout.findUnique({
      where: { id: outcome.publishedId },
      include: LAYOUT_INCLUDE,
    });
    await audit(req, {
      action: 'LAYOUT_PUBLISH',
      entity: 'FloorLayout',
      entityId: outcome.publishedId,
      companyId: req.companyScope.id,
      meta: { floorId: floor.id, version: outcome.version },
    });
    res.json({ layout: publicLayout(full) });
  }),
);

export default router;
