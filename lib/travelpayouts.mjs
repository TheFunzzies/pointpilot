// Travelpayouts (Aviasales) Data API — free with a Travelpayouts partner token.
// Prices are the cheapest fares Aviasales users found in roughly the last 48 hours (cached, not
// live), for one adult, mostly economy. Docs: https://support.travelpayouts.com (Aviasales Data API)
import { ApiError } from './seatsaero.mjs';

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
    r = await fetchImpl(`${BASE}${path}?${q}`, { headers: { 'X-Access-Token': token, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
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
  return {
    source: 'travelpayouts',
    origin: String(f.origin_airport || f.origin || '').toUpperCase(),
    destination: String(f.destination_airport || f.destination || '').toUpperCase(),
    departDate: String(f.departure_at || '').slice(0, 10),
    returnDate: f.return_at ? String(f.return_at).slice(0, 10) : null,
    price: Number(f.price),                      // USD, one adult, whole trip (round trip if returnDate)
    airline: f.airline || null,
    flightNumber: f.flight_number ? `${f.airline || ''}${f.flight_number}` : null,
    stops: Number.isFinite(Number(f.transfers)) ? Number(f.transfers) : null,
    returnStops: Number.isFinite(Number(f.return_transfers)) ? Number(f.return_transfers) : null,
    durationMin: Number(f.duration) || null,
    link: aviasalesLink(f.link),
    live: false
  };
}

/**
 * Cheapest cached fares for a route. `departAt`/`returnAt` may be YYYY-MM-DD or YYYY-MM.
 * Tries airport codes first, then metro codes (NYC, LON…) when nothing comes back.
 */
export async function routeFares({ token, origin, destination, departAt, returnAt = null, direct = false, fetchImpl = fetch }) {
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

/** Cheapest recent fares from one origin to anywhere (round trips by default). */
export async function faresFromOrigin({ token, origin, oneWay = false, fetchImpl = fetch }) {
  let calls = 0;
  for (const o of [...new Set([origin, metroCode(origin)])]) {
    calls++;
    const body = await call('/v2/prices/latest', { origin: o, period_type: 'year', one_way: String(oneWay), sorting: 'price', limit: '100', page: '1', show_to_affiliates: 'true', trip_class: '0' }, token, fetchImpl);
    const fares = (body.data || []).filter(x => Number(x.value) > 0 && x.destination).map(x => ({
      source: 'travelpayouts',
      origin: String(x.origin || o).toUpperCase(),
      destination: String(x.destination).toUpperCase(),
      departDate: String(x.depart_date || '').slice(0, 10),
      returnDate: x.return_date ? String(x.return_date).slice(0, 10) : null,
      price: Number(x.value),
      stops: Number.isFinite(Number(x.number_of_changes)) ? Number(x.number_of_changes) : null,
      foundAt: x.found_at || null,
      live: false
    }));
    if (fares.length) return { fares, calls, queriedOrigin: o };
  }
  return { fares: [], calls, queriedOrigin: origin };
}
