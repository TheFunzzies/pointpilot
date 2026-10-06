// Premium cabin products (Qsuite, Delta One Suite, THE Room...) by airline + aircraft.
// Bundled in reference/cabin-products.json and refreshed from the repo like transfer partners.
import { readFileSync } from 'node:fs';
import { referenceFile, dataFile } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { normalizeCabin } from './programs.mjs';

export const REMOTE_CABINS_URL = process.env.POINTPILOT_CABINS_URL ||
  'https://raw.githubusercontent.com/TheFunzzies/pointpilot/main/reference/cabin-products.json';

let data = JSON.parse(readFileSync(referenceFile('cabin-products.json'), 'utf8'));
const valid = d => d && d.schemaVersion === 1 && d.airlines && /^\d{4}-\d{2}-\d{2}$/.test(String(d.lastUpdated || ''));

export async function loadCachedCabins() {
  const cached = await readJson(dataFile('cabin-products.remote.json'), null);
  if (valid(cached) && cached.lastUpdated > data.lastUpdated) data = cached;
}
export async function refreshCabins({ fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(REMOTE_CABINS_URL, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const d = await r.json();
    if (!valid(d)) return { ok: false, error: 'invalid data' };
    if (d.lastUpdated > data.lastUpdated) { data = d; await writeJson(dataFile('cabin-products.remote.json'), d); return { ok: true, updated: true }; }
    return { ok: true, updated: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

const norm = s => String(s || '').toLowerCase().replace(/boeing|airbus|dreamliner|neo|\s|-/g, '');

// ---------- generic fallback (no curated entry) ----------
const WIDEBODY = /(\b7[4678]7\b|a3[3-8]0|dreamliner|\b(77W|77L|773|772|788|789|78X|781|744|748|764|763|332|333|338|339|342|343|346|351|359|35K|388)\b)/i;
const LONG_NARROW = /(\b757\b|a321|\b(75[0-9]|32Q|21N)\b)/i;

export function genericProduct(aircraft, cabin) {
  const a = String(aircraft || '');
  const wide = WIDEBODY.test(a), longNarrow = LONG_NARROW.test(a);
  const c = normalizeCabin(cabin) || 'economy';
  if (c === 'first') return wide
    ? { product: 'Lie-flat first class', detail: 'Typically a fully flat bed, often enclosed.', score: 4, certainty: 'generic' }
    : { product: 'Domestic first (recliner)', detail: 'On narrow-body jets "first" is usually a wide recliner, not a bed.', score: 1, certainty: 'generic' };
  if (c === 'business') {
    if (wide) return { product: 'Lie-flat business (typical)', detail: 'Most long-haul business is fully flat; layout and aisle access vary.', score: 3, certainty: 'generic' };
    if (longNarrow) return { product: 'Lie-flat or recliner', detail: 'Transcon / long-range A321 and 757 business is often lie-flat, sometimes a recliner.', score: 2, certainty: 'generic' };
    return { product: 'Recliner (regional business)', detail: 'Short-haul business is usually a recliner or a blocked middle seat.', score: 1, certainty: 'generic' };
  }
  if (c === 'premium') return { product: 'Premium economy recliner', detail: 'Wider seat with more legroom and recline.', score: 1, certainty: 'generic' };
  return { product: 'Economy seat', detail: wide ? 'Long-haul economy usually has seatback screens and power.' : 'Screens and power vary by airline.', score: 0, certainty: 'generic' };
}

/**
 * Best-known product for a carrier/aircraft/cabin:
 * { product, detail, score (0-5), certainty: all|typical|varies|generic, airline }
 */
export function cabinProduct({ carrier, aircraftCode, aircraftName, cabin }) {
  const c = normalizeCabin(cabin) || 'economy';
  const generic = genericProduct(aircraftName || aircraftCode, c);
  if (c !== 'business' && c !== 'first') return generic;
  const al = data.airlines[String(carrier || '').toUpperCase()];
  if (!al) return generic;
  const code = String(aircraftCode || '').toUpperCase();
  const name = norm(aircraftName);
  const match = e => e.aircraft.some(k => k.toUpperCase() === code || (name && norm(k).length >= 3 && name.includes(norm(k))));
  const hit = (al[c] || []).find(match);
  if (hit) return { product: hit.product, detail: hit.detail, score: hit.score, certainty: hit.certainty || 'typical', airline: al.name };
  const def = al.default?.[c];
  // Don't let an airline default (e.g. "lie-flat") override a clearly narrow-body regional flight.
  if (def && generic.score >= 2) return { ...def, certainty: 'varies', airline: al.name };
  return generic;
}

export const cabinDataStatus = () => ({ lastUpdated: data.lastUpdated });

// ---------- product catalog (for "find flights with this seat") ----------
export const productKey = (carrier, cabin, product) => `${carrier}|${cabin}|${product}`;

/** Every curated business/first product: [{ key, carrier, airline, cabin, product, score, certainty, aircraft }] */
export function productCatalog() {
  const out = new Map();
  for (const [carrier, al] of Object.entries(data.airlines)) {
    for (const cabin of ['first', 'business']) {
      for (const e of al[cabin] || []) {
        const key = productKey(carrier, cabin, e.product);
        const prev = out.get(key);
        out.set(key, { key, carrier, airline: al.name, cabin, product: e.product, score: Math.max(e.score, prev?.score ?? 0), certainty: e.certainty || 'typical', aircraft: [...new Set([...(prev?.aircraft || []), ...e.aircraft.filter(a => /[a-z-]/i.test(a) && a.length > 3)])] });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.cabin === b.cabin ? 0 : a.cabin === 'first' ? -1 : 1) || b.score - a.score || a.airline.localeCompare(b.airline));
}

export function findProduct(key) {
  return productCatalog().find(p => p.key === key) || null;
}

/** Does a flight option include a segment with this product (on its carrier, in its cabin)? */
export function hasProduct(option, prod) {
  if (!prod || !option?.flight || (option.cabin && option.cabin !== prod.cabin)) return false;
  return (option.flight.segments || []).some(s => s.carrier === prod.carrier && s.seat?.type === prod.product);
}
