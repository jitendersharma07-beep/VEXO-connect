// Operational log. One JSON object per line to the log file, one readable line
// to the console. Every value passes the secret mask on the way out — a log an
// operator is asked to email must not be a credential leak.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { maskSecrets } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Log {
  #stream = null;

  constructor({ path: logPath, level = 'info', console: toConsole = true, retainBytes = 8 * 1024 * 1024 }) {
    this.path = logPath;
    this.level = LEVELS[level] ?? LEVELS.info;
    this.toConsole = toConsole;
    this.retainBytes = retainBytes;
  }

  async open() {
    if (!this.path) return this;
    // Single generation kept beside the live file. A till fills a disk slowly
    // and nobody is watching; unbounded logs are how it stops selling.
    try {
      const st = await fsp.stat(this.path);
      if (st.size > this.retainBytes) await fsp.rename(this.path, `${this.path}.1`);
    } catch { /* no log yet */ }
    this.#stream = fs.createWriteStream(this.path, { flags: 'a' });
    return this;
  }

  #write(level, event, fields) {
    if (LEVELS[level] < this.level) return;
    const rec = { t: new Date().toISOString(), level, event, ...fields };
    const line = maskSecrets(JSON.stringify(rec));
    if (this.#stream) this.#stream.write(`${line}\n`);
    if (this.toConsole) {
      const detail = Object.entries(fields ?? {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      const out = maskSecrets(`${rec.t} ${level.toUpperCase().padEnd(5)} ${event}${detail ? ` ${detail}` : ''}`);
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${out}\n`);
    }
  }

  debug(event, fields) { this.#write('debug', event, fields); }
  info(event, fields) { this.#write('info', event, fields); }
  warn(event, fields) { this.#write('warn', event, fields); }
  error(event, fields) { this.#write('error', event, fields); }

  async close() {
    if (!this.#stream) return;
    await new Promise((res) => this.#stream.end(res));
    this.#stream = null;
  }
}

export const silentLog = () => {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, open: async () => {}, close: async () => {} };
};
