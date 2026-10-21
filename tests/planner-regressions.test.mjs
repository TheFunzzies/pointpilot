import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-plan-reg-'));
const { isCalendarDate, assertCalendarDate, parseFiniteNumber } = await import('../lib/validate.mjs');
const { evaluateSelection } = await import('../lib/search.mjs');
const { setFlights, clearTrip, updateTripSettings, setPositioning, getTripPlan, positioningFit } = await import('../lib/tripplan.mjs');
const { addStay, clearPlan, balancesAfterPlan } = await import('../lib/stayplan.mjs');
const { saveUser } = await import('../lib/settings.mjs');
const out = { id: 'out', program: 'united', origin: 'JFK', destination: 'LHR', date: '2027-06-05', cabin: 'business', mileageCost: 1000, remainingSeats: 2 };
const back = { ...out, id: 'back', origin: 'LHR', destination: 'JFK', date: '2027-06-10' };

test('BUG-9: shared validators strictly check calendar dates and bounded finite numbers', () => {
  assert.equal(isCalendarDate('2028-02-29'), true);
  for (const value of ['2027-02-29', '2027-02-30', '2027-13-01', '2027-1-01', null]) assert.equal(isCalendarDate(value), false);
  assert.throws(() => assertCalendarDate('2027-02-30', 'departDate'), { status: 400, code: 'INVALID_INPUT' });
  for (const value of ['NaN', 'Infinity', '1e999', '', true, null, {}, 1.5, 10]) assert.throws(() => parseFiniteNumber(value, { min: 1, max: 9, integer: true, name: 'travelers' }), { status: 400 });
  assert.equal(parseFiniteNumber('2', { min: 1, max: 9, integer: true }), 2);
});

test('DOM-4: evaluate and save share chronology, route and seat validation', async () => {
  await saveUser({ balances: [{ code: 'united', balance: 100000 }] });
  await clearTrip();
  for (const ret of [{ ...back, date: '2027-06-01' }, { ...back, destination: 'BOS' }, { ...back, remainingSeats: 1 }]) {
    const result = await evaluateSelection({ legs: [out, ret], travelers: 2 });
    assert.equal(result.valid, false);
    assert.equal(result.affordable, false);
    assert.ok(result.invalidReason);
    await assert.rejects(setFlights({ outbound: out, return: ret, travelers: 2 }), { status: 400 });
  }
  const open = { ...back, destination: 'BOS' };
  assert.equal((await evaluateSelection({ legs: [out, open], travelers: 2, allowOpenJaw: true })).valid, true);
  let plan = await setFlights({ outbound: out, return: open, travelers: 2, allowOpenJaw: true });
  assert.equal(plan.valid, true);
  assert.equal(plan.summary.valid, true);
  await clearTrip();
  plan = await setFlights({ outbound: out, return: back, travelers: 2, allowOpenJaw: false });
  assert.equal(plan.summary.affordable, true);
});

test('DOM-5: airport changes and arbitrary positioning picks are rejected', async () => {
  await clearTrip();
  await setFlights({ outbound: { ...out, flight: { origin: 'JFK', destination: 'LHR', departUtc: '2027-06-05T20:00:00Z', arriveUtc: '2027-06-06T04:00:00Z' } } });
  await updateTripSettings({ home: { origin: 'BOS' } });
  const pick = { kind: 'cash', origin: 'BOS', destination: 'EWR', departDate: out.date, departUtc: '2027-06-05T10:00:00Z', arriveUtc: '2027-06-05T11:00:00Z', price: 100 };
  const need = (await getTripPlan()).needs.outbound;
  assert.match(positioningFit(need, pick).incompatibleReason, /Airport change/);
  await assert.rejects(setPositioning('outbound', pick), { status: 400 });
  await assert.rejects(setPositioning('outbound', { ...pick, destination: 'JFK', departDate: '2027-06-08' }), { status: 400 });
  const valid = await setPositioning('outbound', { ...pick, destination: 'JFK' });
  assert.equal(valid.valid, true);
});

test('DOM-6: remaining wallet consolidates duplicates, retains overshoot and exposes unfunded plans', async () => {
  await clearPlan();
  const user = { balances: [{ code: 'chase', balance: 3000 }, { code: 'chase', balance: 3000 }] };
  await saveUser(user);
  await addStay({ name: 'Hyatt', program: 'hyatt', checkIn: '2027-06-05', checkOut: '2027-06-06', nightlyPoints: 5500 });
  const remaining = await balancesAfterPlan(user);
  assert.equal(remaining.balances.filter(b => b.code === 'chase').length, 1);
  assert.equal(remaining.balances.find(b => b.code === 'chase').balance, 0);
  assert.equal(remaining.balances.find(b => b.code === 'hyatt').balance, 500);
  const unfunded = await balancesAfterPlan({ balances: [] });
  assert.equal(unfunded.unfunded, true);
  assert.equal(unfunded.balances, null);
  await clearPlan();
});

test('BUG-9: planners reject impossible dates and loosely typed numbers', async () => {
  await assert.rejects(addStay({ name: 'Hyatt', program: 'hyatt', checkIn: '2027-02-30', checkOut: '2027-03-03', nightlyPoints: 1000 }), { status: 400 });
  await assert.rejects(addStay({ name: 'Hyatt', program: 'hyatt', checkIn: '2027-06-05', checkOut: '2027-06-06', nightlyPoints: '1e999' }), { status: 400 });
  await assert.rejects(setFlights({ outbound: out, travelers: 'abc' }), { status: 400 });
  await assert.rejects(updateTripSettings({ buffers: { outboundHours: 'Infinity' } }), { status: 400 });
});


test('same-metro and searched airport sets survive evaluation, saving and reloading', async () => {
  await clearTrip();
  await saveUser({ balances: [{ code: 'united', balance: 100000 }] });
  const metroBack = { ...back, origin: 'LGW', destination: 'EWR' };
  assert.equal((await evaluateSelection({ legs: [out, metroBack] })).affordable, true);
  assert.equal((await setFlights({ outbound: out, return: metroBack })).valid, true);
  assert.equal((await getTripPlan()).valid, true);
  await updateTripSettings({ travelers: 2 });
  const otherCity = { ...back, origin: 'CDG', destination: 'BOS' };
  const context = { origins: ['JFK', 'BOS'], destinations: ['LHR', 'CDG'] };
  assert.equal((await evaluateSelection({ legs: [out, otherCity], ...context })).affordable, true);
  assert.equal((await setFlights({ outbound: out, return: otherCity, ...context })).valid, true);
  assert.equal((await getTripPlan()).valid, true);
  await updateTripSettings({ travelers: 1 });
  await clearTrip();
});

test('same-metro routes still reject return departures before outbound arrival', async () => {
  await clearTrip();
  const timedOut = { ...out, flight: { departUtc: '2027-06-05T20:00:00Z', arriveUtc: '2027-06-06T08:00:00Z' } };
  const early = { ...back, destination: 'EWR', date: '2027-06-06', flight: { departUtc: '2027-06-06T07:00:00Z', arriveUtc: '2027-06-06T15:00:00Z' } };
  for (const allowOpenJaw of [false, true]) {
    assert.equal((await evaluateSelection({ legs: [timedOut, early], allowOpenJaw })).valid, false);
    await assert.rejects(setFlights({ outbound: timedOut, return: early, allowOpenJaw }), { status: 400 });
  }
});
