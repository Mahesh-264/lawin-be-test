const mongoose = require('mongoose');

const pendingRegistrationSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, index: true },
  phone: { type: String, required: true, index: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'lawyer', 'student'], required: true },
  authProvider: { type: String, enum: ['email', 'google'], default: 'email' },
  googleId: { type: String, index: true },
  profilePicture: { type: String, default: '' },
  phoneVerified: { type: Boolean, default: false },
  otpHash: { type: String, required: true, select: false },
  otpExpiresAt: { type: Date, required: true },
  resendAvailableAt: { type: Date, required: true },
  attemptCount: { type: Number, default: 0 },
  address: {
    latitude: Number,
    longitude: Number,
    pincode: String,
    state: String,
    district: String,
    city: String,
    country: { type: String, default: 'India' },
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      default: undefined,
    },
  },
  lawyerProfile: {
    barId: String,
    specialization: String,
    experienceYears: Number,
    about: String,
    languages: [String],
    consultationFee: Number,
  },
  studentProfile: {
    collegeName: String,
    collegeEmail: String,
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 15 * 60 * 1000),
    index: { expires: 0 },
  },
}, { timestamps: true });

pendingRegistrationSchema.index({ email: 1, role: 1 });
pendingRegistrationSchema.index({ phone: 1, role: 1 });

module.exports = mongoose.model('PendingRegistration', pendingRegistrationSchema);
