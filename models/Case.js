const mongoose = require('mongoose');

const caseSchema = new mongoose.Schema(
  {
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    // Read only while repairing records created before Client was normalized.
    // The repair migration unsets it and all new writes use clientId only.
    clientName: { type: String, trim: true, maxlength: 200, default: undefined },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    details: { type: String, required: true, trim: true, maxlength: 20000 },
    basicInfo: { type: String, trim: true, maxlength: 10000, default: '' },
    courtName: { type: String, trim: true, maxlength: 300, default: '' },
    startingDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ['new', 'in_progress', 'hearing_scheduled', 'closed'],
      default: 'new',
    },
    nextHearingAt: { type: Date, default: null },
    // Ownership is permanent. Membership determines whether another lawyer
    // may read this matter, but never changes this field.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Idempotency markers used only by the legacy embedded-case migration.
    legacyTeamId: { type: String, trim: true, default: undefined, immutable: true },
    legacyCaseId: { type: String, trim: true, default: undefined, immutable: true },
  },
  { timestamps: true }
);

caseSchema.index({ teamId: 1, ownerId: 1, status: 1, updatedAt: -1 });
caseSchema.index({ teamId: 1, status: 1, nextHearingAt: 1 });
caseSchema.index({ ownerId: 1, updatedAt: -1 });
caseSchema.index({ legacyTeamId: 1, legacyCaseId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Case', caseSchema);
