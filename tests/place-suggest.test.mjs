import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestPlaces, resolveAirports } from '../lib/places.mjs';

test('typing a country offers an all-airports entry first that resolves to those airports', () => {
  const [first] = suggestPlaces('jamai');
  assert.equal(first.kind, 'all');
  assert.equal(first.value, 'Jamaica');
  assert.deepEqual(resolveAirports(first.value).sort(), ['KIN', 'MBJ', 'OCJ']);
  const jap = suggestPlaces('jap')[0];
  assert.equal(jap.value, 'Japan');
  assert.ok(resolveAirports(jap.value).includes('HND'));
});

test('city and airport matches are offered and every all-airports value resolves', () => {
  const tok = suggestPlaces('tok');
  assert.equal(tok[0].kind, 'all');
  assert.ok(tok.some(s => s.kind === 'airport' && s.code === 'HND'));
  for (const q of ['lon', 'new y', 'par', 'syd']) for (const s of suggestPlaces(q).filter(x => x.kind === 'all')) assert.doesNotThrow(() => resolveAirports(s.value));
});

test('completes only the last comma-separated token and ignores short input', () => {
  assert.equal(suggestPlaces('b').length, 0);
  assert.ok(suggestPlaces('BOS, jamai')[0].value === 'Jamaica');
});
