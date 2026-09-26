#!/usr/bin/env node
// The operator's entire interface to the agent.
//
// The exit codes are part of the contract, because a wrapper script that treats
// every non-zero as "try again" is how a kitchen gets two tickets for one dish:
//
//   0  the thing asked for happened
//   1  the command was wrong — bad arguments, missing config, not enrolled
//   2  a check failed (`doctor`, `status`)
//   3  nothing was sent to the printer, and nothing can have been printed
//   4  UNCERTAIN — bytes were in flight and the outcome is unknown. Never retry
//      on a 4. Look at the paper.
//
// `selftest`, `render` and `doctor` all work before enrolment and without a
// server, which is deliberate: the width of the roll and the wiring of the
// drawer are questions about a printer, and they should be answerable on a till
// that has not been given a credential yet.

import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { PrintAgentClient } from './client.js';
import {
  AGENT_VERSION, AgentHome, DEFAULTS, PROTOCOL_VERSION, defaultHome, maskSecrets,
} from './config.js';
import { Journal } from './journal.js';
import { Log } from './log.js';
import { renderKot, renderReceipt, renderSelfTest } from './render.js';
import { Runner } from './runner.js';
import { OUTCOME, canReadStatus, deliver, readStatus } from './transport.js';
import { Builder } from './escpos.js';

const EXIT = { OK: 0, USAGE: 1, CHECK_FAILED: 2, NOT_SENT: 3, UNCERTAIN: 4 };

const USAGE = `vexo-print-agent ${AGENT_VERSION}  (protocol ${PROTOCOL_VERSION})

  enrol <code> --server <url>   Exchange a one-time enrolment code for this
                               till's credential. The code works exactly once.
  run [--once]                  Claim, print and report until stopped. This is
                               what the service runs.
  selftest [--out <file>]       Print the character ruler. The only thing that
                               settles how many columns this roll fits.
  render --kind <receipt|kot> --in <doc.json> [--out <file>] [--bytes]
                               Turn a document into paper-shaped text without a
                               printer. For rehearsal and for evidence.
  drawer --yes                  Fire one test pulse and read the sensor pin
                               before and after. Opens a real till.
  status [--remote]             What this agent knows about itself.
  doctor [--json]               Every check, each with a verdict and a reason.
  config show | config set k=v  Read and change stored settings.
  uninstall [--purge] --yes     Remove local state. Not reversible.
  version

Common options:
  --home <dir>        Agent state directory (default ${defaultHome()})
  --server <url>      Server base URL, overriding the stored one
  --host <addr>       Printer address for local commands (default from config)
  --port <n>          Printer port (default 9100)
  --transport <t>     TCP or FILE. FILE means --host is a device or share path.
  --width <n>         Characters per line for local rendering
`;

// Flags that take no value, so that `--yes CODE` does not eat the code.
const BOOLEAN_FLAGS = new Set([
  'once', 'remote', 'json', 'bytes', 'yes', 'purge', 'replace', 'help',
  'version', 'verbose', 'quiet', 'no-console',
]);

const parseArgs = (argv) => {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { args.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return { flags, args };
};

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${maskSecrets(String(s))}\n`);

class CliError extends Error {
  constructor(message, code = EXIT.USAGE) { super(message); this.code = code; }
}

const homeFor = (flags) => new AgentHome(flags.home ? path.resolve(flags.home) : defaultHome());

const serverUrlFrom = (cfg, flags) => {
  const url = flags.server ?? process.env.VEXO_SERVER_URL ?? cfg.serverUrl;
  if (!url) {
    throw new CliError('no server URL — pass --server https://host or run `config set serverUrl=...`');
  }
  return String(url).replace(/\/+$/, '');
};

// The printer for the commands that talk to hardware directly. Jobs never come
// through here: they carry their own target from the server.
const localTarget = (cfg, flags) => ({
  id: '(local)',
  transport: String(flags.transport ?? cfg.printerTransport ?? 'TCP').toUpperCase(),
  host: flags.host ?? cfg.printerHost ?? '',
  port: Number(flags.port ?? cfg.printerPort ?? 9100),
  widthChars: Number(flags.width ?? cfg.widthCharsOverride ?? 48),
  cut: flags.cut !== 'false',
  drawerKick: false,
});

const describeTarget = (t) => (t.transport === 'FILE' ? `FILE ${t.host}` : `TCP ${t.host}:${t.port}`);

const requireCredentials = async (home) => {
  const creds = await home.readCredentials();
  if (!creds) {
    throw new CliError(
      `not enrolled — no credential at ${home.credentialPath}.\n`
      + 'Ask a manager for an enrolment code, then run: vexo-print-agent enrol <code> --server <url>',
    );
  }
  return creds;
};

// Outcome → exit code, in one place so every command agrees. The gap between 3
// and 4 is the whole delivery model.
const exitForOutcome = (outcome) => (
  outcome === OUTCOME.DELIVERED ? EXIT.OK
    : outcome === OUTCOME.NOT_SENT ? EXIT.NOT_SENT : EXIT.UNCERTAIN
);

const OUTCOME_TEXT = {
  [OUTCOME.DELIVERED]: 'DELIVERED — every byte was written and the channel closed. '
    + 'This is not a statement that paper came out: check the printer.',
  [OUTCOME.NOT_SENT]: 'NOT SENT — nothing reached the printer, so nothing was printed. Safe to repeat.',
  [OUTCOME.UNCERTAIN]: 'UNCERTAIN — bytes were in flight when the connection failed. '
    + 'It may have printed in whole or in part. Do NOT repeat it blind; look at the paper first.',
};

const reportDelivery = (res) => {
  out('');
  out(OUTCOME_TEXT[res.outcome]);
  out(`  transport   ${res.transport}`);
  out(`  bytes       ${res.bytesWritten} of ${res.payloadBytes}`);
  out(`  elapsed     ${res.ms} ms`);
  out(`  detail      ${res.detail}`);
};

// --- enrol -----------------------------------------------------------------

const cmdEnrol = async ({ flags, args }) => {
  const home = homeFor(flags);
  await home.ensure();
  const code = String(args[0] ?? flags.code ?? '').trim();
  if (!code) throw new CliError('usage: vexo-print-agent enrol <code> --server <url>');

  const cfg = await home.readConfig();
  const serverUrl = serverUrlFrom(cfg, flags);

  const existing = await home.readCredentials();
  if (existing && !flags.replace) {
    // The secret is shown once and stored server-side only as a hash. Overwriting
    // it is how a till ends up with a credential nobody can recover.
    throw new CliError(
      `this till is already enrolled as ${existing.agentId}.\n`
      + 'Enrolling again replaces a credential that cannot be recovered. '
      + 'If that is what you want, add --replace.',
    );
  }

  const client = new PrintAgentClient({ serverUrl, timeoutMs: cfg.requestTimeoutMs });
  out(`Enrolling with ${serverUrl} ...`);
  const res = await client.enrol(code, { hostname: flags.hostname ?? os.hostname() });
  await home.writeCredentials(res);
  await home.writeConfig({ serverUrl });

  const prot = await home.credentialProtection();
  out('');
  out(`Enrolled.  agent ${res.agentId}`);
  out(`  credential  ${prot.path} (mode ${prot.mode})`);
  out(`  host        ${os.hostname()}  ${process.platform}-${process.arch}`);
  if (prot.worldReadable) {
    err('WARNING: the credential file is readable by other users on this machine. '
      + 'Fix the directory permissions before going live.');
  }
  // The server tells an enrolling agent its id and its secret and nothing else,
  // so the agent cannot show which store it now belongs to. Proving the stored
  // credential is accepted is the strongest confirmation available here.
  try {
    await client.heartbeat({ agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, event: 'enrolled' });
    out('  credential  accepted by the server (heartbeat 204)');
  } catch (e) {
    err(`WARNING: the credential was stored but the server rejected it: ${e.message}`);
    err('The secret is not recoverable, so it has NOT been deleted. Run `doctor` before enrolling again.');
    return EXIT.CHECK_FAILED;
  }
  out('');
  out('Next: `vexo-print-agent selftest --host <printer>` to measure the roll, then `run`.');
  return EXIT.OK;
};

// --- run -------------------------------------------------------------------

const cmdRun = async ({ flags }) => {
  const home = homeFor(flags);
  await home.ensure();
  const cfg = await home.readConfig();
  const serverUrl = serverUrlFrom(cfg, flags);
  const creds = await requireCredentials(home);

  const log = await new Log({
    path: home.logPath,
    level: flags.verbose ? 'debug' : (cfg.logLevel ?? 'info'),
    console: !flags.quiet && !flags['no-console'],
    retainBytes: cfg.logRetainBytes,
  }).open();
  const journal = await new Journal(home.journalPath).open();
  const client = new PrintAgentClient({
    serverUrl, agentId: creds.agentId, secret: creds.secret, timeoutMs: cfg.requestTimeoutMs,
  });
  const runner = new Runner({ client, journal, log, config: cfg });

  const ac = new AbortController();
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) {
      // A second signal from an impatient operator. Exiting here can leave a job
      // mid-write, which the journal turns into an UNCERTAIN rather than a
      // duplicate — the right trade, but still worth saying out loud.
      log.warn('agent.force-stop', { signal, note: 'second signal — exiting without finishing the current job' });
      process.exit(EXIT.UNCERTAIN);
    }
    stopping = true;
    log.info('agent.signal', { signal, note: 'finishing the job in hand, then stopping' });
    runner.stop();
    ac.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    if (flags.once) {
      await runner.recoverFromJournal();
      const jobs = await runner.pollJobs();
      const commands = await runner.pollDrawer();
      out(`one pass: ${jobs} job(s), ${commands} drawer command(s)`);
      out(`  delivered ${runner.stats.delivered}  not-sent ${runner.stats.notSent}  uncertain ${runner.stats.uncertain}`);
      if (runner.stats.uncertain) return EXIT.UNCERTAIN;
      if (runner.stats.notSent) return EXIT.NOT_SENT;
      return EXIT.OK;
    }
    await runner.run({ signal: ac.signal });
    return EXIT.OK;
  } finally {
    await journal.close();
    await log.close();
  }
};

// --- selftest --------------------------------------------------------------

const cmdSelftest = async ({ flags }) => {
  const home = homeFor(flags);
  const cfg = await home.readConfig();
  const target = localTarget(cfg, flags);
  const creds = await home.readCredentials().catch(() => null);

  const payload = renderSelfTest({
    widthChars: target.widthChars,
    version: AGENT_VERSION,
    info: {
      agent: creds?.agentId ?? '(not enrolled)',
      host: os.hostname(),
      printer: describeTarget(target),
      protocol: PROTOCOL_VERSION,
      when: new Date().toISOString(),
    },
  }).feed(1).cut(4).build();

  if (flags.out) {
    await fsp.writeFile(flags.out, payload);
    out(`${payload.length} bytes written to ${flags.out} — no printer was contacted.`);
    return EXIT.OK;
  }
  if (!target.host) {
    throw new CliError('no printer address — pass --host, or `config set printerHost=...`, or --out <file>');
  }

  out(`Sending the ${target.widthChars}-column ruler to ${describeTarget(target)} (${payload.length} bytes) ...`);
  const res = await deliver(target, payload, {
    connectTimeoutMs: cfg.connectTimeoutMs,
    writeTimeoutMs: cfg.writeTimeoutMs,
    closeGraceMs: cfg.closeGraceMs,
  });
  reportDelivery(res);
  if (res.outcome === OUTCOME.DELIVERED) {
    out('');
    out('Read the strip. The row of hashes must reach the right edge on ONE line.');
    out(`If it wrapped, the roll is narrower than ${target.widthChars} columns: set the target's`);
    out('widthChars to the last number visible on the ruler. If it stopped short, raise it.');
    out('Photograph the strip — it is the only evidence of the printable width.');
  }
  return exitForOutcome(res.outcome);
};

// --- render ----------------------------------------------------------------

// ESC/POS back to something a human can read. Not a printer emulator: it keeps
// the text and drops the control sequences, which is exactly what is wanted when
// checking that a receipt's columns line up.
const preview = (buf, width = 48) => {
  const lines = [];
  let cur = '';
  let align = 0;
  // Centring is the printer's job, so the bytes carry a trimmed string and an
  // alignment command. Applying it here is what makes this preview resemble the
  // paper rather than the buffer.
  const push = (s) => {
    const t = s.trimEnd();
    if (align === 1) lines.push(' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t);
    else if (align === 2) lines.push(' '.repeat(Math.max(0, width - t.length)) + t);
    else lines.push(s);
  };
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b === 0x0a) { push(cur); cur = ''; continue; }
    if (b === 0x1b) { // ESC
      const c = buf[i + 1];
      if (c === 0x40) { align = 0; i += 1; continue; }             // init
      if (c === 0x61) { align = buf[i + 2]; i += 2; continue; }     // align
      if (c === 0x64) { push(cur); cur = ''; i += 2; continue; }    // feed n
      if (c === 0x70) { push(`${cur}[drawer pulse]`); cur = ''; i += 4; continue; }
      i += 2; // ESC x n — bold, font
      continue;
    }
    if (b === 0x1d) { // GS
      if (buf[i + 1] === 0x56) { push(cur); lines.push('[cut]'); cur = ''; i += 3; continue; }
      i += 2;
      continue;
    }
    if (b === 0x10) { i += 2; continue; } // DLE EOT n
    if (b < 0x20) continue;
    cur += String.fromCharCode(b);
  }
  if (cur) push(cur);
  return lines;
};

const readJson = async (file) => {
  const raw = file && file !== '-' ? await fsp.readFile(file, 'utf8') : await readStdin();
  try { return JSON.parse(raw); } catch (e) { throw new CliError(`${file ?? 'stdin'} is not JSON: ${e.message}`); }
};

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { data += d; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

const cmdRender = async ({ flags }) => {
  const home = homeFor(flags);
  const cfg = await home.readConfig();
  const kind = String(flags.kind ?? 'receipt').toUpperCase();
  if (!['RECEIPT', 'KOT'].includes(kind)) throw new CliError('--kind must be receipt or kot');
  const doc = await readJson(flags.in);
  const width = Number(flags.width ?? cfg.widthCharsOverride ?? 48);
  const opts = {
    widthChars: width, currencySymbol: cfg.currencySymbol, timeZone: cfg.timeZone || undefined, version: AGENT_VERSION,
  };
  const b = kind === 'KOT' ? renderKot(doc, opts) : renderReceipt(doc, opts);
  const payload = b.build();

  const lines = preview(payload, width);
  if (flags.out) {
    await fsp.writeFile(flags.out, flags.bytes ? payload : `${lines.join('\n')}\n`);
    out(`${flags.bytes ? `${payload.length} bytes` : `${lines.length} lines`} written to ${flags.out}`);
    return EXIT.OK;
  }
  out(`+${'-'.repeat(width)}+`);
  for (const line of lines) out(`|${line.padEnd(width).slice(0, width)}|`);
  out(`+${'-'.repeat(width)}+`);
  out(`${payload.length} ESC/POS bytes, ${width} columns. Nothing was sent to a printer.`);
  return EXIT.OK;
};

// --- drawer ----------------------------------------------------------------

const levelWord = (high) => (high ? 'HIGH' : 'LOW');

const cmdDrawer = async ({ flags }) => {
  const home = homeFor(flags);
  const cfg = await home.readConfig();
  const target = localTarget(cfg, flags);
  if (!target.host) throw new CliError('no printer address — pass --host or `config set printerHost=...`');
  if (!flags.yes) {
    throw new CliError('this opens a real cash drawer. Add --yes when someone is standing at the till.');
  }
  const profile = {
    drawerPin: Number(flags.pin ?? cfg.drawerPin ?? 2),
    drawerOnMs: Number(flags.on ?? cfg.drawerOnMs ?? 50),
    drawerOffMs: Number(flags.off ?? cfg.drawerOffMs ?? 200),
  };

  const before = await readStatus(target, { connectTimeoutMs: cfg.connectTimeoutMs });
  out(`before  pin 3 ${before.ok ? levelWord(before.status.drawerPinHigh) : `unread (${before.detail})`}`);

  const payload = new Builder().drawer(profile).build();
  out(`pulse   pin ${profile.drawerPin} for ${profile.drawerOnMs} ms ...`);
  const res = await deliver(target, payload, {
    connectTimeoutMs: cfg.connectTimeoutMs,
    writeTimeoutMs: cfg.writeTimeoutMs,
    closeGraceMs: cfg.closeGraceMs,
    readStatusAfterMs: canReadStatus(target) ? profile.drawerOnMs + profile.drawerOffMs + 400 : 0,
  });
  reportDelivery(res);

  const after = res.status ?? null;
  out('');
  out(`after   pin 3 ${after ? levelWord(after.drawerPinHigh) : 'unread'}`);
  if (before.ok && after) {
    if (before.status.drawerPinHigh !== after.drawerPinHigh) {
      out(`The level changed on the pulse, so the sensor is wired and reading it means something.`);
      out(`With the drawer now open, "open" on this unit is ${levelWord(after.drawerPinHigh)}:`);
      out(`  config set drawerOpenLevel=${after.drawerPinHigh ? 'high' : 'low'}`);
    } else {
      out('The level did not change. Either nothing is wired to pin 3, the drawer did not');
      out('move, or it was already open. This is the case where the honest answer is');
      out('"acknowledged", never "opened".');
    }
  } else {
    out('No sensor reading, so this run says only that the printer took the pulse.');
    out('Acknowledgement is not observation: leave PrintTarget.drawerSensor false.');
  }
  return exitForOutcome(res.outcome);
};

// --- status ----------------------------------------------------------------

const cmdStatus = async ({ flags }) => {
  const home = homeFor(flags);
  const cfg = await home.readConfig();
  const creds = await home.readCredentials().catch(() => null);
  const prot = await home.credentialProtection();
  const journal = new Journal(home.journalPath);
  const recovered = await journal.recover();

  out(`vexo-print-agent ${AGENT_VERSION}   protocol ${PROTOCOL_VERSION}`);
  out(`home        ${home.home}`);
  out(`server      ${cfg.serverUrl || '(unset)'}`);
  out(`agent       ${creds?.agentId ?? '(not enrolled)'}`);
  out(`credential  ${prot.exists ? `mode ${prot.mode}${prot.worldReadable ? '  WORLD-READABLE' : ''}` : 'absent'}`);
  out(`printer     ${cfg.printerHost ? describeTarget(localTarget(cfg, flags)) : '(unset)'}`);
  out(`width       ${cfg.widthCharsOverride ?? '(from each target; schema default 48)'}`);
  out(`drawer      pin ${cfg.drawerPin} ${cfg.drawerOnMs}/${cfg.drawerOffMs} ms, open = ${cfg.drawerOpenLevel}`);
  out(`log         ${home.logPath}`);
  out('');
  out('journal');
  out(`  jobs seen               ${recovered.total}`);
  out(`  owed a report           ${recovered.reportable.length}`);
  out(`  claimed, never written  ${recovered.notStarted.length}`);
  out(`  interrupted mid-write   ${recovered.poisoned.length}${recovered.poisoned.length ? '   <- these will be left UNCERTAIN for a person' : ''}`);

  if (flags.remote) {
    if (!creds) { err('--remote needs a credential; this till is not enrolled.'); return EXIT.CHECK_FAILED; }
    const client = new PrintAgentClient({
      serverUrl: serverUrlFrom(cfg, flags), agentId: creds.agentId, secret: creds.secret, timeoutMs: cfg.requestTimeoutMs,
    });
    try {
      await client.heartbeat({ agentVersion: AGENT_VERSION, event: 'status' });
      out('');
      out('server      heartbeat accepted');
    } catch (e) {
      err(`server      ${e.message}`);
      return EXIT.CHECK_FAILED;
    }
  }
  return recovered.poisoned.length ? EXIT.UNCERTAIN : EXIT.OK;
};

// --- doctor ----------------------------------------------------------------

const cmdDoctor = async ({ flags }) => {
  const home = homeFor(flags);
  const checks = [];
  const add = (name, verdict, detail) => { checks.push({ name, verdict, detail }); };

  const cfg = await home.readConfig();
  const creds = await home.readCredentials().catch(() => null);
  const prot = await home.credentialProtection();
  const target = localTarget(cfg, flags);

  // 1 — state directory
  try {
    const st = await fsp.stat(home.home);
    const mode = (st.mode & 0o777).toString(8);
    add('state directory', 'PASS', `${home.home} mode ${mode}`);
  } catch {
    add('state directory', 'FAIL', `${home.home} does not exist — run enrol, or pass --home`);
  }

  // 2 — settings
  add('server URL', cfg.serverUrl ? 'PASS' : 'FAIL', cfg.serverUrl || 'unset: `config set serverUrl=https://...`');

  // 3 — credential, and how well it is hidden
  if (!prot.exists) add('credential', 'FAIL', 'not enrolled');
  else if (prot.worldReadable) add('credential', 'FAIL', `mode ${prot.mode} — other users on this machine can read the secret`);
  else add('credential', 'PASS', `${prot.path} mode ${prot.mode}`);

  // 4 — the clock. A 60-second lease reasoned about on a till whose clock is ten
  // minutes out produces confident nonsense, and a wrong time is printed on
  // every bill.
  if (cfg.serverUrl) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${cfg.serverUrl}/api/health`, { method: 'GET' });
      const date = res.headers.get('date');
      if (!date) add('clock', 'SKIP', 'the server sent no Date header');
      else {
        const skew = Math.abs(new Date(date).getTime() - (t0 + (Date.now() - t0) / 2));
        add('clock', skew < 30_000 ? 'PASS' : 'FAIL', `${Math.round(skew / 1000)} s from the server`);
      }
    } catch (e) {
      add('clock', 'SKIP', `could not reach the server: ${e.message}`);
    }
  } else add('clock', 'SKIP', 'no server URL');

  // 5 — does the credential still work
  if (creds && cfg.serverUrl) {
    const client = new PrintAgentClient({
      serverUrl: cfg.serverUrl, agentId: creds.agentId, secret: creds.secret, timeoutMs: cfg.requestTimeoutMs,
    });
    try {
      await client.heartbeat({ agentVersion: AGENT_VERSION, event: 'doctor' });
      add('server credential', 'PASS', `accepted for agent ${creds.agentId}`);
    } catch (e) {
      add('server credential', 'FAIL', e.status === 401
        ? 'rejected (401) — this agent may have been revoked; a manager must issue a new code'
        : e.message);
    }
  } else add('server credential', 'SKIP', creds ? 'no server URL' : 'not enrolled');

  // 6 — the printer. A connect and an immediate close: it proves the socket is
  // there and cannot put a mark on the roll.
  if (!target.host) {
    add('printer reachable', 'SKIP', 'no printer configured — `config set printerHost=...`');
  } else if (target.transport === 'FILE') {
    try {
      await fsp.access(target.host, fsp.constants.W_OK);
      add('printer reachable', 'PASS', `${target.host} is writable`);
    } catch (e) {
      add('printer reachable', 'FAIL', `${target.host}: ${e.code ?? e.message}`);
    }
  } else {
    const probe = await new Promise((resolve) => {
      const s = new net.Socket();
      const t = setTimeout(() => { s.destroy(); resolve('timed out'); }, cfg.connectTimeoutMs);
      s.once('error', (e) => { clearTimeout(t); s.destroy(); resolve(e.code ?? e.message); });
      s.connect(target.port, target.host, () => { clearTimeout(t); s.destroy(); resolve(null); });
    });
    add('printer reachable', probe ? 'FAIL' : 'PASS', probe ? `${describeTarget(target)}: ${probe}` : describeTarget(target));
  }

  // 7 — what the printer says about itself, including the drawer pin LEVEL. Not
  // "the drawer is open": the level, with the configured polarity applied, which
  // is a different and much weaker statement.
  if (target.host && canReadStatus(target)) {
    const st = await readStatus(target, { connectTimeoutMs: cfg.connectTimeoutMs });
    if (!st.ok) add('printer status', 'SKIP', st.detail);
    else {
      const open = cfg.drawerOpenLevel === 'low' ? !st.status.drawerPinHigh : st.status.drawerPinHigh;
      add('printer status', st.status.offline ? 'FAIL' : 'PASS',
        `${st.status.offline ? 'OFFLINE' : 'online'}; drawer pin 3 ${levelWord(st.status.drawerPinHigh)}`
        + ` = "${open ? 'open' : 'closed'}" under drawerOpenLevel=${cfg.drawerOpenLevel}`);
    }
  } else add('printer status', 'SKIP', target.host ? 'FILE transport has no status channel' : 'no printer configured');

  // 8 — unfinished business from a previous life
  const recovered = await new Journal(home.journalPath).recover();
  add('journal',
    recovered.poisoned.length ? 'FAIL' : 'PASS',
    recovered.poisoned.length
      ? `${recovered.poisoned.length} job(s) interrupted mid-write and never resolved — run \`run\` to hand them to staff as UNCERTAIN`
      : `${recovered.total} job(s) on file, none interrupted`);

  // 9 — the width, which is an assumption until the ruler is printed
  add('printable width', 'SKIP',
    `${cfg.widthCharsOverride ?? 48} columns is a configured assumption. `
    + 'Only `selftest`, printed and photographed, measures it.');

  const failed = checks.filter((c) => c.verdict === 'FAIL');
  if (flags.json) {
    out(maskSecrets(JSON.stringify({
      agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, at: new Date().toISOString(), checks,
    }, null, 2)));
  } else {
    out(`vexo-print-agent doctor  ${AGENT_VERSION}  ${new Date().toISOString()}`);
    out('');
    for (const c of checks) out(`  ${c.verdict.padEnd(4)}  ${c.name.padEnd(20)} ${c.detail}`);
    out('');
    out(`${checks.filter((c) => c.verdict === 'PASS').length} passed, ${failed.length} failed, `
      + `${checks.filter((c) => c.verdict === 'SKIP').length} not checked`);
  }
  return failed.length ? EXIT.CHECK_FAILED : EXIT.OK;
};

// --- config ----------------------------------------------------------------

const coerce = (key, raw) => {
  const def = DEFAULTS[key];
  if (typeof def === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CliError(`${key} must be a number`);
    return n;
  }
  if (typeof def === 'boolean') {
    if (!['true', 'false'].includes(raw)) throw new CliError(`${key} must be true or false`);
    return raw === 'true';
  }
  if (raw === 'null') return null;
  if (def !== null && typeof def === 'object') {
    try { return JSON.parse(raw); } catch { throw new CliError(`${key} must be JSON`); }
  }
  return raw;
};

const cmdConfig = async ({ flags, args }) => {
  const home = homeFor(flags);
  const sub = args[0] ?? 'show';
  const cfg = await home.readConfig();

  if (sub === 'show') {
    const width = Math.max(...Object.keys(DEFAULTS).map((k) => k.length));
    for (const key of Object.keys(DEFAULTS)) {
      const v = cfg[key];
      out(`${key.padEnd(width)}  ${maskSecrets(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
    }
    out('');
    out(home.configPath);
    return EXIT.OK;
  }

  if (sub !== 'set') throw new CliError('usage: config show | config set key=value [key=value ...]');
  const pairs = args.slice(1);
  if (!pairs.length) throw new CliError('usage: config set key=value [key=value ...]');
  const patch = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new CliError(`"${pair}" is not key=value`);
    const key = pair.slice(0, eq);
    // Unknown keys are refused rather than stored. A typo that silently persists
    // is a setting somebody will swear they changed.
    if (!(key in DEFAULTS)) throw new CliError(`unknown setting "${key}" — see \`config show\``);
    patch[key] = coerce(key, pair.slice(eq + 1));
  }
  const next = await home.writeConfig(patch);
  for (const key of Object.keys(patch)) {
    out(`${key} = ${typeof next[key] === 'object' ? JSON.stringify(next[key]) : next[key]}`);
  }
  return EXIT.OK;
};

// --- uninstall -------------------------------------------------------------

const SERVICE_REMOVAL = {
  win32: 'sc.exe delete VexoPrintAgent    (as Administrator, after `sc.exe stop VexoPrintAgent`)',
  linux: 'sudo systemctl disable --now vexo-print-agent && sudo rm /etc/systemd/system/vexo-print-agent.service',
  darwin: 'sudo launchctl bootout system /Library/LaunchDaemons/com.vexo.printagent.plist',
};

const cmdUninstall = async ({ flags }) => {
  const home = homeFor(flags);
  const prot = await home.credentialProtection();

  out('This command removes local agent state only. It does not stop or remove the');
  out('service, because that needs privileges this process should not be holding.');
  out('');
  out('Stop the service first:');
  out(`  ${SERVICE_REMOVAL[process.platform] ?? 'stop whatever supervises `vexo-print-agent run`'}`);
  out('');
  out(flags.purge ? `Then remove everything under ${home.home}:` : 'Files that would be removed:');
  for (const p of flags.purge ? [home.home] : [home.credentialPath, home.journalPath]) out(`  ${p}`);
  out('');
  if (prot.exists) {
    out('The credential is the one thing here that cannot be recreated. The server holds');
    out('only a hash of it, and the enrolment code was consumed when this agent activated,');
    out('so a manager must issue a new code before this till can print again.');
    out('');
  }
  if (!flags.yes) {
    out('Nothing has been removed. Add --yes to proceed.');
    return EXIT.USAGE;
  }
  if (flags.purge) {
    await fsp.rm(home.home, { recursive: true, force: true });
    out(`removed ${home.home}`);
  } else {
    for (const p of [home.credentialPath, home.journalPath]) {
      await fsp.rm(p, { force: true });
      out(`removed ${p}`);
    }
    out(`kept ${home.configPath} and ${home.logPath}`);
  }
  return EXIT.OK;
};

// --- entry point -----------------------------------------------------------

const COMMANDS = {
  enrol: cmdEnrol,
  enroll: cmdEnrol, // the American spelling reaches the same place
  run: cmdRun,
  selftest: cmdSelftest,
  'self-test': cmdSelftest,
  render: cmdRender,
  drawer: cmdDrawer,
  status: cmdStatus,
  doctor: cmdDoctor,
  config: cmdConfig,
  uninstall: cmdUninstall,
};

const main = async () => {
  const { flags, args } = parseArgs(process.argv.slice(2));
  const name = args.shift();

  if (flags.version || name === 'version') { out(`${AGENT_VERSION} (protocol ${PROTOCOL_VERSION})`); return EXIT.OK; }
  if (!name || flags.help || name === 'help') { out(USAGE); return name ? EXIT.OK : EXIT.USAGE; }

  const command = COMMANDS[name];
  if (!command) { err(`unknown command "${name}"`); out(USAGE); return EXIT.USAGE; }
  return command({ flags, args });
};

main()
  .then((code) => process.exit(code ?? EXIT.OK))
  .catch((e) => {
    if (e instanceof CliError) { err(e.message); process.exit(e.code); }
    // Anything else is a bug or a server saying no. Print it and fail: this is a
    // command line, not the print loop, and there is nothing in flight to lose.
    err(e.stack ? maskSecrets(e.stack) : e.message);
    process.exit(EXIT.CHECK_FAILED);
  });
