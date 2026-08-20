require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Team = require('../models/Team');
const TeamMember = require('../models/TeamMember');
const Client = require('../models/Client');
const LegalCase = require('../models/Case');
const CaseDocument = require('../models/CaseDocument');

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  await Promise.all([Team.createIndexes(), TeamMember.createIndexes(), Client.createIndexes(), LegalCase.createIndexes(), CaseDocument.createIndexes()]);

  const [teams, members, clients, cases, documents, invalidOwnerTeams, activeTeams, activeOwners, orphanCases, orphanDocuments, invalidCaseClients] = await Promise.all([
    Team.countDocuments({ status: 'active' }),
    TeamMember.countDocuments({ status: 'active' }),
    Client.countDocuments(),
    LegalCase.countDocuments(),
    CaseDocument.countDocuments({ deletedAt: null }),
    TeamMember.aggregate([
      { $match: { status: 'active', role: 'owner' } },
      { $group: { _id: '$teamId', owners: { $sum: 1 } } },
      { $match: { owners: { $ne: 1 } } },
    ]),
    Team.find({ status: 'active' }).select('_id ownerId').lean(),
    TeamMember.find({ status: 'active', role: 'owner' }).select('teamId userId').lean(),
    LegalCase.aggregate([{ $lookup: { from: 'teams', localField: 'teamId', foreignField: '_id', as: 'team' } }, { $match: { team: { $size: 0 } } }]),
    CaseDocument.aggregate([{ $match: { deletedAt: null } }, { $lookup: { from: 'cases', localField: 'caseId', foreignField: '_id', as: 'case' } }, { $match: { case: { $size: 0 } } }]),
    LegalCase.aggregate([{ $lookup: { from: 'clients', let: { clientId: '$clientId', teamId: '$teamId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$clientId'] }, { $eq: ['$teamId', '$$teamId'] }] } } }], as: 'client' } }, { $match: { client: { $size: 0 } } }]),
  ]);
  const ownerMismatches = activeTeams.filter((team) => !activeOwners.some(
    (membership) => String(membership.teamId) === String(team._id) && String(membership.userId) === String(team.ownerId)
  ));
  const result = { teams, members, clients, cases, documents, invalidOwnerTeams: invalidOwnerTeams.length, ownerMismatches: ownerMismatches.length, orphanCases: orphanCases.length, orphanDocuments: orphanDocuments.length, invalidCaseClients: invalidCaseClients.length };
  console.log(JSON.stringify(result));
  if (result.invalidOwnerTeams || result.ownerMismatches || result.orphanCases || result.orphanDocuments || result.invalidCaseClients) process.exitCode = 1;
};

main().catch((error) => { console.error('Team domain verification failed:', error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
