const mongoose = require('mongoose');

const verificationOtpSchema = new mongoose.Schema({
  channel: { type: String, enum: ['email', 'phone'], required: true },
  target: { type: String, required: true, lowercase: true, index: true },
  role: { type: String, enum: ['user', 'lawyer', 'student'], required: true },
  otpHash: { type: String, select: false },
  otpExpiresAt: Date,
  resendAvailableAt: Date,
  attemptCount: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  verifiedAt: Date,
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 15 * 60 * 1000),
    index: { expires: 0 },
  },
}, { timestamps: true });

verificationOtpSchema.index({ channel: 1, target: 1, role: 1 }, { unique: true });

module.exports = mongoose.model('VerificationOtp', verificationOtpSchema);
