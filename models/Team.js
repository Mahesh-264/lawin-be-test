const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
  lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: String,
  email: String,
  phone: String,
  joinedAt: { type: Date, default: Date.now },
}, { _id: true });

const teamRequestSchema = new mongoose.Schema({
  lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: String,
  email: String,
  phone: String,
  requestedAt: { type: Date, default: Date.now },
}, { _id: true });

const hearingHistoryItemSchema = new mongoose.Schema({
  courtName: { type: String, default: '' },
  hearingDate: { type: Date, default: null },
  hearingDetails: { type: String, default: '' },
  nextHearing: { type: Date, default: null },
}, { _id: true });

const teamCaseSchema = new mongoose.Schema({
  clientName: String,
  clientPhone: String,
  clientAddress: String,
  caseName: String,
  caseTitle: String,
  briefInfo: String,
  caseDetails: String,
  courtName: String,
  startingDate: Date,
  nextHearingDate: Date,
  hearingDate: Date,
  hearingHistory: [hearingHistoryItemSchema],
  status: {
    type: String,
    enum: ['new', 'in_progress', 'hearing_scheduled', 'closed'],
    default: 'new',
  },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  addedByName: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: true });

const teamSchema = new mongoose.Schema({
  teamCode: { type: String, uppercase: true, trim: true, unique: true, required: true },
  firmName: { type: String, required: true },
  seniorLawyerName: { type: String, required: true },
  maxTeamSize: { type: Number, min: 2, required: true },
  // `owner` is retained only for legacy records/routes during migration.
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  // The normalized, team-scoped owner identity. It must match exactly one
  // active TeamMember with role `owner`.
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true,
  },
  settings: {
    allowJoinRequests: { type: Boolean, default: true },
  },
  // Legacy embedded fields. They remain only until the migration and API
  // cutover phases are complete; new normalized writes must not target them.
  members: [teamMemberSchema],
  pendingRequests: [teamRequestSchema],
  cases: [teamCaseSchema],
}, { timestamps: true });

teamSchema.index({ owner: 1 });
teamSchema.index({ ownerId: 1, status: 1 });
teamSchema.index({ createdBy: 1, status: 1 });
teamSchema.index({ 'members.lawyerId': 1 });
teamSchema.index({ 'pendingRequests.lawyerId': 1 });

module.exports = mongoose.model('Team', teamSchema);
