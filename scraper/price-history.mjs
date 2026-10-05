import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(ROOT);
const DATA_DIR = process.env.POINTPILOT_DATA_DIR ? path.resolve(process.env.POINTPILOT_DATA_DIR) : path.join(PROJECT_ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'price-history.json');
const SOURCES_FILE = path.join(PROJECT_ROOT, 'historical', 'sources.json');

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

function clean(v) { return String(v ?? '').trim(); }
function num(v, d = null) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function observationId(o) {
  const stable = {
    sourceType: o.sourceType,
    sourceId: o.sourceId,
    provider: o.provider,
    program: o.program,
    product: o.product,
    origin: o.origin,
    destination: o.destination,
    date: o.date,
    effectiveFrom: o.effectiveFrom,
    effectiveTo: o.effectiveTo,
    cabin: o.cabin,
    roomType: o.roomType,
    market: o.market,
    category: o.category,
    distanceMin: o.distanceMin,
    distanceMax: o.distanceMax,
    pointsMin: o.pointsMin,
    pointsMax: o.pointsMax,
    pointsCommon: o.pointsCommon,
    pricingModel: o.pricingModel,
    observationKey: o.observationKey || null
  };
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

export async function loadHistory() {
  return readJson(HISTORY_FILE, []);
}

export async function saveHistory(rows) {
  const dedup = new Map();
  for (const row of rows) dedup.set(row.id || observationId(row), { ...row, id: row.id || observationId(row) });
  const out = [...dedup.values()].sort((a, b) => String(b.observedAt || b.effectiveFrom || '').localeCompare(String(a.observedAt || a.effectiveFrom || '')));
  await saveJson(HISTORY_FILE, out);
  return out;
}

export async function recordPriceObservation(raw) {
  const o = {
    id: raw.id || observationId(raw),
    observedAt: raw.observedAt || raw.sourcePublishedAt || raw.effectiveFrom || new Date().toISOString(),
    effectiveFrom: clean(raw.effectiveFrom) || null,
    effectiveTo: clean(raw.effectiveTo) || null,
    sourceType: clean(raw.sourceType) || 'manual_observation',
    sourceId: clean(raw.sourceId) || null,
    provider: clean(raw.provider) || null,
    program: clean(raw.program) || null,
    product: clean(raw.product) || 'flight',
    origin: clean(raw.origin).toUpperCase() || null,
    destination: clean(raw.destination).toUpperCase() || null,
    date: clean(raw.date) || null,
    cabin: clean(raw.cabin).toLowerCase() || null,
    roomType: clean(raw.roomType).toLowerCase() || null,
    market: clean(raw.market) || null,
    category: clean(raw.category) || null,
    distanceMin: num(raw.distanceMin),
    distanceMax: num(raw.distanceMax),
    pointsMin: num(raw.pointsMin),
    pointsMax: num(raw.pointsMax),
    pointsCommon: num(raw.pointsCommon),
    taxes: num(raw.taxes),
    cashValue: num(raw.cashValue),
    seats: num(raw.seats),
    pricingModel: clean(raw.pricingModel) || null,
    confidence: clean(raw.confidence) || 'medium',
    sourceUrl: clean(raw.sourceUrl) || null,
    sourceTitle: clean(raw.sourceTitle) || null,
    sourcePublishedAt: clean(raw.sourcePublishedAt) || null,
    notes: clean(raw.notes) || null
  };
  const history = await loadHistory();
  const filtered = history.filter(x => x.id !== o.id);
  filtered.push(o);
  await saveHistory(filtered);
  return o;
}

export async function recordAwards(rows, defaults = {}) {
  const history = await loadHistory();
  const existing = new Map(history.map(x => [x.id, x]));
  for (const r of rows) {
    const observation = {
      observedAt: r.capturedAt || new Date().toISOString(),
      sourceType: defaults.sourceType || 'manual_observation',
      sourceId: defaults.sourceId || r.provider || r.dataSource || null,
      provider: r.provider || defaults.provider,
      program: r.program || defaults.program,
      product: r.product || 'flight',
      origin: r.origin,
      destination: r.destination,
      date: r.date,
      cabin: r.cabin,
      roomType: r.roomType,
      pointsMin: r.mileageCost ?? r.nightlyPoints,
      pointsMax: r.mileageCost ?? r.nightlyPoints,
      pointsCommon: r.mileageCost ?? r.nightlyPoints,
      taxes: r.totalTaxes,
      cashValue: r.cashValue,
      seats: r.remainingSeats,
      confidence: 'high',
      sourceUrl: r.sourceUrl || defaults.sourceUrl,
      sourceTitle: defaults.sourceTitle,
      notes: defaults.notes || `Observed via ${r.dataSource || 'PointPilot'}`,
      observationKey: defaults.observationKey ? `${defaults.observationKey}:${r.id || ''}` : (r.observationKey || null)
    };
    observation.id = observationId(observation);
    existing.set(observation.id, observation);
  }
  await saveHistory([...existing.values()]);
  return [...existing.values()];
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function routeHistoryStats(history, { provider, program, origin, destination, cabin }) {
  const p = clean(program).toLowerCase();
  const o = clean(origin).toUpperCase();
  const d = clean(destination).toUpperCase();
  const c = clean(cabin).toLowerCase();
  const rows = history.filter(x =>
    (!provider || String(x.provider).toLowerCase() === String(provider).toLowerCase()) &&
    (!p || String(x.program).toLowerCase() === p) &&
    String(x.origin || '').toUpperCase() === o &&
    String(x.destination || '').toUpperCase() === d &&
    (!c || String(x.cabin || '').toLowerCase() === c) &&
    Number.isFinite(Number(x.pointsCommon ?? x.pointsMin))
  );
  const pts = rows.map(x => Number(x.pointsCommon ?? x.pointsMin));
  return {
    count: rows.length,
    min: pts.length ? Math.min(...pts) : null,
    median: median(pts),
    max: pts.length ? Math.max(...pts) : null,
    latest: rows.length ? rows.slice().sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)))[0] : null
  };
}

export async function getSources() { return readJson(SOURCES_FILE, []); }
export { HISTORY_FILE, SOURCES_FILE, observationId };
