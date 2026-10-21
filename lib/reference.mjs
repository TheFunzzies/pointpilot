// Reference data (transfer partners) ships inside the app AND can be refreshed from the
// GitHub repo without a new installer. The newer of {bundled, cached remote} wins.
import { readFileSync } from 'node:fs';
import { referenceFile, dataFile } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { transferContentHash } from './transfer-sources.mjs';

export const REMOTE_TRANSFER_URL = process.env.POINTPILOT_REFERENCE_URL ||
  'https://raw.githubusercontent.com/TheFunzzies/pointpilot/main/reference/transfer-partners.json';

const BUNDLED = JSON.parse(readFileSync(referenceFile('transfer-partners.json'), 'utf8'));
let current = { ...BUNDLED, origin: 'bundled' };
let lastRefresh = null;

export function validateTransferData(d) {
  if (!d || typeof d !== 'object') return 'not an object';
  if (d.schemaVersion !== 2) return `unsupported schemaVersion ${d.schemaVersion}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.lastUpdated || ''))) return 'missing lastUpdated';
  if (d.updatedAt != null && (typeof d.updatedAt !== 'string' || !Number.isFinite(Date.parse(d.updatedAt)))) return 'bad updatedAt';
  if (d.revision != null && (!Number.isSafeInteger(d.revision) || d.revision < 0)) return 'bad revision';
  if (!d.programs || !d.banks) return 'missing programs/banks';
  for (const [pid, p] of Object.entries(d.programs)) {
    if (!p || typeof p !== 'object') return `bad program ${pid}`;
    for (const [bank, e] of Object.entries(p.transfers || {})) {
      if (!e || !Array.isArray(e.ratio) || e.ratio.length !== 2 || !e.ratio.every(n => Number.isFinite(n) && n > 0)) return `bad ratio ${bank}->${pid}`;
      if (e.bonusPct != null && !(Number.isFinite(e.bonusPct) && e.bonusPct >= 0 && e.bonusPct <= 5)) return `bad bonus ${bank}->${pid}`;
      if (e.bonusLastConfirmedAt != null && (typeof e.bonusLastConfirmedAt !== 'string' || !Number.isFinite(Date.parse(e.bonusLastConfirmedAt)))) return `bad bonus confirmation ${bank}->${pid}`;
      if (e.chunkBonus != null && e.chunkBonus !== false &&
          !(Number.isSafeInteger(e.chunkBonus.every) && e.chunkBonus.every > 0 && Number.isSafeInteger(e.chunkBonus.bonus) && e.chunkBonus.bonus >= 0)) return `bad chunk bonus ${bank}->${pid}`;
      for (const key of ['minTransfer', 'increment']) if (e[key] != null && !(Number.isSafeInteger(e[key]) && e[key] > 0)) return `bad ${key} ${bank}->${pid}`;
    }
  }
  return null;
}

// Date-only schema-2 data remains supported. New files carry a monotone timestamp
// and revision so corrections and reconfirmations made on the same day are visible.
export function newerTransferData(a, b) {
  const aTime = Date.parse(a?.updatedAt || `${a?.lastUpdated}T00:00:00.000Z`);
  const bTime = Date.parse(b?.updatedAt || `${b?.lastUpdated}T00:00:00.000Z`);
  if (aTime !== bTime) return aTime > bTime;
  if ((a?.revision || 0) !== (b?.revision || 0)) return (a?.revision || 0) > (b?.revision || 0);
  return !a.updatedAt && !b.updatedAt && transferContentHash(a) !== transferContentHash(b);
}

export async function loadCachedReference() {
  const cached = await readJson(dataFile('transfer-partners.remote.json'), null);
  if (cached && !validateTransferData(cached) && newerTransferData(cached, current)) current = { ...cached, origin: 'remote-cache' };
  return current;
}

export function transferData() { return current; }

/** Fetch the latest partner data from the repo. Never throws; returns a status object. */
export async function refreshReference({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  lastRefresh = { at: new Date().toISOString() };
  try {
    const r = await fetchImpl(REMOTE_TRANSFER_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const problem = validateTransferData(data);
    if (problem) throw new Error(`rejected remote data: ${problem}`);
    if (newerTransferData(data, current)) {
      await writeJson(dataFile('transfer-partners.remote.json'), data);
      current = { ...data, origin: 'remote' };
      Object.assign(lastRefresh, { ok: true, updated: true, lastUpdated: data.lastUpdated, updatedAt: data.updatedAt, revision: data.revision });
    } else {
      Object.assign(lastRefresh, { ok: true, updated: false, lastUpdated: current.lastUpdated, updatedAt: current.updatedAt, revision: current.revision });
    }
  } catch (e) {
    Object.assign(lastRefresh, { ok: false, error: e.message });
  }
  return lastRefresh;
}

export function referenceStatus() {
  return { origin: current.origin, lastUpdated: current.lastUpdated, updatedAt: current.updatedAt, revision: current.revision, contentHash: current.contentHash, source: current.source, lastRefresh };
}

/** Test helper. */
export function _setTransferData(d) { current = { ...d, origin: 'test' }; }
