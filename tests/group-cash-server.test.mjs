import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.POINTPILOT_DATA_DIR=mkdtempSync(path.join(os.tmpdir(),'pp-group-cash-server-'));
process.env.POINTPILOT_REFERENCE_URL='http://127.0.0.1:9/unreachable.json';
const { startServer }=await import('../server.mjs');
const { updateSettings }=await import('../lib/settings.mjs');
const nativeFetch=globalThis.fetch;
const counts=[];
globalThis.fetch=async (url,options)=>{
  const u=new URL(String(url));
  if(u.hostname!=='serpapi.com' && u.hostname!=='api.travelpayouts.com') return nativeFetch(url,options);
  if(u.hostname==='api.travelpayouts.com') return {ok:true,status:200,json:async()=>({currency:'usd',data:[{origin_airport:'JFK',destination_airport:'HND',departure_at:'2027-08-05T08:00:00Z',price:600}]})};
  const n=Number(u.searchParams.get('adults'));counts.push(n);
  return {ok:true,status:200,json:async()=>({best_flights:[{price:n===1?700:1800,flights:[{departure_airport:{id:'JFK',time:'2027-08-05 08:00'},arrival_airport:{id:'HND',time:'2027-08-05 10:00'}}]}]})};
};
const server=await new Promise(resolve=>{const s=startServer({port:0,monitor:false,onReady:()=>resolve(s)});});
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{globalThis.fetch=nativeFetch;server.close();});
const post=(route,body)=>nativeFetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('registered cash routes expose raw group quote and separate estimate without exact savings',async()=>{
  await updateSettings({serpApiKey:'group-http',travelpayoutsToken:''});
  const query={origins:'JFK',origin:'JFK',destination:'HND',departDate:'2027-08-05',returnDate:'2027-08-12',travelers:3,useGoogle:true};
  const res=await post('/api/cash/search',query);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
  const search=await res.json();assert.equal(search.fares[0].total,null);assert.equal(search.fares[0].price,1800);assert.equal(search.fares[0].oneAdultEstimate.amount,2100);assert.equal(search.fares[0].pricing.completeItinerary,false);
  const comparison=await (await post('/api/cash/itinerary',query)).json();assert.equal(comparison.total,null);assert.equal(comparison.perTraveler,null);assert.equal(comparison.exactComparable,false);assert.match(comparison.pricingLabel,/basis unconfirmed/);assert.deepEqual(counts,[3,1]);
  const bad=await post('/api/cash/search',{...query,travelers:10});assert.equal(bad.status,400);assert.deepEqual(counts,[3,1]);
});

test('cached group estimates and legacy one adult retain their distinct HTTP totals',async()=>{
  await updateSettings({serpApiKey:'',travelpayoutsToken:'group-http'});
  const query={origins:'JFK',origin:'JFK',destination:'HND',departDate:'2027-08-05',travelers:3};
  const group=await (await post('/api/cash/itinerary',query)).json();assert.equal(group.total,1800);assert.equal(group.pricing.queriedAdults,1);assert.equal(group.pricing.estimated,true);assert.equal(group.exactComparable,false);assert.match(group.pricingLabel,/group availability not checked/);
  const single=await (await post('/api/cash/itinerary',{...query,travelers:1})).json();assert.equal(single.total,600);assert.equal(single.perTraveler,600);assert.equal(single.exactComparable,true);
});
