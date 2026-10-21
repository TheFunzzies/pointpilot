import { recordApiCalls } from './settings.mjs';
import { dataDir } from './paths.mjs';
// SerpApi Google Flights — live Google Flights prices plus Google's "price insights"
// (low / typical / high). Free plan: 250 searches/month. Docs: https://serpapi.com/google-flights-api
// Query the real party; provider amount units remain unconfirmed.
import { parseFiniteNumber } from './validate.mjs';
import { ApiError } from './errors.mjs';
import { zonedToUtc } from './geo.mjs';
import { observeRequest } from './request-observer.mjs';

const TRAVEL_CLASS = { economy: 1, premium: 2, business: 3, first: 4 };

export function googleFlightsUrl({ origins, destinations, departDate, returnDate, cabin }) {
  const q = `Flights from ${origins.join(',')} to ${destinations.join(',')} on ${departDate}${returnDate ? ` through ${returnDate}` : ' one way'}${cabin && cabin !== 'economy' ? ` ${cabin} class` : ''}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function mapItinerary(it) {
  const legs = Array.isArray(it?.flights) ? it.flights : [];
  if (!(Number(it?.price) > 0) || !legs.length) return null;
  const origin = legs[0].departure_airport?.id || null, destination = legs[legs.length - 1].arrival_airport?.id || null;
  const dep = String(legs[0].departure_airport?.time || ''), arr = String(legs[legs.length - 1].arrival_airport?.time || '');
  const utc = (s, ap) => { const [d, t] = s.split(' '); return d && t ? zonedToUtc(d, t, ap) : null; };
  return {
    source: 'google',
    origin, destination,
    departTime: dep || null,                        // local, "YYYY-MM-DD HH:MM"
    arriveTime: arr || null,
    departUtc: utc(dep, origin),
    arriveUtc: utc(arr, destination),
    layovers: (it.layovers || []).map(l => ({ airport: l.id, durationMin: Number(l.duration) || null, overnight: Boolean(l.overnight) })),
    price: Number(it.price),                       // USD, basis unconfirmed
    airlines: [...new Set(legs.map(f => f.airline).filter(Boolean))].join(', '),
    flightNumbers: legs.map(f => f.flight_number).filter(Boolean).join(' / '),
    stops: legs.length - 1,
    durationMin: Number(it.total_duration) || null,
    live: true
  };
}

/** One Google Flights search. Returns { fares, insights, url, calls: 1 }. */
async function googleFlightsUncached({ apiKey, origins, destinations, departDate, returnDate = null, cabin = 'economy', nonstop = false, adults = 1, fetchImpl = fetch }) {
  if (!apiKey) throw new ApiError('No SerpApi key configured.', 400, 'NO_SERPAPI_KEY');
  const q = new URLSearchParams({
    engine: 'google_flights', api_key: apiKey, hl: 'en', gl: 'us', currency: 'USD',
    departure_id: origins.join(','), arrival_id: destinations.join(','),
    outbound_date: departDate, type: returnDate ? '1' : '2', travel_class: String(TRAVEL_CLASS[cabin] || 1), adults: String(adults)
  });
  if (returnDate) q.set('return_date', returnDate);
  if (nonstop) q.set('stops', '1');
  let r;
  try {
    await recordApiCalls(1, 'serp');
    r = await observeRequest({service:'serpapi',operation:'google.flights',method:'GET'}, () => fetchImpl(`https://serpapi.com/search.json?${q}`, { signal: AbortSignal.timeout(60000) }), { classify:async response => { const body=await response.clone().json().catch(()=>null); return body?.error && !/hasn't returned any results/i.test(body.error)?{outcome:'http-error',errorCode:'SERPAPI_ERROR'}:{}; } });
  } catch (e) {
    throw new ApiError(`Could not reach SerpApi: ${e.message}`, 502, 'SERPAPI_UNREACHABLE');
  }
  if (r.status === 401) throw new ApiError('SerpApi rejected the API key. Check it under Data & System.', 401, 'SERPAPI_AUTH');
  if (r.status === 429) throw new ApiError('SerpApi monthly search limit reached.', 429, 'SERPAPI_LIMIT');
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) {
    // SerpApi reports "no results" as an error string; treat it as an empty result.
    if (/hasn't returned any results/i.test(body.error || '')) return { fares: [], insights: null, url: googleFlightsUrl({ origins, destinations, departDate, returnDate, cabin }), calls: 1 };
    throw new ApiError(`SerpApi: ${body.error || `HTTP ${r.status}`}`, 502, 'SERPAPI_ERROR');
  }
  const fares = [...(body.best_flights || []), ...(body.other_flights || [])].map(mapItinerary).filter(Boolean)
    .map(f => ({ ...f, departDate, returnDate, cabin, pricing: { requestedAdults: adults, queriedAdults: adults, amount: f.price, currency: 'USD', amountBasis: 'unknown', estimated: false, source: 'google', quotedAt: new Date().toISOString(), completeItinerary: !returnDate } }))
    .sort((a, b) => a.price - b.price);
  const pi = body.price_insights;
  const insights = pi ? {
    lowestPrice: Number(pi.lowest_price) || null,
    level: pi.price_level || null,                 // "low" | "typical" | "high"
    typicalRange: Array.isArray(pi.typical_price_range) ? pi.typical_price_range.map(Number) : null
  } : null;
  return { fares, insights, url: body.search_metadata?.google_flights_url || googleFlightsUrl({ origins, destinations, departDate, returnDate, cabin }), calls: 1 };
}

// Short repeat cache and in-flight coalescing, isolated by credentials, data directory and transport.
const requests = new Map();
const transports = new WeakMap();
let transportId = 0;
export async function googleFlights(params) {
  params = { ...params, adults: parseFiniteNumber(params.adults ?? 1, { min: 1, max: 9, integer: true, name: 'adults' }) };
  const transport = params.fetchImpl || fetch;
  if (!transports.has(transport)) transports.set(transport, ++transportId);
  const { fetchImpl: _fetchImpl, bypassCache, ...query } = params;
  const key = JSON.stringify([dataDir(), transports.get(transport), query]);
  const existing = requests.get(key);
  if (existing && (existing.pending || (!bypassCache && existing.until > Date.now()))) {
    return { ...structuredClone(await existing.promise), calls: 0 };
  }
  const entry = { pending: true, until: 0 };
  entry.promise = googleFlightsUncached(params).then(result => {
    entry.pending = false;
    entry.until = Date.now() + 60000;
    return structuredClone(result);
  }, error => { if (requests.get(key) === entry) requests.delete(key); throw error; });
  requests.set(key, entry);
  for (const [k, v] of requests) { if (!v.pending && (v.until <= Date.now() || requests.size > 100)) requests.delete(k); }
  return structuredClone(await entry.promise);
}
