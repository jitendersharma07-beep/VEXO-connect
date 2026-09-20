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
