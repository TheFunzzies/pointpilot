import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, verdictFor, planHashFor, contextHashFor, selectionFingerprint, transferTimingItems, FRESHNESS_MS } from '../lib/readiness.mjs';
const now = Date.parse('2026-10-20T12:00:00Z');
const at = new Date(now).toISOString();
const award = () => ({ id: 'selected', program: 'united', origin: 'JFK', destination: 'LHR', date: '2027-01-01', cabin: 'business', mileageCost: 50000, totalTaxes: 0, remainingSeats: null, dataSource: 'seats.aero', flight: { departUtc: '2027-01-01T12:00:00Z', arriveUtc: '2027-01-01T19:00:00Z', flightNumbers: ['UA1'] } });
const context = () => ({ scope: 'trip', trip: { schemaVersion: 2, revision: 0, travelers: 2, segments: [{ id: 'leg1', award: award() }], transitions: [] }, stay: { stays: [] }, user: { balances: [{ code: 'united', balance: 100000 }] }, transfers: { programs: {}, banks: {}, lastUpdated: '2026-10-20' }, now });
const result = (method='live', extra={}) => ({ evidence: { method, requestedAt: at, observedAt: at, source: 'seats.aero', complete: true }, match: { mileageCost: 50000, totalTaxes: 0, remainingSeats: 2, ...extra }, code: 'MATCHED' });

test('deterministic verdict gives Stop precedence over all other evidence', () => {
  assert.equal(verdictFor([]), 'Caution');
  assert.equal(verdictFor([{status:'pass'}]), 'Go');
  assert.equal(verdictFor([{status:'unknown'}, {status:'pass'}]), 'Caution');
  assert.equal(verdictFor([{status:'caution'}, {status:'stop'}, {status:'pass'}]), 'Stop');
});
test('exact live evidence with affordable accepted prices and known zero fees can be Go', () => {
  const report = buildReport({...context(),results:{leg1:result()}});
  assert.equal(report.verdict,'Go');
  assert.equal(Date.parse(report.expiresAt)-Date.parse(report.checkedAt),FRESHNESS_MS);
});
test('cached match is caution; complete cached absence never means sold out', () => {
  assert.equal(buildReport({...context(),results:{leg1:result('cached')}}).verdict,'Caution');
  const r=buildReport({...context(),results:{leg1:{evidence:result('cached').evidence,code:'AVAILABILITY_NOT_FOUND',definitive:false}}});
  assert.equal(r.verdict,'Caution');
  assert.match(r.items.find(i=>i.code==='AVAILABILITY_NOT_FOUND').message,/does not prove/);
});
test('zero seats remain unknown; known shortage and authoritative live loss Stop', () => {
  assert.equal(buildReport({...context(),results:{leg1:result('live',{remainingSeats:0})}}).verdict,'Caution');
  assert.equal(buildReport({...context(),results:{leg1:result('cached',{remainingSeats:1})}}).verdict,'Stop');
  assert.equal(buildReport({...context(),results:{leg1:{...result(),match:null,definitive:true}}}).verdict,'Stop');
});
test('price change cannot silently substitute, and current price funding is recomputed', () => {
  const report=buildReport({...context(),results:{leg1:result('live',{mileageCost:60000})}});
  assert.equal(report.verdict,'Stop');
  assert.ok(report.items.some(i=>i.code==='PRICE_CHANGED'));
  assert.ok(report.items.some(i=>i.code==='FUNDING_SHORTFALL'));
});
test('unknown, estimated and non-USD fees are distinct from known zero', () => {
  for(const changes of [{totalTaxes:null},{totalTaxes:1,taxesCurrency:'EUR'}]) {
    const ctx=context();ctx.trip.segments[0].award.totalTaxes=null;
    assert.equal(buildReport({...ctx,results:{leg1:result('live',changes)}}).items.find(i=>i.category==='fees').status,'unknown');
  }
  const ctx=context();ctx.trip.segments[0].award.taxesEstimate=30;
  assert.equal(buildReport({...ctx,results:{leg1:result()}}).verdict,'Caution');
});
test('manual evidence is exact, recently user confirmed and never erases contradictions', () => {
  const ctx=context(); const s={...ctx.trip.segments[0].award,selectionId:'leg1',kind:'flight'};
  const c={planHash:planHashFor(ctx),selectionId:'leg1',itemCode:'AVAILABILITY_CACHED',fingerprint:selectionFingerprint(s),sourceUrl:'https://www.united.com/',confirmedAt:at};
  assert.equal(buildReport({...ctx,results:{leg1:result('cached')},confirmations:[c]}).verdict,'Go');
  assert.equal(buildReport({...ctx,results:{leg1:result('cached')},confirmations:[{...c,confirmedAt:new Date(now-FRESHNESS_MS).toISOString()}]}).verdict,'Caution');
  assert.equal(buildReport({...ctx,results:{leg1:result('cached',{remainingSeats:1})},confirmations:[c]}).verdict,'Stop');
  ctx.trip.segments[0].award.mileageCost++;
  assert.equal(buildReport({...ctx,results:{leg1:result('cached')},confirmations:[c]}).items.find(i=>i.code==='AVAILABILITY_CACHED').status,'caution');
});
test('wallet and reference hashes exclude credentials and invalidate on material context', () => {
  const ctx=context();const h=contextHashFor(ctx);
  ctx.user.apiKey='secret'; ctx.user.name='private';assert.equal(contextHashFor(ctx),h);
  ctx.user.balances[0].balance--;assert.notEqual(contextHashFor(ctx),h);
  const old=planHashFor(ctx);ctx.trip.revision++;assert.notEqual(planHashFor(ctx),old);
});
test('connections and known chronology problems take Stop precedence', () => {
  assert.equal(buildReport({...context(),results:{leg1:result()},risks:[{code:'INSUFFICIENT_BUFFER',severity:'stop',reason:'Too short'}]}).verdict,'Stop');
  const ctx=context();ctx.trip.segments[0].award.flight.arriveUtc='2027-01-01T11:00:00Z';
  assert.equal(buildReport({...ctx,results:{leg1:result()}}).verdict,'Stop');
});
test('transfers remain estimates, expiry cutoff is unknown and stale rolling bonus cannot fund', () => {
  const ctx=context();ctx.user.balances=[{code:'chase',balance:50000}];ctx.transfers={banks:{chase:{}},programs:{united:{transfers:{chase:{ratio:[1,1],days:0,bonusPct:1,bonusRolling:true,bonusLastConfirmedAt:'2026-10-19T12:00:00Z',bonusEnds:'2026-10-20'}}}},lastUpdated:'2026-10-20'};
  assert.equal(buildReport({...ctx,results:{leg1:result()}}).verdict,'Stop');
  const funding={sources:[{from:'chase',targetProgram:'united',bonusPct:1}],transfers:1};
  const items=transferTimingItems({funding,transfers:ctx.transfers,now});
  assert.ok(items.some(i=>i.code==='TRANSFER_ESTIMATED_INSTANT'));
  assert.equal(items.find(i=>i.code==='BONUS_DEADLINE').details.bonusDeadlineTimeZone,null);
  ctx.transfers.programs.united.transfers.chase.days=2;
  assert.ok(transferTimingItems({funding,transfers:ctx.transfers,now}).some(i=>i.code==='TRANSFER_DELAY'));
});
test('hotel cash comparison is not award fees and extrapolated stays stay caution', () => {
  const ctx=context();ctx.scope='stay';ctx.stay.stays=[{id:'stay1',hotelId:'h',program:'hyatt',nights:6,pricedNights:5,totalPoints:30000,cashUsd:2000,estimated:true}];ctx.user.balances=[{code:'hyatt',balance:30000}];
  const r=buildReport(ctx);assert.equal(r.verdict,'Caution');assert.ok(r.items.some(i=>i.code==='FEES_UNKNOWN'));assert.ok(r.items.some(i=>i.code==='STAY_EXTRAPOLATED'));
});

test('new unknown counts cannot inherit old positive counts and fee changes need review',()=>{
 const ctx=context();ctx.trip.segments[0].award.remainingSeats=2;
 assert.equal(buildReport({...ctx,results:{leg1:result('live',{remainingSeats:null})}}).items.find(i=>i.code==='SEATS_UNKNOWN').status,'unknown');
 assert.ok(buildReport({...ctx,results:{leg1:result('live',{totalTaxes:10})}}).items.some(i=>i.code==='FEES_CHANGED'));
});
test('a required unconfirmed bonus is excluded before deciding affordability',()=>{
 const ctx=context();ctx.user.balances=[{code:'chase',balance:50000}];ctx.transfers={banks:{chase:{}},programs:{united:{transfers:{chase:{ratio:[1,1],days:0,bonusPct:1,unverified:true,bonusEnds:'2026-11-01'}}}},lastUpdated:'2026-10-20'};
 assert.equal(buildReport({...ctx,results:{leg1:result()}}).verdict,'Stop');
});

test('a recheck cannot extend an older manual confirmation beyond its own 15-minute lifetime',()=>{
 const ctx=context();const selection={...ctx.trip.segments[0].award,selectionId:'leg1',kind:'flight'};
 const c={planHash:planHashFor(ctx),selectionId:'leg1',itemCode:'AVAILABILITY_CACHED',fingerprint:selectionFingerprint(selection),sourceUrl:'https://www.united.com/',confirmedAt:at};
 const r=buildReport({...ctx,now:now+14*60000,results:{leg1:result('cached')},confirmations:[c]});
 assert.equal(Date.parse(r.expiresAt),now+FRESHNESS_MS);
});

test('a new missing exact price or fee cannot be replaced with an old saved amount',()=>{
 const ctx=context();
 const r=buildReport({...ctx,results:{leg1:result('live',{mileageCost:null,totalTaxes:null})}});
 assert.equal(r.verdict,'Caution');assert.ok(r.items.some(i=>i.code==='PRICE_UNVERIFIED'));assert.ok(r.items.some(i=>i.code==='FEES_UNKNOWN'));
});

test('multi-room stays retain estimated-price and unknown-inventory caution after every confirmation',()=>{
 const ctx=context();ctx.scope='stay';ctx.user.balances=[{code:'hyatt',balance:60000}];
 const stay={id:'multi',program:'hyatt',nights:2,pricedNights:2,totalPoints:60000,awardFees:0,estimated:false,rooms:[{adults:2,childrenAges:[],roomType:'standard'},{adults:2,childrenAges:[],roomType:'standard'}]};ctx.stay.stays=[stay];
 const evidence={method:'cached',requestedAt:at,observedAt:at,source:'rooms.aero',complete:true};
 const confirmations=['AVAILABILITY_CACHED','ROOMS_UNKNOWN'].map(itemCode=>({planHash:planHashFor(ctx),selectionId:'multi',itemCode,fingerprint:selectionFingerprint(stay),sourceUrl:'https://www.hyatt.com/',confirmedAt:at}));
 const report=buildReport({...ctx,results:{multi:{evidence,match:{totalPoints:30000,remainingRooms:null}}},confirmations});
 assert.equal(report.verdict,'Caution');assert.equal(report.items.find(i=>i.code==='MULTI_ROOM_ESTIMATE').status,'caution');
 assert.match(report.items.find(i=>i.code==='MULTI_ROOM_ESTIMATE').message,/inventory is unknown/);
 assert.equal(report.items.find(i=>i.code==='FUNDED').status,'pass');assert.ok(!report.items.some(i=>i.code==='PRICE_CHANGED'));
 for(const code of ['AVAILABILITY_CACHED','ROOMS_UNKNOWN'])assert.equal(report.items.find(i=>i.code===code).status,'pass');
 const old=selectionFingerprint(stay);stay.rooms.pop();assert.notEqual(selectionFingerprint(stay),old);
});
test('award positioning gets separate availability, current-price funding and fee evidence without double counting',()=>{
 const ctx=context();ctx.user.balances[0].balance=120000;
 ctx.trip.positioning={outbound:{...award(),id:'pos',kind:'award',origin:'BOS',destination:'JFK',mileageCost:10000,totalTaxes:null,flight:{departUtc:'2027-01-01T00:00:00Z',arriveUtc:'2027-01-01T02:00:00Z',flightNumbers:['UA2']}}};
 const pos=result('live',{mileageCost:10000,totalTaxes:null});
 let r=buildReport({...ctx,results:{leg1:result(),'positioning-outbound':pos}});
 assert.equal(r.verdict,'Caution');assert.ok(r.items.some(i=>i.selectionId==='positioning-outbound'&&i.code==='AVAILABILITY_VERIFIED'));assert.ok(r.items.some(i=>i.selectionId==='positioning-outbound'&&i.code==='FEES_UNKNOWN'));assert.ok(r.items.some(i=>i.code==='FUNDED'));
 r=buildReport({...ctx,results:{leg1:result(),'positioning-outbound':result('live',{mileageCost:11000})}});
 assert.equal(r.verdict,'Stop');assert.ok(r.items.some(i=>i.selectionId==='positioning-outbound'&&i.code==='PRICE_CHANGED'));assert.ok(r.items.some(i=>i.code==='FUNDING_SHORTFALL'));
 const gone={...pos,match:null,definitive:true};r=buildReport({...ctx,results:{leg1:result(),'positioning-outbound':gone}});assert.equal(r.items.find(i=>i.code==='INVENTORY_GONE').status,'stop');
});
test('cash positioning never treats a saved fare as verified inventory, fees or current party price',()=>{
 const ctx=context();ctx.trip.positioning={return:{kind:'cash',origin:'LHR',destination:'BOS',price:100,currency:'USD',totalTaxes:0,departUtc:'2027-01-02T12:00:00Z',arriveUtc:'2027-01-02T19:00:00Z',flightNumbers:['BA1']}};
 const r=buildReport({...ctx,results:{leg1:result()}});assert.equal(r.verdict,'Caution');
 for(const code of ['AVAILABILITY_UNVERIFIED','SEATS_UNKNOWN','PRICE_UNVERIFIED','FEES_UNKNOWN'])assert.ok(r.items.some(i=>i.selectionId==='positioning-return'&&i.code===code));
 assert.ok(!r.items.some(i=>i.code==='INVALID_PRICE'));assert.ok(r.items.some(i=>i.code==='FUNDED'));
});
