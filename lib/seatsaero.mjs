import { observeRequest } from './request-observer.mjs';
import { recordApiCalls } from './settings.mjs';
// seats.aero Partner API adapter (cached search).
// Docs: https://developers.seats.aero  — Pro members get a personal key (non-commercial use,
// ~1,000 calls/day). The key is stored only in the local settings file.
import { programId, CABIN_CODES } from './programs.mjs';
import { normalizeFlightAward } from './awards.mjs';
import { mapTrip, getTrips, availabilityObservation } from './flights.mjs';

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
  const totalTaxes = Number.isFinite(Number(rawTaxes)) && rawTaxes !== null && rawTaxes !== '' && (!currency || currency === 'USD') ? Number(rawTaxes) / 100 : null;
  const seats = Number(rec[`${c}RemainingSeats`]);
  // With include_trips=true each availability carries its individual flights.
  const flights = (Array.isArray(rec.AvailabilityTrips) ? rec.AvailabilityTrips : [])
    .map(t => mapTrip(t, { cabin }))
    .filter(t => t && (!t.cabin || t.cabin === cabin))
    .sort((a, b) => (a.mileageCost ?? Infinity) - (b.mileageCost ?? Infinity) || a.totalDurationMin - b.totalDurationMin);
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
export async function searchSeatsAero({ apiKey, origins, destinations, start, end, cabin, directOnly = false, fetchImpl = fetch, signal }) {
  if (!apiKey) throw new ApiError('No seats.aero API key configured.', 400, 'NO_API_KEY');
  const rows = [];
  let cursor = null, skip = 0, calls = 0, truncated = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({
        origin_airport: origins.join(','), destination_airport: destinations.join(','),
        start_date: start, end_date: end, cabins: cabin, take: '500', order_by: 'lowest_mileage',
        include_trips: 'true'   // flight-level details (times, aircraft) in the same call
      });
      if (directOnly) q.set('only_direct_flights', 'true');
      if (cursor != null) { q.set('cursor', String(cursor)); q.set('skip', String(skip)); }
      await recordApiCalls(1, 'seats');
      calls++;
      let r;
      try {
        r = await observeRequest({ service: 'seatsaero', operation: 'seats.search', method: 'GET' }, () => fetchImpl(`${BASE}/search?${q}`, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }), { classify: r => availabilityObservation(r, 'seatsaero') });
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
      truncated = !Array.isArray(body?.data) || Boolean(body?.hasMore);
      if (!body?.hasMore || body.cursor == null || !data.length) break;
      cursor = body.cursor;
    }
  } catch (e) { e.calls = calls; throw e; }
  return { rows, calls, truncated, truncatedReason: truncated ? 'seats.aero page limit reached' : null };
}

// Identity excludes price: a price change requires review, never substitution.
export function sameFlightIdentity(selection, candidate) {
  const a = selection.flight || selection;
  const b = candidate.flight || candidate;
  const nums = x => (x.segments?.map(s => s.flightNumber) || x.flightNumbers || []).map(n => String(n).replace(/\s/g, '').toUpperCase());
  const an = nums(a), bn = nums(b);
  const as = a.segments || [], bs = b.segments || [];
  if (!an.length || an.some(n => !n) || an.length !== bn.length || an.some((n, i) => n !== bn[i])) return false;
  if (!a.departUtc || !b.departUtc || !Number.isFinite(Date.parse(a.departUtc)) || Date.parse(a.departUtc) !== Date.parse(b.departUtc)) return false;
  if (as.length && (as.length !== bs.length || as.some((s, i) => s.origin !== bs[i].origin || s.destination !== bs[i].destination || !s.departUtc || Date.parse(s.departUtc) !== Date.parse(bs[i].departUtc)))) return false;
  return selection.origin === candidate.origin && selection.destination === candidate.destination && selection.cabin === candidate.cabin;
}

export async function checkFlightAvailability({ apiKey, selection, travelers = 1, commercialLive = false, liveSource, fetchImpl = fetch, signal }) {
  const requestedAt = new Date().toISOString();
  const evidence = { method: 'unsupported', requestedAt, observedAt: null, source: 'seats.aero', complete: false };
  const unavailable = code => ({ evidence, match: null, code, definitive: false });
  if (!apiKey) return unavailable('NO_API_KEY');
  if (selection.dataSource !== 'seats.aero') return unavailable('UNSUPPORTED_CHECK');
  if (!(selection.flight?.departUtc && (selection.flight?.flightNumbers?.length || selection.flight?.segments?.length))) return unavailable('IDENTITY_MISSING');
  let rows, complete;
  if (commercialLive === true && liveSource) {
    if (programId(liveSource) !== selection.program) return unavailable('UNSUPPORTED_CHECK');
    await recordApiCalls(1, 'seats');
    const r = await observeRequest({ service: 'seatsaero', operation: 'seats.live', method: 'POST' }, () => fetchImpl(`${BASE}/live`, { method: 'POST', headers: { 'Partner-Authorization': apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ origin_airport: selection.origin, destination_airport: selection.destination, departure_date: selection.date, source: liveSource, seat_count: travelers, smart_cache: false, disable_filters: true }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }), { classify: r => availabilityObservation(r, 'seatsaero') });
    if (!r.ok) throw new ApiError('seats.aero availability check failed.', r.status === 429 ? 429 : r.status === 401 || r.status === 403 ? 401 : 502, r.status === 429 ? 'API_RATE_LIMIT' : r.status === 401 || r.status === 403 ? 'API_AUTH' : 'API_ERROR');
    const body = await r.json();
    evidence.method = body.cached === true ? 'cached' : 'live';
    // Live responses contain individual trips, not cached Availability summaries.
    const trips = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : null;
    complete = trips !== null && !body.hasMore && trips.every(t => t?.AvailabilitySegments?.length && programId(t.Source) === selection.program && mapTrip(t, { cabin: selection.cabin }));
    rows = (trips || []).map(t => {
      const trip = mapTrip(t, { cabin: selection.cabin });
      if (!trip) return null;
      return { program: programId(t.Source), origin: trip.origin, destination: trip.destination, date: selection.date, cabin: trip.cabin, sourceUpdatedAt: t.UpdatedAt || null, flights: [trip], availabilityId: evidence.method === 'cached' ? t.AvailabilityID || null : null };
    }).filter(Boolean);
  } else {
    const result = await searchSeatsAero({ apiKey, origins: [selection.origin], destinations: [selection.destination], start: selection.date, end: selection.date, cabin: selection.cabin, fetchImpl, signal });
    rows = result.rows;
    complete = !result.truncated;
    evidence.method = 'cached';
  }
  evidence.complete = complete;
  const candidates = rows.filter(r => r.program === selection.program && r.origin === selection.origin && r.destination === selection.destination && r.date === selection.date && r.cabin === selection.cabin);
  for (const row of candidates) {
    let trips = row.flights;
    if (evidence.method === 'cached' && !trips.length && row.availabilityId) {
      try { trips = (await getTrips({ apiKey, availabilityId: row.availabilityId, cabin: selection.cabin, fetchImpl, signal })).trips; }
      catch (e) { if (e.status !== 404) throw e; evidence.complete = false; continue; }
    }
    const trip = trips.find(t => sameFlightIdentity(selection, { ...t, cabin: t.cabin || row.cabin }));
    if (!trip) continue;
    evidence.observedAt = row.sourceUpdatedAt;
    return { evidence, definitive: false, code: 'MATCHED', match: { mileageCost: trip.mileageCost, totalTaxes: trip.taxes, taxesCurrency: trip.taxesCurrency || null, remainingSeats: trip.remainingSeats > 0 ? trip.remainingSeats : null } };
  }
  return { evidence, match: null, code: evidence.method === 'live' && evidence.complete ? 'INVENTORY_GONE' : 'AVAILABILITY_NOT_FOUND', definitive: evidence.method === 'live' && evidence.complete };
}
