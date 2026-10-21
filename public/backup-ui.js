'use strict';
// Backup & restore screen. Export an encrypted file; restore with preview -> merge/replace -> review -> restore.
// Mounted by app.js: PPFeatures.backup.mount({ root, api, esc, safeUrl, createGuard, onPlanChanged, desktop, onDataRestored }).
// Passwords live only in memory while typed and are cleared the moment a request starts. Nothing here ever
// writes keys, webhook URLs or wallet contents into messages; the server's responses carry none.
(function (root) {
  const Kit = root.PPKit;
  const MAX_BACKUP_BYTES = 18 * 1024 * 1024;
  const CATEGORIES = ['wallet', 'preferences', 'settings', 'plans', 'alerts'];
  const CATEGORY_LABELS = { wallet: 'Wallet balances', preferences: 'Optimizer preferences', settings: 'Settings', plans: 'Saved trip and stays', alerts: 'Alert definitions' };
  const ACTION_LABELS = { keep: 'Keep mine', incoming: 'Use the backup\'s', both: 'Keep both' };
  const ERRORS = {
    BACKUP_DECRYPT_FAILED: 'The password is wrong, or the backup file was changed after it was made.',
    BACKUP_UNSUPPORTED_VERSION: 'This backup was made by a different version of PointPilot and cannot be read.',
    BACKUP_INVALID: 'That file is not a valid PointPilot backup.',
    BACKUP_TOO_LARGE: 'That backup is too large.',
    BACKUP_BUSY: 'Another backup operation is still running. Try again in a moment.',
    PASSWORD_INVALID: 'Use a password of at least 12 characters.',
    PREVIEW_EXPIRED: 'The review expired. Choose the backup file again.',
    PREVIEW_STALE: 'Your data changed after the review. Review the backup again before restoring.',
    PREVIEW_OPTIONS_CHANGED: 'The review options changed. Review the backup again.',
    BACKUP_RESTORE_FAILED: 'The restore failed.',
    UNTRUSTED_SENDER: 'The file dialog is not available from this window.',
    DIALOG_BUSY: 'A file dialog is already open.',
    TOO_LARGE: 'That file is too large to be a PointPilot backup.',
    NOT_A_BACKUP: 'That file is not a PointPilot backup.',
    NOT_ALLOWED: 'That file cannot be used. Choose a regular file.',
    READ_FAILED: 'The file could not be read.',
    WRITE_FAILED: 'The file could not be saved. Choose another location.',
    INVALID_CONTENT: 'The backup could not be saved.',
    FILE_TOO_LARGE: 'That file is too large to be a PointPilot backup.',
    BODY_TOO_LARGE: 'That file is too large to be a PointPilot backup.'
  };

  const freshExport = () => ({ categories: Object.fromEntries(CATEGORIES.map(c => [c, true])), includeSecrets: false, password: '', repeat: '', busy: false, error: null, result: null });
  const freshRestore = () => ({ step: 'choose', fileName: null, envelope: null, password: '', busy: false, error: null, notice: null, preview: null, previewKey: 0, mode: 'merge', categories: {}, choices: {}, options: { restoreSecrets: false, activateImportedAlerts: false, enableLaunchAtLogin: false }, confirmReplace: false, done: null, expired: false });
  const initialState = () => ({ tab: 'export', summary: { loading: true, error: null, counts: null, secretsPresent: false }, export: freshExport(), restore: freshRestore() });

  function countText(category, counts) {
    if (!counts) return '';
    const n = key => counts[key];
    const items = {
      wallet: n('wallet') == null ? '' : Kit.plural(n('wallet'), 'program'),
      preferences: n('preferences') == null ? '' : Kit.plural(n('preferences'), 'value'),
      settings: n('settings') == null ? '' : Kit.plural(n('settings'), 'setting'),
      plans: [n('savedTrip') != null ? `${n('savedTrip') ? Kit.plural(n('savedTrip'), 'trip leg') : 'no saved trip'}` : '', n('savedStays') != null ? Kit.plural(n('savedStays'), 'stay') : ''].filter(Boolean).join(', ') || 'no saved plans',
      alerts: n('alerts') == null ? '' : Kit.plural(n('alerts'), 'alert')
    };
    return items[category] || '';
  }

  const statusRegion = (esc, text, kind = 'status') => `<div class="fk-status${kind === 'error' ? ' error' : ''}" role="${kind === 'error' ? 'alert' : 'status'}" aria-live="${kind === 'error' ? 'assertive' : 'polite'}">${text ? esc(text) : ''}</div>`;

  // ---------- views (state -> HTML; every dynamic value goes through esc) ----------
  function exportView(s, esc) {
    const e = s.export, counts = s.summary.counts;
    const pwProblem = e.password ? Kit.passwordProblem(e.password) : null;
    const mismatch = e.repeat && e.password !== e.repeat;
    const picked = CATEGORIES.filter(c => e.categories[c]);
    const canExport = !e.busy && picked.length && e.password && !pwProblem && e.password === e.repeat;
    return `<form class="fk-form" data-form="export" novalidate>
      <fieldset class="fk-fieldset"><legend>What to include</legend>
        ${s.summary.loading ? '<p class="muted" role="status">Counting what you have…</p>' : ''}
        ${s.summary.error ? `<p class="fk-status error" role="alert">${esc(s.summary.error)} <button type="button" class="btn small" data-action="reload-summary">Try again</button></p>` : ''}
        <div class="fk-checks">${CATEGORIES.map(c => `<label class="check"><input type="checkbox" data-field="category" data-category="${c}"${e.categories[c] ? ' checked' : ''}${e.busy ? ' disabled' : ''}> <span>${esc(CATEGORY_LABELS[c])}${counts ? ` <span class="muted">· ${esc(countText(c, counts))}</span>` : ''}</span></label>`).join('')}</div>
        <p class="muted fk-help">Not included: cached provider results, price history, captures, readiness reports, usage counters, logs and delivery state.</p>
      </fieldset>
      <fieldset class="fk-fieldset"><legend>Credentials</legend>
        <label class="check fk-switch"><input type="checkbox" role="switch" data-field="includeSecrets"${e.includeSecrets ? ' checked' : ''}${e.busy ? ' disabled' : ''}> <span><strong>Include API keys and webhook destination</strong></span></label>
        <p class="muted fk-help">Off by default. If you turn this on, anyone who has the file and its password can use your keys${s.summary.secretsPresent ? '' : ' (you have none saved right now)'}. Your webhook address is treated as a secret too.${e.includeSecrets && !e.categories.settings ? ' Credentials are saved with Settings, which is not selected.' : ''}</p>
      </fieldset>
      <fieldset class="fk-fieldset"><legend>Password</legend>
        <div class="formgrid fk-grid">
          <div><label for="fkExportPw">Password</label><input id="fkExportPw" type="password" autocomplete="new-password" data-field="password" data-focus="export-pw" value="${esc(e.password)}"${e.busy ? ' disabled' : ''} aria-describedby="fkExportPwHelp"></div>
          <div><label for="fkExportPw2">Repeat password</label><input id="fkExportPw2" type="password" autocomplete="new-password" data-field="repeat" data-focus="export-pw2" value="${esc(e.repeat)}"${e.busy ? ' disabled' : ''}${mismatch ? ' aria-invalid="true"' : ''}></div>
        </div>
        <p id="fkExportPwHelp" class="muted fk-help">At least 12 characters. <strong>If you lose this password the file cannot be recovered</strong>: there is no reset and PointPilot does not keep a copy.</p>
        <div class="fk-hint" role="status" aria-live="polite">${esc(pwProblem || (mismatch ? 'The two passwords do not match.' : ''))}</div>
      </fieldset>
      <div class="btnrow"><button type="submit" class="btn primary" data-action="export"${canExport ? '' : ' disabled'}>${e.busy ? 'Encrypting…' : 'Export encrypted backup'}</button></div>
      ${statusRegion(esc, e.error || e.result, e.error ? 'error' : 'status')}
    </form>`;
  }

  function reviewView(s, esc) {
    const r = s.restore, p = r.preview;
    const loading = r.busy;
    const inFile = p.backup.categories;
    const selected = CATEGORIES.filter(c => inFile.includes(c) && r.categories[c]);
    const replaceRisky = r.mode === 'replace';
    const expiry = Date.parse(p.expiresAt);
    const canRestore = !loading && !r.expired && selected.length && (!replaceRisky || r.confirmReplace);
    const countRow = c => { const k = p.counts[c]; return k ? `<li><strong>${esc(CATEGORY_LABELS[c])}</strong>: ${[k.add ? `${k.add} added` : '', k.update ? `${k.update} changed` : '', k.remove ? `${k.remove} removed` : '', k.unchanged ? `${k.unchanged} already the same` : '', k.skipped ? `${k.skipped} kept as yours` : ''].filter(Boolean).join(' · ') || 'nothing to change'}</li>` : ''; };
    return `<div class="fk-review" aria-busy="${loading ? 'true' : 'false'}">
      <h4 tabindex="-1" data-focus="review-heading">Review before restoring</h4>
      <p class="muted">Backup made ${esc(Kit.whenLabel(p.backup.createdAt))} by PointPilot ${esc(p.backup.appVersion)}. Nothing has changed yet.</p>
      <fieldset class="fk-fieldset"><legend>1. What to restore</legend>
        <div class="fk-checks">${CATEGORIES.filter(c => inFile.includes(c)).map(c => `<label class="check"><input type="checkbox" data-field="restoreCategory" data-category="${c}"${r.categories[c] ? ' checked' : ''}${loading ? ' disabled' : ''}> <span>${esc(CATEGORY_LABELS[c])}</span></label>`).join('')}</div>
        ${CATEGORIES.some(c => !inFile.includes(c)) ? `<p class="muted fk-help">Not in this backup: ${esc(CATEGORIES.filter(c => !inFile.includes(c)).map(c => CATEGORY_LABELS[c]).join(', '))}.</p>` : ''}
      </fieldset>
      <fieldset class="fk-fieldset"><legend>2. Merge or replace</legend>
        <label class="check"><input type="radio" name="fkMode" value="merge" data-field="mode"${r.mode === 'merge' ? ' checked' : ''}${loading ? ' disabled' : ''}> <span><strong>Merge</strong>: keep what you have and add what is missing. Where both differ you choose; the default is to keep yours. Balances are never added together.</span></label>
        <label class="check"><input type="radio" name="fkMode" value="replace" data-field="mode"${r.mode === 'replace' ? ' checked' : ''}${loading ? ' disabled' : ''}> <span><strong>Replace</strong>: make the selected categories match the backup. Anything of yours that is not in the backup is removed.</span></label>
      </fieldset>
      ${p.conflicts.length ? `<fieldset class="fk-fieldset"><legend>3. Differences to decide (${p.conflicts.length})</legend>
        <ul class="fk-conflicts">${p.conflicts.map(c => `<li><div><strong>${esc(c.label)}</strong><div class="muted">${c.sensitive ? 'A saved credential differs from the one in the backup.' : `Yours: ${esc(c.existing || '')} · Backup: ${esc(c.incoming || '')}`}</div></div>
          <label class="fk-sel"><span class="fk-sr">Choice for ${esc(c.label)}</span><select data-field="choice" data-conflict="${esc(c.id)}"${loading ? ' disabled' : ''}>${c.actionOptions.map(a => `<option value="${esc(a)}"${(r.choices[c.id] || c.resolution) === a ? ' selected' : ''}>${esc(ACTION_LABELS[a] || a)}</option>`).join('')}</select></label></li>`).join('')}</ul></fieldset>` : ''}
      <fieldset class="fk-fieldset"><legend>${p.conflicts.length ? '4' : '3'}. Sensitive options (all off by default)</legend>
        ${p.containsSecrets ? `<label class="check"><input type="checkbox" data-field="option" data-option="restoreSecrets"${r.options.restoreSecrets ? ' checked' : ''}${loading ? ' disabled' : ''}> <span><strong>Restore API keys and webhook destination</strong> from this backup. They replace saved ones only when this is on.</span></label>` : '<p class="muted fk-help">This backup contains no API keys or webhook address. Your saved credentials are never touched by a restore unless the backup carries them and you opt in.</p>'}
        ${inFile.includes('alerts') ? `<label class="check"><input type="checkbox" data-field="option" data-option="activateImportedAlerts"${r.options.activateImportedAlerts ? ' checked' : ''}${loading ? ' disabled' : ''}> <span><strong>Turn imported alerts back on</strong> if they were on. Otherwise they arrive turned off and nothing is checked or sent until you switch them on.</span></label>` : ''}
        ${inFile.includes('settings') ? `<label class="check"><input type="checkbox" data-field="option" data-option="enableLaunchAtLogin"${r.options.enableLaunchAtLogin ? ' checked' : ''}${loading ? ' disabled' : ''}> <span><strong>Apply "Start with Windows"</strong> if the backup turns it on.</span></label>` : ''}
      </fieldset>
      <section class="fk-effects" aria-labelledby="fkEffectsHead"><h4 id="fkEffectsHead">What will happen</h4>
        ${loading ? '<p class="muted" role="status">Updating the review…</p>' : ''}
        <ul>${p.effects.map(x => `<li${x.sensitive ? ' class="fk-sensitive"' : ''}>${x.sensitive ? '<span class="tag warn">SENSITIVE</span> ' : ''}${esc(x.text)}</li>`).join('')}</ul>
        <ul class="fk-counts">${selected.map(countRow).join('')}</ul>
        ${p.warnings.length ? `<div class="warnbox" role="note"><ul>${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      </section>
      ${replaceRisky ? `<label class="check fk-confirm"><input type="checkbox" data-field="confirmReplace"${r.confirmReplace ? ' checked' : ''}${loading ? ' disabled' : ''}> <span>I understand Replace removes or overwrites the items listed above.</span></label>` : ''}
      <p class="muted fk-help">${r.expired ? '<strong>This review expired.</strong>' : `This review stays valid until ${esc(Number.isFinite(expiry) ? new Date(expiry).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'a few minutes from now')}. If your data changes first, you will be asked to review again.`}</p>
      <div class="btnrow"><button type="button" class="btn primary" data-action="restore"${canRestore ? '' : ' disabled'}>${r.busy && r.restoring ? 'Restoring…' : 'Restore now'}</button><button type="button" class="btn" data-action="restore-reset">${r.expired ? 'Start over' : 'Cancel'}</button></div>
      ${statusRegion(esc, r.error, 'error')}
    </div>`;
  }

  function restoreView(s, esc) {
    const r = s.restore;
    if (r.step === 'done') {
      const applied = Object.entries(r.done.appliedCounts || {}).filter(([, n]) => n > 0);
      return `<div class="fk-done" role="status"><h4 tabindex="-1" data-focus="restore-heading">Restore finished</h4>
        <p>${applied.length ? esc(applied.map(([c, n]) => `${CATEGORY_LABELS[c] || c}: ${n} changed`).join(' · ')) : 'Nothing needed to change.'}</p>
        ${(r.done.warnings || []).length ? `<div class="warnbox"><ul>${r.done.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        <p class="muted">Your views have been refreshed. Imported alerts stay off until you turn them on in Alerts.</p>
        <div class="btnrow"><button type="button" class="btn" data-action="restore-reset">Done</button></div></div>`;
    }
    if (r.step === 'review' && r.preview) return reviewView(s, esc);
    const havefile = Boolean(r.envelope);
    return `<form class="fk-form" data-form="restore-open" novalidate>
      <p>Choose a PointPilot backup (<code>.ppbackup</code>) and enter its password. You will see exactly what would change before anything is written.</p>
      <div class="btnrow">${r.hasDesktop ? `<button type="button" class="btn" data-action="choose-file"${r.busy ? ' disabled' : ''}>Choose backup file…</button>` : `<label class="fk-file"><span class="fk-sr">Backup file</span><input type="file" accept=".ppbackup,.json,application/json" data-field="file" data-focus="restore-file"${r.busy ? ' disabled' : ''}></label>`}
        ${havefile ? `<span class="tag">${esc(r.fileName || 'Backup file')} selected</span>` : ''}</div>
      ${havefile ? `<div class="formgrid fk-grid"><div class="span-2"><label for="fkRestorePw">Backup password</label><input id="fkRestorePw" type="password" autocomplete="off" data-field="restorePassword" data-focus="restore-pw" value="${esc(r.password)}"${r.busy ? ' disabled' : ''}></div></div>
        <div class="btnrow"><button type="submit" class="btn primary" data-action="preview"${r.busy || !r.password ? ' disabled' : ''}>${r.busy ? 'Decrypting…' : 'Review what would change'}</button>${r.busy ? '<button type="button" class="btn" data-action="cancel-preview">Cancel</button>' : '<button type="button" class="btn ghost" data-action="restore-reset">Choose a different file</button>'}</div>` : ''}
      ${r.notice ? `<p class="muted" role="status">${esc(r.notice)}</p>` : ''}
      ${statusRegion(esc, r.error, 'error')}
    </form>`;
  }

  function view(state, esc) {
    return `<div class="fk-tabs seg" role="group" aria-label="Backup or restore">
        <button type="button" class="seg${state.tab === 'export' ? ' active' : ''}" aria-pressed="${state.tab === 'export'}" data-action="tab" data-tab="export" data-focus="tab-export">Export</button>
        <button type="button" class="seg${state.tab === 'restore' ? ' active' : ''}" aria-pressed="${state.tab === 'restore'}" data-action="tab" data-tab="restore" data-focus="tab-restore">Restore</button></div>
      <div class="fk-panel" role="region" aria-label="${state.tab === 'export' ? 'Export a backup' : 'Restore a backup'}">${state.tab === 'export' ? exportView(state, esc) : restoreView(state, esc)}</div>`;
  }

  // ---------- mount ----------
  function mount({ root: host, api, esc, createGuard, desktop = null, onDataRestored = () => {}, onPlanChanged = () => {} }) {
    const state = initialState();
    state.restore.hasDesktop = Boolean(desktop && desktop.openBackup);
    const previewGuard = createGuard();
    const summaryGuard = createGuard();
    let expiryTimer = null;

    const draw = () => Kit.renderInto(host, view(state, esc));
    const moveFocus = key => { const el = host.querySelector && host.querySelector(`[data-focus="${key}"]`); if (el && el.focus) el.focus(); };
    const failure = e => ERRORS[e?.code] || Kit.errorMessage(e, ERRORS, 'Something went wrong. Your data was not changed.');

    async function loadSummary() {
      const token = summaryGuard.next();
      state.summary = { ...state.summary, loading: true, error: null };
      draw();
      try {
        const r = await api('/api/backup/summary', { signal: token.signal });
        if (!summaryGuard.isCurrent(token)) return;
        state.summary = { loading: false, error: null, counts: r.counts, secretsPresent: Boolean(r.secretsPresent) };
      } catch (e) {
        if (!summaryGuard.isCurrent(token) || e?.name === 'AbortError') return;
        state.summary = { ...state.summary, loading: false, error: 'Could not count what is included.' };
      }
      draw();
    }

    async function doExport() {
      const e = state.export;
      const picked = CATEGORIES.filter(c => e.categories[c]);
      const problem = Kit.passwordProblem(e.password);
      if (!picked.length) { e.error = 'Choose at least one category.'; return draw(); }
      if (problem) { e.error = problem; return draw(); }
      if (e.password !== e.repeat) { e.error = 'The two passwords do not match.'; return draw(); }
      const password = e.password;
      e.password = ''; e.repeat = ''; e.busy = true; e.error = null; e.result = null;
      draw();
      try {
        const r = await api('/api/backup/export', { method: 'POST', body: { password, includeSecrets: e.includeSecrets && e.categories.settings, categories: picked } });
        const content = JSON.stringify(r.envelope);
        if (desktop && desktop.saveArtifact) {
          const saved = await desktop.saveArtifact({ kind: 'backup', content });
          if (saved && saved.cancelled) e.result = 'Save cancelled. Nothing was saved.';
          else if (saved && saved.ok) e.result = `Saved ${saved.filename}.${r.includesSecrets ? ' This file contains your API keys and webhook address.' : ''} Keep the password safe: it cannot be recovered.`;
          else e.error = ERRORS[saved?.code] || 'The backup could not be saved.';
        } else {
          Kit.downloadText(Kit.safeFilename(r.filename, 'pointpilot-backup.ppbackup'), content);
          e.result = `Downloaded ${Kit.safeFilename(r.filename, 'pointpilot-backup.ppbackup')}.${r.includesSecrets ? ' This file contains your API keys and webhook address.' : ''} Keep the password safe: it cannot be recovered.`;
        }
        if (r.warnings && r.warnings.length) e.result = `${e.result || ''} ${r.warnings.join(' ')}`.trim();
      } catch (err) { e.error = failure(err); }
      e.busy = false;
      draw();
    }

    function categoriesForPreview() { return CATEGORIES.filter(c => state.restore.preview ? state.restore.preview.backup.categories.includes(c) && state.restore.categories[c] : true); }

    function startExpiryTimer(preview) {
      clearTimeout(expiryTimer);
      const ms = Date.parse(preview.expiresAt) - Date.now();
      if (Number.isFinite(ms)) expiryTimer = setTimeout(() => { state.restore.expired = true; draw(); }, Math.max(0, ms));
    }

    async function runPreview(body) {
      const r = state.restore;
      const token = previewGuard.next();
      r.busy = true; r.error = null; draw();
      try {
        const preview = await api('/api/backup/preview', { method: 'POST', body, signal: token.signal });
        if (!previewGuard.isCurrent(token)) return;
        r.preview = preview;
        r.choices = Object.fromEntries(Object.entries(r.choices).filter(([id]) => preview.conflicts.some(c => c.id === id)));
        const entering = r.step !== 'review';
        r.step = 'review';
        r.expired = false;
        if (!Object.keys(r.categories).length) r.categories = Object.fromEntries(CATEGORIES.map(c => [c, preview.backup.categories.includes(c)]));
        startExpiryTimer(preview);
        r.busy = false;
        draw();
        if (entering) moveFocus('review-heading');
        return;
      } catch (e) {
        if (!previewGuard.isCurrent(token) || e?.name === 'AbortError') return;
        if (e.code === 'PREVIEW_EXPIRED') { r.expired = true; r.step = r.envelope ? 'choose' : 'choose'; r.preview = null; r.notice = ERRORS.PREVIEW_EXPIRED; }
        else r.error = failure(e);
      }
      r.busy = false;
      draw();
    }

    async function preview() {
      const r = state.restore;
      if (!r.envelope || !r.password) return;
      const password = r.password;
      r.password = '';
      r.categories = {}; r.choices = {}; r.confirmReplace = false;
      await runPreview({ password, envelope: r.envelope, mode: r.mode, categories: CATEGORIES, options: r.options });
    }

    function rePreview() {
      const r = state.restore;
      const cats = categoriesForPreview();
      if (!r.preview || !cats.length) { draw(); return Promise.resolve(); }
      r.confirmReplace = false;
      return runPreview({ previewId: r.preview.previewId, mode: r.mode, categories: cats, choices: r.choices, options: r.options });
    }

    async function chooseFile() {
      const r = state.restore;
      r.error = null; r.notice = null;
      try {
        const opened = await desktop.openBackup();
        if (opened && opened.cancelled) { r.notice = 'No file chosen.'; return draw(); }
        if (!opened || !opened.ok) { r.error = ERRORS[opened?.code] || 'The file could not be opened.'; return draw(); }
        acceptText(opened.content, opened.filename);
      } catch (e) { r.error = failure(e); draw(); }
    }

    function acceptText(text, name) {
      const r = state.restore;
      try { r.envelope = JSON.parse(text); r.fileName = Kit.safeFilename(name, 'Backup file'); r.error = null; }
      catch { r.envelope = null; r.error = ERRORS.BACKUP_INVALID; }
      draw();
    }

    async function chooseBrowserFile(file) {
      const r = state.restore;
      r.error = null; r.notice = null;
      if (!file) return;
      try { acceptText(await Kit.readFileText(file, MAX_BACKUP_BYTES), file.name); }
      catch (e) { r.error = failure(e); draw(); }
    }

    async function doRestore() {
      const r = state.restore;
      const p = r.preview;
      if (!p || r.expired || r.busy) return;
      r.busy = true; r.restoring = true; r.error = null; draw();
      try {
        const done = await api('/api/backup/restore', { method: 'POST', body: { previewId: p.previewId, restoreSecrets: p.options.restoreSecrets, activateImportedAlerts: p.options.activateImportedAlerts, enableLaunchAtLogin: p.options.enableLaunchAtLogin } });
        clearTimeout(expiryTimer);
        state.restore = { ...freshRestore(), hasDesktop: r.hasDesktop, step: 'done', done };
        draw();
        moveFocus('restore-heading');
        try { await (desktop && desktop.settingsChanged ? desktop.settingsChanged() : null); } catch { /* the shell re-reads settings on its next change */ }
        await onDataRestored(done);
        onPlanChanged();
        loadSummary();
      } catch (e) {
        r.busy = false; r.restoring = false;
        if (e.code === 'PREVIEW_STALE' || e.code === 'PREVIEW_EXPIRED' || e.code === 'PREVIEW_OPTIONS_CHANGED') {
          clearTimeout(expiryTimer);
          r.step = 'choose'; r.preview = null; r.notice = failure(e); r.error = null;
        } else r.error = failure(e);
      }
      draw();
    }

    function resetRestore() {
      clearTimeout(expiryTimer);
      previewGuard.cancel();
      state.restore = { ...freshRestore(), hasDesktop: state.restore.hasDesktop };
      draw();
    }

    // ----- events (delegated; handlers read data attributes from the event target) -----
    host.addEventListener('click', ev => {
      const el = ev.target.closest && ev.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;
      if (action === 'tab') { state.tab = el.dataset.tab; return draw(); }
      if (action === 'reload-summary') return loadSummary();
      if (action === 'choose-file') return Kit.guarded(chooseFile, e => { state.restore.error = failure(e); draw(); })();
      if (action === 'cancel-preview') { previewGuard.cancel(); state.restore.busy = false; state.restore.notice = 'Cancelled. Nothing was changed.'; return draw(); }
      if (action === 'restore-reset') return resetRestore();
      if (action === 'restore') return doRestore();
    });
    host.addEventListener('submit', ev => {
      ev.preventDefault?.();
      const form = ev.target.dataset && ev.target.dataset.form;
      if (form === 'export') doExport();
      if (form === 'restore-open') preview();
    });
    host.addEventListener('input', ev => {
      const t = ev.target, f = t.dataset && t.dataset.field;
      if (f === 'password' || f === 'repeat') { state.export[f] = t.value; return draw(); }
      if (f === 'restorePassword') { state.restore.password = t.value; return draw(); }
    });
    host.addEventListener('change', ev => {
      const t = ev.target, f = t.dataset && t.dataset.field;
      if (!f) return;
      const r = state.restore;
      if (f === 'category') { state.export.categories[t.dataset.category] = Boolean(t.checked); state.export.error = null; return draw(); }
      if (f === 'includeSecrets') { state.export.includeSecrets = Boolean(t.checked); return draw(); }
      if (f === 'file') return chooseBrowserFile(t.files && t.files[0]);
      if (f === 'restoreCategory') { r.categories[t.dataset.category] = Boolean(t.checked); r.choices = {}; return rePreview(); }
      if (f === 'mode') { r.mode = t.value === 'replace' ? 'replace' : 'merge'; r.choices = {}; return rePreview(); }
      if (f === 'choice') { r.choices[t.dataset.conflict] = t.value; return rePreview(); }
      if (f === 'option') {
        r.options = { ...r.options, [t.dataset.option]: Boolean(t.checked) };
        if (t.dataset.option === 'restoreSecrets') r.choices = Object.fromEntries(Object.entries(r.choices).filter(([id]) => !/^settings:(seatsAeroApiKey|travelpayoutsToken|serpApiKey|webhookUrl)$/.test(id)));
        return rePreview();
      }
      if (f === 'confirmReplace') { r.confirmReplace = Boolean(t.checked); return draw(); }
    });

    loadSummary();
    return {
      refresh: loadSummary,
      destroy() { clearTimeout(expiryTimer); previewGuard.cancel(); summaryGuard.cancel(); host.innerHTML = ''; },
      get state() { return state; }
    };
  }

  root.PPFeatures = root.PPFeatures || {};
  root.PPFeatures.backup = { mount, view, initialState, ERRORS, CATEGORY_LABELS };
})(typeof window !== 'undefined' ? window : globalThis);
