import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { projectRequestEvent, projectAlertEvent } from './redact.mjs';

const FILE = () => dataFile('diagnostics.json');
const EMPTY = () => ({ schemaVersion: 1, requests: [], sourceStatus: {}, alertEvents: [], recordingStartedAt: new Date().toISOString() });
const MAX_BYTES = 2 * 1024 * 1024;
const requestCutoff = now => now - 7 * 86400000;
const alertCutoff = now => now - 30 * 86400000;
const safeUsage = value => {
  const src = value && typeof value === 'object' ? value : {};
  const int = x => Number.isSafeInteger(x) && x >= 0 ? x : 0;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(src.day || '') ? src.day : null;
  const month = /^\d{4}-\d{2}$/.test(src.month || '') ? src.month : (day ? day.slice(0,7) : null);
  return { label:'attempted requests recorded by Point Pilot', day, month, calls:int(src.calls), roomsCalls:int(src.roomsCalls), tpCalls:int(src.tpCalls), serpCalls:int(src.serpCalls) };
};
const trim = (doc, now) => {
  doc.requests = (Array.isArray(doc.requests) ? doc.requests : []).map(projectRequestEvent).filter(e => e && Date.parse(e.at) >= requestCutoff(now)).slice(-500);
  const events = (Array.isArray(doc.alertEvents) ? doc.alertEvents : []).map(projectAlertEvent).filter(e => e && Date.parse(e.at) >= alertCutoff(now)).slice(-2000);
  const counts = new Map();
  doc.alertEvents = events.reverse().filter(e => { const n = counts.get(e.alertId) || 0; if (n >= 50) return false; counts.set(e.alertId,n+1); return true; }).reverse();
  return doc;
};

export function createDiagnostics({ store = { readJson, updateJson }, appInfo = {}, usage = async () => ({}), monitor = async () => [], sourceInfo = async () => ({}), now = () => Date.now(), randomBytes = nodeRandomBytes } = {}) {
  let staged = null;
let persistenceUnavailable = false;
const read = async () => {
    try {
      const doc = await store.readJson(FILE(), EMPTY());
      const clean = { schemaVersion:1, requests:Array.isArray(doc?.requests)?doc.requests:[], sourceStatus:sanitizeSourceStatus(doc?.sourceStatus), alertEvents:Array.isArray(doc?.alertEvents)?doc.alertEvents:[], recordingStartedAt:dateOrNull(doc?.recordingStartedAt) || new Date(now()).toISOString() };
      return trim(clean, now());
    } catch { persistenceUnavailable = true; return EMPTY(); }
  };
  const recordRequest = async event => { try { const projected = projectRequestEvent(event); if (!projected) return false; await store.updateJson(FILE(), EMPTY(), doc => { trim(doc, now()); doc.requests.push(projected); trim(doc, now()); }); return true; } catch { persistenceUnavailable = true; return false; } };
  const recordAlertEvent = async event => { try { const projected = projectAlertEvent(event); if (!projected) return false; await store.updateJson(FILE(), EMPTY(), doc => { trim(doc, now()); doc.alertEvents.push(projected); trim(doc, now()); }); return true; } catch { persistenceUnavailable = true; return false; } };
  const removeAlertHistory = async alertId => { try { await store.updateJson(FILE(), EMPTY(), doc => { doc.alertEvents = (doc.alertEvents || []).filter(e => e.alertId !== alertId); }); return true; } catch { persistenceUnavailable = true; return false; } };
  const recordSourceObservation = async o => {
    if (!o || typeof o.source !== 'string' || !/^[a-z][a-z0-9.-]{1,40}$/.test(o.source)) return false;
    const safe = { source:o.source, lastAttemptAt:o.lastAttemptAt ? new Date(o.lastAttemptAt).toISOString() : new Date(now()).toISOString(), lastSuccessAt:o.lastSuccessAt ? new Date(o.lastSuccessAt).toISOString() : null, lastFailureCode:knownError(o.lastFailureCode), providerObservedMinAt:o.providerObservedMinAt ? new Date(o.providerObservedMinAt).toISOString() : null, providerObservedMaxAt:o.providerObservedMaxAt ? new Date(o.providerObservedMaxAt).toISOString() : null, sampleCount:Number.isSafeInteger(o.sampleCount)?Math.max(0,o.sampleCount):0, ...(Number.isSafeInteger(o.revision)&&o.revision>=0?{revision:o.revision}:{}), scope:'recent-observed-records', cacheTtlMinutes:Number.isFinite(o.cacheTtlMinutes)?Math.max(0,Math.min(525600,o.cacheTtlMinutes)):null, completeness:['complete','truncated','unknown'].includes(o.completeness)?o.completeness:'unknown' };
    try { await store.updateJson(FILE(), EMPTY(), d => { d.sourceStatus ||= {}; const previous=d.sourceStatus[safe.source]||{}; d.sourceStatus[safe.source] = { ...previous, ...safe, lastSuccessAt:safe.lastSuccessAt||previous.lastSuccessAt||null, lastFailureCode:safe.lastFailureCode||null, providerObservedMinAt:safe.providerObservedMinAt||previous.providerObservedMinAt||null, providerObservedMaxAt:safe.providerObservedMaxAt||previous.providerObservedMaxAt||null, sampleCount:safe.sampleCount }; }); return true; } catch { persistenceUnavailable = true; return false; }
  };
  const preview = async () => {
    const d = await read();
    const [providedApp, used, alerts, sources] = await Promise.all([Promise.resolve(typeof appInfo==='function'?appInfo():appInfo), Promise.resolve(typeof usage==='function'?usage():usage), Promise.resolve(typeof monitor==='function'?monitor():monitor), Promise.resolve(typeof sourceInfo==='function'?sourceInfo():sourceInfo)]);
    const safeApp = sanitizeApp(providedApp);
    const bundle = {
      format:'pointpilot-diagnostics', schemaVersion:1, generatedAt:new Date(now()).toISOString(), app:safeApp,
      requests:d.requests, freshness:mergeFreshness(d.sourceStatus, sources), usage:safeUsage(used), alerts:makeAlerts(d.alertEvents, alerts, randomBytes),
      coverage:{recordingStartedAt:d.recordingStartedAt || null, requestRetention:'latest 500 requests / 7 days', alertRetention:'50 per alert / 2,000 total / 30 days', requestCount:d.requests.length, alertEventCount:d.alertEvents.length, historyAvailable:Boolean(d.requests.length || d.alertEvents.length), persistence:persistenceUnavailable?'unavailable':'best-effort'},
      redaction:{schemaVersion:1,policy:'allowlist projection; secrets, URLs, travel details, titles, paths and raw errors excluded'}
    };
    const bytes = Buffer.byteLength(JSON.stringify(bundle));
    if (bytes > MAX_BYTES) throw Object.assign(new Error('Diagnostics bundle exceeds 2 MiB'), { code:'DIAGNOSTICS_TOO_LARGE', status:413 });
    const exportId = randomBytes(24).toString('hex');
    staged = { exportId, expiresAt:new Date(now()+300000).toISOString(), bundle, bytes };
    return { exportId, expiresAt:staged.expiresAt, summary:{bytes,requests:bundle.requests.length,alertEvents:bundle.alerts.events.length,hasHistory:bundle.coverage.historyAvailable}, bundle:structuredClone(bundle) };
  };
  const exportBundle = async exportId => {
    if (!staged || staged.exportId !== exportId || Date.parse(staged.expiresAt) <= now()) { staged = null; throw Object.assign(new Error('Diagnostics preview is missing or expired'), { code:'DIAGNOSTICS_PREVIEW_EXPIRED', status:409 }); }
    return { filename:`pointpilot-diagnostics-${staged.bundle.generatedAt.slice(0,10)}.json`, bundle:structuredClone(staged.bundle) };
  };
  const clearHistory = async () => { try { await store.updateJson(FILE(), EMPTY(), () => EMPTY()); } finally { staged = null; } return { ok:true }; };
  return { preview, exportBundle, clearHistory, recordRequest, recordAlertEvent, removeAlertHistory, recordSourceObservation };
}
function sanitizeApp(input) {
  const a = input && typeof input === 'object' ? input : {};
  const pick = (v, re) => typeof v==='string' && re.test(v) ? v.slice(0,80) : null;
  const version = pick(a.version,/^[0-9A-Za-z.+-]{1,40}$/);
  const mode = ['desktop','browser','packaged'].includes(a.mode)?a.mode:'unknown';
  return { version, platform:pick(a.platform,/^(win32|darwin|linux)$/), architecture:pick(a.architecture,/^(x64|arm64|ia32|arm)$/), nodeVersion:pick(a.nodeVersion,/^v?\d+(?:\.\d+){0,2}$/), electronVersion:pick(a.electronVersion,/^\d+(?:\.\d+){0,2}$/), chromiumVersion:pick(a.chromiumVersion,/^\d+(?:\.\d+){0,2}$/), mode, locale:pick(a.locale,/^[A-Za-z0-9_-]{1,40}$/), timezone:pick(a.timezone,/^[A-Za-z0-9_+./-]{1,80}$/), monitorIntervalMinutes:Number.isFinite(a.monitorIntervalMinutes)?Math.max(0,Math.min(1440,a.monitorIntervalMinutes)):null, configured:{ travelpayouts:Boolean(a.configured?.travelpayouts), serpapi:Boolean(a.configured?.serpapi), seats:Boolean(a.configured?.seats), rooms:Boolean(a.configured?.rooms), webhook:Boolean(a.configured?.webhook) } };
}
function mergeFreshness(saved, current) {
  return sanitizeSourceStatus({ ...(saved || {}), ...(current && typeof current==='object' ? current : {}) });
}
function makeAlerts(events, current, randomBytes) {
  const ids = new Map(), pseudonym = id => { if(!ids.has(id)) ids.set(id,randomBytes(12).toString('hex')); return ids.get(id); };
  const safeEvents = events.map(e => ({...e,alertId:pseudonym(e.alertId)}));
  const snapshots = Array.isArray(current) ? current.slice(0,500) : [];
  return { snapshots:snapshots.map(a => ({id:pseudonym(String(a.id||'')),kind:['award','hotel','cash','deals'].includes(a.kind)?a.kind:'award',active:Boolean(a.active),lastAttemptAt:dateOrNull(a.lastAttemptAt),lastStatus:['ok','error'].includes(a.lastStatus)?a.lastStatus:null,lastErrorCode:knownError(a.lastError),deliveryStatus:safeDelivery(a.deliveryState)})), events:safeEvents };
}
function dateOrNull(v){const n=Date.parse(v);return Number.isFinite(n)?new Date(n).toISOString():null;}
const KNOWN_CODES=new Set(['NO_TP_TOKEN','TP_AUTH','TP_RATE_LIMIT','TP_ERROR','TP_UNREACHABLE','NO_SERPAPI_KEY','SERPAPI_AUTH','SERPAPI_LIMIT','SERPAPI_ERROR','SERPAPI_UNREACHABLE','NO_SEATS_KEY','SEATS_AUTH','SEATS_RATE_LIMIT','ROOMS_AUTH','ROOMS_RATE_LIMIT','REFERENCE_REFRESH_FAILED','TIMEOUT']);
function knownError(v){return KNOWN_CODES.has(v)?v:null;}
function safeDelivery(v){const out={};for(const [k,x] of Object.entries(v||{})){if(!['webhook','desktop'].includes(k))continue;out[k]={status:['ok','error'].includes(x?.status)?x.status:null,attempts:Number.isSafeInteger(x?.attempts)?Math.max(0,x.attempts):0,deliveredAt:dateOrNull(x?.deliveredAt),nextAttemptAt:dateOrNull(x?.nextAttemptAt)};}return out;}
function sanitizeSourceStatus(value){const out={};for(const [key,v] of Object.entries(value||{}).slice(0,100)){if(!/^[a-z][a-z0-9.-]{1,40}$/.test(key)||!v||typeof v!=='object')continue;out[key]={source:key,lastAttemptAt:dateOrNull(v.lastAttemptAt),lastSuccessAt:dateOrNull(v.lastSuccessAt),lastFailureCode:knownError(v.lastFailureCode),providerObservedMinAt:dateOrNull(v.providerObservedMinAt),providerObservedMaxAt:dateOrNull(v.providerObservedMaxAt),sampleCount:Number.isSafeInteger(v.sampleCount)?Math.max(0,v.sampleCount):0,...(Number.isSafeInteger(v.revision)&&v.revision>=0?{revision:v.revision}:{}),scope:'recent-observed-records',cacheTtlMinutes:Number.isFinite(v.cacheTtlMinutes)?Math.max(0,Math.min(525600,v.cacheTtlMinutes)):null,completeness:['complete','truncated','unknown'].includes(v.completeness)?v.completeness:'unknown'};}return out;}

const singleton = createDiagnostics();
export const recordDiagnosticRequest = (...args) => singleton.recordRequest(...args);
export const recordDiagnosticAlertEvent = (...args) => singleton.recordAlertEvent(...args);
export const removeDiagnosticAlertHistory = (...args) => singleton.removeAlertHistory(...args);
export const recordDiagnosticSource = (...args) => singleton.recordSourceObservation(...args);
