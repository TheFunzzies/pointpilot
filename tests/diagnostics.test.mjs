import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../lib/diagnostics.mjs';
import { createRequestObserver } from '../lib/request-observer.mjs';

function fakeStore(initial = null) {
  let value = initial;
  return { readJson:async (_file,fallback)=>structuredClone(value ?? fallback), updateJson:async (_file,fallback,mutate)=>{const doc=structuredClone(value??fallback);const next=await mutate(doc);value=structuredClone(next===undefined?doc:next);return value;}, get:()=>value };
}
test('preview and export use staged bytes and expire after five minutes', async () => {
  let now=1000000; const d=createDiagnostics({store:fakeStore(),now:()=>now,randomBytes:n=>Buffer.alloc(n,1),appInfo:{version:'0.14.0',platform:'win32',mode:'browser',hostname:'sensitive'}});
  const p=await d.preview(); assert.equal(p.bundle.format,'pointpilot-diagnostics'); assert.equal(p.bundle.app.hostname,undefined);
  await d.recordRequest({service:'serpapi',operation:'google.flights',method:'GET',status:200,outcome:'ok',durationMs:4,requestId:'1234567890abcdef'});
  assert.deepEqual((await d.exportBundle(p.exportId)).bundle,p.bundle);
  now+=300001; await assert.rejects(d.exportBundle(p.exportId),e=>e.code==='DIAGNOSTICS_PREVIEW_EXPIRED');
});
test('observer preserves the original result and records only closed event fields', async () => {
  const events=[]; const o=createRequestObserver({record:async e=>events.push(e),now:(()=>{let n=0;return()=>++n;})()});
  const response={ok:false,status:429,headers:{Authorization:'canary'}};
  assert.equal(await o.observeRequest({service:'reference',operation:'reference.transfers',method:'GET'},async()=>response),response);
  assert.deepEqual(Object.keys(events[0]).sort(),['at','durationMs','errorCode','method','operation','outcome','requestId','service','status'].sort());
  assert.equal(events[0].status,429); assert.equal(events[0].outcome,'http-error');
});
test('observer maps seats.aero and rooms.aero authentication and quota responses', async () => {
  const events=[]; const o=createRequestObserver({record:async e=>events.push(e),source:async()=>false});
  for (const [service,operation,method,expected] of [
    ['seatsaero','seats.search','GET',[[401,'SEATS_AUTH'],[403,'SEATS_AUTH'],[429,'SEATS_RATE_LIMIT']]],
    ['roomsaero','rooms.availability','GET',[[401,'ROOMS_AUTH'],[403,'ROOMS_AUTH'],[429,'ROOMS_RATE_LIMIT']]],
  ]) {
    for (const [status,errorCode] of expected) {
      await o.observeRequest({service,operation,method},async()=>({ok:false,status}));
      assert.equal(events.at(-1).outcome,'http-error');
      assert.equal(events.at(-1).errorCode,errorCode,`${service} ${status}`);
    }
  }
});
test('retention bounds requests and clear history drops logs but not injected usage', async () => {
  let now=Date.now(); const store=fakeStore(); const d=createDiagnostics({store,now:()=>now});
  for(let i=0;i<510;i++) await d.recordRequest({service:'seatsaero',operation:'seats.search',method:'GET',status:200,outcome:'ok',at:new Date(now-i).toISOString(),requestId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`});
  assert.equal((await d.preview()).bundle.requests.length,500);
  await d.clearHistory(); assert.equal((await d.preview()).bundle.requests.length,0);
});
test('diagnostic storage failures remain best-effort and coverage reports the gap', async () => {
  const store={readJson:async()=>{throw new Error('wallet-canary storage failed');},updateJson:async()=>{throw new Error('write-canary');}};
  const d=createDiagnostics({store});
  assert.equal(await d.recordRequest({service:'reference',operation:'reference.transfers',method:'GET',status:200,outcome:'ok'}),false);
  const p=await d.preview(); assert.equal(p.bundle.coverage.persistence,'unavailable');
  assert.equal(JSON.stringify(p.bundle).includes('wallet-canary'),false);
});
test('mapper freshness summaries preserve their observed row sample count', async () => {
  const d=createDiagnostics({store:fakeStore()});
  await d.recordSourceObservation({source:'seatsaero',sampleCount:7,providerObservedMinAt:'2026-10-19T00:00:00Z',providerObservedMaxAt:'2026-10-20T00:00:00Z',completeness:'complete'});
  assert.equal((await d.preview()).bundle.freshness.seatsaero.sampleCount,7);
});
