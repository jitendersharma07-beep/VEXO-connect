// The phone side of table QR ordering (TQ-5) — transport only.
//
// Plain fetch, not the shared axios client, for two reasons and both matter.
// That client sends `withCredentials`, which would attach a cashier's session
// cookie to a public endpoint if a member of staff ever scanned a card on the
// same browser; and its 401 interceptor hard-redirects to /login, whereas a 401
// here is the ordinary "you have not joined this table yet" answer that the page
// is built to render.
//
// The guest token is the only credential and it never goes in a cookie — the
// backend reads it from X-Guest-Token precisely so that no CSRF defence is
// needed on a public origin. It is stored per printed token, so a phone that
// scans table 4 after table 2 does not carry table 2's session to it.

const base = `${import.meta.env.BASE_URL}api/guest/qr`;

const KEY = (token) => `pos.guestQr.${token}`;
const memory = new Map();

export const loadGuestToken = (token) => {
  try {
    return sessionStorage.getItem(KEY(token)) ?? memory.get(token) ?? null;
  } catch {
    return memory.get(token) ?? null;
  }
};

export const saveGuestToken = (token, guestToken) => {
  memory.set(token, guestToken);
  try {
    sessionStorage.setItem(KEY(token), guestToken);
  } catch {
    // Private mode. The session then lives for as long as the page does, which
    // is the length of one meal in practice.
  }
};

export const clearGuestToken = (token) => {
  memory.delete(token);
  try {
    sessionStorage.removeItem(KEY(token));
  } catch {
    // Nothing stored.
  }
};

// Every call returns a discriminated result instead of throwing, so the page
// stays a state machine and a dead mobile connection is a state rather than an
// unhandled rejection.
const call = async (path, { method = 'GET', guestToken, body } = {}) => {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(guestToken ? { 'X-Guest-Token': guestToken } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { kind: 'offline' };
  }
  const payload = await res.json().catch(() => null);
  if (res.ok) return { kind: 'ok', status: res.status, body: payload };
  return {
    kind: 'error',
    status: res.status,
    code: payload?.error?.code ?? null,
    message: payload?.error?.message ?? 'Something went wrong. Please ask a member of staff.',
  };
};

export const scanCard = (token) => call(`/t/${encodeURIComponent(token)}`);

export const startOrJoin = (token, joinCode) =>
  call(`/t/${encodeURIComponent(token)}/session`, {
    method: 'POST',
    body: joinCode ? { joinCode } : {},
  });

export const fetchOrder = (token, guestToken) =>
  call(`/t/${encodeURIComponent(token)}/order`, { guestToken });

export const submitBasket = (token, guestToken, payload) =>
  call(`/t/${encodeURIComponent(token)}/order`, { method: 'POST', guestToken, body: payload });

// A key the server can recognise a retry by. Generated once per basket and kept
// until that basket is accepted for sending, so the double-tap that mobile
// Safari produces on a slow connection is answered with the first result
// instead of ordering twice.
export const newIdempotencyKey = () => {
  const rand =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `qr-${rand}`;
};

// What a chosen line costs on screen, for the basket only. The bill is whatever
// the server says it is — this number never reaches a request, and the page
// shows the server's totals the moment an order exists.
export const lineEstimate = (choice) => {
  const base = choice.variant ? choice.variant.price : choice.product.price;
  const mods = choice.options.reduce((a, o) => a + (o.price ?? 0), 0);
  return (base + mods) * choice.qty;
};
