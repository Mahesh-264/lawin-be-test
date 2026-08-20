const crypto = require('crypto');
const mongoose = require('mongoose');
const Team = require('../models/Team');
const TeamMember = require('../models/TeamMember');
const TeamJoinRequest = require('../models/TeamJoinRequest');
const Client = require('../models/Client');
const LegalCase = require('../models/Case');
const Hearing = require('../models/Hearing');
const CaseDocument = require('../models/CaseDocument');
const ActivityEvent = require('../models/ActivityEvent');
const User = require('../models/User');
const { createNotification, getDisplayName } = require('../services/notificationService');
const { recordActivity } = require('../services/activityService');
const { emitTeamEvent } = require('../services/teamRealtimeService');
const { runInTransaction } = require('../utils/transaction');
const { normalizeName, resolveCaseClient } = require('../services/caseClientService');
const { createHearingCalendarEvent, updateHearingCalendarEvent, deleteHearingCalendarEvent, deleteCalendarEventsForCase } = require('../services/hearingCalendarService');
const {
  assertObjectId,
  domainError,
  getAuthorizedTeamCaseScope,
  getOwnedCaseScopeForActiveTeams,
  requireActiveMembership,
  requireCaseAccess,
  requireTeamOwner,
} = require('../services/teamAuthorizationService');

const trim = (value) => String(value || '').trim();
const requestId = (req) => req.headers['x-request-id'] || '';
const optionalRequestReason = (body) => {
  if (body === undefined) return '';
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw domainError(400, 'Request payload must be an object');
  }
  return trim(body.reason);
};
const teamActionErrorResponse = (res, error) => res.status(error.statusCode || 500).json({
  success: false,
  message: error.message || 'Unable to update join request',
  error: { code: error.statusCode ? 'TEAM_JOIN_REQUEST_INVALID' : 'TEAM_JOIN_REQUEST_UPDATE_FAILED' },
});
const caseStatuses = new Set(['new', 'in_progress', 'hearing_scheduled', 'closed']);
const asDate = (value, label, { required = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw domainError(400, `${label} is required`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw domainError(400, `Invalid ${label.toLowerCase()}`);
  return date;
};
const asHearingDateTime = (dateValue, timeValue, label, { required = false } = {}) => {
  if (dateValue === undefined || dateValue === null || dateValue === '') {
    if (required) throw domainError(400, `${label} is required`);
    return null;
  }
  if (!timeValue && /T/.test(String(dateValue))) return asDate(dateValue, label, { required });
  const time = /^\d{2}:\d{2}$/.test(String(timeValue || '')) ? timeValue : '00:00';
  const date = new Date(`${String(dateValue).slice(0, 10)}T${time}:00+05:30`);
  if (Number.isNaN(date.getTime())) throw domainError(400, `Invalid ${label.toLowerCase()}`);
  return date;
};
const dateTimeParts = (value) => {
  const date = new Date(value);
  return {
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date),
  };
};
const caseRecipients = (legalCase, team) => [legalCase.ownerId, team.ownerId || team.owner];

const formatHearing = (hearing) => ({
  id: String(hearing._id),
  courtName: hearing.courtName || '',
  hearingDate: hearing.hearingDate,
  hearingTime: hearing.hearingTime ?? (hearing.hearingDate ? dateTimeParts(hearing.hearingDate).time : ''),
  hearingDetails: hearing.hearingDetails || '',
  nextHearing: hearing.nextHearingDate || null,
  nextHearingDate: hearing.nextHearingDate || null,
  nextHearingTime: hearing.nextHearingTime ?? (hearing.nextHearingDate ? dateTimeParts(hearing.nextHearingDate).time : ''),
  isHistorical: Boolean(hearing.isHistorical),
  createdAt: hearing.createdAt,
  updatedAt: hearing.updatedAt,
});

const recomputeNextHearing = async (legalCase, userId, session) => {
  const query = Hearing.findOne({
    caseId: legalCase._id,
    hearingDate: { $exists: true, $ne: null },
    nextHearingDate: null,
    isHistorical: { $ne: true },
  })
    .sort({ hearingDate: 1, _id: 1 })
    .select('hearingDate');
  if (session) query.session(session);
  const latest = await query.lean();
  legalCase.nextHearingAt = latest?.hearingDate || null;
  legalCase.updatedBy = userId;
  await legalCase.save(session ? { session } : undefined);
  return legalCase.nextHearingAt;
};

const generateTeamCode = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const joinCode = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    if (!(await Team.exists({ teamCode: joinCode }))) return joinCode;
  }
  throw domainError(500, 'Unable to generate a team code');
};

const parseDocuments = (value) => {
  const records = Array.isArray(value) ? value : String(value || '').split('\n');
  return records.map((item) => {
    if (typeof item === 'string') return { name: trim(item), url: trim(item) };
    return { name: trim(item?.name) || trim(item?.url), url: trim(item?.url) };
  }).filter((item) => item.name && item.url);
};

const formatMember = (member, options = {}) => ({
  id: String(member._id),
  lawyerId: member.userId?._id || member.userId,
  name: getDisplayName(member.userId, 'Lawyer'),
  email: member.userId?.email || '',
  phone: member.userId?.phone || '',
  role: member.role,
  hasTeam: Boolean(options.hasTeam),
  joinedAt: member.joinedAt,
});

const formatLegacyTeamMember = (member, options = {}) => ({
  id: String(member._id || member.lawyerId),
  lawyerId: member.lawyerId,
  name: trim(member.name) || 'Lawyer',
  email: member.email || '',
  phone: member.phone || '',
  role: options.role || 'member',
  hasTeam: Boolean(options.hasTeam),
  joinedAt: member.joinedAt || null,
});

const formatCase = (legalCase, documents = [], viewerId) => {
  const client = legalCase.clientId && typeof legalCase.clientId === 'object' ? legalCase.clientId : null;
  const caseName = legalCase.caseName || legalCase.title || legalCase.caseTitle || '';
  const briefInfo = legalCase.briefInfo || legalCase.details || legalCase.caseDetails || '';
  return {
    id: String(legalCase._id),
    clientId: client?._id || legalCase.clientId || null,
    clientName: client?.displayName || legalCase.clientName || '',
    clientPhone: client?.phone || '',
    clientAddress: client?.address || '',
    caseName,
    caseTitle: caseName,
    title: caseName,
    briefInfo,
    caseDetails: briefInfo,
    courtName: legalCase.courtName || '',
    startingDate: legalCase.startingDate || legalCase.createdAt || null,
    nextHearingDate: legalCase.nextHearingAt || null,
    hearingDate: legalCase.nextHearingAt || null,
    documents: documents.map((document) => ({ id: String(document._id), name: document.name, url: document.url })),
    status: legalCase.status || 'new',
    addedBy: legalCase.ownerId?._id || legalCase.ownerId,
    addedByName: getDisplayName(legalCase.ownerId, 'Lawyer'),
    canEdit: String(legalCase.ownerId?._id || legalCase.ownerId) === String(viewerId),
    createdAt: legalCase.createdAt,
    updatedAt: legalCase.updatedAt,
  };
};

const formatLegacyEmbeddedCase = (legacyCase, team, viewerId) => {
  const caseName = legacyCase.caseName || legacyCase.caseTitle || 'Untitled Case';
  const briefInfo = legacyCase.briefInfo || legacyCase.caseDetails || '';
  const hearingDate = legacyCase.hearingDate || null;
  return {
    id: String(legacyCase._id),
    clientId: null,
    clientName: legacyCase.clientName || '',
    clientPhone: legacyCase.clientPhone || '',
    clientAddress: legacyCase.clientAddress || '',
    caseName,
    caseTitle: caseName,
    title: caseName,
    briefInfo,
    caseDetails: briefInfo,
    courtName: legacyCase.courtName || '',
    startingDate: legacyCase.startingDate || legacyCase.createdAt || null,
    nextHearingDate: hearingDate,
    hearingDate,
    hearingTime: hearingDate ? dateTimeParts(hearingDate).time : '',
    documents: [],
    status: legacyCase.status,
    addedBy: legacyCase.addedBy || null,
    addedByName: legacyCase.addedByName || 'Lawyer',
    canEdit: String(legacyCase.addedBy?._id || legacyCase.addedBy || '') === String(viewerId),
    createdAt: legacyCase.createdAt,
    updatedAt: legacyCase.updatedAt,
    teamId: team?._id ? String(team._id) : '',
    teamName: team?.firmName || 'No team',
    teamCode: team?.teamCode || 'Not added',
  };
};

const getWorkspace = async (userId, selectedTeamId) => {
  const memberships = await TeamMember.find({ userId, status: 'active' }).lean();
  const teamIds = memberships.map((member) => member.teamId);
  const teams = await Team.find({ _id: { $in: teamIds }, status: 'active' }).sort({ updatedAt: -1 }).lean();
  if (!teams.length) {
    const legalCases = await LegalCase.find({
      $or: [{ ownerId: userId }, { createdBy: userId }, { addedBy: userId }],
      archivedAt: null,
    })
      .populate('ownerId', 'firstName lastName phone')
      .populate('clientId', 'displayName phone address')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();

    const caseIds = legalCases.map((legalCase) => legalCase._id);
    const documents = caseIds.length
      ? await CaseDocument.find({ caseId: { $in: caseIds }, deletedAt: null }).sort({ createdAt: -1 }).lean()
      : [];
    const documentsByCase = documents.reduce((map, document) => {
      const key = String(document.caseId);
      map.set(key, [...(map.get(key) || []), document]);
      return map;
    }, new Map());

    const cases = legalCases.map((legalCase) => formatCase(legalCase, documentsByCase.get(String(legalCase._id)) || [], userId));
    return { team: null, teams: [], activeTeamId: null, cases };
  }

  const selected = selectedTeamId && teams.find((team) => String(team._id) === String(selectedTeamId));
  const activeTeam = selected || teams[0];
  const membershipByTeam = new Map(memberships.map((member) => [String(member.teamId), member]));
  const activeMembership = membershipByTeam.get(String(activeTeam._id));
  const [memberRecords, pendingRequests, legalCases] = await Promise.all([
    TeamMember.find({ teamId: activeTeam._id, status: 'active' })
      .populate('userId', 'firstName lastName email phone profileImage role')
      .sort({ role: 1, joinedAt: 1 }).lean(),
    activeMembership && activeMembership.role === 'owner'
      ? TeamJoinRequest.find({ teamId: activeTeam._id, status: 'pending' })
        .populate('requesterId', 'firstName lastName email phone').sort({ requestedAt: -1 }).lean()
      : [],
    LegalCase.find(getAuthorizedTeamCaseScope({ teamId: activeTeam._id, userId, membership: activeMembership, includeArchived: false }))
      .populate('ownerId', 'firstName lastName phone')
      .populate('clientId', 'displayName phone address')
      .sort({ updatedAt: -1 }).limit(100).lean(),
  ]);
  const caseIds = legalCases.map((legalCase) => legalCase._id);
  const documents = caseIds.length
    ? await CaseDocument.find({ caseId: { $in: caseIds }, deletedAt: null }).sort({ createdAt: -1 }).lean()
    : [];
  const documentsByCase = documents.reduce((map, document) => {
    const key = String(document.caseId);
    map.set(key, [...(map.get(key) || []), document]);
    return map;
  }, new Map());
  const memberUserIds = memberRecords
    .filter((member) => member.role === 'member')
    .map((member) => member.userId?._id || member.userId)
    .filter(Boolean);
  const teamsOwnedByMembers = memberUserIds.length
    ? await Team.find({
      status: 'active',
      $or: [{ ownerId: { $in: memberUserIds } }, { owner: { $in: memberUserIds } }],
    }).select('ownerId owner').lean()
    : [];
  const memberTeamOwnerIds = new Set(teamsOwnedByMembers.map((team) => String(team.ownerId || team.owner)));
  const members = memberRecords
    .filter((member) => member.role === 'member')
    .map((member) => formatMember(member, { hasTeam: memberTeamOwnerIds.has(String(member.userId?._id || member.userId)) }));
  const workspace = {
    id: String(activeTeam._id),
    role: activeMembership?.role || 'owner',
    teamCode: activeTeam.teamCode,
    firmName: activeTeam.firmName,
    seniorLawyerName: activeTeam.seniorLawyerName,
    maxTeamSize: activeTeam.maxTeamSize,
    seniorLawyer: activeTeam.ownerId || activeTeam.owner,
    members,
    pendingRequests: pendingRequests.map((item) => ({
      id: String(item._id), lawyerId: item.requesterId?._id || item.requesterId,
      name: getDisplayName(item.requesterId, 'Lawyer'), email: item.requesterId?.email || '',
      phone: item.requesterId?.phone || '', requestedAt: item.requestedAt,
    })),
    cases: legalCases.map((legalCase) => formatCase(legalCase, documentsByCase.get(String(legalCase._id)) || [], userId)),
    createdAt: activeTeam.createdAt,
    updatedAt: activeTeam.updatedAt,
  };
  return {
    team: workspace,
    teams: teams.map((team) => ({ id: String(team._id), teamCode: team.teamCode, firmName: team.firmName, role: membershipByTeam.get(String(team._id))?.role || 'member' })),
    activeTeamId: String(activeTeam._id),
  };
};

exports.getWorkspace = async (req, res) => {
  try { res.json(await getWorkspace(req.user._id, req.query.teamId)); }
  catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

// A team owner may view the team created by a lawyer who is currently a
// member of their team. This is deliberately scoped to that relationship so
// arbitrary lawyer/team directories cannot be queried.
exports.getMemberOwnedTeam = async (req, res) => {
  try {
    assertObjectId(req.params.teamId, 'Team');
    assertObjectId(req.params.memberId, 'Team Member');
    await requireTeamOwner(req.params.teamId, req.user._id);

    const queue = [req.params.teamId];
    const visitedTeams = new Set();
    let member = null;
    while (queue.length && !member) {
      const teamId = queue.shift();
      if (visitedTeams.has(String(teamId))) continue;
      visitedTeams.add(String(teamId));
      const records = await TeamMember.find({ teamId, status: 'active' }).lean();
      member = records.find((record) => String(record.userId) === String(req.params.memberId) && record.role === 'member');
      const directMemberIds = records
        .filter((record) => record.role === 'member')
        .map((record) => record.userId)
        .filter(Boolean);
      if (directMemberIds.length) {
        const childTeams = await Team.find({
          status: 'active',
          $or: [{ ownerId: { $in: directMemberIds } }, { owner: { $in: directMemberIds } }],
        }).select('_id').lean();
        childTeams.forEach((team) => queue.push(team._id));
      }
    }
    if (!member) throw domainError(404, 'Active Team Member not found');

    const ownedTeam = await Team.findOne({
      status: 'active',
      $or: [{ ownerId: req.params.memberId }, { owner: req.params.memberId }],
    }).sort({ updatedAt: -1 }).lean();

    const memberCases = await LegalCase.find({ ownerId: req.params.memberId, archivedAt: null })
      .populate('clientId', 'displayName phone address').sort({ updatedAt: -1 }).limit(100).lean();
    if (!ownedTeam) return res.json({ lawyer: { id: String(req.params.memberId) }, cases: memberCases.map((legalCase) => formatCase(legalCase, [], req.user._id)), team: null });

    const [members, legalCases] = await Promise.all([
      TeamMember.find({ teamId: ownedTeam._id, status: 'active' })
        .populate('userId', 'firstName lastName email phone profileImage role')
        .sort({ role: 1, joinedAt: 1 }).lean(),
      LegalCase.find({ teamId: ownedTeam._id, archivedAt: null })
        .populate('ownerId', 'firstName lastName phone')
        .populate('clientId', 'displayName phone address')
        .sort({ updatedAt: -1 }).limit(100).lean(),
    ]);

    const legacyMembers = Array.isArray(ownedTeam.members) ? ownedTeam.members : [];
    const ownedTeamMemberIds = [
      ...members
        .filter((record) => record.role === 'member')
        .map((record) => record.userId?._id || record.userId),
      ...legacyMembers.map((record) => record.lawyerId),
    ].filter(Boolean);

    const ownerUserId = ownedTeam.ownerId || ownedTeam.owner;
    const ownerUser = ownerUserId ? await User.findById(ownerUserId).select('firstName lastName email phone').lean() : null;
    const formattedMembers = [];
    const seenLawyerIds = new Set();
    const addFormattedMember = (record) => {
      const lawyerId = record.lawyerId || record.userId?._id || record.userId;
      if (!lawyerId || seenLawyerIds.has(String(lawyerId))) return;
      seenLawyerIds.add(String(lawyerId));
      formattedMembers.push(record);
    };

    if (ownerUserId) {
      addFormattedMember({
        id: `owner-${String(ownerUserId)}`,
        lawyerId: ownerUserId,
        name: getDisplayName(ownerUser, 'Team Owner'),
        email: ownerUser?.email || '',
        phone: ownerUser?.phone || '',
        role: 'owner',
        hasTeam: true,
        joinedAt: ownedTeam.createdAt || null,
      });
    }

    members
      .filter((record) => record.role === 'member')
      .forEach((record) => addFormattedMember(formatMember(record)));

    const nestedOwnedTeams = ownedTeamMemberIds.length
      ? await Team.find({
        status: 'active',
        $or: [{ ownerId: { $in: ownedTeamMemberIds } }, { owner: { $in: ownedTeamMemberIds } }],
      }).select('ownerId owner').lean()
      : [];
    const nestedTeamOwnerIds = new Set(nestedOwnedTeams.map((team) => String(team.ownerId || team.owner)));

    legacyMembers.forEach((record) => {
      addFormattedMember(formatLegacyTeamMember(record, { hasTeam: nestedTeamOwnerIds.has(String(record.lawyerId)) }));
    });
    formattedMembers.forEach((record) => {
      if (record.role === 'member') record.hasTeam = nestedTeamOwnerIds.has(String(record.lawyerId));
    });

    return res.json({
      team: {
        id: String(ownedTeam._id),
        firmName: ownedTeam.firmName,
        seniorLawyerName: ownedTeam.seniorLawyerName,
        members: formattedMembers,
        cases: legalCases.map((legalCase) => formatCase(legalCase, [], req.user._id)),
      },
      lawyer: { id: String(req.params.memberId) },
      cases: memberCases.map((legalCase) => formatCase(legalCase, [], req.user._id)),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.createTeam = async (req, res) => {
  try {
    const firmName = trim(req.body.firmName);
    const seniorLawyerName = trim(req.body.seniorLawyerName) || getDisplayName(req.user, 'Team Owner');
    const maxTeamSize = Number(req.body.maxTeamSize);
    if (!firmName || !Number.isInteger(maxTeamSize) || maxTeamSize < 2) throw domainError(400, 'Firm name and a team size of at least 2 are required');
    const teamCode = await generateTeamCode();
    const team = await runInTransaction(async (session) => {
      const [created] = await Team.create([{ teamCode, firmName, seniorLawyerName, maxTeamSize, owner: req.user._id, ownerId: req.user._id, createdBy: req.user._id }], { session });
      await TeamMember.create([{ teamId: created._id, userId: req.user._id, role: 'owner', addedBy: req.user._id }], { session });
      await recordActivity({ teamId: created._id, actorId: req.user._id, entityType: 'team', entityId: created._id, action: 'team.created', after: { firmName, teamCode }, requestId: requestId(req), session });
      return created;
    });
    emitTeamEvent({ io: req.app.get('socketio'), recipientIds: [req.user._id], event: 'team:created', teamId: team._id, payload: { team: { id: String(team._id), firmName, teamCode } } });
    res.status(201).json({ message: 'Team created', ...(await getWorkspace(req.user._id, team._id)) });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

// Team data is entirely team-scoped in the normalized domain. Delete only
// records carrying this exact teamId; no user-owned records from another team
// can be reached by this cascade.
exports.deleteTeam = async (req, res) => {
  try {
    assertObjectId(req.params.teamId, 'Team');
    const { team } = await requireTeamOwner(req.params.teamId, req.user._id);
    await runInTransaction(async (session) => {
      await requireTeamOwner(req.params.teamId, req.user._id, { session });
      await Promise.all([
        TeamMember.deleteMany({ teamId: team._id }).session(session),
        TeamJoinRequest.deleteMany({ teamId: team._id }).session(session),
        Team.deleteOne({ _id: team._id }).session(session),
      ]);
    });
    emitTeamEvent({ io: req.app.get('socketio'), recipientIds: [req.user._id], event: 'team:deleted', teamId: team._id, payload: { teamId: String(team._id) } });
    res.json({ success: true, message: 'Team deleted', data: await getWorkspace(req.user._id) });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.requestToJoin = async (req, res) => {
  try {
    const teamCode = trim(req.body.teamCode).toUpperCase();
    if (!teamCode) throw domainError(400, 'Team code is required');
    const team = await Team.findOne({ teamCode, status: 'active' }).lean();
    if (!team) throw domainError(404, 'Team not found');
    if (String(team.ownerId || team.owner) === String(req.user._id)) throw domainError(400, 'You already own this team');
    const result = await runInTransaction(async (session) => {
      const member = await TeamMember.findOne({ teamId: team._id, userId: req.user._id, status: 'active' }).session(session);
      if (member) throw domainError(409, 'You are already a member of this team');
      const activeCount = await TeamMember.countDocuments({ teamId: team._id, status: 'active' }).session(session);
      if (activeCount >= team.maxTeamSize) throw domainError(409, 'This team is already full');
      const request = await TeamJoinRequest.findOneAndUpdate(
        { teamId: team._id, requesterId: req.user._id, status: 'pending' },
        { $setOnInsert: { requestedAt: new Date() } }, { upsert: true, new: true, session, setDefaultsOnInsert: true }
      );
      await recordActivity({ teamId: team._id, actorId: req.user._id, entityType: 'team_join_request', entityId: request._id, action: 'team.join_request.created', requestId: requestId(req), session });
      return request;
    });
    const teamOwnerId = team.ownerId || team.owner;
    await createNotification({ recipient: teamOwnerId, actor: req.user._id, type: 'team_join_request', title: 'New team join request', message: `${getDisplayName(req.user)} requested to join ${team.firmName}.`, link: `/lawyer-dash?section=team&teamId=${team._id}`, metadata: { teamId: team._id, requestId: result._id }, io: req.app.get('socketio') });
    emitTeamEvent({ io: req.app.get('socketio'), recipientIds: [teamOwnerId], event: 'team:join-request-created', teamId: team._id, payload: { requestId: String(result._id) } });
    res.status(202).json({ message: 'Join request sent to the Team Owner', requestPending: true, requestId: result._id });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.decideJoinRequest = async (req, res) => {
  try {
    assertObjectId(req.params.teamId, 'Team'); assertObjectId(req.params.requestId, 'Join request');
    const approved = req.params.decision === 'approve';
    if (!approved && req.params.decision !== 'reject') throw domainError(400, 'Invalid join request decision');
    // Approval has no reason by design. Rejection may include one, but it is
    // optional so an omitted JSON body is a valid request.
    const decisionReason = approved ? '' : optionalRequestReason(req.body);
    const result = await runInTransaction(async (session) => {
      const { team } = await requireTeamOwner(req.params.teamId, req.user._id, { session });
      const joinRequest = await TeamJoinRequest.findOne({ _id: req.params.requestId, teamId: team._id, status: 'pending' }).session(session);
      if (!joinRequest) throw domainError(404, 'Pending join request not found');
      if (approved) {
        const activeCount = await TeamMember.countDocuments({ teamId: team._id, status: 'active' }).session(session);
        if (activeCount >= team.maxTeamSize) throw domainError(409, 'This team is already full');
        await TeamMember.findOneAndUpdate({ teamId: team._id, userId: joinRequest.requesterId }, { $set: { role: 'member', status: 'active', joinedAt: new Date(), leftAt: null, addedBy: req.user._id, removedBy: null, removalReason: '' } }, { upsert: true, new: true, session, setDefaultsOnInsert: true });
      }
      joinRequest.status = approved ? 'approved' : 'rejected'; joinRequest.decidedAt = new Date(); joinRequest.decidedBy = req.user._id; joinRequest.decisionReason = decisionReason; await joinRequest.save({ session });
      await recordActivity({ teamId: team._id, actorId: req.user._id, entityType: 'team_join_request', entityId: joinRequest._id, action: approved ? 'team.join_request.approved' : 'team.join_request.rejected', after: { requesterId: joinRequest.requesterId }, requestId: requestId(req), session });
      return { team, joinRequest };
    });
    const type = approved ? 'team_join_accepted' : 'team_join_rejected';
    await createNotification({ recipient: result.joinRequest.requesterId, actor: req.user._id, type, title: approved ? 'Team request accepted' : 'Team request rejected', message: `${getDisplayName(req.user)} ${approved ? 'accepted' : 'rejected'} your request to join ${result.team.firmName}.`, link: `/lawyer-dash?section=team&teamId=${result.team._id}`, metadata: { teamId: result.team._id }, io: req.app.get('socketio') });
    emitTeamEvent({ io: req.app.get('socketio'), recipientIds: [req.user._id, result.joinRequest.requesterId], event: approved ? 'team:member-joined' : 'team:join-request-rejected', teamId: result.team._id, payload: { userId: String(result.joinRequest.requesterId) } });
    res.json({
      success: true,
      message: approved ? 'Join request approved' : 'Join request rejected',
      data: await getWorkspace(req.user._id, result.team._id),
    });
  } catch (error) { teamActionErrorResponse(res, error); }
};

exports.removeMember = async (req, res) => {
  try {
    assertObjectId(req.params.teamId, 'Team'); assertObjectId(req.params.memberId, 'Member');
    // A removal reason is optional. A body-less DELETE is valid.
    const removalReason = optionalRequestReason(req.body);
    const result = await runInTransaction(async (session) => {
      const isSelfLeave = String(req.params.memberId) === String(req.user._id);
      const context = isSelfLeave
        ? await requireActiveMembership(req.params.teamId, req.user._id, { session })
        : await requireTeamOwner(req.params.teamId, req.user._id, { session });
      const { team } = context;
      if (String(team.ownerId || team.owner) === String(req.params.memberId)) throw domainError(400, 'The Team Owner cannot leave or be removed');
      const member = await TeamMember.findOne({ teamId: team._id, userId: req.params.memberId, role: 'member', status: 'active' }).session(session);
      if (!member) throw domainError(404, 'Active Team Member not found');
      member.status = 'removed'; member.leftAt = new Date(); member.removedBy = req.user._id; member.removalReason = removalReason; await member.save({ session });

      // TeamMember is the normalized source of truth. `team` is deliberately
      // a lean authorization result, and legacy embedded members must not be
      // written by this route.

      const removedUser = await User.findById(req.params.memberId).session(session);
      if (removedUser && removedUser.lawyerProfile) {
        removedUser.lawyerProfile.team = {
          teamCode: '',
          firmName: '',
          seniorLawyerName: '',
          isSeniorLawyer: false,
          joinedAt: null,
        };
        await removedUser.save({ session });
      }

      await recordActivity({ teamId: team._id, actorId: req.user._id, entityType: 'team_member', entityId: member._id, action: isSelfLeave ? 'team.member.left' : 'team.member.removed', after: { userId: member.userId }, requestId: requestId(req), session });
      return { team, member, isSelfLeave };
    });
    if (!result.isSelfLeave) await createNotification({ recipient: result.member.userId, actor: req.user._id, type: 'team_member_removed', title: 'Removed from team', message: `${getDisplayName(req.user)} removed you from ${result.team.firmName}.`, link: '/lawyer-dash?section=team', metadata: { teamId: result.team._id }, io: req.app.get('socketio') });
    emitTeamEvent({ io: req.app.get('socketio'), recipientIds: [req.user._id, result.member.userId], event: 'team:member-left', teamId: result.team._id, payload: { userId: String(result.member.userId) } });
    res.json({
      success: true,
      message: result.isSelfLeave ? 'You left the team' : 'Team Member removed',
      data: await getWorkspace(req.user._id),
    });
  } catch (error) { teamActionErrorResponse(res, error); }
};

exports.createCase = async (req, res) => {
  try {
    const rawTeamId = req.params.teamId;
    const isPersonal = !rawTeamId || rawTeamId === 'personal' || rawTeamId === 'no-team' || rawTeamId === 'null' || !mongoose.isValidObjectId(rawTeamId);

    const title = trim(req.body.caseTitle || req.body.caseName || req.body.title);
    const details = trim(req.body.caseDetails || req.body.briefInfo || req.body.details);
    const clientName = trim(req.body.clientName);
    const clientPhone = trim(req.body.clientPhone);
    const clientAddress = trim(req.body.clientAddress);
    if (!title || !details || !clientName) throw domainError(400, 'Client name, case title, and case details are required');
    const status = trim(req.body.status) || 'new'; if (!caseStatuses.has(status)) throw domainError(400, 'Invalid case status');
    const hearingDate = asHearingDateTime(req.body.hearingDate ?? req.body.nextHearingDate, req.body.hearingTime ?? req.body.nextHearingTime, 'Hearing date');

    const result = await runInTransaction(async (session) => {
      let team = null;
      if (!isPersonal) {
        try {
          ({ team } = await requireActiveMembership(rawTeamId, req.user._id, { session }));
        } catch (e) {
          team = null;
        }
      }

      const normalizedName = normalizeName(clientName);
      let client;
      if (req.body.clientId && mongoose.isValidObjectId(req.body.clientId)) {
        client = await Client.findById(req.body.clientId).session(session);
      }
      if (!client) {
        const clientQuery = team ? { teamId: team._id, normalizedName, phone: clientPhone } : { createdBy: req.user._id, normalizedName, phone: clientPhone };
        client = await Client.findOne(clientQuery).session(session);
        if (!client) {
          [client] = await Client.create([{ teamId: team?._id || null, displayName: clientName, normalizedName, phone: clientPhone, address: clientAddress, createdBy: req.user._id, updatedBy: req.user._id }], { session });
        }
      }

      const startingDate = asDate(req.body.startingDate, 'Starting date');
      const [legalCase] = await LegalCase.create([{ teamId: team?._id || null, clientId: client._id, title, details, basicInfo: trim(req.body.basicInfo), courtName: trim(req.body.courtName), startingDate, status, ownerId: req.user._id, createdBy: req.user._id, updatedBy: req.user._id }], { session });
      let hearing = null;
      if (hearingDate) {
        [hearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, courtName: trim(req.body.courtName), hearingDate, hearingTime: req.body.hearingTime || '', hearingDetails: '', nextHearingDate: null, nextHearingTime: '', createdBy: req.user._id, updatedBy: req.user._id }], { session });
        await recomputeNextHearing(legalCase, req.user._id, session);
      }

      const documents = parseDocuments(req.body.documents);
      if (documents.length) await CaseDocument.insertMany(documents.map((document) => ({ teamId: team?._id || null, caseId: legalCase._id, ...document, uploadedBy: req.user._id })), { session });

      if (team) {
        await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'case', entityId: legalCase._id, action: 'case.created', after: { title, status, clientId: client._id }, requestId: requestId(req), session });
      }

      return { legalCase, team, hearing };
    });

    if (result.hearing) await createHearingCalendarEvent(result.hearing, result.legalCase);
    if (result.team) {
      emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'case.created', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), ownerId: String(req.user._id) } });
    }
    res.status(201).json({ message: 'Case created', case: formatCase(result.legalCase, [], req.user._id) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

exports.updateCase = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    const result = await runInTransaction(async (session) => {
      const { legalCase, team } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'write', { session });
      const allowed = { title: 'caseTitle', details: 'caseDetails', basicInfo: 'basicInfo', courtName: 'courtName', status: 'status' };
      const before = {}; const changedFields = [];
      Object.entries(allowed).forEach(([field, bodyField]) => {
        if (req.body[bodyField] === undefined && req.body[field] === undefined) return;
        let value = trim(req.body[bodyField] ?? req.body[field]);
        if (field === 'status' && !caseStatuses.has(value)) throw domainError(400, 'Invalid case status');
        if (String(legalCase[field] || '') !== String(value || '')) { before[field] = legalCase[field]; legalCase[field] = value; changedFields.push(field); }
      });
      let client = null; let clientChanged = false;
      if (req.body.clientPhone !== undefined || req.body.clientAddress !== undefined) {
        ({ client } = await resolveCaseClient({ legalCase, actorId: req.user._id, session }));
        const clientBefore = { phone: client.phone, address: client.address };
        if (req.body.clientPhone !== undefined) client.phone = trim(req.body.clientPhone);
        if (req.body.clientAddress !== undefined) client.address = trim(req.body.clientAddress);
        if (client.isModified('phone') || client.isModified('address')) { clientChanged = true; client.updatedBy = req.user._id; await client.save({ session }); if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'client', entityId: client._id, action: 'client.updated', changedFields: Object.keys(client.modifiedPaths()).filter((field) => ['phone', 'address'].includes(field)), before: clientBefore, after: { phone: client.phone, address: client.address }, requestId: requestId(req), session }); }
      }
      if (!changedFields.length && !clientChanged) throw domainError(400, 'No changes were supplied');
      if (changedFields.length) { legalCase.updatedBy = req.user._id; await legalCase.save({ session }); if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'case', entityId: legalCase._id, action: 'case.updated', changedFields, before, after: changedFields.reduce((data, field) => ({ ...data, [field]: legalCase[field] }), {}), requestId: requestId(req), session }); }
      return { legalCase, team, client, clientChanged, changedFields };
    });
    if (result.team) {
      emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'case.updated', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), ownerId: String(result.legalCase.ownerId), changedFields: result.changedFields } });
      if (result.changedFields.includes('status')) {
        emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'case.status.updated', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), ownerId: String(result.legalCase.ownerId), status: result.legalCase.status } });
      }
      if (result.clientChanged) emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'client.updated', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), clientId: String(result.client._id), ownerId: String(result.legalCase.ownerId) } });
    }
    res.json({ message: 'Case updated', case: formatCase(result.legalCase, [], req.user._id) });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.deleteCase = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    // References to Calendar events live on Hearing documents, so collect and
    // clean those exact IDs before the transaction removes the hearings.
    const { legalCase: calendarCase } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'delete');
    const calendarHearings = await Hearing.find({ caseId: calendarCase._id, googleEventId: { $exists: true, $ne: null } });
    await deleteCalendarEventsForCase(calendarHearings);
    const result = await runInTransaction(async (session) => {
      const { legalCase, team } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'delete', { session });
      await Promise.all([LegalCase.deleteOne({ _id: legalCase._id }).session(session), Hearing.deleteMany({ caseId: legalCase._id }).session(session), CaseDocument.updateMany({ caseId: legalCase._id }, { deletedAt: new Date(), deletedBy: req.user._id }).session(session)]);
      // Retain one immutable deletion audit record while removing historical
      // events tied to a record that no longer exists.
      await ActivityEvent.deleteMany({ caseId: legalCase._id }).session(session);
      if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'case', entityId: legalCase._id, action: 'case.deleted', before: { title: legalCase.title, ownerId: legalCase.ownerId }, requestId: requestId(req), session });
      return { legalCase, team };
    });
    if (result.team) emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'case.deleted', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), ownerId: String(result.legalCase.ownerId) } });
    res.json({ message: 'Case deleted' });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.getCaseDetails = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    const result = await runInTransaction(async (session) => {
      const { legalCase } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'read', { session });
      await resolveCaseClient({ legalCase, actorId: req.user._id, session });
      const [caseWithClient, hearings] = await Promise.all([
        LegalCase.findById(legalCase._id).populate('clientId', 'displayName phone address').populate('ownerId', 'firstName lastName').session(session).lean(),
        Hearing.find({ caseId: legalCase._id }).sort({ hearingDate: -1, _id: -1 }).session(session).lean(),
      ]);
      return { caseWithClient, hearings };
    });
    res.json({ case: { ...formatCase(result.caseWithClient, [], req.user._id), hearingHistory: result.hearings.map(formatHearing) } });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.syncHearingHistory = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    if (!Array.isArray(req.body.hearings)) throw domainError(400, 'Hearings must be an array');
    const events = [];
    const result = await runInTransaction(async (session) => {
      const { legalCase, team } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'write', { session });
      const calendarEvents = [];
      const existing = await Hearing.find({ caseId: legalCase._id }).session(session);
      const byId = new Map(existing.map((hearing) => [String(hearing._id), hearing]));
      const seenIds = new Set();
      for (const row of req.body.hearings) {
        const hearingDate = asHearingDateTime(row.hearingDate, row.hearingTime, 'Hearing date', { required: true });
        const nextHearingDate = asHearingDateTime(row.nextHearingDate ?? row.nextHearing, row.nextHearingTime, 'Next hearing date');
        if (hearingDate && nextHearingDate && nextHearingDate < hearingDate) {
          throw domainError(400, 'Next hearing date cannot be earlier than hearing date');
        }
        const hearingId = row.id || row._id;
        if (hearingId) {
          assertObjectId(hearingId, 'Hearing');
          const hearing = byId.get(String(hearingId));
          if (!hearing || seenIds.has(String(hearingId))) throw domainError(400, 'Invalid or duplicate hearing id');
          seenIds.add(String(hearingId));
          const before = { courtName: hearing.courtName, hearingDate: hearing.hearingDate, hearingDetails: hearing.hearingDetails, nextHearingDate: hearing.nextHearingDate };
          const scheduleNextHearing = !hearing.nextHearingDate && nextHearingDate;
          hearing.courtName = trim(row.courtName);
          hearing.hearingDate = hearingDate;
          hearing.hearingTime = row.hearingTime || '';
          hearing.hearingDetails = trim(row.hearingDetails);
          hearing.nextHearingDate = nextHearingDate;
          hearing.nextHearingTime = row.nextHearingTime || '';
          hearing.updatedBy = req.user._id;
          await hearing.save({ session });
          if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'hearing', entityId: hearing._id, action: 'hearing.updated', changedFields: ['courtName', 'hearingDate', 'hearingDetails', 'nextHearingDate'], before, after: hearing.toObject(), requestId: requestId(req), session });
          const event = { event: 'hearing.updated', hearingId: hearing._id, hearing };
          events.push(event); calendarEvents.push(scheduleNextHearing ? { event: 'hearing.deleted', hearingId: hearing._id, hearing } : event);
          if (scheduleNextHearing) {
            const [newHearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, courtName: hearing.courtName || legalCase.courtName, hearingDate: nextHearingDate, hearingTime: row.nextHearingTime || '', hearingDetails: '', nextHearingDate: null, nextHearingTime: '', createdBy: req.user._id, updatedBy: req.user._id }], { session });
            const nextEvent = { event: 'hearing.created', hearingId: newHearing._id, hearing: newHearing };
            events.push(nextEvent); calendarEvents.push(nextEvent);
          }
        } else {
          const isManualHistory = row.isManualHistory === true;
          const [hearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, courtName: trim(row.courtName) || legalCase.courtName, hearingDate, hearingTime: row.hearingTime || '', hearingDetails: trim(row.hearingDetails), nextHearingDate, nextHearingTime: row.nextHearingTime || '', isHistorical: isManualHistory, createdBy: req.user._id, updatedBy: req.user._id }], { session });
          if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'hearing', entityId: hearing._id, action: 'hearing.created', after: hearing.toObject(), requestId: requestId(req), session });
          const event = { event: 'hearing.created', hearingId: hearing._id, hearing };
          events.push(event); calendarEvents.push(event);
          if (!isManualHistory && nextHearingDate) {
            const [nextHearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, courtName: hearing.courtName, hearingDate: nextHearingDate, hearingTime: row.nextHearingTime || '', hearingDetails: '', nextHearingDate: null, nextHearingTime: '', createdBy: req.user._id, updatedBy: req.user._id }], { session });
            const nextEvent = { event: 'hearing.created', hearingId: nextHearing._id, hearing: nextHearing };
            events.push(nextEvent); calendarEvents.push(nextEvent);
          }
        }
      }
      for (const [id, hearing] of byId.entries()) if (!seenIds.has(id)) {
        await Hearing.deleteOne({ _id: hearing._id }).session(session);
        if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'hearing', entityId: hearing._id, action: 'hearing.deleted', before: hearing.toObject(), requestId: requestId(req), session });
        const event = { event: 'hearing.deleted', hearingId: hearing._id, hearing };
        events.push(event); calendarEvents.push(event);
      }
      const previousNextHearingAt = legalCase.nextHearingAt;
      const nextHearingAt = await recomputeNextHearing(legalCase, req.user._id, session);
      if (String(previousNextHearingAt || '') !== String(nextHearingAt || '')) {
        if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'case', entityId: legalCase._id, action: 'case.updated', changedFields: ['nextHearingAt'], before: { nextHearingAt: previousNextHearingAt }, after: { nextHearingAt }, requestId: requestId(req), session });
      }
      const hearings = await Hearing.find({ caseId: legalCase._id }).sort({ hearingDate: -1, _id: -1 }).session(session).lean();
      return { legalCase, team, hearings, calendarEvents };
    });
    for (const event of result.calendarEvents) {
      if (event.event === 'hearing.created' && !event.hearing.isHistorical && !event.hearing.nextHearingDate) await createHearingCalendarEvent(event.hearing, result.legalCase);
      if (event.event === 'hearing.updated') await updateHearingCalendarEvent(event.hearing, result.legalCase);
      if (event.event === 'hearing.deleted') await deleteHearingCalendarEvent(event.hearing);
    }
    if (result.team) {
      events.forEach(({ event, hearingId }) => emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event, teamId: result.team._id, payload: { caseId: String(result.legalCase._id), hearingId: String(hearingId), ownerId: String(result.legalCase.ownerId) } }));
      emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'case.updated', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), ownerId: String(result.legalCase.ownerId), changedFields: ['nextHearingAt'] } });
    }
    res.json({ message: 'Hearing history saved', case: { ...formatCase(result.legalCase, [], req.user._id), hearingHistory: result.hearings.map(formatHearing) } });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.getNextHearings = async (req, res) => {
  try {
    assertObjectId(req.params.teamId, 'Team');
    const { team, membership } = await requireActiveMembership(req.params.teamId, req.user._id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const caseScope = getAuthorizedTeamCaseScope({
      teamId: team._id,
      userId: req.user._id,
      membership,
      includeClosed: false,
      includeArchived: false,
    });
    const legalCases = await LegalCase.find(caseScope)
      .populate('clientId', 'displayName phone address').lean();
    const caseIds = legalCases.map((legalCase) => legalCase._id);
    const hearings = caseIds.length
      ? await Hearing.find({
        teamId: team._id,
        caseId: { $in: caseIds },
        hearingDate: { $exists: true, $ne: null },
        nextHearingDate: null,
        isHistorical: { $ne: true },
      }).sort({ hearingDate: 1, _id: 1 }).lean()
      : [];
    // A case can have historical hearings. Retain only its nearest qualifying
    // one so every eligible case has exactly one Next Hearings card.
    const nextHearingByCaseId = new Map();
    hearings.forEach((hearing) => {
      const caseId = String(hearing.caseId);
      if (!nextHearingByCaseId.has(caseId)) nextHearingByCaseId.set(caseId, hearing);
    });
    const eligibleCases = legalCases
      .filter((legalCase) => nextHearingByCaseId.has(String(legalCase._id)))
      .map((legalCase) => ({ ...legalCase, activeHearing: nextHearingByCaseId.get(String(legalCase._id)), nextHearingAt: nextHearingByCaseId.get(String(legalCase._id)).hearingDate }))
      .sort((left, right) => new Date(left.activeHearing.hearingDate) - new Date(right.activeHearing.hearingDate))
      .slice(0, limit);
    res.json({ cases: eligibleCases.map((legalCase) => ({ ...formatCase(legalCase, [], req.user._id), hearingDate: legalCase.activeHearing.hearingDate, hearingTime: dateTimeParts(legalCase.activeHearing.hearingDate).time, courtName: legalCase.activeHearing.courtName || legalCase.courtName, teamName: team.firmName, teamCode: team.teamCode })), page: 1, limit });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

// Dashboard scope: all active memberships, but only cases owned by the
// authenticated lawyer. This is deliberately not tied to the My Team switcher.
exports.getMyNextHearings = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const now = new Date();
    const activeMemberships = await TeamMember.find({ userId: req.user._id, status: 'active' }).select('teamId').lean();
    const membershipTeamIds = activeMemberships.map((membership) => membership.teamId);
    const activeTeams = membershipTeamIds.length
      ? await Team.find({ _id: { $in: membershipTeamIds }, status: 'active' }).select('_id').lean()
      : [];
    const activeTeamIds = activeTeams.map((team) => team._id);
    const [legalCases, legacyTeams] = await Promise.all([
      LegalCase.find(getOwnedCaseScopeForActiveTeams({ teamIds: activeTeamIds, userId: req.user._id }))
        .populate('clientId', 'displayName phone address')
        .populate('teamId', 'firmName teamCode')
        .lean(),
      activeTeamIds.length
        ? Team.find({
          _id: { $in: activeTeamIds },
          status: 'active',
          cases: {
            $elemMatch: {
              addedBy: req.user._id,
              hearingDate: { $gte: now },
              status: { $ne: 'closed' },
            },
          },
        })
          .select('firmName teamCode cases')
          .lean()
        : [],
    ]);
    const caseIds = legalCases.map((legalCase) => legalCase._id);
    const hearings = await (caseIds.length
      ? Hearing.find({
        caseId: { $in: caseIds },
        isHistorical: { $ne: true },
        $or: [
          { hearingDate: { $gte: now }, nextHearingDate: null },
          { nextHearingDate: { $gte: now } },
          { hearingDate: { $exists: true, $ne: null } },
        ],
      }).sort({ hearingDate: 1, _id: 1 }).lean()
      : []);
    const hearingsByCaseId = new Map();
    hearings.forEach((hearing) => {
      const key = String(hearing.caseId);
      if (!hearingsByCaseId.has(key)) hearingsByCaseId.set(key, []);
      hearingsByCaseId.get(key).push(hearing);
    });
    const migratedLegacyKeys = new Set(
      legalCases
        .filter((legalCase) => legalCase.legacyTeamId && legalCase.legacyCaseId)
        .map((legalCase) => `${String(legalCase.legacyTeamId)}:${String(legalCase.legacyCaseId)}`)
    );
    const normalizedCases = legalCases
      .map((legalCase) => {
        const caseHearings = hearingsByCaseId.get(String(legalCase._id)) || [];
        const activeHearing = caseHearings.find((hearing) => !hearing.nextHearingDate && hearing.isHistorical !== true);
        const fallbackUpcoming = caseHearings
          .filter((hearing) => hearing.nextHearingDate && new Date(hearing.nextHearingDate) >= now)
          .sort((left, right) => new Date(left.nextHearingDate) - new Date(right.nextHearingDate))[0];
        const anyHearing = caseHearings[0];
        const upcomingHearing = activeHearing || fallbackUpcoming || anyHearing || (legalCase.nextHearingAt || legalCase.startingDate ? {
          hearingDate: legalCase.nextHearingAt || legalCase.startingDate,
          hearingTime: '',
          courtName: legalCase.courtName,
        } : null);
        return upcomingHearing ? { legalCase, upcomingHearing } : null;
      })
      .filter(Boolean)
      .map((legalCase) => {
        const { legalCase: record, upcomingHearing } = legalCase;
        const team = record.teamId && typeof record.teamId === 'object' ? record.teamId : null;
        return {
          ...formatCase(record, [], req.user._id),
          hearingDate: upcomingHearing.hearingDate,
          hearingTime: upcomingHearing.hearingTime ?? dateTimeParts(upcomingHearing.hearingDate).time,
          courtName: upcomingHearing.courtName || record.courtName,
          teamId: team?._id ? String(team._id) : (record.teamId ? String(record.teamId) : ''),
          teamName: team?.firmName || 'No team',
          teamCode: team?.teamCode || 'Not added',
        };
      });
    const legacyCases = legacyTeams.flatMap((team) => (
      Array.isArray(team.cases) ? team.cases : []
    ).filter((legacyCase) => {
      if (String(legacyCase.addedBy?._id || legacyCase.addedBy || '') !== String(req.user._id)) return false;
      if (String(legacyCase.status || '').toLowerCase() === 'closed') return false;
      const hearingDateValue = legacyCase.nextHearingDate || legacyCase.hearingDate;
      if (!hearingDateValue) return false;
      const hearingDate = new Date(hearingDateValue);
      if (Number.isNaN(hearingDate.getTime()) || hearingDate < now) return false;
      return !migratedLegacyKeys.has(`${String(team._id)}:${String(legacyCase._id)}`);
    }).map((legacyCase) => formatLegacyEmbeddedCase({
      ...legacyCase,
      hearingDate: legacyCase.nextHearingDate || legacyCase.hearingDate,
    }, team, req.user._id)));
    const cases = [...normalizedCases, ...legacyCases]
      .sort((left, right) => new Date(left.hearingDate) - new Date(right.hearingDate))
      .slice(0, limit);
    res.json({ cases, page: 1, limit });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.createHearing = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    const hearingDate = asHearingDateTime(req.body.hearingDate ?? req.body.scheduledAt, req.body.hearingTime, 'Hearing date', { required: true });
    const nextHearingDate = asHearingDateTime(req.body.nextHearingDate, req.body.nextHearingTime, 'Next hearing date');
    const result = await runInTransaction(async (session) => {
      const { legalCase, team } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'write', { session });
      const [hearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, hearingDate, hearingTime: req.body.hearingTime || '', courtName: trim(req.body.courtName) || legalCase.courtName, hearingDetails: trim(req.body.hearingDetails ?? req.body.notes), nextHearingDate, nextHearingTime: req.body.nextHearingTime || '', createdBy: req.user._id, updatedBy: req.user._id }], { session });
      let nextHearing = null;
      if (nextHearingDate) [nextHearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, hearingDate: nextHearingDate, hearingTime: req.body.nextHearingTime || '', courtName: hearing.courtName, hearingDetails: '', nextHearingDate: null, nextHearingTime: '', createdBy: req.user._id, updatedBy: req.user._id }], { session });
      await recomputeNextHearing(legalCase, req.user._id, session);
      if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'hearing', entityId: hearing._id, action: 'hearing.created', after: { hearingDate, nextHearingDate }, requestId: requestId(req), session });
      return { hearing, nextHearing, legalCase, team };
    });
    if (!result.hearing.nextHearingDate) await createHearingCalendarEvent(result.hearing, result.legalCase);
    if (result.nextHearing) await createHearingCalendarEvent(result.nextHearing, result.legalCase);
    if (result.team) emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'hearing.created', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), hearingId: String(result.hearing._id), ownerId: String(result.legalCase.ownerId) } });
    res.status(201).json({ hearing: result.hearing });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.updateHearing = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    assertObjectId(req.params.hearingId, 'Hearing');
    const result = await runInTransaction(async (session) => {
      const { legalCase, team } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'write', { session });
      const hearing = await Hearing.findOne({ _id: req.params.hearingId, caseId: legalCase._id }).session(session);
      if (!hearing) throw domainError(404, 'Hearing not found');
      const wasActive = !hearing.nextHearingDate;
      ['courtName', 'hearingDetails'].forEach((field) => { if (req.body[field] !== undefined) hearing[field] = trim(req.body[field]); });
      if (req.body.hearingDate !== undefined || req.body.scheduledAt !== undefined) { hearing.hearingDate = asHearingDateTime(req.body.hearingDate ?? req.body.scheduledAt, req.body.hearingTime, 'Hearing date', { required: true }); hearing.hearingTime = req.body.hearingTime || ''; }
      if (req.body.nextHearingDate !== undefined) { hearing.nextHearingDate = asHearingDateTime(req.body.nextHearingDate, req.body.nextHearingTime, 'Next hearing date'); hearing.nextHearingTime = req.body.nextHearingTime || ''; }
      hearing.updatedBy = req.user._id; await hearing.save({ session }); await recomputeNextHearing(legalCase, req.user._id, session);
      let nextHearing = null;
      if (wasActive && hearing.nextHearingDate) [nextHearing] = await Hearing.create([{ teamId: team?._id || null, caseId: legalCase._id, hearingDate: hearing.nextHearingDate, hearingTime: hearing.nextHearingTime || '', courtName: hearing.courtName || legalCase.courtName, hearingDetails: '', nextHearingDate: null, nextHearingTime: '', createdBy: req.user._id, updatedBy: req.user._id }], { session });
      if (nextHearing) await recomputeNextHearing(legalCase, req.user._id, session);
      if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'hearing', entityId: hearing._id, action: 'hearing.updated', requestId: requestId(req), session });
      return { hearing, nextHearing, legalCase, team };
    });
    if (result.nextHearing) await deleteHearingCalendarEvent(result.hearing);
    else await updateHearingCalendarEvent(result.hearing, result.legalCase);
    if (result.nextHearing) await createHearingCalendarEvent(result.nextHearing, result.legalCase);
    if (result.team) emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'hearing.updated', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), hearingId: String(result.hearing._id), ownerId: String(result.legalCase.ownerId) } });
    res.json({ hearing: result.hearing });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};

exports.deleteHearing = async (req, res) => {
  try {
    if (req.params.teamId && mongoose.isValidObjectId(req.params.teamId)) assertObjectId(req.params.teamId, 'Team');
    assertObjectId(req.params.hearingId, 'Hearing');
    const result = await runInTransaction(async (session) => {
      const { legalCase, team } = await requireCaseAccess(req.params.caseId, req.params.teamId, req.user._id, 'delete', { session });
      const hearing = await Hearing.findOneAndDelete({ _id: req.params.hearingId, caseId: legalCase._id }, { session });
      if (!hearing) throw domainError(404, 'Hearing not found');
      await recomputeNextHearing(legalCase, req.user._id, session);
      if (team) await recordActivity({ teamId: team._id, caseId: legalCase._id, actorId: req.user._id, entityType: 'hearing', entityId: hearing._id, action: 'hearing.deleted', requestId: requestId(req), session });
      return { hearing, legalCase, team };
    });
    await deleteHearingCalendarEvent(result.hearing);
    if (result.team) emitTeamEvent({ io: req.app.get('socketio'), recipientIds: caseRecipients(result.legalCase, result.team), event: 'hearing.deleted', teamId: result.team._id, payload: { caseId: String(result.legalCase._id), hearingId: String(result.hearing._id), ownerId: String(result.legalCase.ownerId) } });
    res.json({ message: 'Hearing deleted' });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
};
