// What the agent tells the server, and — the part that cannot be reviewed by
// reading the code — what it deliberately does not tell it.
//
// The tests in delivery.test.js establish which of the three outcomes a given
// printer produces. These establish the consequence: whether the job is reported
// as done, reported as failed so it prints again, or left in silence so a person
// looks at the paper. Every assertion below is about one of those three, because
// getting it wrong means either a bill nobody has or two bills for one order.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../src/config.js';
import { Builder } from '../src/escpos.js';
import { Journal, PHASE } from '../src/journal.js';
import { silentLog } from '../src/log.js';
import { Runner } from '../src/runner.js';
import { OUTCOME } from '../src/transport.js';
import { MODE, PrinterSink, deadPort } from './printer-sink.js';
import { RecordingClient } from './recording-client.js';
import { kot, receiptDemo } from './fixtures.js';

const tmpHome = async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vexo-agent-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
};

// One runner, one journal on disk, one recording server, and optionally one
// misbehaving printer. Nothing is stubbed between the runner and the socket.
const harness = async (t, { mode = null, client = {}, config = {}, sink: sinkOpts = {} } = {}) => {
  const home = await tmpHome(t);
  const sink = mode ? await new PrinterSink({ mode, ...sinkOpts }).start() : null;
  if (sink) t.after(() => sink.stop());

  const journal = await new Journal(path.join(home, 'journal.jsonl')).open();
  t.after(() => journal.close());

  const rc = client instanceof RecordingClient ? client : new RecordingClient(client);
  const runner = new Runner({
    client: rc,
    journal,
    log: silentLog(),
    config: {
      ...DEFAULTS,
      connectTimeoutMs: 2000,
      writeTimeoutMs: 2000,
      closeGraceMs: 300,
      ...config,
    },
  });
  const target = sink
    ? { id: 'tgt_1', transport: 'TCP', host: '127.0.0.1', port: sink.port, widthChars: 48, cut: true }
    : { id: 'tgt_1', transport: 'TCP', host: '127.0.0.1', port: await deadPort(), widthChars: 48, cut: true };

  return { home, sink, journal, client: rc, runner, target, phases: () => phasesOf(journal) };
};

const phasesOf = async (journal) => {
  const recs = await journal.read();
  const byJob = new Map();
  for (const r of recs) {
    if (!r.jobId) continue;
    byJob.set(r.jobId, [...(byJob.get(r.jobId) ?? []), r.phase]);
  }
  return byJob;
};

const job = (over = {}) => ({
  id: 'job_1', kind: 'RECEIPT', document: receiptDemo, attempts: 1, maxAttempts: 3, ...over,
});

// --- the three outcomes, as sentences to the server ------------------------

test('a clean delivery is reported once, as ok', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN });

  const outcome = await h.runner.deliverJob(job({ target: h.target }));

  assert.equal(outcome, OUTCOME.DELIVERED);
  assert.equal(h.client.reports.length, 1);
  assert.equal(h.client.reports[0].ok, true);
  assert.deepEqual(await h.phases().then((m) => m.get('job_1')),
    [PHASE.WRITING, PHASE.WROTE, PHASE.REPORTED]);
  assert.equal(h.runner.stats.delivered, 1);
});

test('a refused connection is reported as a failure, so the job prints again', async (t) => {
  const h = await harness(t); // no sink: nothing is listening

  const outcome = await h.runner.deliverJob(job({ target: h.target }));

  assert.equal(outcome, OUTCOME.NOT_SENT);
  assert.equal(h.client.reports.length, 1);
  assert.equal(h.client.reports[0].ok, false);
  assert.equal(h.client.reports[0].error, 'NOT_SENT');
  // ok:false is a request to re-queue. It is only ever safe because NOT_SENT
  // means no byte left the machine.
  assert.match(h.client.reports[0].detail, /ECONNREFUSED/);
});

test('an uncertain delivery is reported to NOBODY', async (t) => {
  // The single most important test in the agent. A socket that died with bytes in
  // flight must produce silence: ok:true would record paper that may not exist,
  // and ok:false would ask the kitchen to cook the dish twice. The protocol has
  // no third value, so the agent says nothing and lets the lease expire.
  const h = await harness(t, { mode: MODE.CUT_MID, sink: { cutAfter: 200 } });

  const outcome = await h.runner.deliverJob(job({ target: h.target }));

  assert.equal(outcome, OUTCOME.UNCERTAIN);
  assert.equal(h.client.reports.length, 0);
  assert.equal(h.client.called('reportJob'), 0);
  // Recorded locally instead, so the next start knows this job is finished with.
  assert.deepEqual(await h.phases().then((m) => m.get('job_1')),
    [PHASE.WRITING, PHASE.ABANDONED]);
  assert.equal(h.runner.stats.uncertain, 1);
});

test('an uncertain delivery is never re-sent by the agent', async (t) => {
  const h = await harness(t, { mode: MODE.CUT_MID, sink: { cutAfter: 200 } });

  await h.runner.deliverJob(job({ target: h.target }));
  // The server is the only thing that may ever re-offer this job, and it will
  // not: a DISPATCHED job whose lease expires goes to UNCERTAIN, not QUEUED.
  // What is asserted here is that the agent has no retry of its own.
  assert.equal(h.sink.connections, 1);
  assert.equal(h.client.calls.length, 0);
});

test('a document the renderer cannot read is a failure, not an uncertainty', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN });

  const outcome = await h.runner.deliverJob(job({ document: { items: 7 }, target: h.target }));

  // No bytes were formed, let alone sent, so this is safe to call a failure and
  // must not be dressed up as one. The server's attempt counter decides when to
  // stop trying.
  assert.equal(outcome, OUTCOME.NOT_SENT);
  assert.equal(h.sink.connections, 0);
  assert.equal(h.client.reports[0].error, 'RENDER_FAILED');
});

test('a report the server never receives does not cause a reprint', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN, client: { reportThrows: true } });

  const outcome = await h.runner.deliverJob(job({ target: h.target }));

  assert.equal(outcome, OUTCOME.DELIVERED);
  assert.equal(h.sink.connections, 1);
  // The attempt is recorded and the paper is not reprinted. The journal keeps a
  // `wrote` with no `reported`, which is what makes the owed report survive a
  // restart — see the recovery tests below.
  const phases = await h.phases().then((m) => m.get('job_1'));
  assert.deepEqual(phases, [PHASE.WRITING, PHASE.WROTE]);
});

test('a clean delivery whose lease already expired is reported and not reprinted', async (t) => {
  // A slow printer can finish after the 60 s lease. The paper is real, the
  // server's verdict is UNCERTAIN, and the agent must not try to change that by
  // printing again — it reports once and leaves the disagreement visible.
  const h = await harness(t, { mode: MODE.CLEAN, client: { jobReport: 'lease-expired' } });

  const outcome = await h.runner.deliverJob(job({ target: h.target }));

  assert.equal(outcome, OUTCOME.DELIVERED);
  assert.equal(h.client.reports.length, 1);
  assert.equal(h.client.reports[0].ok, true);
  assert.equal(h.sink.connections, 1);
});

// --- claims: duplicates, competing consumers, shutdown ---------------------

test('the same job offered twice in one claim is printed once', async (t) => {
  const dup = job({ target: null });
  const h = await harness(t, { mode: MODE.CLEAN });
  dup.target = h.target;
  h.client.pendingJobs = [[dup, { ...dup }]];

  const n = await h.runner.pollJobs();

  assert.equal(n, 2, 'the server offered two rows');
  assert.equal(h.sink.connections, 1, 'one ticket reached the printer');
  assert.equal(h.client.reportsFor('job_1').length, 1);
});

test('a runner that is stopping writes no bytes and hands the claim back', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN });
  h.client.pendingJobs = [[job({ target: h.target }), job({ id: 'job_2', target: h.target })]];

  // A service stop, a till being switched off at the end of the night, a
  // restart for an update: whatever the reason, a held claim must go back to the
  // queue rather than expire into UNCERTAIN, because nothing was printed.
  h.runner.stop();
  await h.runner.pollJobs();

  assert.equal(h.sink.connections, 0);
  assert.equal(h.client.reports.length, 2);
  for (const r of h.client.reports) {
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NOT_ATTEMPTED');
    assert.match(r.detail, /stopping/);
  }
});

test('each claim carries a fresh replayable token', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN });

  await h.runner.pollJobs();
  await h.runner.pollJobs();

  assert.equal(h.client.claimTokens.length, 2);
  assert.notEqual(h.client.claimTokens[0], h.client.claimTokens[1]);
  // The token is what makes a lost claim response safe to retry: the server
  // hands the same rows back rather than dispatching them to a second consumer.
  for (const tok of h.client.claimTokens) assert.match(tok, /^tok_[0-9a-f]{24}$/);
});

// --- crash recovery -------------------------------------------------------

const seedJournal = async (t, records) => {
  const home = await tmpHome(t);
  const p = path.join(home, 'journal.jsonl');
  await fsp.writeFile(p, records.map((r) => JSON.stringify({ t: new Date().toISOString(), ...r })).join('\n') + '\n');
  return p;
};

const recoverWith = async (t, records, opts = {}) => {
  const p = await seedJournal(t, records);
  const journal = await new Journal(p).open();
  t.after(() => journal.close());
  const client = new RecordingClient(opts.client ?? {});
  const runner = new Runner({ client, journal, log: silentLog(), config: { ...DEFAULTS } });
  await runner.recoverFromJournal();
  return { runner, client, journal, phases: () => phasesOf(journal) };
};

test('a crash mid-write is never re-delivered and never reported', async (t) => {
  const r = await recoverWith(t, [
    { phase: PHASE.CLAIMED, jobId: 'job_9', kind: 'KOT' },
    { phase: PHASE.WRITING, jobId: 'job_9', kind: 'KOT', bytes: 812 },
  ]);

  // Bytes were on their way to the printer when the power went out. A thermal
  // printer has no memory of what it printed, so nobody can ever establish how
  // much of that ticket exists. Silence, and a human.
  assert.equal(r.client.reports.length, 0);
  assert.equal(r.runner.stats.uncertain, 1);
});

test('a delivery completed before the crash is reported, not reprinted', async (t) => {
  const r = await recoverWith(t, [
    { phase: PHASE.CLAIMED, jobId: 'job_8', kind: 'RECEIPT' },
    { phase: PHASE.WRITING, jobId: 'job_8', kind: 'RECEIPT', bytes: 1024 },
    { phase: PHASE.WROTE, jobId: 'job_8', bytes: 1024, ms: 40 },
  ]);

  assert.equal(r.client.reports.length, 1);
  assert.equal(r.client.reports[0].ok, true);
  assert.equal(r.client.reports[0].detail, 'delivered before restart');
});

test('a claim held with no byte written goes back on the queue', async (t) => {
  const r = await recoverWith(t, [{ phase: PHASE.CLAIMED, jobId: 'job_7', kind: 'KOT' }]);

  // The good case: the crash landed before any byte was formed, so the agent
  // KNOWS there is no paper. Reporting it as a plain failure prints the ticket
  // instead of parking it in front of a manager for no reason.
  assert.equal(r.client.reports.length, 1);
  assert.equal(r.client.reports[0].ok, false);
  assert.equal(r.client.reports[0].error, 'AGENT_RESTARTED');
});

test('restarting twice does not report twice', async (t) => {
  const p = await seedJournal(t, [
    { phase: PHASE.CLAIMED, jobId: 'job_6', kind: 'RECEIPT' },
    { phase: PHASE.WRITING, jobId: 'job_6', kind: 'RECEIPT' },
    { phase: PHASE.WROTE, jobId: 'job_6' },
  ]);
  const journal = await new Journal(p).open();
  t.after(() => journal.close());
  const client = new RecordingClient();
  const mk = () => new Runner({ client, journal, log: silentLog(), config: { ...DEFAULTS } });

  await mk().recoverFromJournal();
  await mk().recoverFromJournal();

  // A till that reboots twice in a minute is not exotic. The `reported` record
  // and the compaction that follows it are what keep the second pass silent.
  assert.equal(client.reports.length, 1);
});

test('a job already reported or abandoned is not revisited', async (t) => {
  const r = await recoverWith(t, [
    { phase: PHASE.WRITING, jobId: 'job_a' },
    { phase: PHASE.ABANDONED, jobId: 'job_a', reason: 'crash during write' },
    { phase: PHASE.WROTE, jobId: 'job_b' },
    { phase: PHASE.REPORTED, jobId: 'job_b', ok: true },
  ]);

  assert.equal(r.client.reports.length, 0);
  // Terminal records are dropped, so the journal does not grow forever on a till
  // that prints a thousand tickets a week.
  assert.equal((await r.phases()).size, 0);
});

// --- the drawer: acknowledgement is not observation ------------------------

const command = (over = {}) => ({
  id: 'cmd_1', kind: 'OPEN', targetId: 'tgt_1',
  drawerPin: 2, drawerOnMs: 50, drawerOffMs: 200,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), ...over,
});

test('a pulse with no sensor reply states nothing about the drawer', async (t) => {
  // The whole drawer model rests on this. A drawerOpen of false would be a claim
  // about the hardware; leaving it undefined keeps the server at "the agent drove
  // the pin", which is the only thing that actually happened.
  //
  // Asserted as undefined rather than as an absent key because the key is dropped
  // one layer further out, in PrintAgentClient.reportCommand — that the JSON on
  // the wire has no drawerOpen field is client.test.js's assertion.
  const h = await harness(t, {
    mode: MODE.HOLD_OPEN,
    config: { printerHost: '127.0.0.1' },
  });
  h.runner.cfg.printerPort = h.sink.port;
  h.client.pendingCommands = [[command()]];

  await h.runner.pollDrawer();

  assert.equal(h.client.commandReports.length, 1);
  const body = h.client.commandReports[0];
  assert.equal(body.ok, true);
  assert.equal(body.drawerOpen, undefined);
  assert.notEqual(body.drawerOpen, false);
});

test('a sensor that reads open reports drawerOpen true and claims OPENED', async (t) => {
  const h = await harness(t, {
    mode: MODE.STATUS,
    sink: { statusByte: 0b0001_0110 },
    config: { printerHost: '127.0.0.1', drawerOnMs: 50, drawerOffMs: 200 },
    client: new RecordingClient({ drawerSensor: true }),
  });
  h.runner.cfg.printerPort = h.sink.port;
  h.client.pendingCommands = [[command()]];

  await h.runner.pollDrawer();

  assert.equal(h.client.commandReports[0].drawerOpen, true);
  assert.equal(h.runner.stats.drawerConfirmed, 1);
});

test('a sensor that reads shut reports drawerOpen false — a jam, not a success', async (t) => {
  // Pin 3 low with the pulse delivered means the solenoid fired and the drawer
  // did not move. The server turns this into ACKNOWLEDGED_NOT_OPENED, which is
  // the pair of facts a manager needs.
  const h = await harness(t, {
    mode: MODE.STATUS,
    sink: { statusByte: 0b0001_0010 },
    config: { printerHost: '127.0.0.1' },
    client: new RecordingClient({ drawerSensor: true }),
  });
  h.runner.cfg.printerPort = h.sink.port;
  h.client.pendingCommands = [[command()]];

  await h.runner.pollDrawer();

  assert.equal(h.client.commandReports[0].ok, true);
  assert.equal(h.client.commandReports[0].drawerOpen, false);
});

test('reversed drawer wiring is a setting, not a lie about the hardware', async (t) => {
  const h = await harness(t, {
    mode: MODE.STATUS,
    sink: { statusByte: 0b0001_0010 },   // pin 3 LOW
    config: { printerHost: '127.0.0.1', drawerOpenLevel: 'low' },
    client: new RecordingClient({ drawerSensor: true }),
  });
  h.runner.cfg.printerPort = h.sink.port;
  h.client.pendingCommands = [[command()]];

  await h.runner.pollDrawer();

  assert.equal(h.client.commandReports[0].drawerOpen, true);
});

test('a drawer command for an address the agent does not know is refused, not guessed', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN, config: { printerHost: '' } });
  h.client.pendingCommands = [[command({ targetId: 'tgt_unknown' })]];

  await h.runner.pollDrawer();

  // The command payload names a target but carries no address, so an agent with
  // nothing configured has genuinely nowhere to send it. Saying so beats pulsing
  // a host that does not exist.
  assert.equal(h.sink.connections, 0);
  assert.equal(h.client.commandReports[0].ok, false);
  assert.equal(h.client.commandReports[0].error, 'NO_ROUTE');
  assert.match(h.client.commandReports[0].detail, /printerHost|drawerTargets/);
});

test('an address learned from a print job is reused for that target’s drawer', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN, config: { printerHost: '' } });
  h.client.pendingJobs = [[job({ target: h.target })]];

  await h.runner.pollJobs();   // teaches the agent where tgt_1 lives
  h.client.pendingCommands = [[command({ targetId: 'tgt_1' })]];
  await h.runner.pollDrawer();

  assert.equal(h.client.commandReports[0].ok, true);
  assert.equal(h.sink.connections, 2, 'one for the bill, one for the pulse');
  // Learned from the server on a job for the same target — never discovered by
  // probing the network.
  const pulse = new Builder().drawer({ drawerPin: 2, drawerOnMs: 50, drawerOffMs: 200 }).build();
  assert.ok(sinkHas(h.sink, pulse));
});

test('an uncertain pulse is not reported either', async (t) => {
  const h = await harness(t, {
    mode: MODE.CUT_MID,
    sink: { cutAfter: 2 },
    config: { printerHost: '127.0.0.1' },
  });
  h.runner.cfg.printerPort = h.sink.port;
  h.client.pendingCommands = [[command()]];

  await h.runner.pollDrawer();

  // The solenoid may have fired. Reporting a failure would let a manager reissue
  // and open a till twice; reporting success would claim a pulse nobody can
  // vouch for. Silence, and the command expires as UNCERTAIN.
  assert.equal(h.client.commandReports.length, 0);
  assert.equal(h.runner.stats.drawerUncertain, 1);
});

test('a drawer pulse is not re-queued when nothing was sent', async (t) => {
  const h = await harness(t, { config: { printerHost: '127.0.0.1', printerPort: await deadPort() } });
  h.client.pendingCommands = [[command()]];

  await h.runner.pollDrawer();

  assert.equal(h.client.commandReports[0].ok, false);
  assert.equal(h.client.commandReports[0].error, 'NOT_SENT');
  // The server does not back off and retry a drawer command, by design: a second
  // pulse opens a till nobody is standing at. A manager reissues by hand.
  assert.equal(h.runner.stats.drawerFailed, 1);
});

test('a KOT job does not kick the drawer even on a drawer-kick target', async (t) => {
  const h = await harness(t, { mode: MODE.CLEAN });

  await h.runner.deliverJob(job({
    id: 'job_kot', kind: 'KOT', document: kot, target: { ...h.target, drawerKick: true },
  }));

  const pulse = new Builder().drawer(DEFAULTS).build();
  assert.equal(h.client.reports[0].ok, true);
  assert.equal(sinkHas(h.sink, pulse), false);
  assert.match(h.sink.text, /KOT/);
});

const sinkHas = (sink, needle) => sink.received.some((b) => b.includes(needle));
