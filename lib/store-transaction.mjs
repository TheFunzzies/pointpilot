// Multi-document transaction for backup restore.
// The store serializes writes per file; this module adds what it lacks: a consistent snapshot of the
// five backup documents, and an all-or-nothing replacement of several of them with a before-image
// journal so a crash mid-restore is rolled back at the next startup. This is process-crash recovery,
// not a promise against every power failure or filesystem fault.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, unlink, rename } from 'node:fs/promises';
import { dataDir } from './paths.mjs';
import path from 'node:path';
import { DOCUMENT_FILES, documentPath, readJson, setCachedJson, withDocumentGate, writeFileAtomic } from './store.mjs';

export const JOURNAL_FILE = 'restore-journal.json';
const DOCUMENT_ORDER = Object.keys(DOCUMENT_FILES);

export class TransactionError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** Deterministic JSON (sorted keys) so equal documents hash equally regardless of key order. */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashDocument = value => (value == null ? 'absent' : createHash('sha256').update(canonicalJson(value)).digest('hex'));
export const revisionOf = hashes => createHash('sha256').update(DOCUMENT_ORDER.map(n => `${n}=${hashes[n] || 'absent'}`).join('|')).digest('hex').slice(0, 16);

export const defaultIo = {
  writeFile: (file, text, opts) => writeFileAtomic(file, text, opts),
  removeFile: file => unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }),
  readText: file => readFile(file, 'utf8'),
  moveAside: file => rename(file, `${file}.corrupt-${Date.now()}`)
};

export function createTransactionManager({ io = defaultIo, journalPath = () => path.join(dataDir(), JOURNAL_FILE) } = {}) {
  const textOf = value => JSON.stringify(value, null, 2);

  /** Consistent view of all five documents (absent files are null) plus content hashes. */
  async function readAll() {
    const documents = {}, hashes = {};
    for (const name of DOCUMENT_ORDER) {
      const value = await readJson(documentPath(name), null);
      documents[name] = value ?? null;
      hashes[name] = hashDocument(value);
    }
    return { documents, hashes, revision: revisionOf(hashes) };
  }

  function snapshotDocuments() { return withDocumentGate(readAll); }

  async function writeJournal(journal) { await io.writeFile(journalPath(), textOf(journal), { mode: 0o600 }); }

  async function restoreBeforeImages(files) {
    for (const [name, entry] of Object.entries(files)) {
      if (!Object.hasOwn(DOCUMENT_FILES, name)) continue; // never act on a name that is not one of the fixed documents
      const file = documentPath(name);
      if (entry.before == null) await io.removeFile(file); else await io.writeFile(file, textOf(entry.before));
      setCachedJson(file, entry.before ?? undefined);
    }
  }

  /**
   * Replace several documents together. `after` maps document name -> new value (only the ones to change).
   * `baseHashes` (name -> hash from a snapshot) guards against anything having changed since the preview.
   * Returns { changed, revision }. Throws TransactionError('STALE') when a base hash no longer matches and
   * TransactionError('COMMIT_FAILED') after rolling back (or, if even rollback failed, leaving the journal
   * for startup recovery; `recovery` tells which).
   */
  async function replaceDocumentsAtomic({ after, baseHashes }) {
    for (const [name, value] of Object.entries(after || {})) {
      if (!Object.hasOwn(DOCUMENT_FILES, name)) throw new TransactionError(`Unknown document: ${name}`, 'UNKNOWN_DOCUMENT');
      if (value == null || typeof value !== 'object') throw new TransactionError(`Document ${name} must be an object or array`, 'INVALID_DOCUMENT');
    }
    return withDocumentGate(async () => {
      const current = await readAll();
      for (const [name, expected] of Object.entries(baseHashes || {})) {
        if (current.hashes[name] !== expected) throw new TransactionError('Data changed since the preview was created.', 'STALE', { document: name });
      }
      const changed = Object.keys(after).filter(name => hashDocument(after[name]) !== current.hashes[name]);
      if (!changed.length) return { changed: [], revision: current.revision };

      const files = Object.fromEntries(changed.map(name => [name, { before: current.documents[name] }]));
      const journal = { version: 1, id: randomBytes(8).toString('hex'), state: 'pending', startedAt: new Date().toISOString(), files };
      try {
        await writeJournal(journal);
      } catch (cause) {
        await io.removeFile(journalPath()).catch(() => {});
        throw new TransactionError('Restore could not start; nothing was changed.', 'COMMIT_FAILED', { recovery: 'none', cause });
      }
      try {
        for (const name of changed) {
          const file = documentPath(name);
          await io.writeFile(file, textOf(after[name]));
          setCachedJson(file, after[name]);
        }
        await writeJournal({ ...journal, state: 'committed' });
      } catch (cause) {
        try {
          await restoreBeforeImages(files);
          await io.removeFile(journalPath());
        } catch {
          for (const name of changed) setCachedJson(documentPath(name), undefined); // next read comes from disk
          throw new TransactionError('Restore failed and will be rolled back when PointPilot restarts.', 'COMMIT_FAILED', { recovery: 'journal-retained', cause });
        }
        throw new TransactionError('Restore failed; your previous data was put back.', 'COMMIT_FAILED', { recovery: 'rolled-back', cause });
      }
      let journalCleared = true;
      try { await io.removeFile(journalPath()); } catch { journalCleared = false; } // committed journals are harmless; startup removes them
      const next = await readAll();
      return { changed, revision: next.revision, journalCleared };
    });
  }

  /** Startup: finish or undo a transaction a crash interrupted. Must run before serving requests or starting the monitor. */
  function recoverTransactions() {
    return withDocumentGate(async () => {
      let text;
      try { text = await io.readText(journalPath()); }
      catch (e) { if (e.code === 'ENOENT') return { recovered: false }; throw e; }
      let journal;
      try { journal = JSON.parse(text); } catch { journal = null; }
      if (!journal || typeof journal !== 'object' || typeof journal.files !== 'object' || journal.files === null) {
        await io.moveAside(journalPath()).catch(() => {});
        console.warn('[backup] restore journal was unreadable and was set aside');
        return { recovered: false, corruptJournal: true };
      }
      if (journal.state === 'committed') { await io.removeFile(journalPath()); return { recovered: false, cleaned: true }; }
      await restoreBeforeImages(journal.files);
      await io.removeFile(journalPath());
      return { recovered: true, rolledBack: Object.keys(journal.files).filter(n => Object.hasOwn(DOCUMENT_FILES, n)) };
    });
  }

  return { snapshotDocuments, replaceDocumentsAtomic, recoverTransactions, journalPath };
}

const manager = createTransactionManager();
export const snapshotDocuments = manager.snapshotDocuments;
export const replaceDocumentsAtomic = manager.replaceDocumentsAtomic;
export const recoverTransactions = manager.recoverTransactions;
