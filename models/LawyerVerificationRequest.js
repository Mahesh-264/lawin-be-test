const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const lawyerVerificationRequestSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, default: 'lawyer' },
    barId: { type: String, required: true, trim: true },
    barEnrollmentNumber: { type: String, required: true, trim: true },
    specialization: { type: String, default: 'General Practice' },
    experienceYears: { type: Number, default: 1 },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' },
    address: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'rejected'],
      default: 'pending',
      index: true,
    },
    rejectionReason: { type: String, default: '' },
    profileImage: { type: String, default: '' },
    certificates: [{ type: String }],
  },
  { timestamps: true }
);

// Hash password before saving if modified
lawyerVerificationRequestSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  if (this.$locals && this.$locals.passwordIsHashed) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password method
lawyerVerificationRequestSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('LawyerVerificationRequest', lawyerVerificationRequestSchema);
