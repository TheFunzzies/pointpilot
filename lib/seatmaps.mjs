// Resolve the exact AeroLOPA / SeatMaps page for an airline + aircraft.
// Neither site accepts a flight number or date in its URL, so the most precise link possible is
// the airline's aircraft page. Each site's airline index is fetched at most once a month and
// cached; if no aircraft page matches, the airline page is returned instead.
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';

const FILE = () => dataFile('seatmap-cache.json');
const MONTH = 30 * 86400000;
const UA = { 'user-agent': 'PointPilot/1.0 (+https://github.com/TheFunzzies/pointpilot)' };

const norm = s => String(s || '').toLowerCase().replace(/boeing|airbus|embraer|dreamliner|neo|\(.*?\)|\s|-/g, '');

async function cached(key, loader) {
  const store = await readJson(FILE(), {});
  const hit = store[key];
  if (hit && Date.now() - hit.at < MONTH) return hit.value;
  const value = await loader();
  await updateJson(FILE(), {}, s => { s[key] = { at: Date.now(), value }; });
  return value;
}

async function getText(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** AeroLOPA airline page lists aircraft as /{al}-{code} links with an <img alt="Boeing 777-300ER">. */
export function parseAerolopa(html, al) {
  const out = [];
  const re = new RegExp(`href="/(${al}-[a-z0-9]+)"`, 'g');
  for (const m of html.matchAll(re)) {
    const alt = html.slice(m.index, m.index + 1200).match(/alt="([^"]+)"/);
    if (!out.some(x => x.slug === m[1])) out.push({ slug: m[1], code: m[1].slice(al.length + 1), name: alt ? alt[1] : null });
  }
  return out;
}

/** SeatMaps airline page lists aircraft as /airlines/{al}-{airline}/{aircraft}/ links with the name as text. */
export function parseSeatmaps(html, airlinePath) {
  const out = [];
  const esc = airlinePath.replace(/[/-]/g, m => `\\${m}`);
  const re = new RegExp(`href="(${esc}[a-z0-9-]+/)"[^>]*>([^<]{2,80})<`, 'g');
  for (const m of html.matchAll(re)) if (!out.some(x => x.path === m[1])) out.push({ path: m[1], name: m[2].trim() });
  return out;
}

function pick(list, aircraftName, aircraftCode) {
  const n = norm(aircraftName), code = String(aircraftCode || '').toLowerCase();
  const exact = list.filter(x => (x.code && x.code === code) || (n && norm(x.name) === n));
  if (exact.length) return exact;
  // Loose match ("A350-900" vs "A350-900XWB"), but never treat 777-300 and 777-300ER as the same plane.
  const loose = (a, b) => a.startsWith(b) && !/^(er|lr|f)$/.test(a.slice(b.length));
  return n ? list.filter(x => x.name && (loose(norm(x.name), n) || loose(n, norm(x.name)))) : [];
}

export async function resolveSeatMaps({ carrier, aircraftName, aircraftCode }) {
  const al = String(carrier || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z0-9]{2}$/.test(al)) throw Object.assign(new Error('carrier must be a 2-character airline code'), { status: 400 });
  const result = { aerolopa: { url: `https://www.aerolopa.com/${al}`, exact: false, variants: [] }, seatmaps: { url: 'https://seatmaps.com/airlines/', exact: false } };

  try {
    const list = await cached(`aerolopa:${al}`, async () => parseAerolopa(await getText(`https://www.aerolopa.com/${al}`), al));
    const hits = pick(list, aircraftName, aircraftCode);
    if (hits.length) {
      result.aerolopa = { url: `https://www.aerolopa.com/${hits[0].slug}`, exact: true, variants: hits.map(h => ({ url: `https://www.aerolopa.com/${h.slug}`, label: `${h.name || h.code} (${h.code.toUpperCase()})` })) };
    }
  } catch { /* keep the airline page */ }

  try {
    const airlines = await cached('seatmaps:airlines', async () => {
      const html = await getText('https://seatmaps.com/airlines/');
      return Object.fromEntries([...html.matchAll(/href="(\/airlines\/([a-z0-9]{2})-[a-z0-9-]+\/)"/g)].map(m => [m[2], m[1]]));
    });
    const path = airlines[al];
    if (path) {
      result.seatmaps = { url: `https://seatmaps.com${path}`, exact: false };
      const list = await cached(`seatmaps:${al}`, async () => parseSeatmaps(await getText(`https://seatmaps.com${path}`), path));
      const hits = pick(list, aircraftName, null);
      if (hits.length) result.seatmaps = { url: `https://seatmaps.com${hits[0].path}`, exact: true };
    }
  } catch { /* keep the generic page */ }

  return result;
}
