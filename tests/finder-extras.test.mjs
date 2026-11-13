import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pp-finder-extras-'));
process.env.POINTPILOT_DATA_DIR = dir;
process.env.POINTPILOT_REFERENCE_URL = 'http://127.0.0.1:9/unreachable.json';
process.env.POINTPILOT_CABINS_URL = 'http://127.0.0.1:9/unreachable.json';
const { saveUser, updateSettings, getSettings } = await import('../lib/settings.mjs');
const { normalizeFlightAward, normalizeHotelAward, saveAwards } = await import('../lib/awards.mjs');
const { findTrip } = await import('../lib/finder.mjs');
const { findHotels, parseCashProperty, matchCashOffer } = await import('../lib/hotelfinder.mjs');
const { exploreDestinations } = await import('../lib/explore.mjs');
const { listOpportunities, checkOpportunityAlerts } = await import('../lib/opportunities.mjs');
test.after(() => rm(dir, { recursive: true, force: true }));

const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const earliest = day(60), latest = day(90);
const award = (id, program, origin, destination, date, mileageCost) => normalizeFlightAward({ id, program, origin, destination, date, cabin: 'economy', mileageCost, totalTaxes: 40, direct: true });
const hotel = (name, program, nightlyPoints, cashValue) => normalizeHotelAward({ program, name, location: 'Tokyo, Japan', city: 'Tokyo', searchLocation: 'tokyo', checkIn: day(70), nightlyPoints, cashValue, roomType: 'standard' });

await saveUser({ balances: [{ code: 'united', balance: 60000, cpp: 1.2 }, { code: 'hyatt', balance: 40000, cpp: 1.7 }, { code: 'hilton', balance: 50000, cpp: 0.5 }] });
await saveAwards([
  award('o-lis', 'united', 'JFK', 'LIS', day(65), 20000), award('b-lis', 'united', 'LIS', 'JFK', day(72), 20000),
  award('o-cdg', 'united', 'JFK', 'CDG', day(65), 30000), award('b-cdg', 'united', 'CDG', 'JFK', day(72), 28000),
  award('o-fco', 'united', 'JFK', 'FCO', day(65), 80000), award('b-fco', 'united', 'FCO', 'JFK', day(72), 80000),
  award('o-aa', 'american', 'JFK', 'MAD', day(65), 25000), award('b-aa', 'american', 'MAD', 'JFK', day(72), 25000),
  hotel('Park Hyatt Tokyo', 'hyatt', 12000, 600), hotel('Hyatt Place Tokyo Bay', 'hyatt', 10000, 90), hotel('Conrad Tokyo', 'hilton', 30000, 400)
]);

test('explore ranks the destinations the wallet can fund and counts the ones it cannot', async () => {
  const r = await exploreDestinations({ origins: 'JFK', earliest, latest, nights: 7, cabin: 'economy', region: 'europe' }, { allowApi: false });
  assert.deepEqual(r.results.map(x => x.city), ['Lisbon', 'Paris']);
  assert.deepEqual([r.results[0].points, r.results[0].feesUsd, r.results[0].depart, r.results[0].return], [40000, 80, day(65), day(72)]);
  assert.equal(r.unfunded, 2); // Rome costs too much; Madrid needs miles the wallet cannot reach
  await assert.rejects(() => exploreDestinations({ origins: 'JFK', earliest, latest, region: 'atlantis' }), /Unknown region/);
});

test('flight finder offers buying the missing miles when a saved offer makes the award bookable', async () => {
  const before = await findTrip({ origins: 'JFK', destination: 'MAD', earliest, latest, nights: 7 }, { allowApi: false, allowGoogle: false });
  assert.equal(before.best, null);
  await updateSettings({ buyPointsOffers: [{ program: 'american', pricePerPointCents: 1.0, minimumPurchase: 1000, purchaseIncrement: 1000 }] });
  const r = await findTrip({ origins: 'JFK', destination: 'MAD', earliest, latest, nights: 7 }, { allowApi: false, allowGoogle: false });
  assert.deepEqual([r.best.type, r.best.pointsBought, r.best.outOfPocketUsd], ['buy', 50000, 580]);
  assert.match(r.summary.headline, /^Buy miles and book the award: \$580/);
  assert.equal(r.calendar.outbound.length, 0);
  const lis = await findTrip({ origins: 'JFK', destination: 'LIS', earliest, latest, nights: 7 }, { allowApi: false, allowGoogle: false });
  assert.deepEqual(lis.calendar.outbound, [{ date: day(65), points: 20000, feesUsd: 40, program: 'United MileagePlus' }]);
});

test('hotel finder: points when they beat cash, cash when they do not, points + cash when short', async () => {
  const r = await findHotels({ destination: 'Tokyo', checkIn: day(70), nights: 3 }, { allowApi: false, allowGoogle: false });
  const by = Object.fromEntries(r.hotels.map(h => [h.name, h]));
  assert.deepEqual([by['Park Hyatt Tokyo'].verdict, by['Park Hyatt Tokyo'].points, by['Park Hyatt Tokyo'].cashUsd, by['Park Hyatt Tokyo'].cpp], ['points', 36000, 1800, 5]);
  assert.equal(by['Hyatt Place Tokyo Bay'].verdict, 'cash'); // 30,000 points are worth $510; the room is $270
  assert.deepEqual([by['Conrad Tokyo'].verdict, by['Conrad Tokyo'].mix.pointsNights, by['Conrad Tokyo'].mix.cashUsd], ['mix', 1, 800]);
  assert.equal(r.hotels[0].name, 'Park Hyatt Tokyo');
  assert.match(r.summary.headline, /^Use points at Park Hyatt Tokyo: 36,000/);
  assert.equal(r.watch.suggested, false);
  await assert.rejects(() => findHotels({ destination: '', checkIn: day(70) }), /city/);
});

test('hotel cash offers: parsed from Google Hotels and matched by name', () => {
  const offers = [parseCashProperty({ name: 'Park Hyatt Tokyo', rate_per_night: { extracted_lowest: 500 }, total_rate: { extracted_lowest: 1500 }, overall_rating: 4.6, extracted_hotel_class: 5, link: 'https://example.com/ph' }, 3),
    parseCashProperty({ name: 'APA Hotel Shinjuku', rate_per_night: { extracted_lowest: 80 } }, 3)];
  assert.deepEqual([offers[0].totalUsd, offers[0].stars, offers[1].totalUsd], [1500, 5, 240]);
  assert.equal(parseCashProperty({ name: 'No price' }, 3), null);
  assert.equal(matchCashOffer('Park Hyatt Tokyo', offers).totalUsd, 1500);
  assert.equal(matchCashOffer('The Park Hyatt Tokyo Hotel', offers).totalUsd, 1500);
  assert.equal(matchCashOffer('Hyatt Regency Tokyo', offers), null);
});

test('opportunities: buy-points offers are rated against point value and announced once', async () => {
  const user = { balances: [{ code: 'chase', balance: 1000 }] };
  const transfers = { banks: { chase: { name: 'Chase' } }, valuations: { source: 'Test', cents: { american: 1.5, hyatt: 1.7 } },
    programs: { hyatt: { name: 'World of Hyatt', transfers: { chase: { ratio: [1, 1], bonusPct: 0.25, bonusEnds: '2099-01-01' } } }, united: { name: 'United', transfers: { chase: { ratio: [1, 1] } } } } };
  const settings = { buyPointsOffers: [{ program: 'american', pricePerPointCents: 0.9 }, { program: 'hyatt', pricePerPointCents: 1.6 }, { program: 'american', pricePerPointCents: 0.5, offerEnds: '2020-01-01' }], pointExpirations: [{ id: 'e1', program: 'united', points: 5000, expiresOn: day(20), note: '' }] };
  const list = listOpportunities({ user, settings, transfers });
  assert.deepEqual(list.map(o => [o.kind, o.rating || null, o.notify]), [['bonus', null, true], ['buy', 'great', true], ['buy', 'poor', false], ['expiry', null, false]]);
  assert.match(list[0].title, /^25% transfer bonus: Chase → World of Hyatt/);
  assert.match(list[1].text, /40% below their 1.5¢ value/);

  const notes = [];
  const first = await checkOpportunityAlerts(n => notes.push(n), await getSettings());
  assert.ok(first.some(o => o.kind === 'buy')); // the 1.0¢ American offer saved above is a good buy
  assert.equal(notes.length, 1);
  assert.deepEqual(await checkOpportunityAlerts(n => notes.push(n), await getSettings()), []);
  assert.equal(notes.length, 1);
});
