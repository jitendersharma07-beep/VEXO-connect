import { prisma } from './prisma.js';
import { logger } from './logger.js';

// `req.ip` first, NOT the X-Real-IP header. The container nginx sets
// `X-Real-IP $remote_addr`, which overwrites the value the host nginx put
// there with the address it sees — the docker bridge gateway. Trusting that
// header wrote 172.28.0.1 onto every audit row and every session row in
// production, so the column recorded which proxy delivered the request and
// never who made it.
//
// `req.ip` is derived from X-Forwarded-For under the `trust proxy` hop count
// set in app.js, which is the one place that knows the topology.
export const clientIp = (req) =>
  req.ip || req.headers['x-real-ip'] || req.socket?.remoteAddress || null;

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
        // Stored, not joined. PosUser.role answers "what are they now"; an
        // audit row has to answer "what were they then", and a promotion
        // between the two would otherwise rewrite the past.
        actorRole: req.user?.role ?? null,
        ip: clientIp(req),
        meta: meta ?? undefined,
      },
    });
  } catch (err) {
    logger.warn({ err, action }, 'pos audit write failed');
  }
};
