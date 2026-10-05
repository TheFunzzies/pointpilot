// Reference data (transfer partners) ships inside the app AND can be refreshed from the
// GitHub repo without a new installer. The newer of {bundled, cached remote} wins.
import { readFileSync } from 'node:fs';
import { referenceFile, dataFile } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';

export const REMOTE_TRANSFER_URL = process.env.POINTPILOT_REFERENCE_URL ||
  'https://raw.githubusercontent.com/TheFunzzies/pointpilot/main/reference/transfer-partners.json';

const BUNDLED = JSON.parse(readFileSync(referenceFile('transfer-partners.json'), 'utf8'));
let current = { ...BUNDLED, origin: 'bundled' };
let lastRefresh = null;

export function validateTransferData(d) {
  if (!d || typeof d !== 'object') return 'not an object';
  if (d.schemaVersion !== 2) return `unsupported schemaVersion ${d.schemaVersion}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.lastUpdated || ''))) return 'missing lastUpdated';
  if (!d.programs || !d.banks) return 'missing programs/banks';
  for (const [pid, p] of Object.entries(d.programs)) {
    for (const [bank, e] of Object.entries(p.transfers || {})) {
      const [from, to] = e.ratio || [];
      if (!(from > 0 && to > 0)) return `bad ratio ${bank}->${pid}`;
      if (e.bonusPct != null && !(e.bonusPct >= 0 && e.bonusPct <= 5)) return `bad bonus ${bank}->${pid}`;
    }
  }
  return null;
}

const newer = (a, b) => String(a?.lastUpdated || '') > String(b?.lastUpdated || '');

export async function loadCachedReference() {
  const cached = await readJson(dataFile('transfer-partners.remote.json'), null);
  if (cached && !validateTransferData(cached) && newer(cached, current)) current = { ...cached, origin: 'remote-cache' };
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
    if (newer(data, current)) {
      await writeJson(dataFile('transfer-partners.remote.json'), data);
      current = { ...data, origin: 'remote' };
      Object.assign(lastRefresh, { ok: true, updated: true, lastUpdated: data.lastUpdated });
    } else {
      Object.assign(lastRefresh, { ok: true, updated: false, lastUpdated: current.lastUpdated });
    }
  } catch (e) {
    Object.assign(lastRefresh, { ok: false, error: e.message });
  }
  return lastRefresh;
}

export function referenceStatus() {
  return { origin: current.origin, lastUpdated: current.lastUpdated, source: current.source, lastRefresh };
}

/** Test helper. */
export function _setTransferData(d) { current = { ...d, origin: 'test' }; }
