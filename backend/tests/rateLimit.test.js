// Rate-limiter control (gateway 429 incident, 2026-09-24). rateLimit.js reads
// NODE_ENV ONCE at module load; under NODE_ENV=test both limiters skip so
// deliberate login failures see 401, not 429. A test runner that sourced the
// dev .env exported NODE_ENV=development, which armed the 300 req/min global
// limiter mid-suite and 429'd gateway.test.js success fixtures. This control
// re-imports the REAL middleware under a stubbed NODE_ENV, so it proves both
// sides no matter what env the harness leaks: armed → the 301st request from
// one IP is 429 POS_RATE_LIMITED; test mode → the skip holds past threshold.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const limiterApp = async (nodeEnv) => {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.resetModules();
  const { globalLimiter } = await import('../src/middleware/rateLimit.js');
  const app = express();
  app.use(globalLimiter);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
};

afterAll(() => {
  // Restore BOTH halves of what limiterApp perturbed: the stubbed env AND the
  // module registry, so no later import sees rateLimit.js cached under a
  // stubbed NODE_ENV.
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('globalLimiter armed (NODE_ENV=production at load)', () => {
  let app;
  beforeAll(async () => {
    app = await limiterApp('production');
  });

  it('lets 300 requests from one IP through, then answers 429 POS_RATE_LIMITED', async () => {
    const statuses = [];
    for (let i = 0; i < 300; i += 1) {
      statuses.push((await request(app).get('/ping')).status);
    }
    expect(statuses).toHaveLength(300);
    expect(statuses.every((s) => s === 200)).toBe(true);

    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: { code: 'POS_RATE_LIMITED', message: 'Too many requests, please slow down' },
    });
  });
});

describe('globalLimiter skipped (NODE_ENV=test at load)', () => {
  let app;
  beforeAll(async () => {
    app = await limiterApp('test');
  });

  it('waves through past the threshold — the isolation the suite relies on', async () => {
    const statuses = [];
    for (let i = 0; i < 301; i += 1) {
      statuses.push((await request(app).get('/ping')).status);
    }
    expect(statuses).toHaveLength(301);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});
