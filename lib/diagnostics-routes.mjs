import { createDiagnostics } from './diagnostics.mjs';
import { apiUsage, getSettings } from './settings.mjs';
import { listAlerts } from './monitor.mjs';
import { referenceStatus } from './reference.mjs';
import { cabinDataStatus } from './cabins.mjs';

export function createRoutes(deps = {}) {
  const diagnostics = deps.diagnostics || createDiagnostics({
    now:deps.now,
    usage:apiUsage,
    monitor:listAlerts,
    appInfo:async()=>{
      const s=await getSettings();
      return {version:deps.version,platform:process.platform,architecture:process.arch,nodeVersion:process.versions.node,electronVersion:process.versions.electron,chromiumVersion:process.versions.chrome,mode:process.versions.electron?'desktop':'browser',locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,monitorIntervalMinutes:s.monitorIntervalMinutes,configured:{travelpayouts:Boolean(s.travelpayoutsToken),serpapi:Boolean(s.serpApiKey),seats:Boolean(s.seatsAeroApiKey),rooms:Boolean(s.seatsAeroApiKey),webhook:Boolean(s.webhookUrl)}};
    },
    sourceInfo:async()=>{
      const ref=referenceStatus(), cabins=cabinDataStatus();
      return {reference:{lastAttemptAt:ref.lastRefresh?.at,lastSuccessAt:ref.lastRefresh?.ok?ref.lastRefresh.at:null,lastFailureCode:ref.lastRefresh&&!ref.lastRefresh.ok?'REFERENCE_REFRESH_FAILED':null,providerObservedMaxAt:ref.updatedAt||`${ref.lastUpdated||''}T00:00:00.000Z`,revision:ref.revision,sampleCount:0,completeness:'unknown'},cabins:{providerObservedMaxAt:cabins.lastUpdated?`${cabins.lastUpdated}T00:00:00.000Z`:null,sampleCount:0,completeness:'unknown'}};
    }
  });
  return async ctx => {
    const method = String(ctx?.method || ctx?.req?.method || '').toUpperCase();
    const path = String(ctx?.path || ctx?.pathname || ctx?.url?.pathname || '');
    const body = ctx?.body;
    if (path === '/api/diagnostics/preview' && method === 'POST') {
      if (!plainObject(body) || Object.keys(body).length) return badRequest();
      return diagnostics.preview().then(payload => ({ status:200, payload }));
    }
    if (path === '/api/diagnostics/export' && method === 'POST') {
      if (!plainObject(body) || Object.keys(body).length !== 1 || typeof body.exportId !== 'string' || !/^[a-f0-9]{48}$/i.test(body.exportId)) return badRequest();
      return diagnostics.exportBundle(body.exportId).then(payload => ({ status:200,payload }), error => ({ status:error.status || 409,payload:{error:error.message,code:error.code || 'DIAGNOSTICS_PREVIEW_EXPIRED'} }));
    }
    if (path === '/api/diagnostics/history' && method === 'DELETE') {
      if (!plainObject(body) || Object.keys(body).length) return badRequest();
      return diagnostics.clearHistory().then(payload => ({status:200,payload}));
    }
    return null;
  };
}
const plainObject = v => v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const badRequest = () => ({status:400,payload:{error:'Invalid diagnostics request',code:'INVALID_DIAGNOSTICS_REQUEST'}});
