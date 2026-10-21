import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTripPlan, normalizeStayPlan, normalizeSelectedAward, selectionEvidenceSummary, planHash } from '../lib/itinerary.mjs';
import { validateItinerary } from '../lib/validate.mjs';
import { assessTransitions } from '../lib/route-risk.mjs';
import { observedTimestampSummary } from '../lib/awards.mjs';

const award = (origin = 'JFK', destination = 'LHR', date = '2027-06-05', extra = {}) => ({ id: `${origin}-${destination}`, program: 'united', origin, destination, date, cabin: 'business', mileageCost: 1000, ...extra });
const plan = (segments, extra = {}) => ({ schemaVersion: 2, mode: 'multi-city', travelers: 1, segments: segments.map((a, i) => ({ id: `leg${i + 1}`, award: a })), ...extra });
const timed = (origin, destination, departUtc, arriveUtc) => award(origin, destination, departUtc.slice(0, 10), { flight: { origin, destination, departUtc, arriveUtc } });
const open = () => plan([award(), award('CDG', 'JFK', '2027-06-10')], { mode: 'open-jaw' });

test('explicit open jaw derives a visible unresolved surface gap and separate tickets', () => {
  const p = normalizeTripPlan(open());
  const risk = assessTransitions(p);
  assert.equal(validateItinerary(p, { requireComplete: true }).valid, true);
  assert.equal(p.transitions[0].type, 'surface');
  assert.equal(p.transitions[0].ground, null);
  assert.ok(risk.risks.some(r => r.code === 'SURFACE_TRAVEL'));
  assert.ok(risk.risks.some(r => r.code === 'SEPARATE_TICKETS'));
  assert.ok(risk.risks.some(r => r.code === 'TIMING_UNKNOWN'));
  assert.deepEqual(risk.risks[0].actualAirports, { from: 'LHR', to: 'CDG' });
});

test('three through six legs normalize; seventh and duplicate IDs fail', () => {
  for (let n = 3; n <= 6; n++) {
    const p = normalizeTripPlan(plan(Array.from({ length: n }, (_, i) => award('JFK', 'LHR', `2027-06-${String(i + 5).padStart(2, '0')}`))));
    assert.equal(p.segments.length, n);
    assert.equal(p.transitions.length, n - 1);
  }
  assert.throws(() => normalizeTripPlan(plan(Array(7).fill(award()))), { status: 400 });
  const duplicate = open(); duplicate.segments[1].id = 'leg1';
  assert.throws(() => normalizeTripPlan(duplicate), /unique/);
  const missing = open(); delete missing.segments[0].id;
  assert.throws(() => normalizeTripPlan(missing), { status: 400 });
});

test('strict schema rejects unknown fields, wrong types, invalid airports, seats and unsafe numbers', () => {
  for (const mutation of [
    p => { p.unknown = true; }, p => { p.travelers = []; }, p => { p.segments[0].extra = 2; },
    p => { p.segments[0].award.origin = 'ZZZ'; }, p => { p.segments[0].award.cabin = 'sleeping'; },
    p => { p.segments[0].award.totalTaxes = Infinity; }, p => { p.segments[0].award.mileageCost = Number.MAX_SAFE_INTEGER + 1; },
    p => { p.travelers = 2; p.segments[1].award.remainingSeats = 1; },
    p => { p.segments[0].award.flight = { origin: 'EWR' }; },
    p => { p.segments[0].award.flight = { departUtc: '2027-06-05' }; },
    p => { p.segments[0].award.bookingLinks = [{ url: 'javascript:alert(1)' }]; },
    p => { p.transitions = [{ fromSegmentId: 'leg2', toSegmentId: 'leg1', type: 'surface' }]; },
    p => { p.transitions = [{ fromSegmentId: 'leg1', toSegmentId: 'leg2', type: 'surface', ticketRelationship: 'protected' }]; }
  ]) { const p = open(); mutation(p); assert.throws(() => normalizeTripPlan(p), { status: 400 }); }
});

test('UTC chronology handles date line travel and rejects overlap despite increasing local dates', () => {
  const a = timed('HND', 'LAX', '2027-06-06T00:00:00Z', '2027-06-06T10:00:00Z');
  const b = timed('LAX', 'JFK', '2027-06-06T13:00:00Z', '2027-06-06T18:00:00Z');
  a.date = '2027-06-06'; b.date = '2027-06-05';
  assert.equal(validateItinerary(plan([a, b])).valid, true);
  b.date = '2027-06-07'; b.flight.departUtc = '2027-06-06T09:00:00Z';
  assert.equal(validateItinerary(plan([a, b])).valid, false);
});

test('same-metro moves require a user ground estimate plus buffer before timing can pass', () => {
  const p = plan([timed('BOS','JFK','2027-06-05T10:00:00Z','2027-06-05T11:00:00Z'), timed('EWR','LHR','2027-06-05T13:00:00Z','2027-06-05T20:00:00Z')]);
  assert.ok(assessTransitions(p).risks.some(r => r.code === 'GROUND_TIME_UNKNOWN'));
  p.transitions = [{ fromSegmentId: 'leg1', toSegmentId: 'leg2', type: 'connection', ground: { mode: 'road', durationMinutes: 90, cost: { currency: 'USD', value: 50 } }, bufferMinutes: 60, ticketRelationship: 'unknown' }];
  const assessment = assessTransitions(p);
  assert.equal(assessment.valid, false);
  assert.equal(assessment.risks.find(r => r.code === 'INSUFFICIENT_BUFFER').requiredMinutes, 150);
  p.transitions[0].ground.durationMinutes = 45;
  assert.equal(assessTransitions(p).valid, true);
  assert.ok(assessTransitions(p).risks.some(r => r.code === 'AIRPORT_CHANGE'));
});

test('multi-day stopovers retain surface warnings without a tight-connection claim', () => {
  const p = plan([timed('JFK','LHR','2027-06-05T10:00:00Z','2027-06-05T18:00:00Z'),timed('CDG','JFK','2027-06-10T10:00:00Z','2027-06-10T18:00:00Z')]);
  p.transitions = [{ fromSegmentId:'leg1',toSegmentId:'leg2',type:'stopover',bufferMinutes:180,ground:null,ticketRelationship:'separate' }];
  const r = assessTransitions(normalizeTripPlan(p));
  assert.equal(r.valid, true);
  assert.ok(r.risks.some(x => x.code === 'SURFACE_TRAVEL'));
  assert.ok(!r.risks.some(x => x.code === 'INSUFFICIENT_BUFFER'));
});

test('timestamps accept live six-digit fractions but reject more than nine', () => {
  const six = award('JFK','LHR','2027-06-05',{ capturedAt:'2027-06-01T00:00:00.123456Z' });
  assert.equal(normalizeSelectedAward(six).capturedAt, '2027-06-01T00:00:00.123456Z');
  assert.equal(normalizeTripPlan(plan([six])).segments[0].award.capturedAt, '2027-06-01T00:00:00.123456Z');
  assert.throws(() => normalizeSelectedAward({ ...six, capturedAt:'2027-06-01T00:00:00.1234567890Z' }), /timestamp/);
});

test('operated-flight identity, provenance and fee unknowns survive slimming', () => {
  const a = award('JFK','LHR','2027-06-05',{ capturedAt:'2027-06-01T00:00:00Z',sourceUpdatedAt:'2027-05-31T23:00:00Z',evidenceMethod:'live',availabilityId:'live:synthetic',taxesCurrency:'GBP',
    flight:{ id:'real', origin:'JFK', destination:'LHR', departUtc:'2027-06-05T10:00:00Z',arriveUtc:'2027-06-05T18:00:00Z',flightNumbers:['UA1'],segments:[{flightNumber:'UA1',origin:'JFK',destination:'LHR',departUtc:'2027-06-05T10:00:00Z',arriveUtc:'2027-06-05T18:00:00Z'}] } });
  const slim = normalizeSelectedAward(a);
  assert.equal(slim.availabilityId, null);
  assert.equal(slim.evidenceMethod, 'live');
  assert.equal(slim.flight.segments[0].flightNumber, 'UA1');
  assert.equal(slim.taxesMissing, true);
  const p = normalizeTripPlan(plan([slim]));
  assert.deepEqual(selectionEvidenceSummary(p)[0],{selectionId:'leg1',source:'unknown',capturedAt:a.capturedAt,sourceUpdatedAt:a.sourceUpdatedAt,observedAt:a.sourceUpdatedAt});
  const hash = planHash(p); assert.equal(hash, planHash(structuredClone(p))); p.travelers = 2; assert.notEqual(hash, planHash(p));
});

test('stay normalization keeps exact totals and evidence, enforces the twenty-stay import cap', () => {
  const s = { id:'stay1',name:'Hyatt',program:'hyatt',checkIn:'2027-06-05',checkOut:'2027-06-08',nightlyPoints:3334,totalPoints:10000,pricedNights:3,pricedTotalPoints:10000,availabilityId:'avail',roomId:'standard',capturedAt:'2027-06-01T00:00:00Z' };
  const p = normalizeStayPlan({stays:[s]});
  assert.equal(p.stays[0].totalPoints,10000); assert.equal(p.stays[0].roomId,'standard'); assert.equal(p.stays[0].pricedNights,3);
  const large = {stays:Array.from({length:21},(_,i)=>({...s,id:`stay${i}`}))};
  assert.throws(()=>normalizeStayPlan(large),{status:400});
  assert.equal(normalizeStayPlan(large,{strict:false,allowOversizedLegacy:true}).stays.length,21);
  assert.throws(()=>normalizeStayPlan({stays:[{...s,nightlyPoints:1e100}]}),{status:400});
});

test('observation summaries never substitute captured time for provider observation', () => {
  const summary = observedTimestampSummary([{capturedAt:'2027-06-02T00:00:00Z'},{sourceUpdatedAt:'2027-06-01T00:00:00Z'},{sourceUpdatedAt:'2027-05-31T00:00:00Z'}],{source:'seatsaero',completeness:'truncated',at:'2027-06-02T00:00:00Z'});
  assert.equal(summary.sampleCount,3); assert.equal(summary.providerObservedMinAt,'2027-05-31T00:00:00.000Z'); assert.equal(summary.providerObservedMaxAt,'2027-06-01T00:00:00.000Z'); assert.equal(summary.completeness,'truncated');
  assert.equal(observedTimestampSummary([{capturedAt:'2027-06-02T00:00:00Z'}],{source:'seatsaero'}).providerObservedMaxAt,null);
});

test('saved query constraints and imported home positioning are validated without writes', () => {
  const p=plan([award()],{mode:'one-way',home:{origin:'BOS',returnTo:'BOS'}});
  p.segments[0].query={origins:'JFK',destination:'LHR',departDate:'2027-06-05',cabin:'business',nonstopOnly:false};
  assert.equal(normalizeTripPlan(p).segments[0].award.origin,'JFK');
  assert.throws(()=>normalizeTripPlan({...p,segments:[{...p.segments[0],query:{...p.segments[0].query,destination:'CDG'}}]}),/query/);
  const timedAward=timed('JFK','LHR','2027-06-05T20:00:00Z','2027-06-06T04:00:00Z');
  const positioning={kind:'cash',origin:'BOS',destination:'JFK',date:'2027-06-05',price:100,departUtc:'2027-06-05T10:00:00Z',arriveUtc:'2027-06-05T11:00:00Z'};
  const positioned=plan([timedAward],{mode:'one-way',home:p.home,positioning:{outbound:positioning,return:null}});
  assert.equal(normalizeTripPlan(positioned).positioning.outbound.destination,'JFK');
  assert.throws(()=>normalizeTripPlan({...positioned,positioning:{outbound:{...positioning,destination:'EWR'}}}),/actual connecting airports/);
  assert.throws(()=>normalizeTripPlan({...positioned,positioning:{outbound:{...positioning,arriveUtc:'2027-06-05T19:00:00Z'}}}),/buffer/);
  assert.ok(assessTransitions({...open(),transitions:[{fromSegmentId:'leg1',toSegmentId:'leg2',type:'surface',ticketRelationship:'protected'}]}).risks.some(r=>r.code==='SEPARATE_TICKETS'));
});
