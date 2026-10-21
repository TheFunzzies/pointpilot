import { getTripPlan, saveItinerary, removeSegment } from './tripplan.mjs';
import { searchTrip, evaluateSelection } from './search.mjs';
import { objectFields } from './itinerary.mjs';

/** Called only after the server's Host/Origin, JSON and body-limit checks. */
export function createRoutes(deps = {}) {
  const service = { getTripPlan, saveItinerary, removeSegment, searchTrip, evaluateSelection, ...deps };
  return async ({ method, path, body }) => {
    if (method === 'PUT' && path === '/api/trip-plan/itinerary') return { status: 200, payload: await service.saveItinerary(body) };
    const match = path?.match(/^\/api\/trip-plan\/segments\/([^/]+)$/);
    if (method === 'DELETE' && match) {
      objectFields(body, ['expectedRevision'], 'segment deletion');
      return { status: 200, payload: await service.removeSegment(match[1], body) };
    }
    if (method === 'POST' && body?.schemaVersion === 2 && path === '/api/search/trip') return { status: 200, payload: await service.searchTrip(body) };
    if (method === 'POST' && body?.schemaVersion === 2 && path === '/api/trip/evaluate') return { status: 200, payload: await service.evaluateSelection(body) };
    return null;
  };
}
