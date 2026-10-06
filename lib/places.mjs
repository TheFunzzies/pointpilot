import { readFileSync } from 'node:fs';
import { referenceFile } from './paths.mjs';
import { describe, airportsForCityName } from './geo.mjs';

const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

const PLACES = new Map(
  Object.entries(JSON.parse(readFileSync(referenceFile('destinations.json'), 'utf8')).places)
    .map(([name, codes]) => [norm(name), codes])
);

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
    throw new PlaceError(`"${part}" isn't a known place. Use 3-letter airport codes (e.g. LIS) or a listed city/country.`);
  }
  return [...codes];
}

export function knownPlaces() { return [...PLACES.keys()]; }
