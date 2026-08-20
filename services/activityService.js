const ActivityEvent = require('../models/ActivityEvent');

const recordActivity = async ({
  teamId,
  caseId = null,
  actorId = null,
  entityType,
  entityId,
  action,
  changedFields = [],
  before = null,
  after = null,
  requestId = '',
  session = null,
}) => {
  const [event] = await ActivityEvent.create([{
    teamId,
    caseId,
    actorId,
    entityType,
    entityId,
    action,
    changedFields,
    before,
    after,
    requestId,
  }], session ? { session } : undefined);
  return event;
};

module.exports = { recordActivity };
