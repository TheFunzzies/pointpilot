import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-expiration-'));
const { updateSettings, getSettings, validateSettings, validateAlertDefinitions } = await import('../lib/settings.mjs');
const { setNotifier, checkPointExpirationReminders, tripFitsAwardFilters } = await import('../lib/monitor.mjs');
const { buildPayload, normalizeIncoming } = await import('../lib/backup-schema.mjs');

test('points-expiration settings and alert filters validate and survive backup round trips', () => {
  const entry = { id: 'exp-1', program: 'united', points: 25000, expiresOn: '2027-06-01', note: 'Activity required' };
  assert.deepEqual(validateSettings({ pointExpirations: [entry] }).pointExpirations[0], { ...entry, reminderStage: '', reminderDate: '' });
  assert.throws(() => validateSettings({ pointExpirations: [{ ...entry, points: 0 }] }), /expiring points/);
  const restored = validateSettings({ pointExpirations: [entry] });
  assert.equal(restored.pointExpirations[0].program, 'united');
  const alert = validateAlertDefinitions([{ id: 'a1', kind: 'award', title: 'Trip', query: { origins: 'JFK', destination: 'LHR', departDate: '2027-06-01' }, maxTaxesPerTraveler: 150, minSeats: 2, minCabinPct: 90 }])[0];
  assert.equal(alert.maxTaxesPerTraveler, 150);
  assert.equal(alert.minSeats, 2);
  assert.equal(alert.minCabinPct, 90);

  const { payload } = buildPayload({
    categories: ['settings', 'alerts'],
    now: () => Date.parse('2026-10-28T12:00:00Z'),
    documents: {
      settings: { pointExpirations: [entry] },
      alerts: [{ id: 'a1', kind: 'award', title: 'Trip', active: true, query: { origins: 'JFK', destination: 'LHR', departDate: '2027-06-01' }, maxTaxesPerTraveler: 150, minSeats: 2, minCabinPct: 90 }]
    }
  });
  const incoming = normalizeIncoming(payload);
  assert.deepEqual(incoming.settings.pointExpirations[0], { ...entry, reminderStage: '', reminderDate: '' });
  assert.equal(incoming.alerts[0].def.maxTaxesPerTraveler, 150);
  assert.equal(incoming.alerts[0].def.minSeats, 2);
  assert.equal(incoming.alerts[0].def.minCabinPct, 90);
});

test('expiration reminders notify at milestones, daily in the final week, and only once after expiry', async () => {
  const delivered = [];
  setNotifier(message => delivered.push(message));
  await updateSettings({ pointExpirations: [{ id: 'exp-1', program: 'united', points: 25000, expiresOn: '2027-01-01', note: '' }] });
  const settings = await getSettings();
  assert.equal((await checkPointExpirationReminders(settings, '2026-10-03')).length, 1); // 90 days
  assert.equal(delivered.length, 1);
  assert.equal((await checkPointExpirationReminders(await getSettings(), '2026-10-03')).length, 0);
  assert.equal((await checkPointExpirationReminders(await getSettings(), '2026-12-26')).length, 1); // final week
  assert.equal((await checkPointExpirationReminders(await getSettings(), '2026-12-27')).length, 1); // next daily reminder
  assert.equal((await checkPointExpirationReminders(await getSettings(), '2027-01-01')).length, 1); // expired once
  assert.equal((await checkPointExpirationReminders(await getSettings(), '2027-01-02')).length, 0);
  assert.equal(delivered.length, 4);
  setNotifier(null);
});

test('award alert filters enforce total fees, known seat counts, and cabin coverage for every leg', () => {
  const option = (seats, cabin, taxes) => ({ remainingSeats: seats, totalTaxes: taxes, flight: { mixedCabinPct: cabin } });
  const trip = { travelers: 2, taxesUsd: 220, legs: [option(2, 100, 50), option(3, 90, 60)] };
  const filters = { maxTaxesPerTraveler: 120, minSeats: 2, minCabinPct: 90 };
  assert.equal(tripFitsAwardFilters(trip, filters), true);
  assert.equal(tripFitsAwardFilters({ ...trip, taxesUsd: 250 }, filters), false);
  assert.equal(tripFitsAwardFilters({ ...trip, legs: [option(2, 100, 50), option(null, 90, 60)] }, filters), false);
  assert.equal(tripFitsAwardFilters({ ...trip, legs: [option(2, 100, 50), option(3, 80, 60)] }, filters), false);
});

