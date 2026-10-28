const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, Notification, shell, safeStorage } = require('electron');
const path = require('node:path');
if (process.env.POINTPILOT_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.POINTPILOT_USER_DATA_DIR));
const fsp = require('node:fs/promises');
const { createArtifactHandlers } = require('./artifacts.cjs');

let mainWindow = null;
let captureWindow = null;
let tray = null;
let server = null;
let serverPort = null;
let serverModule = null;
let isQuitting = false;
let captureProvider = null;
let lastUpdateStatus = null;
let chatgpt = null;
let Anthropic = null;
let claudeKeyPath = null;
let simpleFinAccessPath = null;

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

function assertTrustedIpc(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || !isAppUrl(event.senderFrame.url)) {
    throw new Error('This request is only available from PointPilot.');
  }
}

async function readClaudeKey() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = await fsp.readFile(claudeKeyPath);
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not unlock the saved Claude credential. Remove it and reconnect.');
  }
}

async function readSimpleFinAccessUrl() {
  if (!safeStorage.isEncryptionAvailable() || !simpleFinAccessPath) return null;
  try { return safeStorage.decryptString(await fsp.readFile(simpleFinAccessPath)); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not unlock the saved SimpleFIN connection. Disconnect it and connect again.');
  }
}

async function saveSimpleFinAccessUrl(accessUrl) {
  if (!safeStorage.isEncryptionAvailable() || !simpleFinAccessPath) throw new Error('OS-backed credential encryption is unavailable. Restart PointPilot and try again.');
  await fsp.mkdir(path.dirname(simpleFinAccessPath), { recursive: true });
  await fsp.writeFile(simpleFinAccessPath, safeStorage.encryptString(accessUrl), { mode: 0o600 });
}

async function removeSimpleFinAccessUrl() {
  if (simpleFinAccessPath) await fsp.rm(simpleFinAccessPath, { force: true });
}

function safeSession(session) {
  return {
    status: session?.status || 'disconnected',
    sharing: Boolean(session?.sharing),
    identity: session?.identity ? { name: session.identity.name, email: session.identity.email } : undefined,
    error: session?.error ? { code: session.error.code, message: session.error.message } : undefined
  };
}

async function llmStatus() {
  let openai = { status: 'unavailable', sharing: false, models: [] };
  if (chatgpt) {
    try {
      const session = await chatgpt.getSession();
      openai = { ...safeSession(session), models: session?.sharing ? await chatgpt.listModels() : [] };
    } catch { openai = { status: 'error', sharing: false, models: [] }; }
  }
  let claudeConnected = false;
  try { claudeConnected = Boolean(await readClaudeKey()); } catch { /* Display disconnected if OS credential decryption fails. */ }
  return { openai, anthropic: { connected: claudeConnected } };
}

function validateAssistantInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A question is required.');
  const provider = input.provider;
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!['openai', 'anthropic'].includes(provider)) throw new Error('Choose a supported provider.');
  if (!prompt || prompt.length > 4000) throw new Error('Enter a question up to 4,000 characters.');
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Choose a valid model.');
  return { provider, prompt, model, includeWallet: input.includeWallet === true };
}

async function assistantContext(includeWallet) {
  if (!includeWallet) return '';
  const { loadUser } = await import('../lib/settings.mjs');
  const user = await loadUser();
  const balances = (user.balances || []).filter(b => Number.isFinite(b.balance) && b.balance > 0).map(b => ({ program: b.program, balance: b.balance }));
  return balances.length ? `\n\nUser-selected PointPilot wallet balances (programs are separate currencies; do not add them together):\n${JSON.stringify(balances)}` : '\n\nThe PointPilot wallet currently has no saved balances.';
}

async function askAssistant(input) {
  const { provider, prompt, model, includeWallet } = validateAssistantInput(input);
  const context = await assistantContext(includeWallet);
  const userMessage = `${prompt}${context}`;
  const instructions = 'You are PointPilot’s read-only travel rewards assistant. Be clear when you lack data. Never claim live award availability, prices, or balances unless they are present in the supplied context. Do not initiate transfers, buy points, bookings, or alerts. Tell the user to verify current inventory in PointPilot before acting.';
  if (provider === 'openai') {
    if (!chatgpt) throw new Error('OpenAI sign-in is unavailable in this app build.');
    const session = await chatgpt.getSession();
    if (session.status !== 'connected' || !session.sharing) throw new Error('Sign in with ChatGPT and approve plan usage before asking a question.');
    const available = await chatgpt.listModels();
    if (!available.some(item => item.slug === model)) throw new Error('That model is not available for the signed-in account. Refresh the model list and try again.');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 45000);
    try {
      const result = await chatgpt.streamResponse({ model, input: userMessage, instructions, signal: timeout.signal });
      return { text: String(result.text || '').slice(0, 20000), provider, model };
    } finally { clearTimeout(timer); }
  }
  const apiKey = await readClaudeKey();
  if (!apiKey) throw new Error('Add an Anthropic Console API key to connect Claude.');
  if (!/^claude-[a-z0-9.-]{2,80}$/.test(model)) throw new Error('Choose a valid Claude model.');
  const client = new Anthropic({ apiKey, timeout: 45000, maxRetries: 0 });
  try {
    const result = await client.messages.create({ model, max_tokens: 1200, system: instructions, messages: [{ role: 'user', content: userMessage }] });
    const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 20000);
    return { text, provider, model };
  } catch (error) {
    const status = Number(error?.status);
    if (status === 401) throw new Error('Claude rejected this API key. Check the saved key and reconnect.');
    if (status === 429) throw new Error('Claude is rate limiting requests. Wait a moment and try again.');
    if (status === 403) throw new Error('This Claude API key does not have access to the selected model.');
    throw new Error('Claude could not complete this request. Check your connection and try again.');
  }
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
ipcMain.handle('open-provider', async (_e, { providerId, url } = {}) => {
  const { providerUrlAllowed } = await import('../lib/providers.mjs');
  if (!providerUrlAllowed(String(providerId || ''), String(url || ''))) return { ok: false, message: 'This URL is not an approved page for that provider.' };
  openCaptureBrowser(String(providerId), String(url));
  return { ok: true };
});
ipcMain.handle('app-info', () => ({ version: app.getVersion(), dataDir: dataDir(), packaged: app.isPackaged }));
ipcMain.handle('check-for-updates', () => checkForUpdates());
ipcMain.handle('install-update', () => { if (!autoUpdater) return { ok: false }; isQuitting = true; autoUpdater.quitAndInstall(false, true); return { ok: true }; });
ipcMain.handle('settings-changed', () => applySettings());
ipcMain.handle('llm-status', async event => { assertTrustedIpc(event); return llmStatus(); });
ipcMain.handle('llm-openai-sign-in', async event => {
  assertTrustedIpc(event);
  if (!chatgpt) throw new Error('OpenAI sign-in is unavailable in this app build.');
  return safeSession(await chatgpt.signIn());
});
ipcMain.handle('llm-openai-disconnect', async event => {
  assertTrustedIpc(event);
  if (chatgpt) await chatgpt.disconnect();
  return llmStatus();
});
ipcMain.handle('llm-save-claude-key', async (event, value) => {
  assertTrustedIpc(event);
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(apiKey)) throw new Error('Enter a valid-looking Anthropic Console API key.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. Restart PointPilot and try again.');
  await fsp.mkdir(path.dirname(claudeKeyPath), { recursive: true });
  await fsp.writeFile(claudeKeyPath, safeStorage.encryptString(apiKey), { mode: 0o600 });
  return { connected: true };
});
ipcMain.handle('llm-remove-claude-key', async event => {
  assertTrustedIpc(event);
  await fsp.rm(claudeKeyPath, { force: true });
  return { connected: false };
});
ipcMain.handle('llm-ask', async (event, input) => {
  assertTrustedIpc(event);
  return askAssistant(input);
});
// Backups and diagnostics bundles: fixed kinds, native dialogs, bounded JSON, trusted sender only (see artifacts.cjs).
const artifacts = createArtifactHandlers({ dialog, getMainWindow: () => mainWindow, getPort: () => serverPort, defaultDirectory: () => app.getPath('documents') });
ipcMain.handle('save-artifact', (event, request) => artifacts.save(event, request));
ipcMain.handle('open-backup', event => artifacts.openBackup(event));

// ---------- startup ----------
app.whenReady().then(async () => {
  await fsp.mkdir(dataDir(), { recursive: true });
  const aiDirectory = path.join(app.getPath('userData'), 'ai');
  const simpleFinDirectory = path.join(app.getPath('userData'), 'simplefin');
  await fsp.mkdir(aiDirectory, { recursive: true });
  await fsp.mkdir(simpleFinDirectory, { recursive: true });
  claudeKeyPath = path.join(aiDirectory, 'anthropic-api-key.bin');
  simpleFinAccessPath = path.join(simpleFinDirectory, 'access-url.bin');
  if (safeStorage.isEncryptionAvailable()) {
    try {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
      const { createChatGPT } = await import('@siwc/local');
      chatgpt = createChatGPT({
        appName: 'PointPilot',
        appId: 'pointpilot',
        redirectPort: 0,
        storageDir: path.join(aiDirectory, 'openai'),
        sendHostId: true,
        credentialEncryption: {
          id: 'electron-safeStorage-v1',
          isAvailable: () => app.isReady() && safeStorage.isEncryptionAvailable(),
          encrypt: plaintext => safeStorage.encryptString(plaintext),
          decrypt: ciphertext => safeStorage.decryptString(Buffer.from(ciphertext))
        },
        openBrowser: async url => {
          const target = new URL(url);
          if (target.origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in destination.');
          await shell.openExternal(target.href);
        }
      });
    } catch (error) {
      console.error('[llm] Provider setup failed:', error?.message || String(error));
    }
  }
  process.env.POINTPILOT_DATA_DIR = dataDir();
  process.env.POINTPILOT_VERSION = app.getVersion();
  serverModule = await import('../server.mjs');
  serverModule.setSimpleFinCredentialStore({
    isAvailable: () => app.isReady() && safeStorage.isEncryptionAvailable(),
    read: readSimpleFinAccessUrl,
    save: saveSimpleFinAccessUrl,
    remove: removeSimpleFinAccessUrl
  });
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
app.on('before-quit', () => { isQuitting = true; try { server?.close(); } catch { /* Continue quitting if the server is already closed. */ } });
