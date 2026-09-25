// Where "do not expose Tally's local service to the public internet" is actually
// enforced (LANE providers).
//
// This file exists because the first version of that guard did not enforce it.
// The settings schema rejected a `http://` prefix and nothing else, so
// `8.8.8.8` and `tally.example.com` both saved cleanly; and the call-time check
// treated any dot-free string as a LAN machine name, which let `134744072`
// through as a "hostname". It is not a hostname. The WHATWG URL parser reads a
// bare integer as an IPv4 address, so that string dials 8.8.8.8 — measured, not
// theorised. `0x8080808` does the same thing in hex.
//
// So there are two gates here, and they answer different questions:
//
//   assertLanHostSyntax  — is what the operator typed capable of naming
//                          something off-LAN? Synchronous, used by the settings
//                          schema so a bad host is refused at the point of
//                          typing rather than surfacing later as a dead job.
//
//   assertLanDestination — does it actually RESOLVE to a private address right
//                          now? Asynchronous, used immediately before the call.
//                          A name is not an address: `tallypc` is a perfectly
//                          good LAN name that a search domain or a poisoned
//                          resolver can point anywhere, and only resolution can
//                          tell. This is the gate that makes "LAN-only" a fact
//                          about the destination rather than about the spelling.
//
// Both refuse by default. Tally's documented request format carries no
// credential of any kind, so anything that can reach port 9000 can write
// vouchers into the client's books — which makes an unverifiable destination a
// reason to not send, never a reason to try.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// RFC1918, loopback, and link-local. 100.64/10 (carrier NAT) is deliberately
// absent: it is shared provider space, not a shop LAN, and a Tally reachable
// across it is reachable by the carrier's other subscribers.
const isPrivateV4 = (ip) => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
};

// ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local, and the v4-mapped
// form (::ffff:10.0.0.1) because a dual-stack resolver answers with it.
const isPrivateV6 = (raw) => {
  const ip = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (ip === '::1') return true;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  const head = ip.split(':')[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true;
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true;
  return false;
};

export const isPrivateAddress = (ip) => {
  const v = isIP(ip.replace(/^\[|\]$/g, ''));
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) return isPrivateV6(ip);
  return false;
};

// Suffixes reserved for local naming. `.internal` is on that list by convention
// and `.home.arpa` by RFC 8375. These pass the SYNTAX gate only — they still
// have to resolve privately before anything is sent to them.
const LOCAL_SUFFIX = ['.local', '.lan', '.internal', '.home.arpa'];

// What the operator typed, turned into what fetch will actually dial. Going
// through the URL parser rather than pattern-matching the raw string is the
// point: it is the same parser fetch uses, so it collapses the decimal, hex and
// userinfo forms into the address they really mean instead of leaving them to be
// matched by a regex that has never heard of them.
export const canonicalHost = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // Anything that could restructure the URL is refused outright rather than
  // normalised. `192.168.1.1@8.8.8.8` parses to a hostname of 8.8.8.8 — the part
  // before the @ is userinfo — and a host field has no business containing a
  // credential, a path or a port separator anyway.
  if (/[^A-Za-z0-9.\-[\]:]/.test(s)) return null;
  if (s.includes('@') || s.includes('/')) return null;
  // A bare IPv6 literal needs brackets to survive the parser.
  const candidate = isIP(s) === 6 ? `[${s}]` : s;
  let url;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    return null;
  }
  // A port or anything else smuggled in means this was not just a host.
  if (url.port || url.pathname !== '/' || url.username || url.password) return null;
  return url.hostname.toLowerCase();
};

// Is this host capable of naming something off-LAN? Answers on spelling alone,
// because that is all a settings form has.
export const classifyLanHost = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'enter the Tally machine name or its LAN IP address' };
  if (/^https?:\/\//i.test(s)) return { ok: false, reason: 'enter a host or IP, not a URL' };

  const host = canonicalHost(s);
  if (!host) {
    return {
      ok: false,
      reason: `"${s}" is not a plain host or IP address. Enter the Tally machine's LAN name or its IP, with no scheme, port, path or credentials.`,
    };
  }

  // An IP literal — including the decimal and hex spellings the parser just
  // unpacked — is decided here and needs no DNS.
  if (isIP(host.replace(/^\[|\]$/g, ''))) {
    return isPrivateAddress(host)
      ? { ok: true, kind: 'ip', host }
      : {
          ok: false,
          kind: 'ip',
          host,
          reason: `${host} is a public address. TallyPrime's XML interface has no authentication, so it must only be reached on the shop's own network (10.x, 172.16–31.x, 192.168.x or 127.x).`,
        };
  }

  if (host === 'localhost' || LOCAL_SUFFIX.some((sfx) => host.endsWith(sfx))) {
    return { ok: true, kind: 'name', host };
  }

  // A dot-free label is a LAN machine name, which is how a Tally PC is usually
  // addressed. Allowed by syntax, but it is exactly the case that cannot be
  // trusted on spelling — assertLanDestination resolves it before any call.
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) return { ok: true, kind: 'name', host };

  return {
    ok: false,
    kind: 'name',
    host,
    reason: `"${host}" is a public-style domain name. Tally must be reached on the shop's own network — use the machine's LAN name or its IP address.`,
  };
};

export const isLanHostSyntax = (raw) => classifyLanHost(raw).ok === true;

export class LanHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LanHostError';
  }
}

export const assertLanHostSyntax = (raw) => {
  const verdict = classifyLanHost(raw);
  if (!verdict.ok) throw new LanHostError(verdict.reason);
  return verdict;
};

// The gate that actually establishes LAN-only. Resolves the name and requires
// EVERY answer to be private: a name that returns one LAN address and one public
// address is refused, because which one gets dialled is not ours to choose.
//
// A resolution failure is also a refusal. That is the uncomfortable direction —
// it means a DNS outage stops Tally posting — but the alternative is sending an
// unauthenticated voucher write to an address we could not verify, and the queue
// already exists to hold work until a person can look at it.
export const assertLanDestination = async (raw, { resolver = lookup } = {}) => {
  const verdict = assertLanHostSyntax(raw);
  if (verdict.kind === 'ip') return { host: verdict.host, addresses: [verdict.host] };

  let answers;
  try {
    answers = await resolver(verdict.host, { all: true });
  } catch (err) {
    throw new LanHostError(
      `"${verdict.host}" could not be resolved on this network (${err?.code || 'lookup failed'}), so it cannot be confirmed to be the shop's own Tally machine. Nothing was sent.`,
    );
  }

  const addresses = (Array.isArray(answers) ? answers : [answers]).map((a) => a.address).filter(Boolean);
  if (addresses.length === 0) {
    throw new LanHostError(`"${verdict.host}" resolved to no address at all. Nothing was sent.`);
  }

  const publics = addresses.filter((a) => !isPrivateAddress(a));
  if (publics.length > 0) {
    throw new LanHostError(
      `"${verdict.host}" resolves to ${publics.join(', ')}, which is outside the shop's network. TallyPrime has no authentication and must never be written to across the public internet. Nothing was sent.`,
    );
  }

  return { host: verdict.host, addresses };
};
