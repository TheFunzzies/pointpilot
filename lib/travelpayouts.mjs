import { recordApiCalls } from './settings.mjs';
import { dataDir } from './paths.mjs';
// Travelpayouts (Aviasales) Data API — free with a Travelpayouts partner token.
// Prices are the cheapest fares Aviasales users found in roughly the last 48 hours (cached, not
// live), for one adult, mostly economy. Docs: https://support.travelpayouts.com (Aviasales Data API)
import { ApiError } from './errors.mjs';
import { observeRequest } from './request-observer.mjs';

const BASE = 'https://api.travelpayouts.com';

// Aviasales often indexes by metro/city code rather than airport.
const METRO = {
  JFK: 'NYC', EWR: 'NYC', LGA: 'NYC', ORD: 'CHI', MDW: 'CHI', IAD: 'WAS', DCA: 'WAS', BWI: 'WAS',
  IAH: 'HOU', HOU: 'HOU', DAL: 'DFW', LHR: 'LON', LGW: 'LON', LCY: 'LON', STN: 'LON', LTN: 'LON',
  CDG: 'PAR', ORY: 'PAR', NRT: 'TYO', HND: 'TYO', KIX: 'OSA', ITM: 'OSA', ICN: 'SEL', GMP: 'SEL',
  DMK: 'BKK', MXP: 'MIL', LIN: 'MIL', FCO: 'ROM', ARN: 'STO', YYZ: 'YTO', YUL: 'YMQ', PEK: 'BJS',
  PKX: 'BJS', PVG: 'SHA', GRU: 'SAO', GIG: 'RIO', EZE: 'BUE', AEP: 'BUE', SAW: 'IST', OAK: 'SFO', SJC: 'SFO', FLL: 'MIA'
};
export const metroCode = code => METRO[code] || code;

async function call(path, params, token, fetchImpl) {
  if (!token) throw new ApiError('No Travelpayouts token configured.', 400, 'NO_TP_TOKEN');
  const q = new URLSearchParams({ currency: 'usd', market: 'us', ...params });
  let r;
  try {
    await recordApiCalls(1, 'travelpayouts');
    r = await observeRequest({service:'travelpayouts',operation:path.includes('prices_for_dates')?'travelpayouts.prices':'travelpayouts.latest',method:'GET'}, () => fetchImpl(`${BASE}${path}?${q}`, { headers: { 'X-Access-Token': token, accept: 'application/json' }, signal: AbortSignal.timeout(20000) }), { classify:async response => { const body=await response.clone().json().catch(()=>null); return !body||body.success===false?{outcome:'http-error',errorCode:'TP_ERROR'}:{}; } });
  } catch (e) {
    throw new ApiError(`Could not reach Travelpayouts: ${e.message}`, 502, 'TP_UNREACHABLE');
  }
  if (r.status === 401 || r.status === 403) throw new ApiError('Travelpayouts rejected the token. Check it under Data & System.', 401, 'TP_AUTH');
  if (r.status === 429) throw new ApiError('Travelpayouts rate limit reached; try again in a minute.', 429, 'TP_RATE_LIMIT');
  if (!r.ok) throw new ApiError(`Travelpayouts returned HTTP ${r.status}.`, 502, 'TP_ERROR');
  const body = await r.json();
  if (body && body.success === false) throw new ApiError(`Travelpayouts error: ${body.error || 'request failed'}`, 502, 'TP_ERROR');
  return body;
}

const aviasalesLink = link => (link ? `https://www.aviasales.com${String(link).startsWith('/') ? '' : '/'}${link}` : null);

/** Map one /aviasales/v3/prices_for_dates record. */
export function mapFare(f, currency = 'usd') {
  if (!(Number(f?.price) > 0)) return null;
  if (String(currency).toLowerCase() !== 'usd') return null;
  // departure_at carries the local time with its UTC offset, e.g. 2027-03-05T10:00:00-05:00.
  const depMs = Date.parse(f.departure_at || '');
  const outMin = Number(f.duration_to) || (f.return_at ? null : Number(f.duration)) || null;
  return {
    departTime: /T\d{2}:\d{2}/.test(f.departure_at || '') ? String(f.departure_at).slice(11, 16) : null,
    departUtc: Number.isFinite(depMs) ? new Date(depMs).toISOString() : null,
    arriveUtc: Number.isFinite(depMs) && outMin ? new Date(depMs + outMin * 60000).toISOString() : null,
    source: 'travelpayouts',
    origin: String(f.origin_airport || f.origin || '').toUpperCase(),
    destination: String(f.destination_airport || f.destination || '').toUpperCase(),
    departDate: String(f.departure_at || '').slice(0, 10),
    returnDate: f.return_at ? String(f.return_at).slice(0, 10) : null,
    pricing: { requestedAdults: 1, queriedAdults: 1, amount: Number(f.price), currency: 'USD', amountBasis: 'per-adult', estimated: false, source: 'travelpayouts', quotedAt: new Date().toISOString(), completeItinerary: true },
    price: Number(f.price),                      // USD, one adult, whole trip (round trip if returnDate)
    airline: f.airline || null,
    flightNumber: f.flight_number ? `${f.airline || ''}${f.flight_number}` : null,
    stops: f.transfers != null && Number.isFinite(Number(f.transfers)) ? Number(f.transfers) : null,
    returnStops: f.return_transfers != null && Number.isFinite(Number(f.return_transfers)) ? Number(f.return_transfers) : null,
    durationMin: Number(f.duration) || null,
    link: aviasalesLink(f.link),
    cabin: 'economy',
    live: false
  };
}

/**
 * Cheapest cached fares for a route. `departAt`/`returnAt` may be YYYY-MM-DD or YYYY-MM.
 * Tries airport codes first, then metro codes (NYC, LON…) when nothing comes back.
 */
async function routeFaresUncached({ token, origin, destination, departAt, returnAt = null, direct = false, fetchImpl = fetch }) {
  let calls = 0;
  for (const [o, d] of [[origin, destination], [metroCode(origin), metroCode(destination)]]) {
    if (calls && o === origin && d === destination) break;
    const params = { origin: o, destination: d, departure_at: departAt, one_way: String(!returnAt), direct: String(direct), sorting: 'price', unique: 'false', limit: '100', page: '1' };
    if (returnAt) params.return_at = returnAt;
    calls++;
    const body = await call('/aviasales/v3/prices_for_dates', params, token, fetchImpl);
    const fares = (body.data || []).map(f => mapFare(f, body.currency || 'usd')).filter(Boolean);
    if (fares.length) return { fares, calls };
  }
  return { fares: [], calls };
}

const TRIP_CLASS = { economy: 0, business: 1, first: 2 };

/** Cheapest recent fares from one origin to anywhere (round trips by default) for a cabin. */
export async function faresFromOrigin({ token, origin, oneWay = false, cabin = 'economy', destination = null, fetchImpl = fetch }) {
  let calls = 0;
  for (const o of [...new Set([origin, metroCode(origin)])]) {
    calls++;
    const params = { origin: o, period_type: 'year', one_way: String(oneWay), sorting: 'price', limit: '100', page: '1', show_to_affiliates: 'true', trip_class: String(TRIP_CLASS[cabin] ?? 0) };
    if (destination) params.destination = destination;
    const body = await call('/v2/prices/latest', params, token, fetchImpl);
    const fares = (body.data || []).filter(x => Number(x.value) > 0 && x.destination).map(x => ({
      source: 'travelpayouts',
      origin: String(x.origin || o).toUpperCase(),
      destination: String(x.destination).toUpperCase(),
      departDate: String(x.depart_date || '').slice(0, 10),
      returnDate: x.return_date ? String(x.return_date).slice(0, 10) : null,
      pricing: { requestedAdults: 1, queriedAdults: 1, amount: Number(x.value), currency: 'USD', amountBasis: 'per-adult', estimated: false, source: 'travelpayouts', quotedAt: new Date().toISOString(), completeItinerary: true },
      price: Number(x.value),
      stops: Number.isFinite(Number(x.number_of_changes)) ? Number(x.number_of_changes) : null,
      foundAt: x.found_at || null,
      cabin,
      live: false
    }));
    if (fares.length) return { fares, calls, queriedOrigin: o };
  }
  return { fares: [], calls, queriedOrigin: origin };
}

// Short repeat cache and in-flight coalescing, isolated by credentials, data directory and transport.
const requests = new Map();
const transports = new WeakMap();
let transportId = 0;
export async function routeFares(params) {
  const transport = params.fetchImpl || fetch;
  if (!transports.has(transport)) transports.set(transport, ++transportId);
  const { fetchImpl: _fetchImpl, bypassCache, ...query } = params;
  const key = JSON.stringify([dataDir(), transports.get(transport), query]);
  const existing = requests.get(key);
  if (existing && (existing.pending || (!bypassCache && existing.until > Date.now()))) {
    return { ...structuredClone(await existing.promise), calls: 0 };
  }
  const entry = { pending: true, until: 0 };
  entry.promise = routeFaresUncached(params).then(result => {
    entry.pending = false;
    entry.until = Date.now() + 60000;
    return structuredClone(result);
  }, error => { if (requests.get(key) === entry) requests.delete(key); throw error; });
  requests.set(key, entry);
  for (const [k, v] of requests) { if (!v.pending && (v.until <= Date.now() || requests.size > 100)) requests.delete(k); }
  return structuredClone(await entry.promise);
}
