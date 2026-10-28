'use strict';
// Booking-readiness panel for Trip Builder and Stay Plan.
// Mounted by app.js: PPFeatures.readiness.mount({ root, api, esc, safeUrl, createGuard, onPlanChanged, navigate }).
// Honest wording rules: "Refresh availability", never a claim of live confirmation; cached evidence says cached; what the user
// confirmed says "User confirmed". Go means no detected blocker, never a booking guarantee. Nothing here moves
// points, books or buys: it only reads and records what the user confirms.
(function (root) {
  const Kit = root.PPKit;
  const CATEGORY_ORDER = ['availability', 'funding', 'transfers', 'connections', 'fees'];
  const CATEGORY_LABELS = { availability: 'Availability', funding: 'Funding and transfers', transfers: 'Funding and transfers', connections: 'Connections', fees: 'Taxes and fees' };
  const STATUS_TEXT = { pass: 'OK', caution: 'CAUTION', stop: 'STOP', unknown: 'UNKNOWN' };
  const VERDICT_TEXT = {
    Go: 'No blocker detected. This is not a booking guarantee: availability can change before you book.',
    Caution: 'Some facts are unconfirmed or need review. Resolve the items below before moving points.',
    Stop: 'A blocker was found. Do not transfer points for this selection until it is resolved.'
  };
  const METHOD_TEXT = { cached: 'Cached provider availability', live: 'Live provider check', manual: 'User confirmed at the program', unsupported: 'Not checked (unsupported or no data)' };
  const MANUAL_CODES = ['AVAILABILITY_UNVERIFIED', 'AVAILABILITY_CACHED', 'AVAILABILITY_NOT_FOUND', 'SEATS_UNKNOWN', 'ROOMS_UNKNOWN', 'FEES_UNKNOWN'];
  const REFRESH_CODES = ['AVAILABILITY_UNVERIFIED', 'AVAILABILITY_CACHED', 'AVAILABILITY_NOT_FOUND', 'ROOMS_UNKNOWN', 'HOTEL_REFRESH_QUEUED'];
  const ERRORS = {
    EMPTY_PLAN: 'There is nothing to check yet.',
    PLAN_CHANGED: 'The plan, your wallet or the transfer data changed. Run the check again.',
    CHECK_IN_PROGRESS: 'A check is already running. Wait for it to finish.',
    API_RATE_LIMIT: 'The provider quota or allowance is used up for now. Try again later.',
    API_AUTH: 'The provider rejected your key. Check it in Data & System.',
    NO_API_KEY: 'No seats.aero key is saved, so availability cannot be refreshed. Add one in Data & System, or confirm at the program.',
    API_ERROR: 'The provider could not be reached or returned an error.',
    BAD_INPUT: 'That request was not accepted.',
    UNSUPPORTED_CHECK: 'This selection cannot be refreshed automatically. Confirm it at the program.',
    PLAN_LIMIT: 'Readiness checks support up to 6 flight legs and 20 stays.'
  };

  const initialState = () => ({ open: false, scope: null, phase: 'idle', report: null, current: false, planHash: null, plan: { items: [] }, error: null, errorCode: null, notice: null, confirming: null, confirmError: null, refreshAsk: null, busy: null, refreshReceipt: null, now: Date.now() });

  const selectionLabel = (plan, id) => (plan.items.find(i => i.id === id) || {}).label || null;

  /** What a check will cover, for the progress list and for naming each item's flight or stay. */
  function planItems(scope, trip, stay) {
    const items = [];
    if (scope === 'trip') for (const s of trip?.segments || []) if (s.award) items.push({ id: s.id, kind: 'flight', label: `${s.award.origin} to ${s.award.destination} on ${s.award.date} (${s.award.programName || s.award.program})`, hotel: false });
    for (const s of (stay?.stays) || []) items.push({ id: s.id, kind: 'hotel', label: `${s.name || 'Hotel'}, ${s.checkIn} to ${s.checkOut}`, hotel: true, refreshable: s.dataSource === 'rooms.aero' && Boolean(s.hotelId) });
    return items;
  }

  function errorInfo(e) {
    const code = e && e.code;
    const text = ERRORS[code] || (e && e.status === 429 ? ERRORS.API_RATE_LIMIT : Kit.errorMessage(e, ERRORS, 'The check could not be completed.'));
    const settings = ['API_AUTH', 'NO_API_KEY', 'API_RATE_LIMIT'].includes(code) || (e && e.status === 429);
    return { text, settings, retry: !['EMPTY_PLAN', 'PLAN_LIMIT'].includes(code) };
  }

  function confirmationFormProblem(form, itemCode) {
    let url;
    try { url = new URL(String(form.sourceUrl || '')); } catch { return 'Enter the program page address, starting with https://'; }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || String(form.sourceUrl).length > 2048) return 'Use an https:// page address without a password, ? query or # fragment.';
    if (itemCode === 'FEES_UNKNOWN') {
      const value = Number(form.amount);
      if (form.amount === '' || form.amount == null || !Number.isFinite(value) || value < 0 || value > 1e7) return 'Enter the total award taxes and fees as a number, 0 or more.';
      if (!/^[A-Z]{3}$/.test(String(form.currency || '').toUpperCase())) return 'Enter a three-letter currency code, such as USD.';
    }
    return null;
  }

  function evidenceLine(ev, esc, safeUrl, now) {
    if (!ev) return '';
    const method = METHOD_TEXT[ev.method] || 'Evidence';
    const src = safeUrl(ev.source);
    const parts = [
      `<span class="tag muted">${esc(method)}</span>`,
      `Checked ${esc(Kit.whenLabel(ev.requestedAt))}`,
      ev.observedAt ? `Provider observed ${esc(Kit.whenLabel(ev.observedAt))} (${esc(Kit.ageLabel(ev.observedAt, now))})` : 'Provider observation time not reported',
      src ? `Source: <a href="${esc(src)}" target="_blank" rel="noreferrer">program page ↗</a>` : (ev.source ? `Source: ${esc(ev.source)}` : ''),
      ev.complete === false ? 'Partial or incomplete result' : ''
    ].filter(Boolean);
    return `<div class="fk-evidence muted">${parts.join(' · ')}</div>`;
  }

  // A check can come back HTTP 200 with a partial report whose items say the provider rejected the key or the quota is gone.
  const PROVIDER_SETTINGS = ['API_AUTH', 'NO_API_KEY', 'API_RATE_LIMIT'];
  const providerHint = it => {
    const pc = it.details && it.details.providerCode;
    if (!pc || !(PROVIDER_SETTINGS.includes(pc) || pc === 'PROVIDER_FAILURE')) return null;
    return { code: pc, text: pc === 'PROVIDER_FAILURE' ? ERRORS.API_ERROR : ERRORS[pc], settings: PROVIDER_SETTINGS.includes(pc) };
  };

  function itemRow(it, s, esc, safeUrl) {
    const hint = providerHint(it);
    const label = selectionLabel(s.plan, it.selectionId);
    const manual = MANUAL_CODES.includes(it.code) && it.status !== 'stop' && !(it.details && it.details.userConfirmed);
    const stay = s.plan.items.find(p => p.id === it.selectionId && p.hotel);
    const canRefresh = Boolean(stay && stay.refreshable && REFRESH_CODES.includes(it.code));
    const link = safeUrl(it.details && it.details.bookingUrl);
    const confirming = s.confirming && s.confirming.itemId === it.id ? s.confirming : null;
    const asking = s.refreshAsk === it.id;
    return `<li class="fk-item ${esc(it.status)}" data-item="${esc(it.id)}">
      <div class="fk-itemhead"><span class="tag ${it.status === 'pass' ? '' : it.status === 'stop' ? 'warn' : 'muted'}">${esc(STATUS_TEXT[it.status] || 'UNKNOWN')}</span>
        <span class="fk-msg">${label ? `<strong>${esc(label)}.</strong> ` : ''}${esc(it.message)}</span></div>
      ${evidenceLine(it.evidence, esc, safeUrl, s.now)}
      ${hint ? `<div class="fk-status error" role="alert">${esc(hint.text)}${hint.settings ? ' <button type="button" class="btn small" data-action="goto" data-view="system">Open Data &amp; System</button>' : ''}</div>` : ''}
      ${it.details && it.details.userConfirmed ? `<div class="fk-evidence"><span class="tag">USER CONFIRMED</span> This was confirmed by you at the program, not verified by an API. It expires 15 minutes after you confirmed it.</div>` : ''}
      ${it.details && it.details.stale ? '<div class="fk-evidence muted">Cached evidence is older than 15 minutes. Refresh availability.</div>' : ''}
      <div class="btnrow fk-itemactions">
        ${link ? `<a class="btn small" href="${esc(link)}" target="_blank" rel="noreferrer">Open the program's booking page ↗</a>` : ''}
        ${manual ? `<button type="button" class="btn small" data-action="confirm-open" data-item="${esc(it.id)}" data-focus="ci-${esc(it.id)}">I confirmed this at the program</button>` : ''}
        ${canRefresh ? `<button type="button" class="btn small" data-action="hotel-ask" data-item="${esc(it.id)}" data-focus="hr-${esc(it.id)}">Request hotel refresh</button>` : ''}
      </div>
      ${asking ? `<div class="note fk-inline" role="group" aria-label="Confirm hotel refresh"><p>This asks rooms.aero to re-check this hotel. It uses your shared allowance of <strong>one hotel refresh per 24 hours</strong>, and the result arrives later. A refresh does not prove the room can be booked.</p>
        <div class="btnrow"><button type="button" class="btn small primary" data-action="hotel-go" data-item="${esc(it.id)}" data-stay="${esc(it.selectionId)}" data-focus="hr-go"${s.busy ? ' disabled' : ''}>Request refresh (uses allowance)</button><button type="button" class="btn small" data-action="hotel-cancel">Not now</button></div></div>` : ''}
      ${confirming ? `<form class="note fk-inline" data-form="confirm" data-item="${esc(it.id)}" novalidate><p>Open the program's site yourself, check this, then record what you saw. PointPilot stores the page address and the time, nothing else.</p>
        <div class="formgrid fk-grid"><div class="span-2"><label for="ci-url">Program page address (https)</label><input id="ci-url" type="url" inputmode="url" autocomplete="off" data-field="sourceUrl" data-focus="ci-url" value="${esc(confirming.sourceUrl)}" placeholder="https://www.example.com/award-search"></div>
          ${it.code === 'FEES_UNKNOWN' ? `<div><label for="ci-amount">Total taxes and fees</label><input id="ci-amount" type="number" min="0" step="0.01" data-field="amount" data-focus="ci-amount" value="${esc(confirming.amount)}"></div><div><label for="ci-cur">Currency</label><input id="ci-cur" maxlength="3" data-field="currency" data-focus="ci-cur" value="${esc(confirming.currency)}"></div>` : ''}</div>
        <div class="btnrow"><button type="submit" class="btn small primary"${s.busy ? ' disabled' : ''}>Save confirmation</button><button type="button" class="btn small" data-action="confirm-cancel">Cancel</button></div>
        <div class="fk-status error" role="alert">${esc(s.confirmError || '')}</div></form>` : ''}
    </li>`;
  }

  /** Receipt for a requested hotel refresh, with a user-triggered (never automatic) status check. */
  function refreshBlock(rc, s, esc) {
    const waiting = Date.parse(rc.nextCheckAfter) > s.now;
    let message;
    if (rc.status === 'completed') message = 'New provider data has arrived. Refresh availability to re-check this stay; that is still not a booking guarantee.';
    else if (rc.status === 'unknown') message = 'No new provider data arrived within the checks allowed, so this stays unconfirmed.';
    else message = `The provider updates this later. Until it does the stay stays CAUTION.${waiting ? ` You can check the refresh status after ${esc(Kit.whenLabel(rc.nextCheckAfter))}.` : ''}`;
    const disabled = waiting || rc.checksRemaining <= 0 || s.busy ? ' disabled' : '';
    return `<div class="note fk-inline" role="status"><strong>Hotel refresh requested</strong> ${esc(Kit.ageLabel(rc.requestedAt, s.now))}. ${message}
      ${rc.status === 'queued' ? `<div class="btnrow"><button type="button" class="btn small" data-action="refresh-status" data-focus="rd-status"${disabled}>Check refresh status (${esc(String(Math.max(0, rc.checksRemaining)))} left)</button></div>` : ''}
      ${rc.error ? `<div class="fk-status error" role="alert">${esc(rc.error)}</div>` : ''}</div>`;
  }

  function reportView(s, esc, safeUrl) {
    const r = s.report;
    const expired = Date.parse(r.expiresAt) <= s.now;
    const stale = !s.current;
    const groups = [];
    for (const key of [...new Set(CATEGORY_ORDER.map(c => CATEGORY_LABELS[c]))]) {
      const items = r.items.filter(i => (CATEGORY_LABELS[i.category] || 'Other') === key);
      if (items.length) groups.push([key, items]);
    }
    const other = r.items.filter(i => !CATEGORY_LABELS[i.category]);
    if (other.length) groups.push(['Other', other]);
    const verdict = String(r.verdict || 'Caution');
    return `<div class="fk-report${stale ? ' stale' : ''}">
      ${stale ? `<div class="warnbox" role="note"><strong>This report is out of date.</strong> ${expired ? 'Reports are good for 15 minutes.' : 'The plan, your wallet or the transfer data changed since it was made.'} Refresh availability for a current result.</div>` : ''}
      <div class="fk-verdict v-${esc(verdict.toLowerCase())}" role="status" aria-label="Readiness result: ${esc(verdict)}"><span class="fk-verdict-word">${esc(stale ? `${verdict} (out of date)` : verdict)}</span><span>${esc(VERDICT_TEXT[verdict] || '')}</span></div>
      <p class="muted fk-help">Plan revision ${esc(String(r.planHash || '').slice(0, 8))} · checked ${esc(Kit.whenLabel(r.checkedAt))} (${esc(Kit.ageLabel(r.checkedAt, s.now))}) · ${expired ? 'expired' : `valid until ${esc(Kit.whenLabel(r.expiresAt))}`}. Availability comes from provider-cached data unless an item says otherwise; it can lag the program.</p>
      ${[...new Map(r.items.map(providerHint).filter(Boolean).filter(h => h.settings).map(h => [h.code, h])).values()].map(h => `<div class="warnbox" role="alert"><strong>${esc(h.text)}</strong> <button type="button" class="btn small" data-action="goto" data-view="system">Open Data &amp; System</button></div>`).join('')}
      ${r.sourceStatus && r.sourceStatus.complete === false ? '<p class="note" role="note">Some checks could not be completed. They are marked unknown, not passed. You can run the check again.</p>' : ''}
      ${groups.map(([name, items]) => `<section class="fk-group" aria-label="${esc(name)}"><h4>${esc(name)}</h4><ul class="fk-items">${items.map(i => itemRow(i, s, esc, safeUrl)).join('')}</ul></section>`).join('')}
      ${s.notice ? `<div class="fk-status" role="status">${esc(s.notice)}</div>` : ''}
    </div>`;
  }

  function view(s, esc, safeUrl) {
    if (!s.open) return '';
    const scopeName = s.scope === 'stay' ? 'Stay plan' : 'Trip';
    const title = `Booking readiness · ${scopeName}`;
    let body;
    const empty = s.phase === 'ready' && !s.plan.items.length && !s.report;
    if (s.phase === 'loading') body = '<p class="muted" role="status">Loading the saved result…</p>';
    else if (empty || s.errorCode === 'EMPTY_PLAN') body = `<div class="card empty fk-empty"><strong>${s.scope === 'stay' ? 'No stays to check yet' : 'No flights or stays to check yet'}</strong><p>Add ${s.scope === 'stay' ? 'a hotel to the stay plan' : 'flights in the Trip Optimizer, or hotels to the stay plan'}, then check readiness.</p><div class="btnrow"><button type="button" class="btn" data-action="goto" data-view="search" data-focus="rd-goto">Open Trip Optimizer</button></div></div>`;
    else {
      const checking = s.phase === 'checking';
      const err = s.error ? errorInfo({ code: s.errorCode, status: s.errorStatus, message: s.error }) : null;
      body = `${s.refreshReceipt ? refreshBlock(s.refreshReceipt, s, esc) : ''}${checking ? `<div class="fk-progress" role="status" aria-live="polite"><p><strong>Checking ${Kit.plural(s.plan.items.length, 'selection')}…</strong> This can take up to 90 seconds. Completed checks are kept even if one fails.</p><ul>${s.plan.items.map(i => `<li><span class="fk-spin" aria-hidden="true"></span> ${esc(i.label)} <span class="muted">in progress</span></li>`).join('')}</ul></div>` : ''}
        ${s.error ? `<div class="fk-status error" role="alert">${esc(s.error)}${err && err.settings ? ' <button type="button" class="btn small" data-action="goto" data-view="system">Open Data &amp; System</button>' : ''}${err && err.retry ? ' <button type="button" class="btn small" data-action="check" data-focus="rd-retry">Try again</button>' : ''}</div>` : ''}
        ${s.report ? reportView(s, esc, safeUrl) : (!checking && !s.error ? '<p class="muted">No check has been run for the current plan yet.</p>' : '')}`;
    }
    const canCheck = !['loading', 'checking'].includes(s.phase) && !empty && s.errorCode !== 'EMPTY_PLAN';
    return `<section class="card searchbox fk-panel" role="region" aria-labelledby="rdTitle" aria-busy="${s.phase === 'checking' || s.phase === 'loading' ? 'true' : 'false'}">
      <div class="cardhead"><div><h3 id="rdTitle" tabindex="-1" data-focus="rd-title">${esc(title)}</h3><p>Checks whether your current selection is still plausible before you move points. It never books, buys or transfers anything.</p></div>
        <div class="btnrow" style="margin:0"><button type="button" class="btn primary" data-action="check" data-focus="rd-check"${canCheck ? '' : ' disabled'}>${s.phase === 'checking' ? 'Checking…' : s.report ? 'Refresh availability' : 'Check booking readiness'}</button><button type="button" class="btn" data-action="close" data-focus="rd-close">Close</button></div></div>
      ${body}</section>`;
  }

  function mount({ root: host, api, esc, safeUrl, createGuard, onPlanChanged = () => {}, navigate = () => {} }) {
    const state = initialState();
    const guard = createGuard();
    let trigger = null;
    let keyHandler = null;

    const draw = () => { state.now = Date.now(); Kit.renderInto(host, view(state, esc, safeUrl)); host.hidden = !state.open; };
    const focus = key => { const el = host.querySelector && host.querySelector(`[data-focus="${key}"]`); if (el && el.focus) el.focus(); };

    async function loadPlan(scope) {
      const [trip, stay] = await Promise.all([scope === 'trip' ? api('/api/trip-plan') : Promise.resolve(null), api('/api/stay-plan')]);
      return { items: planItems(scope, trip, stay) };
    }

    async function load() {
      const token = guard.next();
      state.phase = 'loading'; state.error = null; state.errorCode = null; state.notice = null; state.report = null;
      draw();
      try {
        const [saved, plan] = await Promise.all([api(`/api/booking-readiness?scope=${encodeURIComponent(state.scope)}`, { signal: token.signal }), loadPlan(state.scope)]);
        if (!guard.isCurrent(token)) return;
        state.report = saved.report; state.current = Boolean(saved.current); state.planHash = saved.planHash || null; state.plan = plan; state.phase = 'ready';
      } catch (e) {
        if (!guard.isCurrent(token) || e?.name === 'AbortError') return;
        state.phase = 'ready'; state.error = errorInfo(e).text; state.errorCode = e.code; state.errorStatus = e.status;
      }
      draw();
    }

    async function check() {
      if (state.phase === 'checking') return;
      const token = guard.next();
      const scope = state.scope;
      state.phase = 'checking'; state.error = null; state.errorCode = null; state.notice = null; state.confirming = null; state.refreshAsk = null;
      draw();
      try {
        const body = { scope };
        if (state.planHash) body.expectedPlanHash = state.planHash;
        const r = await api('/api/booking-readiness/check', { method: 'POST', body, signal: token.signal });
        if (!guard.isCurrent(token)) return;
        state.report = r.report; state.current = true; state.planHash = r.report.planHash; state.phase = 'ready';
        state.notice = `Checked ${Kit.plural(r.report.items.length, 'item')}.`;
      } catch (e) {
        if (!guard.isCurrent(token) || e?.name === 'AbortError') return;
        state.phase = 'ready'; state.error = errorInfo(e).text; state.errorCode = e.code; state.errorStatus = e.status;
        if (e.code === 'PLAN_CHANGED') { state.current = false; return load().then(() => { state.error = ERRORS.PLAN_CHANGED; draw(); }); }
      }
      draw();
      focus('rd-check');
    }

    async function confirm() {
      const c = state.confirming;
      if (!c || !state.report) return;
      const item = state.report.items.find(i => i.id === c.itemId);
      const problem = item && confirmationFormProblem(c, item.code);
      if (!item) return;
      if (problem) { state.confirmError = problem; return draw(); }
      const token = guard.next();
      state.busy = 'confirm'; state.confirmError = null; draw();
      try {
        const body = { scope: state.scope, planHash: state.planHash || state.report.planHash, selectionId: item.selectionId, itemCode: item.code, sourceUrl: c.sourceUrl.trim() };
        if (item.code === 'FEES_UNKNOWN') body.amount = { currency: String(c.currency).toUpperCase(), value: Number(c.amount) };
        const r = await api('/api/booking-readiness/confirmations', { method: 'POST', body, signal: token.signal });
        if (!guard.isCurrent(token)) return;
        state.report = r.report; state.confirming = null; state.notice = 'Saved. This is recorded as user confirmed and expires in 15 minutes.';
        onPlanChanged({ readinessOnly: true });
      } catch (e) {
        if (!guard.isCurrent(token) || e?.name === 'AbortError') return;
        state.confirmError = errorInfo(e).text;
        if (e.code === 'PLAN_CHANGED') { state.confirming = null; state.current = false; }
      }
      state.busy = null; draw();
    }

    async function hotelRefresh(stayId) {
      if (state.busy) return;
      const token = guard.next();
      state.busy = 'hotel'; state.error = null; draw();
      try {
        const r = await api('/api/booking-readiness/hotel-refresh', { method: 'POST', body: { scope: state.scope, planHash: state.planHash || state.report?.planHash, stayId }, signal: token.signal });
        if (!guard.isCurrent(token)) return;
        state.refreshAsk = null;
        state.refreshReceipt = { stayId, requestedAt: r.requestedAt, nextCheckAfter: r.nextCheckAfter, status: 'queued', checksRemaining: 3, error: null };
        state.notice = `Hotel refresh requested. ${r.allowanceMessage ? `${r.allowanceMessage} ` : ''}Check again after ${Kit.whenLabel(r.nextCheckAfter)}. Until new provider data arrives this stays CAUTION.`;
        state.report = null; state.current = false;
      } catch (e) {
        if (!guard.isCurrent(token) || e?.name === 'AbortError') return;
        state.error = e.status === 429 ? 'The hotel refresh allowance is used up (one per 24 hours). Try again later.' : errorInfo(e).text; state.errorCode = e.code; state.errorStatus = e.status;
      }
      state.busy = null; draw();
    }

    async function refreshStatus() {
      const rc = state.refreshReceipt;
      if (!rc || state.busy || rc.checksRemaining <= 0) return;
      const token = guard.next();
      state.busy = 'status'; rc.error = null; draw();
      try {
        const q = new URLSearchParams({ scope: state.scope, planHash: state.planHash || '', stayId: rc.stayId });
        const r = await api(`/api/booking-readiness/hotel-refresh?${q}`, { signal: token.signal });
        if (!guard.isCurrent(token)) return;
        Object.assign(rc, { status: r.status, nextCheckAfter: r.nextCheckAfter || rc.nextCheckAfter, checksRemaining: r.checksRemaining ?? rc.checksRemaining - 1 });
      } catch (e) {
        if (!guard.isCurrent(token) || e?.name === 'AbortError') return;
        rc.error = e.status === 404 ? 'Status checks are not available. Refresh availability after the time above instead.' : errorInfo(e).text;
      }
      state.busy = null; draw();
    }

    function close() {
      guard.cancel();
      state.open = false; state.phase = 'idle'; state.confirming = null; state.refreshAsk = null;
      draw();
      if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
      if (trigger && trigger.focus && trigger.isConnected !== false) trigger.focus();
      trigger = null;
    }

    function open(scope, from) {
      trigger = from || null;
      Object.assign(state, initialState(), { open: true, scope: scope === 'stay' ? 'stay' : 'trip' });
      draw();
      focus('rd-title');
      if (typeof document !== 'undefined' && !keyHandler) { keyHandler = ev => { if (ev.key === 'Escape' && state.open) close(); }; document.addEventListener('keydown', keyHandler); }
      return load().then(() => { if (state.open) focus('rd-title'); });
    }

    host.addEventListener('click', ev => {
      const el = ev.target.closest && ev.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'close') return close();
      if (a === 'check') return check();
      if (a === 'goto') { const view = el.dataset.view; close(); return navigate(view); }
      if (a === 'confirm-open') { state.confirming = { itemId: el.dataset.item, sourceUrl: '', amount: '', currency: 'USD' }; state.confirmError = null; state.refreshAsk = null; draw(); return focus('ci-url'); }
      if (a === 'confirm-cancel') { const id = state.confirming && state.confirming.itemId; state.confirming = null; draw(); return focus(`ci-${id}`); }
      if (a === 'hotel-ask') { state.refreshAsk = el.dataset.item; state.confirming = null; draw(); return focus('hr-go'); }
      if (a === 'hotel-cancel') { const id = state.refreshAsk; state.refreshAsk = null; draw(); return focus(`hr-${id}`); }
      if (a === 'hotel-go') return hotelRefresh(el.dataset.stay);
      if (a === 'refresh-status') return refreshStatus();
    });
    host.addEventListener('input', ev => {
      const f = ev.target.dataset && ev.target.dataset.field;
      if (state.confirming && ['sourceUrl', 'amount', 'currency'].includes(f)) state.confirming[f] = ev.target.value;
    });
    host.addEventListener('submit', ev => {
      ev.preventDefault && ev.preventDefault();
      if (ev.target.dataset && ev.target.dataset.form === 'confirm') confirm();
    });

    host.hidden = true;
    return {
      open, close,
      /** The saved plan, wallet or reference data changed: whatever report is on screen is no longer current. */
      invalidate() { state.current = false; if (state.open && state.phase !== 'checking') load(); else if (state.open) draw(); },
      destroy() { guard.cancel(); if (keyHandler) document.removeEventListener('keydown', keyHandler); host.innerHTML = ''; },
      get state() { return state; }
    };
  }

  root.PPFeatures = root.PPFeatures || {};
  root.PPFeatures.readiness = { providerHint, mount, view, initialState, planItems, confirmationFormProblem, errorInfo, ERRORS, STATUS_TEXT, VERDICT_TEXT, METHOD_TEXT };
})(typeof window !== 'undefined' ? window : globalThis);
