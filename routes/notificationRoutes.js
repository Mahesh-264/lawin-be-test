const express = require('express');
const notificationController = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/', notificationController.getNotifications);
router.patch('/:id/read', notificationController.markNotificationRead);
router.patch('/read-all', notificationController.markAllNotificationsRead);

module.exports = router;
