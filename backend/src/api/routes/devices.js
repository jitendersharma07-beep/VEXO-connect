// ENTITLEMENT(DEVICES)
//
// Physical and browser devices. publicId ("VX-DVC-00002871") is minted at
// enrolment and never changes; the token is the credential.
//
// Lifecycle: PENDING (enrolled, no credential) → ACTIVE (activation minted a
// bearer token; only its hash is stored and the token itself is returned exactly
// once) → REVOKED (hash cleared, so the token dies at the very next request).
// Revocation is final: a machine coming back into service enrols as a new
// device, because "the same publicId, with a gap where we could not trust it" is
// an attribution history nobody can read honestly.

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { auditRequired } from '../../lib/audit.js';
import { hashSecret } from '../../lib/crypto.js';
import { mintDevicePublicId } from '../../lib/identity.js';
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

const publicDevice = (d) => ({
  id: d.id,
  publicId: d.publicId,
  type: d.type,
  name: d.name,
  status: d.status,
  branchId: d.branchId,
  branchName: d.branch?.name ?? null,
  terminalId: d.terminalId,
  terminalCode: d.terminal?.code ?? null,
  lastSeenAt: d.lastSeenAt,
  activatedAt: d.activatedAt,
  revokedAt: d.revokedAt,
  createdAt: d.createdAt,
});

const include = {
  branch: { select: { id: true, name: true, code: true } },
  terminal: { select: { id: true, code: true, name: true, branchId: true, status: true } },
};

router.get(
  '/',
  requireAction('device.read'),
  asyncHandler(async (req, res) => {
    const devices = await prisma.device.findMany({
      where: { companyId: req.companyScope.id, ...scopedBranchIdWhere(req) },
      include,
      orderBy: { createdAt: 'asc' },
    });
    res.json({ devices: devices.map(publicDevice) });
  }),
);

const DEVICE_TYPES = ['COUNTER', 'KDS', 'CUSTOMER_DISPLAY', 'HANDHELD', 'OTHER'];

// branchId is required, not optional. A device credential's whole security value
// is that it is scoped to one store, and a device with no store would be a token
// valid across the tenant.
const createSchema = z.object({
  branchId: z.string().trim().min(1),
  terminalId: z.string().trim().min(1).nullish(),
  type: z.enum(DEVICE_TYPES),
  name: z.string().trim().min(2).max(80),
});

// A terminal implies its store; naming both only works when they agree.
const resolveTerminal = async (branch, terminalId) => {
  if (!terminalId) return null;
  const terminal = await prisma.terminal.findFirst({
    where: { id: terminalId, branchId: branch.id },
    select: { id: true, code: true, status: true },
  });
  // Scoped to the already-resolved branch, so a till in a store the caller
  // cannot see is indistinguishable from one that does not exist.
  if (!terminal) throw badRequest('That till belongs to a different store', 'terminalId');
  if (terminal.status !== 'ACTIVE') throw badRequest('That till is disabled', 'terminalId');
  return terminal;
};

router.post(
  '/',
  requireAction('device.enrol'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const branch = await resolveStoreInScope(req, data.branchId);
    const terminal = await resolveTerminal(branch, data.terminalId);

    const device = await prisma.$transaction(async (tx) => {
      const publicId = await mintDevicePublicId(tx);
      const made = await tx.device.create({
        data: {
          companyId: branch.companyId,
          publicId,
          branchId: branch.id,
          terminalId: terminal?.id ?? null,
          type: data.type,
          name: data.name,
          enrolledById: req.user.id,
        },
        include,
      });
      await auditRequired(tx, req, {
        action: 'DEVICE_ENROL',
        entity: 'Device',
        entityId: made.id,
        companyId: req.companyScope.id,
        meta: {
          publicId: made.publicId,
          type: made.type,
          name: made.name,
          branchId: made.branchId,
          terminalId: made.terminalId,
        },
      });
      return made;
    });
    await auditPlatformWrite(req);
    res.status(201).json({ device: publicDevice(device) });
  }),
);

const loadDevice = async (req) => {
  const device = await prisma.device.findFirst({
    where: { id: req.params.id, companyId: req.companyScope.id, ...scopedBranchIdWhere(req) },
    include,
  });
  if (!device) throw notFound('Device not found');
  return device;
};

router.get(
  '/:id',
  requireAction('device.read'),
  asyncHandler(async (req, res) => {
    res.json({ device: publicDevice(await loadDevice(req)) });
  }),
);

// Activation, and re-activation of an ACTIVE device, which rotates the token —
// the old one dies the moment the new hash is written. The token appears in this
// response and nowhere else; it is not recoverable, not logged and not audited,
// the same discipline as a staff temporary password.
router.post(
  '/:id/activate',
  requireAction('device.activate'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const before = await loadDevice(req);
    if (before.status === 'REVOKED') {
      throw conflict('A revoked device cannot be re-activated. Enrol it as a new device.');
    }
    // The till is checked again here, not only at enrolment. A device can sit
    // PENDING for weeks and a till can be disabled in between, so activating on
    // the strength of the earlier check would mint a live credential onto a
    // counter the owner has since closed.
    if (before.terminal && before.terminal.status !== 'ACTIVE') {
      throw conflict('That till is disabled. Re-point this device at an open till before activating it.');
    }

    const deviceToken = `vxd_${randomBytes(24).toString('hex')}`;
    // The credential and the record of who minted it commit together. The
    // token is handed out once and never recoverable, so if the evidence were
    // lost here there would be a live device taking money that no row in the
    // system can explain the existence of.
    const device = await prisma.$transaction(async (tx) => {
      const updated = await tx.device.update({
        where: { id: before.id },
        data: { status: 'ACTIVE', tokenHash: hashSecret(deviceToken), activatedAt: new Date() },
        include,
      });
      await auditRequired(tx, req, {
        action: 'DEVICE_ACTIVATE',
        entity: 'Device',
        entityId: updated.id,
        companyId: req.companyScope.id,
        meta: { publicId: updated.publicId, rotated: before.status === 'ACTIVE' },
      });
      return updated;
    });
    await auditPlatformWrite(req);
    res.json({ device: publicDevice(device), deviceToken });
  }),
);

router.post(
  '/:id/revoke',
  requireAction('device.revoke'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const before = await loadDevice(req);
    if (before.status === 'REVOKED') throw conflict('This device is already revoked');

    const device = await prisma.$transaction(async (tx) => {
      const updated = await tx.device.update({
        where: { id: before.id },
        data: {
          status: 'REVOKED',
          // Clearing the hash is what actually kills the token. Status alone
          // would leave a working credential in the wild, relying on every
          // future code path remembering to check the status too.
          tokenHash: null,
          revokedAt: new Date(),
          revokedById: req.user.id,
        },
        include,
      });
      await auditRequired(tx, req, {
        action: 'DEVICE_REVOKE',
        entity: 'Device',
        entityId: updated.id,
        companyId: req.companyScope.id,
        meta: { publicId: updated.publicId, previousStatus: before.status },
      });
      return updated;
    });
    await auditPlatformWrite(req);
    res.json({ device: publicDevice(device) });
  }),
);

// publicId, type, branchId and the lifecycle fields are absent on purpose:
// identity and store binding are immutable, and activation and revocation have
// their own routes. Only the till within the same store and the human-readable
// name can move.
const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  terminalId: z.string().trim().min(1).nullish(),
});

router.patch(
  '/:id',
  requireAction('device.enrol'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const before = await loadDevice(req);
    if (before.status === 'REVOKED') {
      throw conflict('A revoked device is history — enrol a new device instead of editing it.');
    }

    const patch = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.terminalId !== undefined) {
      // Re-pointing changes where FUTURE transactions attribute; the rows
      // already written keep the till they were rung up on.
      const terminal = await resolveTerminal({ id: before.branchId }, data.terminalId);
      patch.terminalId = terminal?.id ?? null;
    }

    const device = await prisma.$transaction(async (tx) => {
      const updated = await tx.device.update({ where: { id: before.id }, data: patch, include });
      await auditRequired(tx, req, {
        action: 'DEVICE_UPDATE',
        entity: 'Device',
        entityId: updated.id,
        companyId: req.companyScope.id,
        meta: {
          publicId: updated.publicId,
          before: { name: before.name, terminalId: before.terminalId },
          after: { name: updated.name, terminalId: updated.terminalId },
        },
      });
      return updated;
    });
    await auditPlatformWrite(req);
    res.json({ device: publicDevice(device) });
  }),
);

export default router;
