// Hotel finder: the best way to pay for a stay — points, points for some nights + cash for the
// rest, or cash. Award rooms come from rooms.aero (via searchHotels); cash prices come from the
// award data when it carries them and from one Google Hotels search for the city.
import { searchHotels } from './search.mjs';
import { fundPrograms, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { getSettings, loadUser, apiUsage, recordApiCalls } from './settings.mjs';
import { observeRequest } from './request-observer.mjs';
import { getProviderSearch, providerCacheKey, saveProviderSearch } from './provider-search-cache.mjs';
import { valueCents } from './opportunities.mjs';
import { playbook, reachablePrograms } from './playbook.mjs';
import { programName } from './programs.mjs';
import { assertCalendarDate, parseFiniteNumber } from './validate.mjs';
import { ApiError } from './errors.mjs';

const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const round2 = n => Math.round(n * 100) / 100;
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|hotel|hotels|resort|and|by|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
const SERP_RESERVE = 230;
const CASH_TTL = 6 * 3600 * 1000;

/** Parse one SerpApi Google Hotels property into a cash offer, or null without a price. */
export function parseCashProperty(p, nights) {
  const perNight = Number(p?.rate_per_night?.extracted_lowest) || null;
  const total = Number(p?.total_rate?.extracted_lowest) || (perNight ? perNight * nights : null);
  if (!p?.name || !total) return null;
  return { name: p.name, totalUsd: round2(total), perNightUsd: round2(perNight || total / nights), stars: Number(p.extracted_hotel_class) || null, rating: Number(p.overall_rating) || null,
    reviews: Number(p.reviews) || null, url: /^https:\/\//i.test(String(p.link || '')) ? p.link : `https://www.google.com/travel/search?q=${encodeURIComponent(p.name)}` };
}

async function cityCashPrices({ apiKey, city, checkIn, checkOut, nights, fetchImpl = fetch }) {
  const key = providerCacheKey('serpapi.google-hotels-city', apiKey, { city: city.toLowerCase(), checkIn, checkOut });
  const cached = await getProviderSearch(key, CASH_TTL);
  if (cached) return { offers: cached.result, calls: 0 };
  const params = new URLSearchParams({ engine: 'google_hotels', q: `hotels in ${city}`, check_in_date: checkIn, check_out_date: checkOut, currency: 'USD', gl: 'us', hl: 'en', adults: '2', api_key: apiKey });
  await recordApiCalls(1, 'serp');
  const r = await observeRequest({ service: 'hotelinfo', operation: 'hotelinfo.enrich', method: 'GET' }, () => fetchImpl(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) }));
  if (r.status === 429) throw new ApiError('SerpApi monthly search limit reached.', 429, 'SERPAPI_LIMIT');
  if (!r.ok) throw new ApiError(`SerpApi returned HTTP ${r.status}.`, 502, 'SERPAPI_ERROR');
  const body = await r.json().catch(() => ({}));
  const offers = (body.properties || []).filter(p => !p.type || /hotel/i.test(p.type)).map(p => parseCashProperty(p, nights)).filter(Boolean);
  await saveProviderSearch(key, offers).catch(() => {});
  return { offers, calls: 1 };
}

/** Find the Google offer for an award hotel by name (every significant word of the shorter name). */
export function matchCashOffer(name, offers) {
  const a = norm(name).split(' ').filter(Boolean);
  if (!a.length) return null;
  let best = null;
  for (const o of offers) {
    const b = norm(o.name).split(' ').filter(Boolean);
    const [short, long] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
    if (short.length >= 2 && short.every(w => long.has(w)) && (!best || o.totalUsd < best.totalUsd)) best = o;
  }
  return best;
}

/**
 * input: { destination, checkIn, nights, flexDays?, roomType? }
 */
export async function findHotels(input, { allowApi = true, allowGoogle = true, fetchImpl } = {}) {
  const started = Date.now();
  const destination = String(input?.destination || '').trim();
  if (!destination || destination.length > 120) throw new ApiError('Enter a city for the stay.', 400, 'INVALID_INPUT');
  const checkIn = assertCalendarDate(input.checkIn, 'check-in date');
  const nights = parseFiniteNumber(input.nights ?? 3, { min: 1, max: 14, integer: true, name: 'nights' });
  const flexDays = parseFiniteNumber(input.flexDays ?? 0, { min: 0, max: 7, integer: true, name: 'date flexibility' });
  const checkOut = shift(checkIn, nights);
  const [settings, user, usage] = await Promise.all([getSettings(), loadUser(), apiUsage()]);
  const transfers = transferData();
  const prefs = { ...DEFAULT_PREFS, ...(user.preferences || {}) };

  const canGoogle = allowGoogle && settings.serpApiKey && usage.serpCalls < SERP_RESERVE;
  const status = { api: 'skipped', google: canGoogle ? 'fetched' : settings.serpApiKey ? 'skipped' : 'not-configured', googleCalls: 0, warnings: [] };
  const [awards, cash] = await Promise.all([
    searchHotels({ destination, checkIn, checkOut, flexDays, roomType: input.roomType === 'suite' ? 'suite' : 'standard' }, { allowApi }),
    canGoogle ? cityCashPrices({ apiKey: settings.serpApiKey, city: destination, checkIn, checkOut, nights, ...(fetchImpl ? { fetchImpl } : {}) }).catch(e => { status.google = 'error'; status.warnings.push(e.message); return { offers: [], calls: 0 }; }) : { offers: [], calls: 0 }
  ]);
  status.api = awards.dataStatus.api; status.googleCalls = cash.calls;
  status.warnings.push(...awards.dataStatus.warnings);

  const hotels = awards.rows.map(h => {
    const value = valueCents(h.program, user.balances, transfers, prefs.defaultCpp);
    const offer = h.checkIn === checkIn ? matchCashOffer(h.name, cash.offers) : null;
    const rawCash = h.cashUsd ?? offer?.totalUsd ?? null;
    const cashUsd = rawCash == null ? null : round2(rawCash);
    const pointsValueUsd = round2(h.funding?.pointsCostUsd ?? (h.totalPoints * value.cents) / 100);
    const cpp = cashUsd ? Math.round((cashUsd / h.totalPoints) * 1000) / 10 : null;
    // Not enough points for the whole stay: cover as many nights as the wallet can, pay cash for the rest.
    let mix = null;
    if (!h.affordable && nights > 1) {
      for (let k = nights - 1; k >= 1 && !mix; k--) {
        const points = Math.round((h.totalPoints / nights) * k);
        const f = fundPrograms({ [h.program]: points }, user.balances, transfers, prefs);
        if (f) mix = { pointsNights: k, cashNights: nights - k, points: f.totalSourcePoints, cashUsd: cashUsd != null ? round2((cashUsd / nights) * (nights - k)) : null, pointsValueUsd: round2(f.pointsCostUsd), plan: f.sources };
      }
    }
    const verdict = h.affordable ? (cashUsd == null ? 'points' : pointsValueUsd <= cashUsd ? 'points' : 'cash') : mix ? 'mix' : cashUsd != null ? 'cash' : 'short';
    return {
      id: h.id, name: h.name, program: h.program, programName: h.programName, city: h.city, location: h.location, checkIn: h.checkIn, checkOut: shift(h.checkIn, nights), nights, roomType: h.roomType, category: h.category,
      stars: h.info?.stars ?? offer?.stars ?? null, rating: h.info?.rating ?? offer?.rating ?? null, michelinKeys: h.awards?.michelinKeys ?? null,
      points: h.totalPoints, pointsPerNight: Math.round(h.totalPoints / nights), estimated: Boolean(h.estimated), affordable: h.affordable,
      plan: (h.funding?.sources || []).map(s => ({ from: s.from, fromName: transfers.banks?.[s.from]?.name || programName(s.from), fromPoints: s.fromPoints, toName: programName(s.targetProgram), toPoints: s.targetPoints, direct: Boolean(s.direct) })),
      pointsValueUsd, cashUsd, cashSource: h.cashUsd != null ? 'program' : offer ? 'google' : null, cpp, valueCents: value.cents,
      savingsUsd: cashUsd != null ? round2(cashUsd - pointsValueUsd) : null, verdict, mix,
      effectiveCostUsd: verdict === 'points' ? pointsValueUsd : verdict === 'mix' && mix.cashUsd != null ? round2(mix.pointsValueUsd + mix.cashUsd) : cashUsd,
      bookUrl: h.bookingUrl || null, cashUrl: offer?.url || h.reviewLinks?.google || null
    };
  });
  // Best value first: fundable stays where points beat cash by the most, then other fundable stays.
  const rank = h => (h.verdict === 'points' ? 0 : h.verdict === 'mix' ? 1 : h.verdict === 'cash' ? 2 : 3);
  hotels.sort((a, b) => rank(a) - rank(b) || (b.savingsUsd ?? -Infinity) - (a.savingsUsd ?? -Infinity) || (a.effectiveCostUsd ?? Infinity) - (b.effectiveCostUsd ?? Infinity));

  const cashDeals = cash.offers.filter(o => !o.rating || o.rating >= 3.8).sort((a, b) => a.totalUsd - b.totalUsd).slice(0, 8);
  const bestPoints = hotels.find(h => h.verdict === 'points') || null;
  const bestMix = hotels.filter(h => h.verdict === 'mix' && h.mix.cashUsd != null).sort((a, b) => a.effectiveCostUsd - b.effectiveCostUsd)[0] || null;
  const bestCash = cashDeals[0] || null;

  const reach = reachablePrograms(user.balances, transfers);
  const tips = playbook().hotelTips.filter(t => !reach.size || t.programs.some(p => reach.has(p))).map(t => ({ title: t.title, text: t.text }));
  const insights = [];
  if (nights >= 5 && hotels.some(h => ['hilton', 'marriott'].includes(h.program))) insights.push('Hilton (for elite members) and Marriott give the fifth night free on award stays. Confirm the total on the program site; it can be lower than shown here.');
  if (nights > 5) insights.push('Award prices for stays longer than five nights are estimated from the five-night price.');
  if (bestPoints?.cpp != null) insights.push(`${bestPoints.name} returns ${bestPoints.cpp.toFixed(1)}¢ per point against a value of ${bestPoints.valueCents}¢.`);

  const usd = n => `$${Math.round(n).toLocaleString('en-US')}`;
  const pts = n => Math.round(n).toLocaleString('en-US');
  const summary = bestPoints
    ? { headline: `Use points at ${bestPoints.name}: ${pts(bestPoints.points)} ${bestPoints.programName} points.`, detail: bestPoints.savingsUsd != null ? `That saves about ${usd(bestPoints.savingsUsd)} against the ${usd(bestPoints.cashUsd)} cash rate at your point values.${bestCash && bestCash.totalUsd < bestPoints.pointsValueUsd ? ` The cheapest well-rated cash stay is ${bestCash.name} at ${usd(bestCash.totalUsd)}.` : ''}` : 'No cash rate is known for comparison, so check the cash price before you book.' }
    : bestMix ? { headline: `Mix points and cash at ${bestMix.name}.`, detail: `Your points cover ${bestMix.mix.pointsNights} of ${nights} nights (${pts(bestMix.mix.points)} points); the other ${bestMix.mix.cashNights} cost about ${usd(bestMix.mix.cashUsd)}.` }
      : bestCash ? { headline: `Pay cash: ${bestCash.name} for ${usd(bestCash.totalUsd)}.`, detail: hotels.length ? 'Award rooms exist, but paying cash costs less than your points are worth, or your points cannot cover them.' : 'No award rooms were found for these dates.' }
        : { headline: hotels.length ? 'Award rooms exist, but your points cannot cover them.' : 'No award rooms were found for these dates.', detail: 'Try flexible dates or another city, or watch this stay.' };

  return {
    query: { destination, checkIn, checkOut, nights, flexDays },
    summary, bestPoints, bestMix, bestCash,
    hotels: hotels.slice(0, 30), cashDeals, insights, tips,
    watch: { suggested: !bestPoints },
    counts: { awardRooms: awards.rows.length, cashOffers: cash.offers.length },
    walletEmpty: !(user.balances || []).some(b => Number(b.balance) > 0),
    dataStatus: status, tookMs: Date.now() - started
  };
}
