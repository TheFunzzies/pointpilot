import { availabilityObservation } from './flights.mjs';
import { observeRequest } from './request-observer.mjs';
import { recordApiCalls } from './settings.mjs';
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
import { ApiError } from './errors.mjs';

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
      availabilityId: rec.id || null, roomIdentity: null,
      name: h.name,
      brand: h.brand || null,
      category: h.award_category || null,
      location: [h.city, h.state, h.country].filter(Boolean).join(', '),
      city: h.city || null,
      latitude: Number.isFinite(Number(h.latitude)) ? Number(h.latitude) : null,
      longitude: Number.isFinite(Number(h.longitude)) ? Number(h.longitude) : null,
      searchLocation,
      checkIn: String(date).slice(0, 10),
      roomType,
      nightlyPoints: perNightPts,
      cashValue: totalCash != null ? totalCash / n : null,
      pricedNights: n, pricedTotalPoints: points, pricedTotalCash: totalCash,
      apiNights: queryNights,  // the stay length we searched — used to match cached rows to a search
      bookingUrl: /^https:\/\//i.test(String(h.url || '')) ? h.url : null,
      sourceUpdatedAt: rec.last_checked_at || h.last_checked_at || null,
      estimated: stayNights !== n
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
  let calls = 0, truncated = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ location, start_date: start, end_date: end, nights: String(nights), take: '500', skip: String(page * 500) });
      await recordApiCalls(1, 'rooms');
      calls++;
      let r;
      try {
        r = await observeRequest({ service: 'roomsaero', operation: 'rooms.availability', method: 'GET' }, () => fetchImpl(`${BASE}/search?${q}`, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }), { classify: r => availabilityObservation(r, 'roomsaero') });
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
      truncated = !Array.isArray(body?.data) || Boolean(body?.has_more);
      if (!body?.has_more || !data.length) break;
    }
  } catch (e) { e.calls = calls; throw e; }
  return { rows, calls, truncated, truncatedReason: truncated ? 'rooms.aero page limit reached' : null };
}

/** Exact property data; unknown room quantity and award fees remain unknown. */
export async function getExactHotelAvailability({ apiKey, selection, fetchImpl = fetch, signal }) {
  const evidence = { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'rooms.aero', complete: false };
  if (!apiKey || selection.dataSource !== 'rooms.aero' || !selection.hotelId || selection.estimated || !(selection.nights >= 1 && selection.nights <= MAX_API_NIGHTS)) {
    return { evidence, match: null, definitive: false, code: !apiKey ? 'NO_API_KEY' : 'UNSUPPORTED_CHECK' };
  }
  const q = new URLSearchParams({ hotel_id: String(selection.hotelId), start_date: selection.checkIn, end_date: selection.checkIn, nights: String(selection.nights), take: '500' });
  const body = await roomsRequest({ apiKey, path: `/availability?${q}`, fetchImpl, signal });
  evidence.method = 'cached';
  evidence.complete = Array.isArray(body.data) && !body.has_more;
  const rec = (Array.isArray(body.data) ? body.data : []).find(r => String(r.hotel_id ?? r.hotel?.id) === String(selection.hotelId) && (!r.source || programId(r.source) === selection.program) && String(r.arrival_date || r.check_in || r.date).slice(0, 10) === selection.checkIn && Number(r.num_nights ?? r.nights) === selection.nights);
  if (!rec) return { evidence, match: null, definitive: false, code: 'AVAILABILITY_NOT_FOUND' };
  const id = rec.id;
  let detail = rec;
  if (id) {
    try { const b = await roomsRequest({ apiKey, path: `/availability/${encodeURIComponent(id)}`, fetchImpl, signal }); detail = b.data && !Array.isArray(b.data) ? b.data : b; }
    catch (e) { if (e.status !== 404) throw e; evidence.complete = false; return { evidence, match: null, definitive: false, code: 'AVAILABILITY_NOT_FOUND' }; }
  }
  evidence.observedAt = detail.last_checked_at || rec.last_checked_at || null;
  const identity = selection.roomIdentity || selection.roomId;
  const rooms = Array.isArray(detail.rooms) ? detail.rooms : Array.isArray(detail.room_types) ? detail.room_types : [];
  const room = identity ? rooms.find(r => String(r.id || r.name) === String(identity)) : null;
  // A cheapest room in the same class cannot establish that a specific selected room remains.
  const available = rec[`${selection.roomType}_award_available`];
  const raw = identity ? room?.award_cost ?? room?.points : available === false ? null : rec[`${selection.roomType}_award_cost`] ?? rec[`lowest_award_${selection.roomType}`];
  const points = raw == null || raw === '' ? null : Number(raw);
  const match = Number.isSafeInteger(points) && points > 0 ? { totalPoints: points, pricedNights: Number(rec.num_nights ?? rec.nights), availabilityId: id || null, roomIdentity: room?.id || room?.name || null, remainingRooms: null, totalTaxes: null } : null;
  return { evidence, match, definitive: false, code: match ? 'MATCHED' : 'AVAILABILITY_NOT_FOUND' };
}

async function roomsRequest({ apiKey, path, method = 'GET', fetchImpl = fetch, signal }) {
  if (!apiKey) throw new ApiError('No seats.aero API key configured.', 400, 'NO_API_KEY');
  await recordApiCalls(1, 'rooms');
  let r;
  try { r = await observeRequest({ service: 'roomsaero', operation: method === 'POST' ? 'rooms.refresh' : path.startsWith('/availability/') ? 'rooms.details' : 'rooms.availability', method }, () => fetchImpl(`${BASE}${path}`, { method, headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }), { classify: r => availabilityObservation(r, 'roomsaero') }); }
  catch { throw new ApiError('Could not reach rooms.aero.', 502, 'API_UNREACHABLE'); }
  if (r.status === 401 || r.status === 403) throw new ApiError('rooms.aero rejected the API key.', 401, 'API_AUTH');
  if (r.status === 429) {
    const e = new ApiError('rooms.aero allowance exhausted. Hotel refresh uses the shared one-refresh-per-24-hours allowance.', 429, 'API_RATE_LIMIT');
    const retry = Number(r.headers?.get('retry-after'));
    e.retryAfter = Number.isFinite(retry) && retry > 0 ? retry : 86400;
    throw e;
  }
  if (r.status === 404) throw new ApiError('rooms.aero could not find this item.', 404, 'AVAILABILITY_NOT_FOUND');
  if (!r.ok) throw new ApiError('rooms.aero availability request failed.', 502, 'API_ERROR');
  if (method === 'POST' && r.status === 202) return {};
  return r.json();
}

/** Explicit action only. Never retried: a timeout may already have consumed the allowance. */
export async function requestHotelRefresh({ apiKey, hotelId, fetchImpl = fetch, signal }) {
  if (!hotelId) throw new ApiError('A provider hotel identity is required.', 400, 'UNSUPPORTED_CHECK');
  const requestedAt = new Date().toISOString();
  await roomsRequest({ apiKey, path: `/hotels/${encodeURIComponent(hotelId)}/refresh`, method: 'POST', fetchImpl, signal });
  return { status: 'queued', requestedAt, nextCheckAfter: new Date(Date.parse(requestedAt) + 60000).toISOString(), allowanceMessage: 'Uses the shared one-refresh-per-24-hours allowance on rooms.aero. Queued refresh does not confirm bookability.' };
}
