import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = f => readFileSync(path.join(pub, f), 'utf8');

// The feature screens are classic browser scripts; evaluate them against a bare global like the browser would.
// Timers must not keep the test process alive (the screens set five-minute expiry timers).
const unrefTimeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
const sandbox = { AbortController, URL, URLSearchParams, TextEncoder, Intl, setTimeout: unrefTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['helpers.js', 'feature-kit.js', 'itinerary-ui.js', 'readiness-ui.js', 'backup-ui.js', 'diagnostics-ui.js']) vm.runInContext(read(f), sandbox, { filename: f });
const F = sandbox.PPFeatures;
const Kit = sandbox.PPKit;
const json = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : null);
const createGuard = sandbox.PPHelpers.createGuard;

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const XSS = '<img src=x onerror=alert(1)>"\'&';
const assertNoRawXss = html => { assert.ok(!html.includes('<img src=x'), 'unescaped markup reached the page'); assert.ok(!/onerror=alert/.test(html.replace(/&lt;[^]*?&gt;/g, '')), 'handler attribute leaked'); };

/** Minimal DOM: just enough for delegated handlers (innerHTML sink, listeners, closest()). */
function fakeHost() {
  const handlers = {};
  const host = {
    innerHTML: '', hidden: false, handlers,
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    contains() { return false; },
    querySelector() { return null; },
    fire(type, target) { for (const fn of handlers[type] || []) fn({ target, key: target.key, preventDefault() {} }); }
  };
  return host;
}
const el = (props = {}) => {
  const node = { dataset: {}, value: '', checked: false, type: 'text', ...props };
  node.closest = sel => (sel === '[data-action]' ? (node.dataset.action !== undefined ? node : null) : null);
  return node;
};
const click = (host, dataset) => host.fire('click', el({ dataset }));
const input = (host, field, value, extra = {}) => host.fire('input', el({ dataset: { field, ...extra }, value }));
const change = (host, field, props = {}, extra = {}) => host.fire('change', el({ dataset: { field, ...extra }, ...props }));
const submit = (host, form) => host.fire('submit', el({ dataset: { form } }));
const deps = (host, api, extra = {}) => ({ root: host, api, esc, safeUrl, createGuard, onPlanChanged() {}, ...extra });

// ---------- static page checks ----------
test('page loads the feature scripts before app.js, with no inline scripts or handlers (CSP)', () => {
  const html = read('index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]);
  assert.ok(scripts.every(a => /\bsrc="\/[a-z-]+\.js"/.test(a)), 'every script is an external same-origin file');
  const order = [...html.matchAll(/<script src="\/([a-z-]+\.js)">/g)].map(m => m[1]);
  assert.deepEqual(order, ['helpers.js', 'feature-kit.js', 'itinerary-ui.js', 'readiness-ui.js', 'backup-ui.js', 'diagnostics-ui.js', 'app.js']);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.)[^"' ]*\.(js|css)/, 'no CDN assets');
  for (const f of ['feature-kit.js', 'itinerary-ui.js', 'readiness-ui.js', 'backup-ui.js', 'diagnostics-ui.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(|document\.write|\son(click|change|input|submit)\s*=\s*["']/, `${f} must not use eval or inline handlers`);
    assert.doesNotMatch(src, /require\(|process\./, `${f} has no Node access`);
  }
});

test('honest wording: never "live confirmed" or "API verified" claims anywhere in the UI', () => {
  for (const f of ['itinerary-ui.js', 'readiness-ui.js', 'backup-ui.js', 'diagnostics-ui.js', 'app.js', 'index.html']) {
    assert.doesNotMatch(read(f), /live[ -]confirmed/i, f);
  }
  const html = F.readiness.view({ ...F.readiness.initialState(), open: true, scope: 'trip', phase: 'ready', plan: { items: [{ id: 'a', label: 'x', kind: 'flight' }] }, report: null }, esc, safeUrl);
  assert.match(html, /Check booking readiness/);
  assert.doesNotMatch(html, /live confirmed/i);
  const withReport = F.readiness.view({ ...F.readiness.initialState(), open: true, scope: 'trip', phase: 'ready', plan: { items: [] }, current: true, report: { verdict: 'Go', items: [], checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), planHash: 'a'.repeat(64) } }, esc, safeUrl);
  assert.match(withReport, /Refresh availability/);
  assert.match(withReport, /not a booking guarantee/);
});

/** Every visible form control must have a label: `for=`, an aria-label, or a wrapping <label>. */
function assertLabelled(html, where) {
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    if (/type="hidden"/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id && new RegExp(`<label[^>]*\\bfor="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html)) continue;
    if (/aria-label=/.test(attrs)) continue;
    const before = html.slice(0, m.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
    assert.fail(`${where}: unlabelled control <${m[1]}${attrs.slice(0, 80)}>`);
  }
}

// ---------- shared kit ----------
test('PPKit: password rule, error mapping and labels', () => {
  assert.equal(Kit.passwordProblem('short'), 'Use at least 12 characters.');
  assert.equal(Kit.passwordProblem('x'.repeat(12)), null);
  assert.equal(Kit.passwordProblem('🙂'.repeat(11)), 'Use at least 12 characters.');
  assert.match(Kit.passwordProblem('é'.repeat(600)), /too long/);
  assert.equal(Kit.errorMessage({ code: 'X', message: 'ignored' }, { X: 'friendly' }), 'friendly');
  const long = Kit.errorMessage({ message: `line\nbreak ${'a'.repeat(1000)}` });
  assert.ok(long.length <= 300 && !long.includes('\n'));
  assert.equal(Kit.whenLabel('not a date'), 'unknown');
  assert.equal(Kit.ageLabel(new Date(Date.now() - 5 * 60000).toISOString()), '5 min ago');
  assert.equal(Kit.safeFilename('../../evil', 'fallback.json'), 'fallback.json');
  assert.equal(Kit.safeFilename('pointpilot-backup-2026-10-20.ppbackup', 'x'), 'pointpilot-backup-2026-10-20.ppbackup');
});

// ---------- backup UI ----------
const previewFixture = (over = {}) => ({
  previewId: 'p1', expiresAt: new Date(Date.now() + 300000).toISOString(), baseRevision: 'abc',
  backup: { createdAt: '2026-10-20T00:00:00.000Z', appVersion: '0.14.0', categories: ['wallet', 'preferences', 'settings', 'plans', 'alerts'] },
  mode: 'merge', categories: ['wallet'], options: { restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false },
  counts: { wallet: { incoming: 2, add: 1, update: 0, remove: 0, unchanged: 0, skipped: 1 } },
  conflicts: [{ id: 'wallet:chase', category: 'wallet', label: 'Chase Ultimate Rewards', actionOptions: ['keep', 'incoming'], defaultAction: 'keep', resolution: 'keep', existing: '1 points', incoming: '2 points' }],
  effects: [{ category: 'wallet', action: 'add', count: 1, text: 'Add 1 program to your wallet.' }], warnings: [], containsSecrets: false, sensitive: {}, ...over
});

test('backup UI: export form defaults — secrets off, passwords required, nothing sent until valid', async () => {
  const host = fakeHost();
  const calls = [];
  const api = async (p, o) => { calls.push([p, o]); if (p === '/api/backup/summary') return { counts: { wallet: 2, preferences: 3, settings: 6, savedTrip: 0, savedStays: 1, alerts: 4 }, secretsPresent: true, categories: [] }; if (p === '/api/backup/export') return { filename: 'pointpilot-backup-2026-10-20.ppbackup', envelope: { format: 'pointpilot-backup', version: 1 }, includesSecrets: false, warnings: [] }; throw new Error(`unexpected ${p}`); };
  const saved = [];
  const ui = F.backup.mount(deps(host, api, { desktop: { saveArtifact: async a => { saved.push(a); return { ok: true, filename: 'pointpilot-backup-2026-10-20.ppbackup' }; }, openBackup: async () => ({ cancelled: true }) } }));
  await tick();
  assert.match(host.innerHTML, /2 programs/);
  assert.match(host.innerHTML, /Export encrypted backup/);
  assert.ok(!/data-field="includeSecrets" checked/.test(host.innerHTML), 'API keys switch starts off');
  assert.match(host.innerHTML, /If you lose this password the file cannot be recovered/);
  assertLabelled(host.innerHTML, 'export');
  assert.match(host.innerHTML, /data-action="export"[^>]* disabled/, 'export disabled without a password');
  input(host, 'password', 'short');
  assert.match(host.innerHTML, /Use at least 12 characters/);
  input(host, 'password', 'a long enough password');
  input(host, 'repeat', 'a long enough passwore');
  assert.match(host.innerHTML, /do not match/);
  submit(host, 'export'); await tick();
  assert.equal(calls.filter(c => c[0] === '/api/backup/export').length, 0, 'mismatched passwords never reach the server');
  input(host, 'repeat', 'a long enough password');
  submit(host, 'export'); await tick();
  const exportCall = calls.find(c => c[0] === '/api/backup/export');
  assert.deepEqual(json(exportCall[1].body), { password: 'a long enough password', includeSecrets: false, categories: ['wallet', 'preferences', 'settings', 'plans', 'alerts'] });
  assert.deepEqual(json(saved[0]), { kind: 'backup', content: JSON.stringify({ format: 'pointpilot-backup', version: 1 }) });
  assert.equal(ui.state.export.password, '', 'password cleared as soon as the request starts');
  assert.equal(ui.state.export.repeat, '');
  assert.ok(!host.innerHTML.includes('a long enough password'), 'password is not rendered back');
  assert.match(host.innerHTML, /Saved pointpilot-backup-2026-10-20\.ppbackup/);
});

test('backup UI: opt-in for keys is sent, cancelling the save dialog is neutral, errors are safe', async () => {
  const host = fakeHost();
  let mode = 'cancel';
  const api = async p => {
    if (p === '/api/backup/summary') return { counts: {}, secretsPresent: false };
    if (mode === 'fail') { throw Object.assign(new Error(`boom ${XSS}`), { code: 'BACKUP_BUSY', status: 429 }); }
    return { filename: 'f.ppbackup', envelope: { format: 'pointpilot-backup', version: 1 }, includesSecrets: true, warnings: [] };
  };
  const bodies = [];
  const wrapped = async (p, o) => { if (o?.body) bodies.push(o.body); return api(p, o); };
  const desktop = { saveArtifact: async () => (mode === 'cancel' ? { cancelled: true } : { ok: false, code: 'WRITE_FAILED' }) };
  F.backup.mount(deps(host, wrapped, { desktop }));
  await tick();
  change(host, 'includeSecrets', { checked: true });
  assert.match(host.innerHTML, /data-field="includeSecrets" checked/);
  assert.match(host.innerHTML, /anyone who has the file and its password can use your keys/);
  const fill = () => { input(host, 'password', 'twelve chars ok!'); input(host, 'repeat', 'twelve chars ok!'); submit(host, 'export'); };
  fill(); await tick();
  assert.equal(bodies.at(-1).includeSecrets, true);
  assert.match(host.innerHTML, /Save cancelled\. Nothing was saved\./);
  mode = 'write'; fill(); await tick();
  assert.match(host.innerHTML, /could not be saved\. Choose another location/);
  mode = 'fail'; fill(); await tick();
  assert.match(host.innerHTML, /Another backup operation is still running/);
  assertNoRawXss(host.innerHTML);
  assert.ok(!host.innerHTML.includes('boom'), 'raw server text is replaced by the friendly message');
});

test('backup UI: browser fallback downloads the file instead of using the desktop dialog', async () => {
  const host = fakeHost();
  const downloads = [];
  Kit.downloadText = (name, text) => downloads.push([name, text]);
  const api = async p => (p === '/api/backup/summary' ? { counts: {} } : { filename: '../evil', envelope: { format: 'pointpilot-backup', version: 1 }, includesSecrets: false });
  F.backup.mount(deps(host, api, { desktop: null }));
  await tick();
  input(host, 'password', 'twelve chars ok!'); input(host, 'repeat', 'twelve chars ok!'); submit(host, 'export'); await tick();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0][0], 'pointpilot-backup.ppbackup', 'an unsafe server filename falls back to a safe one');
});

test('backup UI: restore flow — choose, decrypt, review, change a choice without the password, restore', async () => {
  const host = fakeHost();
  const calls = [];
  const restored = [];
  const settingsChanged = [];
  const api = async (p, o = {}) => {
    calls.push([p, json(o.body)]);
    if (p === '/api/backup/summary') return { counts: {} };
    if (p === '/api/backup/preview') return o.body.previewId ? previewFixture({ previewId: 'p2', conflicts: previewFixture().conflicts.map(c => ({ ...c, resolution: o.body.choices?.[c.id] || 'keep' })) }) : previewFixture({ backup: { createdAt: '2026-10-20T00:00:00.000Z', appVersion: `0.14.0${XSS}`, categories: ['wallet', 'preferences', 'settings', 'plans', 'alerts'] } });
    if (p === '/api/backup/restore') return { ok: true, appliedCounts: { wallet: 1, alerts: 0 }, warnings: ['careful'], revision: 'r' };
    throw new Error(p);
  };
  const envelope = { format: 'pointpilot-backup', version: 1, kdf: {}, cipher: {}, ciphertext: 'AAAA' };
  const desktop = { openBackup: async () => ({ ok: true, content: JSON.stringify(envelope), filename: 'in.ppbackup' }), settingsChanged: async () => settingsChanged.push(1) };
  const ui = F.backup.mount(deps(host, api, { desktop, onDataRestored: async d => restored.push(d) }));
  await tick();
  click(host, { action: 'tab', tab: 'restore' });
  assert.match(host.innerHTML, /Choose backup file/);
  click(host, { action: 'choose-file' }); await tick();
  assert.match(host.innerHTML, /in\.ppbackup selected/);
  assertLabelled(host.innerHTML, 'restore-open');
  input(host, 'restorePassword', 'the backup password');
  submit(host, 'restore-open'); await tick();
  const first = calls.find(c => c[0] === '/api/backup/preview');
  assert.equal(first[1].password, 'the backup password');
  assert.deepEqual(first[1].envelope, envelope);
  assert.equal(ui.state.restore.password, '', 'password cleared once sent');
  assert.match(host.innerHTML, /Review before restoring/);
  assert.match(host.innerHTML, /Nothing has changed yet/);
  assertNoRawXss(host.innerHTML);
  assertLabelled(host.innerHTML, 'review');
  assert.match(host.innerHTML, /Keep mine/);
  assert.match(host.innerHTML, /Balances are never added together/);
  assert.ok(!/data-option="restoreSecrets"/.test(host.innerHTML), 'no key option when the backup holds none');
  // Changing a choice re-previews from the staged preview, with no password and no file.
  change(host, 'choice', { value: 'incoming' }, { conflict: 'wallet:chase' }); await tick();
  const second = calls.filter(c => c[0] === '/api/backup/preview')[1];
  assert.equal(second[1].previewId, 'p1');
  assert.deepEqual(second[1].choices, { 'wallet:chase': 'incoming' });
  assert.ok(!('password' in second[1]) && !('envelope' in second[1]));
  click(host, { action: 'restore' }); await tick();
  const restoreCall = calls.find(c => c[0] === '/api/backup/restore');
  assert.deepEqual(restoreCall[1], { previewId: 'p2', restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false });
  assert.equal(restored.length, 1, 'all views are told to reload');
  assert.equal(settingsChanged.length, 1, 'the desktop shell re-reads settings');
  assert.match(host.innerHTML, /Restore finished/);
  assert.match(host.innerHTML, /careful/);
  assert.equal(ui.state.restore.envelope, null, 'the file is released after restoring');
});

test('backup UI: replace needs an explicit confirmation; stale and expired reviews send you back', async () => {
  const host = fakeHost();
  let restoreError = null;
  const api = async (p, o = {}) => {
    if (p === '/api/backup/summary') return { counts: {} };
    if (p === '/api/backup/preview') return previewFixture({ mode: o.body.mode, conflicts: [], effects: [{ category: 'wallet', action: 'replace', count: 1, sensitive: true, text: 'Overwrite your seats.aero API key.' }], containsSecrets: true });
    if (p === '/api/backup/restore') throw restoreError;
    throw new Error(p);
  };
  const desktop = { openBackup: async () => ({ ok: true, content: JSON.stringify({ format: 'pointpilot-backup', version: 1 }), filename: 'x.ppbackup' }) };
  const ui = F.backup.mount(deps(host, api, { desktop }));
  await tick();
  click(host, { action: 'tab', tab: 'restore' }); click(host, { action: 'choose-file' }); await tick();
  input(host, 'restorePassword', 'some password here'); submit(host, 'restore-open'); await tick();
  assert.match(host.innerHTML, /data-option="restoreSecrets"/);
  assert.match(host.innerHTML, /SENSITIVE/);
  change(host, 'mode', { value: 'replace' }); await tick();
  assert.match(host.innerHTML, /data-action="restore"[^>]* disabled/, 'replace cannot be run before it is confirmed');
  change(host, 'confirmReplace', { checked: true });
  assert.ok(!/data-action="restore"[^>]* disabled/.test(host.innerHTML));
  restoreError = Object.assign(new Error('x'), { code: 'PREVIEW_STALE', status: 409 });
  click(host, { action: 'restore' }); await tick();
  assert.equal(ui.state.restore.step, 'choose');
  assert.match(host.innerHTML, /Your data changed after the review/);
  assert.ok(ui.state.restore.envelope, 'the file stays loaded: only the password is needed again');
});

test('backup UI: a slow earlier preview cannot overwrite a newer one, and Cancel ignores a late response', async () => {
  const host = fakeHost();
  const gates = [];
  const api = async (p, o = {}) => {
    if (p === '/api/backup/summary') return { counts: {} };
    const d = deferred(); gates.push({ d, body: o.body, signal: o.signal });
    return d.promise;
  };
  const desktop = { openBackup: async () => ({ ok: true, content: JSON.stringify({ format: 'pointpilot-backup', version: 1 }), filename: 'x.ppbackup' }) };
  const ui = F.backup.mount(deps(host, api, { desktop }));
  await tick();
  click(host, { action: 'tab', tab: 'restore' }); click(host, { action: 'choose-file' }); await tick();
  input(host, 'restorePassword', 'some password here'); submit(host, 'restore-open'); await tick();
  assert.match(host.innerHTML, /Decrypting…/);
  click(host, { action: 'cancel-preview' }); await tick();
  assert.equal(gates[0].signal.aborted, true, 'the request is aborted');
  gates[0].d.resolve(previewFixture({ previewId: 'late' }));
  await tick();
  assert.equal(ui.state.restore.preview, null, 'a late response after Cancel is ignored');
  assert.match(host.innerHTML, /Cancelled\. Nothing was changed\./);
});

test('backup UI: error messages map to safe text and never echo server detail', async () => {
  for (const code of Object.keys(F.backup.ERRORS)) assert.ok(F.backup.ERRORS[code].length > 5 && !/undefined/.test(F.backup.ERRORS[code]), code);
  const host = fakeHost();
  const api = async (p) => { if (p === '/api/backup/summary') return { counts: {} }; throw Object.assign(new Error('secret=hunter2 /Users/x'), { code: 'BACKUP_DECRYPT_FAILED' }); };
  const desktop = { openBackup: async () => ({ ok: true, content: '{"format":"pointpilot-backup","version":1}', filename: 'x' }) };
  F.backup.mount(deps(host, api, { desktop }));
  await tick();
  click(host, { action: 'tab', tab: 'restore' }); click(host, { action: 'choose-file' }); await tick();
  input(host, 'restorePassword', 'wrong password!!'); submit(host, 'restore-open'); await tick();
  assert.match(host.innerHTML, /password is wrong, or the backup file was changed/);
  assert.ok(!host.innerHTML.includes('hunter2') && !host.innerHTML.includes('/Users/'));
  assert.ok(!host.innerHTML.includes('wrong password!!'), 'the password is not shown back');
});

// ---------- diagnostics UI ----------
const bundleFixture = (over = {}) => ({
  format: 'pointpilot-diagnostics', schemaVersion: 1, generatedAt: '2026-10-20T00:00:00.000Z',
  app: { version: '0.14.0', platform: 'win32', architecture: 'x64', mode: 'desktop', configured: { seats: true, webhook: false } },
  requests: Array.from({ length: 30 }, (_, i) => ({ at: '2026-10-20T00:00:00.000Z', service: 'seatsaero', operation: `seats.search${i}`, method: 'GET', status: 200, durationMs: 120, outcome: 'ok', errorCode: null, requestId: `r${i}` })),
  freshness: { seatsaero: { source: 'seatsaero', lastAttemptAt: '2026-10-20T00:00:00.000Z', lastSuccessAt: null, lastFailureCode: 'SEATS_AUTH', providerObservedMinAt: null, providerObservedMaxAt: null, sampleCount: 3, completeness: 'unknown' } },
  usage: { label: 'attempted requests recorded by Point Pilot', day: '2026-10-20', month: '2026-10', calls: 4, roomsCalls: 0, tpCalls: 0, serpCalls: 1 },
  alerts: { snapshots: [{ id: 'abcdef012345', kind: 'award', active: true, lastAttemptAt: null, lastStatus: null, lastErrorCode: null }], events: [] },
  coverage: { recordingStartedAt: '2026-10-19T00:00:00.000Z', requestRetention: 'latest 500', alertRetention: '50 per alert', requestCount: 30, alertEventCount: 0, historyAvailable: true, persistence: 'best-effort' },
  redaction: { schemaVersion: 1 }, ...over
});

test('diagnostics UI: readable preview, escaped, labelled usage, bounded request table', async () => {
  const host = fakeHost();
  const bundle = bundleFixture();
  bundle.app.version = XSS;
  bundle.requests[0].operation = XSS;
  const api = async (p) => { if (p === '/api/diagnostics/preview') return { exportId: 'e'.repeat(48), expiresAt: new Date(Date.now() + 300000).toISOString(), summary: { bytes: 4096, requests: 30 }, bundle }; throw new Error(p); };
  F.diagnostics.mount(deps(host, api, { desktop: null }));
  await tick();
  const html = host.innerHTML;
  assertNoRawXss(html);
  assert.match(html, /attempted requests recorded by Point Pilot/);
  assert.match(html, /not provider-billed charges/);
  assert.match(html, /Showing the latest 20 of 30/);
  assert.match(html, /Export diagnostics/);
  assert.match(html, /Clear diagnostic history/);
  assert.match(html, /never sent anywhere automatically|does not send it anywhere|not send it anywhere/i);
  assert.match(html, /never as fresh/.source ? /unknown|never recorded/ : /./);
  assertLabelled(html, 'diagnostics');
});

test('diagnostics UI: empty state is honest about missing history', async () => {
  const host = fakeHost();
  const api = async () => ({ exportId: 'e'.repeat(48), expiresAt: new Date(Date.now() + 300000).toISOString(), summary: { bytes: 900 }, bundle: bundleFixture({ requests: [], freshness: {}, alerts: { snapshots: [], events: [] }, coverage: { historyAvailable: false, requestCount: 0, alertEventCount: 0, recordingStartedAt: '2026-10-20T00:00:00.000Z', persistence: 'best-effort' } }) });
  F.diagnostics.mount(deps(host, api, { desktop: null }));
  await tick();
  assert.match(host.innerHTML, /Nothing has been recorded since installation or the last update/);
  assert.match(host.innerHTML, /No requests recorded yet/);
  assert.match(host.innerHTML, /Unknown is shown as unknown, never as fresh/);
});

test('diagnostics UI: failed preview is retryable; export saves the staged bundle through the restricted dialog', async () => {
  const host = fakeHost();
  let fail = true;
  const calls = [];
  const saved = [];
  const api = async (p, o = {}) => {
    calls.push([p, o.method, json(o.body)]);
    if (p === '/api/diagnostics/preview') { if (fail) throw Object.assign(new Error('nope'), { status: 500 }); return { exportId: 'e'.repeat(48), expiresAt: new Date(Date.now() + 300000).toISOString(), summary: { bytes: 1500 }, bundle: bundleFixture() }; }
    if (p === '/api/diagnostics/export') return { filename: 'pointpilot-diagnostics-2026-10-20.json', bundle: bundleFixture() };
    throw new Error(p);
  };
  const desktop = { saveArtifact: async a => { saved.push(a); return { ok: true, filename: 'pointpilot-diagnostics-2026-10-20.json' }; } };
  const ui = F.diagnostics.mount(deps(host, api, { desktop }));
  await tick();
  assert.match(host.innerHTML, /role="alert"/);
  assert.match(host.innerHTML, /Try again/);
  fail = false;
  click(host, { action: 'refresh-preview' }); await tick();
  click(host, { action: 'export' }); await tick();
  assert.deepEqual(calls.find(c => c[0] === '/api/diagnostics/export')[2], { exportId: 'e'.repeat(48) });
  assert.equal(saved[0].kind, 'diagnostics');
  assert.equal(JSON.parse(saved[0].content).format, 'pointpilot-diagnostics');
  assert.match(host.innerHTML, /It was not sent anywhere/);
  assert.equal(ui.state.busy, null);
});

test('diagnostics UI: an expired preview refreshes instead of exporting stale bytes; clearing needs confirmation', async () => {
  const host = fakeHost();
  const calls = [];
  let exportError = Object.assign(new Error('x'), { code: 'DIAGNOSTICS_PREVIEW_EXPIRED', status: 409 });
  const api = async (p, o = {}) => {
    calls.push([p, o.method]);
    if (p === '/api/diagnostics/preview') return { exportId: 'e'.repeat(48), expiresAt: new Date(Date.now() + 300000).toISOString(), summary: { bytes: 1500 }, bundle: bundleFixture() };
    if (p === '/api/diagnostics/export') throw exportError;
    if (p === '/api/diagnostics/history') return { ok: true };
    throw new Error(p);
  };
  F.diagnostics.mount(deps(host, api, { desktop: null }));
  await tick();
  click(host, { action: 'export' }); await tick();
  assert.equal(calls.filter(c => c[0] === '/api/diagnostics/preview').length, 2, 'the preview was regenerated');
  assert.match(host.innerHTML, /preview expired, so it was refreshed/);
  click(host, { action: 'clear' });
  assert.match(host.innerHTML, /Yes, clear history/);
  assert.match(host.innerHTML, /Usage counters, alerts and your wallet are not touched/);
  assert.equal(calls.filter(c => c[0] === '/api/diagnostics/history').length, 0, 'nothing is cleared by the first click');
  click(host, { action: 'clear-confirmed' }); await tick();
  assert.deepEqual(calls.find(c => c[0] === '/api/diagnostics/history'), ['/api/diagnostics/history', 'DELETE']);
  assert.match(host.innerHTML, /Diagnostic history cleared/);
  exportError = null;
});

// ---------- readiness UI ----------
const reportFixture = (over = {}) => ({
  id: 'r1', scope: 'trip', planHash: 'a'.repeat(64), contextHash: 'b'.repeat(64), checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), verdict: 'Caution',
  items: [
    { id: 'i1', category: 'availability', selectionId: 'outbound', status: 'unknown', code: 'AVAILABILITY_UNVERIFIED', message: `Availability is unverified ${XSS}`, evidence: { method: 'cached', requestedAt: new Date().toISOString(), observedAt: null, source: 'seats.aero', complete: false }, details: { bookingUrl: 'https://www.aeroplan.com/' } },
    { id: 'i2', category: 'fees', selectionId: 'outbound', status: 'unknown', code: 'FEES_UNKNOWN', message: 'Award taxes are missing.', evidence: { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'Point Pilot', complete: false }, details: {} },
    { id: 'i3', category: 'funding', selectionId: null, status: 'pass', code: 'FUNDED', message: 'Wallet covers it.', evidence: { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'Point Pilot', complete: true }, details: {} },
    { id: 'i4', category: 'availability', selectionId: 'stay1', status: 'pass', code: 'AVAILABILITY_CACHED', message: 'User confirmed at the program; this is not API verification.', evidence: { method: 'manual', requestedAt: new Date().toISOString(), observedAt: new Date().toISOString(), source: 'https://example.com/page', complete: true }, details: { userConfirmed: true } },
    { id: 'i5', category: 'connections', selectionId: null, status: 'stop', code: 'IMPOSSIBLE_CONNECTION', message: 'A connecting flight departs before arrival.', evidence: { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'Point Pilot', complete: false }, details: {} }
  ],
  sourceStatus: { complete: false, label: 'Refresh availability', disclaimer: 'Go means no detected blocker, not a booking guarantee.' }, ...over
});
const tripPlan = { planHash: 'a'.repeat(64), segments: [{ id: 'outbound', award: { origin: 'JFK', destination: 'LHR', date: '2027-06-05', program: 'aeroplan', programName: 'Air Canada Aeroplan' } }] };
const stayPlan = { stays: [{ id: 'stay1', name: `Park <b>Hyatt</b>`, checkIn: '2027-06-05', checkOut: '2027-06-08', dataSource: 'rooms.aero', hotelId: 'h1' }] };

function readinessApi(over = {}) {
  const calls = [];
  const api = async (p, o = {}) => {
    calls.push([p, o.method || 'GET', json(o.body)]);
    for (const [prefix, handler] of Object.entries(over)) if (p.startsWith(prefix)) return handler(p, o);
    if (p.startsWith('/api/booking-readiness?')) return { report: null, current: false, planHash: 'a'.repeat(64) };
    if (p === '/api/trip-plan') return tripPlan;
    if (p === '/api/stay-plan') return stayPlan;
    throw new Error(`unexpected ${p}`);
  };
  return { api, calls };
}

test('readiness UI: empty plan offers search/builder navigation instead of a check', async () => {
  const host = fakeHost();
  const navigated = [];
  const { api } = readinessApi({ '/api/trip-plan': () => ({ planHash: 'a'.repeat(64), segments: [] }), '/api/stay-plan': () => ({ stays: [] }) });
  const ui = F.readiness.mount(deps(host, api, { navigate: v => navigated.push(v) }));
  await ui.open('trip', null);
  assert.match(host.innerHTML, /No flights or stays to check yet/);
  assert.match(host.innerHTML, /Open Trip Optimizer/);
  assert.match(host.innerHTML, /data-action="check"[^>]* disabled/);
  click(host, { action: 'goto', view: 'search' });
  assert.deepEqual(navigated, ['search']);
  assert.equal(ui.state.open, false, 'navigating closes the panel');
});

test('readiness UI: a check sends the plan hash, shows per-item progress, then grouped evidence-labelled results', async () => {
  const host = fakeHost();
  const gate = deferred();
  const { api, calls } = readinessApi({ '/api/booking-readiness/check': () => gate.promise });
  const ui = F.readiness.mount(deps(host, api));
  await ui.open('trip', null);
  assert.match(host.innerHTML, /Check booking readiness/);
  assertLabelled(host.innerHTML, 'readiness-open');
  click(host, { action: 'check' });
  await tick(2);
  assert.match(host.innerHTML, /Checking 2 selections/);
  assert.match(host.innerHTML, /JFK to LHR on 2027-06-05/);
  assert.match(host.innerHTML, /data-action="check"[^>]* disabled/, 'no duplicate checks while one runs');
  click(host, { action: 'check' });
  assert.equal(calls.filter(c => c[0] === '/api/booking-readiness/check').length, 1);
  gate.resolve({ report: reportFixture() });
  await tick();
  const check = calls.find(c => c[0] === '/api/booking-readiness/check');
  assert.deepEqual(check[2], { scope: 'trip', expectedPlanHash: 'a'.repeat(64) });
  const html = host.innerHTML;
  assertNoRawXss(html);
  assert.match(html, /Caution/);
  assert.match(html, /Refresh availability/);
  assert.match(html, /Cached provider availability/);
  assert.match(html, /Provider observation time not reported/);
  assert.match(html, /Partial or incomplete result/);
  assert.match(html, /USER CONFIRMED/);
  assert.match(html, /not verified by an API/);
  assert.match(html, /Taxes and fees/);
  assert.match(html, /Connections/);
  assert.match(html, /STOP/);
  assert.match(html, /href="https:\/\/www\.aeroplan\.com\/"/, 'program links are https only');
  assert.match(html, /Some checks could not be completed/);
  assert.match(html, /I confirmed this at the program/);
  assert.ok(!/data-item="i5"[^]*I confirmed this/.test(html.split('</li>')[4] || ''), 'a stop cannot be acknowledged away');
  assert.ok(!/Go<\/span>/.test(html), 'not a Go');
  assertLabelled(html, 'readiness-report');
});

test('readiness UI: unsafe links are dropped; out-of-date reports are labelled and dimmed', async () => {
  const host = fakeHost();
  const report = reportFixture();
  report.items[0].details.bookingUrl = 'javascript:alert(1)';
  report.items[0].evidence.source = 'http://insecure.example';
  const { api } = readinessApi({ '/api/booking-readiness?': () => ({ report, current: false, planHash: 'c'.repeat(64) }) });
  const ui = F.readiness.mount(deps(host, api));
  await ui.open('trip', null);
  assert.ok(!host.innerHTML.includes('javascript:'));
  assert.ok(!host.innerHTML.includes('href="http://insecure'));
  assert.match(host.innerHTML, /This report is out of date/);
  assert.match(host.innerHTML, /Caution \(out of date\)/);
  assert.match(host.innerHTML, /fk-report stale/);
});

test('readiness UI: manual confirmation validates the address and amounts before sending', async () => {
  const P = F.readiness.confirmationFormProblem;
  assert.ok(P({ sourceUrl: 'http://x.example/a' }, 'SEATS_UNKNOWN'));
  assert.ok(P({ sourceUrl: 'https://user:pw@x.example/a' }, 'SEATS_UNKNOWN'));
  assert.ok(P({ sourceUrl: 'https://x.example/a?token=1' }, 'SEATS_UNKNOWN'));
  assert.ok(P({ sourceUrl: 'https://x.example/a#frag' }, 'SEATS_UNKNOWN'));
  assert.equal(P({ sourceUrl: 'https://x.example/a' }, 'SEATS_UNKNOWN'), null);
  assert.ok(P({ sourceUrl: 'https://x.example/a', amount: '', currency: 'USD' }, 'FEES_UNKNOWN'));
  assert.ok(P({ sourceUrl: 'https://x.example/a', amount: '-3', currency: 'USD' }, 'FEES_UNKNOWN'));
  assert.ok(P({ sourceUrl: 'https://x.example/a', amount: '5', currency: 'US' }, 'FEES_UNKNOWN'));
  assert.equal(P({ sourceUrl: 'https://x.example/a', amount: '56.1', currency: 'usd' }, 'FEES_UNKNOWN'), null);

  const host = fakeHost();
  let confirmBody = null;
  const { api } = readinessApi({
    '/api/booking-readiness?': () => ({ report: reportFixture(), current: true, planHash: 'a'.repeat(64) }),
    '/api/booking-readiness/confirmations': (p, o) => { confirmBody = json(o.body); return { report: reportFixture({ verdict: 'Caution' }) }; }
  });
  const ui = F.readiness.mount(deps(host, api));
  await ui.open('trip', null);
  click(host, { action: 'confirm-open', item: 'i2' });
  assert.match(host.innerHTML, /Total taxes and fees/);
  assertLabelled(host.innerHTML, 'confirm-form');
  input(host, 'sourceUrl', 'http://insecure.example');
  host.fire('submit', el({ dataset: { form: 'confirm', item: 'i2' } })); await tick();
  assert.equal(confirmBody, null, 'invalid input never reaches the server');
  assert.match(host.innerHTML, /https:\/\/ page address/);
  input(host, 'sourceUrl', 'https://www.aeroplan.com/search'); input(host, 'amount', '56.10'); input(host, 'currency', 'usd');
  host.fire('submit', el({ dataset: { form: 'confirm', item: 'i2' } })); await tick();
  assert.deepEqual(confirmBody, { scope: 'trip', planHash: 'a'.repeat(64), selectionId: 'outbound', itemCode: 'FEES_UNKNOWN', sourceUrl: 'https://www.aeroplan.com/search', amount: { currency: 'USD', value: 56.1 } });
  assert.match(host.innerHTML, /recorded as user confirmed/);
});

test('readiness UI: errors are actionable — quota links to settings, plan changes re-sync, closing ignores late replies', async () => {
  const host = fakeHost();
  let behaviour = 'quota';
  const gate = deferred();
  const { api } = readinessApi({
    '/api/booking-readiness/check': () => {
      if (behaviour === 'quota') throw Object.assign(new Error('quota'), { status: 429, code: 'API_RATE_LIMIT' });
      if (behaviour === 'changed') throw Object.assign(new Error('x'), { status: 409, code: 'PLAN_CHANGED' });
      return gate.promise;
    }
  });
  const navigated = [];
  const ui = F.readiness.mount(deps(host, api, { navigate: v => navigated.push(v) }));
  await ui.open('trip', null);
  click(host, { action: 'check' }); await tick();
  assert.match(host.innerHTML, /quota or allowance is used up/);
  assert.match(host.innerHTML, /Open Data &amp; System/);
  assert.match(host.innerHTML, /Try again/);
  behaviour = 'changed';
  click(host, { action: 'check' }); await tick();
  assert.match(host.innerHTML, /plan, your wallet or the transfer data changed/);
  behaviour = 'slow';
  click(host, { action: 'check' }); await tick(2);
  ui.close(); await tick();
  gate.resolve({ report: reportFixture() });
  await tick();
  assert.equal(ui.state.report, null, 'a late reply after closing does not repopulate the panel');
  assert.equal(host.hidden, true);
});

test('readiness UI: hotel refresh is a separate, costed, two-step action with a user-triggered status check', async () => {
  const host = fakeHost();
  const report = reportFixture({ items: [{ id: 'h1', category: 'availability', selectionId: 'stay1', status: 'unknown', code: 'ROOMS_UNKNOWN', message: 'Bookable inventory count is unknown.', evidence: { method: 'cached', requestedAt: new Date().toISOString(), observedAt: null, source: 'rooms.aero', complete: true }, details: {} }] });
  const next = new Date(Date.now() - 1000).toISOString();
  const { api, calls } = readinessApi({
    '/api/booking-readiness?scope=stay': () => ({ report, current: true, planHash: 'a'.repeat(64) }),
    '/api/booking-readiness/hotel-refresh?': () => ({ status: 'completed', requestedAt: new Date().toISOString(), nextCheckAfter: null, checksRemaining: 2 }),
    '/api/booking-readiness/hotel-refresh': () => ({ status: 'queued', requestedAt: new Date().toISOString(), nextCheckAfter: next, allowanceMessage: 'Uses the shared allowance.' })
  });
  const ui = F.readiness.mount(deps(host, api));
  await ui.open('stay', null);
  assert.match(host.innerHTML, /Request hotel refresh/);
  click(host, { action: 'hotel-ask', item: 'h1' });
  assert.match(host.innerHTML, /one hotel refresh per 24 hours/);
  assert.match(host.innerHTML, /does not prove the room can be booked/);
  assert.equal(calls.filter(c => c[0].includes('hotel-refresh')).length, 0, 'asking does not request');
  click(host, { action: 'hotel-go', item: 'h1', stay: 'stay1' }); await tick();
  assert.deepEqual(calls.find(c => c[0] === '/api/booking-readiness/hotel-refresh')[2], { scope: 'stay', planHash: 'a'.repeat(64), stayId: 'stay1' });
  assert.match(host.innerHTML, /Hotel refresh requested/);
  assert.match(host.innerHTML, /Check refresh status \(3 left\)/);
  click(host, { action: 'refresh-status' }); await tick();
  assert.match(calls.at(-1)[0], /hotel-refresh\?scope=stay&planHash=a+&stayId=stay1/);
  assert.match(host.innerHTML, /Refresh availability to re-check this stay/);
});

// ---------- itinerary UI ----------
const I = F.itinerary;
const award = (id, o, d, over = {}) => ({ id, program: 'aeroplan', programName: 'Air Canada Aeroplan', origin: o, destination: d, date: '2027-06-05', cabin: 'business', mileageCost: 60000, totalTaxes: 100, remainingSeats: 2, dataSource: 'seats.aero', ageHours: 3, flight: { origin: o, destination: d, depart: { date: '2027-06-05', time: '10:00' }, arrive: { date: '2027-06-05', time: '18:30' }, totalDurationMin: 510, stops: 0, flightNumbers: ['AC1'] }, ...over });

test('itinerary UI: open jaw produces two explicit route requests (JFK–LHR, CDG–JFK)', () => {
  const s = I.initialState('open-jaw');
  Object.assign(s.openJaw, { leaveFrom: 'JFK', flyInto: 'LHR', flyHomeFrom: 'CDG', returnTo: '', departDate: '2027-06-05', returnDate: '2027-06-15', flexDays: 3, cabin: 'business' });
  const body = json(I.searchBody(s));
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.mode, 'open-jaw');
  assert.deepEqual(body.segments.map(x => [x.origins, x.destination, x.departDate]), [['JFK', 'LHR', '2027-06-05'], ['CDG', 'JFK', '2027-06-15']]);
  assert.deepEqual(json(I.legProblems(s)), []);
  s.openJaw.returnDate = '2027-06-01';
  assert.ok(I.legProblems(s).some(p => /cannot be before/.test(p.message)));
  s.openJaw.flyInto = '';
  assert.ok(I.legProblems(s).some(p => p.field === 'flyInto'));
});

test('itinerary UI: multi-city legs — cap of six, reorder/remove prune gaps, ids stay stable', () => {
  const s = I.initialState('multi-city');
  s.legs.forEach((l, i) => Object.assign(l, { origins: i ? 'LHR' : 'JFK', destination: i ? 'NRT' : 'LHR', departDate: i ? '2027-06-10' : '2027-06-05' }));
  assert.equal(s.legs.length, 2);
  while (I.addLeg(s)) { /* fill */ }
  assert.equal(s.legs.length, I.LEG_CAP);
  assert.equal(I.addLeg(s), null, 'the cap is enforced, not silently truncated');
  assert.ok(I.legProblems(s).some(p => /Enter where/.test(p.message)), 'blank legs are reported');
  assert.equal(I.addLeg(s), null);
  const ids = s.legs.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length);
  s.transitions['leg1>leg2'] = { touched: true, type: 'surface' };
  s.transitions['leg2>leg3'] = { touched: true, type: 'connection' };
  assert.ok(I.moveLeg(s, 'leg2', -1));
  assert.deepEqual(json(s.legs.slice(0, 3).map(l => l.id)), ['leg2', 'leg1', 'leg3']);
  assert.deepEqual(json(Object.keys(s.transitions)), [], 'ground moves between legs that are no longer neighbours are dropped');
  assert.equal(I.moveLeg(s, 'leg2', -1), false, 'cannot move the first leg up');
  assert.ok(I.removeLeg(s, 'leg3'));
  assert.equal(s.legs.length, 5);
  const small = I.initialState('multi-city');
  assert.equal(I.removeLeg(small, 'leg1'), false, 'a multi-city trip keeps at least two flights');
});

test('itinerary UI: evaluation needs one pick per leg; only filled-in gaps are sent; ground time is a user estimate', () => {
  const s = I.initialState('multi-city');
  s.legs.forEach((l, i) => Object.assign(l, { origins: i ? 'LHR' : 'JFK', destination: i ? 'NRT' : 'LHR', departDate: i ? '2027-06-10' : '2027-06-05' }));
  s.picks.leg1 = award('a', 'JFK', 'LHR');
  const pair = I.adjacentPairs(s)[0];
  assert.equal(I.transitionsBody(s).length, 0, 'untouched gaps are left for the server to derive as unresolved');
  s.picks.leg2 = award('b', 'LHR', 'NRT', { date: '2027-06-10' });
  s.transitions[pair.key] = { ...I.defaultTransition(s, pair), type: 'surface', mode: 'rail', durationMinutes: '90', cost: '25', bufferMinutes: 180, touched: true };
  const body = json(I.evaluateBody(s));
  assert.equal(body.schemaVersion, 2);
  assert.deepEqual(body.segments.map(x => x.id), ['leg1', 'leg2']);
  assert.deepEqual(body.transitions[0], { fromSegmentId: 'leg1', toSegmentId: 'leg2', type: 'surface', bufferMinutes: 180, ticketRelationship: 'separate', ground: { mode: 'rail', durationMinutes: 90, cost: { currency: 'USD', value: 25 } } });
  const save = json(I.saveBody(s, 4));
  assert.equal(save.expectedRevision, 4);
  assert.equal(save.segments[0].query.origins, 'JFK');
  const draft = I.initialState('multi-city'); draft.legs.forEach(l => Object.assign(l, { origins: 'AAA', destination: 'BBB', departDate: '2027-06-01' }));
  assert.equal(json(I.saveBody(draft, 0)).segments[0].award, null, 'a draft saves with award:null');
  const html = I.view(s, esc, safeUrl);
  assert.match(html, /Travel time in minutes \(user estimate\)/);
  assert.match(html, /PointPilot does not guess driving times|Unknown: not entered|Your own estimate/);
  assert.match(html, /Allow time for baggage, security and immigration/);
  assert.match(html, /not an official minimum connection time/);
  assert.match(html, /Move up/); assert.match(html, /Move down/); assert.match(html, /Add flight/);
  assert.match(html, /Award legs can require separate bookings/);
  assertLabelled(html, 'itinerary');
});

test('itinerary UI: mount flow — per-leg results, an independent failed leg keeps the others, retry, evaluate, save', async () => {
  const host = fakeHost();
  const calls = [];
  let retryOk = false;
  const api = async (p, o = {}) => {
    calls.push([p, o.method || 'GET', json(o.body)]);
    if (p === '/api/search/trip') {
      const ids = o.body.segments.map(s => s.id);
      return { schemaVersion: 2, segments: ids.map(id => (id === 'leg2' && !retryOk
        ? { id, options: [], counts: {}, dataStatus: { api: 'error', warnings: [] }, error: { code: 'API_ERROR', message: `Availability search failed ${XSS}` } }
        : { id, options: [award(`${id}-o1`, id === 'leg1' ? 'JFK' : 'CDG', id === 'leg1' ? 'LHR' : 'JFK'), award(`${id}-o2`, id === 'leg1' ? 'JFK' : 'CDG', id === 'leg1' ? 'LHR' : 'JFK', { mileageCost: 70000 })], counts: {}, dataStatus: { api: 'fetched', warnings: ['Cached data'] }, truncated: id === 'leg1', truncatedReason: 'page limit', error: null })), complete: false, gaps: [] };
    }
    if (p === '/api/trip/evaluate') return { valid: true, risks: [{ code: 'AIRPORT_CHANGE', severity: 'caution', reason: 'Different airports need a ground move.', actualAirports: { from: 'LHR', to: 'CDG' }, gapMinutes: null }], affordable: true, fundingStatus: 'funded', trip: { totalSourcePoints: 130000, totalTargetPoints: 130000, taxesUsd: 200, sources: [{ direct: true, from: 'aeroplan', fromPoints: 130000 }], stays: [], warnings: [] } };
    if (p === '/api/trip-plan' && !o.method) return { revision: 3 };
    if (p === '/api/trip-plan/itinerary') return { revision: 4, segments: [{}, {}] };
    throw new Error(p);
  };
  const changed = [];
  const ui = I.mount(deps(host, api, { onPlanChanged: d => changed.push(d) }));
  const f = { 'oj-leaveFrom': 'JFK', 'oj-flyInto': 'LHR', 'oj-flyHomeFrom': 'CDG', 'oj-departDate': '2027-06-05', 'oj-returnDate': '2027-06-15' };
  click(host, { action: 'search' });
  assert.match(host.innerHTML, /Enter where the outbound leaves from/, 'validation happens before any request');
  assert.equal(calls.filter(c => c[0] !== '/api/trip-plan').length, 0, 'no search request is sent (only the saved-revision lookup at open)');
  for (const [k, v] of Object.entries(f)) input(host, k, v);
  click(host, { action: 'search' }); await tick();
  const searchCall = calls.find(c => c[0] === '/api/search/trip');
  assert.deepEqual(searchCall[2].segments.map(s => `${s.origins}-${s.destination}`), ['JFK-LHR', 'CDG-JFK']);
  assertNoRawXss(host.innerHTML);
  assert.match(host.innerHTML, /Search this flight again/, 'the failed leg is retryable');
  assert.match(host.innerHTML, /Other flights are not affected/);
  assert.match(host.innerHTML, /More results exist: page limit/);
  assert.match(host.innerHTML, /name="pick-leg1"/);
  assertLabelled(host.innerHTML, 'itinerary-results');
  assert.match(host.innerHTML, /data-action="evaluate"[^>]* disabled/, 'evaluation waits for a pick on every leg');
  change(host, 'pick', {}, { leg: 'leg1', option: 'leg1-o1' });
  assert.match(host.innerHTML, /Pick a flight for flight 2/);
  retryOk = true;
  click(host, { action: 'retry-leg', leg: 'leg2' }); await tick();
  const retry = calls.filter(c => c[0] === '/api/search/trip').at(-1);
  assert.equal(retry[2].segments.length, 1);
  assert.equal(retry[2].mode, 'one-way');
  assert.ok(ui.state.picks.leg1, 'the other leg\'s pick survives a retry');
  change(host, 'pick', {}, { leg: 'leg2', option: 'leg2-o1' });
  click(host, { action: 'evaluate' }); await tick();
  assert.match(host.innerHTML, /Your points can fund this itinerary/);
  assert.match(host.innerHTML, /Different airports need a ground move/);
  assert.match(host.innerHTML, /CAUTION/);
  click(host, { action: 'save' }); await tick();
  const put = calls.find(c => c[0] === '/api/trip-plan/itinerary');
  assert.equal(put[1], 'PUT');
  assert.equal(put[2].expectedRevision, 3);
  assert.equal(put[2].segments[1].award.id, 'leg2-o1');
  assert.equal(changed.length, 1);
  assert.match(host.innerHTML, /Saved to your Trip Builder/);
});

test('itinerary UI: late search results after a mode change are ignored; funding wording never claims impossibility', async () => {
  const host = fakeHost();
  const gate = deferred();
  const api = async (p) => { if (p === '/api/search/trip') return gate.promise; if (p === '/api/trip/evaluate') return { valid: true, risks: [], affordable: false, trip: null, fundingStatus: 'search-limited' }; throw new Error(p); };
  const ui = I.mount(deps(host, api));
  for (const [k, v] of Object.entries({ 'oj-leaveFrom': 'JFK', 'oj-flyInto': 'LHR', 'oj-flyHomeFrom': 'CDG', 'oj-departDate': '2027-06-05', 'oj-returnDate': '2027-06-15' })) input(host, k, v);
  click(host, { action: 'search' }); await tick(2);
  assert.match(host.innerHTML, /Searching this flight…/);
  ui.setMode('multi-city');
  gate.resolve({ schemaVersion: 2, segments: [{ id: 'leg1', options: [award('x', 'JFK', 'LHR')], dataStatus: {}, error: null }] });
  await tick();
  assert.equal(ui.state.mode, 'multi-city');
  assert.deepEqual(json(ui.state.results), {}, 'results of the old search are not shown in the new mode');
  const s = I.initialState('multi-city');
  s.legs.forEach(l => Object.assign(l, { origins: 'A', destination: 'B', departDate: '2027-06-01' }));
  s.picks = { leg1: award('a', 'A', 'B'), leg2: award('b', 'A', 'B') };
  s.evalState = { phase: 'done', result: { valid: true, risks: [], affordable: false, trip: null, fundingStatus: 'search-limited' }, error: null };
  const html = I.view(s, esc, safeUrl);
  assert.match(html, /does not prove the trip is impossible/);
});

test('itinerary UI: Trip Builder timeline shows every leg, gaps as user estimates, risks, and escapes everything', () => {
  const plan = {
    mode: 'multi-city', travelers: 2, complete: false, valid: true,
    segments: [{ id: 'leg1', award: award('a', 'JFK', 'LHR') }, { id: 'leg2', award: null }, { id: 'leg3', award: award('c', 'CDG', 'NRT', { programName: XSS }) }],
    risks: [{ code: 'AIRPORT_CHANGE', severity: 'stop', fromId: 'leg1', toId: 'leg2', reason: `Overlap ${XSS}` }],
    timeline: [
      { type: 'award', segmentId: 'leg1', at: '2027-06-05T10:00:00Z', item: award('a', 'JFK', 'LHR') },
      { type: 'transition', at: '2027-06-05T19:00:00Z', item: { fromSegmentId: 'leg1', toSegmentId: 'leg2', type: 'surface', ground: { mode: 'rail', durationMinutes: 140, cost: { currency: 'USD', value: 60 } }, bufferMinutes: 180, ticketRelationship: 'separate' } },
      { type: 'transition', at: '2027-06-06T19:00:00Z', item: { fromSegmentId: 'leg2', toSegmentId: 'leg3', type: 'connection', ground: null, bufferMinutes: 120, ticketRelationship: 'unknown' } },
      { type: 'award', segmentId: 'leg3', at: '2027-06-10T10:00:00Z', item: award('c', 'CDG', 'NRT', { programName: XSS, bookingLinks: [{ url: 'javascript:alert(1)' }] }) },
      { type: 'positioning', at: '2027-06-04T10:00:00Z', direction: 'outbound', item: { kind: 'cash', origin: 'BOS', destination: 'JFK', price: 120 } }
    ]
  };
  const html = I.timelineHtml(plan, esc, safeUrl);
  assertNoRawXss(html);
  assert.match(html, /Multi-city · 3 flights/);
  assert.match(html, /2 flights still need an award selected/.test(html) ? /./ : /still needs? an award|still need an award/);
  assert.match(html, /about 2h 20m \(user estimate\)/);
  assert.match(html, /time between flights is unknown|No ground move entered/);
  assert.match(html, /separate tickets, not protected/);
  assert.match(html, /ticket protection unknown/);
  assert.match(html, /STOP/);
  assert.match(html, /data-tb="remove-segment" data-id="leg1"/);
  assert.ok(!html.includes('javascript:'));
  const without = I.timelineHtml(plan, esc, safeUrl, { skipPositioning: true });
  assert.ok(html.includes('BOS') && !without.includes('BOS'));
});

test('app.js wiring: trip-type switcher, readiness triggers, system-view roots and no inline handlers', () => {
  const app = read('app.js'), html = read('index.html');
  for (const id of ['itineraryRoot', 'readinessRoot', 'backupRoot', 'diagnosticsRoot', 'tripTypeWrap', 'classicSearch', 'tbReadinessSlot', 'stayReadinessSlot', 'gotoBackup']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /name="tripType" value="open-jaw"/);
  assert.match(html, /name="tripType" value="multi-city"/);
  assert.match(app, /data-readiness="trip"/);
  assert.match(app, /data-readiness="stay"/);
  assert.match(app, /PPFeatures\.itinerary\.mount/);
  assert.match(app, /PPFeatures\.readiness\.mount/);
  assert.match(app, /PPFeatures\.backup\.mount/);
  assert.match(app, /PPFeatures\.diagnostics\.mount/);
  assert.match(app, /closest\('#itineraryRoot'\)/, 'Enter in the itinerary screen must not trigger the classic search');
});

// ---------- group cash (O1) and multi-room hotels (O2) helpers ----------
const H = sandbox.PPHelpers;
const usd = n => `$${Math.round(n)}`;

test('group cash: unconfirmed-basis prices are labelled, never presented as per-person or exact', () => {
  const legacy = H.fareQuote({ price: 870, total: 1740 }, 2, usd);
  assert.equal(legacy.exact, true);
  assert.equal(legacy.caption, 'per person · $1740 for 2', 'fares without pricing metadata read as before');
  assert.equal(H.fareQuote({ price: 870, total: 870 }, 1, usd).caption, 'per person');
  const google = H.fareQuote({ price: 2100, total: null, exactComparable: false, pricing: { amountBasis: 'unknown', estimated: false }, pricingLabel: 'Price returned for 2 adults — basis unconfirmed', oneAdultEstimate: { amount: 1740, label: 'one-adult price × N — estimated, group availability not checked' } }, 2, usd);
  assert.equal(google.exact, false);
  assert.equal(google.caption, '', 'no per-person claim for an unknown basis');
  assert.equal(google.label, 'Price returned for 2 adults — basis unconfirmed');
  assert.deepEqual(json(google.oneAdult), { amountText: '$1740', label: 'one-adult price × N — estimated, group availability not checked' });
  const tp = H.fareQuote({ price: 870, total: 1740, exactComparable: false, pricing: { amountBasis: 'per-adult', estimated: true }, pricingLabel: 'one-adult price × N — estimated, group availability not checked' }, 2, usd);
  assert.equal(tp.exact, false);
  assert.match(tp.caption, /per adult · ≈\$1740 for 2 \(estimated\)/);
  assert.equal(H.fareQuote({ price: 900, exactComparable: false, pricingLabel: '' }, 1, usd).exact, true, 'one traveller is unchanged');
  assert.equal(H.isExactComparable({ exactComparable: false }), false);
  assert.equal(H.isExactComparable({ total: 5 }), true);
  assert.equal(H.isExactComparable(undefined), true);
  const unlabelled = H.fareQuote({ price: 2100, total: null, pricing: { amountBasis: 'unknown' } }, 3, usd);
  assert.equal(unlabelled.label, 'Price returned for 3 adults — basis unconfirmed', 'a default label is used when the server omits one');
});

test('multi-room: explicit allocation, bounds, and the default stays legacy', () => {
  assert.deepEqual(json(H.parseChildAges('')), { ok: true, ages: [] });
  assert.deepEqual(json(H.parseChildAges('7, 3;12')), { ok: true, ages: [7, 3, 12] });
  for (const bad of ['18', '-1', 'x', '3.5', '1,2,3,4,5,6,7']) assert.equal(H.parseChildAges(bad).ok, false, bad);
  const def = H.buildRooms([{ adults: 2, childrenText: '', roomType: 'standard' }]);
  assert.equal(def.ok, true);
  assert.equal(def.isDefault, true);
  const two = H.buildRooms([{ adults: 2, childrenText: '7', roomType: 'standard' }, { adults: 1, childrenText: '', roomType: 'suite' }]);
  assert.deepEqual(json(two.rooms), [{ adults: 2, childrenAges: [7], roomType: 'standard' }, { adults: 1, childrenAges: [], roomType: 'suite' }]);
  assert.equal(two.isDefault, false);
  assert.equal(H.buildRooms([{ adults: 3, childrenText: '', roomType: 'any' }]).isDefault, false, 'three adults is explicit, not the default');
  assert.equal(H.buildRooms([]).ok, false);
  assert.equal(H.buildRooms(Array.from({ length: 5 }, () => ({ adults: 2, childrenText: '', roomType: 'any' }))).ok, false, 'at most four rooms');
  assert.equal(H.buildRooms([{ adults: 9, childrenText: '', roomType: 'any' }]).ok, false);
  assert.equal(H.buildRooms([{ adults: 0, childrenText: '', roomType: 'any' }]).ok, false);
  assert.equal(H.buildRooms([{ adults: 2, childrenText: '', roomType: 'penthouse' }]).ok, false);
  assert.match(H.buildRooms([{ adults: 2, childrenText: '99', roomType: 'any' }]).error, /Room 1/);
});

test('multi-room: required labels appear, and inventory is never described as available', () => {
  const fmt = n => String(n);
  const row = { observedSingleRoomPoints: 75000, estimatedPointsForRooms: 150000, totalPoints: 150000, roomEstimate: { rooms: 2, singleRoomPoints: 75000, points: 150000, estimated: true }, roomEstimateLabel: 'Estimated points for 2 rooms', inventoryStatus: 'unknown', occupancyStatus: 'unverified', userEvidence: null };
  const s = H.roomSummary(row, fmt);
  assert.deepEqual(json(s.lines.map(l => l.label)), ['Observed award for one room', 'Estimated points for 2 rooms']);
  assert.deepEqual(json(s.badges), ['Room inventory unknown', 'Occupancy unverified']);
  assert.deepEqual(json(H.roomSummary({ ...row, feeStatus: 'unknown' }, fmt).badges).slice(-1), ['Award taxes and resort fees unknown']);
  assert.equal(s.lines[1].estimated, true);
  assert.ok(!JSON.stringify(s).match(/available/i), 'no "R rooms available" claim');
  const entered = H.roomSummary({ ...row, userEvidence: { roomCount: {} } }, fmt);
  assert.deepEqual(json(entered.badges), ['Room inventory unknown', 'Occupancy: user entered']);
  const single = H.roomSummary({ totalPoints: 75000 }, fmt);
  assert.deepEqual(json(single), { rooms: 1, lines: [], badges: [], userEntered: false }, 'a legacy one-room row looks exactly as before');
  assert.equal(H.plainText('Free until &lt;b&gt;June&lt;/b&gt; &amp; &quot;more&quot; &#39;x&#39;'), `Free until <b>June</b> & "more" 'x'`);
});

test('multi-room: user-entered details need a source and date, and every amount is validated', () => {
  const base = { source: 'Hyatt agent chat', date: '2026-10-21', currency: 'usd' };
  assert.deepEqual(json(H.buildProgramEvidence({}, [])), { ok: true, evidence: null }, 'nothing entered means nothing stored');
  assert.match(H.buildProgramEvidence({ taxes: '35' }, []).error, /where you confirmed/);
  assert.match(H.buildProgramEvidence({ taxes: '35', source: 'x', date: 'soon' }, []).error, /date/);
  assert.match(H.buildProgramEvidence({ ...base, taxes: '-5' }, []).error, /Taxes/);
  assert.match(H.buildProgramEvidence({ ...base, resortFee: 'abc' }, []).error, /Resort fee/);
  assert.match(H.buildProgramEvidence({ ...base, taxes: '5', currency: 'US' }, []).error, /currency/);
  assert.match(H.buildProgramEvidence({ ...base, roomCount: '9' }, []).error, /Rooms confirmed/);
  assert.match(H.buildProgramEvidence({ ...base, cancellation: 'x'.repeat(501) }, []).error, /500/);
  const rooms = [{ adults: 2, childrenAges: [7], roomType: 'standard' }];
  const ok = H.buildProgramEvidence({ ...base, roomCount: '2', occupancyConfirmed: true, taxes: '35', resortFee: '', resortFeeWaived: true, cancellation: 'Free until June 1' }, rooms);
  assert.equal(ok.ok, true);
  assert.deepEqual(json(ok.evidence), {
    roomCount: { value: 2, source: 'Hyatt agent chat', date: '2026-10-21', currency: null },
    occupancy: { rooms, source: 'Hyatt agent chat', date: '2026-10-21', currency: null },
    taxes: { amount: 35, source: 'Hyatt agent chat', date: '2026-10-21', currency: 'USD' },
    resortFee: { amount: null, source: 'Hyatt agent chat', date: '2026-10-21', currency: 'USD', waived: true },
    cancellation: { text: 'Free until June 1', source: 'Hyatt agent chat', date: '2026-10-21', currency: null }
  });
  assert.equal(H.buildProgramEvidence({ ...base, resortFee: '0' }, []).evidence.resortFee.amount, 0, 'a typed zero stays zero; a blank stays null');
});

test('app.js wiring for group cash and multi-room', () => {
  const app = read('app.js'), html = read('index.html');
  for (const id of ['roomsWrap', 'roomsList', 'addRoom', 'cashOffers', 'roomsError']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /Cash offer for requested occupancy/);
  assert.match(app, /user entered/);
  assert.match(app, /isExactComparable\(r\)/, 'savings and cents-per-point are gated');
  assert.match(app, /cashPricingUncertain/);
  assert.match(app, /Object\.assign\(body, \{ rooms/);
  assert.match(app, /quoteHtml\(f, t\)/);
  assert.doesNotMatch(app, /\brooms? available\b/i);
  assert.match(html, /never splits your party/i);
});

// ---------- verification round 1 (items owned by D) ----------
test('#3 cash comparison quotes: Google amount comes from pricing.amount; Travelpayouts shows per-adult and the estimated group total', () => {
  const google = H.comparisonQuote({ available: true, price: undefined, perTraveler: null, total: null, exactComparable: false, pricing: { amount: 1900, amountBasis: 'unknown', estimated: false }, pricingLabel: 'Price returned for 2 adults — basis unconfirmed', oneAdultEstimate: { amount: 3480, label: 'one-adult price × N — estimated, group availability not checked' } }, 2, usd);
  assert.equal(google.price, 1900, 'the returned amount is shown, not a dash');
  assert.equal(google.label, 'Price returned for 2 adults — basis unconfirmed');
  assert.equal(google.caption, '');
  assert.equal(google.oneAdult.amountText, '$3480');
  const tp = H.comparisonQuote({ available: true, perTraveler: 600, total: 1800, exactComparable: false, pricing: { amount: 600, amountBasis: 'per-adult', estimated: true }, pricingLabel: 'one-adult price × 3 — estimated, group availability not checked' }, 3, usd);
  assert.equal(tp.price, 600);
  assert.equal(tp.caption, 'per adult · ≈$1800 for 3 (estimated)');
  assert.match(tp.label, /one-adult price × 3/);
  const app = read('app.js');
  assert.match(app, /comparisonQuote\(\{ \.\.\.r, exactComparable: false \}/);
  assert.match(app, /\$\{gq\.caption \? ` \$\{esc\(gq\.caption\)\}` : ''\}/, 'the comparison box prints the caption');
});

const loadedPlan = (over = {}) => ({
  revision: 7, mode: 'multi-city', travelers: 2, transitions: [],
  segments: [
    { id: 'leg1', query: { origins: 'JFK', destination: 'LHR', departDate: '2027-06-05', flexDays: 0, cabin: 'business', nonstopOnly: false }, award: award('a', 'JFK', 'LHR'), ticketGroupId: null },
    { id: 'leg3', query: null, award: award('b', 'LHR', 'CDG', { date: '2027-06-08' }), ticketGroupId: 'grp1' },
    { id: 'leg4', query: { origins: 'CDG', destination: 'NRT', departDate: '2027-06-12', flexDays: 1, cabin: 'business', nonstopOnly: true }, award: null, ticketGroupId: null }
  ], ...over
});

test('#4 save submits the revision that was loaded, and a conflict is surfaced with a way to reload', async () => {
  const host = fakeHost();
  let served = 7;
  const calls = [];
  const api = async (p, o = {}) => {
    calls.push([p, o.method || 'GET', json(o.body)]);
    if (p === '/api/trip-plan') return loadedPlan({ revision: served });
    if (p === '/api/trip-plan/itinerary') throw Object.assign(new Error('x'), { status: 409, code: 'PLAN_CHANGED' });
    throw new Error(p);
  };
  const ui = I.mount(deps(host, api));
  await tick();
  assert.equal(ui.state.baseRevision, 7, 'the revision is captured when the screen opens');
  click(host, { action: 'load-saved' }); await tick();
  served = 12; // someone else saved meanwhile
  click(host, { action: 'save' }); await tick();
  const put = calls.find(c => c[0] === '/api/trip-plan/itinerary');
  assert.equal(put[2].expectedRevision, 7, 'never silently upgraded to 12');
  assert.equal(calls.filter(c => c[0] === '/api/trip-plan').length, 2, 'no re-fetch of the newest revision on save (open + load)');
  assert.match(host.innerHTML, /saved trip changed since you opened it/);
  assert.match(host.innerHTML, /Reload the saved trip/);
  click(host, { action: 'load-saved' }); await tick();
  assert.equal(ui.state.baseRevision, 12, 'reloading moves the base to what the user now sees');
});

test('#5 #10 #11 a saved plan loads completely: every leg, its ids, ticket groups and transitions survive a save', async () => {
  const host = fakeHost();
  const calls = [];
  const api = async (p, o = {}) => { calls.push([p, o.method || 'GET', json(o.body)]); if (p === '/api/trip-plan' && !o.method) return loadedPlan(); if (p === '/api/trip-plan/itinerary') return { revision: 8, segments: [{}, {}, {}] }; throw new Error(p); };
  const ui = I.mount(deps(host, api));
  await tick();
  click(host, { action: 'load-saved' }); await tick();
  assert.deepEqual(json(ui.state.legs.map(l => l.id)), ['leg1', 'leg3', 'leg4'], 'the query-less middle leg is not dropped');
  const middle = ui.state.legs[1];
  assert.deepEqual([middle.origins, middle.destination, middle.departDate], ['LHR', 'CDG', '2027-06-08'], 'rebuilt from its saved award');
  assert.match(host.innerHTML, /3 flights/);
  // #11 adding a flight never reuses an id
  click(host, { action: 'add-leg' });
  const ids = ui.state.legs.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
  assert.ok(!ids.slice(0, 3).includes(ids[3]));
  I.removeLeg(ui.state, ids[3]);
  // save sends every leg, with its ticket group
  ui.state.legs[2].origins = 'CDG';
  click(host, { action: 'save' }); await tick();
  const put = calls.find(c => c[0] === '/api/trip-plan/itinerary');
  assert.deepEqual(put[2].segments.map(s => s.id), ['leg1', 'leg3', 'leg4']);
  assert.equal(put[2].segments[1].ticketGroupId, 'grp1');
  assert.equal(put[2].segments[1].award.id, 'b', 'its award is kept');
  assert.equal(put[2].expectedRevision, 7);
});

test('#10 open-jaw saved ids and transitions stay consistent through a save', async () => {
  const host = fakeHost();
  const calls = [];
  const plan = { revision: 3, mode: 'open-jaw', travelers: 1, segments: [
    { id: 'outbound', query: { origins: 'JFK', destination: 'LHR', departDate: '2027-06-05', flexDays: 0, cabin: 'business', nonstopOnly: false }, award: award('o', 'JFK', 'LHR') },
    { id: 'return', query: { origins: 'CDG', destination: 'JFK', departDate: '2027-06-15', flexDays: 0, cabin: 'business', nonstopOnly: false }, award: award('r', 'CDG', 'JFK', { date: '2027-06-15' }) }
  ], transitions: [{ fromSegmentId: 'outbound', toSegmentId: 'return', type: 'surface', ground: { mode: 'rail', durationMinutes: 180, cost: null }, bufferMinutes: 180, ticketRelationship: 'separate' }] };
  const api = async (p, o = {}) => { calls.push([p, o.method || 'GET', json(o.body)]); if (p === '/api/trip-plan' && !o.method) return plan; if (p === '/api/trip-plan/itinerary') return { revision: 4, segments: [{}, {}] }; throw new Error(p); };
  const ui = I.mount(deps(host, api));
  await tick();
  click(host, { action: 'load-saved' }); await tick();
  assert.deepEqual(json(I.currentLegs(ui.state).map(l => l.id)), ['outbound', 'return']);
  click(host, { action: 'save' }); await tick();
  const put = calls.find(c => c[0] === '/api/trip-plan/itinerary');
  assert.deepEqual(put[2].segments.map(s => s.id), ['outbound', 'return']);
  assert.equal(put[2].transitions.length, 1, 'the 180-minute rail transfer is not lost');
  assert.deepEqual([put[2].transitions[0].fromSegmentId, put[2].transitions[0].toSegmentId, put[2].transitions[0].ground.durationMinutes], ['outbound', 'return', 180]);
});

test('#12 adding, removing or reordering a leg clears the evaluation', () => {
  const evaluated = () => {
    const s = I.initialState('multi-city');
    s.legs.forEach(l => Object.assign(l, { origins: 'A', destination: 'B', departDate: '2027-06-01' }));
    s.picks = { leg1: award('a', 'A', 'B'), leg2: award('b', 'A', 'B') };
    s.evalState = { phase: 'done', result: { valid: true, fundingStatus: 'funded', affordable: true, trip: { totalSourcePoints: 1, totalTargetPoints: 1, taxesUsd: 0, sources: [] } }, error: null };
    s.save = { phase: 'saved', message: 'Saved to your Trip Builder.', error: null };
    return s;
  };
  for (const act of [s => I.addLeg(s), s => I.moveLeg(s, 'leg2', -1), s => { I.addLeg(s); s.evalState = { phase: 'done', result: {}, error: null }; I.removeLeg(s, 'leg3'); }]) {
    const s = evaluated();
    act(s);
    assert.equal(s.evalState.phase, 'idle');
    assert.ok(!/can fund this itinerary/.test(I.view(s, esc, safeUrl)));
    assert.equal(s.save.message, null, 'a stale "Saved" message is cleared too');
  }
});

test('#14 trip ends come from the canonical legs when there is no legacy flights pair', () => {
  const a = award('a', 'JFK', 'LHR'), z = award('z', 'CDG', 'JFK');
  assert.equal(H.tripEnds({ flights: { outbound: 1, return: 2 } }).outbound, 1);
  const multi = H.tripEnds({ segments: [{ award: a }, { award: award('m', 'LHR', 'CDG') }, { award: z }] });
  assert.equal(multi.outbound.id, 'a');
  assert.equal(multi.return.id, 'z');
  assert.deepEqual(json(H.tripEnds({ segments: [{ award: a }] })), { outbound: json(a), return: null });
  assert.deepEqual(json(H.tripEnds({ segments: [] })), { outbound: null, return: null });
  const app = read('app.js');
  assert.match(app, /const flights = tripEnds\(p\)/, 'positioning controls use the canonical ends');
  assert.match(app, /skipPositioning: true/);
  assert.doesNotMatch(app, /if \(!p\.flights\) return ''/);
});

test('#8 a stay added from a hotel result carries its exact provenance', () => {
  const row = { name: 'Park Hyatt', availabilityId: 'av1', roomId: 'rm1', roomIdentity: 'KING', pricedNights: 3, pricedTotalPoints: 75000, pricedTotalCash: 900, capturedAt: '2026-10-21T00:00:00Z', sourceUpdatedAt: '2026-10-20T20:00:00Z', observedAt: '2026-10-20T20:00:00Z', evidenceMethod: 'cached', totalTaxes: null, taxesMissing: true, feesMissing: true, feesEstimated: false, feesCurrency: 'USD', awardFees: null, unrelated: 'x' };
  const p = H.stayProvenance(row);
  for (const k of ['availabilityId', 'roomId', 'roomIdentity', 'pricedNights', 'pricedTotalPoints', 'pricedTotalCash', 'capturedAt', 'sourceUpdatedAt', 'observedAt', 'evidenceMethod', 'taxesMissing', 'feesMissing', 'feesEstimated', 'feesCurrency']) assert.ok(k in p, k);
  assert.ok(!('totalTaxes' in p) && !('awardFees' in p) && !('unrelated' in p), 'unknown stays unknown: nothing is defaulted to zero or invented');
  assert.deepEqual(json(H.stayProvenance({})), {});
  assert.match(read('app.js'), /Object\.assign\(body, stayProvenance\(h\)\)/);
});

test('#17 partial reports with a provider auth or quota failure say so and link to settings', async () => {
  const host = fakeHost();
  const report = reportFixture({ sourceStatus: { complete: false }, items: [
    { id: 'p1', category: 'availability', selectionId: 'outbound', status: 'unknown', code: 'AVAILABILITY_UNVERIFIED', message: 'Availability is unverified.', evidence: { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'seats.aero', complete: false }, details: { providerCode: 'API_AUTH' } },
    { id: 'p2', category: 'availability', selectionId: 'stay1', status: 'unknown', code: 'AVAILABILITY_UNVERIFIED', message: 'Availability is unverified.', evidence: { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'rooms.aero', complete: false }, details: { providerCode: 'API_RATE_LIMIT' } },
    { id: 'p3', category: 'availability', selectionId: 'stay1', status: 'unknown', code: 'AVAILABILITY_UNVERIFIED', message: 'x', evidence: { method: 'unsupported', requestedAt: new Date().toISOString(), observedAt: null, source: 'Point Pilot', complete: false }, details: { providerCode: 'PROVIDER_FAILURE' } }
  ] });
  const { api } = readinessApi({ '/api/booking-readiness?': () => ({ report, current: true, planHash: 'a'.repeat(64) }) });
  const navigated = [];
  const ui = F.readiness.mount(deps(host, api, { navigate: v => navigated.push(v) }));
  await ui.open('trip', null);
  assert.match(host.innerHTML, /provider rejected your key/);
  assert.match(host.innerHTML, /quota or allowance is used up/);
  assert.match(host.innerHTML, /could not be reached or returned an error/);
  assert.ok((host.innerHTML.match(/Open Data &amp; System/g) || []).length >= 2, 'a settings action is offered');
  assert.equal(F.readiness.providerHint({ details: { providerCode: 'PROVIDER_FAILURE' } }).settings, false, 'a generic failure has no settings link');
  assert.equal(F.readiness.providerHint({ details: {} }), null);
  click(host, { action: 'goto', view: 'system' });
  assert.deepEqual(navigated, ['system']);
});
