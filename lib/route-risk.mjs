import { cityCodeOf } from './geo.mjs';

/** Planning assessment only: buffers and ground durations are user estimates, never legal MCTs. */
export function assessTransitions(plan) {
  const risks = [], transitions = [];
  const segments = plan.segments || [];
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1], next = segments[i];
    const a = previous.award, b = next.award;
    const supplied = (plan.transitions || []).find(t => t.fromSegmentId === previous.id && t.toSegmentId === next.id);
    const from = a?.flight?.destination || a?.destination || null;
    const to = b?.flight?.origin || b?.origin || null;
    const arrival = a?.flight?.arriveUtc, departure = b?.flight?.departUtc;
    const gapMinutes = arrival && departure && Number.isFinite(Date.parse(arrival)) && Number.isFinite(Date.parse(departure))
      ? (Date.parse(departure) - Date.parse(arrival)) / 60000 : null;
    const airportChange = Boolean(from && to && from !== to);
    const distant = airportChange && cityCodeOf(from) !== cityCodeOf(to);
    const type = supplied?.type || (distant ? 'surface' : gapMinutes != null && gapMinutes >= 1440 ? 'stopover' : 'connection');
    const transition = { fromSegmentId: previous.id, toSegmentId: next.id, type,
      ground: supplied?.ground || null, bufferMinutes: supplied?.bufferMinutes ?? 0,
      ticketRelationship: supplied?.ticketRelationship === 'unknown' ? 'unknown' : 'separate' };
    transitions.push(transition);
    if (!a || !b) continue;
    const duration = transition.ground?.durationMinutes;
    const requiredMinutes = airportChange && duration == null ? null : (duration ?? 0) + transition.bufferMinutes;
    const add = (code, severity, reason) => risks.push({ code, severity, fromId: previous.id, toId: next.id,
      actualAirports: { from, to }, gapMinutes, requiredMinutes, reason });
    if (gapMinutes != null && gapMinutes <= 0) add('FLIGHT_OVERLAP', 'stop', 'The next flight must depart after the previous flight arrives.');
    if (gapMinutes == null) add('TIMING_UNKNOWN', 'caution', 'Exact UTC times are unknown; connection timing cannot be confirmed.');
    if (gapMinutes == null && b.date < (a.flight?.arrive?.date || a.date)) add('DATE_OVERLAP', 'stop', 'The next departure date precedes the previous arrival date.');
    if (distant && transition.type === 'connection') add('SURFACE_REQUIRED', 'stop', 'Different cities require a visible surface journey or stopover.');
    if (airportChange) add(distant ? 'SURFACE_TRAVEL' : 'AIRPORT_CHANGE', 'caution', `${from} to ${to} requires ground travel; allow for baggage, security and immigration.`);
    if (airportChange && duration == null) add('GROUND_TIME_UNKNOWN', 'caution', 'Enter a ground travel duration as a user estimate.');
    if (airportChange && !transition.ground) add('GROUND_UNARRANGED', 'caution', 'The surface journey has not been arranged.');
    if (gapMinutes != null && gapMinutes > 0 && requiredMinutes != null && gapMinutes < requiredMinutes) add('INSUFFICIENT_BUFFER', 'stop', 'Available time is shorter than the ground duration and user buffer.');
    add('SEPARATE_TICKETS', 'caution', transition.ticketRelationship === 'unknown'
      ? 'Ticket protection is unknown; confirm separate-booking exposure.' : 'Separately selected awards require separate bookings; protection is not established.');
  }
  for (const dir of ['outbound', 'return']) {
    const segment = dir === 'outbound' ? (segments[0]?.id === 'return' ? null : segments[0])
      : segments.length > 1 || segments[0]?.id === 'return' ? segments.at(-1) : null;
    const award = segment?.award;
    const home = dir === 'outbound' ? plan.home?.origin : plan.home?.returnTo || plan.home?.origin;
    const airport = dir === 'outbound' ? award?.origin : award?.destination;
    if (!award || !home || home === airport) continue;
    const id = `positioning-${dir}`, pos = plan.positioning?.[dir];
    if (!pos) {
      risks.push({ code: 'POSITIONING_MISSING', severity: 'caution', fromId: dir === 'outbound' ? id : segment.id,
        toId: dir === 'outbound' ? segment.id : id, actualAirports: { from: dir === 'outbound' ? home : airport, to: dir === 'outbound' ? airport : home },
        gapMinutes: null, requiredMinutes: null, reason: `Arrange travel ${dir === 'outbound' ? 'from home to the award departure airport' : 'from the award arrival airport home'}.` });
      continue;
    }
    const positioned = { id, award: { ...pos, date: pos.date || pos.departDate || pos.departUtc?.slice(0, 10),
      flight: pos.flight || { origin: pos.origin, destination: pos.destination, departUtc: pos.departUtc, arriveUtc: pos.arriveUtc } } };
    const chain = dir === 'outbound' ? [positioned, segment] : [segment, positioned];
    const from = chain[0].award.destination, to = chain[1].award.origin;
    const assessment = assessTransitions({ segments: chain, transitions: [{ fromSegmentId: chain[0].id, toSegmentId: chain[1].id,
      type: from !== to && cityCodeOf(from) !== cityCodeOf(to) ? 'surface' : 'connection', ground: pos.ground || null,
      bufferMinutes: (plan.buffers?.[dir === 'outbound' ? 'outboundHours' : 'returnHours'] ?? (dir === 'outbound' ? 3 : 2)) * 60,
      ticketRelationship: 'separate' }] });
    risks.push(...assessment.risks);
  }
  return { valid: !risks.some(r => r.severity === 'stop'), risks, transitions };
}
