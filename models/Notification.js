const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    type: {
      type: String,
      enum: [
        'appointment_request',
        'appointment_accepted',
        'appointment_rejected',
        'student_connection_request',
        'student_connection_accepted',
        'new_message',
        'appointment_reminder',
        'post_liked',
        'post_commented',
        'follow_request',
        'follow_accepted',
        'internship_application',
        'internship_application_update',
        'jam_session_joined',
        'new_post',
        'team_join_request',
        'team_join_accepted',
        'team_join_rejected',
        'team_member_removed',
        'system',
      ],
      default: 'system',
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    link: {
      type: String,
      default: '',
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
