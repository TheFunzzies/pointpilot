import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, validateUser, validateAlertDefinitions } from '../lib/settings.mjs';
import { withMonitorPaused, validateAlertDefinition } from '../lib/monitor.mjs';

test('restore validators are pure, normalize, exclude secrets, and deactivate alerts', () => {
  const settings=validateSettings({monitorIntervalMinutes:60,serpApiKey:'secret',webhookUrl:'https://hook.example'});
  assert.equal(settings.serpApiKey,''); assert.equal(settings.webhookUrl,'');
  assert.equal(validateSettings({serpApiKey:'restorable-key'},{allowSecrets:true}).serpApiKey,'restorable-key');
  const user=validateUser({balances:[],preferences:{preferNonstop:true}}); assert.deepEqual(user.preferences,{preferNonstop:true});
  const alerts=validateAlertDefinitions([{id:'alert-1',kind:'cash',title:'Trip',active:true,query:{origins:'JFK',destination:'LHR',departDate:'2027-01-01'},deliveryState:{webhook:{target:'https://secret'}}}]);
  assert.equal(alerts[0].active,false); assert.equal(alerts[0].deliveryState,undefined);
  assert.throws(()=>validateSettings({mystery:true}),e=>e.code==='INVALID_RESTORE_DATA');
  assert.throws(()=>validateAlertDefinitions([{id:'x',kind:'bogus',query:{}}]));
  const tracked=validateAlertDefinition({id:'tracked',kind:'award',title:'Tracked',createdAt:'2026-10-20T00:00:00.000Z',query:{origins:'JFK',destination:'LHR',departDate:'2027-01-01',returnDate:null},verifyWithGoogle:false,track:{mode:'exact',legs:[{leg:'Outbound',date:'2027-01-01',flightNumbers:['AA100'],program:null,programName:null,mileageCost:65000,seatScore:null,product:null}]},lastResult:{private:true}});
  assert.equal(tracked.active,false); assert.equal(tracked.track.mode,'exact'); assert.equal(tracked.createdAt,'2026-10-20T00:00:00.000Z'); assert.equal(tracked.query.returnDate,null); assert.equal(tracked.verifyWithGoogle,false); assert.equal(tracked.lastResult,undefined);
  const product=validateAlertDefinition({id:'product',kind:'award',query:{origins:'JFK',destination:'LHR',departDate:'2027-01-01'},track:{mode:'product',product:'Qsuite',productLabel:null,legs:[]}});
  assert.equal(product.track.productLabel,null); assert.deepEqual(product.track.legs,[]);
});
test('withMonitorPaused awaits fn and resumes after rejection', async () => {
  const value=await withMonitorPaused(async()=>42); assert.equal(value,42);
  await assert.rejects(withMonitorPaused(async()=>{throw new Error('expected');}),/expected/);
  assert.equal(await withMonitorPaused(async()=>true),true);
});
