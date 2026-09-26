// The agent loop: heartbeat, claim, render, deliver, report.
//
// Everything interesting in this file is about what NOT to say. The three
// transport outcomes map onto the protocol like this, and the mapping is the
// product:
//
//   NOT_SENT   → report ok:false. The server re-queues with backoff, or fails
//                the job once attempts run out. Safe, because there is no paper.
//   DELIVERED  → report ok:true → CONFIRMED. Bytes written, channel closed
//                clean. Not "printed".
//   UNCERTAIN  → report NOTHING. The lease expires, the server sweeps the job to
//                UNCERTAIN, and a human resolves it. The contract offers no
//                third value for `ok`, and `ok:false` would mean "print it
//                again" — which is how a kitchen gets two tickets for one dish.
//                Silence is the only correct expression of not knowing.

import os from 'node:os';
import { AGENT_VERSION, PROTOCOL_VERSION } from './config.js';
import { newClaimToken } from './client.js';
import { Builder } from './escpos.js';
import { PHASE } from './journal.js';
import { renderKot, renderReceipt, renderSelfTest } from './render.js';
import { OUTCOME, canReadStatus, deliver } from './transport.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const buildPayload = (job, cfg) => {
  const target = job.target ?? {};
  const widthChars = cfg.widthCharsOverride ?? target.widthChars ?? 48;
  const opts = {
    widthChars,
    currencySymbol: cfg.currencySymbol,
    timeZone: cfg.timeZone || undefined,
    version: AGENT_VERSION,
  };
  const b = job.kind === 'KOT' ? renderKot(job.document ?? {}, opts)
    : job.kind === 'TEST' ? renderSelfTest({ ...opts, info: { target: target.id ?? '', transport: target.transport ?? 'TCP' } })
      : renderReceipt(job.document ?? {}, opts);

  b.feed(1);
  // A drawer kick riding on a receipt is the printer's own connector firing as
  // part of the same byte stream. It is NOT the drawer command channel, has no
  // command row, and produces no acknowledgement — so it can never be read as
  // an observed opening. Receipts only: a KOT must not open a till.
  // The server's job payload carries drawerKick but no pin or durations, so the
  // site profile supplies them. A store wired to pin 5 that leaves this at the
  // default gets a kick on a pin nothing is connected to — silent, harmless and
  // invisible, which is why `doctor` reports the configured pin out loud.
  if (target.drawerKick && job.kind === 'RECEIPT') {
    b.drawer({ drawerPin: cfg.drawerPin, drawerOnMs: cfg.drawerOnMs, drawerOffMs: cfg.drawerOffMs });
  }
  if (target.cut !== false) b.cut(4); else b.feed(4);
  return b.build();
};

export class Runner {
  #stopping = false;
  #claimed = new Map();
  // targetId → the connection details the server sent with a print job. A drawer
  // command names a target but not its address, so the addresses seen on jobs
  // are remembered and reused. Learned from the server, never from the network.
  #routes = new Map();

  constructor({ client, journal, log, config }) {
    this.client = client;
    this.journal = journal;
    this.log = log;
    this.cfg = config;
    this.stats = {
      startedAt: new Date().toISOString(),
      delivered: 0, notSent: 0, uncertain: 0,
      drawerConfirmed: 0, drawerFailed: 0, drawerUncertain: 0,
      lastOutcome: null, lastError: null, heartbeats: 0,
    };
  }

  async recoverFromJournal() {
    const { poisoned, reportable, notStarted } = await this.journal.recover();

    for (const rec of poisoned) {
      // The single most important line in the agent. Bytes were in flight when
      // the process died. Nobody knows how many landed, so this job is never
      // delivered again and never reported — it is left to time out into
      // UNCERTAIN, where a human looks at the paper and decides.
      this.stats.uncertain += 1;
      this.log.warn('recover.poisoned', {
        jobId: rec.jobId, kind: rec.kind,
        note: 'interrupted mid-write; will not re-deliver and will not report — left to expire as UNCERTAIN',
      });
      await this.journal.append(PHASE.ABANDONED, { jobId: rec.jobId, reason: 'crash during write' });
    }

    for (const rec of reportable) {
      try {
        const out = await this.client.reportJob(rec.jobId, { ok: true, detail: 'delivered before restart' });
        await this.journal.append(PHASE.REPORTED, { jobId: rec.jobId, ok: true, serverStatus: out?.status });
        this.log.info('recover.reported', { jobId: rec.jobId, serverStatus: out?.status });
      } catch (e) {
        this.log.warn('recover.report-failed', { jobId: rec.jobId, error: e.message });
      }
    }

    for (const rec of notStarted) {
      try {
        const out = await this.client.reportJob(rec.jobId, {
          ok: false, error: 'AGENT_RESTARTED', detail: 'claimed but no byte was written before restart',
        });
        await this.journal.append(PHASE.REPORTED, { jobId: rec.jobId, ok: false, serverStatus: out?.status });
        this.log.info('recover.requeued', { jobId: rec.jobId, serverStatus: out?.status });
      } catch (e) {
        this.log.warn('recover.requeue-failed', { jobId: rec.jobId, error: e.message });
      }
    }

    const { dropped } = await this.journal.compact();
    this.log.info('recover.done', {
      poisoned: poisoned.length, reported: reportable.length, requeued: notStarted.length, compacted: dropped,
    });
  }

  health() {
    return {
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      hostname: os.hostname(),
      platform: `${process.platform}-${process.arch}`,
      uptimeSec: Math.round(process.uptime()),
      inFlight: this.#claimed.size,
      delivered: this.stats.delivered,
      notSent: this.stats.notSent,
      uncertain: this.stats.uncertain,
      lastOutcome: this.stats.lastOutcome,
    };
  }

  async deliverJob(job) {
    const jobId = job.id;
    let payload;
    try {
      payload = buildPayload(job, this.cfg);
    } catch (e) {
      // A document the renderer cannot read produced no bytes, so nothing was
      // printed and saying so is safe. Retrying will not help, but the server's
      // attempt counter is the right place to decide that.
      this.log.error('render.failed', { jobId, kind: job.kind, error: e.message });
      await this.#report(jobId, { ok: false, error: 'RENDER_FAILED', detail: e.message });
      this.stats.notSent += 1;
      return OUTCOME.NOT_SENT;
    }

    await this.journal.append(PHASE.WRITING, { jobId, kind: job.kind, bytes: payload.length });
    const res = await deliver(job.target, payload, {
      connectTimeoutMs: this.cfg.connectTimeoutMs,
      writeTimeoutMs: this.cfg.writeTimeoutMs,
      closeGraceMs: this.cfg.closeGraceMs,
    });
    this.stats.lastOutcome = res.outcome;

    if (res.outcome === OUTCOME.DELIVERED) {
      await this.journal.append(PHASE.WROTE, { jobId, bytes: res.bytesWritten, ms: res.ms });
      this.stats.delivered += 1;
      const out = await this.#report(jobId, { ok: true, detail: `${res.bytesWritten} bytes, ${res.transport}, ${res.ms} ms` });
      // A clean delivery whose report arrives after the lease has gone leaves
      // the job UNCERTAIN on the server even though the paper is real. Worth a
      // warning, because the operator will see an uncertain job that printed.
      if (out && out.status && out.status !== 'CONFIRMED') {
        this.log.warn('report.late', {
          jobId, serverStatus: out.status,
          note: 'delivered cleanly but the lease had expired; the server keeps its own verdict',
        });
      }
      this.log.info('job.delivered', { jobId, kind: job.kind, bytes: res.bytesWritten, ms: res.ms, serverStatus: out?.status });
      return res.outcome;
    }

    if (res.outcome === OUTCOME.NOT_SENT) {
      this.stats.notSent += 1;
      this.log.warn('job.not-sent', { jobId, kind: job.kind, detail: res.detail, attempts: job.attempts, maxAttempts: job.maxAttempts });
      await this.#report(jobId, { ok: false, error: 'NOT_SENT', detail: res.detail });
      return res.outcome;
    }

    // UNCERTAIN. Deliberately no report.
    this.stats.uncertain += 1;
    await this.journal.append(PHASE.ABANDONED, { jobId, reason: res.detail, bytes: res.bytesWritten });
    this.log.error('job.uncertain', {
      jobId, kind: job.kind, wrote: res.bytesWritten, of: res.payloadBytes, detail: res.detail,
      note: 'NOT reported and NOT retried — the lease will expire and staff will resolve it',
    });
    return res.outcome;
  }

  async #report(jobId, body) {
    try {
      const out = await this.client.reportJob(jobId, body);
      await this.journal.append(PHASE.REPORTED, { jobId, ok: body.ok, serverStatus: out?.status });
      return out;
    } catch (e) {
      // The paper already happened. A report that cannot be delivered is
      // recorded locally and retried on the next start, never re-printed.
      this.log.warn('report.failed', { jobId, ok: body.ok, error: e.message });
      return null;
    }
  }

  async pollJobs() {
    const token = newClaimToken();
    let out;
    try {
      out = await this.client.claimJobs(token, this.cfg.maxClaim);
    } catch (e) {
      this.stats.lastError = e.message;
      this.log.warn('claim.failed', { error: e.message });
      return 0;
    }
    const jobs = out?.jobs ?? [];
    if (!jobs.length) return 0;
    if (out.replayed) this.log.info('claim.replayed', { count: jobs.length });

    // A batch shares one 60 s lease, so the jobs are delivered in order and the
    // agent stops as soon as it is out of time rather than writing bytes for a
    // job the server has already given up on. What it does not deliver is
    // reported as not-sent, which re-queues it cleanly.
    const deadline = Date.now() + 55_000;
    const seen = new Set();
    for (const job of jobs) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      if (job.target?.id && job.target.host) this.#routes.set(job.target.id, job.target);
      await this.journal.append(PHASE.CLAIMED, { jobId: job.id, kind: job.kind, token });
      this.#claimed.set(job.id, job);
      try {
        if (this.#stopping || Date.now() > deadline) {
          await this.#report(job.id, {
            ok: false, error: 'NOT_ATTEMPTED',
            detail: this.#stopping ? 'agent stopping' : 'lease would expire before delivery',
          });
          this.log.info('job.deferred', { jobId: job.id, reason: this.#stopping ? 'stopping' : 'lease' });
          continue;
        }
        await this.deliverJob(job);
      } finally {
        this.#claimed.delete(job.id);
      }
    }
    return jobs.length;
  }

  async pollDrawer() {
    const token = newClaimToken();
    let out;
    try {
      out = await this.client.claimCommands(token, 5);
    } catch (e) {
      this.log.warn('drawer.claim-failed', { error: e.message });
      return 0;
    }
    const commands = out?.commands ?? [];
    for (const cmd of commands) {
      await this.#pulseDrawer(cmd);
    }
    return commands.length;
  }

  // A drawer command says which target to pulse but not how to reach it, so the
  // address comes from somewhere else. Explicit config first, then an address the
  // server itself gave us on a print job for that target, then the single
  // printer this till is wired to — which is the whole fleet in most stores.
  #routeFor(targetId) {
    const configured = this.cfg.drawerTargets?.[targetId];
    if (configured?.host) return { id: targetId, transport: 'TCP', port: 9100, ...configured };
    const learned = this.#routes.get(targetId);
    if (learned?.host) return learned;
    return {
      id: targetId,
      transport: this.cfg.printerTransport ?? 'TCP',
      host: this.cfg.printerHost,
      port: this.cfg.printerPort,
    };
  }

  async #pulseDrawer(cmd) {
    const target = this.#routeFor(cmd.targetId);
    const payload = new Builder().drawer(cmd).build();
    const sensor = canReadStatus(target) && this.cfg.readDrawerSensor !== false;

    if (!target.host) {
      // Nothing was sent and nothing can be, so this is safe to call a failure.
      // Drawer failures are not re-queued, so the till stays shut and a manager
      // is told why instead of a pulse going to an address that does not exist.
      this.stats.drawerFailed += 1;
      await this.#reportCommand(cmd.id, {
        ok: false, error: 'NO_ROUTE',
        detail: `agent has no address for target ${cmd.targetId} — set printerHost or drawerTargets`,
      });
      this.log.error('drawer.no-route', { commandId: cmd.id, targetId: cmd.targetId });
      return;
    }

    await this.journal.append(PHASE.WRITING, { jobId: `cmd:${cmd.id}`, kind: 'DRAWER' });
    const res = await deliver(target, payload, {
      connectTimeoutMs: this.cfg.connectTimeoutMs,
      writeTimeoutMs: this.cfg.writeTimeoutMs,
      closeGraceMs: this.cfg.closeGraceMs,
      // The pulse is 50 ms on, 200 ms off by default, and the till itself takes
      // a moment more to travel. Reading the sensor before it has finished
      // moving measures nothing.
      readStatusAfterMs: sensor ? (Number(cmd.drawerOnMs ?? 50) + Number(cmd.drawerOffMs ?? 200) + 400) : 0,
    });

    if (res.outcome === OUTCOME.DELIVERED) {
      // drawerOpen is sent ONLY when a sensor was genuinely read. Omitting it
      // leaves sensorConfirmed false, and the claim stays "acknowledged" —
      // which is the truth when nothing observed the drawer.
      let drawerOpen;
      if (res.status) {
        drawerOpen = this.cfg.drawerOpenLevel === 'low' ? !res.status.drawerPinHigh : res.status.drawerPinHigh;
      }
      await this.journal.append(PHASE.WROTE, { jobId: `cmd:${cmd.id}` });
      this.stats.drawerConfirmed += 1;
      const out = await this.#reportCommand(cmd.id, { ok: true, detail: `pulse pin ${cmd.drawerPin}`, drawerOpen });
      this.log.info('drawer.acknowledged', {
        commandId: cmd.id, pin: cmd.drawerPin, sensorRead: res.status ? true : false,
        drawerOpen: drawerOpen ?? null, claim: out?.claim ?? null,
      });
      return;
    }

    if (res.outcome === OUTCOME.NOT_SENT) {
      this.stats.drawerFailed += 1;
      // Drawer failure is final: no backoff and no re-queue, because a second
      // pulse opens a till nobody is standing at. A manager reissues by hand.
      await this.#reportCommand(cmd.id, { ok: false, error: 'NOT_SENT', detail: res.detail });
      this.log.warn('drawer.not-sent', { commandId: cmd.id, detail: res.detail });
      return;
    }

    this.stats.drawerUncertain += 1;
    await this.journal.append(PHASE.ABANDONED, { jobId: `cmd:${cmd.id}`, reason: res.detail });
    this.log.error('drawer.uncertain', {
      commandId: cmd.id, detail: res.detail,
      note: 'the pulse may have fired — NOT reported, left to expire as UNCERTAIN',
    });
  }

  async #reportCommand(id, body) {
    try {
      const out = await this.client.reportCommand(id, body);
      await this.journal.append(PHASE.REPORTED, { jobId: `cmd:${id}`, ok: body.ok });
      return out;
    } catch (e) {
      this.log.warn('drawer.report-failed', { commandId: id, error: e.message });
      return null;
    }
  }

  async run({ signal } = {}) {
    await this.recoverFromJournal();
    this.log.info('agent.start', this.health());

    let lastBeat = 0;
    let backoffMs = 0;
    while (!this.#stopping && !signal?.aborted) {
      const now = Date.now();
      if (now - lastBeat >= this.cfg.heartbeatMs) {
        try {
          await this.client.heartbeat(this.health());
          this.stats.heartbeats += 1;
          lastBeat = now;
          backoffMs = 0;
        } catch (e) {
          // The server being unreachable is not a printing failure and must not
          // become one. The agent keeps beating and keeps whatever it knows.
          this.log.warn('heartbeat.failed', { error: e.message });
          backoffMs = Math.min(30_000, (backoffMs || this.cfg.pollMs) * 2);
        }
      }
      try {
        const n = await this.pollJobs();
        await this.pollDrawer();
        if (n > 0) backoffMs = 0;
      } catch (e) {
        this.log.error('poll.failed', { error: e.message });
        backoffMs = Math.min(30_000, (backoffMs || this.cfg.pollMs) * 2);
      }
      await sleep(backoffMs || this.cfg.pollMs);
    }
    this.log.info('agent.stop', this.health());
  }

  stop() { this.#stopping = true; }
}
