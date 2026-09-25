// CORS refusal legibility control (F-9, docs/CLIENT-HANDOVER-SCOPE.md).
//
// The ledger filed F-9 as "cosmetic and deferred": a browser whose Origin is not
// on the allow-list got 500 POS_INTERNAL_ERROR, "Something went wrong handling
// that request", where 403 would be accurate. It is not cosmetic. A staging
// session lost a debugging session to it — sign-in answered 500, which reads as
// a server fault, and the actual fault was one CORS_ORIGIN value with the wrong
// port. What made it expensive is the line above the refusal: a request with NO
// Origin header is waved through, because CORS is a browser mechanism and cannot
// bind a client that simply omits the header. So every curl probe returned 200
// and only a real browser failed, which is the hardest shape of bug to read.
//
// This file pins all three behaviours, because the refusal and the wave-through
// only make sense as a pair:
//   1. an allowed origin is approved AND echoed back — without this the refusal
//      tests would pass on an app that refuses everything;
//   2. no Origin header is still let through, and carries no allow-origin
//      header — the curl blind spot, pinned so nobody removes it by accident
//      while believing they are tightening CORS;
//   3. a refused origin leaves as 403 POS_ORIGIN_NOT_ALLOWED naming the origin,
//      and is still refused — no allow-origin header comes back. A legible
//      refusal must not become a permitted one.
//
// Reads only: every request is GET /api/health, which is one SELECT 1.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// Two entries, comma-separated and deliberately whitespace-padded, because that
// is the shape a deployment actually sets — app.js splits and trims, and a
// regression there would silently allow nothing.
const ALLOWED = 'http://localhost:5177';
const ALSO_ALLOWED = 'https://pos.example.test';
const REFUSED = 'https://not-this-one.example';

let app;

beforeAll(async () => {
  // Stubbed then re-imported, so what is exercised is the real cors() block in
  // src/app.js reading a known allow-list, not a copy of it written here that
  // could drift from the mounted one.
  vi.stubEnv('CORS_ORIGIN', `${ALLOWED} ,  ${ALSO_ALLOWED} `);
  vi.resetModules();
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(() => {
  // Restore both halves, so no later import sees config/env.js cached under a
  // stubbed CORS_ORIGIN.
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('an allowed browser origin is approved', () => {
  it('lets the first allow-list entry through and echoes it back', async () => {
    const res = await request(app).get('/api/health').set('Origin', ALLOWED);
    expect(res.status).toBe(200);
    // The echo is the proof cors() approved it. A 200 alone would not be: the
    // route would answer 200 even if the middleware had been removed entirely.
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('lets a later, whitespace-padded entry through too', async () => {
    const res = await request(app).get('/api/health').set('Origin', ALSO_ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALSO_ALLOWED);
  });
});

describe('no Origin header is waved through — the reason curl could not see F-9', () => {
  it('answers 200 with no allow-origin header, exactly as before', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is waved through even when the allow-list would refuse everything', async () => {
    // The point restated as a control: this is not "the allow-list happens to
    // contain the caller", it is "there is nothing to check". Any future change
    // that made an unknown origin refuse MUST leave this case alone, or every
    // health probe and server-to-server call in the deployment starts failing.
    vi.resetModules();
    vi.stubEnv('CORS_ORIGIN', 'https://nothing-matches.example');
    const { createApp } = await import('../src/app.js');
    const strict = createApp();

    const headerless = await request(strict).get('/api/health');
    expect(headerless.status).toBe(200);

    const browser = await request(strict).get('/api/health').set('Origin', ALLOWED);
    expect(browser.status).toBe(403);
  });
});

describe('a refused origin says which origin, and says it as 403', () => {
  it('answers 403 POS_ORIGIN_NOT_ALLOWED, not an opaque 500', async () => {
    const res = await request(app).get('/api/health').set('Origin', REFUSED);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('POS_ORIGIN_NOT_ALLOWED');
    // Named explicitly rather than by "not 200", because the old behaviour is
    // the thing this file exists to keep out, and a status range would let it
    // back in.
    expect(res.status).not.toBe(500);
    expect(res.body.error.code).not.toBe('POS_INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/Something went wrong/);
  });

  it('names the rejected origin and the variable that fixes it', async () => {
    const res = await request(app).get('/api/health').set('Origin', REFUSED);
    // The two facts the one person who can fix this needs: which origin was
    // rejected, and what to add it to. Without both, the message is only a
    // better-numbered dead end.
    expect(res.body.error.message).toContain(REFUSED);
    expect(res.body.error.message).toContain('CORS_ORIGIN');
  });

  it('is still a refusal — no allow-origin header comes back', async () => {
    // The failure this guards is the obvious wrong fix: making the message
    // friendly by approving the origin. If this header ever appears, the
    // deployment's browser allow-list has stopped meaning anything.
    const res = await request(app).get('/api/health').set('Origin', REFUSED);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('caps the echoed origin, so a header cannot choose its own reply length', async () => {
    const huge = `https://${'a'.repeat(400)}.example`;
    const res = await request(app).get('/api/health').set('Origin', huge);

    expect(res.status).toBe(403);
    expect(res.body.error.message).not.toContain(huge);
    expect(res.body.error.message.length).toBeLessThan(300);
  });
});
