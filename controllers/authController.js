const User = require('../models/User');
const Team = require('../models/Team');
const Post = require('../models/Post');
const Otp = require('../models/Otp');
const PendingRegistration = require('../models/PendingRegistration');
const VerificationOtp = require('../models/VerificationOtp');
const LawyerVerificationRequest = require('../models/LawyerVerificationRequest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
const {
  normalizeAddressPayload,
  parseBooleanFlag,
  parseLimit,
  parseRadiusKm,
  parseSearchCoordinates,
  parseSpecializationTerms,
  trimString,
} = require('../utils/location');
const {
  mapLawyerDiscoveryCard,
  searchNearbyLawyers,
} = require('../services/lawyerDiscoveryService');
const {
  hasManualLocationInput,
  lookupPincodeDetails,
  resolveLawyerAddress,
  reverseGeocodeCoordinates,
} = require('../services/locationResolutionService');
const {
  createNotification,
  getDisplayName: getNotificationDisplayName,
} = require('../services/notificationService');
const { sendOtpEmail } = require('../services/emailService');
const { verifyGoogleIdToken } = require('../services/googleAuthService');
const {
  createGoogleCompletionToken,
  createUserFromPending,
  issueSession,
  verifyGoogleCompletionToken,
} = require('../services/authService');
const {
  compareOtp,
  generateOtp,
  getOtpExpiry,
  getResendAvailableAt,
  hashOtp,
} = require('../utils/otp');
const {
  validateEmailRegistration,
  validateGoogleProfile,
  validatePasswordReset,
} = require('../validators/authValidators');
const { AUTH_CODES, authError, sendAuthError, sendAuthSuccess } = require('../utils/authResponse');

const sanitizeUser = '-password -refreshToken -otp';
const allowedRoles = ['user', 'lawyer', 'student', 'admin'];

const normalizeRole = (role) => String(role || '').trim().toLowerCase();
const normalizeEmail = (value) => trimString(value).toLowerCase();
const normalizePhone = (value) => trimString(value);
const isEmailAddress = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isMobileNumber = (value) => /^\+?[0-9]{10,15}$/.test(String(value || '').replace(/[\s-]/g, ''));

const createLawyerVerificationToken = (verificationRequest) => jwt.sign(
  {
    type: 'lawyer-verification-status',
    requestId: String(verificationRequest._id),
    email: verificationRequest.email,
  },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);

const sendLawyerVerificationCreated = (res, verificationRequest) => {
  const user = {
    _id: verificationRequest._id,
    id: verificationRequest._id,
    firstName: verificationRequest.firstName,
    lastName: verificationRequest.lastName,
    email: verificationRequest.email,
    role: 'lawyer',
    accountStatus: 'pending_approval',
    lawyerProfile: {
      barId: verificationRequest.barId,
      barEnrollmentNumber: verificationRequest.barEnrollmentNumber,
      isVerified: false,
    },
  };

  return sendAuthSuccess(res, 201, {
    code: 'LAWYER_VERIFICATION_PENDING',
    message: 'Lawyer registration submitted for verification.',
    user,
    verificationToken: createLawyerVerificationToken(verificationRequest),
  });
};

const normalizeVerificationTarget = (channel, value) => (
  channel === 'email' ? normalizeEmail(value) : normalizePhone(value).replace(/[\s-]/g, '')
);

const findVerifiedContact = ({ channel, target, role }) => VerificationOtp.findOne({
  channel,
  target,
  role,
  verified: true,
  expiresAt: { $gt: new Date() },
});

const sendSmsOtp = async ({ to, otp }) => {
  // Provider hook: integrate Twilio, MSG91, etc. here.
  console.log(`SMS OTP for ${to}: ${otp}`);
};

const setRefreshCookie = (res, refreshToken) => {
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
};

const getOptionalViewerId = (req) => {
  const token = req.headers.authorization?.startsWith('Bearer')
    ? req.headers.authorization.split(' ')[1]
    : null;

  if (!token) return null;

  try {
    return jwt.verify(token, process.env.JWT_SECRET).id;
  } catch {
    return null;
  }
};

const getDisplayName = (user) => {
  if (!user) return 'Lawyer';
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name || 'Lawyer';
};

const getLocationLabel = (user) => (
  user?.address?.city ||
  user?.address?.district ||
  user?.address?.state ||
  'India'
);

const normalizeLanguageList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => trimString(item)).filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const buildDistanceLabel = (distanceKm) => (
  Number.isFinite(distanceKm) ? `${distanceKm.toFixed(1)} km away` : null
);

const getRelativeTime = (dateValue) => {
  if (!dateValue) return 'Recently posted';

  const timestamp = new Date(dateValue).getTime();
  if (Number.isNaN(timestamp)) return 'Recently posted';

  const difference = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (difference < hour) {
    const minutes = Math.max(1, Math.floor(difference / minute));
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (difference < day) {
    const hours = Math.max(1, Math.floor(difference / hour));
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.max(1, Math.floor(difference / day));
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const getStudentApplicationIds = (student) => new Set(
  (student?.studentProfile?.internshipApplications || []).map((item) => String(item.postId))
);

const getJoinedJamSessionIds = (student) => new Set(
  (student?.studentProfile?.joinedJamSessions || []).map((item) => String(item.sessionId))
);

const formatInteractionComment = (comment) => ({
  id: comment._id,
  userId: comment.userId,
  name: comment.name || 'User',
  role: comment.role || 'user',
  text: comment.text || '',
  createdAt: comment.createdAt,
  postedAt: getRelativeTime(comment.createdAt),
});

const formatPublishedInternship = (lawyer, internship, options = {}) => ({
  id: internship._id,
  type: 'internship',
  lawyerId: lawyer._id,
  lawyerName: getDisplayName(lawyer),
  profileImage: lawyer.profileImage || '',
  avatar: getDisplayName(lawyer).charAt(0).toUpperCase(),
  title: internship.title || 'Internship',
  firm: internship.firm || lawyer.address?.city || lawyer.address?.district || 'Lawin',
  specialization: internship.specialization || [],
  description: internship.description || '',
  duration: internship.duration || 'Not specified',
  location: internship.location || getLocationLabel(lawyer),
  stipend: internship.stipend || 'Not specified',
  skills: internship.skills || [],
  status: internship.status || 'open',
  createdAt: internship.createdAt,
  postedAt: getRelativeTime(internship.createdAt),
  applicationCount: Array.isArray(internship.applications) ? internship.applications.length : 0,
  likesCount: Array.isArray(internship.likedBy) ? internship.likedBy.length : 0,
  liked: (internship.likedBy || []).some((id) => String(id) === String(options.viewerId)),
  commentsCount: Array.isArray(internship.comments) ? internship.comments.length : 0,
  comments: (internship.comments || []).map(formatInteractionComment),
  city: lawyer.address?.city || lawyer.address?.district || '',
  state: lawyer.address?.state || '',
  distanceKm: Number.isFinite(options.distanceKm) ? options.distanceKm : null,
  distanceLabel: buildDistanceLabel(options.distanceKm),
});

const formatPublishedJamSession = (lawyer, session, options = {}) => ({
  id: session._id,
  type: 'jam',
  lawyerId: lawyer._id,
  lawyerName: getDisplayName(lawyer),
  author: getDisplayName(lawyer),
  profileImage: lawyer.profileImage || '',
  avatar: getDisplayName(lawyer).charAt(0).toUpperCase(),
  title: session.title || 'Jam Session',
  topic: session.topic || 'General Discussion',
  summary: session.summary || '',
  schedule: session.schedule || '',
  location: session.location || getLocationLabel(lawyer),
  createdAt: session.createdAt,
  time: getRelativeTime(session.createdAt),
  meta: lawyer.lawyerProfile?.specialization || 'Lawyer',
  participantCount: Array.isArray(session.participants) ? session.participants.length : 0,
  participants: Array.isArray(session.participants)
    ? `${session.participants.length} joined`
    : 'Open for students',
  likesCount: Array.isArray(session.likedBy) ? session.likedBy.length : 0,
  liked: (session.likedBy || []).some((id) => String(id) === String(options.viewerId)),
  commentsCount: Array.isArray(session.comments) ? session.comments.length : 0,
  comments: (session.comments || []).map(formatInteractionComment),
  commentsLabel: `${Array.isArray(session.comments) ? session.comments.length : 0} comments`,
  city: lawyer.address?.city || lawyer.address?.district || '',
  state: lawyer.address?.state || '',
  distanceKm: Number.isFinite(options.distanceKm) ? options.distanceKm : null,
  distanceLabel: buildDistanceLabel(options.distanceKm),
});

const getLawyerInteractionStats = (lawyer) => {
  const internships = lawyer?.lawyerProfile?.internships || [];
  const jamSessions = lawyer?.lawyerProfile?.jamSessions || [];

  return {
    totalInternshipsPosted: internships.length,
    activeInternships: internships.filter((internship) => (internship.status || 'open') === 'open').length,
    totalApplicants: internships.reduce((count, internship) => count + (internship.applications?.length || 0), 0),
    totalJamSessions: jamSessions.length,
    totalParticipants: jamSessions.reduce((count, session) => count + (session.participants?.length || 0), 0),
  };
};

const formatLawyerCard = (lawyer) => ({
  id: lawyer._id,
  name: getDisplayName(lawyer),
  profileImage: lawyer.profileImage || '',
  avatar: getDisplayName(lawyer).charAt(0).toUpperCase(),
  specialization: lawyer.lawyerProfile?.specialization || 'General Practice',
  location: getLocationLabel(lawyer),
  city: lawyer.address?.city || lawyer.address?.district || '',
  state: lawyer.address?.state || '',
  verified: Boolean(lawyer.lawyerProfile?.isVerified),
  isOnline: Boolean(lawyer.lawyerProfile?.isOnline),
  rating: lawyer.lawyerProfile?.rating || 4.8,
});

const notifyLawyerFollowers = async ({ lawyer, type, title, message, link, metadata, io }) => {
  const followerIds = [
    ...new Set((lawyer.followers || []).map((id) => String(id)).filter((id) => id && id !== String(lawyer._id))),
  ];

  if (!followerIds.length) return;

  await Promise.all(followerIds.map((recipient) => createNotification({
    recipient,
    actor: lawyer._id,
    type,
    title,
    message,
    link,
    metadata,
    io,
  })));
};

const generateTeamCode = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    const existingTeam = await Team.exists({ teamCode: code });
    const existingLegacyTeam = await User.exists({ 'lawyerProfile.team.teamCode': code });
    if (!existingTeam && !existingLegacyTeam) return code;
  }


  const error = new Error('Unable to generate a team code. Please try again.');
  error.statusCode = 500;
  throw error;
};

const getLawyerName = (lawyer) => (
  `${lawyer.firstName || ''} ${lawyer.lastName || ''}`.trim() || lawyer.name || 'Lawyer'
);

const getTeamResponseUser = (lawyer) => User.findById(lawyer._id).select(sanitizeUser);

const formatTeamCase = (teamCase) => {
  const caseName = teamCase.caseName || teamCase.caseTitle || '';
  const briefInfo = teamCase.briefInfo || teamCase.caseDetails || teamCase.basicInfo || '';
  const startingDate = teamCase.startingDate || teamCase.hearingDate || null;
  const nextHearingDate = teamCase.nextHearingDate || null;
  const hearingHistory = Array.isArray(teamCase.hearingHistory)
    ? teamCase.hearingHistory.map((item) => ({
        id: item._id ? String(item._id) : item.id,
        courtName: item.courtName || '',
        hearingDate: item.hearingDate || null,
        hearingDetails: item.hearingDetails || '',
        nextHearing: item.nextHearing || null,
      }))
    : [];

  return {
    id: teamCase._id ? String(teamCase._id) : teamCase.id,
    clientName: teamCase.clientName || '',
    clientPhone: teamCase.clientPhone || '',
    clientAddress: teamCase.clientAddress || '',
    caseName,
    caseTitle: caseName,
    briefInfo,
    caseDetails: briefInfo,
    courtName: teamCase.courtName || '',
    startingDate,
    nextHearingDate,
    hearingDate: startingDate,
    hearingHistory,
    status: teamCase.status || 'new',
    addedBy: teamCase.addedBy?._id ? String(teamCase.addedBy._id) : (teamCase.addedBy ? String(teamCase.addedBy) : null),
    addedByName: teamCase.addedByName || 'Lawyer',
    createdAt: teamCase.createdAt,
    updatedAt: teamCase.updatedAt,
  };
};

const formatTeamRequest = (request) => ({
  id: request._id,
  lawyerId: request.lawyerId,
  name: request.name || 'Lawyer',
  email: request.email || '',
  phone: request.phone || '',
  requestedAt: request.requestedAt,
});

const formatTeamMember = (member) => ({
  id: member._id,
  lawyerId: member.lawyerId,
  name: member.name || 'Lawyer',
  email: member.email || '',
  phone: member.phone || '',
  joinedAt: member.joinedAt,
});

const formatTeamWorkspace = (team, viewerId) => {
  const members = Array.isArray(team?.members) ? team.members : [];
  const cases = Array.isArray(team?.cases) ? team.cases : [];
  const pendingRequests = Array.isArray(team?.pendingRequests) ? team.pendingRequests : [];
  const isOwner = String(team?.owner) === String(viewerId);
  const visibleCases = isOwner
    ? cases
    : cases.filter((teamCase) => String(teamCase.addedBy?._id || teamCase.addedBy || '') === String(viewerId));

  return {
    id: team._id,
    role: isOwner ? 'owner' : 'member',
    teamCode: team.teamCode || '',
    firmName: team.firmName || '',
    seniorLawyerName: team.seniorLawyerName || 'Senior Lawyer',
    maxTeamSize: team.maxTeamSize || members.length + 1,
    seniorLawyer: team.owner,
    members: members.map(formatTeamMember),
    pendingRequests: isOwner ? pendingRequests
      .slice()
      .sort((first, second) => new Date(second.requestedAt || 0) - new Date(first.requestedAt || 0))
      .map(formatTeamRequest) : [],
    cases: visibleCases
      .slice()
      .sort((first, second) => new Date(second.createdAt || 0) - new Date(first.createdAt || 0))
      .map(formatTeamCase),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
};

const migrateLegacyTeamIfNeeded = async (legacyOwner) => {
  const legacyTeam = legacyOwner?.lawyerProfile?.team;
  if (!legacyOwner || legacyOwner.role !== 'lawyer' || legacyTeam?.role !== 'owner' || !legacyTeam.teamCode) {
    return null;
  }

  const existingTeam = await Team.findOne({ teamCode: legacyTeam.teamCode });
  if (existingTeam) return existingTeam;

  return Team.create({
    teamCode: legacyTeam.teamCode,
    firmName: legacyTeam.firmName || 'Lawyer Team',
    seniorLawyerName: legacyTeam.seniorLawyerName || getLawyerName(legacyOwner),
    maxTeamSize: Number(legacyTeam.maxTeamSize) || 2,
    owner: legacyOwner._id,
    members: Array.isArray(legacyTeam.members) ? legacyTeam.members : [],
    pendingRequests: Array.isArray(legacyTeam.pendingRequests) ? legacyTeam.pendingRequests : [],
    cases: Array.isArray(legacyTeam.cases) ? legacyTeam.cases : [],
    createdAt: legacyTeam.createdAt || new Date(),
  });
};

const findTeamByCode = async (teamCode) => {
  const team = await Team.findOne({ teamCode });
  if (team) return team;

  const legacyOwner = await User.findOne({
    role: 'lawyer',
    'lawyerProfile.team.role': 'owner',
    'lawyerProfile.team.teamCode': teamCode,
  });

  return migrateLegacyTeamIfNeeded(legacyOwner);
};

const getLawyerTeamDocuments = async (lawyerId) => {
  const lawyer = await User.findById(lawyerId);
  if (lawyer?.lawyerProfile?.team?.role === 'owner') {
    await migrateLegacyTeamIfNeeded(lawyer);
  } else if (lawyer?.lawyerProfile?.team?.teamCode) {
    const legacyOwner = await User.findOne({
      role: 'lawyer',
      'lawyerProfile.team.role': 'owner',
      'lawyerProfile.team.teamCode': lawyer.lawyerProfile.team.teamCode,
    });
    await migrateLegacyTeamIfNeeded(legacyOwner);
  }

  return Team.find({
    $or: [
      { owner: lawyerId },
      { 'members.lawyerId': lawyerId },
    ],
  }).sort({ updatedAt: -1, createdAt: -1 });
};

const getTeamForOwnerAction = async (lawyerId, teamId) => {
  const query = { owner: lawyerId };
  if (teamId) query._id = teamId;
  const team = await Team.findOne(query);
  if (!team) {
    const error = new Error('Only the senior lawyer who created this team can perform this action');
    error.statusCode = 403;
    throw error;
  }
  return team;
};

const getOwnedTeamForRequest = async (lawyerId, requestId, teamId) => {
  if (teamId) {
    try {
      const selectedTeam = await getTeamForOwnerAction(lawyerId, teamId);
      const hasRequest = selectedTeam.pendingRequests.some((request) => String(request._id) === String(requestId));
      if (hasRequest) return selectedTeam;
    } catch (error) {
      if (error.statusCode !== 403 && error.statusCode !== 404) {
        throw error;
      }
    }
  }

  const team = await Team.findOne({
    owner: lawyerId,
    'pendingRequests._id': requestId,
  });

  if (!team) {
    const error = new Error('Join request not found');
    error.statusCode = 404;
    throw error;
  }

  return team;
};

const getTeamForMemberAction = async (lawyerId, teamId) => {
  const query = teamId
    ? { _id: teamId }
    : { $or: [{ owner: lawyerId }, { 'members.lawyerId': lawyerId }] };
  const team = await Team.findOne(query);
  if (!team) {
    const error = new Error('Team not found');
    error.statusCode = 404;
    throw error;
  }

  const isOwner = String(team.owner) === String(lawyerId);
  const isMember = team.members.some((member) => String(member.lawyerId) === String(lawyerId));
  if (!isOwner && !isMember) {
    const error = new Error('You are not part of this team');
    error.statusCode = 403;
    throw error;
  }

  return team;
};

const parseTeamDocuments = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((document) => {
        if (typeof document === 'string') {
          const url = trimString(document);
          return url ? { name: url, url } : null;
        }

        const name = trimString(document?.name);
        const url = trimString(document?.url);
        return (name || url) ? { name: name || url, url } : null;
      })
      .filter(Boolean);
  }

  return String(value || '')
    .split('\n')
    .map((line) => trimString(line))
    .filter(Boolean)
    .map((line) => ({ name: line, url: line }));
};

const uploadResumeToCloudinary = (file) => (
  new Promise((resolve, reject) => {
    if (!file) {
      resolve(null);
      return;
    }

   const stream = cloudinary.uploader.upload_stream(
  {
    folder: 'lawin_resumes',
    resource_type: 'raw',
    use_filename: true,
    unique_filename: true,
  },
  (error, result) => {
    if (error) return reject(error);

    resolve({
      url: result.secure_url,
      publicId: result.public_id,
      fileName: file.originalname,
    });
  }
);
    streamifier.createReadStream(file.buffer).pipe(stream);
  })
);

const uploadProfileFileToCloudinary = (file, folder, resourceType = 'auto') => (
  new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, use_filename: true, unique_filename: true },
      (error, result) => error
        ? reject(error)
        : resolve({ url: result.secure_url, fileName: file.originalname })
    );
    streamifier.createReadStream(file.buffer).pipe(stream);
  })
);

const parseMultipartJson = (value, fallback = {}) => {
  if (!value || typeof value !== 'string') return value || fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const checkRegistrationContact = async ({ channel, value, role }) => {
  const selectedRole = normalizeRole(role) || 'user';
  if (!['user', 'lawyer', 'student'].includes(selectedRole)) {
    const error = new Error('Invalid role selected');
    error.statusCode = 400;
    throw error;
  }

  const target = normalizeVerificationTarget(channel, value);
  if (!target) {
    const error = new Error(channel === 'email' ? 'Email is required' : 'Mobile number is required');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = channel;
    throw error;
  }

  if (channel === 'email' && !isEmailAddress(target)) {
    const error = new Error('Invalid email');
    error.statusCode = 400;
    error.code = 'INVALID_EMAIL';
    error.field = 'email';
    throw error;
  }

  if (channel === 'phone' && !isMobileNumber(target)) {
    const error = new Error('Invalid mobile number');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = 'phone';
    throw error;
  }

  const duplicate = await User.findOne(channel === 'email' ? { email: target } : { phone: target });
  if (duplicate) {
    const error = new Error(channel === 'email' ? 'Email already registered' : 'Mobile number already registered');
    error.statusCode = 409;
    error.code = channel === 'email' ? 'EMAIL_ALREADY_EXISTS' : 'PHONE_ALREADY_EXISTS';
    error.field = channel;
    throw error;
  }

  return { role: selectedRole, target };
};

const sendRegistrationVerification = async ({ channel, value, role, firstName }) => {
  const checked = await checkRegistrationContact({ channel, value, role });
  const existing = await VerificationOtp.findOne({
    channel,
    target: checked.target,
    role: checked.role,
  }).select('+otpHash');

  if (existing?.resendAvailableAt > new Date()) {
    const error = new Error('Too many OTP requests. Please wait before requesting another code.');
    error.statusCode = 429;
    error.code = 'TOO_MANY_ATTEMPTS';
    error.retryAfter = Math.ceil((existing.resendAvailableAt.getTime() - Date.now()) / 1000);
    throw error;
  }

  const otp = generateOtp();
  const verificationData = {
    channel,
    target: checked.target,
    role: checked.role,
    otpHash: await hashOtp(otp),
    otpExpiresAt: getOtpExpiry(),
    resendAvailableAt: getResendAvailableAt(),
    attemptCount: 0,
    verified: false,
    verifiedAt: undefined,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  };

  if (existing) {
    existing.set(verificationData);
    await existing.save();
  } else {
    await VerificationOtp.create(verificationData);
  }

  if (channel === 'email') {
    await sendOtpEmail({
      to: checked.target,
      otp,
      firstName,
      purpose: 'verify your email address',
    });
  } else {
    await sendSmsOtp({ to: checked.target, otp });
  }

  return checked;
};

const verifyRegistrationContactOtp = async ({ channel, value, role, otp }) => {
  const selectedRole = normalizeRole(role) || 'user';
  const target = normalizeVerificationTarget(channel, value);
  const verification = await VerificationOtp.findOne({
    channel,
    target,
    role: selectedRole,
  }).select('+otpHash');

  if (!verification) {
    const error = new Error('OTP expired');
    error.statusCode = 422;
    error.code = 'OTP_EXPIRED';
    error.field = 'otp';
    throw error;
  }

  if (verification.attemptCount >= 5) {
    const error = new Error('Too many OTP requests');
    error.statusCode = 429;
    error.code = 'TOO_MANY_ATTEMPTS';
    error.field = 'otp';
    throw error;
  }

  if (!verification.otpHash || verification.otpExpiresAt <= new Date()) {
    const error = new Error('OTP expired');
    error.statusCode = 422;
    error.code = verification.verified ? 'OTP_USED' : 'OTP_EXPIRED';
    error.field = 'otp';
    throw error;
  }

  if (!(await compareOtp(otp, verification.otpHash))) {
    verification.attemptCount += 1;
    await verification.save();
    const error = new Error('Incorrect OTP');
    error.statusCode = 422;
    error.code = 'OTP_INVALID';
    error.field = 'otp';
    throw error;
  }

  verification.verified = true;
  verification.verifiedAt = new Date();
  verification.otpHash = undefined;
  verification.otpExpiresAt = undefined;
  verification.attemptCount = 0;
  verification.expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await verification.save();
  return verification;
};

exports.checkEmailAvailability = async (req, res) => {
  try {
    const { target } = await checkRegistrationContact({
      channel: 'email',
      value: req.body.email,
      role: req.body.role,
    });
    res.json({ available: true, email: target, message: 'Email is available' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.sendEmailVerification = async (req, res) => {
  try {
    const { target } = await sendRegistrationVerification({
      channel: 'email',
      value: req.body.email,
      role: req.body.role,
      firstName: req.body.firstName,
    });
    res.json({ message: 'OTP sent to your email', email: target, resendAfter: 30 });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.message,
      retryAfter: error.retryAfter,
    });
  }
};

exports.verifyEmailVerification = async (req, res) => {
  try {
    await verifyRegistrationContactOtp({
      channel: 'email',
      value: req.body.email,
      role: req.body.role,
      otp: req.body.otp,
    });
    res.json({ message: 'Verification successful', verified: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.checkPhoneAvailability = async (req, res) => {
  try {
    const { target } = await checkRegistrationContact({
      channel: 'phone',
      value: req.body.phone,
      role: req.body.role,
    });
    res.json({ available: true, phone: target, message: 'Mobile number is available' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.sendPhoneVerification = async (req, res) => {
  try {
    const { target } = await sendRegistrationVerification({
      channel: 'phone',
      value: req.body.phone,
      role: req.body.role,
    });
    res.json({ message: 'OTP sent to your mobile number', phone: target, resendAfter: 30 });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.message,
      retryAfter: error.retryAfter,
    });
  }
};

exports.verifyPhoneVerification = async (req, res) => {
  try {
    await verifyRegistrationContactOtp({
      channel: 'phone',
      value: req.body.phone,
      role: req.body.role,
      otp: req.body.otp,
    });
    res.json({ message: 'Verification successful', verified: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const buildStudentFeed = (lawyers, student, distanceLookup = new Map()) => {
  const appliedIds = getStudentApplicationIds(student);
  const joinedIds = getJoinedJamSessionIds(student);

  return lawyers.flatMap((lawyer) => {
    const distanceKm = distanceLookup.get(String(lawyer._id));
    const internships = (lawyer.lawyerProfile?.internships || []).map((internship) => ({
      ...formatPublishedInternship(lawyer, internship, { distanceKm, viewerId: student?._id }),
      applied: appliedIds.has(String(internship._id)),
    }));

    const jamSessions = (lawyer.lawyerProfile?.jamSessions || []).map((session) => ({
      ...formatPublishedJamSession(lawyer, session, { distanceKm, viewerId: student?._id }),
      joined: joinedIds.has(String(session._id)),
    }));

    return [...internships, ...jamSessions];
  }).sort((first, second) => {
    const firstDistance = Number.isFinite(first.distanceKm) ? first.distanceKm : Number.MAX_SAFE_INTEGER;
    const secondDistance = Number.isFinite(second.distanceKm) ? second.distanceKm : Number.MAX_SAFE_INTEGER;

    if (firstDistance !== secondDistance) {
      return firstDistance - secondDistance;
    }

    return new Date(second.createdAt || 0) - new Date(first.createdAt || 0);
  });
};

// 1. REGISTER
exports.register = async (req, res) => {
  try {
    const role = validateEmailRegistration(req.body);
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);

    const duplicate = await User.findOne({ $or: [{ email }, { phone }] });
    if (duplicate) throw authError(
      duplicate.email === email ? AUTH_CODES.EMAIL_ALREADY_EXISTS : AUTH_CODES.PHONE_ALREADY_EXISTS,
      duplicate.email === email ? 'An account already uses this email address.' : 'An account already uses this phone number.',
      { status: 409, field: duplicate.email === email ? 'email' : 'phone' }
    );

    const [emailVerification, phoneVerification] = await Promise.all([
      findVerifiedContact({ channel: 'email', target: email, role }),
      findVerifiedContact({ channel: 'phone', target: phone, role }),
    ]);

    if (!emailVerification) {
      throw authError(AUTH_CODES.EMAIL_NOT_VERIFIED, 'Please verify your email address before creating an account.', { status: 403, field: 'email' });
    }

    if (!phoneVerification) {
      throw authError(AUTH_CODES.PHONE_NOT_VERIFIED, 'Please verify your phone number before creating an account.', { status: 403, field: 'phone' });
    }

    const userData = {
      firstName: trimString(req.body.firstName),
      lastName: trimString(req.body.lastName),
      email,
      phone,
      password: await bcrypt.hash(req.body.password, 12),
      role,
      authProvider: 'email',
    };

    if (role === 'lawyer') {
      const resolvedLocation = await resolveLawyerAddress(req.body.address || {}, {
        requireCoordinates: hasManualLocationInput(req.body.address || {}),
      });
      userData.address = resolvedLocation.address;
      userData.location = resolvedLocation.location;
      userData.lawyerProfile = {
        barId: trimString(req.body.barId),
        specialization: trimString(req.body.specialization),
        experienceYears: Number(req.body.experienceYears) || 0,
        about: trimString(req.body.about),
        languages: normalizeLanguageList(req.body.languages),
        consultationFee: Number(req.body.consultationFee) || 500,
      };
    } else if (role === 'student') {
      userData.studentProfile = {
        collegeName: trimString(req.body.collegeName),
        collegeEmail: trimString(req.body.collegeEmail),
        specializations: [],
        skills: [],
        internships: [],
      };
    }

    const user = await createUserFromPending(userData);
    await VerificationOtp.deleteMany({ $or: [{ target: email }, { target: phone }] });
    await PendingRegistration.deleteMany({ $or: [{ email }, { phone }] });

    // Lawyer applications are intentionally not logged into the product. Their
    // verification request remains the source of truth until an admin approves it.
    if (role === 'lawyer') return sendLawyerVerificationCreated(res, user);

    const session = await issueSession(user);
    setRefreshCookie(res, session.refreshToken);

    sendAuthSuccess(res, 201, { code: 'ACCOUNT_CREATED', message: 'Account created successfully.', ...session });
  } catch (error) {
    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'email';
      return sendAuthError(res, authError(
        field === 'phone' ? AUTH_CODES.PHONE_ALREADY_EXISTS : AUTH_CODES.EMAIL_ALREADY_EXISTS,
        field === 'phone' ? 'An account already uses this phone number.' : 'An account already uses this email address.',
        { status: 409, field }
      ));
    }
    sendAuthError(res, error);
  }
};

// Returns the current status from the same records used by the admin approval
// workflow. The status token is issued only when the lawyer submits registration.
exports.getLawyerVerificationStatus = async (req, res) => {
  try {
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '';
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.type !== 'lawyer-verification-status' || !payload.email) {
      return res.status(401).json({ message: 'Invalid verification status session.' });
    }

    const email = normalizeEmail(payload.email);
    const verificationRequest = await LawyerVerificationRequest.findOne({ email }).lean();
    if (verificationRequest) {
      return res.json({
        status: verificationRequest.status,
        rejectionReason: verificationRequest.rejectionReason || '',
        firstName: verificationRequest.firstName,
        lastName: verificationRequest.lastName,
        email: verificationRequest.email,
        barEnrollmentNumber: verificationRequest.barEnrollmentNumber || verificationRequest.barId || '',
      });
    }

    // Approval migrates the application into User and removes the request. This
    // is deliberately the existing admin workflow, not a parallel status field.
    const approvedLawyer = await User.findOne({
      email,
      role: 'lawyer',
      accountStatus: 'active',
      'lawyerProfile.isVerified': true,
    }).lean();
    if (approvedLawyer) {
      return res.json({
        status: 'approved',
        firstName: approvedLawyer.firstName,
        lastName: approvedLawyer.lastName,
        email: approvedLawyer.email,
        barEnrollmentNumber: approvedLawyer.lawyerProfile?.barEnrollmentNumber || approvedLawyer.lawyerProfile?.barId || '',
      });
    }

    return res.status(404).json({ message: 'Verification request could not be found. Please contact support.' });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Verification status session has expired. Please contact support.' });
    }
    return res.status(500).json({ message: 'Unable to check verification status. Please try again.' });
  }
};

// 1A. LOOK UP PINCODE DETAILS FOR LAWYER REGISTRATION
exports.lookupPincode = async (req, res) => {
  try {
    const address = await lookupPincodeDetails(req.params.pincode);
    res.json({ address });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 1B. GEOCODE CITY/DISTRICT/STATE INTO COORDINATES
exports.geocodeRegistrationAddress = async (req, res) => {
  try {
    const resolvedAddress = await resolveLawyerAddress(req.body?.address || req.body || {}, {
      requireCoordinates: false,
    });

    if (!resolvedAddress.location) {
      return res.status(422).json({
        message: 'Unable to generate coordinates from the provided location details.',
        address: resolvedAddress.address,
        resolution: resolvedAddress.resolution,
      });
    }

    res.json(resolvedAddress);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 1C. REVERSE GEOCODE CURRENT COORDINATES INTO ADDRESS FIELDS
exports.reverseGeocodeRegistrationAddress = async (req, res) => {
  try {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    const resolvedAddress = await reverseGeocodeCoordinates({ latitude, longitude });
    res.json(resolvedAddress);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 2. LOGIN
exports.login = async (req, res) => {
  try {
    const { email: rawEmail, password, role: rawRole } = req.body;
    if (typeof rawRole !== 'string' || !rawRole.trim()) throw authError(AUTH_CODES.VALIDATION_ERROR, 'Please select a role.', { field: 'role' });
    if (typeof rawEmail !== 'string' || !rawEmail.trim()) throw authError(AUTH_CODES.VALIDATION_ERROR, 'Email is required.', { field: 'email' });
    if (typeof password !== 'string' || !password.trim()) throw authError(AUTH_CODES.VALIDATION_ERROR, 'Password is required.', { field: 'password' });

    const requestedRole = normalizeRole(rawRole);
    const email = normalizeEmail(rawEmail);
    if (!allowedRoles.includes(requestedRole)) throw authError(AUTH_CODES.VALIDATION_ERROR, 'Please select a valid role.', { field: 'role' });
    if (!isEmailAddress(email)) throw authError(AUTH_CODES.INVALID_EMAIL, 'Enter a valid email address.', { field: 'email' });

    let authenticatedUser = await User.findOne({ email }).select('+password');

    if (!authenticatedUser) {
      const verificationRequest = await LawyerVerificationRequest.findOne({ email: email.toLowerCase() });
      if (verificationRequest) {
        if (requestedRole && requestedRole !== 'lawyer') {
          throw authError(AUTH_CODES.ROLE_MISMATCH, 'This email has a pending lawyer verification request.', { status: 403, field: 'role' });
        }
        if (!(await verificationRequest.matchPassword(password))) {
          throw authError(AUTH_CODES.WRONG_PASSWORD, 'Incorrect password.', { status: 401, field: 'password' });
        }

        if (verificationRequest.status === 'rejected') {
          throw authError(AUTH_CODES.ACCOUNT_PENDING_APPROVAL, 'Your lawyer registration has been rejected.', { status: 403 });
        }
        throw authError(AUTH_CODES.ACCOUNT_PENDING_APPROVAL, 'Your lawyer account is awaiting verification.', { status: 403 });
      } else {
        throw authError(AUTH_CODES.ACCOUNT_NOT_FOUND, 'Invalid email or password.', { status: 404, field: 'email' });
      }
    } else {
      if (authenticatedUser.role !== requestedRole) {
        const roleLabel = authenticatedUser.role === 'user' ? 'Client' : `${authenticatedUser.role.charAt(0).toUpperCase()}${authenticatedUser.role.slice(1)}`;
        throw authError(AUTH_CODES.ROLE_MISMATCH, `This email is registered as a ${roleLabel}.`, { status: 403, field: 'role' });
      }
      const accountStatus = authenticatedUser.accountStatus || 'active';
      if (accountStatus === 'blocked') throw authError(AUTH_CODES.ACCOUNT_BLOCKED, 'This account has been blocked.', { status: 403 });
      if (accountStatus === 'suspended') throw authError(AUTH_CODES.ACCOUNT_SUSPENDED, 'This account has been suspended.', { status: 403 });
      if (accountStatus === 'deleted') throw authError(AUTH_CODES.ACCOUNT_NOT_FOUND, 'Invalid email or password.', { status: 404, field: 'email' });

      if (authenticatedUser.role === 'lawyer' && accountStatus === 'pending_approval') {
        throw authError(AUTH_CODES.ACCOUNT_PENDING_APPROVAL, 'Your lawyer account is awaiting verification.', { status: 403 });
      }
      if (authenticatedUser.role === 'lawyer' && accountStatus === 'rejected') {
        throw authError(AUTH_CODES.ACCOUNT_PENDING_APPROVAL, 'Your lawyer registration has been rejected.', { status: 403 });
      }
      if (authenticatedUser.role !== 'lawyer' && accountStatus === 'pending_approval') {
        throw authError(AUTH_CODES.ACCOUNT_PENDING_APPROVAL, 'Your account is pending administrator approval.', { status: 403 });
      }

      if (authenticatedUser.emailVerified === false || authenticatedUser.verified === false) throw authError(AUTH_CODES.EMAIL_NOT_VERIFIED, 'Please verify your email address before logging in.', { status: 403, field: 'email' });
      if (authenticatedUser.phoneVerified === false) throw authError(AUTH_CODES.PHONE_NOT_VERIFIED, 'Please verify your phone number before logging in.', { status: 403, field: 'phone' });
      if (!authenticatedUser.password || !(await authenticatedUser.matchPassword(password))) throw authError(AUTH_CODES.WRONG_PASSWORD, 'Incorrect password.', { status: 401, field: 'password' });
    }

    const session = await issueSession(authenticatedUser);
    setRefreshCookie(res, session.refreshToken);
    return sendAuthSuccess(res, 200, { code: AUTH_CODES.LOGIN_SUCCESS, message: 'Login successful.', ...session });

    {
    const normalizedEmail = normalizeEmail(req.body.email);
    const normalizedPhone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    const email = normalizedEmail;
    const phone = normalizedPhone;
    const requestedRole = normalizeRole(req.body.role);

    if (requestedRole && !allowedRoles.includes(requestedRole)) {
      return res.status(400).json({ message: 'Invalid role selected' });
    }

    if (!normalizedEmail && !normalizedPhone) {
      return res.status(400).json({ message: 'Email or phone is required' });
    }

    if (!password.trim()) {
      return res.status(400).json({ message: 'Password is required' });
    }

    let user;
    if (normalizedEmail) {
      console.log("🚀 Login request:", email);
      user = await User.findOne({ email: normalizedEmail }).select('+password');
    } else if (normalizedPhone) {
      console.log("🚀 Login request:", phone);
      user = await User.findOne({ phone: normalizedPhone }).select('+password');
    }
    
    if (!user) {
      return res.status(404).json({
        message: 'No account found with these details. Please register first.',
        code: 'ACCOUNT_NOT_FOUND',
      });
    }

    if (!user.password) {
      return res.status(400).json({
        message: 'This account is not set up for password login yet.',
        code: 'PASSWORD_NOT_SET',
      });
    }

    if (!(await user.matchPassword(password))) {
      return res.status(401).json({
        message: 'Incorrect password. Please try again.',
        code: 'INVALID_PASSWORD',
      });
    }

    if (requestedRole && user.role !== requestedRole) {
      return res.status(403).json({
        message: `This account is registered as ${user.role}. Please use the ${user.role} login.`,
        code: 'ROLE_MISMATCH',
      });
    }

    const session = await issueSession(user);
    setRefreshCookie(res, session.refreshToken);
    console.log("✅ Login Successful.");
    res.json(session);
    }
  } catch (error) { sendAuthError(res, error); }
};

// 3. SEND OTP
exports.sendOTP = async (req, res) => {
  try {
    const { phone, isRegister } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`📡 OTP for ${phone}: ${otp}`);

    if (isRegister) {
       await Otp.findOneAndUpdate(
         { phone },
         { otp, createdAt: new Date() },
         { upsert: true, new: true, setDefaultsOnInsert: true }
       );
    } else {
      const user = await User.findOneAndUpdate(
        { phone },
        { otp, otpExpires: Date.now() + 600000 },
        { new: true }
      );
      if (!user) return res.status(404).json({ message: "User not found" });
    }
    res.json({ message: "OTP sent" });
  } catch (error) { res.status(500).json({ message: error.message }); }
};

exports.verifyPhoneOTP = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const registrationOtp = await Otp.findOne({ phone, otp });

    if (registrationOtp) {
      await registrationOtp.deleteOne();
      return res.json({ message: 'Mobile number verified', verified: true });
    }

    const requestedRole = normalizeRole(req.body.role);

    if (requestedRole && !allowedRoles.includes(requestedRole)) {
      return res.status(400).json({ message: 'Invalid role selected' });
    }

    const user = await User.findOne({ phone, otp, otpExpires: { $gt: Date.now() } });
    if (!user) return res.status(400).json({ message: "Invalid/Expired OTP" });

    if (requestedRole && user.role !== requestedRole) {
      return res.status(403).json({
        message: `This account is registered as ${user.role}. Please use the ${user.role} login.`,
      });
    }

    user.otp = undefined; user.otpExpires = undefined;
    const session = await issueSession(user);
    setRefreshCookie(res, session.refreshToken);
    res.json(session);
  } catch (error) { sendAuthError(res, error); }
};

// 4. VERIFY REGISTRATION OTP
exports.verifyOTP = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return exports.verifyPhoneOTP(req, res);

    const role = normalizeRole(req.body.role);
    const pending = await PendingRegistration.findOne({
      email,
      ...(role ? { role } : {}),
    }).select('+password +otpHash');

    if (!pending) {
      return res.status(404).json({ message: 'Pending registration not found or expired' });
    }

    if (pending.attemptCount >= 5) {
      return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
    }

    if (pending.otpExpiresAt <= new Date()) {
      return res.status(400).json({ message: 'Verification code expired. Request a new code.' });
    }

    const isValid = await compareOtp(req.body.otp, pending.otpHash);
    if (!isValid) {
      pending.attemptCount += 1;
      await pending.save();
      return res.status(400).json({ message: 'Invalid verification code' });
    }

    const user = await createUserFromPending(pending);
    await PendingRegistration.deleteMany({
      $or: [{ email: pending.email }, { phone: pending.phone }],
    });

    const session = await issueSession(user);
    setRefreshCookie(res, session.refreshToken);
    res.status(201).json(session);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.resendOTP = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const pending = await PendingRegistration.findOne({ email }).select('+otpHash');

    if (!pending) {
      return res.status(404).json({ message: 'Pending registration not found or expired' });
    }

    if (pending.resendAvailableAt > new Date()) {
      return res.status(429).json({
        message: 'Please wait before requesting another verification code',
        retryAfter: Math.ceil((pending.resendAvailableAt.getTime() - Date.now()) / 1000),
      });
    }

    const otp = generateOtp();
    pending.otpHash = await hashOtp(otp);
    pending.otpExpiresAt = getOtpExpiry();
    pending.resendAvailableAt = getResendAvailableAt();
    pending.attemptCount = 0;
    pending.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pending.save();

    await sendOtpEmail({
      to: pending.email,
      otp,
      firstName: pending.firstName,
      purpose: 'complete your registration',
    });

    res.json({ message: 'A new verification code was sent', resendAfter: 60 });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.googleAuth = async (req, res) => {
  try {
    let googleProfile;

    if (req.body.completionToken) {
      googleProfile = verifyGoogleCompletionToken(req.body.completionToken);
    } else {
      googleProfile = await verifyGoogleIdToken(req.body.credential);

      if (!googleProfile.emailVerified) {
        return res.status(400).json({ message: 'Google account email must be verified' });
      }

      const existingUser = await User.findOne({
        $or: [{ googleId: googleProfile.googleId }, { email: googleProfile.email }],
      }).select('+password');

      if (existingUser) {
        const requestedRole = normalizeRole(req.body.role);
        if (requestedRole && existingUser.role !== requestedRole) {
          return res.status(403).json({
            message: `This account is registered as ${existingUser.role}. Please use the ${existingUser.role} login.`,
            code: 'ROLE_MISMATCH',
          });
        }

        existingUser.googleId = googleProfile.googleId;
        existingUser.verified = true;
        existingUser.profilePicture = existingUser.profilePicture || googleProfile.profilePicture;
        existingUser.profileImage = existingUser.profileImage || googleProfile.profilePicture;
        existingUser.authProvider = existingUser.password ? 'both' : 'google';

        const session = await issueSession(existingUser);
        setRefreshCookie(res, session.refreshToken);
        return res.json(session);
      }

      return res.status(202).json({
        requiresProfile: true,
        completionToken: createGoogleCompletionToken(googleProfile),
        googleProfile: {
          email: googleProfile.email,
          firstName: googleProfile.firstName,
          lastName: googleProfile.lastName,
          profilePicture: googleProfile.profilePicture,
        },
      });
    }

    const role = validateGoogleProfile(req.body);
    const payload = {
      ...req.body,
      role,
      phone: normalizePhone(req.body.phone),
    };

    const phone = normalizePhone(req.body.phone);
    const duplicate = await User.findOne({
      $or: [
        { email: googleProfile.email },
        { phone },
        { googleId: googleProfile.googleId },
      ],
    });

    if (duplicate) {
      return res.status(400).json({
        message: duplicate.email === googleProfile.email
          ? 'Email already registered'
          : duplicate.phone === phone
            ? 'Phone already registered'
            : 'Google account already registered',
      });
    }

    let resolvedLocation;
    if (role === 'lawyer') {
      resolvedLocation = await resolveLawyerAddress(req.body.address || {}, {
        requireCoordinates: hasManualLocationInput(req.body.address || {}),
      });
    }

    const phoneVerification = await findVerifiedContact({ channel: 'phone', target: phone, role });
    if (!phoneVerification) {
      return res.status(400).json({ message: 'Mobile number must be verified before creating an account' });
    }

    const userData = {
      firstName: trimString(req.body.firstName || googleProfile.firstName),
      lastName: trimString(req.body.lastName || googleProfile.lastName),
      email: googleProfile.email,
      phone,
      password: await bcrypt.hash(req.body.password, 12),
      role,
      authProvider: 'google',
      googleId: googleProfile.googleId,
      profilePicture: googleProfile.profilePicture,
    };

    if (role === 'lawyer') {
      userData.address = resolvedLocation.address;
      userData.location = resolvedLocation.location;
      userData.lawyerProfile = {
        barId: trimString(req.body.barId),
        specialization: trimString(req.body.specialization),
        experienceYears: Number(req.body.experienceYears) || 0,
        about: trimString(req.body.about),
        languages: normalizeLanguageList(req.body.languages),
        consultationFee: Number(req.body.consultationFee) || 500,
      };
    } else if (role === 'student') {
      userData.studentProfile = {
        collegeName: trimString(req.body.collegeName),
        collegeEmail: trimString(req.body.collegeEmail),
        specializations: [],
        skills: [],
        internships: [],
      };
    }

    const user = await createUserFromPending(userData);
    await VerificationOtp.deleteMany({ $or: [{ target: googleProfile.email }, { target: phone }] });
    await PendingRegistration.deleteMany({
      $or: [
        { email: googleProfile.email },
        { phone },
        { googleId: googleProfile.googleId },
      ],
    });
    if (role === 'lawyer') return sendLawyerVerificationCreated(res, user);

    const session = await issueSession(user);
    setRefreshCookie(res, session.refreshToken);

    res.status(201).json(session);
  } catch (error) {
    const statusCode = ['JsonWebTokenError', 'TokenExpiredError'].includes(error.name)
      ? 401
      : error.statusCode || 500;
    res.status(statusCode).json({ message: error.message });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const user = await User.findOne({ email })
      .select('+resetOtpHash +resetOtpExpiresAt +resetResendAvailableAt +resetAttemptCount');

    if (!user) {
      return res.json({ message: 'If an account exists, a reset code has been sent.' });
    }

    if (user.resetResendAvailableAt > new Date()) {
      return res.status(429).json({
        message: 'Please wait before requesting another reset code',
        retryAfter: Math.ceil((user.resetResendAvailableAt.getTime() - Date.now()) / 1000),
      });
    }

    const otp = generateOtp();
    user.resetOtpHash = await hashOtp(otp);
    user.resetOtpExpiresAt = getOtpExpiry();
    user.resetResendAvailableAt = getResendAvailableAt();
    user.resetAttemptCount = 0;
    await user.save();

    await sendOtpEmail({
      to: user.email,
      otp,
      firstName: user.firstName,
      purpose: 'reset your password',
    });

    res.json({ message: 'If an account exists, a reset code has been sent.', resendAfter: 60 });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    validatePasswordReset(req.body);
    const email = normalizeEmail(req.body.email);
    const user = await User.findOne({ email })
      .select('+password +resetOtpHash +resetOtpExpiresAt +resetAttemptCount');

    if (!user?.resetOtpHash || user.resetOtpExpiresAt <= new Date()) {
      return res.status(400).json({ message: 'Reset code is invalid or expired' });
    }

    if (user.resetAttemptCount >= 5) {
      return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
    }

    if (!(await compareOtp(req.body.otp, user.resetOtpHash))) {
      user.resetAttemptCount += 1;
      await user.save();
      return res.status(400).json({ message: 'Reset code is invalid or expired' });
    }

    user.password = req.body.password;
    user.authProvider = user.googleId ? 'both' : 'email';
    user.verified = true;
    user.refreshToken = undefined;
    user.resetOtpHash = undefined;
    user.resetOtpExpiresAt = undefined;
    user.resetResendAvailableAt = undefined;
    user.resetAttemptCount = 0;
    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.logout = async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken || req.cookies.refreshToken;
    if (refreshToken) {
      await User.updateOne({ refreshToken }, { $unset: { refreshToken: 1 } });
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    });
    res.json({ message: 'Logged out' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 5. REFRESH TOKEN
exports.refresh = async (req, res) => {
  const token = req.body?.refreshToken || req.headers['x-refresh-token'] || req.cookies.refreshToken;
  console.log("♻️ Token Refresh triggered");
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findOne({ _id: decoded.id, refreshToken: token });
    if (!user) return res.status(403).json({ message: "Invalid session" });
    const accessToken = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
    res.json({ accessToken });
  } catch (err) { res.status(403).json({ message: "Expired" }); }
};

// 6. GET LAWYERS (Filtered)
exports.getLawyers = async (req, res) => {
  try {
    const { district, specialization } = req.query;
    
    // Base Query: Must be a registered lawyer
    let query = { role: 'lawyer' };

    // Filter by District
    if (district) query['address.district'] = district;

    // Filter by Specialization (Regex for flexible matching)
    const specializationTerms = parseSpecializationTerms(specialization);
    if (specializationTerms.length) {
        query['lawyerProfile.specialization'] = { $regex: specializationTerms.join('|'), $options: 'i' };
    }
    
    const lawyers = await User.find(query)
      .select(sanitizeUser)
      .sort({ createdAt: -1 })
      .lean();

    // The auth router adds metadata by spreading response objects. Returning
    // the list under a named field preserves it as an array for chat clients.
    res.json({ lawyers });
  } catch (error) { 
    res.status(500).json({ message: error.message }); 
  }
};

// 6A. GET NEARBY LAWYERS USING MONGODB GEOSPATIAL SEARCH
exports.getNearbyLawyers = async (req, res) => {
  try {
    const { latitude, longitude } = parseSearchCoordinates(req.query);
    const radiusKm = parseRadiusKm(req.query.radiusKm);
    const limit = parseLimit(req.query.limit);
    const onlineOnly = parseBooleanFlag(req.query.onlineOnly);

    const lawyers = await searchNearbyLawyers({
      latitude,
      longitude,
      specialization: req.query.specialization,
      onlineOnly,
      radiusKm,
      limit,
    });

    res.json({
      count: lawyers.length,
      origin: { latitude, longitude },
      radiusKm,
      lawyers: lawyers.map(mapLawyerDiscoveryCard),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 7. GET REGISTERED STUDENTS
exports.getStudents = async (req, res) => {
  try {
    const excludeId = req.user?._id;
    const query = { role: 'student' };

    if (excludeId) query._id = { $ne: excludeId };

    const students = await User.find(query)
      .select(sanitizeUser)
      .sort({ createdAt: -1 })
      .lean();

    res.json({ students });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 7A. GET CURRENT USER
exports.getCurrentUser = async (req, res) => {
  try {
    let user = await User.findById(req.user._id).select(sanitizeUser).lean();
    if (!user) {
      const verificationRequest = await LawyerVerificationRequest.findById(req.user._id).lean();
      if (verificationRequest) {
        user = {
          _id: verificationRequest._id,
          id: verificationRequest._id,
          firstName: verificationRequest.firstName,
          lastName: verificationRequest.lastName,
          email: verificationRequest.email,
          phone: verificationRequest.phone,
          role: 'lawyer',
          accountStatus: verificationRequest.status === 'pending' ? 'pending_approval' : 'rejected',
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
      } else {
        return res.status(404).json({ message: 'User not found' });
      }
    }
    res.json({ ...user, name: getDisplayName(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 8. FOLLOW OR UNFOLLOW LAWYER (Student Only)
exports.toggleFollowLawyer = async (req, res) => {
  try {
    const student = await User.findById(req.user._id);
    const lawyer = await User.findById(req.params.id);

    if (!student || student.role !== 'student') {
      return res.status(403).json({ message: 'Only students can follow lawyers' });
    }

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(404).json({ message: 'Lawyer not found' });
    }

    if (!student.studentProfile) student.studentProfile = {};
    if (!Array.isArray(student.studentProfile.followingLawyers)) {
      student.studentProfile.followingLawyers = [];
    }
    student.following = Array.isArray(student.following) ? student.following : [];
    lawyer.followers = Array.isArray(lawyer.followers) ? lawyer.followers : [];

    const lawyerId = String(lawyer._id);
    const alreadyFollowing = student.studentProfile.followingLawyers.some(
      (id) => String(id) === lawyerId
    );

    if (alreadyFollowing) {
      student.studentProfile.followingLawyers = student.studentProfile.followingLawyers.filter(
        (id) => String(id) !== lawyerId
      );
      student.following = student.following.filter((id) => String(id) !== lawyerId);
      lawyer.followers = lawyer.followers.filter((id) => String(id) !== String(student._id));
    } else {
      student.studentProfile.followingLawyers.push(lawyer._id);
      if (!student.following.some((id) => String(id) === lawyerId)) {
        student.following.push(lawyer._id);
      }
      if (!lawyer.followers.some((id) => String(id) === String(student._id))) {
        lawyer.followers.push(student._id);
      }

      // 🔔 Send notification when someone follows a lawyer
      await createNotification({
        recipient: lawyer._id,
        actor: student._id,
        type: 'follow_accepted',
        title: 'You have a new follower',
        message: `${getNotificationDisplayName(student, 'A student')} started following you.`,
        link: '/lawyer-dash?section=student-interactions&tab=posts',
        metadata: { followerId: student._id },
        io: req.app.get('socketio'),
      });
    }

    student.markModified('studentProfile');
    await student.save();
    await lawyer.save();

    res.json({
      message: alreadyFollowing ? 'Lawyer unfollowed' : 'Lawyer followed',
      user: student.toObject(),
      isFollowing: !alreadyFollowing,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 9. SEND STUDENT CONNECTION REQUEST
exports.sendStudentConnectionRequest = async (req, res) => {
  try {
    const student = await User.findById(req.user._id);
    const targetStudent = await User.findById(req.params.id);

    if (!student || student.role !== 'student') {
      return res.status(403).json({ message: 'Only students can connect with students' });
    }

    if (!targetStudent || targetStudent.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    if (String(student._id) === String(targetStudent._id)) {
      return res.status(400).json({ message: 'You cannot connect with yourself' });
    }

    if (!student.studentProfile) student.studentProfile = {};
    if (!targetStudent.studentProfile) targetStudent.studentProfile = {};
    if (!Array.isArray(student.studentProfile.connectedStudents)) {
      student.studentProfile.connectedStudents = [];
    }
    if (!Array.isArray(student.studentProfile.outgoingConnectionRequests)) {
      student.studentProfile.outgoingConnectionRequests = [];
    }
    if (!Array.isArray(targetStudent.studentProfile.connectionRequests)) {
      targetStudent.studentProfile.connectionRequests = [];
    }

    const targetId = String(targetStudent._id);
    const alreadyConnected = student.studentProfile.connectedStudents.some(
      (id) => String(id) === targetId
    );

    if (alreadyConnected) {
      return res.status(400).json({ message: 'Already connected' });
    }

    const alreadyRequested = student.studentProfile.outgoingConnectionRequests.some(
      (id) => String(id) === targetId
    );

    if (alreadyRequested) {
      return res.status(400).json({ message: 'Request already sent' });
    }

    const incomingFromTarget = student.studentProfile.connectionRequests?.some(
      (id) => String(id) === targetId
    );

    if (incomingFromTarget) {
      return res.status(400).json({ message: 'This student has already sent you a request. Accept it instead.' });
    }

    student.studentProfile.outgoingConnectionRequests.push(targetStudent._id);
    targetStudent.studentProfile.connectionRequests.push(student._id);

    student.markModified('studentProfile');
    targetStudent.markModified('studentProfile');
    await student.save();
    await targetStudent.save();
    await createNotification({
      recipient: targetStudent._id,
      actor: student._id,
      type: 'student_connection_request',
      title: 'New student connection request',
      message: `${getNotificationDisplayName(student, 'A student')} sent you a connection request.`,
      link: `/student-network?tab=students&requesterId=${student._id}`,
      metadata: { requesterId: student._id },
      io: req.app.get('socketio'),
    });

    res.json({
      message: 'Connection request sent',
      user: student.toObject(),
      requestSent: true,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 10. ACCEPT STUDENT CONNECTION REQUEST
exports.acceptStudentConnectionRequest = async (req, res) => {
  try {
    const student = await User.findById(req.user._id);
    const requester = await User.findById(req.params.id);

    if (!student || student.role !== 'student') {
      return res.status(403).json({ message: 'Only students can accept requests' });
    }

    if (!requester || requester.role !== 'student') {
      return res.status(404).json({ message: 'Student not found' });
    }

    if (!student.studentProfile) student.studentProfile = {};
    if (!requester.studentProfile) requester.studentProfile = {};

    student.studentProfile.connectionRequests = student.studentProfile.connectionRequests || [];
    student.studentProfile.connectedStudents = student.studentProfile.connectedStudents || [];
    requester.studentProfile.connectedStudents = requester.studentProfile.connectedStudents || [];
    requester.studentProfile.outgoingConnectionRequests = requester.studentProfile.outgoingConnectionRequests || [];
    student.connections = Array.isArray(student.connections) ? student.connections : [];
    requester.connections = Array.isArray(requester.connections) ? requester.connections : [];

    const requesterId = String(requester._id);
    const hasIncomingRequest = student.studentProfile.connectionRequests.some(
      (id) => String(id) === requesterId
    );

    if (!hasIncomingRequest) {
      return res.status(400).json({ message: 'No pending request from this student' });
    }

    student.studentProfile.connectionRequests = student.studentProfile.connectionRequests.filter(
      (id) => String(id) !== requesterId
    );

    if (!student.studentProfile.connectedStudents.some((id) => String(id) === requesterId)) {
      student.studentProfile.connectedStudents.push(requester._id);
    }
    if (!student.connections.some((id) => String(id) === requesterId)) {
      student.connections.push(requester._id);
    }

    requester.studentProfile.outgoingConnectionRequests = requester.studentProfile.outgoingConnectionRequests.filter(
      (id) => String(id) !== String(student._id)
    );

    if (!requester.studentProfile.connectedStudents.some((id) => String(id) === String(student._id))) {
      requester.studentProfile.connectedStudents.push(student._id);
    }
    if (!requester.connections.some((id) => String(id) === String(student._id))) {
      requester.connections.push(student._id);
    }

    student.markModified('studentProfile');
    requester.markModified('studentProfile');
    await student.save();
    await requester.save();
    await createNotification({
      recipient: requester._id,
      actor: student._id,
      type: 'student_connection_accepted',
      title: 'Connection request accepted',
      message: `${getNotificationDisplayName(student, 'A student')} accepted your connection request.`,
      link: `/student-network?tab=students&studentId=${student._id}`,
      metadata: { studentId: student._id },
      io: req.app.get('socketio'),
    });

    res.json({
      message: 'Connection request accepted',
      user: student.toObject(),
      accepted: true,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 11. GET LAWYER BY ID (Profile View)
exports.getLawyerById = async (req, res) => {
  try {
    // Return a plain object. The auth route adds response metadata by
    // spreading its body; spreading a Mongoose document hides its actual
    // fields inside `_doc`, including `_id` needed for appointments.
    const lawyer = await User.findById(req.params.id).select(sanitizeUser).lean();
    if (!lawyer || !['lawyer', 'LAWYER'].includes(lawyer.role)) {
      return res.status(404).json({ message: "Lawyer not found" });
    }
    res.json({ ...lawyer, name: getDisplayName(lawyer) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 12. UPDATE PROFILE (User & Lawyer)
exports.updateProfile = async (req, res) => {
  try {
    const requestBody = req.body || {};
    // Note: We use findById to ensure we get the Mongoose document instance
    const user = await User.findById(req.user._id);

    if (!user) return res.status(404).json({ message: "User not found" });

    // Update Basic Fields
    if (requestBody.firstName) user.firstName = trimString(requestBody.firstName);
    if (requestBody.lastName) user.lastName = trimString(requestBody.lastName);
    if (requestBody.email) user.email = trimString(requestBody.email);
    if (requestBody.age) user.age = requestBody.age;
    if (requestBody.gender) user.gender = requestBody.gender;

    // Update Address (Merge existing with new)
    const addressPayload = parseMultipartJson(requestBody.address, {});
    if (addressPayload && typeof addressPayload === 'object') {
      const mergedAddress = {
        ...(user.address?.toObject ? user.address.toObject() : (user.address || {})),
        ...addressPayload,
      };
      const normalizedLocation = user.role === 'lawyer'
        ? await resolveLawyerAddress(mergedAddress, {
          requireCoordinates: hasManualLocationInput(mergedAddress),
        })
        : normalizeAddressPayload(mergedAddress);
      user.address = normalizedLocation.address;
      user.location = normalizedLocation.location;
    }

    // Update Lawyer Specifics
    if (requestBody.lawyerProfile && user.role === 'lawyer') {
      const normalizedLawyerProfile = { ...requestBody.lawyerProfile };

      if (normalizedLawyerProfile.languages !== undefined) {
        normalizedLawyerProfile.languages = normalizeLanguageList(normalizedLawyerProfile.languages);
      }

      if (normalizedLawyerProfile.specialization !== undefined) {
        normalizedLawyerProfile.specialization = trimString(normalizedLawyerProfile.specialization);
      }

      if (normalizedLawyerProfile.barId !== undefined) {
        normalizedLawyerProfile.barId = trimString(normalizedLawyerProfile.barId);
      }

      if (normalizedLawyerProfile.about !== undefined) {
        normalizedLawyerProfile.about = trimString(normalizedLawyerProfile.about);
      }

      if (normalizedLawyerProfile.experienceYears !== undefined) {
        normalizedLawyerProfile.experienceYears = Number(normalizedLawyerProfile.experienceYears) || 0;
      }

      if (normalizedLawyerProfile.consultationFee !== undefined) {
        normalizedLawyerProfile.consultationFee = Number(normalizedLawyerProfile.consultationFee) || 0;
      }

      user.lawyerProfile = {
        ...user.lawyerProfile,
        ...normalizedLawyerProfile,
        isVerified: false,
      };
    }

    // Update Student Specifics
    const studentProfilePayload = parseMultipartJson(requestBody.studentProfile, {});
    if (studentProfilePayload && user.role === 'student') {
      const certificateFiles = req.files?.certificateFiles || [];
      const certificates = await Promise.all((Array.isArray(studentProfilePayload.certificates) ? studentProfilePayload.certificates : (user.studentProfile?.certificates || [])).map(async (certificate) => {
        const fileIndex = Number(certificate.fileIndex);
        const file = Number.isInteger(fileIndex) ? certificateFiles[fileIndex] : null;
        const uploadedFile = file ? await uploadProfileFileToCloudinary(file, 'lawin_certificates', 'auto') : null;
        return {
          name: trimString(certificate.name),
          description: trimString(certificate.description),
          fileUrl: uploadedFile?.url || trimString(certificate.fileUrl),
          fileName: uploadedFile?.fileName || trimString(certificate.fileName),
        };
      }));
      user.studentProfile = {
        ...user.studentProfile,
        ...studentProfilePayload,
        certificates,
      };
    }

    const profileImageFile = req.files?.profileImage?.[0];
    if (profileImageFile) {
      if (!profileImageFile.mimetype.startsWith('image/')) {
        return res.status(400).json({ message: 'Profile photo must be an image file' });
      }
      const uploadedImage = await uploadProfileFileToCloudinary(profileImageFile, 'lawin_profile_images', 'image');
      user.profileImage = uploadedImage.url;
      user.profilePicture = uploadedImage.url;
    }

    await user.save();
    console.log(`🔄 Profile updated for: ${user.phone}`);
    res.json({ message: "Updated", user: user.toObject() });
  } catch (error) {
      res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 13. GET CURRENT LAWYER STUDENT INTERACTION POSTS
exports.getLawyerStudentInteractions = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id).select(sanitizeUser);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can access student interactions' });
    }

    const internships = (lawyer.lawyerProfile?.internships || [])
      .slice()
      .sort((first, second) => new Date(second.createdAt || 0) - new Date(first.createdAt || 0))
      .map((internship) => ({
        ...formatPublishedInternship(lawyer, internship, { viewerId: req.user._id }),
        applicants: (internship.applications || []).map((application) => ({
          id: application._id,
          studentId: application.studentId,
          name: `${application.firstName || ''} ${application.lastName || ''}`.trim() || 'Student',
          email: application.email || '',
          phone: application.phone || '',
          collegeName: application.collegeName || '',
          degree: application.degree || '',
          yearOfStudy: application.yearOfStudy || '',
          skills: application.skills || [],
          resumeLink: application.resumeLink || '',
          resumeUrl: application.resumeUrl || '',
          resumeFileName: application.resumeFileName || '',
          coverMessage: application.coverMessage || '',
          linkedIn: application.linkedIn || '',
          portfolio: application.portfolio || '',
          status: application.status || 'pending',
          submittedAt: application.submittedAt,
        })),
      }));

    const jamSessions = (lawyer.lawyerProfile?.jamSessions || [])
      .slice()
      .sort((first, second) => new Date(second.createdAt || 0) - new Date(first.createdAt || 0))
      .map((session) => {
        const joinedStudents = (session.participants || []).map((participant) => ({
          id: participant._id,
          studentId: participant.studentId,
          name: participant.name || 'Student',
          email: participant.email || '',
          collegeName: participant.collegeName || '',
          yearOfStudy: participant.yearOfStudy || '',
          status: 'joined',
          joinedAt: participant.joinedAt,
        }));

        return {
          ...formatPublishedJamSession(lawyer, session, { viewerId: req.user._id }),
          participantCount: joinedStudents.length,
          joinedStudents,
        };
      });

    const followerUsers = await User.find({
      $or: [
        { _id: { $in: lawyer.followers || [] } },
        { 'studentProfile.followingLawyers': lawyer._id },
      ],
      role: 'student',
    }).select('firstName lastName email phone profileImage profilePicture studentProfile createdAt').lean();

    const followers = followerUsers.map((student) => ({
      id: String(student._id),
      _id: String(student._id),
      name: `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Law Student',
      email: student.email || '',
      phone: student.phone || '',
      profileImage: student.profileImage || student.profilePicture || '',
      collegeName: student.studentProfile?.collegeName || 'Law Student',
      collegeEmail: student.studentProfile?.collegeEmail || '',
      currentYear: student.studentProfile?.currentYear || '',
      followedAt: student.createdAt,
    }));

    res.json({
      internships,
      jamSessions,
      followers,
      stats: getLawyerInteractionStats(lawyer),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 14. CREATE LAWYER INTERNSHIP POST
exports.createLawyerInternship = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can publish internships' });
    }

    const internship = {
      title: req.body.title?.trim(),
      firm: req.body.firm?.trim(),
      specialization: Array.isArray(req.body.specialization)
        ? req.body.specialization.map((item) => String(item).trim()).filter(Boolean)
        : [],
      description: req.body.description?.trim(),
      duration: req.body.duration?.trim(),
      location: req.body.location?.trim(),
      stipend: req.body.stipend?.trim(),
      skills: Array.isArray(req.body.skills)
        ? req.body.skills.map((item) => String(item).trim()).filter(Boolean)
        : [],
      status: 'open',
    };

    if (!internship.title || !internship.description) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

    const currentProfile = lawyer.lawyerProfile?.toObject
      ? lawyer.lawyerProfile.toObject()
      : (lawyer.lawyerProfile || {});
    const currentInternships = Array.isArray(currentProfile.internships) ? currentProfile.internships : [];

    lawyer.set('lawyerProfile', {
      ...currentProfile,
      internships: [internship, ...currentInternships],
    });

    await lawyer.save();

    const savedInternship = lawyer.lawyerProfile?.internships?.[0];
    await notifyLawyerFollowers({
      lawyer,
      type: 'new_post',
      title: 'New internship posted',
      message: `${getNotificationDisplayName(lawyer, 'A lawyer')} posted a new internship: ${savedInternship.title || 'Internship'}.`,
      link: `/student-explore?tab=internships&itemId=${savedInternship._id}`,
      metadata: { internshipId: savedInternship._id, lawyerId: lawyer._id, creatorRole: 'lawyer' },
      io: req.app.get('socketio'),
    });

    res.status(201).json({
      message: 'Internship published',
      internship: formatPublishedInternship(lawyer, savedInternship, { viewerId: req.user._id }),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 15. CREATE LAWYER JAM SESSION POST
exports.createLawyerJamSession = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can publish jam sessions' });
    }

    const jamSession = {
      title: req.body.title?.trim(),
      topic: req.body.topic?.trim(),
      summary: req.body.summary?.trim(),
      schedule: req.body.schedule?.trim(),
      location: req.body.location?.trim(),
    };

    if (!jamSession.title || !jamSession.topic || !jamSession.summary) {
      return res.status(400).json({ message: 'Title, topic, and summary are required' });
    }

    const currentProfile = lawyer.lawyerProfile?.toObject
      ? lawyer.lawyerProfile.toObject()
      : (lawyer.lawyerProfile || {});
    const currentJamSessions = Array.isArray(currentProfile.jamSessions) ? currentProfile.jamSessions : [];

    lawyer.set('lawyerProfile', {
      ...currentProfile,
      jamSessions: [jamSession, ...currentJamSessions],
    });
    // Explicitly mark the nested profile dirty so the new session is reliably
    // persisted before the dashboard reloads.
    lawyer.markModified('lawyerProfile');

    await lawyer.save();

    const savedJamSession = lawyer.lawyerProfile?.jamSessions?.[0];
    await notifyLawyerFollowers({
      lawyer,
      type: 'new_post',
      title: 'New jam session posted',
      message: `${getNotificationDisplayName(lawyer, 'A lawyer')} posted a new jam session: ${savedJamSession.title || 'Jam Session'}.`,
      link: `/student-explore?tab=jamSessions&itemId=${savedJamSession._id}`,
      metadata: { sessionId: savedJamSession._id, lawyerId: lawyer._id, creatorRole: 'lawyer' },
      io: req.app.get('socketio'),
    });

    res.status(201).json({
      message: 'Jam session published',
      jamSession: formatPublishedJamSession(lawyer, savedJamSession, { viewerId: req.user._id }),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 15A. GET PARTICIPANTS FOR A LAWYER'S JAM SESSION
exports.getLawyerJamSessionParticipants = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id).select('role lawyerProfile.jamSessions');

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can view jam session participants' });
    }

    const session = (lawyer.lawyerProfile?.jamSessions || []).find(
      (item) => String(item._id) === String(req.params.sessionId)
    );

    if (!session) {
      return res.status(404).json({ message: 'Jam session not found' });
    }

    const participants = (session.participants || []).map((participant) => ({
      id: String(participant._id),
      studentId: String(participant.studentId || ''),
      name: participant.name || 'Student',
      email: participant.email || '',
      collegeName: participant.collegeName || '',
      yearOfStudy: participant.yearOfStudy || '',
      status: 'joined',
      joinedAt: participant.joinedAt,
    }));

    res.json({ participants });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 16. CREATE LAWYER TEAM
exports.createLawyerTeam = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can create a team' });
    }

    const firmName = trimString(req.body.firmName);
    const seniorLawyerName = trimString(req.body.seniorLawyerName);
    const maxTeamSize = Number(req.body.maxTeamSize);

    if (!firmName || !seniorLawyerName) {
      return res.status(400).json({ message: 'Firm name and senior lawyer name are required' });
    }

    if (!Number.isInteger(maxTeamSize) || maxTeamSize < 2) {
      return res.status(400).json({ message: 'Team size must be at least 2' });
    }

    const teamCode = await generateTeamCode();
    const team = await Team.create({
      teamCode,
      firmName,
      seniorLawyerName,
      maxTeamSize,
      owner: lawyer._id,
      members: [],
      pendingRequests: [],
      cases: [],
    });

    const teams = await getLawyerTeamDocuments(lawyer._id);

    res.status(201).json({
      message: 'Team created',
      team: formatTeamWorkspace(team, lawyer._id),
      teams: teams.map((item) => formatTeamWorkspace(item, lawyer._id)),
      user: await getTeamResponseUser(lawyer),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17. JOIN LAWYER TEAM
exports.joinLawyerTeam = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can join a team' });
    }

    const teamCode = trimString(req.body.teamCode).toUpperCase();
    if (!teamCode) {
      return res.status(400).json({ message: 'Team code is required' });
    }

    const team = await findTeamByCode(teamCode);

    if (!team) {
      return res.status(404).json({ message: 'Team not found. Please check the code.' });
    }

    if (String(team.owner) === String(lawyer._id)) {
      return res.status(400).json({ message: 'You cannot join your own team' });
    }

    const members = Array.isArray(team.members) ? team.members : [];
    const pendingRequests = Array.isArray(team.pendingRequests) ? team.pendingRequests : [];
    const maxTeamSize = Number(team.maxTeamSize) || 2;
    const lawyerId = String(lawyer._id);
    const alreadyMember = members.some((member) => String(member.lawyerId) === lawyerId);
    const alreadyRequested = pendingRequests.some((request) => String(request.lawyerId) === lawyerId);

    if (alreadyMember) {
      return res.status(400).json({ message: 'You are already a member of this team' });
    }

    if (alreadyRequested) {
      return res.json({
        message: 'Your join request is already pending with the senior lawyer',
        requestPending: true,
      });
    }

    if (members.length + 1 >= maxTeamSize) {
      return res.status(400).json({ message: 'This team is already full' });
    }

    const pendingRequest = {
      lawyerId: lawyer._id,
      name: getLawyerName(lawyer),
      email: lawyer.email || '',
      phone: lawyer.phone || '',
      requestedAt: new Date(),
    };

    team.pendingRequests.unshift(pendingRequest);
    await team.save();

    await createNotification({
      recipient: team.owner,
      actor: lawyer._id,
      type: 'team_join_request',
      title: 'New team join request',
      message: `${getLawyerName(lawyer)} requested to join ${team.firmName || 'your team'}.`,
      link: `/lawyer-dash?section=team&teamId=${team._id}`,
      metadata: { teamId: team._id, teamCode, requesterId: lawyer._id },
      io: req.app.get('socketio'),
    });

    res.status(202).json({
      message: 'Join request sent to the senior lawyer',
      requestPending: true,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17A. ACCEPT LAWYER TEAM REQUEST
exports.acceptLawyerTeamRequest = async (req, res) => {
  try {
    const seniorLawyer = await User.findById(req.user._id);

    if (!seniorLawyer || seniorLawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only the senior lawyer can accept team requests' });
    }

    const team = await getOwnedTeamForRequest(seniorLawyer._id, req.params.requestId, req.query.teamId);
    const pendingRequests = Array.isArray(team.pendingRequests) ? team.pendingRequests : [];
    const members = Array.isArray(team.members) ? team.members : [];
    const maxTeamSize = Number(team.maxTeamSize) || 2;
    const request = pendingRequests.find((item) => String(item._id) === String(req.params.requestId));

    if (!request) {
      return res.status(404).json({ message: 'Join request not found' });
    }

    if (members.length + 1 >= maxTeamSize) {
      return res.status(400).json({ message: 'This team is already full' });
    }

    const juniorLawyer = await User.findById(request.lawyerId);
    if (!juniorLawyer || juniorLawyer.role !== 'lawyer') {
      return res.status(404).json({ message: 'Requesting lawyer not found' });
    }

    const requestLawyerId = String(request.lawyerId);
    const alreadyMember = members.some((member) => String(member.lawyerId) === requestLawyerId);
    const member = {
      lawyerId: request.lawyerId,
      name: request.name || getLawyerName(juniorLawyer),
      email: request.email || juniorLawyer.email || '',
      phone: request.phone || juniorLawyer.phone || '',
      joinedAt: new Date(),
    };

    if (!alreadyMember) {
      team.members.push(member);
    }
    team.pendingRequests = pendingRequests.filter((item) => String(item._id) !== String(req.params.requestId));
    await team.save();

    await createNotification({
      recipient: juniorLawyer._id,
      actor: seniorLawyer._id,
      type: 'team_join_accepted',
      title: 'Team request accepted',
      message: `${getLawyerName(seniorLawyer)} accepted your request to join ${team.firmName || 'the team'}.`,
      link: `/lawyer-dash?section=team&teamId=${team._id}`,
      metadata: { teamId: team._id, teamCode: team.teamCode, seniorLawyerId: seniorLawyer._id },
      io: req.app.get('socketio'),
    });

    res.json({
      message: 'Join request accepted',
      team: formatTeamWorkspace(team, seniorLawyer._id),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17B. REJECT LAWYER TEAM REQUEST
exports.rejectLawyerTeamRequest = async (req, res) => {
  try {
    const seniorLawyer = await User.findById(req.user._id);

    if (!seniorLawyer || seniorLawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only the senior lawyer can reject team requests' });
    }

    const team = await getOwnedTeamForRequest(seniorLawyer._id, req.params.requestId, req.query.teamId);
    const pendingRequests = Array.isArray(team.pendingRequests) ? team.pendingRequests : [];
    const request = pendingRequests.find((item) => String(item._id) === String(req.params.requestId));

    if (!request) {
      return res.status(404).json({ message: 'Join request not found' });
    }

    team.pendingRequests = pendingRequests.filter((item) => String(item._id) !== String(req.params.requestId));
    await team.save();

    await createNotification({
      recipient: request.lawyerId,
      actor: seniorLawyer._id,
      type: 'team_join_rejected',
      title: 'Team request rejected',
      message: `${getLawyerName(seniorLawyer)} rejected your request to join ${team.firmName || 'the team'}.`,
      link: `/lawyer-dash?section=team&teamId=${team._id}`,
      metadata: { teamId: team._id, teamCode: team.teamCode, seniorLawyerId: seniorLawyer._id },
      io: req.app.get('socketio'),
    });

    res.json({
      message: 'Join request rejected',
      team: formatTeamWorkspace(team, seniorLawyer._id),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17C. REMOVE LAWYER TEAM MEMBER
exports.removeLawyerTeamMember = async (req, res) => {
  try {
    const seniorLawyer = await User.findById(req.user._id);

    if (!seniorLawyer || seniorLawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only the senior lawyer can remove team members' });
    }

    const memberId = String(req.params.memberId);
    if (memberId === String(seniorLawyer._id)) {
      return res.status(400).json({ message: 'You cannot remove yourself from your team' });
    }

    const team = await getTeamForOwnerAction(seniorLawyer._id, req.query.teamId);
    const members = Array.isArray(team.members) ? team.members : [];
    const member = members.find((item) => String(item.lawyerId) === memberId);

    if (!member) {
      return res.status(404).json({ message: 'Team member not found' });
    }

    team.members = members.filter((item) => String(item.lawyerId) !== memberId);
    await team.save();

    await createNotification({
      recipient: memberId,
      actor: seniorLawyer._id,
      type: 'team_member_removed',
      title: 'Removed from team',
      message: `${getLawyerName(seniorLawyer)} removed you from ${team.firmName || 'the team'}.`,
      link: '/lawyer-dash?section=team',
      metadata: { teamId: team._id, teamCode: team.teamCode, seniorLawyerId: seniorLawyer._id },
      io: req.app.get('socketio'),
    });

    res.json({
      message: 'Team member removed',
      team: formatTeamWorkspace(team, seniorLawyer._id),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17D. GET LAWYER TEAM WORKSPACE
exports.getLawyerTeamWorkspace = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can access a team workspace' });
    }

    const teams = await getLawyerTeamDocuments(lawyer._id);
    const selectedTeam = teams.find((team) => String(team._id) === String(req.query.teamId)) || teams[0] || null;

    res.json({
      team: selectedTeam ? formatTeamWorkspace(selectedTeam, lawyer._id) : null,
      teams: teams.map((team) => formatTeamWorkspace(team, lawyer._id)),
      activeTeamId: selectedTeam?._id || null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17B. ADD TEAM CASE
exports.addLawyerTeamCase = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can add team cases' });
    }

    const team = await getTeamForMemberAction(lawyer._id, req.query.teamId || req.body.teamId);

    const clientName = trimString(req.body.clientName);
    const clientPhone = trimString(req.body.clientPhone);
    const clientAddress = trimString(req.body.clientAddress);
    const caseName = trimString(req.body.caseName || req.body.caseTitle);
    const briefInfo = trimString(req.body.briefInfo || req.body.caseDetails);
    const courtName = trimString(req.body.courtName);
    const status = trimString(req.body.status) || 'new';
    const allowedStatuses = ['new', 'in_progress', 'hearing_scheduled', 'closed'];

    if (!clientName || !caseName || !briefInfo) {
      return res.status(400).json({ message: 'Client name, case name, and brief info are required' });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid case status' });
    }

    const startingDateInput = req.body.startingDate || req.body.hearingDate;
    const startingDate = startingDateInput ? new Date(startingDateInput) : null;
    if (startingDate && Number.isNaN(startingDate.getTime())) {
      return res.status(400).json({ message: 'Invalid starting date' });
    }

    const nextHearingDateInput = req.body.nextHearingDate;
    const nextHearingDate = nextHearingDateInput ? new Date(nextHearingDateInput) : null;
    if (nextHearingDate && Number.isNaN(nextHearingDate.getTime())) {
      return res.status(400).json({ message: 'Invalid next hearing date' });
    }

    const teamCase = {
      clientName,
      clientPhone,
      clientAddress,
      caseName,
      caseTitle: caseName,
      briefInfo,
      caseDetails: briefInfo,
      courtName,
      startingDate,
      nextHearingDate,
      hearingDate: startingDate,
      status,
      addedBy: lawyer._id,
      addedByName: getLawyerName(lawyer),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    team.cases.unshift(teamCase);
    await team.save();

    const savedCase = team.cases[0];
    res.status(201).json({
      message: 'Team case added',
      case: formatTeamCase(savedCase),
      team: formatTeamWorkspace(team, lawyer._id),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17C. UPDATE TEAM CASE STATUS / DETAILS
exports.updateLawyerTeamCaseStatus = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can update team cases' });
    }

    const allowedStatuses = ['new', 'in_progress', 'hearing_scheduled', 'closed'];
    const team = await getTeamForMemberAction(lawyer._id, req.query.teamId || req.body.teamId);

    const teamCase = team.cases.id(req.params.caseId);
    if (!teamCase) {
      return res.status(404).json({ message: 'Team case not found' });
    }

    if (req.body.status !== undefined) {
      const status = trimString(req.body.status);
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid case status' });
      }
      teamCase.status = status;
    }

    if (req.body.nextHearingDate !== undefined) {
      const nextHearingDateInput = req.body.nextHearingDate;
      const nextHearingDate = nextHearingDateInput ? new Date(nextHearingDateInput) : null;
      if (nextHearingDate && Number.isNaN(nextHearingDate.getTime())) {
        return res.status(400).json({ message: 'Invalid next hearing date' });
      }
      teamCase.nextHearingDate = nextHearingDate;
    }

    if (req.body.clientPhone !== undefined) {
      teamCase.clientPhone = trimString(req.body.clientPhone);
    }

    if (req.body.hearingHistory !== undefined && Array.isArray(req.body.hearingHistory)) {
      teamCase.hearingHistory = req.body.hearingHistory.map((item) => ({
        courtName: trimString(item.courtName),
        hearingDate: item.hearingDate ? new Date(item.hearingDate) : null,
        hearingDetails: trimString(item.hearingDetails),
        nextHearing: item.nextHearing ? new Date(item.nextHearing) : null,
      }));
    }

    teamCase.updatedAt = new Date();
    await team.save();

    res.json({
      message: 'Case details updated',
      case: formatTeamCase(teamCase),
      team: formatTeamWorkspace(team, lawyer._id),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17D. GET STUDENT DISCOVERY DATA
exports.getStudentDiscovery = async (req, res) => {
  try {
    const student = await User.findById(req.user._id).select(sanitizeUser);

    if (!student || student.role !== 'student') {
      return res.status(403).json({ message: 'Only students can access student discovery' });
    }

    const { latitude, longitude } = parseSearchCoordinates(req.query);
    const radiusKm = parseRadiusKm(req.query.radiusKm);
    const limit = parseLimit(req.query.limit, 36);

    const nearbyLawyers = await searchNearbyLawyers({
      latitude,
      longitude,
      radiusKm,
      limit,
    });

    const lawyerIds = nearbyLawyers.map((lawyer) => lawyer._id);
    const distanceLookup = new Map(
      nearbyLawyers.map((lawyer) => [String(lawyer._id), lawyer.distanceKm])
    );

    const lawyers = lawyerIds.length
      ? await User.find({ _id: { $in: lawyerIds } })
        .select(sanitizeUser)
      : [];

    const lawyerMap = new Map(lawyers.map((lawyer) => [String(lawyer._id), lawyer]));
    const orderedLawyers = nearbyLawyers
      .map((lawyer) => lawyerMap.get(String(lawyer._id)))
      .filter(Boolean);

    const feed = buildStudentFeed(orderedLawyers, student, distanceLookup);
    const internships = feed.filter((item) => item.type === 'internship');
    const jamSessions = feed.filter((item) => item.type === 'jam');
    const lawyerCards = nearbyLawyers.map(mapLawyerDiscoveryCard);

    res.json({
      origin: { latitude, longitude },
      radiusKm,
      feed,
      internships,
      jamSessions,
      lawyers: lawyerCards,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

// 17B. APPLY TO INTERNSHIP
exports.applyToInternship = async (req, res) => {
  try {
    const student = await User.findById(req.user._id);

    if (!student || student.role !== 'student') {
      return res.status(403).json({ message: 'Only students can apply to internships' });
    }

    const lawyers = await User.find({ role: 'lawyer', 'lawyerProfile.internships.0': { $exists: true } });

    let targetLawyer = null;
    let internshipIndex = -1;

    lawyers.some((lawyer) => {
      internshipIndex = (lawyer.lawyerProfile?.internships || []).findIndex(
        (internship) => String(internship._id) === String(req.params.postId)
      );

      if (internshipIndex >= 0) {
        targetLawyer = lawyer;
        return true;
      }

      return false;
    });

    if (!targetLawyer || internshipIndex < 0) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    if (!student.studentProfile) {
      student.studentProfile = {};
    }

    student.studentProfile.internshipApplications = student.studentProfile.internshipApplications || [];
    const alreadyApplied = student.studentProfile.internshipApplications.some(
      (item) => String(item.postId) === String(req.params.postId)
    );

    if (alreadyApplied) {
      return res.status(400).json({ message: 'You already applied to this internship' });
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      collegeName,
      degree,
      yearOfStudy,
      skills,
      resumeLink,
      resumeFileName,
      coverMessage,
      linkedIn,
      portfolio,
    } = req.body;

    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !phone?.trim() || !collegeName?.trim() || !degree?.trim() || !yearOfStudy?.trim()) {
      return res.status(400).json({ message: 'Please fill all required fields' });
    }

    const internship = targetLawyer.lawyerProfile.internships[internshipIndex];
    if ((internship.status || 'open') === 'closed') {
      return res.status(400).json({ message: 'This internship is closed for applications' });
    }

    const uploadedResume = await uploadResumeToCloudinary(req.file);

    internship.applications = internship.applications || [];
    internship.applications.unshift({
      studentId: student._id,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim(),
      collegeName: collegeName.trim(),
      degree: degree.trim(),
      yearOfStudy: yearOfStudy.trim(),
      skills: Array.isArray(skills) ? skills.map((item) => String(item).trim()).filter(Boolean) : [],
      resumeLink: resumeLink?.trim() || '',
      resumeUrl: uploadedResume?.url || '',
      resumePublicId: uploadedResume?.publicId || '',
      resumeFileName: uploadedResume?.fileName || resumeFileName?.trim() || '',
      coverMessage: coverMessage?.trim() || '',
      linkedIn: linkedIn?.trim() || '',
      portfolio: portfolio?.trim() || '',
      status: 'pending',
    });

    student.studentProfile.internshipApplications.unshift({
      postId: internship._id,
      lawyerId: targetLawyer._id,
      title: internship.title || 'Internship',
      status: 'applied',
    });

    student.markModified('studentProfile');
    targetLawyer.markModified('lawyerProfile');
    await Promise.all([student.save(), targetLawyer.save()]);

    // 🔔 Send notification when someone applies to an internship
    await createNotification({
      recipient: targetLawyer._id,
      actor: student._id,
      type: 'internship_application',
      title: 'New internship application',
      message: `${getNotificationDisplayName(student, 'A student')} applied to your internship: ${internship.title || 'Untitled'}`,
      link: `/lawyer-dash?section=student-interactions&tab=internships&itemId=${internship._id}&drawer=applicants`,
      metadata: { internshipId: internship._id, lawyerId: targetLawyer._id, studentId: student._id },
      io: req.app.get('socketio'),
    });

    res.status(201).json({
      message: 'Application submitted',
      application: {
        postId: internship._id,
        title: internship.title || 'Internship',
        appliedAt: new Date().toISOString(),
      },
      user: student.toObject(),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17C. JOIN JAM SESSION
exports.joinJamSession = async (req, res) => {
  try {
    const student = await User.findById(req.user._id);

    if (!student || student.role !== 'student') {
      return res.status(403).json({ message: 'Only students can join jam sessions' });
    }

    const lawyers = await User.find({ role: 'lawyer', 'lawyerProfile.jamSessions.0': { $exists: true } });

    let targetLawyer = null;
    let sessionIndex = -1;

    lawyers.some((lawyer) => {
      sessionIndex = (lawyer.lawyerProfile?.jamSessions || []).findIndex(
        (session) => String(session._id) === String(req.params.sessionId)
      );

      if (sessionIndex >= 0) {
        targetLawyer = lawyer;
        return true;
      }

      return false;
    });

    if (!targetLawyer || sessionIndex < 0) {
      return res.status(404).json({ message: 'Jam session not found' });
    }

    if (!student.studentProfile) {
      student.studentProfile = {};
    }

    student.studentProfile.joinedJamSessions = student.studentProfile.joinedJamSessions || [];
    const alreadyJoined = student.studentProfile.joinedJamSessions.some(
      (item) => String(item.sessionId) === String(req.params.sessionId)
    );

    if (alreadyJoined) {
      return res.status(400).json({ message: 'You already joined this jam session' });
    }

    const session = targetLawyer.lawyerProfile.jamSessions[sessionIndex];
    session.participants = session.participants || [];

    if (session.participants.some((participant) => String(participant.studentId) === String(student._id))) {
      return res.status(400).json({ message: 'You already joined this jam session' });
    }

    const participantName = req.body.name?.trim() || getDisplayName(student);
    const participantEmail = req.body.email?.trim() || student.email || '';

    session.participants.unshift({
      studentId: student._id,
      name: participantName,
      email: participantEmail,
      collegeName: student.studentProfile?.collegeName || '',
      yearOfStudy: student.studentProfile?.currentYear || '',
    });

    student.studentProfile.joinedJamSessions.unshift({
      sessionId: session._id,
      lawyerId: targetLawyer._id,
      title: session.title || 'Jam Session',
    });

    student.markModified('studentProfile');
    targetLawyer.markModified('lawyerProfile');
    await Promise.all([student.save(), targetLawyer.save()]);

    // 🔔 Send notification when someone joins a jam session
    await createNotification({
      recipient: targetLawyer._id,
      actor: student._id,
      type: 'jam_session_joined',
      title: 'Student joined jam session',
      message: `${getNotificationDisplayName(student, 'A student')} joined your jam session: ${session.title || 'Untitled'}`,
      link: `/lawyer-dash?section=student-interactions&tab=jamSessions&itemId=${session._id}&drawer=participants`,
      metadata: { sessionId: session._id, lawyerId: targetLawyer._id, studentId: student._id },
      io: req.app.get('socketio'),
    });

    res.status(201).json({
      message: 'Jam session joined',
      joinedSession: {
        sessionId: session._id,
        title: session.title || 'Jam Session',
        joinedAt: new Date().toISOString(),
      },
      participantCount: session.participants.length,
      user: student.toObject(),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const findLawyerJamSession = async (sessionId) => {
  const lawyers = await User.find({ role: 'lawyer', 'lawyerProfile.jamSessions.0': { $exists: true } });
  let targetLawyer = null;
  let sessionIndex = -1;

  lawyers.some((lawyer) => {
    sessionIndex = (lawyer.lawyerProfile?.jamSessions || []).findIndex(
      (session) => String(session._id) === String(sessionId)
    );

    if (sessionIndex >= 0) {
      targetLawyer = lawyer;
      return true;
    }

    return false;
  });

  return { targetLawyer, sessionIndex };
};

const findLawyerInternship = async (internshipId) => {
  const lawyers = await User.find({ role: 'lawyer', 'lawyerProfile.internships.0': { $exists: true } });
  let targetLawyer = null;
  let internshipIndex = -1;

  lawyers.some((lawyer) => {
    internshipIndex = (lawyer.lawyerProfile?.internships || []).findIndex(
      (internship) => String(internship._id) === String(internshipId)
    );

    if (internshipIndex >= 0) {
      targetLawyer = lawyer;
      return true;
    }

    return false;
  });

  return { targetLawyer, internshipIndex };
};

exports.toggleInternshipLike = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can react to internships' });
    }

    const { targetLawyer, internshipIndex } = await findLawyerInternship(req.params.postId);
    if (!targetLawyer || internshipIndex < 0) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    const internship = targetLawyer.lawyerProfile.internships[internshipIndex];
    internship.likedBy = Array.isArray(internship.likedBy) ? internship.likedBy : [];
    const alreadyLiked = internship.likedBy.some((id) => String(id) === String(req.user._id));

    if (alreadyLiked) {
      internship.likedBy = internship.likedBy.filter((id) => String(id) !== String(req.user._id));
    } else {
      internship.likedBy.push(req.user._id);
    }

    targetLawyer.markModified('lawyerProfile');
    await targetLawyer.save();

    // 🔔 Send notification when someone likes an internship
    if (String(targetLawyer._id) !== String(req.user._id) && !alreadyLiked) {
      await createNotification({
        recipient: targetLawyer._id,
        actor: req.user._id,
        type: 'post_liked',
        title: 'Internship liked',
        message: `${getNotificationDisplayName(req.user, 'Someone')} liked your internship: ${internship.title || 'Untitled'}`,
        link: `/lawyer-dash?section=student-interactions&tab=internships&itemId=${internship._id}`,
        metadata: { internshipId: internship._id, lawyerId: targetLawyer._id },
        io: req.app.get('socketio'),
      });
    }

    res.json({
      liked: !alreadyLiked,
      likesCount: internship.likedBy.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addInternshipComment = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can comment on internships' });
    }

    const text = String(req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ message: 'Comment text is required' });
    }

    const { targetLawyer, internshipIndex } = await findLawyerInternship(req.params.postId);
    if (!targetLawyer || internshipIndex < 0) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    const internship = targetLawyer.lawyerProfile.internships[internshipIndex];
    internship.comments = Array.isArray(internship.comments) ? internship.comments : [];
    internship.comments.unshift({
      userId: req.user._id,
      name: getDisplayName(req.user),
      role: req.user.role,
      text,
    });

    targetLawyer.markModified('lawyerProfile');
    await targetLawyer.save();

    // 🔔 Send notification when someone comments on an internship
    if (String(targetLawyer._id) !== String(req.user._id)) {
      await createNotification({
        recipient: targetLawyer._id,
        actor: req.user._id,
        type: 'post_commented',
        title: 'New comment on internship',
        message: `${getNotificationDisplayName(req.user, 'Someone')} commented on your internship: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        link: `/lawyer-dash?section=student-interactions&tab=internships&itemId=${internship._id}`,
        metadata: { internshipId: internship._id, commentText: text, lawyerId: targetLawyer._id },
        io: req.app.get('socketio'),
      });
    }

    res.status(201).json({
      comment: formatInteractionComment(internship.comments[0]),
      commentsCount: internship.comments.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.toggleJamSessionLike = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can react to jam sessions' });
    }

    const { targetLawyer, sessionIndex } = await findLawyerJamSession(req.params.sessionId);
    if (!targetLawyer || sessionIndex < 0) {
      return res.status(404).json({ message: 'Jam session not found' });
    }

    const session = targetLawyer.lawyerProfile.jamSessions[sessionIndex];
    session.likedBy = Array.isArray(session.likedBy) ? session.likedBy : [];
    const alreadyLiked = session.likedBy.some((id) => String(id) === String(req.user._id));

    if (alreadyLiked) {
      session.likedBy = session.likedBy.filter((id) => String(id) !== String(req.user._id));
    } else {
      session.likedBy.push(req.user._id);
    }

    targetLawyer.markModified('lawyerProfile');
    await targetLawyer.save();

    // 🔔 Send notification when someone likes a jam session
    if (String(targetLawyer._id) !== String(req.user._id) && !alreadyLiked) {
      await createNotification({
        recipient: targetLawyer._id,
        actor: req.user._id,
        type: 'post_liked',
        title: 'Jam session liked',
        message: `${getNotificationDisplayName(req.user, 'Someone')} liked your jam session: ${session.title || 'Untitled'}`,
        link: `/lawyer-dash?section=student-interactions&tab=jamSessions&itemId=${session._id}`,
        metadata: { sessionId: session._id, lawyerId: targetLawyer._id },
        io: req.app.get('socketio'),
      });
    }

    res.json({
      liked: !alreadyLiked,
      likesCount: session.likedBy.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addJamSessionComment = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can comment on jam sessions' });
    }

    const text = String(req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ message: 'Comment text is required' });
    }

    const { targetLawyer, sessionIndex } = await findLawyerJamSession(req.params.sessionId);
    if (!targetLawyer || sessionIndex < 0) {
      return res.status(404).json({ message: 'Jam session not found' });
    }

    const session = targetLawyer.lawyerProfile.jamSessions[sessionIndex];
    session.comments = Array.isArray(session.comments) ? session.comments : [];
    session.comments.unshift({
      userId: req.user._id,
      name: getDisplayName(req.user),
      role: req.user.role,
      text,
    });

    targetLawyer.markModified('lawyerProfile');
    await targetLawyer.save();

    // 🔔 Send notification when someone comments on a jam session
    if (String(targetLawyer._id) !== String(req.user._id)) {
      await createNotification({
        recipient: targetLawyer._id,
        actor: req.user._id,
        type: 'post_commented',
        title: 'New comment on jam session',
        message: `${getNotificationDisplayName(req.user, 'Someone')} commented on your jam session: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        link: `/lawyer-dash?section=student-interactions&tab=jamSessions&itemId=${session._id}`,
        metadata: { sessionId: session._id, commentText: text, lawyerId: targetLawyer._id },
        io: req.app.get('socketio'),
      });
    }

    res.status(201).json({
      comment: formatInteractionComment(session.comments[0]),
      commentsCount: session.comments.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17D. TOGGLE INTERNSHIP STATUS
exports.toggleInternshipStatus = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can manage internships' });
    }

    const internships = lawyer.lawyerProfile?.internships || [];
    const internshipIndex = internships.findIndex(
      (internship) => String(internship._id) === String(req.params.postId)
    );

    if (internshipIndex < 0) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    const internship = internships[internshipIndex];
    internship.status = (internship.status || 'open') === 'open' ? 'closed' : 'open';

    lawyer.markModified('lawyerProfile');
    await lawyer.save();

    res.json({
      message: `Internship ${internship.status}`,
      internship: formatPublishedInternship(lawyer, internship),
      stats: getLawyerInteractionStats(lawyer),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17E. DELETE INTERNSHIP
exports.deleteLawyerInternship = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can manage internships' });
    }

    const internships = lawyer.lawyerProfile?.internships || [];
    const internshipIndex = internships.findIndex(
      (internship) => String(internship._id) === String(req.params.postId)
    );

    if (internshipIndex < 0) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    const [removedInternship] = internships.splice(internshipIndex, 1);
    lawyer.markModified('lawyerProfile');
    await lawyer.save();

    if (removedInternship?.applications?.length) {
      const affectedStudentIds = [
        ...new Set(
          removedInternship.applications
            .map((application) => application.studentId && String(application.studentId))
            .filter(Boolean)
        ),
      ];

      if (affectedStudentIds.length) {
        await User.updateMany(
          { _id: { $in: affectedStudentIds } },
          { $pull: { 'studentProfile.internshipApplications': { postId: removedInternship._id } } }
        );
      }
    }

    res.json({
      message: 'Internship deleted',
      deletedPostId: req.params.postId,
      stats: getLawyerInteractionStats(lawyer),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17F. UPDATE APPLICANT STATUS
exports.updateInternshipApplicantStatus = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can manage applicants' });
    }

    const nextStatus = String(req.body.status || '').toLowerCase();
    if (!['pending', 'accepted', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({ message: 'Invalid applicant status' });
    }

    const internships = lawyer.lawyerProfile?.internships || [];
    const internship = internships.find((item) => String(item._id) === String(req.params.postId));

    if (!internship) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    const applicant = (internship.applications || []).find(
      (application) => String(application._id) === String(req.params.applicationId)
    );

    if (!applicant) {
      return res.status(404).json({ message: 'Applicant not found' });
    }

    applicant.status = nextStatus;
    lawyer.markModified('lawyerProfile');
    await lawyer.save();

    const student = applicant.studentId ? await User.findById(applicant.studentId) : null;
    if (student?.studentProfile?.internshipApplications?.length) {
      const studentApplication = student.studentProfile.internshipApplications.find(
        (application) => String(application.postId) === String(req.params.postId)
      );

      if (studentApplication) {
        studentApplication.status = nextStatus;
        student.markModified('studentProfile');
        await student.save();

        // 🔔 Send notification when application status changes
        await createNotification({
          recipient: student._id,
          actor: lawyer._id,
          type: 'internship_application_update',
          title: `Internship application ${nextStatus}`,
          message: `Your application for "${internship.title || 'Internship'}" has been ${nextStatus} by ${getNotificationDisplayName(lawyer, 'the lawyer')}.`,
          link: `/student-explore?tab=internships&itemId=${internship._id}`,
          metadata: { internshipId: internship._id, lawyerId: lawyer._id, status: nextStatus },
          io: req.app.get('socketio'),
        });
      }
    }

    res.json({
      message: `Applicant ${nextStatus}`,
      applicant: {
        id: applicant._id,
        status: applicant.status,
      },
      stats: getLawyerInteractionStats(lawyer),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17G. GET INTERNSHIP APPLICANTS
exports.getInternshipApplicants = async (req, res) => {
  try {
    const lawyer = await User.findById(req.user._id);

    if (!lawyer || lawyer.role !== 'lawyer') {
      return res.status(403).json({ message: 'Only lawyers can view internship applicants' });
    }

    const internship = (lawyer.lawyerProfile?.internships || []).find(
      (item) => String(item._id) === String(req.params.postId)
    );

    if (!internship) {
      return res.status(404).json({ message: 'Internship not found' });
    }

    const applicants = (internship.applications || []).map((application) => ({
      id: application._id,
      studentId: application.studentId,
      name: `${application.firstName || ''} ${application.lastName || ''}`.trim() || 'Student',
      email: application.email || '',
      phone: application.phone || '',
      collegeName: application.collegeName || '',
      degree: application.degree || '',
      yearOfStudy: application.yearOfStudy || '',
      skills: application.skills || [],
      resumeLink: application.resumeLink || '',
      resumeUrl: application.resumeUrl || '',
      resumeFileName: application.resumeFileName || '',
      coverMessage: application.coverMessage || '',
      linkedIn: application.linkedIn || '',
      portfolio: application.portfolio || '',
      status: application.status || 'pending',
      submittedAt: application.submittedAt,
    }));

    res.json(applicants);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 16. GET ALL PUBLISHED INTERNSHIPS
exports.getPublishedInternships = async (req, res) => {
  try {
    const viewerId = getOptionalViewerId(req);
    const viewer = viewerId
      ? await User.findById(viewerId).select('role studentProfile.internshipApplications')
      : null;
    const appliedInternshipIds = viewer?.role === 'student'
      ? getStudentApplicationIds(viewer)
      : new Set();
    const lawyers = await User.find({ role: 'lawyer', 'lawyerProfile.internships.0': { $exists: true } })
      .select(sanitizeUser)
      .sort({ createdAt: -1 });

    const legacyInternships = lawyers.flatMap((lawyer) =>
      (lawyer.lawyerProfile?.internships || []).map((internship) =>
        ({
          ...formatPublishedInternship(lawyer, internship, { viewerId }),
          applied: appliedInternshipIds.has(String(internship._id)),
        })
      )
    );

    let postInternships = [];
    try {
      const posts = await Post.find({ type: 'internship' })
        .populate('createdBy', 'firstName lastName role profileImage lawyerProfile address')
        .sort({ createdAt: -1 });

      postInternships = posts.map((post) => {
        const creator = post.createdBy || {};
        const creatorName = `${creator.firstName || ''} ${creator.lastName || ''}`.trim() || 'Lawyer';
        return {
          id: post._id,
          type: 'internship',
          lawyerId: creator._id,
          lawyerName: creatorName,
          profileImage: creator.profileImage || '',
          avatar: creatorName.charAt(0).toUpperCase(),
          title: post.title || 'Internship',
          firm: creator.address?.city || creator.address?.district || 'Lawin',
          specialization: post.tags || [],
          description: post.content || post.description || '',
          duration: post.duration || 'Not specified',
          location: post.location || 'Not specified',
          stipend: post.stipend || 'Not specified',
          skills: post.tags || [],
          status: post.status || 'open',
          createdAt: post.createdAt,
          postedAt: getRelativeTime(post.createdAt),
          applicationCount: post.applicationCount || 0,
          likesCount: Array.isArray(post.likedBy) ? post.likedBy.length : 0,
          liked: (post.likedBy || []).some((id) => String(id) === String(viewerId)),
          commentsCount: Array.isArray(post.comments) ? post.comments.length : 0,
        };
      });
    } catch {
      postInternships = [];
    }

    const internships = [...legacyInternships, ...postInternships].sort(
      (first, second) => new Date(second.createdAt || 0) - new Date(first.createdAt || 0)
    );

    res.json({ internships });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 17. GET ALL PUBLISHED JAM SESSIONS
exports.getPublishedJamSessions = async (req, res) => {
  try {
    const viewerId = getOptionalViewerId(req);
    const lawyers = await User.find({ role: 'lawyer', 'lawyerProfile.jamSessions.0': { $exists: true } })
      .select(sanitizeUser)
      .sort({ createdAt: -1 });

    const legacyJamSessions = lawyers.flatMap((lawyer) =>
      (lawyer.lawyerProfile?.jamSessions || []).map((session) =>
        formatPublishedJamSession(lawyer, session, { viewerId })
      )
    );

    let postJamSessions = [];
    try {
      const posts = await Post.find({ type: 'jam' })
        .populate('createdBy', 'firstName lastName role profileImage lawyerProfile address')
        .sort({ createdAt: -1 });

      postJamSessions = posts.map((post) => {
        const creator = post.createdBy || {};
        const creatorName = `${creator.firstName || ''} ${creator.lastName || ''}`.trim() || 'Lawyer';
        return {
          id: post._id,
          type: 'jam',
          lawyerId: creator._id,
          lawyerName: creatorName,
          author: creatorName,
          profileImage: creator.profileImage || '',
          avatar: creatorName.charAt(0).toUpperCase(),
          title: post.title || 'Jam Session',
          topic: post.topic || post.tags?.[0] || 'General Discussion',
          summary: post.content || post.summary || '',
          schedule: post.schedule || 'To be announced',
          location: post.location || 'Online / TBA',
          createdAt: post.createdAt,
          time: getRelativeTime(post.createdAt),
          participantCount: post.participantCount || 0,
          likesCount: Array.isArray(post.likedBy) ? post.likedBy.length : 0,
          liked: (post.likedBy || []).some((id) => String(id) === String(viewerId)),
          commentsCount: Array.isArray(post.comments) ? post.comments.length : 0,
        };
      });
    } catch {
      postJamSessions = [];
    }

    const jamSessions = [...legacyJamSessions, ...postJamSessions].sort(
      (first, second) => new Date(second.createdAt || 0) - new Date(first.createdAt || 0)
    );

    res.json({ jamSessions });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 18. VERIFY LAWYER (Admin Only)
exports.verifyLawyer = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { 'lawyerProfile.isVerified': req.body.isVerified }, { new: true });
    
    // 🔔 Send notification to the lawyer
    if (user) {
      await createNotification({
        recipient: user._id,
        type: 'system',
        title: user.lawyerProfile?.isVerified ? 'Profile verified' : 'Profile verification updated',
        message: user.lawyerProfile?.isVerified 
          ? 'Congratulations! Your profile has been verified by the administrator.' 
          : 'Your verification status has been updated by the administrator.',
        link: '/lawyer-profile/me',
        io: req.app.get('socketio'),
      });
    }

    console.log(`👮 Lawyer ${user.phone} verification set to ${req.body.isVerified}`);
    res.json(user);
  } catch (error) { res.status(500).json({ message: error.message }); }
};

// 19. ADMIN - GET ALL LAWYERS FOR VERIFICATION
exports.getAdminLawyers = async (req, res) => {
  try {
    const { status } = req.query;

    const pendingRequests = await LawyerVerificationRequest.find({ status: 'pending' }).sort({ createdAt: -1 }).lean();
    const approvedLawyers = await User.find({ role: 'lawyer', accountStatus: 'active' })
      .select('firstName lastName email phone accountStatus lawyerProfile verified emailVerified phoneVerified createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean();

    const formattedPending = pendingRequests.map((req) => ({
      _id: req._id,
      id: req._id,
      name: `${req.firstName || ''} ${req.lastName || ''}`.trim(),
      firstName: req.firstName,
      lastName: req.lastName,
      email: req.email,
      phone: req.phone,
      accountStatus: 'pending_approval',
      barId: req.barId || req.barEnrollmentNumber || '',
      barEnrollmentNumber: req.barEnrollmentNumber || req.barId || '',
      specialization: req.specialization || 'General Practice',
      experienceYears: req.experienceYears || 1,
      isVerified: false,
      createdAt: req.createdAt,
      updatedAt: req.updatedAt,
      isVerificationRequest: true,
    }));

    const formattedApproved = approvedLawyers.map((lawyer) => ({
      _id: lawyer._id,
      id: lawyer._id,
      name: lawyer.name || `${lawyer.firstName || ''} ${lawyer.lastName || ''}`.trim(),
      firstName: lawyer.firstName,
      lastName: lawyer.lastName,
      email: lawyer.email,
      phone: lawyer.phone,
      accountStatus: 'active',
      barId: lawyer.lawyerProfile?.barId || '',
      barEnrollmentNumber: lawyer.lawyerProfile?.barId || '',
      specialization: lawyer.lawyerProfile?.specialization || '',
      experienceYears: lawyer.lawyerProfile?.experienceYears || 0,
      isVerified: true,
      createdAt: lawyer.createdAt,
      updatedAt: lawyer.updatedAt,
      isVerificationRequest: false,
    }));

    let allLawyers = [];
    if (status === 'pending') {
      allLawyers = formattedPending;
    } else if (status === 'approved') {
      allLawyers = formattedApproved;
    } else {
      allLawyers = [...formattedPending, ...formattedApproved];
    }

    res.json({ lawyers: allLawyers, count: allLawyers.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 20. ADMIN - UPDATE LAWYER STATUS (APPROVE / REJECT)
exports.updateLawyerStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'approved' | 'rejected'

    if (status === 'rejected') {
      const verificationRequest = await LawyerVerificationRequest.findById(id);
      if (verificationRequest) {
        verificationRequest.status = 'rejected';
        verificationRequest.rejectionReason = trimString(req.body.rejectionReason)
          || 'Your lawyer registration could not be approved.';
        await verificationRequest.save();
        console.log(`👮 Verification request ${id} marked as REJECTED`);
        return res.json({
          success: true,
          message: 'Lawyer verification request rejected.',
          status: 'rejected',
          lawyerId: id,
        });
      }

      const existingUser = await User.findById(id);
      if (existingUser) {
        await User.deleteOne({ _id: id });
        console.log(`👮 User ${id} deleted on rejection`);
        return res.json({
          success: true,
          message: 'Lawyer user record removed on rejection.',
          status: 'rejected',
          lawyerId: id,
        });
      }

      return res.status(404).json({ message: 'Lawyer request not found' });
    }

    if (status === 'approved' || status === 'active') {
      const verificationRequest = await LawyerVerificationRequest.findById(id);
      if (verificationRequest) {
        let createdUser = await User.findOne({ email: verificationRequest.email.toLowerCase() });
        if (!createdUser) {
          createdUser = new User({
            firstName: verificationRequest.firstName,
            lastName: verificationRequest.lastName,
            email: verificationRequest.email,
            phone: verificationRequest.phone,
            password: verificationRequest.password,
            role: 'lawyer',
            accountStatus: 'active',
            verified: true,
            emailVerified: true,
            phoneVerified: true,
            lawyerProfile: {
              barId: verificationRequest.barId,
              specialization: verificationRequest.specialization,
              experienceYears: verificationRequest.experienceYears,
              isVerified: true,
            },
            address: {
              city: verificationRequest.city,
              state: verificationRequest.state,
              pincode: verificationRequest.pincode,
              fullAddress: verificationRequest.address,
            },
          });
          createdUser.$locals.passwordIsHashed = true;
          await createdUser.save();
        } else {
          createdUser.accountStatus = 'active';
          if (!createdUser.lawyerProfile) createdUser.lawyerProfile = {};
          createdUser.lawyerProfile.isVerified = true;
          await createdUser.save();
        }

        await LawyerVerificationRequest.deleteOne({ _id: id });

        console.log(`✅ Approved lawyer ${createdUser.email} created in User collection`);

        return res.json({
          success: true,
          message: 'Lawyer approved and created in main database collection.',
          lawyer: {
            _id: createdUser._id,
            id: createdUser._id,
            name: `${createdUser.firstName} ${createdUser.lastName}`.trim(),
            firstName: createdUser.firstName,
            lastName: createdUser.lastName,
            email: createdUser.email,
            phone: createdUser.phone,
            accountStatus: 'active',
            barId: createdUser.lawyerProfile?.barId || '',
            barEnrollmentNumber: createdUser.lawyerProfile?.barId || '',
            specialization: createdUser.lawyerProfile?.specialization || '',
            isVerified: true,
          },
        });
      }

      const existingUser = await User.findById(id);
      if (existingUser) {
        existingUser.accountStatus = 'active';
        if (!existingUser.lawyerProfile) existingUser.lawyerProfile = {};
        existingUser.lawyerProfile.isVerified = true;
        await existingUser.save();

        return res.json({
          success: true,
          message: 'Lawyer user status updated to active.',
          lawyer: existingUser,
        });
      }

      return res.status(404).json({ message: 'Lawyer record not found' });
    }

    return res.status(400).json({ message: 'Invalid status specified' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
