// Phase F — the NODE_ENV=production boot guards.
//
// WHY THIS EXISTS. This staging stack runs NODE_ENV=development, forced by its
// own constraints: loopback only, no TLS, no public hostname. That is an honest
// deviation, but it leaves a hole — the guards in config/env.js that would
// REFUSE a misconfigured production deploy are exactly the ones staging never
// executes. Handing over a production change set without exercising them would
// mean the first time they run is against production.
//
// So they are run here, in isolation, as pure configuration validation. This
// loads config/env.js in a child process with a candidate environment and
// records whether it accepted or refused. It starts no server, opens no socket,
// touches no database and publishes no hostname. It is a unit test of the
// production configuration, run inside the production image.
//
// The test is TWO-SIDED on purpose. "Production config loads" alone would also
// pass if every guard had been deleted, so each refusal is asserted by its own
// message as well.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { check, note, summary } from './lib.mjs';

const run = promisify(execFile);

// A production-shaped baseline: real https origins, a hostname a phone could
// actually resolve, correct secret lengths. Nothing here is a live credential —
// the point is the SHAPE the guards check.
const PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/pos?schema=public',
  POS_JWT_SECRET: 'x'.repeat(48),
  POS_PAYMENT_SECRET_KEY: 'a'.repeat(64),
  APP_URL: 'https://pos.example.com/pos',
  POS_QR_BASE_URL: 'https://pos.example.com/pos',
  CORS_ORIGIN: 'https://pos.example.com',
  COOKIE_SECURE: 'true',
};

// env.js is imported for its side effects (it throws at module scope).
const probe = async (label, overrides) => {
  const env = { ...PROD, ...overrides };
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  try {
    await run(
      'docker',
      [
        'exec',
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        'pos-stgtbl-backend',
        'node',
        '-e',
        "import('./src/config/env.js').then(()=>console.log('LOADED')).catch(e=>{console.error(e.message);process.exit(1)})",
      ],
      { timeout: 30000 },
    );
    return { ok: true, msg: '' };
  } catch (e) {
    return { ok: false, msg: String(e.stderr || e.message).trim() };
  }
};

note('loading config/env.js inside the production image — no server, no socket, no DB');

// --- the accept path -------------------------------------------------------
// If this fails, the production change set is wrong and nothing below matters.
{
  const r = await probe('baseline', {});
  check(
    'production-shaped config LOADS (https app+qr, 48-char jwt, 64-hex payment key)',
    r.ok,
    r.ok ? '' : r.msg,
  );
}

// --- the refusals, each asserted by its own message ------------------------
const refusals = [
  [
    'production refuses an http POS_QR_BASE_URL',
    { POS_QR_BASE_URL: 'http://pos.example.com/pos' },
    /https:\/\/ origin outside test and development/i,
  ],
  [
    'production refuses a loopback POS_QR_BASE_URL (a phone cannot reach it)',
    { POS_QR_BASE_URL: 'https://127.0.0.1:8113/pos' },
    /not reachable from a customer's phone/i,
  ],
  [
    'production refuses a .local POS_QR_BASE_URL',
    { POS_QR_BASE_URL: 'https://till.local/pos' },
    /not reachable from a customer's phone/i,
  ],
  [
    'production refuses a QR base carrying a query string',
    { POS_QR_BASE_URL: 'https://pos.example.com/pos?x=1' },
    /must not carry a query string or fragment/i,
  ],
  [
    'production refuses a simulator terminal connector',
    { POS_TERMINAL_PROVIDER: 'sim-approve' },
    /cannot be used in production/i,
  ],
  [
    'production refuses a test gateway provider',
    { POS_GATEWAY_PROVIDER: 'test-approve', POS_GATEWAY_WEBHOOK_SECRET: 'z'.repeat(32) },
    /cannot be used in production/i,
  ],
  [
    'a short POS_JWT_SECRET is refused at boot',
    { POS_JWT_SECRET: 'tooshort' },
    /at least 32 characters/i,
  ],
  [
    'a truncated POS_PAYMENT_SECRET_KEY is refused at boot',
    { POS_PAYMENT_SECRET_KEY: 'a'.repeat(32) },
    /64 hex characters/i,
  ],
  [
    'a missing DATABASE_URL is refused at boot',
    { DATABASE_URL: null },
    /Missing required environment variable: DATABASE_URL/i,
  ],
  [
    'a gateway provider without its webhook secret is refused',
    { POS_GATEWAY_PROVIDER: 'razorpay' },
    /POS_GATEWAY_WEBHOOK_SECRET is missing/i,
  ],
];

for (const [label, overrides, pattern] of refusals) {
  const r = await probe(label, overrides);
  // Two things, not one: it must refuse, AND refuse for the stated reason. A
  // refusal with the wrong message means a different guard fired and this one
  // may be gone.
  if (check(label, !r.ok, r.ok ? 'LOADED — guard is not armed' : '')) {
    check(`  ...and says why: ${pattern.source.slice(0, 44)}`, pattern.test(r.msg), r.msg.slice(0, 160));
  }
}

// --- the deviation this staging stack actually runs under ------------------
// Proves the claim in .env is true rather than asserted: the same loopback QR
// base that production refuses is accepted under development.
{
  const r = await probe('dev accepts loopback', {
    NODE_ENV: 'development',
    POS_QR_BASE_URL: 'http://127.0.0.1:8113/pos',
    MAIL_ALLOWED_RECIPIENTS: 'nobody@invalid.test',
  });
  check(
    'development DOES accept the loopback QR base (why staging runs as development)',
    r.ok,
    r.ok ? '' : r.msg,
  );
}

process.exit(summary('Phase F — production boot guards') ? 1 : 0);
