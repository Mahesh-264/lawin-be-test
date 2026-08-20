const express = require("express");
const { chatWithAI } = require("../controllers/aiController");
const { protect } = require("../middleware/authMiddleware");
const noticeRoutes = require("./noticeRoutes");

const router = express.Router();

router.use(protect);
router.post("/chat", chatWithAI);
router.use("/notice", noticeRoutes);

module.exports = router;
