const Message = require("../models/Message");
const User = require("../models/User");
const cloudinary = require("../config/cloudinary");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const mongoose = require("mongoose");
const { createNotification, getDisplayName } = require("../services/notificationService");

// --- Helper: Cloudinary Upload ---
const getUploadDetails = (file) => {
  if (file.mimetype.startsWith('image/')) return { messageType: 'image', resourceType: 'image' };
  if (file.mimetype.startsWith('audio/')) return { messageType: 'audio', resourceType: 'video' };
  if (file.mimetype.startsWith('video/')) return { messageType: 'video', resourceType: 'video' };
  return { messageType: 'document', resourceType: 'raw' };
};

const getStoredResourceType = (message) => (
  message.attachment?.resourceType
  || (message.messageType === 'audio' || message.messageType === 'video' ? 'video' : 'image')
);

// Exported for the upload regression test; routes only use the controller actions below.
exports.getUploadDetails = getUploadDetails;

const fallbackExtensions = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

const getFileExtension = (file) => (
  path.extname(path.basename(file.originalname || '')).toLowerCase()
  || fallbackExtensions[file.mimetype]
  || ''
);

exports.getFileExtension = getFileExtension;

const uploadToCloudinary = async (file) => {
  const { resourceType } = getUploadDetails(file);
  const originalName = path.basename(file.originalname || `attachment${getFileExtension(file)}`);
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'lawin-chat-'));
  const tempFilePath = path.join(tempDirectory, `${randomUUID()}${getFileExtension(file)}`);

  try {
    // upload_stream receives only bytes, so Cloudinary cannot reliably retain a
    // raw file's extension/format. upload() receives an extension-bearing file.
    await fs.writeFile(tempFilePath, file.buffer);
    const result = await cloudinary.uploader.upload(tempFilePath, {
      folder: "legal_chat_media",
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true,
      filename_override: originalName,
    });

    if (!result) throw new Error('Cloudinary did not return an upload result.');

    console.log({
      originalname: file.originalname,
      mimetype: file.mimetype,
      resource_type: result.resource_type,
      secure_url: result.secure_url,
      format: result.format,
    });

    return {
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      mimeType: file.mimetype,
      originalName: file.originalname,
      size: file.size,
    };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

exports.uploadToCloudinary = uploadToCloudinary;

// 🟢 1. SEND MESSAGE
exports.sendMessage = async (req, res) => {
  try {
    const { receiverId, messageType, content, contextId, contextLabel } = req.body;
    const newMessageData = {
      sender: req.user.id,
      receiver: receiverId,
      senderRole: req.user.role,
      messageType: messageType || 'text',
      content,
      timestamp: new Date(),
      contextId: contextId ? String(contextId) : null,
      contextLabel: contextLabel ? String(contextLabel).slice(0, 300) : null,
    };

    if (req.file) {
      const uploadResult = await uploadToCloudinary(req.file);
      // File metadata is the source of truth; never let a client messageType
      // force a PDF onto Cloudinary's image delivery endpoint.
      newMessageData.messageType = getUploadDetails(req.file).messageType;
      newMessageData.mediaUrl = uploadResult.url;
      newMessageData.mediaPublicId = uploadResult.publicId;
      newMessageData.attachment = uploadResult;
    }

    const message = await Message.create(newMessageData);
    
    const populated = await message.populate([
      { path: "sender", select: "firstName lastName phone profileImage role lawyerProfile.specialization" },
      { path: "receiver", select: "firstName lastName phone profileImage role lawyerProfile.specialization" },
    ]);

    const io = req.app.get("socketio");
    if (io) {
      io.to(req.user.id.toString()).emit("newMessage", populated);
      io.to(receiverId.toString()).emit("newMessage", populated);
    }
    await createNotification({
      recipient: receiverId,
      actor: req.user._id,
      type: 'new_message',
      title: 'New message received',
      message: `${getDisplayName(req.user, 'Someone')} sent you a ${newMessageData.messageType} message.`,
      link: `/chat?partnerId=${req.user._id}`,
      metadata: { messageId: message._id, senderId: req.user._id, receiverId },
      io,
    });
    res.status(201).json({ success: true, message: populated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 🟡 2. GET CONVERSATIONS
exports.getConversations = async (req, res) => {
  try {
    const myId = new mongoose.Types.ObjectId(req.user.id);
    const chatList = await Message.aggregate([
      { $match: { $or: [{ sender: myId }, { receiver: myId }] } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: { $cond: [{ $eq: ["$sender", myId] }, "$receiver", "$sender"] },
          lastMessage: { $first: "$content" },
          lastMessageType: { $first: "$messageType" },
          timestamp: { $first: "$timestamp" },
          unreadCount: {
            $sum: { $cond: [{ $and: [{ $eq: ["$receiver", myId] }, { $eq: ["$read", false] }] }, 1, 0] }
          }
        }
      },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "contactInfo" } },
      { $unwind: "$contactInfo" },
      {
        $project: {
          _id: 1, lastMessage: 1, lastMessageType: 1, timestamp: 1, unreadCount: 1,
          contact: {
            _id: "$contactInfo._id",
            name: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ["$contactInfo.firstName", ""] },
                    " ",
                    { $ifNull: ["$contactInfo.lastName", ""] }
                  ]
                }
              }
            },
            profileImage: "$contactInfo.profileImage", // 🚨 FIX IS HERE: Included profileImage
            phone: "$contactInfo.phone",
            role: "$contactInfo.role",
            specialization: "$contactInfo.lawyerProfile.specialization"
          }
        }
      },
      { $sort: { timestamp: -1 } }
    ]);
    res.status(200).json({ success: true, chatList });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 🔵 3. GET HISTORY
exports.getHistory = async (req, res) => {
  try {
    const myId = new mongoose.Types.ObjectId(req.user.id);
    const partnerId = new mongoose.Types.ObjectId(req.params.partnerId);
    const contextId = req.query.contextId ? String(req.query.contextId) : null;
    const query = { $or: [{ sender: myId, receiver: partnerId }, { sender: partnerId, receiver: myId }] };
    if (contextId) query.contextId = contextId;
    const messages = await Message.find(query).sort({ timestamp: 1 });
    res.status(200).json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 🟠 4. MARK READ
exports.markRead = async (req, res) => {
  try {
    await Message.updateMany(
      { sender: req.params.partnerId, receiver: req.user.id, read: false },
      { $set: { read: true } }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 🔴 5. SINGLE DELETE
exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message || message.sender.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    if (message.mediaPublicId) {
      await cloudinary.uploader.destroy(message.mediaPublicId, { resource_type: getStoredResourceType(message) });
    }

    await Message.findByIdAndDelete(req.params.id);

    const io = req.app.get("socketio");
    if (io) {
      io.to(message.sender.toString()).emit("messageDeleted", req.params.id);
      io.to(message.receiver.toString()).emit("messageDeleted", req.params.id);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 🔥 6. BATCH DELETE (Multiple Selection)
exports.deleteBatch = async (req, res) => {
  try {
    const { ids } = req.body; 
    const myId = req.user.id;

    const messages = await Message.find({ _id: { $in: ids }, sender: myId });
    
    if (messages.length === 0) return res.status(404).json({ success: false, message: "No messages found" });

    const cloudinaryDeletions = messages
      .filter(m => m.mediaPublicId)
      .map(m => {
        return cloudinary.uploader.destroy(m.mediaPublicId, { resource_type: getStoredResourceType(m) });
      });
    
    await Promise.all(cloudinaryDeletions);

    await Message.deleteMany({ _id: { $in: ids }, sender: myId });

    const io = req.app.get("socketio");
    if (io) {
      messages.forEach(m => {
        io.to(m.sender.toString()).emit("messageDeleted", m._id);
        io.to(m.receiver.toString()).emit("messageDeleted", m._id);
      });
    }

    res.status(200).json({ success: true, deletedIds: ids });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
