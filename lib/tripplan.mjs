// Trip Builder: assembles the whole trip — award flights, hotel stays (from the stay plan) and
// "positioning" flights between your real home airport and the award's departure airport
// (e.g. BOS → JFK before an ANA award from JFK, JFK → BOS after the return).
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { getPlan as getStayPlan } from './stayplan.mjs';
import { fundPrograms, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { loadUser, getSettings } from './settings.mjs';
import { programName } from './programs.mjs';
import { googleFlightsUrl } from './serpapi.mjs';
import { routeFares } from './travelpayouts.mjs';
import { searchSeatsAero } from './seatsaero.mjs';
import { flightOptions } from './search.mjs';
import { describe, localTime } from './geo.mjs';
import { recordFares, priceFare, googleCash } from './cash.mjs';
import { assertCalendarDate, parseFiniteNumber, validateFlightPair, validateItinerary } from './validate.mjs';
import { normalizeCabin } from './programs.mjs';
import { normalizeTripPlan, normalizeSelectedAward, airportCode, objectFields, planHash, itineraryId } from './itinerary.mjs';
import { assessTransitions } from './route-risk.mjs';
import { ApiError } from './errors.mjs';
export { normalizeTripPlan } from './itinerary.mjs';

const FILE = () => dataFile('trip-plan.json');
const EMPTY = normalizeTripPlan({});
const bad = m => new ApiError(m, 400, 'INVALID_INPUT');
const DIRS = ['outbound', 'return'];
const code = s => String(s || '').trim().toUpperCase();
const HOUR = 3600000;

function legacyView(p) {
  const outbound = p.segments.find(s => s.id === 'outbound') || (p.segments[0]?.id !== 'return' ? p.segments[0] : null);
  const ret = p.segments.find(s => s.id === 'return') || (p.segments.length > 1 ? p.segments.at(-1) : null);
  return { ...p, flights: { outbound: outbound?.award || null, return: ret?.award || null } };
}
async function load() { return legacyView(normalizeTripPlan(await readJson(FILE(), {}), { strict: false })); }
const save = (mutate, { pair = false, expectedRevision } = {}) => updateJson(FILE(), structuredClone(EMPTY), raw => {
  const next = legacyView(normalizeTripPlan(raw, { strict: false }));
  if (expectedRevision !== undefined && expectedRevision !== next.revision) throw new ApiError('The trip plan changed; reload before editing.', 409, 'PLAN_CHANGED');
  if (pair && next.segments.length > 2) throw new ApiError('Use the itinerary editor for a multi-city plan.', 409, 'MULTICITY_PLAN');
  mutate(next);
  if (pair) {
    next.segments = DIRS.filter(dir => next.flights[dir]).map(id => ({ id, query: next.segments.find(s => s.id === id)?.query || null, award: next.flights[id], ticketGroupId: null }));
    next.mode = next.segments.length === 2 ? next.allowOpenJaw ? 'open-jaw' : 'round-trip' : 'one-way';
    next.transitions = [];
  }
  const { flights: _flights, migrationWarnings: _warnings, ...document } = next;
  const normalized = normalizeTripPlan(document);
  for (const dir of DIRS) if (next.positioning[dir]) {
    const check = positioningFit(positioningNeed(next, dir), next.positioning[dir], next.travelers);
    if (check.fits === false) throw bad(check.incompatibleReason);
  }
  if (next.revision >= Number.MAX_SAFE_INTEGER) throw bad('Plan revision limit reached.');
  return { ...normalized, revision: next.revision + 1 };
});

// Keep only what the builder needs from an award option.
export function slimAward(o) { return normalizeSelectedAward(o); }

export async function setFlights(input) {
  objectFields(input, ['outbound','return','travelers','cabin','allowOpenJaw','origins','destinations','expectedRevision'], 'flight selection');
  const { outbound = undefined, return: ret = undefined, travelers, cabin, allowOpenJaw, origins, destinations, expectedRevision } = input;
  await save(p => {
    if (outbound !== undefined) p.flights.outbound = outbound ? slimAward({ ...outbound, cabin: outbound.cabin || cabin || p.cabin }) : null;
    if (ret !== undefined) p.flights.return = ret ? slimAward({ ...ret, cabin: ret.cabin || cabin || p.cabin }) : null;
    if (travelers != null) p.travelers = parseFiniteNumber(travelers, { min: 1, max: 9, integer: true, name: 'travelers' });
    if (cabin) { if (!normalizeCabin(cabin)) throw bad('Invalid cabin.'); p.cabin = normalizeCabin(cabin); }
    for (const [key, codes] of Object.entries({ origins, destinations })) if (codes !== undefined) {
      if (!Array.isArray(codes) || codes.some(c => typeof c !== 'string' || !/^[A-Z]{3}$/.test(c))) throw bad(key + ' must be an array of airport codes.');
      p[key] = [...new Set(codes)];
    }
    if (allowOpenJaw != null) { if (typeof allowOpenJaw !== 'boolean') throw bad('allowOpenJaw must be boolean.'); p.allowOpenJaw = allowOpenJaw; }
    const validity = validateFlightPair(DIRS.map(d => p.flights[d]).filter(Boolean), { travelers: p.travelers, allowOpenJaw: p.allowOpenJaw, origins: p.origins, destinations: p.destinations });
    if (DIRS.some(d => p.flights[d]) && !validity.valid) throw bad(validity.invalidReason);
    // Positioning picks depend on the award flights; clear them when those change.
    if (outbound !== undefined) p.positioning.outbound = null;
    if (ret !== undefined) p.positioning.return = null;
    // Default the home airports to the award airports until the user says otherwise.
    if (!p.home.origin && p.flights.outbound) p.home.origin = p.flights.outbound.origin;
    if (!p.home.returnTo) p.home.returnTo = p.home.origin;
  }, { pair: true, expectedRevision });
  return getTripPlan();
}

export async function updateTripSettings(input) {
  objectFields(input, ['home','buffers','travelers','expectedRevision'], 'trip settings');
  const { home, buffers, travelers, expectedRevision } = input;
  if (home != null) objectFields(home, ['origin','returnTo'], 'home');
  if (buffers != null) objectFields(buffers, ['outboundHours','returnHours'], 'buffers');
  await save(p => {
    if (home) {
      if (home.origin != null) { const c = airportCode(code(home.origin), true); if (c !== p.home.origin) p.positioning.outbound = null; p.home.origin = c; }
      if (home.returnTo != null) { const c = airportCode(code(home.returnTo), true); if (c !== p.home.returnTo) p.positioning.return = null; p.home.returnTo = c; }
    }
    if (buffers) for (const k of ['outboundHours', 'returnHours']) if (buffers[k] != null) p.buffers[k] = parseFiniteNumber(buffers[k], { min: 0.5, max: 24, name: k });
    if (travelers != null) p.travelers = parseFiniteNumber(travelers, { min: 1, max: 9, integer: true, name: 'travelers' });
  }, { expectedRevision });
  return getTripPlan();
}

export async function removeFlight(dir) {
  if (!DIRS.includes(dir)) throw bad('direction must be outbound or return');
  await save(p => { p.flights[dir] = null; p.positioning[dir] = null; }, { pair: true });
  return getTripPlan();
}

export async function setPositioning(dir, option) {
  if (!DIRS.includes(dir)) throw bad('direction must be outbound or return');
  await save(p => {
    if (option) {
      const need = positioningNeed(p, dir);
      if (!need) throw bad('No positioning flight is needed for this direction.');
      if (!['award', 'cash'].includes(option.kind)) throw bad('Positioning kind must be award or cash.');
      const day = option.departDate || option.date || option.flight?.depart?.date || option.departUtc?.slice(0, 10);
      assertCalendarDate(day, 'positioning date');
      const delta = (Date.parse(day) - Date.parse(need.date)) / 86400000;
      if (dir === 'outbound' ? delta < -1 || delta > 0 : delta < 0 || delta > 1) throw bad('Positioning date is incompatible with the connection.');
      if (option.kind === 'cash') parseFiniteNumber(option.price, { min: 0, max: 1e7, name: 'positioning price' });
      const assessment = positioningFit(need, option, p.travelers);
      if (assessment.fits === false) throw bad(assessment.incompatibleReason);
      const savedOption = { ...option };
      if (option.kind === 'cash') for (const field of ['total','perTraveler','exactComparable','pricingLabel','oneAdultEstimate']) delete savedOption[field];
      p.positioning[dir] = { ...savedOption, date: day, chosenAt: new Date().toISOString() };
    } else p.positioning[dir] = null;
  });
  return getTripPlan();
}

export async function clearTrip() {
  await save(p => { p.segments = []; p.transitions = []; p.mode = 'one-way'; p.positioning = { outbound: null, return: null }; });
  return getTripPlan();
}

/** Atomically replace an ordered draft or complete itinerary. */
export async function saveItinerary(input) {
  objectFields(input, ['schemaVersion','expectedRevision','mode','travelers','segments','transitions','home','buffers','allowOpenJaw','origins','destinations','cabin','positioning'], 'itinerary request');
  if (input.schemaVersion !== 2) throw bad('schemaVersion must be 2.');
  const expectedRevision = parseFiniteNumber(input.expectedRevision, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, name: 'expectedRevision' });
  if (!Array.isArray(input.segments) || !input.segments.length) throw bad('An itinerary requires one to six legs.');
  await save(p => {
    const { expectedRevision: _revision, ...fields } = input;
    const candidate = { ...Object.fromEntries(Object.entries(p).filter(([key]) => !['flights','migrationWarnings'].includes(key))), ...fields };
    if (fields.transitions === undefined) candidate.transitions = p.transitions.filter(t => {
      const i = candidate.segments.findIndex(s => s.id === t.fromSegmentId);
      return i >= 0 && candidate.segments[i + 1]?.id === t.toSegmentId;
    });
    // An existing transfer estimate is tied to both selected flights and their adjacency.
    candidate.transitions = candidate.transitions.map(t => {
      const oldA = p.segments.find(s => s.id === t.fromSegmentId), oldB = p.segments.find(s => s.id === t.toSegmentId);
      const newA = candidate.segments.find(s => s.id === t.fromSegmentId), newB = candidate.segments.find(s => s.id === t.toSegmentId);
      const existing = p.transitions.find(x => x.fromSegmentId === t.fromSegmentId && x.toSegmentId === t.toSegmentId);
      if (existing && planHash(t) === planHash(existing) && (planHash(oldA?.award) !== planHash(newA?.award) || planHash(oldB?.award) !== planHash(newB?.award))) return { ...t, ground: null, bufferMinutes: 0 };
      return t;
    });
    if (planHash(p.segments[0]?.award) !== planHash(candidate.segments[0]?.award)) candidate.positioning = { ...candidate.positioning, outbound: null };
    if (planHash(p.segments.at(-1)?.award) !== planHash(candidate.segments.at(-1)?.award)) candidate.positioning = { ...candidate.positioning, return: null };
    const next = normalizeTripPlan(candidate);
    Object.assign(p, next, { flights: legacyView(next).flights });
  }, { expectedRevision });
  return getTripPlan();
}

export async function removeSegment(id, { expectedRevision } = {}) {
  itineraryId(id);
  expectedRevision = parseFiniteNumber(expectedRevision, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, name: 'expectedRevision' });
  await save(p => {
    const index = p.segments.findIndex(s => s.id === id);
    if (index < 0) throw new ApiError('Itinerary leg not found.', 404, 'SEGMENT_NOT_FOUND');
    if (index === 0) p.positioning.outbound = null;
    if (index === p.segments.length - 1) p.positioning.return = null;
    p.segments.splice(index, 1);
    p.transitions = p.transitions.filter(t => t.fromSegmentId !== id && t.toSegmentId !== id);
    if (p.segments.length < 2) p.mode = 'one-way';
    else if (['open-jaw','round-trip'].includes(p.mode)) p.mode = 'multi-city';
    p.flights = legacyView(p).flights;
  }, { expectedRevision });
  return getTripPlan();
}

/** What a positioning flight must do for a direction (route, date, time limit), or null. */
function positioningNeed(p, dir) {
  const award = p.flights[dir];
  if (!award) return null;
  if (dir === 'outbound') {
    const home = p.home.origin;
    if (!home || home === award.origin) return null;
    const depUtc = Number.isFinite(Date.parse(award.flight?.departUtc)) && Number.isFinite(p.buffers.outboundHours) ? award.flight.departUtc : null;
    return {
      from: home, to: award.origin, date: award.flight?.depart?.date || award.date,
      latestArrivalUtc: depUtc ? new Date(Date.parse(depUtc) - p.buffers.outboundHours * HOUR).toISOString() : null,
      latestArrivalLocal: depUtc ? localTime(new Date(Date.parse(depUtc) - p.buffers.outboundHours * HOUR).toISOString(), award.origin) : null
    };
  }
  const home = p.home.returnTo || p.home.origin;
  if (!home || home === award.destination) return null;
  const arrUtc = Number.isFinite(Date.parse(award.flight?.arriveUtc)) && Number.isFinite(p.buffers.returnHours) ? award.flight.arriveUtc : null;
  return {
    from: award.destination, to: home, date: award.flight?.arrive?.date || award.date,
    earliestDepartureUtc: arrUtc ? new Date(Date.parse(arrUtc) + p.buffers.returnHours * HOUR).toISOString() : null,
    earliestDepartureLocal: arrUtc ? localTime(new Date(Date.parse(arrUtc) + p.buffers.returnHours * HOUR).toISOString(), award.destination) : null
  };
}

export function positioningFit(need, f, travelers = 1) {
  const fail = incompatibleReason => ({ fits: false, incompatibleReason });
  if (!need) return fail('Airport change: positioning airports must match the required connection exactly.');
  const outbound = Object.hasOwn(need, 'latestArrivalUtc');
  const homeMismatch = outbound ? f.origin !== need.from : f.destination !== need.to;
  const airportChange = outbound ? f.destination !== need.to : f.origin !== need.from;
  if (homeMismatch || airportChange && !f.ground) return fail('Airport change: positioning airports must match the required connection exactly or include an explicit ground move.');
  if (f.flight && ((f.flight.origin && f.flight.origin !== f.origin) || (f.flight.destination && f.flight.destination !== f.destination))) return fail('Airport change: positioning flight details do not match its actual airports.');
  const day = f.flight?.depart?.date || f.departTime?.slice(0, 10) || f.departDate || f.date || f.departUtc?.slice(0, 10);
  if (day) {
    try { assertCalendarDate(day, 'positioning date'); } catch { return fail('Invalid positioning calendar date.'); }
    const delta = (Date.parse(day) - Date.parse(need.date)) / 86400000;
    if (outbound ? delta < -1 || delta > 0 : delta < 0 || delta > 1) return fail('Positioning date is incompatible with the connection.');
  }
  if ((f.flight?.remainingSeats ?? f.remainingSeats) != null && (f.flight?.remainingSeats ?? f.remainingSeats) < travelers) return fail('Not enough positioning seats for all travelers.');
  const arrival = f.arriveUtc || f.flight?.arriveUtc;
  const departure = f.departUtc || f.flight?.departUtc;
  if ((arrival && !Number.isFinite(Date.parse(arrival))) || (departure && !Number.isFinite(Date.parse(departure)))) return fail('Invalid positioning flight times.');
  if (arrival && departure && Date.parse(arrival) <= Date.parse(departure)) return fail('Positioning arrival must follow departure.');
  if (f.ground && (f.ground.durationMinutes != null && (!Number.isFinite(f.ground.durationMinutes) || f.ground.durationMinutes < 0))) return fail('Invalid ground duration estimate.');
  const groundMinutes = f.ground?.durationMinutes;
  if (airportChange && groundMinutes == null) return { fits: null, incompatibleReason: null };
  if (need.latestArrivalUtc && arrival) return Date.parse(arrival) + (groundMinutes || 0) * 60000 <= Date.parse(need.latestArrivalUtc) ? { fits: true, incompatibleReason: null } : fail('Positioning flight arrives too late for the ground move and connection.');
  if (need.earliestDepartureUtc && departure) return Date.parse(departure) - (groundMinutes || 0) * 60000 >= Date.parse(need.earliestDepartureUtc) ? { fits: true, incompatibleReason: null } : fail('Positioning flight departs too early for the ground move and connection.');
  return { fits: null, incompatibleReason: null };
}
const fits = (need, f) => positioningFit(need, f).fits;

/**
 * Find positioning flights for a direction. Cash via Google Flights (SerpApi) when configured,
 * otherwise Travelpayouts; award options via seats.aero (economy) when a key is set.
 * `date` lets the UI try the day before / after.
 */
export async function searchPositioning({ direction, date }) {
  if (!DIRS.includes(direction)) throw bad('direction must be outbound or return');
  const p = await load();
  const need = positioningNeed(p, direction);
  if (!need) throw bad(direction === 'outbound' ? 'Pick an outbound award flight and a home airport different from its departure airport.' : 'Pick a return award flight and a home airport different from where it lands.');
  const day = assertCalendarDate(date || need.date, 'positioning date');
  const settings = await getSettings();
  const status = { warnings: [], cashSource: null };
  if (!settings.serpApiKey && !settings.travelpayoutsToken) status.warnings.push('Add a SerpApi key (best: exact times) or a Travelpayouts token under Data & System to search positioning flights.');

  // Cash and award lookups are independent: run them together.
  const [cash, awards] = await Promise.all([
    (async () => {
      try {
        if (settings.serpApiKey) {
          const g = await googleCash({ apiKey: settings.serpApiKey, origins: [need.from], destinations: [need.to], departDate: day, cabin: 'economy' }, p.travelers);
          status.warnings.push(...g.warnings);
          status.cashSource = 'google';
          await recordFares(g.fares);
          return g.fares;
        }
        if (settings.travelpayoutsToken) {
          const r = await routeFares({ token: settings.travelpayoutsToken, origin: need.from, destination: need.to, departAt: day });
          status.cashSource = 'travelpayouts';
          return r.fares.filter(f => f.departDate === day).map(f => priceFare(f, p.travelers));
        }
      } catch (e) { status.warnings.push(e.message); }
      return [];
    })(),
    (async () => {
      if (!settings.seatsAeroApiKey) return [];
      try {
        const r = await searchSeatsAero({ apiKey: settings.seatsAeroApiKey, origins: [need.from], destinations: [need.to], start: day, end: day, cabin: 'economy' });
        return flightOptions(r.rows, direction === 'outbound' ? 'Positioning out' : 'Positioning back', { travelers: p.travelers })
          .filter(o => o.flight).map(o => ({ ...o, kind: 'award', departUtc: o.flight.departUtc, arriveUtc: o.flight.arriveUtc }));
      } catch (e) { status.warnings.push(e.message); return []; }
    })()
  ]);

  const tag = f => ({ ...f, ...positioningFit(need, f, p.travelers) });
  // Fits first, then cheapest, then the one closest to the award flight (latest arrival before
  // the outbound award / earliest departure after the return award) to minimize waiting.
  const closeness = f => (direction === 'outbound' ? -Date.parse(f.arriveUtc || 0) : Date.parse(f.departUtc || 0)) || 0;
  const order = (a, b) => (b.fits === true) - (a.fits === true) || (a.price ?? a.mileageCost) - (b.price ?? b.mileageCost) || closeness(a) - closeness(b);
  const cashSorted = cash.map(f => tag({ ...f, kind: 'cash' })).sort(order);
  return {
    direction, need: { ...need, date: day },
    counts: { cash: cashSorted.length, fitting: cashSorted.filter(f => f.fits === true).length },
    cash: cashSorted.slice(0, 20),
    awards: awards.map(tag).sort(order).slice(0, 10),
    googleFlightsUrl: googleFlightsUrl({ origins: [need.from], destinations: [need.to], departDate: day, cabin: 'economy' }),
    dataStatus: status
  };
}

export async function getTripPlan() {
  const p = await load();
  const stayPlan = await getStayPlan({ includeFunding: false });
  const pax = p.travelers;
  const needs = {};
  const add = (prog, pts) => { if (prog && pts > 0) needs[prog] = (needs[prog] || 0) + pts; };
  let cashUsd = 0;
  let cashPricingUncertain = false;
  const warnings = [];
  const items = [];

  for (const dir of DIRS) {
    const pos = p.positioning[dir];
    if (pos) {
      if (pos.kind === 'award') { add(pos.program, pos.mileageCost * pax); cashUsd += (pos.totalTaxes || 0) * pax; }
      else {
        const priced = priceFare(pos, pax);
        if (pax > 1) {
          cashPricingUncertain = true;
          warnings.push(pos.source === 'google' ? 'Positioning cash price basis unconfirmed; excluded from known cash total.' : priced.pricingLabel);
        }
        if (priced.total != null) cashUsd += priced.total;
      }
      items.push({ type: 'positioning', direction: dir, at: pos.departUtc || `${pos.departDate || pos.date}T12:00:00Z`, item: pos.kind === 'cash' ? priceFare({ ...pos, pricing: pos.pricing || { quotedAt: null } }, pax) : pos });
    }
    const need = positioningNeed(p, dir);
    if (need && !pos) warnings.push(dir === 'outbound' ? `You start in ${need.from} but the award departs ${need.to}: add a positioning flight.` : `The return award lands in ${need.from}, not ${need.to}: add a flight home.`);
    if (need && pos) { const ok = fits(need, pos); if (ok === false) warnings.push(dir === 'outbound' ? `The positioning flight lands less than ${p.buffers.outboundHours}h before the award departs.` : `The flight home leaves less than ${p.buffers.returnHours}h after the award lands.`); }
  }
  for (const segment of p.segments) if (segment.award) {
    const f = segment.award;
    add(f.program, f.mileageCost * pax);
    cashUsd += (f.totalTaxes || 0) * pax;
    items.push({ type: 'award', direction: segment.id, segmentId: segment.id, at: f.flight?.departUtc || `${f.date}T12:00:00Z`, item: f });
  }
  const assessment = assessTransitions(p);
  for (const t of assessment.transitions) {
    const f = p.segments.find(s => s.id === t.fromSegmentId)?.award;
    items.push({ type: 'transition', at: f?.flight?.arriveUtc || `${f?.date || '9999-12-31'}T23:59:00Z`, item: t });
  }
  warnings.push(...assessment.risks.map(r => r.reason), ...(p.migrationWarnings || []));
  for (const s of stayPlan.stays) {
    add(s.program, s.totalPoints);
    items.push({ type: 'hotel', at: `${s.checkIn}T15:00:00Z`, item: s });
  }
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // Do the hotels line up with the flights?
  const out = p.flights.outbound, ret = p.flights.return, stays = stayPlan.stays;
  if (stays.length && out) {
    const arrive = out.flight?.arrive?.date || out.date;
    if (stays[0].checkIn !== arrive) warnings.push(`First hotel check-in (${stays[0].checkIn}) doesn't match the outbound arrival date (${arrive}).`);
  }
  if (stays.length && ret) {
    const leave = ret.flight?.depart?.date || ret.date;
    const lastOut = stays.reduce((m, s) => (s.checkOut > m ? s.checkOut : m), stays[0].checkOut);
    if (lastOut !== leave) warnings.push(`Last hotel check-out (${lastOut}) doesn't match the return flight date (${leave}).`);
  }
  warnings.push(...stayPlan.summary.warnings);

  const user = await loadUser();
  const funding = Object.keys(needs).length ? fundPrograms(needs, user.balances, transferData(), { ...DEFAULT_PREFS, ...(user.preferences || {}) }) : null;
  const { flights: _flights, migrationWarnings: _warnings, ...canonical } = p;
  let validity = validateItinerary(canonical);
  if (p.migrationWarnings?.length) validity = { valid: false, invalidReason: p.migrationWarnings[0], complete: false };
  if (stayPlan.migrationWarnings.length || stayPlan.stays.length > 20) validity = { valid: false, invalidReason: stayPlan.migrationWarnings[0] || 'The stay plan exceeds the twenty-stay evaluation limit.', complete: false };
  for (const dir of DIRS) if (p.positioning[dir]) {
    const check = positioningFit(positioningNeed(p, dir), p.positioning[dir], pax);
    if (check.fits === false) validity = { valid: false, invalidReason: check.incompatibleReason };
  }
  return {
    ...canonical, ...validity,
    positioning: Object.fromEntries(DIRS.map(dir => { const pos = p.positioning[dir]; return [dir, pos?.kind === 'cash' ? priceFare({ ...pos, pricing: pos.pricing || { quotedAt: null } }, pax) : pos]; })),
    legacyCompatible: p.segments.length <= 2,
    ...(p.segments.length <= 2 ? { flights: p.flights } : {}),
    migrationWarnings: p.migrationWarnings || [], risks: assessment.risks, planHash: planHash(canonical),
    homeLabels: { origin: p.home.origin ? describe(p.home.origin).label : null, returnTo: p.home.returnTo ? describe(p.home.returnTo).label : null },
    needs: { outbound: positioningNeed(p, 'outbound'), return: positioningNeed(p, 'return') },
    // Why a connecting flight is or isn't needed, for the timeline.
    connections: {
      outbound: p.flights.outbound ? (p.home.origin && p.home.origin !== p.flights.outbound.origin ? 'needed' : p.home.origin ? 'home' : 'no-home') : 'no-flight',
      return: p.flights.return ? ((p.home.returnTo || p.home.origin) && (p.home.returnTo || p.home.origin) !== p.flights.return.destination ? 'needed' : (p.home.returnTo || p.home.origin) ? 'home' : 'no-home') : 'no-flight'
    },
    stays: stayPlan.stays,
    timeline: items,
    summary: {
      pointsByProgram: Object.entries(needs).map(([prog, pts]) => ({ program: prog, programName: programName(prog), points: pts })),
      totalPoints: Object.values(needs).reduce((s, n) => s + n, 0),
      cashUsd,
      cashPricingUncertain,
      funding,
      fundingStatus: !validity.complete ? 'incomplete' : funding ? 'funded' : 'search-limited',
      ...validity,
      affordable: !validity.valid || p.segments.length && !validity.complete ? false : Object.keys(needs).length ? Boolean(funding) : null,
      feesMissing: p.segments.some(s => s.award && (s.award.totalTaxes == null || s.award.taxesMissing || s.award.taxesCurrency && s.award.taxesCurrency !== 'USD')),
      warnings: [...new Set(warnings)]
    }
  };
}
