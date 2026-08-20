const { OAuth2Client } = require('google-auth-library');

const getGoogleClientId = () => process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;

const getClient = () => {
  const clientId = getGoogleClientId();
  if (!clientId) {
    const error = new Error('GOOGLE_CLIENT_ID is not configured');
    error.statusCode = 500;
    throw error;
  }

  return new OAuth2Client(clientId);
};

const verifyGoogleIdToken = async (credential) => {
  if (!credential) {
    const error = new Error('Google credential is required');
    error.statusCode = 400;
    throw error;
  }

  const ticket = await getClient().verifyIdToken({
    idToken: credential,
    audience: getGoogleClientId(),
  });

  const payload = ticket.getPayload();

  if (!payload?.email) {
    const error = new Error('Google account email is required');
    error.statusCode = 400;
    throw error;
  }

  return {
    googleId: payload.sub,
    email: String(payload.email).toLowerCase(),
    firstName: payload.given_name || '',
    lastName: payload.family_name || '',
    name: payload.name || '',
    profilePicture: payload.picture || '',
    emailVerified: Boolean(payload.email_verified),
  };
};

module.exports = { verifyGoogleIdToken };
