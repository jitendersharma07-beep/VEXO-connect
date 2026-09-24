import { hashPassword } from './crypto.js';
import { newOpaqueToken, inviteExpiry, secretVerifier, RESEND_COOLDOWN_SECONDS } from './authcodes.js';
import { conflict } from './errors.js';
import { sendMail } from './mail/mailer.js';
import { appLink, invitationEmail } from './mail/templates.js';

// The mechanics of "somebody is invited to hold an account here". Policy —
// who may invite whom, into which tenant, with what reach — belongs to the
// callers; this file decides how an invitation is stored, mailed, found again
// and turned into a user.
//
// Three callers share it: the tenant invitation route, the public acceptance
// route, and the platform-admin bootstrap script. A second copy of "mint a
// token, revoke the old one, create the account" is how the three drift into
// disagreeing about what an accepted invitation means.

// The token exists in plaintext exactly twice: in the return value of the
// function that mints it, and in the email body. The row stores a keyed
// verifier, so a database dump alone cannot be turned back into a working
// invitation link.
const storeToken = (token) => secretVerifier(token);

// The link carries the token in the URL FRAGMENT, not the path or query.
// Fragments are never sent to a server — the browser keeps them — so the token
// cannot land in an access log, a proxy log, a Referer header, or pino-http's
// `req.url`. The accept page reads it from location.hash and POSTs it in a
// body instead.
export const acceptUrlFor = (token) => `${appLink('/invite')}#${token}`;

// One open invitation per address. Superseding rather than refusing means a
// second "invite this person" — the normal reaction to a mail that did not
// arrive — does the obvious thing, and means at most one live link exists for
// an address at any moment.
const supersedePending = (tx, email, now) =>
  tx.userInvitation.updateMany({
    where: { email, status: 'PENDING' },
    data: { status: 'REVOKED', revokedAt: now },
  });

export const emailIsFree = async (tx, email) => {
  const existing = await tx.posUser.findUnique({ where: { email }, select: { id: true } });
  return !existing;
};

// Refused for an address that already holds an account anywhere on the
// platform: PosUser.email is globally unique, so an invitation for one could
// only ever fail at acceptance — after the person has clicked the link and
// chosen a password. Throwing is right HERE, where the caller is a signed-in
// colleague who needs to know why; the acceptance path below must not, because
// telling an unauthenticated caller "that address is taken" is an answer they
// have not earned.
export const requireEmailUnused = async (tx, email) => {
  if (!(await emailIsFree(tx, email))) throw conflict('An account with this email already exists');
};

export const createInvitation = async (
  tx,
  { companyId = null, email, fullName, role, branchId = null, regionId = null, storeIds = [], createdById = null },
  now = new Date(),
) => {
  await requireEmailUnused(tx, email);
  await supersedePending(tx, email, now);
  const token = newOpaqueToken();
  const invitation = await tx.userInvitation.create({
    data: {
      companyId,
      email,
      fullName,
      role,
      branchId,
      regionId,
      storeIds,
      tokenHash: storeToken(token),
      expiresAt: inviteExpiry(now.getTime()),
      createdById,
      lastSentAt: now,
    },
  });
  return { invitation, token };
};

// A resend is a new token, not a second copy of the old one: the previous link
// stops working the moment this returns. Without that, an invitation forwarded
// by mistake stays live for its full week however many times it is reissued.
export const rotateInvitationToken = async (tx, invitationId, now = new Date()) => {
  const token = newOpaqueToken();
  const updated = await tx.userInvitation.updateMany({
    where: { id: invitationId, status: 'PENDING' },
    data: {
      tokenHash: storeToken(token),
      expiresAt: inviteExpiry(now.getTime()),
      lastSentAt: now,
      sentCount: { increment: 1 },
    },
  });
  // Lost the race with a revoke or an acceptance that landed in between.
  if (updated.count === 0) return null;
  return { invitation: await tx.userInvitation.findUnique({ where: { id: invitationId } }), token };
};

export const resendCooldownRemaining = (invitation, now = new Date()) => {
  const elapsed = (now.getTime() - new Date(invitation.lastSentAt).getTime()) / 1000;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed));
};

// Expiry is derived, never a stored status: a row that lapsed while nothing
// was running must read as expired the next time it is looked at, and a job
// that sweeps PENDING rows into EXPIRED is a job that can fail to run.
export const isOpen = (invitation, now = new Date()) =>
  Boolean(invitation) && invitation.status === 'PENDING' && new Date(invitation.expiresAt) > now;

export const findByToken = (tx, token) =>
  tx.userInvitation.findUnique({
    where: { tokenHash: storeToken(token) },
    include: { company: { select: { id: true, name: true, status: true } } },
  });

// Names for the placement, which UserInvitation stores as bare ids. Display
// only — nothing here is an authorisation input.
export const placementNames = async (tx, invitation) => {
  const [branch, region] = await Promise.all([
    invitation.branchId
      ? tx.branch.findUnique({ where: { id: invitation.branchId }, select: { name: true } })
      : null,
    invitation.regionId
      ? tx.region.findUnique({ where: { id: invitation.regionId }, select: { name: true } })
      : null,
  ]);
  return { storeName: branch?.name ?? null, regionName: region?.name ?? null };
};

// What the unauthenticated accept page is allowed to know. It names the
// company and the role so the person can tell a genuine invitation from a
// lure, and nothing else — no ids, no inviter, no token, no account state.
export const invitationOffer = (invitation, { storeName = null, regionName = null } = {}) => ({
  email: invitation.email,
  fullName: invitation.fullName,
  role: invitation.role,
  companyName: invitation.company?.name ?? null,
  storeName,
  regionName,
  expiresAt: invitation.expiresAt,
});

// The management view. Carries state but never the token or its hash, so an
// admin screen — or a screenshot of one — cannot be replayed into an account.
export const invitationView = (invitation, now = new Date()) => ({
  id: invitation.id,
  email: invitation.email,
  fullName: invitation.fullName,
  role: invitation.role,
  branchId: invitation.branchId,
  regionId: invitation.regionId,
  storeIds: invitation.storeIds,
  // PENDING-but-lapsed is reported as EXPIRED, matching what the link does.
  status: invitation.status === 'PENDING' && !isOpen(invitation, now) ? 'EXPIRED' : invitation.status,
  expiresAt: invitation.expiresAt,
  sentCount: invitation.sentCount,
  lastSentAt: invitation.lastSentAt,
  acceptedAt: invitation.acceptedAt,
  createdAt: invitation.createdAt,
});

// Turns an open invitation into an account, once. The conditional UPDATE is
// the lock: two clicks on the same link race to move the row out of PENDING
// and the loser gets zero rows back, so only one of them creates a user.
export const acceptInvitation = async (tx, invitation, { password }, now = new Date()) => {
  const claimed = await tx.userInvitation.updateMany({
    where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
    data: { status: 'ACCEPTED', acceptedAt: now },
  });
  if (claimed.count === 0) return null;

  // Re-checked after the claim, not trusted from the lookup a moment ago: an
  // account can be created for this address by another route while the person
  // is choosing a password. Answered as "this link is not usable" rather than
  // as a conflict — the caller is unauthenticated and must not learn which
  // addresses are registered.
  if (!(await emailIsFree(tx, invitation.email))) return null;

  const user = await tx.posUser.create({
    data: {
      email: invitation.email,
      fullName: invitation.fullName,
      role: invitation.role,
      companyId: invitation.companyId,
      branchId: invitation.branchId,
      regionId: invitation.regionId,
      passwordHash: await hashPassword(password),
      // They chose it themselves, so there is nothing to force a change of.
      mustChangePassword: false,
      status: 'ACTIVE',
      // Accepting the invitation IS the proof of the address: the link only
      // ever existed in that mailbox.
      emailVerifiedAt: now,
    },
  });

  if (invitation.storeIds.length && invitation.companyId) {
    await tx.userStoreAssignment.createMany({
      data: invitation.storeIds.map((branchId) => ({
        userId: user.id,
        branchId,
        companyId: invitation.companyId,
        createdById: invitation.createdById,
      })),
    });
  }

  await tx.userInvitation.update({ where: { id: invitation.id }, data: { acceptedById: user.id } });
  return user;
};

// Mails the link. Kept next to the minting so that no caller can mint a token
// and then compose its own mail body with the token somewhere it should not be.
export const sendInvitationMail = ({ invitation, token, companyName, roleLabel, inviterName }) =>
  sendMail({
    to: invitation.email,
    template: 'invitation',
    message: invitationEmail({
      companyName: companyName ?? null,
      roleLabel: roleLabel ?? invitation.role,
      inviterName: inviterName ?? null,
      acceptUrl: acceptUrlFor(token),
      expiresAt: invitation.expiresAt,
    }),
    companyId: invitation.companyId,
    meta: { invitationId: invitation.id },
  });
