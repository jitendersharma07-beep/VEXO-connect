import { createRequire } from 'node:module';
import { env } from '../config/env.js';

// `createRequire` rather than a JSON import: import attributes (`with { type:
// 'json' }`) are not accepted across every Node 20 minor, and this sits on the
// boot path — a syntax error here costs the whole service, not one endpoint.
//
// package.json is read from the image rather than passed as a build arg because
// it is already there: the Dockerfile COPYs it for `npm ci`. One fewer thing the
// deploy can forget to export.
const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

// Resolved once at import. The values cannot change while the process lives —
// they describe the image it was started from.
export const buildInfo = Object.freeze({
  service: 'atc-pos-api',
  version,
  gitSha: env.GIT_SHA,
  builtAt: env.BUILD_TIME,
});
