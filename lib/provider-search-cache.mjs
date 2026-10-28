// Bounded, short-lived cache for provider search responses. Flight search results can be reused
// across app restarts without keeping provider credentials in the cache file.
import crypto from 'node:crypto';
import { dataFile } from './paths.mjs';
import { readJsonShared, updateJson } from './store.mjs';

const FILE = () => dataFile('provider-search-cache.json');
const MAX_ENTRIES = 500;

export function providerCacheKey(provider, credential, query) {
  const credentialHash = crypto.createHash('sha256').update(String(credential || '')).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify([provider, credentialHash, query])).digest('hex');
}

export async function getProviderSearch(key, maxAgeMs, now = Date.now()) {
  const rows = await readJsonShared(FILE(), []);
  const entry = rows.find(row => row.key === key);
  if (!entry || !Number.isFinite(Date.parse(entry.cachedAt)) || now - Date.parse(entry.cachedAt) > maxAgeMs) return null;
  return { result: structuredClone(entry.result), cachedAt: entry.cachedAt };
}

export async function saveProviderSearch(key, result, now = Date.now()) {
  const cachedAt = new Date(now).toISOString();
  await updateJson(FILE(), [], rows => {
    const keep = rows.filter(row => row.key !== key && Number.isFinite(Date.parse(row.cachedAt)) && now - Date.parse(row.cachedAt) <= 24 * 60 * 60 * 1000);
    keep.push({ key, cachedAt, result });
    return keep.slice(-MAX_ENTRIES);
  });
  return cachedAt;
}
