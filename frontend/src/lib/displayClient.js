// VC-101 customer display — pairing storage and the poll client.
//
// Plain fetch, not the shared axios client: that client's 401 interceptor
// redirects to /login, and an unpaired display must land on its own pairing
// screen instead. localStorage survives kiosk reloads but can be unavailable
// (private mode), so every access is guarded and the page still works — the
// pairing then just lives for the tab.

const KEY = 'pos.customerDisplay';
let memory = null; // fallback when localStorage is unavailable

export const loadPairing = () => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : memory;
  } catch {
    return memory;
  }
};

export const savePairing = (pairing) => {
  memory = pairing;
  try {
    localStorage.setItem(KEY, JSON.stringify(pairing));
  } catch {
    // Tab-scoped only; the page still runs.
  }
};

export const clearPairing = () => {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
};

const base = `${import.meta.env.BASE_URL}api/display`;

export const pairWithCode = async (code) => {
  const res = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || 'Pairing failed — ask for a fresh code');
  return body;
};

// One poll. Returns a discriminated result instead of throwing, so the loop
// in the page stays a plain state machine.
export const fetchState = async (token, etag) => {
  let res;
  try {
    res = await fetch(`${base}/state`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 304) return { kind: 'unchanged' };
  if (res.status === 401) return { kind: 'unpaired' };
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      kind: 'ratelimited',
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30000,
    };
  }
  if (!res.ok) return { kind: 'offline' };
  const body = await res.json().catch(() => null);
  if (!body) return { kind: 'offline' };
  return { kind: 'state', body, etag: res.headers.get('etag') };
};

// Contract: 2s while a sale is on screen, 10s while idle — a shop's devices
// share one public IP and one rate-limit budget.
export const pollDelayMs = (view) => (view === 'ACTIVE' || view === 'THANKYOU' ? 2000 : 10000);
