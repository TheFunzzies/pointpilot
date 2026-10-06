import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_DIR, dataDir, dataFile } from './lib/paths.mjs';
import { listProviders, providerUrlAllowed } from './lib/providers.mjs';
import { listPrograms } from './lib/programs.mjs';
import { loadHistory, recordAwards, routeHistoryStats, getSources } from './lib/history.mjs';
import { saveAwards, normalizeFlightAward, normalizeHotelAward } from './lib/awards.mjs';
import { searchTrip, searchHotels, evaluateSelection, expandAwards } from './lib/search.mjs';
import { listAlerts, createAlert, deleteAlert, setAlertActive, runMonitor, setNotifier } from './lib/monitor.mjs';
import { loadUser, saveUser, exampleUser, publicSettings, updateSettings, getSettings, apiUsage } from './lib/settings.mjs';
import { transferData, loadCachedReference, refreshReference, referenceStatus } from './lib/reference.mjs';
import { PlaceError } from './lib/places.mjs';
import { searchCash, dealsFromAirports, cashForItinerary } from './lib/cash.mjs';
import { getTripsCached } from './lib/flights.mjs';
import { getPlan, addStay, removeStay, clearPlan } from './lib/stayplan.mjs';
import { resolveSeatMaps } from './lib/seatmaps.mjs';
import { enrichHotels } from './lib/hotelinfo.mjs';
import { getTripPlan, updateTripSettings, setFlights, clearTrip, searchPositioning, removeFlight, setPositioning } from './lib/tripplan.mjs';
import { loadCachedCabins, refreshCabins, productCatalog } from './lib/cabins.mjs';
import { recordApiCalls } from './lib/settings.mjs';

const VERSION = process.env.POINTPILOT_VERSION || '0.6.0';
const MAX_BODY = 25 * 1024 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
};

function send(res, code, payload, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(type === 'application/json' ? JSON.stringify(payload) : payload);
}

async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

/**
 * The server only listens on 127.0.0.1, but any web page open in the user's browser can still
 * send requests to localhost. Reject anything that isn't from PointPilot's own origin:
 *  - Host must be our loopback host:port (blocks DNS-rebinding),
 *  - a cross-site Origin is refused,
 *  - state-changing requests must be application/json (forces a CORS preflight we never grant).
 */
function rejectForeign(req, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(String(req.headers.host || '').toLowerCase())) return 'Bad host';
  const origin = req.headers.origin;
  if (origin && !allowed.some(h => origin === `http://${h}`)) return 'Cross-origin request refused';
  if (!['GET', 'HEAD'].includes(req.method) && !String(req.headers['content-type'] || '').startsWith('application/json')) return 'JSON required';
  return null;
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  let content;
  try { content = await readFile(file); }
  catch { file = path.join(PUBLIC_DIR, 'index.html'); content = await readFile(file); }
  send(res, 200, content, MIME[path.extname(file)] || 'application/octet-stream');
}

function makeHandler(getPort) {
  return async function handle(req, res) {
    const port = getPort();
    const refusal = rejectForeign(req, port);
    if (refusal) return send(res, 403, { error: refusal });
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = u.pathname;
    const m = req.method;
    const q = Object.fromEntries(u.searchParams);
    try {
      if (!p.startsWith('/api/')) return m === 'GET' ? serveStatic(res, p) : send(res, 404, { error: 'Not found' });

      if (m === 'GET' && p === '/api/health') {
        const [h, s, usage] = await Promise.all([loadHistory(), getSettings(), apiUsage()]);
        return send(res, 200, { ok: true, version: VERSION, awardObservations: h.length, dataDir: dataDir(), liveData: s.seatsAeroApiKey ? 'seats.aero' : 'manual-only', cashData: { travelpayouts: Boolean(s.travelpayoutsToken), google: Boolean(s.serpApiKey) }, apiCallsToday: usage.calls, roomsCallsToday: usage.roomsCalls, tpCallsToday: usage.tpCalls, serpCallsThisMonth: usage.serpCalls, reference: referenceStatus() });
      }
      if (m === 'GET' && p === '/api/user') return send(res, 200, await loadUser());
      if (m === 'GET' && p === '/api/user/example') return send(res, 200, exampleUser());
      if (m === 'PUT' && p === '/api/user') return send(res, 200, await saveUser(await body(req)));
      if (m === 'GET' && p === '/api/settings') return send(res, 200, await publicSettings());
      if (m === 'PUT' && p === '/api/settings') return send(res, 200, await updateSettings(await body(req)));
      if (m === 'GET' && p === '/api/programs') return send(res, 200, { programs: listPrograms() });
      if (m === 'GET' && p === '/api/providers') return send(res, 200, { providers: listProviders() });
      if (m === 'GET' && p === '/api/transfer-partners') return send(res, 200, { ...transferData(), status: referenceStatus() });
      if (m === 'POST' && p === '/api/transfer-partners/refresh') { const r = await refreshReference(); return send(res, 200, { ...r, status: referenceStatus() }); }

      if (m === 'POST' && p === '/api/search/trip') return send(res, 200, await searchTrip(await body(req)));
      if (m === 'POST' && p === '/api/search/hotels') return send(res, 200, await searchHotels(await body(req)));
      if (m === 'GET' && p === '/api/stay-plan') return send(res, 200, await getPlan());
      if (m === 'POST' && p === '/api/stay-plan/stays') return send(res, 201, await addStay(await body(req)));
      if (m === 'DELETE' && p === '/api/stay-plan') return send(res, 200, await clearPlan());
      const stayMatch = p.match(/^\/api\/stay-plan\/stays\/([a-z0-9]+)$/i);
      if (stayMatch && m === 'DELETE') return send(res, 200, await removeStay(stayMatch[1]));
      if (m === 'GET' && p === '/api/trip-plan') return send(res, 200, await getTripPlan());
      if (m === 'PUT' && p === '/api/trip-plan/settings') return send(res, 200, await updateTripSettings(await body(req)));
      if (m === 'PUT' && p === '/api/trip-plan/flights') return send(res, 200, await setFlights(await body(req)));
      if (m === 'DELETE' && p === '/api/trip-plan') return send(res, 200, await clearTrip());
      if (m === 'POST' && p === '/api/trip-plan/positioning/search') return send(res, 200, await searchPositioning(await body(req)));
      const tripDir = p.match(/^\/api\/trip-plan\/(flights|positioning)\/(outbound|return)$/);
      if (tripDir && m === 'DELETE') return send(res, 200, tripDir[1] === 'flights' ? await removeFlight(tripDir[2]) : await setPositioning(tripDir[2], null));
      if (tripDir && m === 'PUT' && tripDir[1] === 'positioning') return send(res, 200, await setPositioning(tripDir[2], (await body(req)).option));
      if (m === 'GET' && p === '/api/cabin-products') return send(res, 200, { products: productCatalog() });
      if (m === 'POST' && p === '/api/hotels/enrich') return send(res, 200, await enrichHotels(await body(req)));
      if (m === 'POST' && p === '/api/award/expand') return send(res, 200, await expandAwards(await body(req)));
      if (m === 'POST' && p === '/api/trip/evaluate') return send(res, 200, await evaluateSelection(await body(req)));
      if (m === 'GET' && p === '/api/seatmaps') return send(res, 200, await resolveSeatMaps({ carrier: q.carrier, aircraftName: q.aircraft, aircraftCode: q.code }));
      if (m === 'GET' && p === '/api/award/trips') {
        if (!q.id) return send(res, 400, { error: 'Missing availability id' });
        const s = await getSettings();
        return send(res, 200, await getTripsCached({ apiKey: s.seatsAeroApiKey, availabilityId: q.id, cabin: q.cabin }, n => recordApiCalls(n, 'seats')));
      }
      if (m === 'POST' && p === '/api/cash/search') return send(res, 200, await searchCash(await body(req)));
      if (m === 'POST' && p === '/api/cash/deals') return send(res, 200, await dealsFromAirports(await body(req)));
      if (m === 'POST' && p === '/api/cash/itinerary') return send(res, 200, await cashForItinerary(await body(req)));

      if (m === 'POST' && p === '/api/manual-award') {
        const row = normalizeFlightAward({ ...(await body(req)), dataSource: 'manual' });
        if (!/^[A-Z]{3}$/.test(row.origin) || !/^[A-Z]{3}$/.test(row.destination)) return send(res, 400, { error: 'Origin and destination must be 3-letter airport codes.' });
        if (!row.date || !(row.mileageCost > 0) || !row.program) return send(res, 400, { error: 'Program, date and points are required.' });
        await saveAwards([row]);
        await recordAwards([row], { sourceType: 'manual_entry', sourceId: 'manual-entry' });
        return send(res, 201, { ok: true, row });
      }
      if (m === 'POST' && p === '/api/manual-hotel') {
        const row = normalizeHotelAward({ ...(await body(req)), dataSource: 'manual' });
        if (!row.name || !row.checkIn || !(row.nightlyPoints > 0) || !row.program) return send(res, 400, { error: 'Program, hotel, check-in and points/night are required.' });
        await saveAwards([row]);
        await recordAwards([row], { sourceType: 'manual_entry', sourceId: 'manual-entry' });
        return send(res, 201, { ok: true, row });
      }
      if (m === 'POST' && p === '/api/browser-capture-html') {
        const b = await body(req);
        const html = String(b.html || '');
        if (!html) return send(res, 400, { error: 'No HTML supplied' });
        const dir = dataFile('captures'); await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${String(b.providerId || 'manual').replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.html`);
        await writeFile(file, html, 'utf8');
        return send(res, 201, { ok: true, file });
      }

      if (m === 'GET' && p === '/api/history') {
        const history = await loadHistory();
        const rows = history.filter(x => (!q.program || x.program === q.program) && (!q.origin || x.origin === q.origin.toUpperCase()) &&
          (!q.destination || x.destination === q.destination.toUpperCase()) && (!q.cabin || x.cabin === q.cabin));
        return send(res, 200, { rows: rows.slice(0, 500), count: rows.length });
      }
      if (m === 'GET' && p === '/api/history/stats') return send(res, 200, routeHistoryStats(await loadHistory(), q));
      if (m === 'GET' && p === '/api/history/sources') return send(res, 200, { sources: getSources() });

      if (m === 'GET' && p === '/api/alerts') return send(res, 200, await listAlerts());
      if (m === 'POST' && p === '/api/alerts') return send(res, 201, await createAlert(await body(req)));
      const alertMatch = p.match(/^\/api\/alerts\/([a-z0-9]+)$/i);
      if (alertMatch && m === 'DELETE') { await deleteAlert(alertMatch[1]); return send(res, 200, { ok: true }); }
      if (alertMatch && m === 'PATCH') { const b = await body(req); await setAlertActive(alertMatch[1], b.active); return send(res, 200, { ok: true }); }
      if (m === 'POST' && p === '/api/monitor/run') return send(res, 200, await runMonitor({ force: true }));

      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e instanceof PlaceError ? 400 : e.status || 500;
      if (status >= 500) console.error(e);
      return send(res, status, { error: e.message, code: e.code || null });
    }
  };
}

let monitorTimer = null;
async function scheduleMonitor() {
  const { monitorIntervalMinutes } = await getSettings();
  monitorTimer = setTimeout(async () => {
    try {
      const r = await runMonitor();
      if (r.results.some(x => x.isNew)) console.log('[monitor] new matches', r.results.filter(x => x.isNew).map(x => x.title));
    } catch (e) { console.error('[monitor]', e); }
    scheduleMonitor();
  }, monitorIntervalMinutes * 60000);
  monitorTimer.unref?.();
}

export { runMonitor, setNotifier, getSettings };

export function startServer({ port = Number(process.env.PORT || 3000), onReady, monitor = true } = {}) {
  let actualPort = port;
  const server = http.createServer(makeHandler(() => actualPort));
  server.listen(port, '127.0.0.1', async () => {
    actualPort = server.address().port;
    await loadCachedReference().catch(e => console.warn('[reference]', e.message));
    await loadCachedCabins().catch(e => console.warn('[cabins]', e.message));
    console.log(`PointPilot ${VERSION} running at http://127.0.0.1:${actualPort} (data: ${dataDir()})`);
    onReady?.(actualPort);
    // Pull the latest transfer-partner and cabin-product data from GitHub now and twice a day.
    const refreshAll = () => { refreshReference().then(r => r.updated && console.log('[reference] transfer partners updated to', r.lastUpdated)); refreshCabins(); };
    refreshAll();
    setInterval(refreshAll, 12 * 3600 * 1000).unref();
    if (monitor) scheduleMonitor();
  });
  server.on('close', () => clearTimeout(monitorTimer));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--monitor-once')) {
    await loadCachedReference();
    console.log(JSON.stringify(await runMonitor(), null, 2));
  } else startServer();
}
