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
  // How an inventory reminder reaches a person. "inapp" is the shipped state
  // and the only one that delivers anything: no email or WhatsApp adapter is
  // written. Naming a transport with no adapter behind it does not throw — the
  // notification is recorded FAILED with the reason, because a message that
  // did not arrive has to leave a record saying so. See
  // src/lib/inventory/notifyTransport.js.
  //
  // The accounts lane's SMTP settings below are now the obvious thing to build
  // an "email" transport on, but wiring them together is a decision about who
  // may be mailed and how often, not a refactor, so it is deliberately not
  // done here.
  INVENTORY_NOTIFY_TRANSPORT: process.env.INVENTORY_NOTIFY_TRANSPORT || 'inapp',

  // LANE reporting — scheduled report delivery.
  //
  // Where a produced report is written. Report delivery has no transport of its
  // own: a delivery lands in a spool directory and the row, the screen and the
  // export all say FILE. The SMTP settings below arrived with the accounts lane
  // and are not wired to this — reports are not mail until somebody connects the
  // two deliberately, and until then the honest label is the one that says where
  // the file went. A transport that silently wrote to disk while the screen said
  // "sent by email" would be worse than either.
  REPORTING_SPOOL_DIR: process.env.REPORTING_SPOOL_DIR || null,
  // The timer that fires due schedules. Off unless explicitly switched on, so
  // deploying this lane cannot start sending anything on its own — a schedule
  // still has to be activated by a person, and the process still has to be told
  // to tick.
  REPORTING_SCHEDULER: process.env.REPORTING_SCHEDULER === 'true',

  // --- Transactional email (contract: accounts lane) ------------------------
  // Unset is the shipped state, exactly like the gateway: with no SMTP host
  // named, mail is disabled and every flow that would send one refuses loudly
  // instead of pretending. Bootstrapping the platform administrator is the
  // first thing that needs it, so an unconfigured deployment cannot silently
  // create an administrator nobody can reach.
  SMTP_HOST: process.env.SMTP_HOST || null,
  SMTP_PORT: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null,
  // 'starttls' (587), 'tls' (465), or 'none' — plaintext, refused outside dev
  // and test because it would put the mailbox password on the wire.
  SMTP_SECURITY: process.env.SMTP_SECURITY || 'starttls',
  SMTP_USERNAME: process.env.SMTP_USERNAME || null,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD || null,
  // Envelope + header sender. The provider should be authorised to send as this
  // domain (SPF/DKIM). If it is not, the relay still accepts the message and what
  // happens next is the receiver's local policy — reject, quarantine, Junk, or
  // deliver regardless. So acceptance here says nothing about receipt there; it
  // is not, however, the guaranteed loss an earlier version of this comment
  // claimed. See docs/ACCOUNTS-GO-LIVE.md §1 for the measured DNS facts.
  MAIL_FROM: process.env.MAIL_FROM || null,
  MAIL_REPLY_TO: process.env.MAIL_REPLY_TO || null,
  // Outside production, a comma-separated allowlist of recipient patterns
  // ("*@example.com", "someone@vexoconnect.com"). A dev run that tries to mail
  // anyone else is refused before the socket opens, so a copied-in production
  // database cannot turn a test into a message to a real customer.
  MAIL_ALLOWED_RECIPIENTS: process.env.MAIL_ALLOWED_RECIPIENTS || null,
  SMTP_TIMEOUT_MS: Number(process.env.SMTP_TIMEOUT_MS || 20000),
};

export const gatewayEnabled = Boolean(env.POS_GATEWAY_PROVIDER);
export const mailEnabled = Boolean(env.SMTP_HOST);

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
// The test notification transport reports delivery on command without sending
// anything. In production that would mean an expiring-batch warning marked
// DELIVERED that nobody ever received — and unlike a failed payment, nobody is
// standing at a counter to notice. Refused here at boot and again on every
// lookup in notifyTransport.js, because one gate that can be edited out is not
// a gate.
if (env.NODE_ENV === 'production' && env.INVENTORY_NOTIFY_TRANSPORT.startsWith('test')) {
  throw new Error(
    `Notification transport "${env.INVENTORY_NOTIFY_TRANSPORT}" cannot be used in production`,
  );
}

// --- mail configuration, refused at boot rather than at the first send ------
// The failure mode this guards against is specific: a half-configured mailer
// accepts the invitation request, records it, and then cannot deliver it. The
// administrator is created, the customer is told to check their inbox, and
// nothing arrives. Refusing here means that state cannot be reached.
const MAIL_SECURITIES = new Set(['starttls', 'tls', 'none']);
if (mailEnabled) {
  if (!MAIL_SECURITIES.has(env.SMTP_SECURITY)) {
    throw new Error(`SMTP_SECURITY must be one of: ${[...MAIL_SECURITIES].join(', ')}`);
  }
  if (!Number.isFinite(env.SMTP_PORT) || env.SMTP_PORT <= 0) {
    throw new Error('SMTP_HOST is set but SMTP_PORT is missing or not a port number');
  }
  if (!env.MAIL_FROM) {
    throw new Error('SMTP_HOST is set but MAIL_FROM is missing');
  }
  // Credentials are a pair. One without the other is a paste that lost a line,
  // and the server would answer with a 535 at the worst possible moment.
  if (Boolean(env.SMTP_USERNAME) !== Boolean(env.SMTP_PASSWORD)) {
    throw new Error('SMTP_USERNAME and SMTP_PASSWORD must be set together');
  }
  // Plaintext submission sends the mailbox password in the clear. A local
  // capture sink on loopback is the only legitimate use, and that only happens
  // on a developer's machine.
  if (env.SMTP_SECURITY === 'none' && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error("SMTP_SECURITY 'none' is only allowed in development and test");
  }
  // Production sends to real customers, so the allowlist is a development-only
  // safety rail — but outside production its ABSENCE is the danger, because
  // that is when a restored customer database is sitting in front of a mailer
  // that would happily reach every address in it.
  if (env.NODE_ENV !== 'production' && !env.MAIL_ALLOWED_RECIPIENTS) {
    throw new Error(
      'MAIL_ALLOWED_RECIPIENTS is required outside production: name the addresses this ' +
        'deployment may mail, so a test cannot reach a real customer',
    );
  }
}
// A recovery link built from anything but trusted configuration is a way to
// send a customer's reset token to a host the attacker picked — which is why
// nothing in this codebase reads the request Host header. Its correctness
// therefore matters enough to check.
if (mailEnabled) {
  let appUrl;
  try {
    appUrl = new URL(env.APP_URL);
  } catch {
    throw new Error('APP_URL must be an absolute URL — email links are built from it');
  }
  if (env.NODE_ENV === 'production' && appUrl.protocol !== 'https:') {
    throw new Error('APP_URL must be https:// in production — email links are built from it');
  }
}
