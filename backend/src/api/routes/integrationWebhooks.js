// Aggregator callback intake (LANE providers).
//
// Mounted ahead of express.json, like routes/gateway.js, because the bytes a
// provider sent are the bytes we have to authenticate — re-serialising a parsed
// body reorders keys and changes what any future signature scheme would cover.
//
// NOT session-authenticated. Zomato has no session. What authenticates a
// delivery is the header pair agreed on the onboarding form, held sealed in the
// connection credential, compared in constant time. Nothing downstream runs
// until that passes.
//
// The URL names the connection and the header proves it. A connection id is not
// a secret — it is in a URL that is configured into a partner portal — so it is
// treated as a lookup key and never as authority. A wrong header on a correct
// connection id gets the same answer as a correct header on an unknown one.
//
// WHAT THIS ROUTE WILL NOT DO. It will not create an order for an outlet that
// nobody has mapped, it will not price a line it cannot find in the catalogue,
// and it will not move an order backwards because a delayed callback said so.
// Each of those is held, with a sentence naming what to fix, and answered 200 —
// because the delivery was genuine and redelivering it will not help.

import express from 'express';

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { asyncHandler } from '../../lib/errors.js';
import { openFor, sanitizeProviderError } from '../../lib/integrations/index.js';
import { enqueue } from '../../lib/integrations/queue.js';
import { resolveAdapter } from '../../lib/integrations/adapters/index.js';
import {
  verifySharedHeader,
  recordEvent,
  markProcessed,
  markSkipped,
  markFailed,
  TERMINAL_STATES,
} from '../../lib/integrations/events.js';
import {
  resolveOutlet,
  upsertAggregatorOrder,
  materialise,
  applyState,
  recordStateBeforePlacement,
} from '../../lib/integrations/aggregatorOrders.js';

const router = express.Router();

// 512kb: an aggregator order with fifty lines and full modifier detail is a few
// kilobytes. Anything at this size is not an order.
const rawBody = express.raw({ type: '*/*', limit: '512kb' });

// Identical reply for every rejected delivery, whatever was wrong with it.
// A prober learns only that something was refused — not whether the connection
// exists, not whether the header name was right, not whether the tenant is real.
const REFUSED = {
  error: { code: 'POS_INTEGRATION_CALLBACK_REFUSED', message: 'Callback refused' },
};

// Kinds that bring an order into existence. Everything else is a state change on
// an order we are expected to already hold.
const PLACEMENT = new Set(['ORDER_PLACED']);

router.post(
  '/:provider/:connectionId',
  rawBody,
  asyncHandler(async (req, res) => {
    const { provider, connectionId } = req.params;

    const connection = await prisma.integrationConnection.findFirst({
      where: { id: connectionId, provider, enabled: true },
    });
    // Logged at warn, not stored: see recordEvent in lib/integrations/events.js
    // for why an unauthenticated delivery must never be written to a table keyed
    // on an id the payload supplied.
    if (!connection || !connection.credentialCiphertext) {
      logger.warn({ provider, connectionId }, 'integration callback for unknown or unconfigured connection');
      return res.status(401).json(REFUSED);
    }

    let credential;
    try {
      credential = openFor(connection);
    } catch {
      logger.error({ provider, connectionId }, 'integration callback: stored credential could not be opened');
      return res.status(401).json(REFUSED);
    }

    const authenticated = verifySharedHeader(
      req.headers,
      credential.inboundHeaderName,
      credential.inboundHeaderValue,
    );
    if (!authenticated) {
      await audit(req, {
        action: 'INTEGRATION_CALLBACK_REJECTED',
        entity: 'IntegrationConnection',
        entityId: connection.id,
        companyId: connection.companyId,
        meta: { provider, reason: 'inbound authentication failed' },
      });
      return res.status(401).json(REFUSED);
    }

    // Parsed only after authentication. An unauthenticated caller should not be
    // able to reach a JSON parser, however cheap that parser is.
    let body;
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
    } catch {
      return res.status(400).json({
        error: { code: 'POS_INTEGRATION_CALLBACK_UNPARSEABLE', message: 'Body is not JSON' },
      });
    }

    const adapter = resolveAdapter(provider);
    let envelope;
    try {
      envelope = adapter.parseInbound({ headers: req.headers, body });
    } catch (err) {
      logger.warn({ provider, connectionId, err }, 'integration callback could not be normalised');
      return res.status(400).json({
        error: { code: 'POS_INTEGRATION_CALLBACK_UNRECOGNISED', message: 'Callback shape not recognised' },
      });
    }

    const { event, duplicate } = await recordEvent({
      companyId: connection.companyId,
      connectionId: connection.id,
      externalEventId: envelope.externalEventId,
      kind: envelope.kind,
      payload: body,
      externalOrderId: envelope.externalOrderId ?? null,
      providerSequence: envelope.providerSequence ?? null,
      providerEventAt: envelope.providerEventAt ?? null,
    });

    // The redelivery case, and the single most important line in this file. The
    // work was done the first time; doing it again is a second kitchen ticket.
    if (duplicate) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      const outcome = PLACEMENT.has(envelope.kind)
        ? await handlePlacement({ connection, envelope })
        : await handleStateChange({ connection, envelope });

      if (outcome.processed) {
        await markProcessed(event.id);
      } else {
        await markSkipped(event.id, outcome.reason);
      }

      // 200 for every authenticated delivery we stored, processed or held. It
      // was genuine, and a redelivery cannot change the outcome: an unmapped
      // outlet is still unmapped on the second attempt. The reason lives on the
      // row for the integrations screen to show, which is where an operator can
      // actually act on it.
      return res.json({ received: true, processed: outcome.processed, held: !outcome.processed });
    } catch (err) {
      await markFailed(event.id, err);
      logger.error(
        { provider, connectionId, eventId: event.id, reason: sanitizeProviderError(err?.message) },
        'integration callback processing failed',
      );
      // 500 here is deliberate and is the one case where a redelivery IS wanted:
      // this is our fault, not the payload's, and the provider retrying gives us
      // a second chance at an order that would otherwise be lost. The unique key
      // on the event makes that retry safe.
      return res.status(500).json({
        error: { code: 'POS_INTEGRATION_CALLBACK_FAILED', message: 'Callback could not be processed' },
      });
    }
  }),
);

// --- placement ---------------------------------------------------------------

const handlePlacement = async ({ connection, envelope }) => {
  const outlet = await resolveOutlet(prisma, {
    connectionId: connection.id,
    externalOutletId: envelope.externalOutletId,
  });

  const aggOrder = await upsertAggregatorOrder(prisma, {
    companyId: connection.companyId,
    connectionId: connection.id,
    provider: connection.provider,
    envelope,
    outlet,
  });

  // Already materialised. Reached when a provider redelivers a placement under a
  // NEW event id — which happens, and which the event-level duplicate check
  // above therefore cannot catch. AggregatorOrder.orderId is the guard that can:
  // it is unique, and it is set inside the same transaction that creates the
  // order.
  if (aggOrder.orderId) {
    return { processed: true, reason: null };
  }

  // THE ORDERING GATE. The provider has already told us this order is finished,
  // in an event that arrived before the placement it refers to. Materialising now
  // would put a kitchen ticket on the rail for food nobody is coming to collect,
  // and a sale in the books for an order that was cancelled. Event-id uniqueness
  // cannot catch this: both events are genuine and distinct, they simply arrived
  // in the wrong order.
  //
  // So: no Order, no KOT, no stock movement. A discrepancy instead, because an
  // order that was cancelled before we saw it is something the operator should
  // know happened rather than something to silently discard.
  if (TERMINAL_STATES.has(aggOrder.state)) {
    await prisma.integrationDiscrepancy.create({
      data: {
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: 'TERMINAL_BEFORE_PLACEMENT',
        externalRef: envelope.externalOrderId,
        detail: {
          state: aggOrder.state,
          cancelReason: aggOrder.cancelReason ?? null,
          note:
            `The provider reported this order as ${aggOrder.state} before it delivered the order itself. ` +
            'No POS order, kitchen ticket or stock movement was created. The order details are recorded for reference only.',
        },
      },
    });
    return {
      processed: true,
      reason: `the provider had already reported this order ${aggOrder.state} before sending it; nothing was sent to the kitchen`,
    };
  }

  // Which user the POS order is attributed to. An aggregator order has no
  // cashier, and putting whoever is on shift on it would place a sale in the
  // name of someone who never touched it. Configured as a dedicated service
  // account; absent, the order is held rather than misattributed.
  const actorUserId = connection.config?.orderActorUserId ?? null;
  if (!actorUserId) {
    return {
      processed: false,
      reason:
        'No service account is configured to own aggregator orders. Set one on the integration screen, then retry this order.',
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.aggregatorOrder.findUnique({ where: { id: aggOrder.id } });
    if (fresh?.orderId) return { held: false, orderId: fresh.orderId };
    return materialise(tx, {
      companyId: connection.companyId,
      connection,
      aggOrder: fresh ?? aggOrder,
      envelope,
      actorUserId,
    });
  });

  // A held order carries no hold-reason column of its own, deliberately. The
  // reason is written to the EVENT that was held (markSkipped, in the caller),
  // where it sits next to the payload that caused it and cannot be overwritten
  // by the next delivery. A held order is therefore "an AggregatorOrder with no
  // orderId", and why is a question the event answers — which is also the only
  // shape that survives two different callbacks being held for two different
  // reasons on the same order.
  if (result.held) return { processed: false, reason: result.reason };

  // Auto-accept is a commercial decision, not a technical one: confirming an
  // order to Zomato commits the kitchen to cooking it. Off unless the owner
  // switched it on. When off, the order is in the POS and on the KDS, and a
  // human presses accept.
  if (connection.config?.autoAccept) {
    await enqueueAccept({ connection, envelope, orderId: result.orderId });
  }

  return { processed: true, reason: null };
};

// Queued rather than called, because a callback handler that waits on Zomato's
// confirm endpoint holds the provider's own request open while it does — and
// their timeout, not ours, decides what happens next.
const enqueueAccept = async ({ connection, envelope, orderId }) =>
  enqueue(prisma, {
    companyId: connection.companyId,
    connectionId: connection.id,
    kind: 'ZOMATO_ORDER_CONFIRM',
    payload: { order_id: envelope.externalOrderId, orderId, externalOrderId: envelope.externalOrderId },
    dedupe: ['confirm', envelope.externalOrderId],
  });

// --- state change ------------------------------------------------------------

const handleStateChange = async ({ connection, envelope }) => {
  if (!envelope.externalOrderId) {
    return { processed: false, reason: 'the callback names no order' };
  }

  const aggOrder = await prisma.aggregatorOrder.findUnique({
    where: {
      connectionId_externalOrderId: {
        connectionId: connection.id,
        externalOrderId: envelope.externalOrderId,
      },
    },
  });

  // A state change for an order we have never seen. This is the out-of-order
  // case, and it used to be dropped — which quietly lost the one event we most
  // need to keep. A cancellation that overtakes its own placement, dropped, means
  // the placement arrives later and the kitchen cooks an order the provider had
  // already killed. So the state is RECORDED against the provider's order id,
  // with placementReceivedAt null to say plainly that no order has been seen.
  //
  // It is not an invented order: it has no Order, no kitchen ticket and no money
  // on it. It is a note that outranks the placement when the placement arrives.
  if (!aggOrder) {
    if (!envelope.state) {
      return { processed: false, reason: `unrecognised provider state "${envelope.rawState ?? ''}"` };
    }
    try {
      await recordStateBeforePlacement(prisma, {
        companyId: connection.companyId,
        connectionId: connection.id,
        provider: connection.provider,
        envelope,
        state: envelope.state,
      });
    } catch (err) {
      // P2002: the placement landed in the gap between the read and this write.
      // The row now exists, so the ordinary path is the right one — handled by
      // the provider's own retry rather than by racing it here.
      if (err?.code !== 'P2002') throw err;
      return { processed: false, reason: 'the placement arrived while this event was being recorded; retry it' };
    }
    return {
      processed: true,
      reason: `recorded ${envelope.state} for an order whose placement has not arrived yet`,
    };
  }

  // The placement still has not arrived, so there is nothing to advance and no
  // kitchen ticket to affect. Record the later state on the shell and stop.
  if (!aggOrder.placementReceivedAt) {
    const applied = await applyState(prisma, { aggOrder, state: envelope.state, envelope });
    return applied.applied
      ? { processed: true, reason: 'the placement for this order has still not arrived' }
      : { processed: false, reason: applied.reason };
  }

  const applied = await applyState(prisma, { aggOrder, state: envelope.state, envelope });
  if (!applied.applied) return { processed: false, reason: applied.reason };

  // A cancellation after the kitchen has the ticket is the case that costs money
  // — food already being cooked — so it is surfaced as a discrepancy rather than
  // left as a state on a row nobody is watching.
  if (envelope.state === 'CANCELLED' && aggOrder.orderId) {
    await prisma.integrationDiscrepancy.create({
      data: {
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: 'CANCELLED_AFTER_MATERIALISE',
        externalRef: envelope.externalOrderId,
        orderId: aggOrder.orderId,
        detail: {
          cancelReason: envelope.cancelReason ?? null,
          note: 'The provider cancelled an order that was already in the POS and on the kitchen display. The POS order has not been voided automatically.',
        },
      },
    });
  }

  return { processed: true, reason: null };
};

export default router;
