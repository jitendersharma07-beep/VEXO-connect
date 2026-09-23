export class AppError extends Error {
  constructor(status, code, message, field, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    // Optional machine-readable payload. Only for refusals the caller is
    // meant to act on — a discount over the till operator's limit is a
    // "fetch a manager", not a bug, and the screen needs the numbers to say
    // so. Never carries anything the user is not already allowed to see.
    this.details = details;
  }
}

export const badRequest = (message, field) => new AppError(400, 'POS_BAD_REQUEST', message, field);
export const unauthorized = (message = 'Please sign in to continue') =>
  new AppError(401, 'POS_UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'POS_FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'POS_NOT_FOUND', message);

// 403 with its own code, because the screen has to tell these two apart. The
// first says "this discount is above your limit, here is whose signature
// would clear it" and opens the approval prompt; the second says the approval
// itself was refused and must NOT re-open the prompt in a loop.
export const discountDenied = (message, details) =>
  new AppError(403, 'POS_DISCOUNT_NOT_PERMITTED', message, undefined, details);
export const approvalRefused = (message, details) =>
  new AppError(403, 'POS_DISCOUNT_APPROVAL_REFUSED', message, undefined, details);
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
      ? 'Your VEXO Connect licence has expired. Please contact VEXO to renew.'
      : state === 'SUSPENDED'
        ? 'Your VEXO Connect licence is suspended. Please contact VEXO support.'
        : 'No active VEXO Connect licence found for this account. Please contact VEXO.',
  );

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
