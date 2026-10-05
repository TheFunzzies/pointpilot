// Small JSON document store.
// - Reads are cached in memory (files are only written through this module).
// - Writes are serialized per file, so concurrent requests can't lose updates.
// - Writes are atomic (temp file + rename), so a crash can't leave half a file.
// - A corrupt file is moved aside instead of being silently overwritten.
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const cache = new Map();
const queues = new Map();

const clone = v => (v === undefined ? undefined : structuredClone(v));

export async function readJson(file, fallback) {
  if (cache.has(file)) return clone(cache.get(file));
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return clone(fallback);
  }
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    cache.set(file, value);
    return clone(value);
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    console.warn(`[store] ${file} is not valid JSON (${e.message}); moved to ${aside}`);
    await rename(file, aside).catch(() => {});
    return clone(fallback);
  }
}

async function renameWithRetry(from, to) {
  // Windows can briefly lock files (antivirus, indexer). Retry a few times.
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try { await renameWithRetry(tmp, file); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  cache.set(file, clone(value));
}

/** Serialized read-modify-write. `mutate` may change the value in place or return a new one. */
export function updateJson(file, fallback, mutate) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const current = await readJson(file, fallback);
    const result = await mutate(current);
    const value = result === undefined ? current : result;
    await writeAtomic(file, value);
    return clone(value);
  });
  queues.set(file, next);
  return next;
}

export const writeJson = (file, value) => updateJson(file, null, () => value);

/** Test helper. */
export function clearStoreCache() { cache.clear(); queues.clear(); }
