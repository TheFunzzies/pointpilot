import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAward } from '../scraper/normalize.mjs';
import { getProvider, listProviders } from '../scraper/provider-registry.mjs';

test('provider registry contains major programs and keeps restricted providers disabled', () => {
  const list = listProviders();
  for (const id of ['american','united','aeroplan','flyingblue','hyatt','hilton','marriott']) assert.ok(list.some(x => x.id === id));
  assert.equal(getProvider('american').mode, 'restricted');
  assert.equal(getProvider('demo_authorized').mode, 'authorized');
});

test('award normalization creates optimizer-ready records', () => {
  const row = normalizeAward({origin:'jfk',destination:'bkk',date:'2027-02-11',program:'Aeroplan',cabin:'business',points:'87,500',taxes:'$87',seats:'2',airline:'Air Canada',flightNumbers:'AC889'}, 'aeroplan');
  assert.equal(row.origin, 'JFK');
  assert.equal(row.destination, 'BKK');
  assert.equal(row.mileageCost, 87500);
  assert.equal(row.totalTaxes, 87);
  assert.equal(row.remainingSeats, 2);
  assert.equal(row.dataSource, 'direct:aeroplan');
});
