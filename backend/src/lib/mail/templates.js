import { env } from '../../config/env.js';

// Builders for every outbound message the account flows send. Each returns
// { subject, text, html } for the mailer; nothing here touches the network.
//
// Two rules the builders enforce by construction:
//  - Action links come from env.APP_URL — operator-controlled configuration —
//    never from a request's Host header, which the sender of a forged
//    password-reset request controls and could use to poison the link.
//  - Codes and tokens appear in message bodies only. Subjects stay generic so
//    lock-screen previews and mail-client notifications don't expose them.

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Resolved BENEATH APP_URL, not against its origin. The portal is served from
// a sub-path in production (…/pos), and `new URL('/invite', 'https://host/pos')`
// quietly returns 'https://host/invite' — an email full of links to a page that
// is not there. Forcing a trailing slash on the base and a relative path makes
// the sub-path part of the answer.
export const appLink = (path) => {
  const base = env.APP_URL.endsWith('/') ? env.APP_URL : `${env.APP_URL}/`;
  return new URL(String(path).replace(/^\/+/, ''), base).toString();
};

const IST = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});
const fmtWhen = (d) => `${IST.format(new Date(d))} IST`;

const layout = (title, bodyHtml) => `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
    <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
      <div style="background:#111827;border-radius:8px 8px 0 0;padding:18px 24px;">
        <span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.4px;">${esc(env.APP_NAME)}</span>
      </div>
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:28px 24px;">
        <h1 style="margin:0 0 16px;font-size:18px;">${title}</h1>
        ${bodyHtml}
      </div>
      <p style="color:#6b7280;font-size:12px;margin:16px 8px;">
        This is an automated message from ${esc(env.APP_NAME)}. If you were not expecting it, you can safely ignore it.
      </p>
    </div>
  </body>
</html>`;

const para = (html) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;">${html}</p>`;
const muted = (html) => `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">${html}</p>`;

const button = (url, label) => `
      <p style="margin:24px 0 10px;">
        <a href="${esc(url)}" style="background:#111827;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:14px;display:inline-block;">${esc(label)}</a>
      </p>
      <p style="font-size:12px;color:#6b7280;word-break:break-all;margin:0 0 14px;">If the button does not work, open this link:<br>${esc(url)}</p>`;

const codeBlock = (code) => `
      <p style="margin:24px 0;text-align:center;">
        <span style="display:inline-block;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:12px 20px;font-size:26px;letter-spacing:6px;font-family:Consolas,'Courier New',monospace;">${esc(code)}</span>
      </p>`;

// companyName null ⇒ platform-administrator invitation (no tenant).
export const invitationEmail = ({ companyName, roleLabel, inviterName, acceptUrl, expiresAt }) => {
  const where = companyName ? `${companyName} on ${env.APP_NAME}` : `the ${env.APP_NAME} platform team`;
  const subject = companyName
    ? `You are invited to join ${companyName} on ${env.APP_NAME}`
    : `${env.APP_NAME} platform administrator invitation`;
  const text = [
    `You are invited to join ${where} as ${roleLabel}.`,
    inviterName ? `Invited by: ${inviterName}` : null,
    '',
    'Accept the invitation and choose your own password:',
    acceptUrl,
    '',
    `This invitation expires on ${fmtWhen(expiresAt)} and can be used once.`,
    'Anyone with this link can accept the invitation, so do not forward it.',
    'If you were not expecting this invitation, ignore this email.',
  ]
    .filter((l) => l !== null)
    .join('\n');
  const html = layout(
    companyName ? `Join ${esc(companyName)}` : 'Platform administrator invitation',
    [
      para(`You are invited to join <strong>${esc(where)}</strong> as <strong>${esc(roleLabel)}</strong>.`),
      inviterName ? para(`Invited by ${esc(inviterName)}.`) : '',
      button(acceptUrl, 'Accept invitation'),
      para(`You will verify this email address and choose your own password. No password is sent by email.`),
      muted(
        `This invitation expires on ${esc(fmtWhen(expiresAt))} and can be used once. ` +
          'Anyone with the link can accept it, so do not forward this email. ' +
          'If you were not expecting it, simply ignore it.',
      ),
    ].join(''),
  );
  return { subject, text, html };
};

export const resetCodeEmail = ({ code, ttlMinutes, maxAttempts }) => ({
  subject: `Your ${env.APP_NAME} password reset code`,
  text: [
    'Use this code to continue resetting your password:',
    '',
    `    ${code}`,
    '',
    `The code expires in ${ttlMinutes} minutes and allows ${maxAttempts} attempts.`,
    'If you did not request a reset, your password is unchanged and you can',
    `ignore this email. Never share this code — ${env.APP_NAME} staff will never ask for it.`,
  ].join('\n'),
  html: layout(
    'Password reset code',
    [
      para('Use this code to continue resetting your password:'),
      codeBlock(code),
      para(`The code expires in <strong>${ttlMinutes} minutes</strong> and allows ${maxAttempts} attempts.`),
      muted(
        'If you did not request a reset, your password is unchanged and you can ignore this email. ' +
          `Never share this code — ${esc(env.APP_NAME)} staff will never ask for it.`,
      ),
    ].join(''),
  ),
});

export const passwordChangedEmail = ({ when, ip }) => ({
  subject: `Your ${env.APP_NAME} password was changed`,
  text: [
    `The password for your account was changed on ${fmtWhen(when)}${ip ? ` from IP ${ip}` : ''}.`,
    'All previous sign-in sessions were signed out.',
    '',
    'If this was you, no further action is needed.',
    "If it was not, use 'Forgot password?' on the sign-in page immediately to",
    'take back control, and inform your administrator.',
  ].join('\n'),
  html: layout(
    'Password changed',
    [
      para(
        `The password for your account was changed on <strong>${esc(fmtWhen(when))}</strong>${
          ip ? ` from IP ${esc(ip)}` : ''
        }. All previous sign-in sessions were signed out.`,
      ),
      para('If this was you, no further action is needed.'),
      muted(
        "If it was not, use 'Forgot password?' on the sign-in page immediately to take back control, " +
          'and inform your administrator.',
      ),
    ].join(''),
  ),
});

// Sent to the NEW address to prove control of it before the switch happens.
export const emailChangeVerifyEmail = ({ code, ttlMinutes }) => ({
  subject: `Confirm your new ${env.APP_NAME} sign-in email`,
  text: [
    `A request was made to move a ${env.APP_NAME} account to this email address.`,
    'Enter this code in the portal to confirm the change:',
    '',
    `    ${code}`,
    '',
    `The code expires in ${ttlMinutes} minutes.`,
    'If you did not request this, ignore this email and nothing will change.',
  ].join('\n'),
  html: layout(
    'Confirm your new sign-in email',
    [
      para(`A request was made to move a ${esc(env.APP_NAME)} account to this email address.`),
      para('Enter this code in the portal to confirm the change:'),
      codeBlock(code),
      para(`The code expires in <strong>${ttlMinutes} minutes</strong>.`),
      muted('If you did not request this, ignore this email and nothing will change.'),
    ].join(''),
  ),
});

// Sent to the OLD address after the switch, so a hijacked change is visible.
export const emailChangedNoticeEmail = ({ newEmail, when }) => ({
  subject: `Your ${env.APP_NAME} sign-in email was changed`,
  text: [
    `Your sign-in email was changed to ${newEmail} on ${fmtWhen(when)}.`,
    'This address no longer signs in to the account.',
    '',
    'If you made this change, no further action is needed.',
    'If you did not, contact your administrator immediately.',
  ].join('\n'),
  html: layout(
    'Sign-in email changed',
    [
      para(
        `Your sign-in email was changed to <strong>${esc(newEmail)}</strong> on ${esc(fmtWhen(when))}. ` +
          'This address no longer signs in to the account.',
      ),
      para('If you made this change, no further action is needed.'),
      muted('If you did not, contact your administrator immediately.'),
    ].join(''),
  ),
});

export const mfaEnabledEmail = ({ when }) => ({
  subject: `Two-factor authentication enabled on your ${env.APP_NAME} account`,
  text: [
    `Two-factor authentication (authenticator app) was enabled on your account on ${fmtWhen(when)}.`,
    'From now on, sign-in requires a 6-digit code from your authenticator app.',
    '',
    'If you did not do this, reset your password immediately and contact your administrator.',
  ].join('\n'),
  html: layout(
    'Two-factor authentication enabled',
    [
      para(
        `Two-factor authentication (authenticator app) was enabled on your account on <strong>${esc(
          fmtWhen(when),
        )}</strong>. From now on, sign-in requires a 6-digit code from your authenticator app.`,
      ),
      muted('If you did not do this, reset your password immediately and contact your administrator.'),
    ].join(''),
  ),
});

export const mfaDisabledEmail = ({ when }) => ({
  subject: `Two-factor authentication disabled on your ${env.APP_NAME} account`,
  text: [
    `Two-factor authentication was disabled on your account on ${fmtWhen(when)}.`,
    'Sign-in now requires only your email and password.',
    '',
    'If you did not do this, your account may be compromised: reset your password',
    'immediately and contact your administrator.',
  ].join('\n'),
  html: layout(
    'Two-factor authentication disabled',
    [
      para(
        `Two-factor authentication was disabled on your account on <strong>${esc(fmtWhen(when))}</strong>. ` +
          'Sign-in now requires only your email and password.',
      ),
      muted(
        'If you did not do this, your account may be compromised: reset your password immediately ' +
          'and contact your administrator.',
      ),
    ].join(''),
  ),
});
