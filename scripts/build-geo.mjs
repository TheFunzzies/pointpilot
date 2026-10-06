// Builds reference/geo.json — a compact airport/city/country table used for place names,
// city lookups and airport time zones. Source: Travelpayouts public data files (no token).
// Run occasionally: `npm run build:geo`
import { writeFileSync } from 'node:fs';

const get = async name => (await fetch(`https://api.travelpayouts.com/data/en/${name}.json`)).json();
const [airports, cities, countries, airlines] = await Promise.all([get('airports'), get('cities'), get('countries'), get('airlines')]);

const en = x => x.name_translations?.en || x.name;
const out = { source: 'https://api.travelpayouts.com/data/en/', built: new Date().toISOString().slice(0, 10), countries: {}, cities: {}, airports: {} };
for (const c of countries) out.countries[c.code] = en(c);
for (const c of cities) if (c.has_flightable_airport && c.code) out.cities[c.code] = [en(c), c.country_code, c.time_zone];
for (const a of airports) {
  if (!a.flightable || a.iata_type !== 'airport' || !a.code) continue;
  out.airports[a.code] = [a.city_code, a.country_code, a.time_zone, en(a)];
}
out.airlines = {};
for (const a of airlines) if (a.code && /^[A-Z0-9]{2}$/.test(a.code) && a.is_lowcost != null && en(a)) out.airlines[a.code] = en(a);
writeFileSync(new URL('../reference/geo.json', import.meta.url), JSON.stringify(out));
console.log(`geo.json: ${Object.keys(out.airports).length} airports, ${Object.keys(out.cities).length} cities, ${Object.keys(out.countries).length} countries`);
