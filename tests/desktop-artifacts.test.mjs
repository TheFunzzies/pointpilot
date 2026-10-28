import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, readdirSync, readFileSync as read } from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createArtifactHandlers, LIMITS } = require('../desktop/artifacts.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'pointpilot-artifacts-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const PORT = 4321;
const envelope = { format: 'pointpilot-backup', version: 1, kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }, cipher: { name: 'aes-256-gcm', iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==' }, ciphertext: 'AAAA' };
const bundle = { format: 'pointpilot-diagnostics', schemaVersion: 1, generatedAt: '2026-10-20T00:00:00.000Z', requests: [] };

function harness({ saveResult, openResult } = {}) {
  const contents = { mainFrame: { url: `http://127.0.0.1:${PORT}/` } };
  const win = { webContents: contents, isDestroyed: () => false };
  const calls = [];
  const dialog = {
    showSaveDialog: async (parent, opts) => { calls.push(['save', parent, opts]); return saveResult || { canceled: true }; },
    showOpenDialog: async (parent, opts) => { calls.push(['open', parent, opts]); return openResult || { canceled: true }; }
  };
  const handlers = createArtifactHandlers({ dialog, getMainWindow: () => win, getPort: () => PORT, defaultDirectory: () => dir, now: () => Date.UTC(2026, 9, 20) });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { handlers, event, win, contents, calls };
}

test('only the main frame at the exact loopback origin may use the dialogs', async () => {
  const h = harness();
  const request = { kind: 'backup', content: JSON.stringify(envelope) };
  assert.deepEqual(await h.handlers.save(h.event, request), { cancelled: true }, 'trusted sender reaches the dialog');
  const other = { webContents: {}, isDestroyed: () => false };
  const bad = {
    'another window': { sender: other.webContents, senderFrame: { url: `http://127.0.0.1:${PORT}/` } },
    'subframe': { sender: h.contents, senderFrame: { url: `http://127.0.0.1:${PORT}/` } },
    'no frame': { sender: h.contents },
    'wrong port': { sender: h.contents, senderFrame: Object.assign(h.contents.mainFrame, { url: `http://127.0.0.1:${PORT + 1}/` }) },
    'localhost name': { sender: h.contents, senderFrame: Object.assign(h.contents.mainFrame, { url: `http://localhost:${PORT}/` }) },
    'https': { sender: h.contents, senderFrame: Object.assign(h.contents.mainFrame, { url: `https://127.0.0.1:${PORT}/` }) },
    'remote origin': { sender: h.contents, senderFrame: Object.assign(h.contents.mainFrame, { url: 'http://evil.example:4321/' }) },
    'userinfo': { sender: h.contents, senderFrame: Object.assign(h.contents.mainFrame, { url: `http://x:y@127.0.0.1:${PORT}/` }) },
    'garbage url': { sender: h.contents, senderFrame: Object.assign(h.contents.mainFrame, { url: 'not a url' }) },
    'no event': undefined
  };
  const before = h.calls.length;
  for (const [name, event] of Object.entries(bad)) {
    assert.deepEqual(await h.handlers.save(event, request), { ok: false, code: 'UNTRUSTED_SENDER' }, name);
    assert.deepEqual(await h.handlers.openBackup(event), { ok: false, code: 'UNTRUSTED_SENDER' }, name);
  }
  assert.equal(h.calls.length, before, 'untrusted senders never reach a dialog');
  h.win.isDestroyed = () => true;
  h.contents.mainFrame.url = `http://127.0.0.1:${PORT}/`;
  assert.equal((await h.handlers.save(h.event, request)).code, 'UNTRUSTED_SENDER', 'a destroyed window is untrusted');
});

test('save: native dialog parented to the main window, fixed names and filters, cancel is neutral', async () => {
  const h = harness();
  assert.deepEqual(await h.handlers.save(h.event, { kind: 'backup', content: JSON.stringify(envelope) }), { cancelled: true });
  const [, parent, opts] = h.calls[0];
  assert.equal(parent, h.win);
  assert.equal(path.basename(opts.defaultPath), 'pointpilot-backup-2026-10-20.ppbackup');
  assert.deepEqual(opts.filters, [{ name: 'PointPilot backup', extensions: ['ppbackup'] }]);
  await h.handlers.save(h.event, { kind: 'diagnostics', content: JSON.stringify(bundle) });
  assert.equal(path.basename(h.calls[1][2].defaultPath), 'pointpilot-diagnostics-2026-10-20.json');
  assert.deepEqual(readdirSync(dir), [], 'cancelling writes nothing');
});

test('save: writes the encrypted envelope, appends the extension, and returns only a file name', async () => {
  const target = path.join(dir, 'my backup');
  const h = harness({ saveResult: { canceled: false, filePath: target } });
  const content = JSON.stringify(envelope);
  const r = await h.handlers.save(h.event, { kind: 'backup', content });
  assert.deepEqual(r, { ok: true, filename: 'my backup.ppbackup' });
  assert.equal(readFileSync(`${target}.ppbackup`, 'utf8'), content);
  assert.ok(!JSON.stringify(r).includes(dir), 'no directory leaks back to the renderer');
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temp files left behind');
  const h2 = harness({ saveResult: { canceled: false, filePath: path.join(dir, 'bundle.TXT') } });
  assert.equal((await h2.handlers.save(h2.event, { kind: 'diagnostics', content: JSON.stringify(bundle) })).filename, 'bundle.TXT.json');
});

test('save: plaintext, other shapes, unknown kinds, extra fields and oversized content are refused', async () => {
  const h = harness({ saveResult: { canceled: false, filePath: path.join(dir, 'never.ppbackup') } });
  const cases = {
    'plaintext wallet as a backup': [{ kind: 'backup', content: JSON.stringify({ balances: [{ code: 'chase', balance: 5 }] }) }, 'INVALID_CONTENT'],
    'not json': [{ kind: 'backup', content: 'hello' }, 'INVALID_CONTENT'],
    'envelope with extra keys': [{ kind: 'backup', content: JSON.stringify({ ...envelope, plaintext: 'x' }) }, 'INVALID_CONTENT'],
    'diagnostics shaped as backup': [{ kind: 'backup', content: JSON.stringify(bundle) }, 'INVALID_CONTENT'],
    'backup shaped as diagnostics': [{ kind: 'diagnostics', content: JSON.stringify(envelope) }, 'INVALID_CONTENT'],
    'unknown kind': [{ kind: 'wallet', content: '{}' }, 'INVALID_REQUEST'],
    'prototype kind': [{ kind: '__proto__', content: '{}' }, 'INVALID_REQUEST'],
    'path argument': [{ kind: 'backup', content: JSON.stringify(envelope), path: 'C:/Windows/evil.ppbackup' }, 'INVALID_REQUEST'],
    'filename argument': [{ kind: 'backup', content: JSON.stringify(envelope), filename: '../x' }, 'INVALID_REQUEST'],
    'non-string content': [{ kind: 'backup', content: { format: 'pointpilot-backup' } }, 'INVALID_REQUEST'],
    'array request': [[], 'INVALID_REQUEST'],
    'null request': [null, 'INVALID_REQUEST'],
    'oversized diagnostics': [{ kind: 'diagnostics', content: JSON.stringify({ ...bundle, pad: 'x'.repeat(LIMITS.diagnostics) }) }, 'TOO_LARGE'],
    'oversized backup': [{ kind: 'backup', content: JSON.stringify({ ...envelope, ciphertext: 'A'.repeat(LIMITS.backup) }) }, 'TOO_LARGE']
  };
  for (const [name, [request, code]] of Object.entries(cases)) assert.deepEqual(await h.handlers.save(h.event, request), { ok: false, code }, name);
  assert.equal(h.calls.length, 0, 'invalid requests never open a dialog');
  assert.equal(existsSync(path.join(dir, 'never.ppbackup')), false);
});

test('save: refuses to overwrite a symlink or a directory', async t => {
  const real = path.join(dir, 'real.ppbackup'); writeFileSync(real, 'keep me');
  const link = path.join(dir, 'link.ppbackup');
  try { symlinkSync(real, link); } catch { t.diagnostic('symlink creation not permitted here; symlink assertion skipped'); }
  const asDir = path.join(dir, 'folder.ppbackup'); mkdirSync(asDir);
  const content = JSON.stringify(envelope);
  for (const filePath of [existsSync(link) ? link : null, asDir].filter(Boolean)) {
    const h = harness({ saveResult: { canceled: false, filePath } });
    assert.deepEqual(await h.handlers.save(h.event, { kind: 'backup', content }), { ok: false, code: 'NOT_ALLOWED' });
  }
  assert.equal(readFileSync(real, 'utf8'), 'keep me');
});

test('save: a write failure is a safe error code', async () => {
  const h = harness({ saveResult: { canceled: false, filePath: path.join(dir, 'missing-dir', 'x.ppbackup') } });
  assert.deepEqual(await h.handlers.save(h.event, { kind: 'backup', content: JSON.stringify(envelope) }), { ok: false, code: 'WRITE_FAILED' });
});

test('only one dialog at a time', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const contents = { mainFrame: { url: `http://127.0.0.1:${PORT}/` } };
  const win = { webContents: contents, isDestroyed: () => false };
  const handlers = createArtifactHandlers({ dialog: { showSaveDialog: async () => { await gate; return { canceled: true }; }, showOpenDialog: async () => ({ canceled: true }) }, getMainWindow: () => win, getPort: () => PORT });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const first = handlers.save(event, { kind: 'backup', content: JSON.stringify(envelope) });
  assert.deepEqual(await handlers.openBackup(event), { ok: false, code: 'DIALOG_BUSY' });
  release();
  assert.deepEqual(await first, { cancelled: true });
});

test('open: cancel is neutral; a regular backup file is returned as text with its name', async () => {
  const cancelled = harness();
  assert.deepEqual(await cancelled.handlers.openBackup(cancelled.event), { cancelled: true });
  const file = path.join(dir, 'in.ppbackup');
  writeFileSync(file, `\uFEFF${JSON.stringify(envelope)}`);
  const h = harness({ openResult: { canceled: false, filePaths: [file] } });
  const r = await h.handlers.openBackup(h.event);
  assert.deepEqual(r, { ok: true, content: JSON.stringify(envelope), filename: 'in.ppbackup' });
  assert.equal(h.calls[0][1], h.win, 'parented to the main window');
  assert.deepEqual(h.calls[0][2].properties, ['openFile']);
});

test('open: wrong content, directories, symlinks and oversized files are refused', async t => {
  const cases = {};
  const notBackup = path.join(dir, 'other.json'); writeFileSync(notBackup, JSON.stringify({ balances: [] })); cases.NOT_A_BACKUP = notBackup;
  const garbage = path.join(dir, 'garbage.ppbackup'); writeFileSync(garbage, 'not json at all'); cases.NOT_A_BACKUP_2 = garbage;
  const folder = path.join(dir, 'a-folder'); mkdirSync(folder); cases.NOT_ALLOWED = folder;
  const big = path.join(dir, 'big.ppbackup'); writeFileSync(big, Buffer.alloc(LIMITS.backup + 1, 32)); cases.TOO_LARGE = big;
  const missing = path.join(dir, 'gone.ppbackup'); cases.READ_FAILED = missing;
  for (const [code, file] of Object.entries(cases)) {
    const h = harness({ openResult: { canceled: false, filePaths: [file] } });
    assert.equal((await h.handlers.openBackup(h.event)).code, code.replace('_2', ''), file);
  }
  const target = path.join(dir, 'target.ppbackup'); writeFileSync(target, JSON.stringify(envelope));
  const link = path.join(dir, 'open-link.ppbackup');
  try { symlinkSync(target, link); } catch { return t.diagnostic('symlink creation not permitted here; symlink assertion skipped'); }
  const h = harness({ openResult: { canceled: false, filePaths: [link] } });
  assert.equal((await h.handlers.openBackup(h.event)).code, 'NOT_ALLOWED');
});

test('the preload exposes only the two artifact methods and no filesystem primitives', () => {
  const exposed = {};
  const sandbox = { require: id => (id === 'electron' ? { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: { invoke: (...a) => a, on() {}, removeListener() {} } } : null) };
  vm.createContext(sandbox);
  vm.runInContext(read(path.join(root, 'desktop', 'preload.cjs'), 'utf8'), sandbox);
  const api = exposed.pointpilot;
  assert.ok(api.saveArtifact && api.openBackup);
  for (const name of Object.keys(api)) assert.ok(!/read|write|file|path|fs|exec|shell/i.test(name.replace(/saveArtifact|openBackup|openProvider/, '')), `unexpected capability: ${name}`);
  assert.deepEqual(JSON.parse(JSON.stringify(api.saveArtifact({ kind: 'backup', content: 'x', path: 'C:/evil', extra: 1 }))), ['save-artifact', { kind: 'backup', content: 'x' }], 'only kind and content cross the bridge');
  assert.deepEqual(JSON.parse(JSON.stringify(api.openBackup())), ['open-backup']);
});

test('main process registers the handlers behind the trusted-sender check and no raw file IPC', () => {
  const main = read(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  assert.match(main, /ipcMain\.handle\('save-artifact'/);
  assert.match(main, /ipcMain\.handle\('open-backup'/);
  assert.doesNotMatch(main, /ipcMain\.handle\('(read|write)-?file/i);
  const ipcNames = [...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(ipcNames, ['app-info', 'check-for-updates', 'install-update', 'llm-ask', 'llm-openai-disconnect', 'llm-openai-sign-in', 'llm-remove-claude-key', 'llm-save-claude-key', 'llm-status', 'open-backup', 'open-provider', 'save-artifact', 'settings-changed']);
});

// A spy file system: every call is recorded, so "zero reads" is something we can assert.
function spyFs(real = {}) {
  const calls = [];
  const wrap = name => async (...args) => { calls.push(name); if (!real[name]) throw new Error(`unexpected fs.${name}`); return real[name](...args); };
  return { calls, lstat: wrap('lstat'), open: wrap('open'), readFile: wrap('readFile'), writeFile: wrap('writeFile'), rename: wrap('rename'), unlink: wrap('unlink') };
}
function openHarness(filePath, fs) {
  const contents = { mainFrame: { url: `http://127.0.0.1:${PORT}/` } };
  const win = { webContents: contents, isDestroyed: () => false };
  const dialog = { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: false, filePaths: [filePath] }) };
  const handlers = createArtifactHandlers({ dialog, getMainWindow: () => win, getPort: () => PORT, fs });
  return { handlers, event: { sender: contents, senderFrame: contents.mainFrame } };
}

test('open: only .ppbackup and .json can be read; anything else is refused before any file access', async () => {
  const refused = ['C:\\Users\\x\\backup.exe', 'C:\\Users\\x\\backup', 'C:\\Users\\x\\backup.', 'C:\\Users\\x\\x.ppbackup.exe', 'C:\\Users\\x\\x.json.exe', 'C:\\Users\\x\\x.ppbackup.bat', 'C:\\Users\\x\\x.PPBACKUP.EXE',
    'C:\\Users\\x\\x.ppbackup:stream', 'C:\\Users\\x\\x.txt', 'C:\\Users\\x\\.ppbackup.exe', '/home/x/backup.sh', '/home/x/x.ppbackup/', 'C:\\Users\\x\\x.ppbackup\\', `/home/x/x.ppbackup${String.fromCharCode(0)}.exe`, ''];
  for (const file of refused) {
    const fs = spyFs();
    const h = openHarness(file, fs);
    const r = await h.handlers.openBackup(h.event);
    assert.deepEqual(r, { ok: false, code: 'NOT_ALLOWED' }, JSON.stringify(file));
    assert.deepEqual(fs.calls, [], `no file system access for ${JSON.stringify(file)}`);
    assert.ok(!JSON.stringify(r).includes('backup.exe') && !JSON.stringify(r).includes('Users'), 'the path is never echoed');
  }
});

test('open: the allowed extensions are accepted, case-insensitively', async () => {
  for (const name of ['ok.ppbackup', 'ok.PPBACKUP', 'ok.json', 'Ok.Json', 'my.backup.ppbackup']) {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(envelope));
    const h = openHarness(file, undefined);
    const r = await h.handlers.openBackup(h.event);
    assert.equal(r.ok, true, name);
    assert.equal(r.filename, name);
  }
});

test('save: the written file always ends in this kind\'s extension, whatever name was chosen', async () => {
  const chosen = { backup: ['plain', 'x.exe', 'x.ppbackup.exe', 'x.json', 'x.', 'x.PPBACKUP'], diagnostics: ['plain', 'x.exe', 'x.json.exe', 'x.ppbackup', 'x.JSON'] };
  const contentOf = { backup: JSON.stringify(envelope), diagnostics: JSON.stringify(bundle) };
  const extOf = { backup: '.ppbackup', diagnostics: '.json' };
  for (const [kind, names] of Object.entries(chosen)) {
    for (const name of names) {
      const target = path.join(dir, `forced-${kind}-${name}`);
      const written = [];
      const fs = spyFs({
        lstat: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
        writeFile: async (file) => { written.push(file); },
        rename: async (_from, to) => { written.push(to); }
      });
      const contents = { mainFrame: { url: `http://127.0.0.1:${PORT}/` } };
      const win = { webContents: contents, isDestroyed: () => false };
      const handlers = createArtifactHandlers({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }), showOpenDialog: async () => ({ canceled: true }) }, getMainWindow: () => win, getPort: () => PORT, fs });
      const r = await handlers.save({ sender: contents, senderFrame: contents.mainFrame }, { kind, content: contentOf[kind] });
      assert.equal(r.ok, true, `${kind} ${name}`);
      assert.equal(path.extname(r.filename).toLowerCase(), extOf[kind], `${kind} ${name} -> ${r.filename}`);
      assert.equal(path.extname(written.at(-1)).toLowerCase(), extOf[kind], 'the final path on disk has the kind\'s extension');
    }
  }
});
