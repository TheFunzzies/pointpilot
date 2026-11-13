// Trip finder: "I want to go to X sometime in this window" -> the best way to pay for it.
//
// One pass gathers award space for the whole window (one seats.aero query per direction), cached
// cash fares (Travelpayouts, free) and, when needed, one or two live Google Flights prices. It then
// compares three ways to pay: all points, points one way + cash the other, or all cash. Everything
// is ranked by effective cost (points at the user's own values + fees + cash).
import { resolveAirports } from './places.mjs';
import { normalizeCabin, programName, BOOKING_URLS } from './programs.mjs';
import { queryFlights } from './awards.mjs';
import { refreshFromApi, bestPerFlight, flightOptions } from './search.mjs';
import { loadHistory } from './history.mjs';
import { evaluateTrip, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { getSettings, loadUser, apiUsage } from './settings.mjs';
import { todayISO } from './transfers.mjs';
import { routeFares, metroCode } from './travelpayouts.mjs';
import { googleFlights, googleFlightsUrl } from './serpapi.mjs';
import { recordFares } from './cash.mjs';
import { describe } from './geo.mjs';
import { adviceFor, activeBonuses } from './playbook.mjs';
import { quotePointPurchases } from './buy-points.mjs';
import { assertCalendarDate, parseFiniteNumber, validateFlightPair } from './validate.mjs';
import { ApiError } from './errors.mjs';
import { mapLimit } from './util.mjs';

export const FINDER_LIMITS = Object.freeze({ maxSpanDays: 62, maxPairs: 400, perDate: 4, perDirection: 120, routeCombos: 6, googleAirports: 4, serpMonthlyReserve: 230 });

const bad = message => new ApiError(message, 400, 'INVALID_INPUT');
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const monthsBetween = (a, b) => { const out = []; let m = a.slice(0, 7); while (m <= b.slice(0, 7) && out.length < 4) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; } return out; };
const round2 = n => Math.round(n * 100) / 100;

/** Validate and normalize a finder request. `homeAirports` fills in a missing origin. */
export function normalizeFinderQuery(input, { homeAirports = '', today = todayISO() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Describe the trip: where to, and roughly when.');
  const originsText = String(input.origins || homeAirports || '').trim();
  if (!originsText) throw bad('Enter where you are flying from, or save your home airports in Settings.');
  const destinationText = String(input.destination || '').trim();
  if (!destinationText) throw bad('Enter where you want to go.');
  if (originsText.length > 300 || destinationText.length > 160) throw bad('That place name is too long.');
  const origins = resolveAirports(originsText), destinations = resolveAirports(destinationText);
  const tripType = input.tripType === 'one-way' ? 'one-way' : 'round-trip';
  const travelers = parseFiniteNumber(input.travelers ?? 1, { min: 1, max: 9, integer: true, name: 'travelers' });
  const cabin = normalizeCabin(input.cabin) || 'economy';
  let earliest = assertCalendarDate(input.earliest, 'earliest date');
  const latest = assertCalendarDate(input.latest, 'latest date');
  if (latest < today) throw bad('That travel window is in the past.');
  if (earliest < today) earliest = today;
  if (latest < earliest) throw bad('The latest date is before the earliest date.');
  if (daysBetween(earliest, latest) > FINDER_LIMITS.maxSpanDays) throw bad('Choose a travel window of two months or less.');
  const nights = tripType === 'one-way' ? 0 : parseFiniteNumber(input.nights ?? 7, { min: 1, max: 30, integer: true, name: 'trip length' });
  const nightsFlex = tripType === 'one-way' ? 0 : parseFiniteNumber(input.nightsFlex ?? 2, { min: 0, max: 7, integer: true, name: 'trip length flexibility' });
  const minNights = Math.max(1, nights - nightsFlex), maxNights = nights + nightsFlex;
  if (tripType === 'round-trip' && daysBetween(earliest, latest) < minNights) throw bad('The travel window is shorter than the trip length.');
  const maxCashUsd = input.maxCashUsd == null || input.maxCashUsd === '' ? null : parseFiniteNumber(input.maxCashUsd, { min: 1, max: 1e6, name: 'cash target' });
  return { originsText, destinationText, origins, destinations, tripType, travelers, cabin, earliest, latest, nights, nightsFlex, minNights, maxNights, nonstopOnly: Boolean(input.nonstopOnly), maxCashUsd };
}

// ---------- awards ----------
function trimOptions(options) {
  const perDate = new Map();
  for (const o of options) {
    const list = perDate.get(o.date) || [];
    if (list.length < FINDER_LIMITS.perDate) { list.push(o); perDate.set(o.date, list); }
  }
  return [...perDate.values()].flat().sort((a, b) => a.mileageCost - b.mileageCost).slice(0, FINDER_LIMITS.perDirection);
}

function makeFunder(ctx) {
  const cache = new Map();
  return legs => {
    const key = legs.map(l => `${l.program}:${l.mileageCost}:${l.totalTaxes ?? ''}:${l.direct}`).join('|');
    if (!cache.has(key)) cache.set(key, evaluateTrip(legs, ctx));
    const t = cache.get(key);
    return t && { ...t, legs: legs.map((l, i) => ({ ...l, program: t.legs[i].program, programName: t.legs[i].programName, pointsPerTraveler: t.legs[i].pointsPerTraveler })) };
  };
}

// ---------- cash ----------
async function cachedCashFares(q, settings, status) {
  const out = { roundTrips: [], outbound: [], inbound: [] };
  if (!settings.travelpayoutsToken) { status.travelpayouts = 'not-configured'; return out; }
  if (q.cabin !== 'economy') { status.travelpayouts = 'economy-only'; return out; }
  const pairs = [...new Map(q.origins.flatMap(o => q.destinations.map(d => [metroCode(o), metroCode(d)])).map(p => [p.join('-'), p])).values()].slice(0, FINDER_LIMITS.routeCombos);
  const months = monthsBetween(q.earliest, q.latest);
  const jobs = [];
  for (const [o, d] of pairs) {
    for (const [i, m] of months.entries()) {
      if (q.tripType === 'round-trip') {
        for (const rm of months.slice(i)) jobs.push({ kind: 'roundTrips', origin: o, destination: d, departAt: m, returnAt: rm });
        jobs.push({ kind: 'inbound', origin: d, destination: o, departAt: m, returnAt: null });
      }
      jobs.push({ kind: 'outbound', origin: o, destination: d, departAt: m, returnAt: null });
    }
  }
  status.travelpayouts = 'fetched';
  await mapLimit(jobs, 6, async ({ kind, ...job }) => {
    try { out[kind].push(...(await routeFares({ token: settings.travelpayoutsToken, ...job, direct: q.nonstopOnly })).fares); }
    catch (e) { if (status.travelpayouts !== 'error') status.warnings.push(e.message); status.travelpayouts = 'error'; }
  });
  recordFares([...out.roundTrips, ...out.outbound, ...out.inbound]).catch(() => {});
  const lastOut = q.tripType === 'round-trip' ? shift(q.latest, -q.minNights) : q.latest;
  const nonstop = f => !q.nonstopOnly || (f.stops === 0 && (!f.returnDate || f.returnStops === 0));
  out.roundTrips = out.roundTrips.filter(f => f.returnDate && f.departDate >= q.earliest && f.departDate <= lastOut && f.returnDate <= q.latest && nonstop(f) &&
    daysBetween(f.departDate, f.returnDate) >= q.minNights && daysBetween(f.departDate, f.returnDate) <= q.maxNights);
  out.outbound = out.outbound.filter(f => !f.returnDate && f.departDate >= q.earliest && f.departDate <= lastOut && nonstop(f));
  out.inbound = out.inbound.filter(f => !f.returnDate && f.departDate >= shift(q.earliest, q.minNights) && f.departDate <= q.latest && nonstop(f));
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.price - b.price);
  return out;
}

async function liveFare({ settings, status, budget, origins, destinations, departDate, returnDate, cabin, nonstopOnly }) {
  if (!budget.left) return null;
  budget.left -= 1;
  try {
    const g = await googleFlights({ apiKey: settings.serpApiKey, origins: origins.slice(0, FINDER_LIMITS.googleAirports), destinations: destinations.slice(0, FINDER_LIMITS.googleAirports), departDate, returnDate, cabin, nonstop: nonstopOnly, adults: 1 });
    status.google = g.calls === 0 && status.google !== 'fetched' ? 'recent-cache' : 'fetched';
    status.googleCalls += g.calls || 0;
    if (cabin === 'economy') recordFares(g.fares).catch(() => {});
    return g.fares[0] ? { ...g.fares[0], insights: g.insights, link: g.url } : null;
  } catch (e) { status.google = 'error'; status.warnings.push(e.message); return null; }
}

// ---------- options ----------
const placeLabel = code => describe(code).label;
function awardLeg(l, dir) {
  return { dir, pay: 'points', origin: l.origin, destination: l.destination, date: l.flight?.depart?.date || l.date, program: l.program, programName: l.programName || programName(l.program),
    pointsPerTraveler: Math.round(l.mileageCost), taxesPerTraveler: l.totalTaxes ?? null, taxesEstimated: Boolean(l.taxesMissing), direct: l.direct ?? null, airlines: l.airlines || null,
    seats: l.remainingSeats ?? null, flightNumbers: l.flight?.flightNumbers || [], bookUrl: BOOKING_URLS[l.program] || null, source: l.dataSource || null };
}
function cashLeg(f, dir, cabin) {
  return { dir, pay: 'cash', origin: f.origin, destination: f.destination, date: f.departDate, returnDate: f.returnDate || null, pricePerTraveler: f.price, airlines: f.airlines || f.airline || null, direct: f.stops == null ? null : f.stops === 0,
    live: f.source === 'google', source: f.source, bookUrl: f.source === 'google' ? (f.link || null) : googleFlightsUrl({ origins: [f.origin], destinations: [f.destination], departDate: f.departDate, returnDate: f.returnDate, cabin }) };
}
function planSteps(trip, transfers) {
  const name = id => transfers.banks?.[id]?.name || programName(id);
  return trip.sources.map(s => ({ from: s.from, fromName: name(s.from), fromPoints: s.fromPoints, to: s.targetProgram, toName: programName(s.targetProgram), toPoints: s.targetPoints, direct: Boolean(s.direct), days: s.days || 0, bonusPct: s.bonusPct ? Math.round(s.bonusPct * 100) : 0 }));
}
function pointsOption(trip, q, transfers, cashTotal) {
  const [o, b] = trip.legs;
  const cpp = cashTotal != null && trip.totalSourcePoints > 0 ? round2(((cashTotal - trip.taxesUsd) / trip.totalSourcePoints) * 100) : null;
  return { id: `points:${trip.legs.map(l => l.id).join('|')}`, type: 'points', depart: o.date, return: b?.date || null,
    legs: [awardLeg(o, 'Outbound'), ...(b ? [awardLeg(b, 'Return')] : [])],
    points: trip.totalSourcePoints, plan: planSteps(trip, transfers), taxesUsd: round2(trip.taxesUsd), cashUsd: 0, outOfPocketUsd: round2(trip.taxesUsd),
    pointsValueUsd: round2(trip.pointsCostUsd), effectiveCostUsd: round2(trip.effectiveCostUsd), cpp, taxesEstimated: trip.legs.some(l => l.taxesMissing), warnings: (trip.warnings || []).filter(w => !/search limits/.test(w)) };
}
function mixedOption(trip, fare, pointsDir, q, transfers) {
  const award = trip.legs[0];
  const cashUsd = fare.price * q.travelers;
  const legs = pointsDir === 'Outbound' ? [awardLeg(award, 'Outbound'), cashLeg(fare, 'Return', q.cabin)] : [cashLeg(fare, 'Outbound', q.cabin), awardLeg(award, 'Return')];
  return { id: `mixed:${pointsDir}:${award.id}:${fare.departDate}:${fare.price}`, type: 'mixed', depart: legs[0].date, return: legs[1].date, legs,
    points: trip.totalSourcePoints, plan: planSteps(trip, transfers), taxesUsd: round2(trip.taxesUsd), cashUsd: round2(cashUsd), outOfPocketUsd: round2(trip.taxesUsd + cashUsd),
    pointsValueUsd: round2(trip.pointsCostUsd), effectiveCostUsd: round2(trip.effectiveCostUsd + cashUsd), cpp: null, taxesEstimated: Boolean(award.taxesMissing), warnings: (trip.warnings || []).filter(w => !/search limits/.test(w)) };
}
function cashOption(fare, q) {
  const total = fare.price * q.travelers;
  return { id: `cash:${fare.source}:${fare.origin}-${fare.destination}:${fare.departDate}:${fare.returnDate || ''}:${fare.price}`, type: 'cash', depart: fare.departDate, return: fare.returnDate || null,
    legs: [cashLeg(fare, q.tripType === 'one-way' ? 'Outbound' : 'Round trip', q.cabin)], points: 0, plan: [], taxesUsd: 0, cashUsd: round2(total), outOfPocketUsd: round2(total),
    pointsValueUsd: 0, effectiveCostUsd: round2(total), cpp: null, insights: fare.insights || null, estimated: q.travelers > 1,
    warnings: [...(fare.source === 'travelpayouts' ? ['Fare seen by other travelers in the last two days; confirm the live price before booking.'] : []), ...(q.travelers > 1 ? [`One-adult price × ${q.travelers}; group availability not checked.`] : [])] };
}

const fmtInt = n => Math.round(n).toLocaleString('en-US');
const usd = n => `$${fmtInt(n)}`;

function summarize(options, q, { hasAwardSpace, unfundedPair }) {
  const best = options[0] || null;
  const cash = options.find(o => o.type === 'cash') || null;
  const pointsBased = options.find(o => o.type === 'points' || o.type === 'mixed') || null;
  if (!best) return { headline: 'Nothing bookable was found in this window yet.', detail: hasAwardSpace ? 'Award seats exist, but your points and their transfer partners cannot cover them, and no cash fare was found.' : 'No award seats and no cash fares came back. A watch will keep checking every day.' };
  if (best.type === 'points') {
    const saved = cash ? cash.effectiveCostUsd - best.effectiveCostUsd : null;
    return { headline: `Use points: ${fmtInt(best.points)} points + ${usd(best.outOfPocketUsd)} in fees.`,
      detail: saved != null && saved > 0 ? `That beats the ${usd(cash.effectiveCostUsd)} cash fare by about ${usd(saved)} at your point values${best.cpp ? ` (${best.cpp.toFixed(1)}¢ per point)` : ''}.` : 'This is the lowest-cost way to take this trip with what you hold.' };
  }
  if (best.type === 'buy') return { headline: `Buy miles and book the award: ${usd(best.outOfPocketUsd)} all-in.`, detail: `Your points cannot cover this award, but buying ${fmtInt(best.pointsBought)} miles at your saved offer${cash ? ` beats the ${usd(cash.effectiveCostUsd)} cash fare` : ' makes it bookable'}.` };
  if (best.type === 'mixed') {
    const p = best.legs.find(l => l.pay === 'points');
    return { headline: `Mix points and cash: ${fmtInt(best.points)} points + ${usd(best.outOfPocketUsd)}.`, detail: `Award space is only worth taking on the ${p.dir.toLowerCase()} leg; paying cash for the other direction costs less overall than the alternatives.` };
  }
  return { headline: `Pay cash: ${usd(best.effectiveCostUsd)}${q.travelers > 1 ? ' total' : ''}.`,
    detail: pointsBased ? `The best points option (${fmtInt(pointsBased.points)} points + ${usd(pointsBased.outOfPocketUsd)}) works out to about ${usd(pointsBased.effectiveCostUsd)} at your point values, more than this fare. Save the points for a better redemption.`
      : hasAwardSpace ? `Award seats exist but your points cannot cover them${unfundedPair ? ` (cheapest needs ${fmtInt(unfundedPair.points)} ${unfundedPair.programs})` : ''}.`
        : 'No award seats are open in this window right now.' };
}

function insightsFor({ options, bonuses, seenPrograms, q, hasAwardSpace }) {
  const out = [];
  const pts = options.find(o => o.type === 'points' || o.type === 'mixed');
  for (const b of bonuses.filter(x => seenPrograms.has(x.to)).slice(0, 2)) out.push({ kind: 'bonus', text: `${b.bonusPct}% transfer bonus from ${b.fromName} to ${b.toName}${b.ends ? ` through ${b.ends}` : ''}. Totals here already include it.` });
  if (pts) {
    const worst = pts.legs.filter(l => l.pay === 'points').reduce((m, l) => Math.max(m, l.taxesPerTraveler || 0), 0);
    if (worst >= 300) out.push({ kind: 'fees', text: `This award carries about ${usd(worst)} per person in carrier surcharges on one leg. A different program or departure city can cut that.` });
    const seats = pts.legs.map(l => l.seats).filter(n => n != null);
    if (seats.length && Math.min(...seats) <= 2) out.push({ kind: 'seats', text: `Only ${Math.min(...seats)} award seat${Math.min(...seats) === 1 ? '' : 's'} left at this price. Confirm on the program's site before you transfer.` });
    const slow = pts.plan.find(s => !s.direct && s.days >= 2);
    if (slow) out.push({ kind: 'transfer', text: `${slow.fromName} to ${slow.toName} takes about ${slow.days} days. Ask the program to hold the award, or pick an instant transfer.` });
    if (pts.cpp != null) out.push({ kind: 'value', text: pts.cpp >= 2 ? `Strong value: ${pts.cpp.toFixed(1)}¢ per point against the cash fare.` : pts.cpp < 1 ? `Weak value: ${pts.cpp.toFixed(1)}¢ per point. Cash is usually the better choice below 1¢.` : `Fair value: ${pts.cpp.toFixed(1)}¢ per point against the cash fare.` });
  } else if (!hasAwardSpace && ['business', 'first'].includes(q.cabin)) {
    out.push({ kind: 'timing', text: 'Premium award seats often appear in the last two weeks before departure and when schedules open about 11 months out. A watch catches both.' });
  }
  const cash = options.find(o => o.type === 'cash');
  if (cash?.insights?.level) out.push({ kind: 'price', text: `Google rates this cash fare as ${cash.insights.level} for the route${cash.insights.typicalRange ? ` (typical ${usd(cash.insights.typicalRange[0])} to ${usd(cash.insights.typicalRange[1])})` : ''}.` });
  return out;
}

/**
 * Find the best way to pay for a trip inside a date window.
 * input: { origins?, destination, earliest, latest, tripType, nights, nightsFlex, cabin, travelers, nonstopOnly, maxCashUsd? }
 * allowGoogle: permit live Google Flights lookups (at most two per call, and none near the monthly quota).
 */
export async function findTrip(input, { allowApi = true, allowGoogle = true, cash = true } = {}) {
  const started = Date.now();
  const [settings, user, usage] = await Promise.all([getSettings(), loadUser(), apiUsage()]);
  const q = normalizeFinderQuery(input, { homeAirports: settings.homeAirports });
  const rt = q.tripType === 'round-trip';
  const transfers = transferData();
  const status = { api: 'skipped', warnings: [], travelpayouts: 'skipped', google: 'skipped', googleCalls: 0 };
  const outQ = { origins: q.origins, destinations: q.destinations, start: q.earliest, end: rt ? shift(q.latest, -q.minNights) : q.latest, cabin: q.cabin };
  const backQ = rt ? { origins: q.destinations, destinations: q.origins, start: shift(q.earliest, q.minNights), end: q.latest, cabin: q.cabin } : null;

  const [cached, history] = await Promise.all([
    cash ? cachedCashFares(q, settings, status) : { roundTrips: [], outbound: [], inbound: [] },
    loadHistory(),
    allowApi ? refreshFromApi(outQ, settings, status) : null,
    allowApi && backQ ? refreshFromApi(backQ, settings, status) : null
  ]);
  if (!settings.seatsAeroApiKey) status.api = 'not-configured';

  const usable = r => (!q.nonstopOnly || r.direct === true || r.flights?.length) && (r.remainingSeats == null || r.remainingSeats >= q.travelers);
  const [outRaw, backRaw] = await Promise.all([queryFlights(outQ), backQ ? queryFlights(backQ) : []]);
  const optionsFor = (rows, leg) => trimOptions(flightOptions(bestPerFlight(rows.filter(usable)), leg, { travelers: q.travelers, directOnly: q.nonstopOnly, history }));
  const outOpts = optionsFor(outRaw, 'Outbound'), backOpts = rt ? optionsFor(backRaw, 'Return') : [];
  const seenPrograms = new Set([...outOpts, ...backOpts].map(o => o.program));

  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };
  const ctx = { travelers: q.travelers, origins: q.origins, destinations: q.destinations, balances: user.balances, transfers, prefs };
  const fund = makeFunder(ctx);
  const value = id => (transfers.valuations?.cents?.[id] ?? prefs.defaultCpp) / 100;
  const rough = l => l.mileageCost * value(l.program) + (l.totalTaxes || 0);
  const byCost = (a, b) => a.effectiveCostUsd - b.effectiveCostUsd;

  // All-points trips.
  let pointsTrips = [], unfundedPair = null, unfundedLegs = null;
  if (rt) {
    const pairs = [];
    for (const o of outOpts) for (const b of backOpts) {
      const n = daysBetween(o.date, b.date);
      if (n < q.minNights || n > q.maxNights || !validateFlightPair([o, b], ctx).valid) continue;
      pairs.push({ legs: [o, b], rough: rough(o) + rough(b) });
    }
    pairs.sort((a, b) => a.rough - b.rough);
    pointsTrips = pairs.slice(0, FINDER_LIMITS.maxPairs).map(p => fund(p.legs)).filter(Boolean).sort(byCost);
    if (!pointsTrips.length && pairs[0]) unfundedLegs = pairs[0].legs;
    if (!pointsTrips.length && pairs[0]) unfundedPair = { points: (pairs[0].legs[0].mileageCost + pairs[0].legs[1].mileageCost) * q.travelers, programs: [...new Set(pairs[0].legs.map(l => l.programName))].join(' + ') };
  }
  const fundedOut = outOpts.map(o => fund([o])).filter(Boolean).sort(byCost);
  const fundedBack = backOpts.map(o => fund([o])).filter(Boolean).sort(byCost);
  if (!rt) {
    pointsTrips = fundedOut;
    if (!fundedOut.length && outOpts[0]) unfundedLegs = [outOpts[0]];
    if (!fundedOut.length && outOpts[0]) unfundedPair = { points: outOpts[0].mileageCost * q.travelers, programs: outOpts[0].programName };
  }

  // Cash: cached fares first; one live Google price when nothing is cached or the cabin is premium.
  const budget = { left: cash && allowGoogle && settings.serpApiKey && usage.serpCalls < FINDER_LIMITS.serpMonthlyReserve ? 2 : 0 };
  if (cash && allowGoogle && settings.serpApiKey && !budget.left) status.warnings.push('Live Google Flights checks are paused to protect this month\'s SerpApi quota.');
  let cashFare = (rt ? cached.roundTrips : cached.outbound)[0] || null;
  if (!cashFare) {
    const anchor = pointsTrips[0]?.legs[0].date || fundedOut[0]?.legs[0].date || shift(q.earliest, Math.max(0, Math.floor((daysBetween(q.earliest, q.latest) - q.nights) / 2)));
    const back = rt ? (pointsTrips[0]?.legs[1]?.date || (shift(anchor, q.nights) <= q.latest ? shift(anchor, q.nights) : q.latest)) : null;
    cashFare = await liveFare({ settings, status, budget, origins: q.origins, destinations: q.destinations, departDate: anchor, returnDate: back, cabin: q.cabin, nonstopOnly: q.nonstopOnly });
  }

  // Points one way + cash the other.
  const mixed = [];
  if (rt) {
    const inWindow = (out, back) => { const n = daysBetween(out, back); return n >= q.minNights && n <= q.maxNights; };
    const combine = (funded, fares, pointsDir) => {
      let bestMix = null;
      for (const t of funded.slice(0, 30)) for (const f of fares.slice(0, 40)) {
        const ok = pointsDir === 'Outbound' ? inWindow(t.legs[0].date, f.departDate) : inWindow(f.departDate, t.legs[0].date);
        if (!ok) continue;
        const m = mixedOption(t, f, pointsDir, q, transfers);
        if (!bestMix || m.effectiveCostUsd < bestMix.effectiveCostUsd) bestMix = m;
      }
      return bestMix;
    };
    let viaOut = combine(fundedOut, cached.inbound, 'Outbound'), viaBack = combine(fundedBack, cached.outbound, 'Return');
    // Award space in one direction only and no cached one-way fare: price the missing direction live.
    if (!pointsTrips.length && !viaOut && !viaBack && (fundedOut.length || fundedBack.length)) {
      const t = fundedOut[0] || fundedBack[0];
      const outDir = Boolean(fundedOut.length);
      const date = outDir ? (shift(t.legs[0].date, q.nights) <= q.latest ? shift(t.legs[0].date, q.nights) : q.latest) : (shift(t.legs[0].date, -q.nights) >= q.earliest ? shift(t.legs[0].date, -q.nights) : q.earliest);
      const f = await liveFare({ settings, status, budget, origins: outDir ? q.destinations : q.origins, destinations: outDir ? q.origins : q.destinations, departDate: date, returnDate: null, cabin: q.cabin, nonstopOnly: q.nonstopOnly });
      if (f) { if (outDir) viaOut = mixedOption(t, f, 'Outbound', q, transfers); else viaBack = mixedOption(t, f, 'Return', q, transfers); }
    }
    for (const m of [viaOut, viaBack]) if (m) mixed.push(m);
  }

  const cashTotal = cashFare ? cashFare.price * q.travelers : null;
  const pointsOptions = pointsTrips.slice(0, 40).map(t => pointsOption(t, q, transfers, cashTotal));
  // Award seats exist but the wallet falls short: price buying the missing miles at a saved offer.
  let buy = null;
  if (unfundedLegs && settings.buyPointsOffers?.length) {
    try {
      const quote = quotePointPurchases({ legs: unfundedLegs.map(l => ({ program: l.program, mileageCost: l.mileageCost, totalTaxes: l.totalTaxes ?? 0 })), travelers: q.travelers }, { balances: user.balances, offers: settings.buyPointsOffers });
      if (quote.purchaseCostUsd != null && quote.totalPointsToBuy > 0) {
        const total = round2(quote.purchaseCostUsd + quote.taxesUsd);
        buy = { id: `buy:${unfundedLegs.map(l => l.id).join('|')}`, type: 'buy', depart: unfundedLegs[0].date, return: unfundedLegs[1]?.date || null,
          legs: unfundedLegs.map((l, i) => awardLeg(l, i ? 'Return' : 'Outbound')), points: 0, pointsBought: quote.totalPointsToBuy,
          plan: quote.byProgram.filter(p => p.pointsToBuy).map(p => ({ buy: true, toName: p.programName, toPoints: p.pointsToBuy, priceCents: p.pricePerPointCents, costUsd: p.purchaseCostUsd, url: p.offerUrl })),
          taxesUsd: quote.taxesUsd, cashUsd: total, outOfPocketUsd: total, pointsValueUsd: 0, effectiveCostUsd: total, cpp: null,
          warnings: ['Uses the buy-points offer you saved under My Points. Confirm the offer and the award seat before buying; purchases are not refundable.'] };
      }
    } catch { /* an offer that cannot price this award is simply not shown */ }
  }
  const options = [pointsOptions[0], ...mixed.sort(byCost).slice(0, 1), buy, cashFare && cashOption(cashFare, q)].filter(Boolean).sort(byCost);
  // Other dates or programs worth a look: the next-best all-points trips on a different day.
  const alternatives = [];
  for (const o of pointsOptions.slice(1)) {
    if (alternatives.length >= 4) break;
    if (o.depart === pointsOptions[0].depart && o.return === pointsOptions[0].return) continue;
    if (alternatives.some(a => a.depart === o.depart && a.return === o.return)) continue;
    alternatives.push(o);
  }

  const hasAwardSpace = outOpts.length > 0 || backOpts.length > 0;
  const cashPerPerson = cashFare?.price ?? null;
  // A points option is "good" when it is not clearly worse than simply paying cash.
  const cashEff = options.find(o => o.type === 'cash')?.effectiveCostUsd ?? null;
  for (const o of options) o.good = o.type === 'buy' ? cashEff == null || o.effectiveCostUsd <= cashEff * 0.85 : o.type === 'cash' ? (q.maxCashUsd != null ? cashPerPerson <= q.maxCashUsd : cashFare?.insights?.level === 'low') : cashEff == null || o.effectiveCostUsd <= cashEff * 1.1;
  const hasPointsWay = options.some(o => o.type !== 'cash' && o.good);
  // Cheapest fundable one-way award per day, for the date strip.
  const perDay = list => { const m = new Map(); for (const t of list) { const l = t.legs[0]; const cur = m.get(l.date); if (!cur || t.totalSourcePoints < cur.points) m.set(l.date, { date: l.date, points: t.totalSourcePoints, feesUsd: round2(t.taxesUsd), program: l.programName }); } return [...m.values()].sort((a, b) => a.date.localeCompare(b.date)); };
  const goalMet = hasPointsWay || (q.maxCashUsd != null ? cashPerPerson != null && cashPerPerson <= q.maxCashUsd : cashFare?.insights?.level === 'low');
  const advice = adviceFor({ origins: q.origins, destinations: q.destinations, cabin: q.cabin, balances: user.balances, transfers, seenPrograms: [...seenPrograms] });
  return {
    query: { origins: q.origins, destinations: q.destinations, originsText: q.originsText, destinationText: q.destinationText, destinationLabel: q.destinations.length === 1 ? placeLabel(q.destinations[0]) : q.destinationText,
      tripType: q.tripType, travelers: q.travelers, cabin: q.cabin, earliest: q.earliest, latest: q.latest, nights: q.nights, nightsFlex: q.nightsFlex, nonstopOnly: q.nonstopOnly, maxCashUsd: q.maxCashUsd },
    summary: summarize(options, q, { hasAwardSpace, unfundedPair }),
    best: options[0] || null,
    options,
    alternatives,
    calendar: { outbound: perDay(fundedOut), return: perDay(fundedBack) },
    insights: insightsFor({ options, bonuses: activeBonuses(user.balances, transfers), seenPrograms, q, hasAwardSpace }),
    advice,
    goalMet,
    watch: { suggested: !goalMet, targetCashUsd: q.maxCashUsd ?? (cashPerPerson != null ? Math.floor(cashPerPerson * 0.85) : null) },
    counts: { outbound: outOpts.length, return: backOpts.length, cashFares: cached.roundTrips.length + cached.outbound.length + cached.inbound.length },
    walletEmpty: !(user.balances || []).some(b => Number(b.balance) > 0),
    dataStatus: status,
    tookMs: Date.now() - started
  };
}
