// Explore: "where can my points take me in this window?"
// Award space for a curated set of destinations is fetched region by region (one seats.aero query
// per direction per region), then every destination is funded from the wallet and ranked.
import { findTrip, normalizeFinderQuery } from './finder.mjs';
import { refreshFromApi } from './search.mjs';
import { getSettings } from './settings.mjs';
import { describe, cityCodeOf } from './geo.mjs';
import { mapLimit } from './util.mjs';
import { ApiError } from './errors.mjs';

export const EXPLORE_REGIONS = Object.freeze({
  europe: { label: 'Europe', airports: ['LHR', 'CDG', 'AMS', 'MAD', 'BCN', 'LIS', 'FCO', 'MXP', 'DUB', 'FRA', 'MUC', 'ZRH', 'ATH', 'CPH', 'KEF', 'IST'] },
  asia: { label: 'Asia', airports: ['NRT', 'HND', 'KIX', 'ICN', 'TPE', 'HKG', 'BKK', 'SIN', 'SGN', 'MNL', 'DPS', 'DEL'] },
  caribbean: { label: 'Caribbean & Mexico', airports: ['CUN', 'SJD', 'PVR', 'MEX', 'PUJ', 'SJU', 'MBJ', 'NAS', 'AUA', 'SXM', 'LIR', 'SJO', 'PTY'] },
  southamerica: { label: 'South America', airports: ['BOG', 'LIM', 'GRU', 'GIG', 'EZE', 'SCL', 'UIO', 'CTG'] },
  pacific: { label: 'Hawaii & South Pacific', airports: ['HNL', 'OGG', 'KOA', 'LIH', 'SYD', 'MEL', 'AKL', 'NAN', 'PPT'] },
  mideastafrica: { label: 'Middle East & Africa', airports: ['DXB', 'DOH', 'AUH', 'TLV', 'CAI', 'CMN', 'JNB', 'CPT', 'NBO', 'MLE'] },
  northamerica: { label: 'US & Canada', airports: ['LAX', 'SFO', 'SEA', 'LAS', 'DEN', 'ORD', 'MIA', 'MCO', 'JFK', 'BOS', 'AUS', 'MSY', 'YVR', 'YYZ', 'ANC'] }
});

const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

/**
 * input: finder fields without a destination, plus region ('anywhere' or a key of EXPLORE_REGIONS).
 * Returns destinations the wallet can fund, cheapest effective cost first.
 */
export async function exploreDestinations(input, { allowApi = true } = {}) {
  const started = Date.now();
  const region = input?.region && input.region !== 'anywhere' ? String(input.region) : 'anywhere';
  if (region !== 'anywhere' && !EXPLORE_REGIONS[region]) throw new ApiError('Unknown region.', 400, 'INVALID_INPUT');
  const settings = await getSettings();
  const { region: _region, ...rest } = input || {};
  const q = normalizeFinderQuery({ ...rest, destination: 'LHR' }, { homeAirports: settings.homeAirports });
  const homeCities = new Set(q.origins.map(cityCodeOf));
  const regions = (region === 'anywhere' ? Object.keys(EXPLORE_REGIONS) : [region]).map(key => ({ key, airports: EXPLORE_REGIONS[key].airports.filter(a => !homeCities.has(cityCodeOf(a))) })).filter(r => r.airports.length);
  const rt = q.tripType === 'round-trip';
  const status = { api: 'skipped', warnings: [] };

  // One award query per direction per region fills the local cache for every destination in it.
  if (allowApi && settings.seatsAeroApiKey) {
    const jobs = regions.flatMap(r => [
      { origins: q.origins, destinations: r.airports, start: q.earliest, end: rt ? shift(q.latest, -q.minNights) : q.latest, cabin: q.cabin },
      ...(rt ? [{ origins: r.airports, destinations: q.origins, start: shift(q.earliest, q.minNights), end: q.latest, cabin: q.cabin }] : [])
    ]);
    await mapLimit(jobs, 4, job => refreshFromApi(job, settings, status));
  } else if (!settings.seatsAeroApiKey) status.api = 'not-configured';

  // Group airports into cities (NRT + HND = Tokyo) and evaluate each from the cache.
  const cities = new Map();
  for (const r of regions) for (const a of r.airports) {
    const key = cityCodeOf(a);
    if (!cities.has(key)) cities.set(key, { region: r.key, airports: [] });
    cities.get(key).airports.push(a);
  }
  const base = { origins: q.originsText, earliest: q.earliest, latest: q.latest, tripType: q.tripType, ...(rt ? { nights: q.nights, nightsFlex: q.nightsFlex } : {}), cabin: q.cabin, travelers: q.travelers, nonstopOnly: q.nonstopOnly };
  const found = (await mapLimit([...cities.values()], 6, async c => {
    try {
      const r = await findTrip({ ...base, destination: c.airports.join(',') }, { allowApi: false, allowGoogle: false, cash: false });
      const best = r.options.find(o => o.type === 'points');
      if (!best) return r.counts.outbound + r.counts.return > 0 ? { unfunded: true } : null;
      const d = describe(c.airports[0]);
      return { destination: c.airports.join(','), label: d.label, city: d.city || c.airports[0], country: d.country, region: c.region, regionLabel: EXPLORE_REGIONS[c.region].label,
        depart: best.depart, return: best.return, points: best.points, feesUsd: best.outOfPocketUsd, effectiveCostUsd: best.effectiveCostUsd,
        programs: [...new Set(best.legs.map(l => l.programName))], nonstop: best.legs.every(l => l.direct === true), plan: best.plan, cashUsd: null, cpp: null };
    } catch { return null; }
  })).filter(Boolean);
  const results = found.filter(x => !x.unfunded).sort((a, b) => a.effectiveCostUsd - b.effectiveCostUsd);

  // Cash comparison (free cached fares) for the leading candidates, to show cents per point.
  if (q.cabin === 'economy' && settings.travelpayoutsToken) {
    await mapLimit(results.slice(0, 8), 4, async x => {
      try {
        const r = await findTrip({ ...base, destination: x.destination }, { allowApi: false, allowGoogle: false });
        const cash = r.options.find(o => o.type === 'cash');
        if (cash) { x.cashUsd = cash.cashUsd; x.cpp = x.points > 0 ? Math.round(((cash.cashUsd - x.feesUsd) / x.points) * 1000) / 10 : null; }
      } catch { /* cash comparison is optional */ }
    });
  }
  return {
    query: { originsText: q.originsText, earliest: q.earliest, latest: q.latest, tripType: q.tripType, nights: q.nights, cabin: q.cabin, travelers: q.travelers, region },
    regions: Object.entries(EXPLORE_REGIONS).map(([key, r]) => ({ key, label: r.label })),
    results, searched: cities.size, unfunded: found.filter(x => x.unfunded).length,
    dataStatus: status, tookMs: Date.now() - started
  };
}
