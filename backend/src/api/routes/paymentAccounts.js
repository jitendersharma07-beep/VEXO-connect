// Merchant accounts — whose bank account a company's online payments land in.
//
// WHY THIS EXISTS. Provider credentials used to be process environment
// variables, one set per running server. On a multi-tenant product that means
// every company sharing a deployment shares one merchant account, and every
// customer's card payment settles into whoever's bank account the box was
// configured with. This router is where a company's own credentials are
// entered, and lib/gateway/accounts.js is where they are resolved from the
// order being paid — never from the process.
//
// WHAT IT NEVER RETURNS. Secrets. A key secret and a webhook secret go in and
// are never legible again through this API: the list and detail responses carry
// `keySecretSet: true` and nothing more, because an operator screen needs to
// know whether one is configured, not what it is. The key ID is different — it
// is the publishable half, it ships to the browser to open Checkout, and it is
// returned in full so the operator can confirm which account they configured.
//
// WHAT IT CANNOT DO. Delete. A merchant account is named by every intent opened
// on it and every payment taken through it, and a refund months from now has to
// be posted back to the account that took the money. Switching an account off
// stops NEW payments through it and leaves refunds of old ones working, which
// is the behaviour an operator tidying up their configuration actually wants.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { requirePosAuth, resolveCompanyScope } from '../../middleware/auth.js';
import { requireUsableLicense } from '../../middleware/rbac.js';
import {
  loadPermissionContext,
  requireAction,
  auditPlatformWrite,
  resolveStoreInScope,
  scopedBranchIdWhere,
} from '../../middleware/permissions.js';
import { encryptSecret, paymentSecretKeyAvailable, secretFingerprint } from '../../lib/gateway/secrets.js';
import { publicAccount, resolveAccountRow, PaymentAccountError } from '../../lib/gateway/accounts.js';
import { getAdapter, gatewayAvailable } from '../../lib/gateway/index.js';

const router = Router();

router.use(requirePosAuth, resolveCompanyScope, loadPermissionContext);

// A store-scoped operator sees their own stores' accounts AND the company-wide
// one, because the company-wide one is what their store actually settles into
// when it has no row of its own. Hiding it would show a manager an empty list
// for a store that takes online payments perfectly well.
//
// The empty branch below is not a shortcut. `scopedBranchIdWhere` returns `{}`
// for a company-wide scope, which is match-all ONLY at the top level of a
// `where`. Inside an `OR` array Prisma renders it as a term that matches
// nothing, so `OR: [{branchId: null}, {}]` collapses to "company-wide rows
// only" — measured, an owner asking for a store's account got a 404 for a row
// that was plainly theirs.
const scopeWhere = (req) => {
  const mine = scopedBranchIdWhere(req);
  if (!Object.keys(mine).length) return {};
  return { OR: [{ branchId: null }, mine] };
};

const include = { branch: { select: { id: true, name: true, code: true } } };

const withBranch = (row) => ({
  ...publicAccount(row),
  branchName: row.branch?.name ?? null,
  // The scope in words, because "branchId: null" on a screen is not an answer
  // to "where does this apply".
  appliesTo: row.branchId ? `${row.branch?.name ?? 'one store'} only` : 'the whole company',
});

router.get(
  '/',
  requireAction('payment.account.read'),
  asyncHandler(async (req, res) => {
    const accounts = await prisma.paymentProviderAccount.findMany({
      where: { companyId: req.companyScope.id, ...scopeWhere(req) },
      include,
      orderBy: [{ provider: 'asc' }, { branchId: 'asc' }],
    });
    res.json({
      accounts: accounts.map(withBranch),
      // Two facts an operator needs before they can read the list correctly.
      // A deployment with no provider configured has no working accounts
      // whatever this list says, and one with no encryption key cannot accept
      // a secret at all — both are better said here than discovered on a 409.
      provider: gatewayAvailable() ? getAdapter().name : null,
      capabilities: gatewayAvailable() ? (getAdapter().capabilities ?? null) : null,
      secretStorageReady: paymentSecretKeyAvailable(),
    });
  }),
);

// Secrets are write-only and, once written, may be replaced but not blanked.
// An account with no key secret cannot authenticate, so "clear it" and "switch
// it off" are the same intent and only the second has an honest name — which
// is `active`, below.
const secret = z.string().trim().min(8).max(512);

const createSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  // Omitted means company-wide. A franchise settling per outlet names a store;
  // a single-account tenant configures one row and every store uses it.
  branchId: z.string().trim().min(1).optional(),
  mode: z.enum(['TEST', 'LIVE']),
  keyId: z.string().trim().min(1).max(200),
  keySecret: secret,
  // Optional because not every provider issues one separately, and because a
  // deployment may wire the webhook after the API credentials.
  webhookSecret: secret.optional(),
});

// Encrypting requires the deployment key. Refusing here, with the variable
// named, beats storing a plaintext credential or failing at the first charge.
const requireSecretStorage = () => {
  if (!paymentSecretKeyAvailable()) {
    throw conflict(
      'This deployment cannot store merchant credentials yet: POS_PAYMENT_SECRET_KEY is not configured',
    );
  }
};

// The provider must be one this build actually has an adapter for. Storing
// credentials for a name nothing can use is a silent dead end: the operator
// sees a configured account and every payment still refuses.
const requireKnownProvider = (provider) => {
  if (!gatewayAvailable()) {
    throw conflict('No payment provider is configured on this deployment');
  }
  const configured = getAdapter().name;
  if (provider !== configured) {
    throw badRequest(
      `This deployment is configured for "${configured}", so an account for "${provider}" would never be used`,
      'provider',
    );
  }
};

router.post(
  '/',
  requireAction('payment.account.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    requireKnownProvider(data.provider);
    requireSecretStorage();

    // companyId comes from the resolved store, never from the body — the same
    // rule every other store-bound write in this codebase follows.
    const branch = data.branchId ? await resolveStoreInScope(req, data.branchId) : null;

    const existing = await prisma.paymentProviderAccount.findFirst({
      where: {
        companyId: req.companyScope.id,
        provider: data.provider,
        branchId: branch?.id ?? null,
      },
      select: { id: true },
    });
    if (existing) {
      throw conflict(
        branch
          ? `${branch.name} already has a ${data.provider} account. Update it rather than adding a second.`
          : `This company already has a company-wide ${data.provider} account. Update it rather than adding a second.`,
      );
    }

    const account = await prisma.paymentProviderAccount.create({
      data: {
        companyId: req.companyScope.id,
        branchId: branch?.id ?? null,
        provider: data.provider,
        label: data.label,
        mode: data.mode,
        keyId: data.keyId,
        keySecretEnc: encryptSecret(data.keySecret),
        webhookSecretEnc: data.webhookSecret ? encryptSecret(data.webhookSecret) : null,
      },
      include,
    });

    await audit(req, {
      action: 'PAYMENT_ACCOUNT_CREATE',
      entity: 'PaymentProviderAccount',
      entityId: account.id,
      companyId: req.companyScope.id,
      meta: {
        provider: account.provider,
        mode: account.mode,
        branchId: account.branchId,
        keyId: account.keyId,
        // A short hash, never the secret. It is enough to prove two accounts
        // hold different credentials, or that a rotation actually changed
        // something, without the audit log becoming a place credentials live.
        keySecretFingerprint: secretFingerprint(data.keySecret),
      },
    });
    await auditPlatformWrite(req);
    res.status(201).json({ account: withBranch(account) });
  }),
);

// No provider and no branchId. Both are identity: an account is the credentials
// for one provider at one place, and changing either would silently re-point
// every intent and payment already recorded against this row.
const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    mode: z.enum(['TEST', 'LIVE']).optional(),
    keyId: z.string().trim().min(1).max(200).optional(),
    keySecret: secret.optional(),
    webhookSecret: secret.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

router.patch(
  '/:id',
  requireAction('payment.account.write'),
  requireUsableLicense,
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body ?? {});
    const existing = await prisma.paymentProviderAccount.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id, ...scopeWhere(req) },
    });
    if (!existing) throw notFound('Merchant account not found');
    if (body.keySecret || body.webhookSecret) requireSecretStorage();

    const data = {
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.mode === undefined ? {} : { mode: body.mode }),
      ...(body.keyId === undefined ? {} : { keyId: body.keyId }),
      ...(body.active === undefined ? {} : { active: body.active }),
      ...(body.keySecret === undefined ? {} : { keySecretEnc: encryptSecret(body.keySecret) }),
      ...(body.webhookSecret === undefined
        ? {}
        : { webhookSecretEnc: encryptSecret(body.webhookSecret) }),
    };
    // Any credential change invalidates a past verification: it was a statement
    // about the credentials that were there then. Leaving the green tick up
    // would tell an operator that a key nobody has ever used is known to work.
    if (body.keyId !== undefined || body.keySecret !== undefined || body.mode !== undefined) {
      data.lastVerifiedAt = null;
      data.lastVerifyNote = null;
    }

    const account = await prisma.paymentProviderAccount.update({
      where: { id: existing.id },
      data,
      include,
    });

    await audit(req, {
      action: 'PAYMENT_ACCOUNT_UPDATE',
      entity: 'PaymentProviderAccount',
      entityId: account.id,
      companyId: req.companyScope.id,
      meta: {
        provider: account.provider,
        branchId: account.branchId,
        // WHICH fields moved, and the before/after of the ones that are safe to
        // record. Secrets appear only as a fingerprint, and only to prove that
        // a rotation happened.
        changed: Object.keys(body),
        before: { label: existing.label, mode: existing.mode, keyId: existing.keyId, active: existing.active },
        after: { label: account.label, mode: account.mode, keyId: account.keyId, active: account.active },
        ...(body.keySecret ? { keySecretFingerprint: secretFingerprint(body.keySecret) } : {}),
        ...(body.webhookSecret ? { webhookSecretFingerprint: secretFingerprint(body.webhookSecret) } : {}),
      },
    });
    await auditPlatformWrite(req);
    res.json({ account: withBranch(account) });
  }),
);

// Does this account actually work?
//
// The only honest way to answer is to make an authenticated call and see. A
// stored credential that has never been used is a credential that fails at the
// counter, in front of a customer, on the first sale — and the operator who
// typed it is by then somewhere else.
//
// It is a READ at the provider. Nothing here opens a payment, and a failure
// changes no money: it records that the credentials did not authenticate.
router.post(
  '/:id/verify',
  requireAction('payment.account.write'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.paymentProviderAccount.findFirst({
      where: { id: req.params.id, companyId: req.companyScope.id, ...scopeWhere(req) },
    });
    if (!existing) throw notFound('Merchant account not found');
    if (!gatewayAvailable()) throw conflict('No payment provider is configured on this deployment');

    const adapter = getAdapter();
    if (existing.provider !== adapter.name) {
      throw conflict(`This deployment is configured for "${adapter.name}", so this account cannot be checked here`);
    }
    if (typeof adapter.verifyCredentials !== 'function') {
      throw conflict('This payment provider offers no way to check credentials without taking a payment');
    }

    let credentials;
    try {
      credentials = resolveAccountRow(existing);
    } catch (err) {
      if (err instanceof PaymentAccountError) throw conflict(err.message);
      throw err;
    }

    const answer = await adapter.verifyCredentials({
      credentials: { keyId: credentials.keyId, keySecret: credentials.keySecret },
    });
    // Note, not a verdict about the account's fitness: the point of recording
    // the failure is that the next person to look sees what the provider said.
    const note = String(answer.detail ?? (answer.ok ? 'the provider accepted these credentials' : 'the provider refused these credentials')).slice(0, 200);
    const account = await prisma.paymentProviderAccount.update({
      where: { id: existing.id },
      // lastVerifiedAt is set ONLY on success. It means "these were known to
      // work at this moment"; stamping it on a failure would turn it into
      // "somebody pressed the button", which is not a fact anyone needs.
      data: { lastVerifyNote: note, ...(answer.ok ? { lastVerifiedAt: new Date() } : {}) },
      include,
    });

    await audit(req, {
      action: answer.ok ? 'PAYMENT_ACCOUNT_VERIFIED' : 'PAYMENT_ACCOUNT_VERIFY_FAILED',
      entity: 'PaymentProviderAccount',
      entityId: account.id,
      companyId: req.companyScope.id,
      meta: { provider: account.provider, branchId: account.branchId, keyId: account.keyId, note },
    });
    res.json({ ok: answer.ok, note, account: withBranch(account) });
  }),
);

export default router;
