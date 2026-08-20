const bcrypt = require('bcryptjs');

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_WAIT_MS = 30 * 1000;

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const hashOtp = (otp) => bcrypt.hash(otp, 10);

const compareOtp = (otp, hash) => bcrypt.compare(String(otp || ''), hash);

const getOtpExpiry = () => new Date(Date.now() + OTP_TTL_MS);

const getResendAvailableAt = () => new Date(Date.now() + RESEND_WAIT_MS);

module.exports = {
  OTP_TTL_MS,
  RESEND_WAIT_MS,
  compareOtp,
  generateOtp,
  getOtpExpiry,
  getResendAvailableAt,
  hashOtp,
};
