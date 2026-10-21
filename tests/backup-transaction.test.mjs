import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-txn-'));
process.env.POINTPILOT_DATA_DIR = dir;
const { readJson, updateJson, withDocumentGate, clearStoreCache, documentPath, DOCUMENT_FILES } = await import('../lib/store.mjs');
const tx = await import('../lib/store-transaction.mjs');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const names = Object.keys(DOCUMENT_FILES);
const onDisk = name => (existsSync(documentPath(name)) ? JSON.parse(readFileSync(documentPath(name), 'utf8')) : null);
const journalFile = () => path.join(dir, tx.JOURNAL_FILE);

async function seed(docs) {
  for (const name of names) { try { rmSync(documentPath(name)); } catch { /* absent */ } }
  rmSync(journalFile(), { force: true });
  clearStoreCache();
  for (const [name, value] of Object.entries(docs)) writeFileSync(documentPath(name), JSON.stringify(value));
}

const BEFORE = { user: { balances: [{ code: 'chase', balance: 1 }], preferences: {} }, settings: { monitorIntervalMinutes: 60 }, alerts: [{ id: 'a1' }] };
const AFTER = { user: { balances: [{ code: 'chase', balance: 99 }], preferences: {} }, settings: { monitorIntervalMinutes: 30 }, tripPlan: { schemaVersion: 2, revision: 1, segments: [] }, alerts: [{ id: 'a2' }] };

/** Wrap the real io; `failAt` fails the Nth operation. dead=true makes every later operation fail too (a crash). */
function faultyIo({ failAt = Infinity, dead = false } = {}) {
  const state = { calls: 0, crashed: false };
  const wrap = fn => async (...args) => {
    state.calls += 1;
    if (state.crashed || state.calls === failAt) { if (dead) state.crashed = true; throw Object.assign(new Error('injected fault'), { code: 'EIO' }); }
    return fn(...args);
  };
  return { state, io: { writeFile: wrap(tx.defaultIo.writeFile), removeFile: wrap(tx.defaultIo.removeFile), readText: tx.defaultIo.readText, moveAside: tx.defaultIo.moveAside } };
}

test('snapshot reports absent documents and stable hashes', async () => {
  await seed({ user: BEFORE.user });
  const a = await tx.snapshotDocuments();
  assert.equal(a.documents.settings, null);
  assert.equal(a.hashes.settings, 'absent');
  assert.deepEqual(a.documents.user, BEFORE.user);
  const b = await tx.snapshotDocuments();
  assert.equal(a.revision, b.revision);
  assert.equal(tx.hashDocument({ b: 1, a: 2 }), tx.hashDocument({ a: 2, b: 1 }), 'key order must not matter');
});

test('replaceDocumentsAtomic writes every document, keeps the cache consistent and removes the journal', async () => {
  await seed(BEFORE);
  const snap = await tx.snapshotDocuments();
  const result = await tx.replaceDocumentsAtomic({ after: AFTER, baseHashes: snap.hashes });
  assert.deepEqual(result.changed.sort(), ['alerts', 'settings', 'tripPlan', 'user']);
  for (const name of Object.keys(AFTER)) {
    assert.deepEqual(onDisk(name), AFTER[name], `${name} on disk`);
    assert.deepEqual(await readJson(documentPath(name), null), AFTER[name], `${name} via cache`);
  }
  assert.equal(existsSync(journalFile()), false);
  assert.notEqual(result.revision, snap.revision);
});

test('unchanged documents are not rewritten and an all-equal request is a no-op', async () => {
  await seed(BEFORE);
  const snap = await tx.snapshotDocuments();
  const result = await tx.replaceDocumentsAtomic({ after: { user: BEFORE.user }, baseHashes: snap.hashes });
  assert.deepEqual(result.changed, []);
  assert.equal(existsSync(journalFile()), false);
});

test('a changed document since the preview makes the commit fail with STALE and writes nothing', async () => {
  await seed(BEFORE);
  const snap = await tx.snapshotDocuments();
  await updateJson(documentPath('alerts'), [], a => { a.push({ id: 'monitor-wrote-this' }); });
  await assert.rejects(tx.replaceDocumentsAtomic({ after: AFTER, baseHashes: snap.hashes }), e => e.code === 'STALE' && e.document === 'alerts');
  assert.deepEqual(onDisk('user'), BEFORE.user, 'nothing was written');
  assert.equal(existsSync(journalFile()), false);
});

test('only the fixed document names are accepted', async () => {
  await seed(BEFORE);
  await assert.rejects(tx.replaceDocumentsAtomic({ after: { '../evil': { a: 1 } }, baseHashes: {} }), e => e.code === 'UNKNOWN_DOCUMENT');
  await assert.rejects(tx.replaceDocumentsAtomic({ after: { user: null }, baseHashes: {} }), e => e.code === 'INVALID_DOCUMENT');
});

// Inject a failure at every file/journal boundary: the prior data must come back, with or without a "crash".
const expectedOps = 4 /* docs */ + 2 /* journal pending + committed */ + 1 /* journal removal */;
for (let failAt = 1; failAt <= expectedOps; failAt++) {
  test(`failure at operation ${failAt}: the commit rolls back and prior data stays usable`, async () => {
    await seed(BEFORE);
    const { io } = faultyIo({ failAt });
    const manager = tx.createTransactionManager({ io });
    const snap = await manager.snapshotDocuments();
    let error = null, result = null;
    try { result = await manager.replaceDocumentsAtomic({ after: AFTER, baseHashes: snap.hashes }); } catch (e) { error = e; }
    if (failAt === expectedOps) {
      // Only the final journal removal failed: the restore itself committed.
      assert.equal(error, null);
      assert.equal(result.journalCleared, false);
      for (const name of Object.keys(AFTER)) assert.deepEqual(onDisk(name), AFTER[name]);
      assert.equal(JSON.parse(readFileSync(journalFile(), 'utf8')).state, 'committed');
      const recovered = await tx.createTransactionManager().recoverTransactions();
      assert.equal(recovered.cleaned, true);
      return;
    }
    assert.equal(error?.code, 'COMMIT_FAILED');
    assert.equal(error.recovery, failAt === 1 ? 'none' : 'rolled-back');
    for (const name of names) assert.deepEqual(onDisk(name), BEFORE[name] ?? null, `${name} restored`);
    assert.equal(existsSync(journalFile()), false);
    clearStoreCache(); // cache must agree with disk, so a stale value cannot survive
    for (const name of names) assert.deepEqual(await readJson(documentPath(name), null), BEFORE[name] ?? null);
  });

  test(`crash at operation ${failAt}: startup recovery restores the before-images`, async () => {
    await seed(BEFORE);
    const { io } = faultyIo({ failAt, dead: true });
    const manager = tx.createTransactionManager({ io });
    const snap = await manager.snapshotDocuments();
    await manager.replaceDocumentsAtomic({ after: AFTER, baseHashes: snap.hashes }).catch(() => {});
    // "Restart": the process is gone, the cache is empty, io works again.
    clearStoreCache();
    const recovery = await tx.createTransactionManager().recoverTransactions();
    if (failAt >= expectedOps - 1 && existsSync(journalFile()) === false && recovery.recovered === false) {
      // The commit had already reached the committed marker; nothing to undo.
      for (const name of Object.keys(AFTER)) assert.deepEqual(onDisk(name), AFTER[name]);
      return;
    }
    for (const name of names) assert.deepEqual(onDisk(name), BEFORE[name] ?? null, `${name} after recovery`);
    assert.equal(existsSync(journalFile()), false, 'journal removed after recovery');
    for (const name of names) assert.deepEqual(await readJson(documentPath(name), null), BEFORE[name] ?? null);
  });
}

test('recovery ignores unknown names in a journal and sets aside an unreadable journal', async () => {
  await seed(BEFORE);
  writeFileSync(journalFile(), JSON.stringify({ version: 1, state: 'pending', files: { '../../escape': { before: { x: 1 } }, user: { before: { balances: [], preferences: {} } } } }));
  const r = await tx.recoverTransactions();
  assert.deepEqual(r.rolledBack, ['user']);
  assert.deepEqual(onDisk('user'), { balances: [], preferences: {} });
  assert.equal(existsSync(path.join(dir, '..', 'escape')), false);
  writeFileSync(journalFile(), '{not json');
  const warn = console.warn; console.warn = () => {};
  try { assert.equal((await tx.recoverTransactions()).corruptJournal, true); } finally { console.warn = warn; }
  assert.equal(existsSync(journalFile()), false);
});

test('readers never see a half-applied restore and ordinary reads wait for the commit', async () => {
  await seed(BEFORE);
  const slow = { ...tx.defaultIo, writeFile: async (...args) => { await new Promise(r => setTimeout(r, 25)); return tx.defaultIo.writeFile(...args); } };
  const manager = tx.createTransactionManager({ io: slow });
  const snap = await manager.snapshotDocuments();
  const seen = [];
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      const s = await manager.snapshotDocuments();
      seen.push(`${s.documents.user?.balances[0].balance}/${s.documents.settings?.monitorIntervalMinutes}/${s.documents.alerts?.[0].id}`);
      await new Promise(r => setTimeout(r, 2));
    }
  })();
  const commit = manager.replaceDocumentsAtomic({ after: AFTER, baseHashes: snap.hashes });
  await new Promise(r => setTimeout(r, 30)); // commit is mid-flight
  const read = await readJson(documentPath('alerts'), null); // must wait for the gate
  await commit;
  stop = true; await poller;
  assert.deepEqual(read, AFTER.alerts, 'a read issued during the commit sees the committed data, not a mix');
  const states = new Set(seen);
  for (const s of states) assert.ok(s === '1/60/a1' || s === '99/30/a2', `torn state observed: ${s}`);
  assert.ok(states.has('1/60/a1') && states.has('99/30/a2'));
});

test('store calls made inside a gated update, and inside the gate, do not deadlock', async () => {
  await seed(BEFORE);
  const value = await updateJson(documentPath('user'), null, async u => {
    const s = await readJson(documentPath('settings'), {}); // nested gated read
    u.seenInterval = s.monitorIntervalMinutes;
  });
  assert.equal(value.seenInterval, 60);
  await withDocumentGate(async () => { await updateJson(documentPath('settings'), {}, s => { s.touched = true; }); });
  assert.equal((await readJson(documentPath('settings'), {})).touched, true);
  await assert.rejects(updateJson(documentPath('user'), null, () => withDocumentGate(async () => {})), /cannot be taken/);
});

test('non-document files are never gated', async () => {
  await seed(BEFORE);
  let release; const held = new Promise(r => { release = r; });
  const gateRun = withDocumentGate(() => held);
  const other = await Promise.race([updateJson(path.join(dir, 'api-usage.json'), {}, u => { u.n = 1; }), new Promise(r => setTimeout(() => r('blocked'), 500))]);
  assert.equal(other.n, 1);
  release(); await gateRun;
});
