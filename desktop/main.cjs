const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, Notification, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

let mainWindow = null;
let captureWindow = null;
let tray = null;
let server = null;
let serverPort = null;
let serverModule = null;
let isQuitting = false;
let captureProvider = null;
let lastUpdateStatus = null;

const startHidden = process.argv.includes('--hidden');
const UPDATE_INTERVAL_MS = 4 * 3600 * 1000;
const ICON = path.join(__dirname, 'icon.ico');

// One PointPilot at a time: a second launch focuses the existing window instead of starting a
// second server and monitor that would write the same data files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}
app.setAppUserModelId('com.pointpilot.desktop'); // required for Windows toast notifications

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); }
catch (err) { console.warn('[updates] electron-updater unavailable:', err.message); }

const dataDir = () => path.join(app.getPath('userData'), 'data');

async function settings() {
  try { return await serverModule.getSettings(); } catch { return { closeToTray: true, launchAtLogin: false }; }
}

// ---------- updates ----------
function sendUpdateStatus(status, extra = {}) {
  lastUpdateStatus = { status, ...extra };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', lastUpdateStatus);
}

function configureAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;           // download in the background as soon as found
  autoUpdater.autoInstallOnAppQuit = true;   // install the next time PointPilot quits
  // No code-signing certificate yet. Re-enable signature verification once builds are signed.
  autoUpdater.verifyUpdateCodeSignature = false;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', info => sendUpdateStatus('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('current', { version: app.getVersion() }));
  autoUpdater.on('download-progress', p => sendUpdateStatus('downloading', { percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', info => {
    sendUpdateStatus('downloaded', { version: info.version });
    notify('PointPilot update ready', `Version ${info.version} installs when you restart PointPilot.`);
  });
  autoUpdater.on('error', err => sendUpdateStatus('error', { message: err?.message || String(err) }));
}

async function checkForUpdates() {
  if (!autoUpdater || !app.isPackaged) return { ok: false, message: 'Updates run in the installed app.' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (err) { sendUpdateStatus('error', { message: err?.message || String(err) }); return { ok: false, message: err?.message || String(err) }; }
}

// ---------- notifications & tray ----------
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => showMainWindow('alerts'));
  n.show();
}

function buildTray() {
  tray = new Tray(ICON);
  tray.setToolTip('PointPilot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PointPilot', click: () => showMainWindow() },
    { label: 'Check alerts now', click: () => serverModule.runMonitor().catch(e => console.error(e)) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showMainWindow());
}

// Settings that affect the shell are cached so window events can act on them synchronously.
let closeToTray = true;
let trayHintShown = false;
async function applySettings() {
  const s = await settings();
  closeToTray = s.closeToTray !== false;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(s.launchAtLogin), args: ['--hidden'] });
}

// ---------- windows ----------
function isAppUrl(url) {
  try { const u = new URL(url); return u.hostname === '127.0.0.1' && Number(u.port) === serverPort; } catch { return false; }
}

function openExternal(url) {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1460, height: 960, minWidth: 1000, minHeight: 700,
    title: 'PointPilot', backgroundColor: '#f6f7fb', icon: ICON, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // Links leave the app in the user's browser; the app window can't be navigated elsewhere.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); openExternal(url); } });
  mainWindow.on('close', e => {
    if (isQuitting) return;
    if (!closeToTray) { isQuitting = true; app.quit(); return; }
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) { trayHintShown = true; notify('PointPilot is still running', 'Alerts keep checking in the background. Right-click the tray icon to quit.'); }
  });
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });
  mainWindow.webContents.on('did-finish-load', () => { if (lastUpdateStatus) mainWindow.webContents.send('update-status', lastUpdateStatus); });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
}

function showMainWindow(view) {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (view) mainWindow.webContents.send('navigate', view);
}

function openCaptureBrowser(providerId, url) {
  if (!/^https:\/\//i.test(String(url))) return;
  captureProvider = providerId;
  if (captureWindow && !captureWindow.isDestroyed()) { captureWindow.loadURL(url); captureWindow.focus(); return; }
  captureWindow = new BrowserWindow({
    width: 1400, height: 940, title: `PointPilot — ${providerId}`, icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:capture' }
  });
  // Booking sites love popups; keep them in the capture window rather than spawning new ones.
  captureWindow.webContents.setWindowOpenHandler(({ url: popup }) => { if (/^https:\/\//i.test(popup)) captureWindow.loadURL(popup); return { action: 'deny' }; });
  captureWindow.loadURL(url);
  captureWindow.on('closed', () => { captureWindow = null; captureProvider = null; });
}

async function captureCurrentPage() {
  if (!captureWindow || captureWindow.isDestroyed()) {
    return dialog.showMessageBox({ type: 'warning', title: 'No capture window', message: 'Open a program from Manual Entry first.' });
  }
  const wc = captureWindow.webContents;
  const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
  if (/(captcha|verify you are human|unusual traffic|access denied)/i.test(text)) {
    return dialog.showMessageBox({ type: 'warning', title: 'Capture stopped', message: 'A bot-check page is showing. Complete it yourself first; PointPilot never bypasses these.' });
  }
  const html = await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
  try {
    const r = await fetch(`http://127.0.0.1:${serverPort}/api/browser-capture-html`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: captureProvider || 'manual', url: wc.getURL(), html })
    });
    const payload = await r.json();
    if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
    dialog.showMessageBox({ type: 'info', title: 'Page saved', message: 'Saved a copy of this page.', detail: `${payload.file}\n\nRecord the award price under Manual Entry so it's used in searches.` });
  } catch (e) {
    dialog.showMessageBox({ type: 'error', title: 'Capture failed', message: e.message });
  }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PointPilot', submenu: [
      { label: 'Check for Updates', click: () => checkForUpdates() },
      { label: 'Open Data Folder', click: () => shell.openPath(dataDir()) },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { isQuitting = true; app.quit(); } }
    ] },
    { label: 'Capture', submenu: [
      { label: 'Save Current Award Page', accelerator: 'Ctrl+Shift+S', click: () => captureCurrentPage() },
      { label: 'Close Capture Window', accelerator: 'Ctrl+Shift+W', click: () => captureWindow?.close() }
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]));
}

// ---------- IPC ----------
ipcMain.handle('open-provider', (_e, { providerId, url }) => { openCaptureBrowser(String(providerId), String(url)); return { ok: true }; });
ipcMain.handle('app-info', () => ({ version: app.getVersion(), dataDir: dataDir(), packaged: app.isPackaged }));
ipcMain.handle('check-for-updates', () => checkForUpdates());
ipcMain.handle('install-update', () => { if (!autoUpdater) return { ok: false }; isQuitting = true; autoUpdater.quitAndInstall(false, true); return { ok: true }; });
ipcMain.handle('settings-changed', () => applySettings());

// ---------- startup ----------
app.whenReady().then(async () => {
  await fsp.mkdir(dataDir(), { recursive: true });
  process.env.POINTPILOT_DATA_DIR = dataDir();
  process.env.POINTPILOT_VERSION = app.getVersion();
  serverModule = await import('../server.mjs');
  serverModule.setNotifier(({ title, body }) => notify(title, body));
  await new Promise(resolve => { server = serverModule.startServer({ port: 0, onReady: p => { serverPort = p; resolve(); } }); });
  buildMenu();
  buildTray();
  createMainWindow();
  await applySettings();
  configureAutoUpdater();
  if (app.isPackaged && autoUpdater) {
    setTimeout(() => checkForUpdates(), 10000);
    setInterval(() => checkForUpdates(), UPDATE_INTERVAL_MS);
  }
}).catch(err => {
  console.error(err);
  dialog.showErrorBox('PointPilot failed to start', err.stack || err.message || String(err));
  app.exit(1);
});

app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', () => { isQuitting = true; try { server?.close(); } catch {} });
