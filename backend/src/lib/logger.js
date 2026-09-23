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
  // The discount-approval block is the one place a password legitimately
  // rides inside a request BODY: { approval: { approverEmail, password,
  // reason } }. That puts it two levels down, and `*` above reaches exactly
  // ONE level, so nothing in this list reached it: a deliberate
  // `logger.info({ body: req.body })` wrote the password out in full, in
  // plain text, with the list as it stood.
  //
  // No log path serialises bodies today — pino-http's default req serializer
  // carries no body, and the error handler logs { err, url } only — so this
  // is depth rather than a live hole. But it is the layer everyone assumes
  // is covering them while they add the log line that needs it.
  //
  // fast-redact has no arbitrary-depth wildcard, so the depths are spelled
  // out. Keyed on depth rather than on the name `approval`, because the
  // defect is "a password nested deeper than one level" and `approval` is
  // only today's instance of it — a later `{ body: { manager: { password } } }`
  // is the same bug and is already covered here.
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
