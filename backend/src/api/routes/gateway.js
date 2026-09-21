// Provider webhook intake (contract §13).
//
// This router is mounted ONLY when a provider is configured, so a deployment
// with no gateway — which is every deployment today — has no such endpoint to
// probe at all.
//
// It is deliberately NOT session-authenticated: the provider has no session.
// The HMAC signature over the raw body IS the authentication, and nothing
// downstream runs until it verifies.

import express from 'express';

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { getAdapter } from '../../lib/gateway/index.js';
import { sha256Hex } from '../../lib/gateway/signature.js';
import { applyGatewayEvent } from '../../lib/gateway/apply.js';
import { audit } from '../../lib/audit.js';
import { asyncHandler } from '../../lib/errors.js';

const router = express.Router();

// The exact bytes that were signed. Re-serialising a parsed body would
// reorder keys and drop whitespace, breaking every signature ever sent.
const rawBody = express.raw({ type: '*/*', limit: '256kb' });

const duplicateOf = (err, field) =>
  err?.code === 'P2002' && [].concat(err.meta?.target ?? []).some((t) => String(t).includes(field));

router.post(
  '/webhook',
  rawBody,
  asyncHandler(async (req, res) => {
    const adapter = getAdapter();
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

    const verified = adapter.verifyWebhook({
      rawBody: body,
      headers: req.headers,
      secret: env.POS_GATEWAY_WEBHOOK_SECRET,
      toleranceSeconds: env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
      nowMs: Date.now(),
    });

    if (!verified.valid) {
      // Recorded in the audit log, never in GatewayWebhookEvent: eventId comes
      // from the payload, so storing unverified deliveries would let a forged
      // id squat the unique key and block the genuine event for good.
      await audit(req, {
        action: 'GATEWAY_WEBHOOK_REJECTED',
        entity: 'GatewayWebhookEvent',
        meta: { provider: adapter.name, reason: verified.reason, payloadHash: sha256Hex(body) },
      });
      // Terse on the wire, precise in the log: a prober learns nothing about
      // which check failed, while the operator can see exactly why.
      return res.status(400).json({
        error: { code: 'POS_GATEWAY_SIGNATURE_INVALID', message: 'Signature verification failed' },
      });
    }

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const event = await tx.gatewayWebhookEvent.create({
          data: {
            provider: adapter.name,
            eventId: verified.eventId,
            kind: verified.kind,
            payloadHash: sha256Hex(body),
          },
        });

        const applied = await applyGatewayEvent(tx, {
          provider: adapter.name,
          providerRef: verified.providerRef,
          kind: verified.kind,
          amountPaise: verified.amountPaise,
          method: verified.method,
        });

        await tx.gatewayWebhookEvent.update({
          where: { id: event.id },
          data: {
            processedAt: new Date(),
            intentId: applied.intentId ?? null,
            skippedReason: applied.skippedReason ?? null,
          },
        });

        return applied;
      });
    } catch (err) {
      // Both of these mean the money has already been accounted for exactly
      // once. The provider is told 200 so it stops retrying.
      if (duplicateOf(err, 'eventId')) {
        return res.json({ received: true, duplicate: true });
      }
      if (duplicateOf(err, 'intentId')) {
        return res.json({ received: true, duplicate: true });
      }
      throw err;
    }

    if (outcome.payment) {
      await audit(req, {
        action: 'ORDER_PAYMENT',
        entity: 'Order',
        entityId: outcome.orderId,
        companyId: outcome.companyId,
        meta: {
          method: outcome.payment.method,
          amount: String(outcome.payment.amount),
          channel: 'GATEWAY',
          provider: adapter.name,
          intentId: outcome.intentId,
        },
      });
    } else if (outcome.skippedReason) {
      logger.warn(
        { provider: adapter.name, eventId: verified.eventId, reason: outcome.skippedReason },
        'gateway webhook verified but not applied',
      );
    }

    // 200 for every verified delivery, applied or not: it was genuine, and a
    // retry cannot change the outcome. The reason is on the row for the
    // reconciliation report to surface.
    return res.json({ received: true, applied: Boolean(outcome.payment) });
  }),
);

export default router;
