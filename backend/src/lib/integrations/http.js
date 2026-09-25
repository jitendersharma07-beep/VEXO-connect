// Outbound HTTP for provider integrations (LANE providers).
//
// Same discipline as lib/gateway/razorpay.js, for the same reason: what we do
// after a failed call depends entirely on whether the provider DECIDED anything.
//
//   TERMINAL — the provider answered and said no. Retrying sends the same
//              rejection again. Stop, and show the operator why.
//   RETRYABLE — the provider answered that it is unavailable (429, 503).
//              Retrying is the correct response.
//   UNKNOWN  — timeout, reset, unparseable body. The provider may have acted.
//              This is the dangerous one: for a loyalty redemption or a Tally
//              voucher, UNKNOWN means a customer's points may already be spent
//              or a voucher may already be in the books. Retry only where the
//              receiving end is keyed against a repeat.
//
// Collapsing UNKNOWN into "failed" is how duplicate vouchers and double-spent
// points happen, so it is a distinct class here and never inferred from a status
// code that does not exist.

import { env } from '../../config/env.js';

export class ProviderCallError extends Error {
  constructor(message, { kind = 'UNKNOWN', status = null, body = null, code = null } = {}) {
    super(message);
    this.name = 'ProviderCallError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    // Kept for the operator-facing error queue, truncated at the boundary —
    // provider error pages are sometimes megabytes of HTML.
    this.body = typeof body === 'string' ? body.slice(0, 1000) : body;
    this.retryable = kind === 'RETRYABLE' || kind === 'UNKNOWN';
    // The one question every caller actually asks: did they answer? An UNKNOWN
    // carries no status, so this is false for it, which is correct — we do not
    // know that they refused.
    this.providerRefused = kind === 'TERMINAL';
  }
}

const classifyStatus = (status) => {
  if (status === 429) return 'RETRYABLE';
  // 5xx from a provider is them being broken, not us being wrong.
  if (status >= 500) return 'RETRYABLE';
  // 408 is the provider telling us it timed out reading our request; whether it
  // processed what it did read is exactly the UNKNOWN case.
  if (status === 408) return 'UNKNOWN';
  return 'TERMINAL';
};

// `parse` is 'json' | 'text' | 'xml'. Tally speaks XML and answers with XML, so
// this cannot assume JSON the way the gateway adapter can.
export const providerFetch = async (url, { method = 'POST', headers = {}, body = null, parse = 'json', timeoutMs } = {}) => {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs ?? env.POS_INTEGRATION_TIMEOUT_MS),
    });
  } catch (err) {
    // No status, so no decision was observed. Deliberately UNKNOWN and never
    // RETRYABLE-by-default: the caller decides whether its receiving end is
    // safe to retry, because only the caller knows if it is keyed.
    //
    // `cause` is read as well as `code`, and it is the one that usually carries
    // it: Node's fetch does not surface a socket error directly, it throws
    // `TypeError: fetch failed` and hangs the real errno off `cause`. Reading
    // only `code` returned null for every connection failure — and the
    // difference between ECONNREFUSED and a timeout is the difference between
    // "we never reached them" and "they may have acted on it", which is the
    // whole question a caller inspects this for.
    throw new ProviderCallError(`provider did not answer: ${err?.name || 'network error'}`, {
      kind: 'UNKNOWN',
      code: err?.code ?? err?.cause?.code ?? null,
    });
  }

  const raw = await response.text().catch(() => '');

  if (!response.ok) {
    throw new ProviderCallError(
      `provider answered ${response.status}`,
      { kind: classifyStatus(response.status), status: response.status, body: raw },
    );
  }

  if (parse === 'text' || parse === 'xml') return { status: response.status, raw };

  try {
    return { status: response.status, raw, json: raw ? JSON.parse(raw) : null };
  } catch {
    // A 200 with a body we cannot read means the provider did something and we
    // cannot tell what. That is UNKNOWN, not a parse bug to swallow.
    throw new ProviderCallError('provider answered with a body that is not JSON', {
      kind: 'UNKNOWN',
      status: response.status,
      body: raw,
    });
  }
};

// Joining a configured base to a documented path. Written out rather than using
// `new URL(path, base)` because that silently drops a base path segment when the
// path starts with '/' — which every path in providers.js does, and which would
// quietly send requests to the wrong host prefix.
export const joinUrl = (base, path) =>
  `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
