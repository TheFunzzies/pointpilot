import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.POINTPILOT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'pp-group-cash-'));
const { googleFlights } = await import('../lib/serpapi.mjs');
const { priceFare, searchCash, cashForItinerary, recordFares, baselines, dealInfo } = await import('../lib/cash.mjs');
const { updateSettings } = await import('../lib/settings.mjs');
const { setFlights, updateTripSettings, searchPositioning, setPositioning, getTripPlan } = await import('../lib/tripplan.mjs');
const { createAlert, runMonitor, setNotifier } = await import('../lib/monitor.mjs');
const date = '2027-08-05', back = '2027-08-12';
const nativeFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = nativeFetch; });
const response = body => ({ ok: true, status: 200, json: async () => body });
const itinerary = (amount, origin='JFK', destination='HND') => ({ price: amount, flights: [{ departure_airport: { id: origin, time: `${date} 08:00` }, arrival_airport: { id: destination, time: `${date} 10:00` } }] });
const route = { origin:'JFK', destination:'HND', departDate:date, returnDate:null, cabin:'economy', source:'google', price:700 };

test('normalization never doubles group totals, and never derives totals from unknown group units', () => {
  const confirmed = priceFare({...route, pricing:{amount:1700,amountBasis:'group',queriedAdults:3,completeItinerary:true}},3);
  assert.equal(confirmed.total,1700); assert.equal(confirmed.perTraveler,1700/3);
  assert.equal(priceFare(confirmed,3).total,1700);
  const unknown = priceFare({...route,pricing:{amount:1700,amountBasis:'unknown',queriedAdults:3}},3);
  assert.equal(unknown.total,null); assert.equal(unknown.exactComparable,false);
  const cached = priceFare({...route,source:'travelpayouts'},3);
  assert.equal(cached.total,2100);assert.equal(cached.pricing.queriedAdults,1);assert.equal(cached.pricing.estimated,true);
  assert.match(cached.pricingLabel,/group availability not checked/);
  assert.equal(priceFare(route,1).total,700);
});

test('SerpApi sends real counts and isolates cache, clones and incomplete round trips', async () => {
  const seen=[]; const fetchImpl=async url=>{const n=Number(new URL(url).searchParams.get('adults'));seen.push(n);return response({best_flights:[itinerary(n===1?700:1900)]});};
  const query={apiKey:'group-cache',origins:['JFK'],destinations:['HND'],departDate:date,returnDate:back,fetchImpl};
  const [one,three]=await Promise.all([googleFlights({...query,adults:1}),googleFlights({...query,adults:3})]);
  assert.equal(one.fares[0].price,700);assert.equal(three.fares[0].price,1900);
  assert.equal(three.fares[0].pricing.amountBasis,'unknown');assert.equal(three.fares[0].pricing.completeItinerary,false);
  three.fares[0].pricing.amount=0;
  assert.equal((await googleFlights({...query,adults:3})).fares[0].pricing.amount,1900);
  assert.deepEqual(seen.sort(),[1,3]);
  await assert.rejects(googleFlights({...query,adults:10}),e=>e.status===400);
});

test('nonlinear group quotes and independent one-adult estimates survive search and comparison', async () => {
  await updateSettings({serpApiKey:'nonlinear',travelpayoutsToken:''});
  const counts=[];globalThis.fetch=async url=>{const n=Number(new URL(url).searchParams.get('adults'));counts.push(n);return response({best_flights:[itinerary(n===1?700:1900)]});};
  const r=await searchCash({origins:'JFK',destination:'HND',departDate:date,returnDate:back,travelers:3,useGoogle:true});
  assert.equal(r.fares[0].price,1900);assert.equal(r.fares[0].total,null);assert.equal(r.fares[0].oneAdultEstimate.amount,2100);
  assert.equal(r.google.fares[0].pricing.requestedAdults,3);assert.match(r.fares[0].pricingLabel,/basis unconfirmed/);
  const c=await cashForItinerary({...route,returnDate:back,travelers:3});
  assert.equal(c.total,null);assert.equal(c.oneAdultEstimate.amount,2100);assert.equal(c.exactComparable,false);
  assert.deepEqual(counts,[3,1]);
});

test('no group result still exposes the separately labeled single-adult estimate', async () => {
  await updateSettings({serpApiKey:'empty-group',travelpayoutsToken:''});
  globalThis.fetch=async url=>response({best_flights:new URL(url).searchParams.get('adults')==='1'?[itinerary(700)]:[]});
  const c=await cashForItinerary({...route,travelers:2});
  assert.equal(c.available,false);assert.equal(c.total,null);assert.equal(c.oneAdultEstimate.amount,1400);
  const r=await searchCash({origins:'JFK',destination:'HND',departDate:date,travelers:2,useGoogle:true});
  assert.equal(r.fares.length,0);assert.equal(r.google.oneAdultEstimates[0].amount,1400);
});

test('history scopes party, dates, cabin, currency and basis', async () => {
  const fare=priceFare({...route,source:'travelpayouts',price:900},3);
  for(const ago of [2,3,4]) await recordFares([fare],new Date(Date.now()-ago*86400000).toISOString());
  const base=await baselines();assert.equal(dealInfo(fare,base).baselineDays,3);
  for(const changed of [priceFare(fare,2),{...fare,departDate:'2027-08-06'},{...fare,cabin:'business'},{...fare,pricing:{...fare.pricing,amountBasis:'group'}},{...fare,pricing:{...fare.pricing,currency:'EUR'}},priceFare(fare,1)]) assert.equal(dealInfo(changed,base).baselineDays,0);
});

test('positioning sends actual party and excludes unknown Google group cash from summary', async () => {
  await updateSettings({serpApiKey:'positioning-group',travelpayoutsToken:'',seatsAeroApiKey:''});
  await setFlights({outbound:{id:'position-award',origin:'JFK',destination:'HND',date,cabin:'business',program:'united',mileageCost:1000,totalTaxes:0}});
  await updateTripSettings({travelers:3,home:{origin:'BOS'}});
  const counts=[];globalThis.fetch=async url=>{const n=Number(new URL(url).searchParams.get('adults'));counts.push(n);return response({best_flights:[itinerary(n===1?200:800,'BOS','JFK')]});};
  const r=await searchPositioning({direction:'outbound',date});assert.equal(r.cash[0].total,null);assert.equal(r.cash[0].oneAdultEstimate.amount,600);assert.deepEqual(counts,[3,1]);
  await setPositioning('outbound',r.cash[0]);
  const plan=await getTripPlan();assert.equal(plan.summary.cashUsd,0);assert.equal(plan.summary.cashPricingUncertain,true);assert.match(plan.summary.warnings.join(' '),/basis unconfirmed/);
});

test('group monitor targets use estimated party total and label live group verification', async () => {
  await updateSettings({serpApiKey:'monitor-group',travelpayoutsToken:'monitor-group',desktopNotifications:true});
  const counts=[];globalThis.fetch=async url=>{const u=new URL(url);if(u.hostname==='serpapi.com'){counts.push(u.searchParams.get('adults'));return response({best_flights:[itinerary(1100)]});}return response({currency:'usd',data:[{origin_airport:'JFK',destination_airport:'HND',departure_at:date+'T09:00:00Z',price:400,transfers:0}]});};
  const notes=[];setNotifier(n=>notes.push(n));
  await createAlert({kind:'cash',origins:'JFK',destination:'HND',departDate:date,travelers:3,targetPrice:500,dealPct:0});
  assert.equal((await runMonitor()).results.find(x=>x.kind==='cash').isNew,false);
  await createAlert({kind:'cash',origins:'JFK',destination:'HND',departDate:date,travelers:3,targetPrice:1300,dealPct:0});
  await runMonitor();assert.match(notes.at(-1).body,/\$1,200/);assert.match(notes.at(-1).body,/group availability not checked/);assert.match(notes.at(-1).body,/basis unconfirmed/);assert.deepEqual(counts,['3']);
});


test('missing one-adult estimate preserves the group amount without inventing a total', async () => {
  await updateSettings({serpApiKey:'single-failure',travelpayoutsToken:''});
  globalThis.fetch=async url=>{
    if(new URL(url).searchParams.get('adults')==='1') throw new Error('offline');
    return response({best_flights:[itinerary(1900)]});
  };
  const c=await cashForItinerary({...route,travelers:3});
  assert.equal(c.available,true);assert.equal(c.pricing.amount,1900);assert.equal(c.total,null);assert.equal(c.oneAdultEstimate,null);assert.equal(c.exactComparable,false);assert.deepEqual(c.warnings,['One-adult estimate unavailable.']);
});

test('history interprets pre-metadata rows as single adult without sharing with groups', async () => {
  const { writeJson }=await import('../lib/store.mjs');
  const legacy={origin:'BOS',destination:'JFK',tripType:'ow',cabin:'economy',departDate:date,returnDate:null,price:200,source:'travelpayouts'};
  await writeJson(path.join(process.env.POINTPILOT_DATA_DIR,'cash-history.json'),[2,3,4].map(ago=>({...legacy,observedDay:new Date(Date.now()-ago*86400000).toISOString().slice(0,10)})));
  const base=await baselines();
  assert.equal(dealInfo(priceFare(legacy,1),base).baselineDays,3);
  assert.equal(dealInfo(priceFare(legacy,2),base).baselineDays,0);
});
