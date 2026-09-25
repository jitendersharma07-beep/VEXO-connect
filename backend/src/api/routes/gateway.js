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
import { applyGatewayEvent, isDuplicateOf } from '../../lib/gateway/apply.js';
import { webhookSecretCandidates } from '../../lib/gateway/accounts.js';
import { audit } from '../../lib/audit.js';
import { asyncHandler } from '../../lib/errors.js';

const router = express.Router();

// The exact bytes that were signed. Re-serialising a parsed body would
// reorder keys and drop whitespace, breaking every signature ever sent.
const rawBody = express.raw({ type: '*/*', limit: '256kb' });

// One URL, many merchant accounts.
//
// The provider signs with the secret of the account the attempt was opened on,
// and this endpoint is reached before anything is known about which account
// that was — the reference that would say is inside the body, which must not be
// read until it verifies. So every configured secret is a candidate.
//
// Trying the next candidate is correct ONLY for a signature mismatch. Every
// other refusal — a missing header, a body that will not parse, a timestamp
// outside tolerance — either precedes the HMAC or follows a secret that already
// matched, and no further secret can change it. Stopping there keeps the work
// bounded and keeps a real structural fault from being reported as "signature
// mismatch" after N pointless retries.
const verifyAgainstCandidates = (adapter, { rawBody: body, headers, toleranceSeconds, nowMs }, candidates) => {
  if (candidates.length === 0) {
    return { verified: { valid: false, reason: 'no webhook secret is configured' }, account: null };
  }
  let last = null;
  for (const candidate of candidates) {
    const verified = adapter.verifyWebhook({
      rawBody: body,
      headers,
      secret: candidate.secret,
      toleranceSeconds,
      nowMs,
    });
    if (verified.valid) return { verified, account: candidate };
    last = verified;
    if (verified.reason !== 'signature mismatch') return { verified, account: null };
  }
  return { verified: last, account: null };
};

router.post(
  '/webhook',
  rawBody,
  asyncHandler(async (req, res) => {
    const adapter = getAdapter();
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

    const candidates = await webhookSecretCandidates(adapter.name);
    const { verified, account } = verifyAgainstCandidates(
      adapter,
      {
        rawBody: body,
        headers: req.headers,
        toleranceSeconds: env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
        nowMs: Date.now(),
      },
      candidates,
    );

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
            // This route is the only writer of WEBHOOK rows. Stated rather
            // than defaulted, so nothing else can acquire the label by
            // omission.
            source: 'WEBHOOK',
          },
        });

        const applied = await applyGatewayEvent(tx, {
          provider: adapter.name,
          providerRef: verified.providerRef,
          kind: verified.kind,
          amountPaise: verified.amountPaise,
          currency: verified.currency,
          method: verified.method,
          chargeRef: verified.chargeRef,
          // Which account's secret verified this, and therefore the only
          // company whose orders this delivery may touch. Null where the
          // deployment-wide environment secret answered, which is the
          // single-account arrangement and is box-scoped by construction.
          accountId: account?.accountId ?? null,
          expectCompanyId: account?.companyId ?? null,
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
      if (isDuplicateOf(err, 'eventId')) {
        return res.json({ received: true, duplicate: true });
      }
      // Reached when a pull-based reconcile settled this intent while this
      // delivery was in flight. The money is recorded once, by whichever got
      // there first, and the provider is told to stop retrying either way.
      if (isDuplicateOf(err, 'intentId')) {
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
    } else if (outcome.refundSettled || outcome.refundFailed) {
      // The refund existed before this event; what changed is whether the
      // provider actually paid it out, so that is what the audit records.
      await audit(req, {
        action: outcome.refundSettled ? 'ORDER_REFUND_SETTLED' : 'ORDER_REFUND_FAILED',
        entity: 'Order',
        entityId: outcome.orderId,
        companyId: outcome.companyId,
        meta: { channel: 'GATEWAY', provider: adapter.name, refundId: outcome.refundId },
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
    return res.json({
      received: true,
      applied: Boolean(outcome.payment || outcome.refundSettled || outcome.refundFailed),
    });
  }),
);

export default router;
