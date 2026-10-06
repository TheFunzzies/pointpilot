import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-v011-'));
const ts = await import('../lib/transfer-sources.mjs');
const { mapTrip } = await import('../lib/flights.mjs');
const { expandAwards } = await import('../lib/search.mjs');
const { updateSettings } = await import('../lib/settings.mjs');

test('program name matching across sites', () => {
  assert.equal(ts.matchProgram('British Airways Executive Club (Avios)'), 'ba');
  assert.equal(ts.matchProgram('Air France/KLM Flying Blue'), 'flyingblue');
  assert.equal(ts.matchProgram('American Airlines AAdvantage'), 'american');
  assert.equal(ts.matchProgram('American Express Membership Rewards logo'), 'amex');
  assert.equal(ts.matchProgram('Citi ThankYou Rewards*'), 'citi');
  assert.equal(ts.matchProgram('IHG Rewards'), 'ihg');
  assert.equal(ts.matchProgram('Korean Air SKYPASS'), null);
});

test('ratio and transfer-time parsing', () => {
  assert.deepEqual(ts.parseRatio('1:1.6'), [1, 1.6]);
  assert.deepEqual(ts.parseRatio('3:1* Instant'), [3, 1]);
  assert.equal(ts.parseDays('Instant'), 0);
  assert.equal(ts.parseDays('Up to 48 hours'), 2);
  assert.equal(ts.parseDays('2-3 weeks'), 21);
  assert.equal(ts.parseDays('~1 day'), 1);
});

const roameHtml = `<table><tr><th>Airline/Program</th><th>Alliance</th><th>IATA</th><th>Also</th><th>Release</th><th><img alt="American Express Membership Rewards logo"></th><th><img alt="Chase Ultimate Rewards logo"></th><th><img alt="World of Hyatt logo"></th></tr>
${Array.from({ length: 12 }, () => '<tr><td>Filler</td></tr>').join('')}
<tr><td><img alt="x"> Air Canada Aeroplan</td><td></td><td>AC</td><td></td><td></td><td>1:1 Instant +20%</td><td>1:1 Instant</td><td></td></tr>
<tr><td>United MileagePlus</td><td></td><td>UA</td><td></td><td></td><td></td><td>1:1 Instant</td><td>5:2 Instant</td></tr></table>`;
const upHtml = `<table><tr><th>Flexible Points</th><th>Transfer Partner</th><th>Transfer Ratio</th><th>Transfer Time</th></tr>
<tr><td>American Express Membership Rewards</td><td>Air Canada Aeroplan</td><td>1:1</td><td>Instant</td></tr>
<tr><td>Chase Ultimate Rewards</td><td>Air Canada Aeroplan</td><td>1:1</td><td>Instant</td></tr>
<tr><td>Chase Ultimate Rewards</td><td>United MileagePlus</td><td>1:1</td><td>Instant</td></tr></table>`;

test('parsers read Roame grid and Upgraded Points list', () => {
  const r = ts.resolveEdges(ts.parseRoame(roameHtml)).edges;
  assert.deepEqual(r.map(e => `${e.bank}>${e.program} ${e.ratio.join(':')} +${e.bonusPct}`).sort(), ['amex>aeroplan 1:1 +0.2', 'chase>aeroplan 1:1 +0', 'chase>united 1:1 +0', 'hyatt>united 5:2 +0']);
  const u = ts.resolveEdges(ts.parseUpgradedPoints(upHtml)).edges;
  assert.equal(u.length, 3);
});

test('consensus: verify, correct, add, live bonus, flag unlisted routes', () => {
  const current = {
    schemaVersion: 2, lastUpdated: '2026-10-01', banks: { amex: { name: 'Amex' }, chase: { name: 'Chase' }, hyatt: { name: 'Hyatt' }, citi: { name: 'Citi' } },
    programs: {
      aeroplan: { name: 'Aeroplan', transfers: { amex: { ratio: [1, 1], days: 0, unverified: true }, chase: { ratio: [2, 1], days: 0 }, citi: { ratio: [1, 1], days: 0 } } },
      united: { name: 'United', transfers: { chase: { ratio: [1, 1], days: 0 } } }
    }
  };
  const e = (bank, program, ratio, bonusPct = 0) => ({ bank, program, ratio, days: 0, bonusPct });
  const filler = Array.from({ length: 21 }, (_, i) => e('amex', `x${i}`, [1, 1]));
  const bySource = {
    roame: [e('amex', 'aeroplan', [1, 1], 0.2), e('chase', 'aeroplan', [1, 1]), e('chase', 'united', [1, 1]), e('hyatt', 'united', [5, 2]), e('citi', 'united', [1, 1]), ...filler],
    upgradedpoints: [e('amex', 'aeroplan', [1, 1]), e('chase', 'aeroplan', [1, 1]), e('chase', 'united', [1, 1]), e('citi', 'united', [1, 1]), ...filler]
  };
  const { data, changes } = ts.reconcile(current, bySource, { today: '2026-10-06' });
  const t = data.programs.aeroplan.transfers;
  assert.equal(t.amex.unverified, undefined);                      // verified by both
  assert.deepEqual(t.amex.verifiedBy, ['roame', 'upgradedpoints']);
  assert.equal(t.amex.bonusPct, 0.2);                              // live bonus from Roame
  assert.equal(t.amex.bonusEnds, '2026-10-13');                    // rolling: re-confirmed daily
  assert.deepEqual(t.chase.ratio, [1, 1]);                         // corrected from 2:1
  assert.deepEqual(data.programs.united.transfers.hyatt.ratio, [5, 2]); // only Roame covers Hyatt → accepted
  assert.deepEqual(data.programs.united.transfers.citi.ratio, [1, 1]);  // added (2 sources)
  assert.equal(t.citi.unverified, true);                           // we list it, no source does
  assert.equal(data.lastUpdated, '2026-10-06');
  assert.ok(changes.length >= 5);
});

test('layovers are flagged: very tight, tight and long', () => {
  const seg = (o, d, dep, arr) => ({ FlightNumber: 'XX1', OriginAirport: o, DestinationAirport: d, DepartsAt: dep, ArrivesAt: arr });
  const t = mapTrip({ ID: 't', Cabin: 'business', AvailabilitySegments: [
    seg('JFK', 'LHR', '2027-03-05T00:00:00Z', '2027-03-05T07:00:00Z'), seg('LHR', 'DOH', '2027-03-05T07:40:00Z', '2027-03-05T14:00:00Z'), seg('DOH', 'BKK', '2027-03-05T23:30:00Z', '2027-03-06T05:00:00Z')
  ].map((s, i) => ({ ...s, Order: i })) });
  assert.deepEqual(t.layovers.map(l => l.flag), ['very-tight', 'long']);
});

test('expanding an award into its individual flights (one per seats.aero trip)', async () => {
  await updateSettings({ seatsAeroApiKey: 'k' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [137000, 146000, 154500].map((m, i) => ({ ID: `t${i}`, Cabin: 'business', MileageCost: m, TotalTaxes: 3800, TaxesCurrency: 'USD', TotalDuration: 1000 + i,
    AvailabilitySegments: [{ Order: 0, FlightNumber: `DL${i}`, OriginAirport: 'JFK', DestinationAirport: 'HND', DepartsAt: '2027-03-05T07:05:00Z', ArrivesAt: '2027-03-06T05:05:00Z', AircraftName: 'Airbus A350-900', AircraftCode: '359' }] })), booking_links: [] }) });
  try {
    const award = { id: 'aw1', awardId: 'aw1', availabilityId: 'av1', program: 'flyingblue', programName: 'Flying Blue', cabin: 'business', origin: 'JFK', destination: 'HND', date: '2027-03-05', mileageCost: 137000, flight: null };
    const r = await expandAwards({ awards: [award], leg: 'Outbound', travelers: 2 });
    assert.deepEqual(r.options.map(o => o.mileageCost), [137000, 146000, 154500]);
    assert.ok(r.options.every(o => o.flight && o.awardId === 'aw1' && o.id.startsWith('aw1#')));
    assert.equal(r.options[0].flight.depart.time, '02:05');           // 07:05Z = 2:05 AM New York
    assert.equal(r.options[0].flight.product.type, 'Delta One Suite');
  } finally { globalThis.fetch = real; }
});
