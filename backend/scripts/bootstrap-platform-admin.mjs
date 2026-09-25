// Provisions a PERMANENT platform administrator — the account that creates
// real customer companies, issues licences and invites customer owners.
//
// Usage (inside the backend container; DATABASE_URL and SMTP_* come from the
// environment):
//   node scripts/bootstrap-platform-admin.mjs --email you@example.com
//   node scripts/bootstrap-platform-admin.mjs --email you@example.com --confirm
//
// Preview is the default: it prints exactly what it would do and writes
// nothing. Nothing is written and no mail is sent without --confirm.
//
// Exit codes: 0 ok · 1 refused/failed · 2 usage.
//
// --- Why this INVITES rather than creating an account with a password ------
//
// The script never chooses, prints, stores or mails a password. It mints a
// single-use invitation and sends it, and the recipient sets their own
// password on the accept page. That buys three things at once: the address is
// PROVEN (the link only ever existed in that mailbox), no credential passes
// through a terminal, a scrollback, a log or this file, and the account cannot
// be created at all unless the operator's own mail configuration works.
//
// It is also why the script REFUSES when SMTP is unconfigured instead of
// falling back to printing a password. A platform administrator nobody can
// reach is not a lesser success; it is the failure this refusal prevents.
//
// --- Why an existing non-admin account is a refusal, never an upgrade ------
//
// "Never grant platform access merely by email registration" is the rule this
// enforces. If the address already belongs to somebody — a cashier at a
// customer, say — this stops and says so. Silently promoting an existing row
// to POS_SUPER_ADMIN is precisely the escalation the rule exists to prevent,
// and the fact that an operator typed the address is not evidence that the
// person holding it should own the platform.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Imported AFTER PrismaClient so a bad DATABASE_URL fails on the database
// rather than inside config/env.js's mail validation, which would be a
// confusing thing to read when the database is what is wrong.
const { env, mailEnabled } = await import('../src/config/env.js');
const { createInvitation, sendInvitationMail, invitationView } = await import('../src/lib/invitations.js');
const { roleLabel } = await import('../src/lib/permissions.js');
const { recipientAllowed, mailStatus } = await import('../src/lib/mail/mailer.js');

const PLATFORM_ROLE = 'POS_SUPER_ADMIN';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const emailArg = valueOf('--email') || process.env.POS_BOOTSTRAP_ADMIN_EMAIL;
const confirm = has('--confirm');

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// No default address. The owner's real mailbox is an INPUT; baking one into a
// file in a public repository would be both a leak and a footgun.
if (!emailArg) {
  die('usage: node scripts/bootstrap-platform-admin.mjs --email you@example.com [--confirm]', 2);
}
// Gate on the FLAG, not the value: `--email` as the final argument makes
// valueOf() undefined, and a typo must not fall through to the env var.
if (has('--email') && (!valueOf('--email') || valueOf('--email').startsWith('--'))) {
  die('refused: --email needs an address', 2);
}

const email = String(emailArg).trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die(`refused: "${email}" is not an email address`, 2);

const main = async () => {
  // 1. Mail first. Everything below is pointless if the invitation cannot
  //    leave the building, and finding that out AFTER writing rows would leave
  //    a live invitation nobody received.
  if (!mailEnabled) {
    console.error('REFUSED: email delivery is not configured, so the invitation could not be delivered.');
    console.error('');
    console.error('A platform administrator who never receives the link is not a partial success —');
    console.error('it is an account nobody can sign in to. Configure the sender, then re-run.');
    console.error('');
    console.error('  SMTP_HOST      your provider host        SMTP_PORT      587 (starttls) or 465 (tls)');
    console.error('  SMTP_USERNAME  the mailbox/API user      SMTP_PASSWORD  its password or API key');
    console.error('  MAIL_FROM      the From: address, on a domain the provider may send for (SPF/DKIM)');
    console.error('');
    console.error('Set them where the other secrets live — NOT in the repository, NOT on the command line.');
    process.exit(1);
  }
  if (!recipientAllowed(email)) {
    const s = mailStatus();
    die(
      `refused: ${email} is not in MAIL_ALLOWED_RECIPIENTS (${(s.allowedRecipients || []).join(', ') || 'empty'}).\n` +
        'Outside production this deployment may only mail approved addresses, so a copied-in\n' +
        'production database cannot turn a rehearsal into a message to a real person.',
    );
  }

  // 2. What already exists. Both answers below are terminal — this script
  //    changes no existing account, ever.
  const existing = await prisma.posUser.findUnique({
    where: { email },
    select: { id: true, email: true, role: true, status: true, companyId: true },
  });

  if (existing) {
    if (existing.role === PLATFORM_ROLE && existing.companyId === null) {
      console.log(`Already provisioned: ${email} is a platform administrator (status=${existing.status}).`);
      console.log('Nothing to do; no invitation sent. This script is safe to re-run.');
      if (existing.status !== 'ACTIVE') {
        console.log(`\nNOTE: the account is ${existing.status}, not ACTIVE. Re-enable it from the admin`);
        console.log('console — deliberately not done here, since a disabled administrator was disabled');
        console.log('by somebody for a reason this script cannot see.');
      }
      return;
    }
    die(
      `REFUSED: ${email} already has an account (role=${existing.role}, ` +
        `company=${existing.companyId ?? 'none'}).\n` +
        'This script will not promote an existing account to platform administrator.\n' +
        'Platform access is granted deliberately, never inherited from owning an address.\n' +
        'Use a different address, or grant the role explicitly from the admin console.',
    );
  }

  // 3. Preview.
  const s = mailStatus();
  console.log('platform administrator bootstrap');
  console.log(`  email        ${email}`);
  console.log(`  role         ${PLATFORM_ROLE} (${roleLabel(PLATFORM_ROLE)})`);
  console.log('  tenant       none — platform scope, not a customer company');
  console.log(`  mail         ${s.host}:${s.port} ${s.security}, from ${s.from}, auth=${s.authenticated}`);
  console.log(`  app links    ${env.APP_URL}`);
  console.log('  password     chosen by the recipient on the accept page; never generated, printed or mailed');

  if (!confirm) {
    console.log('\nPREVIEW ONLY — nothing written, no mail sent. Re-run with --confirm.');
    return;
  }

  // 4. Write and send. The row is committed BEFORE the send so a delivery
  //    failure leaves a revocable invitation rather than an invisible one;
  //    createInvitation supersedes any earlier PENDING invitation for this
  //    address, so a re-run after a bounced mail issues a fresh link and kills
  //    the old one rather than leaving two live.
  const { invitation, token } = await prisma.$transaction(async (tx) => {
    const made = await createInvitation(tx, {
      companyId: null,
      email,
      fullName: 'Platform Administrator',
      role: PLATFORM_ROLE,
      createdById: null,
    });
    await tx.posAuditLog.create({
      data: {
        action: 'PLATFORM_ADMIN_BOOTSTRAP',
        entity: 'UserInvitation',
        entityId: made.invitation.id,
        actorEmail: process.env.POS_BOOTSTRAP_ACTOR || 'scripts/bootstrap-platform-admin.mjs',
        // Deliberately no token, no hash, no link.
        meta: { email, role: PLATFORM_ROLE, expiresAt: made.invitation.expiresAt.toISOString() },
      },
    });
    return made;
  });

  try {
    await sendInvitationMail({
      invitation,
      token,
      companyName: null, // platform invitation, no tenant
      roleLabel: roleLabel(PLATFORM_ROLE),
      inviterName: null,
    });
  } catch (err) {
    console.error(`\nThe invitation row was written but the mail FAILED: ${err.message}`);
    console.error(`Invitation id ${invitation.id} is live until ${invitation.expiresAt.toISOString()}.`);
    console.error('Fix the mail configuration and re-run — the re-run supersedes this invitation');
    console.error('with a fresh link, so nothing is left dangling.');
    process.exit(1);
  }

  const view = invitationView(invitation);
  console.log('\nInvitation sent.');
  console.log(`  id           ${view.id}`);
  console.log(`  status       ${view.status}`);
  console.log(`  expires      ${new Date(view.expiresAt).toISOString()}`);
  console.log(`\nThe link was emailed to ${email} and is NOT printed here — it is a credential,`);
  console.log('single-use, and this output is not a safe place for one.');
  console.log('Open it in that mailbox and choose a password to finish provisioning.');
};

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await prisma.$disconnect();
    process.exit(1);
  });
