// Historical award-price observations.
// One observation = one distinct price seen for one award on one day. Re-running the same
// search doesn't add rows, so frequently searched routes don't skew the statistics.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dataFile, referenceFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { programId, normalizeCabin } from './programs.mjs';

const FILE = () => dataFile('price-history.json');
const MAX_ROWS = 50000;
const SEED = JSON.parse(readFileSync(referenceFile('price-history-seed.json'), 'utf8'));
const SOURCES = JSON.parse(readFileSync(referenceFile('history-sources.json'), 'utf8'));

const clean = v => String(v ?? '').trim();
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function observationId(o) {
  const stable = [o.sourceType, o.program, o.product, o.origin, o.destination, o.date, o.cabin, o.roomType,
    o.category, o.effectiveFrom, o.pointsMin, o.pointsMax, o.pointsCommon, clean(o.observedAt).slice(0, 10)];
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

function normalizeObservation(raw) {
  const o = {
    observedAt: raw.observedAt || raw.sourcePublishedAt || raw.effectiveFrom || new Date().toISOString(),
    effectiveFrom: clean(raw.effectiveFrom) || null,
    effectiveTo: clean(raw.effectiveTo) || null,
    sourceType: clean(raw.sourceType) || 'observation',
    sourceId: clean(raw.sourceId) || null,
    program: programId(raw.program) || clean(raw.program).toLowerCase() || null,
    product: clean(raw.product) || 'flight',
    origin: clean(raw.origin).toUpperCase() || null,
    destination: clean(raw.destination).toUpperCase() || null,
    date: clean(raw.date) || null,
    cabin: normalizeCabin(raw.cabin) || null,
    roomType: clean(raw.roomType).toLowerCase() || null,
    market: clean(raw.market) || null,
    category: clean(raw.category) || null,
    pointsMin: num(raw.pointsMin),
    pointsMax: num(raw.pointsMax),
    pointsCommon: num(raw.pointsCommon),
    taxes: num(raw.taxes),
    cashValue: num(raw.cashValue),
    seats: num(raw.seats),
    confidence: clean(raw.confidence) || 'medium',
    sourceUrl: clean(raw.sourceUrl) || null,
    sourceTitle: clean(raw.sourceTitle) || null,
    notes: clean(raw.notes) || null
  };
  o.id = raw.id || observationId(o);
  return o;
}

export async function loadHistory() {
  const rows = await readJson(FILE(), null);
  if (rows) return rows;
  // First run: start from the published benchmark seed.
  return updateJson(FILE(), [], () => SEED.map(normalizeObservation));
}

async function addObservations(observations) {
  if (!observations.length) return 0;
  await loadHistory();
  let added = 0;
  await updateJson(FILE(), [], rows => {
    const ids = new Set(rows.map(r => r.id));
    for (const o of observations) if (!ids.has(o.id)) { rows.push(o); ids.add(o.id); added++; }
    rows.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
    return rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  });
  return added;
}

/** Record award rows (flights or hotels) as price observations. */
export function recordAwards(rows, { sourceType = 'observation', sourceId = null } = {}) {
  return addObservations(rows.map(r => {
    const pts = r.product === 'hotel' ? r.nightlyPoints : r.mileageCost;
    return normalizeObservation({
      observedAt: r.capturedAt || new Date().toISOString(),
      sourceType, sourceId: sourceId || r.dataSource,
      program: r.program, product: r.product || 'flight',
      origin: r.origin, destination: r.destination, date: r.date || r.checkIn,
      cabin: r.cabin, roomType: r.roomType,
      pointsMin: pts, pointsMax: pts, pointsCommon: pts,
      taxes: r.totalTaxes, cashValue: r.cashValue, seats: r.remainingSeats,
      confidence: 'high', sourceUrl: r.sourceUrl,
      notes: r.product === 'hotel' && r.name ? `${r.name}, ${r.location || ''}` : null
    });
  }));
}

export function recordPriceObservation(raw) { return addObservations([normalizeObservation(raw)]); }

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function routeHistoryStats(history, { program, origin, destination, cabin }) {
  const p = programId(program) || clean(program).toLowerCase();
  const o = clean(origin).toUpperCase();
  const d = clean(destination).toUpperCase();
  const c = normalizeCabin(cabin);
  const rows = history.filter(x =>
    (!p || x.program === p) && x.origin === o && x.destination === d && (!c || x.cabin === c) &&
    Number.isFinite(Number(x.pointsCommon ?? x.pointsMin)));
  const pts = rows.map(x => Number(x.pointsCommon ?? x.pointsMin));
  return {
    count: rows.length,
    min: pts.length ? Math.min(...pts) : null,
    median: median(pts),
    max: pts.length ? Math.max(...pts) : null,
    latest: rows[0] || null
  };
}

/** Label like "12% below historical median" for a leg, or null without enough data. */
export function historicalContext(leg, history) {
  const stats = routeHistoryStats(history, leg);
  if (stats.count < 3 || stats.median == null) return null;
  const current = Number(leg.mileageCost);
  const pct = ((stats.median - current) / stats.median) * 100;
  let label = 'Near historical median';
  if (current <= stats.min) label = 'At historical low';
  else if (pct >= 10) label = `${Math.round(pct)}% below historical median`;
  else if (pct <= -10) label = `${Math.round(-pct)}% above historical median`;
  return { count: stats.count, min: stats.min, median: stats.median, max: stats.max, current, percentVsMedian: pct, label };
}

export function getSources() { return SOURCES; }
