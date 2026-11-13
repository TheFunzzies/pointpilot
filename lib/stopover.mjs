// Stopover builder: add a second city on the way out for few or no extra points.
// origin -> stopover city (a few nights) -> destination (the main stay) -> origin, built from
// one-way awards. Three award queries cover every candidate stopover city.
import { findTrip, normalizeFinderQuery, trimOptions, makeFunder, awardLeg, planSteps, shift, daysBetween } from './finder.mjs';
import { refreshFromApi, bestPerFlight, flightOptions } from './search.mjs';
import { queryFlights } from './awards.mjs';
import { resolveAirports } from './places.mjs';
import { loadHistory } from './history.mjs';
import { DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { getSettings, loadUser } from './settings.mjs';
import { describe, cityCodeOf } from './geo.mjs';
import { regionsFor, playbook } from './playbook.mjs';
import { parseFiniteNumber } from './validate.mjs';
import { ApiError } from './errors.mjs';

/** Cities that sit naturally on the way, by destination region. */
export const STOPOVER_HUBS = Object.freeze({
  europe: ['KEF', 'DUB', 'LIS', 'MAD', 'LHR', 'CDG', 'AMS', 'FRA', 'ZRH', 'IST'],
  japan: ['HNL', 'YVR', 'ICN', 'TPE', 'HKG'],
  asia: ['NRT', 'HND', 'ICN', 'TPE', 'HKG', 'SIN', 'HNL', 'YVR'],
  southasia: ['DOH', 'DXB', 'AUH', 'IST', 'LHR', 'CDG', 'FRA', 'SIN'],
  maldives: ['DOH', 'DXB', 'AUH', 'IST', 'SIN'],
  middleeast: ['LHR', 'CDG', 'AMS', 'FRA', 'IST', 'MAD'],
  africa: ['LHR', 'CDG', 'AMS', 'IST', 'DOH', 'DXB', 'LIS', 'CMN'],
  oceania: ['HNL', 'NAN', 'NRT', 'SIN', 'AKL', 'PPT'],
  southamerica: ['PTY', 'BOG', 'MEX', 'MIA', 'LIM'],
  centralamerica: ['MEX', 'MIA', 'PTY'],
  hawaii: ['LAX', 'SFO', 'SEA'],
  caribbean: ['MIA', 'SJU'],
  mexico: ['MIA', 'DFW', 'LAX']
});
const MAX_COMBOS = 80, TOP = 8;
const round2 = n => Math.round(n * 100) / 100;

/**
 * input: finder fields (round trip; nights = stay at the destination) plus
 *   stopNights (1–7, default 3) and an optional stopover city/airport.
 */
export async function findStopoverTrips(input, { allowApi = true } = {}) {
  const started = Date.now();
  const [settings, user] = await Promise.all([getSettings(), loadUser()]);
  const { stopover, stopNights: rawStop, ...rest } = input || {};
  const q = normalizeFinderQuery({ ...rest, tripType: 'round-trip' }, { homeAirports: settings.homeAirports });
  const stopNights = parseFiniteNumber(rawStop ?? 3, { min: 1, max: 7, integer: true, name: 'stopover nights' });
  if (daysBetween(q.earliest, q.latest) < q.minNights + stopNights) throw new ApiError('The travel window is too short for the stopover and the stay.', 400, 'INVALID_INPUT');
  const avoid = new Set([...q.origins, ...q.destinations].map(cityCodeOf));
  const named = String(stopover || '').trim();
  const hubs = (named ? resolveAirports(named) : [...new Set(regionsFor(q.origins, q.destinations).flatMap(r => STOPOVER_HUBS[r] || []))]).filter(a => !avoid.has(cityCodeOf(a)));
  if (!hubs.length) throw new ApiError(named ? 'Pick a stopover city different from your origin and destination.' : 'No stopover ideas for this destination yet. Name a city to stop in.', 400, 'INVALID_INPUT');

  const status = { api: settings.seatsAeroApiKey ? 'skipped' : 'not-configured', warnings: [] };
  const q1 = { origins: q.origins, destinations: hubs, start: q.earliest, end: shift(q.latest, -(q.minNights + stopNights)), cabin: q.cabin };
  const q2 = { origins: hubs, destinations: q.destinations, start: shift(q.earliest, Math.max(1, stopNights - 1)), end: shift(q.latest, -q.minNights), cabin: q.cabin };
  const q3 = { origins: q.destinations, destinations: q.origins, start: shift(q.earliest, stopNights + q.minNights - 1), end: q.latest, cabin: q.cabin };
  const base = { origins: q.originsText, destination: q.destinationText, earliest: q.earliest, latest: q.latest, nights: q.nights, nightsFlex: q.nightsFlex, cabin: q.cabin, travelers: q.travelers, nonstopOnly: q.nonstopOnly };
  const [direct, history] = await Promise.all([
    findTrip(base, { allowApi, allowGoogle: false, cash: false, positioning: false }).catch(() => null),
    loadHistory(),
    ...(allowApi && settings.seatsAeroApiKey ? [q1, q2, q3].map(x => refreshFromApi(x, settings, status)) : [])
  ]);

  const usable = r => (!q.nonstopOnly || r.direct === true || r.flights?.length) && (r.remainingSeats == null || r.remainingSeats >= q.travelers);
  const load = async (query, leg) => trimOptions(flightOptions(bestPerFlight((await queryFlights(query)).filter(usable)), leg, { travelers: q.travelers, directOnly: q.nonstopOnly, history }));
  const [l1, l2, l3] = await Promise.all([load(q1, 'Outbound'), load(q2, 'Onward'), load(q3, 'Return')]);

  const transfers = transferData();
  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  const fund = makeFunder({ travelers: q.travelers, balances: user.balances, transfers, prefs });
  const value = id => (transfers.valuations?.cents?.[id] ?? prefs.defaultCpp) / 100;
  const rough = l => l.mileageCost * value(l.program) + (l.totalTaxes || 0);
  const cheapest = list => list.slice().sort((a, b) => rough(a) - rough(b));
  const singleAward = playbook().stopoverPrograms || {};
  const directBest = direct?.options.find(o => o.type === 'points' && !o.variant) || null;

  const cities = new Map();
  for (const a of hubs) { const c = cityCodeOf(a); if (!cities.has(c)) cities.set(c, []); cities.get(c).push(a); }
  const results = [];
  let unfunded = 0;
  for (const airports of cities.values()) {
    const set = new Set(airports);
    const firsts = cheapest(l1.filter(o => set.has(o.destination))), seconds = cheapest(l2.filter(o => set.has(o.origin)));
    if (!firsts.length || !seconds.length || !l3.length) continue;
    const combos = [];
    for (const a of firsts.slice(0, TOP * 3)) for (const b of seconds.slice(0, TOP * 3)) {
      const stop = daysBetween(a.date, b.date);
      if (stop < Math.max(1, stopNights - 1) || stop > stopNights + 2) continue;
      for (const c of cheapest(l3.filter(o => { const n = daysBetween(b.date, o.date); return n >= q.minNights && n <= q.maxNights; })).slice(0, TOP)) combos.push({ legs: [a, b, c], rough: rough(a) + rough(b) + rough(c) });
    }
    if (!combos.length) continue;
    combos.sort((x, y) => x.rough - y.rough);
    const trip = combos.slice(0, MAX_COMBOS).map(x => fund(x.legs)).filter(Boolean).sort((x, y) => x.effectiveCostUsd - y.effectiveCostUsd)[0];
    if (!trip) { unfunded += 1; continue; }
    const [a, b, c] = trip.legs;
    const d = describe(airports[0]);
    const same = a.program === b.program && singleAward[a.program];
    results.push({
      city: d.city || airports[0], label: d.label, airports,
      depart: a.date, onward: b.date, return: c.date, stopNights: daysBetween(a.date, b.date), stayNights: daysBetween(b.date, c.date),
      legs: [awardLeg(a, 'Outbound'), awardLeg(b, 'Onward'), awardLeg(c, 'Return')], plan: planSteps(trip, transfers),
      points: trip.totalSourcePoints, feesUsd: round2(trip.taxesUsd), effectiveCostUsd: round2(trip.effectiveCostUsd),
      extraPoints: directBest ? trip.totalSourcePoints - directBest.points : null, extraCostUsd: directBest ? round2(trip.effectiveCostUsd - directBest.effectiveCostUsd) : null,
      singleAward: same ? `${a.programName} ${singleAward[a.program]} Price the two outbound flights as one award on its site; it may cost fewer points than shown here.` : null,
      warnings: (trip.warnings || []).filter(w => !/search limits/.test(w))
    });
  }
  results.sort((x, y) => x.effectiveCostUsd - y.effectiveCostUsd);
  return {
    query: { originsText: q.originsText, destinationText: q.destinationText, destinationLabel: q.destinations.length === 1 ? describe(q.destinations[0]).label : q.destinationText, earliest: q.earliest, latest: q.latest, nights: q.nights, stopNights, cabin: q.cabin, travelers: q.travelers, stopover: named || null },
    direct: directBest && { points: directBest.points, feesUsd: directBest.outOfPocketUsd, effectiveCostUsd: directBest.effectiveCostUsd, depart: directBest.depart, return: directBest.return },
    results, searched: cities.size, unfunded,
    walletEmpty: !(user.balances || []).some(x => Number(x.balance) > 0),
    dataStatus: status, tookMs: Date.now() - started
  };
}
