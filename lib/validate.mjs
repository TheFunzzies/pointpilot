import { cityCodeOf } from './geo.mjs';
import { ApiError } from './errors.mjs';
import { programId, programKind } from './programs.mjs';
import { normalizeTripPlan } from './itinerary.mjs';

export function isCalendarDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const date = new Date(`${str}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === str;
}

export function assertCalendarDate(str, name = 'date') {
  if (!isCalendarDate(str)) throw new ApiError(`${name} must be a valid YYYY-MM-DD calendar date`, 400, 'INVALID_INPUT');
  return str;
}

export function parseFiniteNumber(value, { min = -Infinity, max = Infinity, integer = false, name = 'value' } = {}) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) {
    throw new ApiError(`${name} must be a finite number`, 400, 'INVALID_INPUT');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new ApiError(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}`, 400, 'INVALID_INPUT');
  }
  return number;
}

export function validateFlightPair(legs, { travelers = 1, allowOpenJaw = false, origins = [], destinations = [] } = {}) {
  const invalid = invalidReason => ({ valid: false, invalidReason });
  if (!Array.isArray(legs) || !legs.length || legs.length > 2) return invalid('Pick one outbound and optionally one return flight.');
  for (const l of legs) {
    if (!l || programKind(programId(l.program)) !== 'airline' || !Number.isFinite(Number(l.mileageCost)) || Number(l.mileageCost) <= 0) return invalid('Each flight needs a recognized airline program and finite positive mileage cost.');
    try {
      parseFiniteNumber(l.mileageCost, { min: 1, max: 1e9, integer: true, name: 'mileageCost' });
      for (const field of ['totalTaxes', 'cashValue']) if (l[field] != null) parseFiniteNumber(l[field], { min: 0, max: 1e7, name: field });
      for (const seats of [l.remainingSeats, l.flight?.remainingSeats]) if (seats != null) parseFiniteNumber(seats, { min: 0, max: 1e6, integer: true, name: 'remainingSeats' });
    } catch (e) { return invalid(e.message); }
    if (!isCalendarDate(l.date)) return invalid('Each flight needs a valid calendar date.');
    if (!/^[A-Z]{3}$/.test(l.origin || '') || !/^[A-Z]{3}$/.test(l.destination || '') || l.origin === l.destination) return invalid('Each flight needs distinct origin and destination airports.');
    if (l.flight && ((l.flight.origin && l.flight.origin !== l.origin) || (l.flight.destination && l.flight.destination !== l.destination))) return invalid('Flight airports do not match the award.');
    if ((l.flight?.remainingSeats ?? l.remainingSeats) != null && (l.flight?.remainingSeats ?? l.remainingSeats) < travelers) return invalid('Not enough award seats for all travelers.');
    for (const field of ['departUtc', 'arriveUtc']) if (l.flight?.[field] && !Number.isFinite(Date.parse(l.flight[field]))) return invalid('Flight times must be valid timestamps.');
    if (l.flight?.departUtc && l.flight?.arriveUtc && Date.parse(l.flight.arriveUtc) <= Date.parse(l.flight.departUtc)) return invalid('Flight arrival must follow departure.');
  }
  if (legs.length === 2) {
    const [o, b] = legs;
    const sameCity = (a, b) => cityCodeOf(a) === cityCodeOf(b);
    const sameSet = (a, b, codes) => Array.isArray(codes) && codes.includes(a) && codes.includes(b);
    const homeMatches = sameCity(o.origin, b.destination) || sameSet(o.origin, b.destination, origins);
    const destinationMatches = sameCity(o.destination, b.origin) || sameSet(o.destination, b.origin, destinations);
    if (allowOpenJaw !== true && (!homeMatches || !destinationMatches)) return invalid('Return airports must serve the outbound cities or searched airport sets; explicitly allow open-jaw travel to use different cities.');
    const arrival = o.flight?.arriveUtc, departure = b.flight?.departUtc;
    if (arrival && departure ? !(Date.parse(departure) > Date.parse(arrival)) : b.date < (o.flight?.arrive?.date || o.date)) return invalid('Return must depart after the outbound arrives.');
  }
  return { valid: true, invalidReason: null };
}

export function validateItinerary(plan, { requireComplete = false } = {}) {
  try {
    const normalized = normalizeTripPlan(plan);
    const complete = normalized.segments.length > 0 && normalized.segments.every(s => s.award);
    if (requireComplete && !complete) return { valid: false, invalidReason: 'Pick one flight for every itinerary leg.', complete: false };
    return { valid: true, invalidReason: null, complete };
  } catch (e) { return { valid: false, invalidReason: e.message, complete: false }; }
}
