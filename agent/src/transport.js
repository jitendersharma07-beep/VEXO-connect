// Getting bytes to a printer, and — the part that matters — knowing afterwards
// which of three things happened.
//
// There are exactly three honest answers, and the whole delivery model rests on
// keeping them apart:
//
//   NOT_SENT   We are certain no byte reached the printer. The connection was
//              refused, the device path did not exist, we were denied it. There
//              is no paper and there cannot be, so this is safe to retry and is
//              the ONLY outcome that may be reported as a failure.
//
//   DELIVERED  Every byte was written and the channel closed cleanly — for TCP,
//              the peer acknowledged the whole stream and completed the FIN
//              exchange. This is the strongest statement a one-way print
//              channel can make, and it is still NOT a statement about paper:
//              the printer may be out of paper, jammed, or have its head up.
//              The server's name for this is CONFIRMED, which means "the agent
//              wrote every byte and the connection closed clean" and nothing
//              more. Do not let anything downstream call it "printed".
//
//   UNCERTAIN  Anything in between. A socket that died after some bytes went
//              out; a write that stalled; a close that errored. The job may
//              have printed, printed partially, or not printed. This outcome
//              must never become a retry, because a second copy of a KOT is a
//              second dish and a second copy of a bill is a second bill.
//
// The protocol has no way to say UNCERTAIN: `POST /jobs/:id/report` takes
// `{ok: boolean}`, and `ok:false` sends the job back to QUEUED with a backoff.
// So the agent expresses uncertainty the only way the contract allows — it says
// nothing at all, lets the 60-second lease expire, and lets the server sweep the
// job to UNCERTAIN, where it waits for a human instead of for a retry. Silence
// is load-bearing here. See runner.js.

import net from 'node:net';
import fs from 'node:fs/promises';
import { decodePrinterStatus, CMD } from './escpos.js';

export const OUTCOME = {
  NOT_SENT: 'NOT_SENT',
  DELIVERED: 'DELIVERED',
  UNCERTAIN: 'UNCERTAIN',
};

// Errors that can only happen before a single byte is handed to the network or
// the device. Anything not on this list, once we have started writing, is
// uncertain by default — the list is deliberately short and deliberately not
// extended with "probably fine" cases.
const PRE_WRITE_ERRORS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'ENOENT', 'EACCES', 'EPERM', 'ENXIO', 'ENODEV', 'EISDIR',
]);

const errInfo = (e) => ({
  code: e?.code ?? e?.cause?.code ?? null,
  message: e?.message ?? String(e),
});

const deliverTcp = async (target, payload, opts) => {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8000;
  const writeTimeoutMs = opts.writeTimeoutMs ?? 20000;
  // Many print servers on 9100 hold the connection open after taking a job and
  // never send a FIN. Waiting for a clean close forever would turn every
  // successful print on such a unit into an UNCERTAIN, and every UNCERTAIN costs
  // a person walking to the printer. After the grace expires we accept a weaker
  // but still specific statement: every byte was flushed to the socket and the
  // peer neither errored nor hung up. See the resolve below for what that is
  // worth and what it is not.
  const closeGraceMs = opts.closeGraceMs ?? 2000;
  const host = target.host;
  const port = target.port ?? 9100;
  if (!host) return { outcome: OUTCOME.NOT_SENT, detail: 'target has no host', bytesWritten: 0 };

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let connected = false;
    let writeStarted = false;
    let writeFinished = false;
    let statusByte = null;
    let settled = false;
    let timer = null;
    // A sensor read appends a status query to the stream, so the number of bytes
    // that ought to have gone out is not always the payload length. Counting it
    // separately is what keeps a successful drawer pulse from being read as a
    // short write.
    let extraBytes = 0;
    const expected = () => payload.length + extraBytes;

    const finish = (outcome, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ outcome, detail, bytesWritten: socket.bytesWritten, statusByte });
    };

    const arm = (ms, detail) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // A timeout before the first write is a connection that never happened.
        // A timeout after it is the dangerous case: bytes are in flight and we
        // do not know where they stopped.
        finish(writeStarted ? OUTCOME.UNCERTAIN : OUTCOME.NOT_SENT, detail);
      }, ms);
    };

    arm(connectTimeoutMs, 'connect timed out');

    socket.on('error', (e) => {
      const { code, message } = errInfo(e);
      if (!writeStarted && PRE_WRITE_ERRORS.has(code)) {
        finish(OUTCOME.NOT_SENT, `${code}: ${message}`);
      } else if (!writeStarted) {
        finish(OUTCOME.NOT_SENT, `before any write — ${code ?? 'error'}: ${message}`);
      } else {
        finish(OUTCOME.UNCERTAIN, `after ${socket.bytesWritten} bytes — ${code ?? 'error'}: ${message}`);
      }
    });

    socket.on('close', (hadError) => {
      if (settled) return;
      if (!writeStarted) return finish(OUTCOME.NOT_SENT, 'closed before any write');
      if (hadError) return finish(OUTCOME.UNCERTAIN, 'transport error on close');
      if (!writeFinished) return finish(OUTCOME.UNCERTAIN, 'peer closed mid-write');
      if (socket.bytesWritten !== expected()) {
        return finish(OUTCOME.UNCERTAIN,
          `wrote ${socket.bytesWritten} of ${expected()} bytes`);
      }
      finish(OUTCOME.DELIVERED, 'all bytes written, peer closed clean');
    });

    // Send our FIN and wait. A clean close is the answer we want; the grace
    // timer below is the answer we settle for.
    const endAndWait = () => {
      if (settled) return;
      socket.end();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (socket.writableFinished && socket.bytesWritten === expected()) {
          // Weaker than a clean close: it says the local stack has no bytes of
          // ours left and the peer never complained. It does NOT prove the
          // printer's stack acknowledged the last segment, and — as always — it
          // says nothing about paper.
          finish(OUTCOME.DELIVERED, 'all bytes flushed; peer held the connection open');
        } else {
          finish(OUTCOME.UNCERTAIN,
            `peer held the connection open after ${socket.bytesWritten} of ${expected()} bytes`);
        }
      }, closeGraceMs);
    };

    // A status reply is the only thing a printer sends back on 9100, and only
    // when asked. Anything else on this socket is ignored.
    socket.on('data', (chunk) => { if (chunk.length) statusByte = chunk[chunk.length - 1]; });

    socket.connect(port, host, () => {
      connected = true;
      arm(writeTimeoutMs, 'write timed out');
      writeStarted = true;
      socket.write(payload, (e) => {
        if (e) return; // the 'error' handler owns this
        writeFinished = true;
        if (!opts.readStatusAfterMs) return endAndWait();
        // Give the drawer time to actually move before asking the printer what
        // the sensor pin reads. Asking immediately reads the state before the
        // solenoid has finished, which is a measurement of nothing.
        setTimeout(() => {
          if (settled) return;
          extraBytes += CMD.STATUS_PRINTER.length;
          socket.write(CMD.STATUS_PRINTER);
          setTimeout(endAndWait, opts.statusReadWindowMs ?? 700);
        }, opts.readStatusAfterMs);
      });
    });

    socket.on('end', () => { if (connected && !writeStarted) finish(OUTCOME.NOT_SENT, 'peer ended before write'); });
  });
};

// Windows RAW and Unix device nodes. `host` carries the path — a shared-printer
// UNC name (`\\localhost\POS-80C`), a port (`LPT1`), or a device (`/dev/usb/lp0`).
// There is no status channel here: a device node is write-only in practice, so
// this transport can never observe a drawer sensor and must never claim to.
const deliverFile = async (target, payload) => {
  const path = target.host;
  if (!path) return { outcome: OUTCOME.NOT_SENT, detail: 'target has no path', bytesWritten: 0 };

  let handle = null;
  let written = 0;
  try {
    handle = await fs.open(path, 'w');
  } catch (e) {
    const { code, message } = errInfo(e);
    return { outcome: OUTCOME.NOT_SENT, detail: `open ${code ?? 'failed'}: ${message}`, bytesWritten: 0 };
  }

  try {
    while (written < payload.length) {
      const { bytesWritten } = await handle.write(payload, written, payload.length - written);
      if (bytesWritten <= 0) break;
      written += bytesWritten;
    }
    if (written !== payload.length) {
      return { outcome: OUTCOME.UNCERTAIN, detail: `wrote ${written} of ${payload.length} bytes`, bytesWritten: written };
    }
    try {
      await handle.sync();
    } catch (e) {
      // Character devices and printer shares routinely refuse fsync. That is
      // not a delivery failure and must not be reported as one.
      if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM'].includes(e?.code)) {
        return { outcome: OUTCOME.UNCERTAIN, detail: `sync failed: ${e.message}`, bytesWritten: written };
      }
    }
    await handle.close();
    handle = null;
    return { outcome: OUTCOME.DELIVERED, detail: 'all bytes written and handle closed', bytesWritten: written };
  } catch (e) {
    const { code, message } = errInfo(e);
    return {
      outcome: written === 0 && PRE_WRITE_ERRORS.has(code) ? OUTCOME.NOT_SENT : OUTCOME.UNCERTAIN,
      detail: `${code ?? 'write failed'}: ${message}`,
      bytesWritten: written,
    };
  } finally {
    if (handle) { try { await handle.close(); } catch { /* already failing */ } }
  }
};

export const deliver = async (target, payload, opts = {}) => {
  const started = Date.now();
  const res = target.transport === 'FILE'
    ? await deliverFile(target, payload)
    : await deliverTcp(target, payload, opts);
  return {
    ...res,
    status: decodePrinterStatus(res.statusByte ?? undefined),
    transport: target.transport ?? 'TCP',
    ms: Date.now() - started,
    payloadBytes: payload.length,
  };
};

export const canReadStatus = (target) => target?.transport !== 'FILE';

// Ask the printer how it is, without printing anything.
//
// Deliberately not routed through deliver(): there is no payload here to be
// uncertain about. DLE EOT 1 is a real-time query — three bytes the firmware
// answers out of band rather than queueing — so this is the one thing `doctor`
// can do to a live printer in a busy store without putting a mark on the roll.
export const readStatus = async (target, { connectTimeoutMs = 8000, windowMs = 1200 } = {}) => {
  if (!canReadStatus(target)) {
    return { ok: false, status: null, detail: 'this transport is write-only — no status channel exists' };
  }
  if (!target?.host) return { ok: false, status: null, detail: 'target has no host' };

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok, status, detail) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, status, detail });
    };
    const timer = setTimeout(
      () => done(false, null, `no status reply within ${windowMs} ms`),
      connectTimeoutMs + windowMs,
    );
    socket.on('error', (e) => { clearTimeout(timer); done(false, null, `${e.code ?? 'error'}: ${e.message}`); });
    socket.on('data', (chunk) => {
      for (const byte of chunk) {
        const status = decodePrinterStatus(byte);
        // Every byte is tried and non-status bytes are skipped rather than
        // reported as a bad reply: some firmwares prepend noise, and a reply
        // that fails the fixed-bit check is not an answer about the drawer.
        if (status) { clearTimeout(timer); return done(true, status, 'status byte decoded'); }
      }
    });
    socket.connect(target.port ?? 9100, target.host, () => socket.write(CMD.STATUS_PRINTER));
  });
};
