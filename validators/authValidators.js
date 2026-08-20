const { trimString } = require('../utils/location');

const allowedRoles = ['user', 'lawyer', 'student', 'admin'];
const registrationRoles = ['user', 'lawyer', 'student'];

const normalizeRole = (role) => String(role || '').trim().toLowerCase();
const normalizeEmail = (value) => trimString(value).toLowerCase();
const normalizePhone = (value) => trimString(value);
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isPhone = (value) => /^\+?[0-9]{10,15}$/.test(String(value || '').replace(/[\s-]/g, ''));
const isValidPassword = (value) => /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(String(value || ''));
const passwordRequirementsMessage = 'Password must include at least 1 capital letter, 1 special character, and 1 number.';
const isScalar = (value) => typeof value === 'string' || typeof value === 'number';
const hasValue = (value) => {
  if (Array.isArray(value)) {
    return value.some((item) => isScalar(item) && trimString(item));
  }

  return isScalar(value) && trimString(value);
};

const requireFields = (payload, fields) => {
  const missing = fields.filter((field) => !hasValue(payload[field]));
  if (missing.length) {
    const error = new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`);
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = missing[0];
    throw error;
  }
};

const validateRoleFields = (body, role) => {
  if (role === 'student') {
    requireFields(body, ['collegeName', 'collegeEmail']);
  }

  if (role === 'lawyer') {
    requireFields(body, ['barId', 'specialization', 'languages', 'experienceYears']);
  }
};

const validateEmailRegistration = (body) => {
  const role = normalizeRole(body.role);

  if (!role || !registrationRoles.includes(role)) {
    const error = new Error(!role ? 'Please select a role.' : 'Invalid role selected.');
    error.statusCode = 400;
    throw error;
  }

  requireFields(body, ['firstName', 'lastName', 'email', 'phone', 'password', 'confirmPassword']);

  if (!isEmail(normalizeEmail(body.email))) {
    const error = new Error('Enter a valid email address.');
    error.statusCode = 400;
    throw error;
  }

  if (!isPhone(normalizePhone(body.phone))) {
    const error = new Error('Enter a valid phone number.');
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = 'phone';
    throw error;
  }

  if (!isValidPassword(body.password)) {
    const error = new Error(passwordRequirementsMessage);
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = 'password';
    throw error;
  }

  if (body.password !== body.confirmPassword) {
    const error = new Error('Passwords do not match');
    error.statusCode = 400;
    throw error;
  }

  validateRoleFields(body, role);
  return role;
};

const validateGoogleProfile = (body) => {
  const role = normalizeRole(body.role) || 'user';

  if (!registrationRoles.includes(role)) {
    const error = new Error('Invalid role selected');
    error.statusCode = 400;
    throw error;
  }

  requireFields(body, ['phone', 'password', 'confirmPassword']);

  if (!isValidPassword(body.password)) {
    const error = new Error(passwordRequirementsMessage);
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = 'password';
    throw error;
  }

  if (body.password !== body.confirmPassword) {
    const error = new Error('Passwords do not match');
    error.statusCode = 400;
    throw error;
  }

  validateRoleFields(body, role);
  return role;
};

const validatePasswordReset = (body) => {
  requireFields(body, ['email', 'otp', 'password', 'confirmPassword']);

  if (!isEmail(normalizeEmail(body.email))) {
    const error = new Error('Enter a valid email address');
    error.statusCode = 400;
    throw error;
  }

  if (!isValidPassword(body.password)) {
    const error = new Error(passwordRequirementsMessage);
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    error.field = 'password';
    throw error;
  }

  if (body.password !== body.confirmPassword) {
    const error = new Error('Passwords do not match');
    error.statusCode = 400;
    throw error;
  }
};

module.exports = {
  allowedRoles,
  normalizeEmail,
  normalizePhone,
  normalizeRole,
  validateEmailRegistration,
  validateGoogleProfile,
  validatePasswordReset,
};
