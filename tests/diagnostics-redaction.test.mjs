import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics } from '../lib/diagnostics.mjs';
import { redactString, redactObject } from '../lib/redact.mjs';

const canaries=['api_key=alpha-canary','Password:pw-canary','https://user-canary:pass-canary@host.example/webhook/path-canary?token=query-canary#fragment-canary','C:\\Users\\Alice\\AppData\\PointPilot\\wallet-canary','/Users/Alice/Library/Application Support/PointPilot/wallet-canary','Bearer oauth-canary','departure_token_canary','<img src=x onerror=wallet-canary>','api%255Fkey%253Dencoded-canary'];
test('redaction strips secret-bearing URLs, paths, and secret-valued fields', () => {
  for(const c of canaries) { const s=redactString(c); for(const needle of ['alpha-canary','pw-canary','user-canary','pass-canary','path-canary','query-canary','fragment-canary','Alice','wallet-canary','oauth-canary','departure_token_canary']) assert.equal(s.includes(needle),false,`${needle} leaked from ${c}`); }
  assert.deepEqual(redactObject({Authorization:'auth-canary',nested:[{X_Access_Token:'token-canary',safe:'ok'}],unknown:'safe'}),{nested:[{safe:'ok'}],unknown:'safe'});
  assert.deepEqual(redactObject({'ＰＡＳＳＷＯＲＤ':'unicode-canary',ApiKey:'api-canary',rows:[{Cookie:'cookie-canary',safe:'retained'}]}),{rows:[{safe:'retained'}]});
});
test('diagnostics never serialize provider raw data or unknown fields', async () => {
  let doc; const store={readJson:async(_f,f)=>doc??f,updateJson:async(_f,f,fn)=>{doc=fn(doc??structuredClone(f));return doc;}};
  const d=createDiagnostics({store,appInfo:{version:'1.2.3',platform:'win32',mode:'desktop'},usage:{calls:4,api_key:'key-canary'},monitor:[{id:'opaque-alert-id',kind:'cash',active:true,title:'private-title-canary',deliveryState:{webhook:{target:'https://host/webhook/secret-path-canary?token=webhook-canary',status:'error',error:'pass-canary'}}}]});
  await d.recordRequest({service:'serpapi',operation:'google.flights',method:'GET',status:429,outcome:'http-error',errorCode:'SERPAPI_LIMIT',api_key:'key-canary',requestId:'1234567890abcdef'});
  const serialized=JSON.stringify((await d.preview()).bundle);
  for(const c of ['key-canary','private-title-canary','secret-path-canary','webhook-canary','pass-canary','opaque-alert-id','target']) assert.equal(serialized.includes(c),false,`${c} leaked`);
  assert.match(serialized,/pointpilot-diagnostics/); assert.match(serialized,/"calls":4/);
});
test('provider thrown errors and raw body canaries never enter persisted records or bundles', async () => {
  const rows=[]; const o=(await import('../lib/request-observer.mjs')).createRequestObserver({record:async e=>rows.push(e),source:async()=>false});
  await assert.rejects(o.observeRequest({service:'serpapi',operation:'google.flights',method:'GET'},async()=>{throw Object.assign(new Error('pw-canary wallet-canary /Users/Alice/private'),{code:'api_key=error-canary'});}),/pw-canary/);
  const bundle=JSON.stringify(rows);
  for(const c of ['pw-canary','wallet-canary','Alice','error-canary','api_key']) assert.equal(bundle.includes(c),false,`${c} leaked`);
  assert.equal(rows.length,1); assert.equal(rows[0].outcome,'transport-error');
});
