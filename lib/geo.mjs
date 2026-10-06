// Airport / city / country lookups from reference/geo.json (see scripts/build-geo.mjs).
import { readFileSync } from 'node:fs';
import { referenceFile } from './paths.mjs';

const GEO = JSON.parse(readFileSync(referenceFile('geo.json'), 'utf8'));
const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

const CITY_AIRPORTS = new Map();   // city code -> [airport codes]
for (const [code, [city]] of Object.entries(GEO.airports)) {
  if (!CITY_AIRPORTS.has(city)) CITY_AIRPORTS.set(city, []);
  CITY_AIRPORTS.get(city).push(code);
}
const CITY_BY_NAME = new Map();    // normalized city name -> city code (largest city wins on ties)
for (const [code, [name]] of Object.entries(GEO.cities)) {
  const k = norm(name);
  if (!CITY_BY_NAME.has(k) || (CITY_AIRPORTS.get(code)?.length || 0) > (CITY_AIRPORTS.get(CITY_BY_NAME.get(k))?.length || 0)) CITY_BY_NAME.set(k, code);
}

/** Describe an airport or city code: { code, city, country, countryCode, label, tz }. */
export function describe(code) {
  const c = String(code || '').toUpperCase();
  const a = GEO.airports[c];
  const cityCode = a ? a[0] : c;
  const city = GEO.cities[cityCode];
  const countryCode = a?.[1] || city?.[1] || null;
  const country = countryCode ? GEO.countries[countryCode] || countryCode : null;
  const cityName = city?.[0] || null;
  return {
    code: c,
    city: cityName,
    country,
    countryCode,
    airportName: a?.[3] || null,
    tz: a?.[2] || city?.[2] || null,
    label: cityName ? `${cityName}${country ? `, ${country}` : ''}` : c
  };
}

export const timeZoneOf = code => describe(code).tz;
export const airlineName = code => GEO.airlines?.[String(code || '').toUpperCase()] || null;

/** Airports serving a city name ("Hanoi" -> ["HAN"]), or null. */
export function airportsForCityName(name) {
  const cityCode = CITY_BY_NAME.get(norm(name));
  return cityCode ? CITY_AIRPORTS.get(cityCode) || null : null;
}

/** Format a UTC ISO time in the airport's local time: { date: 'YYYY-MM-DD', time: 'HH:MM', label } */
export function localTime(isoUtc, airport) {
  const tz = timeZoneOf(airport) || 'UTC';
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, tz };
}
