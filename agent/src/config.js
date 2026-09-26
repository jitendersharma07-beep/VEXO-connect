// Where the agent keeps its state, and how it protects the one secret it holds.
//
// The enrolment secret is shown by the server exactly once, at `POST /enrol`,
// and stored server-side only as a sha256 hash. If this file is lost the agent
// cannot re-enrol itself: the enrolment code is cleared in the same write that
// activates the agent, so recovery means a manager issuing a new code. That is
// the intended shape — a till that can silently re-enrol itself is a till whose
// credential can be silently replaced.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AGENT_VERSION = '1.0.0';
// Bumped when the wire conversation with the server changes shape. Reported on
// enrol and heartbeat so a mismatch is visible from the server side rather than
// being discovered as a malformed claim at 9 p.m. on a Friday.
export const PROTOCOL_VERSION = '2026-09-24.print-agents.v1';

export const defaultHome = () => {
  if (process.env.VEXO_AGENT_HOME) return path.resolve(process.env.VEXO_AGENT_HOME);
  if (process.platform === 'win32') {
    return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'VexoPrintAgent');
  }
  if (process.getuid && process.getuid() === 0) return '/var/lib/vexo-print-agent';
  return path.join(os.homedir(), '.vexo-print-agent');
};

export const DEFAULTS = {
  serverUrl: '',
  // 30 s beat against a 90 s staleness window: two may be lost before the
  // server calls the agent offline.
  heartbeatMs: 30_000,
  // The claim poll. Fast enough that a KOT does not visibly lag the kitchen,
  // slow enough that an idle till is not a load generator.
  pollMs: 2_000,
  // Claimed jobs share ONE 60 s lease. Whatever is not delivered inside it is
  // swept to UNCERTAIN even if it printed, so the batch stays small enough that
  // the slowest plausible printer still finishes.
  maxClaim: 3,
  requestTimeoutMs: 15_000,
  connectTimeoutMs: 8_000,
  writeTimeoutMs: 20_000,
  // How long to wait for the printer's FIN after ours. Printers that never
  // close still get a DELIVERED, on weaker evidence. See transport.js.
  closeGraceMs: 2_000,
  logLevel: 'info',
  currencySymbol: 'Rs.',
  timeZone: '',
  // The printer this till is wired to. Print JOBS carry their own target from
  // the server and ignore these; they exist for local diagnostics (`selftest`,
  // `doctor`, `drawer`) and as the route of last resort for a drawer command,
  // which arrives with a pin and two durations but no address.
  printerTransport: 'TCP',
  printerHost: '',
  printerPort: 9100,
  // targetId → { transport, host, port }, for a store with more than one
  // printer that can kick a drawer. Only consulted if the agent has not already
  // learned the address from a print job for that same target.
  drawerTargets: {},
  readDrawerSensor: true,
  // Used for the kick that rides along on a receipt, and by `drawer`. A drawer
  // command from the server carries its own profile, frozen when it was queued,
  // and that always wins.
  drawerPin: 2,
  drawerOnMs: 50,
  drawerOffMs: 200,
  // Which level on the drawer connector's pin 3 means "open". Wiring-dependent,
  // so it is a setting and not an assumption. Confirmed per site by opening the
  // drawer by hand and running `doctor`.
  drawerOpenLevel: 'high',
  // Overrides PrintTarget.widthChars for every target. Only for a site whose
  // measured ruler disagrees with the server record; leave null and fix the
  // server row instead wherever possible.
  widthCharsOverride: null,
  logRetainBytes: 8 * 1024 * 1024,
};

export class AgentHome {
  constructor(home = defaultHome()) {
    this.home = home;
    this.configPath = path.join(home, 'config.json');
    this.credentialPath = path.join(home, 'credentials.json');
    this.journalPath = path.join(home, 'journal.jsonl');
    this.logPath = path.join(home, 'agent.log');
  }

  async ensure() {
    await fsp.mkdir(this.home, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try { await fsp.chmod(this.home, 0o700); } catch { /* best effort on odd filesystems */ }
    }
    return this;
  }

  async readConfig() {
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      if (e.code === 'ENOENT') return { ...DEFAULTS };
      throw new Error(`config at ${this.configPath} is unreadable: ${e.message}`);
    }
  }

  async writeConfig(patch) {
    await this.ensure();
    const next = { ...(await this.readConfig()), ...patch };
    await writePrivate(this.configPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return next;
  }

  async readCredentials() {
    try {
      const raw = await fsp.readFile(this.credentialPath, 'utf8');
      const c = JSON.parse(raw);
      if (!c.agentId || !c.secret) throw new Error('incomplete');
      return c;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`credentials at ${this.credentialPath} are unreadable: ${e.message}`);
    }
  }

  async writeCredentials({ agentId, secret }) {
    await this.ensure();
    await writePrivate(
      this.credentialPath,
      `${JSON.stringify({ agentId, secret, storedAt: new Date().toISOString() }, null, 2)}\n`,
      0o600,
    );
  }

  // Reports what protection is actually in place rather than what was intended,
  // because a 0600 chmod that silently did nothing on a Windows volume is the
  // kind of thing that is only ever noticed in an audit.
  async credentialProtection() {
    try {
      const st = await fsp.stat(this.credentialPath);
      const mode = st.mode & 0o777;
      return {
        exists: true,
        mode: mode.toString(8).padStart(3, '0'),
        worldReadable: process.platform !== 'win32' && Boolean(mode & 0o077),
        path: this.credentialPath,
      };
    } catch {
      return { exists: false, mode: null, worldReadable: false, path: this.credentialPath };
    }
  }
}

const writePrivate = async (target, contents, mode) => {
  const tmp = `${target}.tmp-${process.pid}`;
  // Created with the restrictive mode from the outset — writing 0644 and
  // chmod-ing afterwards leaves a window in which the secret is readable.
  const fd = await fsp.open(tmp, 'w', mode);
  try {
    await fd.writeFile(contents, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fsp.rename(tmp, target);
  if (process.platform !== 'win32') {
    try { await fsp.chmod(target, mode); } catch { /* rename preserved the mode */ }
  }
};

// Anything that might carry the secret goes through here before it is printed
// or logged. The secret's shape (`pas_` + 48 hex) is recognisable, so the mask
// catches it even when it arrives somewhere it was never meant to be.
export const maskSecrets = (value) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return s
    .replace(/pas_[0-9a-f]{8,}/gi, 'pas_***')
    .replace(/pae_[0-9a-f]{8,}/gi, 'pae_***')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1***');
};

export const existsSync = (p) => fs.existsSync(p);
