const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const isValidLatitude = (value) => Number.isFinite(value) && value >= -90 && value <= 90;
const isValidLongitude = (value) => Number.isFinite(value) && value >= -180 && value <= 180;

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  age: { type: Number, min: 0, max: 150 },
  gender: { type: String, trim: true },
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, required: true },
  password: { type: String, required: false, select: false }, // optional for pure OTP users
  role: { type: String, enum: ['user', 'lawyer', 'student', 'admin'], default: 'user' },
  authProvider: {
    type: String,
    enum: ['email', 'google', 'both'],
    default: 'email',
  },
  googleId: { type: String, unique: true, sparse: true },
  verified: { type: Boolean, default: true },
  emailVerified: { type: Boolean, default: true },
  phoneVerified: { type: Boolean, default: true },
  accountStatus: {
    type: String,
    enum: ['active', 'pending_approval', 'rejected', 'suspended', 'blocked', 'deleted'],
    default: 'active',
  },
  profilePicture: { type: String, default: '' },
  profileImage: { type: String, default: "" },
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  connections: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  address: {
    latitude: Number,
    longitude: Number,
    pincode: String,
    state: String,
    district: String,
    city: String, // Added city for location filtering
    country: { type: String, default: "India" },
  },
  // GeoJSON coordinates power geospatial discovery queries for nearby lawyers.
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      default: undefined,
    },
  },
  refreshToken: String,
  googleCalendar: {
    connected: { type: Boolean, default: false },
    email: { type: String, trim: true, lowercase: true },
    // This token is server-side only. It is intentionally never returned by
    // the calendar status endpoint or included in any client payload.
    refreshToken: { type: String, select: false },
  },
  otp: { type: String, select: false },
  otpExpires: { type: Date, select: false },
  resetOtpHash: { type: String, select: false },
  resetOtpExpiresAt: { type: Date, select: false },
  resetResendAvailableAt: { type: Date, select: false },
  resetAttemptCount: { type: Number, default: 0, select: false },
  lawyerProfile: {
    barId: String,
    specialization: String, // e.g., "Criminal", "Civil"
    experienceYears: Number,
    about: String, // Added for the "About" section in profile
    successRate: { type: Number, default: 0 }, // Added for UI
    casesHandled: { type: Number, default: 0 }, // Added for UI
    languages: [String], // e.g., ["Hindi", "English"]
    consultationFee: { type: Number, default: 500 }, // Added fee
    rating: { type: Number, default: 4.8 },
    isVerified: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: true },
    team: {
      role: { type: String, enum: ['owner', 'member'] },
      teamCode: { type: String, uppercase: true, trim: true },
      firmName: String,
      seniorLawyerName: String,
      maxTeamSize: { type: Number, min: 2 },
      seniorLawyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      members: [
        {
          lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          name: String,
          email: String,
          phone: String,
          joinedAt: { type: Date, default: Date.now },
        }
      ],
      pendingRequests: [
        {
          lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          name: String,
          email: String,
          phone: String,
          requestedAt: { type: Date, default: Date.now },
        }
      ],
      cases: [
        {
          clientName: String,
          caseTitle: String,
          caseDetails: String,
          basicInfo: String,
          courtName: String,
          hearingDate: Date,
          documents: [
            {
              name: String,
              url: String,
            }
          ],
          status: {
            type: String,
            enum: ['new', 'in_progress', 'hearing_scheduled', 'closed'],
            default: 'new',
          },
          addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          addedByName: String,
          createdAt: { type: Date, default: Date.now },
          updatedAt: { type: Date, default: Date.now },
        }
      ],
      createdAt: { type: Date, default: Date.now },
      joinedAt: Date,
    },
    internships: [
      {
        title: String,
        firm: String,
        specialization: [String],
        description: String,
        duration: String,
        location: String,
        stipend: String,
        skills: [String],
        status: { type: String, enum: ['open', 'closed'], default: 'open' },
        likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        comments: [
          {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: String,
            role: String,
            text: String,
            createdAt: { type: Date, default: Date.now },
          }
        ],
        applications: [
          {
            studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            firstName: String,
            lastName: String,
            email: String,
            phone: String,
            collegeName: String,
            degree: String,
            yearOfStudy: String,
            skills: [String],
            resumeLink: String,
            resumeUrl: String,
            resumePublicId: String,
            resumeFileName: String,
            coverMessage: String,
            linkedIn: String,
            portfolio: String,
            status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
            submittedAt: { type: Date, default: Date.now },
          }
        ],
        createdAt: { type: Date, default: Date.now },
      }
    ],
    certificates: [
      {
        name: String,
        fileUrl: String,
        fileName: String,
        description: String,
      }
    ],
    jamSessions: [
      {
        title: String,
        topic: String,
        summary: String,
        schedule: String,
        location: String,
        participants: [
          {
            studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: String,
            email: String,
            collegeName: String,
            yearOfStudy: String,
            joinedAt: { type: Date, default: Date.now },
          }
        ],
        likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
        comments: [
          {
            userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            name: String,
            role: String,
            text: String,
            createdAt: { type: Date, default: Date.now },
          }
        ],
        createdAt: { type: Date, default: Date.now },
      }
    ]
  },
  studentProfile: {
    collegeName: String,
    collegeEmail: String,
    bio: String,
    currentYear: String,
    specializations: [String],
    skills: [String],
    internshipApplications: [
      {
        postId: { type: mongoose.Schema.Types.ObjectId },
        lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        title: String,
        status: { type: String, default: 'applied' },
        appliedAt: { type: Date, default: Date.now },
      }
    ],
    joinedJamSessions: [
      {
        sessionId: { type: mongoose.Schema.Types.ObjectId },
        lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        title: String,
        joinedAt: { type: Date, default: Date.now },
      }
    ],
    internships: [
      {
        role: String,
        org: String,
        period: String,
        description: String,
      }
    ],
    followingLawyers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    connectedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    connectionRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    outgoingConnectionRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  }
}, { timestamps: true });

// Keep legacy address latitude/longitude in sync with the GeoJSON search field.
userSchema.pre('validate', function syncGeoLocation() {
  const addressLatitude = Number(this.address?.latitude);
  const addressLongitude = Number(this.address?.longitude);

  if (isValidLatitude(addressLatitude) && isValidLongitude(addressLongitude)) {
    this.address.latitude = addressLatitude;
    this.address.longitude = addressLongitude;
    this.location = {
      type: 'Point',
      coordinates: [addressLongitude, addressLatitude],
    };
    return;
  }

  const coordinates = Array.isArray(this.location?.coordinates) ? this.location.coordinates : [];
  const [locationLongitude, locationLatitude] = coordinates;

  if (isValidLatitude(locationLatitude) && isValidLongitude(locationLongitude)) {
    this.address = {
      ...this.address,
      latitude: locationLatitude,
      longitude: locationLongitude,
    };
    this.location = {
      type: 'Point',
      coordinates: [locationLongitude, locationLatitude],
    };
    return;
  }

  this.location = undefined;
});

userSchema.index({ location: '2dsphere' });
userSchema.index({ role: 1, 'lawyerProfile.specialization': 1 });
userSchema.index({ role: 1, 'lawyerProfile.isOnline': 1 });

// Virtual for full name
userSchema.virtual('name').get(function() {
  return [this.firstName, this.lastName].filter(Boolean).join(' ').trim();
});

// Ensure virtuals are included in JSON and Object output
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

// Hash password before saving
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  if (this.$locals.passwordIsHashed) return;
  console.log(`🔐 Hashing password for: ${this.phone}`);
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.pre('save', function syncProfilePictures() {
  if (!this.profileImage && this.profilePicture) {
    this.profileImage = this.profilePicture;
  } else if (!this.profilePicture && this.profileImage) {
    this.profilePicture = this.profileImage;
  }
});

// Helper for Login
userSchema.methods.matchPassword = async function(enteredPassword) {
  console.log(`🔑 Comparing password for: ${this.phone}`);
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
