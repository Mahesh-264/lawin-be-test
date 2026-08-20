// Shared location helpers for safe coordinate validation and geospatial search input.
const DEFAULT_RADIUS_KM = 25;
const MAX_RADIUS_KM = 250;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const toFiniteNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const trimString = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const isValidLatitude = (value) => Number.isFinite(value) && value >= -90 && value <= 90;
const isValidLongitude = (value) => Number.isFinite(value) && value >= -180 && value <= 180;

const normalizeCoordinatePair = ({ latitude, longitude }) => {
  const parsedLatitude = toFiniteNumber(latitude);
  const parsedLongitude = toFiniteNumber(longitude);

  if (parsedLatitude === null && parsedLongitude === null) {
    return { latitude: null, longitude: null, geoPoint: undefined };
  }

  if (parsedLatitude === null || parsedLongitude === null) {
    const error = new Error('Both latitude and longitude are required together.');
    error.statusCode = 400;
    throw error;
  }

  if (!isValidLatitude(parsedLatitude)) {
    const error = new Error('Latitude must be between -90 and 90.');
    error.statusCode = 400;
    throw error;
  }

  if (!isValidLongitude(parsedLongitude)) {
    const error = new Error('Longitude must be between -180 and 180.');
    error.statusCode = 400;
    throw error;
  }

  return {
    latitude: parsedLatitude,
    longitude: parsedLongitude,
    geoPoint: {
      type: 'Point',
      coordinates: [parsedLongitude, parsedLatitude],
    },
  };
};

const normalizeAddressPayload = (address = {}) => {
  const normalizedAddress = {
    pincode: trimString(address.pincode),
    state: trimString(address.state),
    district: trimString(address.district),
    city: trimString(address.city),
    country: trimString(address.country) || 'India',
  };

  const coordinatePayload = normalizeCoordinatePair({
    latitude: address.latitude,
    longitude: address.longitude,
  });

  normalizedAddress.latitude = coordinatePayload.latitude;
  normalizedAddress.longitude = coordinatePayload.longitude;

  return {
    address: normalizedAddress,
    location: coordinatePayload.geoPoint,
  };
};

const parseSearchCoordinates = (input = {}) => {
  const latitude = input.latitude ?? input.lat;
  const longitude = input.longitude ?? input.lng ?? input.lon;
  const coordinatePayload = normalizeCoordinatePair({ latitude, longitude });

  if (!coordinatePayload.geoPoint) {
    const error = new Error('Search coordinates are required.');
    error.statusCode = 400;
    throw error;
  }

  return coordinatePayload;
};

const parseRadiusKm = (value, defaultValue = DEFAULT_RADIUS_KM) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (String(value).toLowerCase() === 'all') return null;

  const radius = Number(value);
  if (!Number.isFinite(radius) || radius <= 0) {
    const error = new Error('Radius must be a positive number or "all".');
    error.statusCode = 400;
    throw error;
  }

  return Math.min(radius, MAX_RADIUS_KM);
};

const parseLimit = (value, defaultValue = DEFAULT_LIMIT) => {
  if (value === undefined || value === null || value === '') return defaultValue;

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    const error = new Error('Limit must be a positive integer.');
    error.statusCode = 400;
    throw error;
  }

  return Math.min(limit, MAX_LIMIT);
};

const parseBooleanFlag = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return undefined;

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;

  const error = new Error('Boolean query values must be true or false.');
  error.statusCode = 400;
  throw error;
};

const parseSpecializationTerms = (value) => {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry || '').split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_RADIUS_KM,
  MAX_LIMIT,
  MAX_RADIUS_KM,
  normalizeAddressPayload,
  parseBooleanFlag,
  parseLimit,
  parseRadiusKm,
  parseSearchCoordinates,
  parseSpecializationTerms,
  trimString,
};
