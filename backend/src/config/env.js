const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5010),
  // Prod container keeps the all-interfaces default; dev runs set 127.0.0.1
  // so a public-IP host never exposes the dev stack.
  HOST: process.env.HOST || '0.0.0.0',
  APP_NAME: process.env.APP_NAME || 'VEXO Connect',
  APP_URL: process.env.APP_URL || 'http://localhost:5177',
  DATABASE_URL: required('DATABASE_URL'),
  // POS signs with its own secret; an ATC NOC / Megatel / AGR token can never
  // verify here and a POS token can never verify there.
  POS_JWT_SECRET: required('POS_JWT_SECRET'),
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || 'pos_session',
  SESSION_TTL_HOURS: Number(process.env.SESSION_TTL_HOURS || 12),
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5177',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  // Payment gateway (contract §13). Unset is the normal, shipped state: with no
  // provider named, every gateway route refuses. Production runs this way today
  // and will keep doing so until the owner supplies real provider credentials.
  POS_GATEWAY_PROVIDER: process.env.POS_GATEWAY_PROVIDER || null,
  POS_GATEWAY_WEBHOOK_SECRET: process.env.POS_GATEWAY_WEBHOOK_SECRET || null,
  POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS: Number(
    process.env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS || 300,
  ),
  // API credentials the adapter calls the provider with. Named for the role
  // they play, not for Razorpay, because the adapter layer is deliberately
  // provider-independent — swapping providers must not rename the deployment's
  // variables. The test adapter needs neither: it never leaves the process.
  POS_GATEWAY_KEY_ID: process.env.POS_GATEWAY_KEY_ID || null,
  POS_GATEWAY_KEY_SECRET: process.env.POS_GATEWAY_KEY_SECRET || null,
  // Overridable so the adapter's HTTP behaviour — idempotency headers, error
  // classification, timeouts — can be exercised against a local stub with no
  // provider account. Guarded below: outside test and development this may
  // only ever be an https:// origin.
  POS_GATEWAY_API_BASE: process.env.POS_GATEWAY_API_BASE || null,
  // A provider call that never returns must not hold a cashier, or a request
  // handler, forever. Exceeding this is UNKNOWN, never "refused".
  POS_GATEWAY_TIMEOUT_MS: Number(process.env.POS_GATEWAY_TIMEOUT_MS || 20000),
  // Encrypts the per-tenant merchant credentials stored in
  // PaymentProviderAccount. Unset is the normal, shipped state: a deployment
  // with no stored accounts never needs it, and the gateway falls back to the
  // single-account POS_GATEWAY_KEY_* variables above. Validated below only if
  // present — see lib/gateway/secrets.js for why it is read lazily.
  POS_PAYMENT_SECRET_KEY: process.env.POS_PAYMENT_SECRET_KEY || null,
  // Which card-terminal connector the store's terminals speak. Unset
  // everywhere: no terminal vendor's SDK has been supplied, so the terminal
  // routes refuse for the same reason the gateway routes do. See
  // lib/terminal/index.js for the connectors that exist and what each is
  // waiting on.
  POS_TERMINAL_PROVIDER: process.env.POS_TERMINAL_PROVIDER || null,
};

export const gatewayEnabled = Boolean(env.POS_GATEWAY_PROVIDER);

if (env.POS_JWT_SECRET.length < 32) {
  throw new Error('POS_JWT_SECRET must be at least 32 characters');
}

// A half-configured gateway is worse than none: routes would exist and then
// fail on the first webhook, after the customer has already paid. Refuse at
// boot instead, while nobody is mid-transaction.
if (gatewayEnabled && !env.POS_GATEWAY_WEBHOOK_SECRET) {
  throw new Error('POS_GATEWAY_PROVIDER is set but POS_GATEWAY_WEBHOOK_SECRET is missing');
}
if (env.POS_GATEWAY_WEBHOOK_SECRET && env.POS_GATEWAY_WEBHOOK_SECRET.length < 16) {
  throw new Error('POS_GATEWAY_WEBHOOK_SECRET must be at least 16 characters');
}
// The test adapter exists so the signature, idempotency and reconciliation
// paths can be exercised without a provider account. It settles payments on
// command, so production must never be able to name it — that is the whole
// distance between "verified by the gateway" and "fake success".
if (env.NODE_ENV === 'production' && env.POS_GATEWAY_PROVIDER?.startsWith('test')) {
  throw new Error(`Gateway provider "${env.POS_GATEWAY_PROVIDER}" cannot be used in production`);
}
// A real provider is reached over the network with an API credential; the test
// adapter never leaves the process. Missing keys would otherwise surface as a
// failed charge with the customer already at the counter, so this refuses at
// boot for the same reason the webhook secret does.
const realProvider = gatewayEnabled && !env.POS_GATEWAY_PROVIDER.startsWith('test');
if (realProvider && !(env.POS_GATEWAY_KEY_ID && env.POS_GATEWAY_KEY_SECRET)) {
  throw new Error(
    `Gateway provider "${env.POS_GATEWAY_PROVIDER}" needs POS_GATEWAY_KEY_ID and POS_GATEWAY_KEY_SECRET`,
  );
}
// Live keys move real customer money. Outside production a live key is always
// a paste error, and the cost of noticing late is a genuine charge on somebody's
// card during a dev run.
if (env.NODE_ENV !== 'production' && env.POS_GATEWAY_KEY_ID?.includes('_live_')) {
  throw new Error('POS_GATEWAY_KEY_ID is a live key; dev and test runs must use sandbox keys');
}
if (!Number.isFinite(env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS) ||
    env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS <= 0) {
  throw new Error('POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS must be a positive number of seconds');
}
// A redirected API base is how a test points the adapter at a stub. Outside
// test and development it is how an attacker who can set one variable would
// send every API key and every charge to a host of their choosing, so plain
// http and non-URLs are refused there — and the whitelist is on the safe
// environments, so an unset NODE_ENV refuses rather than allows.
if (env.POS_GATEWAY_API_BASE) {
  const overridable = env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
  let parsed;
  try {
    parsed = new URL(env.POS_GATEWAY_API_BASE);
  } catch {
    throw new Error('POS_GATEWAY_API_BASE must be an absolute URL');
  }
  if (!overridable && parsed.protocol !== 'https:') {
    throw new Error('POS_GATEWAY_API_BASE must be an https:// origin outside test and development');
  }
}
if (!Number.isFinite(env.POS_GATEWAY_TIMEOUT_MS) || env.POS_GATEWAY_TIMEOUT_MS <= 0) {
  throw new Error('POS_GATEWAY_TIMEOUT_MS must be a positive number of milliseconds');
}
// A key of the wrong length fails at the first decrypt, which is the moment a
// customer is standing at the counter. Refuse at boot instead, while nobody is
// mid-transaction — the same rule the webhook secret follows. A short or
// non-hex key is also the shape a truncated copy-paste takes, and half a key
// is not a weaker key: it is an unreadable column of ciphertext.
if (env.POS_PAYMENT_SECRET_KEY !== null && !/^[0-9a-fA-F]{64}$/.test(env.POS_PAYMENT_SECRET_KEY)) {
  throw new Error('POS_PAYMENT_SECRET_KEY must be 64 hex characters (32 bytes)');
}
// The test terminal connector reports approvals on command, so production must
// never be able to name it — the same distance the gateway keeps between
// "verified by the provider" and "fake success".
if (env.NODE_ENV === 'production' && env.POS_TERMINAL_PROVIDER?.startsWith('sim')) {
  throw new Error(`Terminal connector "${env.POS_TERMINAL_PROVIDER}" cannot be used in production`);
}
