const streamifier = require('streamifier');
const cloudinary = require('../config/cloudinary');
const Post = require('../models/Post');
const User = require('../models/User');
const { createNotification, getDisplayName } = require('../services/notificationService');

const uploadPostAttachmentToCloudinary = (file) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'lawin_posts',
        resource_type: 'auto',
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          name: file.originalname || result.original_filename || 'Attachment',
          type: file.mimetype || result.resource_type || 'application/octet-stream',
          resourceType: result.resource_type || 'auto',
        });
      }
    );

    streamifier.createReadStream(file.buffer).pipe(stream);
  });

const formatComment = (comment) => ({
  id: comment._id,
  userId: comment.userId,
  name: comment.name || 'User',
  role: comment.role || 'user',
  text: comment.text || '',
  createdAt: comment.createdAt,
  postedAt: getRelativeTime(comment.createdAt),
});

const getUserSpecializations = (user) => {
  const userSpecializations = [];

  if (user?.role === 'student') {
    userSpecializations.push(...(user.studentProfile?.specializations || []));
  }

  if (user?.role === 'lawyer' && user.lawyerProfile?.specialization) {
    userSpecializations.push(user.lawyerProfile.specialization);
  }

  return [...new Set(userSpecializations.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
};

const getNetworkIds = (user) => {
  const ids = [
    ...(user?.connections || []),
    ...(user?.following || []),
    ...(user?.studentProfile?.connectedStudents || []),
    ...(user?.studentProfile?.followingLawyers || []),
    user?._id,
  ];

  return new Set(ids.filter(Boolean).map((item) => String(item)));
};

const getRelativeTime = (dateValue) => {
  if (!dateValue) return 'Recently posted';

  const timestamp = new Date(dateValue).getTime();
  if (Number.isNaN(timestamp)) return 'Recently posted';

  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) {
    const minutes = Math.max(1, Math.floor(diff / minute));
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (diff < day) {
    const hours = Math.max(1, Math.floor(diff / hour));
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.max(1, Math.floor(diff / day));
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const formatGeneralPost = (post, creator, viewer) => {
  const creatorSpecializations = getUserSpecializations(creator);
  const viewerSpecializations = getUserSpecializations(viewer);
  const hasSharedSpecialization = creatorSpecializations.some((item) => viewerSpecializations.includes(item))
    || (post.tags || []).some((item) => viewerSpecializations.includes(String(item).trim().toLowerCase()));

  return {
    id: post._id,
    type: post.type,
    sourceModel: 'Post',
    content: post.content,
    media: post.media || [],
    createdAt: post.createdAt,
    postedAt: getRelativeTime(post.createdAt),
    visibility: post.visibility,
    likesCount: post.likesCount || 0,
    commentsCount: post.commentsCount || 0,
    liked: (post.likedBy || []).some((id) => String(id) === String(viewer?._id)),
    comments: (post.comments || []).map(formatComment),
    tags: post.tags || [],
    title: post.title || '',
    location: post.location || '',
    stipend: post.stipend || '',
    duration: post.duration || '',
    schedule: post.schedule || '',
    createdBy: creator?._id || post.createdBy,
    creatorName: getDisplayName(creator),
    creatorRole: creator?.role || 'user',
    creatorAvatar: getDisplayName(creator).charAt(0).toUpperCase(),
    creatorProfileImage: creator?.profileImage || '',
    creatorSpecialization: creator?.lawyerProfile?.specialization || creator?.studentProfile?.specializations || [],
    specializationMatched: hasSharedSpecialization,
  };
};

const getPostNotificationLink = (post) => {
  const creatorRole = post.createdBy?.role;
  const postId = post._id;

  if (creatorRole === 'lawyer') {
    return `/lawyer-dash?section=student-interactions&tab=posts&postId=${postId}`;
  }

  if (creatorRole === 'student') {
    return `/student-home?postId=${postId}`;
  }

  return '/dashboard';
};

const getPostAudienceIds = (creator) => {
  if (creator?.role === 'lawyer') return creator.followers || [];
  if (creator?.role === 'student') {
    return [
      ...(creator.connections || []),
      ...(creator.studentProfile?.connectedStudents || []),
    ];
  }
  return [];
};

const notifyPostAudience = async ({ creator, post, io }) => {
  const audienceIds = [
    ...new Set(
      getPostAudienceIds(creator)
        .map((id) => String(id))
        .filter((id) => id && id !== String(creator._id))
    ),
  ];

  if (!audienceIds.length) return;

  await Promise.all(audienceIds.map((recipient) => createNotification({
    recipient,
    actor: creator._id,
    type: 'new_post',
    title: creator.role === 'lawyer' ? 'New lawyer post' : 'New student post',
    message: `${getDisplayName(creator)} shared a new post.`,
    link: getPostNotificationLink(post),
    metadata: { postId: post._id, creatorId: creator._id, creatorRole: creator.role },
    io,
  })));
};

const scoreFeedItem = (item, viewer, networkIds, viewerSpecializations) => {
  const creatorId = String(item.createdBy || item.lawyerId || '');
  if (networkIds.has(creatorId)) return 3;

  const creatorTags = [
    ...(item.tags || []),
    ...(Array.isArray(item.specialization) ? item.specialization : []),
    ...(Array.isArray(item.creatorSpecialization) ? item.creatorSpecialization : [item.creatorSpecialization]).filter(Boolean),
  ]
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  if (creatorTags.some((value) => viewerSpecializations.includes(value))) return 2;

  return 1;
};

const canSeePost = (post, viewer, networkIds) => {
  if (post.visibility !== 'connections') return true;
  return networkIds.has(String(post.createdBy));
};

const buildLegacyOpportunities = async (viewer, networkIds, viewerSpecializations) => {
  const appliedIds = new Set(
    (viewer?.studentProfile?.internshipApplications || []).map((item) => String(item.postId))
  );
  const joinedIds = new Set(
    (viewer?.studentProfile?.joinedJamSessions || []).map((item) => String(item.sessionId))
  );

  const lawyers = await User.find({
    role: 'lawyer',
    $or: [
      { 'lawyerProfile.internships.0': { $exists: true } },
      { 'lawyerProfile.jamSessions.0': { $exists: true } },
    ],
  }).select('firstName lastName role profileImage address lawyerProfile');

  const items = [];

  lawyers.forEach((lawyer) => {
    const creatorName = getDisplayName(lawyer);
    const creatorSpecialization = lawyer.lawyerProfile?.specialization || '';
    const creatorTags = [creatorSpecialization].map((value) => String(value).trim().toLowerCase()).filter(Boolean);
    const specializationMatched = creatorTags.some((value) => viewerSpecializations.includes(value));

    (lawyer.lawyerProfile?.internships || []).forEach((internship) => {
      items.push({
        id: internship._id,
        type: 'internship',
        sourceModel: 'LegacyInternship',
        createdAt: internship.createdAt,
        postedAt: getRelativeTime(internship.createdAt),
        createdBy: lawyer._id,
        creatorName,
        creatorRole: 'lawyer',
        creatorAvatar: creatorName.charAt(0).toUpperCase(),
        creatorProfileImage: lawyer.profileImage || '',
        creatorSpecialization,
        specialization: internship.specialization || [],
        specializationMatched: specializationMatched || (internship.specialization || [])
          .map((value) => String(value).trim().toLowerCase())
          .some((value) => viewerSpecializations.includes(value)),
        title: internship.title || 'Internship',
        content: internship.description || '',
        description: internship.description || '',
        location: internship.location || lawyer.address?.city || lawyer.address?.district || 'Not specified',
        stipend: internship.stipend || 'Not specified',
        duration: internship.duration || 'Not specified',
        applicationCount: internship.applications?.length || 0,
        applied: appliedIds.has(String(internship._id)),
        status: internship.status || 'open',
        likesCount: Array.isArray(internship.likedBy) ? internship.likedBy.length : 0,
        liked: (internship.likedBy || []).some((id) => String(id) === String(viewer?._id)),
        commentsCount: Array.isArray(internship.comments) ? internship.comments.length : 0,
        comments: (internship.comments || []).map(formatComment),
        media: [],
        tags: internship.specialization || [],
      });
    });

    (lawyer.lawyerProfile?.jamSessions || []).forEach((session) => {
      items.push({
        id: session._id,
        type: 'jam',
        sourceModel: 'LegacyJamSession',
        createdAt: session.createdAt,
        postedAt: getRelativeTime(session.createdAt),
        createdBy: lawyer._id,
        creatorName,
        creatorRole: 'lawyer',
        creatorAvatar: creatorName.charAt(0).toUpperCase(),
        creatorProfileImage: lawyer.profileImage || '',
        creatorSpecialization,
        specializationMatched,
        title: session.title || 'Jam Session',
        content: session.summary || '',
        summary: session.summary || '',
        location: session.location || lawyer.address?.city || lawyer.address?.district || 'Online / TBA',
        schedule: session.schedule || '',
        participantCount: session.participants?.length || 0,
        joined: joinedIds.has(String(session._id)),
        likesCount: Array.isArray(session.likedBy) ? session.likedBy.length : 0,
        liked: (session.likedBy || []).some((id) => String(id) === String(viewer?._id)),
        commentsCount: Array.isArray(session.comments) ? session.comments.length : 0,
        comments: (session.comments || []).map(formatComment),
        media: [],
        tags: [creatorSpecialization].filter(Boolean),
      });
    });
  });

  return items
    .map((item) => ({ ...item, priority: scoreFeedItem(item, viewer, networkIds, viewerSpecializations) }))
    .sort((first, second) => {
      if (second.priority !== first.priority) return second.priority - first.priority;
      return new Date(second.createdAt || 0) - new Date(first.createdAt || 0);
    });
};

exports.createPost = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can create posts' });
    }

    const content = String(req.body.content || '').trim();
    if (!content) {
      return res.status(400).json({ message: 'Post content is required' });
    }

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags
      : String(req.body.tags || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

    const files = Array.isArray(req.files) ? req.files.slice(0, 3) : [];
    const media = files.length
      ? await Promise.all(files.map(uploadPostAttachmentToCloudinary))
      : [];

    const post = await Post.create({
      type: ['general', 'internship', 'jam'].includes(req.body.type) ? req.body.type : 'general',
      content,
      media,
      createdBy: req.user._id,
      visibility: req.body.visibility === 'connections' ? 'connections' : 'public',
      tags,
      title: req.body.title?.trim() || '',
      location: req.body.location?.trim() || '',
      stipend: req.body.stipend?.trim() || '',
      duration: req.body.duration?.trim() || '',
      schedule: req.body.schedule?.trim() || '',
    });

    const creator = await User.findById(req.user._id).select(
      'firstName lastName role profileImage followers following connections lawyerProfile studentProfile'
    );

    await notifyPostAudience({
      creator,
      post,
      io: req.app.get('socketio'),
    });

    res.status(201).json({
      message: 'Post created',
      post: formatGeneralPost(post, creator, creator),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getFeed = async (req, res) => {
  try {
    const viewer = await User.findById(req.user._id).select(
      'firstName lastName role profileImage followers following connections lawyerProfile studentProfile'
    );

    if (!viewer) {
      return res.status(404).json({ message: 'User not found' });
    }

    const networkIds = getNetworkIds(viewer);
    const viewerSpecializations = getUserSpecializations(viewer);

    const posts = await Post.find({})
      .sort({ createdAt: -1 })
      .populate('createdBy', 'firstName lastName role profileImage lawyerProfile studentProfile');

    const formattedGeneralPosts = posts
      .filter((post) => canSeePost(post, viewer, networkIds))
      .map((post) => {
        const formatted = formatGeneralPost(post, post.createdBy, viewer);
        return {
          ...formatted,
          priority: scoreFeedItem(formatted, viewer, networkIds, viewerSpecializations),
        };
      });

    const legacyItems = await buildLegacyOpportunities(viewer, networkIds, viewerSpecializations);

    const all = [...formattedGeneralPosts, ...legacyItems].sort((first, second) => {
      if (second.priority !== first.priority) return second.priority - first.priority;
      return new Date(second.createdAt || 0) - new Date(first.createdAt || 0);
    });

    res.json({
      network: all.filter((item) => item.priority >= 3),
      suggested: all.filter((item) => item.priority < 3),
      all,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getUserPosts = async (req, res) => {
  try {
    const viewer = await User.findById(req.user._id).select(
      'firstName lastName role profileImage followers following connections lawyerProfile studentProfile'
    );

    const user = await User.findById(req.params.id).select(
      'firstName lastName role profileImage followers following connections lawyerProfile studentProfile'
    );

    if (!viewer || !user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const networkIds = getNetworkIds(viewer);
    const posts = await Post.find({ createdBy: req.params.id }).sort({ createdAt: -1 });

    const visiblePosts = posts
      .filter((post) => String(post.createdBy) === String(viewer._id) || canSeePost(post, viewer, networkIds))
      .map((post) => formatGeneralPost(post, user, viewer));

    res.json({
      posts: visiblePosts,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.toggleLike = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can react to posts' });
    }

    const post = await Post.findById(req.params.id).populate('createdBy', 'firstName lastName role');
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    post.likedBy = Array.isArray(post.likedBy) ? post.likedBy : [];
    const alreadyLiked = post.likedBy.some((id) => String(id) === String(req.user._id));

    if (alreadyLiked) {
      post.likedBy = post.likedBy.filter((id) => String(id) !== String(req.user._id));
    } else {
      post.likedBy.push(req.user._id);
      
      //  Send notification when someone likes a post
      if (String(post.createdBy._id) !== String(req.user._id)) {
        const io = req.app.get('socketio');
        await createNotification({
          recipient: post.createdBy._id,
          actor: req.user._id,
          type: 'post_liked',
          title: 'Your post was liked',
          message: `${getDisplayName(req.user)} liked your post.`,
          link: getPostNotificationLink(post),
          metadata: { postId: post._id, postContent: post.content.substring(0, 50) },
          io,
        });
      }
    }

    post.likesCount = post.likedBy.length;
    await post.save();

    res.json({
      liked: !alreadyLiked,
      likesCount: post.likesCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addComment = async (req, res) => {
  try {
    if (!['student', 'lawyer'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only students and lawyers can comment on posts' });
    }

    const text = String(req.body.text || '').trim();
    if (!text) {
      return res.status(400).json({ message: 'Comment text is required' });
    }

    const post = await Post.findById(req.params.id).populate('createdBy', 'firstName lastName role');
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    post.comments = Array.isArray(post.comments) ? post.comments : [];
    post.comments.unshift({
      userId: req.user._id,
      name: getDisplayName(req.user),
      role: req.user.role,
      text,
    });
    post.commentsCount = post.comments.length;
    await post.save();

    // 🔔 Send notification when someone comments on a post
    if (String(post.createdBy._id) !== String(req.user._id)) {
      const io = req.app.get('socketio');
      await createNotification({
        recipient: post.createdBy._id,
        actor: req.user._id,
        type: 'post_commented',
        title: 'New comment on your post',
        message: `${getDisplayName(req.user)} commented: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
        link: getPostNotificationLink(post),
        metadata: { postId: post._id, commentText: text, postContent: post.content.substring(0, 50) },
        io,
      });
    }

    res.status(201).json({
      comment: formatComment(post.comments[0]),
      commentsCount: post.commentsCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (String(post.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ message: 'You can only delete your own posts' });
    }

    await Post.findByIdAndDelete(req.params.id);

    res.json({ message: 'Post deleted successfully', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
