const mongoose = require('mongoose');

const activityEventSchema = new mongoose.Schema(
  {
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', default: null, immutable: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
    entityType: {
      type: String,
      enum: ['team', 'team_member', 'team_join_request', 'client', 'case', 'hearing', 'case_document'],
      required: true,
      immutable: true,
    },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    action: { type: String, required: true, trim: true, maxlength: 150, immutable: true },
    changedFields: [{ type: String, trim: true, maxlength: 200 }],
    before: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    after: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    requestId: { type: String, trim: true, maxlength: 200, default: '' },
    occurredAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: true }
);

activityEventSchema.index({ teamId: 1, occurredAt: -1 });
activityEventSchema.index({ caseId: 1, occurredAt: -1 });
activityEventSchema.index({ actorId: 1, occurredAt: -1 });

module.exports = mongoose.model('ActivityEvent', activityEventSchema);
