const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const TeamMember = require('../models/TeamMember');
const { getCaseReadScope, getAuthorizedTeamCaseScope, getOwnedCaseScopeForActiveTeams } = require('../services/teamAuthorizationService');

test('Team Owner case scope includes every case in their team', () => {
  const teamId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();
  assert.deepEqual(
    getCaseReadScope({ teamId, userId: ownerId, membership: { role: 'owner' } }),
    { teamId }
  );
});

test('Team Member case scope includes the selected team directory', () => {
  const teamId = new mongoose.Types.ObjectId();
  const memberId = new mongoose.Types.ObjectId();
  assert.deepEqual(
    getCaseReadScope({ teamId, userId: memberId, membership: { role: 'member' } }),
    { teamId }
  );
});

test('Next Hearings scope excludes closed and archived cases within the selected team', () => {
  const teamId = new mongoose.Types.ObjectId();
  const memberId = new mongoose.Types.ObjectId();
  assert.deepEqual(
    getAuthorizedTeamCaseScope({
      teamId,
      userId: memberId,
      membership: { role: 'member' },
      includeClosed: false,
      includeArchived: false,
    }),
    { teamId, status: { $ne: 'closed' }, archivedAt: null }
  );
});

test('TeamMember declares a unique active Team Owner invariant', () => {
  const indexes = TeamMember.schema.indexes();
  assert(indexes.some(([keys, options]) => (
    keys.teamId === 1 && keys.role === 1 && options.unique === true
      && options.partialFilterExpression?.role === 'owner'
      && options.partialFilterExpression?.status === 'active'
  )));
});

test('Dashboard owned-case scope requires active team ids and lawyer ownership', () => {
  const teamId = new mongoose.Types.ObjectId();
  const lawyerId = new mongoose.Types.ObjectId();
  assert.deepEqual(getOwnedCaseScopeForActiveTeams({ teamIds: [teamId], userId: lawyerId }), {
    teamId: { $in: [teamId] },
    $or: [{ ownerId: lawyerId }, { createdBy: lawyerId }, { addedBy: lawyerId }],
    status: { $ne: 'closed' },
    archivedAt: null,
  });
});
