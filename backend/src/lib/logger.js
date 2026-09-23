import pino from 'pino';
import { env } from '../config/env.js';

export const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // The response side is its own path. Redacting the *request* cookie does
  // nothing to the Set-Cookie that mints the session in the first place, so
  // every successful login used to write a usable token into the log.
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'token',
  'activationKey',
  'licenseKey',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.licenseKey',
  // A discount approval carries the manager's password two levels down —
  // `body.approval.password`. pino's `*` matches exactly ONE level, so the
  // line above does not reach it, and neither does anything else here: a
  // deliberate `logger.info({ body: req.body })` wrote the password out in
  // full, in plain text, with this list already in force.
  //
  // Nothing in the app logs a request body today, so this is depth rather
  // than a live hole — but it is the layer everyone assumes is covering them
  // while they add the log line that needs it. fast-redact has no
  // arbitrary-depth wildcard, so the depths are spelled out: these three
  // reach `approval.password`, `body.approval.password` and
  // `req.body.approval.password` respectively.
  '*.*.password',
  '*.*.*.password',
  '*.*.*.*.password',
];

// A whitelist, where REDACT is a denylist: pino-http logs every response
// header by default, so anything credential-bearing that nobody has thought to
// add to REDACT leaks. Receives the already-serialised {statusCode, headers}.
export const resSerializer = (res) => ({
  statusCode: res.statusCode,
  contentLength: res.headers?.['content-length'],
});

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[REDACTED]' },
});

export default logger;
