import { ZodError } from 'zod';
import { AppError, storageBusy } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Prisma signals two transient storage conditions with a code rather than with
// anything a route could sensibly catch, so they arrive here as strangers and
// used to leave as 500 POS_INTERNAL_ERROR — the least useful thing a till can
// say. Both are retryable and neither leaves a partial write behind.
const TRANSIENT_STORAGE_CODES = new Set([
  'P2028', // interactive transaction outlived its budget and was closed
  'P2024', // timed out waiting for a free connection from the pool
]);

export const notFoundHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'POS_NOT_FOUND', message: 'Not found' } });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.field ? { field: err.field } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }
  if (err instanceof ZodError) {
    const first = err.issues?.[0];
    return res.status(400).json({
      error: {
        code: 'POS_BAD_REQUEST',
        message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input',
        field: first?.path?.join('.') || undefined,
      },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'POS_BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  if (TRANSIENT_STORAGE_CODES.has(err?.code)) {
    // Logged, not swallowed: a write the database abandoned is worth seeing in
    // the log even though the caller is told to simply try again. The code goes
    // in the log line because the response deliberately does not carry it.
    logger.warn({ code: err.code, url: req.originalUrl }, 'transient storage failure');
    const busy = storageBusy();
    return res.status(busy.status).json({ error: { code: busy.code, message: busy.message } });
  }

  logger.error({ err, url: req.originalUrl }, 'unhandled error');
  return res
    .status(500)
    .json({ error: { code: 'POS_INTERNAL_ERROR', message: 'Something went wrong handling that request' } });
};
