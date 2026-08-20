const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
      immutable: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    // This is deliberately team-scoped. User.role remains the platform role
    // (`lawyer`) and is never changed by Team membership.
    role: {
      type: String,
      enum: ['owner', 'member'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'removed'],
      default: 'active',
    },
    joinedAt: { type: Date, default: Date.now, immutable: true },
    leftAt: { type: Date, default: null },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    removalReason: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { timestamps: true }
);

teamMemberSchema.index({ teamId: 1, userId: 1 }, { unique: true });
teamMemberSchema.index(
  { teamId: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: 'owner', status: 'active' } }
);
teamMemberSchema.index({ userId: 1, status: 1, teamId: 1 });
teamMemberSchema.index({ teamId: 1, role: 1, status: 1 });

module.exports = mongoose.model('TeamMember', teamMemberSchema);
