// Saved-trip alerts. Each run re-searches (seats.aero when configured), applies the alert's
// limits and notifies only when the set of matching options changes.
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { searchTrip } from './search.mjs';
import { getSettings } from './settings.mjs';

const FILE = () => dataFile('alerts.json');
let notifier = null;

/** Electron registers a callback here to show native Windows notifications. */
export function setNotifier(fn) { notifier = fn; }

// v0.5 alerts stored flat fields (origin/start_date/end_date); convert them on read.
function migrate(a) {
  if (a.query || !a.start_date) return a;
  const mid = a.end_date && a.end_date > a.start_date
    ? new Date((Date.parse(a.start_date) + Date.parse(a.end_date)) / 2).toISOString().slice(0, 10) : a.start_date;
  const flex = a.end_date ? Math.ceil((Date.parse(a.end_date) - Date.parse(a.start_date)) / 172800000) : 0;
  return { ...a, query: { origins: a.origin, destination: a.destination, departDate: mid, returnDate: null, flexDays: flex, cabin: a.cabin || 'business', travelers: a.travelers || 1 }, maxPointsPerTraveler: a.maxPoints || 0, minCpp: a.minCpp || 0 };
}

export const listAlerts = async () => (await readJson(FILE(), [])).map(migrate);

export function createAlert(body) {
  const required = ['origins', 'destination', 'departDate'];
  for (const k of required) if (!body?.[k]) throw Object.assign(new Error(`Alert is missing ${k}`), { status: 400 });
  const alert = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: String(body.title || `${body.destination} ${body.cabin || 'business'}`).slice(0, 120),
    query: {
      origins: body.origins, destination: body.destination, departDate: body.departDate,
      returnDate: body.returnDate || null, flexDays: Number(body.flexDays) || 0,
      cabin: body.cabin || 'business', travelers: Number(body.travelers) || 1,
      nonstopOnly: Boolean(body.nonstopOnly)
    },
    maxPointsPerTraveler: Number(body.maxPointsPerTraveler) || 0,
    minCpp: Number(body.minCpp) || 0,
    active: true,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastResult: null,
    lastSignature: null
  };
  return updateJson(FILE(), [], alerts => { alerts.unshift(alert); }).then(() => alert);
}

export function deleteAlert(id) {
  return updateJson(FILE(), [], alerts => alerts.filter(a => a.id !== id));
}

export function setAlertActive(id, active) {
  return updateJson(FILE(), [], alerts => { const a = alerts.find(x => x.id === id); if (a) a.active = Boolean(active); });
}

function matchesLimits(alert, trip) {
  const perTraveler = trip.totalTargetPoints / trip.travelers;
  if (alert.maxPointsPerTraveler && perTraveler > alert.maxPointsPerTraveler) return false;
  if (alert.minCpp && !(trip.cpp >= alert.minCpp)) return false;
  return true;
}

async function sendWebhook(url, alert, matches) {
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        text: `PointPilot: ${matches.length} option(s) for ${alert.title}`,
        content: `PointPilot: ${matches.length} option(s) for ${alert.title}`,
        matches: matches.slice(0, 5).map(t => ({ explanation: t.explanation, points: t.totalSourcePoints, effectiveCostUsd: Math.round(t.effectiveCostUsd) }))
      })
    });
    return { sent: r.ok, status: r.status };
  } catch (e) { return { sent: false, error: e.message }; }
}

let running = null;
export function runMonitor() {
  // Never overlap two runs (interval tick + "Run now" click).
  running ||= (async () => {
    const settings = await getSettings();
    const alerts = (await listAlerts()).filter(a => a.active && a.query);
    const results = [];
    for (const alert of alerts) {
      let summary;
      try {
        const r = await searchTrip(alert.query, { allowApi: true });
        const matches = r.trips.filter(t => matchesLimits(alert, t));
        const signature = matches.slice(0, 5).map(t => t.id).sort().join(',');
        const isNew = matches.length > 0 && signature !== alert.lastSignature;
        summary = { alertId: alert.id, title: alert.title, mode: r.mode, matches: matches.length, isNew, best: matches[0]?.explanation || null, dataStatus: r.dataStatus };
        if (isNew) {
          summary.webhook = await sendWebhook(settings.webhookUrl, alert, matches);
          if (settings.desktopNotifications && notifier) notifier({ title: `Award space: ${alert.title}`, body: `${matches.length} option(s). Best: ${Math.round(matches[0].totalSourcePoints).toLocaleString()} pts + $${Math.round(matches[0].taxesUsd)}` });
        }
        await updateJson(FILE(), [], all => {
          const a = all.find(x => x.id === alert.id);
          if (a) Object.assign(a, { lastCheckedAt: new Date().toISOString(), lastSignature: matches.length ? signature : null, lastResult: { mode: r.mode, matches: matches.length, best: summary.best } });
        });
      } catch (e) {
        summary = { alertId: alert.id, title: alert.title, error: e.message };
      }
      results.push(summary);
    }
    return { ranAt: new Date().toISOString(), alertsChecked: alerts.length, results };
  })().finally(() => { running = null; });
  return running;
}
