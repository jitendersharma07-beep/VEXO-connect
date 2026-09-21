// Razorpay adapter suite.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. Every HTTP call below goes to a stub
// of Razorpay's API running on loopback in this process. That is enough to
// prove the wire format, the two signature schemes, the event mapping, the
// idempotency headers and — the part that actually protects money — how each
// class of failure is classified. It proves NOTHING about a real Razorpay
// account: no sandbox call has been made, no key exists in this repository,
// and a green run here must never be reported as a working integration.
//
// The stub answers with Razorpay's documented payload shapes rather than
// minimal ones, because a field we invented is a field the adapter would read
// happily and the real provider would never send.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import crypto from 'node:crypto';

// Must precede the app import: config/env.js reads process.env once, at load.
// Never real keys — the strings below are literals chosen to be obviously not
// credentials, and the adapter only ever base64s them into a header the stub
// discards.
process.env.NODE_ENV = 'test';
process.env.POS_GATEWAY_PROVIDER = 'razorpay';
process.env.POS_GATEWAY_WEBHOOK_SECRET = 'razorpay-webhook-secret-not-a-real-one';
process.env.POS_GATEWAY_KEY_ID = 'rzp_test_0000000000fake';
process.env.POS_GATEWAY_KEY_SECRET = 'not-a-real-key-secret-000000';
process.env.POS_GATEWAY_TIMEOUT_MS = '1500';

// The stub's port is only known after listen(), and config/env.js snapshots
// process.env at import. So the server is started FIRST and the modules are
// imported after — otherwise the adapter would hold the default base URL and
// these tests would quietly call api.razorpay.com.
const routes = [];
const calls = [];

const stub = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://stub.invalid');
    calls.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    const handler = routes.shift();
    if (!handler) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'TEST', description: 'stub had no queued answer' } }));
    }
    const answer = handler({ method: req.method, path: url.pathname, query: url.searchParams, body, res });
    if (answer === undefined) return; // handler took over the socket
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.POS_GATEWAY_API_BASE = `http://127.0.0.1:${stub.address().port}`;

const { razorpayAdapter, verifyCheckoutSignature, RazorpayError, SIGNATURE_HEADER, EVENT_ID_HEADER } =
  await import('../src/lib/gateway/razorpay.js');
const { getAdapter } = await import('../src/lib/gateway/index.js');

const WEBHOOK_SECRET = process.env.POS_GATEWAY_WEBHOOK_SECRET;
const KEY_SECRET = process.env.POS_GATEWAY_KEY_SECRET;

const queue = (...handlers) => routes.push(...handlers);
const answer = (status, body) => () => ({ status, body });

afterEach(() => {
  routes.length = 0;
  calls.length = 0;
});
afterAll(() => stub.close());

// Razorpay's own order entity, trimmed to the fields that exist on it.
const orderEntity = (over = {}) => ({
  id: 'order_TESTfakeorder01',
  entity: 'order',
  amount: 80000,
  amount_paid: 0,
  amount_due: 80000,
  currency: 'INR',
  receipt: 'rcpt',
  status: 'created',
  attempts: 0,
  notes: {},
  created_at: Math.floor(Date.now() / 1000),
  ...over,
});

const refundEntity = (over = {}) => ({
  id: 'rfnd_TESTfakerefund1',
  entity: 'refund',
  amount: 10000,
  currency: 'INR',
  payment_id: 'pay_TESTfakepayment1',
  notes: {},
  receipt: null,
  acquirer_data: {},
  created_at: Math.floor(Date.now() / 1000),
  batch_id: null,
  status: 'processed',
  speed_processed: 'normal',
  speed_requested: 'normal',
  ...over,
});

// --- webhook payloads -------------------------------------------------------

const paymentEvent = (event, over = {}, entityOver = {}) => ({
  entity: 'event',
  account_id: 'acc_TESTfakeaccount',
  event,
  contains: ['payment'],
  payload: {
    payment: {
      entity: {
        id: 'pay_TESTfakepayment1',
        entity: 'payment',
        amount: 80000,
        currency: 'INR',
        status: event === 'payment.failed' ? 'failed' : 'captured',
        order_id: 'order_TESTfakeorder01',
        method: 'upi',
        captured: event !== 'payment.failed',
        email: 'x@example.com',
        contact: '+910000000000',
        notes: {},
        fee: 1888,
        tax: 288,
        created_at: Math.floor(Date.now() / 1000),
        ...entityOver,
      },
    },
  },
  created_at: Math.floor(Date.now() / 1000),
  ...over,
});

const refundEvent = (event, over = {}, entityOver = {}) => ({
  entity: 'event',
  account_id: 'acc_TESTfakeaccount',
  event,
  contains: ['refund'],
  payload: { refund: { entity: refundEntity(entityOver) } },
  created_at: Math.floor(Date.now() / 1000),
  ...over,
});

// Signs exactly the way Razorpay does: HMAC-SHA256 over the raw bytes with the
// webhook secret, hex, in X-Razorpay-Signature. No timestamp anywhere.
const deliver = (payload, { secret = WEBHOOK_SECRET, eventId = 'evt_TESTfake000001', ...over } = {}) => {
  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    rawBody,
    headers: {
      [SIGNATURE_HEADER]: crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
      [EVENT_ID_HEADER]: eventId,
      ...over.headers,
    },
    secret: WEBHOOK_SECRET,
    toleranceSeconds: 300,
    nowMs: Date.now(),
  };
};

const verify = (payload, opts) => razorpayAdapter.verifyWebhook(deliver(payload, opts));

describe('razorpay adapter is reachable only as a named provider', () => {
  it('is the adapter POS_GATEWAY_PROVIDER=razorpay selects', () => {
    expect(getAdapter().name).toBe('razorpay');
  });
});

describe('createSession opens a Razorpay order', () => {
  it('sends paise, the idempotency key as the receipt, and automatic capture', async () => {
    queue(answer(200, orderEntity({ amount: 80000 })));
    const session = await razorpayAdapter.createSession({
      amountPaise: 80000, currency: 'INR', orderId: 'ord_local_1', idempotencyKey: 'key-one',
    });

    expect(session).toEqual({ providerRef: 'order_TESTfakeorder01', checkoutUrl: null });
    const sent = JSON.parse(calls[0].body);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/orders' });
    expect(sent.amount).toBe(80000);
    expect(sent.currency).toBe('INR');
    // The receipt is the idempotency key, which is what makes recovery possible.
    expect(sent.receipt).toBe('key-one');
    // Nested capture, not the deprecated flat payment_capture. Automatic
    // matters: an authorized-but-uncaptured payment is money not received.
    //
    // capture_options is asserted in full because Razorpay documents both of
    // these as mandatory once capture is "automatic", and omitting them is an
    // incomplete request rather than a terser one. The expiry period is in
    // MINUTES and 12 is the documented floor — a bare number here is easy to
    // mistake for seconds and quietly leave payments uncaptured for hours.
    expect(sent.payment).toEqual({
      capture: 'automatic',
      capture_options: { automatic_expiry_period: 12, refund_speed: 'normal' },
    });
    expect(sent.payment_capture).toBeUndefined();
    expect(sent.notes.pos_order_id).toBe('ord_local_1');
  });

  it('authenticates with HTTP Basic over the key pair', async () => {
    queue(answer(200, orderEntity()));
    await razorpayAdapter.createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' });
    const header = calls[0].headers.authorization;
    expect(header.startsWith('Basic ')).toBe(true);
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    expect(id).toBe(process.env.POS_GATEWAY_KEY_ID);
    expect(secret).toBe(KEY_SECRET);
  });

  it('refuses an order Razorpay opened for a different amount', async () => {
    queue(answer(200, orderEntity({ amount: 70000 })));
    await expect(
      razorpayAdapter.createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' }),
    ).rejects.toThrow(/different amount/);
  });

  it('refuses a 200 that carries no order id rather than returning a null reference', async () => {
    queue(answer(200, { entity: 'order', amount: 80000 }));
    await expect(
      razorpayAdapter.createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' }),
    ).rejects.toThrow(/without an id/);
  });
});

describe('createSession failure classification', () => {
  it('treats a 400 as the provider refusing, and does not try to recover', async () => {
    queue(answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100' } }));
    const err = await razorpayAdapter
      .createSession({ amountPaise: 1, currency: 'INR', orderId: 'o', idempotencyKey: 'k' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(RazorpayError);
    expect(err.kind).toBe('TERMINAL');
    expect(err.providerRefused).toBe(true);
    expect(err.retryable).toBe(false);
    // Razorpay's own description reaches the operator.
    expect(err.message).toMatch(/at least 100/);
    // One call only: a refusal created nothing, so there is nothing to look up.
    expect(calls).toHaveLength(1);
  });

  it('treats a 401 as terminal — a wrong key is not something to retry', async () => {
    queue(answer(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }));
    const err = await razorpayAdapter
      .createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' })
      .catch((e) => e);
    expect(err.kind).toBe('TERMINAL');
    expect(calls).toHaveLength(1);
  });

  it('recovers the order by receipt after a 500, instead of opening a second one', async () => {
    queue(
      answer(500, { error: { code: 'SERVER_ERROR', description: 'we are having trouble' } }),
      ({ query }) => {
        expect(query.get('receipt')).toBe('key-recover');
        return { status: 200, body: { entity: 'collection', count: 1, items: [orderEntity({ receipt: 'key-recover' })] } };
      },
    );

    const session = await razorpayAdapter.createSession({
      amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'key-recover',
    });
    expect(session.providerRef).toBe('order_TESTfakeorder01');
    // The recovery is a GET. It never POSTs a second order.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/orders', 'GET /v1/orders']);
  });

  it('refuses to guess when the receipt lookup finds more than one order', async () => {
    queue(
      answer(500, { error: { description: 'trouble' } }),
      answer(200, { entity: 'collection', count: 2, items: [orderEntity(), orderEntity({ id: 'order_other' })] }),
    );
    const err = await razorpayAdapter
      .createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' })
      .catch((e) => e);
    // Falls back to the original failure, which is RETRYABLE — not a refusal,
    // so the caller may safely ask again under the same key.
    expect(err.kind).toBe('RETRYABLE');
    expect(err.providerRefused).toBe(false);
  });

  it('classifies a timeout as UNKNOWN, never as refused', async () => {
    queue(({ res }) => {
      // Never answers; AbortSignal.timeout fires. The socket is left for
      // afterAll to close with the server.
      res.writeHead(200, { 'content-type': 'application/json' });
      return undefined;
    }, answer(200, { entity: 'collection', count: 0, items: [] }));

    const err = await razorpayAdapter
      .createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' })
      .catch((e) => e);

    expect(err.kind).toBe('UNKNOWN');
    // The whole point: unknown must never free the reservation.
    expect(err.providerRefused).toBe(false);
    expect(err.message).toMatch(/timed out/);
  }, 10000);

  it('classifies 429 and 5xx as retryable and 404 as terminal', async () => {
    for (const [status, kind] of [[429, 'RETRYABLE'], [502, 'RETRYABLE'], [404, 'TERMINAL']]) {
      routes.length = 0;
      // Each retryable failure also attempts a receipt lookup; answer it empty.
      queue(answer(status, { error: { description: 'x' } }), answer(200, { items: [] }));
      const err = await razorpayAdapter
        .createSession({ amountPaise: 80000, currency: 'INR', orderId: 'o', idempotencyKey: 'k' })
        .catch((e) => e);
      expect(err.kind, `status ${status}`).toBe(kind);
    }
  });
});

describe('createRefund', () => {
  const args = {
    intentProviderRef: 'order_TESTfakeorder01',
    chargeProviderRef: 'pay_TESTfakepayment1',
    amountPaise: 10000,
    currency: 'INR',
    orderId: 'ord_local_1',
    idempotencyKey: 'refund-key-1',
  };

  it('posts to the PAYMENT, not the order, and sends the idempotency header', async () => {
    queue(answer(200, refundEntity({ amount: 10000 })));
    const out = await razorpayAdapter.createRefund(args);

    expect(out).toEqual({ providerRef: 'rfnd_TESTfakerefund1' });
    expect(calls[0].method).toBe('POST');
    // The order id cannot be refunded; only the pay_ can.
    expect(calls[0].path).toBe('/v1/payments/pay_TESTfakepayment1/refund');
    // Razorpay's documented header for this route. Without it a retry of an
    // unanswered request creates a SECOND refund.
    expect(calls[0].headers['x-refund-idempotency']).toBe('refund-key-1');
    expect(JSON.parse(calls[0].body).amount).toBe(10000);
  });

  it('stops before calling out when no payment id was ever recorded, and does not call it a refusal', async () => {
    const err = await razorpayAdapter.createRefund({ ...args, chargeProviderRef: null }).catch((e) => e);
    expect(err.kind).toBe('LOCAL');
    expect(err.message).toMatch(/no Razorpay payment id/);
    // Never reached the network, so nothing can have moved.
    expect(calls).toHaveLength(0);
    // And therefore Razorpay cannot have refused it. This is the flag that
    // releases a reservation, so a fault in our own precondition must not
    // raise it — otherwise a missing charge id hands the amount back to be
    // refunded again.
    expect(err.providerRefused).toBe(false);
    expect(err.status).toBe(null);
  });

  it('stops on an order id passed where a payment id belongs, still not a refusal', async () => {
    const err = await razorpayAdapter
      .createRefund({ ...args, chargeProviderRef: 'order_TESTfakeorder01' })
      .catch((e) => e);
    expect(err.kind).toBe('LOCAL');
    expect(calls).toHaveLength(0);
    expect(err.providerRefused).toBe(false);
  });

  // The label is not the evidence. Even spelled TERMINAL, a throw that never
  // reached Razorpay carries no status and so cannot release money — the
  // guarantee is structural rather than a convention each call site remembers.
  it('cannot report a refusal without the HTTP status that evidences one', () => {
    expect(new RazorpayError('local fault', { kind: 'TERMINAL' }).providerRefused).toBe(false);
    expect(new RazorpayError('bad gateway', { kind: 'TERMINAL', status: 502 }).providerRefused).toBe(false);
    expect(new RazorpayError('not implemented', { kind: 'TERMINAL', status: 501 }).providerRefused).toBe(false);
    expect(new RazorpayError('declined', { kind: 'TERMINAL', status: 400 }).providerRefused).toBe(true);
  });

  it('treats a refund Razorpay made for the wrong amount as a mismatch, never a refusal', async () => {
    queue(answer(200, refundEntity({ amount: 5000 })));
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    // Razorpay answered 200 and a refund exists: money is moving. Releasing
    // the reservation here would free it to be paid out a second time.
    expect(err.kind).toBe('MISMATCH');
    expect(err.providerRefused).toBe(false);
  });

  it('treats a refund made in the wrong currency as a mismatch too', async () => {
    queue(answer(200, refundEntity({ currency: 'USD' })));
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('MISMATCH');
    expect(err.providerRefused).toBe(false);
  });

  it('does not report a refund as settled even when Razorpay already says processed', async () => {
    queue(answer(200, refundEntity({ status: 'processed' })));
    const out = await razorpayAdapter.createRefund(args);
    // A reference to track, and nothing else. Only the signed webhook settles.
    expect(Object.keys(out)).toEqual(['providerRef']);
    expect(out.status).toBeUndefined();
  });

  it('refuses a refund Razorpay made for a different amount', async () => {
    queue(answer(200, refundEntity({ amount: 5000 })));
    await expect(razorpayAdapter.createRefund(args)).rejects.toThrow(/different amount/);
  });

  it('treats an accepted refund with no reference as UNKNOWN', async () => {
    queue(answer(200, { entity: 'refund', amount: 10000, currency: 'INR' }));
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('UNKNOWN');
    expect(err.providerRefused).toBe(false);
  });

  it('marks a 400 as the provider refusing ONLY once the charge shows no such refund', async () => {
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The payment has been fully refunded already' } }),
      // The charge is read before any money is released, and it holds no
      // refund under our key: the refusal is now evidenced by more than a
      // status code.
      answer(200, { entity: 'collection', count: 0, items: [] }),
    );
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('TERMINAL');
    expect(err.providerRefused).toBe(true);
    expect(err.message).toMatch(/fully refunded already/);

    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('GET');
    expect(calls[1].path).toBe('/v1/payments/pay_TESTfakepayment1/refunds');
  });

  // The rule this whole block exists for: a 4xx describes the REQUEST, not the
  // world. Razorpay rejects a replayed idempotency key whose payload differs,
  // so the status that looks most like "no" is exactly the one most likely to
  // be sitting on top of a refund that already happened.
  it('does NOT release the money when a 4xx hides a refund already made under our key', async () => {
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key already used' } }),
      answer(200, {
        entity: 'collection',
        count: 1,
        items: [refundEntity({ id: 'rfnd_TESTrecovered1', notes: { pos_refund_key: 'refund-key-1' } })],
      }),
    );
    const out = await razorpayAdapter.createRefund(args);
    // Recovered, not refused: the reference of the refund that does exist.
    expect(out).toEqual({ providerRef: 'rfnd_TESTrecovered1' });
  });

  it('holds the money when the 4xx cannot be resolved, rather than calling it a refusal', async () => {
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key already used' } }),
      answer(500, { error: { description: 'refund list unavailable' } }),
    );
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('UNKNOWN');
    // The reservation stands. This is the flag that would have released it.
    expect(err.providerRefused).toBe(false);
    expect(err.status).toBe(null);
    expect(err.message).toMatch(/may already exist/);
  });

  // A full page is a page that may have another behind it. "Not in the part I
  // read" is not "not there", and treating it as such releases money on a
  // charge whose later refunds were never looked at.
  it('will not read a truncated refund list as proof that no refund exists', async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      refundEntity({ id: `rfnd_other${i}`, notes: { pos_refund_key: `someone-elses-key-${i}` } }),
    );
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key already used' } }),
      answer(200, { entity: 'collection', count: full.length, items: full }),
    );
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('UNKNOWN');
    expect(err.providerRefused).toBe(false);
  });

  it('refuses to choose when two refunds carry the same key', async () => {
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key already used' } }),
      answer(200, {
        entity: 'collection',
        count: 2,
        items: [
          refundEntity({ id: 'rfnd_first', notes: { pos_refund_key: 'refund-key-1' } }),
          refundEntity({ id: 'rfnd_second', notes: { pos_refund_key: 'refund-key-1' } }),
        ],
      }),
    );
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('UNKNOWN');
    expect(err.providerRefused).toBe(false);
  });

  it('checks a recovered refund against the amount asked for, exactly like a fresh one', async () => {
    queue(
      answer(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'idempotency key already used' } }),
      answer(200, {
        entity: 'collection',
        count: 1,
        items: [refundEntity({ amount: 5000, notes: { pos_refund_key: 'refund-key-1' } })],
      }),
    );
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('MISMATCH');
    expect(err.providerRefused).toBe(false);
  });

  it('resolves a 409 conflict into the refund the concurrent request created', async () => {
    queue(
      answer(409, { error: { description: 'another request with this idempotency key is in progress' } }),
      answer(200, {
        entity: 'collection',
        count: 1,
        items: [refundEntity({ id: 'rfnd_TESTconcurrent', notes: { pos_refund_key: 'refund-key-1' } })],
      }),
    );
    const out = await razorpayAdapter.createRefund(args);
    expect(out).toEqual({ providerRef: 'rfnd_TESTconcurrent' });
  });

  it('leaves a 409 retryable when the conflict produced nothing to find', async () => {
    queue(
      answer(409, { error: { description: 'another request with this idempotency key is in progress' } }),
      answer(200, { entity: 'collection', count: 0, items: [] }),
    );
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('RETRYABLE');
    expect(err.providerRefused).toBe(false);
  });

  // A 5xx or a dead socket already holds the money. Going back to Razorpay
  // there would add a second way to fail and change no decision.
  it('does not go looking after a 5xx, which already holds the money', async () => {
    queue(answer(503, { error: { description: 'service unavailable' } }));
    const err = await razorpayAdapter.createRefund(args).catch((e) => e);
    expect(err.kind).toBe('RETRYABLE');
    expect(err.providerRefused).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('verifyWebhook signature', () => {
  it('accepts a delivery signed with the webhook secret', () => {
    const out = verify(paymentEvent('payment.captured'));
    expect(out.valid).toBe(true);
    expect(out.eventId).toBe('evt_TESTfake000001');
  });

  it('refuses a body signed with the API key secret instead of the webhook secret', () => {
    // These are two different secrets in Razorpay's dashboard, and mixing them
    // up is the likeliest configuration error there is.
    const out = verify(paymentEvent('payment.captured'), { secret: KEY_SECRET });
    expect(out).toEqual({ valid: false, reason: 'signature mismatch' });
  });

  it('refuses a body altered after signing', () => {
    const d = deliver(paymentEvent('payment.captured'));
    const tampered = d.rawBody.replace('"amount":80000', '"amount":1');
    expect(tampered).not.toBe(d.rawBody);
    const out = razorpayAdapter.verifyWebhook({ ...d, rawBody: tampered });
    expect(out.valid).toBe(false);
  });

  it('refuses a missing signature header, and a malformed one', () => {
    const d = deliver(paymentEvent('payment.captured'));
    expect(razorpayAdapter.verifyWebhook({ ...d, headers: { [EVENT_ID_HEADER]: 'e' } }))
      .toEqual({ valid: false, reason: 'signature header missing' });
    expect(razorpayAdapter.verifyWebhook({ ...d, headers: { ...d.headers, [SIGNATURE_HEADER]: 'not-hex' } }).valid)
      .toBe(false);
  });

  it('hands back no event id at all when verification fails', () => {
    // A rejected delivery must not yield an id the caller could store, or a
    // forged id could squat the unique index and block the genuine event.
    const out = verify(paymentEvent('payment.captured'), { secret: 'wrong-secret-entirely' });
    expect(out.eventId).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['reason', 'valid']);
  });

  it('refuses when the event id header is absent, even with a valid signature', () => {
    const d = deliver(paymentEvent('payment.captured'));
    delete d.headers[EVENT_ID_HEADER];
    expect(razorpayAdapter.verifyWebhook(d)).toEqual({ valid: false, reason: 'event id header missing' });
  });

  it('refuses a stale delivery by the created_at inside the signed body', () => {
    const old = paymentEvent('payment.captured', { created_at: Math.floor(Date.now() / 1000) - 4000 });
    expect(verify(old)).toEqual({ valid: false, reason: 'event timestamp missing or outside tolerance' });
  });

  it('refuses a future-dated delivery too', () => {
    const ahead = paymentEvent('payment.captured', { created_at: Math.floor(Date.now() / 1000) + 4000 });
    expect(verify(ahead).valid).toBe(false);
  });

  it('refuses a signed body that is not JSON', () => {
    expect(verify('not json at all')).toEqual({ valid: false, reason: 'signed body is not valid JSON' });
  });
});

describe('verifyWebhook event mapping', () => {
  it('maps payment.captured to a settlement, keyed on the ORDER id', () => {
    const out = verify(paymentEvent('payment.captured'));
    expect(out).toMatchObject({
      valid: true,
      kind: 'payment.succeeded',
      // The attempt we opened and stored — the only reference that matches a
      // PaymentIntent. The pay_ comes back separately.
      providerRef: 'order_TESTfakeorder01',
      chargeRef: 'pay_TESTfakepayment1',
      amountPaise: 80000,
      currency: 'INR',
      method: 'UPI',
    });
  });

  it('maps payment.failed', () => {
    expect(verify(paymentEvent('payment.failed')).kind).toBe('payment.failed');
  });

  it('does NOT map payment.authorized to a success', () => {
    // Authorized is money blocked on a card and not received. Treating it as
    // captured marks an order paid for money the shop never got.
    const out = verify(paymentEvent('payment.authorized', {}, { status: 'authorized', captured: false }));
    expect(out.valid).toBe(true);
    expect(out.kind).toBe('payment.authorized');
    expect(out.kind).not.toBe('payment.succeeded');
  });

  it('passes order.paid through unmapped rather than settling on it', () => {
    const out = verify(paymentEvent('order.paid'));
    expect(out.kind).toBe('order.paid');
  });

  it('maps refund.processed and refund.failed, keyed on the REFUND id', () => {
    const ok = verify(refundEvent('refund.processed'));
    expect(ok).toMatchObject({
      valid: true, kind: 'refund.succeeded', providerRef: 'rfnd_TESTfakerefund1', amountPaise: 10000,
    });
    expect(verify(refundEvent('refund.failed', {}, { status: 'failed' })).kind).toBe('refund.failed');
  });

  it('passes refund.created through unmapped — a created refund has paid nobody', () => {
    expect(verify(refundEvent('refund.created', {}, { status: 'created' })).kind).toBe('refund.created');
  });

  it('records an unrecognised instrument as OTHER rather than guessing', () => {
    expect(verify(paymentEvent('payment.captured', {}, { method: 'netbanking' })).method).toBe('OTHER');
    expect(verify(paymentEvent('payment.captured', {}, { method: 'card' })).method).toBe('CARD');
  });

  it('refuses a non-integer amount instead of coercing it into the wrong money', () => {
    expect(verify(paymentEvent('payment.captured', {}, { amount: 800.5 })).valid).toBe(false);
    expect(verify(paymentEvent('payment.captured', {}, { amount: '80000' })).valid).toBe(false);
    expect(verify(paymentEvent('payment.captured', {}, { amount: -80000 })).valid).toBe(false);
  });

  it('refuses a payment event with no order id — there is nothing to match it to', () => {
    expect(verify(paymentEvent('payment.captured', {}, { order_id: null })))
      .toEqual({ valid: false, reason: 'payment order id missing' });
  });

  it('refuses a refund event with no refund id', () => {
    const e = refundEvent('refund.processed');
    delete e.payload.refund.entity.id;
    expect(verify(e)).toEqual({ valid: false, reason: 'refund id missing' });
  });

  it('survives an event whose payload is missing entirely', () => {
    const e = paymentEvent('payment.captured');
    delete e.payload;
    expect(verify(e)).toEqual({ valid: false, reason: 'payment entity missing' });
  });
});

describe('checkout signature', () => {
  // Razorpay Checkout's browser handoff, signed with the API KEY secret over
  // "<order_id>|<payment_id>" — a different secret and a different payload
  // from the webhook.
  const sign = (orderId, paymentId, secret = KEY_SECRET) =>
    crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  it('accepts a genuine handoff', () => {
    expect(verifyCheckoutSignature({
      orderId: 'order_x', paymentId: 'pay_y', signature: sign('order_x', 'pay_y'), secret: KEY_SECRET,
    })).toBe(true);
  });

  it('refuses a signature over a different order or payment', () => {
    expect(verifyCheckoutSignature({
      orderId: 'order_x', paymentId: 'pay_y', signature: sign('order_x', 'pay_OTHER'), secret: KEY_SECRET,
    })).toBe(false);
    expect(verifyCheckoutSignature({
      orderId: 'order_OTHER', paymentId: 'pay_y', signature: sign('order_x', 'pay_y'), secret: KEY_SECRET,
    })).toBe(false);
  });

  it('refuses one signed with the webhook secret', () => {
    expect(verifyCheckoutSignature({
      orderId: 'order_x', paymentId: 'pay_y', signature: sign('order_x', 'pay_y', WEBHOOK_SECRET), secret: KEY_SECRET,
    })).toBe(false);
  });

  it('refuses missing or non-string input rather than throwing', () => {
    expect(verifyCheckoutSignature({ orderId: 'o', paymentId: 'p', signature: undefined, secret: KEY_SECRET })).toBe(false);
    expect(verifyCheckoutSignature({})).toBe(false);
  });
});
