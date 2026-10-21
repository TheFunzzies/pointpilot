import { createReadinessService, MANUAL_CODES } from './readiness.mjs';
import { ApiError } from './errors.mjs';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const bad = message => { throw new ApiError(message, 400, 'BAD_INPUT'); };
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) bad('Unexpected readiness request fields.');
}
function scope(value) { if (!['trip', 'stay'].includes(value)) bad('scope must be trip or stay.'); return value; }
function hash(value, optional = false) { if (optional && value === undefined) return; if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) bad('A current plan hash is required.'); }
function id(value) { if (typeof value !== 'string' || !value.length || value.length > 200 || Array.from(value).some(c => c.charCodeAt(0) < 32)) bad('A bounded selection identity is required.'); }
function source(value) {
  if (typeof value !== 'string' || value.length > 2048) bad('A bounded HTTPS program source link is required.');
  let u;
  try { u = new URL(value); } catch { bad('A valid HTTPS source link is required.'); }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash) bad('Use an HTTPS program page without credentials, query parameters, or fragments.');
}
export function createRoutes(deps = {}) {
  const service = deps.service || createReadinessService(deps);
  return async ({ method, path, body, query }) => {
    if (method === 'GET' && path === '/api/booking-readiness/hotel-refresh') {
      const q = query instanceof URLSearchParams ? Object.fromEntries(query) : query || {};
      object(q, ['scope', 'planHash', 'stayId']); scope(q.scope); hash(q.planHash); id(q.stayId);
      return { status: 200, payload: await service.hotelRefreshStatus(q) };
    }
    if (method === 'GET' && path === '/api/booking-readiness') {
      const q = query instanceof URLSearchParams ? Object.fromEntries(query) : query || {};
      object(q, ['scope']);
      return { status: 200, payload: await service.get({ scope: scope(q.scope) }) };
    }
    if (method !== 'POST' || !['/api/booking-readiness/check', '/api/booking-readiness/confirmations', '/api/booking-readiness/hotel-refresh'].includes(path)) return null;
    if (path.endsWith('/check')) {
      object(body, ['scope', 'expectedPlanHash']); scope(body.scope); hash(body.expectedPlanHash, true);
      return { status: 200, payload: await service.check(body) };
    }
    if (path.endsWith('/confirmations')) {
      object(body, ['scope', 'planHash', 'selectionId', 'itemCode', 'amount', 'sourceUrl']); scope(body.scope); hash(body.planHash); id(body.selectionId); source(body.sourceUrl);
      if (!MANUAL_CODES.includes(body.itemCode)) bad('This item cannot be manually confirmed.');
      if (body.itemCode === 'FEES_UNKNOWN' && body.amount === undefined) bad('Fee confirmation requires an amount and currency.');
      if (body.amount !== undefined) {
        object(body.amount, ['currency', 'value']);
        if (body.itemCode !== 'FEES_UNKNOWN' || typeof body.amount.currency !== 'string' || !CURRENCIES.has(body.amount.currency) || typeof body.amount.value !== 'number' || !Number.isFinite(body.amount.value) || body.amount.value < 0 || body.amount.value > 1e7) bad('A finite nonnegative fee amount and ISO currency are required.');
      }
      return { status: 200, payload: await service.confirm(body) };
    }
    object(body, ['scope', 'planHash', 'stayId']); scope(body.scope); hash(body.planHash); id(body.stayId);
    try { return { status: 202, payload: await service.hotelRefresh(body) }; }
    catch (e) { if (e.status === 429) return { status: 429, payload: { error: 'Hotel refresh allowance or provider quota exhausted.', code: 'API_RATE_LIMIT', retryAfter: e.retryAfter || 86400 } }; throw e; }
  };
}
