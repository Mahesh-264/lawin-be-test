const mongoose = require('mongoose');

const hearingSchema = new mongoose.Schema(
  {
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true },
    hearingDate: { type: Date, required: true },
    // Empty means the record deliberately has no scheduled time. The datetime
    // remains for date compatibility, but Calendar must not invent a time.
    hearingTime: { type: String, default: '' },
    courtName: { type: String, trim: true, maxlength: 300, default: '' },
    hearingDetails: { type: String, trim: true, maxlength: 10000, default: '' },
    nextHearingDate: { type: Date, default: null },
    nextHearingTime: { type: String, default: '' },
    // Imported/manual history rows are deliberately excluded from active
    // hearing selection and Calendar synchronization.
    isHistorical: { type: Boolean, default: false },
    googleEventId: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

hearingSchema.index({ caseId: 1, hearingDate: 1 });
hearingSchema.index({ teamId: 1, nextHearingDate: 1 });

module.exports = mongoose.model('Hearing', hearingSchema);
