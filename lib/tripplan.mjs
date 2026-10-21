// Trip Builder: assembles the whole trip — award flights, hotel stays (from the stay plan) and
// "positioning" flights between your real home airport and the award's departure airport
// (e.g. BOS → JFK before an ANA award from JFK, JFK → BOS after the return).
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { getPlan as getStayPlan } from './stayplan.mjs';
import { fundPrograms, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { loadUser, getSettings } from './settings.mjs';
import { programId, programName } from './programs.mjs';
import { googleFlights, googleFlightsUrl } from './serpapi.mjs';
import { routeFares } from './travelpayouts.mjs';
import { searchSeatsAero } from './seatsaero.mjs';
import { flightOptions } from './search.mjs';
import { describe, localTime } from './geo.mjs';
import { recordFares } from './cash.mjs';
import { assertCalendarDate, parseFiniteNumber, validateFlightPair } from './validate.mjs';
import { programKind, normalizeCabin } from './programs.mjs';

const FILE = () => dataFile('trip-plan.json');
const EMPTY = { home: { origin: '', returnTo: '' }, buffers: { outboundHours: 3, returnHours: 2 }, travelers: 1, allowOpenJaw: false, origins: [], destinations: [], cabin: 'business', flights: { outbound: null, return: null }, positioning: { outbound: null, return: null } };
const bad = m => Object.assign(new Error(m), { status: 400 });
const DIRS = ['outbound', 'return'];
const code = s => String(s || '').trim().toUpperCase();
const HOUR = 3600000;

async function load() { return { ...structuredClone(EMPTY), ...(await readJson(FILE(), {})) }; }
const save = mutate => updateJson(FILE(), structuredClone(EMPTY), p => {
  const next = { ...structuredClone(EMPTY), ...p };
  mutate(next);
  const legs = DIRS.map(d => next.flights[d]).filter(Boolean);
  const validity = legs.length ? validateFlightPair(legs, { travelers: next.travelers, allowOpenJaw: next.allowOpenJaw, origins: next.origins, destinations: next.destinations }) : { valid: true };
  if (!validity.valid) throw bad(validity.invalidReason);
  for (const dir of DIRS) if (next.positioning[dir]) {
    const check = positioningFit(positioningNeed(next, dir), next.positioning[dir], next.travelers);
    if (check.fits === false) throw bad(check.incompatibleReason);
  }
  return next;
});

// Keep only what the builder needs from an award option.
function slimAward(o) {
  if (!o || !o.origin || !o.destination || !(Number(o.mileageCost) > 0)) throw bad('A valid award flight is required.');
  assertCalendarDate(o.date, 'flight date');
  if (programKind(programId(o.program)) !== 'airline') throw bad('Choose a recognized airline program.');
  parseFiniteNumber(o.mileageCost, { min: 1, max: 1e9, integer: true, name: 'mileageCost' });
  for (const key of ['totalTaxes', 'cashValue']) if (o[key] != null) parseFiniteNumber(o[key], { min: 0, max: 1e7, name: key });
  const pick = ({ id, leg, program, programName: pn, origin, destination, date, cabin, mileageCost, totalTaxes, cashValue, direct, airlines, flight, seatScore, availabilityId, remainingSeats, dataSource, taxesMissing, taxesEstimate, bookingLinks }) =>
    ({ id, leg, program: programId(program) || program, programName: pn || programName(program), origin, destination, date, cabin, mileageCost: Number(mileageCost), totalTaxes: totalTaxes ?? null, cashValue: cashValue ?? null, direct, airlines, flight: flight || null, seatScore: seatScore ?? null, availabilityId: availabilityId || null, remainingSeats: remainingSeats ?? null, dataSource: dataSource || null,
      taxesMissing: Boolean(taxesMissing), taxesEstimate: taxesEstimate || null, bookingLinks: Array.isArray(bookingLinks) ? bookingLinks.filter(l => /^https:\/\//i.test(String(l.url || ''))).slice(0, 3) : [] });
  return pick(o);
}

export async function setFlights({ outbound = undefined, return: ret = undefined, travelers, cabin, allowOpenJaw, origins, destinations }) {
  await save(p => {
    if (outbound !== undefined) p.flights.outbound = outbound ? slimAward(outbound) : null;
    if (ret !== undefined) p.flights.return = ret ? slimAward(ret) : null;
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
  });
  return getTripPlan();
}

export async function updateTripSettings({ home, buffers, travelers }) {
  await save(p => {
    if (home) {
      if (home.origin != null) { const c = code(home.origin); if (c && !/^[A-Z]{3}$/.test(c)) throw bad('Home airport must be a 3-letter code.'); if (c !== p.home.origin) p.positioning.outbound = null; p.home.origin = c; }
      if (home.returnTo != null) { const c = code(home.returnTo); if (c && !/^[A-Z]{3}$/.test(c)) throw bad('Return airport must be a 3-letter code.'); if (c !== p.home.returnTo) p.positioning.return = null; p.home.returnTo = c; }
    }
    if (buffers) for (const k of ['outboundHours', 'returnHours']) if (buffers[k] != null) p.buffers[k] = parseFiniteNumber(buffers[k], { min: 0.5, max: 24, name: k });
    if (travelers != null) p.travelers = parseFiniteNumber(travelers, { min: 1, max: 9, integer: true, name: 'travelers' });
  });
  return getTripPlan();
}

export async function removeFlight(dir) {
  if (!DIRS.includes(dir)) throw bad('direction must be outbound or return');
  await save(p => { p.flights[dir] = null; p.positioning[dir] = null; });
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
      if (option.kind === 'award') slimAward({ ...option, date: day });
      else parseFiniteNumber(option.price, { min: 0, max: 1e7, name: 'positioning price' });
      const assessment = positioningFit(need, option, p.travelers);
      if (assessment.fits === false) throw bad(assessment.incompatibleReason);
      p.positioning[dir] = { ...option, date: day, chosenAt: new Date().toISOString() };
    } else p.positioning[dir] = null;
  });
  return getTripPlan();
}

export async function clearTrip() {
  await save(p => { p.flights = { outbound: null, return: null }; p.positioning = { outbound: null, return: null }; });
  return getTripPlan();
}

/** What a positioning flight must do for a direction (route, date, time limit), or null. */
function positioningNeed(p, dir) {
  const award = p.flights[dir];
  if (!award) return null;
  if (dir === 'outbound') {
    const home = p.home.origin;
    if (!home || home === award.origin) return null;
    const depUtc = award.flight?.departUtc || null;
    return {
      from: home, to: award.origin, date: award.flight?.depart?.date || award.date,
      latestArrivalUtc: depUtc ? new Date(Date.parse(depUtc) - p.buffers.outboundHours * HOUR).toISOString() : null,
      latestArrivalLocal: depUtc ? localTime(new Date(Date.parse(depUtc) - p.buffers.outboundHours * HOUR).toISOString(), award.origin) : null
    };
  }
  const home = p.home.returnTo || p.home.origin;
  if (!home || home === award.destination) return null;
  const arrUtc = award.flight?.arriveUtc || null;
  return {
    from: award.destination, to: home, date: award.flight?.arrive?.date || award.date,
    earliestDepartureUtc: arrUtc ? new Date(Date.parse(arrUtc) + p.buffers.returnHours * HOUR).toISOString() : null,
    earliestDepartureLocal: arrUtc ? localTime(new Date(Date.parse(arrUtc) + p.buffers.returnHours * HOUR).toISOString(), award.destination) : null
  };
}

export function positioningFit(need, f, travelers = 1) {
  const fail = incompatibleReason => ({ fits: false, incompatibleReason });
  if (!need || f.origin !== need.from || f.destination !== need.to) return fail('Airport change: positioning airports must match the required connection exactly.');
  if (f.flight && ((f.flight.origin && f.flight.origin !== need.from) || (f.flight.destination && f.flight.destination !== need.to))) return fail('Airport change: positioning flight details do not match the required connection.');
  const day = f.flight?.depart?.date || f.departTime?.slice(0, 10) || f.departDate || f.date || f.departUtc?.slice(0, 10);
  if (day) {
    try { assertCalendarDate(day, 'positioning date'); } catch { return fail('Invalid positioning calendar date.'); }
    const delta = (Date.parse(day) - Date.parse(need.date)) / 86400000;
    if (need.latestArrivalUtc ? delta < -1 || delta > 0 : delta < 0 || delta > 1) return fail('Positioning date is incompatible with the connection.');
  }
  if ((f.flight?.remainingSeats ?? f.remainingSeats) != null && (f.flight?.remainingSeats ?? f.remainingSeats) < travelers) return fail('Not enough positioning seats for all travelers.');
  const arrival = f.arriveUtc || f.flight?.arriveUtc;
  const departure = f.departUtc || f.flight?.departUtc;
  if ((arrival && !Number.isFinite(Date.parse(arrival))) || (departure && !Number.isFinite(Date.parse(departure)))) return fail('Invalid positioning flight times.');
  if (arrival && departure && Date.parse(arrival) <= Date.parse(departure)) return fail('Positioning arrival must follow departure.');
  if (need.latestArrivalUtc && arrival) return Date.parse(arrival) <= Date.parse(need.latestArrivalUtc) ? { fits: true, incompatibleReason: null } : fail('Positioning flight arrives too late for the connection.');
  if (need.earliestDepartureUtc && departure) return Date.parse(departure) >= Date.parse(need.earliestDepartureUtc) ? { fits: true, incompatibleReason: null } : fail('Positioning flight departs too early for the connection.');
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
          const g = await googleFlights({ apiKey: settings.serpApiKey, origins: [need.from], destinations: [need.to], departDate: day, cabin: 'economy' });
          status.cashSource = 'google';
          await recordFares(g.fares);
          return g.fares;
        }
        if (settings.travelpayoutsToken) {
          const r = await routeFares({ token: settings.travelpayoutsToken, origin: need.from, destination: need.to, departAt: day });
          status.cashSource = 'travelpayouts';
          return r.fares.filter(f => f.departDate === day);
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
  const stayPlan = await getStayPlan();
  const pax = p.travelers;
  const needs = {};
  const add = (prog, pts) => { if (prog && pts > 0) needs[prog] = (needs[prog] || 0) + pts; };
  let cashUsd = 0;
  const warnings = [];
  const items = [];

  for (const dir of DIRS) {
    const pos = p.positioning[dir];
    if (pos) {
      if (pos.kind === 'award') { add(pos.program, pos.mileageCost * pax); cashUsd += (pos.totalTaxes || 0) * pax; }
      else cashUsd += (pos.price || 0) * pax;
      items.push({ type: 'positioning', direction: dir, at: pos.departUtc || `${pos.departDate || pos.date}T12:00:00Z`, item: pos });
    }
    const f = p.flights[dir];
    if (f) {
      add(f.program, f.mileageCost * pax);
      cashUsd += (f.totalTaxes || 0) * pax;
      items.push({ type: 'award', direction: dir, at: f.flight?.departUtc || `${f.date}T12:00:00Z`, item: f });
    }
    const need = positioningNeed(p, dir);
    if (need && !pos) warnings.push(dir === 'outbound' ? `You start in ${need.from} but the award departs ${need.to}: add a positioning flight.` : `The return award lands in ${need.from}, not ${need.to}: add a flight home.`);
    if (need && pos) { const ok = fits(need, pos); if (ok === false) warnings.push(dir === 'outbound' ? `The positioning flight lands less than ${p.buffers.outboundHours}h before the award departs.` : `The flight home leaves less than ${p.buffers.returnHours}h after the award lands.`); }
  }
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
  const legs = DIRS.map(d => p.flights[d]).filter(Boolean);
  let validity = legs.length ? validateFlightPair(legs, { travelers: pax, allowOpenJaw: p.allowOpenJaw, origins: p.origins, destinations: p.destinations }) : { valid: true, invalidReason: null };
  for (const dir of DIRS) if (p.positioning[dir]) {
    const check = positioningFit(positioningNeed(p, dir), p.positioning[dir], pax);
    if (check.fits === false) validity = { valid: false, invalidReason: check.incompatibleReason };
  }
  return {
    ...p, ...validity,
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
      funding,
      ...validity,
      affordable: !validity.valid ? false : Object.keys(needs).length ? Boolean(funding) : null,
      warnings: [...new Set(warnings)]
    }
  };
}
