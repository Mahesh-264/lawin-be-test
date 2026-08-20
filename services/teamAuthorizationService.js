const mongoose = require('mongoose');
const Team = require('../models/Team');
const TeamMember = require('../models/TeamMember');
const Case = require('../models/Case');

const domainError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const assertObjectId = (value, label = 'Resource') => {
  if (!mongoose.isValidObjectId(value)) throw domainError(400, `Invalid ${label.toLowerCase()} id`);
};

const getActiveMembership = async (teamId, userId, options = {}) => {
  assertObjectId(teamId, 'Team');
  const query = TeamMember.findOne({ teamId, userId, status: 'active' });
  if (options.session) query.session(options.session);
  return query.lean();
};

const requireActiveMembership = async (teamId, userId, options = {}) => {
  const team = await Team.findOne({ _id: teamId, status: 'active' }).session(options.session || null).lean();
  const membership = await getActiveMembership(teamId, userId, options);
  if (!team) throw domainError(404, 'Team not found');
  if (!membership) throw domainError(403, 'You are not an active member of this team');
  return { team, membership };
};

const requireTeamOwner = async (teamId, userId, options = {}) => {
  const context = await requireActiveMembership(teamId, userId, options);
  const ownerId = context.team.ownerId || context.team.owner;
  if (context.membership.role !== 'owner' || String(ownerId) !== String(userId)) {
    throw domainError(403, 'Only the Team Owner can perform this action');
  }
  return context;
};

// Cases belong to lawyers independently of team life-cycle.
// When viewing a team workspace or My Cases, a lawyer sees:
// 1. All cases created in the active team.
// 2. All cases owned/created by the lawyer across any team view.
const getCaseReadScope = ({ teamId, userId }) => {
  if (userId && teamId) {
    return {
      $or: [
        { teamId },
        { ownerId: userId },
        { createdBy: userId },
        { addedBy: userId },
      ],
    };
  }
  if (userId) {
    return {
      $or: [
        { ownerId: userId },
        { createdBy: userId },
        { addedBy: userId },
      ],
    };
  }
  return { teamId };
};

// Dashboard "My Cases" and Next Hearings query owned cases across all teams.
const getOwnedCaseScopeForActiveTeams = ({ teamIds, userId }) => {
  const scope = {
    $or: [
      { ownerId: userId },
      { createdBy: userId },
      { addedBy: userId },
    ],
    status: { $ne: 'closed' },
    archivedAt: null,
  };
  if (teamIds && teamIds.length) {
    scope.$or.unshift({ teamId: { $in: teamIds } });
  }
  return scope;
};

const getAuthorizedTeamCaseScope = ({ teamId, userId, membership, includeClosed = true, includeArchived = true }) => {
  const scope = getCaseReadScope({ teamId, userId, membership });
  if (!includeClosed) scope.status = { $ne: 'closed' };
  if (!includeArchived) scope.archivedAt = null;
  return scope;
};

const requireCaseAccess = async (caseId, teamId, userId, action = 'read', options = {}) => {
  assertObjectId(caseId, 'Case');
  const query = Case.findById(caseId);
  if (options.session) query.session(options.session);
  const legalCase = await query;
  if (!legalCase) throw domainError(404, 'Case not found');

  const isCaseOwner = String(legalCase.ownerId) === String(userId) ||
                      String(legalCase.createdBy) === String(userId) ||
                      String(legalCase.addedBy) === String(userId);

  let team = null;
  let membership = null;

  if (teamId && mongoose.isValidObjectId(teamId)) {
    team = await Team.findOne({ _id: teamId, status: 'active' }).session(options.session || null).lean();
    if (team) {
      membership = await getActiveMembership(teamId, userId, options);
    }
  }

  if (!team && legalCase.teamId) {
    team = await Team.findOne({ _id: legalCase.teamId, status: 'active' }).session(options.session || null).lean();
    if (team) {
      membership = await getActiveMembership(legalCase.teamId, userId, options);
    }
  }

  if (isCaseOwner) {
    return {
      team: team || { _id: legalCase.teamId, firmName: 'My Cases' },
      membership: membership || { role: 'owner' },
      legalCase,
      isCaseOwner: true,
    };
  }

  if (!membership) {
    throw domainError(403, 'You do not have access to this case');
  }

  if (action !== 'read') {
    throw domainError(403, 'Only the case owner can modify or delete this case');
  }

  return { team, membership, legalCase, isCaseOwner: false };
};

module.exports = {
  assertObjectId,
  domainError,
  getActiveMembership,
  getCaseReadScope,
  getOwnedCaseScopeForActiveTeams,
  getAuthorizedTeamCaseScope,
  requireActiveMembership,
  requireCaseAccess,
  requireTeamOwner,
};
