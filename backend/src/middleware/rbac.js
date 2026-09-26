import { unauthorized, forbidden, licenseBlocked } from '../lib/errors.js';
import { licenseUsable } from '../lib/license.js';

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  return next();
};

export const requireAtc = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'POS_SUPER_ADMIN') {
    return next(forbidden('This area is restricted to VEXO Connect administrators'));
  }
  return next();
};

// Selling is a tenant activity, never a platform one. A VEXO operator may
// repair a licence, not ring up a sale.
//
// This has to be stated as its own gate because of how the two authorisation
// layers differ. The till routes used to carry hard-coded role lists that
// simply never named POS_SUPER_ADMIN, so the property held by omission. Moving
// them onto the action model (lib/permissions.js) removes that accident:
// POS_SUPER_ADMIN's baseline is `[...ACTION_KEYS]` — every action there is —
// and `order.create`, `order.bill` and `payment.record` are not in
// SUPPORT_GRANT_REQUIRED, so an action gate on its own would hand a platform
// operator a till that the role list had always refused.
//
// lib/discountPolicy.js already asserts the same rule from the money side
// ("ATC operators are read-only on orders anyway", ROLE_FLOOR.POS_SUPER_ADMIN
// = DENY). This is that invariant made enforceable on the request path rather
// than inferred from a role list's silence.
export const denyPlatformSelling = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'POS_SUPER_ADMIN') {
    return next(
      forbidden('VEXO administrators cannot trade on a customer till. Use a store login.'),
    );
  }
  return next();
};

// Mutations for customer principals require a usable licence. ATC operators
// bypass it — they are the ones who repair licences. Reads stay open so an
// expired customer can still see their data and the renewal notice.
export const requireUsableLicense = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'POS_SUPER_ADMIN') return next();
  if (!req.license) return next(licenseBlocked('MISSING'));
  if (!licenseUsable(req.license)) return next(licenseBlocked(req.license.effectiveStatus));
  return next();
};
