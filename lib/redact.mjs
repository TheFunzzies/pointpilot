const SECRET_NAME = /(?:authorization|partner[-_]?authorization|x[-_]?access[-_]?token|api[_-]?key|apikey|token|cookie|password|webhook|secret|credential)/i;
const SECRET_VALUE = /(?:bearer\s+)[a-z0-9._~+/-]+=*/ig;
const SENSITIVE_URL = /https?:\/\/[^\s"'<>]+/ig;

export function redactString(value, maxLength = 240) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  let out = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(SECRET_VALUE, '[REDACTED]');
  if (/<[^>]+>/.test(out)) return '[HTML REDACTED]';
  out = out.replace(SENSITIVE_URL, raw => {
    try {
      const u = new URL(raw);
      if (u.username || u.password || u.search || u.hash || /token|key|auth|secret|webhook/i.test(u.pathname)) return '[URL REDACTED]';
      return `${u.protocol}//${u.host}/[PATH REDACTED]`;
    } catch { return '[URL REDACTED]'; }
  });
  out = out.replace(/(?:[A-Za-z]:(?:\\|\/)|\\\\|\/(?:Users|home|tmp|var|private|data|etc|opt)\/)[\s\S]*$/g, '[PATH REDACTED]');
  // Encoded secret markers and path tokens are unsafe to inspect or preserve.
  for (let i = 0; i < 2; i++) {
    try { const decoded = decodeURIComponent(out); if (/api[_-]?key|token|password|webhook|authorization|cookie/i.test(decoded)) return '[REDACTED]'; }
    catch { return '[REDACTED]'; }
  }
  return out.slice(0, Math.max(0, maxLength));
}

export function redactObject(value, { maxDepth = 4, maxStringLength = 240 } = {}) {
  const walk = (v, depth) => {
    if (depth > maxDepth) return undefined;
    if (typeof v === 'string') return redactString(v, maxStringLength);
    if (v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map(x => walk(x, depth + 1)).filter(x => x !== undefined);
    if (typeof v !== 'object') return undefined;
    const out = {};
    for (const [key, item] of Object.entries(v).slice(0, 100)) {
      if (SECRET_NAME.test(key.normalize('NFKC'))) continue;
      const clean = walk(item, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  };
  return walk(value, 0);
}

const SERVICES = new Set(['travelpayouts','serpapi','hotelinfo','reference','cabins','seatmaps','seatsaero','roomsaero','googleflights','webhook']);
const METHODS = new Set(['GET','POST','PUT','DELETE','OTHER']);
const OUTCOMES = new Set(['ok','http-error','timeout','transport-error']);
const OPERATIONS = new Set(['travelpayouts.prices','travelpayouts.latest','serpapi.search','google.flights','hotelinfo.enrich','reference.transfers','cabins.refresh','seatmaps.reference','seats.search','seats.trip-details','seats.live','rooms.availability','rooms.details','rooms.refresh','alerts.webhook']);
const ERROR_CODES = new Set(['NO_TP_TOKEN','TP_AUTH','TP_RATE_LIMIT','TP_ERROR','TP_UNREACHABLE','NO_SERPAPI_KEY','SERPAPI_AUTH','SERPAPI_LIMIT','SERPAPI_ERROR','SERPAPI_UNREACHABLE','NO_SEATS_KEY','SEATS_AUTH','SEATS_RATE_LIMIT','ROOMS_AUTH','ROOMS_RATE_LIMIT','REFERENCE_REFRESH_FAILED','CABINS_INVALID_DATA','TIMEOUT']);
const ALERT_REASONS = new Set(['cooldown','source-error','partial-source','checked','check-failed','delivery-failed','delivered']);
export function projectRequestEvent(v) {
  if (!v || !SERVICES.has(v.service) || !OPERATIONS.has(v.operation)) return null;
  return {
    at: safeDate(v.at), service: v.service, operation: v.operation,
    method: METHODS.has(v.method) ? v.method : 'OTHER',
    status: Number.isInteger(v.status) && v.status >= 100 && v.status <= 599 ? v.status : null,
    durationMs: Number.isFinite(v.durationMs) ? Math.max(0, Math.min(600000, Math.round(v.durationMs))) : 0,
    outcome: OUTCOMES.has(v.outcome) ? v.outcome : 'transport-error',
    errorCode: ERROR_CODES.has(v.errorCode) ? v.errorCode : null,
    requestId: typeof v.requestId === 'string' && /^[a-f0-9-]{16,64}$/i.test(v.requestId) ? v.requestId : null
  };
}
export function projectAlertEvent(v) {
  const kinds = new Set(['award','hotel','cash','deals']);
  const phases = new Set(['check','delivery']);
  const statuses = new Set(['ok','error','skipped','partial','retry','exhausted']);
  if (!v || !kinds.has(v.kind) || !phases.has(v.phase) || !statuses.has(v.status)) return null;
  return {
    at: safeDate(v.at), alertId: redactString(String(v.alertId || ''), 80), kind: v.kind,
    phase: v.phase, status: v.status,
    reasonCode: ALERT_REASONS.has(v.reasonCode) ? v.reasonCode : null,
    ...(Number.isInteger(v.matchCount) ? { matchCount: Math.max(0, Math.min(10000, v.matchCount)) } : {}),
    ...(new Set(['webhook','desktop']).has(v.channel) ? { channel: v.channel } : {}),
    ...(Number.isInteger(v.attempt) ? { attempt: Math.max(0, Math.min(100, v.attempt)) } : {}),
    ...(v.nextAttemptAt ? { nextAttemptAt: safeDate(v.nextAttemptAt) } : {}),
    ...(v.deliveredAt ? { deliveredAt: safeDate(v.deliveredAt) } : {})
  };
}
export function safeDate(v) { const n = Date.parse(v); return Number.isFinite(n) ? new Date(n).toISOString() : new Date().toISOString(); }
