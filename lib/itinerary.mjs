import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { describe } from './geo.mjs';
import { normalizeCabin, programId, programKind, programName } from './programs.mjs';
import { assertCalendarDate, parseFiniteNumber, validateFlightPair } from './validate.mjs';
import { assessTransitions } from './route-risk.mjs';
import { resolveAirports } from './places.mjs';

export const ITINERARY_LIMITS = Object.freeze({ segments: 6, stays: 20 });
export const ITINERARY_MODES = Object.freeze(['one-way', 'round-trip', 'open-jaw', 'multi-city']);
const fail = message => { throw new ApiError(message, 400, 'INVALID_INPUT'); };
export function objectFields(value, allowed, name = 'object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${name} field: ${key}.`);
  return value;
}
const text = (value, name, max = 160, nullable = false) => {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || value.length > max) fail(`${name} must be a string of at most ${max} characters.`);
  return value;
};
export const itineraryId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail('IDs must contain 1–64 letters, digits, underscores or hyphens.');
  return value;
};
export function airportCode(value, optional = false) {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || !describe(value).airportName) fail('Choose a known airport code.');
  return value;
}
const number = (v, name, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false) => parseFiniteNumber(v, { name, min, max, integer });
const boolean = (v, name) => { if (typeof v !== 'boolean') fail(`${name} must be boolean.`); return v; };
function timestamp(v, name) {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v))) fail(`${name} must be a timestamp with a UTC offset.`);
  assertCalendarDate(v.slice(0, 10), name);
  if (Number(v.slice(11, 13)) > 23 || Number(v.slice(14, 16)) > 59 || (v[16] === ':' && Number(v.slice(17, 19)) > 59)) fail(`${name} has an invalid clock time.`);
  return v;
}
function https(v, name) {
  if (v == null || v === '') return null;
  text(v, name, 2048);
  let url; try { url = new URL(v); } catch { fail(`${name} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(`${name} must be an HTTPS URL.`);
  return v;
}
const EVIDENCE = ['capturedAt', 'sourceUpdatedAt', 'observedAt', 'evidenceMethod', 'availabilityId', 'dataSource', 'sourceUrl'];
function evidence(input) {
  const out = {};
  for (const key of EVIDENCE.slice(0, 3)) out[key] = timestamp(input[key], key);
  out.evidenceMethod = input.evidenceMethod ?? null;
  if (out.evidenceMethod != null && !['cached', 'live', 'manual', 'unsupported'].includes(out.evidenceMethod)) fail('Invalid evidenceMethod.');
  for (const key of ['availabilityId', 'dataSource']) out[key] = text(input[key], key, 256, true);
  out.sourceUrl = https(input.sourceUrl, 'sourceUrl');
  if (out.evidenceMethod === 'live' && /^live[:_-]/i.test(out.availabilityId || '')) out.availabilityId = null;
  return out;
}
function safeMetadata(value, depth = 0) {
  if (depth > 8) fail('Selection metadata is too deeply nested.');
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Selection numbers must be finite.'); return value; }
  if (typeof value === 'string') return text(value, 'selection metadata', 2048);
  if (Array.isArray(value)) { if (value.length > 64) fail('Selection metadata array is too large.'); return value.map(x => safeMetadata(x, depth + 1)); }
  fail('Unexpected selection metadata.');
}
function localStamp(v) {
  if (v == null) return null;
  objectFields(v, ['date', 'time', 'tz', 'label'], 'local time');
  assertCalendarDate(v.date);
  if (!/^\d\d:\d\d$/.test(v.time || '') || Number(v.time.slice(0, 2)) > 23 || Number(v.time.slice(3)) > 59) fail('Invalid local time.');
  return { date: v.date, time: v.time, tz: text(v.tz ?? '', 'time zone', 100) };
}
function flightIdentity(input) {
  if (input == null) return null;
  const fields = ['id','origin','destination','departUtc','arriveUtc','cabin','mileageCost','taxes','taxesCurrency','remainingSeats','stops','totalDurationMin','depart','arrive','arriveDayOffset','flightNumbers','airlines','segments','layovers','product','mixedCabinPct'];
  objectFields(input, fields, 'flight');
  const out = {};
  for (const k of ['id']) if (input[k] != null) out[k] = text(input[k], k, 256);
  for (const k of ['origin', 'destination']) if (input[k] != null) out[k] = airportCode(input[k]);
  for (const k of ['departUtc', 'arriveUtc']) out[k] = timestamp(input[k], k);
  for (const k of ['depart', 'arrive']) if (input[k] != null) out[k] = localStamp(input[k]);
  for (const k of ['mileageCost','taxes','remainingSeats','stops','totalDurationMin','mixedCabinPct']) if (input[k] != null) out[k] = number(input[k], k, 0, k === 'mileageCost' ? 1e9 : 1e7, ['remainingSeats','stops','mileageCost'].includes(k));
  if (input.cabin != null) { out.cabin = normalizeCabin(input.cabin); if (!out.cabin) fail('Invalid flight cabin.'); }
  if (input.taxesCurrency != null) out.taxesCurrency = currency(input.taxesCurrency);
  for (const k of ['flightNumbers', 'airlines']) if (input[k] != null) out[k] = safeMetadata(input[k]);
  if (input.product != null) out.product = seatProduct(input.product);
  if (input.arriveDayOffset != null) out.arriveDayOffset = number(input.arriveDayOffset, 'arriveDayOffset', -7, 7, true);
  if (input.layovers != null) {
    if (!Array.isArray(input.layovers) || input.layovers.length > 15) fail('Too many layovers.');
    out.layovers = input.layovers.map(l => {
      objectFields(l, ['airport','city','durationMin','flag','overnight'], 'layover');
      return { airport: airportCode(l.airport), city: text(l.city, 'layover city', 160, true), durationMin: number(l.durationMin, 'layover duration', 0, 525600), flag: text(l.flag, 'layover flag', 32, true), overnight: l.overnight == null ? false : boolean(l.overnight, 'overnight') };
    });
  }
  if (input.segments != null) {
    if (!Array.isArray(input.segments) || !input.segments.length || input.segments.length > 16) fail('Flight segments must contain 1–16 operated flights.');
    out.segments = input.segments.map(s => {
      objectFields(s, ['flightNumber','carrier','airline','origin','destination','originCity','destinationCity','departUtc','arriveUtc','depart','arrive','arriveDayOffset','durationMin','aircraft','aircraftCode','fareClass','distance','seat','seatMaps','cabin'], 'operated flight');
      const segment = { origin: airportCode(s.origin), destination: airportCode(s.destination), departUtc: timestamp(s.departUtc, 'departure'), arriveUtc: timestamp(s.arriveUtc, 'arrival') };
      if (segment.origin === segment.destination) fail('Operated flight airports must differ.');
      if (segment.departUtc && segment.arriveUtc && Date.parse(segment.arriveUtc) <= Date.parse(segment.departUtc)) fail('Operated flight arrival must follow departure.');
      for (const k of ['flightNumber','carrier','airline','aircraft','aircraftCode','fareClass','cabin','originCity','destinationCity']) if (s[k] != null) segment[k] = text(s[k], k, 160);
      if (s.arriveDayOffset != null) segment.arriveDayOffset = number(s.arriveDayOffset, 'arriveDayOffset', -7, 7, true);
      if (s.seat != null) segment.seat = seatProduct(s.seat);
      if (s.seatMaps != null) { objectFields(s.seatMaps, ['aerolopa','seatmaps'], 'seat maps'); segment.seatMaps = { aerolopa: https(s.seatMaps.aerolopa, 'seat map URL'), seatmaps: https(s.seatMaps.seatmaps, 'seat map URL') }; }
      for (const k of ['depart','arrive']) if (s[k] != null) segment[k] = localStamp(s[k]);
      for (const k of ['durationMin','distance']) if (s[k] != null) segment[k] = number(s[k], k, 0, 1e7);
      return segment;
    });
    for (let i = 1; i < out.segments.length; i++) {
      const a = out.segments[i - 1], b = out.segments[i];
      if (a.arriveUtc && b.departUtc && Date.parse(b.departUtc) <= Date.parse(a.arriveUtc)) fail('Operated flights overlap.');
    }
    const first = out.segments[0], last = out.segments.at(-1);
    if ((out.origin && out.origin !== first.origin) || (out.destination && out.destination !== last.destination)) fail('Operated flight airports do not match the flight.');
    out.origin ??= first.origin; out.destination ??= last.destination;
    if ((out.departUtc && first.departUtc && Date.parse(out.departUtc) !== Date.parse(first.departUtc)) || (out.arriveUtc && last.arriveUtc && Date.parse(out.arriveUtc) !== Date.parse(last.arriveUtc))) fail('Flight times do not match its operated flights.');
    out.departUtc ??= first.departUtc; out.arriveUtc ??= last.arriveUtc;
  }
  return out;
}
function seatProduct(input) {
  objectFields(input, ['type','product','detail','score','certainty','airline','carrier','aircraft','flightNumber'], 'seat product');
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, key === 'score' ? number(value, key, 0, 100) : text(value, key, 2048, true)]));
}
const AWARD_FIELDS = ['id','leg','program','programName','origin','destination','date','cabin','mileageCost','totalTaxes','cashValue','direct','airlines','flight','seatScore','remainingSeats','taxesMissing','taxesEstimate','taxesCurrency','bookingLinks','flightNumbers', ...EVIDENCE,
  'awardId','product','history','ageHours','stale','reportedTaxes','productMatch','source','sourceId','sourceType','flights'];
export function normalizeSelectedAward(input, travelers = 1) {
  objectFields(input, AWARD_FIELDS, 'award');
  const program = programId(input.program);
  if (programKind(program) !== 'airline') fail('Choose a recognized airline program.');
  const cabin = normalizeCabin(input.cabin); if (!cabin) fail('Invalid cabin.');
  const out = { ...evidence(input), program, programName: programName(program), origin: airportCode(input.origin), destination: airportCode(input.destination),
    date: assertCalendarDate(input.date, 'flight date'), cabin, mileageCost: number(input.mileageCost, 'mileageCost', 1, 1e9, true),
    totalTaxes: input.totalTaxes == null ? null : number(input.totalTaxes, 'totalTaxes', 0, 1e7), cashValue: input.cashValue == null ? null : number(input.cashValue, 'cashValue', 0, 1e7),
    remainingSeats: input.remainingSeats == null ? null : number(input.remainingSeats, 'remainingSeats', 0, 1e6, true),
    flight: flightIdentity(input.flight), taxesMissing: input.taxesMissing == null ? input.totalTaxes == null : boolean(input.taxesMissing, 'taxesMissing'),
    taxesCurrency: input.taxesCurrency == null ? null : currency(input.taxesCurrency), taxesEstimate: null, bookingLinks: [] };
  for (const k of ['id','leg']) if (input[k] != null) out[k] = text(input[k], k, 512);
  for (const k of ['direct']) if (input[k] != null) out[k] = boolean(input[k], k);
  for (const k of ['airlines','flightNumbers']) if (input[k] != null) out[k] = safeMetadata(input[k]);
  if (input.seatScore != null) out.seatScore = number(input.seatScore, 'seatScore', 0, 100);
  if (input.taxesEstimate != null) {
    objectFields(input.taxesEstimate, ['value','count','basis'], 'tax estimate');
    out.taxesEstimate = { value: number(input.taxesEstimate.value, 'tax estimate', 0, 1e7), count: number(input.taxesEstimate.count, 'tax count', 0, 1e9, true), basis: text(input.taxesEstimate.basis, 'tax basis', 32) };
  }
  if (input.bookingLinks != null) {
    if (!Array.isArray(input.bookingLinks) || input.bookingLinks.length > 3) fail('At most three booking links are allowed.');
    out.bookingLinks = input.bookingLinks.map(l => { objectFields(l, ['label','url','primary'], 'booking link'); return { label: text(l.label ?? 'Book', 'booking label', 120), url: https(l.url, 'booking URL'), primary: l.primary == null ? false : boolean(l.primary, 'primary') }; });
  }
  const check = validateFlightPair([out], { travelers }); if (!check.valid) fail(check.invalidReason);
  if (out.flight?.cabin && out.flight.cabin !== out.cabin) fail('Flight cabin does not match the selected award.');
  return out;
}
function currency(v) { if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) fail('Currency must be a three-letter ISO code.'); return v; }
export function normalizeTransition(t) {
  objectFields(t, ['fromSegmentId','toSegmentId','type','ground','bufferMinutes','ticketRelationship'], 'transition');
  if (!['connection','surface','stopover'].includes(t.type)) fail('Invalid transition type.');
  if (t.ticketRelationship != null && !['separate','unknown'].includes(t.ticketRelationship)) fail('Ticket relationship must be separate or unknown.');
  let ground = null;
  if (t.ground != null) {
    objectFields(t.ground, ['mode','durationMinutes','cost'], 'ground');
    if (!['rail','road','other'].includes(t.ground.mode)) fail('Invalid ground mode.');
    let cost = null;
    if (t.ground.cost != null) { objectFields(t.ground.cost, ['currency','value'], 'ground cost'); cost = { currency: currency(t.ground.cost.currency), value: number(t.ground.cost.value, 'ground cost', 0, 1e7) }; }
    ground = { mode: t.ground.mode, durationMinutes: t.ground.durationMinutes == null ? null : number(t.ground.durationMinutes, 'ground duration', 0, 525600, true), cost };
  }
  return { fromSegmentId: itineraryId(t.fromSegmentId), toSegmentId: itineraryId(t.toSegmentId), type: t.type, ground,
    bufferMinutes: number(t.bufferMinutes ?? 0, 'bufferMinutes', 0, 10080, true), ticketRelationship: t.ticketRelationship || 'separate' };
}
function query(q) {
  if (q == null) return null;
  objectFields(q, ['origins','destination','departDate','flexDays','cabin','nonstopOnly'], 'query');
  const out = { origins: text(q.origins, 'origins', 500), destination: text(q.destination, 'destination', 500), departDate: assertCalendarDate(q.departDate), flexDays: number(q.flexDays ?? 0, 'flexDays', 0, 30, true), cabin: normalizeCabin(q.cabin), nonstopOnly: q.nonstopOnly == null ? false : boolean(q.nonstopOnly, 'nonstopOnly') };
  if (!out.cabin || !out.origins.trim() || !out.destination.trim()) fail('A complete query and valid cabin are required.');
  for (const field of ['origins','destination']) {
    const airports = resolveAirports(out[field]);
    if (airports.length > 100) fail('At most 100 airports are supported per search side.');
    airports.forEach(c => airportCode(c));
  }
  return out;
}
const TRIP_FIELDS = ['schemaVersion','revision','mode','travelers','home','buffers','allowOpenJaw','origins','destinations','cabin','segments','transitions','positioning'];
const LEGACY_FIELDS = ['home','buffers','travelers','allowOpenJaw','origins','destinations','cabin','flights','positioning','revision'];
export function normalizeTripPlan(input = {}, { strict = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Trip plan must be an object.');
  if (input.schemaVersion != null && ![1, 2].includes(input.schemaVersion)) throw new ApiError('Unsupported trip schema version.', 400, 'UNSUPPORTED_SCHEMA');
  const legacy = input.schemaVersion !== 2;
  if (strict) objectFields(input, legacy ? [...LEGACY_FIELDS,'schemaVersion'] : TRIP_FIELDS, 'trip plan');
  const warnings = [];
  const attempt = (fn, fallback) => { try { return fn(); } catch (e) { if (strict) throw e; warnings.push(e.message); return fallback; } };
  if (legacy && input.flights != null) attempt(() => objectFields(input.flights, ['outbound','return'], 'flights'), null);
  const rawSegments = legacy ? ['outbound','return'].filter(id => input.flights?.[id]).map(id => ({ id, award: input.flights[id] })) : input.segments;
  if (!Array.isArray(rawSegments)) fail('segments must be an array.');
  if (rawSegments.length > ITINERARY_LIMITS.segments) fail('At most six itinerary legs are supported.');
  const p = { schemaVersion: 2, revision: number(input.revision ?? 0, 'revision', 0, Number.MAX_SAFE_INTEGER, true),
    mode: input.mode || (rawSegments.length > 2 ? 'multi-city' : rawSegments.length === 2 ? input.allowOpenJaw ? 'open-jaw' : 'round-trip' : 'one-way'),
    travelers: attempt(() => number(input.travelers ?? 1, 'travelers', 1, 9, true), input.travelers),
    home: { origin: '', returnTo: '' }, buffers: { outboundHours: 3, returnHours: 2 }, allowOpenJaw: input.allowOpenJaw == null ? false : attempt(() => boolean(input.allowOpenJaw, 'allowOpenJaw'), false),
    origins: [], destinations: [], cabin: attempt(() => { const cabin = normalizeCabin(input.cabin || 'business'); if (!cabin) fail('Invalid cabin.'); return cabin; }, input.cabin), segments: [], transitions: [], positioning: { outbound: null, return: null } };
  if (!ITINERARY_MODES.includes(p.mode)) fail('Invalid itinerary mode.');
  for (const key of ['origins','destinations']) if (input[key] != null) {
    if (!Array.isArray(input[key]) || input[key].length > 100) fail(`${key} must be a bounded airport array.`);
    p[key] = attempt(() => [...new Set(input[key].map(c => airportCode(c)))], structuredClone(input[key]));
  }
  if (input.home != null) { objectFields(input.home, ['origin','returnTo'], 'home'); for (const k of ['origin','returnTo']) p.home[k] = attempt(() => airportCode(input.home[k] || '', true), input.home[k]); }
  if (input.buffers != null) { objectFields(input.buffers, ['outboundHours','returnHours'], 'buffers'); for (const k of ['outboundHours','returnHours']) p.buffers[k] = attempt(() => number(input.buffers[k] ?? p.buffers[k], k, 0.5, 24), input.buffers[k]); }
  p.segments = rawSegments.map(s => {
    objectFields(s, ['id','query','award','ticketGroupId'], 'segment');
    const normalized = { id: itineraryId(s.id), query: attempt(() => query(s.query), structuredClone(s.query || null)), award: s.award == null ? null : attempt(() => normalizeSelectedAward(legacy && !s.award.cabin ? { ...s.award, cabin: p.cabin } : s.award, p.travelers), structuredClone(s.award)), ticketGroupId: s.ticketGroupId == null ? null : itineraryId(s.ticketGroupId) };
    if (normalized.query && normalized.award) attempt(() => {
      const q = normalized.query, a = normalized.award;
      if (!resolveAirports(q.origins).includes(a.origin) || !resolveAirports(q.destination).includes(a.destination)) fail('Selected airports do not match the leg query.');
      const delta = Math.abs(Date.parse(a.date) - Date.parse(q.departDate)) / 86400000;
      if (delta > q.flexDays || a.cabin !== q.cabin) fail('Selected date or cabin does not match the leg query.');
      if (q.nonstopOnly && (a.flight ? a.flight.stops !== 0 && a.flight.segments?.length !== 1 : a.direct !== true)) fail('This leg requires a nonstop flight.');
    }, null);
    return normalized;
  });
  if (new Set(p.segments.map(s => s.id)).size !== p.segments.length) fail('Segment IDs must be unique.');
  if (p.mode === 'one-way' && p.segments.length > 1 || ['round-trip','open-jaw'].includes(p.mode) && p.segments.length > 2) fail('The itinerary mode does not match its leg count.');
  if (p.segments.length && ['round-trip','open-jaw'].includes(p.mode) && p.segments.length !== 2) attempt(() => fail('Round trips and open jaws require exactly two legs.'), null);
  if (input.transitions != null) {
    if (!Array.isArray(input.transitions) || input.transitions.length > 5) fail('transitions must be a bounded array.');
    p.transitions = input.transitions.map(normalizeTransition);
    const edges = new Set();
    for (const t of p.transitions) {
      const i = p.segments.findIndex(s => s.id === t.fromSegmentId);
      if (i < 0 || p.segments[i + 1]?.id !== t.toSegmentId || edges.has(t.fromSegmentId)) fail('Transition references must name unique adjacent legs.');
      edges.add(t.fromSegmentId);
    }
  }
  const risk = assessTransitions(p);
  p.transitions = risk.transitions;
  if (!risk.valid) attempt(() => fail(risk.risks.find(r => r.severity === 'stop').reason), null);
  if (p.mode === 'round-trip' && p.segments.length === 2 && p.segments.every(s => s.award)) {
    const pair = validateFlightPair(p.segments.map(s => s.award), p);
    if (!pair.valid) attempt(() => fail(pair.invalidReason), null);
  }
  if (input.positioning != null) {
    objectFields(input.positioning, ['outbound','return'], 'positioning');
    // Positioning is validated against the actual connecting award by tripplan.mjs.
    for (const dir of ['outbound','return']) if (input.positioning[dir] != null) p.positioning[dir] = attempt(() => normalizePositioning(input.positioning[dir]), structuredClone(input.positioning[dir]));
  }
  attempt(() => validateHomePositioning(p), null);
  if (!strict && warnings.length) p.migrationWarnings = warnings;
  return p;
}
function normalizePositioning(input) {
  const base = ['kind','origin','destination','date','departDate','returnDate','departUtc','arriveUtc','departTime','arriveTime','price','currency','airline','airlines','flightNumber','flightNumbers','durationMin','totalDurationMin','stops','returnStops','transfers','link','bookingUrl','source','foundAt','observedAt','queriedAt','chosenAt','fits','incompatibleReason','pricing','layovers','live','ground'];
  objectFields(input, [...new Set([...AWARD_FIELDS, ...base])], 'positioning');
  if (!['award','cash'].includes(input.kind)) fail('Invalid positioning kind.');
  const out = input.kind === 'award' ? { ...normalizeSelectedAward(Object.fromEntries(Object.entries(input).filter(([k]) => AWARD_FIELDS.includes(k))), 1), kind: 'award' } : { kind: 'cash', origin: airportCode(input.origin), destination: airportCode(input.destination), price: number(input.price, 'positioning price', 0, 1e7) };
  for (const k of ['date','departDate']) if (input[k] != null) out[k] = assertCalendarDate(input[k]);
  for (const k of ['departUtc','arriveUtc','chosenAt']) if (input[k] != null) out[k] = timestamp(input[k], k);
  for (const k of ['link','bookingUrl']) if (input[k] != null) out[k] = https(input[k], k);
  for (const k of ['source','airline','airlines','flightNumber','flightNumbers','departTime','arriveTime']) if (input[k] != null) out[k] = safeMetadata(input[k]);
  for (const k of ['stops','durationMin','totalDurationMin']) if (input[k] != null) out[k] = number(input[k], k, 0, 1e7);
  if (input.cabin != null) { out.cabin = normalizeCabin(input.cabin); if (!out.cabin) fail('Invalid positioning cabin.'); }
  if (input.ground != null) out.ground = normalizeTransition({ fromSegmentId:'positioning',toSegmentId:'award',type:'surface',ground:input.ground }).ground;
  if (out.departUtc && out.arriveUtc && Date.parse(out.arriveUtc) <= Date.parse(out.departUtc)) fail('Positioning arrival must follow departure.');
  return out;
}
function validateHomePositioning(p) {
  const first = p.segments[0]?.id === 'return' ? null : p.segments[0]?.award;
  const last = p.segments.length > 1 || p.segments[0]?.id === 'return' ? p.segments.at(-1)?.award : null;
  for (const dir of ['outbound','return']) {
    const pos = p.positioning[dir]; if (!pos) continue;
    const a = dir === 'outbound' ? first : last;
    const home = dir === 'outbound' ? p.home.origin : p.home.returnTo || p.home.origin;
    if (!a || !home) fail('A home positioning pick requires its award and home airport.');
    const from = dir === 'outbound' ? home : a.destination, to = dir === 'outbound' ? a.origin : home;
    const homeMismatch = dir === 'outbound' ? pos.origin !== from : pos.destination !== to;
    const airportChange = dir === 'outbound' ? pos.destination !== to : pos.origin !== from;
    if (from === to || homeMismatch || airportChange && !pos.ground) fail('Positioning must match the actual connecting airports; airport changes require an explicit ground move.');
    if ((pos.flight?.remainingSeats ?? pos.remainingSeats) != null && (pos.flight?.remainingSeats ?? pos.remainingSeats) < p.travelers) fail('Not enough positioning seats for all travelers.');
    const arrival = pos.arriveUtc || pos.flight?.arriveUtc, departure = pos.departUtc || pos.flight?.departUtc;
    const groundTime = dir === 'outbound' ? a.flight?.departUtc : a.flight?.arriveUtc;
    const posTime = dir === 'outbound' ? arrival : departure;
    if (groundTime && posTime) {
      const gap = dir === 'outbound' ? Date.parse(groundTime) - Date.parse(posTime) : Date.parse(posTime) - Date.parse(groundTime);
      const required = p.buffers[dir === 'outbound' ? 'outboundHours' : 'returnHours'] * 3600000 + (pos.ground?.durationMinutes || 0) * 60000;
      if (gap < required) fail('Positioning flight does not leave the selected ground duration and connection buffer.');
    }
    const day = pos.departDate || pos.date || pos.flight?.depart?.date || departure?.slice(0, 10);
    if (day) {
      const connectingDate = dir === 'outbound' ? a.flight?.depart?.date || a.date : a.flight?.arrive?.date || a.date;
      const delta = (Date.parse(day) - Date.parse(connectingDate)) / 86400000;
      if (dir === 'outbound' ? delta < -1 || delta > 0 : delta < 0 || delta > 1) fail('Positioning date is incompatible with the connection.');
    }
  }
}
const STAY_FIELDS = ['id','name','hotelId','program','programName','city','location','category','roomType','roomId','roomIdentity','checkIn','checkOut','nights','nightlyPoints','totalPoints','cashPerNight','cashUsd','bookingUrl','estimated','addedAt', ...EVIDENCE, 'pricedNights','pricedTotalPoints','pricedTotalCash','totalTaxes','taxesMissing','taxesEstimate','taxesCurrency','feesMissing','feesEstimated','feesCurrency','awardFees','occupancySchemaVersion','rooms','inventoryStatus','occupancyStatus','programEvidence'];
function normalizeRoomRequests(rooms) {
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 4) fail('Room requests must contain one to four rooms.');
  return rooms.map(room => {
    objectFields(room, ['adults','childrenAges','roomType'], 'room request');
    const adults = number(room.adults, 'room adults', 1, 8, true);
    if (!Array.isArray(room.childrenAges) || room.childrenAges.length > 6) fail('Each room supports zero to six child ages.');
    const childrenAges = room.childrenAges.map(age => number(age, 'child age', 0, 17, true));
    const roomType = room.roomType ?? 'standard';
    if (!['standard','suite','any'].includes(roomType)) fail('Room type must be standard, suite or any.');
    return { adults, childrenAges, roomType };
  });
}
function normalizeProgramEvidence(value) {
  if (value == null) return null;
  objectFields(value, ['roomCount','occupancy','taxes','resortFee','cancellation'], 'program evidence');
  const common = (item, money = false) => {
    objectFields(item, money ? ['amount','source','date','currency','waived','value','rooms','expiresAt'] : ['source','date','currency','text','value','rooms','expiresAt'], 'user evidence');
    if (typeof item.source !== 'string' || !item.source.trim() || item.source.length > 300) fail('Evidence source must be a non-empty string of at most 300 characters.');
    assertCalendarDate(item.date);
    const out = { source: item.source.trim(), date: item.date, currency: item.currency == null ? null : currency(item.currency) };
    if (item.expiresAt != null) out.expiresAt = timestamp(item.expiresAt, 'evidence expiry');
    if (money) out.amount = item.amount == null ? null : number(item.amount, 'evidence amount', 0, 1e7);
    if (money && out.amount != null && out.currency == null) fail('Evidence currency is required when an amount is entered.');
    if (item.waived != null) out.waived = boolean(item.waived, 'waived');
    if (item.text != null) out.text = text(item.text, 'evidence text', 500);
    return out;
  };
  const out = {};
  if (value.roomCount != null) { const item=value.roomCount; out.roomCount={...common(item),value:number(item.value,'confirmed room count',1,4,true)}; }
  if (value.occupancy != null) { const item=value.occupancy; out.occupancy={...common(item),rooms:normalizeRoomRequests(item.rooms)}; }
  if (value.taxes != null) out.taxes=common(value.taxes,true);
  if (value.resortFee != null) out.resortFee=common(value.resortFee,true);
  if (value.cancellation != null) out.cancellation=common(value.cancellation);
  return out;
}
export function normalizeStayPlan(input = {}, { strict = true, allowOversizedLegacy = false } = {}) {
  objectFields(input, ['schemaVersion','revision','stays'], 'stay plan');
  if (input.schemaVersion != null && ![1,2].includes(input.schemaVersion)) throw new ApiError('Unsupported stay schema version.', 400, 'UNSUPPORTED_SCHEMA');
  const raw = input.stays ?? [];
  if (!Array.isArray(raw) || raw.length > (allowOversizedLegacy ? 10000 : ITINERARY_LIMITS.stays)) fail('At most twenty stays are supported.');
  const warnings = [];
  const stays = raw.map((s, i) => {
    try {
      objectFields(s, STAY_FIELDS, 'stay');
      const id = s.id == null && input.schemaVersion == null ? `legacy-stay-${i + 1}` : itineraryId(s.id);
      const program = programId(s.program); if (programKind(program) !== 'hotel') fail('Choose a recognized hotel program.');
      assertCalendarDate(s.checkIn); assertCalendarDate(s.checkOut); if (s.checkOut <= s.checkIn) fail('Check-out must follow check-in.');
      const nights = (Date.parse(s.checkOut) - Date.parse(s.checkIn)) / 86400000;
      const nightlyPoints = number(s.nightlyPoints, 'nightlyPoints', 1, 1e9, true);
      const totalPoints = s.totalPoints == null ? nightlyPoints * nights : number(s.totalPoints, 'totalPoints', 1, Number.MAX_SAFE_INTEGER, true);
      if (!Number.isSafeInteger(totalPoints)) fail('Stay points exceed safe integer limits.');
      const out = { ...evidence(s), id, program, programName: programName(program), name: text(s.name, 'hotel name', 120),
        city: text(s.city ?? '', 'city', 80), location: text(s.location ?? '', 'location', 160), category: text(s.category, 'category', 20, true),
        hotelId: text(s.hotelId, 'hotelId', 256, true), roomId: text(s.roomId, 'roomId', 256, true), roomIdentity: text(s.roomIdentity, 'roomIdentity', 256, true), roomType: text(s.roomType ?? 'standard', 'roomType', 80),
        checkIn: s.checkIn, checkOut: s.checkOut, nights, nightlyPoints, totalPoints,
        cashPerNight: s.cashPerNight == null ? null : number(s.cashPerNight, 'cashPerNight', 0, 1e7), bookingUrl: https(s.bookingUrl, 'bookingUrl'), estimated: s.estimated == null ? false : boolean(s.estimated, 'estimated'), addedAt: timestamp(s.addedAt, 'addedAt') };
      out.cashUsd = out.cashPerNight == null ? null : out.cashPerNight * nights;
      for (const k of ['pricedNights','pricedTotalPoints','pricedTotalCash','totalTaxes','awardFees']) out[k] = s[k] == null ? null : number(s[k], k, 0, Number.MAX_SAFE_INTEGER, ['pricedNights','pricedTotalPoints'].includes(k));
      for (const k of ['taxesMissing','feesMissing','feesEstimated']) out[k] = s[k] == null ? null : boolean(s[k], k);
      for (const k of ['taxesCurrency','feesCurrency']) out[k] = s[k] == null ? null : currency(s[k]);
      out.taxesEstimate = s.taxesEstimate == null ? null : number(s.taxesEstimate, 'taxesEstimate', 0, 1e7);
      out.occupancySchemaVersion = s.occupancySchemaVersion == null ? 1 : number(s.occupancySchemaVersion, 'occupancySchemaVersion', 1, 1, true);
      out.rooms = normalizeRoomRequests(s.rooms ?? [{ adults: 2, childrenAges: [], roomType: out.roomType === 'suite' ? 'suite' : 'standard' }]);
      out.estimated = out.estimated || out.rooms.length > 1;
      out.inventoryStatus = s.inventoryStatus ?? 'unknown';
      out.occupancyStatus = s.occupancyStatus ?? 'unverified';
      if (!['unknown','user-entered'].includes(out.inventoryStatus) || !['unverified','user-entered'].includes(out.occupancyStatus)) fail('Invalid stay inventory or occupancy status.');
      out.programEvidence = normalizeProgramEvidence(s.programEvidence);
      return out;
    } catch (e) { if (strict) throw e; warnings.push(e.message); return structuredClone(s); }
  });
  if (new Set(stays.map(s => s.id)).size !== stays.length) { if (strict) fail('Stay IDs must be unique.'); warnings.push('Legacy stay IDs are duplicated; correct the draft before evaluation.'); }
  if (!Number.isSafeInteger(stays.reduce((sum, s) => sum + s.totalPoints, 0))) { if (strict) fail('Combined stay points exceed safe integer limits.'); warnings.push('Combined stay points exceed safe integer limits.'); }
  const out = { schemaVersion: 2, revision: number(input.revision ?? 0, 'revision', 0, Number.MAX_SAFE_INTEGER, true), stays };
  if (raw.length > 20) warnings.push('This legacy plan exceeds the twenty-stay editing/evaluation limit.');
  if (!strict && warnings.length) out.migrationWarnings = warnings;
  return out;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export function planHash(document) { return createHash('sha256').update(JSON.stringify(canonical(document ?? null))).digest('hex'); }
export function selectionEvidenceSummary(plan) {
  return [...(plan.segments || []).filter(s => s.award).map(s => ({ ...s.award, selectionId: s.id })), ...(plan.stays || []).map(s => ({ ...s, selectionId: s.id }))]
    .map(s => ({ selectionId: s.selectionId, source: s.dataSource || 'unknown', capturedAt: s.capturedAt || null, sourceUpdatedAt: s.sourceUpdatedAt || null, observedAt: s.observedAt || s.sourceUpdatedAt || null }));
}
