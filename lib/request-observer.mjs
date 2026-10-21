import { randomUUID } from 'node:crypto';
import { recordDiagnosticRequest, recordDiagnosticSource } from './diagnostics.mjs';
import { projectRequestEvent } from './redact.mjs';

export function createRequestObserver({ record = recordDiagnosticRequest, source = recordDiagnosticSource, now = () => Date.now() } = {}) {
  const recordOutcome = async input => {
    const item = projectRequestEvent({ ...input, requestId:input.requestId || randomUUID() });
    if (!item) return false;
    try { await record(item); } catch { /* diagnostics must never affect the provider call */ }
    const sourceCompletion = input.sourceCompletion || {};
    try { await source({ source:sourceCompletion.source || item.service, lastAttemptAt:item.at, lastSuccessAt:item.outcome==='ok'?item.at:undefined, lastFailureCode:item.outcome==='ok'?null:(item.errorCode || null), providerObservedMinAt:sourceCompletion.providerObservedMinAt, providerObservedMaxAt:sourceCompletion.providerObservedMaxAt, revision:sourceCompletion.revision, sampleCount:1, cacheTtlMinutes:sourceCompletion.cacheTtlMinutes, completeness:sourceCompletion.completeness || 'unknown' }); } catch { /* best-effort freshness */ }
    return true;
  };
  const observeRequest = async (descriptor, request, metadata = {}) => {
    const started = now(); let response;
    try {
      response = await request();
      const status = Number.isInteger(response?.status) ? response.status : null;
      let classified = {};
      try { if (typeof metadata.classify === 'function') classified = await metadata.classify(response) || {}; } catch { /* classification cannot affect the request */ }
      const outcome = response?.ok === false ? 'http-error' : (['ok','http-error'].includes(classified.outcome)?classified.outcome:'ok');
      const statusCode = status===429 ? (descriptor.service==='travelpayouts'?'TP_RATE_LIMIT':descriptor.service==='serpapi'||descriptor.service==='hotelinfo'?'SERPAPI_LIMIT':descriptor.service==='seatsaero'?'SEATS_RATE_LIMIT':descriptor.service==='roomsaero'?'ROOMS_RATE_LIMIT':null) : (status===401||status===403 ? (descriptor.service==='travelpayouts'?'TP_AUTH':descriptor.service==='serpapi'||descriptor.service==='hotelinfo'?'SERPAPI_AUTH':descriptor.service==='seatsaero'?'SEATS_AUTH':descriptor.service==='roomsaero'?'ROOMS_AUTH':null) : null);
      await recordOutcome({ ...descriptor, ...metadata, status, outcome, errorCode:classified.errorCode || statusCode, sourceCompletion:classified.sourceCompletion, durationMs:now()-started });
      return response;
    } catch (error) {
      const name = String(error?.name || '');
      const code = ['AbortError','TimeoutError'].includes(name) ? 'TIMEOUT' : (typeof error?.code === 'string' && /^[A-Z0-9_]{2,48}$/.test(error.code) ? error.code : null);
      await recordOutcome({ ...descriptor, status:null, outcome:code==='TIMEOUT'?'timeout':'transport-error', errorCode:code, durationMs:now()-started, ...metadata });
      throw error;
    }
  };
  const recordOperation = (descriptor, metadata = {}) => recordOutcome({ ...descriptor, status:metadata.status??null, outcome:metadata.outcome || (metadata.status >= 400?'http-error':'ok'), errorCode:metadata.errorCode, durationMs:metadata.durationMs || 0, sourceCompletion:metadata.sourceCompletion });
  const recordSourceObservation = async observation => { try { return await source(observation); } catch { return false; } };
  return { observeRequest, recordOutcome, recordOperation, recordSourceObservation };
}
const observer = createRequestObserver();
export const observeRequest = (...args) => observer.observeRequest(...args);
export const recordObservedOutcome = (...args) => observer.recordOutcome(...args);
export const recordObservedOperation = (...args) => observer.recordOperation(...args);
export const recordSourceObservation = (...args) => observer.recordSourceObservation(...args);
