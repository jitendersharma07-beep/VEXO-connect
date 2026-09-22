// A tunnel pointed at the dev backend would publish the whole POS to the
// internet: login, catalog, orders, reports, every route. Razorpay needs
// exactly one of them.
//
// This forwards POST /api/gateway/webhook and answers 404 to everything else,
// so the tunnel's public hostname is not a way into the POS. It listens on
// loopback, which is all the tunnel client needs, and it is dev-only — the
// production edge is nginx and is not touched by any of this.
//
// The body is relayed as RAW BYTES. The webhook signature is an HMAC over
// exactly what Razorpay sent, so parsing and re-serialising here — which any
// JSON middleware would do — would invalidate every event.

import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.POS_WEBHOOK_PROXY_PORT || 5011);
const TARGET_PORT = Number(process.env.POS_WEBHOOK_TARGET_PORT || 5010);
const PATH = '/api/gateway/webhook';
const MAX_BODY = 256 * 1024; // matches the route's own express.raw limit

// Optional capture of genuine deliveries, off unless a path is given.
//
// This exists to make the duplicate-event test REAL. Re-sending an event needs
// the exact bytes Razorpay signed plus its signature header; anything we
// synthesise ourselves proves our own HMAC round-trips, not that a genuine
// redelivery is refused. Captured lines are written 0600 because a signed body
// is replayable against this backend for as long as the secret stands.
//
// It is dev-only and opt-in: the production edge is nginx and never runs this.
const CAPTURE = process.env.POS_WEBHOOK_CAPTURE || '';
const capture = (headers, body) => {
  if (!CAPTURE) return;
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      signature: headers['x-razorpay-signature'] ?? null,
      eventId: headers['x-razorpay-event-id'] ?? null,
      bodyB64: body.toString('base64'),
    });
    fs.appendFileSync(CAPTURE, `${line}\n`, { mode: 0o600 });
  } catch (err) {
    // Capture is a diagnostic, never a reason to drop a real payment event.
    console.log(`capture failed (delivery unaffected): ${err.message}`);
  }
};

// Only what the signature check and the event log need. Everything else —
// cookies above all, but also authorization and forwarded-identity headers —
// is dropped rather than relayed, so nothing arriving from the tunnel can
// present itself as a signed-in operator.
const FORWARD = new Set([
  'content-type',
  'content-length',
  'x-razorpay-signature',
  'x-razorpay-event-id',
]);

const deny = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
};

const server = http.createServer((req, res) => {
  // Compare the path only: a query string must not smuggle a different route
  // past an equality check on the whole URL.
  const path = (req.url || '').split('?')[0];
  if (req.method !== 'POST' || path !== PATH) {
    console.log(`refused ${req.method} ${path}`);
    return deny(res, 404, 'not found');
  }

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      req.destroy();
      return deny(res, 413, 'body too large');
    }
    chunks.push(c);
  });

  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (FORWARD.has(k.toLowerCase())) headers[k] = v;
    }
    headers['content-length'] = String(body.length);
    capture(headers, body);

    const up = http.request(
      { host: '127.0.0.1', port: TARGET_PORT, method: 'POST', path: PATH, headers },
      (upRes) => {
        console.log(`forwarded webhook -> ${upRes.statusCode}`);
        res.writeHead(upRes.statusCode ?? 502, { 'content-type': 'application/json' });
        upRes.pipe(res);
      },
    );
    up.on('error', () => {
      console.log('backend unreachable on 127.0.0.1:' + TARGET_PORT);
      // 5xx, so the provider retries rather than treating it as delivered.
      deny(res, 502, 'backend unreachable');
    });
    up.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`webhook-only proxy on 127.0.0.1:${PORT}`);
  console.log(`forwarding POST ${PATH} -> 127.0.0.1:${TARGET_PORT}, refusing everything else`);
});
