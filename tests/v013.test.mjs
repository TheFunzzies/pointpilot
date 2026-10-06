import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-v013-'));
const { productCatalog, findProduct, hasProduct } = await import('../lib/cabins.mjs');
const { searchTrip } = await import('../lib/search.mjs');
const { saveAwards, normalizeFlightAward } = await import('../lib/awards.mjs');
const { saveUser, exampleUser, updateSettings } = await import('../lib/settings.mjs');
const { createAlert, runMonitor, setNotifier } = await import('../lib/monitor.mjs');
await saveUser({ ...exampleUser(), balances: [...exampleUser().balances, { program: 'Amex', code: 'amex', balance: 2000000, cpp: 1.6 }] });

const inDays = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DATE = inDays(150);

test('catalog lists first-class products like La Première and Singapore Suites', () => {
  const keys = productCatalog().map(p => p.key);
  assert.ok(keys.includes('AF|first|La Première'));
  assert.ok(keys.includes('SQ|first|Suites'));
  assert.equal(findProduct('NH|first|THE Suite').airline, 'ANA');
});

test('product search loads flights only for that airline and finds La Première', async () => {
  await updateSettings({ seatsAeroApiKey: 'k' });
  const row = (id, program, airlines, miles) => normalizeFlightAward({ dataSource: 'seats.aero', availabilityId: id, program, origin: 'JFK', destination: 'CDG', date: DATE, cabin: 'first', mileageCost: miles, totalTaxes: 200, airlines });
  await saveAwards([row('av-af', 'flyingblue', 'AF', 180000), row('av-ac', 'aeroplan', 'AC, LH', 90000)]);
  const fetched = [];
  const real = globalThis.fetch;
  globalThis.fetch = async url => {
    fetched.push(String(url));
    return { ok: true, status: 200, json: async () => ({ data: [
      { ID: 'laprem', Cabin: 'first', MileageCost: 180000, TotalTaxes: 20000, TaxesCurrency: 'USD', TotalDuration: 450, AvailabilitySegments: [{ Order: 0, FlightNumber: 'AF7', OriginAirport: 'JFK', DestinationAirport: 'CDG', DepartsAt: `${DATE}T22:00:00Z`, ArrivesAt: `${inDays(151)}T05:30:00Z`, AircraftName: 'Boeing 777-300ER', AircraftCode: '77W' }] },
      { ID: 'narrow', Cabin: 'first', MileageCost: 185000, TotalTaxes: 20000, TaxesCurrency: 'USD', TotalDuration: 460, AvailabilitySegments: [{ Order: 0, FlightNumber: 'AF9', OriginAirport: 'JFK', DestinationAirport: 'CDG', DepartsAt: `${DATE}T23:00:00Z`, ArrivesAt: `${inDays(151)}T06:40:00Z`, AircraftName: 'Airbus A350-900', AircraftCode: '359' }] }
    ], booking_links: [] }) };
  };
  try {
    const r = await searchTrip({ origins: 'JFK', destination: 'CDG', departDate: DATE, flexDays: 0, travelers: 1, product: 'AF|first|La Première' }, { allowApi: false });
    assert.equal(r.query.cabin, 'first');
    assert.equal(fetched.length, 1);                                  // only the Air France award was expanded
    assert.match(fetched[0], /trips\/av-af/);
    assert.equal(r.dataStatus.productHunt.matches.outbound, 1);
    const hit = r.outbound.find(o => o.productMatch);
    assert.equal(hit.flight.flightNumbers[0], 'AF7');
    assert.ok(hasProduct(hit, findProduct('AF|first|La Première')));
    assert.equal(r.recommended.ids[0], hit.id);                      // recommended despite costing more points
  } finally { globalThis.fetch = real; }
});

test('product alert fires when that seat is bookable on the dates', async () => {
  const notes = [];
  setNotifier(n => notes.push(n));
  await createAlert({ origins: 'JFK', destination: 'CDG', departDate: DATE, flexDays: 0, travelers: 1, cabin: 'first', track: { mode: 'product', product: 'AF|first|La Première', productLabel: 'Air France La Première' } });
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('should use cached trips'); };
  try {
    const r = await runMonitor();
    const res = r.results.find(x => x.kind === 'award');
    assert.equal(res.isNew, true, JSON.stringify(res));
    assert.match(notes.at(-1).title, /La Première/);
    assert.match(notes.at(-1).body, /AF7/);
  } finally { globalThis.fetch = real; }
});
