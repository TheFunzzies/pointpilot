// Hotel quality signals: star class + Google rating/reviews (SerpApi Google Hotels, cached 60 days)
// and distinctions such as MICHELIN Keys (reference/hotel-awards.json, refreshed weekly).
import { readFileSync } from 'node:fs';
import { dataFile, referenceFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { getSettings, recordApiCalls } from './settings.mjs';
import { ApiError } from './errors.mjs';

const FILE = () => dataFile('hotel-info.json');
const TTL = 60 * 86400000;
const STOP = new Set(['the', 'hotel', 'hotels', 'resort', 'resorts', 'and', 'a', 'an', 'by', 'spa', 'de', 'la', 'le', 'les', 'el', 'at', 'of', 'collection', 'hôtel']);
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = s => new Set(norm(s).split(' ').filter(t => t && !STOP.has(t)));
export const hotelKey = (name, city) => `${norm(name)}|${norm(city)}`;

function sameName(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  const shared = [...A].filter(t => B.has(t)).length;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return shared === small.size && small.size >= 2 && shared / big.size >= 0.5;
}

// ---------- MICHELIN Keys ----------
let AWARDS = [];
try { AWARDS = JSON.parse(readFileSync(referenceFile('hotel-awards.json'), 'utf8')).hotels || []; } catch { AWARDS = []; }

/** Distinctions for a hotel: [{ type, keys, label, url }] */
export function awardsFor({ name, location = '', city = '' }) {
  const place = norm(`${location} ${city}`);
  const hits = AWARDS.filter(h => {
    if (!sameName(name, h.name)) return false;
    // City check: the award's city (e.g. "California (Beverly Hills)") should appear in our location.
    const cityTokens = norm(String(h.city || '').replace(/[()]/g, ' ')).split(' ').filter(t => t.length > 2);
    return !cityTokens.length || cityTokens.some(t => place.includes(t) || norm(name).includes(t)) || norm(h.country).split(' ').some(t => t.length > 3 && place.includes(t));
  });
  const best = hits.sort((a, b) => b.keys - a.keys)[0];
  return best ? [{ type: 'michelin-keys', keys: best.keys, label: `MICHELIN ${best.keys} Key${best.keys > 1 ? 's' : ''}`, url: `https://www.google.com/search?q=${encodeURIComponent(`${best.name} MICHELIN Key`)}` }] : [];
}

/** Links to read reviews / check other distinctions for a hotel. */
export function reviewLinks({ name, location = '' }) {
  const q = encodeURIComponent(`${name} ${location}`.trim());
  return {
    google: `https://www.google.com/travel/search?q=${q}`,
    tripadvisor: `https://www.tripadvisor.com/Search?q=${q}`,
    forbes: `https://www.google.com/search?q=${encodeURIComponent(`site:forbestravelguide.com ${name}`)}`,
    michelin: `https://www.google.com/search?q=${encodeURIComponent(`site:guide.michelin.com ${name}`)}`
  };
}

// ---------- star class + Google rating (SerpApi Google Hotels) ----------
const BRAND_QUERY = { hyatt: 'Hyatt', marriott: 'Marriott', hilton: 'Hilton', ihg: 'IHG', choice: 'Choice Hotels', wyndham: 'Wyndham', accor: 'Accor', iprefer: 'Preferred Hotels' };

export function parseProperty(p) {
  const stars = Number(p.extracted_hotel_class) || Number(String(p.hotel_class || '').match(/(\d)\s*-?\s*star/i)?.[1]) || null;
  return {
    googleName: p.name || null,
    stars,
    rating: Number(p.overall_rating) || null,
    reviews: Number(p.reviews) || null,
    website: /^https:\/\//i.test(String(p.link || '')) ? p.link : null,
    lat: Number(p.gps_coordinates?.latitude) || null,
    lng: Number(p.gps_coordinates?.longitude) || null
  };
}

const km = (a, b, c, d) => { const R = 6371, r = x => (x * Math.PI) / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

/** Match a Google property to one of our hotels: by distance when both have coordinates, else by name. */
export function matchProperty(prop, hotels) {
  let best = null;
  for (const h of hotels) {
    const close = h.latitude != null && prop.lat != null ? km(h.latitude, h.longitude, prop.lat, prop.lng) : null;
    const named = sameName(h.name, prop.googleName);
    if ((close != null && close < 0.35 && (named || close < 0.12)) || (close == null && named)) {
      if (!best || (close ?? 1) < (best.close ?? 1)) best = { hotel: h, close };
    }
  }
  return best?.hotel || null;
}

async function googleHotels(apiKey, q, checkIn, checkOut) {
  const params = new URLSearchParams({ engine: 'google_hotels', q, check_in_date: checkIn, check_out_date: checkOut, currency: 'USD', gl: 'us', hl: 'en', adults: '2', api_key: apiKey });
  const r = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) });
  if (r.status === 401) throw new ApiError('SerpApi rejected the API key.', 401, 'SERPAPI_AUTH');
  if (r.status === 429) throw new ApiError('SerpApi monthly search limit reached.', 429, 'SERPAPI_LIMIT');
  const body = await r.json().catch(() => ({}));
  if (body.error && !/hasn't returned any results/i.test(body.error)) throw new ApiError(`SerpApi: ${body.error}`, 502, 'SERPAPI_ERROR');
  return (body.properties || []).filter(p => !p.type || /hotel/i.test(p.type)).map(parseProperty);
}

/** Cached info for hotels (no API calls). */
export async function cachedInfo(hotels) {
  const store = await readJson(FILE(), { hotels: {} });
  const out = {};
  for (const h of hotels) { const k = hotelKey(h.name, h.city); const v = store.hotels[k]; if (v && Date.now() - v.at < TTL) out[k] = v; }
  return out;
}

/**
 * Look up star class and Google rating for hotels in one city.
 * mode 'program': one Google Hotels search per loyalty program present (e.g. "Hyatt hotels in Tokyo").
 * mode 'single': one search for a specific hotel name.
 */
export async function enrichHotels({ hotels = [], city, checkIn, checkOut, mode = 'program' }) {
  const settings = await getSettings();
  if (!settings.serpApiKey) throw Object.assign(new Error('Add a SerpApi key under Data & System to load star ratings and reviews.'), { status: 400 });
  const store = await readJson(FILE(), { hotels: {}, queries: {} });
  const fresh = await cachedInfo(hotels);
  const todo = hotels.filter(h => !fresh[hotelKey(h.name, h.city)]).slice(0, 40);
  const queries = mode === 'single'
    ? todo.slice(0, 1).map(h => `${h.name} ${h.city || city}`)
    : [...new Set(todo.map(h => BRAND_QUERY[h.program]).filter(Boolean))].slice(0, 4).map(b => `${b} hotels in ${city}`).filter(q => !(store.queries?.[q] && Date.now() - store.queries[q] < TTL));
  let calls = 0;
  const found = {};
  for (const q of queries) {
    const props = await googleHotels(settings.serpApiKey, q, checkIn, checkOut);
    calls++;
    for (const p of props) {
      const h = matchProperty(p, todo);
      if (h) found[hotelKey(h.name, h.city)] = { ...p, at: Date.now() };
    }
    found[`__query__${q}`] = Date.now();
  }
  await recordApiCalls(calls, 'serp');
  await updateJson(FILE(), { hotels: {}, queries: {} }, s => {
    s.queries ||= {};
    for (const [k, v] of Object.entries(found)) { if (k.startsWith('__query__')) s.queries[k.slice(9)] = v; else s.hotels[k] = v; }
  });
  return { info: { ...fresh, ...Object.fromEntries(Object.entries(found).filter(([k]) => !k.startsWith('__query__'))) }, calls, unmatched: todo.filter(h => !found[hotelKey(h.name, h.city)]).map(h => h.name) };
}
