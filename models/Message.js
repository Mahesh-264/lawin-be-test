const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // 🟢 FIX 1: Added 'vendor' and 'doctor' to match your other app roles
  senderRole: {
    type: String,
    required: true,
    enum: ['user', 'lawyer', 'admin', 'vendor', 'doctor'], 
  },
  // 🟢 FIX 2: Added 'video' so Cloudinary video uploads don't crash the DB
  messageType: {
    type: String,
    enum: ['text', 'image', 'audio', 'video', 'document'], 
    default: 'text'
  },
  content: { 
    type: String, 
    required: function() { return this.messageType === 'text'; } 
  },
  // Kept for backwards compatibility with existing chat messages.
  mediaUrl: String,
  mediaPublicId: String,
  attachment: {
    url: { type: String, trim: true },
    publicId: { type: String, trim: true },
    resourceType: { type: String, enum: ['image', 'video', 'raw'] },
    mimeType: { type: String, trim: true },
    originalName: { type: String, trim: true },
    size: { type: Number, min: 0 },
  },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
  // Optional context for embedded case/hearing conversations.
  contextId: { type: String, trim: true, default: null },
  contextLabel: { type: String, trim: true, default: null },
});

module.exports = mongoose.model('Message', MessageSchema);
