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

// Audit comes in two grades, because the two answer to different people.
//
// ROUTINE audit is a record of ordinary trading — an order rung up, a price
// changed. Losing one row is regrettable but a till that cannot sell because
// its audit table is full is worse, so those failures are logged and swallowed.
// That is what `audit` below does, and it stays that way.
//
// REQUIRED audit is the evidence somebody is entitled to demand: who changed a
// permission, when VEXO used support access inside a customer's tenant, which
// device was trusted to take money. Swallowing one of those produces the worst
// possible outcome — the change happens, the evidence does not exist, and
// nothing anywhere says so. For these the row is PART of the change: it is
// written on the caller's transaction, so a change whose evidence cannot be
// stored is refused rather than made invisibly.
const writeAuditRow = (client, req, { action, entity, entityId, companyId, meta }) =>
  client.posAuditLog.create({
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
      // Which till and device the action came from, when the caller presented
      // a device credential. Null on everything done from a plain browser
      // session, which is most administration.
      terminalId: req.device?.terminalId ?? null,
      deviceId: req.device?.id ?? null,
      meta: meta ?? undefined,
    },
  });

// Routine audit. Never takes the request down with it.
export const audit = async (req, entry) => {
  try {
    await writeAuditRow(prisma, req, entry);
  } catch (err) {
    logger.warn({ err, action: entry?.action }, 'pos audit write failed');
  }
};

// Required audit. `tx` is the transaction the change is being made on, so the
// row and the thing it describes commit together or not at all. Deliberately
// has no catch: the throw is the mechanism, and rolling the caller back is the
// correct outcome.
//
// Passing `prisma` instead of a tx is allowed and means "there is nothing to
// roll back" — used where the evidence is written before the change, such as a
// support-access check that decides whether the route runs at all.
export const auditRequired = (tx, req, entry) => writeAuditRow(tx, req, entry);
