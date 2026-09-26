import { env, mailEnabled } from '../../config/env.js';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { sendSmtp, SmtpError } from './smtpClient.js';

// The one place a message leaves this system. Everything above it builds a
// template and calls sendMail(); nothing else opens a socket.
//
// Three invariants live here rather than in the callers, because a caller that
// forgets one is exactly the accident worth designing out:
//   1. Bodies are never persisted and never logged. Every message this system
//      sends carries a code, a token or a link; an outbox row keeps the
//      recipient, the template and the provider's answer, and nothing else.
//   2. Outside production, recipients must match MAIL_ALLOWED_RECIPIENTS. The
//      check runs before the socket opens.
//   3. A send that fails is recorded as FAILED with the reason, and the
//      failure is returned to the caller. No flow gets to believe it sent
//      something it did not.

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'Email delivery is not configured: set SMTP_HOST, SMTP_PORT and MAIL_FROM. ' +
        'Until then, flows that must reach a real mailbox refuse rather than pretend.',
    );
    this.name = 'MailNotConfiguredError';
    this.code = 'MAIL_NOT_CONFIGURED';
  }
}

export class MailRecipientRefusedError extends Error {
  constructor(to) {
    super(
      `Refusing to send to ${to}: outside production this deployment may only mail ` +
        'addresses matching MAIL_ALLOWED_RECIPIENTS.',
    );
    this.name = 'MailRecipientRefusedError';
    this.code = 'MAIL_RECIPIENT_REFUSED';
  }
}

const patterns = () =>
  (env.MAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

// "*@example.com" matches any mailbox at that domain; anything else must match
// the whole address. No regex is built from the pattern — a stray "." in a
// domain must not become "any character".
export const recipientAllowed = (address) => {
  if (env.NODE_ENV === 'production') return true;
  const addr = String(address).toLowerCase().trim();
  return patterns().some((p) =>
    p.startsWith('*@') ? addr.endsWith(p.slice(1)) : addr === p,
  );
};

export const mailStatus = () => ({
  configured: mailEnabled,
  host: mailEnabled ? env.SMTP_HOST : null,
  port: mailEnabled ? env.SMTP_PORT : null,
  security: mailEnabled ? env.SMTP_SECURITY : null,
  from: mailEnabled ? env.MAIL_FROM : null,
  authenticated: Boolean(env.SMTP_USERNAME),
  // Present outside production only, where it is a safety rail worth showing.
  allowedRecipients: env.NODE_ENV === 'production' ? null : patterns(),
});

// Sends, and records the attempt. `message` is { subject, text, html } from
// lib/mail/templates.js. `meta` is joined to the outbox row for traceability
// and must never contain a code, token or password.
//
// Returns { id, messageId, response }. Throws on refusal or delivery failure —
// after writing the FAILED row, so a refusal is still visible in the ledger.
export const sendMail = async ({ to, template, message, companyId = null, userId = null, meta = null }) => {
  if (!mailEnabled) throw new MailNotConfiguredError();
  if (!recipientAllowed(to)) throw new MailRecipientRefusedError(to);

  const row = await prisma.emailOutbox.create({
    data: {
      to,
      template,
      subject: message.subject,
      status: 'QUEUED',
      companyId,
      userId,
      meta: meta ?? undefined,
    },
    select: { id: true },
  });

  try {
    const result = await sendSmtp({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      security: env.SMTP_SECURITY,
      username: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
      to: [to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      timeoutMs: env.SMTP_TIMEOUT_MS,
    });
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: {
        status: 'SENT',
        attempts: { increment: 1 },
        sentAt: new Date(),
        messageId: result.messageId,
        providerResponse: result.response.slice(0, 500),
      },
    });
    // Recipient and template only. The body is not available here by design.
    logger.info({ mail: { id: row.id, to, template } }, 'mail sent');
    return { id: row.id, messageId: result.messageId, response: result.response };
  } catch (err) {
    const reason =
      err instanceof SmtpError
        ? `${err.command ? `${err.command}: ` : ''}${err.message}`
        : err.message;
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { status: 'FAILED', attempts: { increment: 1 }, lastError: reason.slice(0, 500) },
    });
    logger.error({ mail: { id: row.id, to, template }, reason }, 'mail failed');
    throw err;
  }
};

// For flows where the user-visible outcome must not depend on delivery — a
// password-changed notice, say: the password IS changed, and a mail server
// having a bad minute cannot be allowed to unwind that. The failure is still
// recorded in the outbox and logged; it is only the throw that is swallowed.
export const sendMailBestEffort = async (args) => {
  try {
    return await sendMail(args);
  } catch (err) {
    logger.warn({ template: args.template, reason: err.message }, 'notification mail not delivered');
    return null;
  }
};
