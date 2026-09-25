// Turning a table row into a printable card: the token, the URL that goes in the
// symbol, and the three lines of text that let someone holding the card work out
// which table it belongs to without scanning it.

import { randomBytes, randomInt } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';
import { encodeQr } from './encode.js';

// 24 bytes is 192 bits of entropy in 32 URL-safe characters. Longer tokens push
// the symbol to a higher version, and a denser symbol is a worse thing to ask a
// phone camera to read off a laminated card in restaurant lighting.
const TOKEN_BYTES = 24;

export const newQrToken = () => randomBytes(TOKEN_BYTES).toString('base64url');

// Four digits, spoken across a table. Not a secret to be brute-forced offline:
// it is checked server-side against one visit, attempts are counted and capped
// for the life of that visit, and the only thing it unlocks is a shared basket
// at the table the guest is already sitting at.
export const newJoinCode = () => String(randomInt(0, 10000)).padStart(4, '0');

export const qrNotConfigured = () =>
  new AppError(
    501,
    'POS_QR_BASE_URL_NOT_SET',
    'QR ordering is not configured on this deployment. Set POS_QR_BASE_URL to the ' +
      'address guests reach on their phones, then issue the codes.',
  );

/** The configured customer-facing origin, without a trailing slash. */
export const qrBaseUrl = () => {
  if (!env.POS_QR_BASE_URL) throw qrNotConfigured();
  return env.POS_QR_BASE_URL.replace(/\/+$/, '');
};

/**
 * The URL printed inside the symbol. Built only from configuration and the
 * token — never from the request, so a caller cannot get a card minted that
 * points at a host of their choosing.
 */
export const qrUrlFor = (token) => `${qrBaseUrl()}/t/${token}`;

/** "Ground floor · Indoor · Window row" — whatever of it is known. */
export const placeLineOf = ({ floor, area }) =>
  [floor?.name, area?.name].filter(Boolean).join(' · ');

/**
 * A card descriptor for pdf.js. `printedPlace` is what the card will claim, and
 * the caller stores it on the row so a table later moved to another floor can be
 * reported as needing a reprint rather than silently misdescribing itself.
 */
export const buildCard = ({ branch, table, floor, area, token, rotation }) => {
  const url = qrUrlFor(token);
  const printedPlace = placeLineOf({ floor, area });
  return {
    storeName: branch.name,
    placeLine: printedPlace || branch.city || '',
    tableLabel: table.name,
    // The URL in full, so a guest whose camera will not focus can still type it,
    // and so a card found loose can be traced back. The rotation number tells two
    // cards for the same table apart by eye.
    footerLine: `${url}   ·   v${rotation}`,
    matrix: encodeQr(url),
    url,
    printedPlace,
  };
};
