const User = require('../models/User');
const { parseSpecializationTerms } = require('../utils/location');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getDisplayName = (user) => {
  if (!user) return 'Lawyer';
  return `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name || 'Lawyer';
};

const getLocationLabel = (user) => (
  user?.address?.city ||
  user?.address?.district ||
  user?.address?.state ||
  'India'
);

const buildSpecializationQuery = (specialization) => {
  const terms = parseSpecializationTerms(specialization);
  if (!terms.length) return undefined;

  return {
    $regex: terms.map((term) => escapeRegex(term)).join('|'),
    $options: 'i',
  };
};

const mapLawyerDiscoveryCard = (lawyer) => ({
  _id: lawyer._id,
  id: lawyer._id,
  name: getDisplayName(lawyer),
  firstName: lawyer.firstName || '',
  lastName: lawyer.lastName || '',
  profileImage: lawyer.profileImage || '',
  specialization: lawyer.lawyerProfile?.specialization || 'General Practice',
  experienceYears: lawyer.lawyerProfile?.experienceYears || 0,
  languages: Array.isArray(lawyer.lawyerProfile?.languages) ? lawyer.lawyerProfile.languages : [],
  rating: lawyer.lawyerProfile?.rating || 4.8,
  city: lawyer.address?.city || lawyer.address?.district || '',
  state: lawyer.address?.state || '',
  locationLabel: getLocationLabel(lawyer),
  isOnline: Boolean(lawyer.lawyerProfile?.isOnline),
  distanceKm: Number.isFinite(lawyer.distanceKm) ? lawyer.distanceKm : null,
  distanceLabel: Number.isFinite(lawyer.distanceKm) ? `${lawyer.distanceKm.toFixed(1)} km away` : null,
});

const searchNearbyLawyers = async ({
  latitude,
  longitude,
  specialization,
  onlineOnly,
  radiusKm,
  limit,
}) => {
  const specializationQuery = buildSpecializationQuery(specialization);
  const query = {
    role: 'lawyer',
    location: { $exists: true },
  };

  if (specializationQuery) {
    query['lawyerProfile.specialization'] = specializationQuery;
  }

  if (onlineOnly === true) {
    query['lawyerProfile.isOnline'] = true;
  }

  const geoNearStage = {
    $geoNear: {
      near: {
        type: 'Point',
        coordinates: [longitude, latitude],
      },
      key: 'location',
      spherical: true,
      distanceField: 'distanceMeters',
      query,
    },
  };

  if (radiusKm !== null) {
    geoNearStage.$geoNear.maxDistance = radiusKm * 1000;
  }

  const lawyers = await User.aggregate([
    geoNearStage,
    {
      $addFields: {
        distanceKm: {
          $round: [{ $divide: ['$distanceMeters', 1000] }, 1],
        },
      },
    },
    {
      $project: {
        firstName: 1,
        lastName: 1,
        createdAt: 1,
        profileImage: 1,
        address: 1,
        lawyerProfile: {
          specialization: 1,
          experienceYears: 1,
          languages: 1,
          rating: 1,
          isOnline: 1,
          internships: 1,
          jamSessions: 1,
          isVerified: 1,
        },
        distanceKm: 1,
      },
    },
    { $sort: { distanceKm: 1, createdAt: -1 } },
    { $limit: limit },
  ]);

  return lawyers;
};

module.exports = {
  mapLawyerDiscoveryCard,
  searchNearbyLawyers,
};
