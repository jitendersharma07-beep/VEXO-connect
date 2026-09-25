// Store Agent credential — the lane's MINIMAL agent identity, flagged for
// INTEGRATION(foundation): when the foundation lane's Terminal/Device
// enrolment lands, PrintAgent keys onto a Device row and this file shrinks
// to a lookup. Until then: one-time enrol code → per-agent secret, both
// stored only as sha256, secret shown to the agent exactly once.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../prisma.js';
import { asyncHandler, unauthorized } from '../errors.js';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export const newEnrolCode = () => `pae_${randomBytes(16).toString('hex')}`;
export const newAgentSecret = () => `pas_${randomBytes(24).toString('hex')}`;

const hashesEqual = (a, b) => {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// Authorization: Bearer <agentId>.<secret>
export const requirePrintAgent = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const dot = token.indexOf('.');
  if (dot <= 0) throw unauthorized('Agent credential required');
  const agentId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const agent = await prisma.printAgent.findUnique({ where: { id: agentId } });
  if (!agent || agent.status !== 'ACTIVE' || !agent.credentialHash) {
    throw unauthorized('Agent credential rejected');
  }
  if (!hashesEqual(sha256(secret), agent.credentialHash)) {
    throw unauthorized('Agent credential rejected');
  }
  req.printAgent = agent;
  next();
});
