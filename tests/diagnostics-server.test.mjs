import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutes } from '../lib/diagnostics-routes.mjs';

test('diagnostics route factory strictly validates requests and returns preview/export envelopes', async () => {
  const d={preview:async()=>({exportId:'a'.repeat(48),expiresAt:'2026-10-20T12:00:00.000Z',summary:{},bundle:{format:'pointpilot-diagnostics'}}),exportBundle:async()=>({filename:'safe.json',bundle:{format:'pointpilot-diagnostics'}}),clearHistory:async()=>({ok:true})};
  const route=createRoutes({diagnostics:d});
  assert.equal((await route({method:'POST',path:'/api/diagnostics/preview',body:{bad:true}})).status,400);
  assert.equal((await route({method:'POST',path:'/api/diagnostics/preview',body:null})).status,400);
  assert.deepEqual(await route({method:'POST',path:'/api/diagnostics/preview',body:{}}),{status:200,payload:await d.preview()});
  assert.equal((await route({method:'POST',path:'/api/diagnostics/export',body:{exportId:'a'.repeat(48)}})).status,200);
  assert.equal((await route({method:'DELETE',path:'/api/diagnostics/history',body:{}})).payload.ok,true);
  assert.equal(await route({method:'GET',path:'/api/unknown',body:{}}),null);
});
test('expired export maps to stable conflict error', async () => {
  const route=createRoutes({diagnostics:{preview:async()=>{},exportBundle:async()=>{throw Object.assign(new Error('expired'),{status:409,code:'DIAGNOSTICS_PREVIEW_EXPIRED'});},clearHistory:async()=>({ok:true})}});
  assert.deepEqual(await route({method:'POST',path:'/api/diagnostics/export',body:{exportId:'b'.repeat(48)}}),{status:409,payload:{error:'expired',code:'DIAGNOSTICS_PREVIEW_EXPIRED'}});
});
