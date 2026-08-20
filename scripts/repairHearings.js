require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Hearing = require('../models/Hearing');
const LegalCase = require('../models/Case');

const apply = process.argv.includes('--apply');
const validHearingDate = { $exists: true, $ne: null };

const getAudit = async () => {
  const [orphaned, duplicates] = await Promise.all([
    Hearing.aggregate([
      {
        $lookup: {
          from: LegalCase.collection.name,
          let: { caseId: '$caseId', teamId: '$teamId' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$caseId'] }, { $eq: ['$teamId', '$$teamId'] }] } } }],
          as: 'case',
        },
      },
      { $match: { case: { $size: 0 } } },
      { $project: { _id: 1, teamId: 1, caseId: 1 } },
    ]),
    Hearing.aggregate([
      { $group: { _id: { teamId: '$teamId', caseId: '$caseId', hearingDate: '$hearingDate', nextHearingDate: '$nextHearingDate', courtName: '$courtName', hearingDetails: '$hearingDetails' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]),
  ]);
  return { orphaned, duplicates };
};

const recomputeCaseNextHearing = async (caseId) => {
  const next = await Hearing.findOne({ caseId, hearingDate: validHearingDate, nextHearingDate: validHearingDate })
    .sort({ nextHearingDate: 1, _id: 1 }).select('nextHearingDate').lean();
  await LegalCase.updateOne({ _id: caseId }, { $set: { nextHearingAt: next?.nextHearingDate || null } });
};

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const audit = await getAudit();
  const affectedCaseIds = new Set(audit.orphaned.map((item) => String(item.caseId)));
  audit.duplicates.forEach((group) => affectedCaseIds.add(String(group._id.caseId)));
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    orphanHearings: audit.orphaned.length,
    duplicateGroups: audit.duplicates.length,
    duplicateDocuments: audit.duplicates.reduce((total, group) => total + group.count - 1, 0),
    orphanHearingIds: audit.orphaned.map((item) => String(item._id)),
    duplicateCaseIds: audit.duplicates.map((group) => String(group._id.caseId)),
  };
  if (apply) {
    if (audit.orphaned.length) await Hearing.deleteMany({ _id: { $in: audit.orphaned.map((item) => item._id) } });
    for (const group of audit.duplicates) {
      const documents = await Hearing.find({ _id: { $in: group.ids } }).sort({ updatedAt: -1, _id: -1 }).select('_id').lean();
      await Hearing.deleteMany({ _id: { $in: documents.slice(1).map((document) => document._id) } });
    }
    const existingCaseIds = await LegalCase.find({ _id: { $in: [...affectedCaseIds] } }).select('_id').lean();
    await Promise.all(existingCaseIds.map((legalCase) => recomputeCaseNextHearing(legalCase._id)));
    result.repairedCases = existingCaseIds.length;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!apply && (result.orphanHearings || result.duplicateDocuments)) process.exitCode = 1;
};

main().catch((error) => { console.error('Hearing repair failed:', error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
