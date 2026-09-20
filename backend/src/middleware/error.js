import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'POS_NOT_FOUND', message: 'Not found' } });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
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
  logger.error({ err, url: req.originalUrl }, 'unhandled error');
  return res
    .status(500)
    .json({ error: { code: 'POS_INTERNAL_ERROR', message: 'Something went wrong handling that request' } });
};
