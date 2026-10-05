// Trip search: gather award inventory (seats.aero + local cache), pair legs, fund each option
// against the user's portfolio and rank.
import { resolveAirports } from './places.mjs';
import { normalizeCabin, programName } from './programs.mjs';
import { queryFlights, queryHotels, replaceApiAwards } from './awards.mjs';
import { searchSeatsAero } from './seatsaero.mjs';
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

export async function searchHotels(params) {
  if (!isoDate(params.checkIn)) throw badRequest('Choose a check-in date.');
  const checkOut = isoDate(params.checkOut) && params.checkOut > params.checkIn ? params.checkOut : shiftDate(params.checkIn, 1);
  const nights = nightsBetween(params.checkIn, checkOut);
  const win = dateWindow(params.checkIn, params.flexDays);
  const rows = await queryHotels({ destination: params.destination, start: win.start, end: win.end });
  const user = await loadUser();
  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  const results = [];
  for (const r of rows) {
    const total = r.nightlyPoints * nights;
    const funding = fundPrograms({ [r.program]: total }, user.balances, transferData(), prefs);
    results.push({
      ...r, nights, totalPoints: total, programName: programName(r.program),
      cpp: r.cashValue ? (r.cashValue * 100) / r.nightlyPoints : null,
      funding, affordable: Boolean(funding)
    });
  }
  results.sort((a, b) => (b.affordable - a.affordable) || ((b.cpp ?? 0) - (a.cpp ?? 0)));
  return { mode: results.length ? 'results' : 'no-inventory', nights, rows: results };
}
