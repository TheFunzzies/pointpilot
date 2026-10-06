// Builds reference/hotel-awards.json: MICHELIN Key hotels (One / Two / Three Keys).
// Source: the full list compiled at https://www.awardtravel.co/blog/michelin-key-list from the
// MICHELIN Guide's announcements (the Guide's own site blocks automated access).
// Run weekly by .github/workflows/hotel-awards.yml, or locally: `npm run build:hotel-awards`
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://www.awardtravel.co/blog/michelin-key-list';
const FILE = new URL('../reference/hotel-awards.json', import.meta.url);
const decode = s => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
const LEVEL = { one: 1, two: 2, three: 3 };

export function parseMichelinKeys(html) {
  const hotels = [];
  // <h4>Country (N Three-Key Hotels)</h4><ul><li>Name - City</li>…</ul>
  const re = /<h4[^>]*>([\s\S]*?)<\/h4>\s*<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  for (const m of html.matchAll(re)) {
    const head = decode(m[1]).match(/^(.*?)\s*\(\s*\d+\s+(One|Two|Three)-Key Hotels?\s*\)/i);
    if (!head) continue;
    const country = head[1].trim(), keys = LEVEL[head[2].toLowerCase()];
    for (const li of m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      const t = decode(li[1]);
      const i = t.lastIndexOf(' - ');
      const name = i > 0 ? t.slice(0, i).trim() : t, city = i > 0 ? t.slice(i + 3).trim() : null;
      if (name) hotels.push({ name, city, country, award: 'michelin-keys', keys });
    }
  }
  // The page renders its list twice (mobile + desktop); keep one entry per hotel.
  const seen = new Map();
  for (const h of hotels) { const k = `${h.name}|${h.city}`; if (!seen.has(k) || seen.get(k).keys < h.keys) seen.set(k, h); }
  return [...seen.values()];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const r = await fetch(SOURCE, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PointPilot; +https://github.com/TheFunzzies/pointpilot)' }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const hotels = parseMichelinKeys(await r.text());
  if (hotels.length < 800) { console.error(`Only ${hotels.length} hotels parsed; page layout may have changed. Keeping the existing file.`); process.exit(0); }
  let prev = null;
  try { prev = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
  const out = { schemaVersion: 1, lastUpdated: new Date().toISOString().slice(0, 10), source: SOURCE, note: 'MICHELIN Keys (1–3) from the MICHELIN Guide, via AwardTravel\'s compiled list (covers about half of all Key hotels, weighted to the top tiers). A hotel without a badge may still hold a Key. Matched to hotels by name and city.', hotels };
  if (prev && JSON.stringify(prev.hotels) === JSON.stringify(hotels)) { console.log(`No change (${hotels.length} hotels).`); process.exit(0); }
  writeFileSync(FILE, `${JSON.stringify(out)}\n`);
  const by = [1, 2, 3].map(k => `${hotels.filter(h => h.keys === k).length} × ${k} Key${k > 1 ? 's' : ''}`).join(', ');
  console.log(`hotel-awards.json: ${hotels.length} hotels (${by})`);
}
