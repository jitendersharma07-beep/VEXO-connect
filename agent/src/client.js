// The wire conversation with the server, and nothing else. No decisions about
// paper are made here.
//
// Route shapes are taken from backend/src/api/routes/printing.js and
// backend/src/api/routes/drawer.js as implemented, not from the older design
// note that describes a different state machine. Both agent surfaces mount at
// /api/print-agents and share one credential.

import { randomBytes } from 'node:crypto';
import { AGENT_VERSION, PROTOCOL_VERSION } from './config.js';

export class ServerError extends Error {
  constructor(status, body, url) {
    super(`${status} from ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'ServerError';
    this.status = status;
    this.body = body;
    // 5xx and 429 are the server having a moment; 4xx is the agent being wrong
    // about something and will not improve by being repeated.
    this.retryable = status >= 500 || status === 429 || status === 408;
  }
}

export const newClaimToken = () => `tok_${randomBytes(12).toString('hex')}`;

export class PrintAgentClient {
  constructor({ serverUrl, agentId, secret, timeoutMs = 15_000, fetchImpl = fetch }) {
    this.base = String(serverUrl ?? '').replace(/\/+$/, '');
    this.agentId = agentId ?? null;
    this.secret = secret ?? null;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get authorized() { return Boolean(this.agentId && this.secret); }

  async #send(method, routePath, body, { auth = true } = {}) {
    const url = `${this.base}/api${routePath}`;
    const headers = {
      'content-type': 'application/json',
      'user-agent': `vexo-print-agent/${AGENT_VERSION} (${PROTOCOL_VERSION})`,
    };
    if (auth) {
      if (!this.authorized) throw new Error('agent is not enrolled — run `vexo-print-agent enrol` first');
      headers.authorization = `Bearer ${this.agentId}.${this.secret}`;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method, headers, signal: ac.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const err = new Error(`${method} ${url} failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
      err.cause = e;
      err.transport = true;
      err.retryable = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep the raw body for the message */ }
    if (!res.ok) throw new ServerError(res.status, parsed, url);
    return parsed;
  }

  // One-shot. The server clears the enrolment code in the same write that
  // activates the agent, so a second call with the same code fails by design.
  async enrol(code, { platform, hostname } = {}) {
    const body = {
      code,
      platform: platform ?? `${process.platform}-${process.arch}`,
      agentVersion: AGENT_VERSION,
      hostname: hostname ?? undefined,
    };
    const out = await this.#send('POST', '/print-agents/enrol', body, { auth: false });
    this.agentId = out.agentId;
    this.secret = out.secret;
    return out;
  }

  heartbeat(health) { return this.#send('POST', '/print-agents/heartbeat', { health }); }

  claimJobs(claimToken, max) {
    return this.#send('POST', '/print-agents/jobs/claim', { claimToken, max });
  }

  // `ok:false` sends the job back to QUEUED with a backoff until maxAttempts is
  // reached. Call it only when it is certain that nothing was printed.
  reportJob(id, { ok, error, detail }) {
    return this.#send('POST', `/print-agents/jobs/${encodeURIComponent(id)}/report`, { ok, error, detail });
  }

  claimCommands(claimToken, max) {
    return this.#send('POST', '/print-agents/commands/claim', { claimToken, max });
  }

  // drawerOpen is omitted unless a sensor was actually read. The server turns it
  // into `sensorConfirmed` only when the target declares a sensor AND this is
  // true, and that flag is the single difference between "the agent says it sent
  // a pulse" and "the drawer was seen to open".
  reportCommand(id, { ok, error, detail, drawerOpen }) {
    const body = { ok, error, detail };
    if (drawerOpen !== undefined) body.drawerOpen = drawerOpen;
    return this.#send('POST', `/print-agents/commands/${encodeURIComponent(id)}/report`, body);
  }
}
