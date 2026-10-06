// seats.aero Partner API adapter (cached search).
// Docs: https://developers.seats.aero  — Pro members get a personal key (non-commercial use,
// ~1,000 calls/day). The key is stored only in the local settings file.
import { programId, CABIN_CODES } from './programs.mjs';
import { normalizeFlightAward } from './awards.mjs';
import { mapTrip } from './flights.mjs';

const BASE = 'https://seats.aero/partnerapi';
const MAX_PAGES = 3;

import { ApiError } from './errors.mjs';
export { ApiError };

/**
 * Map one seats.aero availability record to PointPilot's award row for `cabin`, or null when
 * that cabin isn't available.
 *
 * Taxes: the cached-search summary may carry `<C>TotalTaxes` in minor currency units (cents) with
 * `TaxesCurrency`. Only USD is converted; other currencies are left unknown rather than guessed.
 */
export function mapAvailability(rec, cabin) {
  const c = CABIN_CODES[cabin];
  if (!c || !rec?.[`${c}Available`]) return null;
  const miles = Number(rec[`${c}MileageCost`]);
  if (!(miles > 0)) return null;
  const route = rec.Route || {};
  const source = rec.Source || route.Source;
  const rawTaxes = rec[`${c}TotalTaxes`];
  const currency = rec.TaxesCurrency || rec[`${c}TaxesCurrency`] || null;
  const totalTaxes = Number.isFinite(Number(rawTaxes)) && rawTaxes !== null && (!currency || currency === 'USD') ? Number(rawTaxes) / 100 : null;
  const seats = Number(rec[`${c}RemainingSeats`]);
  // With include_trips=true each availability carries its individual flights.
  const flights = (Array.isArray(rec.AvailabilityTrips) ? rec.AvailabilityTrips : [])
    .map(t => mapTrip(t, { cabin }))
    .filter(t => t && (!t.cabin || t.cabin === cabin))
    .sort((a, b) => (a.mileageCost ?? Infinity) - (b.mileageCost ?? Infinity) || a.totalDurationMin - b.totalDurationMin)
    .slice(0, 8);
  return normalizeFlightAward({
    flights,
    dataSource: 'seats.aero',
    availabilityId: rec.ID || null,
    program: programId(source) || String(source || '').toLowerCase(),
    origin: route.OriginAirport,
    destination: route.DestinationAirport,
    date: rec.Date || String(rec.ParsedDate || '').slice(0, 10),
    cabin,
    mileageCost: miles,
    totalTaxes,
    remainingSeats: seats > 0 ? seats : null,
    direct: typeof rec[`${c}Direct`] === 'boolean' ? rec[`${c}Direct`] : null,
    airlines: rec[`${c}Airlines`] || null,
    sourceUpdatedAt: rec.UpdatedAt || null,
    sourceUrl: 'https://seats.aero/search'
  });
}

/** Cached search. Returns { rows, calls }. */
export async function searchSeatsAero({ apiKey, origins, destinations, start, end, cabin, directOnly = false, fetchImpl = fetch }) {
  if (!apiKey) throw new ApiError('No seats.aero API key configured.', 400, 'NO_API_KEY');
  const rows = [];
  let cursor = null, skip = 0, calls = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({
      origin_airport: origins.join(','), destination_airport: destinations.join(','),
      start_date: start, end_date: end, cabins: cabin, take: '500', order_by: 'lowest_mileage',
      include_trips: 'true'   // flight-level details (times, aircraft) in the same call
    });
    if (directOnly) q.set('only_direct_flights', 'true');
    if (cursor != null) { q.set('cursor', String(cursor)); q.set('skip', String(skip)); }
    calls++;
    let r;
    try {
      r = await fetchImpl(`${BASE}/search?${q}`, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new ApiError(`Could not reach seats.aero: ${e.message}`, 502, 'API_UNREACHABLE');
    }
    if (r.status === 401 || r.status === 403) throw new ApiError('seats.aero rejected the API key. Check it under Data & System.', 401, 'API_AUTH');
    if (r.status === 429) throw new ApiError('seats.aero daily API limit reached. Results below come from the local cache.', 429, 'API_RATE_LIMIT');
    if (!r.ok) throw new ApiError(`seats.aero returned HTTP ${r.status}.`, 502, 'API_ERROR');
    const body = await r.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const rec of data) { const row = mapAvailability(rec, cabin); if (row) rows.push(row); }
    skip += data.length;
    if (!body?.hasMore || body.cursor == null || !data.length) break;
    cursor = body.cursor;
  }
  return { rows, calls };
}
