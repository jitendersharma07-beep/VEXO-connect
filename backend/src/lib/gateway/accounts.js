// Which merchant account a payment settles into.
//
// THE PROBLEM THIS SOLVES. Credentials used to live in POS_GATEWAY_KEY_ID /
// POS_GATEWAY_KEY_SECRET — process environment variables, one set per running
// server. On a single-tenant box that is fine. On this product, which is
// multi-tenant by construction, it means every company sharing a deployment
// shares one merchant account, and every customer's card payment settles into
// whoever's bank account the box was configured with. That is not a mistake
// waiting to be made; it is the only behaviour a global variable can have.
//
// So the account is resolved from the ORDER being paid — its company, and its
// store — and never from the process.
//
// RESOLUTION ORDER. Store row, then company row. A franchise that settles per
// outlet configures a row per branch; a single-account tenant configures one
// company row and every store uses it. An inactive row is not a fallback: if
// the store's account is switched off, resolution does NOT quietly climb to the
// company account and bill through that instead, because "this outlet stopped
// taking online payments" and "this outlet's money now goes to head office"
// are different instructions and only one of them was given.
//
// THE ENV FALLBACK. A deployment with no account rows at all falls back to the
// environment variables, which is exactly what every existing deployment and
// every existing test does. The fallback is only reachable when the company has
// NO row for that provider — so configuring one account never leaves a second
// path open, and a tenant that has configured its own account can never be
// billed through the shared one.

import { prisma } from '../prisma.js';
import { env } from '../../config/env.js';
import { decryptSecret } from './secrets.js';

// Shape returned to adapters. `source` is carried so callers can audit which
// path answered without having to infer it, and so a report can show an
// operator that a tenant is still on the shared environment credentials.
const fromAccount = (account) => ({
  source: 'ACCOUNT',
  accountId: account.id,
  provider: account.provider,
  mode: account.mode,
  keyId: account.keyId,
  keySecret: account.keySecretEnc === null ? null : decryptSecret(account.keySecretEnc),
  webhookSecret: account.webhookSecretEnc === null ? null : decryptSecret(account.webhookSecretEnc),
});

const fromEnv = (provider) => ({
  source: 'ENV',
  accountId: null,
  provider,
  mode: env.POS_GATEWAY_KEY_ID?.includes('_live_') ? 'LIVE' : 'TEST',
  keyId: env.POS_GATEWAY_KEY_ID,
  keySecret: env.POS_GATEWAY_KEY_SECRET,
  webhookSecret: env.POS_GATEWAY_WEBHOOK_SECRET,
});

export class PaymentAccountError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'PaymentAccountError';
    this.reason = reason;
  }
}

// The accounts a company has for one provider, most specific first. Exported
// because the webhook route needs the SET (it does not know the order yet, so
// it cannot pick one) while everything else needs exactly one.
export const accountsFor = async (companyId, provider, client = prisma) =>
  client.paymentProviderAccount.findMany({
    where: { companyId, provider },
    orderBy: [{ branchId: 'desc' }, { createdAt: 'asc' }],
  });

// The account this order's payment must settle into.
//
// Returns credentials, never the row: nothing above this layer should be
// holding a ciphertext column, and nothing should be tempted to log one.
export const resolveAccount = async ({ companyId, branchId, provider }, client = prisma) => {
  const rows = await accountsFor(companyId, provider, client);
  if (rows.length === 0) {
    // No account configured for this tenant. The environment credentials are
    // the single-account deployment's answer, and they are only reachable
    // here — once a tenant configures a row, this branch is unreachable for it.
    //
    // Deliberately NOT re-checking that those credentials exist. config/env.js
    // already refuses at boot to run a real provider without them, which is the
    // right place: it happens once, while nobody is mid-transaction, rather
    // than in front of a customer. A second copy of that rule here would be one
    // that can disagree with the first — and it did, by refusing the test
    // adapter, which authenticates against nothing and needs no key at all.
    return fromEnv(provider);
  }

  const forStore = rows.find((r) => r.branchId === branchId);
  const forCompany = rows.find((r) => r.branchId === null);
  // Store first, and a store row that exists ENDS the search whether or not it
  // is active — see the header. Climbing past a switched-off store account
  // would route that outlet's takings somewhere nobody asked for.
  const chosen = forStore ?? forCompany;
  if (!chosen) {
    throw new PaymentAccountError(
      'No merchant account is configured for this store',
      'NO_ACCOUNT_FOR_STORE',
    );
  }
  if (!chosen.active) {
    throw new PaymentAccountError(
      'The merchant account for this store is not active',
      'ACCOUNT_INACTIVE',
    );
  }
  return resolveAccountRow(chosen);
};

// Credentials from a row that has ALREADY been chosen — by resolution above, or
// by an existing attempt naming the account it was opened on.
//
// Deliberately does NOT check `active`. Switching an account off means "stop
// taking new payments here", and it is the resolver above, on the new-payment
// path, that enforces it. Applying it to a charge already taken would trap a
// customer's refund inside a disabled account, which turns an operator tidying
// up their configuration into a customer who cannot get their money back.
//
// The two checks that DO belong to every use of a row are here: credentials
// that cannot authenticate, and live credentials on a server that is not
// production.
export const resolveAccountRow = (row) => {
  if (!row.keySecretEnc) {
    throw new PaymentAccountError(
      'The merchant account for this store has no API credential',
      'ACCOUNT_INCOMPLETE',
    );
  }
  // A live key on a non-production server is a paste error, and the cost of
  // noticing late is a genuine charge on somebody's card during a dev run —
  // the same rule env.js applies to POS_GATEWAY_KEY_ID, applied to the rows
  // that replaced it.
  if (row.mode === 'LIVE' && env.NODE_ENV !== 'production') {
    throw new PaymentAccountError(
      'This merchant account holds live credentials and this is not a production server',
      'LIVE_ACCOUNT_OFF_PRODUCTION',
    );
  }
  return fromAccount(row);
};

// The webhook's problem is the reverse one: a delivery arrives naming an
// attempt, and the secret that verifies it depends on which account opened
// that attempt — which is knowable only after the signature has been checked,
// which needs the secret. The way out is to check against every candidate the
// provider could have signed with, then confirm the winner matches the intent.
//
// Returns candidate secrets, most specific first, with the env secret last
// where one exists. Tries are bounded by the number of accounts a company has
// per provider, which the unique indexes cap at one per store plus one.
export const webhookSecretCandidates = async (provider, client = prisma) => {
  const rows = await client.paymentProviderAccount.findMany({
    where: { provider, active: true, webhookSecretEnc: { not: null } },
    orderBy: [{ branchId: 'desc' }, { createdAt: 'asc' }],
  });
  const candidates = rows.map((r) => ({
    accountId: r.id,
    companyId: r.companyId,
    branchId: r.branchId,
    secret: decryptSecret(r.webhookSecretEnc),
  }));
  if (env.POS_GATEWAY_WEBHOOK_SECRET) {
    candidates.push({
      accountId: null,
      companyId: null,
      branchId: null,
      secret: env.POS_GATEWAY_WEBHOOK_SECRET,
    });
  }
  return candidates;
};

// Never returns a secret. `secretSet` is the whole of what an operator screen
// needs: whether there is one, not what it is.
export const publicAccount = (a) => ({
  id: a.id,
  provider: a.provider,
  label: a.label,
  mode: a.mode,
  branchId: a.branchId,
  keyId: a.keyId,
  keySecretSet: a.keySecretEnc !== null,
  webhookSecretSet: a.webhookSecretEnc !== null,
  active: a.active,
  lastVerifiedAt: a.lastVerifiedAt,
  lastVerifyNote: a.lastVerifyNote ?? null,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});
