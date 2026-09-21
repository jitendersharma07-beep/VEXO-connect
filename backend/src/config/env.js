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
  APP_NAME: process.env.APP_NAME || 'ATC POS',
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
if (!Number.isFinite(env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS) ||
    env.POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS <= 0) {
  throw new Error('POS_GATEWAY_WEBHOOK_TOLERANCE_SECONDS must be a positive number of seconds');
}
