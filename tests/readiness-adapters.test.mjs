import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(os.tmpdir(),'pp-readiness-adapters-'));
process.env.POINTPILOT_DATA_DIR=dir;
test.after(()=>rm(dir,{recursive:true,force:true}));
const { checkFlightAvailability, sameFlightIdentity }=await import('../lib/seatsaero.mjs');
const { getTripsCached, getTrips }=await import('../lib/flights.mjs');
const { getExactHotelAvailability, requestHotelRefresh }=await import('../lib/roomsaero.mjs');
const { apiUsage }=await import('../lib/settings.mjs');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const selection={id:'pick',dataSource:'seats.aero',program:'united',origin:'JFK',destination:'LHR',date:'2027-01-01',cabin:'business',mileageCost:50000,flight:{departUtc:'2027-01-01T12:00:00Z',flightNumbers:['UA1']}};
const trip=(changes={})=>({ID:'trip',Cabin:'business',MileageCost:50000,TotalTaxes:0,TaxesCurrency:'USD',RemainingSeats:0,AvailabilitySegments:[{FlightNumber:'UA1',OriginAirport:'JFK',DestinationAirport:'LHR',DepartsAt:'2027-01-01T12:00:00Z',ArrivesAt:'2027-01-01T19:00:00Z',Order:0}],...changes});
const record=(changes={})=>({ID:'cache-id',Source:'united',Route:{OriginAirport:'JFK',DestinationAirport:'LHR'},Date:'2027-01-01',JAvailable:true,JMileageCost:50000,JRemainingSeats:0,UpdatedAt:'2026-10-20T12:00:00Z',AvailabilityTrips:[trip()],...changes});

test('exact identity requires route, cabin, every flight number and departure time',()=>{
  const candidate={...selection,...selection.flight};delete candidate.flight;
  assert.equal(sameFlightIdentity(selection,candidate),true);
  for(const change of [{origin:'EWR'},{cabin:'economy'},{flightNumbers:['UA2']},{departUtc:'2027-01-01T12:01:00Z'}])assert.equal(sameFlightIdentity(selection,{...candidate,...change}),false);
});
test('ordinary availability bypasses local cache and never claims live',async()=>{
  const before=(await apiUsage()).calls;let count=0;
  const args={apiKey:'CANARY-SECRET',selection,fetchImpl:async(url,opts)=>{count++;assert.match(url,/origin_airport=JFK/);assert.match(url,/start_date=2027-01-01/);assert.equal(opts.method,undefined);return response({data:[record()]});}};
  for(let i=0;i<2;i++){const r=await checkFlightAvailability(args);assert.equal(r.evidence.method,'cached');assert.equal(r.match.remainingSeats,null);assert.equal(r.match.totalTaxes,0);}
  assert.equal(count,2);assert.equal((await apiUsage()).calls-before,2);
});
test('commercial live is explicitly gated, disables fallback, and synthetic IDs never fetch details',async()=>{
  let live=0;
  const fetchImpl=async(url,opts)=>{if(url.endsWith('/live')){live++;const b=JSON.parse(opts.body);assert.equal(b.smart_cache,false);assert.equal(b.seat_count,3);return response({data:[trip({ID:'live:synthetic',Source:'united'})]});}assert.ok(!url.includes('/trips/'));return response({data:[record()]});};
  assert.equal((await checkFlightAvailability({apiKey:'k',selection,travelers:3,fetchImpl})).evidence.method,'cached');assert.equal(live,0);
  assert.equal((await checkFlightAvailability({apiKey:'k',selection,travelers:3,commercialLive:true,liveSource:'united',fetchImpl})).evidence.method,'live');assert.equal(live,1);
  await assert.rejects(getTrips({apiKey:'k',availabilityId:'synthetic',evidenceMethod:'live',fetchImpl}),{code:'UNSUPPORTED_CHECK'});
  await assert.rejects(getTripsCached({apiKey:'k',availabilityId:'synthetic',evidenceMethod:'live',fetchImpl}),{code:'UNSUPPORTED_CHECK'});
});
test('cached fallback and incomplete/unknown live schema cannot prove absence',async()=>{
  for(const body of [{data:[],cached:true},{unexpected:true},{data:[{}]}]){
    const r=await checkFlightAvailability({apiKey:'k',selection,commercialLive:true,liveSource:'united',fetchImpl:async()=>response(body)});
    assert.equal(r.definitive,false);
  }
  const live=await checkFlightAvailability({apiKey:'k',selection,commercialLive:true,liveSource:'united',fetchImpl:async()=>response({data:[]})});assert.equal(live.definitive,true);
});
test('cache details bypass performs a fetch after a local cache hit',async()=>{
  let calls=0;const args={apiKey:'detail',availabilityId:'detail-id',cabin:'business',fetchImpl:async()=>{calls++;return response({data:[trip()]});}};
  await getTripsCached(args);await getTripsCached(args);assert.equal(calls,1);
  await getTripsCached({...args,bypassCache:true});assert.equal(calls,2);
});
test('404 cached detail triggers exact lookup first and yields caution rather than sold out',async()=>{
  const urls=[];
  const r=await checkFlightAvailability({apiKey:'k',selection,fetchImpl:async url=>{urls.push(url);return url.includes('/search?')?response({data:[record({AvailabilityTrips:[]})]}):response({},404);}});
  assert.match(urls[0],/search\?/);assert.match(urls[1],/trips\/cache-id/);assert.equal(r.evidence.complete,false);assert.equal(r.definitive,false);
});
test('hotel exact property and details preserve whole-stay points and unknown room count',async()=>{
  const stay={hotelId:'h1',checkIn:'2027-01-01',nights:3,roomType:'standard',program:'hyatt',dataSource:'rooms.aero'};
  const urls=[];const before=(await apiUsage()).roomsCalls;
  const r=await getExactHotelAvailability({apiKey:'k',selection:stay,fetchImpl:async url=>{urls.push(url);return response(url.includes('/availability?')?{data:[{id:'a1',hotel_id:'h1',arrival_date:'2027-01-01',num_nights:3,source:'hyatt',standard_award_available:true,standard_award_cost:100001,last_checked_at:'2026-10-20T12:00:00Z'}]}:{data:{id:'a1',room_types:[],last_checked_at:'2026-10-20T12:00:00Z'}});}});
  assert.match(urls[0],/hotel_id=h1/);assert.match(urls[0],/nights=3/);assert.match(urls[1],/availability\/a1/);assert.equal(r.match.totalPoints,100001);assert.equal(r.match.remainingRooms,null);assert.equal(r.match.totalTaxes,null);assert.equal((await apiUsage()).roomsCalls-before,2);
  let called=false;await getExactHotelAvailability({apiKey:'k',selection:{...stay,nights:6},fetchImpl:async()=>{called=true;}});assert.equal(called,false);
});
test('refresh is explicit, cost-labeled and never automatically retries a quota/transport failure',async()=>{
  let attempts=0;const before=(await apiUsage()).roomsCalls;
  const fetchImpl=async(url,opts)=>{attempts++;assert.match(url,/hotels\/h1\/refresh$/);assert.equal(opts.method,'POST');return new Response(null,{status:202});};
  const r=await requestHotelRefresh({apiKey:'k',hotelId:'h1',fetchImpl});assert.equal(r.status,'queued');assert.match(r.allowanceMessage,/shared one-refresh-per-24-hours/);assert.equal(attempts,1);assert.equal((await apiUsage()).roomsCalls-before,1);
  attempts=0;await assert.rejects(requestHotelRefresh({apiKey:'k',hotelId:'h1',fetchImpl:async()=>{attempts++;return response({},429);}}),{code:'API_RATE_LIMIT',retryAfter:86400});assert.equal(attempts,1);
});
test('provider HTTP and transport failures retain once-per-attempt accounting',async()=>{
  for(const status of [401,429,500]){const before=(await apiUsage()).calls;await assert.rejects(checkFlightAvailability({apiKey:'k',selection,fetchImpl:async()=>response({},status)}));assert.equal((await apiUsage()).calls-before,1);}
  const before=(await apiUsage()).calls;await assert.rejects(checkFlightAvailability({apiKey:'k',selection,fetchImpl:async()=>{throw new Error('transport');}}));assert.equal((await apiUsage()).calls-before,1);
});

test('exact live trips use documented trip shape and keep missing prices unknown',async()=>{
 const r=await checkFlightAvailability({apiKey:'k',selection,commercialLive:true,liveSource:'united',fetchImpl:async()=>response({data:[trip({Source:'united',MileageCost:null,TotalTaxes:null})]})});
 assert.equal(r.evidence.method,'live');assert.equal(r.match.mileageCost,null);assert.equal(r.match.totalTaxes,null);
});

test('adapter diagnostics contain only bounded completion metadata and no key, route or raw body',async()=>{
 const {readJson}=await import('../lib/store.mjs');const {dataFile}=await import('../lib/paths.mjs');
 const doc=await readJson(dataFile('diagnostics.json'),{});
 const serialized=JSON.stringify(doc);assert.ok(!serialized.includes('CANARY-SECRET'));assert.ok(!serialized.includes('JFK'));assert.ok(!serialized.includes('AvailabilitySegments'));
 assert.ok(doc.requests.some(e=>e.operation==='seats.live'));assert.ok(doc.requests.some(e=>e.operation==='rooms.refresh'));
 assert.ok(doc.sourceStatus.seatsaero.providerObservedMaxAt);assert.ok(doc.sourceStatus.roomsaero.providerObservedMaxAt);
});
