/*
 * Normalizes the legacy embedded Team/User team data without deleting it.
 * Default mode is a safe dry run. Use `node scripts/migrateTeamDomain.js --apply`
 * only after a database backup and while MongoDB transactions are available.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Team = require('../models/Team');
const User = require('../models/User');
const TeamMember = require('../models/TeamMember');
const TeamJoinRequest = require('../models/TeamJoinRequest');
const Client = require('../models/Client');
const LegalCase = require('../models/Case');
const CaseDocument = require('../models/CaseDocument');
const { recordActivity } = require('../services/activityService');

const apply = process.argv.includes('--apply');
const normalizeName = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const summary = { teams: 0, members: 0, requests: 0, clients: 0, cases: 0, documents: 0 };

const withTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally { await session.endSession(); }
};

const ensureTeamsFromLegacyUsers = async () => {
  const owners = await User.find({ role: 'lawyer', 'lawyerProfile.team.role': 'owner', 'lawyerProfile.team.teamCode': { $exists: true, $ne: '' } }).lean();
  for (const owner of owners) {
    const legacy = owner.lawyerProfile.team;
    const code = String(legacy.teamCode).trim().toUpperCase();
    if (!code || await Team.exists({ teamCode: code })) continue;
    if (!apply) { summary.teams += 1; continue; }
    await Team.create({
      teamCode: code,
      firmName: legacy.firmName || 'Lawyer Team',
      seniorLawyerName: legacy.seniorLawyerName || `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || 'Team Owner',
      maxTeamSize: Number(legacy.maxTeamSize) || 2,
      owner: owner._id,
      ownerId: owner._id,
      createdBy: owner._id,
      members: legacy.members || [],
      pendingRequests: legacy.pendingRequests || [],
      cases: legacy.cases || [],
      createdAt: legacy.createdAt || new Date(),
    });
    summary.teams += 1;
  }
};

const migrateTeam = async (team) => withTransaction(async (session) => {
  await Team.collection.updateOne(
    { _id: team._id },
    { $set: { status: team.status || 'active', createdBy: team.createdBy || team.owner, ownerId: team.ownerId || team.owner } },
    { session }
  );
  const upsertMember = async (userId, role, joinedAt = team.createdAt) => {
    if (!userId || String(userId) === String(team.owner) && role !== 'owner') return;
    const existed = await TeamMember.exists({ teamId: team._id, userId }).session(session);
    await TeamMember.findOneAndUpdate(
      { teamId: team._id, userId },
      { $setOnInsert: { role, status: 'active', joinedAt: joinedAt || new Date(), addedBy: team.owner } },
      { upsert: true, session, setDefaultsOnInsert: true }
    );
    if (!existed) summary.members += 1;
  };

  await upsertMember(team.owner, 'owner', team.createdAt);
  for (const legacyMember of team.members || []) await upsertMember(legacyMember.lawyerId, 'member', legacyMember.joinedAt);

  for (const legacyRequest of team.pendingRequests || []) {
    if (!legacyRequest.lawyerId) continue;
    const activeMember = await TeamMember.exists({ teamId: team._id, userId: legacyRequest.lawyerId, status: 'active' }).session(session);
    if (activeMember) continue;
    const existed = await TeamJoinRequest.exists({ teamId: team._id, requesterId: legacyRequest.lawyerId, status: 'pending' }).session(session);
    if (!existed) {
      await TeamJoinRequest.create([{ teamId: team._id, requesterId: legacyRequest.lawyerId, status: 'pending', requestedAt: legacyRequest.requestedAt || team.createdAt }], { session });
      summary.requests += 1;
    }
  }

  for (const legacyCase of team.cases || []) {
    const legacyCaseId = String(legacyCase._id);
    if (await LegalCase.exists({ legacyTeamId: String(team._id), legacyCaseId }).session(session)) continue;
    const ownerId = legacyCase.addedBy || team.owner;
    const clientName = String(legacyCase.clientName || 'Unknown Client').trim();
    const normalizedName = normalizeName(clientName) || 'unknown client';
    let client = await Client.findOne({ teamId: team._id, normalizedName }).session(session);
    if (!client) {
      [client] = await Client.create([{ teamId: team._id, displayName: clientName, normalizedName, createdBy: ownerId, updatedBy: ownerId }], { session });
      summary.clients += 1;
    }
    const [created] = await LegalCase.create([{
      teamId: team._id, clientId: client._id, clientName,
      title: legacyCase.caseTitle || 'Untitled Case', details: legacyCase.caseDetails || legacyCase.basicInfo || 'Legacy case details unavailable',
      basicInfo: legacyCase.basicInfo || '', courtName: legacyCase.courtName || '', hearingDate: undefined,
      nextHearingAt: legacyCase.hearingDate || null, status: legacyCase.status || 'new',
      ownerId, createdBy: ownerId, updatedBy: ownerId,
      legacyTeamId: String(team._id), legacyCaseId,
      createdAt: legacyCase.createdAt || team.createdAt, updatedAt: legacyCase.updatedAt || legacyCase.createdAt || team.createdAt,
    }], { session });
    summary.cases += 1;
    const documents = Array.isArray(legacyCase.documents) ? legacyCase.documents.filter((document) => document?.url || document?.name) : [];
    if (documents.length) {
      await CaseDocument.insertMany(documents.map((document) => ({ teamId: team._id, caseId: created._id, name: document.name || document.url, url: document.url || document.name, uploadedBy: ownerId })), { session });
      summary.documents += documents.length;
    }
    await recordActivity({ teamId: team._id, caseId: created._id, actorId: ownerId, entityType: 'case', entityId: created._id, action: 'case.migrated_from_legacy', after: { legacyTeamId: String(team._id), legacyCaseId }, session });
  }
});

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  await ensureTeamsFromLegacyUsers();
  const teams = await Team.find({}).lean();
  if (!apply) {
    summary.teams += teams.length;
    for (const team of teams) {
      summary.members += 1 + (team.members || []).length;
      summary.requests += (team.pendingRequests || []).length;
      summary.cases += (team.cases || []).length;
      summary.documents += (team.cases || []).reduce((count, legacyCase) => count + (legacyCase.documents || []).length, 0);
    }
    console.log('Dry run only. No data changed. Estimated legacy records:', summary);
    return;
  }
  for (const team of teams) await migrateTeam(team);
  console.log('Migration complete:', summary);
};

main().catch((error) => { console.error('Team domain migration failed:', error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
