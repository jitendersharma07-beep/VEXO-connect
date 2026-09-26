// The bytes of the conversation, not the decisions behind them.
//
// Everything here is about the JSON that actually leaves the till and the header
// it leaves under. The runner's judgements are tested in semantics.test.js with a
// recorder; these tests put the real PrintAgentClient over a fake fetch, because
// a field that the runner correctly left undefined and the client then serialised
// as `false` would be a fabricated observation of an open cash drawer, and no
// amount of correct decision-making upstream would save it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_VERSION, PROTOCOL_VERSION } from '../src/config.js';
import { PrintAgentClient, ServerError, newClaimToken } from '../src/client.js';

// Records what was asked for and answers with whatever the test supplies.
const fakeFetch = (reply = { status: 200, body: {} }) => {
  const seen = [];
  const impl = async (url, init) => {
    const entry = {
      url, method: init.method, headers: init.headers,
      raw: init.body ?? null,
      body: init.body ? JSON.parse(init.body) : null,
    };
    seen.push(entry);
    const r = typeof reply === 'function' ? reply(entry) : reply;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.status === 204 ? '' : JSON.stringify(r.body ?? null)),
    };
  };
  impl.seen = seen;
  return impl;
};

const client = (impl, over = {}) => new PrintAgentClient({
  serverUrl: 'http://127.0.0.1:5010',
  agentId: 'pa_test', secret: 'pas_deadbeefdeadbeefdeadbeef',
  fetchImpl: impl, ...over,
});

test('an omitted drawer observation is omitted on the wire too', async () => {
  const f = fakeFetch({ status: 200, body: { status: 'CONFIRMED', claim: 'ACKNOWLEDGED' } });

  await client(f).reportCommand('cmd_1', { ok: true, detail: 'pulse pin 2' });

  const sent = f.seen[0].body;
  assert.equal('drawerOpen' in sent, false);
  // `"drawerOpen": null` would be just as wrong as false: the server's zod schema
  // takes an optional boolean, and a null is a value where the truth is that no
  // measurement exists.
  assert.ok(!f.seen[0].raw.includes('drawerOpen'));
});

test('a drawer observation of false IS sent — it is a measurement', async () => {
  const f = fakeFetch({ status: 200, body: { status: 'CONFIRMED', claim: 'ACKNOWLEDGED_NOT_OPENED' } });

  await client(f).reportCommand('cmd_1', { ok: true, drawerOpen: false });

  // The difference between this test and the one above is the difference between
  // "the sensor says the drawer did not move" and "nothing looked". Collapsing
  // them would hide a jammed till.
  assert.equal(f.seen[0].body.drawerOpen, false);
});

test('the credential travels as one bearer token and is not in the body', async () => {
  const f = fakeFetch({ status: 204 });

  const out = await client(f).heartbeat({ uptimeSec: 12 });

  assert.equal(out, null, '204 is an answer, not an empty parse');
  assert.equal(f.seen[0].headers.authorization, 'Bearer pa_test.pas_deadbeefdeadbeefdeadbeef');
  assert.ok(!f.seen[0].raw.includes('pas_'));
  assert.equal(f.seen[0].headers['user-agent'], `vexo-print-agent/${AGENT_VERSION} (${PROTOCOL_VERSION})`);
});

test('an unenrolled agent refuses to call an authenticated route at all', async () => {
  const f = fakeFetch({ status: 200, body: {} });
  const c = client(f, { agentId: null, secret: null });

  await assert.rejects(() => c.heartbeat({}), /not enrolled/);
  // No request was made, so an unenrolled till cannot be mistaken for an
  // unauthorised one in the server's logs.
  assert.equal(f.seen.length, 0);
});

test('enrolment posts the code unauthenticated and keeps what comes back', async () => {
  const f = fakeFetch({ status: 200, body: { agentId: 'pa_new', secret: 'pas_1234abcd1234abcd' } });
  const c = client(f, { agentId: null, secret: null });

  const out = await c.enrol('PAE-TEST-CODE', { platform: 'linux-x64', hostname: 'till-1' });

  assert.equal(f.seen[0].headers.authorization, undefined);
  assert.equal(f.seen[0].body.code, 'PAE-TEST-CODE');
  assert.equal(f.seen[0].body.agentVersion, AGENT_VERSION);
  assert.equal(out.agentId, 'pa_new');
  assert.equal(c.authorized, true);
});

test('a server error says whether repeating the call could ever help', async () => {
  const bad = fakeFetch({ status: 401, body: { error: 'Invalid agent credential' } });
  const busy = fakeFetch({ status: 503, body: { error: 'upstream' } });

  await assert.rejects(() => client(bad).heartbeat({}), (e) => {
    assert.ok(e instanceof ServerError);
    // A 401 will not improve by being retried — it means the credential is wrong
    // or revoked, and a till that hammers a revoked credential is a till whose
    // logs hide the real problem.
    assert.equal(e.retryable, false);
    return true;
  });
  await assert.rejects(() => client(busy).heartbeat({}), (e) => e.retryable === true);
});

test('a transport failure is retryable and does not pretend to be a status', async () => {
  const impl = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };

  await assert.rejects(() => client(impl).heartbeat({}), (e) => {
    assert.equal(e.transport, true);
    assert.equal(e.retryable, true);
    assert.ok(!(e instanceof ServerError));
    return true;
  });
});

test('a job id is escaped into the path', async () => {
  const f = fakeFetch({ status: 200, body: { status: 'CONFIRMED' } });

  await client(f).reportJob('job/../../admin', { ok: true });

  assert.equal(
    f.seen[0].url,
    'http://127.0.0.1:5010/api/print-agents/jobs/job%2F..%2F..%2Fadmin/report',
  );
});

test('a claim token is long enough for the server to accept and unique per call', () => {
  const a = newClaimToken();
  const b = newClaimToken();

  assert.notEqual(a, b);
  // The server's schema is min 8, max 100 characters. A token below it would fail
  // validation as a 400 and look like a protocol change.
  assert.ok(a.length >= 8 && a.length <= 100);
});

test('a trailing slash on the server URL does not double up in the path', async () => {
  const f = fakeFetch({ status: 204 });

  await new PrintAgentClient({
    serverUrl: 'http://127.0.0.1:5010///', agentId: 'a', secret: 's', fetchImpl: f,
  }).heartbeat({});

  assert.equal(f.seen[0].url, 'http://127.0.0.1:5010/api/print-agents/heartbeat');
});
