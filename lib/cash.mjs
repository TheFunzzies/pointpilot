import { assertCalendarDate, parseFiniteNumber } from './validate.mjs';
// Cash fares: route search, price history, "usual price" baselines and deal detection.
//
// A fare's "usual price" (baseline) is the median of the cheapest fare PointPilot saw for that
// route on each of the last 90 days (round trip and one-way kept separate). It needs fares from
// at least 3 different days before PointPilot calls anything a deal.
import crypto from 'node:crypto';
import { dataFile } from './paths.mjs';
import { describe, cityCodeOf } from './geo.mjs';
import { readJson, updateJson } from './store.mjs';
import { resolveAirports } from './places.mjs';
import { routeFares, faresFromOrigin } from './travelpayouts.mjs';
import { googleFlights, googleFlightsUrl } from './serpapi.mjs';
import { getSettings } from './settings.mjs';
import { todayISO } from './transfers.mjs';
import { normalizeCabin } from './programs.mjs';

const FILE = () => dataFile('cash-history.json');
const MAX_ROWS = 40000;
const BASELINE_DAYS = 90;
export const MIN_BASELINE_DAYS = 3;
const MAX_ROUTE_COMBOS = 6;

// ---------- place names for display ("Lisbon, Portugal") ----------
export const placeName = code => describe(code).label;

// Normalize confirmed units once. Unknown group amounts never become totals.
export function priceFare(fare, adults = 1, oneAdult = null) {
  const pricing = { queriedAdults: 1, amount: fare.price, currency: 'USD', amountBasis: fare.source === 'google' ? 'unknown' : 'per-adult', estimated: false, source: fare.source, quotedAt: new Date().toISOString(), completeItinerary: fare.source !== 'google' || !fare.returnDate, ...fare.pricing, requestedAdults: adults };
  if (pricing.amountBasis === 'per-adult' && adults > 1) pricing.estimated = true;
  const unknown = pricing.amountBasis === 'unknown' && adults > 1;
  const total = unknown ? null : pricing.amountBasis === 'group' ? pricing.amount : pricing.amount * adults;
  const label = 'one-adult price × ' + adults + ' — estimated, group availability not checked';
  const oneAdultEstimate = adults > 1 && oneAdult ? { ...oneAdult.pricing, requestedAdults: adults, queriedAdults: 1, amount: oneAdult.price * adults, currency: 'USD', amountBasis: 'group', estimated: true, label } : null;
  return { ...fare, pricing, total, perTraveler: total == null ? null : total / adults,
    exactComparable: adults === 1 || !pricing.estimated && pricing.amountBasis !== 'unknown' && pricing.completeItinerary,
    pricingLabel: unknown ? (pricing.queriedAdults === adults ? 'Price returned for ' + adults + ' adults — basis unconfirmed' : 'Cash price — basis unconfirmed; group query not confirmed') : adults > 1 && pricing.estimated ? label : 'One-adult price', oneAdultEstimate };
}

function sameFareScope(a, b) {
  return a.origin === b.origin && a.destination === b.destination && a.departDate === b.departDate && a.returnDate === b.returnDate && a.cabin === b.cabin;
}

export async function googleCash(params, adults) {
  const group = await googleFlights({ ...params, adults });
  let single = null;
  const warnings = [];
  if (adults > 1) {
    try { single = await googleFlights({ ...params, adults: 1 }); }
    catch { warnings.push('One-adult estimate unavailable.'); }
  }
  return { ...group, warnings, oneAdultEstimates: (single?.fares || []).map(f => ({ origin: f.origin, destination: f.destination, departDate: f.departDate, returnDate: f.returnDate, cabin: f.cabin, stops: f.stops, returnStops: f.returnStops, ...priceFare(f, adults, f).oneAdultEstimate })), fares: group.fares.map(f => priceFare(f, adults, single?.fares.find(x => sameFareScope(f, x)))) };
}

function historyKey(f) {
  const prefix = f.origin + '-' + f.destination + ':' + (f.tripType || tripType(f)) + ':' + (f.cabin || 'economy');
  const p = f.pricing || priceFare(f, 1).pricing;
  return [prefix,f.departDate,f.returnDate || '',p.requestedAdults,p.queriedAdults,p.currency,p.amountBasis,p.estimated,p.completeItinerary].join(':');
}

// ---------- history ----------
const tripType = f => (f.returnDate ? 'rt' : 'ow');
const day = iso => String(iso || new Date().toISOString()).slice(0, 10);

export async function recordFares(fares, observedAt = new Date().toISOString()) {
  if (!fares.length) return;
  const d = day(observedAt);
  await updateJson(FILE(), [], rows => {
    const ids = new Set(rows.map(r => r.id));
    for (const input of fares) {
      const f = priceFare(input, input.pricing?.requestedAdults || 1);
      const row = { observedDay: d, origin: f.origin, destination: f.destination, tripType: tripType(f), cabin: f.cabin || 'economy', departDate: f.departDate, returnDate: f.returnDate || null, price: f.price, source: f.source, stops: f.stops ?? null, ...(f.pricing ? { pricing: f.pricing } : {}) };
      const { quotedAt: _quotedAt, ...pricingIdentity } = row.pricing;
      row.id = crypto.createHash('sha1').update(JSON.stringify({ ...row, pricing: pricingIdentity })).digest('hex').slice(0, 16);
      if (!ids.has(row.id)) { rows.push(row); ids.add(row.id); }
    }
    return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
  });
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Baselines isolate route, dates, cabin, passenger scope and price units. */
export async function baselines(today = todayISO()) {
  const cutoff = new Date(Date.parse(today) - BASELINE_DAYS * 86400000).toISOString().slice(0, 10);
  const perDay = new Map(); // key -> Map(day -> min price)
  for (const r of await readJson(FILE(), [])) {
    if (r.observedDay >= today || r.observedDay < cutoff) continue;
    const k = historyKey(r);
    if (!perDay.has(k)) perDay.set(k, new Map());
    const m = perDay.get(k);
    m.set(r.observedDay, Math.min(m.get(r.observedDay) ?? Infinity, r.price));
  }
  const out = new Map();
  for (const [k, m] of perDay) out.set(k, { days: m.size, median: median([...m.values()]), low: Math.min(...m.values()) });
  return out;
}

export function dealInfo(fare, base) {
  const b = base.get(historyKey(fare));
  if (!b || b.days < MIN_BASELINE_DAYS) return { usualPrice: b?.median ?? null, baselineDays: b?.days ?? 0, pctBelow: null, label: 'Building price history' };
  const pct = ((b.median - fare.price) / b.median) * 100;
  let label = 'Typical price';
  if (pct >= 10) label = `${Math.round(pct)}% below usual`;
  else if (pct <= -10) label = `${Math.round(-pct)}% above usual`;
  if (fare.price < b.low) label = `Lowest seen · ${label}`;
  return { usualPrice: b.median, baselineDays: b.days, pctBelow: pct, label };
}

// ---------- route search ----------
const shift = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthsIn = (a, b) => [...new Set([a.slice(0, 7), b.slice(0, 7)])];
function windowOf(date, flex) {
  const f = Math.max(0, Math.min(14, Math.round(Number(flex) || 0)));
  let start = shift(date, -f); if (start < todayISO()) start = todayISO();
  return { start, end: shift(date, f) };
}
const badRequest = m => Object.assign(new Error(m), { status: 400 });
function validateCashDates(params) {
  assertCalendarDate(params?.departDate, 'departDate');
  if (params.returnDate) assertCalendarDate(params.returnDate, 'returnDate');
  if (params.returnDate && params.returnDate < params.departDate) throw badRequest('Return date is before the departure date.');
  if (params.flexDays != null) parseFiniteNumber(params.flexDays, { min: 0, max: 14, integer: true, name: 'flexDays' });
}

/** Actual airports, trip type, date window and both directions must fit the requested trip. */
export function fareCompatibility(f, { origins, destinations, departDate, returnDate = null, out = { start: departDate, end: departDate }, back = returnDate ? { start: returnDate, end: returnDate } : null, nonstopOnly = false }) {
  const incompatibility = [];
  if (!origins.includes(f.origin) || !destinations.includes(f.destination)) incompatibility.push('different airports');
  if (Boolean(f.returnDate) !== Boolean(back)) incompatibility.push('different trip type');
  if (!(f.departDate >= out.start && f.departDate <= out.end) || (back && !(f.returnDate >= back.start && f.returnDate <= back.end))) incompatibility.push('different dates');
  if (nonstopOnly && (f.stops !== 0 || (back && f.returnStops !== 0))) incompatibility.push('nonstop not confirmed in both directions');
  return { compatible: !incompatibility.length, incompatibility };
}

/**
 * params: { origins, destination, departDate, returnDate?, flexDays, nonstopOnly, travelers, cabin, useGoogle }
 * Raw prices retain provider units; pricing describes totals and uncertainty.
 */
export async function searchCash(params, { allowGoogle = true, bypassCache = false } = {}) {
  validateCashDates(params);
  const origins = resolveAirports(params.origins);
  const destinations = resolveAirports(params.destination);
  const travelers = parseFiniteNumber(params.travelers ?? 1, { min: 1, max: 9, integer: true, name: 'travelers' });
  const cabin = normalizeCabin(params.cabin) || 'economy';
  const out = windowOf(params.departDate, params.flexDays);
  const back = params.returnDate ? windowOf(params.returnDate, params.flexDays) : null;
  const settings = await getSettings();
  const status = { travelpayouts: 'not-configured', google: 'skipped', warnings: [] };

  let fares = [];
  if (settings.travelpayoutsToken) {
    let allTravelpayoutsCached = true;
    const combos = origins.flatMap(o => destinations.map(d => [o, d])).slice(0, MAX_ROUTE_COMBOS);
    if (origins.length * destinations.length > MAX_ROUTE_COMBOS) status.warnings.push(`Checked the first ${MAX_ROUTE_COMBOS} airport pairs; narrow the airports for a complete search.`);
    const exact = !Number(params.flexDays);
    try {
      for (const [o, d] of combos) {
        for (const dm of exact ? [params.departDate] : monthsIn(out.start, out.end)) {
          for (const rm of back ? (exact ? [params.returnDate] : monthsIn(back.start, back.end)) : [null]) {
            const r = await routeFares({ token: settings.travelpayoutsToken, origin: o, destination: d, departAt: dm, returnAt: rm, direct: Boolean(params.nonstopOnly), bypassCache });
            allTravelpayoutsCached &&= r.calls === 0;
            fares.push(...r.fares.map(f => priceFare(f, travelers)));
          }
        }
      }
      status.travelpayouts = allTravelpayoutsCached ? 'recent-cache' : 'fetched';
    } catch (e) {
      status.travelpayouts = 'error';
      status.warnings.push(e.message);
    }
    fares = fares.map(f => ({ ...f, ...fareCompatibility(f, { origins, destinations, out, back, nonstopOnly: params.nonstopOnly }) }));
  }
  const alternatives = fares.filter(f => !f.compatible).map(f => ({ ...f, comparison: 'alternative', label: 'Alternative: ' + f.incompatibility.join('; ') }));
  fares = fares.filter(f => f.compatible);
  const economyOnly = fares; // Travelpayouts route prices don't distinguish cabins: treat as economy

  let google = null;
  if (allowGoogle && params.useGoogle) {
    if (!settings.serpApiKey) status.warnings.push('Add a SerpApi key under Data & System to check live Google Flights prices.');
    else {
      try {
        const g = await googleCash({ apiKey: settings.serpApiKey, origins, destinations, departDate: params.departDate, returnDate: params.returnDate || null, cabin, nonstop: Boolean(params.nonstopOnly), bypassCache }, travelers);
        status.warnings.push(...g.warnings);
        const checked = g.fares.map(f => ({ ...f, ...fareCompatibility(f, { origins, destinations, out, back, nonstopOnly: params.nonstopOnly }) }));
        alternatives.push(...checked.filter(f => !f.compatible).map(f => ({ ...f, comparison: 'alternative', label: 'Alternative: ' + f.incompatibility.join('; ') })));
        google = { ...g, fares: checked.filter(f => f.compatible) };
        status.google = g.calls === 0 ? 'recent-cache' : 'fetched';
      } catch (e) { status.google = 'error'; status.warnings.push(e.message); }
    }
  }
  // Results list: for economy, cached + live fares together; for premium cabins, only Google's
  // cabin-specific fares (economy prices are shown separately for reference).
  if (cabin === 'economy') fares = [...economyOnly, ...(google?.fares || [])];
  else {
    fares = google?.fares || [];
    if (economyOnly.length && !google) status.warnings.push(`Cached fares are economy only. Tick "Check live Google Flights price" for ${cabin}-class prices.`);
  }

  const base = await baselines();
  await recordFares([...economyOnly, ...(google?.fares || [])]); // each fare carries its cabin, so baselines never mix cabins
  const seen = new Set();
  const ranked = fares
    .sort((a, b) => a.price - b.price)
    .filter(f => { const k = `${f.source}:${f.origin}:${f.destination}:${f.departDate}:${f.returnDate}:${f.price}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 30)
    .map(f => ({ ...f, ...dealInfo(f, base), originName: placeName(f.origin), destinationName: placeName(f.destination) }));

  return {
    query: { origins, destinations, out, back, travelers, cabin, nonstopOnly: Boolean(params.nonstopOnly) },
    fares: ranked,
    alternatives,
    economyReference: cabin === 'economy' ? [] : economyOnly.sort((a, b) => a.price - b.price).slice(0, 5).map(f => ({ ...f, originName: placeName(f.origin), destinationName: placeName(f.destination) })),
    google: google && { oneAdultEstimates: google.oneAdultEstimates, insights: google.insights, url: google.url, cachedAt: google.cachedAt || null, fares: google.fares.slice(0, 8).map(f => ({ ...f })) },
    googleFlightsUrl: googleFlightsUrl({ origins, destinations, departDate: params.departDate, returnDate: params.returnDate, cabin }),
    dataStatus: status
  };
}

// ---------- cash price for an award itinerary (points vs. cash) ----------
/**
 * params: { origin, destination, departDate, returnDate?, cabin, travelers }
 * Uses Google Flights (SerpApi) when configured — it's cabin-aware. Falls back to Travelpayouts
 * for economy only, since its data doesn't distinguish cabins.
 */
export async function cashForItinerary(params) {
  validateCashDates(params);
  const settings = await getSettings();
  const cabin = normalizeCabin(params.cabin) || 'economy';
  const travelers = parseFiniteNumber(params.travelers ?? 1, { min: 1, max: 9, integer: true, name: 'travelers' });
  const route = { origins: [String(params.origin).toUpperCase()], destinations: [String(params.destination).toUpperCase()], departDate: params.departDate, returnDate: params.returnDate || null };
  if (![...route.origins, ...route.destinations].every(x => /^[A-Z]{3}$/.test(x))) throw badRequest('Origin and destination must be 3-letter airport codes.');
  const compatibility = f => fareCompatibility(f, { ...route, nonstopOnly: params.nonstopOnly });
  const url = googleFlightsUrl({ ...route, cabin });
  if (settings.serpApiKey) {
    const g = await googleCash({ apiKey: settings.serpApiKey, ...route, cabin, nonstop: Boolean(params.nonstopOnly) }, travelers);
    const chosen = g.fares.filter(f => compatibility(f).compatible).sort((a, b) => a.price - b.price)[0];
    const price = chosen?.price ?? null;
    if (cabin === 'economy') await recordFares(g.fares);
    const alternatives = g.fares.filter(f => !compatibility(f).compatible).map(f => ({ ...f, comparison: 'alternative', label: 'Alternative: ' + compatibility(f).incompatibility.join('; ') }));
    return { available: price != null, source: 'google', alternatives, cabin, perTraveler: chosen?.perTraveler ?? null, total: chosen?.total ?? null, pricing: chosen?.pricing ?? null, pricingLabel: chosen?.pricingLabel ?? null, oneAdultEstimate: chosen?.oneAdultEstimate ?? g.oneAdultEstimates.find(f => compatibility(f).compatible) ?? null, exactComparable: chosen?.exactComparable ?? false, warnings: g.warnings, insights: g.insights, url: g.url, cachedAt: g.cachedAt || null };
  }
  if (settings.travelpayoutsToken && cabin === 'economy') {
    const r = await routeFares({ token: settings.travelpayoutsToken, origin: route.origins[0], destination: route.destinations[0], departAt: route.departDate, returnAt: route.returnDate });
    r.fares = r.fares.map(f => priceFare(f, travelers));
    await recordFares(r.fares);
    const exact = r.fares.filter(f => compatibility(f).compatible);
    const alternatives = r.fares.filter(f => !compatibility(f).compatible).map(f => ({ ...f, comparison: 'alternative', label: 'Alternative: ' + compatibility(f).incompatibility.join('; ') }));
    const chosen = exact.sort((a, b) => a.price - b.price)[0];
    const price = chosen?.price ?? null;
    return { available: price != null, source: 'travelpayouts', alternatives, cabin, perTraveler: chosen?.perTraveler ?? null, total: chosen?.total ?? null, pricing: chosen?.pricing ?? null, pricingLabel: chosen?.pricingLabel ?? null, exactComparable: chosen?.exactComparable ?? false, oneAdultEstimate: null, insights: null, url };
  }
  return { available: false, cabin, url, reason: cabin === 'economy' ? 'Add a Travelpayouts token or SerpApi key under Data & System.' : `A ${cabin} cash price needs a SerpApi key (Google Flights).` };
}

// ---------- deals from home airports ----------
/**
 * Cheapest recent fares from home airports — to anywhere, or to one `destination`
 * ("Tokyo", "LIS", "Italy"). Each deal is tagged domestic or international.
 */
export async function dealsFromAirports({ airports, maxPrice = 0, oneWay = false, cabin = 'economy', destination = '' }) {
  cabin = ['business', 'first'].includes(cabin) ? cabin : 'economy';
  const settings = await getSettings();
  if (!settings.travelpayoutsToken) throw badRequest('Add a free Travelpayouts token under Data & System to find deals.');
  const homes = resolveAirports(airports);
  // Aviasales indexes destinations by city code (TYO, not HND/NRT).
  const destCities = String(destination || '').trim()
    ? [...new Set(resolveAirports(destination).map(cityCodeOf))].slice(0, 4)
    : [null];
  const status = { travelpayouts: 'fetched', warnings: [] };
  const fares = [];
  for (const a of homes.slice(0, 6)) {
    for (const d of destCities) {
      try {
        const r = await faresFromOrigin({ token: settings.travelpayoutsToken, origin: a, oneWay, cabin, destination: d });
        fares.push(...r.fares.filter(f => f.departDate >= todayISO()));
      } catch (e) { status.travelpayouts = 'error'; status.warnings.push(`${a}${d ? `→${d}` : ''}: ${e.message}`); }
    }
  }
  const base = await baselines();
  await recordFares(fares);
  // Cheapest fare per destination per origin.
  const best = new Map();
  for (const f of fares) { const k = `${f.origin}-${f.destination}`; if (!best.has(k) || f.price < best.get(k).price) best.set(k, f); }
  const deals = [...best.values()]
    .filter(f => !maxPrice || f.price <= maxPrice)
    .map(f => {
      const dest = describe(f.destination), org = describe(f.origin);
      return { ...f, ...dealInfo(f, base), originName: org.label, destinationName: dest.city || f.destination, destinationCountry: dest.country, destinationLabel: dest.label,
        scope: org.countryCode && dest.countryCode && org.countryCode === dest.countryCode ? 'domestic' : 'international',
        googleFlightsUrl: googleFlightsUrl({ origins: [f.origin], destinations: [f.destination], departDate: f.departDate, returnDate: f.returnDate, cabin }) };
    })
    .sort((a, b) => ((b.pctBelow ?? -Infinity) - (a.pctBelow ?? -Infinity)) || a.price - b.price);
  if (cabin !== 'economy' && !fares.length) status.warnings.push(`Aviasales has few cached ${cabin}-class fares from these airports right now; economy deals are much more complete.`);
  return {
    airports: homes, cabin, destination: destination || null, deals: deals.slice(0, 80), dataStatus: status,
    // Google's own tools for exploring further (Explore map and the Deals page).
    googleLinks: {
      explore: `https://www.google.com/travel/explore?q=${encodeURIComponent(`Flights from ${homes.join(',')}${destination ? ` to ${destination}` : ''}`)}`,
      deals: 'https://www.google.com/travel/flights/deals'
    }
  };
}
