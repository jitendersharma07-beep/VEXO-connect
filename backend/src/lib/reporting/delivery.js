// LANE reporting — where a produced report actually goes.
//
// This product has no mail server, no SMTP credentials and no messaging
// provider. Three things could be done about that, and two of them are worse
// than the problem:
//
//   - Write an SMTP client and mark deliveries "sent". Nothing would arrive, the
//     delivery log would say otherwise, and the first person to find out would be
//     an owner who stopped getting a report they believed was still coming.
//   - Leave scheduling unbuilt until credentials exist. Then the scheduling,
//     deduplication, retry and authorisation behaviour — all of which are
//     independent of the transport, and all of which are where the real risk of a
//     double-send or an over-wide reach lives — stay unwritten and unproven.
//
// So: the report is produced, authorised, deduplicated and written to a spool
// file, and the delivery row names the transport that did it. A spool artifact is
// a real delivery that can be verified end to end. `sentTo` is what the attempt
// was addressed to, and `withheld` is who was deliberately not reached — which is
// every approved recipient that is not marked as a test address, because until a
// real transport exists no customer address may be written to anything.
//
// The one owner input this needs is named in the handover rather than guessed at
// here: which transport, and its credentials.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../config/env.js';

export const TRANSPORT_FILE = 'FILE';

export const spoolDir = () =>
  env.REPORTING_SPOOL_DIR || path.join(process.cwd(), '.reporting-spool');

/**
 * Which approved recipients this build may actually write to.
 *
 * A recipient row being approved means a person said "this address may receive
 * reports". It does not mean the deployment is able to reach it safely: with no
 * real transport, "reaching" a customer address amounts to writing it into a file
 * on a server, which is neither a delivery nor something they consented to. So
 * only addresses explicitly marked as this deployment's own test addresses are
 * addressed, and the rest are recorded as withheld with the reason.
 *
 * The reason travels with the result rather than being logged and lost: an owner
 * looking at "sent to 1 of 4" is owed the sentence that explains the other three.
 */
export const partitionRecipients = (recipients) => {
  const deliverable = recipients.filter((r) => r.isTestAddress);
  const withheld = recipients.filter((r) => !r.isTestAddress);
  return {
    deliverable,
    withheld,
    withheldReason: withheld.length
      ? 'No delivery transport is configured in this build, so only addresses marked as test addresses are written to. Real recipients are withheld rather than recorded as sent.'
      : null,
  };
};

/**
 * Write one produced report out.
 *
 * Returns what the delivery row needs to be honest: the transport that ran, the
 * artifact it produced and its size. Throws on failure, so the caller records a
 * FAILED attempt rather than a silent success.
 */
export const deliver = async ({ schedule, runKey, format, body, filename }) => {
  const dir = path.join(spoolDir(), schedule.companyId, schedule.id);
  await mkdir(dir, { recursive: true });
  // Named for the run, not for the attempt: a retry overwrites the artifact of
  // the run it is retrying instead of leaving a directory of near-identical files
  // that somebody has to work out the ordering of.
  const safeRun = runKey.replace(/[^A-Za-z0-9_.-]/g, '_');
  const file = path.join(dir, `${safeRun}-${filename}`);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  await writeFile(file, bytes);
  return { transport: TRANSPORT_FILE, artifactPath: file, bytes: bytes.length, format };
};
