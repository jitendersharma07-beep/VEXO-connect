import { prisma } from './prisma.js';
import { logger } from './logger.js';

export const clientIp = (req) =>
  req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || null;

// Audit writes must never take the request down with them.
export const audit = async (req, { action, entity, entityId, companyId, meta }) => {
  try {
    await prisma.posAuditLog.create({
      data: {
        action,
        entity: entity ?? null,
        entityId: entityId ?? null,
        companyId: companyId ?? req.user?.companyId ?? null,
        actorId: req.user?.id ?? null,
        actorEmail: req.user?.email ?? null,
        ip: clientIp(req),
        meta: meta ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, action }, 'pos audit write failed');
  }
};
