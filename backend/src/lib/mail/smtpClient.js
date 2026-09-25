import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

// Minimal SMTP submission client on node:net / node:tls — no third-party
// dependency, which keeps the lane inside the shared manifest contract. It
// speaks exactly the subset a transactional sender needs: EHLO, STARTTLS,
// AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT. Verified in tests against an
// in-process SMTP sink (tests/helpers/smtpSink.js) end to end, including the
// STARTTLS upgrade and both AUTH mechanisms.

export class SmtpError extends Error {
  constructor(message, { code, command, response } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code ?? null;
    this.command = command ?? null;
    this.response = response ?? null;
  }
}

// One SMTP reply: possibly multi-line ("250-SIZE…" then "250 OK"). Returns
// { code, lines } once the final line ("250 " with a space) arrives.
const createReplyReader = (onReply, onError) => {
  let buffer = '';
  let lines = [];
  return (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!/^\d{3}[ -]/.test(line)) {
        onError(new SmtpError(`Malformed SMTP reply line: ${line.slice(0, 80)}`));
        return;
      }
      lines.push(line);
      if (line[3] === ' ') {
        const reply = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        onReply(reply);
      }
    }
  };
};

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// RFC 2045 base64 body: 76-char lines, CRLF. Base64 lines can never begin
// with a dot, so encoded bodies need no dot-stuffing — the stuffing below is
// applied to the whole DATA payload anyway, as a belt on the braces.
const b64Body = (s) => b64(s).replace(/(.{76})/g, '$1\r\n').trimEnd();

const dotStuff = (s) => s.replace(/(^|\r\n)\./g, '$1..');

// RFC 2047 encoded-word for non-ASCII header text (subjects with ₹ or names
// in Devanagari must survive transport).
const headerText = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

const addrOf = (mailbox) => {
  const m = /<([^>]+)>/.exec(mailbox);
  return m ? m[1] : mailbox.trim();
};

export const buildMimeMessage = ({ from, to, subject, text, html, messageId }) => {
  const boundary = `=_vexo_${randomBytes(12).toString('hex')}`;
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${headerText(subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Body(html),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
};

// security: 'tls' = implicit TLS from byte one (ports like 465).
//           'starttls' = plaintext greeting, upgrade before AUTH (ports like 587).
//           'none' = plaintext throughout — dev sink only; mailer.js refuses
//           to configure it in production.
export const sendSmtp = async ({
  host,
  port,
  security = 'starttls',
  username = null,
  password = null,
  from,
  to,
  subject,
  text,
  html,
  heloName = 'vexo-connect',
  timeoutMs = 20000,
  tlsOptions = {},
}) => {
  const recipients = Array.isArray(to) ? to : [to];
  const messageId = `<${randomBytes(16).toString('hex')}@vexo-connect>`;
  const payload = buildMimeMessage({ from, to: recipients, subject, text, html, messageId });

  let socket = null;
  let replyHandler = null;
  let failConnection = null;

  const attachReader = (sock) => {
    const reader = createReplyReader(
      (reply) => replyHandler?.(reply),
      (err) => failConnection?.(err),
    );
    sock.on('data', reader);
  };

  const connect = () =>
    new Promise((resolve, reject) => {
      const onError = (err) => reject(new SmtpError(`SMTP connect failed: ${err.message}`));
      const sock =
        security === 'tls'
          ? tls.connect({ host, port, servername: host, ...tlsOptions }, () => resolve(sock))
          : net.connect({ host, port }, () => resolve(sock));
      sock.once('error', onError);
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        reject(new SmtpError('SMTP connection timed out'));
      });
    });

  const waitReply = (command) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        replyHandler = null;
        reject(new SmtpError(`SMTP timeout waiting after ${command}`, { command }));
      }, timeoutMs);
      failConnection = (err) => {
        clearTimeout(timer);
        replyHandler = null;
        reject(err);
      };
      replyHandler = (reply) => {
        clearTimeout(timer);
        replyHandler = null;
        resolve(reply);
      };
    });

  const command = async (line, { expect, redactAs } = {}) => {
    socket.write(`${line}\r\n`);
    const reply = await waitReply(redactAs ?? line.split(' ')[0]);
    if (expect && !expect.includes(reply.code)) {
      throw new SmtpError(`SMTP ${redactAs ?? line.split(' ')[0]} refused: ${reply.lines.join(' | ')}`, {
        code: reply.code,
        command: redactAs ?? line.split(' ')[0],
        response: reply.lines,
      });
    }
    return reply;
  };

  try {
    socket = await connect();
    socket.on('error', (err) => failConnection?.(new SmtpError(`SMTP socket error: ${err.message}`)));
    attachReader(socket);

    const greeting = await waitReply('connect');
    if (greeting.code !== 220) {
      throw new SmtpError(`SMTP greeting refused: ${greeting.lines.join(' | ')}`, { code: greeting.code });
    }

    let ehlo = await command(`EHLO ${heloName}`, { expect: [250] });

    if (security === 'starttls') {
      if (!ehlo.lines.some((l) => /starttls/i.test(l))) {
        throw new SmtpError('Server does not offer STARTTLS; refusing to continue in plaintext');
      }
      await command('STARTTLS', { expect: [220] });
      const plain = socket;
      plain.setTimeout(0);
      plain.removeAllListeners('data');
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect(
          { socket: plain, servername: host, ...tlsOptions },
          () => resolve(upgraded),
        );
        upgraded.once('error', (err) => reject(new SmtpError(`STARTTLS failed: ${err.message}`)));
      });
      socket.setTimeout(timeoutMs);
      socket.on('error', (err) => failConnection?.(new SmtpError(`SMTP socket error: ${err.message}`)));
      attachReader(socket);
      ehlo = await command(`EHLO ${heloName}`, { expect: [250] });
    }

    if (username) {
      const mechanisms = ehlo.lines
        .filter((l) => /auth /i.test(l))
        .flatMap((l) => l.slice(4).replace(/^auth/i, '').trim().split(/\s+/))
        .map((m) => m.toUpperCase());
      if (mechanisms.includes('PLAIN') || mechanisms.length === 0) {
        await command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, {
          expect: [235],
          redactAs: 'AUTH',
        });
      } else if (mechanisms.includes('LOGIN')) {
        await command('AUTH LOGIN', { expect: [334], redactAs: 'AUTH' });
        await command(b64(username), { expect: [334], redactAs: 'AUTH-USER' });
        await command(b64(password), { expect: [235], redactAs: 'AUTH-PASS' });
      } else {
        throw new SmtpError(`No supported AUTH mechanism (server offers: ${mechanisms.join(', ')})`);
      }
    }

    await command(`MAIL FROM:<${addrOf(from)}>`, { expect: [250] });
    for (const rcpt of recipients) {
      await command(`RCPT TO:<${addrOf(rcpt)}>`, { expect: [250, 251] });
    }
    await command('DATA', { expect: [354] });
    socket.write(dotStuff(payload));
    socket.write('\r\n.\r\n');
    const accepted = await waitReply('DATA-BODY');
    if (accepted.code !== 250) {
      throw new SmtpError(`Message refused after DATA: ${accepted.lines.join(' | ')}`, {
        code: accepted.code,
        command: 'DATA-BODY',
        response: accepted.lines,
      });
    }
    try {
      await command('QUIT', { expect: [221] });
    } catch {
      // Delivery already succeeded; a rude close after QUIT is the server's
      // problem, not the message's.
    }
    return { messageId, response: accepted.lines.join(' ') };
  } finally {
    socket?.destroy();
  }
};
