const express = require("express");
const { authorize } = require("../middleware/authMiddleware");
const { generateNoticeDraft, editNoticeDraft } = require("../controllers/noticeController");

const router = express.Router();

router.post("/generate", authorize("lawyer"), generateNoticeDraft);
router.post("/edit", authorize("lawyer"), editNoticeDraft);

module.exports = router;
