import net from 'node:net';

// A minimal SMTP server that accepts submission and hands each message to a
// callback. Used two ways, and deliberately the same code both times:
//
//   - `vcxa sink` runs it as a daemon that drops .eml files, so a browser
//     acceptance run has somewhere real for mail to land.
//   - tests start it in-process and assert on what arrived.
//
// It speaks enough of the protocol for src/lib/mail/smtpClient.js to complete
// an unmodified conversation over a real socket. That is the point: a stubbed
// transport proves the templates, but only a socket proves the client — the
// multi-line reply parser, dot-stuffing, and the AUTH exchange.
//
// It relays nothing, ever. Nothing sent here can reach a real mailbox.

// STARTTLS is not advertised. The client refuses plaintext unless the operator
// set SMTP_SECURITY=none, so pointing a production config at this sink fails
// closed instead of quietly sending credentials in clear.
const EHLO_LINES = ['250-vexo-mail-sink', '250-AUTH PLAIN LOGIN', '250-SIZE 10485760', '250 8BITMIME'];

const parseMessage = (envelope, raw) => {
  // Undo dot-stuffing, then split headers from body at the first blank line.
  const text = raw.replace(/(^|\r\n)\.\./g, '$1.');
  const split = text.indexOf('\r\n\r\n');
  const headerBlock = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 4);
  const headers = {};
  // Unfold continuation lines before splitting on ':'.
  for (const line of headerBlock.replace(/\r\n[\t ]+/g, ' ').split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  return { envelope, headers, subject: headers.subject || '', body, raw: text };
};

export const startSmtpSink = ({ port = 0, host = '127.0.0.1', onMessage } = {}) => {
  const messages = [];

  const server = net.createServer((sock) => {
    let buffer = '';
    let inData = false;
    let raw = '';
    let authStage = 0;
    let envelope = { from: null, to: [] };

    const say = (line) => sock.write(`${line}\r\n`);
    say('220 vexo-mail-sink ESMTP ready');

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            const msg = parseMessage(envelope, raw);
            messages.push(msg);
            onMessage?.(msg);
            envelope = { from: null, to: [] };
            raw = '';
            say('250 2.0.0 Ok: queued as sink');
          } else {
            raw += `${line}\r\n`;
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          authStage = 0;
          for (const l of EHLO_LINES) say(l);
        } else if (upper.startsWith('HELO')) {
          say('250 vexo-mail-sink');
        } else if (upper.startsWith('AUTH PLAIN')) {
          say('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('AUTH LOGIN')) {
          authStage = 1;
          say('334 VXNlcm5hbWU6');
        } else if (authStage === 1) {
          authStage = 2;
          say('334 UGFzc3dvcmQ6');
        } else if (authStage === 2) {
          authStage = 0;
          // No credential is checked and none is retained: this sink
          // authenticates nobody, and a password it never stores is a password
          // it cannot leak into a test artefact.
          say('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('MAIL FROM')) {
          envelope.from = line.slice(line.indexOf(':') + 1).trim();
          say('250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          envelope.to.push(line.slice(line.indexOf(':') + 1).trim());
          say('250 2.1.5 Ok');
        } else if (upper === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'RSET') {
          envelope = { from: null, to: [] };
          say('250 2.0.0 Ok');
        } else if (upper === 'QUIT') {
          say('221 2.0.0 Bye');
          sock.end();
        } else {
          say('500 5.5.1 Command unrecognised');
        }
      }
    });

    sock.on('error', () => sock.destroy());
  });

  const started = new Promise((resolve) => server.listen(port, host, () => resolve()));

  return {
    started,
    messages,
    get port() {
      return server.address()?.port ?? null;
    },
    reset: () => messages.splice(0, messages.length),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.unref();
      }),
  };
};
