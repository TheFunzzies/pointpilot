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
import { getTripsCached } from './flights.mjs';

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

  const usable = r => (!directOnly || r.direct === true || r.flights?.length) && (r.remainingSeats == null || r.remainingSeats >= travelers);
  const outRows = bestPerFlight((await queryFlights(outQ)).filter(usable));
  const backRows = backQ ? bestPerFlight((await queryFlights(backQ)).filter(usable)) : [];

  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}), ...(params.preferences || {}) };
  if (params.preserveFlexible != null) prefs.preserveFlexiblePoints = Boolean(params.preserveFlexible);
  const ctx = { travelers, balances: user.balances, transfers: transferData(), prefs };

  // Each award becomes one option per individual flight (when seats.aero gave flight details).
  const history = await loadHistory();
  // How many awards arrived with flight-level details (seats.aero include_trips).
  status.flightDetails = { withFlights: [...outRows, ...backRows].filter(r => r.flights?.length).length, total: outRows.length + backRows.length };
  const outOptions = flightOptions(outRows, 'Outbound', { travelers, directOnly, history });
  const backOptions = backQ ? flightOptions(backRows, 'Return', { travelers, directOnly, history }) : [];

  const candidates = [];
  const outTop = outOptions.slice(0, MAX_LEGS_PER_DIRECTION);
  if (!backQ) {
    for (const o of outTop) candidates.push([o]);
  } else {
    for (const o of outTop) for (const b of backOptions.slice(0, MAX_LEGS_PER_DIRECTION)) {
      // The return must leave after the outbound lands (by time when known, otherwise by date).
      const ok = o.flight?.arriveUtc && b.flight?.departUtc ? b.flight.departUtc > o.flight.arriveUtc : b.date >= o.date;
      if (ok) candidates.push([o, b]);
    }
  }

  const trips = [];
  for (const legs of candidates) {
    const t = scoreTrip(legs, ctx);
    if (t) trips.push(t);
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
    cheapestOutbound: outRows.slice(0, 5).map(r => ({ ...r, flights: undefined, programName: programName(r.program) })),
    cheapestReturn: backRows.slice(0, 5).map(r => ({ ...r, flights: undefined, programName: programName(r.program) })),
    // Pick-your-own: every flight option per direction, plus the recommended pair.
    outbound: outOptions,
    return: backOptions,
    recommended: ranked[0] ? { ids: ranked[0].legs.map(l => l.id), trip: ranked[0] } : null,
    // Other good pairs (legs reduced to ids to keep the payload small).
    trips: ranked.map((t, i) => (i === 0 ? t : { ...t, legs: t.legs.map(l => ({ id: l.id, leg: l.leg, program: l.program, programName: l.programName, origin: l.origin, destination: l.destination, date: l.date, availabilityId: l.availabilityId, cabin: l.cabin, direct: l.direct })) }))
  };
}

const MAX_OPTIONS_PER_DIRECTION = 150;

/** Expand award rows into selectable flight options for one direction. */
export function flightOptions(rows, leg, { travelers = 1, directOnly = false, history = [] } = {}) {
  const out = [];
  for (const row of rows) {
    const { flights = [], ...award } = row;
    const base = { ...award, awardId: row.id, leg, programName: programName(row.program), history: historicalContext(row, history) };
    if (!flights.length) { out.push({ ...base, flight: null, seatScore: null }); continue; }
    for (const f of flights) {
      if (directOnly && f.stops > 0) continue;
      if (f.remainingSeats && f.remainingSeats < travelers) continue;
      out.push({
        ...base,
        id: `${row.id}#${f.id}`,
        mileageCost: f.mileageCost || row.mileageCost,
        totalTaxes: f.taxes ?? row.totalTaxes,
        remainingSeats: f.remainingSeats ?? row.remainingSeats,
        direct: f.stops === 0,
        airlines: f.airlines.join(', ') || row.airlines,
        flight: f,
        seatScore: f.product?.score ?? null
      });
    }
  }
  return out
    .sort((a, b) => a.mileageCost - b.mileageCost || (b.seatScore ?? -1) - (a.seatScore ?? -1) || (a.flight?.totalDurationMin ?? Infinity) - (b.flight?.totalDurationMin ?? Infinity))
    .slice(0, MAX_OPTIONS_PER_DIRECTION);
}

function scoreTrip(legs, ctx) {
  const t = evaluateTrip(legs, ctx);
  if (!t) return null;
  t.id = legs.map(l => l.id).join('|');
  const scores = legs.map(l => l.seatScore).filter(s => s != null);
  t.seatScore = scores.length ? Math.min(...scores) : null;
  t.totalDurationMin = legs.every(l => l.flight) ? legs.reduce((s, l) => s + l.flight.totalDurationMin, 0) : null;
  t.explanation = explainTrip(t);
  return t;
}

/**
 * Expand award rows that came without flight details into one option per flight, using
 * seats.aero's per-award trips endpoint (cached 6h). Rows with flights are returned unchanged.
 */
export async function expandAwards({ awards = [], leg = 'Outbound', travelers = 1 }) {
  const settings = await getSettings();
  const out = [];
  const status = { calls: 0, warnings: [] };
  for (const a of awards.slice(0, 20)) {
    if (a.flight || !a.availabilityId || !settings.seatsAeroApiKey) { out.push(a); continue; }
    try {
      const r = await getTripsCached({ apiKey: settings.seatsAeroApiKey, availabilityId: a.availabilityId, cabin: a.cabin }, async n => { status.calls += n; await recordApiCalls(n, 'seats'); });
      const { flight, seatScore, history, ...row } = a;
      const expanded = flightOptions([{ ...row, id: a.awardId || a.id, flights: r.trips }], leg, { travelers });
      if (expanded.length && expanded[0].flight) expanded.forEach(o => { o.history = history; o.bookingLinks = r.bookingLinks; });
      out.push(...(expanded.length ? expanded : [a]));
    } catch (e) { status.warnings.push(e.message); out.push(a); }
  }
  return { options: out, dataStatus: status };
}

/** Fund a specific outbound/return pair the user picked. */
export async function evaluateSelection({ legs = [], travelers = 1, preserveFlexible = null }) {
  if (!Array.isArray(legs) || !legs.length || legs.length > 2) throw badRequest('Pick an outbound flight (and optionally a return).');
  const user = await loadUser();
  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  if (preserveFlexible != null) prefs.preserveFlexiblePoints = Boolean(preserveFlexible);
  const ctx = { travelers: Math.max(1, Math.round(Number(travelers) || 1)), balances: user.balances, transfers: transferData(), prefs };
  const t = scoreTrip(legs, ctx);
  if (t) return { affordable: true, trip: t };
  // Not fundable: say whether the transfer limit is the reason.
  const relaxed = evaluateTrip(legs, { ...ctx, prefs: { ...prefs, maxTransfers: Infinity } });
  return { affordable: false, trip: null, reason: relaxed ? `Needs ${relaxed.transfers} transfers; your limit is ${prefs.maxTransfers}.` : 'Your balances and transfer partners can\'t cover this pair.' };
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

/** Split "Tokyo, Kyoto" / "Tokyo; Kyoto" / "Tokyo and Kyoto" into cities (max 5). */
export function splitCities(input) {
  return [...new Set(String(input || '').split(/[,;/]|\band\b|&/i).map(s => s.trim()).filter(Boolean).map(s => s.replace(/\s+/g, ' ')))].slice(0, 5);
}

/**
 * Hotel award search for one room in one or more cities.
 * params: { destination: "Tokyo, Kyoto", checkIn, checkOut, flexDays, roomType: any|standard|suite, maxPointsPerNight, rank }
 * Each city is searched separately; `cities` summarizes them side by side.
 */
export async function searchHotels(params, opts = {}) {
  const cities = splitCities(params.destination);
  if (!cities.length) throw badRequest('Enter one or more cities, e.g. "Tokyo, Kyoto".');
  const perCity = [];
  for (const city of cities) perCity.push({ city, ...(await searchHotelsInCity({ ...params, destination: city }, opts)) });
  const rows = perCity.flatMap(c => c.rows.map(r => ({ ...r, city: c.city })));
  const summary = perCity.map(c => {
    const ok = c.rows.filter(r => r.affordable);
    const cheapest = c.rows.reduce((m, r) => (!m || r.totalPoints < m.totalPoints ? r : m), null);
    const bestValue = ok.reduce((m, r) => (!m || (r.effectiveCostUsd ?? Infinity) < (m.effectiveCostUsd ?? Infinity) ? r : m), null);
    return {
      city: c.city, count: c.rows.length, affordable: ok.length,
      programs: [...new Set(c.rows.map(r => r.programName))],
      cheapest: cheapest && { name: cheapest.name, programName: cheapest.programName, nightlyPoints: cheapest.nightlyPoints, totalPoints: cheapest.totalPoints, category: cheapest.category },
      bestValue: bestValue && { name: bestValue.name, programName: bestValue.programName, totalPoints: bestValue.totalPoints, effectiveCostUsd: bestValue.effectiveCostUsd, cpp: bestValue.cpp }
    };
  });
  const first = perCity[0];
  return {
    mode: rows.length ? (rows.some(r => r.affordable) ? 'results' : 'unaffordable') : 'no-inventory',
    query: { ...first.query, destination: cities.join(', '), cities },
    nights: first.nights,
    cities: summary,
    dataStatus: { api: perCity.map(c => c.dataStatus.api).includes('fetched') ? 'fetched' : first.dataStatus.api, warnings: [...new Set(perCity.flatMap(c => c.dataStatus.warnings))] },
    rows
  };
}

async function searchHotelsInCity(params, { allowApi = true } = {}) {
  const destination = String(params.destination || '').trim();
  if (!destination) throw badRequest('Enter a city to search hotels.');
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
