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
