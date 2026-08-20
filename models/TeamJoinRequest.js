const mongoose = require('mongoose');

const teamJoinRequestSchema = new mongoose.Schema(
  {
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true, immutable: true },
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'],
      default: 'pending',
      required: true,
    },
    requestedAt: { type: Date, default: Date.now, immutable: true },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decisionReason: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { timestamps: true }
);

teamJoinRequestSchema.index(
  { teamId: 1, requesterId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
teamJoinRequestSchema.index({ teamId: 1, status: 1, requestedAt: -1 });
teamJoinRequestSchema.index({ requesterId: 1, status: 1, requestedAt: -1 });

module.exports = mongoose.model('TeamJoinRequest', teamJoinRequestSchema);
