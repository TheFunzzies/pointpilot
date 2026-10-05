import test from 'node:test';
import assert from 'node:assert/strict';
import { observationId } from '../scraper/price-history.mjs';

test('search observations can be made distinct with an observation key', () => {
  const base = {provider:'aa',program:'american',product:'flight',origin:'JFK',destination:'BKK',date:'2026-10-05',cabin:'business',pointsCommon:70000,sourceType:'search_observation'};
  const a = observationId({...base, observationKey:'search-1:row-1'});
  const b = observationId({...base, observationKey:'search-2:row-1'});
  assert.notEqual(a,b);
});
