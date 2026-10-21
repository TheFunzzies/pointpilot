// Trip search: gather award inventory (seats.aero + local cache), pair legs, fund each option
// against the user's portfolio and rank.
import { resolveAirports } from './places.mjs';
import { normalizeCabin, programName } from './programs.mjs';
import { queryFlights, queryHotels, replaceApiAwards, replaceApiHotels, observedTimestampSummary } from './awards.mjs';
import { recordDiagnosticSource } from './diagnostics.mjs';
import { searchSeatsAero } from './seatsaero.mjs';
import { searchRoomsAero, MAX_API_NIGHTS } from './roomsaero.mjs';
import { recordAwards, loadHistory, historicalContext } from './history.mjs';
import { evaluateTrip, fundPrograms, rankTrips, explainTrip, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { getSettings, loadUser } from './settings.mjs';
import { todayISO } from './transfers.mjs';
import { getTripsCached } from './flights.mjs';
import { applyTaxes } from './taxes.mjs';
import { balancesAfterPlan, getPlan as getStayPlan } from './stayplan.mjs';
import { awardsFor, reviewLinks, cachedInfo, hotelKey, searchOccupancyCashOffers } from './hotelinfo.mjs';
import { findProduct, hasProduct } from './cabins.mjs';
import { mapLimit } from './util.mjs';
import { isCalendarDate, assertCalendarDate, parseFiniteNumber, validateFlightPair, validateItinerary } from './validate.mjs';
import { normalizeTripPlan, objectFields, airportCode, itineraryId } from './itinerary.mjs';
import { assessTransitions } from './route-risk.mjs';
import { ApiError } from './errors.mjs';

const MAX_LEGS_PER_DIRECTION = 100;
const MAX_RESULTS = 30;
const inFlightQueries = new Map();
const recentApiQueries = new Map(); // query key -> refresh timestamp and truncation metadata

const shiftDate = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const isoDate = isCalendarDate;

function badRequest(message) { return new ApiError(message, 400, 'INVALID_INPUT'); }

export function dateWindow(date, flexDays, today = todayISO()) {
  assertCalendarDate(date);
  const f = parseFiniteNumber(flexDays ?? 0, { min: 0, max: 30, integer: true, name: 'flexDays' });
  let start = shiftDate(date, -f);
  if (start < today) start = today;
  const end = shiftDate(date, f);
  return { start, end };
}

// Share the complete refresh (including persistence/accounting) across simultaneous callers.
async function refreshShared(key, settings, status, fetchRows) {
  const merge = result => {
    if (status.api !== 'error' && (result.api !== 'recent-cache' || status.api !== 'fetched')) status.api = result.api;
    status.calls = (status.calls || 0) + (result.calls || 0);
    status.apiRows = (status.apiRows || 0) + (result.apiRows || 0);
    status.truncated ||= Boolean(result.truncated);
    status.warnings.push(...(result.warnings || []));
  };
  const last = recentApiQueries.get(key);
  if (last && Date.now() - last.at < settings.apiRefreshMinutes * 60000) { merge({ api: 'recent-cache', truncated: last.truncated }); return; }
  if (!inFlightQueries.has(key)) {
    const work = (async () => {
      try {
        const result = await fetchRows();
        recentApiQueries.set(key, { at: Date.now(), truncated: Boolean(result.truncated) });
        if (recentApiQueries.size > 500) recentApiQueries.delete(recentApiQueries.keys().next().value);
        return { api: 'fetched', ...result };
      } catch (e) { return { api: 'error', calls: e.calls || 0, warnings: [e.message] }; }
    })();
    inFlightQueries.set(key, work);
  }
  const work = inFlightQueries.get(key);
  try { merge(await work); } finally { if (inFlightQueries.get(key) === work) inFlightQueries.delete(key); }
}

/** Fetch from seats.aero when configured and the same query wasn't fetched recently. */
async function refreshFromApi(q, settings, status) {
  if (!settings.seatsAeroApiKey) { status.api = 'not-configured'; return; }
  const key = JSON.stringify(['seats', q.origins.slice().sort(), q.destinations.slice().sort(), q.start, q.end, q.cabin, settings.seatsAeroApiKey]);
  await refreshShared(key, settings, status, async () => {
    const { rows, calls, truncated } = await searchSeatsAero({ apiKey: settings.seatsAeroApiKey, ...q });
    await replaceApiAwards({ dataSource: 'seats.aero', ...q, truncated }, rows);
    try { await recordDiagnosticSource(observedTimestampSummary(rows, { source: 'seatsaero', completeness: truncated ? 'truncated' : 'complete', cacheTtlMinutes: settings.apiRefreshMinutes })); } catch { /* best-effort diagnostics */ }
    await recordAwards(rows, { sourceType: 'api_observation', sourceId: 'seats.aero' });
    return { apiRows: rows.length, calls, truncated };
  });
}

export function bestPerFlight(rows) {
  const map = new Map();
  for (const r of rows) {
    const identity = r.availabilityId || r.id || JSON.stringify([r.flightNumbers, r.direct, r.mileageCost]);
    const k = JSON.stringify([r.program, r.origin, r.destination, r.date, r.cabin, identity, r.mileageCost, r.totalTaxes]);
    const prev = map.get(k);
    if (!prev) map.set(k, { ...r, flights: [...(r.flights || [])] });
    else prev.flights = [...new Map([...(prev.flights || []), ...(r.flights || [])].map(f => [f.id || JSON.stringify(f), f])).values()];
  }
  return [...map.values()].sort((a, b) => a.mileageCost - b.mileageCost);
}

/**
 * Product hunt: load flight details (seats.aero trips, cached) for awards operated by the
 * product's airline so we can tell which flights actually have it. Only those awards are
 * expanded, to keep API use small.
 */
async function huntProduct(rows, prod, settings, status, cap = 15) {
  const carrier = prod.carrier;
  const operatedBy = r => String(r.airlines || '').toUpperCase().split(/[^A-Z0-9]+/).includes(carrier);
  const todo = settings.seatsAeroApiKey ? rows.filter(r => !r.flights?.length && r.availabilityId && operatedBy(r)).slice(0, cap) : [];
  if (rows.filter(r => !r.flights?.length && r.availabilityId && operatedBy(r)).length > cap) { status.truncated = true; status.warnings.push('Seat product details checked for a limited number of awards.'); }
  await mapLimit(todo, 4, async r => {
    try {
      const t = await getTripsCached({ apiKey: settings.seatsAeroApiKey, availabilityId: r.availabilityId, cabin: r.cabin }, n => { status.productHunt.calls += n; });
      r.flights = t.trips;
    } catch (e) { status.warnings.push(e.message); }
  });
  status.productHunt.checkedAwards += rows.filter(r => r.flights?.length && operatedBy(r)).length;
}

export async function searchTrip(params, { allowApi = true } = {}) {
  if (params?.schemaVersion !== undefined) {
    if (params.schemaVersion !== 2) throw new ApiError('Unsupported search schema version.', 400, 'UNSUPPORTED_SCHEMA');
    return searchItinerary(params, { allowApi });
  }
  // Looking for a specific seat (e.g. "AF|first|La Première") fixes the cabin to that product's.
  const prod = params.product ? findProduct(params.product) : null;
  if (params.product && !prod) throw badRequest('Unknown seat product.');
  const cabin = prod?.cabin || normalizeCabin(params.cabin) || 'business';
  const travelers = parseFiniteNumber(params.travelers ?? 1, { min: 1, max: 9, integer: true, name: 'travelers' });
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
    // Outbound and return are independent seats.aero queries: run them together.
    await Promise.all([refreshFromApi(outQ, settings, status), backQ && refreshFromApi(backQ, settings, status)]);
  }

  const usable = r => (!directOnly || r.direct === true || r.flights?.length) && (r.remainingSeats == null || r.remainingSeats >= travelers);
  const outRows = bestPerFlight((await queryFlights(outQ)).filter(usable));
  const backRows = backQ ? bestPerFlight((await queryFlights(backQ)).filter(usable)) : [];

  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}), ...(params.preferences || {}) };
  if (params.preserveFlexible != null) prefs.preserveFlexiblePoints = Boolean(params.preserveFlexible);
  const ctx = { travelers, origins, destinations, allowOpenJaw: params.allowOpenJaw === true, balances: user.balances, transfers: transferData(), prefs };

  if (prod) {
    status.productHunt = { key: prod.key, label: `${prod.airline} ${prod.product}`, carrier: prod.carrier, calls: 0, checkedAwards: 0 };
    await Promise.all([huntProduct(outRows, prod, settings, status), backQ && huntProduct(backRows, prod, settings, status)]);
  }

  // Each award becomes one option per individual flight (when seats.aero gave flight details).
  const history = await loadHistory();
  // How many awards arrived with flight-level details (seats.aero include_trips).
  status.flightDetails = { withFlights: [...outRows, ...backRows].filter(r => r.flights?.length).length, total: outRows.length + backRows.length };
  const outOptions = flightOptions(outRows, 'Outbound', { travelers, directOnly, history });
  const backOptions = backQ ? flightOptions(backRows, 'Return', { travelers, directOnly, history }) : [];

  // Mark flights with the wanted product and make sure they're considered for the recommendation.
  const top = list => {
    if (prod) list.forEach(o => { o.productMatch = hasProduct(o, prod); });
    // Fundability precedes caps; round-robin groups retain route/date/product diversity.
    const groups = new Map();
    for (const o of list) {
      const funded = Boolean(evaluateTrip([o], ctx));
      const key = JSON.stringify([funded, o.program, o.date, o.direct, o.productMatch || false, o.seatScore, Math.floor((o.flight?.totalDurationMin || 0) / 180)]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ o, funded });
    }
    const diverse = [];
    while (diverse.length < list.length) for (const group of groups.values()) if (group.length) diverse.push(group.shift());
    diverse.sort((a, b) => Number(b.funded) - Number(a.funded) || Number(b.o.productMatch || false) - Number(a.o.productMatch || false));
    return diverse.slice(0, MAX_LEGS_PER_DIRECTION).map(x => x.o);
  };
  if (prod) {
    status.productHunt.matches = { outbound: outOptions.filter(o => hasProduct(o, prod)).length, return: backOptions.filter(o => hasProduct(o, prod)).length };
  }
  const candidates = [];
  const outTop = top(outOptions);
  const backTop = backQ ? top(backOptions) : [];
  if (!backQ) {
    for (const o of outTop) candidates.push([o]);
  } else {
    for (const o of outTop) for (const b of backTop) {
      // The return must leave after the outbound lands (by time when known, otherwise by date).
      const ok = validateFlightPair([o, b], ctx).valid;
      if (ok) candidates.push([o, b]);
    }
  }

  const trips = [];
  for (const legs of candidates) {
    const t = scoreTrip(legs, ctx);
    if (t) trips.push(t);
  }
  let ranked = rankTrips(trips, params.rank);
  // With a product hunt, trips with more legs on that product come first.
  if (prod) ranked = ranked.map((t, i) => ({ t, i, n: t.legs.filter(l => l.productMatch).length })).sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.t);
  ranked = ranked.slice(0, MAX_RESULTS);

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
    truncated: Boolean(status.truncated || outOptions.length > outTop.length || backOptions.length > backTop.length || trips.length > MAX_RESULTS),
    truncatedReason: status.truncated ? 'API page limit reached' : (outOptions.length > outTop.length || backOptions.length > backTop.length || trips.length > MAX_RESULTS) ? 'Recommendation limit reached; all fetched options remain selectable' : null,
    query: { origins, destinations, cabin, travelers, out, back, directOnly, allowOpenJaw: params.allowOpenJaw === true, product: prod || null },
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

async function searchItinerary(params, options) {
  objectFields(params, ['schemaVersion','mode','travelers','segments'], 'itinerary search');
  if (!Array.isArray(params.segments) || !params.segments.length || params.segments.length > 6) throw badRequest('Search supports one to six itinerary legs.');
  const segments = params.segments.map(s => {
    objectFields(s, ['id','origins','destination','departDate','flexDays','cabin','nonstopOnly'], 'search segment');
    itineraryId(s.id);
    const { id, ...query } = s;
    return { id, query, award: null };
  });
  const plan = normalizeTripPlan({ schemaVersion: 2, mode: params.mode, travelers: params.travelers ?? 1, segments });
  // Validate every leg before any provider request; never turn malformed input into a partial result.
  const queries = plan.segments.map(s => {
    const q = s.query;
    const origins = resolveAirports(q.origins), destinations = resolveAirports(q.destination);
    if (origins.length > 100 || destinations.length > 100) throw badRequest('At most 100 airports are supported per search side.');
    origins.forEach(c => airportCode(c)); destinations.forEach(c => airportCode(c));
    if (dateWindow(q.departDate, q.flexDays).end < todayISO()) throw badRequest('Departure date is in the past.');
    return { id: s.id, ...q };
  });
  const results = await mapLimit(queries, 2, async ({ id, ...q }) => {
    try {
      const r = await searchTrip({ ...q, travelers: plan.travelers }, options);
      return { id, options: r.outbound, counts: r.counts, dataStatus: r.dataStatus, truncated: r.truncated, truncatedReason: r.truncatedReason,
        error: r.dataStatus.api === 'error' ? { code: 'API_ERROR', message: 'Availability refresh failed; any retained options are cached.' } : null };
    } catch (e) { return { id, options: [], counts: { outbound: 0 }, dataStatus: { api: 'error', warnings: [] }, truncated: false, truncatedReason: null, error: { code: e.code || 'SEARCH_FAILED', message: 'Availability search failed for this leg.' } }; }
  });
  return { schemaVersion: 2, query: { mode: plan.mode, travelers: plan.travelers, segments: queries }, segments: results, complete: false,
    gaps: queries.slice(1).map((q, i) => ({ fromSegmentId: queries[i].id, toSegmentId: q.id, from: resolveAirports(queries[i].destination), to: resolveAirports(q.origins), durationMinutes: null, durationSource: 'user-estimate' })) };
}


/** Expand award rows into selectable flight options for one direction. */
export function flightOptions(rows, leg, { travelers = 1, directOnly = false, history = [] } = {}) {
  const out = [];
  for (const row of rows) {
    const { flights = [], ...award } = row;
    const base = { ...award, awardId: row.id, leg, programName: programName(row.program), history: historicalContext(row, history) };
    if (!flights.length) { if (directOnly && row.direct !== true) continue; out.push({ ...base, flight: null, seatScore: null }); continue; }
    for (const f of flights) {
      if (directOnly && f.stops > 0) continue;
      if (f.remainingSeats != null && f.remainingSeats < travelers) continue;
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
    .map(o => applyTaxes(o, history))
    .sort((a, b) => a.mileageCost - b.mileageCost || (b.seatScore ?? -1) - (a.seatScore ?? -1) || (a.flight?.totalDurationMin ?? Infinity) - (b.flight?.totalDurationMin ?? Infinity));
}

function scoreTrip(legs, ctx) {
  if (!validateFlightPair(legs, ctx).valid) return null;
  const t = evaluateTrip(legs, ctx);
  if (!t) return null;
  t.id = legs.map(l => l.id).join('|');
  const scores = legs.map(l => l.seatScore).filter(s => s != null);
  t.seatScore = scores.length ? Math.min(...scores) : null;
  t.totalDurationMin = legs.every(l => l.flight) ? legs.reduce((s, l) => s + l.flight.totalDurationMin, 0) : null;
  for (const l of legs.filter(x => x.taxesMissing)) {
    t.warnings.push(l.taxesEstimate
      ? `${l.programName || l.program} didn't report taxes for the ${String(l.leg).toLowerCase()} flight; using ≈$${Math.round(l.taxesEstimate.value)}/person based on ${l.taxesEstimate.count} earlier ${l.taxesEstimate.basis === 'route' ? 'sightings on this route' : 'awards in this program'}. Confirm on the program's site.`
      : `${l.programName || l.program} didn't report taxes for the ${String(l.leg).toLowerCase()} flight and there's no history to estimate them; real cost will be higher. Check the program's site.`);
  }
  t.taxesEstimated = legs.some(l => l.taxesMissing);
  t.explanation = explainTrip(t);
  return t;
}

/**
 * Expand award rows that came without flight details into one option per flight, using
 * seats.aero's per-award trips endpoint (cached 6h). Rows with flights are returned unchanged.
 */
export async function expandAwards({ awards = [], leg = 'Outbound', travelers = 1, directOnly = false }) {
  travelers = parseFiniteNumber(travelers, { min: 1, max: 9, integer: true, name: 'travelers' });
  if (typeof directOnly !== 'boolean') throw badRequest('directOnly must be a boolean.');
  const settings = await getSettings();
  const history = await loadHistory();
  const out = [];
  const status = { calls: 0, warnings: [] };
  // Up to 4 trips requests at a time; results keep the original order.
  const groups = await mapLimit(awards.slice(0, 20), 4, async a => {
    if (a.flight || !a.availabilityId || !settings.seatsAeroApiKey) return (!directOnly || (a.flight ? a.flight.stops === 0 : a.direct === true)) ? [a] : [];
    try {
      const r = await getTripsCached({ apiKey: settings.seatsAeroApiKey, availabilityId: a.availabilityId, cabin: a.cabin }, n => { status.calls += n; });
      const { flight: _flight, seatScore: _seatScore, history: hist, taxesMissing, taxesEstimate: _taxesEstimate, reportedTaxes, ...row } = a;
      // Each flight carries its own taxes; don't let the award-level estimate leak in.
      if (taxesMissing) row.totalTaxes = reportedTaxes ?? null;
      const expanded = flightOptions([{ ...row, id: a.awardId || a.id, flights: r.trips }], leg, { travelers, directOnly, history });
      if (expanded.length && expanded[0].flight) expanded.forEach(o => { o.history = hist; o.bookingLinks = r.bookingLinks; });
      return expanded.length ? expanded : (directOnly ? [] : [a]);
    } catch (e) { status.warnings.push(e.message); return (!directOnly || a.direct === true) ? [a] : []; }
  });
  out.push(...groups.flat());
  return { options: out, dataStatus: status, truncated: awards.length > 20, truncatedReason: awards.length > 20 ? 'Expansion limited to 20 awards' : null };
}

/** Fund a specific outbound/return pair the user picked. */
export async function evaluateSelection(input) {
  if (input?.schemaVersion !== undefined) {
    if (input.schemaVersion !== 2) throw new ApiError('Unsupported evaluation schema version.', 400, 'UNSUPPORTED_SCHEMA');
    return evaluateItinerary(input);
  }
  const { legs = [], travelers: requestedTravelers = 1, preserveFlexible = null, allowOpenJaw = false, origins = [], destinations = [] } = input;
  let travelers = requestedTravelers;
  if (!Array.isArray(legs) || !legs.length || legs.length > 2) throw badRequest('Pick an outbound flight (and optionally a return).');
  travelers = parseFiniteNumber(travelers, { min: 1, max: 9, integer: true, name: 'travelers' });
  const validity = validateFlightPair(legs, { travelers, allowOpenJaw, origins, destinations });
  if (!validity.valid) return { ...validity, affordable: false, trip: null, reason: validity.invalidReason };
  const user = await loadUser();
  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  if (preserveFlexible != null) prefs.preserveFlexiblePoints = Boolean(preserveFlexible);
  const ctx = { travelers, allowOpenJaw, origins, destinations, balances: user.balances, transfers: transferData(), prefs };
  const t = scoreTrip(legs, ctx);
  if (t) return { valid: true, invalidReason: null, affordable: true, trip: t };
  // Not fundable: say whether the transfer limit is the reason.
  const relaxed = evaluateTrip(legs, { ...ctx, prefs: { ...prefs, maxTransfers: Infinity } });
  return { valid: true, invalidReason: null, affordable: false, trip: null, reason: relaxed ? `Needs ${relaxed.transfers} transfers; your limit is ${prefs.maxTransfers}.` : 'Your balances and transfer partners can\'t cover this pair.' };
}

async function evaluateItinerary(input) {
  objectFields(input, ['schemaVersion','mode','travelers','segments','transitions','preserveFlexible','allowOpenJaw','origins','destinations'], 'itinerary evaluation');
  const { preserveFlexible, ...document } = input;
  // Bad schemas are input errors; structurally valid drafts return an explicit incomplete result.
  const plan = normalizeTripPlan(document);
  const validity = validateItinerary(plan, { requireComplete: true });
  const assessment = assessTransitions(plan);
  if (!validity.valid) return { ...validity, risks: assessment.risks, affordable: false, trip: null, fundingStatus: 'incomplete' };
  const stays = await getStayPlan({ includeFunding: false });
  if (stays.stays.length > 20 || stays.migrationWarnings.length) throw new ApiError('The stay plan must be corrected before evaluating the trip.', 400, 'INVALID_STAY_PLAN');
  const user = await loadUser();
  const needs = {};
  const add = (program, points) => {
    const total = (needs[program] || 0) + points;
    if (!Number.isSafeInteger(total) || total < 0) throw badRequest('Combined points exceed safe integer limits.');
    needs[program] = total;
  };
  for (const s of plan.segments) add(s.award.program, s.award.mileageCost * plan.travelers);
  for (const s of stays.stays) add(s.program, s.totalPoints);
  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  if (preserveFlexible != null) { if (typeof preserveFlexible !== 'boolean') throw badRequest('preserveFlexible must be boolean.'); prefs.preserveFlexiblePoints = preserveFlexible; }
  const funding = fundPrograms(needs, user.balances, transferData(), prefs);
  // fundPrograms does not expose why null was returned. Zero wallet is a proven shortfall;
  // otherwise a bounded search failure is deliberately not represented as impossibility.
  const fundingStatus = funding ? 'funded' : (user.balances || []).every(b => Number(b.balance) === 0) ? 'unfunded' : 'search-limited';
  const taxes = plan.segments.reduce((n, s) => n + (s.award.totalTaxes || 0) * plan.travelers, 0);
  const trip = funding ? { legs: plan.segments.map(s => s.award), stays: stays.stays, travelers: plan.travelers, needs, funding, ...funding, taxesUsd: taxes,
    warnings: [...(funding.warnings || []), ...assessment.risks.map(r => r.reason)] } : null;
  return { ...validity, risks: assessment.risks, affordable: Boolean(funding), trip, fundingStatus,
    reason: funding ? null : fundingStatus === 'unfunded' ? 'The wallet has no points to cover this itinerary.' : 'No funding plan was found within the supported search; this does not prove the itinerary is impossible.' };
}

const nightsBetween = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
const MAX_HOTEL_RESULTS = 40;

export function normalizeHotelRoomRequests(input, roomType = 'standard') {
  const rooms = input ?? [{ adults: 2, childrenAges: [], roomType: ['standard','suite'].includes(roomType) ? roomType : 'standard' }];
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 4) throw badRequest('Choose one to four room allocations.');
  return rooms.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['adults','childrenAges','roomType'].includes(k))) throw badRequest(`Room ${i + 1} allocation is invalid.`);
    const adults = parseFiniteNumber(r.adults, { min: 1, max: 8, integer: true, name: 'room adults' });
    const childrenAges = r.childrenAges ?? [];
    if (!Array.isArray(childrenAges) || childrenAges.length > 6) throw badRequest('Each room supports zero to six children.');
    const ages = childrenAges.map(age => parseFiniteNumber(age, { min: 0, max: 17, integer: true, name: 'child age' }));
    const type = r.roomType ?? 'standard';
    if (!['standard','suite','any'].includes(type)) throw badRequest('Room type must be standard, suite or any.');
    return { adults, childrenAges: ages, roomType: type };
  });
}

async function refreshHotelsFromApi(q, settings, status) {
  if (!settings.seatsAeroApiKey) { status.api = 'not-configured'; return; }
  const key = JSON.stringify(['rooms', q.searchLocation.toLowerCase(), q.start, q.end, q.apiNights, settings.seatsAeroApiKey]);
  await refreshShared(key, settings, status, async () => {
    const { rows, calls, truncated } = await searchRoomsAero({ apiKey: settings.seatsAeroApiKey, location: q.searchLocation, start: q.start, end: q.end, stayNights: q.stayNights });
    await replaceApiHotels({ ...q, truncated }, rows);
    try { await recordDiagnosticSource(observedTimestampSummary(rows, { source: 'roomsaero', completeness: truncated ? 'truncated' : 'complete', cacheTtlMinutes: settings.apiRefreshMinutes })); } catch { /* best-effort diagnostics */ }
    await recordAwards(rows, { sourceType: 'api_observation', sourceId: 'rooms.aero' });
    return { apiRows: rows.length, calls, truncated };
  });
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
  params ||= {};
  const rooms = normalizeHotelRoomRequests(params.rooms, params.roomType || 'standard');
  const currency = params.currency ?? 'USD';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw badRequest('Currency must be a three-letter ISO code.');
  params = { ...params, rooms, currency };
  const cities = splitCities(params.destination);
  if (!cities.length) throw badRequest('Enter one or more cities, e.g. "Tokyo, Kyoto".');
  const perCity = [];
  perCity.push(...await mapLimit(cities, 3, async city => ({ city, ...(await searchHotelsInCity({ ...params, destination: city }, opts)) })));
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
    truncated: perCity.some(c => c.truncated),
    truncatedReason: perCity.find(c => c.truncated)?.truncatedReason || null,
    unfunded: perCity.some(c => c.unfunded),
    cities: summary,
    dataStatus: { calls: perCity.reduce((n, c) => n + (c.dataStatus.calls || 0), 0), api: perCity.map(c => c.dataStatus.api).includes('fetched') ? 'fetched' : first.dataStatus.api, warnings: [...new Set(perCity.flatMap(c => c.dataStatus.warnings))], planNote: first.dataStatus.planNote || null },
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

  const roomRequests = params.rooms;
  const currency = params.currency;
  const roomType = ['standard', 'suite'].includes(params.roomType) ? params.roomType : null;
  const maxPerNight = parseFiniteNumber(params.maxPointsPerNight === '' ? 0 : params.maxPointsPerNight ?? 0, { min: 0, max: 1e9, name: 'maxPointsPerNight' });
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
  // Fund the saved plan and candidate together, retaining transfer rounding credits.
  const after = await balancesAfterPlan(user);
  if (after.stays) status.planNote = { stays: after.stays, committed: after.committed, unfunded: Boolean(after.unfunded) };
  const cityOf = r => r.hotelCity || destination;
  const info = await cachedInfo([...best.values()].map(r => ({ name: r.name, city: cityOf(r) })));
  const rateKey = r => JSON.stringify([r.program, (r.hotelId || r.name).toLowerCase(), r.checkIn, r.pricedNights ?? r.apiNights ?? nights, r.roomType]);
  const rates = new Map([...best.values()].map(r => [rateKey(r), r]));
  const results = [...best.values()].map(r => {
    const infoKey = hotelKey(r.name, cityOf(r));
    const quality = { infoKey, info: info[infoKey] || null, awards: awardsFor({ name: r.name, location: r.location, city: cityOf(r) }), reviewLinks: reviewLinks({ name: r.name, location: r.location }) };
    r = { ...r, ...quality };
    const totalPoints = r.pricedNights === nights && r.pricedTotalPoints != null ? r.pricedTotalPoints : Math.round((r.pricedTotalPoints != null ? r.pricedTotalPoints / r.pricedNights : r.nightlyPoints) * nights);
    const cashUsd = r.pricedNights === nights && r.pricedTotalCash != null ? r.pricedTotalCash : r.cashValue ? r.cashValue * nights : null;
    const perRoom = roomRequests.map(request => {
      const requestedType = request.roomType === 'any' ? r.roomType : request.roomType;
      const matching = rates.get(rateKey({ ...r, roomType: requestedType }));
      const selected = matching || r;
      const points = selected.pricedNights === nights && selected.pricedTotalPoints != null ? selected.pricedTotalPoints : Math.round((selected.pricedTotalPoints != null ? selected.pricedTotalPoints / selected.pricedNights : selected.nightlyPoints) * nights);
      return { ...request, observedPoints: points, sourceRoomType: selected.roomType, typeMismatch: selected.roomType !== requestedType };
    });
    const observedSingleRoomPoints = totalPoints;
    const estimatedPointsForRooms = perRoom.reduce((sum, room) => sum + room.observedPoints, 0);
    const multiRoom = roomRequests.length > 1;
    const roomTypeMismatch = perRoom.some(room => room.typeMismatch);
    const funding = fundPrograms({ ...after.needs, [r.program]: (after.needs?.[r.program] || 0) + estimatedPointsForRooms }, user.balances, transferData(), prefs);
    return {
      ...r, estimated: multiRoom || roomTypeMismatch || nights > MAX_API_NIGHTS || (r.dataSource === 'rooms.aero' ? (r.pricedNights ?? r.apiNights) !== nights : Boolean(r.estimated)), nights, totalPoints: estimatedPointsForRooms, observedSingleRoomPoints, estimatedPointsForRooms, roomTypeMismatch, roomEstimate: { rooms: roomRequests.length, singleRoomPoints: observedSingleRoomPoints, points: estimatedPointsForRooms, estimated: multiRoom || roomTypeMismatch, roomTypeMismatch, allocation: perRoom }, roomEstimateLabel: roomTypeMismatch ? `Estimated points for ${roomRequests.length} rooms; requested ${perRoom.find(room => room.typeMismatch)?.roomType}, observed ${r.roomType}` : `Estimated points for ${roomRequests.length} rooms`, inventoryStatus: 'unknown', occupancyStatus: 'unverified', feeStatus: 'unknown', rooms: roomRequests, cashOffers: [], cashUsd: multiRoom ? null : cashUsd, programName: programName(r.program),
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
  if (params.cashOffers === true && settings.serpApiKey) {
    for (const row of results.slice(0, 5)) {
      try { row.cashOffers = await searchOccupancyCashOffers({ hotel: { name: row.name, city: row.hotelCity || destination, latitude: row.latitude, longitude: row.longitude, location: row.location }, checkIn: params.checkIn, checkOut, rooms: roomRequests, currency, apiKey: settings.serpApiKey }); }
      catch { status.warnings.push('Occupancy-specific hotel cash offers could not be loaded.'); }
    }
  }

  return {
    mode: results.length ? (results.some(r => r.affordable) ? 'results' : 'unaffordable') : 'no-inventory',
    query: { destination, checkIn: params.checkIn, checkOut, nights, window: win, roomType: roomType || 'any', rooms: roomRequests, currency },
    nights,
    dataStatus: status,
    truncated: Boolean(status.truncated || results.length > MAX_HOTEL_RESULTS),
    truncatedReason: results.length > MAX_HOTEL_RESULTS ? 'Hotel result limit reached' : status.truncated ? 'API page limit reached' : null,
    unfunded: Boolean(after.unfunded),
    rows: results.slice(0, MAX_HOTEL_RESULTS)
  };
}
