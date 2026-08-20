const express = require('express');
const teamController = require('../controllers/teamController');
const { protect, authorize } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect, authorize('lawyer'));

router.get('/workspace', teamController.getWorkspace);
router.get('/next-hearings', teamController.getMyNextHearings);
router.get('/:teamId/members/:memberId/owned-team', teamController.getMemberOwnedTeam);
router.post('/', teamController.createTeam);
router.delete('/:teamId', teamController.deleteTeam);
router.post('/join-requests', teamController.requestToJoin);
router.patch('/:teamId/join-requests/:requestId/:decision', teamController.decideJoinRequest);
router.delete('/:teamId', teamController.deleteTeam);
router.delete('/:teamId/members/:memberId', teamController.removeMember);
router.post('/:teamId/cases', teamController.createCase);
router.get('/:teamId/cases/:caseId', teamController.getCaseDetails);
router.patch('/:teamId/cases/:caseId', teamController.updateCase);
router.put('/:teamId/cases/:caseId/status', teamController.updateCase);
router.put('/:teamId/cases/:caseId', teamController.updateCase);
router.delete('/:teamId/cases/:caseId', teamController.deleteCase);
router.put('/:teamId/cases/:caseId/hearings', teamController.syncHearingHistory);
router.get('/:teamId/next-hearings', teamController.getNextHearings);
router.post('/:teamId/cases/:caseId/hearings', teamController.createHearing);
router.patch('/:teamId/cases/:caseId/hearings/:hearingId', teamController.updateHearing);
router.delete('/:teamId/cases/:caseId/hearings/:hearingId', teamController.deleteHearing);

module.exports = router;
