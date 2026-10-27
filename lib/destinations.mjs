import { searchTrip } from './search.mjs';
import { ApiError } from './errors.mjs';
import { objectFields } from './itinerary.mjs';
import { mapLimit } from './util.mjs';

export const DESTINATION_SEARCH_LIMITS = Object.freeze({
  maxDestinations: 8,
  concurrency: 2,
  maxProviderCallsPerDirection: 3
});

const SEARCH_FIELDS = ['origins', 'destinations', 'departDate', 'returnDate', 'flexDays', 'cabin', 'travelers', 'nonstopOnly', 'preserveFlexible', 'rank'];
const badRequest = message => { throw new ApiError(message, 400, 'INVALID_INPUT'); };

function validateInput(input) {
  objectFields(input, SEARCH_FIELDS, 'destination search');
  if (typeof input.origins !== 'string' || !input.origins.trim() || input.origins.length > 1000) badRequest('Origins must be a non-empty string of at most 1000 characters.');
  if (!Array.isArray(input.destinations) || input.destinations.length < 1 || input.destinations.length > DESTINATION_SEARCH_LIMITS.maxDestinations) badRequest('Choose one to eight destinations.');
  const destinations = input.destinations.map(destination => {
    if (typeof destination !== 'string' || !destination.trim() || destination.length > 160) badRequest('Each destination must be a non-empty string of at most 160 characters.');
    return destination.trim();
  });
  const { destinations: _destinations, ...trip } = input;
  return { destinations, trip: { ...trip, origins: input.origins.trim() } };
}

const sourceError = result => result.dataStatus?.api === 'error'
  ? { code: 'API_ERROR', message: 'Availability refresh failed; any retained options are cached.' }
  : null;

export async function searchDestinations(input, { allowApi = true, search = searchTrip } = {}) {
  const { destinations, trip } = validateInput(input);
  const results = await mapLimit(destinations, DESTINATION_SEARCH_LIMITS.concurrency, async destination => {
    try {
      const found = await search({ ...trip, destination }, { allowApi });
      const error = sourceError(found);
      return { destination, result: error && found.mode === 'no-inventory' ? { ...found, mode: 'error' } : found, error };
    } catch (e) {
      return { destination, result: null, error: { code: e.code || 'SEARCH_FAILED', message: e.message || 'Availability search failed for this destination.' } };
    }
  });
  const maxProviderCallsPerDestination = allowApi ? DESTINATION_SEARCH_LIMITS.maxProviderCallsPerDirection * (trip.returnDate ? 2 : 1) : 0;
  const maxProviderCallsTotal = maxProviderCallsPerDestination * destinations.length;
  return {
    results,
    limits: {
      maxDestinations: DESTINATION_SEARCH_LIMITS.maxDestinations,
      concurrency: DESTINATION_SEARCH_LIMITS.concurrency,
      maxProviderCallsPerDestination,
      maxProviderCallsTotal
    },
    warnings: allowApi ? [`At most ${maxProviderCallsPerDestination} seats.aero calls per destination and ${maxProviderCallsTotal} total for this request; cached responses may reduce actual usage.`] : []
  };
}
