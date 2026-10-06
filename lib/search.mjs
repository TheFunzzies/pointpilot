// Trip search: gather award inventory (seats.aero + local cache), pair legs, fund each option
// against the user's portfolio and rank.
import { resolveAirports } from './places.mjs';
import { normalizeCabin, programName } from './programs.mjs';
import { queryFlights, queryHotels, replaceApiAwards, replaceApiHotels } from './awards.mjs';
import { searchSeatsAero } from './seatsaero.mjs';
import { searchRoomsAero, MAX_API_NIGHTS } from './roomsaero.mjs';
import { recordAwards, loadHistory, historicalContext } from './history.mjs';
import { evaluateTrip, fundPrograms, rankTrips, explainTrip, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { getSettings, loadUser, recordApiCalls } from './settings.mjs';
import { todayISO } from './transfers.mjs';

const MAX_LEGS_PER_DIRECTION = 25;
const MAX_RESULTS = 30;
const recentApiQueries = new Map(); // query key -> epoch ms

const shiftDate = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

export function dateWindow(date, flexDays, today = todayISO()) {
  const f = Math.max(0, Math.min(30, Math.round(Number(flexDays) || 0)));
  let start = shiftDate(date, -f);
  if (start < today) start = today;
  const end = shiftDate(date, f);
  return { start, end };
}

/** Fetch from seats.aero when configured and the same query wasn't fetched recently. */
async function refreshFromApi(q, settings, status) {
  if (!settings.seatsAeroApiKey) { status.api = 'not-configured'; return; }
  const key = JSON.stringify([q.origins.slice().sort(), q.destinations.slice().sort(), q.start, q.end, q.cabin]);
  const last = recentApiQueries.get(key);
  if (last && Date.now() - last < settings.apiRefreshMinutes * 60000) { status.api = status.api === 'fetched' ? 'fetched' : 'recent-cache'; return; }
  try {
    const { rows, calls } = await searchSeatsAero({ apiKey: settings.seatsAeroApiKey, ...q });
    await recordApiCalls(calls);
    await replaceApiAwards({ dataSource: 'seats.aero', ...q }, rows);
    await recordAwards(rows, { sourceType: 'api_observation', sourceId: 'seats.aero' });
    recentApiQueries.set(key, Date.now());
    status.api = 'fetched';
    status.apiRows = (status.apiRows || 0) + rows.length;
  } catch (e) {
    status.api = 'error';
    status.warnings.push(e.message);
  }
}

function bestPerFlight(rows) {
  // Same program/route/date can appear from several sources; keep the cheapest.
  const map = new Map();
  for (const r of rows) {
    const k = `${r.program}:${r.origin}:${r.destination}:${r.date}`;
    const prev = map.get(k);
    if (!prev || r.mileageCost < prev.mileageCost || (r.mileageCost === prev.mileageCost && r.capturedAt > prev.capturedAt)) map.set(k, r);
  }
  return [...map.values()].sort((a, b) => a.mileageCost - b.mileageCost);
}

export async function searchTrip(params, { allowApi = true } = {}) {
  const cabin = normalizeCabin(params.cabin) || 'business';
  const travelers = Math.max(1, Math.min(9, Math.round(Number(params.travelers) || 1)));
  if (!isoDate(params.departDate)) throw badRequest('Choose a departure date.');
  if (params.returnDate && !isoDate(params.returnDate)) throw badRequest('Return date is invalid.');
  if (params.returnDate && params.returnDate < params.departDate) throw badRequest('Return date is before the departure date.');
  const origins = resolveAirports(params.origins);
  const destinations = resolveAirports(params.destination);
  const out = dateWindow(params.departDate, params.flexDays);
  const back = params.returnDate ? dateWindow(params.returnDate, params.flexDays) : null;
  if (out.end < todayISO()) throw badRequest('Departure date is in the past.');

  const [settings, user] = await Promise.all([getSettings(), loadUser()]);
  const status = { api: 'skipped', warnings: [] };
  const directOnly = Boolean(params.nonstopOnly);
  const outQ = { origins, destinations, start: out.start, end: out.end, cabin };
  const backQ = back && { origins: destinations, destinations: origins, start: back.start, end: back.end, cabin };
  if (allowApi) {
    await refreshFromApi(outQ, settings, status);
    if (backQ) await refreshFromApi(backQ, settings, status);
  }

  const usable = r => (!directOnly || r.direct === true) && (r.remainingSeats == null || r.remainingSeats >= travelers);
  const outRows = bestPerFlight((await queryFlights(outQ)).filter(usable));
  const backRows = backQ ? bestPerFlight((await queryFlights(backQ)).filter(usable)) : [];

  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}), ...(params.preferences || {}) };
  if (params.preserveFlexible != null) prefs.preserveFlexiblePoints = Boolean(params.preserveFlexible);
  const ctx = { travelers, balances: user.balances, transfers: transferData(), prefs };

  const candidates = [];
  const outTop = outRows.slice(0, MAX_LEGS_PER_DIRECTION);
  if (!backQ) {
    for (const o of outTop) candidates.push([{ ...o, leg: 'Outbound' }]);
  } else {
    for (const o of outTop) for (const b of backRows.slice(0, MAX_LEGS_PER_DIRECTION)) {
      if (b.date >= o.date) candidates.push([{ ...o, leg: 'Outbound' }, { ...b, leg: 'Return' }]);
    }
  }

  const history = await loadHistory();
  const trips = [];
  for (const legs of candidates) {
    const t = evaluateTrip(legs, ctx);
    if (!t) continue;
    t.id = legs.map(l => l.id).join('|');
    t.legs = t.legs.map(l => ({ ...l, history: historicalContext(l, history) }));
    t.explanation = explainTrip(t);
    trips.push(t);
  }
  const ranked = rankTrips(trips, params.rank).slice(0, MAX_RESULTS);

  let mode = 'results';
  if (!outRows.length || (backQ && !backRows.length)) mode = 'no-inventory';
  else if (!ranked.length) mode = candidates.length ? 'unaffordable' : 'no-valid-pairs';
  if (mode === 'unaffordable') {
    // Tell the user when only their transfer limit is in the way.
    const relaxed = candidates.slice(0, 50).map(legs => evaluateTrip(legs, { ...ctx, prefs: { ...prefs, maxTransfers: Infinity } })).filter(Boolean);
    if (relaxed.length) {
      const fewest = Math.min(...relaxed.map(t => t.transfers));
      status.warnings.push(`Affordable with ${fewest} transfers, but your limit is ${prefs.maxTransfers}. Raise "Max transfers" under My Points.`);
    }
  }

  return {
    mode,
    query: { origins, destinations, cabin, travelers, out, back, directOnly },
    counts: { outbound: outRows.length, return: backRows.length, evaluated: candidates.length },
    dataStatus: status,
    // Unaffordable/no-inventory: still show the cheapest raw awards so the user sees what exists.
    cheapestOutbound: outRows.slice(0, 5).map(r => ({ ...r, programName: programName(r.program) })),
    cheapestReturn: backRows.slice(0, 5).map(r => ({ ...r, programName: programName(r.program) })),
    trips: ranked
  };
}

const nightsBetween = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
const MAX_HOTEL_RESULTS = 40;

async function refreshHotelsFromApi(q, settings, status) {
  if (!settings.seatsAeroApiKey) { status.api = 'not-configured'; return; }
  const key = JSON.stringify(['rooms', q.searchLocation.toLowerCase(), q.start, q.end, q.apiNights]);
  const last = recentApiQueries.get(key);
  if (last && Date.now() - last < settings.apiRefreshMinutes * 60000) { status.api = 'recent-cache'; return; }
  try {
    const { rows, calls } = await searchRoomsAero({ apiKey: settings.seatsAeroApiKey, location: q.searchLocation, start: q.start, end: q.end, stayNights: q.stayNights });
    await recordApiCalls(calls, 'rooms');
    await replaceApiHotels(q, rows);
    await recordAwards(rows, { sourceType: 'api_observation', sourceId: 'rooms.aero' });
    recentApiQueries.set(key, Date.now());
    status.api = 'fetched';
    status.apiRows = rows.length;
  } catch (e) {
    status.api = 'error';
    status.warnings.push(e.message);
  }
}

/**
 * Hotel award search for one room.
 * params: { destination, checkIn, checkOut, flexDays, roomType: any|standard|suite, maxPointsPerNight, rank }
 */
export async function searchHotels(params, { allowApi = true } = {}) {
  const destination = String(params.destination || '').trim();
  if (!destination) throw badRequest('Enter a city or area to search hotels.');
  if (!isoDate(params.checkIn)) throw badRequest('Choose a check-in date.');
  if (params.checkOut && !isoDate(params.checkOut)) throw badRequest('Check-out date is invalid.');
  if (params.checkOut && params.checkOut <= params.checkIn) throw badRequest('Check-out must be after check-in.');
  const checkOut = params.checkOut || shiftDate(params.checkIn, 1);
  const nights = nightsBetween(params.checkIn, checkOut);
  const win = dateWindow(params.checkIn, params.flexDays);
  if (win.end < todayISO()) throw badRequest('Check-in date is in the past.');
  const apiNights = Math.min(nights, MAX_API_NIGHTS);

  const [settings, user] = await Promise.all([getSettings(), loadUser()]);
  const status = { api: 'skipped', warnings: [] };
  if (allowApi) await refreshHotelsFromApi({ searchLocation: destination, start: win.start, end: win.end, apiNights, stayNights: nights }, settings, status);
  if (nights > MAX_API_NIGHTS && status.api !== 'not-configured') {
    status.warnings.push(`rooms.aero prices stays of up to ${MAX_API_NIGHTS} nights; totals for your ${nights}-night stay are estimated from the ${MAX_API_NIGHTS}-night price.`);
  }

  const roomType = ['standard', 'suite'].includes(params.roomType) ? params.roomType : null;
  const maxPerNight = Number(params.maxPointsPerNight) || 0;
  const rows = (await queryHotels({ destination, start: win.start, end: win.end, apiNights }))
    .filter(r => r.nightlyPoints > 0 && (!roomType || r.roomType === roomType) && (!maxPerNight || r.nightlyPoints <= maxPerNight));

  // The same room can be both entered manually and returned by the API; keep the cheaper one.
  const best = new Map();
  for (const r of rows) {
    const k = `${(r.hotelId || r.name).toLowerCase()}:${r.checkIn}:${r.roomType}`;
    const prev = best.get(k);
    if (!prev || r.nightlyPoints < prev.nightlyPoints) best.set(k, r);
  }

  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  if (params.preserveFlexible != null) prefs.preserveFlexiblePoints = Boolean(params.preserveFlexible);
  const results = [...best.values()].map(r => {
    const totalPoints = r.nightlyPoints * nights;
    const cashUsd = r.cashValue ? r.cashValue * nights : null;
    const funding = fundPrograms({ [r.program]: totalPoints }, user.balances, transferData(), prefs);
    return {
      ...r, nights, totalPoints, cashUsd, programName: programName(r.program),
      cpp: r.cashValue ? (r.cashValue * 100) / r.nightlyPoints : null,
      effectiveCostUsd: funding?.pointsCostUsd ?? null,
      netValueUsd: funding && cashUsd != null ? cashUsd - funding.pointsCostUsd : null,
      funding, affordable: Boolean(funding)
    };
  });
  const by = {
    points: (a, b) => a.totalPoints - b.totalPoints,
    cpp: (a, b) => (b.cpp ?? -1) - (a.cpp ?? -1)
  }[params.rank] || ((a, b) => (a.effectiveCostUsd ?? Infinity) - (b.effectiveCostUsd ?? Infinity) || a.totalPoints - b.totalPoints);
  results.sort((a, b) => (b.affordable - a.affordable) || by(a, b));

  return {
    mode: results.length ? (results.some(r => r.affordable) ? 'results' : 'unaffordable') : 'no-inventory',
    query: { destination, checkIn: params.checkIn, checkOut, nights, window: win, roomType: roomType || 'any' },
    nights,
    dataStatus: status,
    rows: results.slice(0, MAX_HOTEL_RESULTS)
  };
}
