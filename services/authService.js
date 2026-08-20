const jwt = require('jsonwebtoken');
const User = require('../models/User');

const generateTokens = (id, role) => ({
  accessToken: jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '15m' }),
  refreshToken: jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '1y' }),
});

const sanitizeAuthUser = (user) => {
  const value = user?.toObject ? user.toObject() : { ...user };
  delete value.password;
  delete value.refreshToken;
  delete value.otp;
  delete value.otpExpires;
  delete value.resetOtpHash;
  delete value.resetOtpExpiresAt;
  delete value.resetResendAvailableAt;
  delete value.resetAttemptCount;
  return value;
};

const issueSession = async (user) => {
  const tokens = generateTokens(user._id, user.role);
  user.refreshToken = tokens.refreshToken;
  await user.save();

  return {
    ...tokens,
    user: sanitizeAuthUser(user),
  };
};

const assertNoDuplicateAccount = async ({ email, phone, googleId }) => {
  const checks = [
    email ? { email } : null,
    phone ? { phone } : null,
    googleId ? { googleId } : null,
  ].filter(Boolean);

  if (!checks.length) return;

  const existing = await User.findOne({ $or: checks });
  if (!existing) return;

  const error = new Error(
    existing.email === email
      ? 'Email already registered'
      : existing.phone === phone
        ? 'Phone already registered'
        : 'Google account already registered'
  );
  error.statusCode = 400;
  throw error;
};

const LawyerVerificationRequest = require('../models/LawyerVerificationRequest');

const createUserFromPending = async (pending) => {
  const isLawyer = pending.role === 'lawyer';

  if (isLawyer) {
    const existingActiveUser = await User.findOne({ email: pending.email.toLowerCase() });
    if (existingActiveUser) {
      const error = new Error('Email already registered');
      error.statusCode = 400;
      throw error;
    }

    const barEnrollment = pending.lawyerProfile?.barId || pending.lawyerProfile?.barEnrollmentNumber || 'PENDING';
    const specialization = pending.lawyerProfile?.specialization || 'General Practice';
    const experienceYears = pending.lawyerProfile?.experienceYears || 1;

    let verificationRequest = await LawyerVerificationRequest.findOne({ email: pending.email.toLowerCase() });

    if (verificationRequest) {
      verificationRequest.firstName = pending.firstName;
      verificationRequest.lastName = pending.lastName;
      verificationRequest.phone = pending.phone;
      verificationRequest.password = pending.password;
      verificationRequest.barId = barEnrollment;
      verificationRequest.barEnrollmentNumber = barEnrollment;
      verificationRequest.specialization = specialization;
      verificationRequest.experienceYears = experienceYears;
      verificationRequest.city = pending.address?.city || '';
      verificationRequest.state = pending.address?.state || '';
      verificationRequest.pincode = pending.address?.pincode || '';
      verificationRequest.address = pending.address?.fullAddress || pending.address?.street || '';
      verificationRequest.status = 'pending';
      verificationRequest.rejectionReason = '';

      if (pending.password) {
        verificationRequest.$locals = verificationRequest.$locals || {};
        verificationRequest.$locals.passwordIsHashed = true;
      }

      await verificationRequest.save();
    } else {
      verificationRequest = new LawyerVerificationRequest({
        firstName: pending.firstName,
        lastName: pending.lastName,
        email: pending.email,
        phone: pending.phone,
        password: pending.password,
        role: 'lawyer',
        barId: barEnrollment,
        barEnrollmentNumber: barEnrollment,
        specialization,
        experienceYears,
        city: pending.address?.city || '',
        state: pending.address?.state || '',
        pincode: pending.address?.pincode || '',
        address: pending.address?.fullAddress || pending.address?.street || '',
        status: 'pending',
      });

      if (pending.password) {
        verificationRequest.$locals = verificationRequest.$locals || {};
        verificationRequest.$locals.passwordIsHashed = true;
      }

      await verificationRequest.save();
    }

    return {
      _id: verificationRequest._id,
      id: verificationRequest._id,
      firstName: verificationRequest.firstName,
      lastName: verificationRequest.lastName,
      email: verificationRequest.email,
      phone: verificationRequest.phone,
      role: 'lawyer',
      accountStatus: 'pending_approval',
      verified: true,
      emailVerified: true,
      phoneVerified: true,
      lawyerProfile: {
        barId: verificationRequest.barId,
        barEnrollmentNumber: verificationRequest.barEnrollmentNumber,
        specialization: verificationRequest.specialization,
        experienceYears: verificationRequest.experienceYears,
        isVerified: false,
      },
    };
  }

  await assertNoDuplicateAccount({
    email: pending.email,
    phone: pending.phone,
    googleId: pending.googleId,
  });

  const user = new User({
    firstName: pending.firstName,
    lastName: pending.lastName,
    email: pending.email,
    phone: pending.phone,
    password: pending.password,
    role: pending.role,
    authProvider: pending.authProvider === 'google' && pending.password ? 'both' : pending.authProvider || 'email',
    googleId: pending.googleId,
    verified: true,
    emailVerified: true,
    phoneVerified: true,
    accountStatus: 'active',
    profilePicture: pending.profilePicture,
    profileImage: pending.profilePicture,
    address: pending.address,
    location: pending.location,
    lawyerProfile: pending.lawyerProfile,
    studentProfile: pending.studentProfile,
  });

  if (pending.password) {
    user.$locals.passwordIsHashed = true;
  }
  await user.save();
  return user;
};

const createGoogleCompletionToken = (googleProfile) => jwt.sign(
  { type: 'google-profile-completion', googleProfile },
  process.env.JWT_SECRET,
  { expiresIn: '10m' }
);

const verifyGoogleCompletionToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type !== 'google-profile-completion' || !decoded.googleProfile) {
    const error = new Error('Invalid Google profile session');
    error.statusCode = 401;
    throw error;
  }
  return decoded.googleProfile;
};

module.exports = {
  createGoogleCompletionToken,
  createUserFromPending,
  generateTokens,
  issueSession,
  sanitizeAuthUser,
  verifyGoogleCompletionToken,
};
