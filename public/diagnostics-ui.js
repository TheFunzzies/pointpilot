'use strict';
// Redacted diagnostics export. Shows exactly the sanitized bundle that "Export diagnostics" will save.
// Mounted by app.js: PPFeatures.diagnostics.mount({ root, api, esc, safeUrl, createGuard, onPlanChanged, desktop }).
// The bundle is saved locally (native dialog or browser download); nothing is sent anywhere.
(function (root) {
  const Kit = root.PPKit;
  const REQUEST_ROWS = 20;
  const ERRORS = {
    DIAGNOSTICS_PREVIEW_EXPIRED: 'The preview expired, so it was refreshed. Review it and export again.',
    DIAGNOSTICS_TOO_LARGE: 'The diagnostics bundle is larger than the 2 MiB limit.',
    INVALID_DIAGNOSTICS_REQUEST: 'The request was not accepted.',
    UNTRUSTED_SENDER: 'The file dialog is not available from this window.',
    DIALOG_BUSY: 'A file dialog is already open.',
    WRITE_FAILED: 'The file could not be saved. Choose another location.',
    TOO_LARGE: 'The diagnostics bundle is too large to save.',
    INVALID_CONTENT: 'The bundle could not be saved.'
  };

  const initialState = () => ({ phase: 'loading', error: null, preview: null, busy: null, message: null, confirmClear: false, expired: false });

  const kb = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`);
  const val = v => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  const rows = (esc, pairs) => `<dl class="fk-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(val(v))}</dd>`).join('')}</dl>`;

  function previewSections(bundle, esc) {
    const app = bundle.app || {}, cov = bundle.coverage || {}, usage = bundle.usage || {};
    const freshness = Object.values(bundle.freshness || {});
    const requests = Array.isArray(bundle.requests) ? bundle.requests : [];
    const snapshots = Array.isArray(bundle.alerts?.snapshots) ? bundle.alerts.snapshots : [];
    const events = Array.isArray(bundle.alerts?.events) ? bundle.alerts.events : [];
    const configured = app.configured || {};
    return `<section aria-labelledby="dgApp"><h4 id="dgApp">App and environment</h4>${rows(esc, [
      ['PointPilot version', app.version], ['Mode', app.mode], ['Platform', [app.platform, app.architecture].filter(Boolean).join(' ')], ['Node', app.nodeVersion],
      ['Electron', app.electronVersion], ['Chromium', app.chromiumVersion], ['Locale', app.locale], ['Time zone', app.timezone], ['Alert check interval (minutes)', app.monitorIntervalMinutes],
      ['Sources configured', Object.entries(configured).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none']])}
      <p class="muted fk-help">Only yes/no flags for configured sources are included. No keys, hostname, user name, folders or environment variables.</p></section>
    <section aria-labelledby="dgCoverage"><h4 id="dgCoverage">Coverage</h4>${rows(esc, [
      ['Recording started', cov.recordingStartedAt ? Kit.whenLabel(cov.recordingStartedAt) : null], ['Requests kept', cov.requestCount], ['Alert events kept', cov.alertEventCount],
      ['Request retention', cov.requestRetention], ['Alert retention', cov.alertRetention], ['Storage', cov.persistence]])}
      ${cov.historyAvailable ? '' : '<p class="note" role="note">Nothing has been recorded since installation or the last update, so there is no request or alert history yet. Current environment and source status are still shown. Older history is not reconstructed.</p>'}</section>
    <section aria-labelledby="dgUsage"><h4 id="dgUsage">API usage</h4>
      <p class="muted fk-help">${esc(usage.label || 'attempted requests recorded by Point Pilot')}. These are not provider-billed charges.</p>
      ${rows(esc, [['Day (UTC)', usage.day], ['Month', usage.month], ['seats.aero flight requests today', usage.calls], ['rooms.aero hotel requests today', usage.roomsCalls], ['Travelpayouts requests today', usage.tpCalls], ['SerpApi requests this month', usage.serpCalls]])}</section>
    <section aria-labelledby="dgFresh"><h4 id="dgFresh">Source freshness</h4>
      ${freshness.length ? `<div class="tableScroll"><table class="fk-table"><caption class="fk-sr">Per-source freshness</caption><thead><tr><th scope="col">Source</th><th scope="col">Last attempt</th><th scope="col">Last success</th><th scope="col">Last failure</th><th scope="col">Provider data observed</th><th scope="col">Samples</th><th scope="col">Complete?</th></tr></thead><tbody>
        ${freshness.map(f => `<tr><th scope="row">${esc(f.source)}</th><td>${esc(f.lastAttemptAt ? Kit.whenLabel(f.lastAttemptAt) : 'unknown')}</td><td>${esc(f.lastSuccessAt ? Kit.whenLabel(f.lastSuccessAt) : 'never recorded')}</td><td>${esc(val(f.lastFailureCode))}</td><td>${esc(f.providerObservedMinAt || f.providerObservedMaxAt ? `${f.providerObservedMinAt ? Kit.whenLabel(f.providerObservedMinAt) : '?'} to ${f.providerObservedMaxAt ? Kit.whenLabel(f.providerObservedMaxAt) : '?'}` : 'unknown')}</td><td>${esc(val(f.sampleCount))}</td><td>${esc(f.completeness || 'unknown')}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted fk-help">When data was fetched and when the provider says it observed it are different. A recent fetch does not make every route or hotel fresh.</p>` : '<p class="muted">No source status recorded yet. Unknown is shown as unknown, never as fresh.</p>'}</section>
    <section aria-labelledby="dgReq"><h4 id="dgReq">Recent requests</h4>
      ${requests.length ? `<div class="tableScroll"><table class="fk-table"><caption class="fk-sr">Most recent provider requests</caption><thead><tr><th scope="col">Time</th><th scope="col">Service</th><th scope="col">Operation</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">Outcome</th><th scope="col">Error code</th></tr></thead><tbody>
        ${requests.slice(-REQUEST_ROWS).reverse().map(r => `<tr><td>${esc(r.at ? Kit.whenLabel(r.at) : 'unknown')}</td><td>${esc(val(r.service))}</td><td>${esc(val(r.operation))}</td><td>${esc(val(r.status))}</td><td>${esc(r.durationMs == null ? '—' : `${r.durationMs} ms`)}</td><td>${esc(val(r.outcome))}</td><td>${esc(val(r.errorCode))}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted fk-help">${requests.length > REQUEST_ROWS ? `Showing the latest ${REQUEST_ROWS} of ${requests.length}. The saved file has all ${requests.length}.` : `${Kit.plural(requests.length, 'request')}.`} Requests record timing and outcome only: no addresses, routes, dates, headers or response contents.</p>` : '<p class="muted">No requests recorded yet.</p>'}</section>
    <section aria-labelledby="dgAlerts"><h4 id="dgAlerts">Alerts (anonymous)</h4>
      <p class="muted fk-help">Alerts appear as random labels that are only meaningful inside this one file. No titles, searches or destinations are included.</p>
      ${snapshots.length ? `<div class="tableScroll"><table class="fk-table"><caption class="fk-sr">Alert status snapshot</caption><thead><tr><th scope="col">Alert</th><th scope="col">Kind</th><th scope="col">Active</th><th scope="col">Last check</th><th scope="col">Status</th><th scope="col">Error code</th></tr></thead><tbody>
        ${snapshots.slice(0, 50).map(a => `<tr><th scope="row">${esc(String(a.id || '').slice(0, 8))}</th><td>${esc(val(a.kind))}</td><td>${esc(val(a.active))}</td><td>${esc(a.lastAttemptAt ? Kit.whenLabel(a.lastAttemptAt) : 'never')}</td><td>${esc(val(a.lastStatus))}</td><td>${esc(val(a.lastErrorCode))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No alerts.</p>'}
      <p class="muted fk-help">${Kit.plural(events.length, 'check or delivery event')} recorded.</p></section>`;
  }

  function view(state, esc) {
    const p = state.preview;
    const body = state.phase === 'loading' && !p ? '<p class="muted" role="status">Preparing a preview from local records…</p>'
      : state.phase === 'error' && !p ? `<div class="fk-status error" role="alert">${esc(state.error || 'The preview could not be created.')} <button type="button" class="btn small" data-action="refresh-preview" data-focus="dg-retry">Try again</button></div>`
      : p ? `<div class="fk-meta"><span class="tag">${esc(kb(p.summary.bytes))}</span> <span class="muted">Preview valid until ${esc(new Date(Date.parse(p.expiresAt)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}${state.expired ? ' — expired, refresh it before exporting' : ''}. The saved file is exactly this content.</span></div>${previewSections(p.bundle, esc)}` : '';
    return `<div class="fk-diag" aria-busy="${state.busy || state.phase === 'loading' ? 'true' : 'false'}">
      <p>Create a support bundle that explains failing searches and alerts <strong>without</strong> your wallet, keys, webhook address, travel plans or alert titles. It is saved on this computer; PointPilot does not send it anywhere.</p>
      <div class="btnrow">
        <button type="button" class="btn primary" data-action="export" data-focus="dg-export"${!p || state.busy || state.expired ? ' disabled' : ''}>${state.busy === 'export' ? 'Saving…' : 'Export diagnostics'}</button>
        <button type="button" class="btn" data-action="refresh-preview" data-focus="dg-refresh"${state.busy || state.phase === 'loading' ? ' disabled' : ''}>Refresh preview</button>
        ${state.confirmClear ? `<span class="fk-confirm" role="group" aria-label="Confirm clearing diagnostic history"><span>Clear recorded requests, source status and alert events? Usage counters, alerts and your wallet are not touched.</span> <button type="button" class="btn small danger" data-action="clear-confirmed" data-focus="dg-clear-yes">Yes, clear history</button> <button type="button" class="btn small" data-action="clear-cancel">Keep it</button></span>`
          : `<button type="button" class="btn ghost" data-action="clear" data-focus="dg-clear"${state.busy ? ' disabled' : ''}>Clear diagnostic history</button>`}
      </div>
      <div class="fk-status${state.error && p ? ' error' : ''}" role="${state.error && p ? 'alert' : 'status'}" aria-live="polite">${esc((p && state.error) || state.message || '')}</div>
      ${body}</div>`;
  }

  function mount({ root: host, api, esc, createGuard, desktop = null }) {
    const state = initialState();
    const guard = createGuard();
    let expiryTimer = null;
    const draw = () => Kit.renderInto(host, view(state, esc));
    const failure = e => ERRORS[e?.code] || Kit.errorMessage(e, ERRORS, 'Something went wrong.');

    async function refresh({ keepMessage = false } = {}) {
      const token = guard.next();
      state.phase = 'loading'; state.error = null; state.expired = false; if (!keepMessage) state.message = null;
      draw();
      try {
        const preview = await api('/api/diagnostics/preview', { method: 'POST', body: {}, signal: token.signal });
        if (!guard.isCurrent(token)) return;
        state.preview = preview; state.phase = 'ready';
        clearTimeout(expiryTimer);
        const ms = Date.parse(preview.expiresAt) - Date.now();
        if (Number.isFinite(ms)) expiryTimer = setTimeout(() => { state.expired = true; draw(); }, Math.max(0, ms));
      } catch (e) {
        if (!guard.isCurrent(token) || e?.name === 'AbortError') return;
        state.phase = 'error'; state.error = failure(e);
      }
      draw();
    }

    async function exportBundle() {
      const p = state.preview;
      if (!p || state.busy) return;
      state.busy = 'export'; state.error = null; state.message = null; draw();
      try {
        const r = await api('/api/diagnostics/export', { method: 'POST', body: { exportId: p.exportId } });
        const content = JSON.stringify(r.bundle, null, 2);
        if (desktop && desktop.saveArtifact) {
          const saved = await desktop.saveArtifact({ kind: 'diagnostics', content });
          if (saved && saved.cancelled) state.message = 'Save cancelled. Nothing was saved.';
          else if (saved && saved.ok) state.message = `Saved ${saved.filename}. It was not sent anywhere.`;
          else state.error = ERRORS[saved?.code] || 'The file could not be saved.';
        } else {
          const name = Kit.safeFilename(r.filename, 'pointpilot-diagnostics.json');
          Kit.downloadText(name, content);
          state.message = `Downloaded ${name}. It was not sent anywhere.`;
        }
      } catch (e) {
        if (e.code === 'DIAGNOSTICS_PREVIEW_EXPIRED') { state.busy = null; state.message = ERRORS.DIAGNOSTICS_PREVIEW_EXPIRED; return refresh({ keepMessage: true }); }
        state.error = failure(e);
      }
      state.busy = null; draw();
    }

    async function clearHistory() {
      state.busy = 'clear'; state.confirmClear = false; state.error = null; draw();
      try {
        await api('/api/diagnostics/history', { method: 'DELETE', body: {} });
        state.busy = null; state.message = 'Diagnostic history cleared.';
        return refresh({ keepMessage: true });
      } catch (e) { state.busy = null; state.error = failure(e); draw(); }
    }

    host.addEventListener('click', ev => {
      const el = ev.target.closest && ev.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'refresh-preview') return refresh();
      if (a === 'export') return exportBundle();
      if (a === 'clear') { state.confirmClear = true; draw(); const yes = host.querySelector && host.querySelector('[data-focus="dg-clear-yes"]'); if (yes) yes.focus(); return; }
      if (a === 'clear-cancel') { state.confirmClear = false; draw(); const b = host.querySelector && host.querySelector('[data-focus="dg-clear"]'); if (b) b.focus(); return; }
      if (a === 'clear-confirmed') return clearHistory();
    });

    refresh();
    return { refresh, destroy() { clearTimeout(expiryTimer); guard.cancel(); host.innerHTML = ''; }, get state() { return state; } };
  }

  root.PPFeatures = root.PPFeatures || {};
  root.PPFeatures.diagnostics = { mount, view, initialState, previewSections, ERRORS };
})(typeof window !== 'undefined' ? window : globalThis);
