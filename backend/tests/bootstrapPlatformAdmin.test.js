// Drives scripts/bootstrap-platform-admin.mjs as a REAL subprocess.
//
// Importing its functions would prove nothing that matters here: what is being
// tested is a command an operator runs once, on a production box, to create
// the most privileged account on the platform. Its refusals ARE its behaviour,
// and a refusal that is really a process.exit in a module nobody spawned is
// not a refusal. So each case runs the actual file, with the actual argv, and
// asserts on the exit code and on what reached the database.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { startSmtpSink } from '../scripts/lib/smtpSink.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../scripts/bootstrap-platform-admin.mjs');

const sink = startSmtpSink({ port: 0 });
await sink.started;

const { prisma } = await import('../src/lib/prisma.js');
const { hashPassword } = await import('../src/lib/crypto.js');

const ADMIN = 'platform.admin@bootstrap.test';

// The environment the script sees. Built here rather than inherited so the
// test states its own preconditions instead of depending on the shell.
const scriptEnv = (over = {}) => ({
  ...process.env,
  NODE_ENV: 'test',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(sink.port),
  SMTP_SECURITY: 'none',
  MAIL_FROM: 'VEXO Connect <no-reply@bootstrap.test>',
  MAIL_ALLOWED_RECIPIENTS: '*@bootstrap.test',
  APP_URL: 'https://portal.vexoconnect.test/pos',
  ...over,
});

// execFile rejects on a non-zero exit; both halves are wanted either way.
const exec = async (args, over = {}) => {
  try {
    const { stdout, stderr } = await run('node', [SCRIPT, ...args], { env: scriptEnv(over) });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
};

// The whole list, not only the tables this file writes. The suite shares one
// database and runs the files in sequence, so a wipe that covers only its own
// rows fails on the PREVIOUS file's residue — the RESTRICT keys refuse, and the
// error names a table this file never touched. Copied from invitations.test.js,
// which is the lane's canonical order.
const wipe = async () => {
  await prisma.userInvitation.deleteMany();
  await prisma.emailOutbox.deleteMany();
  await prisma.authChallenge.deleteMany();
  await prisma.dayClose.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.gatewayWebhookEvent.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.promotionRedemption.deleteMany();
  await prisma.promotionStore.deleteMany();
  await prisma.promotionItemRule.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.orderItemModifier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.kot.deleteMany();
  await prisma.order.deleteMany();
  await prisma.invoiceCounter.deleteMany();
  await prisma.modifierOption.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.taxRate.deleteMany();
  await prisma.diningTable.deleteMany();
  await prisma.posAuditLog.deleteMany();
  await prisma.posSession.deleteMany();
  await prisma.licenseAddon.deleteMany();
  await prisma.license.deleteMany();
  await prisma.discountPolicy.deleteMany();
  await prisma.supportAccessGrant.deleteMany();
  await prisma.permissionRule.deleteMany();
  await prisma.userStoreAssignment.deleteMany();
  await prisma.device.deleteMany();
  await prisma.terminal.deleteMany();
  await prisma.branchBrand.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.posUser.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.gstRegistration.deleteMany();
  await prisma.legalEntity.deleteMany();
  await prisma.region.deleteMany({ where: { parentId: { not: null } } });
  await prisma.region.deleteMany();
  await prisma.company.deleteMany();
};

beforeAll(wipe);
beforeEach(async () => {
  await wipe();
  sink.reset();
});
afterAll(async () => {
  await wipe();
  await sink.close();
  await prisma.$disconnect();
});

const invitations = () => prisma.userInvitation.findMany();

// The message as the recipient reads it: the plain-text MIME part, base64
// decoded. Reading msg.raw directly would miss the link entirely.
const bodyOfLastMail = () => {
  const msg = sink.messages[sink.messages.length - 1];
  const parts = msg.raw.split(/--=_vexo_[0-9a-f]+/);
  const plain = parts.find((p) => p.includes('text/plain'));
  return Buffer.from(plain.slice(plain.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
};

describe('bootstrapping the platform administrator', () => {
  it('previews without writing a row or sending a message', async () => {
    const res = await exec(['--email', ADMIN]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('PREVIEW ONLY');
    expect(await invitations()).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('mints and mails an invitation under --confirm, printing no link', async () => {
    const res = await exec(['--email', ADMIN, '--confirm']);
    expect(res.code, res.stderr).toBe(0);

    const rows = await invitations();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('POS_SUPER_ADMIN');
    // Platform scope, not a tenant's.
    expect(rows[0].companyId).toBeNull();
    expect(rows[0].status).toBe('PENDING');

    // Delivered, and to the right mailbox.
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0].envelope.to.join(',')).toContain(ADMIN);

    // The link is a single-use credential. It belongs in the mailbox and
    // NOWHERE else — not on the terminal an operator may be screen-sharing,
    // not in the scrollback, not in the audit row.
    const token = bodyOfLastMail().match(/https:\/\/\S+#([A-Za-z0-9_-]{20,})/)?.[1];
    expect(token, 'no accept link in the delivered message').toBeTruthy();
    expect(res.stdout).not.toContain(token);
    expect(res.stdout).not.toMatch(/https:\/\/\S+#/);

    const audit = await prisma.posAuditLog.findFirst({ where: { action: 'PLATFORM_ADMIN_BOOTSTRAP' } });
    expect(audit, 'no PLATFORM_ADMIN_BOOTSTRAP audit row').toBeTruthy();
    expect(JSON.stringify(audit.meta)).not.toContain(token);
    expect(JSON.stringify(audit.meta)).not.toContain(rows[0].tokenHash);
  });

  it('refuses when email is unconfigured, rather than falling back to a password', async () => {
    const res = await exec(['--email', ADMIN, '--confirm'], { SMTP_HOST: '' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('REFUSED');
    expect(res.stderr).toContain('SMTP_HOST');
    // The refusal must be total: an administrator half-created here is an
    // account nobody can reach and nobody knows exists.
    expect(await invitations()).toHaveLength(0);
    expect(await prisma.posUser.count()).toBe(0);
    // And it must not offer a password as a consolation prize.
    expect(res.stdout + res.stderr).not.toMatch(/password is|generated password|temporary password/i);
  });

  it('is safe to re-run once the administrator exists, and sends nothing', async () => {
    await prisma.posUser.create({
      data: {
        email: ADMIN,
        fullName: 'Platform Administrator',
        role: 'POS_SUPER_ADMIN',
        companyId: null,
        passwordHash: await hashPassword('already-chosen-99'),
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    const res = await exec(['--email', ADMIN, '--confirm']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('Already provisioned');
    expect(await invitations()).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses to promote an address that already belongs to somebody', async () => {
    const company = await prisma.company.create({
      data: { name: 'Brew Street', slug: 'brew-street-bootstrap', status: 'ACTIVE' },
    });
    await prisma.posUser.create({
      data: {
        email: ADMIN,
        fullName: 'A Cashier',
        role: 'CASHIER',
        companyId: company.id,
        passwordHash: await hashPassword('cashier-password-1'),
        status: 'ACTIVE',
      },
    });

    const res = await exec(['--email', ADMIN, '--confirm']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('REFUSED');

    // Unchanged — owning an address is not evidence of entitlement to the
    // platform, and this is the escalation the rule exists to prevent.
    const after = await prisma.posUser.findUnique({ where: { email: ADMIN } });
    expect(after.role).toBe('CASHIER');
    expect(after.companyId).toBe(company.id);
    expect(await invitations()).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses a recipient outside the non-production allowlist', async () => {
    const res = await exec(['--email', 'someone@elsewhere.example', '--confirm']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('MAIL_ALLOWED_RECIPIENTS');
    expect(await invitations()).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });

  it('refuses without an address rather than defaulting to one', async () => {
    const res = await exec([]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('usage:');
    expect(await invitations()).toHaveLength(0);
  });
});
