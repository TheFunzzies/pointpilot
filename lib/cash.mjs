// Cash fares: route search, price history, "usual price" baselines and deal detection.
//
// A fare's "usual price" (baseline) is the median of the cheapest fare PointPilot saw for that
// route on each of the last 90 days (round trip and one-way kept separate). It needs fares from
// at least 3 different days before PointPilot calls anything a deal.
import crypto from 'node:crypto';
import { dataFile } from './paths.mjs';
import { describe } from './geo.mjs';
import { readJson, updateJson } from './store.mjs';
import { resolveAirports } from './places.mjs';
import { routeFares, faresFromOrigin } from './travelpayouts.mjs';
import { googleFlights, googleFlightsUrl } from './serpapi.mjs';
import { getSettings, recordApiCalls } from './settings.mjs';
import { todayISO } from './transfers.mjs';
import { normalizeCabin } from './programs.mjs';

const FILE = () => dataFile('cash-history.json');
const MAX_ROWS = 40000;
const BASELINE_DAYS = 90;
export const MIN_BASELINE_DAYS = 3;
const MAX_ROUTE_COMBOS = 6;

// ---------- place names for display ("Lisbon, Portugal") ----------
export const placeName = code => describe(code).label;

// ---------- history ----------
const tripType = f => (f.returnDate ? 'rt' : 'ow');
const day = iso => String(iso || new Date().toISOString()).slice(0, 10);

export async function recordFares(fares, observedAt = new Date().toISOString()) {
  if (!fares.length) return;
  const d = day(observedAt);
  await updateJson(FILE(), [], rows => {
    const ids = new Set(rows.map(r => r.id));
    for (const f of fares) {
      const row = { observedDay: d, origin: f.origin, destination: f.destination, tripType: tripType(f), cabin: f.cabin || 'economy', departDate: f.departDate, returnDate: f.returnDate || null, price: f.price, source: f.source, stops: f.stops ?? null };
      row.id = crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16);
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

/** Baselines keyed "ORIGIN-DEST:rt|ow:cabin", built from days before `today` only. */
export async function baselines(today = todayISO()) {
  const cutoff = new Date(Date.parse(today) - BASELINE_DAYS * 86400000).toISOString().slice(0, 10);
  const perDay = new Map(); // key -> Map(day -> min price)
  for (const r of await readJson(FILE(), [])) {
    if (r.observedDay >= today || r.observedDay < cutoff) continue;
    const k = `${r.origin}-${r.destination}:${r.tripType}:${r.cabin || 'economy'}`;
    if (!perDay.has(k)) perDay.set(k, new Map());
    const m = perDay.get(k);
    m.set(r.observedDay, Math.min(m.get(r.observedDay) ?? Infinity, r.price));
  }
  const out = new Map();
  for (const [k, m] of perDay) out.set(k, { days: m.size, median: median([...m.values()]), low: Math.min(...m.values()) });
  return out;
}

export function dealInfo(fare, base) {
  const b = base.get(`${fare.origin}-${fare.destination}:${tripType(fare)}:${fare.cabin || 'economy'}`);
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

/**
 * params: { origins, destination, departDate, returnDate?, flexDays, nonstopOnly, travelers, cabin, useGoogle }
 * All prices returned are USD per traveler, plus `total` for all travelers.
 */
export async function searchCash(params, { allowGoogle = true } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(params.departDate || ''))) throw badRequest('Choose a departure date.');
  if (params.returnDate && params.returnDate < params.departDate) throw badRequest('Return date is before the departure date.');
  const origins = resolveAirports(params.origins);
  const destinations = resolveAirports(params.destination);
  const travelers = Math.max(1, Math.min(9, Math.round(Number(params.travelers) || 1)));
  const cabin = normalizeCabin(params.cabin) || 'economy';
  const out = windowOf(params.departDate, params.flexDays);
  const back = params.returnDate ? windowOf(params.returnDate, params.flexDays) : null;
  const settings = await getSettings();
  const status = { travelpayouts: 'not-configured', google: 'skipped', warnings: [] };

  let fares = [];
  if (settings.travelpayoutsToken) {
    const combos = origins.flatMap(o => destinations.map(d => [o, d])).slice(0, MAX_ROUTE_COMBOS);
    if (origins.length * destinations.length > MAX_ROUTE_COMBOS) status.warnings.push(`Checked the first ${MAX_ROUTE_COMBOS} airport pairs; narrow the airports for a complete search.`);
    const exact = !Number(params.flexDays);
    let calls = 0;
    try {
      for (const [o, d] of combos) {
        for (const dm of exact ? [params.departDate] : monthsIn(out.start, out.end)) {
          for (const rm of back ? (exact ? [params.returnDate] : monthsIn(back.start, back.end)) : [null]) {
            const r = await routeFares({ token: settings.travelpayoutsToken, origin: o, destination: d, departAt: dm, returnAt: rm, direct: Boolean(params.nonstopOnly) });
            calls += r.calls;
            fares.push(...r.fares);
          }
        }
      }
      status.travelpayouts = 'fetched';
    } catch (e) {
      status.travelpayouts = 'error';
      status.warnings.push(e.message);
    }
    await recordApiCalls(calls, 'travelpayouts');
    fares = fares.filter(f => f.departDate >= out.start && f.departDate <= out.end && (!back || (f.returnDate && f.returnDate >= back.start && f.returnDate <= back.end)) && (!params.nonstopOnly || f.stops === 0));
  }
  const economyOnly = fares; // Travelpayouts route prices don't distinguish cabins: treat as economy

  let google = null;
  if (allowGoogle && params.useGoogle) {
    if (!settings.serpApiKey) status.warnings.push('Add a SerpApi key under Data & System to check live Google Flights prices.');
    else {
      try {
        const g = await googleFlights({ apiKey: settings.serpApiKey, origins, destinations, departDate: params.departDate, returnDate: params.returnDate || null, cabin, nonstop: Boolean(params.nonstopOnly) });
        await recordApiCalls(g.calls, 'serp');
        google = g;
        status.google = 'fetched';
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
    .map(f => ({ ...f, total: f.price * travelers, ...dealInfo(f, base), originName: placeName(f.origin), destinationName: placeName(f.destination) }));

  return {
    query: { origins, destinations, out, back, travelers, cabin, nonstopOnly: Boolean(params.nonstopOnly) },
    fares: ranked,
    economyReference: cabin === 'economy' ? [] : economyOnly.sort((a, b) => a.price - b.price).slice(0, 5).map(f => ({ ...f, total: f.price * travelers, originName: placeName(f.origin), destinationName: placeName(f.destination) })),
    google: google && { insights: google.insights, url: google.url, fares: google.fares.slice(0, 8).map(f => ({ ...f, total: f.price * travelers })) },
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
  const settings = await getSettings();
  const cabin = normalizeCabin(params.cabin) || 'economy';
  const travelers = Math.max(1, Math.round(Number(params.travelers) || 1));
  const route = { origins: [String(params.origin).toUpperCase()], destinations: [String(params.destination).toUpperCase()], departDate: params.departDate, returnDate: params.returnDate || null };
  const url = googleFlightsUrl({ ...route, cabin });
  if (settings.serpApiKey) {
    const g = await googleFlights({ apiKey: settings.serpApiKey, ...route, cabin });
    await recordApiCalls(g.calls, 'serp');
    const price = g.fares[0]?.price ?? g.insights?.lowestPrice ?? null;
    if (cabin === 'economy') await recordFares(g.fares);
    return { available: price != null, source: 'google', cabin, perTraveler: price, total: price != null ? price * travelers : null, insights: g.insights, url: g.url };
  }
  if (settings.travelpayoutsToken && cabin === 'economy') {
    const r = await routeFares({ token: settings.travelpayoutsToken, origin: route.origins[0], destination: route.destinations[0], departAt: route.departDate, returnAt: route.returnDate });
    await recordApiCalls(r.calls, 'travelpayouts');
    await recordFares(r.fares);
    const price = r.fares.sort((a, b) => a.price - b.price)[0]?.price ?? null;
    return { available: price != null, source: 'travelpayouts', cabin, perTraveler: price, total: price != null ? price * travelers : null, insights: null, url };
  }
  return { available: false, cabin, url, reason: cabin === 'economy' ? 'Add a Travelpayouts token or SerpApi key under Data & System.' : `A ${cabin} cash price needs a SerpApi key (Google Flights).` };
}

// ---------- deals from home airports ----------
export async function dealsFromAirports({ airports, maxPrice = 0, oneWay = false, cabin = 'economy' }) {
  cabin = ['business', 'first'].includes(cabin) ? cabin : 'economy';
  const settings = await getSettings();
  if (!settings.travelpayoutsToken) throw badRequest('Add a free Travelpayouts token under Data & System to find deals.');
  const homes = resolveAirports(airports);
  const status = { warnings: [] };
  let calls = 0;
  const fares = [];
  for (const a of homes.slice(0, 6)) {
    try {
      const r = await faresFromOrigin({ token: settings.travelpayoutsToken, origin: a, oneWay, cabin });
      calls += r.calls;
      fares.push(...r.fares.filter(f => f.departDate >= todayISO()));
    } catch (e) { status.warnings.push(`${a}: ${e.message}`); }
  }
  await recordApiCalls(calls, 'travelpayouts');
  const base = await baselines();
  await recordFares(fares);
  // Cheapest fare per destination per origin.
  const best = new Map();
  for (const f of fares) { const k = `${f.origin}-${f.destination}`; if (!best.has(k) || f.price < best.get(k).price) best.set(k, f); }
  const deals = [...best.values()]
    .filter(f => !maxPrice || f.price <= maxPrice)
    .map(f => { const dest = describe(f.destination), org = describe(f.origin); return { ...f, ...dealInfo(f, base), originName: org.label, destinationName: dest.city || f.destination, destinationCountry: dest.country, destinationLabel: dest.label, googleFlightsUrl: googleFlightsUrl({ origins: [f.origin], destinations: [f.destination], departDate: f.departDate, returnDate: f.returnDate, cabin }) }; })
    .sort((a, b) => ((b.pctBelow ?? -Infinity) - (a.pctBelow ?? -Infinity)) || a.price - b.price);
  if (cabin !== 'economy' && !fares.length) status.warnings.push(`Aviasales has few cached ${cabin}-class fares from these airports right now; economy deals are much more complete.`);
  return { airports: homes, cabin, deals: deals.slice(0, 60), dataStatus: status };
}
