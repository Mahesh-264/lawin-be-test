const { normalizeAddressPayload, trimString } = require('../utils/location');

const DEFAULT_COUNTRY = 'India';
const POSTAL_PINCODE_API_BASE_URL = 'https://api.postalpincode.in/pincode';
const NOMINATIM_SEARCH_API_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_API_URL = 'https://nominatim.openstreetmap.org/reverse';
const REQUEST_TIMEOUT_MS = 10000;
const INDIA_COUNTRY_CODE = 'in';
const PINCODE_PATTERN = /^\d{6}$/;

const buildRequestHeaders = () => ({
  Accept: 'application/json',
  'User-Agent': 'lawin-location-service/1.0',
});

const fetchJson = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: buildRequestHeaders(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`Location service request failed with status ${response.status}.`);
      error.statusCode = 502;
      throw error;
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Location service request timed out.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    if (!error.statusCode) {
      error.statusCode = 502;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const createValidationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const normalizeAddressInput = (input = {}) => ({
  pincode: trimString(input.pincode),
  city: trimString(input.city),
  district: trimString(input.district),
  state: trimString(input.state),
  country: trimString(input.country) || DEFAULT_COUNTRY,
  latitude: input.latitude,
  longitude: input.longitude,
});

const hasManualLocationInput = (address = {}) => (
  Boolean(trimString(address.pincode))
  || Boolean(trimString(address.city))
  || Boolean(trimString(address.district))
  || Boolean(trimString(address.state))
  || address.latitude !== undefined
  || address.longitude !== undefined
);

const hasGeocodingInput = (address = {}) => (
  (Boolean(trimString(address.city) || trimString(address.district)) && Boolean(trimString(address.state)))
  || PINCODE_PATTERN.test(trimString(address.pincode))
);

const dedupeQueries = (queries) => [...new Set(queries.filter(Boolean))];

const buildGeocodeQueries = (address = {}) => {
  const pincode = trimString(address.pincode);
  const city = trimString(address.city);
  const district = trimString(address.district);
  const state = trimString(address.state);
  const country = trimString(address.country) || DEFAULT_COUNTRY;

  return dedupeQueries([
    [pincode, city, district, state, country].filter(Boolean).join(', '),
    [pincode, city, state, country].filter(Boolean).join(', '),
    [city, district, state, country].filter(Boolean).join(', '),
    [district, state, country].filter(Boolean).join(', '),
    [city, state, country].filter(Boolean).join(', '),
  ]);
};

const pickCityFromPostOffice = (postOffice = {}) => (
  trimString(postOffice.Block)
  || trimString(postOffice.Division)
  || trimString(postOffice.District)
  || trimString(postOffice.Name)
);

const pickCityFromNominatimAddress = (address = {}) => (
  trimString(address.city)
  || trimString(address.town)
  || trimString(address.village)
  || trimString(address.municipality)
  || trimString(address.hamlet)
  || trimString(address.county)
);

const lookupPincodeDetails = async (rawPincode) => {
  const pincode = trimString(rawPincode);
  if (!PINCODE_PATTERN.test(pincode)) {
    throw createValidationError('Pincode must be exactly 6 digits.');
  }

  const response = await fetchJson(`${POSTAL_PINCODE_API_BASE_URL}/${pincode}`);
  const result = Array.isArray(response) ? response[0] : null;
  const postOffice = Array.isArray(result?.PostOffice) ? result.PostOffice[0] : null;

  if (!postOffice) {
    const error = new Error('Pincode lookup did not return any address details.');
    error.statusCode = 404;
    throw error;
  }

  return {
    pincode,
    city: pickCityFromPostOffice(postOffice),
    district: trimString(postOffice.District),
    state: trimString(postOffice.State),
    country: trimString(postOffice.Country) || DEFAULT_COUNTRY,
  };
};

const geocodeAddress = async (input = {}) => {
  const address = normalizeAddressInput(input);
  const queries = buildGeocodeQueries(address);

  for (const query of queries) {
    const searchParams = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '1',
      addressdetails: '1',
    });

    if ((address.country || DEFAULT_COUNTRY).toLowerCase() === DEFAULT_COUNTRY.toLowerCase()) {
      searchParams.set('countrycodes', INDIA_COUNTRY_CODE);
    }

    const response = await fetchJson(`${NOMINATIM_SEARCH_API_URL}?${searchParams.toString()}`);
    const match = Array.isArray(response) ? response[0] : null;

    if (match?.lat && match?.lon) {
      return {
        latitude: Number(match.lat),
        longitude: Number(match.lon),
        displayName: trimString(match.display_name),
      };
    }
  }

  return null;
};

const reverseGeocodeCoordinates = async ({ latitude, longitude }) => {
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);

  if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)) {
    throw createValidationError('Latitude and longitude are required for reverse geocoding.');
  }

  const searchParams = new URLSearchParams({
    lat: String(parsedLatitude),
    lon: String(parsedLongitude),
    format: 'jsonv2',
    addressdetails: '1',
  });

  const response = await fetchJson(`${NOMINATIM_REVERSE_API_URL}?${searchParams.toString()}`);
  const address = response?.address || {};

  return normalizeAddressPayload({
    pincode: trimString(address.postcode),
    city: pickCityFromNominatimAddress(address),
    district: trimString(address.state_district) || trimString(address.county),
    state: trimString(address.state),
    country: trimString(address.country) || DEFAULT_COUNTRY,
    latitude: parsedLatitude,
    longitude: parsedLongitude,
  });
};

const resolveLawyerAddress = async (input = {}, options = {}) => {
  const address = normalizeAddressInput(input);
  const requireCoordinates = Boolean(options.requireCoordinates);
  const resolution = {
    pincodeLookupStatus: 'skipped',
    geocodeStatus: 'skipped',
  };

  if (PINCODE_PATTERN.test(address.pincode)) {
    try {
      const pincodeDetails = await lookupPincodeDetails(address.pincode);
      address.city = pincodeDetails.city || address.city;
      address.district = pincodeDetails.district || address.district;
      address.state = pincodeDetails.state || address.state;
      address.country = pincodeDetails.country || address.country;
      resolution.pincodeLookupStatus = 'resolved';
    } catch (error) {
      resolution.pincodeLookupStatus = 'failed';

      if (requireCoordinates && !hasGeocodingInput(address)) {
        throw error;
      }
    }
  }

  let normalized = normalizeAddressPayload(address);

  if (!normalized.location && hasGeocodingInput(address)) {
    const geocodedLocation = await geocodeAddress(address);

    if (geocodedLocation) {
      address.latitude = geocodedLocation.latitude;
      address.longitude = geocodedLocation.longitude;
      normalized = normalizeAddressPayload(address);
      resolution.geocodeStatus = 'resolved';
    } else {
      resolution.geocodeStatus = 'failed';
    }
  }

  if (requireCoordinates && hasManualLocationInput(address) && !normalized.location) {
    throw createValidationError('Unable to generate coordinates from the provided location details.');
  }

  return {
    address: normalized.address,
    location: normalized.location,
    resolution,
  };
};

module.exports = {
  geocodeAddress,
  hasManualLocationInput,
  lookupPincodeDetails,
  resolveLawyerAddress,
  reverseGeocodeCoordinates,
};
