// Third-party integration framework — shared rules (LANE providers).
// ENTITLEMENT(INTEGRATIONS)
//
// Scope of this file: who may configure an integration, what "connected" is
// allowed to mean, and how a connection's credential is read back for an
// outbound call. The provider-specific knowledge lives in providers.js; the
// wire formats live in adapters/.
//
// One rule runs through all of it. A status on the integrations screen must be
// the result of something that actually happened — a call that returned, a
// webhook that verified, a voucher Tally acknowledged. "The operator filled in
// the form" is CONFIGURED, never CONNECTED, because an operator reading
// "Connected" will stop watching the till.

import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { PROVIDERS, providerDef, isOperable } from './providers.js';
import { openCredential, sealCredential } from './secrets.js';

// --- entitlement -------------------------------------------------------------

// ENTITLEMENT(INTEGRATIONS)
export const MODULE_KEY = 'INTEGRATIONS';

// INTEGRATION(firstlogin): requireModule(key) belongs to that lane; until it
// exists there is no module entitlement to read. Aggregator and accounting
// integrations are inherently a multi-outlet concern, but a single-store client
// with one Zomato listing is a normal case, so this deliberately does NOT gate
// on plan — the gate is the permission map below plus the credential the owner
// has to supply. Replace with requireModule(MODULE_KEY) when it lands.

// --- permissions -------------------------------------------------------------

// The eight `integration.*` actions are registered in lib/permissions.js, under
// `// ==== LANE providers ====`, alongside every other action in the product —
// deliberately NOT in a map of our own. That file says a future lane should add
// its keys in one place "rather than inventing a parallel scheme", and it is
// right: a second registry means a second answer to "what may this person do",
// and the permission screen only reads the first one.
//
// Listed here only so this module's surface is greppable from inside it.
export const INTEGRATION_ACTION_KEYS = Object.freeze([
  'integration.read',
  'integration.configure',
  'integration.credential.write',
  'integration.test',
  'integration.outlet.map',
  'integration.job.retry',
  'integration.discrepancy.resolve',
  'integration.import.run',
]);

// --- status ------------------------------------------------------------------

// The only function permitted to decide what the screen says. Callers pass the
// stored row; they do not get to pass a status.
//
// CONNECTED requires lastSuccessfulSyncAt: a real exchange with the provider
// completed at a known time. Everything short of that is CONFIGURED at best.
export const deriveStatus = (connection) => {
  if (!connection) return 'NOT_CONFIGURED';
  if (!connection.enabled) return 'DISABLED';
  if (!connection.credentialCiphertext) return 'NOT_CONFIGURED';
  // An error that arrived after the last success is the current truth; one that
  // predates it has been superseded by a call that worked.
  if (connection.lastError && (!connection.lastSuccessfulSyncAt ||
      (connection.lastErrorAt && connection.lastErrorAt > connection.lastSuccessfulSyncAt))) {
    return 'ERROR';
  }
  if (connection.lastSuccessfulSyncAt) return 'CONNECTED';
  return 'CONFIGURED';
};

// --- credential handling -----------------------------------------------------

// Validate against the provider's own schema BEFORE sealing, so a malformed
// credential is rejected while the operator is still on the screen rather than
// discovered by a failing job at 8pm on a Friday.
export const prepareCredential = (provider, input) => {
  const def = providerDef(provider);
  if (!def) throw new Error(`unknown provider: ${provider}`);
  return def.credentialSchema.parse(input);
};

export const prepareConfig = (provider, input) => {
  const def = providerDef(provider);
  if (!def) throw new Error(`unknown provider: ${provider}`);
  return def.configSchema.parse(input ?? {});
};

export const sealFor = (connection, secret) =>
  sealCredential({ companyId: connection.companyId, provider: connection.provider }, secret);

export const openFor = (connection) =>
  openCredential(
    { companyId: connection.companyId, provider: connection.provider },
    connection.credentialCiphertext,
  );

// What may cross the API boundary. Constructed by allow-list, not by deleting
// fields from the row: a future column added to IntegrationConnection must not
// be able to leak by default. The ciphertext and the fingerprint both stay
// server-side — the fingerprint is not a credential, but it is an oracle for
// "did the key change", which the caller gets as a date instead.
export const publicConnection = (connection) => {
  if (!connection) return null;
  return {
    id: connection.id,
    provider: connection.provider,
    status: deriveStatus(connection),
    enabled: connection.enabled,
    hasCredential: Boolean(connection.credentialCiphertext),
    credentialUpdatedAt: connection.credentialUpdatedAt,
    config: connection.config ?? {},
    lastCheckedAt: connection.lastCheckedAt,
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
    lastError: connection.lastError,
    lastErrorAt: connection.lastErrorAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
};

// --- error text --------------------------------------------------------------

// Provider errors are written to a column an operator reads, and provider errors
// habitually echo the request back — including the API key. Truncated because a
// 40KB HTML error page from a misconfigured proxy is not an error message.
const SECRET_SHAPED = [
  /\b[A-Za-z0-9_-]{32,}\b/g,        // opaque tokens, keys, bearer values
  /(?<=(key|token|secret|password|auth)["'\s:=]{1,4})\S+/gi,
];

export const sanitizeProviderError = (message) => {
  if (!message) return null;
  let text = String(message).replace(/\s+/g, ' ').trim().slice(0, 500);
  for (const pattern of SECRET_SHAPED) text = text.replace(pattern, '[redacted]');
  return text;
};

// --- dedupe keys -------------------------------------------------------------

// Job identity. Two enqueues describing the same intent must collide on the
// unique index rather than both run — that is how a retry, a double-click and a
// re-delivered webhook all end up sending one status update to Zomato.
export const jobDedupeKey = (kind, ...parts) =>
  [kind, ...parts.map((p) => String(p ?? ''))].join(':').slice(0, 300);

// Payload identity, for proving a posting was not silently altered between
// being queued and being sent. Canonical stringify is not needed here: the
// payload is built by us, in one place, in a stable order.
export const payloadHash = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

// --- guards ------------------------------------------------------------------

// Refuse at the edge of the module, with the provider's own reason, so the
// operator is told "Swiggy publishes no API" instead of watching a job retry
// eight times and die.
// An AppError and not a bare Error, because the whole value of this guard is the
// sentence it carries. A plain Error reaches the operator as "Something went
// wrong handling that request", which is precisely the answer the paragraph above
// exists to avoid — and it would leave them pressing Save on Swiggy forever.
export const assertOperable = (provider) => {
  if (isOperable(provider)) return;
  const def = providerDef(provider);
  throw new AppError(
    409,
    'POS_INTEGRATION_NOT_OPERABLE',
    def?.blockedReason || `${provider} cannot be operated from this product`,
  );
};

export const listProviderKeys = () => Object.keys(PROVIDERS);
