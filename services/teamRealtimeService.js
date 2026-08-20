const emitToUsers = (io, userIds, event, payload) => {
  if (!io) return;
  [...new Set(userIds.filter(Boolean).map(String))].forEach((userId) => {
    io.to(`user:${userId}`).emit(event, payload);
    // Existing notifications/chat use this legacy room name.
    io.to(userId).emit(event, payload);
  });
};

const emitTeamEvent = ({ io, recipientIds, event, teamId, payload = {} }) => {
  emitToUsers(io, recipientIds, event, {
    eventId: `${event}:${teamId}:${Date.now()}`,
    teamId: String(teamId),
    occurredAt: new Date().toISOString(),
    ...payload,
  });
};

module.exports = { emitTeamEvent, emitToUsers };
