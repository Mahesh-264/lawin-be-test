const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema(
  {
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
    type: { type: String, enum: ['individual', 'organization'], default: 'individual' },
    displayName: { type: String, required: true, trim: true, maxlength: 200 },
    normalizedName: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

clientSchema.index({ teamId: 1, normalizedName: 1 });
// Name + phone is the team-scoped client identity used by case creation.
clientSchema.index({ teamId: 1, normalizedName: 1, phone: 1 }, { unique: true });
clientSchema.index({ teamId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('Client', clientSchema);
