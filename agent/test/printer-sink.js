// A printer that does not exist, behaving badly on purpose.
//
// Every delivery outcome the agent must tell apart is a property of how the
// far end behaves, not of the payload — so the only way to test the delivery
// model is to own the far end. This listener can close cleanly, hold the
// connection open, hang up mid-stream, accept and never answer, or refuse
// outright, and it records exactly how many bytes it took before doing so.

import net from 'node:net';

export const MODE = {
  // Reads everything, lets the agent's FIN close the socket. A well-behaved
  // print server: this is the only mode that should ever produce DELIVERED
  // through the clean-close path.
  CLEAN: 'clean',
  // Reads everything and never hangs up. Extremely common in real print
  // servers, and the reason the close grace exists.
  HOLD_OPEN: 'hold-open',
  // Resets the socket after `cutAfter` bytes. The dangerous case: some of the
  // ticket is on paper and nobody can say how much.
  CUT_MID: 'cut-mid',
  // Takes `cutAfter` bytes, throws the rest away, and closes politely. A buffer
  // overrun on a busy unit looks exactly like this, and it is the one failure a
  // one-way channel genuinely cannot see — see the test that says so.
  SHORT_CLEAN: 'short-clean',
  // Accepts the connection and then stops reading. The socket stays healthy and
  // the agent's write stalls once the receive window fills — which is what a
  // printer with the head up or the cover open actually does to a stream.
  BLACKHOLE: 'blackhole',
  // Answers DLE EOT 1 with a status byte, for the drawer sensor path.
  STATUS: 'status',
};

export class PrinterSink {
  #server = null;
  #sockets = new Set();

  constructor({ mode = MODE.CLEAN, cutAfter = 64, statusByte = 0b0001_0010 } = {}) {
    this.mode = mode;
    this.cutAfter = cutAfter;
    this.statusByte = statusByte;
    this.received = [];       // one Buffer per connection, what actually arrived
    this.connections = 0;
  }

  get port() { return this.#server.address().port; }

  get bytes() { return Buffer.concat(this.received); }

  // What a human would read off the roll, with the escapes taken out.
  get text() {
    return this.bytes.toString('latin1')
      .replace(/\x1b@|\x1b[aEM].|\x1d!.|\x1b\x64.|\x1bp.../gs, '')
      .replace(/\x1dV../gs, '\n[cut]\n');
  }

  // Resolves once every connection has gone away, so an assertion about what
  // arrived is not racing the socket's own close event.
  async drained({ timeoutMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.#sockets.size && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return this;
  }

  async start(host = '127.0.0.1') {
    // Without this Node answers the agent's FIN with a FIN of its own before any
    // handler runs, and HOLD_OPEN cannot hold anything open.
    this.#server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.connections += 1;
      this.#sockets.add(socket);
      socket.on('error', () => { /* the test is the one causing these */ });

      if (this.mode === MODE.BLACKHOLE) {
        // No 'data' handler and an explicit pause, so the kernel stops draining
        // and a payload larger than the receive window leaves the agent's write
        // stalled part-way through. Nothing is recorded, which is the point:
        // neither end can say how much of the ticket got through.
        socket.pause();
        socket.on('close', () => this.#sockets.delete(socket));
        return;
      }

      let taken = Buffer.alloc(0);
      let recorded = false;
      // Recorded however the connection ends, including a destroy, so `bytes`
      // always answers "what actually arrived" and never "what arrived on the
      // paths that happened to close politely".
      const record = () => { if (!recorded) { recorded = true; this.received.push(taken); } };

      socket.on('data', (chunk) => {
        if (this.mode === MODE.CUT_MID || this.mode === MODE.SHORT_CLEAN) {
          const room = Math.max(0, this.cutAfter - taken.length);
          if (!recorded) taken = Buffer.concat([taken, chunk.subarray(0, room)]);
          if (taken.length >= this.cutAfter && !recorded) {
            record();
            if (this.mode === MODE.CUT_MID) {
              // An explicit RST. A plain destroy() closes an already-drained
              // socket with a polite FIN, which the agent cannot tell from a
              // successful print — and telling them apart is the whole point.
              socket.resetAndDestroy();
            } else {
              // FIN, and keep draining: the rest of the ticket is accepted by the
              // kernel, discarded by the firmware, and never printed.
              socket.end();
            }
            return;
          }
        } else {
          taken = Buffer.concat([taken, chunk]);
        }
        if (this.mode === MODE.STATUS && chunk.includes(0x10)) {
          socket.write(Buffer.from([this.statusByte]));
        }
      });
      socket.on('end', () => {
        record();
        // HOLD_OPEN deliberately does not call end(): the agent's FIN is
        // answered with silence and the close grace has to carry the outcome.
        if (this.mode === MODE.CLEAN || this.mode === MODE.STATUS) socket.end();
      });
      socket.on('close', () => { record(); this.#sockets.delete(socket); });
    });
    await new Promise((resolve) => this.#server.listen(0, host, resolve));
    return this;
  }

  async stop() {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    if (this.#server) await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }
}

// A port with nothing on it, for the refused case. Bound and released, so the
// number is real and almost certainly still free.
export const deadPort = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};
