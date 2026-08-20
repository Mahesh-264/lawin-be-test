require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const assert = require('assert');
const mongoose = require('mongoose');
const TeamMember = require('../models/TeamMember');
const LegalCase = require('../models/Case');
const { getCaseReadScope } = require('../services/teamAuthorizationService');

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const member = await TeamMember.findOne({ status: 'active', role: 'member' }).lean();
  if (!member) { console.log(JSON.stringify({ skipped: 'No active Team Member exists to validate member case scope.' })); return; }
  const owner = await TeamMember.findOne({ teamId: member.teamId, status: 'active', role: 'owner' }).lean();
  assert(owner, 'Each member Team must have an active Team Owner');
  const ownerScope = getCaseReadScope({ teamId: member.teamId, userId: owner.userId, membership: owner });
  const memberScope = getCaseReadScope({ teamId: member.teamId, userId: member.userId, membership: member });
  assert.deepStrictEqual(ownerScope, { teamId: member.teamId });
  assert.deepStrictEqual(memberScope, { teamId: member.teamId, ownerId: member.userId });
  const visibleCases = await LegalCase.find(memberScope).select('ownerId').lean();
  const leaked = visibleCases.filter((legalCase) => String(legalCase.ownerId) !== String(member.userId)).length;
  assert.strictEqual(leaked, 0, 'Member scope must never include another lawyer\'s case');
  console.log(JSON.stringify({ validatedTeamId: String(member.teamId), ownerScope: 'all team cases', memberScope: 'only own cases', leakedCases: leaked }));
};

main().catch((error) => { console.error('Team authorization verification failed:', error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
