/*
 * Repairs pre-client-domain Case documents. Default mode is a dry run;
 * run `npm run repair:case-clients:apply` to write changes.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const LegalCase = require('../models/Case');
const { resolveCaseClient } = require('../services/caseClientService');

const apply = process.argv.includes('--apply');

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const cases = await LegalCase.find({}).select('_id teamId clientId clientName ownerId createdBy').lean();
  const Client = require('../models/Client');
  const clients = await Client.find({}).select('_id teamId').lean();
  const clientTeams = new Map(clients.map((client) => [String(client._id), String(client.teamId)]));
  const candidates = cases.filter((legalCase) => legalCase.clientName || !legalCase.clientId || clientTeams.get(String(legalCase.clientId)) !== String(legalCase.teamId));
  const result = { scanned: cases.length, candidates: candidates.length, repaired: 0, unresolved: [] };
  if (!apply) {
    result.unresolved = candidates.filter((legalCase) => !String(legalCase.clientName || '').trim()).map((legalCase) => String(legalCase._id));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const candidate of candidates) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const legalCase = await LegalCase.findById(candidate._id).session(session);
        await resolveCaseClient({ legalCase, actorId: legalCase.ownerId || legalCase.createdBy, session });
      });
      result.repaired += 1;
    } catch (error) {
      result.unresolved.push({ caseId: String(candidate._id), reason: error.message });
    } finally { await session.endSession(); }
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.unresolved.length) process.exitCode = 1;
};

main().catch((error) => { console.error('Case-client repair failed:', error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
