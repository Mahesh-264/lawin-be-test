const express = require('express');
const calendarController = require('../controllers/calendarController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/google/connect', protect, authorize('lawyer'), calendarController.connectGoogleCalendar);
// Google redirects from its own browser context and cannot attach the app's
// Bearer token. The signed, short-lived OAuth state verifies the same user.
router.get('/google/callback', calendarController.authenticateGoogleCalendarCallback, protect, authorize('lawyer'), calendarController.callbackGoogleCalendar);
router.get('/google/status', protect, authorize('lawyer'), calendarController.getGoogleCalendarStatus);
router.delete('/google/disconnect', protect, authorize('lawyer'), calendarController.disconnectGoogleCalendar);

module.exports = router;
