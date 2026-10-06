// Flight-level details for an award: segments, local times, layovers, aircraft and seat info.
// Data: seats.aero "Get Trips" (GET /partnerapi/trips/{availabilityId}); times arrive in UTC and
// are converted to each airport's local time using the bundled geo table.
import { describe, localTime, airlineName } from './geo.mjs';
import { ApiError } from './errors.mjs';
import { normalizeCabin } from './programs.mjs';
import { cabinProduct } from './cabins.mjs';

const BASE = 'https://seats.aero/partnerapi';
const minutesBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ---------- seat product ----------
// Curated product (Qsuite, THE Room...) when known, otherwise the typical product for the
// cabin + aircraft type. Exact seat-map pages are resolved separately (lib/seatmaps.mjs).
export function seatExpectation(aircraft, cabin, carrier = null, aircraftCode = null) {
  const p = cabinProduct({ carrier, aircraftCode, aircraftName: aircraft, cabin });
  return { type: p.product, detail: p.detail, score: p.score, certainty: p.certainty };
}

// Always-valid starting links; the UI upgrades them to the exact aircraft page via /api/seatmaps.
function seatMapLinks(carrierCode) {
  const al = String(carrierCode || '').toLowerCase();
  return { aerolopa: al ? `https://www.aerolopa.com/${al}` : 'https://www.aerolopa.com/', seatmaps: 'https://seatmaps.com/airlines/' };
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
      seat: seatExpectation(s.AircraftName || s.AircraftCode, t.Cabin || cabin, carrier, s.AircraftCode),
      seatMaps: seatMapLinks(carrier)
    };
  });
  const layovers = segments.slice(1).map((s, i) => ({
    airport: s.origin, city: s.originCity,
    durationMin: minutesBetween(segments[i].arriveUtc, s.departUtc),
    overnight: segments[i].arrive && s.depart ? segments[i].arrive.date !== s.depart.date : false
  }));
  const first = segments[0], last = segments[segments.length - 1];
  const currency = t.TaxesCurrency || null;
  // The seat that matters most is the one on the longest flight.
  const main = segments.reduce((m, s) => (s.durationMin > (m?.durationMin ?? -1) ? s : m), null);
  return {
    id: t.ID,
    origin: first.origin, destination: last.destination,
    departUtc: first.departUtc, arriveUtc: last.arriveUtc,
    product: main ? { ...main.seat, airline: main.airline, aircraft: main.aircraft, flightNumber: main.flightNumber } : null,
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
