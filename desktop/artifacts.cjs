'use strict';
// Restricted file access for the renderer: save an encrypted backup or a diagnostics bundle, open a backup.
// There is no path argument and no generic read/write: the main process owns the dialogs, the file names and
// extensions, the size limits and the content checks. Content is plain JSON text produced by the app itself.
const path = require('node:path');
const fsp = require('node:fs/promises');

const LIMITS = { backup: 18 * 1024 * 1024, diagnostics: 2 * 1024 * 1024 };
const KINDS = {
  backup: { extension: 'ppbackup', label: 'PointPilot backup', prefix: 'pointpilot-backup', title: 'Save encrypted backup' },
  diagnostics: { extension: 'json', label: 'PointPilot diagnostics', prefix: 'pointpilot-diagnostics', title: 'Save diagnostics bundle' }
};

const fail = code => ({ ok: false, code });
// A backup may be opened from its own extension or .json; the check is on the final extension only, so
// `x.ppbackup.exe` and extensionless names are refused before the file system is touched.
const OPEN_EXTENSIONS = new Set([`.${KINDS.backup.extension}`, '.json']);
const allowedOpenPath = file => typeof file === 'string' && !file.includes(String.fromCharCode(0)) && !/[\\/]$/.test(file) && OPEN_EXTENSIONS.has(path.extname(file).toLowerCase());
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const dayStamp = now => new Date(now()).toISOString().slice(0, 10);

/** Shape checks only: the main process never decrypts a backup or interprets its contents. */
function validContent(kind, text) {
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  if (!isPlain(value)) return false;
  if (kind === 'backup') {
    const keys = Object.keys(value).sort().join(',');
    return value.format === 'pointpilot-backup' && Number.isInteger(value.version) && keys === 'cipher,ciphertext,format,kdf,version' && typeof value.ciphertext === 'string';
  }
  return value.format === 'pointpilot-diagnostics' && value.schemaVersion === 1;
}

function createArtifactHandlers({ dialog, getMainWindow, getPort, defaultDirectory = () => undefined, fs = fsp, now = Date.now }) {
  let dialogOpen = false;

  /** Only the app's own main frame, at its exact loopback origin, may ask for a dialog. */
  function trusted(event) {
    const win = getMainWindow();
    if (!win || win.isDestroyed?.()) return false;
    const contents = win.webContents;
    if (!event || event.sender !== contents) return false;
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame) return false;
    try {
      const url = new URL(frame.url);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === getPort() && url.username === '' && url.password === '';
    } catch { return false; }
  }

  async function withDialog(fn) {
    if (dialogOpen) return fail('DIALOG_BUSY');
    dialogOpen = true;
    try { return await fn(); } finally { dialogOpen = false; }
  }

  async function save(event, request) {
    if (!trusted(event)) return fail('UNTRUSTED_SENDER');
    if (!isPlain(request) || Object.keys(request).sort().join(',') !== 'content,kind' || typeof request.content !== 'string' || !Object.hasOwn(KINDS, request.kind)) return fail('INVALID_REQUEST');
    const kind = KINDS[request.kind];
    if (Buffer.byteLength(request.content, 'utf8') > LIMITS[request.kind]) return fail('TOO_LARGE');
    if (!validContent(request.kind, request.content)) return fail('INVALID_CONTENT');
    return withDialog(async () => {
      const dir = defaultDirectory();
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: kind.title,
        defaultPath: path.join(dir || '', `${kind.prefix}-${dayStamp(now)}.${kind.extension}`),
        filters: [{ name: kind.label, extensions: [kind.extension] }],
        properties: ['showOverwriteConfirmation']
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      // The saved file always ends in this kind's extension: a different or missing one gets it appended.
      let target = result.filePath;
      if (path.extname(target).toLowerCase() !== `.${kind.extension}`) target += `.${kind.extension}`;
      try {
        const existing = await fs.lstat(target).catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) return fail('NOT_ALLOWED');
        const tmp = `${target}.${process.pid}.tmp`;
        await fs.writeFile(tmp, request.content, { encoding: 'utf8', flag: 'w' });
        try { await fs.rename(tmp, target); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
      } catch { return fail('WRITE_FAILED'); }
      return { ok: true, filename: path.basename(target) };
    });
  }

  async function openBackup(event) {
    if (!trusted(event)) return fail('UNTRUSTED_SENDER');
    return withDialog(async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose a PointPilot backup',
        defaultPath: defaultDirectory(),
        filters: [{ name: KINDS.backup.label, extensions: [KINDS.backup.extension] }, { name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths?.length) return { cancelled: true };
      const file = result.filePaths[0];
      if (!allowedOpenPath(file)) return fail('NOT_ALLOWED'); // before any lstat/open/read; the path is never echoed
      let handle;
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) return fail('NOT_ALLOWED');
        if (info.size > LIMITS.backup) return fail('TOO_LARGE');
        handle = await fs.open(file, 'r');
        const stat = await handle.stat(); // re-check on the handle we actually read from
        if (!stat.isFile() || stat.size > LIMITS.backup) return fail(stat.size > LIMITS.backup ? 'TOO_LARGE' : 'NOT_ALLOWED');
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
        if (!validContent('backup', text)) return fail('NOT_A_BACKUP');
        return { ok: true, content: text, filename: path.basename(file) };
      } catch { return fail('READ_FAILED'); }
      finally { await handle?.close().catch(() => {}); }
    });
  }

  return { save, openBackup, trusted };
}

module.exports = { createArtifactHandlers, LIMITS, KINDS, validContent };
