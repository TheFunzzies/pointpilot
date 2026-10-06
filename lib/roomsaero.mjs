// Rooms.aero Partner API adapter (hotel award search) — seats.aero's hotel product.
// Docs: https://developers.seats.aero/reference/rooms-getting-started
// Uses the same seats.aero Pro key, with its own ~1,000 calls/day quota.
//
// Units (per the Rooms.aero "Concepts" doc):
//   points  = whole stay (not per night)
//   cash    = whole stay, integer minor units (cents) of currency_code
//   cpp     = US cents per point, 0 when cash or award is missing
import { programId } from './programs.mjs';
import { normalizeHotelAward } from './awards.mjs';
import { ApiError } from './seatsaero.mjs';

const BASE = 'https://rooms.aero/partnerapi';
const MAX_PAGES = 2;
export const MAX_API_NIGHTS = 5;

function cashUsd(points, cpp, cents, currency) {
  if (Number(cpp) > 0 && points > 0) return (Number(cpp) * points) / 100;
  if (Number(cents) > 0 && (!currency || currency === 'USD')) return Number(cents) / 100;
  return null;
}

/**
 * One search result -> up to two hotel award rows (cheapest standard room, cheapest suite).
 * `stayNights` is the stay the user asked for; when it's longer than the API's 5-night limit the
 * total is extrapolated from the per-night price and flagged `estimated`.
 */
export function mapHotelResult(rec, { searchLocation, stayNights, queryNights = Math.min(MAX_API_NIGHTS, Math.max(1, stayNights || 1)) }) {
  const h = rec?.hotel || {};
  const program = programId(h.source || h.program) || String(h.source || '').toLowerCase();
  const rows = [];
  for (const [roomType, pts, cash, date, nights] of [
    ['standard', rec.lowest_award_standard, rec.lowest_cash_standard, rec.standard_date, rec.standard_nights],
    ['suite', rec.lowest_award_suite, rec.lowest_cash_suite, rec.suite_date, rec.suite_nights]
  ]) {
    const points = Number(pts);
    // Prices are for the whole stay the API priced; fall back to the stay length we asked for.
    const n = Number(nights) > 0 ? Number(nights) : queryNights;
    if (!(points > 0) || !date) continue;
    // `cpp` on the search result describes the standard room; derive suite cash from cents.
    const totalCash = cashUsd(points, roomType === 'standard' ? rec.cpp : 0, cash, rec.currency_code);
    const perNightPts = Math.round(points / n);
    rows.push(normalizeHotelAward({
      dataSource: 'rooms.aero',
      program,
      hotelId: h.id || null,
      name: h.name,
      brand: h.brand || null,
      category: h.award_category || null,
      location: [h.city, h.state, h.country].filter(Boolean).join(', '),
      searchLocation,
      checkIn: String(date).slice(0, 10),
      roomType,
      nightlyPoints: perNightPts,
      cashValue: totalCash != null ? totalCash / n : null,
      apiNights: queryNights,  // the stay length we searched — used to match cached rows to a search
      bookingUrl: /^https:\/\//i.test(String(h.url || '')) ? h.url : null,
      sourceUpdatedAt: rec.last_checked_at || h.last_checked_at || null,
      estimated: stayNights > n
    }));
  }
  return rows;
}

/** Search an area for hotels with award space. Returns { rows, calls }. */
export async function searchRoomsAero({ apiKey, location, start, end, stayNights = 1, fetchImpl = fetch }) {
  if (!apiKey) throw new ApiError('No seats.aero API key configured.', 400, 'NO_API_KEY');
  const nights = Math.max(1, Math.min(MAX_API_NIGHTS, Math.round(stayNights)));
  const rows = [];
  const seen = new Set();
  let calls = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ location, start_date: start, end_date: end, nights: String(nights), take: '500', skip: String(page * 500) });
    calls++;
    let r;
    try {
      r = await fetchImpl(`${BASE}/search?${q}`, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new ApiError(`Could not reach rooms.aero: ${e.message}`, 502, 'API_UNREACHABLE');
    }
    if (r.status === 401 || r.status === 403) throw new ApiError('rooms.aero rejected the API key (it uses your seats.aero Pro key).', 401, 'API_AUTH');
    if (r.status === 429) throw new ApiError('rooms.aero daily API limit reached. Results below come from the local cache.', 429, 'API_RATE_LIMIT');
    if (r.status === 400) throw new ApiError(`rooms.aero couldn't search "${location}". Try a city name.`, 400, 'API_BAD_LOCATION');
    if (!r.ok) throw new ApiError(`rooms.aero returned HTTP ${r.status}.`, 502, 'API_ERROR');
    const body = await r.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    for (const rec of data) {
      for (const row of mapHotelResult(rec, { searchLocation: location, stayNights, queryNights: nights })) {
        if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
      }
    }
    if (!body?.has_more || !data.length) break;
  }
  return { rows, calls };
}
