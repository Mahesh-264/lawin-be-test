const Notification = require('../models/Notification');

exports.getNotifications = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const notifications = await Notification.find({ recipient: req.user._id })
      .populate('actor', 'firstName lastName profileImage role lawyerProfile.specialization')
      .sort({ createdAt: -1 })
      .limit(limit);

    const unreadCount = await Notification.countDocuments({
      recipient: req.user._id,
      readAt: null,
    });

    res.json({ notifications, unreadCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.markNotificationRead = async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.markAllNotificationsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, readAt: null },
      { readAt: new Date() }
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
