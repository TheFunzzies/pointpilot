// Saved alerts, re-checked in the background:
//   award  — award-space trips (seats.aero / manual awards)
//   hotel  — hotel award stays (rooms.aero / manual)
//   cash   — cash fare for a route; fires below a target price or well below the usual price
//   deals  — cheap cash fares from home airports to anywhere
// Each alert only notifies when something new appears (new options, a lower price, a new deal).
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { searchTrip, searchHotels, expandAwards } from './search.mjs';
import { searchCash, dealsFromAirports } from './cash.mjs';
import { googleFlights } from './serpapi.mjs';
import { getSettings, recordApiCalls } from './settings.mjs';
import { todayISO } from './transfers.mjs';

const FILE = () => dataFile('alerts.json');
const DEALS_MIN_HOURS = 6;
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

const missing = (body, keys, what) => { for (const k of keys) if (!body?.[k]) throw Object.assign(new Error(`${what} is missing ${k}`), { status: 400 }); };
const base = body => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, active: true, createdAt: new Date().toISOString(), lastCheckedAt: null, lastResult: null, lastSignature: null, title: String(body.title || '').slice(0, 120) });
const num = v => Math.max(0, Number(v) || 0);

function buildAlert(body) {
  const kind = body?.kind || 'award';
  if (kind === 'hotel') {
    missing(body, ['destination', 'checkIn'], 'Hotel alert');
    return { ...base(body), kind, title: String(body.title || `${body.destination} hotel`).slice(0, 120),
      query: { destination: body.destination, checkIn: body.checkIn, checkOut: body.checkOut || null, flexDays: num(body.flexDays), roomType: body.roomType || 'any', maxPointsPerNight: num(body.maxPointsPerNight) },
      maxPointsPerNight: num(body.maxPointsPerNight), minCpp: num(body.minCpp) };
  }
  if (kind === 'cash') {
    missing(body, ['origins', 'destination', 'departDate'], 'Price alert');
    return { ...base(body), kind, title: String(body.title || `${body.destination} cash fare`).slice(0, 120),
      query: { origins: body.origins, destination: body.destination, departDate: body.departDate, returnDate: body.returnDate || null, flexDays: num(body.flexDays), travelers: num(body.travelers) || 1, nonstopOnly: Boolean(body.nonstopOnly), cabin: 'economy' },
      targetPrice: num(body.targetPrice), dealPct: body.dealPct == null ? 20 : num(body.dealPct), verifyWithGoogle: body.verifyWithGoogle !== false, lastNotifiedPrice: null, lastGoogleDay: null };
  }
  if (kind === 'deals') {
    missing(body, ['airports'], 'Deal watch');
    return { ...base(body), kind, title: String(body.title || `Deals from ${body.airports}${body.destination ? ` to ${body.destination}` : ''}`).slice(0, 120),
      query: { airports: body.airports, destination: String(body.destination || '').trim(), maxPrice: num(body.maxPrice), cabin: ['business', 'first'].includes(body.cabin) ? body.cabin : 'economy' }, minDropPct: body.minDropPct == null ? 25 : num(body.minDropPct), notifiedKeys: [] };
  }
  missing(body, ['origins', 'destination', 'departDate'], 'Alert');
  // Optional: watch specific flights ("exact") or those flights and close alternatives ("similar").
  // "product": any flight on the dates that features a seat product, e.g. AF|first|La Première.
  if (body.track?.mode === 'product' && body.track.product) {
    return { ...base(body), kind: 'award', title: String(body.title || `${body.track.productLabel || body.track.product} · ${body.destination}`).slice(0, 120),
      query: { origins: body.origins, destination: body.destination, departDate: body.departDate, returnDate: body.returnDate || null, flexDays: num(body.flexDays), cabin: body.cabin || 'first', travelers: num(body.travelers) || 1, nonstopOnly: Boolean(body.nonstopOnly), product: String(body.track.product) },
      maxPointsPerTraveler: num(body.maxPointsPerTraveler), minCpp: 0, track: { mode: 'product', product: String(body.track.product), productLabel: body.track.productLabel || null, legs: [] } };
  }
  const track = ['exact', 'similar'].includes(body.track?.mode) && Array.isArray(body.track.legs) && body.track.legs.length
    ? { mode: body.track.mode, legs: body.track.legs.slice(0, 2).map(l => ({ leg: l.leg === 'Return' ? 'Return' : 'Outbound', date: String(l.date || '').slice(0, 10), flightNumbers: (l.flightNumbers || []).map(String).slice(0, 6), program: l.program || null, programName: l.programName || null, mileageCost: num(l.mileageCost), seatScore: l.seatScore ?? null, product: l.product || null })) }
    : null;
  return { ...base(body), kind: 'award', title: String(body.title || `${body.destination} ${body.cabin || 'business'}`).slice(0, 120),
    query: { origins: body.origins, destination: body.destination, departDate: body.departDate, returnDate: body.returnDate || null, flexDays: num(body.flexDays), cabin: body.cabin || 'business', travelers: num(body.travelers) || 1, nonstopOnly: Boolean(body.nonstopOnly) },
    maxPointsPerTraveler: num(body.maxPointsPerTraveler), minCpp: num(body.minCpp), track };
}

export async function createAlert(body) {
  const alert = buildAlert(body);
  await updateJson(FILE(), [], alerts => { alerts.unshift(alert); });
  return alert;
}

export function deleteAlert(id) { return updateJson(FILE(), [], alerts => alerts.filter(a => a.id !== id)); }
export function setAlertActive(id, active) {
  return updateJson(FILE(), [], alerts => { const a = alerts.find(x => x.id === id); if (a) a.active = Boolean(active); });
}

const money = n => `$${Math.round(n).toLocaleString('en-US')}`;
const fareText = f => `${money(f.price)} ${f.origin}→${f.destination} ${f.departDate}${f.returnDate ? `–${f.returnDate}` : ' one-way'}`;

// ---------- per-kind evaluation: returns { mode, matches, headline, isNew, update, dataStatus } ----------
/** Does a flight option match a tracked flight? */
export function matchesTracked(o, t, mode) {
  if (!o.flight || dayOf(o) !== t.date) return false;
  const same = t.flightNumbers.length && o.flight.flightNumbers.join('/') === t.flightNumbers.join('/');
  if (mode === 'exact') return same;
  if (same) return true;
  const pointsOk = !t.mileageCost || o.mileageCost <= t.mileageCost * 1.1;
  const seatOk = t.seatScore == null || (o.seatScore ?? -1) >= t.seatScore;
  return pointsOk && seatOk;
}
const dayOf = o => o.flight?.depart?.date || o.date;

async function trackedFlights(alert, r) {
  const results = [];
  for (const t of alert.track.legs) {
    const key = t.leg === 'Return' ? 'return' : 'outbound';
    let options = (r[key] || []).filter(o => dayOf(o) === t.date || o.date === t.date);
    // Load individual flights for awards on the tracked day when the search didn't include them.
    if (options.some(o => !o.flight && o.availabilityId)) options = (await expandAwards({ awards: options, leg: t.leg, travelers: alert.query.travelers })).options;
    const hits = options.filter(o => matchesTracked(o, t, alert.track.mode)).sort((a, b) => a.mileageCost - b.mileageCost);
    results.push({ tracked: t, best: hits[0] || null, count: hits.length });
  }
  return results;
}

const evaluators = {
  async award(alert) {
    const r = await searchTrip(alert.query, { allowApi: true });
    if (alert.track?.mode === 'product') {
      const hits = [...(r.outbound || []), ...(r.return || [])]
        .filter(o => o.productMatch && (!alert.maxPointsPerTraveler || o.mileageCost <= alert.maxPointsPerTraveler))
        .sort((a, b) => a.mileageCost - b.mileageCost);
      const label = alert.track.productLabel || alert.track.product;
      const describe = o => `${o.leg} ${o.flight.flightNumbers.join('/')} ${o.flight.depart?.date || o.date} · ${Math.round(o.mileageCost).toLocaleString()} pts (${o.programName})`;
      const signature = hits.slice(0, 5).map(o => `${o.id}:${o.mileageCost}`).sort().join(',');
      return {
        mode: hits.length ? 'results' : 'not-available', dataStatus: r.dataStatus,
        matches: hits.map(o => ({ ...o, explanation: describe(o) })),
        isNew: hits.length > 0 && signature !== alert.lastSignature,
        headline: hits.length ? `${label} available: ${hits.slice(0, 2).map(describe).join(' · ')}${hits.length > 2 ? ` (+${hits.length - 2} more)` : ''}` : null,
        update: { lastSignature: hits.length ? signature : null },
        notifyTitle: `${label} space`
      };
    }
    if (alert.track) {
      const legs = await trackedFlights(alert, r);
      const allFound = legs.every(l => l.best);
      const perPerson = legs.reduce((s, l) => s + (l.best?.mileageCost || 0), 0);
      const withinMax = !alert.maxPointsPerTraveler || perPerson <= alert.maxPointsPerTraveler;
      const ok = allFound && withinMax;
      const describe = l => `${l.best.flight.flightNumbers.join('/')} ${l.tracked.date} ${Math.round(l.best.mileageCost).toLocaleString()} pts${l.best.flight.flightNumbers.join('/') === l.tracked.flightNumbers.join('/') ? '' : ' (similar)'}`;
      const signature = ok ? legs.map(l => `${l.best.id}:${l.best.mileageCost}`).join(',') : null;
      const matches = ok ? [{ explanation: legs.map(describe).join(' + '), id: signature }] : [];
      return {
        mode: ok ? 'results' : allFound ? 'over-limit' : 'not-available', matches, dataStatus: r.dataStatus,
        isNew: ok && signature !== alert.lastSignature,
        headline: ok ? `Available: ${legs.map(describe).join(' + ')} per person` : null,
        update: { lastSignature: signature, lastTracked: legs.map(l => ({ leg: l.tracked.leg, found: Boolean(l.best), points: l.best?.mileageCost ?? null, flight: l.best?.flight?.flightNumbers?.join('/') || null })) },
        notifyTitle: alert.track.mode === 'exact' ? 'Your flights are available' : 'Flights available'
      };
    }
    const matches = r.trips.filter(t => (!alert.maxPointsPerTraveler || t.totalTargetPoints / t.travelers <= alert.maxPointsPerTraveler) && (!alert.minCpp || t.cpp >= alert.minCpp));
    const signature = matches.slice(0, 5).map(t => t.id).sort().join(',');
    return {
      mode: r.mode, matches, dataStatus: r.dataStatus, isNew: matches.length > 0 && signature !== alert.lastSignature,
      headline: matches[0] && `${matches.length} option(s). Best: ${Math.round(matches[0].totalSourcePoints).toLocaleString()} pts + ${money(matches[0].taxesUsd)}`,
      update: { lastSignature: matches.length ? signature : null }, notifyTitle: 'Award space'
    };
  },

  async hotel(alert) {
    const r = await searchHotels(alert.query, { allowApi: true });
    const matches = r.rows.filter(h => h.affordable && (!alert.minCpp || h.cpp >= alert.minCpp))
      .map(h => ({ ...h, explanation: `${h.name} (${h.programName}) ${h.checkIn}: ${Math.round(h.nightlyPoints).toLocaleString()} pts/night` }));
    const signature = matches.slice(0, 5).map(t => t.id).sort().join(',');
    return {
      mode: r.mode, matches, dataStatus: r.dataStatus, isNew: matches.length > 0 && signature !== alert.lastSignature,
      headline: matches[0] && `${matches.length} hotel(s). Best: ${matches[0].explanation}`,
      update: { lastSignature: matches.length ? signature : null }, notifyTitle: 'Hotel award'
    };
  },

  async cash(alert, settings) {
    const r = await searchCash(alert.query, { allowGoogle: false });
    const matches = r.fares
      .filter(f => (alert.targetPrice && f.price <= alert.targetPrice) || (f.pctBelow != null && alert.dealPct && f.pctBelow >= alert.dealPct))
      .map(f => ({ ...f, explanation: `${fareText(f)} (${f.label})` }));
    const best = matches[0];
    // Notify on the first match and on every further price drop.
    const isNew = Boolean(best) && (alert.lastNotifiedPrice == null || best.price < alert.lastNotifiedPrice - 0.5);
    let headline = best && `${fareText(best)}${alert.targetPrice && best.price <= alert.targetPrice ? ` — under your ${money(alert.targetPrice)} target` : ` — ${best.label}`}`;
    const update = { lastNotifiedPrice: isNew ? best.price : (best ? alert.lastNotifiedPrice : null) };
    // Confirm with a live Google Flights search (at most once per day per alert, to save quota).
    if (isNew && settings.serpApiKey && alert.verifyWithGoogle && alert.lastGoogleDay !== todayISO()) {
      try {
        const g = await googleFlights({ apiKey: settings.serpApiKey, origins: [best.origin], destinations: [best.destination], departDate: best.departDate, returnDate: best.returnDate });
        await recordApiCalls(g.calls, 'serp');
        update.lastGoogleDay = todayISO();
        if (g.fares[0]) headline += `. Google now: ${money(g.fares[0].price)}${g.insights?.level ? ` (${g.insights.level} for this route)` : ''}`;
      } catch (e) { r.dataStatus.warnings.push(e.message); }
    }
    return { mode: matches.length ? 'results' : 'no-match', matches, dataStatus: r.dataStatus, isNew, headline, update, notifyTitle: 'Fare alert' };
  },

  async deals(alert, settings, { force }) {
    const hours = alert.lastCheckedAt ? (Date.now() - Date.parse(alert.lastCheckedAt)) / 3600000 : Infinity;
    if (!force && hours < DEALS_MIN_HOURS) return { skipped: true };
    const r = await dealsFromAirports(alert.query);
    const matches = r.deals.filter(d => d.pctBelow != null && d.pctBelow >= alert.minDropPct)
      .map(d => ({ ...d, key: `${d.cabin}:${d.origin}-${d.destination}:${d.departDate}:${d.price}`, explanation: `${d.destinationLabel || d.destinationName}${d.cabin !== 'economy' ? ` (${d.cabin})` : ''}: ${fareText(d)} (${d.label})` }));
    const seen = new Set(alert.notifiedKeys || []);
    const fresh = matches.filter(m => !seen.has(m.key));
    return {
      mode: matches.length ? 'results' : 'no-match', matches, dataStatus: r.dataStatus, isNew: fresh.length > 0,
      headline: fresh[0] && `${fresh.length} new deal(s). ${fresh.slice(0, 2).map(f => f.explanation).join(' · ')}`,
      update: { notifiedKeys: [...fresh.map(f => f.key), ...(alert.notifiedKeys || [])].slice(0, 300) }, notifyTitle: 'Cheap fares'
    };
  }
};

async function sendWebhook(url, alert, headline, matches) {
  if (!url) return null;
  try {
    const text = `PointPilot — ${alert.title}: ${headline}`;
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ text, content: text, matches: matches.slice(0, 5).map(t => ({ explanation: t.explanation, bookingUrl: t.bookingUrl || t.link || t.googleFlightsUrl || null })) })
    });
    return { sent: r.ok, status: r.status };
  } catch (e) { return { sent: false, error: e.message }; }
}

let running = null;
/** Run all active alerts. `force` re-checks deal watches even if they ran recently. */
export function runMonitor({ force = false } = {}) {
  running ||= (async () => {
    const settings = await getSettings();
    const alerts = (await listAlerts()).filter(a => a.active && a.query);
    const results = [];
    for (const alert of alerts) {
      const kind = alert.kind || 'award';
      let summary;
      try {
        const e = await evaluators[kind](alert, settings, { force });
        if (e.skipped) { results.push({ alertId: alert.id, title: alert.title, kind, skipped: true }); continue; }
        summary = { alertId: alert.id, title: alert.title, kind, mode: e.mode, matches: e.matches.length, isNew: e.isNew, best: e.matches[0]?.explanation || null, dataStatus: e.dataStatus };
        if (e.isNew) {
          summary.webhook = await sendWebhook(settings.webhookUrl, alert, e.headline, e.matches);
          if (settings.desktopNotifications && notifier) notifier({ title: `${e.notifyTitle}: ${alert.title}`, body: e.headline });
        }
        await updateJson(FILE(), [], all => {
          const a = all.find(x => x.id === alert.id);
          if (a) Object.assign(a, e.update, { lastCheckedAt: new Date().toISOString(), lastResult: { mode: e.mode, matches: e.matches.length, best: summary.best } });
        });
      } catch (err) {
        summary = { alertId: alert.id, title: alert.title, kind, error: err.message };
      }
      results.push(summary);
    }
    return { ranAt: new Date().toISOString(), alertsChecked: alerts.length, results };
  })().finally(() => { running = null; });
  return running;
}
