const express = require('express');
const multer = require('multer');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect, authorize } = require('../middleware/authMiddleware');
const rejectUnsafeAuthInput = require('../middleware/rejectUnsafeAuthInput');
const {
  authLimiter,
  loginLimiter,
  otpLimiter,
} = require('../middleware/authRateLimiters');

const retiredTeamEndpoint = (req, res) => res.status(410).json({
  message: 'This legacy Team endpoint has been retired. Use /api/teams.',
});

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowedTypes = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);

    if (allowedTypes.has(file.mimetype)) {
      callback(null, true);
      return;
    }

    callback(new Error('Resume must be a PDF, DOC, or DOCX file'));
  },
});

const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowedTypes = new Set([
      'image/jpeg', 'image/png', 'image/webp',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    callback(allowedTypes.has(file.mimetype) ? null : new Error('Only JPG, PNG, WEBP, PDF, DOC, and DOCX files are allowed'), allowedTypes.has(file.mimetype));
  },
});

router.use(rejectUnsafeAuthInput);
router.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body = {}) => {
    if (Object.prototype.hasOwnProperty.call(body, 'success')) return sendJson(body);
    const success = res.statusCode < 400;
    const fallbackCode = success
      ? 'SUCCESS'
      : res.statusCode === 401 ? 'WRONG_PASSWORD'
        : res.statusCode === 403 ? 'FORBIDDEN'
          : res.statusCode === 404 ? 'ACCOUNT_NOT_FOUND'
            : res.statusCode === 409 ? 'CONFLICT'
              : res.statusCode === 422 ? 'VALIDATION_ERROR'
                : res.statusCode >= 500 ? 'INTERNAL_SERVER_ERROR'
                  : 'VALIDATION_ERROR';
    return sendJson({ success, code: body.code || fallbackCode, ...body });
  };
  next();
});

router.post('/register', authLimiter, authController.register);
router.get('/lawyer-verification-status', authController.getLawyerVerificationStatus);
router.post('/login', loginLimiter, authController.login);
router.post('/google', loginLimiter, authController.googleAuth);
router.post('/registration/check-email', authLimiter, authController.checkEmailAvailability);
router.post('/registration/send-email-otp', otpLimiter, authController.sendEmailVerification);
router.post('/registration/verify-email-otp', otpLimiter, authController.verifyEmailVerification);
router.post('/registration/check-phone', authLimiter, authController.checkPhoneAvailability);
router.post('/registration/send-phone-otp', otpLimiter, authController.sendPhoneVerification);
router.post('/registration/verify-phone-otp', otpLimiter, authController.verifyPhoneVerification);
router.post('/forgot-password', otpLimiter, authController.forgotPassword);
router.post('/reset-password', otpLimiter, authController.resetPassword);
router.post('/logout', authController.logout);
router.get('/location/pincode/:pincode', authController.lookupPincode);
router.post('/location/geocode', authController.geocodeRegistrationAddress);
router.get('/location/reverse-geocode', authController.reverseGeocodeRegistrationAddress);
router.post('/send-otp', otpLimiter, authController.sendOTP);
router.post('/verify-phone-otp', otpLimiter, authController.verifyPhoneOTP);
router.post('/verify-otp', otpLimiter, authController.verifyOTP);
router.post('/resend-otp', otpLimiter, authController.resendOTP);
router.post('/refresh', authController.refresh);
router.get('/published-internships', authController.getPublishedInternships);
router.get('/published-jam-sessions', authController.getPublishedJamSessions);
router.get('/lawyers', authController.getLawyers);
router.get('/lawyers/nearby', authController.getNearbyLawyers);
router.get('/lawyers/:id', authController.getLawyerById);
router.use(protect);
router.get('/me', authController.getCurrentUser);
router.get('/students', authController.getStudents);
router.get('/student/discovery', authorize('student'), authController.getStudentDiscovery);
router.post('/student/internships/:postId/apply', authorize('student'), resumeUpload.single('resumeFile'), authController.applyToInternship);
router.post('/student/jam-sessions/:sessionId/join', authorize('student'), authController.joinJamSession);
router.post('/jam-sessions/:sessionId/like', authorize('student', 'lawyer'), authController.toggleJamSessionLike);
router.post('/jam-sessions/:sessionId/comments', authorize('student', 'lawyer'), authController.addJamSessionComment);
router.get('/lawyer/student-interactions', authorize('lawyer'), authController.getLawyerStudentInteractions);
router.post('/lawyer/internships', authorize('lawyer'), authController.createLawyerInternship);
router.post('/lawyer/jam-sessions', authorize('lawyer'), authController.createLawyerJamSession);
router.get('/lawyer/jam-sessions/:sessionId/participants', authorize('lawyer'), authController.getLawyerJamSessionParticipants);
// The normalized /api/teams API is the sole Team/Case mutation surface.
// Keeping these paths reachable would allow bypassing TeamMember authorization.
router.get('/lawyer/team', authorize('lawyer'), retiredTeamEndpoint);
router.post('/lawyer/team', authorize('lawyer'), retiredTeamEndpoint);
router.post('/lawyer/team/join', authorize('lawyer'), retiredTeamEndpoint);
router.patch('/lawyer/team/requests/:requestId/accept', authorize('lawyer'), retiredTeamEndpoint);
router.patch('/lawyer/team/requests/:requestId/reject', authorize('lawyer'), retiredTeamEndpoint);
router.delete('/lawyer/team/members/:memberId', authorize('lawyer'), retiredTeamEndpoint);
router.post('/lawyer/team/cases', authorize('lawyer'), retiredTeamEndpoint);
router.patch('/lawyer/team/cases/:caseId/status', authorize('lawyer'), retiredTeamEndpoint);
router.post('/lawyer/internships/:postId/like', authorize('student', 'lawyer'), authController.toggleInternshipLike);
router.post('/lawyer/internships/:postId/comments', authorize('student', 'lawyer'), authController.addInternshipComment);
router.patch('/lawyer/internships/:postId/toggle-status', authorize('lawyer'), authController.toggleInternshipStatus);
router.delete('/lawyer/internships/:postId', authorize('lawyer'), authController.deleteLawyerInternship);
router.get('/lawyer/internships/:postId/applicants', authorize('lawyer'), authController.getInternshipApplicants);
router.patch('/lawyer/internships/:postId/applicants/:applicationId/status', authorize('lawyer'), authController.updateInternshipApplicantStatus);
router.post('/follow-lawyer/:id', authController.toggleFollowLawyer);
router.post('/connect-student/:id', authController.sendStudentConnectionRequest);
router.post('/accept-student-request/:id', authController.acceptStudentConnectionRequest);
router.put('/update-profile', profileUpload.fields([
  { name: 'profileImage', maxCount: 1 },
  { name: 'certificateFiles', maxCount: 10 },
]), authController.updateProfile);
router.patch('/verify-lawyer/:id', authorize('admin'), authController.verifyLawyer);
router.get('/admin/lawyers', authorize('admin'), authController.getAdminLawyers);
router.patch('/admin/lawyers/:id/status', authorize('admin'), authController.updateLawyerStatus);

module.exports = router;
