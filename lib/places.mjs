import { readFileSync } from 'node:fs';
import { referenceFile } from './paths.mjs';
import { describe, airportsForCityName, airportsForCountryName, geoTables } from './geo.mjs';

const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

const PLACE_TABLE = JSON.parse(readFileSync(referenceFile('destinations.json'), 'utf8')).places;
const PLACES = new Map(Object.entries(PLACE_TABLE).map(([name, codes]) => [norm(name), codes]));
const PLACE_LABELS = new Map(Object.keys(PLACE_TABLE).map(name => [norm(name), name]));

// Larger countries (US, Russia, China…) need a curated list or specific cities, not every airport.
const MAX_COUNTRY_AIRPORTS = 25;

export class PlaceError extends Error {
  constructor(message) { super(message); this.code = 'UNKNOWN_PLACE'; this.status = 400; }
}

/**
 * Resolve "Thailand", "BKK", "Tokyo, BKK" or "JFK,EWR" to a de-duplicated list of airport codes.
 * Unknown names are an error — never silently substitute a different destination.
 */
export function resolveAirports(input) {
  const parts = String(input ?? '').split(/[,;/]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new PlaceError('Enter at least one airport code or place name.');
  const codes = new Set();
  for (const part of parts) {
    const place = PLACES.get(norm(part));
    if (place) { place.forEach(c => codes.add(c)); continue; }
    if (/^[A-Za-z]{3}$/.test(part)) {
      const code = part.toUpperCase();
      // A metro code (TYO, LON, NYC) that isn't itself an airport expands to its airports.
      const d = describe(code);
      const metro = !d.airportName && d.city ? airportsForCityName(d.city) : null;
      (metro || [code]).forEach(c => codes.add(c));
      continue;
    }
    const cityAirports = airportsForCityName(part);
    if (cityAirports) { cityAirports.forEach(c => codes.add(c)); continue; }
    const countryAirports = airportsForCountryName(part);
    if (countryAirports && countryAirports.length <= MAX_COUNTRY_AIRPORTS) { countryAirports.forEach(c => codes.add(c)); continue; }
    throw new PlaceError(`"${part}" isn't a known place. Use 3-letter airport codes (e.g. LIS) or a listed city/country.`);
  }
  return [...codes];
}

export function knownPlaces() { return [...PLACES.keys()]; }

const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase());
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Autocomplete for a place field. The last comma-separated token of `input` is matched against
 * countries, cities, and airports. "All airports" entries come first; their `value` always
 * resolves through resolveAirports() to exactly the airports listed in `detail`.
 * Returns [{ kind: 'all'|'airport', code, value, detail }].
 */
export function suggestPlaces(input, limit = 8) {
  const token = String(input ?? '').split(/[,;/]+/).pop().trim();
  const q = norm(token);
  if (q.length < 2) return [];
  const { airports, cities, countries, cityAirports } = geoTables();
  const groups = new Map(); // normalized value -> suggestion; curated places are added first and win
  const claimed = new Set(); // names already settled by an earlier (higher-priority) source, even single-airport ones
  const addGroup = (key, value, code, where, codes, score) => {
    const k = norm(key);
    if (claimed.has(k)) return;
    claimed.add(k);
    if (codes.length < 2) return;
    groups.set(k, { score, kind: 'all', code, value, detail: `${where} – all airports (${codes.length > 6 ? plural(codes.length, 'airport') : codes.join(', ')})` });
  };

  for (const [name, codes] of PLACES) {
    if (!name.startsWith(q)) continue;
    const label = titleCase(PLACE_LABELS.get(name) || name);
    addGroup(name, label, label.length === 3 ? label.toUpperCase() : codes[0], label, codes, 0);
  }
  for (const [countryCode, name] of Object.entries(countries)) {
    const codes = airportsForCountryName(name) || [];
    if (norm(name).startsWith(q) && codes.length <= MAX_COUNTRY_AIRPORTS) addGroup(name, name, countryCode, name, codes, 0);
  }
  for (const [cityCode, [name, countryCode]] of Object.entries(cities)) {
    if (!norm(name).startsWith(q)) continue;
    const codes = cityAirports.get(cityCode) || [];
    addGroup(name, airports[cityCode] ? name : cityCode, cityCode, `${name}, ${countries[countryCode] || countryCode}`, codes, 1);
  }
  const single = [];
  for (const [code, [cityCode, countryCode, , airportName]] of Object.entries(airports)) {
    const city = cities[cityCode]?.[0] || '';
    const score = code.toLowerCase() === q ? 0 : code.toLowerCase().startsWith(q) ? 1 : norm(airportName).startsWith(q) || norm(city).startsWith(q) ? 2 : norm(`${airportName || ''} ${city}`).includes(q) ? 3 : null;
    if (score != null) single.push({ score, kind: 'airport', code, value: code, detail: `${airportName || code}${city ? ` – ${city}` : ''}, ${countries[countryCode] || countryCode}` });
  }
  const bigger = [...groups.values()].sort((a, b) => a.score - b.score || a.value.localeCompare(b.value));
  single.sort((a, b) => a.score - b.score || a.code.localeCompare(b.code));
  return [...bigger.slice(0, Math.min(4, limit)), ...single].slice(0, limit).map(s => ({ kind: s.kind, code: s.code, value: s.value, detail: s.detail }));
}
