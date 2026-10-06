// Flight-level details for an award: segments, local times, layovers, aircraft and seat info.
// Data: seats.aero "Get Trips" (GET /partnerapi/trips/{availabilityId}); times arrive in UTC and
// are converted to each airport's local time using the bundled geo table.
import { describe, localTime, airlineName } from './geo.mjs';
import { ApiError } from './seatsaero.mjs';
import { normalizeCabin } from './programs.mjs';

const BASE = 'https://seats.aero/partnerapi';
const minutesBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ---------- seat expectations ----------
// No public seat-map API exists (AeroLOPA / SeatMaps don't offer one), so PointPilot gives the
// typical product for the cabin + aircraft type and links to the seat-map sites for specifics.
// Matches names ("Boeing 787-9", "Airbus A350-900") and IATA aircraft codes ("789", "77W", "359").
const WIDEBODY = /(\b7[4678]7\b|a3[3-8]0|dreamliner|\b(77W|77L|773|772|788|789|78X|781|744|748|764|763|332|333|338|339|342|343|346|351|359|35K|388)\b)/i;
const LONG_NARROW = /(\b757\b|a321|\b(75[0-9]|32Q|21N)\b)/i;

export function seatExpectation(aircraft, cabin) {
  const a = String(aircraft || '');
  const wide = WIDEBODY.test(a), longNarrow = LONG_NARROW.test(a);
  const c = normalizeCabin(cabin) || 'economy';
  if (c === 'first') return wide
    ? { type: 'Lie-flat first-class suite or seat', detail: 'Typically a fully flat bed, often enclosed, with a large personal screen.' }
    : { type: 'Domestic-style first (recliner)', detail: 'On narrow-body jets "first" is usually a wide recliner, not a bed.' };
  if (c === 'business') {
    if (wide) return { type: 'Lie-flat business seat (typical)', detail: 'Most long-haul business cabins are fully flat. Newer cabins are 1-2-1 with direct aisle access; some older ones are 2-2-2 or angled.' };
    if (longNarrow) return { type: 'Varies: lie-flat or recliner', detail: 'Transcontinental and long-range A321/757 business is often lie-flat, but some are recliners. Check the seat map.' };
    return { type: 'Recliner (regional business)', detail: 'Short-haul business on narrow-bodies is usually a recliner or a blocked middle seat.' };
  }
  if (c === 'premium') return { type: 'Premium economy recliner', detail: 'Wider seat, more legroom (typically 38" pitch) and more recline than economy.' };
  return { type: 'Economy seat', detail: wide ? 'Long-haul economy usually has seatback screens and power.' : 'Narrow-body economy; screens and power vary by airline.' };
}

function seatMapLinks(carrierCode, aircraft) {
  const airline = airlineName(carrierCode) || carrierCode;
  const q = s => `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  return {
    aerolopa: q(`site:aerolopa.com ${airline} ${aircraft || ''}`.trim()),
    seatmaps: q(`site:seatmaps.com ${airline} ${aircraft || ''}`.trim())
  };
}

// ---------- mapping ----------
export function mapTrip(t, { cabin } = {}) {
  const segs = (Array.isArray(t.AvailabilitySegments) ? t.AvailabilitySegments : [])
    .slice().sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
  if (!segs.length) return null;
  const segments = segs.map(s => {
    const carrier = String(s.FlightNumber || '').match(/^[A-Z0-9]{2}/)?.[0] || null;
    const dep = localTime(s.DepartsAt, s.OriginAirport), arr = localTime(s.ArrivesAt, s.DestinationAirport);
    return {
      flightNumber: s.FlightNumber || null,
      carrier, airline: airlineName(carrier),
      origin: s.OriginAirport, destination: s.DestinationAirport,
      originCity: describe(s.OriginAirport).city, destinationCity: describe(s.DestinationAirport).city,
      departUtc: s.DepartsAt, arriveUtc: s.ArrivesAt,
      depart: dep, arrive: arr,
      arriveDayOffset: dep && arr ? dayDiff(dep.date, arr.date) : 0,
      durationMin: minutesBetween(s.DepartsAt, s.ArrivesAt),
      aircraft: s.AircraftName || s.AircraftCode || null,
      aircraftCode: s.AircraftCode || null,
      fareClass: s.FareClass || null,
      distance: Number(s.Distance) || null,
      seat: seatExpectation(s.AircraftName || s.AircraftCode, t.Cabin || cabin),
      seatMaps: seatMapLinks(carrier, s.AircraftName || s.AircraftCode)
    };
  });
  const layovers = segments.slice(1).map((s, i) => ({
    airport: s.origin, city: s.originCity,
    durationMin: minutesBetween(segments[i].arriveUtc, s.departUtc),
    overnight: segments[i].arrive && s.depart ? segments[i].arrive.date !== s.depart.date : false
  }));
  const first = segments[0], last = segments[segments.length - 1];
  const currency = t.TaxesCurrency || null;
  return {
    id: t.ID,
    cabin: normalizeCabin(t.Cabin) || cabin || null,
    mixedCabinPct: Number(t.MixedCabinPct) || null,
    mileageCost: Number(t.MileageCost) || null,
    taxes: Number.isFinite(Number(t.TotalTaxes)) && (!currency || currency === 'USD') ? Number(t.TotalTaxes) / 100 : null,
    taxesCurrency: currency,
    remainingSeats: Number(t.RemainingSeats) || null,
    stops: segments.length - 1,
    totalDurationMin: Number(t.TotalDuration) || minutesBetween(first.departUtc, last.arriveUtc),
    depart: first.depart, arrive: last.arrive,
    arriveDayOffset: first.depart && last.arrive ? dayDiff(first.depart.date, last.arrive.date) : 0,
    flightNumbers: segments.map(s => s.flightNumber).filter(Boolean),
    airlines: [...new Set(segments.map(s => s.airline || s.carrier).filter(Boolean))],
    segments, layovers
  };
}

// Cache flight details for 6 hours so expanding the same result twice costs no extra API call.
const cache = new Map();
const TTL_MS = 6 * 3600 * 1000;
export async function getTripsCached(args, recordCalls = async () => {}) {
  const key = `${args.availabilityId}:${normalizeCabin(args.cabin) || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };
  const value = await getTrips(args);
  await recordCalls(value.calls);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

/** Flight options behind one seats.aero availability record. Returns { trips, bookingLinks, calls }. */
export async function getTrips({ apiKey, availabilityId, cabin, fetchImpl = fetch }) {
  if (!apiKey) throw new ApiError('No seats.aero API key configured.', 400, 'NO_API_KEY');
  let r;
  try {
    r = await fetchImpl(`${BASE}/trips/${encodeURIComponent(availabilityId)}`, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  } catch (e) { throw new ApiError(`Could not reach seats.aero: ${e.message}`, 502, 'API_UNREACHABLE'); }
  if (r.status === 401 || r.status === 403) throw new ApiError('seats.aero rejected the API key.', 401, 'API_AUTH');
  if (r.status === 404) throw new ApiError('seats.aero no longer has flights for this award (space may be gone).', 404, 'TRIPS_GONE');
  if (r.status === 429) throw new ApiError('seats.aero daily API limit reached.', 429, 'API_RATE_LIMIT');
  if (!r.ok) throw new ApiError(`seats.aero returned HTTP ${r.status}.`, 502, 'API_ERROR');
  const body = await r.json();
  const want = normalizeCabin(cabin);
  const trips = (Array.isArray(body?.data) ? body.data : [])
    .map(t => mapTrip(t, { cabin: want }))
    .filter(t => t && (!want || !t.cabin || t.cabin === want))
    .sort((a, b) => (a.mileageCost ?? Infinity) - (b.mileageCost ?? Infinity) || a.totalDurationMin - b.totalDurationMin);
  const bookingLinks = (Array.isArray(body?.booking_links) ? body.booking_links : [])
    .filter(l => /^https:\/\//i.test(String(l.link || '')))
    .map(l => ({ label: l.label || 'Book', url: l.link, primary: Boolean(l.primary) }));
  return { trips, bookingLinks, calls: 1 };
}
