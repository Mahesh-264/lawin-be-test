const AUTH_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_PHONE: 'INVALID_PHONE',
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  PHONE_ALREADY_EXISTS: 'PHONE_ALREADY_EXISTS',
  ROLE_MISMATCH: 'ROLE_MISMATCH',
  WRONG_PASSWORD: 'WRONG_PASSWORD',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  PHONE_NOT_VERIFIED: 'PHONE_NOT_VERIFIED',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_USED: 'OTP_USED',
  ACCOUNT_PENDING_APPROVAL: 'ACCOUNT_PENDING_APPROVAL',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
});

class AuthError extends Error {
  constructor(code, message, { status = 400, field } = {}) {
    super(message);
    this.code = code;
    this.statusCode = status;
    this.field = field;
  }
}

const authError = (code, message, options) => new AuthError(code, message, options);

const sendAuthError = (res, error) => {
  const expectedError = error instanceof AuthError || (error?.statusCode >= 400 && error.statusCode < 500);
  const status = expectedError ? error.statusCode : 500;
  const code = error instanceof AuthError
    ? error.code
    : expectedError
      ? (error.code || AUTH_CODES.VALIDATION_ERROR)
      : AUTH_CODES.INTERNAL_SERVER_ERROR;
  const message = expectedError ? error.message : 'An unexpected error occurred. Please try again.';
  const body = { success: false, code, message };
  if (error.field) body.field = error.field;
  if (error?.retryAfter) body.retryAfter = error.retryAfter;
  return res.status(status).json(body);
};

const sendAuthSuccess = (res, status, body) => res.status(status).json({ success: true, ...body });

module.exports = { AUTH_CODES, AuthError, authError, sendAuthError, sendAuthSuccess };
