#!/usr/bin/env node
// Runs the local SMTP capture sink as a daemon, dropping each accepted message
// into a folder as .eml. See scripts/lib/smtpSink.js for what it speaks and
// why it exists. Nothing is relayed anywhere.
//
//   MAIL_SINK_PORT  listen port  (default 5325, loopback only)
//   MAIL_SINK_DIR   drop folder  (default ./.maildrop)
import fs from 'node:fs';
import path from 'node:path';
import { startSmtpSink } from './lib/smtpSink.js';

const PORT = Number(process.env.MAIL_SINK_PORT || 5325);
const DIR = process.env.MAIL_SINK_DIR || path.resolve('.maildrop');

fs.mkdirSync(DIR, { recursive: true });

const sink = startSmtpSink({
  port: PORT,
  onMessage: (msg) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    const file = path.join(DIR, `${stamp}-${rand}.eml`);
    fs.writeFileSync(
      file,
      `X-Sink-Envelope-From: ${msg.envelope.from}\r\n` +
        `X-Sink-Envelope-To: ${msg.envelope.to.join(', ')}\r\n${msg.raw}`,
      { mode: 0o600 },
    );
    // Subject and recipient only: the body holds the code.
    process.stdout.write(`captured ${path.basename(file)} → ${msg.envelope.to.join(',')} | ${msg.subject}\n`);
  },
});

await sink.started;
process.stdout.write(`mail sink listening on 127.0.0.1:${sink.port}, writing to ${DIR}\n`);
