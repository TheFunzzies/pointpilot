const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

let mainWindow = null;
let captureWindow = null;
let server = null;
let serverPort = null;
let providerCaptureMeta = null;

// electron-updater is only available after npm install in packaged/release builds.
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  console.warn('[updates] electron-updater unavailable:', err.message);
}

const BUNDLED_DATA_FILES = [
  'user.json', 'alerts.json', 'transfer-partners.json', 'price-history.json', 'award-cache.json'
];

async function ensureUserData() {
  const root = path.join(app.getPath('userData'), 'data');
  await fsp.mkdir(root, { recursive: true });
  const bundled = path.join(app.getAppPath(), 'data');
  for (const name of BUNDLED_DATA_FILES) {
    const dest = path.join(root, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(bundled, name);
    if (fs.existsSync(src)) await fsp.copyFile(src, dest);
    else await fsp.writeFile(dest, name === 'alerts.json' || name === 'award-cache.json' ? '[]\n' : '{}\n', 'utf8');
  }
  return root;
}

function challengeDetected(text) {
  return /(captcha|recaptcha|hcaptcha|access denied|verify you are human|unusual traffic|robot check|blocked)/i.test(text || '');
}

function sendUpdateStatus(status, extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update-status', { status, ...extra });
}

function configureAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return false;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // Until Authenticode signing is configured for the GitHub Actions build,
  // allow unsigned installers to update. Before public distribution, enable
  // Windows code signing and restore signature verification.
  autoUpdater.verifyUpdateCodeSignature = false;

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus('current', { version: info.version || app.getVersion() }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', {
    version: progress.version,
    percent: Math.round(progress.percent || 0),
    transferred: progress.transferred,
    total: progress.total
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err?.message || String(err) }));
  return true;
}

async function checkForUpdates(userInitiated = false) {
  if (!autoUpdater || !app.isPackaged) {
    const message = 'Updates are available after PointPilot is installed from a GitHub release.';
    if (userInitiated) sendUpdateStatus('unavailable', { message });
    return { ok: false, message };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.updateInfo || result.updateInfo.version === app.getVersion()) {
      sendUpdateStatus('current', { version: app.getVersion() });
    }
    return { ok: true, version: result?.updateInfo?.version || app.getVersion() };
  } catch (err) {
    sendUpdateStatus('error', { message: err?.message || String(err) });
    return { ok: false, message: err?.message || String(err) };
  }
}

async function downloadUpdate() {
  if (!autoUpdater) return { ok: false, message: 'Updater unavailable.' };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    sendUpdateStatus('error', { message: err?.message || String(err) });
    return { ok: false, message: err?.message || String(err) };
  }
}

function installUpdate() {
  if (!autoUpdater) return { ok: false, message: 'Updater unavailable.' };
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
}

function buildMenu() {
  const template = [
    { label: 'PointPilot', submenu: [
      { label: 'About PointPilot', click: () => dialog.showMessageBox({ type: 'info', title: 'About PointPilot', message: 'PointPilot', detail: 'Rewards intelligence and portfolio-aware trip optimization. Award observations are stored locally on this computer.' }) },
      { type: 'separator' },
      { label: 'Check for Updates', click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' }
    ] },
    { label: 'Manual Capture', submenu: [
      { label: 'Capture Current Award Page', accelerator: 'Ctrl+Shift+S', enabled: true, click: () => captureCurrentPage() },
      { label: 'Close Capture Browser', accelerator: 'Ctrl+Shift+W', click: () => captureWindow?.close() }
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function captureCurrentPage() {
  if (!captureWindow || captureWindow.isDestroyed()) {
    dialog.showMessageBox({ type: 'warning', title: 'No capture browser', message: 'Open a provider from Manual Capture first.' });
    return;
  }
  const url = captureWindow.webContents.getURL();
  const title = captureWindow.getTitle();
  const text = await captureWindow.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
  if (challengeDetected(text)) {
    await dialog.showMessageBox({ type: 'warning', title: 'Capture stopped', message: 'A CAPTCHA, access-denied, or bot-check page was detected. PointPilot will not bypass it.' });
    return;
  }
  const html = await captureWindow.webContents.executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""').catch(() => '');
  if (!html) {
    await dialog.showMessageBox({ type: 'error', title: 'Capture failed', message: 'PointPilot could not read the current page.' });
    return;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${serverPort}/api/browser-capture-html`, {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ providerId: providerCaptureMeta?.providerId || 'manual', url, title, html })
    });
    const payload = await r.json();
    if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
    await dialog.showMessageBox({ type: 'info', title: 'Page captured', message: 'The current page was saved locally.', detail: `Provider: ${providerCaptureMeta?.providerId || 'manual'}\nURL: ${url}\n\nThe saved page can be used while you enter exact award values into PointPilot.` });
  } catch (e) {
    dialog.showMessageBox({ type: 'error', title: 'Capture failed', message: e.message });
  }
}

function openCaptureBrowser(providerId, url) {
  providerCaptureMeta = { providerId, url };
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.focus();
    captureWindow.loadURL(url);
    return;
  }
  captureWindow = new BrowserWindow({
    width: 1440, height: 950, minWidth: 1000, minHeight: 700,
    title: `PointPilot Manual Capture — ${providerId}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  captureWindow.loadURL(url);
  captureWindow.on('closed', () => { captureWindow = null; providerCaptureMeta = null; });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1460, height: 960, minWidth: 1100, minHeight: 720,
    title: 'PointPilot',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  await new Promise((resolve, reject) => {
    server = null;
    import('../server.mjs').then(({ startServer }) => {
      server = startServer({ port: 0, onReady: (p) => { serverPort = p; resolve(); } });
    }).catch(reject);
  });
  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}

ipcMain.handle('open-provider', async (_event, { providerId, url }) => {
  openCaptureBrowser(providerId, url);
  return { ok: true };
});
ipcMain.handle('capture-provider-page', async () => { await captureCurrentPage(); return { ok: true }; });
ipcMain.handle('app-info', () => ({ version: app.getVersion(), dataDir: path.join(app.getPath('userData'), 'data'), packaged: app.isPackaged }));
ipcMain.handle('check-for-updates', () => checkForUpdates(true));
ipcMain.handle('download-update', () => downloadUpdate());
ipcMain.handle('install-update', () => installUpdate());

app.whenReady().then(async () => {
  const dataDir = await ensureUserData();
  process.env.POINTPILOT_DATA_DIR = dataDir;
  process.env.PORT = '0';
  process.env.MONITOR_INTERVAL_MINUTES = process.env.MONITOR_INTERVAL_MINUTES || '30';
  configureAutoUpdater();
  await createMainWindow();
  buildMenu();
  // Don't make startup depend on the update server. The check happens shortly
  // after the UI is ready and any error is surfaced non-blockingly.
  if (app.isPackaged && autoUpdater) setTimeout(() => checkForUpdates(false), 5000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
}).catch(err => {
  console.error(err);
  dialog.showErrorBox('PointPilot failed to start', err.stack || err.message || String(err));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  try { server?.close(); } catch {}
});
