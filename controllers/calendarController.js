const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { generateConsentUrl, decodeState, exchangeCode, getGoogleAccountEmail } = require('../services/googleCalendarService');
const { resyncFutureActiveHearings } = require('../services/hearingCalendarService');

const frontendUrl = () => (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
const redirectToHearings = (res, status) => res.redirect(`${frontendUrl()}/lawyer-dashboard?calendar=${status}`);

exports.connectGoogleCalendar = (req, res) => {
  try {
    if (req.user.role !== 'lawyer') return res.status(403).json({ message: 'Google Calendar is available to lawyers only' });
    const url = generateConsentUrl(req.user._id);
    // A browser navigation cannot attach the app's Bearer token. Frontends
    // using Bearer auth can request the signed consent URL, then navigate to
    // it themselves; ordinary authenticated navigations still redirect here.
    if (req.query.response === 'json') return res.json({ url });
    return res.redirect(url);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Google callbacks cannot include the application's Authorization header.
// Verify the short-lived, HMAC-signed OAuth state first, then create a
// server-only bearer token so the existing protect middleware still enforces
// the authenticated user on the callback route.
exports.authenticateGoogleCalendarCallback = (req, res, next) => {
  try {
    const { userId } = decodeState(req.query.state);
    if (!process.env.JWT_SECRET) throw new Error('JWT secret is not configured');
    const callbackToken = jwt.sign({ id: userId, calendarOAuthCallback: true }, process.env.JWT_SECRET, { expiresIn: '10m' });
    req.headers.authorization = `Bearer ${callbackToken}`;
    next();
  } catch (error) {
    return redirectToHearings(res, 'error');
  }
};

exports.callbackGoogleCalendar = async (req, res) => {
  try {
    if (req.query.error) throw new Error('Google Calendar permission was not granted');
    const { userId } = decodeState(req.query.state);
    if (String(req.user._id) !== String(userId)) throw new Error('Google Calendar authorization user mismatch');
    const tokens = await exchangeCode(req.query.code);
    const email = await getGoogleAccountEmail(tokens);
    const user = await User.findById(userId).select('+googleCalendar.refreshToken');
    if (!user || user.role !== 'lawyer') throw new Error('Google Calendar user is unavailable');
    user.googleCalendar = { connected: true, email, refreshToken: tokens.refresh_token };
    await user.save();
    await resyncFutureActiveHearings(user._id);
    console.log('Google Calendar Connected', { userId: String(user._id), email });
    return redirectToHearings(res, 'connected');
  } catch (error) {
    console.error('Google Calendar connection failed:', error.message);
    return redirectToHearings(res, 'error');
  }
};

exports.disconnectGoogleCalendar = async (req, res) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $set: { 'googleCalendar.connected': false }, $unset: { 'googleCalendar.email': 1, 'googleCalendar.refreshToken': 1 } });
    console.log('Google Calendar Disconnected', { userId: String(req.user._id) });
    return res.json({ connected: false });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to disconnect Google Calendar' });
  }
};

exports.getGoogleCalendarStatus = (req, res) => {
  const calendar = req.user.googleCalendar || {};
  return res.json(calendar.connected ? { connected: true, email: calendar.email } : { connected: false });
};
