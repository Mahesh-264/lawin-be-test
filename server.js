const path = require('path');
const dotenvResult = require('dotenv').config({
    path: path.join(__dirname, '.env')
});

if (process.env.SMTP_DEBUG === 'true') {
    console.log('[env] cwd:', process.cwd());
    console.log(
        '[env] loaded:',
        dotenvResult.error
            ? dotenvResult.error.message
            : path.join(__dirname, '.env')
    );
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./config/db');
const {
    createNotification,
    getDisplayName
} = require('./services/notificationService');

const seedAdminUser = require('./services/adminSeedService');
const TeamMember = require('./models/TeamMember');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);

/* =========================================================
   CORS CONFIGURATION
========================================================= */

const allowedOrigins = (
    process.env.CORS_ORIGIN ||
    'http://localhost:5173,' +
    'http://127.0.0.1:5173,' +
    'http://localhost:5174,' +
    'http://127.0.0.1:5174,' +
    'http://localhost:5175,' +
    'http://127.0.0.1:5175'
)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin(origin, callback) {

        // Allow requests without an Origin header
        // such as Postman/server-to-server requests.
        if (!origin) {
            return callback(null, true);
        }

        // Allow explicitly configured origins.
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // During local development, allow all origins.
        if (process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }

        return callback(
            new Error('Origin is not allowed by CORS')
        );
    },

    credentials: true
};

/* =========================================================
   SOCKET.IO
========================================================= */

const io = new Server(server, {
    cors: corsOptions
});

/* =========================================================
   SOCKET AUTHENTICATION
========================================================= */

io.use(async (socket, next) => {

    const token = socket.handshake.auth.token;

    if (!token) {
        return next(
            new Error('Authentication error: Token missing')
        );
    }

    try {

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        const user = await User
            .findById(decoded.id)
            .select('role accountStatus')
            .lean();

        if (
            !user ||
            (user.accountStatus &&
                user.accountStatus !== 'active')
        ) {
            return next(
                new Error(
                    'Authentication error: Account unavailable'
                )
            );
        }

        socket.userId = String(user._id);
        socket.userRole = user.role;

        next();

    } catch (err) {

        console.error(
            'Socket authentication error:',
            err.message
        );

        next(
            new Error(
                'Authentication error: Invalid token'
            )
        );
    }
});

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on('connection', async (socket) => {

    console.log(`🔗 Connected: ${socket.userId}`);

    socket.join(socket.userId);
    socket.join(`user:${socket.userId}`);

    try {

        const memberships = await TeamMember
            .find({
                userId: socket.userId,
                status: 'active'
            })
            .select('teamId')
            .lean();

        memberships.forEach((membership) => {
            socket.join(`team:${membership.teamId}`);
        });

    } catch (error) {

        console.error(
            'Unable to join team socket rooms:',
            error.message
        );
    }

    /* =====================================================
       SEND MESSAGE
    ===================================================== */

    socket.on(
        'sendMessage',
        async ({
            receiverId,
            content,
            messageType = 'text'
        }) => {

            try {

                const Message = require('./models/Message');

                const newMessage = new Message({
                    sender: socket.userId,
                    receiver: receiverId,
                    senderRole: socket.userRole,
                    messageType,
                    content,
                    timestamp: new Date()
                });

                await newMessage.save();

                const populated =
                    await newMessage.populate([
                        {
                            path: 'sender',
                            select:
                                'firstName lastName phone profileImage role lawyerProfile.specialization'
                        },
                        {
                            path: 'receiver',
                            select:
                                'firstName lastName phone profileImage role lawyerProfile.specialization'
                        }
                    ]);

                io
                    .to(socket.userId)
                    .emit('newMessage', populated);

                io
                    .to(receiverId)
                    .emit('newMessage', populated);

                await createNotification({
                    recipient: receiverId,
                    actor: socket.userId,
                    type: 'new_message',
                    title: 'New message received',
                    message:
                        `${getDisplayName(
                            populated.sender,
                            'Someone'
                        )} sent you a message.`,
                    link:
                        `/chat?partnerId=${socket.userId}`,
                    metadata: {
                        messageId: newMessage._id,
                        senderId: socket.userId,
                        receiverId
                    },
                    io
                });

            } catch (err) {

                console.error(
                    'Socket Error:',
                    err
                );

                socket.emit('error', {
                    message: 'Message failed to send'
                });
            }
        }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on('disconnect', () => {

        console.log(
            `❌ Offline: ${socket.userId}`
        );
    });

    /* =====================================================
       POST LIKED
    ===================================================== */

    socket.on(
        'postLiked',
        async ({
            postId,
            postCreatorId
        }) => {

            try {

                if (
                    String(postCreatorId) !==
                    String(socket.userId)
                ) {

                    io
                        .to(String(postCreatorId))
                        .emit(
                            'notification:update',
                            {
                                type: 'post_liked',
                                title:
                                    'Your post was liked',
                                actor:
                                    socket.userId
                            }
                        );
                }

            } catch (err) {

                console.error(
                    'Socket Error (postLiked):',
                    err
                );
            }
        }
    );

    /* =====================================================
       POST COMMENTED
    ===================================================== */

    socket.on(
        'postCommented',
        async ({
            postId,
            postCreatorId,
            comment
        }) => {

            try {

                if (
                    String(postCreatorId) !==
                    String(socket.userId)
                ) {

                    io
                        .to(String(postCreatorId))
                        .emit(
                            'notification:update',
                            {
                                type:
                                    'post_commented',
                                title:
                                    'New comment on your post',
                                actor:
                                    socket.userId,
                                comment:
                                    comment
                                        ? comment.substring(0, 50)
                                        : ''
                            }
                        );
                }

            } catch (err) {

                console.error(
                    'Socket Error (postCommented):',
                    err
                );
            }
        }
    );

    /* =====================================================
       LAWYER FOLLOWED
    ===================================================== */

    socket.on(
        'lawyerFollowed',
        async ({
            lawyerId
        }) => {

            try {

                if (
                    String(lawyerId) !==
                    String(socket.userId)
                ) {

                    io
                        .to(String(lawyerId))
                        .emit(
                            'notification:update',
                            {
                                type:
                                    'follow_accepted',
                                title:
                                    'You have a new follower',
                                actor:
                                    socket.userId
                            }
                        );
                }

            } catch (err) {

                console.error(
                    'Socket Error (lawyerFollowed):',
                    err
                );
            }
        }
    );

    /* =====================================================
       CONNECTION REQUEST
    ===================================================== */

    socket.on(
        'connectionRequested',
        async ({
            targetStudentId
        }) => {

            try {

                io
                    .to(String(targetStudentId))
                    .emit(
                        'notification:update',
                        {
                            type:
                                'student_connection_request',
                            title:
                                'New student connection request',
                            actor:
                                socket.userId
                        }
                    );

            } catch (err) {

                console.error(
                    'Socket Error (connectionRequested):',
                    err
                );
            }
        }
    );

    /* =====================================================
       APPOINTMENT STATUS
    ===================================================== */

    socket.on(
        'appointmentStatusChanged',
        async ({
            studentId,
            status
        }) => {

            try {

                const notificationType =
                    status === 'accepted'
                        ? 'appointment_accepted'
                        : 'appointment_rejected';

                io
                    .to(String(studentId))
                    .emit(
                        'notification:update',
                        {
                            type:
                                notificationType,
                            title:
                                status === 'accepted'
                                    ? 'Lawyer accepted your request'
                                    : 'Lawyer rejected your request',
                            actor:
                                socket.userId
                        }
                    );

            } catch (err) {

                console.error(
                    'Socket Error (appointmentStatusChanged):',
                    err
                );
            }
        }
    );
});

/* =========================================================
   EXPRESS CONFIGURATION
========================================================= */

app.set('socketio', io);

app.use(morgan('dev'));

app.use(express.json());

app.use(cookieParser());

app.use(cors(corsOptions));

/* =========================================================
   REQUEST LOGGER
========================================================= */

app.use((req, res, next) => {

    console.log(
        `--- [${new Date().toLocaleTimeString()}] ${req.method} ${req.url} ---`
    );

    next();
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get('/', (req, res) => {

    res.status(200).json({
        success: true,
        message: 'Lawin Backend Running 🚀',
        environment:
            process.env.NODE_ENV || 'development'
    });
});

/* =========================================================
   API ROUTES
========================================================= */

app.use(
    '/api/auth',
    require('./routes/authRoutes')
);

app.use(
    '/api/posts',
    require('./routes/postsRoutes')
);

app.use(
    '/api/ai',
    require('./routes/aiRoutes')
);

app.use(
    '/api/chat',
    require('./routes/chatRoutes')
);

app.use(
    '/api/appointments',
    require('./routes/appointmentRoutes')
);

app.use(
    '/api/notifications',
    require('./routes/notificationRoutes')
);

app.use(
    '/api/teams',
    require('./routes/teamRoutes')
);

app.use(
    '/api/calendar',
    require('./routes/calendarRoutes')
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {

    console.error(
        '❌ SERVER ERROR'
    );

    console.error(err.stack);

    res.status(500).json({
        success: false,
        message: 'Internal Server Error'
    });
});

/* =========================================================
   PORT
========================================================= */

const PORT =
    process.env.PORT || 5000;

/* =========================================================
   SERVER ERROR HANDLER
========================================================= */

server.on('error', (error) => {

    if (error.code === 'EADDRINUSE') {

        console.error(
            `Port ${PORT} is already in use.`
        );

        process.exit(1);
    }

    console.error(
        'Server failed to start:',
        error
    );

    process.exit(1);
});

/* =========================================================
   DATABASE + SERVER START
========================================================= */

connectDB()
    .then(async () => {

        console.log(
            '✅ Database connected'
        );

        await seedAdminUser();

        server.listen(
            PORT,
            '0.0.0.0',
            () => {

                console.log(
                    `🚀 Lawin Backend running on port ${PORT}`
                );

            }
        );

    })
    .catch((error) => {

        console.error(
            '❌ Database connection failed:',
            error
        );

        process.exit(1);
    });