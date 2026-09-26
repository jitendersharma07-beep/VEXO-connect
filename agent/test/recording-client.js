// A server that writes down what it was told, so a test can assert on silence.
//
// The runner's product is not a byte stream — it is the set of sentences it says
// to the server, and for UNCERTAIN the correct sentence is none. Asserting "no
// report was sent" needs an instrument that records every call, which is what
// this is. It is a recorder, not a second server: response shapes are copied
// from backend/src/api/routes/printing.js and drawer.js as implemented —
// `{status}` from a job report, `{status, recorded:true}` when the lease has
// already gone, `{commands, replayed}` from a command claim — so a drift between
// them shows up as a failing test rather than as a passing fiction.
//
// The real backend is exercised separately. This file is here for the cases the
// real backend cannot produce on demand: a lease that has already expired, a
// claim that hands back the same job twice, a server that is unreachable at the
// exact moment a report is owed.
//
// What it records is the ARGUMENT the runner passed, not the JSON that would go
// on the wire. The two differ in one place that matters — PrintAgentClient drops
// an undefined `drawerOpen` rather than serialising it — so the wire-level facts
// are asserted against the real client in client.test.js instead.

export class RecordingClient {
  constructor({
    jobs = [],
    commands = [],
    // What the server says back to a job report. 'lease-expired' is the
    // interesting one: a clean delivery whose report arrives too late.
    jobReport = 'normal',
    // Throw on report instead of answering, for "the paper exists and the server
    // cannot be told".
    reportThrows = false,
    drawerSensor = false,
  } = {}) {
    this.pendingJobs = [jobs];
    this.pendingCommands = [commands];
    this.jobReportMode = jobReport;
    this.reportThrows = reportThrows;
    this.drawerSensor = drawerSensor;

    this.calls = [];            // every method, in order
    this.reports = [];          // { id, ...body } per job report
    this.commandReports = [];   // { id, ...body } per drawer report
    this.heartbeats = [];
    this.claimTokens = [];
  }

  #note(method, args) { this.calls.push({ method, ...args }); }

  get authorized() { return true; }

  async heartbeat(health) {
    this.#note('heartbeat', {});
    this.heartbeats.push(health);
    return null; // 204
  }

  async claimJobs(claimToken, max) {
    this.#note('claimJobs', { claimToken, max });
    this.claimTokens.push(claimToken);
    const batch = this.pendingJobs.shift() ?? [];
    return { jobs: batch, replayed: false };
  }

  async reportJob(id, body) {
    this.#note('reportJob', { id, ok: body.ok });
    this.reports.push({ id, ...body });
    if (this.reportThrows) throw new Error('POST /report failed: timed out');
    if (this.jobReportMode === 'lease-expired') {
      // The server's own words for this: too late to change anything, but the
      // report is kept for whoever resolves the job.
      return { status: 'UNCERTAIN', recorded: true };
    }
    return { status: body.ok ? 'CONFIRMED' : 'QUEUED' };
  }

  async claimCommands(claimToken, max) {
    this.#note('claimCommands', { claimToken, max });
    const batch = this.pendingCommands.shift() ?? [];
    return { commands: batch, replayed: false };
  }

  async reportCommand(id, body) {
    this.#note('reportCommand', { id, ok: body.ok });
    this.commandReports.push({ id, ...body });
    if (!body.ok) return { status: 'FAILED', claim: 'UNKNOWN' };
    // sensorConfirmed is the server's, and it needs BOTH a target that declares
    // a sensor and a drawerOpen that came back true. Reproduced here because the
    // agent's job is to make sure the second half is never fabricated.
    const sensorConfirmed = this.drawerSensor === true && body.drawerOpen === true;
    return {
      status: 'CONFIRMED',
      claim: sensorConfirmed ? 'OPENED'
        : this.drawerSensor ? 'ACKNOWLEDGED_NOT_OPENED' : 'ACKNOWLEDGED',
    };
  }

  // Convenience for the assertions that matter most.
  reportsFor(id) { return this.reports.filter((r) => r.id === id); }
  called(method) { return this.calls.filter((c) => c.method === method).length; }
}
