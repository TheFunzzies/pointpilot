import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(),'pp-itinerary-migration-'));
process.env.POINTPILOT_DATA_DIR = dir;
const { normalizeTripPlan } = await import('../lib/itinerary.mjs');
const { validateItinerary } = await import('../lib/validate.mjs');
const { writeJson, clearStoreCache } = await import('../lib/store.mjs');
const { getTripPlan, updateTripSettings } = await import('../lib/tripplan.mjs');
test.after(()=>rm(dir,{recursive:true,force:true}));
const out = {id:'out',program:'united',origin:'JFK',destination:'LHR',date:'2027-06-05',cabin:'business',mileageCost:1000};
const ret = {...out,id:'back',origin:'LGW',destination:'EWR',date:'2027-06-10'};

test('legacy one-way, same-metro pair and open-jaw migration preserve context and stable IDs', () => {
  const one = normalizeTripPlan({flights:{outbound:out,return:null},travelers:2,home:{origin:'BOS',returnTo:'BOS'},buffers:{outboundHours:4,returnHours:3}});
  assert.equal(one.mode,'one-way');assert.equal(one.segments[0].id,'outbound');assert.equal(one.travelers,2);assert.equal(one.buffers.outboundHours,4);
  const pair = normalizeTripPlan({flights:{outbound:out,return:ret}});
  assert.equal(pair.mode,'round-trip');assert.equal(validateItinerary(pair).valid,true);
  const open = normalizeTripPlan({flights:{outbound:out,return:{...ret,origin:'CDG'}},allowOpenJaw:true});
  assert.equal(open.mode,'open-jaw');assert.equal(open.transitions[0].type,'surface');assert.equal(open.transitions[0].ground,null);
});

test('legacy return-only drafts remain return-only; incompatible data is readable with warnings', () => {
  const only = normalizeTripPlan({flights:{outbound:null,return:ret}},{strict:false});
  assert.equal(only.segments[0].id,'return');assert.equal(only.segments[0].award.origin,'LGW');
  const invalid = normalizeTripPlan({flights:{outbound:out,return:{...ret,date:'2027-06-01'}}},{strict:false});
  assert.ok(invalid.migrationWarnings.length);assert.equal(invalid.segments.length,2);assert.equal(validateItinerary(Object.fromEntries(Object.entries(invalid).filter(([k])=>k!=='migrationWarnings'))).valid,false);
  assert.equal(normalizeTripPlan({}).segments.length,0);
  assert.throws(()=>normalizeTripPlan([]),{status:400});
  assert.throws(()=>normalizeTripPlan({schemaVersion:3,segments:[]},{strict:false}),{code:'UNSUPPORTED_SCHEMA'});
});

test('read migration never writes; successful first edit writes canonical v2 without duplicate flights', async () => {
  const file = path.join(dir,'trip-plan.json');
  const legacy = {flights:{outbound:null,return:ret},travelers:1};
  await writeJson(file,legacy);
  const before = await readFile(file,'utf8');
  const read = await getTripPlan();
  assert.equal(read.flights.outbound,null);assert.equal(read.flights.return.id,'back');assert.equal(await readFile(file,'utf8'),before);
  const edited = await updateTripSettings({travelers:2});
  assert.equal(edited.revision,1);
  const persisted = JSON.parse(await readFile(file,'utf8'));
  assert.equal(persisted.schemaVersion,2);assert.equal(persisted.segments[0].id,'return');assert.equal('flights' in persisted,false);
  await writeJson(file,{home:{origin:'BOS'},flights:{outbound:{...out,flight:{departUtc:'invalid legacy timestamp'}},return:null}});
  const incompatible=await getTripPlan();
  assert.equal(incompatible.valid,false);assert.ok(incompatible.migrationWarnings.length);assert.equal(incompatible.segments[0].award.flight.departUtc,'invalid legacy timestamp');
});

test('unknown future saved schemas cannot be overwritten by edits', async () => {
  const file = path.join(dir,'trip-plan.json'); await writeJson(file,{schemaVersion:99,segments:[]});
  const before = await readFile(file,'utf8');
  await assert.rejects(updateTripSettings({travelers:1}),{code:'UNSUPPORTED_SCHEMA'});
  assert.equal(await readFile(file,'utf8'),before);
});

test('corrupt persisted JSON loads empty and the original bytes remain recoverable', async () => {
  const file=path.join(dir,'trip-plan.json');
  await writeFile(file,'{broken itinerary');clearStoreCache();
  const p=await getTripPlan();assert.equal(p.segments.length,0);
  const aside=(await readdir(dir)).find(name=>name.startsWith('trip-plan.json.corrupt-'));
  assert.ok(aside);assert.equal(await readFile(path.join(dir,aside),'utf8'),'{broken itinerary');
});
