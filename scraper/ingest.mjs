import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAwards } from './price-history.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(ROOT);
const DATA_DIR = process.env.POINTPILOT_DATA_DIR ? path.resolve(process.env.POINTPILOT_DATA_DIR) : path.join(PROJECT_ROOT, 'data');
const OUT = path.join(DATA_DIR, 'award-cache.json');

export async function saveAwards(rows, historyDefaults = {}) {
  await mkdir(path.dirname(OUT), { recursive: true });
  let existing = [];
  try { existing = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const map = new Map(existing.map(r => [r.id, r]));
  for (const row of rows) {
    const normalized = row.id ? row : { ...row, id: `${row.provider || row.source || 'unknown'}-${row.product || 'flight'}-${row.date || row.checkIn || 'na'}-${Date.now()}-${Math.random().toString(36).slice(2,8)}` };
    map.set(normalized.id, normalized);
  }
  const merged = [...map.values()].sort((a,b) => String(a.date||a.checkIn).localeCompare(String(b.date||b.checkIn)));
  await writeFile(OUT, JSON.stringify(merged, null, 2));
  await recordAwards(rows, {sourceType: historyDefaults.sourceType || 'capture', sourceId: historyDefaults.sourceId || 'pointpilot-capture', provider: historyDefaults.provider, sourceUrl: historyDefaults.sourceUrl, notes: historyDefaults.notes});
  return merged;
}
