export class AppError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export const badRequest = (message, field) => new AppError(400, 'POS_BAD_REQUEST', message, field);
export const unauthorized = (message = 'Please sign in to continue') =>
  new AppError(401, 'POS_UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'POS_FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'POS_NOT_FOUND', message);
export const conflict = (message) => new AppError(409, 'POS_CONFLICT', message);

// 501, not 403: the caller did nothing wrong and no permission would help.
// Online payment simply is not configured on this deployment.
export const gatewayNotConfigured = () =>
  new AppError(
    501,
    'POS_GATEWAY_NOT_CONFIGURED',
    'Online payment is not enabled on this deployment. Record the payment manually.',
  );

// 502, not 500: nothing here is broken. The provider is a separate system that
// did not answer, and the cashier's next move is to take the money another way
// rather than to report a bug.
export const badGateway = (message) => new AppError(502, 'POS_GATEWAY_UNAVAILABLE', message);

export const licenseBlocked = (state) =>
  new AppError(
    403,
    `POS_LICENSE_${state}`,
    state === 'EXPIRED'
      ? 'Your ATC POS licence has expired. Please contact ATC to renew.'
      : state === 'SUSPENDED'
        ? 'Your ATC POS licence is suspended. Please contact ATC support.'
        : 'No active ATC POS licence found for this account. Please contact ATC.',
  );

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
