const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');
const multer = require('multer');

const allowedMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'audio/mpeg', 'audio/wav', 'audio/ogg',
  'video/mp4', 'video/webm',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (allowedMimeTypes.has(file.mimetype)) return callback(null, true);
    return callback(new Error('Unsupported chat attachment type.'));
  },
});

router.use(protect);

router.post('/send', upload.single('file'), chatController.sendMessage);
router.get('/conversations', chatController.getConversations);
router.get('/history/:partnerId', chatController.getHistory);
router.put('/read-all/:partnerId', chatController.markRead);
router.delete('/:id', chatController.deleteMessage);
// Add this to your existing chat routes file
router.post('/delete-batch', chatController.deleteBatch);
module.exports = router;
