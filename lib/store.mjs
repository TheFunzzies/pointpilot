// Small JSON document store.
// - Reads are cached in memory (files are only written through this module).
// - Writes are serialized per file, so concurrent requests can't lose updates.
// - Writes are atomic (temp file + rename), so a crash can't leave half a file.
// - A corrupt file is moved aside instead of being silently overwritten.
// - The five backup documents share a global gate so a multi-file restore is never half-visible
//   (see store-transaction.mjs). Ordinary calls only wait while a restore commit holds the gate.
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { dataDir } from './paths.mjs';

const cache = new Map();
const queues = new Map();

const clone = v => (v === undefined ? undefined : structuredClone(v));

/** Fixed, app-owned filenames covered by backup/restore. No caller supplies a path. */
export const DOCUMENT_FILES = Object.freeze({
  user: 'user.json',
  settings: 'settings.json',
  tripPlan: 'trip-plan.json',
  stayPlan: 'stay-plan.json',
  alerts: 'alerts.json'
});
const DOCUMENT_NAMES = new Set(Object.values(DOCUMENT_FILES));
export const documentPath = name => {
  if (!Object.hasOwn(DOCUMENT_FILES, name)) throw new Error(`Unknown document: ${name}`);
  return path.join(dataDir(), DOCUMENT_FILES[name]);
};
const gated = file => DOCUMENT_NAMES.has(path.basename(file)) && path.dirname(path.resolve(file)) === dataDir();

// ---------- document gate ----------
// Shared holders are ordinary reads/updates of a gated file. An exclusive holder (restore commit or a
// consistent snapshot) waits for them to drain, blocks newcomers, and then runs alone. Work started
// inside either kind of section carries a context marker so nested store calls never deadlock.
const als = new AsyncLocalStorage();
const SHARED = Object.freeze({ kind: 'shared' });
const EXCLUSIVE = Object.freeze({ kind: 'exclusive' });
const gate = { active: 0, exclusive: false, pending: 0, waiters: [], drainers: [], tail: Promise.resolve() };

function releaseWaiters() {
  if (gate.exclusive || gate.pending) return;
  const waiters = gate.waiters; gate.waiters = [];
  for (const w of waiters) w();
}

function runShared(file, fn) {
  if (als.getStore() || !gated(file)) return fn();
  if (gate.exclusive || gate.pending) return new Promise(resolve => gate.waiters.push(resolve)).then(() => runShared(file, fn));
  gate.active += 1;
  const done = () => {
    gate.active -= 1;
    if (!gate.active) { const d = gate.drainers; gate.drainers = []; for (const r of d) r(); }
  };
  let result;
  try { result = als.run(SHARED, fn); }
  catch (e) { done(); throw e; }
  return Promise.resolve(result).finally(done);
}

/**
 * Run `fn` alone: waits for in-flight reads/updates of gated documents, holds new ones back, then runs.
 * Store calls made inside `fn` bypass the gate. Calling this from inside a gated read/update would
 * deadlock, so it is refused.
 */
export function withDocumentGate(fn) {
  if (als.getStore()?.kind === 'shared') return Promise.reject(new Error('Document gate cannot be taken from inside a store call'));
  if (als.getStore()?.kind === 'exclusive') return Promise.resolve().then(fn);
  gate.pending += 1;
  const run = gate.tail.catch(() => {}).then(async () => {
    if (gate.active) await new Promise(resolve => gate.drainers.push(resolve));
    gate.exclusive = true;
    try { return await als.run(EXCLUSIVE, fn); }
    finally { gate.exclusive = false; gate.pending -= 1; releaseWaiters(); }
  });
  gate.tail = run.catch(() => {});
  return run;
}

// ---------- reads ----------
async function readRaw(file, fallback) {
  if (cache.has(file)) return clone(cache.get(file));
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return clone(fallback);
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    cache.set(file, value);
    return clone(value);
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    console.warn(`[store] ${file} is not valid JSON (${e.message}); moved to ${aside}`);
    await rename(file, aside).catch(() => {});
    return clone(fallback);
  }
}

export function readJson(file, fallback) {
  return runShared(file, () => readRaw(file, fallback));
}

/**
 * Like readJson but returns the cached object itself (no deep copy). Much faster for big files
 * (award cache, price history) on hot read paths. Callers MUST treat the result as read-only.
 */
export function readJsonShared(file, fallback) {
  return runShared(file, async () => {
    if (cache.has(file)) return cache.get(file);
    await readRaw(file, fallback);
    return cache.has(file) ? cache.get(file) : fallback;
  });
}

// ---------- writes ----------
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

/** Atomic file replacement without touching the read cache. `mode` restricts permissions where supported. */
export async function writeFileAtomic(file, text, { mode } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, mode ? { encoding: 'utf8', mode } : 'utf8');
  try { await renameWithRetry(tmp, file); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}

async function writeAtomic(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
  cache.set(file, clone(value));
}

/** Replace (or, with undefined, forget) the cached value for a file. Used after transactional writes. */
export function setCachedJson(file, value) {
  if (value === undefined) cache.delete(file); else cache.set(file, clone(value));
}

/** Serialized read-modify-write. `mutate` may change the value in place or return a new one. */
export function updateJson(file, fallback, mutate) {
  return runShared(file, () => {
    const prev = queues.get(file) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const current = await readRaw(file, fallback);
      const result = await mutate(current);
      const value = result === undefined ? current : result;
      await writeAtomic(file, value);
      return clone(value);
    });
    queues.set(file, next);
    return next;
  });
}

export const writeJson = (file, value) => updateJson(file, null, () => value);

/** Test helper. */
export function clearStoreCache() { cache.clear(); queues.clear(); }
