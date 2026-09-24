// Loyalty at the till (LANE providers).
// ENTITLEMENT(INTEGRATIONS)
//
// The cashier's half of the Reelo integration. Separate from routes/integrations.js
// on purpose: that file is administration — keys, mappings, imports — and this one
// is four things a cashier does while a customer is standing in front of them.
//
// WHAT THIS FILE ASSUMES, AND WHY IT HAS TO. A VEXO order carries no customer.
// Customers exist (phone orders have one) but an ordinary till order does not name
// a person, because the product deliberately has no customer accounts yet. So a
// bill can only reach the loyalty programme if a cashier attaches a number to it,
// and `POST /orders/:id/customer` is that step. Without it a walk-in bill syncs
// nothing, which is the honest outcome — the alternative is guessing whose points
// these are.
//
// THE 100,000 EXISTING CUSTOMERS. Every path here is a read or an instruction
// against the client's existing Reelo account. Nothing enrols, nothing resets a
// balance, nothing recomputes one and nothing sends a message. Attaching a number
// to a bill creates a VEXO Customer row — our side of the mapping — and never a
// Reelo profile; Reelo creates its own on bill sync, which is why an unconfident
// phone number is refused before it can invent a person.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import { loadPermissionContext, requireAction } from '../../middleware/permissions.js';

import { openFor, sanitizeProviderError } from '../../lib/integrations/index.js';
import { resolveAdapter } from '../../lib/integrations/adapters/index.js';
import {
  normalizePhone,
  linkCustomer,
  refreshBalance,
  publicBalance,
  performRedemption,
  billSyncKey,
} from '../../lib/integrations/loyalty.js';

const router = Router();
router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext, requireUsableLicense);

// The loyalty connection, opened, or a sentence saying why not.
//
// Returns rather than throws for the "switched off" cases, because a till that
// asks about loyalty on every bill must not see an error when the restaurant
// simply has no loyalty programme. A 200 with `available: false` lets the screen
// hide the panel; a 500 makes it look broken.
const loyaltyContext = async (companyId) => {
  const connection = await prisma.integrationConnection.findUnique({
    where: { companyId_provider: { companyId, provider: 'REELO' } },
  });
  if (!connection || !connection.enabled) return { available: false, reason: 'No loyalty programme is switched on' };
  if (!connection.credentialCiphertext) {
    return { available: false, reason: 'The loyalty provider has no credential stored' };
  }
  let credential;
  try {
    credential = openFor(connection);
  } catch {
    return { available: false, reason: 'The stored loyalty credential could not be opened' };
  }
  return {
    available: true,
    connection,
    credential,
    config: connection.config ?? {},
    adapter: resolveAdapter('REELO'),
  };
};

// The owner's switch for whether this till may move a real customer's points at
// all. It is declared in the REELO config schema with exactly that promise —
// "run bill sync with redemption still disabled" — and for a while nothing read
// it, which is the worst shape this kind of defect takes: the setting appears on
// the screen, the owner turns it off, and the till goes on spending points.
//
// Checked here rather than inside performRedemption so that the OTP request is
// refused too. Asking Reelo to text a customer a code we are not going to honour
// is a message sent for nothing, and Reelo owns customer communication.
const assertRedemptionAllowed = (ctx) => {
  if (ctx.config?.redemptionEnabled) return;
  throw conflict(
    'Redemption is switched off for this loyalty connection. Turn it on in the integration settings before spending points at the till.',
  );
};

const phoneBody = z.object({ phone: z.string().trim().min(1).max(20) });

// The VEXO side of the mapping. Upsert on (companyId, phone), which is the
// constraint that stops a second Anita Rao appearing every time a number is
// typed again. Never creates anything at the provider.
const customerFor = async (companyId, phone, name, createdById) =>
  prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    create: { companyId, phone, name: name || phone, createdById },
    // The name is NOT overwritten from the provider. A cashier who corrected a
    // spelling should not have it reverted by the next lookup, and the provider's
    // copy is not more authoritative about a name than the person who just asked.
    update: {},
  });

// --- lookup ------------------------------------------------------------------

// What does this customer have? Asked of the provider, because the provider owns
// the ledger. The cached figure is the fallback and travels with its own age, so
// a cashier never reads a stale number as a current one.
router.post(
  '/lookup',
  requireAction('loyalty.lookup'),
  asyncHandler(async (req, res) => {
    const { phone } = phoneBody.parse(req.body);
    const norm = normalizePhone(phone);
    if (!norm.confident) {
      throw badRequest('That is not a recognisable Indian mobile number');
    }

    const ctx = await loyaltyContext(req.companyScope.id);
    if (!ctx.available) return res.json({ available: false, reason: ctx.reason });

    const customer = await prisma.customer.findUnique({
      where: { companyId_phone: { companyId: req.companyScope.id, phone: norm.national } },
    });
    const link = customer
      ? await prisma.loyaltyProfileLink.findUnique({
          where: { connectionId_customerId: { connectionId: ctx.connection.id, customerId: customer.id } },
        })
      : null;

    let lookup = null;
    let providerError = null;
    try {
      lookup = await refreshBalance({ ...ctx, link, phone: norm.national });
    } catch (err) {
      // A provider outage must not stop a sale. The cached balance is offered
      // instead, labelled, and the reason travels with it so the cashier can say
      // "their points system is down" rather than "it isn't working".
      providerError = sanitizeProviderError(err?.message ?? String(err));
    }

    // Link on first successful sighting, so the next bill for this number has a
    // mapping without anyone having to press anything.
    if (lookup?.externalCustomerId && customer) {
      await linkCustomer(prisma, {
        companyId: req.companyScope.id,
        connectionId: ctx.connection.id,
        customerId: customer.id,
        externalCustomerId: lookup.externalCustomerId,
        phone: norm.national,
        lookup,
        source: 'LOOKUP',
      });
    }

    res.json({
      available: true,
      phone: norm.national,
      // Null when the provider has never seen this number. Deliberately not
      // "0 points" — a customer who does not exist yet and a customer with an
      // empty balance are different things to tell someone.
      known: Boolean(lookup?.externalCustomerId ?? link),
      name: lookup?.name ?? customer?.name ?? null,
      tier: lookup?.tier ?? link?.membershipTier ?? null,
      balance: publicBalance(link, lookup),
      rewards: lookup?.rewards ?? [],
      providerError,
    });
  }),
);

// --- attach a customer to a bill ---------------------------------------------

// Records that this order belongs to this person, so that billing it syncs to the
// loyalty programme.
//
// The record is a PENDING LoyaltyOperation rather than a column on Order: the
// Order model belongs to the core product and does not know what a loyalty
// provider is, and the operation row is where this lane already keeps every
// instruction it intends to send. Keyed on billSyncKey(orderId), which is the same
// key enqueueBillSync upserts at bill time — so attaching twice, or attaching and
// then billing, produces one operation and one sync.
router.post(
  '/orders/:orderId/customer',
  requireAction('loyalty.lookup'),
  asyncHandler(async (req, res) => {
    const { phone, name } = z
      .object({ phone: z.string().trim().min(1).max(20), name: z.string().trim().max(120).optional() })
      .parse(req.body);
    const norm = normalizePhone(phone);
    if (!norm.confident) throw badRequest('That is not a recognisable Indian mobile number');

    const ctx = await loyaltyContext(req.companyScope.id);
    if (!ctx.available) throw conflict(ctx.reason);

    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, companyId: req.companyScope.id },
      select: { id: true, status: true, total: true, branchId: true },
    });
    if (!order) throw notFound('Order not found');
    if (req.user.branchId && req.user.branchId !== order.branchId) throw notFound('Order not found');
    // After billing the sync has already been decided. Allowing a change here
    // would mean a bill that earned points for one person and was then attached
    // to another, with no way to take the first award back.
    if (order.status !== 'OPEN') throw conflict('This order has already been billed');

    const customer = await customerFor(req.companyScope.id, norm.national, name, req.user.id);

    const op = await prisma.loyaltyOperation.upsert({
      where: {
        connectionId_idempotencyKey: {
          connectionId: ctx.connection.id,
          idempotencyKey: billSyncKey(order.id),
        },
      },
      create: {
        companyId: req.companyScope.id,
        connectionId: ctx.connection.id,
        customerId: customer.id,
        orderId: order.id,
        kind: 'BILL_SYNC',
        idempotencyKey: billSyncKey(order.id),
      },
      // Re-attaching before the bill is issued replaces who it is for, which is
      // the correction a cashier makes after mistyping a digit. Only reachable
      // while the operation is still PENDING — once the job has run, the status
      // guard below has already refused.
      update: { customerId: customer.id },
    });
    if (op.status !== 'PENDING') throw conflict('This bill has already been sent to the loyalty programme');

    await audit(req, {
      action: 'LOYALTY_CUSTOMER_ATTACH',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: { customerId: customer.id },
    });

    res.json({ attached: true, customer: { id: customer.id, name: customer.name, phone: customer.phone } });
  }),
);

// --- redemption --------------------------------------------------------------

// Ask the provider to send the customer their OTP. Not a message from VEXO: Reelo
// owns customer communication and the user's instruction on that is explicit.
router.post(
  '/otp',
  requireAction('loyalty.redeem'),
  asyncHandler(async (req, res) => {
    const { phone } = phoneBody.parse(req.body);
    const norm = normalizePhone(phone);
    if (!norm.confident) throw badRequest('That is not a recognisable Indian mobile number');

    const ctx = await loyaltyContext(req.companyScope.id);
    if (!ctx.available) throw conflict(ctx.reason);
    assertRedemptionAllowed(ctx);

    const result = await ctx.adapter.sendRedemptionOtp({
      credential: ctx.credential,
      config: ctx.config,
      phone: norm.national,
    });
    await audit(req, {
      action: 'LOYALTY_OTP_REQUEST',
      entity: 'Company',
      entityId: req.companyScope.id,
      companyId: req.companyScope.id,
      // The number, never the code. An OTP in an audit row is an OTP anyone with
      // audit access can spend.
      meta: { phone: norm.national },
    });
    res.json({ sent: true, expiresInSeconds: result?.expiresInSeconds ?? null });
  }),
);

// Spend points against an open bill. Inline, once, never queued — see the note
// above performRedemption in lib/integrations/loyalty.js for why.
router.post(
  '/orders/:orderId/redeem',
  requireAction('loyalty.redeem'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        phone: z.string().trim().min(1).max(20),
        otp: z.string().trim().min(1).max(12),
        points: z.number().int().positive().optional(),
        reward: z.string().trim().max(120).optional(),
      })
      .refine((v) => v.points != null || v.reward, {
        message: 'Name either a number of points or a reward to redeem',
      })
      .parse(req.body);

    const norm = normalizePhone(body.phone);
    if (!norm.confident) throw badRequest('That is not a recognisable Indian mobile number');

    const ctx = await loyaltyContext(req.companyScope.id);
    if (!ctx.available) throw conflict(ctx.reason);
    assertRedemptionAllowed(ctx);

    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, companyId: req.companyScope.id },
      select: { id: true, status: true, branchId: true, invoiceNumber: true },
    });
    if (!order) throw notFound('Order not found');
    if (req.user.branchId && req.user.branchId !== order.branchId) throw notFound('Order not found');
    // Redeeming against a closed bill would spend points the bill cannot show a
    // discount for. The window is the same one the till has for any other
    // adjustment: while the order is open.
    if (order.status !== 'OPEN') throw conflict('This order has already been billed');

    const customer = await customerFor(req.companyScope.id, norm.national, null, req.user.id);
    const result = await performRedemption({
      adapter: ctx.adapter,
      connection: ctx.connection,
      credential: ctx.credential,
      config: ctx.config,
      order,
      customer,
      phone: norm.national,
      otp: body.otp,
      points: body.points,
      reward: body.reward,
    });

    await audit(req, {
      action: 'LOYALTY_REDEEM',
      entity: 'Order',
      entityId: order.id,
      companyId: req.companyScope.id,
      meta: {
        customerId: customer.id,
        points: body.points ?? null,
        reward: body.reward ?? null,
        ok: result.ok,
        unknown: result.unknown ?? false,
        duplicate: result.duplicate ?? false,
      },
    });

    if (result.ok) {
      return res.json({
        redeemed: true,
        duplicate: result.duplicate ?? false,
        operationId: result.operation?.id ?? null,
        pointsDelta: result.operation?.pointsDelta ?? null,
        balanceAfter: result.balanceAfter ?? null,
      });
    }

    // 409 for a refusal and 502 for an unanswered call, because they need
    // different things from the cashier: try again with a fresh OTP, versus stop
    // and check the balance before touching it again.
    return res.status(result.unknown ? 502 : 409).json({
      error: {
        code: result.unknown ? 'POS_LOYALTY_REDEEM_UNKNOWN' : 'POS_LOYALTY_REDEEM_REFUSED',
        message: sanitizeProviderError(result.reason),
      },
      operationId: result.operationId ?? null,
    });
  }),
);

// What the till shows about a bill it has in front of it: who it is attached to
// and what has been spent on it. A read, so it costs no provider call.
router.get(
  '/orders/:orderId',
  requireAction('loyalty.lookup'),
  asyncHandler(async (req, res) => {
    const ctx = await loyaltyContext(req.companyScope.id);
    if (!ctx.available) return res.json({ available: false, reason: ctx.reason });

    const ops = await prisma.loyaltyOperation.findMany({
      where: { orderId: req.params.orderId, companyId: req.companyScope.id, connectionId: ctx.connection.id },
      include: { customer: { select: { id: true, name: true, phone: true } } },
      orderBy: { requestedAt: 'asc' },
    });
    const attached = ops.find((o) => o.kind === 'BILL_SYNC')?.customer ?? null;
    res.json({
      available: true,
      customer: attached,
      operations: ops.map((o) => ({
        id: o.id,
        kind: o.kind,
        status: o.status,
        pointsDelta: o.pointsDelta,
        requestedAt: o.requestedAt,
        confirmedAt: o.confirmedAt,
        lastError: sanitizeProviderError(o.lastError),
      })),
    });
  }),
);

export default router;
