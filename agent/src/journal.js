// The crash journal: what the agent knew about each job at the moment the power
// went out.
//
// The hazard is narrow and specific. Between "bytes are on their way to the
// printer" and "the server has been told", the agent can die. If it comes back
// and re-delivers, the kitchen gets a second copy of a ticket it already has.
// If it comes back and reports success, the server records paper that may never
// have existed. Neither is acceptable, and the agent cannot tell which happened
// by asking the printer — a thermal printer has no memory of what it printed.
//
// So the agent writes down what it is ABOUT to do before doing it, and fsyncs.
// After a crash the journal is read back and each interrupted job is placed in
// one of two states:
//
//   `writing` with no `wrote`  →  POISONED. Bytes were in flight and we will
//       never know how many landed. The job is never delivered again and never
//       reported. Its lease expires, the server sweeps it to UNCERTAIN, and a
//       human decides — which is exactly the outcome UNCERTAIN exists for.
//
//   `wrote` with no `reported` →  REPORTABLE. The channel closed cleanly before
//       the crash; the delivery is as confirmed as delivery ever gets. The
//       report is simply owed and is sent on restart. If the lease has expired
//       by then the server records it as a late report and leaves the status
//       alone, which is correct and is why the report is safe to send blind.

import fsp from 'node:fs/promises';

export const PHASE = {
  CLAIMED: 'claimed',
  WRITING: 'writing',
  WROTE: 'wrote',
  REPORTED: 'reported',
  ABANDONED: 'abandoned',
};

export class Journal {
  #path;
  #handle = null;

  constructor(path) { this.#path = path; }

  async open() {
    this.#handle = await fsp.open(this.#path, 'a');
    return this;
  }

  // fsync on every record. This is a handful of writes per ticket on a machine
  // that is otherwise idle, and it is the only thing that makes the record
  // survive the power cut it exists to describe.
  async append(phase, fields = {}) {
    const rec = { t: new Date().toISOString(), phase, ...fields };
    await this.#handle.write(`${JSON.stringify(rec)}\n`);
    await this.#handle.sync();
    return rec;
  }

  async close() {
    if (!this.#handle) return;
    await this.#handle.close();
    this.#handle = null;
  }

  async read() {
    try {
      const raw = await fsp.readFile(this.#path, 'utf8');
      return raw.split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async recover() {
    const records = await this.read();
    const byJob = new Map();
    for (const r of records) {
      if (!r.jobId) continue;
      const cur = byJob.get(r.jobId) ?? { jobId: r.jobId, phases: new Set(), last: null };
      cur.phases.add(r.phase);
      cur.last = r;
      byJob.set(r.jobId, cur);
    }
    const poisoned = [];
    const reportable = [];
    const notStarted = [];
    for (const j of byJob.values()) {
      if (j.phases.has(PHASE.REPORTED) || j.phases.has(PHASE.ABANDONED)) continue;
      if (j.phases.has(PHASE.WROTE)) reportable.push(j.last);
      else if (j.phases.has(PHASE.WRITING)) poisoned.push(j.last);
      // `claimed` alone is the good case: the crash landed before a single byte
      // was formed, so the agent KNOWS there is no paper. Left alone the lease
      // would expire and the server would call it UNCERTAIN, which is a job
      // waiting on a human for no reason. Reported as a plain failure instead,
      // it goes back on the queue and prints.
      else if (j.phases.has(PHASE.CLAIMED)) notStarted.push(j.last);
    }
    return { poisoned, reportable, notStarted, total: byJob.size };
  }

  // Keeps the journal from growing forever by dropping records for jobs that
  // reached a terminal phase. Runs at startup, after recovery has read the file,
  // so a crash during compaction loses nothing that recovery still needs.
  async compact() {
    const records = await this.read();
    const terminal = new Set();
    for (const r of records) {
      if (r.jobId && (r.phase === PHASE.REPORTED || r.phase === PHASE.ABANDONED)) terminal.add(r.jobId);
    }
    const keep = records.filter((r) => !r.jobId || !terminal.has(r.jobId));
    if (keep.length === records.length) return { dropped: 0, kept: keep.length };
    const tmp = `${this.#path}.tmp-${process.pid}`;
    const fd = await fsp.open(tmp, 'w');
    try {
      await fd.writeFile(keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (this.#handle) { await this.#handle.close(); this.#handle = null; }
    await fsp.rename(tmp, this.#path);
    await this.open();
    return { dropped: records.length - keep.length, kept: keep.length };
  }
}
