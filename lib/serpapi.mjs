// SerpApi Google Flights — live Google Flights prices plus Google's "price insights"
// (low / typical / high). Free plan: 250 searches/month. Docs: https://serpapi.com/google-flights-api
// We always query one adult and multiply ourselves, so prices are unambiguous.
import { ApiError } from './seatsaero.mjs';

const TRAVEL_CLASS = { economy: 1, premium: 2, business: 3, first: 4 };

export function googleFlightsUrl({ origins, destinations, departDate, returnDate, cabin }) {
  const q = `Flights from ${origins.join(',')} to ${destinations.join(',')} on ${departDate}${returnDate ? ` through ${returnDate}` : ' one way'}${cabin && cabin !== 'economy' ? ` ${cabin} class` : ''}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function mapItinerary(it) {
  const legs = Array.isArray(it?.flights) ? it.flights : [];
  if (!(Number(it?.price) > 0) || !legs.length) return null;
  return {
    source: 'google',
    origin: legs[0].departure_airport?.id || null,
    destination: legs[legs.length - 1].arrival_airport?.id || null,
    departTime: legs[0].departure_airport?.time || null,
    arriveTime: legs[legs.length - 1].arrival_airport?.time || null,
    price: Number(it.price),                       // USD, one adult (round-trip total when type=1)
    airlines: [...new Set(legs.map(f => f.airline).filter(Boolean))].join(', '),
    flightNumbers: legs.map(f => f.flight_number).filter(Boolean).join(' / '),
    stops: legs.length - 1,
    durationMin: Number(it.total_duration) || null,
    live: true
  };
}

/** One Google Flights search. Returns { fares, insights, url, calls: 1 }. */
export async function googleFlights({ apiKey, origins, destinations, departDate, returnDate = null, cabin = 'economy', nonstop = false, fetchImpl = fetch }) {
  if (!apiKey) throw new ApiError('No SerpApi key configured.', 400, 'NO_SERPAPI_KEY');
  const q = new URLSearchParams({
    engine: 'google_flights', api_key: apiKey, hl: 'en', gl: 'us', currency: 'USD',
    departure_id: origins.join(','), arrival_id: destinations.join(','),
    outbound_date: departDate, type: returnDate ? '1' : '2', travel_class: String(TRAVEL_CLASS[cabin] || 1), adults: '1'
  });
  if (returnDate) q.set('return_date', returnDate);
  if (nonstop) q.set('stops', '1');
  let r;
  try {
    r = await fetchImpl(`https://serpapi.com/search.json?${q}`, { signal: AbortSignal.timeout(60000) });
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
    .map(f => ({ ...f, departDate, returnDate }))
    .sort((a, b) => a.price - b.price);
  const pi = body.price_insights;
  const insights = pi ? {
    lowestPrice: Number(pi.lowest_price) || null,
    level: pi.price_level || null,                 // "low" | "typical" | "high"
    typicalRange: Array.isArray(pi.typical_price_range) ? pi.typical_price_range.map(Number) : null
  } : null;
  return { fares, insights, url: body.search_metadata?.google_flights_url || googleFlightsUrl({ origins, destinations, departDate, returnDate, cabin }), calls: 1 };
}
