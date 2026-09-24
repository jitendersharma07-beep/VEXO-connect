import { prisma } from '../lib/prisma.js';
import { unauthorized, forbidden, asyncHandler } from '../lib/errors.js';
import { hashSecret } from '../lib/crypto.js';
import { clientIp } from '../lib/audit.js';

// Device identity and attribution.
//
// A till presenting an activated device token gets its writes stamped with
// WHERE (terminal) and WHAT (device). A plain browser till sends no token and
// keeps working exactly as before — it just attributes less, which is the state
// every existing installation is in and is not an error.
//
// Mount AFTER resolveCompanyScope: the tenant has to be known before a token
// can be judged against it.

export const DEVICE_TOKEN_HEADER = 'x-pos-device-token';

// One message for unknown, revoked and foreign tokens alike. Revocation clears
// the stored hash, so from outside the three cases are indistinguishable and a
// leaked token cannot be used to learn whether it was revoked or never existed.
const refused = () =>
  unauthorized('This device is not recognised or has been revoked. Ask the owner to activate it.');

// Disabling a till is an owner saying "this counter is out of service". A
// device bound to it has to stop too, otherwise the till keeps taking money
// under a credential minted before it was closed. Said plainly rather than
// hidden behind the message above: unlike a revoked token, the holder here is
// legitimate and the state is one their own owner set, so naming it is what
// lets them act on it.
const tillDisabled = () =>
  forbidden('The till this device is registered to has been disabled. Ask the owner to re-point or re-enrol it.');

// lastSeenAt drives the "last seen" column on the devices screen. Refreshing it
// on literally every request would put a write in front of every menu tap, so
// it moves at most once a minute — a device screen that is 60s stale is still
// answering the only question it is asked ("is this thing alive today").
const LAST_SEEN_REFRESH_MS = 60_000;

export const deviceContext = asyncHandler(async (req, _res, next) => {
  const token = req.headers[DEVICE_TOKEN_HEADER];
  if (!token) return next();

  const device = await prisma.device.findUnique({
    where: { tokenHash: hashSecret(String(token)) },
    select: {
      id: true,
      publicId: true,
      companyId: true,
      branchId: true,
      terminalId: true,
      status: true,
      lastSeenAt: true,
      // Read on the same trip rather than trusted from enrolment time. The
      // till's status is checked when a device is pointed at it, but that
      // answers "was it open then"; a credential outlives that moment and the
      // only honest place to ask "is it open NOW" is the request itself.
      terminal: { select: { status: true } },
    },
  });
  // status is checked as well as the hash: revoke clears the hash, but a future
  // path that only sets the status must not leave a working credential behind.
  if (!device || device.status !== 'ACTIVE') throw refused();
  if (req.companyScope && device.companyId !== req.companyScope.id) throw refused();
  // A device with no till of its own is a store-level device and has no till to
  // be closed; only a bound one can be stranded by this.
  if (device.terminal && device.terminal.status !== 'ACTIVE') throw tillDisabled();

  const stale = !device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS;
  if (stale) {
    await prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date(), lastSeenIp: clientIp(req) },
    });
  }

  req.device = device;
  next();
});

// The store half of the scope check, which the tenant check above cannot do:
// the branch is only known once the route has resolved it. A device enrolled at
// Connaught Place presenting its token against a Gurgaon order is refused here
// even though both stores belong to the same tenant.
export const assertDeviceStore = (req, branchId) => {
  if (!req.device || !branchId) return;
  if (req.device.branchId !== branchId) {
    throw forbidden('This device is registered to a different store');
  }
};

// The counter half. Only meaningful when the caller names a terminal; a device
// with no terminal of its own is a store-level device and may use any till in
// its own store.
export const assertDeviceTerminal = (req, terminalId) => {
  if (!req.device || !terminalId || !req.device.terminalId) return;
  if (req.device.terminalId !== terminalId) {
    throw forbidden('This device is registered to a different till');
  }
};

// What order/payment writes spread into their data. Null-safe: no device, no
// claims. A device bound to a terminal stamps both; a store-level device stamps
// only itself, and never guesses a till.
export const deviceStamp = (req) => ({
  terminalId: req.device?.terminalId ?? null,
  deviceId: req.device?.id ?? null,
});
