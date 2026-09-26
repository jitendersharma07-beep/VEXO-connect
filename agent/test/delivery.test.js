// The transport's three answers, one test per way a printer can behave.
//
// These tests exist because the difference between "did not print" and "might
// have printed" cannot be derived from the payload — it is only ever a property
// of the far end. Each case below drives a real socket against test/printer-sink
// and asserts which of NOT_SENT / DELIVERED / UNCERTAIN comes back, because that
// single value decides whether the server is told to print the ticket again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Builder } from '../src/escpos.js';
import { OUTCOME, canReadStatus, deliver, readStatus } from '../src/transport.js';
import { buildPayload } from '../src/runner.js';
import { DEFAULTS } from '../src/config.js';
import { MODE, PrinterSink, deadPort } from './printer-sink.js';
import { receiptDemo, kot } from './fixtures.js';

const ticket = buildPayload(
  { kind: 'RECEIPT', document: receiptDemo, target: { widthChars: 48 } },
  DEFAULTS,
);

const sinkOn = async (mode, extra = {}) => new PrinterSink({ mode, ...extra }).start();
const tcp = (sink) => ({ id: 'tgt_1', transport: 'TCP', host: '127.0.0.1', port: sink.port });

test('a printer that reads the job and hangs up cleanly is DELIVERED', async (t) => {
  const sink = await sinkOn(MODE.CLEAN);
  t.after(() => sink.stop());

  const res = await deliver(tcp(sink), ticket, { closeGraceMs: 2000 });

  assert.equal(res.outcome, OUTCOME.DELIVERED);
  assert.match(res.detail, /peer closed clean/);
  assert.equal(res.bytesWritten, ticket.length);
  // The strongest statement available, and it is still only about bytes: every
  // one of them arrived, in order, and the far end acknowledged the lot.
  assert.deepEqual(sink.bytes, ticket);
  assert.match(sink.text, /TOTAL/);
});

test('a printer that never hangs up is DELIVERED on named, weaker evidence', async (t) => {
  const sink = await sinkOn(MODE.HOLD_OPEN);
  t.after(() => sink.stop());

  const res = await deliver(tcp(sink), ticket, { closeGraceMs: 300 });

  // Holding 9100 open after taking a job is ordinary print-server behaviour. If
  // this produced UNCERTAIN, every single ticket on such a unit would need a
  // human to resolve it, and the outcome would stop meaning anything.
  assert.equal(res.outcome, OUTCOME.DELIVERED);
  assert.equal(res.detail, 'all bytes flushed; peer held the connection open');
  assert.deepEqual(sink.bytes, ticket);
});

test('a printer that dies mid-stream is UNCERTAIN, and the paper proves why', async (t) => {
  const sink = await sinkOn(MODE.CUT_MID, { cutAfter: 200 });
  t.after(() => sink.stop());

  const res = await deliver(tcp(sink), ticket, { closeGraceMs: 2000 });

  assert.equal(res.outcome, OUTCOME.UNCERTAIN);
  assert.notEqual(res.outcome, OUTCOME.NOT_SENT);
  // 200 bytes of a bill reached the far end. Some of the customer's order is on
  // the roll and the agent cannot say which part, so the one thing it must not
  // do is ask for the job again.
  assert.equal(sink.bytes.length, 200);
  assert.ok(sink.bytes.length < ticket.length);
});

test('a printer that truncates politely is DELIVERED — the ceiling of the model', async (t) => {
  // The honest limit. This peer accepted the whole stream at the TCP level,
  // printed part of it, and completed the FIN exchange. Nothing observable
  // distinguishes it from a perfect print, so the agent says DELIVERED and the
  // server says CONFIRMED — which is exactly why CONFIRMED is defined as "every
  // byte was written and the channel closed clean" and never as "printed".
  // Catching this needs the operator, or a printer status the protocol has no
  // field for. It is recorded here so the claim is not mistaken for a stronger
  // one later.
  const sink = await sinkOn(MODE.SHORT_CLEAN, { cutAfter: 200 });
  t.after(() => sink.stop());

  const res = await deliver(tcp(sink), ticket, { closeGraceMs: 2000 });
  await sink.drained();

  assert.equal(res.outcome, OUTCOME.DELIVERED);
  assert.equal(res.bytesWritten, ticket.length);
  assert.equal(sink.bytes.length, 200);
});

test('a printer that stops draining its buffer is UNCERTAIN, never a failure', async (t) => {
  const sink = await sinkOn(MODE.BLACKHOLE);
  t.after(() => sink.stop());

  // Head up, cover open, out of paper on a unit that stops consuming: the socket
  // is healthy, the firmware is not. Needs more bytes than the receive window
  // holds, so this is a deliberately oversized stream rather than a bill.
  const flood = Buffer.alloc(24 * 1024 * 1024, 0x41);
  const res = await deliver(tcp(sink), flood, { writeTimeoutMs: 1200, closeGraceMs: 300 });

  assert.equal(res.outcome, OUTCOME.UNCERTAIN);
  assert.equal(res.detail, 'write timed out');
  assert.equal(sink.connections, 1);
});

test('nothing listening on the port is NOT_SENT', async () => {
  const port = await deadPort();

  const res = await deliver({ transport: 'TCP', host: '127.0.0.1', port }, ticket, {});

  // The only outcome the agent is allowed to report as a failure, and the reason
  // it is allowed: no byte was handed to the network, so there is no paper and
  // there cannot be.
  assert.equal(res.outcome, OUTCOME.NOT_SENT);
  assert.equal(res.bytesWritten, 0);
  assert.match(res.detail, /ECONNREFUSED/);
});

test('a host that does not resolve is NOT_SENT', async () => {
  const res = await deliver(
    { transport: 'TCP', host: 'printer.invalid', port: 9100 },
    ticket,
    { connectTimeoutMs: 2000 },
  );

  // Whether the resolver refuses or the connect simply times out, this happens
  // before the first write, and both paths must land on the same answer.
  assert.equal(res.outcome, OUTCOME.NOT_SENT);
  assert.equal(res.bytesWritten, 0);
});

test('a target with no host at all is NOT_SENT and touches no socket', async () => {
  const res = await deliver({ transport: 'TCP', host: '', port: 9100 }, ticket, {});
  assert.equal(res.outcome, OUTCOME.NOT_SENT);
  assert.equal(res.detail, 'target has no host');
});

test('a device path that does not exist is NOT_SENT, and has no status channel', async () => {
  const target = { transport: 'FILE', host: '/nonexistent/vexo-test/lp0' };

  const res = await deliver(target, ticket, {});

  assert.equal(res.outcome, OUTCOME.NOT_SENT);
  assert.match(res.detail, /open ENOENT/);
  // A device node is write-only in practice, so this transport can never observe
  // a drawer and must never be asked to.
  assert.equal(canReadStatus(target), false);
  const st = await readStatus(target);
  assert.equal(st.ok, false);
  assert.match(st.detail, /write-only/);
});

test('a real device path is DELIVERED byte-for-byte', async (t) => {
  const path = `${process.env.TMPDIR ?? '/tmp'}/vexo-agent-file-target-${process.pid}`;
  t.after(async () => { await (await import('node:fs/promises')).rm(path, { force: true }); });

  const res = await deliver({ transport: 'FILE', host: path }, ticket, {});

  assert.equal(res.outcome, OUTCOME.DELIVERED);
  assert.equal(res.bytesWritten, ticket.length);
  const written = await (await import('node:fs/promises')).readFile(path);
  assert.deepEqual(written, ticket);
});

test('a KOT is never given a drawer kick, and a receipt kick is not a command', () => {
  const target = { widthChars: 48, drawerKick: true };
  const pulse = new Builder().drawer(DEFAULTS).build();

  const receipt = buildPayload({ kind: 'RECEIPT', document: receiptDemo, target }, DEFAULTS);
  const kitchen = buildPayload({ kind: 'KOT', document: kot, target }, DEFAULTS);

  assert.ok(receipt.includes(pulse), 'a receipt on a drawer-kick target carries the pulse');
  // A kitchen ticket opening the till is a cash drawer opening every time a dish
  // is ordered. The server sets drawerKick per target, not per job, so this is
  // the agent's guard and not the server's.
  assert.ok(!kitchen.includes(pulse), 'a KOT must not open a till');
});

test('a drawer pulse with a sensor read is DELIVERED, not a short write', async (t) => {
  // The regression this file exists for: the status query appends three bytes to
  // the stream, so a delivery judged on `bytesWritten === payload.length` called
  // every successful sensor-read pulse UNCERTAIN — and an UNCERTAIN drawer pulse
  // is a till that stays shut with nobody told why.
  const sink = await sinkOn(MODE.STATUS, { statusByte: 0b0001_0110 });
  t.after(() => sink.stop());

  const pulse = new Builder().drawer({ drawerPin: 2, drawerOnMs: 50, drawerOffMs: 200 }).build();
  const res = await deliver(tcp(sink), pulse, {
    closeGraceMs: 500, readStatusAfterMs: 60, statusReadWindowMs: 300,
  });

  assert.equal(res.outcome, OUTCOME.DELIVERED);
  assert.equal(res.bytesWritten, pulse.length + 3);
  assert.equal(res.status.drawerPinHigh, true);
});

test('a status query is answered without printing anything', async (t) => {
  const sink = await sinkOn(MODE.STATUS, { statusByte: 0b0001_0010 });
  t.after(() => sink.stop());

  const st = await readStatus(tcp(sink), { windowMs: 500 });
  await sink.drained();

  assert.equal(st.ok, true);
  assert.equal(st.status.drawerPinHigh, false);
  assert.equal(st.status.offline, false);
  // Three bytes went out and they were the query. Nothing reached the head, so
  // `doctor` can run this against a live till in service hours.
  assert.deepEqual(sink.bytes, Buffer.from([0x10, 0x04, 1]));
});

test('noise that is not a status byte is not an answer about the drawer', async (t) => {
  // 0xFF fails the fixed-bit check. Treating it as a reply would read bit 2 out
  // of a byte that means nothing and hand the server a fabricated observation of
  // an open till.
  const sink = await sinkOn(MODE.STATUS, { statusByte: 0xff });
  t.after(() => sink.stop());

  const st = await readStatus(tcp(sink), { connectTimeoutMs: 1000, windowMs: 400 });

  assert.equal(st.ok, false);
  assert.equal(st.status, null);
  assert.match(st.detail, /no status reply/);
});

test('a printer with no sensor reply still delivers the pulse', async (t) => {
  // Most drawers have no sensor at all. The pulse must still be DELIVERED and
  // the status must be absent rather than guessed — that absence is what keeps
  // the server's claim at "acknowledged" instead of "opened".
  const sink = await sinkOn(MODE.HOLD_OPEN);
  t.after(() => sink.stop());

  const pulse = new Builder().drawer(DEFAULTS).build();
  const res = await deliver(tcp(sink), pulse, {
    closeGraceMs: 300, readStatusAfterMs: 60, statusReadWindowMs: 200,
  });

  assert.equal(res.outcome, OUTCOME.DELIVERED);
  assert.equal(res.status, null);
  assert.equal(res.statusByte, null);
});
