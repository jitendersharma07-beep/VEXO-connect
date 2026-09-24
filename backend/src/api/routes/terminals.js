// ENTITLEMENT(DEVICES)
//
// Logical tills. A terminal is bound to one store for its whole life: a till
// that could move between stores would make a day's cash belong to two places
// at once, and the day close has no way to express that.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  resolveStoreInScope,
  scopedBranchIdWhere,
} from '../../middleware/permissions.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

const publicTerminal = (t) => ({
  id: t.id,
  branchId: t.branchId,
  branchName: t.branch?.name ?? null,
  code: t.code,
  name: t.name,
  status: t.status,
  deviceCount: t._count?.devices,
  createdAt: t.createdAt,
});

const include = {
  branch: { select: { id: true, name: true, code: true } },
  _count: { select: { devices: true } },
};

// Scoped, not filtered in the browser: a cashier asking for the list gets their
// own store's tills and nothing else, whatever the query string says.
router.get(
  '/',
  requireAction('terminal.read'),
  asyncHandler(async (req, res) => {
    const terminals = await prisma.terminal.findMany({
      where: { companyId: req.companyScope.id, ...scopedBranchIdWhere(req) },
      include,
      orderBy: [{ branchId: 'asc' }, { code: 'asc' }],
    });
    res.json({ terminals: terminals.map(publicTerminal) });
  }),
);

const createSchema = z.object({
  branchId: z.string().trim().min(1),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,12}$/, 'Code must be 1-12 letters, digits or dashes'),
  name: z.string().trim().min(1).max(80),
});

router.post(
  '/',
  requireAction('terminal.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const branch = await resolveStoreInScope(req, data.branchId);

    const exists = await prisma.terminal.findUnique({
      where: { branchId_code: { branchId: branch.id, code: data.code } },
      select: { id: true },
    });
    if (exists) throw conflict(`${branch.name} already has a till called ${data.code}`);

    const terminal = await prisma.terminal.create({
      // companyId comes from the resolved branch, never from the request body.
      data: { ...data, branchId: branch.id, companyId: branch.companyId },
      include,
    });
    await audit(req, {
      action: 'TERMINAL_CREATE',
      entity: 'Terminal',
      entityId: terminal.id,
      companyId: req.companyScope.id,
      meta: { code: terminal.code, name: terminal.name, branchId: branch.id },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ terminal: publicTerminal(terminal) });
  }),
);

// No `code` and no `branchId`. The code appears on day-close records and the
// store binding is the scope a device credential is checked against — moving
// either would re-label history that has already been written.
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

router.patch(
  '/:id',
  requireAction('terminal.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const existing = await prisma.terminal.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id, ...scopedBranchIdWhere(req) },
    });
    if (!existing) throw badRequest('Till not found');

    // Disabling a till is safe for history — the orders keep pointing at it —
    // but an active device would keep stamping a disabled till, so the devices
    // have to be dealt with first.
    if (data.status === 'DISABLED' && existing.status !== 'DISABLED') {
      const live = await prisma.device.count({
        where: { terminalId: existing.id, status: 'ACTIVE' },
      });
      if (live > 0) {
        throw badRequest(
          `Revoke or move the ${live} active device${live === 1 ? '' : 's'} on this till before disabling it`,
        );
      }
    }

    const terminal = await prisma.terminal.update({ where: { id: existing.id }, data, include });
    await audit(req, {
      action: 'TERMINAL_UPDATE',
      entity: 'Terminal',
      entityId: terminal.id,
      companyId: req.companyScope.id,
      meta: {
        code: terminal.code,
        before: { name: existing.name, status: existing.status },
        after: { name: terminal.name, status: terminal.status },
      },
    });
    await auditPlatformWrite(req);
    res.json({ terminal: publicTerminal(terminal) });
  }),
);

export default router;
