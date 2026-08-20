let rateLimit;

try {
  rateLimit = require('express-rate-limit');
} catch {
  rateLimit = null;
}

const createAuthLimiter = ({ windowMs, max, message }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'TOO_MANY_ATTEMPTS', message },
});

const passthrough = (req, res, next) => next();

module.exports = {
  authLimiter: rateLimit ? createAuthLimiter({
    windowMs: 15 * 60 * 1000,
    max: 80,
    message: 'Too many auth requests. Please try again later.',
  }) : passthrough,
  otpLimiter: rateLimit ? createAuthLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many OTP requests. Please try again later.',
  }) : passthrough,
  loginLimiter: rateLimit ? createAuthLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many login attempts. Please try again later.',
  }) : passthrough,
};
