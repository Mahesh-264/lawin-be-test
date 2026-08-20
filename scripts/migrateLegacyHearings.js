// Creates an active first-hearing record for normalized legacy cases that
// predate the Hearing collection but have a stored nextHearingAt value.
// Run with --apply to write; without it the script reports the candidate count.
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const LegalCase = require('../models/Case');
const Hearing = require('../models/Hearing');

const apply = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const cases = await LegalCase.find({ nextHearingAt: { $ne: null } }).lean();
  let migrated = 0;
  for (const legalCase of cases) {
    const exists = await Hearing.exists({ caseId: legalCase._id });
    if (exists) continue;
    migrated += 1;
    if (apply) {
      await Hearing.create({
        teamId: legalCase.teamId,
        caseId: legalCase._id,
        courtName: legalCase.courtName || '',
        hearingDate: legalCase.nextHearingAt,
        hearingDetails: '',
        nextHearingDate: null,
        createdBy: legalCase.createdBy || legalCase.ownerId,
        updatedBy: legalCase.updatedBy || legalCase.ownerId,
      });
    }
  }
  console.log(`Legacy hearing candidates: ${migrated}${apply ? ' migrated' : ''}`);
}

main().catch((error) => { console.error('Legacy hearing migration failed:', error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
