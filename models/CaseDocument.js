const mongoose = require('mongoose');

const caseDocumentSchema = new mongoose.Schema(
  {
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 500 },
    url: { type: String, required: true, trim: true, maxlength: 4000 },
    storageProvider: { type: String, trim: true, maxlength: 100, default: 'legacy_url' },
    storageKey: { type: String, trim: true, maxlength: 1000, default: '' },
    mimeType: { type: String, trim: true, maxlength: 200, default: '' },
    sizeBytes: { type: Number, min: 0, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

caseDocumentSchema.index({ caseId: 1, createdAt: -1 });
caseDocumentSchema.index({ teamId: 1, deletedAt: 1, createdAt: -1 });

module.exports = mongoose.model('CaseDocument', caseDocumentSchema);
