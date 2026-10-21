import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(os.tmpdir(),'pp-readiness-service-'));
process.env.POINTPILOT_DATA_DIR=dir;
test.after(()=>rm(dir,{recursive:true,force:true}));
const { createReadinessService, planHashFor, FRESHNESS_MS }=await import('../lib/readiness.mjs');
const { createRoutes }=await import('../lib/readiness-routes.mjs');
const { normalizeTripPlan, normalizeStayPlan }=await import('../lib/itinerary.mjs');
const now=Date.parse('2026-10-20T12:00:00Z');
const award={id:'a',program:'united',origin:'JFK',destination:'LHR',date:'2027-01-01',cabin:'business',mileageCost:50000,totalTaxes:0,dataSource:'seats.aero',flight:{departUtc:'2027-01-01T12:00:00Z',arriveUtc:'2027-01-01T19:00:00Z',flightNumbers:['UA1']}};
function harness(extra={}) {
  let clock=now;
  const ctx={scope:'trip',trip:normalizeTripPlan({flights:{outbound:award},travelers:2}),stay:normalizeStayPlan({stays:[]}),user:{balances:[{code:'united',balance:100000}]},settings:{seatsAeroApiKey:'SECRET-CANARY'},transfers:{banks:{},programs:{},lastUpdated:'2026-10-20'}};
  let state={schemaVersion:1,reports:{trip:null,stay:null},confirmations:[]};
  const deps={loadContext:async scope=>({...structuredClone(ctx),scope}),readState:async()=>structuredClone(state),mutateState:async fn=>{const next=structuredClone(state);await fn(next);state=next;},now:()=>clock,flightCheck:async()=>({evidence:{method:'cached',requestedAt:new Date(clock).toISOString(),observedAt:new Date(clock).toISOString(),source:'seats.aero',complete:true},code:'MATCHED',match:{mileageCost:50000,totalTaxes:0,remainingSeats:2}}),...extra};
  const service=createReadinessService(deps);
  return {ctx,service,routes:createRoutes({service}),state:()=>state,clock:v=>{clock=v;}};
}
const post=(path,body)=>({method:'POST',path:`/api/booking-readiness/${path}`,body});

test('GET makes no provider calls, empty plan conflicts and stale expected hash conflicts',async()=>{
  const h=harness({flightCheck:()=>{throw new Error('must not fetch');}});
  assert.equal((await h.service.get({scope:'trip'})).report,null);
  await assert.rejects(h.service.check({scope:'trip',expectedPlanHash:'0'.repeat(64)}),{code:'PLAN_CHANGED'});
  h.ctx.trip.segments=[];await assert.rejects(h.service.check({scope:'trip'}),{code:'EMPTY_PLAN'});
});
test('malformed and unknown request fields fail before service/provider work',async()=>{
  const h=harness();
  for(const b of [null,[],{scope:'bad'},{scope:'trip',extra:true},{scope:'trip',expectedPlanHash:42}])await assert.rejects(h.routes(post('check',b)),{status:400});
  for(const sourceUrl of ['http://united.com','https://u:p@united.com','https://united.com/?key=secret'])await assert.rejects(h.routes(post('confirmations',{scope:'trip',planHash:'a'.repeat(64),selectionId:'outbound',itemCode:'SEATS_UNKNOWN',sourceUrl})),{status:400});
  await assert.rejects(h.routes(post('confirmations',{scope:'trip',planHash:'a'.repeat(64),selectionId:'outbound',itemCode:'FEES_UNKNOWN',sourceUrl:'https://united.com/',amount:{currency:'AAA',value:0}})),{status:400});
  assert.equal(await h.routes({method:'GET',path:'/other'}),null);
});
test('check persists only latest report and report expiry/context invalidation are explicit',async()=>{
  const h=harness();const original=structuredClone(h.ctx.user);
  const {payload:{report}}=await h.routes(post('check',{scope:'trip'}));assert.equal(report.verdict,'Caution');assert.equal(h.state().reports.trip.id,report.id);
  assert.equal((await h.service.get({scope:'trip'})).current,true);
  assert.ok(!JSON.stringify(report).includes('SECRET-CANARY'));assert.deepEqual(h.ctx.user,original);
  h.clock(now+FRESHNESS_MS);assert.equal((await h.service.get({scope:'trip'})).current,false);
  h.clock(now);h.ctx.user.balances[0].balance--;assert.equal((await h.service.get({scope:'trip'})).current,false);
});
test('auth/quota/partial provider failures return completed unknown items with HTTP 200',async()=>{
  for(const code of ['API_AUTH','API_RATE_LIMIT','TIMEOUT']){
    const h=harness({flightCheck:async()=>{throw Object.assign(new Error('SECRET-CANARY raw-body'),{code});}});
    const result=await h.routes(post('check',{scope:'trip'}));assert.equal(result.status,200);assert.equal(result.payload.report.verdict,'Caution');assert.ok(result.payload.report.items.some(i=>i.code==='AVAILABILITY_UNVERIFIED'));assert.ok(!JSON.stringify(result).includes('SECRET-CANARY'));
  }
  const h=harness({flightCheck:async()=>({evidence:{method:'cached',complete:false,source:'seats.aero'},match:{mileageCost:50000,totalTaxes:0,remainingSeats:2}})});
  assert.ok((await h.service.check({scope:'trip'})).report.items.some(i=>i.code==='EVIDENCE_INCOMPLETE'));
});
test('deadline yields unknown evidence even when an injected provider never settles',async()=>{
  const h=harness({deadlineMs:10,flightCheck:()=>new Promise(()=>{})});
  assert.equal((await h.service.check({scope:'trip'})).report.verdict,'Caution');
});
test('concurrent identical checks coalesce; changed plans cannot attach an old result',async()=>{
  let resolve,calls=0;const wait=new Promise(r=>{resolve=r;});
  const h=harness({flightCheck:async()=>{calls++;await wait;return {evidence:{method:'cached',complete:true},match:null};}});
  const first=h.service.check({scope:'trip'});const second=h.service.check({scope:'trip'});
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);resolve();const [a,b]=await Promise.all([first,second]);assert.equal(a.report.id,b.report.id);
  let finish;const blocked=new Promise(r=>{finish=r;});const changed=harness({flightCheck:async()=>{await blocked;return {};}});
  const work=changed.service.check({scope:'trip'});await new Promise(r=>setImmediate(r));changed.ctx.trip.revision++;finish();await assert.rejects(work,{code:'PLAN_CHANGED'});assert.equal(changed.state().reports.trip,null);
});
test('availability concurrency is capped at two and six-leg/twenty-stay limits are enforced',async()=>{
  let running=0,max=0;const h=harness({flightCheck:async()=>{running++;max=Math.max(max,running);await new Promise(r=>setImmediate(r));running--;return {};}});
  h.ctx.trip.segments=Array.from({length:6},(_,i)=>({id:`leg${i}`,award}));await h.service.check({scope:'trip'});assert.equal(max,2);
  h.ctx.trip.segments.push({id:'extra',award});await assert.rejects(h.service.check({scope:'trip'}),{code:'PLAN_LIMIT'});
});
test('user confirmation is scoped, server timestamped and cannot erase a Stop',async()=>{
  const h=harness();const {report}=await h.service.check({scope:'trip'});
  const body={scope:'trip',planHash:report.planHash,selectionId:'outbound',itemCode:'AVAILABILITY_CACHED',sourceUrl:'https://www.united.com/'};
  const r=await h.routes(post('confirmations',body));assert.equal(r.payload.report.verdict,'Go');assert.equal(h.state().confirmations[0].confirmedAt,new Date(now).toISOString());
  assert.equal(r.payload.report.items.find(i=>i.code==='AVAILABILITY_CACHED').evidence.method,'manual');
  await assert.rejects(h.routes(post('confirmations',{...body,itemCode:'FUNDED'})),{status:400});
  h.clock(now+FRESHNESS_MS);await assert.rejects(h.routes(post('confirmations',body)),{code:'PLAN_CHANGED'});
});
test('hotel refresh resolves saved identity, reports quota metadata and invalidates reports',async()=>{
  let hotelId;const h=harness({refresh:async args=>{hotelId=args.hotelId;return {status:'queued',requestedAt:new Date(now).toISOString(),nextCheckAfter:new Date(now+60000).toISOString(),allowanceMessage:'shared daily allowance'};}});
  h.ctx.stay.stays=[{id:'stay1',hotelId:'hotel1',dataSource:'rooms.aero',program:'hyatt',nights:1,totalPoints:10000}];
  const planHash=planHashFor(h.ctx);const r=await h.routes(post('hotel-refresh',{scope:'trip',planHash,stayId:'stay1'}));assert.equal(r.status,202);assert.equal(hotelId,'hotel1');assert.equal(h.state().reports.trip,null);
  const q=harness({refresh:async()=>{throw Object.assign(new Error('quota'),{status:429,retryAfter:100});}});q.ctx.stay.stays=h.ctx.stay.stays;
  const failure=await q.routes(post('hotel-refresh',{scope:'trip',planHash:planHashFor(q.ctx),stayId:'stay1'}));assert.equal(failure.status,429);assert.equal(failure.payload.retryAfter,100);
});

test('hotel refresh status checks are delayed, capped, and completed only on a newer observation',async()=>{
 let calls=0;const h=harness({refresh:async()=>({status:'queued',requestedAt:new Date(now).toISOString(),nextCheckAfter:new Date(now+60000).toISOString()}),hotelCheck:async()=>{calls++;return {evidence:{method:'cached',observedAt:new Date(now-60000).toISOString()}};}});
 h.ctx.stay.stays=[{id:'stay1',hotelId:'hotel1',sourceUpdatedAt:new Date(now-60000).toISOString(),dataSource:'rooms.aero',program:'hyatt',nights:1,totalPoints:10000}];
 const args={scope:'trip',planHash:planHashFor(h.ctx),stayId:'stay1'};
 await h.service.hotelRefresh(args);
 assert.equal((await h.service.hotelRefreshStatus(args)).status,'queued');assert.equal(calls,0);
 for(let i=1;i<=4;i++){h.clock(now+i*60000);await h.service.hotelRefreshStatus(args);}assert.equal(calls,3);assert.equal((await h.service.hotelRefreshStatus(args)).status,'unknown');
 const completed=harness({refresh:async()=>({status:'queued',requestedAt:new Date(now).toISOString(),nextCheckAfter:new Date(now+60000).toISOString()}),hotelCheck:async()=>({evidence:{method:'cached',observedAt:new Date(now+1000).toISOString()}})});
 completed.ctx.stay.stays=h.ctx.stay.stays;await completed.service.hotelRefresh(args);completed.clock(now+60000);
 const result=await completed.routes({method:'GET',path:'/api/booking-readiness/hotel-refresh',query:args});assert.equal(result.payload.status,'completed');assert.equal(result.payload.checksRemaining,2);
});

test('registered loopback routes preserve security, no-store, plan conflicts and manual-evidence labels',async t=>{
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url).startsWith('http://127.0.0.1:')?nativeFetch(url,options):Promise.reject(new Error('External calls disabled in readiness server test'));
  const { startServer }=await import('../server.mjs');
  const { writeJson, readJson }=await import('../lib/store.mjs');
  const { dataFile }=await import('../lib/paths.mjs');
  const server=await new Promise(resolve=>{const s=startServer({port:0,monitor:false,onReady:()=>resolve(s)});});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));globalThis.fetch=nativeFetch;});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(suffix,body,headers={})=>nativeFetch(base+'/api/booking-readiness'+suffix,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await request('/check',{scope:'trip'},{origin:'https://foreign.example'})).status,403);
  const empty=await request('/check',{scope:'trip'});assert.equal(empty.status,409);assert.equal((await empty.json()).code,'EMPTY_PLAN');
  assert.equal((await request('/check',{scope:'trip',unknown:true})).status,400);
  const plan=normalizeTripPlan({flights:{outbound:award},travelers:2});
  await writeJson(dataFile('trip-plan.json'),plan);await writeJson(dataFile('stay-plan.json'),{stays:[]});await writeJson(dataFile('settings.json'),{});
  const wallet={balances:[{code:'united',balance:100000}],preferences:{}};await writeJson(dataFile('user.json'),wallet);
  assert.equal((await request('/check',{scope:'trip',expectedPlanHash:'0'.repeat(64)})).status,409);
  const checked=await request('/check',{scope:'trip'});assert.equal(checked.status,200);assert.equal(checked.headers.get('cache-control'),'no-store');
  const {report}=await checked.json();assert.equal(report.verdict,'Caution');
  for(const itemCode of ['AVAILABILITY_UNVERIFIED','SEATS_UNKNOWN']){
    const res=await request('/confirmations',{scope:'trip',planHash:report.planHash,selectionId:'outbound',itemCode,sourceUrl:'https://www.united.com/'});assert.equal(res.status,200);
    const body=await res.json();assert.equal(body.report.items.find(i=>i.code===itemCode).evidence.method,'manual');
  }
  const latest=await (await nativeFetch(base+'/api/booking-readiness?scope=trip')).json();assert.equal(latest.current,true);assert.equal(latest.report.verdict,'Go');
  assert.deepEqual(await readJson(dataFile('user.json')),wallet);
  plan.revision++;await writeJson(dataFile('trip-plan.json'),plan);
  assert.equal((await (await nativeFetch(base+'/api/booking-readiness?scope=trip')).json()).current,false);
});

test('readiness checks exact award positioning with all travelers and supports its fee confirmations',async()=>{
 const checked=[];
 const h=harness({flightCheck:async({selection,travelers})=>{checked.push({selection,travelers});return {evidence:{method:'live',requestedAt:new Date(now).toISOString(),observedAt:new Date(now).toISOString(),source:'seats.aero',complete:true},match:{mileageCost:selection.mileageCost,totalTaxes:selection.selectionId==='positioning-outbound'?null:0,remainingSeats:2}};}});
 h.ctx.trip.home.origin='BOS';h.ctx.user.balances[0].balance=120000;
 h.ctx.trip.positioning.outbound={...award,id:'pos',kind:'award',origin:'BOS',destination:'JFK',mileageCost:10000,totalTaxes:null,flight:{departUtc:'2027-01-01T00:00:00Z',arriveUtc:'2027-01-01T02:00:00Z',flightNumbers:['UA2']}};
 const {report}=await h.service.check({scope:'trip'});assert.equal(report.verdict,'Caution');assert.equal(checked.length,2);assert.equal(checked.find(c=>c.selection.selectionId==='positioning-outbound').travelers,2);
 assert.equal(report.items.find(i=>i.selectionId==='positioning-outbound'&&i.code==='FEES_UNKNOWN').status,'unknown');
 const response=await h.routes(post('confirmations',{scope:'trip',planHash:report.planHash,selectionId:'positioning-outbound',itemCode:'FEES_UNKNOWN',amount:{currency:'USD',value:5.6},sourceUrl:'https://www.united.com/'}));
 assert.equal(response.payload.report.items.find(i=>i.selectionId==='positioning-outbound'&&i.code==='FEES_UNKNOWN').evidence.method,'manual');
 h.ctx.trip.positioning.outbound.mileageCost++;assert.equal((await h.service.get({scope:'trip'})).current,false);
});
test('cash positioning is explicit unsupported evidence and never passed to the award or hotel adapter',async()=>{
 let calls=0;const h=harness({flightCheck:async()=>{calls++;return {evidence:{method:'live',complete:true},match:{mileageCost:50000,totalTaxes:0,remainingSeats:2}};},hotelCheck:()=>{throw new Error('Cash is not a hotel');}});
 h.ctx.trip.home.origin='BOS';h.ctx.trip.positioning.outbound={kind:'cash',origin:'BOS',destination:'JFK',price:100,departUtc:'2027-01-01T00:00:00Z',arriveUtc:'2027-01-01T02:00:00Z',source:'google'};
 const {report}=await h.service.check({scope:'trip'});assert.equal(calls,1);assert.equal(report.verdict,'Caution');
 const availability=report.items.find(i=>i.selectionId==='positioning-outbound'&&i.code==='AVAILABILITY_UNVERIFIED');assert.equal(availability.details.providerCode,'UNSUPPORTED_CHECK');assert.equal(availability.evidence.method,'unsupported');
 assert.ok(report.items.some(i=>i.selectionId==='positioning-outbound'&&i.code==='FEES_UNKNOWN'));
});

test('a persisted report missing positioning coverage is stale even before its timestamp expires',async()=>{
 const h=harness();h.ctx.trip.home.origin='BOS';h.ctx.trip.positioning.outbound={kind:'cash',origin:'BOS',destination:'JFK',price:100,departUtc:'2027-01-01T00:00:00Z',arriveUtc:'2027-01-01T02:00:00Z'};
 await h.service.check({scope:'trip'});assert.equal((await h.service.get({scope:'trip'})).current,true);
 h.state().reports.trip.items=h.state().reports.trip.items.filter(i=>i.selectionId!=='positioning-outbound');
 assert.equal((await h.service.get({scope:'trip'})).current,false);
});
