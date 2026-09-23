// Every successful login used to write a usable session JWT into the log:
// pino-http's default serializer emits `res.headers`, and the logger carried no
// redaction at all. Two independent layers now stop it, and both are pinned
// here because either one alone would be one refactor away from silently
// disappearing.
import { describe, it, expect } from 'vitest';
import pino from 'pino';

// logger.js pulls in config/env.js, which hard-requires these. Nothing below
// touches a database or mints a real token; the values only have to exist.
process.env.DATABASE_URL ||= 'postgresql://unused@127.0.0.1:1/unused_test';
process.env.POS_JWT_SECRET ||= 'x'.repeat(32);

const { REDACT, resSerializer } = await import('../src/lib/logger.js');

describe('request-log credential redaction', () => {
  // Layer 1: app.js installs this, so response headers never reach the logger.
  describe('response serializer', () => {
    // pino-http hands the custom serializer the already-serialised res.
    const serialise = (headers) => resSerializer({ statusCode: 200, headers });

    it('drops Set-Cookie', () => {
      const out = serialise({ 'set-cookie': 'pos_session=JWT; HttpOnly' });
      expect(JSON.stringify(out)).not.toContain('pos_session');
    });

    // The point of a whitelist is that it holds for headers nobody predicted,
    // so this asserts the shape rather than the absence of one known key.
    it('emits nothing but status and length', () => {
      const out = serialise({
        'set-cookie': 'pos_session=JWT',
        authorization: 'Bearer SECRET',
        'x-some-future-credential': 'SECRET',
        'content-length': '1612',
      });
      expect(Object.keys(out).sort()).toEqual(['contentLength', 'statusCode']);
      expect(JSON.stringify(out)).not.toContain('SECRET');
    });

    it('keeps the fields that make a request line useful', () => {
      expect(serialise({ 'content-length': '1612' })).toEqual({
        statusCode: 200,
        contentLength: '1612',
      });
    });
  });

  // Layer 2: any other call site that logs a raw res object. Asserted through
  // a real pino instance rather than by reading the array, because the failure
  // mode is pino path syntax (bracket notation, casing) matching nothing.
  describe('redact paths', () => {
    const emit = (obj) => {
      const lines = [];
      const logger = pino(
        { level: 'debug', redact: { paths: REDACT, censor: '[REDACTED]' } },
        { write: (line) => lines.push(JSON.parse(line)) },
      );
      logger.info(obj, 'request completed');
      return lines[0];
    };

    const requestLog = (setCookie) =>
      emit({
        req: { headers: { cookie: 'pos_session=INBOUND', authorization: 'Bearer INBOUND' } },
        res: {
          statusCode: 200,
          headers: {
            'set-cookie': setCookie,
            'x-content-type-options': 'nosniff',
            'content-length': '1612',
          },
        },
      });

    it('censors the Set-Cookie that mints a session', () => {
      const line = requestLog('pos_session=eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG; HttpOnly');
      expect(line.res.headers['set-cookie']).toBe('[REDACTED]');
    });

    it('censors Set-Cookie when a response sets more than one', () => {
      const line = requestLog(['pos_session=JWT; HttpOnly', 'pos_csrf=TOKEN']);
      expect(line.res.headers['set-cookie']).toBe('[REDACTED]');
    });

    it('still censors inbound credentials', () => {
      const line = requestLog('pos_session=JWT');
      expect(line.req.headers.cookie).toBe('[REDACTED]');
      expect(line.req.headers.authorization).toBe('[REDACTED]');
    });

    // A censor broad enough to swallow the surrounding line would pass every
    // assertion above while making the log useless.
    it('leaves the rest of the request line intact', () => {
      const line = requestLog('pos_session=JWT');
      expect(line.res.statusCode).toBe(200);
      expect(line.res.headers['x-content-type-options']).toBe('nosniff');
      expect(line.res.headers['content-length']).toBe('1612');
      expect(line.msg).toBe('request completed');
    });

    // A discount approval puts a manager's password inside a nested object, so
    // it sits deeper than the `*.password` above can see — `*` is one level,
    // not any number of them. Measured, not assumed: logging a request body
    // with this list already in force wrote the password out in full.
    //
    // Each case below is the shape of a log line somebody would plausibly
    // write. They are pinned separately because they are separate paths in
    // REDACT, and a ladder is exactly the kind of thing that gets tidied down
    // to one rung by someone who reads `*` as a glob.
    describe('an approval password, however deep it is nested', () => {
      const CANARY = 'manager-password-canary';

      it('is censored at approval.password', () => {
        const line = emit({ approval: { password: CANARY } });
        expect(line.approval.password).toBe('[REDACTED]');
      });

      it('is censored at body.approval.password', () => {
        const line = emit({ body: { approval: { password: CANARY } } });
        expect(line.body.approval.password).toBe('[REDACTED]');
      });

      it('is censored at req.body.approval.password', () => {
        const line = emit({ req: { body: { approval: { password: CANARY } } } });
        expect(line.req.body.approval.password).toBe('[REDACTED]');
      });

      // The assertions above each name the path they check, so a censor that
      // blanked the whole object would satisfy them. This one reads the
      // serialised line, which is what actually reaches the disk.
      it('leaves no copy anywhere in the serialised line', () => {
        const line = emit({
          req: { body: { approval: { approverEmail: 'mgr@test.local', password: CANARY } } },
        });
        expect(JSON.stringify(line)).not.toContain(CANARY);
        // ...while keeping the part that makes the line worth having.
        expect(line.req.body.approval.approverEmail).toBe('mgr@test.local');
      });
    });
  });
});
