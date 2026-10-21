import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(),'pp-itinerary-routes-'));
process.env.POINTPILOT_DATA_DIR = dir;
const { createRoutes } = await import('../lib/itinerary-routes.mjs');
const { getTripPlan, clearTrip, setFlights, removeFlight, saveItinerary, setPositioning, updateTripSettings } = await import('../lib/tripplan.mjs');
const { addStay, clearPlan } = await import('../lib/stayplan.mjs');
const { searchTrip, evaluateSelection } = await import('../lib/search.mjs');
const { saveUser, updateSettings } = await import('../lib/settings.mjs');
const { normalizeFlightAward, saveAwards, queryFlights, replaceApiAwards } = await import('../lib/awards.mjs');
const route = createRoutes();
test.after(()=>rm(dir,{recursive:true,force:true}));
const award = (origin,destination,date='2027-06-05')=>({id:`${origin}-${destination}`,program:'united',origin,destination,date,cabin:'business',mileageCost:1000,totalTaxes:null});
const full = revision => ({schemaVersion:2,expectedRevision:revision,mode:'multi-city',travelers:1,segments:[{id:'a',award:award('JFK','LHR')},{id:'b',award:award('CDG','HND','2027-06-10')},{id:'c',award:award('HND','JFK','2027-06-15')}],transitions:[]});

test('route factory saves/reloads canonical v2 and old pair mutations cannot erase middle legs', async () => {
  await clearTrip();
  const revision = (await getTripPlan()).revision;
  const saved = await route({method:'PUT',path:'/api/trip-plan/itinerary',body:full(revision)});
  assert.equal(saved.status,200);assert.equal(saved.payload.legacyCompatible,false);assert.equal(saved.payload.segments.length,3);assert.equal('flights' in saved.payload,false);
  await assert.rejects(setFlights({outbound:award('BOS','LHR')}),{status:409,code:'MULTICITY_PLAN'});
  await assert.rejects(removeFlight('outbound'),{status:409,code:'MULTICITY_PLAN'});
  assert.equal((await getTripPlan()).segments[1].id,'b');
  const disk = JSON.parse(await readFile(path.join(dir,'trip-plan.json'),'utf8'));
  assert.equal('flights' in disk,false);assert.equal(disk.revision,revision+1);
  assert.equal(await route({method:'GET',path:'/unowned',body:{}}),null);
});

test('revision checks run atomically and missing segment deletion is 404', async () => {
  const revision = (await getTripPlan()).revision;
  const results = await Promise.allSettled([saveItinerary(full(revision)),saveItinerary(full(revision))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'PLAN_CHANGED');
  const current = await getTripPlan();
  await assert.rejects(route({method:'DELETE',path:'/api/trip-plan/segments/missing',body:{expectedRevision:current.revision}}),{status:404});
  const removed = await route({method:'DELETE',path:'/api/trip-plan/segments/b',body:{expectedRevision:current.revision}});
  assert.deepEqual(removed.payload.segments.map(s=>s.id),['a','c']);
  assert.equal(removed.payload.transitions.length,1);assert.equal(removed.payload.transitions[0].ground,null);
  await assert.rejects(route({method:'DELETE',path:'/api/trip-plan/segments/c',body:{expectedRevision:current.revision}}),{status:409});
});

test('drafts are saved but complete evaluation requires every leg; malformed requests fail', async () => {
  const current = await getTripPlan();
  const body = {...full(current.revision),segments:[{id:'one',award:award('JFK','LHR')},{id:'two',award:null}]};
  const saved = await route({method:'PUT',path:'/api/trip-plan/itinerary',body});
  assert.equal(saved.payload.complete,false);
  const evaluated = await route({method:'POST',path:'/api/trip/evaluate',body:{schemaVersion:2,mode:'multi-city',segments:body.segments}});
  assert.equal(evaluated.payload.affordable,false);assert.equal(evaluated.payload.fundingStatus,'incomplete');
  for (const value of [null,[],{...full(saved.payload.revision),unknown:true},{...full(saved.payload.revision),expectedRevision:undefined}]) await assert.rejects(route({method:'PUT',path:'/api/trip-plan/itinerary',body:value}),{status:400});
});

test('reorder preserves flight picks and invalidates removed adjacent transfer estimates', async () => {
  let current = await getTripPlan();
  const draft = {schemaVersion:2,expectedRevision:current.revision,mode:'multi-city',segments:[{id:'a',award:null},{id:'b',award:null},{id:'c',award:null}],transitions:[{fromSegmentId:'a',toSegmentId:'b',type:'surface',ground:{mode:'rail',durationMinutes:120,cost:null},bufferMinutes:60}]};
  current = await saveItinerary(draft);
  current = await saveItinerary({...draft,expectedRevision:current.revision,segments:[draft.segments[1],draft.segments[0],draft.segments[2]],transitions:[]});
  assert.deepEqual(current.segments.map(s=>s.id),['b','a','c']);assert.ok(current.transitions.every(t=>t.ground===null));
});

test('complete v2 evaluation funds flights plus linked stays exactly once and leaves wallet untouched', async () => {
  await clearPlan();
  await saveUser({balances:[{code:'united',balance:10000},{code:'hyatt',balance:10000}]});
  await addStay({name:'Hyatt',program:'hyatt',checkIn:'2027-06-05',checkOut:'2027-06-06',nightlyPoints:5000});
  const before = await readFile(path.join(dir,'user.json'),'utf8');
  const {expectedRevision:_rev,...body}=full(0);
  const result = await evaluateSelection(body);
  assert.equal(result.affordable,true);assert.deepEqual(result.trip.needs,{united:3000,hyatt:5000});assert.equal(result.trip.stays.length,1);assert.equal(result.trip.fundingStatus,undefined);
  assert.equal(result.fundingStatus,'funded');assert.equal(await readFile(path.join(dir,'user.json'),'utf8'),before);
  await saveUser({balances:[]});assert.equal((await evaluateSelection(body)).fundingStatus,'unfunded');
  await saveUser({balances:[{code:'delta',balance:1}]});assert.equal((await evaluateSelection(body)).fundingStatus,'search-limited');
  await clearPlan();
});

test('v2 search validates all legs before work, retains failed legs independently and bounds concurrency', async () => {
  await updateSettings({seatsAeroApiKey:'synthetic-itinerary-key',apiRefreshMinutes:5});
  await saveUser({balances:[]});
  const original = global.fetch; let calls=0, active=0, maximum=0;
  global.fetch=async input=>{
    const url = new URL(input);
    if (!url.hostname.includes('seats.aero')) throw new Error('Unexpected network');
    calls++;active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,10));active--;
    return {status:url.searchParams.get('origin_airport')==='CDG'?401:200,ok:url.searchParams.get('origin_airport')!=='CDG',json:async()=>({data:[],hasMore:false})};
  };
  try {
    const segments=[{id:'a',origins:'JFK',destination:'LHR',departDate:'2027-06-05',cabin:'business'},{id:'b',origins:'CDG',destination:'HND',departDate:'2027-06-10',cabin:'business'},{id:'c',origins:'HND',destination:'JFK',departDate:'2027-06-15',cabin:'business'}];
    await assert.rejects(searchTrip({schemaVersion:2,mode:'multi-city',segments:[segments[0],{...segments[1],departDate:'2027-02-30'}]}),{status:400});assert.equal(calls,0);
    await assert.rejects(searchTrip({schemaVersion:2,mode:'multi-city',segments:[{...segments[0],origins:'ZZZ'}]}),{status:400});assert.equal(calls,0);
    const result=await searchTrip({schemaVersion:2,mode:'multi-city',segments});
    assert.equal(result.segments.length,3);assert.equal(result.complete,false);assert.ok(maximum<=2);assert.equal(calls,3);
    assert.equal(result.segments[0].error,null);assert.ok(result.segments[1].error);assert.equal(result.segments[2].error,null);
    assert.ok(result.segments.every(s=>Array.isArray(s.options)));
  } finally {global.fetch=original;await updateSettings({seatsAeroApiKey:''});}
});

test('partial inventory refresh never deletes prior cached rows and search exposes truncation per leg', async () => {
  const r=normalizeFlightAward({...award('BOS','LHR'),dataSource:'seats.aero',availabilityId:'old'});
  await saveAwards([r]);
  const query={dataSource:'seats.aero',origins:['BOS'],destinations:['LHR'],start:r.date,end:r.date,cabin:'business'};
  await replaceApiAwards({...query,truncated:true},[]);
  assert.equal((await queryFlights(query)).length,1);
  await replaceApiAwards(query,[]);assert.equal((await queryFlights(query)).length,0);
  await updateSettings({seatsAeroApiKey:'synthetic-truncation'});
  const original=global.fetch;let calls=0;
  global.fetch=async()=>({status:200,ok:true,json:async()=>{calls++;return {data:[],hasMore:true,cursor:`next${calls}`};}});
  try {
    const result=await searchTrip({schemaVersion:2,mode:'one-way',segments:[{id:'truncated',origins:'BOS',destination:'CDG',departDate:'2027-06-20',cabin:'business'}]});
    assert.equal(result.segments[0].truncated,true);assert.ok(result.segments[0].truncatedReason);assert.ok(calls<=10);
  } finally {global.fetch=original;await updateSettings({seatsAeroApiKey:''});}
});

test('registered HTTP routes preserve security, v2 save/reload, draft responses and stale conflicts', async () => {
  const original=global.fetch;
  global.fetch=async(input, init)=>{
    if (new URL(String(input)).hostname==='127.0.0.1') return original(input,init);
    return {ok:false,status:503,json:async()=>({})};
  };
  let server;
  try {
    const {startServer}=await import('../server.mjs');
    const port=await new Promise(resolve=>{server=startServer({port:0,monitor:false,onReady:resolve});});
    const call=async(pathname,method='GET',body)=>{
      const response=await original(`http://127.0.0.1:${port}${pathname}`,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,payload:await response.json(),headers:response.headers};
    };
    const current=await call('/api/trip-plan');
    const body={schemaVersion:2,expectedRevision:current.payload.revision,mode:'one-way',travelers:1,segments:[{id:'http-leg',award:null}],transitions:[]};
    const saved=await call('/api/trip-plan/itinerary','PUT',body);
    assert.equal(saved.status,200);assert.equal(saved.payload.schemaVersion,2);assert.equal(saved.payload.complete,false);assert.equal(saved.headers.get('Cache-Control'),'no-store');
    assert.equal((await call('/api/trip-plan/itinerary','PUT',body)).status,409);
    assert.equal((await call('/api/trip-plan')).payload.segments[0].id,'http-leg');
    assert.equal((await call('/api/trip-plan/itinerary','PUT',[])).status,400);
    const foreign=await original(`http://127.0.0.1:${port}/api/trip-plan/itinerary`,{method:'PUT',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify(body)});
    assert.equal(foreign.status,403);
    assert.equal((await call('/api/trip-plan/segments/http-leg','DELETE',{expectedRevision:saved.payload.revision})).status,200);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    global.fetch=original;
  }
});

test('award home positioning preserves its identity and permits an explicit estimated airport move', async () => {
  await clearTrip();
  await setFlights({outbound:{...award('JFK','LHR'),flight:{departUtc:'2027-06-05T20:00:00Z',arriveUtc:'2027-06-06T04:00:00Z'}}});
  await updateTripSettings({home:{origin:'BOS'}});
  assert.ok((await getTripPlan()).risks.some(r=>r.code==='POSITIONING_MISSING'));
  const pick={...award('BOS','EWR'),kind:'award',flight:{origin:'BOS',destination:'EWR',departUtc:'2027-06-05T10:00:00Z',arriveUtc:'2027-06-05T11:00:00Z'},ground:{mode:'road',durationMinutes:120,cost:{currency:'USD',value:50}}};
  const saved=await setPositioning('outbound',pick);
  assert.equal(saved.positioning.outbound.ground.durationMinutes,120);assert.equal(saved.positioning.outbound.flight.destination,'EWR');
  assert.ok(saved.risks.some(r=>r.code==='AIRPORT_CHANGE'));assert.ok(saved.risks.some(r=>r.code==='SEPARATE_TICKETS'));
  await assert.rejects(setPositioning('outbound',{...pick,ground:{...pick.ground,durationMinutes:600}}),{status:400});
});
