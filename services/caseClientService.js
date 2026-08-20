const Client = require('../models/Client');

const trim = (value) => String(value || '').trim();
const normalizeName = (value) => trim(value).toLowerCase().replace(/\s+/g, ' ');

// Repairs pre-client-domain cases exactly once.  The Case is deliberately not
// used as a second source of client data after the link has been restored.
const resolveCaseClient = async ({ legalCase, actorId, session }) => {
  if (legalCase.clientId) {
    const referencedClient = await Client.findOne({
      _id: legalCase.clientId,
      teamId: legalCase.teamId,
    }).session(session);
    if (referencedClient) {
      if (legalCase.clientName) {
        legalCase.clientName = undefined;
        legalCase.updatedBy = actorId;
        await legalCase.save({ session });
        return { client: referencedClient, repaired: true };
      }
      return { client: referencedClient, repaired: false };
    }
  }

  const displayName = trim(legalCase.clientName);
  if (!displayName) {
    const error = new Error('Case has no client reference or legacy client name');
    error.statusCode = 422;
    throw error;
  }

  const normalizedName = normalizeName(displayName);
  let client = await Client.findOne({ teamId: legalCase.teamId, normalizedName }).session(session);
  if (!client) {
    try {
      [client] = await Client.create([{
        teamId: legalCase.teamId,
        displayName,
        normalizedName,
        createdBy: legalCase.createdBy || legalCase.ownerId || actorId,
        updatedBy: actorId,
      }], { session });
    } catch (error) {
      // A concurrent repair may have created the same team/name/blank-phone client.
      if (error?.code !== 11000) throw error;
      client = await Client.findOne({ teamId: legalCase.teamId, normalizedName }).session(session);
      if (!client) throw error;
    }
  }

  legalCase.clientId = client._id;
  legalCase.clientName = undefined;
  legalCase.updatedBy = actorId;
  await legalCase.save({ session });
  return { client, repaired: true };
};

module.exports = { normalizeName, resolveCaseClient };
