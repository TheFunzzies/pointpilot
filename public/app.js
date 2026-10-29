'use strict';
const $ = id => document.getElementById(id);
const desktop = window.pointpilot || null;

const state = { product: 'flights', user: { balances: [], preferences: {} }, alerts: [], partners: null, programs: [], lastQuery: null, simpleFin: null };

// ---------- helpers ----------
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0));
const money = n => (n == null || !Number.isFinite(Number(n)) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n)));
const dateFmt = x => (x ? new Date(`${String(x).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const programLabel = id => state.programs.find(p => p.id === id)?.name || id;
const { createGuard, paginate, pairAddability, nonstopFilter, expandBody, alertCheckState, summarizeRun, truncationNotice, tripEnds, stayProvenance, fareQuote, comparisonQuote, isExactComparable, buildRooms, plainText, roomSummary, buildProgramEvidence, ROOM_LIMITS, DEFAULT_ROOM } = window.PPHelpers;
const searchGuard = createGuard();
const isAbort = e => e?.name === 'AbortError';
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : null);

/** Re-render while keeping keyboard focus on the same control (identified by id or data attributes). */
function focusSelector(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const keys = ['action', 'leg', 'day', 'id', 'city'].filter(k => el.dataset?.[k] != null);
  return keys.length && el.dataset.action ? `${el.tagName.toLowerCase()}${keys.map(k => `[data-${k}="${CSS.escape(el.dataset[k])}"]`).join('')}` : null;
}
function keepFocus(fn) {
  const sel = focusSelector(document.activeElement);
  const result = fn();
  if (sel) document.querySelector(sel)?.focus({ preventScroll: true });
  return result;
}

let toastTimer;
function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }

async function api(path, { method = 'GET', body, signal } = {}) {
  const r = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  const text = await r.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!r.ok) { const err = new Error(payload.error || `HTTP ${r.status}`); err.status = r.status; err.code = payload.code; throw err; }
  return payload;
}

function busy(button, on, label) {
  if (!button) return;
  if (on) { if (!button._busy) button._html = button.innerHTML; button._busy = true; button.textContent = label || 'Working…'; button.disabled = true; }
  else { if (button._html != null) button.innerHTML = button._html; button._busy = false; button.disabled = false; }
}

// ---------- boot ----------
function initDates() {
  const d = new Date(); d.setDate(d.getDate() + 150);
  const r = new Date(d); r.setDate(r.getDate() + 12);
  $('dateFrom').value = d.toISOString().slice(0, 10);
  $('dateTo').value = r.toISOString().slice(0, 10);
  $('discoverDepart').value = $('dateFrom').value;
  $('discoverReturn').value = $('dateTo').value;
}

async function load() {
  try {
    const [programs, user, partners, alerts, providers] = await Promise.all([
      api('/api/programs'), api('/api/user'), api('/api/transfer-partners'), api('/api/alerts'), api('/api/providers')
    ]);
    state.programs = programs.programs;
    state.user = user;
    state.partners = partners;
    state.alerts = alerts;
    fillProgramSelects();
    renderWallet(); renderPartners(); renderAlerts(); renderProviders(providers.providers); renderKPIs();
    await Promise.all([refreshHealth(), loadSettings(), loadProducts(), loadSimpleFin()]);
  } catch (e) {
    $('statusPill').textContent = '● Backend error';
    toast(e.message);
  }
}

async function refreshHealth() {
  const h = await api('/api/health');
  const live = h.liveData === 'seats.aero';
  $('statusPill').innerHTML = `<span class="dot" style="background:${live ? '#10b981' : '#f59e0b'}"></span>${live ? 'Live data: seats.aero' : 'Manual data only'}`;
  $('modeLabel').textContent = live ? 'Live award data' : 'Manual data only';
  $('modeHint').textContent = live ? `Flights + hotels · ${h.apiCallsToday} flight / ${h.roomsCallsToday} hotel API calls today` : 'Add a seats.aero key in Data & System for live availability.';
  $('liveDot').style.background = live ? '#10b981' : '#f59e0b';
  $('sysHistory').textContent = `${fmt(h.awardObservations)} observations`;
  $('sysTransfer').textContent = `Updated ${h.reference.lastUpdated} (${h.reference.origin})`;
  $('apiCalls').textContent = `${fmt(h.apiCallsToday)} flights · ${fmt(h.roomsCallsToday)} hotels`;
  state.cashData = h.cashData;
  $('useGoogle').disabled = !h.cashData?.google;
  $('useGoogleWrap').title = h.cashData?.google ? `${h.serpCallsThisMonth} of 250 free SerpApi searches used this month` : 'Add a SerpApi key under Data & System';
  const info = desktop ? await desktop.appInfo() : null;
  $('sysDataDir').textContent = info?.dataDir || h.dataDir;
  if (info && !info.packaged) renderUpdateStatus({ status: 'unavailable', message: 'Development build — automatic updates run in the installed app.' });
  else if (!desktop) renderUpdateStatus({ status: 'unavailable', message: 'Running in a browser — updates apply to the desktop app.' });
  else renderUpdateStatus({ status: 'idle', version: info.version });
}

function fillProgramSelects() {
  const opts = kind => state.programs.filter(p => !kind || kind.includes(p.kind)).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('manualProgram').innerHTML = opts(['airline']);
  $('manualHotelProgram').innerHTML = opts(['hotel']);
  $('histProgram').innerHTML = '<option value="">All programs</option>' + opts();
  $('purchaseProgram').innerHTML = '<option value="">Choose a program</option>' + opts(['airline']);
  $('expirationProgram').innerHTML = '<option value="">Choose a program</option>' + opts();
}

function renderExpirations() {
  const list = $('expirationList');
  if (!list) return;
  const entries = [...(state.settings?.pointExpirations || [])].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
  if (!entries.length) { list.innerHTML = '<p class="muted">No expiration dates tracked yet.</p>'; return; }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  list.innerHTML = entries.map(x => {
    const days = Math.ceil((Date.parse(`${x.expiresOn}T00:00:00`) - today.getTime()) / 86400000);
    const badge = days < 0 ? `<span class="tag warn">Expired ${Math.abs(days)}d ago</span>` : days <= 30 ? `<span class="tag warn">${days === 0 ? 'Expires today' : `Expires in ${days}d`}</span>` : `<span class="tag muted">${days} days</span>`;
    return `<div class="expiration-row"><div><strong>${esc(programLabel(x.program))}</strong> · ${fmt(x.points)} points · ${dateFmt(x.expiresOn)} ${badge}${x.note ? `<div class="muted">${esc(x.note)}</div>` : ''}</div><button type="button" class="btn small ghost" data-remove-expiration="${esc(x.id)}" aria-label="Remove expiration for ${esc(programLabel(x.program))}">Remove</button></div>`;
  }).join('');
}

$('addExpiration').addEventListener('click', async () => {
  const program = $('expirationProgram').value, points = Number($('expirationPoints').value), expiresOn = $('expirationDate').value;
  if (!program || !Number.isSafeInteger(points) || points <= 0 || !expiresOn) { $('expirationMessage').textContent = 'Choose a program, enter a point amount, and select an expiration date.'; return; }
  const next = [...(state.settings?.pointExpirations || []), { id: crypto.randomUUID(), program, points, expiresOn, note: $('expirationNote').value.trim() }];
  try {
    await api('/api/settings', { method: 'PUT', body: { pointExpirations: next } });
    await loadSettings();
    $('expirationProgram').value = ''; $('expirationPoints').value = ''; $('expirationDate').value = ''; $('expirationNote').value = '';
    $('expirationMessage').textContent = 'Expiration saved. Reminders run while PointPilot is open or in the tray.';
  } catch (e) { $('expirationMessage').textContent = e.message; }
});
$('expirationList').addEventListener('click', async e => {
  const id = e.target.closest('[data-remove-expiration]')?.dataset.removeExpiration;
  if (!id) return;
  try {
    const next = (state.settings?.pointExpirations || []).filter(x => x.id !== id);
    await api('/api/settings', { method: 'PUT', body: { pointExpirations: next } });
    await loadSettings();
    $('expirationMessage').textContent = 'Expiration removed.';
  } catch (err) { $('expirationMessage').textContent = err.message; }
});

function renderPurchaseOffers(offers = []) {
  const list = $('purchaseOffersList');
  if (!list) return;
  if (!offers.length) { list.innerHTML = '<p class="muted fk-help">No buy-points offers saved. Add a current effective price to compare it with a selected award and cash fare.</p>'; return; }
  list.innerHTML = `<div class="purchase-offer-list" aria-label="Saved buy-points offers">${offers.map(o => {
    const link = safeUrl(o.offerUrl);
    const expired = Boolean(o.offerEnds && o.offerEnds < new Date().toISOString().slice(0, 10));
    return `<div class="purchase-offer-row"><div><strong>${esc(programLabel(o.program))}</strong>${expired ? ' <span class="tag warn">Expired · refresh before using</span>' : ''}<div class="muted">${Number(o.pricePerPointCents).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}¢/point${o.offerEnds ? ` · ends ${dateFmt(o.offerEnds)}` : ''}${o.notes ? ` · ${esc(o.notes)}` : ''}</div>${link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer">Official purchase page ↗</a>` : ''}<small>Minimum ${fmt(o.minimumPurchase)} · increments of ${fmt(o.purchaseIncrement)}</small></div><div class="btnrow" style="margin:0"><button type="button" class="btn small" data-edit-purchase="${esc(o.program)}">Edit</button><button type="button" class="btn small ghost" data-remove-purchase="${esc(o.program)}">Remove</button></div></div>`;
  }).join('')}</div>`;
}

function clearPurchaseOfferFields() {
  $('purchaseProgram').value = '';
  $('purchaseCpp').value = '';
  $('purchaseMinimum').value = '1000';
  $('purchaseIncrement').value = '1000';
  $('purchaseEnds').value = '';
  $('purchaseUrl').value = '';
  $('purchaseNotes').value = '';
}

$('savePurchaseOffer').onclick = async () => {
  const program = $('purchaseProgram').value;
  const cpp = Number($('purchaseCpp').value);
  if (!program || !Number.isFinite(cpp) || cpp <= 0) { $('purchaseOfferMessage').textContent = 'Choose a program and enter its effective cost per point.'; return; }
  const offer = {
    program, pricePerPointCents: cpp,
    minimumPurchase: Number($('purchaseMinimum').value || 1000),
    purchaseIncrement: Number($('purchaseIncrement').value || 1000),
    offerEnds: $('purchaseEnds').value || null,
    offerUrl: $('purchaseUrl').value.trim(), notes: $('purchaseNotes').value.trim()
  };
  const offers = (state.settings?.buyPointsOffers || []).filter(o => o.program !== program).concat(offer);
  try {
    await api('/api/settings', { method: 'PUT', body: { buyPointsOffers: offers } });
    await desktop?.settingsChanged?.();
    await loadSettings();
    clearPurchaseOfferFields();
    $('purchaseOfferMessage').textContent = 'Offer saved on this computer and in your backups.';
    toast(`${programLabel(program)} offer saved`);
  } catch (e) { $('purchaseOfferMessage').textContent = e.message; }
};
$('clearPurchaseOfferForm').onclick = () => { clearPurchaseOfferFields(); $('purchaseOfferMessage').textContent = 'Offer fields cleared.'; };
$('purchaseOffersList').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const offers = state.settings?.buyPointsOffers || [];
  const offer = offers.find(o => o.program === (b.dataset.editPurchase || b.dataset.removePurchase));
  if (!offer) return;
  if (b.dataset.editPurchase) {
    $('purchaseProgram').value = offer.program;
    $('purchaseCpp').value = offer.pricePerPointCents;
    $('purchaseMinimum').value = offer.minimumPurchase;
    $('purchaseIncrement').value = offer.purchaseIncrement;
    $('purchaseEnds').value = offer.offerEnds || '';
    $('purchaseUrl').value = offer.offerUrl || '';
    $('purchaseNotes').value = offer.notes || '';
    $('purchaseCpp').focus();
    return;
  }
  if (!window.confirm(`Remove the saved ${programLabel(offer.program)} buy-points offer?`)) return;
  try {
    await api('/api/settings', { method: 'PUT', body: { buyPointsOffers: offers.filter(o => o.program !== offer.program) } });
    await desktop?.settingsChanged?.();
    await loadSettings();
    $('purchaseOfferMessage').textContent = 'Offer removed.';
  } catch (err) { $('purchaseOfferMessage').textContent = err.message; }
});

// ---------- wallet ----------
function renderKPIs() {
  const b = state.user.balances;
  $('kpiTotal').textContent = fmt(b.filter(x => Number(x.balance) > 0).length);
  $('kpiFlex').textContent = fmt(b.filter(x => x.type === 'bank').reduce((s, x) => s + Number(x.balance || 0), 0));
  $('kpiAlerts').textContent = state.alerts.filter(a => a.active !== false).length;
}

// Typical valuations (¢/pt) used as the starting value when a program is added. Users can edit them.
const DEFAULT_CPP = {
  amex: 1.6, chase: 1.6, citi: 1.5, capitalone: 1.5, bilt: 1.6, wellsfargo: 1.3, brex: 1.3, ramp: 1.3,
  hyatt: 1.6, hilton: 0.5, marriott: 0.7, ihg: 0.5, choice: 0.6, wyndham: 0.8, accor: 2.0, iprefer: 0.5,
  american: 1.5, united: 1.2, delta: 1.1, alaska: 1.4, southwest: 1.3, jetblue: 1.3, aeroplan: 1.4, flyingblue: 1.3
};
const WALLET_GROUPS = [
  { kind: 'bank', title: 'Bank & card points', icon: 'i-bank', empty: 'Add Amex, Chase, Citi, Capital One, Bilt and other card points. These can be transferred to airline and hotel partners.' },
  { kind: 'airline', title: 'Airline miles', icon: 'i-plane', empty: 'Add miles you already hold in airline programs. They are used before transferring bank points.' },
  { kind: 'hotel', title: 'Hotel points', icon: 'i-bed', empty: 'Add hotel program balances. Marriott and others can also transfer to airlines.' }
];
const pointValue = b => (Number(b.balance) || 0) * (Number(b.cpp) || 0) / 100;

function renderWalletSummary() {
  const b = state.user.balances;
  $('discoverWalletNote').hidden = b.some(x => Number(x.balance) > 0);
  $('wTotal').textContent = fmt(b.reduce((s, x) => s + (Number(x.balance) || 0), 0));
  $('wPrograms').textContent = `${b.length} program${b.length === 1 ? '' : 's'}`;
  $('wValue').textContent = money(b.reduce((s, x) => s + pointValue(x), 0));
  $('wFlex').textContent = fmt(b.filter(x => x.type === 'bank').reduce((s, x) => s + (Number(x.balance) || 0), 0));
  for (const g of WALLET_GROUPS) {
    const el = document.querySelector(`[data-group-total="${g.kind}"]`);
    if (!el) continue;
    const rows = b.filter(x => x.type === g.kind);
    el.textContent = rows.length ? `${fmt(rows.reduce((s, x) => s + (Number(x.balance) || 0), 0))} pts · ${money(rows.reduce((s, x) => s + pointValue(x), 0))}` : '';
  }
  document.querySelectorAll('[data-value-for]').forEach(el => { const x = b[Number(el.dataset.valueFor)]; if (x) el.textContent = money(pointValue(x)); });
}

function renderWallet() {
  const balances = state.user.balances;
  const have = new Set(balances.map(b => b.code));
  $('walletGroups').innerHTML = WALLET_GROUPS.map(g => {
    const rows = balances.map((b, i) => ({ b, i })).filter(({ b }) => b.type === g.kind);
    const options = state.programs.filter(p => p.kind === g.kind && !have.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="card wallet-group">
      <header><h3><span class="chip"><svg class="icon"><use href="#${g.icon}"/></svg></span>${esc(g.title)}</h3><small data-group-total="${g.kind}"></small></header>
      ${rows.length ? `<div class="wallet-head"><span>Program</span><span style="text-align:right">Balance</span><span style="text-align:right">Value ¢/pt</span><span style="text-align:right">Worth</span><span></span></div>` : `<div class="wallet-empty">${esc(g.empty)}</div>`}
      ${rows.map(({ b, i }) => `<div class="wallet-row">
        <div class="name">${esc(b.program)}</div>
        <label class="wallet-input"><span>Balance</span><input type="number" min="0" step="1000" inputmode="numeric" aria-label="${esc(b.program)} balance" data-i="${i}" data-k="balance" value="${esc(b.balance)}"></label>
        <label class="wallet-input"><span>Value ¢/pt</span><input type="number" min="0" step="0.05" aria-label="${esc(b.program)} value in cents per point" data-i="${i}" data-k="cpp" value="${esc(b.cpp)}"></label>
        <span class="value" data-value-for="${i}">${money(pointValue(b))}</span>
        <button class="btn ghost icon-only" title="Remove ${esc(b.program)}" aria-label="Remove ${esc(b.program)}" data-remove="${i}"><svg class="icon"><use href="#i-x"/></svg></button>
      </div>`).join('')}
      ${options.length ? `<div class="wallet-add"><select aria-label="Add ${esc(g.title)}" data-add-select="${g.kind}"><option value="">Add a program…</option>${options.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button class="btn small" data-add="${g.kind}"><svg class="icon"><use href="#i-plus"/></svg>Add</button></div>` : ''}
    </div>`;
  }).join('') + (balances.length ? '' : '<div class="note">Just exploring? <button class="btn small" data-action="example-wallet">Load example balances</button></div>');
  const prefs = { maxTransfers: 3, maxTransferDays: 3, defaultCpp: 1.5, preferNonstop: false, ...state.user.preferences };
  $('prefMaxTransfers').value = prefs.maxTransfers;
  $('prefMaxDays').value = prefs.maxTransferDays;
  $('prefDefaultCpp').value = prefs.defaultCpp;
  $('prefNonstop').value = String(Boolean(prefs.preferNonstop));
  renderWalletSummary();
}

function renderSimpleFin() {
  const s = state.simpleFin || { supported: false, connected: false, accounts: [] };
  $('simpleFinStatus').textContent = s.connected ? 'Connected' : s.supported ? 'Not connected' : 'Desktop app only';
  $('simpleFinStatus').className = `tag ${s.connected ? '' : 'muted'}`;
  $('simpleFinUnsupported').hidden = Boolean(s.supported);
  $('simpleFinConnect').hidden = !s.supported || Boolean(s.connected);
  $('simpleFinAccounts').hidden = !s.connected;
  $('simpleFinControls').hidden = !s.connected;
  $('simpleFinReplaceLabel').hidden = !s.connected;
  const rewards = (s.accounts || []).filter(a => a.rewardsCurrency);
  if (s.connected) {
    $('simpleFinAccounts').innerHTML = rewards.length ? `<div class="result-list">${rewards.map(a => {
      const choices = state.programs.map(p => `<option value="${esc(p.id)}" ${a.program === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
      return `<div class="result card"><div><h4>${esc(a.name)}</h4><p>${esc(a.currencyName || 'Custom rewards currency')} · ${fmt(a.balance)} ${esc(a.currencyAbbr || 'points')}${a.balanceAt ? ` · balance as of ${esc(dateFmt(a.balanceAt))}` : ''}</p></div><label>Map to program<select data-simplefin-map="${esc(a.key)}"><option value="">Choose a loyalty program</option>${choices}</select></label></div>`;
    }).join('')}</div>` : '<div class="empty"><strong>No points balances were returned.</strong><p>This connection may provide card account balances without loyalty points. PointPilot only lists custom rewards currencies.</p></div>';
  }
  $('simpleFinSyncBtn').disabled = !simpleFinSyncReady();
  $('simpleFinFreshness').textContent = s.lastFetchedAt ? `Accounts checked ${new Date(s.lastFetchedAt).toLocaleString()}${s.lastSyncedAt ? ` · wallet last synced ${new Date(s.lastSyncedAt).toLocaleString()}` : ''}.` : '';
  $('simpleFinMessage').textContent = (s.errors || []).map(error => error.msg).filter(Boolean).join(' · ');
}

function simpleFinSyncReady() {
  const saved = new Map((state.simpleFin?.accounts || []).filter(account => account.rewardsCurrency).map(account => [account.key, account.program || '']));
  const selects = [...document.querySelectorAll('[data-simplefin-map]')];
  return $('simpleFinReplaceConfirm').checked && saved.size > 0 && selects.length === saved.size && selects.every(select => saved.get(select.dataset.simplefinMap) === select.value) && [...saved.values()].some(Boolean);
}

async function loadSimpleFin() {
  try { state.simpleFin = await api('/api/simplefin'); renderSimpleFin(); }
  catch (error) { $('simpleFinStatus').textContent = 'Unavailable'; $('simpleFinMessage').textContent = error.message; }
}

async function connectSimpleFin() {
  const token = $('simpleFinToken').value.trim();
  if (!token) { $('simpleFinMessage').textContent = 'Paste the SimpleFIN token first.'; return; }
  busy($('simpleFinConnectBtn'), true, 'Connecting…'); $('simpleFinMessage').textContent = '';
  try {
    state.simpleFin = await api('/api/simplefin/connect', { method: 'POST', body: { token } });
    $('simpleFinToken').value = '';
    renderSimpleFin();
    $('simpleFinMessage').textContent = 'Connected. Review the reward accounts and save their loyalty-program mappings.';
  } catch (error) {
    $('simpleFinMessage').textContent = error.message;
    if (['CLAIM_FORBIDDEN', 'SIMPLEFIN_CREDENTIAL_SAVE_FAILED'].includes(error.code)) $('simpleFinToken').value = '';
    if (error.code === 'SIMPLEFIN_ACCOUNTS_FAILED') { $('simpleFinToken').value = ''; await loadSimpleFin(); $('simpleFinMessage').textContent = error.message; }
  }
  finally { busy($('simpleFinConnectBtn'), false); }
}

async function refreshSimpleFin() {
  busy($('simpleFinRefreshBtn'), true, 'Refreshing…'); $('simpleFinMessage').textContent = '';
  try { state.simpleFin = await api('/api/simplefin/refresh', { method: 'POST', body: {} }); renderSimpleFin(); $('simpleFinMessage').textContent = 'Account balances refreshed from SimpleFIN.'; }
  catch (error) { $('simpleFinMessage').textContent = error.message; }
  finally { busy($('simpleFinRefreshBtn'), false); }
}

async function saveSimpleFinMappings() {
  const mappings = [...document.querySelectorAll('[data-simplefin-map]')].map(select => ({ key: select.dataset.simplefinMap, program: select.value }));
  busy($('simpleFinSaveBtn'), true, 'Saving…'); $('simpleFinMessage').textContent = '';
  try { state.simpleFin = await api('/api/simplefin/mappings', { method: 'PUT', body: { mappings } }); renderSimpleFin(); $('simpleFinMessage').textContent = 'Account mappings saved.'; }
  catch (error) { $('simpleFinMessage').textContent = error.message; }
  finally { busy($('simpleFinSaveBtn'), false); }
}

async function syncSimpleFin() {
  busy($('simpleFinSyncBtn'), true, 'Syncing…'); $('simpleFinMessage').textContent = '';
  try {
    const result = await api('/api/simplefin/sync', { method: 'POST', body: {} });
    state.user = result.user; renderWallet(); renderKPIs(); state.simpleFin = result.simpleFin; renderSimpleFin();
    $('simpleFinMessage').textContent = `Updated ${result.sync.programs.map(p => p.program).join(', ')} from SimpleFIN.`;
  } catch (error) { $('simpleFinMessage').textContent = error.message; }
  finally { busy($('simpleFinSyncBtn'), false); }
}

async function disconnectSimpleFin() {
  busy($('simpleFinDisconnectBtn'), true, 'Disconnecting…');
  try { state.simpleFin = await api('/api/simplefin', { method: 'DELETE', body: {} }); $('simpleFinReplaceConfirm').checked = false; renderSimpleFin(); $('simpleFinMessage').textContent = 'Disconnected. Existing wallet balances were kept.'; }
  catch (error) { $('simpleFinMessage').textContent = error.message; }
  finally { busy($('simpleFinDisconnectBtn'), false); }
}

$('simpleFinConnectBtn').addEventListener('click', connectSimpleFin);
$('simpleFinRefreshBtn').addEventListener('click', refreshSimpleFin);
$('simpleFinSaveBtn').addEventListener('click', saveSimpleFinMappings);
$('simpleFinSyncBtn').addEventListener('click', syncSimpleFin);
$('simpleFinDisconnectBtn').addEventListener('click', disconnectSimpleFin);
$('simpleFinReplaceConfirm').addEventListener('change', renderSimpleFin);
$('simpleFinAccounts').addEventListener('change', e => { if (e.target.matches('[data-simplefin-map]')) $('simpleFinSyncBtn').disabled = !simpleFinSyncReady(); });

// Wallet changes save automatically (debounced) so balances are never lost.
let walletTimer = null;
function setWalletState(text, cls = '') { const el = $('walletState'); el.textContent = text; el.className = `save-state ${cls}`; }
function queueWalletSave() {
  setWalletState('Saving…');
  clearTimeout(walletTimer);
  walletTimer = setTimeout(async () => {
    try {
      const saved = await api('/api/user', { method: 'PUT', body: state.user });
      state.user.balances.forEach((b, i) => { if (saved.balances[i]) b.type = saved.balances[i].type; });
      setWalletState('✓ All changes saved', 'saved');
    } catch (e) { setWalletState(`Not saved: ${e.message}`, 'error'); }
  }, 600);
}

$('walletGroups').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.k) return;
  state.user.balances[Number(t.dataset.i)][t.dataset.k] = Math.max(0, Number(t.value) || 0);
  renderWalletSummary(); renderKPIs(); queueWalletSave();
});
$('walletGroups').addEventListener('click', async e => {
  const btn = e.target.closest('button'); if (!btn) return;
  if (btn.dataset.remove != null) {
    const current = state.user.balances[Number(btn.dataset.remove)];
    if (!current || !window.confirm(`Remove ${current.program} from My Points? Its saved balance and valuation will be removed.`)) return;
    const [removed] = state.user.balances.splice(Number(btn.dataset.remove), 1);
    renderWallet(); renderKPIs(); queueWalletSave(); toast(`Removed ${removed.program}`);
  } else if (btn.dataset.add) {
    const id = document.querySelector(`[data-add-select="${btn.dataset.add}"]`).value;
    const p = state.programs.find(x => x.id === id);
    if (!p) return toast('Choose a program to add');
    state.user.balances.push({ program: p.name, code: p.id, type: p.kind, balance: 0, cpp: state.partners?.valuations?.cents?.[p.id] ?? DEFAULT_CPP[p.id] ?? (p.kind === 'hotel' ? 0.6 : p.kind === 'bank' ? 1.5 : 1.3), transferable: p.kind === 'bank' });
    renderWallet(); renderKPIs(); queueWalletSave();
    const input = document.querySelector(`#walletGroups input[data-k="balance"][data-i="${state.user.balances.length - 1}"]`);
    input?.focus(); input?.select();
  } else if (btn.dataset.action === 'example-wallet') {
    state.user = await api('/api/user/example');
    renderWallet(); renderKPIs(); queueWalletSave();
  }
});
['prefMaxTransfers', 'prefMaxDays', 'prefDefaultCpp', 'prefNonstop'].forEach(id => $(id).addEventListener('change', () => {
  state.user.preferences = {
    ...state.user.preferences,
    maxTransfers: Math.max(1, Number($('prefMaxTransfers').value) || 3),
    maxTransferDays: Math.max(0, Number($('prefMaxDays').value) || 0),
    defaultCpp: Math.max(0, Number($('prefDefaultCpp').value) || 1.5),
    preferNonstop: $('prefNonstop').value === 'true'
  };
  queueWalletSave();
}));

// ---------- search ----------
// ---------- seat products ("find flights with La Première") ----------
async function loadProducts() {
  try {
    const { products } = await api('/api/cabin-products');
    state.products = products;
    const group = cabin => products.filter(p => p.cabin === cabin)
      .map(p => `<option value="${esc(p.key)}">${esc(p.airline)}: ${esc(p.product)}${p.score >= 5 ? ' ★' : ''}${p.certainty === 'varies' ? ' (some aircraft)' : ''}</option>`).join('');
    $('productHunt').innerHTML = `<option value="">Any seat</option><optgroup label="First class">${group('first')}</optgroup><optgroup label="Business class">${group('business')}</optgroup>`;
  } catch { /* optional feature */ }
}
$('productHunt').addEventListener('change', () => {
  const p = state.products?.find(x => x.key === $('productHunt').value);
  if (p && state.product === 'flights') $('cabin').value = p.cabin;
});
const productOf = key => state.products?.find(p => p.key === key) || null;
const optHasProduct = (o, p) => Boolean(p && o.flight && (!o.cabin || o.cabin === p.cabin) && (o.flight.segments || []).some(s => s.carrier === p.carrier && s.seat?.type === p.product));

function currentQuery() {
  return {
    product: state.product === 'flights' ? $('productHunt').value || null : null,
    origins: $('origins').value, destination: $('destination').value.trim(),
    departDate: $('dateFrom').value, returnDate: $('dateTo').value || null,
    flexDays: Number($('flex').value), cabin: $('cabin').value, travelers: Number($('travelers').value),
    nonstopOnly: $('directOnly').checked, preserveFlexible: $('keepFlexible').checked, rank: $('rank').value
  };
}

/** Abort any search in flight and restore the Search button (used when the product changes). */
function cancelSearch() {
  if ($('searchBtn').disabled) $('searchMessage').textContent = 'Previous search cancelled.';
  searchGuard.cancel();
  busy($('searchBtn'), false);
}

async function runSearch() {
  const msg = $('searchMessage');
  // A newer search supersedes the one in flight; its response is ignored and its request aborted.
  const token = searchGuard.next();
  const { signal } = token;
  const product = state.product;
  const live = () => searchGuard.isCurrent(token);
  busy($('searchBtn'), true, 'Searching…');
  try {
    if (product === 'hotels') {
      const roomCheck = buildRooms(roomsState.rows);
      $('roomsError').textContent = roomCheck.ok ? '' : roomCheck.error;
      if (!roomCheck.ok) {
        state.lastHotelQuery = null;
        $('results').innerHTML = `<div class="card empty search-error" role="alert"><strong>Check the room details</strong><p>${esc(roomCheck.error)}</p></div>`;
        $('resultMeta').textContent = 'No results for this search.';
        msg.textContent = roomCheck.error;
        return;
      }
      msg.textContent = 'Searching hotel award space…';
      const q = currentHotelQuery();
      const r = await api('/api/search/hotels', { method: 'POST', body: q, signal });
      if (!live()) return;
      state.lastHotelQuery = q;
      renderHotels(r); saveRecent();
      const src = { fetched: 'live rooms.aero data', 'recent-cache': 'rooms.aero data from the last hour', 'not-configured': 'manually entered hotels only', error: 'the local cache (rooms.aero failed)' }[r.dataStatus.api] || 'local data';
      msg.textContent = `${r.rows.length} hotel award(s) in ${r.query.destination} for ${r.nights} night(s), using ${src}.`;
      return;
    }
    if (product === 'cash') {
      msg.textContent = $('useGoogle').checked ? 'Checking cached fares and live Google Flights…' : 'Checking recent cash fares…';
      const q = { ...currentQuery(), useGoogle: $('useGoogle').checked };
      const r = await api('/api/cash/search', { method: 'POST', body: q, signal });
      if (!live()) return;
      state.lastCashQuery = q;
      state.lastCashResult = r;
      renderCash(r); saveRecent();
      msg.textContent = `${r.fares.length} fare(s) for ${r.query.origins.join(', ')} → ${r.query.destinations.join(', ')}${r.google ? (r.dataStatus.google === 'recent-cache' ? ' · recent Google Flights cache used' : ' · Google Flights checked') : ''}.`;
      return;
    }
    msg.textContent = 'Searching award space and optimizing against your points…';
    const q = currentQuery();
    const r = await api('/api/search/trip', { method: 'POST', body: q, signal });
    if (!live()) return;
    state.lastQuery = q;
    renderFlightResults(r); saveRecent();
    const src = { fetched: 'live seats.aero data', 'recent-cache': 'seats.aero data from the last hour', 'not-configured': 'manually entered awards only', error: 'the local cache (seats.aero failed)', skipped: 'local data' }[r.dataStatus.api] || 'local data';
    msg.textContent = `Searched ${r.query.origins.join(', ')} → ${r.query.destinations.join(', ')} using ${src}.`;
  } catch (e) {
    if (isAbort(e) || !live()) return;
    if (product === 'flights') state.lastQuery = null;
    if (product === 'hotels') state.lastHotelQuery = null;
    if (product === 'cash') state.lastCashQuery = null;
    $('results').innerHTML = `<div class="card empty search-error" role="alert"><strong>Search failed</strong><p>${esc(e.message)}</p><p>Check the dates, airport or city names, and your data connection, then try again.</p></div>`;
    $('resultMeta').textContent = 'No results for this search.';
    msg.textContent = `Search failed: ${e.message}`;
  } finally { if (live()) busy($('searchBtn'), false); }
}

function truncatedNotice(r) {
  const text = truncationNotice(r);
  return text ? `<div class="note" role="note">${esc(text)}</div>` : '';
}

function sourceTag(l) {
  if (l.dataSource === 'seats.aero') return `<span class="tag">SEATS.AERO · ${Number.isFinite(l.ageHours) ? `captured ${l.ageHours < 1 ? '<1' : Math.round(l.ageHours)}h ago` : 'capture time unknown'}</span>`;
  return `<span class="tag muted">MANUAL · ${l.ageHours < 24 ? 'today' : `${Math.round(l.ageHours / 24)}d old`}</span>`;
}

function warningsBox(list) {
  const items = [...new Set(list)].filter(Boolean);
  return items.length ? `<div class="warnbox"><strong>Check before you transfer:</strong><ul>${items.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
}

function rawAwardList(title, rows) {
  if (!rows?.length) return '';
  return `<div class="note"><strong>${esc(title)}</strong><br>${rows.map(r => `${esc(r.programName)}: ${esc(r.origin)}→${esc(r.destination)} ${dateFmt(r.date)}, ${fmt(r.mileageCost)} pts/person`).join('<br>')}</div>`;
}

function renderFlightResults(r) {
  state.lastAwardResult = r;
  const trips = r.trips || [];
  $('resultMeta').textContent = `${fmt(r.outbound?.length || 0)} outbound · ${fmt(r.return?.length || 0)} return flight options${trips.length ? ` · recommended pair selected` : ''}`;
  const monitorBtn = '<button class="btn" data-action="monitor">🔔 Monitor this trip</button>';
  const manualBtn = '<button class="btn" data-action="manual">Add an award manually</button>';
  const apiWarn = warningsBox(r.dataStatus.warnings) + truncatedNotice(r);
  if (!r.outbound?.length || (r.query.back && !r.return?.length)) {
    $('kpiScore').textContent = '—'; $('kpiHint').textContent = 'no fundable option';
    const why = {
      'no-inventory': 'No award space was found for these dates.',
      'no-valid-pairs': 'Outbound and return space exist, but no return is on or after an outbound date.',
      unaffordable: 'Award space exists, but your current balances and transfer partners can\'t cover it.'
    }[r.mode] || 'Nothing matched.';
    const tip = r.dataStatus.api === 'not-configured' ? '<div class="note">Tip: add a seats.aero API key under <em>Data &amp; System</em> to search live availability automatically.</div>' : '';
    $('results').innerHTML = `${productHuntBanner(r)}<div class="card empty"><strong>${esc(why)}</strong>${apiWarn}${rawAwardList('Cheapest outbound seen', r.cheapestOutbound)}${rawAwardList('Cheapest return seen', r.cheapestReturn)}${tip}<div class="btnrow">${monitorBtn}${manualBtn}</div></div>`;
    return;
  }
  award.r = r;
  award.seq += 1;
  state.bestTrip = null;
  award.pair = null;
  award.sel = { Outbound: r.recommended?.ids[0] || r.outbound[0]?.id || null, Return: r.recommended?.ids[1] || null };
  award.recIds = new Set(r.recommended?.ids || []);
  award.show = { Outbound: 25, Return: 25 };
  award.open = new Set();
  award.day = {};
  award.loading = new Set();
  const hasReturn = Boolean(r.query.back);
  const programs = [...new Set([...r.outbound, ...r.return].map(o => o.program))];
  const hunt = r.query.product;
  const cabinProducts = (state.products || []).filter(p => p.cabin === r.query.cabin);
  $('results').innerHTML = warningsBox(r.dataStatus.warnings) + truncatedNotice(r) + productHuntBanner(r) + `<div id="awSummary"></div>
    <details class="filters-disclosure" id="awFilters">
      <summary><strong>Filter and sort flights</strong><span id="filterSummary" class="muted">No filters · sorted by fewest points</span></summary>
      <div class="card filters">
      <div><label for="fMaxPts">Max points / person</label><input id="fMaxPts" type="number" min="0" step="5000" placeholder="Any" style="width:120px"></div>
      <div><label for="fMaxFees">Max fees / person</label><input id="fMaxFees" type="number" min="0" step="25" placeholder="Any" style="width:120px"></div>
      <div><label for="fMaxHours">Max travel time</label><select id="fMaxHours"><option value="">Any</option><option value="10">10h</option><option value="14">14h</option><option value="18">18h</option><option value="22">22h</option><option value="26">26h</option><option value="32">32h</option></select></div>
      <div><label for="fStops">Stops</label><select id="fStops"><option value="">Any</option><option value="0">Nonstop</option><option value="1">1 stop or fewer</option></select></div>
      <div><label for="fDepart">Departs</label><select id="fDepart"><option value="">Any time</option><option value="0-6">Overnight (12–6 AM)</option><option value="6-12">Morning (6 AM–12 PM)</option><option value="12-18">Afternoon (12–6 PM)</option><option value="18-24">Evening (6 PM–12 AM)</option></select></div>
      <div><label for="fSeat">Seat quality</label><select id="fSeat"><option value="">Any</option><option value="3">Lie-flat or better</option><option value="4">Excellent (direct aisle)</option><option value="5">Top-tier suites only</option></select></div>
      <div><label for="fProgram">Program</label><select id="fProgram"><option value="">All programs</option>${programs.map(p => `<option value="${esc(p)}">${esc(programLabel(p))}</option>`).join('')}</select></div>
      <div><label for="fProduct">Seat product</label><select id="fProduct" style="max-width:240px"><option value="">Any</option>${cabinProducts.map(p => `<option value="${esc(p.key)}"${hunt?.key === p.key ? ' selected' : ''}>${esc(p.airline)}: ${esc(p.product)}</option>`).join('')}</select></div>
      <div><label for="fSort">Sort by</label><select id="fSort"><option value="points">Fewest points</option><option value="fees">Lowest taxes &amp; fees</option><option value="stops">Fewest stops</option><option value="seat">Best seat</option><option value="duration">Shortest travel time</option><option value="depart">Departure time</option></select></div>
      <div><button class="btn small ghost" data-action="clear-filters">Clear filters</button></div>
      </div>
    </details>
    <p class="picker-intro">The optimizer’s <strong>RECOMMENDED</strong> option is preselected when available. Use dates, filters, and “Show more” to compare other fetched flights.</p>
    <div class="picker ${hasReturn ? '' : 'single'}"><div class="picker-col" id="awCol-Outbound"></div>${hasReturn ? '<div class="picker-col" id="awCol-Return"></div>' : ''}</div>`;
  $('awFilters').addEventListener('input', () => { award.show = { Outbound: 25, Return: 25 }; renderColumns(); });
  renderColumns();
  renderAwardSummary();
  // Load the individual flights for the recommended days right away so times show immediately.
  (async () => {
    for (const leg of ['Outbound', 'Return']) if (award.day[leg]) await ensureExpanded(leg, award.day[leg]);
    if (award.r !== r) return;
    renderColumns();
    renderAwardSummary();
  })();
}

function productHuntBanner(r) {
  const h = r.dataStatus.productHunt;
  if (!h) return '';
  const m = h.matches || { outbound: 0, return: 0 };
  const found = m.outbound + m.return;
  const where = [m.outbound ? `${m.outbound} outbound` : '', r.query.back && m.return ? `${m.return} return` : ''].filter(Boolean).join(' and ');
  return `<div class="card searchbox" style="margin-bottom:12px;border-color:${found ? 'var(--green)' : 'var(--amber-line)'}"><div class="cardhead"><div>
      <div class="eyebrow">Seat search · ${esc(h.label)}</div>
      <h3>${found ? `Found ${where} flight${found > 1 ? 's' : ''} with ${esc(h.label)}` : `No ${esc(h.label)} space found on these dates`}</h3>
      <p>Checked ${h.checkedAwards} award${h.checkedAwards === 1 ? '' : 's'} operated by ${esc(h.carrier)}${h.calls ? ` (${h.calls} seats.aero call${h.calls > 1 ? 's' : ''})` : ''}. Matching flights are marked ✓ and listed first; the "Seat product" filter shows only them.${found ? '' : ' Airlines often release this cabin to partners late or only to their own program. Try more date flexibility, or set an alert.'}</p></div>
      <button class="btn${found ? '' : ' primary'}" data-action="product-alert"><svg class="icon"><use href="#i-bell"/></svg>Alert me for ${esc(h.label)}</button></div></div>`;
}

// ---------- award results: pick an outbound and a return ----------
const award = { r: null, sel: { Outbound: null, Return: null }, recIds: new Set(), show: {}, open: new Set(), seq: 0, day: {}, loading: new Set() };
let activePurchaseQuote = null;
const SEAT_TIER = { 5: 'Top-tier suite', 4: 'Excellent lie-flat', 3: 'Lie-flat', 2: 'Older lie-flat', 1: 'Recliner', 0: 'Standard seat' };
const seatChip = p => (p && p.type ? `<span class="seatchip s${p.score ?? 0}" title="${esc(SEAT_TIER[p.score] || '')}: ${esc(p.detail || '')}${p.certainty === 'varies' ? ' (varies by aircraft)' : ''}">${p.score >= 3 ? '★'.repeat(p.score - 2) + ' ' : ''}${esc(p.type)}${p.certainty === 'varies' ? ' *' : ''}</span>` : '');
const dayLabel = d => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const optById = id => [...(award.r?.outbound || []), ...(award.r?.return || [])].find(o => o.id === id) || null;

function filteredOptions(leg) {
  const list = (leg === 'Outbound' ? award.r.outbound : award.r.return) || [];
  const v = id => $(id)?.value || '';
  const maxPts = Number(v('fMaxPts')) || 0, maxFees = v('fMaxFees') === '' ? null : Number(v('fMaxFees')), maxH = Number(v('fMaxHours')) || 0, stops = v('fStops'), dep = v('fDepart'), seat = Number(v('fSeat')) || 0, prog = v('fProgram'), sort = v('fSort') || 'points';
  const wantProduct = productOf(v('fProduct'));
  const out = list.filter(o => {
    const f = o.flight;
    const duration = f?.totalDurationMin ?? o.totalDurationMin;
    const rawStops = f?.stops ?? o.stops;
    const stopsCount = rawStops != null && Number.isFinite(Number(rawStops)) ? Number(rawStops) : o.direct === true ? 0 : null;
    if (maxPts && o.mileageCost > maxPts) return false;
    if (maxFees != null && (!Number.isFinite(maxFees) || o.totalTaxes == null || o.totalTaxes > maxFees)) return false;
    if (maxH && (duration == null || !Number.isFinite(Number(duration)) || duration > maxH * 60)) return false;
    if (stops && (stopsCount == null || stopsCount > Number(stops))) return false;
    if (dep) { if (!f?.depart?.time) return false; const h = Number(f.depart.time.slice(0, 2)); const [a, b] = dep.split('-').map(Number); if (h < a || h >= b) return false; }
    if (seat && !((o.seatScore ?? -1) >= seat)) return false;
    if (prog && o.program !== prog) return false;
    if (wantProduct && !optHasProduct(o, wantProduct)) return false;
    return true;
  });
  const cmp = {
    points: (a, b) => a.mileageCost - b.mileageCost || (b.seatScore ?? -1) - (a.seatScore ?? -1),
    fees: (a, b) => (a.totalTaxes ?? Infinity) - (b.totalTaxes ?? Infinity) || a.mileageCost - b.mileageCost,
    stops: (a, b) => (a.flight?.stops ?? (a.direct === true ? 0 : Infinity)) - (b.flight?.stops ?? (b.direct === true ? 0 : Infinity)) || a.mileageCost - b.mileageCost,
    seat: (a, b) => (b.seatScore ?? -1) - (a.seatScore ?? -1) || a.mileageCost - b.mileageCost,
    duration: (a, b) => (a.flight?.totalDurationMin ?? Infinity) - (b.flight?.totalDurationMin ?? Infinity) || a.mileageCost - b.mileageCost,
    depart: (a, b) => String(a.flight?.departUtc || `${a.date}T99`).localeCompare(String(b.flight?.departUtc || `${b.date}T99`))
  }[sort];
  return out.sort(cmp);
}

function updateFilterSummary() {
  const summary = $('filterSummary');
  if (!summary) return;
  const values = [
    'fMaxPts', 'fMaxFees', 'fMaxHours', 'fStops', 'fDepart', 'fSeat', 'fProgram', 'fProduct'
  ];
  const active = values.filter(id => {
    const value = $(id)?.value;
    return Boolean(value) && (id !== 'fMaxPts' || Number(value) > 0);
  }).length;
  const sort = ({ points: 'fewest points', fees: 'lowest fees', stops: 'fewest stops', seat: 'best seat', duration: 'shortest time', depart: 'earliest departure' })[$('fSort')?.value] || 'fewest points';
  summary.textContent = active ? `${active} filter${active === 1 ? '' : 's'} active · sorted by ${sort}` : `No filters · sorted by ${sort}`;
}

/** Choose a flight: clears the stale evaluation so nothing can act on the previous pair. */
function selectOption(leg, id) {
  if (award.sel[leg] === id) return;
  award.sel[leg] = id;
  state.bestTrip = null;
  award.pair = null;
  renderColumns(); renderAwardSummary();
}

function returnConflict(o) {
  const out = optById(award.sel.Outbound);
  if (!out) return null;
  if (out.flight?.arriveUtc && o.flight?.departUtc) return o.flight.departUtc <= out.flight.arriveUtc ? 'Leaves before your outbound flight lands' : null;
  return o.date < out.date ? 'Before your outbound date' : null;
}

function optCard(o, leg) {
  const f = o.flight, selected = award.sel[leg] === o.id, rec = award.recIds.has(o.id);
  const conflict = leg === 'Return' ? returnConflict(o) : null;
  const stopsTxt = f ? (f.stops === 0 ? 'Nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''} · ${f.layovers.map(l => `${esc(l.airport)} ${dur(l.durationMin)}`).join(', ')}`) : (o.direct === true ? 'Nonstop' : '');
  const open = award.open.has(o.id);
  const rid = `opt-${leg}-${o.id}`;
  return `<div class="opt${selected ? ' selected' : ''}${conflict ? ' dim' : ''}" data-select="${esc(o.id)}" data-leg="${leg}">
    ${selected ? '<span class="check">✓ SELECTED</span>' : rec ? '<span class="check" style="background:var(--green)">RECOMMENDED</span>' : ''}
    <div class="row1"><div class="opt-pick"><input type="radio" class="opt-radio" name="sel-${leg}" id="${esc(rid)}" value="${esc(o.id)}" data-leg="${leg}"${selected ? ' checked' : ''}${conflict ? ` aria-describedby="${esc(rid)}-c"` : ''}><label for="${esc(rid)}"><div class="times">${f ? `${t12(f.depart?.time)} → ${t12(f.arrive?.time)}${plusDays(f.arriveDayOffset)}` : esc(dayLabel(o.date))}</div>
      <div class="meta">${f ? `${esc(dayLabel(f.depart?.date))} · ${dur(f.totalDurationMin)} · ${stopsTxt}` : `${esc(o.origin)} → ${esc(o.destination)}${stopsTxt ? ` · ${stopsTxt}` : ''} · flight times not available`}</div></label></div>
      <div class="pts">${fmt(o.mileageCost)}<div class="meta" style="font-weight:500">${taxText(o)} / person</div></div></div>
    <div class="meta2">${seatChip(f?.product)} ${f?.product?.aircraft ? `<span>${esc(f.product.aircraft)}</span>` : ''}<span>${esc(o.programName)}</span>${f ? `<span>${esc(f.airlines.join(', '))} ${esc(f.flightNumbers.join(' / '))}</span>` : (o.airlines ? `<span>${esc(o.airlines)}</span>` : '')}${o.remainingSeats ? `<span>${o.remainingSeats} seat(s)</span>` : ''}${o.history ? `<span class="history-badge" style="margin:0">${esc(o.history.label)}</span>` : ''}${sourceTag(o)}
      ${f || o.availabilityId ? `<button class="btn small ghost" data-action="opt-details" data-id="${esc(o.id)}">${open ? 'Hide details' : 'Flight details'}</button>` : ''}</div>
    ${award.r?.query.product && optHasProduct(o, award.r.query.product) ? `<div class="meta2"><span class="flag good">✓ ${esc(award.r.query.product.product)} on this flight</span></div>` : ''}
    ${flagsFor(o, leg) ? `<div class="meta2">${flagsFor(o, leg)}</div>` : ''}
    ${conflict ? `<div class="meta" id="${esc(rid)}-c" style="color:var(--amber)">${esc(conflict)}</div>` : ''}
    ${open ? `<div class="details">${f ? renderTrip({ ...f, mileageCost: o.mileageCost, taxes: o.totalTaxes }) : `<div class="trips" data-load-trips="${esc(o.availabilityId)}" data-cabin="${esc(o.cabin)}"></div>`}</div>` : ''}
  </div>`;
}

// ---------- day-first picker: choose a day, then exactly one flight on that day ----------
const legList = leg => (leg === 'Outbound' ? award.r.outbound : award.r.return) || [];
const setLegList = (leg, list) => { if (leg === 'Outbound') award.r.outbound = list; else award.r.return = list; };
const dayKey = o => o.flight?.depart?.date || o.date;
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const kpts = n => (n >= 100000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k`);

/** "Book with Flying Blue ↗": seats.aero's deep link when we have one, else the program's site. */
function bookLink(o) {
  const deep = (o.bookingLinks || []).find(l => l.primary) || (o.bookingLinks || [])[0];
  const url = safeUrl(deep?.url) || safeUrl(state.programs.find(p => p.id === o.program)?.bookingUrl);
  return url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noreferrer" style="margin-left:auto">Book with ${esc(String(o.programName || '').replace(/^(Air Canada |United |American Airlines |Air France\/KLM )/, ''))} ↗</a>` : '';
}

const taxText = o => (o.taxesMissing ? (o.totalTaxes != null ? `+ ≈${money(o.totalTaxes)} est.` : '+ taxes ?') : o.totalTaxes != null ? `+ ${money(o.totalTaxes)}` : '+ taxes ?');

// Warnings worth seeing at a glance: much longer than typical, tight/long layovers, mixed cabin, price outliers.
function flagsFor(o, leg) {
  const flags = [];
  if (o.taxesMissing) flags.push(['', o.taxesEstimate ? `TAXES NOT REPORTED: ≈${money(o.taxesEstimate.value)} EST.` : 'TAXES NOT REPORTED: CHECK PROGRAM']);
  const list = legList(leg);
  const f = o.flight;
  if (f) {
    const medDur = median(list.filter(x => x.flight).map(x => x.flight.totalDurationMin));
    if (medDur && f.totalDurationMin > medDur * 1.3 && f.totalDurationMin - medDur >= 240) flags.push(['', `LONG: +${Math.round((f.totalDurationMin - medDur) / 60)}h vs typical`]);
    for (const l of f.layovers || []) {
      if (l.flag === 'very-tight') flags.push(['bad', `VERY TIGHT ${l.durationMin}m CONNECTION (${l.airport})`]);
      else if (l.flag === 'tight') flags.push(['', `TIGHT ${l.durationMin}m CONNECTION (${l.airport})`]);
      else if (l.flag === 'long') flags.push(['info', `${Math.round(l.durationMin / 60)}h LAYOVER (${l.airport})`]);
    }
    if (f.mixedCabinPct && f.mixedCabinPct < 100) flags.push(['', `MIXED CABIN: ${f.mixedCabinPct}% ${o.cabin}`]);
  }
  const medPts = median(list.map(x => x.mileageCost));
  if (medPts && o.mileageCost > medPts * 2) flags.push(['info', `${(o.mileageCost / medPts).toFixed(1)}× TYPICAL POINTS`]);
  return flags.map(([cls, t]) => `<span class="flag ${cls}">${esc(t)}</span>`).join('');
}

/** Replace award-level rows for a day with one option per flight (seats.aero trips, cached). */
async function ensureExpanded(leg, day) {
  award.loading ||= new Set();
  const result = award.r;
  const need = legList(leg).filter(o => dayKey(o) === day && !o.flight && o.availabilityId && !award.loading.has(o.id));
  if (!need.length) return;
  need.forEach(o => award.loading.add(o.id));
  // The expansion must honor the original search: send the nonstop constraint and re-apply it here.
  const directOnly = Boolean(result.query.directOnly);
  try {
    const r = await api('/api/award/expand', { method: 'POST', body: expandBody({ awards: need, leg, travelers: result.query.travelers, directOnly }) });
    if (award.r !== result) return; // a newer search replaced these results while we waited
    const ids = new Set(need.map(o => o.id));
    r.options = nonstopFilter(r.options, directOnly);
    setLegList(leg, [...legList(leg).filter(o => !ids.has(o.id)), ...r.options]);
    // If the selection/recommendation was an award (not a flight), pick its cheapest flight.
    const resolve = id => {
      if (!ids.has(id)) return id;
      const fl = r.options.filter(o => (o.awardId || o.id) === id).sort((a, b) => a.mileageCost - b.mileageCost || (a.flight?.totalDurationMin ?? 9e9) - (b.flight?.totalDurationMin ?? 9e9));
      return fl[0]?.id || id;
    };
    if (award.sel[leg]) award.sel[leg] = resolve(award.sel[leg]);
    award.recIds = new Set([...award.recIds].map(resolve));
    if (r.dataStatus.warnings.length) toast(r.dataStatus.warnings[0]);
  } catch (e) { need.forEach(o => award.loading.delete(o.id)); if (award.r === result) toast(e.message); }
}

const renderColumns = () => keepFocus(renderColumnsInner);
function renderColumnsInner() {
  updateFilterSummary();
  for (const leg of ['Outbound', 'Return']) {
    const col = $(`awCol-${leg}`);
    if (!col) continue;
    const all = legList(leg);
    const filtered = new Set(filteredOptions(leg));
    const q = award.r.query;
    const route = leg === 'Outbound' ? `${q.origins.join('/')} → ${q.destinations.join('/')}` : `${q.destinations.join('/')} → ${q.origins.join('/')}`;
    const sel = optById(award.sel[leg]);
    const days = [...new Set(all.map(dayKey))].sort();
    if (!award.day[leg] || !days.includes(award.day[leg])) award.day[leg] = sel ? dayKey(sel) : days[0];
    const open = award.day[leg];
    const dayCard = d => {
      const opts = all.filter(o => dayKey(o) === d);
      const pts = opts.map(o => o.mileageCost);
      const lo = Math.min(...pts), hi = Math.max(...pts);
      const known = opts.some(o => o.flight);
      const best = Math.max(-1, ...opts.map(o => o.seatScore ?? -1));
      const matches = opts.filter(o => filtered.has(o)).length;
      const programs = new Set(opts.map(o => o.program)).size;
      const hunt = award.r.query.product;
      const productHits = hunt ? opts.filter(o => optHasProduct(o, hunt)).length : 0;
      return `<button class="day${d === open ? ' open' : ''}" id="day-${leg}-${esc(d)}" aria-pressed="${d === open}" data-action="open-day" data-leg="${leg}" data-day="${esc(d)}">
        ${sel && dayKey(sel) === d ? '<span class="has-sel">✓</span>' : ''}<b>${esc(dayLabel(d))}</b>
        <span class="rng">${lo === hi ? fmt(lo) : `${kpts(lo)}–${kpts(hi)}`} pts</span>
        <small>${known ? `${opts.length} flight${opts.length > 1 ? 's' : ''}` : `${programs} program${programs > 1 ? 's' : ''}`}${best >= 3 ? ` · ${'★'.repeat(best - 2)}` : ''}${known && matches < opts.length ? ` · ${matches} match` : ''}</small>
        ${productHits ? `<small style="color:var(--green);font-weight:700">✓ ${productHits} ${esc(hunt.product)}</small>` : ''}</button>`;
    };
    // Wide date windows read better as a calendar (like seats.aero's availability calendar).
    const win = leg === 'Outbound' ? q.out : q.back;
    const span = win ? Math.round((Date.parse(win.end) - Date.parse(win.start)) / 86400000) + 1 : 0;
    const fitsWindow = win && days.every(d => d >= win.start && d <= win.end);
    let dayCards;
    if (fitsWindow && span > 7 && span <= 42) {
      const lead = new Date(`${win.start}T00:00:00Z`).getUTCDay();
      const cells = [...Array(lead).fill('<div></div>')];
      for (let i = 0; i < span; i++) {
        const d = addDays(win.start, i);
        cells.push(days.includes(d) ? dayCard(d) : `<div class="empty-day">${new Date(`${d}T00:00:00Z`).getUTCDate()}</div>`);
      }
      dayCards = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(x => `<div class="dow">${x}</div>`).join('') + cells.join('');
    } else dayCards = days.map(dayCard).join('');
    const calendar = Boolean(fitsWindow && span > 7 && span <= 42);
    const dayOpts = all.filter(o => dayKey(o) === open);
    const loading = dayOpts.some(o => !o.flight && o.availabilityId && award.loading?.has(o.id));
    const list = filteredOptions(leg).filter(o => dayKey(o) === open);
    const hidden = dayOpts.length - list.length;
    const pinned = sel && dayKey(sel) === open && !list.includes(sel) ? `<div class="meta" style="margin-bottom:6px">Your selection is hidden by the filters:</div>${optCard(sel, leg)}` : '';
    col.innerHTML = `<h3>${leg === 'Outbound' ? '1. Outbound' : '2. Return'} <small>${esc(route)} · ${days.length} day${days.length > 1 ? 's' : ''}</small></h3>
      <div class="days${calendar ? ' calendar' : ''}">${dayCards}</div>
      <div class="daylist-head"><strong>${esc(dayLabel(open))}: choose one flight</strong><span class="muted">${list.length} shown${hidden ? ` · ${hidden} hidden by filters` : ''}</span></div>
      ${loading ? '<div class="card empty">Loading every flight for this day…</div>' : ''}
      ${pinned}<div class="opts" role="radiogroup" aria-label="${leg} flights on ${esc(dayLabel(open))}">${list.slice(0, award.show[leg]).map(o => optCard(o, leg)).join('') || (loading ? '' : '<div class="card empty">No flights match these filters on this day.</div>')}</div>
      ${list.length > award.show[leg] ? `<button class="btn small more" data-action="more" data-leg="${leg}">Show ${Math.min(25, list.length - award.show[leg])} more</button>` : ''}`;
    col.querySelectorAll('[data-load-trips]').forEach(el => loadTrips(el, el.dataset.loadTrips, el.dataset.cabin));
    upgradeSeatMaps(col);
  }
}

async function openDay(leg, day) {
  const result = award.r;
  award.day[leg] = day;
  award.show[leg] = 25;
  renderColumns();
  await ensureExpanded(leg, day);
  if (award.r !== result) return;
  renderColumns();
  renderAwardSummary();
}

function summaryLeg(o, label) {
  if (!o) return `<div class="summary-leg" style="background:var(--surface-2)"><div class="lbl">${label}</div><div class="sub">Choose a flight below</div></div>`;
  const f = o.flight;
  return `<div class="summary-leg"><div class="lbl">${label} · ${esc(dayLabel(f?.depart?.date || o.date))}</div>
    <div class="times">${f ? `${t12(f.depart?.time)} ${esc(f.origin)} → ${t12(f.arrive?.time)} ${esc(f.destination)}${plusDays(f.arriveDayOffset)}` : `${esc(o.origin)} → ${esc(o.destination)}`}</div>
    <div class="sub">${f ? `${dur(f.totalDurationMin)} · ${f.stops === 0 ? 'Nonstop' : `via ${f.layovers.map(l => esc(l.airport)).join(', ')}`} · ${esc(f.flightNumbers.join(' / '))}` : 'Flight times not available'}</div>
    <div class="meta2" style="margin-top:6px">${seatChip(f?.product)}<span>${esc(o.programName)} · ${fmt(o.mileageCost)} pts ${taxText(o)} / person</span>${bookLink(o)}${flagsFor(o, o.leg === 'Return' ? 'Return' : 'Outbound')}</div></div>`;
}

async function renderAwardSummary() {
  const out = optById(award.sel.Outbound), back = optById(award.sel.Return);
  const hasReturn = Boolean(award.r.query.back);
  const isRec = award.recIds.size && [...award.recIds].every(id => id === award.sel.Outbound || id === award.sel.Return);
  const box = $('awSummary');
  state.bestTrip = null;
  activePurchaseQuote = null;
  const clientConflict = hasReturn && back ? returnConflict(back) : null;
  award.pair = pairAddability({ clientConflict });
  keepFocus(() => { box.innerHTML = `<div class="card summary-card"><div class="cardhead"><div><div class="eyebrow">Your trip${isRec ? ' · recommended' : ''}</div><h3 id="awHeadline">${out ? 'Calculating…' : 'Choose your flights'}</h3></div>
      ${!isRec && award.recIds.size ? '<button class="btn small" data-action="reset-rec">Back to recommended</button>' : ''}</div>
    <div class="summary-legs">${summaryLeg(out, 'Outbound')}${hasReturn ? summaryLeg(back, 'Return') : ''}</div>
    <div id="awFunding"></div><div id="cashCompare"></div>
    <div class="btnrow"><button class="btn primary" id="awAddBuilder" data-action="add-builder"${out && award.pair.ok ? '' : ' disabled'}${award.pair.ok ? '' : ` title="${esc(award.pair.reason)}"`}><svg class="icon"><use href="#i-map"/></svg>Add to Trip Builder</button><button class="btn" data-action="compare-cash" disabled><svg class="icon"><use href="#i-tag"/></svg>Compare purchase vs cash</button><button class="btn" data-action="monitor-open"><svg class="icon"><use href="#i-bell"/></svg>Set an alert</button></div>
    <div id="awAlertPanel" class="note" hidden>
      <strong>Alert me when…</strong>
      <div class="btnrow" style="margin-top:8px">
        <select id="alertMode">
          ${out?.flight ? `<option value="exact">These exact flights (${esc([out, back].filter(Boolean).map(o => o.flight?.flightNumbers.join('/') || o.date).join(' + '))}) are available</option>
          <option value="similar" selected>These flights or similar: same day, ≤10% more points, same or better seat</option>` : ''}
          <option value="any"${out?.flight ? '' : ' selected'}>Any award on these dates fits my points</option>
        </select>
        <input id="alertMaxPts" class="inputnum" type="number" min="0" step="5000" placeholder="Max pts / person">
        <input id="alertMaxFees" class="inputnum" type="number" min="0" step="25" placeholder="Max fees / person">
        <input id="alertMinSeats" class="inputnum" type="number" min="0" max="9" step="1" placeholder="Min seats">
        <label class="check" style="font-size:12px">Cabin coverage <select id="alertMinCabinPct"><option value="0">Any / unknown</option><option value="80">At least 80%</option><option value="90">At least 90%</option><option value="100">100% only</option></select></label>
        <button class="btn primary small" data-action="monitor-create">Create alert</button>
      </div>
      <p class="muted" style="margin:6px 0 0;font-size:12px">Checked in the background (Data &amp; System → alert interval); you get a Windows notification when it matches or the price drops.</p>
    </div></div>`; });
  if (!out) return;
  if (!award.pair.ok) $('awFunding').innerHTML = `<div class="warnbox" role="alert">${esc(award.pair.reason)}</div>`;
  const seq = ++award.seq;
  const legs = [out, ...(hasReturn && back ? [back] : [])];
  try {
    const r = await api('/api/trip/evaluate', { method: 'POST', body: { legs, origins: award.r.query.origins, destinations: award.r.query.destinations, travelers: award.r.query.travelers, preserveFlexible: $('keepFlexible').checked } });
    if (seq !== award.seq) return;
    // Backend verdict (DOM-4): valid === false blocks the pair; absent means older backend, rely on the client check.
    award.pair = pairAddability({ valid: r.valid, invalidReason: r.invalidReason, clientConflict });
    const addBtn = $('awAddBuilder');
    if (addBtn) { addBtn.disabled = !award.pair.ok; addBtn.title = award.pair.ok ? '' : award.pair.reason; }
    if (!award.pair.ok) { $('awHeadline').textContent = 'These flights cannot be combined'; $('awFunding').innerHTML = `<div class="warnbox" role="alert">${esc(award.pair.reason)}</div>`; state.bestTrip = null; return; }
    const cmp = document.querySelector('[data-action="compare-cash"]'); if (cmp) cmp.disabled = false;
    activePurchaseQuote = { legs, travelers: award.r.query.travelers, trip: r.affordable ? r.trip : null };
    if (!r.affordable) { $('awHeadline').textContent = r.fundingStatus === 'search-limited' ? 'Funding could not be confirmed' : 'Not covered by your current points'; $('awFunding').innerHTML = `<div class="warnbox">${esc(r.reason)} You can still add these flights to your Trip Builder as a draft, or compare the cost to buy the target program points with the cash fare.</div>`; const add = $('awAddBuilder'); if (add) add.textContent = 'Add draft to Trip Builder'; state.bestTrip = null; return; }
    const t = r.trip;
    const add = $('awAddBuilder'); if (add) add.textContent = 'Add to Trip Builder';
    state.bestTrip = t;
    $('awHeadline').textContent = `${fmt(t.totalSourcePoints)} points + ${money(t.taxesUsd)} for ${t.travelers} traveler${t.travelers > 1 ? 's' : ''}${hasReturn && !back ? ' (outbound only so far)' : ''}`;
    $('kpiScore').textContent = money(t.effectiveCostUsd);
    $('kpiHint').textContent = `${fmt(t.totalSourcePoints)} pts + ${money(t.taxesUsd)}`;
    const path = t.sources.map(s => `<span class="node">${s.direct ? `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} (have)` : `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} → ${fmt(s.targetPoints)} ${esc(programLabel(s.targetProgram))}${s.bonusPct ? ` (+${Math.round(s.bonusPct * 100)}%)` : ''}`}</span>`).join('');
    $('awFunding').innerHTML = `<div class="metrics" style="margin-top:12px"><div class="metric"><span>Award points needed</span><b>${fmt(t.totalTargetPoints)}</b></div><div class="metric"><span>Taxes &amp; fees${t.taxesEstimated ? ' (incl. estimate)' : ''}</span><b>${t.taxesEstimated ? '≈' : ''}${money(t.taxesUsd)}</b></div><div class="metric"><span>Effective cost</span><b>${money(t.effectiveCostUsd)}</b></div><div class="metric"><span id="valueMetricLabel">Value</span><b class="positive" id="valueMetric">${t.cpp ? `${t.cpp.toFixed(2)}¢/pt` : 'compare with cash ↓'}</b></div></div>
      <div class="path">${path}</div>${warningsBox(t.warnings)}`;
  } catch (e) {
    if (seq !== award.seq || isAbort(e)) return;
    // A 400 (INVALID_INPUT) means the backend rejected this pair: show its reason and block adding it.
    if (e.status === 400 || e.code === 'INVALID_INPUT') {
      award.pair = pairAddability({ valid: false, invalidReason: e.message });
      const addBtn = $('awAddBuilder');
      if (addBtn) { addBtn.disabled = true; addBtn.title = e.message; }
      $('awHeadline').textContent = 'These flights cannot be combined';
      state.bestTrip = null;
      $('awFunding').innerHTML = `<div class="warnbox" role="alert">${esc(e.message)}</div>`;
      return;
    }
    $('awFunding').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`;
  }
}

async function addSelectionToBuilder() {
  if (award.pair && !award.pair.ok) return toast(award.pair.reason);
  const out = optById(award.sel.Outbound), back = award.r.query.back ? optById(award.sel.Return) : null;
  try {
    await api('/api/trip-plan/flights', { method: 'PUT', body: { outbound: out, return: back, origins: award.r.query.origins, destinations: award.r.query.destinations, travelers: award.r.query.travelers, cabin: award.r.query.cabin } });
    toast('Flights added to your Trip Builder.');
    showView('builder');
  } catch (e) { toast(e.message); }
}

// ---------- flight details (seats.aero trips) ----------
const dur = m => (m == null ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
const t12 = hhmm => { if (!hhmm) return '—'; const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const plusDays = n => (n > 0 ? `<span class="plus">+${n}</span>` : n < 0 ? `<span class="plus">${n}</span>` : '');

function renderTrip(t) {
  const segs = t.segments.map((s, i) => `
    ${i > 0 ? `<div class="layover">Layover in ${esc(t.layovers[i - 1].city || t.layovers[i - 1].airport)} (${esc(t.layovers[i - 1].airport)}) · ${dur(t.layovers[i - 1].durationMin)}${t.layovers[i - 1].overnight ? ' · overnight' : ''}</div>` : ''}
    <div class="seg-row">
      <div><b>${esc(s.flightNumber || '')}</b><div class="muted">${esc(s.airline || s.carrier || '')}</div><div class="muted">${dur(s.durationMin)}</div></div>
      <div><b>${t12(s.depart?.time)}</b> ${esc(s.origin)}${s.originCity ? ` <span class="muted">${esc(s.originCity)}</span>` : ''}<br><b>${t12(s.arrive?.time)}</b>${s.arriveDayOffset ? `<span class="next-day">+${s.arriveDayOffset} day</span>` : ''} ${esc(s.destination)}${s.destinationCity ? ` <span class="muted">${esc(s.destinationCity)}</span>` : ''}<div class="muted">${esc(s.aircraft || 'Aircraft not listed')}${s.fareClass ? ` · fare class ${esc(s.fareClass)}` : ''}</div></div>
      <div class="seatinfo">${seatChip(s.seat)}<div class="muted">${esc(s.seat.detail)}${s.seat.certainty === 'varies' ? ' Varies by aircraft: check the seat map.' : ''}</div><div>${seatMapLinksHtml(s)}</div></div>
    </div>`).join('');
  return `<div class="trip"><div class="trip-head">
      <div><div class="trip-times">${t12(t.depart?.time)} → ${t12(t.arrive?.time)}${plusDays(t.arriveDayOffset)}</div>
      <div class="trip-meta">${dur(t.totalDurationMin)} total · ${t.stops === 0 ? 'Nonstop' : `${t.stops} stop${t.stops > 1 ? 's' : ''} via ${t.layovers.map(l => esc(l.airport)).join(', ')}`} · ${esc(t.airlines.join(', '))}${t.arriveDayOffset > 0 ? ` · <strong>arrives ${t.arriveDayOffset === 1 ? 'the next day' : `${t.arriveDayOffset} days later`} (${dateFmt(t.arrive.date)})</strong>` : ''}</div></div>
      <div style="text-align:right"><div class="trip-times">${t.mileageCost ? `${fmt(t.mileageCost)} pts` : ''}</div><div class="trip-meta">${t.taxes != null ? `${money(t.taxes)} taxes` : ''}${t.remainingSeats ? ` · ${t.remainingSeats} seat(s)` : ''}${t.mixedCabinPct && t.mixedCabinPct < 100 ? ` · ${t.mixedCabinPct}% in ${esc(t.cabin)}` : ''}</div></div>
    </div>${segs}</div>`;
}

async function loadTrips(el, id, cabin) {
  el.hidden = false;
  el.innerHTML = '<div class="muted">Loading flight details…</div>';
  try {
    const r = await api(`/api/award/trips?id=${encodeURIComponent(id)}&cabin=${encodeURIComponent(cabin || '')}`);
    if (!r.trips.length) { el.innerHTML = '<div class="muted">seats.aero has no flight-level details for this award.</div>'; return; }
    const links = r.bookingLinks.length ? `<div class="btnrow" style="margin-top:4px">${r.bookingLinks.slice(0, 3).map(l => `<a class="btn small${l.primary ? ' primary' : ''}" href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label)} ↗</a>`).join('')}</div>` : '';
    el.innerHTML = r.trips.slice(0, 4).map(renderTrip).join('') + (r.trips.length > 4 ? `<div class="muted">${r.trips.length - 4} more flight option(s) on this date.</div>` : '') + links;
    upgradeSeatMaps(el);
  } catch (e) { el.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
}

// ---------- seat maps: start with the airline page, upgrade to the exact aircraft page ----------
function seatMapLinksHtml(s) {
  const attrs = `data-sm-carrier="${esc(s.carrier || '')}" data-sm-aircraft="${esc(s.aircraft || '')}" data-sm-code="${esc(s.aircraftCode || '')}"`;
  return `<a ${attrs} data-sm="aerolopa" href="${esc(s.seatMaps?.aerolopa || 'https://www.aerolopa.com/')}" target="_blank" rel="noreferrer">AeroLOPA seat map ↗</a><a ${attrs} data-sm="seatmaps" href="${esc(s.seatMaps?.seatmaps || 'https://seatmaps.com/airlines/')}" target="_blank" rel="noreferrer">SeatMaps ↗</a><span class="sm-variants"></span>`;
}
const seatMapCache = new Map();
async function upgradeSeatMaps(root) {
  const links = [...root.querySelectorAll('a[data-sm]:not([data-sm-done])')].filter(a => a.dataset.smCarrier);
  const keys = [...new Set(links.map(a => `${a.dataset.smCarrier}|${a.dataset.smAircraft}|${a.dataset.smCode}`))];
  for (const key of keys) {
    if (!seatMapCache.has(key)) {
      const [carrier, aircraft, code] = key.split('|');
      seatMapCache.set(key, api(`/api/seatmaps?carrier=${encodeURIComponent(carrier)}&aircraft=${encodeURIComponent(aircraft)}&code=${encodeURIComponent(code)}`).catch(() => null));
    }
    const r = await seatMapCache.get(key);
    if (!r) continue;
    for (const a of links.filter(l => `${l.dataset.smCarrier}|${l.dataset.smAircraft}|${l.dataset.smCode}` === key)) {
      a.dataset.smDone = '1';
      const target = r[a.dataset.sm];
      if (!safeUrl(target?.url)) continue;
      a.href = target.url;
      a.title = target.exact ? 'Seat map for this aircraft' : 'Exact aircraft not found: opens the airline page';
      if (a.dataset.sm === 'aerolopa' && r.aerolopa.variants?.length > 1) {
        const v = a.parentElement.querySelector('.sm-variants');
        if (v) v.innerHTML = `<br><span class="muted">AeroLOPA layouts: ${r.aerolopa.variants.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noreferrer">${esc(x.label.replace(/^.*\(/, '').replace(')', ''))}</a>`).join(' ')}</span>`;
      }
    }
  }
}

function currentHotelQuery() {
  const q = {
    destination: $('destination').value.trim(), checkIn: $('dateFrom').value, checkOut: $('dateTo').value || null,
    flexDays: Number($('flex').value), roomType: $('cabin').value, rank: $('rank').value, preserveFlexible: $('keepFlexible').checked
  };
  // One room for two adults is the long-standing default and sends nothing extra. Anything else is explicit.
  const built = buildRooms(roomsState.rows);
  const cashOffers = $('cashOffers').checked;
  if (built.ok && (!built.isDefault || cashOffers)) q.rooms = built.rooms;
  if (cashOffers) { q.cashOffers = true; q.currency = 'USD'; }
  return q;
}

// ---------- rooms (explicit allocation; never split automatically) ----------
const roomsState = { rows: [{ ...DEFAULT_ROOM }] };
function renderRooms() {
  const n = roomsState.rows.length;
  $('roomsList').innerHTML = roomsState.rows.map((r, i) => `<div class="fk-roomrow" role="group" aria-label="Room ${i + 1}"><strong>Room ${i + 1}</strong>
    <div><label for="roomAdults${i}">Adults</label><select id="roomAdults${i}" data-room="${i}" data-room-field="adults">${Array.from({ length: ROOM_LIMITS.adults }, (_, k) => `<option${Number(r.adults) === k + 1 ? ' selected' : ''}>${k + 1}</option>`).join('')}</select></div>
    <div><label for="roomKids${i}">Children's ages</label><input id="roomKids${i}" data-room="${i}" data-room-field="childrenText" value="${esc(r.childrenText)}" placeholder="none, or e.g. 7, 3" autocomplete="off"></div>
    <div><label for="roomType${i}">Room type</label><select id="roomType${i}" data-room="${i}" data-room-field="roomType">${[['standard', 'Standard'], ['suite', 'Suite'], ['any', 'Any room']].map(([v, l]) => `<option value="${v}"${r.roomType === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <button type="button" class="btn small ghost" data-room-remove="${i}" aria-label="Remove room ${i + 1}"${n < 2 ? ' disabled' : ''}>Remove</button></div>`).join('');
  $('addRoom').disabled = n >= ROOM_LIMITS.rooms;
  const built = buildRooms(roomsState.rows);
  $('roomsError').textContent = built.ok ? '' : built.error;
}
$('roomsList').addEventListener('input', e => {
  const f = e.target.dataset?.roomField;
  if (!f) return;
  roomsState.rows[Number(e.target.dataset.room)][f] = e.target.value;
  const built = buildRooms(roomsState.rows);
  $('roomsError').textContent = built.ok ? '' : built.error;
});
$('roomsList').addEventListener('click', e => {
  const b = e.target.closest?.('[data-room-remove]');
  if (!b || roomsState.rows.length < 2) return;
  roomsState.rows.splice(Number(b.dataset.roomRemove), 1);
  renderRooms();
  $('addRoom').focus();
});
$('addRoom').onclick = () => {
  if (roomsState.rows.length >= ROOM_LIMITS.rooms) return;
  roomsState.rows.push({ ...DEFAULT_ROOM, roomType: roomsState.rows.at(-1).roomType });
  renderRooms();
  $(`roomAdults${roomsState.rows.length - 1}`).focus();
};
renderRooms();

/** One cash offer's money, in the offer's own currency. */
function cashAmount(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Number(v)); }
  catch { return `${Math.round(Number(v))} ${esc(currency || '')}`; }
}

/** Observed award, estimate for several rooms, what is unknown, optional cash offers, and the user-entered details form. */
function roomBlock(h, i) {
  const rs = roomSummary(h, fmt);
  const lines = rs.lines.map(l => `<p class="fk-roomline"><span class="muted">${esc(l.label)}</span> <strong>${esc(l.value)}</strong>${l.estimated ? ' <span class="tag warn">ESTIMATE</span>' : ''}</p>`).join('');
  const badges = rs.badges.length ? `<p>${rs.badges.map(b => `<span class="tag muted">${esc(b)}</span>`).join(' ')}</p>` : '';
  let offers = '';
  if (Array.isArray(h.cashOffers) && h.cashOffers.length) {
    offers = `<div class="note fk-cash" role="group" aria-label="Cash offer for requested occupancy"><strong>Cash offer for requested occupancy</strong> <span class="muted">Google Hotels, cash only. Its taxes and cancellation terms do not apply to your award booking.</span><ul>${h.cashOffers.slice(0, 4).map(o => {
      const before = cashAmount(o.totalBeforeTaxes, o.currency), after = cashAmount(o.totalAfterTaxes, o.currency);
      return `<li>${o.roomType ? `${esc(plainText(o.roomType))}: ` : ''}${before ? `${esc(before)} before taxes` : 'price unknown'} · ${after ? `${esc(after)} after taxes` : 'after-tax total unknown'} · ${o.freeCancellation === true ? 'free cancellation offered' : o.freeCancellation === false ? 'no free cancellation' : 'cancellation unknown'}${o.rawPolicyText ? `<div class="muted">${esc(plainText(o.rawPolicyText))}</div>` : ''}</li>`;
    }).join('')}</ul></div>`;
  } else if (state.lastHotelQuery?.cashOffers) offers = '<p class="muted fk-help">No cash offer was found for this occupancy.</p>';
  const form = `<details class="fk-evidence-form"><summary>Add details you confirmed with the program (user entered)</summary>
    <div class="formgrid fk-grid">
      <div class="span-2"><label for="ev${i}-source">Where you confirmed it</label><input id="ev${i}-source" maxlength="120" placeholder="e.g. Hyatt agent chat"></div>
      <div><label for="ev${i}-date">Date confirmed</label><input id="ev${i}-date" type="date"></div>
      <div><label for="ev${i}-roomCount">Rooms confirmed</label><input id="ev${i}-roomCount" type="number" min="1" max="${ROOM_LIMITS.rooms}"></div>
      <div><label for="ev${i}-taxes">Taxes (total)</label><input id="ev${i}-taxes" type="number" min="0" step="0.01"></div>
      <div><label for="ev${i}-resortFee">Resort fee</label><input id="ev${i}-resortFee" type="number" min="0" step="0.01"></div>
      <div><label for="ev${i}-currency">Currency</label><input id="ev${i}-currency" maxlength="3" value="USD"></div>
      <div class="span-2"><label for="ev${i}-cancellation">Cancellation terms (as stated)</label><input id="ev${i}-cancellation" maxlength="500"></div>
      <div class="fk-checkcell"><label class="check"><input type="checkbox" id="ev${i}-waived"> Resort fee waived</label></div>
      <div class="fk-checkcell"><label class="check"><input type="checkbox" id="ev${i}-occupancy"> They confirmed this room allocation</label></div>
    </div><p class="muted fk-help">Saved with the stay as <strong>user entered</strong>. PointPilot does not check it, and it says nothing about current availability.</p></details>`;
  return `${lines}${badges}${offers}${form}`;
}

/** Read the optional user-entered details for hotel card i. */
function readEvidenceForm(i, rooms) {
  const v = id => $(`ev${i}-${id}`);
  if (!v('source')) return { ok: true, evidence: null };
  return buildProgramEvidence({
    source: v('source').value, date: v('date').value, roomCount: v('roomCount').value, taxes: v('taxes').value, resortFee: v('resortFee').value,
    currency: v('currency').value, cancellation: v('cancellation').value, resortFeeWaived: v('waived').checked, occupancyConfirmed: v('occupancy').checked
  }, rooms);
}

/** Small occupancy / user-entered summary for a saved stay. */
function stayOccupancy(x) {
  const parts = [];
  const R = x.rooms?.length || 1;
  if (R > 1) parts.push(`${R} rooms · points are an estimate · room inventory unknown · occupancy unverified`);
  if (x.feesMissing === true && !(x.programEvidence?.taxes || x.programEvidence?.resortFee)) parts.push('Award taxes and resort fees unknown');
  const ev = x.programEvidence;
  if (ev) {
    const bits = [];
    if (ev.roomCount) bits.push(`${ev.roomCount.value} room${ev.roomCount.value === 1 ? '' : 's'} confirmed`);
    if (ev.occupancy) bits.push('room allocation confirmed');
    if (ev.taxes) bits.push(`taxes ${cashAmount(ev.taxes.amount, ev.taxes.currency) || 'unknown'}`);
    if (ev.resortFee) bits.push(ev.resortFee.waived ? 'resort fee waived' : `resort fee ${cashAmount(ev.resortFee.amount, ev.resortFee.currency) || 'unknown'}`);
    if (ev.cancellation) bits.push(`cancellation: ${plainText(ev.cancellation.text)}`);
    const first = Object.values(ev).find(e => e && e.source);
    parts.push(`<span class="tag muted">user entered</span> ${esc(bits.join(' · '))}${first ? ` (${esc(first.source)}, ${esc(first.date)})` : ''}`);
  }
  return parts.length ? `<small class="fk-occ">${parts.map(p => (p.startsWith('<') ? p : esc(p))).join('<br>')}</small>` : '';
}

function hotelTag(h) {
  if (h.dataSource === 'rooms.aero') return `<span class="tag">LIVE · ${h.ageHours < 1 ? '<1' : Math.round(h.ageHours)}h old</span>`;
  return `<span class="tag muted">MANUAL · ${h.ageHours < 24 ? 'today' : `${Math.round(h.ageHours / 24)}d old`}</span>`;
}

function fundingText(f) {
  if (!f) return '';
  return f.sources.map(s => s.direct ? `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} (have)` : `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} → ${fmt(s.targetPoints)} ${esc(programLabel(s.targetProgram))}${s.bonusPct ? ` (+${Math.round(s.bonusPct * 100)}%)` : ''}`).join(', ');
}

const catLabel = h => (h.category ? `<span class="cat">${esc(h.programName.replace(/^World of /, ''))} Cat ${esc(h.category)}</span>` : '');

function hotelQuality(h) {
  const i = h.info;
  const stars = i?.stars ? `<span class="stars" title="${i.stars}-star hotel (Google)">${'★'.repeat(i.stars)}<span class="muted" style="font-weight:500"> ${i.stars}-star</span></span>` : '';
  const rating = i?.rating ? `<a href="${esc(h.reviewLinks.google)}" target="_blank" rel="noreferrer" title="Google reviews">${i.rating.toFixed(1)} ★ Google${i.reviews ? ` (${fmt(i.reviews)} reviews)` : ''}</a>` : '';
  const awards = (h.awards || []).map(a => `<a class="award" href="${esc(a.url)}" target="_blank" rel="noreferrer" title="MICHELIN Guide distinction">${'🔑'.repeat(a.keys)} ${esc(a.label)}</a>`).join(' ');
  return { stars, rating, awards };
}

function hotelCard(h, i) {
  const link = safeUrl(h.bookingUrl);
  const q = hotelQuality(h);
  const L = h.reviewLinks || {};
  return `<div class="card result"><div>
    <h4>${esc(h.name)} ${catLabel(h)} ${hotelTag(h)} ${h.affordable ? '' : '<span class="tag warn">NOT ENOUGH POINTS</span>'}${h.estimated ? ' <span class="tag warn">ESTIMATED</span>' : ''}</h4>
    ${q.stars || q.rating || q.awards ? `<p class="quality">${[q.stars, q.rating, q.awards].filter(Boolean).join(' · ')}</p>` : ''}
    <p>${esc(h.location)} · ${esc(h.programName)} · ${esc(h.roomType)} · ${dateFmt(h.checkIn)} → ${dateFmt(addDays(h.checkIn, h.nights))} · ${h.nights} night(s)</p>
    <p>${fundingText(h.funding) || 'Your remaining balances and transfer partners can\'t cover this stay.'}</p>
    ${roomBlock(h, i)}
    <p class="links">Reviews &amp; awards: <a href="${esc(L.google)}" target="_blank" rel="noreferrer">Google</a> · <a href="${esc(L.tripadvisor)}" target="_blank" rel="noreferrer">TripAdvisor</a> · <a href="${esc(L.forbes)}" target="_blank" rel="noreferrer">Forbes Travel Guide</a> · <a href="${esc(L.michelin)}" target="_blank" rel="noreferrer">MICHELIN Guide</a>${h.info ? '' : ` · <button class="btn small ghost" data-action="hotel-info-one" data-i="${i}">Get star rating</button>`}</p>
    <div class="btnrow" style="margin-top:6px"><button class="btn small primary" data-action="add-stay" data-i="${i}"><svg class="icon"><use href="#i-plus"/></svg>Add to stay plan</button>${link ? `<a class="btn small" href="${esc(link)}" target="_blank" rel="noreferrer">View / book ↗</a>` : ''}</div>
  </div><div class="right"><span class="pts">${fmt(h.totalPoints)} pts</span>${h.roomEstimate?.rooms > 1 ? `<span class="subv fk-estimate">${esc(h.roomEstimateLabel || `Estimated points for ${h.roomEstimate.rooms} rooms`)}</span>` : ''}<span class="subv">${fmt(h.nightlyPoints)}/night${h.cashUsd ? ` · cash ${money(h.cashUsd)} · ${h.cpp.toFixed(2)}¢/pt` : ''}</span>${h.effectiveCostUsd != null ? `<span class="subv">${money(h.effectiveCostUsd)} in points value</span>` : ''}</div></div>`;
}

/** Load star class + Google rating for the hotels shown (one SerpApi search per program per city). */
async function loadHotelInfo(rows, mode = 'program') {
  const r = state.lastHotels;
  const byCity = new Map();
  for (const h of rows) { const c = h.hotelCity || h.city; if (!byCity.has(c)) byCity.set(c, []); byCity.get(c).push(h); }
  let calls = 0;
  for (const [city, hs] of byCity) {
    const res = await api('/api/hotels/enrich', { method: 'POST', body: { city, checkIn: r.query.checkIn, checkOut: r.query.checkOut, mode, hotels: hs.map(h => ({ name: h.name, city: h.hotelCity || h.city, program: h.program, latitude: h.latitude, longitude: h.longitude })) } });
    calls += res.calls;
    for (const h of state.hotelRows) if (res.info[h.infoKey]) h.info = res.info[h.infoKey];
  }
  renderHotels(r);
  const missing = rows.filter(h => !h.info).length;
  toast(`${calls ? `Used ${calls} SerpApi search${calls > 1 ? 'es' : ''}. ` : ''}${missing ? `${missing} hotel(s) not matched: use "Get star rating" on a card.` : 'Ratings loaded.'}`);
}

function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function renderHotels(r) {
  if (state.lastHotels !== r) { state.lastHotels = r; state.hotelRows = r.rows || []; state.hotelShow = {}; }
  const minStars = Number(state.hotelMinStars || 0);
  const allRows = state.hotelRows;
  // Filtering keeps original indexes so "Add to stay plan" still points at the right hotel.
  const rows = allRows;
  const visible = h => !minStars || (h.info?.stars || 0) >= minStars;
  const HOTEL_PAGE = 20;
  state.hotelShow ||= {};
  $('resultMeta').textContent = `${fmt(rows.filter(visible).length)} hotel award(s) in ${r.query.cities.join(', ')} · ${r.nights} night(s) · ${r.query.roomType === 'any' ? 'any room' : r.query.roomType}`;
  const best = rows.find(h => h.affordable);
  $('kpiScore').textContent = best ? `${fmt(best.totalPoints)} pts` : '—';
  $('kpiHint').textContent = best ? `${best.name}` : 'no affordable stay';
  if (rows.length) {
    const compare = r.cities.length > 1 ? `<div class="city-compare">${r.cities.map(c => `<div class="card city-card"><h3>${esc(c.city)}</h3>
        <p><b>${c.count}</b> hotel award(s) · <b>${c.affordable}</b> you can afford</p>
        ${c.cheapest ? `<p>Fewest points: <b>${fmt(c.cheapest.totalPoints)}</b> · ${esc(c.cheapest.name)}${c.cheapest.category ? ` (Cat ${esc(c.cheapest.category)})` : ''}</p>` : ''}
        ${c.bestValue ? `<p>Lowest points value: <b>${money(c.bestValue.effectiveCostUsd)}</b> · ${esc(c.bestValue.name)}</p>` : ''}
        <p>${esc(c.programs.join(', '))}</p></div>`).join('')}</div>` : '';
    const groups = r.query.cities.map(city => {
      const list = rows.map((h, i) => ({ h, i })).filter(x => x.h.city === city && visible(x.h));
      if (!list.length) return `<div class="city-head"><h3>${esc(city)}</h3><span class="muted">${minStars ? `No ${minStars}-star+ hotels with known ratings` : 'No award space found'}</span></div>`;
      const page = paginate(list, state.hotelShow[city] || HOTEL_PAGE, HOTEL_PAGE);
      const counts = `Showing ${fmt(page.shown)} of ${fmt(page.total)} option(s)`;
      return `${r.cities.length > 1 ? `<div class="city-head"><h3>${esc(city)}</h3><span class="muted">${counts}</span></div>` : ''}<div class="result-list">${page.items.map(x => hotelCard(x.h, x.i)).join('')}</div>
        ${r.cities.length > 1 && !page.remaining ? '' : `<div class="count-note" role="status">${r.cities.length > 1 ? '' : `${counts}. `}${page.remaining ? `<button class="btn small" data-action="hotel-more" data-city="${esc(city)}">Show ${fmt(page.nextStep)} more</button>` : ''}</div>`}`;
    }).join('');
    const monitorBtn = '<input id="hotelAlertMax" class="inputnum" type="number" min="0" step="1000" placeholder="Max pts/night" title="Optional: only alert at or below this many points per night"><button class="btn" data-action="monitor-hotel"><svg class="icon"><use href="#i-bell"/></svg>Monitor these stays</button>';
    const unknown = allRows.filter(h => !h.info).length;
    const programsByCity = new Set(allRows.filter(h => !h.info).map(h => `${h.city}|${h.program}`)).size;
    const toolbar = `<div class="card filters" style="margin-bottom:12px">
      <div><label for="hotelMinStars">Hotel class</label><select id="hotelMinStars"><option value="0">Any</option><option value="3"${minStars === 3 ? ' selected' : ''}>3-star+</option><option value="4"${minStars === 4 ? ' selected' : ''}>4-star+</option><option value="5"${minStars === 5 ? ' selected' : ''}>5-star only</option></select></div>
      ${unknown ? `<div><button class="btn small" data-action="hotel-info-all">Load star ratings &amp; reviews</button><span class="muted" style="font-size:12px;margin-left:6px">about ${programsByCity} SerpApi search${programsByCity === 1 ? '' : 'es'}, cached 60 days</span></div>` : '<div class="muted" style="font-size:12.5px">Ratings loaded (Google)</div>'}
      <div class="muted" style="font-size:12px">🔑 = MICHELIN Key hotel</div></div>`;
    const pn = r.dataStatus.planNote;
    const planUnfunded = Boolean(pn?.unfunded || r.unfunded);
    const stayWord = pn ? `${pn.stays} stay${pn.stays > 1 ? 's' : ''}` : '';
    // unfunded: the existing plan can't be paid for, so there is no "what's left" to claim.
    const planNote = !pn ? ''
      : planUnfunded ? `<div class="warnbox" role="alert"><strong>Your stay plan (${stayWord}) is not fully fundable with your current balances.</strong> The payments below are calculated against your full balances, so they may overlap points the plan already needs. Fix the plan first or treat these as estimates.</div>`
      : `<div class="note">Payments below use what's left <strong>after the ${stayWord} already in your stay plan</strong> (${(pn.committed || []).map(c => `${fmt(c.points)} ${esc(programLabel(c.from))}`).join(', ')} committed).</div>`;
    $('results').innerHTML = warningsBox(r.dataStatus.warnings) + truncatedNotice(r) + planNote + toolbar + compare + groups + `<div class="btnrow">${monitorBtn}</div>`;
    $('hotelMinStars').onchange = e => { state.hotelMinStars = Number(e.target.value); state.hotelShow = {}; keepFocus(() => renderHotels(r)); };
    return;
  }
  const monitorBtn = '<input id="hotelAlertMax" class="inputnum" type="number" min="0" step="1000" placeholder="Max pts/night" title="Optional: only alert at or below this many points per night"><button class="btn" data-action="monitor-hotel"><svg class="icon"><use href="#i-bell"/></svg>Monitor these stays</button>';
  const tip = r.dataStatus.api === 'not-configured' ? '<div class="note">Tip: your seats.aero key also unlocks live hotel search (rooms.aero). Add it under <em>Data &amp; System</em>.</div>' : '';
  $('results').innerHTML = `<div class="card empty"><strong>No hotel award space found in ${esc(r.query.cities.join(', '))} for these dates.</strong>Try nearby dates (date flexibility), a different city name, or a shorter stay.${warningsBox(r.dataStatus.warnings)}${tip}<div class="btnrow">${monitorBtn}<button class="btn" data-action="manual">Add a hotel award</button></div></div>`;
}

// ---------- stay planner ----------
async function addStayFromResult(i) {
  const h = state.hotelRows?.[i]; if (!h) return;
  const rooms = state.lastHotelQuery?.rooms || null;
  const ev = readEvidenceForm(i, rooms || [{ adults: 2, childrenAges: [], roomType: h.roomType === 'suite' ? 'suite' : 'standard' }]);
  if (!ev.ok) return toast(ev.error);
  try {
    const body = {
      name: h.name, hotelId: h.hotelId, program: h.program, city: h.city, location: h.location, category: h.category, roomType: h.roomType,
      checkIn: h.checkIn, checkOut: addDays(h.checkIn, h.nights), nightlyPoints: h.nightlyPoints, totalPoints: h.totalPoints, cashPerNight: h.cashValue,
      bookingUrl: h.bookingUrl, dataSource: h.dataSource, estimated: h.estimated
    };
    // Exact provenance travels with the stay (A.md / B.md / O2.md): readiness and backups rely on it. Unknown stays unknown.
    Object.assign(body, stayProvenance(h));
    // Occupancy is only sent when it is not the long-standing default, so ordinary one-room stays are saved exactly as before.
    if (rooms) Object.assign(body, { rooms, occupancySchemaVersion: 1, inventoryStatus: 'unknown', occupancyStatus: 'unverified' });
    if (ev.evidence) Object.assign(body, { occupancySchemaVersion: 1, programEvidence: ev.evidence });
    const plan = await api('/api/stay-plan/stays', { method: 'POST', body });
    renderStayPlan(plan);
    // Set up the next leg: check-in = this check-out, same length of stay.
    const next = plan.summary.nextCheckIn;
    $('dateFrom').value = next; $('dateTo').value = addDays(next, h.nights);
    $('destination').value = ''; $('destination').placeholder = 'Next city, e.g. Kyoto';
    $('stayPlan').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('destination').focus();
    toast(`Added ${h.name}. Next stay starts ${dateFmt(next)}: enter the next city and search.`);
  } catch (e) { toast(e.message); }
}

function renderStayPlan(plan) {
  const el = $('stayPlan');
  state.plan = plan;
  const stayKey = (plan?.stays || []).map(x => x.id).join(',');
  if (stayKey !== state.stayKey) { if (state.stayKey !== undefined) features.readiness?.invalidate(); state.stayKey = stayKey; }
  if (!plan?.stays.length || state.product !== 'hotels') { el.hidden = true; return; }
  const s = plan.summary;
  const fundingPath = s.funding ? s.funding.sources.map(x => `<span class="node">${x.direct ? `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} (have)` : `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} → ${fmt(x.targetPoints)} ${esc(programLabel(x.targetProgram))}${x.bonusPct ? ` (+${Math.round(x.bonusPct * 100)}%)` : ''}`}</span>`).join('') : '';
  el.hidden = false;
  el.innerHTML = `<div class="card plan"><div class="cardhead"><div><div class="eyebrow">Stay plan</div><h3>${s.stays} hotel${s.stays > 1 ? 's' : ''} · ${s.nights} night${s.nights > 1 ? 's' : ''} · ${dateFmt(s.start)} → ${dateFmt(s.end)}</h3></div><div class="btnrow" style="margin:0"><button class="btn small" data-readiness="stay">Check booking readiness</button><button class="btn small ghost" data-plan="clear">Clear plan</button></div></div>
    <div class="plan-stays">${plan.stays.map((x, i) => `<div class="plan-stay"><span class="num">${i + 1}</span>
      <div><strong>${esc(x.name)}</strong> ${x.category ? `<span class="cat">${esc(x.programName.replace(/^World of /, ''))} Cat ${esc(x.category)}</span>` : ''}<small>${esc(x.city || x.location)} · ${dateFmt(x.checkIn)} → ${dateFmt(x.checkOut)} · ${x.nights} night(s) · ${esc(x.roomType)}${x.bookingUrl ? ` · <a href="${esc(x.bookingUrl)}" target="_blank" rel="noreferrer">book ↗</a>` : ''}</small>${stayOccupancy(x)}</div>
      <div class="pts">${fmt(x.totalPoints)} ${esc(x.programName.replace(/^World of /, ''))}<small>${x.cashUsd ? `${money(x.cashUsd)} cash` : ''}</small></div>
      <button class="btn ghost icon-only" data-plan="remove" data-id="${esc(x.id)}" title="Remove"><svg class="icon"><use href="#i-x"/></svg></button></div>`).join('')}</div>
    <div class="metrics" style="margin-top:12px">
      <div class="metric"><span>Total points</span><b>${fmt(s.totalPoints)}</b></div>
      <div class="metric"><span>By program</span><b style="font-size:13px">${s.pointsByProgram.map(p => `${fmt(p.points)} ${esc(p.programName.replace(/^World of /, ''))}`).join(' · ')}</b></div>
      <div class="metric"><span>Cash price</span><b>${s.cashUsd ? money(s.cashUsd) : '—'}</b></div>
      <div class="metric"><span>Value</span><b class="positive">${s.cpp ? `${s.cpp.toFixed(2)}¢/pt` : '—'}</b></div></div>
    ${s.funding && !(plan.unfunded ?? s.unfunded) ? `<div class="path">${fundingPath}</div>` : '<div class="warnbox" role="alert">This plan is not fully fundable: your current balances and transfer partners can\'t cover the whole plan.</div>'}
    ${warningsBox(s.warnings)}
    <div class="note">Next stay starts <strong>${dateFmt(s.nextCheckIn)}</strong>. Enter the next city above and search; dates are already set.</div></div>`;
}

$('stayPlan').addEventListener('click', async e => {
  const b = e.target.closest('[data-plan]'); if (!b) return;
  try {
    if (b.dataset.plan === 'remove') {
      const stay = state.plan?.stays?.find(x => x.id === b.dataset.id);
      if (!stay || !window.confirm(`Remove ${stay.name} from the stay plan?`)) return;
      renderStayPlan(await api(`/api/stay-plan/stays/${b.dataset.id}`, { method: 'DELETE', body: {} }));
    }
    if (b.dataset.plan === 'clear' && window.confirm('Clear all stays from the stay plan?')) renderStayPlan(await api('/api/stay-plan', { method: 'DELETE', body: {} }));
  } catch (err) { toast(err.message); }
});

// ---------- cash fares ----------
const LEVEL_TEXT = { low: 'Prices are LOW for this route right now', typical: 'Prices are typical for this route', high: 'Prices are HIGH for this route right now' };

function dealTag(f) {
  if (f.pctBelow == null) return `<span class="tag muted">${esc(f.label)}</span>`;
  if (f.pctBelow >= 10) return `<span class="tag">${esc(f.label)}</span>`;
  if (f.pctBelow <= -10) return `<span class="tag warn">${esc(f.label)}</span>`;
  return `<span class="tag muted">${esc(f.label)}</span>`;
}

/** Price block for a cash fare: group prices with an unconfirmed basis are labelled, never presented as exact. */
function quoteHtml(f, travelers) {
  const q = fareQuote(f, travelers, money);
  return `<span class="pts">${money(q.price)}</span>${q.caption ? `<span class="subv">${esc(q.caption)}</span>` : ''}${q.label ? `<span class="subv fk-estimate">${esc(q.label)}</span>` : ''}${q.oneAdult ? `<span class="subv fk-estimate">${esc(q.oneAdult.label)}: ${esc(q.oneAdult.amountText)}</span>` : ''}`;
}

function fareCard(f, travelers) {
  const link = safeUrl(f.link);
  const stops = f.stops == null ? '' : f.stops === 0 ? 'nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
  return `<div class="card result"><div>
    <h4>${esc(f.originName)} → ${esc(f.destinationName)} ${dealTag(f)} ${f.live ? '<span class="tag brand">LIVE · GOOGLE</span>' : '<span class="tag muted">RECENT · AVIASALES</span>'}</h4>
    <p>${esc(f.origin)} → ${esc(f.destination)} · ${dateFmt(f.departDate)}${f.returnDate ? ` – ${dateFmt(f.returnDate)}` : ' · one-way'}${stops ? ` · ${stops}` : ''}${f.airline || f.airlines ? ` · ${esc(f.airline || f.airlines)}` : ''}</p>
    ${f.usualPrice ? `<p>Usual price ≈ ${money(f.usualPrice)} (seen on ${f.baselineDays} days)</p>` : ''}
    ${link ? `<p><a href="${esc(link)}" target="_blank" rel="noreferrer">View on Aviasales ↗</a></p>` : ''}
  </div><div class="right">${quoteHtml(f, travelers)}</div></div>`;
}

function renderCash(r) {
  const fares = r.fares || [];
  const t = r.query.travelers;
  $('resultMeta').textContent = `${fmt(fares.length)} cash fare(s) · ${r.query.cabin} · ${t} traveler${t > 1 ? 's' : ''}`;
  const q0 = fares[0] ? fareQuote(fares[0], t, money) : null;
  $('kpiScore').textContent = fares[0] ? money(fares[0].price) : '—';
  $('kpiHint').textContent = !fares[0] ? 'no fares found' : q0.exact ? 'cheapest per person' : 'cheapest, basis unconfirmed';
  let google = '';
  if (r.google) {
    const i = r.google.insights;
    const g0 = r.google.fares[0];
    const gq = g0 ? fareQuote(g0, t, money) : null;
    const cacheNote = r.dataStatus?.google === 'recent-cache' && r.google.cachedAt ? ` · cached at ${new Date(r.google.cachedAt).toLocaleTimeString()}` : '';
    google = `<div class="card reco"><div class="cardhead"><div><div class="eyebrow">${r.dataStatus?.google === 'recent-cache' ? 'Cached Google Flights' : 'Live Google Flights'} · ${esc(r.query.cabin)}${esc(cacheNote)}</div><h3>${g0 ? (gq.exact ? `${money(g0.price)} per person` : `${money(g0.price)} · ${esc(gq.label)}`) : 'No live fares found'}${g0 && gq.exact && t > 1 ? ` · ${money(g0.total)} total` : ''}</h3>${gq?.oneAdult ? `<p class="fk-estimate">${esc(gq.oneAdult.label)}: ${esc(gq.oneAdult.amountText)}</p>` : ''}</div>${safeUrl(r.google.url) ? `<a class="btn small" href="${esc(r.google.url)}" target="_blank" rel="noreferrer">Open in Google Flights ↗</a>` : ''}</div>
      ${i?.level ? `<div class="note"><strong>${esc(LEVEL_TEXT[i.level] || i.level)}.</strong>${i.typicalRange ? ` Typical: ${money(i.typicalRange[0])}–${money(i.typicalRange[1])}.` : ''}</div>` : ''}
      ${i?.level && t > 1 ? '<div class="note" role="note">For a group search this rating is context only: Google\'s price unit is unconfirmed, so it is not an exact benchmark.</div>' : ''}
      ${r.google.fares.length ? `<div class="result-list">${r.google.fares.slice(0, 5).map(f => `<div class="result card"><div><h4>${esc(f.airlines)}</h4><p>${esc(f.origin)} → ${esc(f.destination)} · ${f.stops === 0 ? 'nonstop' : `${f.stops} stop(s)`}${f.durationMin ? ` · ${Math.floor(f.durationMin / 60)}h ${f.durationMin % 60}m` : ''}</p></div><div class="right">${quoteHtml(f, t)}</div></div>`).join('')}</div>` : ''}
    </div>`;
  }
  const alertForm = `<div class="card searchbox" style="margin-top:12px"><div class="cardhead"><div><h3>Set a price alert</h3><p>PointPilot checks this route in the background and notifies you when the price drops below your target or well below its usual price.</p></div></div>
    <div class="btnrow"><input id="cashTarget" class="inputnum" type="number" min="0" step="10" placeholder="Target $ / person" value="${fares[0] && q0.exact ? Math.max(0, Math.round(fares[0].price * 0.85 / 10) * 10) : ''}">
    <select id="cashDealPct"><option value="0">Only my target</option><option value="15">or 15% below usual</option><option value="20" selected>or 20% below usual</option><option value="30">or 30% below usual</option></select>
    <button class="btn primary" data-action="cash-alert"><svg class="icon"><use href="#i-bell"/></svg>Create price alert</button>
    <a class="btn" href="${esc(r.googleFlightsUrl)}" target="_blank" rel="noreferrer">Open in Google Flights ↗</a></div></div>`;
  const notConfigured = r.dataStatus.travelpayouts === 'not-configured';
  const list = fares.length ? `<div class="result-list">${fares.map(f => fareCard(f, t)).join('')}</div>`
    : r.google ? ''
    : notConfigured ? '<div class="card empty"><strong>Connect a cash fare source</strong>Add a free Travelpayouts token (and optionally a SerpApi key) under <em>Data &amp; System</em> to search cash fares and get price alerts.</div>'
    : '<div class="card empty"><strong>No recent fares found for these dates.</strong>Aviasales may not have cached prices for this route yet. Try ± more days, nearby airports, or a live Google check.</div>';
  const econRef = r.economyReference?.length ? `<div class="note"><strong>Economy fares for reference</strong> (recent Aviasales):<br>${r.economyReference.map(f => `${esc(f.origin)} → ${esc(f.destination)} ${dateFmt(f.departDate)}${f.returnDate ? ` – ${dateFmt(f.returnDate)}` : ''}: ${money(f.price)}${f.pricingLabel && t > 1 ? ` (${esc(f.pricingLabel)})` : ''}`).join('<br>')}</div>` : '';
  const googleBanner = `<div class="card searchbox" style="margin-bottom:12px"><div class="cardhead"><div><h3>See every flight on Google Flights</h3><p>${esc(r.query.origins.join(', '))} → ${esc(r.query.destinations.join(', '))} · ${esc(r.query.cabin)} · ${dateFmt(r.query.out.start)}${r.query.back ? ` – ${dateFmt(r.query.back.end)}` : ''}, prefilled.</p></div><a class="btn primary" href="${esc(r.googleFlightsUrl)}" target="_blank" rel="noreferrer">Open Google Flights ↗</a></div></div>`;
  $('results').innerHTML = googleBanner + warningsBox(r.dataStatus.warnings) + truncatedNotice(r) + google + list + econRef + `<div class="card searchbox" id="awardCompareRoot"><div class="cardhead"><div><h3>Compare award options</h3><p>Search award space for this route, date, cabin, and traveler count, then compare it with these cash fares.</p></div><button class="btn primary" id="compareAwardsBtn">Compare points and cash</button></div><div id="awardCompareResults"></div></div>` + alertForm;
  $('compareAwardsBtn')?.addEventListener('click', compareCashAwards);
}

async function compareCashAwards() {
  const q = state.lastCashQuery;
  const root = $('awardCompareResults');
  const button = $('compareAwardsBtn');
  if (!q || !root || !button) return;
  button.disabled = true;
  button.textContent = 'Searching award space…';
  root.innerHTML = '<p class="muted" role="status">Checking PointPilot award sources for the same route and dates…</p>';
  try {
    const awardQuery = { ...q, useGoogle: undefined };
    const result = await api('/api/search/trip', { method: 'POST', body: awardQuery });
    if (state.lastCashQuery !== q || !$('awardCompareResults')) return;
    const cash = state.lastCashResult;
    const cashItems = [...(cash?.google?.fares || []), ...(cash?.fares || [])];
    const cashSummary = cashItems.length
      ? `<p class="note">Cash fares found: ${cashItems.slice(0, 4).map(f => `${esc(f.airlines || f.airline || 'Flight')} ${money(f.price)}${f.origin && f.destination ? ` · ${esc(f.origin)}→${esc(f.destination)}` : ''}`).join(' · ')}</p>`
      : '<p class="note">No comparable cash fare was returned for these dates.</p>';
    const trips = result.trips || [];
    const cards = trips.map(t => {
      const legs = (t.legs || []).map(l => `${esc(l.programName || programLabel(l.program))}: ${esc(l.origin)}→${esc(l.destination)} ${dateFmt(l.date)}${l.flight?.flightNumbers?.length ? ` · ${esc(l.flight.flightNumbers.join(' / '))}` : ''}`).join('<br>');
      const points = t.totalSourcePoints ?? t.totalTargetPoints;
      const fees = t.taxesUsd == null ? 'fees not reported' : `${money(t.taxesUsd)} taxes & fees`;
      const funding = (t.sources || []).map(s => `${fmt(s.fromPoints)} ${esc(programLabel(s.from))}${s.direct ? ' held' : ` → ${esc(programLabel(s.targetProgram))}`}`).join(' + ');
      return `<article class="card result award-cash-option"><div><span class="tag">ROUTE-LEVEL OPTION · SAME FLIGHT NOT CONFIRMED</span><h4>${fmt(points)} points + ${fees}</h4><p>${legs}</p><p>Fundable from current balances${funding ? ` · ${funding}` : ''}</p><p>Estimated effective cost: ${money(t.effectiveCostUsd)}</p></div></article>`;
    }).join('');
    const status = result.dataStatus?.api;
    const source = status === 'fetched' ? 'Live award data was checked.' : status === 'recent-cache' ? 'Recent award data was used.' : status === 'error' ? 'The live award source failed; results may use local cached data.' : 'Only manually saved award data is available.';
    const warning = result.dataStatus?.warnings?.length ? warningsBox(result.dataStatus.warnings) : '';
    const empty = trips.length ? '' : `<div class="card empty"><strong>${result.mode === 'no-inventory' ? 'No award results found' : result.mode === 'unaffordable' ? 'Award space found, but not funded' : 'No matching award options found'}</strong><p>${esc(source)} This does not establish that no award seat exists across all programs.</p></div>`;
    root.innerHTML = `${cashSummary}<p class="muted">${esc(source)} Award options below match the route and dates, but are not verified as the same flights shown in cash results.</p>${warning}${truncatedNotice(result)}${cards ? `<div class="result-list">${cards}</div>` : empty}`;
  } catch (error) {
    root.innerHTML = `<div class="card empty search-error" role="alert"><strong>Award comparison failed</strong><p>${esc(error.message)}</p><p>Cash results are still available above.</p></div>`;
  } finally {
    if ($('compareAwardsBtn')) { $('compareAwardsBtn').disabled = false; $('compareAwardsBtn').textContent = 'Compare points and cash'; }
  }
}

async function compareCashValueOnly() {
  const t = state.bestTrip; if (!t) return;
  const out = t.legs[0], back = t.legs[1];
  const box = $('cashCompare');
  box.innerHTML = '<div class="note">Looking up the cash price…</div>';
  try {
    const r = await api('/api/cash/itinerary', { method: 'POST', body: { origin: out.origin, destination: out.destination, departDate: out.date, returnDate: back?.date || null, cabin: out.cabin, travelers: t.travelers } });
    // The selection may have changed while we waited; never paint an old comparison onto a new trip.
    if (state.bestTrip !== t || !$('valueMetric') || $('cashCompare') !== box) return;
    if (!r.available) { box.innerHTML = `<div class="note">${esc(r.reason || 'No cash price found for these dates.')} <a href="${esc(r.url)}" target="_blank" rel="noreferrer">Check Google Flights ↗</a></div>`; return r; }
    if (!isExactComparable(r)) {
      // A group price with an unconfirmed basis is shown as returned; savings and cents-per-point are not computed from it.
      const gq = comparisonQuote({ ...r, exactComparable: false }, t.travelers, money);
      box.innerHTML = `<div class="warnbox"><strong>Cash price returned: ${gq.price == null ? '—' : money(gq.price)}${gq.caption ? ` ${esc(gq.caption)}` : ''} (${esc(r.cabin)}).</strong> <span class="fk-estimate">${esc(gq.label)}</span>${gq.oneAdult ? `<br><span class="fk-estimate">${esc(gq.oneAdult.label)}: ${esc(gq.oneAdult.amountText)}</span>` : ''}<br>Cents per point and savings are not calculated, because this group price is not an exact comparison. <a href="${esc(r.url)}" target="_blank" rel="noreferrer">Check Google Flights ↗</a></div>`;
      return r;
    }
    const cpp = ((r.total - t.taxesUsd) / t.totalSourcePoints) * 100;
    const avgCpp = t.pointsCostUsd / t.totalSourcePoints * 100;
    // Show the result in the Value box of the recommendation.
    $('valueMetricLabel').textContent = `Value vs ${money(r.total)} cash`;
    $('valueMetric').textContent = `${cpp.toFixed(2)}¢/pt`;
    $('valueMetric').className = cpp >= avgCpp ? 'positive' : '';
    $('valueMetric').style.color = cpp >= avgCpp ? '' : 'var(--amber)';
    const verdict = r.total <= t.taxesUsd ? 'Paying cash is cheaper than the award taxes — pay cash.'
      : cpp >= avgCpp ? `Points win: you get ${cpp.toFixed(2)}¢ per point, above the ${avgCpp.toFixed(2)}¢ you value them at.`
      : `Consider paying cash: points only get ${cpp.toFixed(2)}¢ each, below the ${avgCpp.toFixed(2)}¢ you value them at.`;
    box.innerHTML = `<div class="${cpp >= avgCpp ? 'note' : 'warnbox'}"><strong>Cash price: ${money(r.perTraveler)} per person (${money(r.total)} total, ${esc(r.cabin)}, ${r.source === 'google' ? 'live Google Flights' : 'recent Aviasales fare'}).</strong><br>${esc(verdict)}${r.insights?.level ? ` Google rates current prices as <strong>${esc(r.insights.level)}</strong>.` : ''} <a href="${esc(r.url)}" target="_blank" rel="noreferrer">Open in Google Flights ↗</a></div>`;
    return r;
  } catch (e) { if (state.bestTrip === t && $('cashCompare') === box) box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return null; }
}

async function compareCash() {
  const selection = activePurchaseQuote; if (!selection) return;
  const box = $('cashCompare');
  box.innerHTML = '<div class="note" role="status">Checking cash fares and saved buy-points offers…</div>';
  try {
    const quotePromise = api('/api/points/purchase-quote', { method: 'POST', body: {
      travelers: selection.travelers,
      legs: selection.legs.map(l => ({ program: l.program || l.source, mileageCost: l.mileageCost ?? l.pointsPerTraveler, totalTaxes: l.totalTaxes }))
    } });
    let fareResult;
    if (selection.trip) {
      const cashPromise = compareCashValueOnly();
      const quote = await quotePromise;
      const fare = await cashPromise;
      if (activePurchaseQuote !== selection || $('cashCompare') !== box) return;
      const cashHtml = box.innerHTML;
      box.innerHTML = renderPurchaseQuote(quote, cashHtml, fare);
      return;
    }
    const [out, back] = selection.legs;
    const cashPromise = api('/api/cash/itinerary', { method: 'POST', body: { origin: out.origin, destination: out.destination, departDate: out.date, returnDate: back?.date || null, cabin: out.cabin, travelers: selection.travelers } });
    const [purchaseResult, fareResponse] = await Promise.allSettled([quotePromise, cashPromise]);
    if (activePurchaseQuote !== selection || $('cashCompare') !== box) return;
    if (purchaseResult.status === 'rejected') throw purchaseResult.reason;
    const quote = purchaseResult.value;
    fareResult = fareResponse.status === 'fulfilled' ? fareResponse.value : null;
    const cashHtml = fareResponse.status === 'rejected'
      ? `<div class="note">Cash fare lookup failed: ${esc(fareResponse.reason?.message || 'request failed')}</div>`
      : !fareResult.available
      ? `<div class="note">${esc(fareResult.reason || 'No cash price found for these dates.')} <a href="${esc(fareResult.url || '')}" target="_blank" rel="noreferrer">Check Google Flights ↗</a></div>`
      : !isExactComparable(fareResult)
        ? `<div class="warnbox">Cash price returned, but its group-price basis is not exact, so savings are not calculated. <a href="${esc(fareResult.url || '')}" target="_blank" rel="noreferrer">Check Google Flights ↗</a></div>`
        : `<div class="note"><strong>Cash fare: ${money(fareResult.perTraveler)} per person (${money(fareResult.total)} total, ${esc(fareResult.cabin)}).</strong> <a href="${esc(fareResult.url || '')}" target="_blank" rel="noreferrer">Open in Google Flights ↗</a></div>`;
    box.innerHTML = renderPurchaseQuote(quote, cashHtml, fareResult);
  } catch (e) { if (activePurchaseQuote === selection && $('cashCompare') === box) box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

function renderPurchaseQuote(quote, cashHtml, fare = null) {
  const rows = quote.byProgram || [];
  const shortRows = rows.filter(row => row.pointsShort > 0);
  if (!shortRows.length) return `<div class="note"><strong>Existing miles in the award programs cover the full points requirement.</strong> No purchase is needed for this comparison.</div>${cashHtml}`;
  const details = shortRows.map(row => {
    if (row.status === 'missing-offer') return `<li>${esc(row.programName)}: short ${fmt(row.pointsShort)} points. <button type="button" class="btn small" data-action="manage-purchase-offer" data-program="${esc(row.program)}">Add a purchase price</button></li>`;
    if (row.status === 'expired') return `<li>${esc(row.programName)}: short ${fmt(row.pointsShort)} points; the saved offer expired${row.offerEnds ? ` on ${dateFmt(row.offerEnds)}` : ''}. <button type="button" class="btn small" data-action="manage-purchase-offer" data-program="${esc(row.program)}">Update offer</button></li>`;
    const link = safeUrl(row.offerUrl);
    const cpp = Number(row.pricePerPointCents).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `<li>${esc(row.programName)}: buy ${fmt(row.pointsToBuy)} points at ${cpp}¢/point = <strong>${money(row.purchaseCostUsd)}</strong>${row.extraPoints ? ` (${fmt(row.extraPoints)} extra from the purchase minimum/increment)` : ''}${row.offerEnds ? ` · offer ends ${dateFmt(row.offerEnds)}` : ''}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noreferrer">Purchase page ↗</a>` : ''}${row.offerNotes ? `<br><span class="muted">${esc(row.offerNotes)}</span>` : ''}</li>`;
  }).join('');
  const allPriced = quote.purchaseCostUsd != null;
  const allIn = allPriced && quote.taxesComplete ? quote.purchaseCostUsd + quote.taxesUsd : null;
  let verdict = '';
  if (allIn != null && fare?.available && isExactComparable(fare)) {
    const delta = Math.abs(fare.total - allIn);
    verdict = allIn <= fare.total
      ? `Buying the points and paying award fees is about ${money(delta)} less than this cash fare.`
      : `The cash fare is about ${money(delta)} less than buying the points and paying award fees.`;
  }
  const cls = verdict && allIn <= fare.total ? 'note' : 'warnbox';
  return `<div class="${cls}"><strong>Buy-points estimate</strong><ul class="purchase-quote-list">${details}</ul>${allPriced ? `<p>Points purchase: ${money(quote.purchaseCostUsd)}${quote.taxesComplete ? ` + ${money(quote.taxesUsd)} award fees = <strong>${money(allIn)} total</strong>` : ' + award fees not fully reported'}</p>` : '<p>Enter an effective purchase price for each program to complete the estimate.</p>'}${verdict ? `<p><strong>${esc(verdict)}</strong></p>` : ''}<p class="muted fk-help">Estimate subtracts miles already held in each award program. It excludes bank points that could be transferred. Offers may be targeted or change; award seats can disappear, and purchases may be nonrefundable. Confirm availability and final terms with the program before buying.</p></div>${cashHtml}`;
}

// Keyboard and screen-reader selection goes through the native radio inputs.
$('results').addEventListener('change', e => {
  const radio = e.target.closest?.('input.opt-radio');
  if (radio?.checked) selectOption(radio.dataset.leg, radio.value);
});

$('results').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  const action = btn?.dataset.action;
  // Award picker: clicking a flight card selects it (links, buttons and details don't).
  const card = e.target.closest('.opt[data-select]');
  if (card && !btn && !e.target.closest('a, .details, input, label')) {
    // A new outbound can invalidate the chosen return; keep it but it will be flagged.
    selectOption(card.dataset.leg, card.dataset.select);
    return;
  }
  if (action === 'open-day') { openDay(btn.dataset.leg, btn.dataset.day); return; }
  if (action === 'opt-details') { const id = btn.dataset.id; award.open.has(id) ? award.open.delete(id) : award.open.add(id); renderColumns(); return; }
  if (action === 'more') { award.show[btn.dataset.leg] += 25; renderColumns(); return; }
  if (action === 'reset-rec') { const ids = award.r.recommended?.ids || []; award.sel = { Outbound: ids[0] || null, Return: ids[1] || null }; state.bestTrip = null; renderColumns(); renderAwardSummary(); return; }
  if (action === 'clear-filters') { ['fMaxPts', 'fMaxFees', 'fMaxHours', 'fStops', 'fDepart', 'fSeat', 'fProgram', 'fProduct'].forEach(id => { $(id).value = ''; }); renderColumns(); return; }
  if (action === 'add-builder') { addSelectionToBuilder(); return; }
  if (action === 'hotel-more') { const c = btn.dataset.city; state.hotelShow[c] = (state.hotelShow[c] || 20) + 20; keepFocus(() => renderHotels(state.lastHotels)); return; }
  if (action === 'hotel-info-all') { busy(btn, true, 'Loading…'); loadHotelInfo(state.hotelRows.filter(h => !h.info)).catch(err => { toast(err.message); renderHotels(state.lastHotels); }); return; }
  if (action === 'hotel-info-one') { const h = state.hotelRows[Number(btn.dataset.i)]; busy(btn, true, '…'); loadHotelInfo([h], 'single').catch(err => { toast(err.message); renderHotels(state.lastHotels); }); return; }
  if (action === 'product-alert') {
    const q = state.lastQuery || currentQuery();
    const p = state.lastAwardResult?.query.product || productOf(q.product);
    if (!p) return;
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, cabin: p.cabin, track: { mode: 'product', product: p.key, productLabel: `${p.airline} ${p.product}` } } });
      state.alerts.unshift(a); renderAlerts(); renderKPIs();
      toast(`Alert saved: you'll be notified when ${p.airline} ${p.product} space appears on these dates.`);
    } catch (err) { toast(err.message); }
    return;
  }
  if (action === 'monitor-open') { $('awAlertPanel').hidden = !$('awAlertPanel').hidden; return; }
  if (action === 'monitor-create') {
    const q = state.lastQuery || currentQuery();
    const mode = $('alertMode').value, max = Number($('alertMaxPts').value || 0);
    const maxTaxesPerTraveler = Number($('alertMaxFees').value || 0), minSeats = Number($('alertMinSeats').value || 0), minCabinPct = Number($('alertMinCabinPct').value || 0);
    const legs = [optById(award.sel.Outbound), award.r.query.back ? optById(award.sel.Return) : null].filter(Boolean);
    const track = mode === 'any' ? null : { mode, legs: legs.map(o => ({ leg: o.leg, date: o.flight?.depart?.date || o.date, flightNumbers: o.flight?.flightNumbers || [], program: o.program, programName: o.programName, mileageCost: o.mileageCost, seatScore: o.seatScore, product: o.flight?.product?.type || null })) };
    const title = track ? `${legs.map(o => o.flight?.flightNumbers.join('/') || o.date).join(' + ')}${mode === 'similar' ? ' or similar' : ''}` : `${q.destination} ${q.cabin} · ${q.travelers} pax`;
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, track, maxPointsPerTraveler: max, maxTaxesPerTraveler, minSeats, minCabinPct, title } });
      state.alerts.unshift(a); renderAlerts(); renderKPIs(); $('awAlertPanel').hidden = true;
      toast(track ? 'Flight alert saved. You\'ll be notified when these flights are bookable.' : 'Trip alert saved.');
    } catch (err) { toast(err.message); }
    return;
  }
  if (action === 'trip-details') {
    const el = btn.closest('.result').querySelector('.trips');
    if (!el.hidden && el.dataset.loaded === btn.dataset.id) { el.hidden = true; return; }
    el.dataset.loaded = btn.dataset.id;
    loadTrips(el, btn.dataset.id, btn.dataset.cabin);
  }
  if (action === 'add-stay') addStayFromResult(Number(btn.dataset.i));
  if (action === 'compare-cash') compareCash();
  if (action === 'manage-purchase-offer') {
    showView('wallet');
    $('purchaseProgram').value = btn.dataset.program;
    $('purchaseOfferMessage').textContent = `Add an effective purchase price for ${programLabel(btn.dataset.program)}.`;
    $('purchaseCpp').focus();
    $('purchaseOffersList').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (action === 'cash-alert') {
    const q = state.lastCashQuery || currentQuery();
    const target = Number($('cashTarget').value || 0), dealPct = Number($('cashDealPct').value);
    if (!target && !dealPct) return toast('Enter a target price or choose a "below usual" option');
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, kind: 'cash', targetPrice: target, dealPct, title: `${q.origins} → ${q.destination}${target ? ` under ${money(target)}` : ''}` } });
      state.alerts.unshift(a); renderAlerts(); renderKPIs(); toast('Price alert saved.');
    } catch (err) { toast(err.message); }
  }
  if (action === 'manual') showView('manual');
  if (action === 'monitor-hotel') {
    const q = state.lastHotelQuery || currentHotelQuery();
    const max = Number($('hotelAlertMax')?.value || 0);
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, kind: 'hotel', maxPointsPerNight: max, title: `${q.destination} hotel${max ? ` ≤ ${fmt(max)}/night` : ''}` } });
      state.alerts.unshift(a); renderAlerts(); renderKPIs(); toast('Hotel monitor saved.');
    } catch (err) { toast(err.message); }
  }
  if (action === 'monitor') {
    const q = state.lastQuery || currentQuery();
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, title: `${q.destination} ${q.cabin} · ${q.travelers} pax` } });
      state.alerts.unshift(a); renderAlerts(); renderKPIs(); toast('Trip monitor saved — you\'ll get a notification when matching space appears.');
    } catch (err) { toast(err.message); }
  }
});

// ---------- alerts ----------
function renderAlerts() {
  $('alertEmpty').style.display = state.alerts.length ? 'none' : 'block';
  $('alerts').style.display = state.alerts.length ? 'block' : 'none';
  $('alerts').innerHTML = state.alerts.map(a => {
    const q = a.query || {};
    const check = alertCheckState(a, state.runErrors?.[a.id]);
    const when = ts => (ts ? new Date(ts).toLocaleString() : 'unknown time');
    const okText = a.lastResult ? `${a.lastResult.matches} match(es) · checked ${when(a.lastCheckedAt)}` : 'Not checked yet';
    // A failed check is not a "no match": show it distinctly and keep the last good result for context.
    const last = check.kind === 'error' ? `Check failed ${when(check.at)}: ${check.error}${a.lastResult ? ` · last successful: ${okText}` : ''}` : okText;
    const desc = {
      hotel: () => `<span class="tag brand">HOTEL</span> ${esc(q.destination)} · ${esc(q.roomType)} room · ${dateFmt(q.checkIn)}${q.checkOut ? ` – ${dateFmt(q.checkOut)}` : ''} ± ${esc(q.flexDays)}d${q.maxPointsPerNight ? ` · ≤ ${fmt(q.maxPointsPerNight)} pts/night` : ''}`,
      cash: () => `<span class="tag brand">CASH FARE</span> ${esc(q.origins)} → ${esc(q.destination)} · ${dateFmt(q.departDate)}${q.returnDate ? ` – ${dateFmt(q.returnDate)}` : ' (one-way)'} ± ${esc(q.flexDays)}d${a.targetPrice ? ` · target ${money(a.targetPrice)}` : ''}${a.dealPct ? ` · or ${esc(a.dealPct)}% below usual` : ''}${a.lastNotifiedPrice ? ` · last alert ${money(a.lastNotifiedPrice)}` : ''}`,
      deals: () => `<span class="tag brand">DEAL WATCH</span> from ${esc(q.airports)}${q.destination ? ` to ${esc(q.destination)}` : ' to anywhere'} · ${esc(a.minDropPct)}%+ below usual${q.maxPrice ? ` · under ${money(q.maxPrice)}` : ''}`,
      award: () => a.track?.mode === 'product'
        ? `<span class="tag brand">SEAT SEARCH</span> ${esc(a.track.productLabel || a.track.product)} · ${esc(q.origins)} ⇄ ${esc(q.destination)} · ${dateFmt(q.departDate)}${q.returnDate ? ` – ${dateFmt(q.returnDate)}` : ''} ± ${esc(q.flexDays)}d · ${esc(q.travelers)} pax${a.maxPointsPerTraveler ? ` · ≤ ${fmt(a.maxPointsPerTraveler)} pts/person` : ''}`
        : a.track
        ? `<span class="tag brand">${a.track.mode === 'exact' ? 'EXACT FLIGHTS' : 'FLIGHTS OR SIMILAR'}</span> ${a.track.legs.map(l => `${esc(l.leg)} ${esc(l.flightNumbers.join('/') || '')} ${dateFmt(l.date)} (${fmt(l.mileageCost)} pts${l.product ? `, ${esc(l.product)}` : ''})`).join(' · ')} · ${esc(q.cabin)} · ${esc(q.travelers)} pax${a.maxPointsPerTraveler ? ` · ≤ ${fmt(a.maxPointsPerTraveler)} pts/person` : ''}${a.lastTracked ? ` · now: ${a.lastTracked.map(t => `${esc(t.leg)} ${t.found ? `${fmt(t.points)} pts` : 'not available'}`).join(', ')}` : ''}`
        : `<span class="tag brand">AWARD</span> ${esc(q.origins)} → ${esc(q.destination)} · ${esc(q.cabin)} · ${esc(q.travelers)} pax · ${dateFmt(q.departDate)}${q.returnDate ? ` – ${dateFmt(q.returnDate)}` : ' (one-way)'} ± ${esc(q.flexDays)}d`
    }[a.kind || 'award']?.() || '';
    const filters = a.kind === 'award' ? [a.maxTaxesPerTraveler ? `≤ ${money(a.maxTaxesPerTraveler)} fees/person` : '', a.minSeats ? `≥ ${a.minSeats} seats` : '', a.minCabinPct ? `≥ ${a.minCabinPct}% cabin coverage` : ''].filter(Boolean).join(' · ') : '';
    return `<div class="rowalert"><div><strong>${esc(a.title)}</strong>
      <div class="muted" style="font-size:11px">${desc}</div>
      ${filters ? `<div class="muted" style="font-size:11px">Filters: ${esc(filters)}</div>` : ''}
      <div class="muted${check.kind === 'error' ? ' alert-error' : ''}" style="font-size:11px"${check.kind === 'error' ? ' role="alert"' : ''}>${check.kind === 'error' ? '⚠ ' : ''}${esc(last)}${check.kind !== 'error' && a.lastWarnings?.length ? ` · Warning: ${esc(a.lastWarnings.join('; '))}` : ''}${check.kind !== 'error' && a.lastResult?.best ? ` — ${esc(a.lastResult.best)}` : ''}</div></div>
      <div class="btnrow" style="margin:0"><button class="btn small" data-check="${esc(a.id)}"${a.active ? '' : ' disabled'}>Check now</button><button class="btn small" data-toggle="${esc(a.id)}" data-active="${a.active ? '1' : ''}">${a.active ? 'Pause' : 'Resume'}</button><button class="btn small" data-delete="${esc(a.id)}">Remove</button></div></div>`;
  }).join('');
}

$('alerts').addEventListener('click', async e => {
  const { toggle, delete: del, active, check } = e.target.dataset;
  try {
    if (check) {
      const button = e.target.closest('[data-check]');
      busy(button, true, 'Checking…');
      const r = await api(`/api/monitor/run/${check}`, { method: 'POST', body: {} });
      const run = summarizeRun(r.results);
      state.runErrors = run.errors;
      state.alerts = await api('/api/alerts'); renderAlerts();
      toast(`Checked alert${run.fresh ? ' — new availability found!' : ''}${run.failed ? ' — check failed; see alert details.' : ''}`);
      return;
    }
    if (del) {
      const alert = state.alerts.find(a => a.id === del);
      if (!alert || !window.confirm(`Remove the alert “${alert.title}”?`)) return;
      await api(`/api/alerts/${del}`, { method: 'DELETE', body: {} }); state.alerts = state.alerts.filter(a => a.id !== del);
    }
    if (toggle) { await api(`/api/alerts/${toggle}`, { method: 'PATCH', body: { active: !active } }); const a = state.alerts.find(x => x.id === toggle); if (a) a.active = !active; }
    renderAlerts(); renderKPIs();
  } catch (err) { toast(err.message); }
});

$('runMonitor').onclick = async () => {
  busy($('runMonitor'), true, 'Checking…');
  try {
    const r = await api('/api/monitor/run', { method: 'POST', body: {} });
    const run = summarizeRun(r.results);
    state.runErrors = run.errors;
    state.alerts = await api('/api/alerts'); renderAlerts();
    const title = id => state.alerts.find(a => a.id === id)?.title || id;
    const detail = Object.entries(run.errors).slice(0, 2).map(([id, err]) => `${title(id)}: ${err}`).join('; ');
    toast(`Checked ${r.alertsChecked} alert(s)${run.fresh ? ` — ${run.fresh} with new space!` : ''}${run.failed ? ` · ${run.failed} failed (${detail}${run.failed > 2 ? '…' : ''})` : ''}`);
  } catch (e) { toast(e.message); } finally { busy($('runMonitor'), false); }
};

// ---------- history ----------
async function loadHistory() {
  const q = new URLSearchParams();
  for (const [k, id] of [['program', 'histProgram'], ['origin', 'histOrigin'], ['destination', 'histDestination'], ['cabin', 'histCabin']]) if ($(id).value) q.set(k, $(id).value.trim());
  const [h, s] = await Promise.all([api(`/api/history?${q}`), api('/api/history/sources')]);
  $('historyTable').innerHTML = h.rows.map(r => {
    const pts = r.pointsCommon ? fmt(r.pointsCommon) : (r.pointsMin || r.pointsMax ? `${fmt(r.pointsMin || r.pointsMax)}${r.pointsMax && r.pointsMin !== r.pointsMax ? `–${fmt(r.pointsMax)}` : ''}` : '—');
    const url = safeUrl(r.sourceUrl);
    return `<tr><td>${dateFmt(r.observedAt)}</td><td>${esc(programLabel(r.program))}</td><td>${r.origin && r.destination ? `${esc(r.origin)} → ${esc(r.destination)}${r.date ? ` · ${dateFmt(r.date)}` : ''}` : esc(r.market || (r.category ? `Category ${r.category}` : 'Benchmark'))}</td><td>${esc(r.cabin || r.roomType || '—')}</td><td>${pts}</td><td>${esc(r.sourceType)}</td><td>${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc((r.sourceTitle || 'Source').slice(0, 40))} ↗</a>` : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="7">No matching history.</td></tr>';
  $('historySources').innerHTML = `<strong>${fmt(h.count)} matching observation(s).</strong> ${s.sources.length} published benchmark source(s) are included; benchmarks are never treated as live availability.`;
}
$('refreshHistory').onclick = () => loadHistory().catch(e => toast(e.message));
['histProgram', 'histOrigin', 'histDestination', 'histCabin'].forEach(id => $(id).addEventListener('change', () => loadHistory().catch(e => toast(e.message))));

// ---------- manual entry ----------
function renderProviders(list) {
  $('providerList').innerHTML = list.map(p => `<div class="provider-card"><strong>${esc(p.name)}</strong><span>${esc(p.product)}</span><div class="btnrow">${desktop ? `<button class="btn small" data-open="${esc(p.id)}" data-url="${esc(p.homepage)}">Open in PointPilot ↗</button>` : ''}<a class="btn small" href="${esc(p.homepage)}" target="_blank" rel="noreferrer">Open in browser ↗</a></div></div>`).join('');
}
$('providerList').addEventListener('click', e => {
  const { open, url } = e.target.dataset;
  if (open && desktop) {
    desktop.openProvider(open, url).then(result => {
      if (result?.ok) toast('Search normally in the new window. Ctrl+Shift+S saves the page.');
      else toast(result?.message || 'Could not open that provider page.');
    }).catch(e => toast(e.message));
  }
});

$('saveManualAward').onclick = async () => {
  const direct = $('manualDirect').value;
  const payload = {
    program: $('manualProgram').value, origin: $('manualOrigin').value.trim().toUpperCase(), destination: $('manualDestination').value.trim().toUpperCase(),
    date: $('manualDate').value, cabin: $('manualCabin').value, mileageCost: Number($('manualPoints').value || 0),
    totalTaxes: $('manualTaxes').value === '' ? null : Number($('manualTaxes').value), cashValue: Number($('manualCash').value || 0) || null,
    remainingSeats: Number($('manualSeats').value || 0) || null, direct: direct === '' ? null : direct === 'true'
  };
  try {
    await api('/api/manual-award', { method: 'POST', body: payload });
    for (const id of ['manualOrigin', 'manualDestination', 'manualDate', 'manualPoints', 'manualTaxes', 'manualCash', 'manualSeats']) $(id).value = '';
    $('manualDirect').value = '';
    $('manualMessage').textContent = 'Saved. It will appear in searches for 14 days and is part of price history.'; toast('Award saved');
  }
  catch (e) { $('manualMessage').textContent = e.message; }
};
$('saveManualHotel').onclick = async () => {
  const payload = { program: $('manualHotelProgram').value, category: $('manualHotelCategory').value.trim() || null, name: $('manualHotelName').value.trim(), location: $('manualHotelLocation').value.trim(), checkIn: $('manualHotelDate').value, roomType: $('manualHotelRoomType').value, nightlyPoints: Number($('manualHotelPoints').value || 0), cashValue: Number($('manualHotelCash').value || 0) || null };
  try {
    await api('/api/manual-hotel', { method: 'POST', body: payload });
    for (const id of ['manualHotelCategory', 'manualHotelName', 'manualHotelLocation', 'manualHotelDate', 'manualHotelPoints', 'manualHotelCash']) $(id).value = '';
    $('manualHotelRoomType').value = 'standard';
    $('manualHotelMessage').textContent = 'Saved.'; toast('Hotel award saved');
  }
  catch (e) { $('manualHotelMessage').textContent = e.message; }
};

// ---------- transfer partners ----------
const SOURCE_NAMES = { roame: 'Roame', upgradedpoints: 'Upgraded Points', tpg: 'The Points Guy' };
function renderPartners() {
  const d = state.partners; if (!d) return;
  const today = new Date().toISOString().slice(0, 10);
  const bankName = id => (typeof d.banks?.[id] === 'object' ? d.banks[id].name : d.banks?.[id]) || programLabel(id);
  const rows = [];
  for (const p of Object.values(d.programs || {})) for (const [bank, e] of Object.entries(p.transfers || {})) {
    // Rolling offers (no published end date) only count as live while recently re-confirmed by a source check.
    const bonusLive = e.bonusPct && (!e.bonusEnds || e.bonusEnds >= today) && (!e.bonusRolling || (e.bonusLastConfirmedAt?.slice(0, 10) ?? '') >= today);
    rows.push(`<tr><td>${esc(p.name)}</td><td>${esc(bankName(bank))}</td><td>${esc(e.ratio[0])}:${esc(e.ratio[1])}</td><td>${e.days ? `${esc(e.days)}d` : 'Instant'}</td><td>${bonusLive ? `+${Math.round(e.bonusPct * 100)}% ${e.bonusRolling ? '(live now; end date not published)' : `until ${esc(e.bonusEnds || '?')}`}` : '—'}</td><td>${e.unverified ? '<span class="tag warn">UNVERIFIED</span>' : e.verifiedBy?.length ? `<span class="tag" title="${esc(e.verifiedBy.map(s => SOURCE_NAMES[s] || s).join(', '))}">✓ ${e.verifiedBy.length} source${e.verifiedBy.length > 1 ? 's' : ''}</span>` : '<span class="tag muted">NOT CHECKED</span>'}</td></tr>`);
  }
  $('partnerTable').innerHTML = rows.sort().join('');
  const v = d.verification;
  $('partnerMeta').textContent = `Data as of ${d.lastUpdated} (${d.status?.origin || 'bundled'}).${v ? ` Cross-checked ${v.checkedAt} against ${Object.keys(v.sources).map(s => SOURCE_NAMES[s] || s).join(', ')}; routes are auto-updated when the sources agree.` : ''} Always confirm before transferring: transfers can't be undone.`;
}
$('refreshPartners').onclick = async () => {
  busy($('refreshPartners'), true, 'Checking…');
  try {
    const r = await api('/api/transfer-partners/refresh', { method: 'POST', body: {} });
    state.partners = await api('/api/transfer-partners'); renderPartners();
    toast(r.ok ? (r.updated ? `Transfer data updated (${r.lastUpdated})` : 'Transfer data is already current') : `Couldn't refresh: ${r.error}`);
  } finally { busy($('refreshPartners'), false); }
};

// ---------- settings ----------
async function loadSettings() {
  const s = await api('/api/settings');
  $('apiStatus').textContent = s.hasSeatsAeroKey ? `Key saved (${s.seatsAeroKeyHint})` : 'No key';
  $('setInterval').value = s.monitorIntervalMinutes;
  $('setNotify').value = String(s.desktopNotifications);
  $('setTray').value = String(s.closeToTray);
  $('setLogin').value = String(s.launchAtLogin);
  $('setWebhook').value = s.webhookUrl || '';
  $('cashKeyStatus').textContent = [
    s.travelpayoutsTokenSet ? `Travelpayouts ✓ (${s.travelpayoutsTokenHint})` : 'Travelpayouts: no token',
    s.serpApiKeySet ? `SerpApi ✓ (${s.serpApiKeyHint})` : 'SerpApi: not set'
  ].join(' · ');
  $('homeAirports').value = s.homeAirports || '';
  if (!$('discoverOrigins').value) $('discoverOrigins').value = s.homeAirports || $('origins').value;
  if (!$('dealAirports').value) $('dealAirports').value = s.homeAirports || $('origins').value;
  state.settings = s;
  renderPurchaseOffers(s.buyPointsOffers || []);
  renderExpirations();
}
$('saveCashKeys').onclick = () => {
  const patch = { homeAirports: $('homeAirports').value };
  if ($('tpToken').value.trim()) patch.travelpayoutsToken = $('tpToken').value.trim();
  if ($('serpKey').value.trim()) patch.serpApiKey = $('serpKey').value.trim();
  $('tpToken').value = ''; $('serpKey').value = '';
  if (patch.homeAirports) $('dealAirports').value = patch.homeAirports;
  saveSettings(patch, 'Cash fare settings saved');
};
$('clearTpToken').onclick = () => saveSettings({ travelpayoutsToken: '' }, 'Travelpayouts token removed');
$('clearSerpKey').onclick = () => saveSettings({ serpApiKey: '' }, 'SerpApi key removed');

// ---------- cash deals ----------
let dealScope = 'all';
let lastDeals = null;
function renderDeals(r) {
  lastDeals = r;
  const all = r.deals || [];
  const deals = dealScope === 'all' ? all : all.filter(d => d.scope === dealScope);
  const strong = all.filter(d => d.pctBelow != null && d.pctBelow >= 10).length;
  const intl = all.filter(d => d.scope === 'international').length;
  $('dealMessage').textContent = all.length ? `${all.length} destination(s) from ${r.airports.join(', ')}${r.destination ? ` to ${r.destination}` : ''} · ${intl} international, ${all.length - intl} domestic · ${strong} below their usual price.` : 'No fares found. Check the airport codes or try again later.';
  $('dealTabsBar').hidden = !all.length;
  $('dealTabs').querySelectorAll('button').forEach(b => { const active = b.dataset.scope === dealScope; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); b.textContent = { all: `All (${all.length})`, international: `International (${intl})`, domestic: `Domestic (${all.length - intl})` }[b.dataset.scope]; });
  $('dealGoogleLinks').innerHTML = r.googleLinks ? `<a class="btn small" href="${esc(r.googleLinks.explore)}" target="_blank" rel="noreferrer">Google Flights Explore ↗</a><a class="btn small" href="${esc(r.googleLinks.deals)}" target="_blank" rel="noreferrer">Google Flights Deals ↗</a>` : '';
  $('dealResults').innerHTML = warningsBox(r.dataStatus.warnings) + (deals.length ? `<div class="result-list">${deals.map(d => `<div class="card result"><div>
      <h4>${esc(d.destinationName)}${d.destinationCountry ? `<span class="muted" style="font-weight:500">, ${esc(d.destinationCountry)}</span>` : ''} <span class="tag muted">${esc(d.destination)}</span> ${dealTag(d)} <span class="tag ${d.scope === 'domestic' ? 'muted' : 'brand'}">${d.scope === 'domestic' ? 'DOMESTIC' : 'INTERNATIONAL'}</span>${d.cabin && d.cabin !== 'economy' ? ` <span class="tag brand">${esc(d.cabin.toUpperCase())}</span>` : ''}</h4>
      <p>From ${esc(d.originName)} (${esc(d.origin)}) · ${dateFmt(d.departDate)}${d.returnDate ? ` – ${dateFmt(d.returnDate)}` : ' · one-way'}${d.stops != null ? ` · ${d.stops === 0 ? 'nonstop' : `${d.stops} stop(s)`}` : ''}</p>
      ${d.usualPrice ? `<p>Usual ≈ ${money(d.usualPrice)}</p>` : ''}
      <p><a href="${esc(d.googleFlightsUrl)}" target="_blank" rel="noreferrer">Check on Google Flights ↗</a></p>
    </div><div class="right"><span class="pts">${money(d.price)}</span><span class="subv">per person, round trip</span></div></div>`).join('')}</div>` : '');
}
$('findDeals').onclick = async () => {
  busy($('findDeals'), true, 'Searching…');
  try { renderDeals(await api('/api/cash/deals', { method: 'POST', body: { airports: $('dealAirports').value, destination: $('dealDestination').value.trim(), cabin: $('dealCabin').value, maxPrice: Number($('dealMaxPrice').value || 0) } })); }
  catch (e) { $('dealMessage').textContent = e.message; } finally { busy($('findDeals'), false); }
};
$('dealTabs').addEventListener('click', e => { const b = e.target.closest('[data-scope]'); if (!b || !lastDeals) return; dealScope = b.dataset.scope; renderDeals(lastDeals); });
$('watchDeals').onclick = async () => {
  try {
    const dest = $('dealDestination').value.trim();
    const a = await api('/api/alerts', { method: 'POST', body: { kind: 'deals', airports: $('dealAirports').value, destination: dest, cabin: $('dealCabin').value, maxPrice: Number($('dealMaxPrice').value || 0), minDropPct: Number($('dealMinDrop').value) } });
    state.alerts.unshift(a); renderAlerts(); renderKPIs(); toast(`Watching ${a.query.airports}${dest ? ` → ${dest}` : ''} for fares ${a.minDropPct}%+ below usual.`);
  } catch (e) { toast(e.message); }
};
async function saveSettings(patch, message) {
  try { await api('/api/settings', { method: 'PUT', body: patch }); await desktop?.settingsChanged?.(); await loadSettings(); await refreshHealth(); toast(message); }
  catch (e) { toast(e.message); }
}
$('saveApiKey').onclick = () => { const k = $('apiKey').value.trim(); if (!k) return toast('Paste a key first'); $('apiKey').value = ''; saveSettings({ seatsAeroApiKey: k }, 'seats.aero key saved'); };
$('clearApiKey').onclick = () => saveSettings({ seatsAeroApiKey: '' }, 'seats.aero key removed');
$('saveSettings').onclick = () => saveSettings({
  monitorIntervalMinutes: Number($('setInterval').value), desktopNotifications: $('setNotify').value === 'true',
  closeToTray: $('setTray').value === 'true', launchAtLogin: $('setLogin').value === 'true', webhookUrl: $('setWebhook').value
}, 'Settings saved');

// ---------- updates ----------
function renderUpdateStatus(u) {
  const v = $('updateVersion'), m = $('updateMessage'), install = $('installUpdate');
  install.hidden = u?.status !== 'downloaded';
  const s = {
    idle: [`v${u.version}`, 'PointPilot checks GitHub Releases every few hours and downloads updates in the background.'],
    checking: ['Checking…', 'Looking for a newer release on GitHub.'],
    available: [`Downloading ${u.version}`, 'A newer version was found and is downloading.'],
    downloading: [`Downloading ${u.version || ''} ${u.percent || 0}%`, 'The update is downloading in the background.'],
    downloaded: [`Ready: ${u.version}`, 'Restart now, or the update installs automatically when you quit.'],
    current: [`Up to date · v${u.version || ''}`, 'You are on the latest release.'],
    unavailable: ['Updater inactive', u.message],
    error: ['Update check failed', u.message || 'Could not reach GitHub Releases.']
  }[u?.status];
  if (s) { v.textContent = s[0]; m.textContent = s[1]; }
}
desktop?.onUpdateStatus?.(renderUpdateStatus);
$('checkUpdates').onclick = async () => { const r = await desktop?.checkForUpdates?.(); if (!desktop) toast('Updates apply to the installed desktop app.'); else if (r && !r.ok) renderUpdateStatus({ status: 'error', message: r.message }); };
$('installUpdate').onclick = () => desktop?.installUpdate?.();

// ---------- Trip Builder ----------
const tb = { plan: null, search: { outbound: null, return: null } };

async function loadBuilder() {
  try { renderBuilder(await api('/api/trip-plan')); } catch (e) { toast(e.message); }
}

const icsEscape = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const icsUtc = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') : null;
};
const icsDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).replace(/-/g, '') : null;
function tripCalendarText(plan) {
  const events = [];
  for (const entry of plan.timeline || []) {
    const item = entry.item || {};
    let summary = '', description = '', start = null, end = null, allDay = false;
    if (entry.type === 'award' || entry.type === 'positioning') {
      const f = entry.type === 'award' ? item.flight : item;
      const origin = f?.origin || item.origin || '';
      const destination = f?.destination || item.destination || '';
      const date = f?.depart?.date || item.departDate || item.date || item.dateFrom;
      const number = f?.flightNumbers?.length ? ` · ${f.flightNumbers.join('/')}` : item.flightNumber ? ` · ${item.flightNumber}` : '';
      summary = `${entry.type === 'award' ? 'Award flight' : 'Positioning flight'} ${origin}${origin && destination ? ' → ' : ''}${destination}${number}`;
      description = [item.programName || item.airline || '', item.mileageCost ? `${fmt(item.mileageCost)} points per traveler` : '', item.price ? `${money(item.price)} cash` : '', 'Times are shown in UTC when available. Confirm details with the airline.'].filter(Boolean).join(' · ');
      start = icsUtc(f?.departUtc || item.departUtc);
      end = icsUtc(f?.arriveUtc || item.arriveUtc);
      if (!start || !end) { start = icsDay(date); allDay = true; }
    } else if (entry.type === 'hotel') {
      const startDay = icsDay(item.checkIn), endDay = icsDay(item.checkOut);
      if (!startDay || !endDay) continue;
      summary = `Hotel · ${item.name || item.city || item.location || 'Stay'}`;
      description = [item.city || item.location || '', item.programName || '', item.totalPoints ? `${fmt(item.totalPoints)} points` : ''].filter(Boolean).join(' · ');
      start = startDay; end = endDay; allDay = true;
    }
    if (!summary || !start) continue;
    events.push({ summary, description, start, end, allDay });
  }
  if (!events.length) throw new Error('Add a flight or stay with dates to your Trip Builder first.');
  const fold = line => line.match(/.{1,70}/g)?.join('\r\n ') || '';
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const rows = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PointPilot//Trip Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  events.forEach((event, i) => {
    rows.push('BEGIN:VEVENT', `UID:${crypto.randomUUID()}-${i}@pointpilot`, `DTSTAMP:${now}`);
    if (event.allDay) rows.push(`DTSTART;VALUE=DATE:${event.start}`, ...(event.end ? [`DTEND;VALUE=DATE:${event.end}`] : []));
    else rows.push(`DTSTART:${event.start}`, ...(event.end ? [`DTEND:${event.end}`] : []));
    rows.push(`SUMMARY:${icsEscape(event.summary)}`, `DESCRIPTION:${icsEscape(event.description)}`, 'END:VEVENT');
  });
  rows.push('END:VCALENDAR');
  return rows.map(fold).join('\r\n') + '\r\n';
}
function downloadTripCalendar(plan) {
  const text = tripCalendarText(plan);
  const date = new Date().toISOString().slice(0, 10);
  window.PPKit.downloadText(`pointpilot-trip-${date}.ics`, text, 'text/calendar;charset=utf-8');
}
$('exportTripCalendar').onclick = () => {
  try { downloadTripCalendar(tb.plan || {}); toast('Calendar file saved.'); }
  catch (e) { toast(e.message); }
};

function legDesc(o) {
  const f = o.flight;
  return f ? `${esc(dayLabel(f.depart?.date))} · ${t12(f.depart?.time)} ${esc(f.origin)} → ${t12(f.arrive?.time)} ${esc(f.destination)}${plusDays(f.arriveDayOffset)} · ${dur(f.totalDurationMin)} · ${esc(f.flightNumbers.join(' / '))}`
    : `${esc(dayLabel(o.date))} · ${esc(o.origin)} → ${esc(o.destination)}`;
}

function cashFareTimes(f) {
  const dep = (f.departTime || '').slice(11, 16) || f.departTime, arr = (f.arriveTime || '').slice(11, 16);
  return `${dep ? t12(dep.length === 5 ? dep : dep.slice(0, 5)) : '?'}${arr ? ` → ${t12(arr)}` : ''}`;
}

function positioningSlot(p, dir) {
  const flights = tripEnds(p); // multi-city plans have no legacy `flights`: the first and last canonical legs play those roles
  const need = p.needs?.[dir];
  if (!need) {
    // Say why there's no connecting flight instead of silently leaving the step out.
    const award = flights[dir];
    const state_ = p.connections?.[dir];
    if (!award || state_ === 'no-flight') return '';
    const airport = dir === 'outbound' ? award.origin : award.destination;
    const text = state_ === 'home'
      ? (dir === 'outbound' ? `Your award departs from <strong>${esc(airport)}</strong>, your home airport, so no connecting flight is needed.` : `Your award lands at <strong>${esc(airport)}</strong>, your home airport, so no connecting flight is needed.`)
      : `Set your home airport above to plan a flight ${dir === 'outbound' ? `to ${esc(airport)}` : `home from ${esc(airport)}`}.`;
    return `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-check"/></svg></div><div class="card tl-card">
      <h4>${dir === 'outbound' ? `Start at ${esc(airport)}` : `Arrive home at ${esc(airport)}`} ${state_ === 'home' ? '<span class="tag">✓ NO CONNECTION NEEDED</span>' : ''}</h4><p>${text}</p></div></div>`;
  }
  const chosen = p.positioning[dir];
  const limit = dir === 'outbound'
    ? (need.latestArrivalLocal ? `Arrive ${need.to} by <strong>${t12(need.latestArrivalLocal.time)} ${esc(dayLabel(need.latestArrivalLocal.date))}</strong> (${p.buffers.outboundHours}h before your award flight).` : 'Arrive with plenty of time before your award flight.')
    : (need.earliestDepartureLocal ? `Leave ${need.from} after <strong>${t12(need.earliestDepartureLocal.time)} ${esc(dayLabel(need.earliestDepartureLocal.date))}</strong> (${p.buffers.returnHours}h after your award lands).` : 'Leave with plenty of time after your award lands.');
  const title = dir === 'outbound' ? `Get from ${need.from} to ${need.to}` : `Get home from ${need.from} to ${need.to}`;
  const s = tb.search[dir];
  // Compact one-line rows: time, flight, stops, duration, fit, price, button.
  const optRow = (o, kind) => `<div class="pos-row${o.fits === false ? ' dim' : ''}">
      <span class="pos-time">${kind === 'award' ? `${t12(o.flight.depart?.time)} → ${t12(o.flight.arrive?.time)}` : cashFareTimes(o)}</span>
      <span class="pos-meta">${kind === 'award' ? `${esc(o.programName)} award · ${esc(o.flight.flightNumbers.join(' / '))} · ${dur(o.flight.totalDurationMin)}` : `${esc(o.airlines || o.airline || '')} ${esc(o.flightNumbers || o.flightNumber || '')} · ${o.stops === 0 ? 'nonstop' : `${o.stops ?? '?'} stop(s)`}${o.durationMin ? ` · ${dur(o.durationMin)}` : ''}`}</span>
      <span>${o.fits === true ? '<span class="tag">FITS</span>' : o.fits === false ? '<span class="tag warn">TOO TIGHT</span>' : '<span class="tag muted">TIME ?</span>'}</span>
      <span class="pos-price">${kind === 'award' ? `${fmt(o.mileageCost)} pts` : money(o.price)}${kind === 'cash' && o.pricingLabel ? `<small class="fk-estimate">${esc(o.pricingLabel)}</small>` : ''}</span>
      <button class="btn small primary" data-tb="pick" data-dir="${dir}" data-kind="${kind}" data-i="${kind === 'award' ? s.awards.indexOf(o) : s.cash.indexOf(o)}">Use</button></div>`;
  const shown = tb.showAll?.[dir] ? 99 : 6;
  const results = s ? `<div style="margin-top:10px">${warningsBox(s.dataStatus.warnings)}
      ${s.cash.length ? `<div class="pos-head">Cash · ${s.counts?.fitting ?? s.cash.filter(f => f.fits).length} of ${s.counts?.cash ?? s.cash.length} fit your connection · per person</div>${s.cash.slice(0, shown).map(o => optRow(o, 'cash')).join('')}` : ''}
      ${s.cash.length > shown ? `<button class="btn small ghost" data-tb="more" data-dir="${dir}">Show all ${s.cash.length}</button>` : ''}
      ${s.awards.length ? `<div class="pos-head">Award options (economy)</div>${s.awards.slice(0, shown).map(o => optRow(o, 'award')).join('')}` : ''}
      ${!s.cash.length && !s.awards.length ? '<div class="muted">No flights found for this date.</div>' : ''}</div>` : '';
  return `<div class="tl-item"><div class="tl-dot${chosen ? '' : ' todo'}"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card">
    <h4>${esc(title)} ${chosen ? '<span class="tag">BOOKED IN PLAN</span>' : '<span class="tag warn">NEEDED</span>'}</h4>
    <p>${limit}</p>
    ${chosen ? `<p><strong>${chosen.kind === 'award' ? `${esc(chosen.programName)} award · ${fmt(chosen.mileageCost)} pts` : `${money(chosen.price)} cash`}</strong> · ${chosen.kind === 'award' ? legDesc(chosen) : `${esc(dayLabel(chosen.departDate || need.date))} · ${cashFareTimes(chosen)} · ${esc(chosen.airlines || chosen.airline || '')}`} <button class="btn small ghost" data-tb="unpick" data-dir="${dir}">Change</button></p>` : `
    <div class="btnrow"><button class="btn small primary" data-tb="search" data-dir="${dir}" data-date="${esc(need.date)}">Find flights ${esc(dayLabel(need.date))}</button>
      <button class="btn small" data-tb="search" data-dir="${dir}" data-date="${esc(addDays(need.date, dir === 'outbound' ? -1 : 1))}">${dir === 'outbound' ? 'Day before' : 'Day after'}</button>
      <a class="btn small" href="https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${need.from} to ${need.to} on ${need.date} one way`)}" target="_blank" rel="noreferrer">Google Flights ↗</a></div>${results}`}
  </div></div>`;
}

function renderBuilder(p) {
  tb.plan = p;
  $('exportTripCalendar').disabled = !(p.timeline || []).some(x => ['award', 'positioning', 'hotel'].includes(x.type));
  if (p.planHash && p.planHash !== tb.lastHash) { if (tb.lastHash) features.readiness?.invalidate(); tb.lastHash = p.planHash; }
  for (const [id, v] of [['tbHome', p.home.origin], ['tbReturnTo', p.home.returnTo], ['tbBufferOut', p.buffers.outboundHours], ['tbBufferBack', p.buffers.returnHours]]) if (document.activeElement !== $(id)) $(id).value = v ?? '';
  const out = p.flights?.outbound, ret = p.flights?.return;
  const awardItem = (o, dir) => o ? `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card">
      <h4>${dir === 'outbound' ? 'Outbound' : 'Return'} award · ${esc(o.programName)} ${seatChip(o.flight?.product)}</h4><p>${legDesc(o)}</p>
      <p>${fmt(o.mileageCost)} pts ${taxText(o)} per person × ${p.travelers} · ${esc(o.cabin)}${o.taxesMissing ? ' · <span class="flag">TAXES NOT REPORTED</span>' : ''}</p>
      <div class="btnrow" style="margin-top:4px">${bookLink(o)}<button class="btn small ghost" data-tb="remove-flight" data-dir="${dir}">Remove</button></div></div></div>`
    : `<div class="tl-item"><div class="tl-dot todo"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card"><h4>${dir === 'outbound' ? 'Outbound' : 'Return'} award flight</h4><p>Not chosen yet. Search in the Trip Optimizer, pick flights, then "Add to Trip Builder".</p><div class="btnrow" style="margin-top:4px"><button class="btn small" data-tb="goto" data-view="search">Open Trip Optimizer</button></div></div></div>`;
  const hotels = p.stays.length ? p.stays.map(s => `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-bed"/></svg></div><div class="card tl-card">
      <h4>${esc(s.name)} ${s.category ? `<span class="cat">${esc(s.programName.replace(/^World of /, ''))} Cat ${esc(s.category)}</span>` : ''}</h4>
      <p>${esc(s.city || s.location)} · ${dateFmt(s.checkIn)} → ${dateFmt(s.checkOut)} · ${s.nights} night(s) · ${fmt(s.totalPoints)} ${esc(s.programName)}</p>${stayOccupancy(s) ? `<p>${stayOccupancy(s)}</p>` : ''}</div></div>`).join('')
    : `<div class="tl-item"><div class="tl-dot todo"><svg class="icon"><use href="#i-bed"/></svg></div><div class="card tl-card"><h4>Hotels (optional)</h4><p>Build stays in the Trip Optimizer's Hotels tab with "Add to stay plan"; they appear here automatically.</p><div class="btnrow" style="margin-top:4px"><button class="btn small" data-tb="goto" data-view="search" data-product="hotels">Find hotels</button></div></div></div>`;
  const multi = (p.mode === 'open-jaw' || p.mode === 'multi-city') && window.PPFeatures?.itinerary;
  $('tbTimeline').innerHTML = multi
    ? positioningSlot(p, 'outbound') + window.PPFeatures.itinerary.timelineHtml(p, esc, safeUrl, { skipPositioning: true }) + positioningSlot(p, 'return')
    : positioningSlot(p, 'outbound') + awardItem(out, 'outbound') + hotels + awardItem(ret, 'return') + positioningSlot(p, 'return');
  const s = p.summary;
  const path = s.funding ? s.funding.sources.map(x => `<span class="node">${x.direct ? `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} (have)` : `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} → ${fmt(x.targetPoints)} ${esc(programLabel(x.targetProgram))}`}</span>`).join('') : '';
  $('tbSummary').innerHTML = `<div class="card plan" style="margin-top:0"><div class="eyebrow">Whole trip · ${p.travelers} traveler${p.travelers > 1 ? 's' : ''}</div>
    <h3 style="margin:4px 0 0">${fmt(s.totalPoints)} points + ${money(s.cashUsd)} cash</h3>
    <div class="note" style="margin-top:10px">${s.pointsByProgram.map(x => `${fmt(x.points)} ${esc(x.programName)}`).join('<br>') || 'Nothing added yet.'}</div>
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Cash = award taxes + positioning fares (all travelers). Hotel points are for the rooms you requested; for more than one room they are an estimate.</p>
    ${s.cashPricingUncertain ? '<div class="warnbox" role="note">The cash total is incomplete: some group positioning fares have an unconfirmed price basis and are left out of it.</div>' : ''}
    ${s.fundingStatus === 'search-limited' ? '<div class="warnbox">No funding plan was found within the supported search. This does not prove the trip is impossible.</div>' : s.affordable === false ? '<div class="warnbox">Your current balances and transfer partners can\'t cover the whole trip.</div>' : ''}
    ${path ? `<div class="path">${path}</div>` : ''}
    ${warningsBox(s.warnings)}
    <div class="btnrow"><button type="button" class="btn" data-readiness="trip">Check booking readiness</button></div></div>`;
}

$('view-builder').addEventListener('click', async e => {
  const b = e.target.closest('[data-tb]'); if (!b) return;
  const dir = b.dataset.dir;
  try {
    if (b.dataset.tb === 'remove-segment') {
      if (!window.confirm('Remove this flight from Trip Builder?')) return;
      await api(`/api/trip-plan/segments/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE', body: { expectedRevision: tb.plan.revision } });
      features.readiness?.invalidate();
      return loadBuilder();
    }
    if (b.dataset.tb === 'goto') { showView(b.dataset.view); if (b.dataset.product) document.querySelector(`button[data-product="${b.dataset.product}"]`)?.click(); return; }
    if (b.dataset.tb === 'remove-flight') {
      if (!window.confirm(`Remove the ${dir} award flight from Trip Builder?`)) return;
      return renderBuilder(await api(`/api/trip-plan/flights/${dir}`, { method: 'DELETE', body: {} }));
    }
    if (b.dataset.tb === 'unpick') { tb.search[dir] = null; return renderBuilder(await api(`/api/trip-plan/positioning/${dir}`, { method: 'DELETE', body: {} })); }
    if (b.dataset.tb === 'more') { tb.showAll = { ...(tb.showAll || {}), [dir]: true }; return renderBuilder(tb.plan); }
    if (b.dataset.tb === 'search') {
      tb.showAll = { ...(tb.showAll || {}), [dir]: false };
      busy(b, true, 'Searching…');
      tb.search[dir] = await api('/api/trip-plan/positioning/search', { method: 'POST', body: { direction: dir, date: b.dataset.date } });
      return renderBuilder(tb.plan);
    }
    if (b.dataset.tb === 'pick') {
      const s = tb.search[dir];
      const option = b.dataset.kind === 'award' ? s.awards[Number(b.dataset.i)] : s.cash[Number(b.dataset.i)];
      tb.search[dir] = null;
      return renderBuilder(await api(`/api/trip-plan/positioning/${dir}`, { method: 'PUT', body: { option: { ...option, kind: b.dataset.kind, departDate: option.departDate || s.need.date } } }));
    }
  } catch (err) { toast(err.message); busy(b, false); }
});
['tbHome', 'tbReturnTo', 'tbBufferOut', 'tbBufferBack'].forEach(id => $(id).addEventListener('change', async () => {
  try {
    tb.search = { outbound: null, return: null };
    // "Return home to" follows the home airport unless the user set it to something else.
    if (id === 'tbHome' && (!$('tbReturnTo').value || $('tbReturnTo').value.toUpperCase() === (tb.plan?.home.origin || ''))) $('tbReturnTo').value = $('tbHome').value.toUpperCase();
    renderBuilder(await api('/api/trip-plan/settings', { method: 'PUT', body: { home: { origin: $('tbHome').value, returnTo: $('tbReturnTo').value || $('tbHome').value }, buffers: { outboundHours: Number($('tbBufferOut').value), returnHours: Number($('tbBufferBack').value) } } }));
  } catch (e) { toast(e.message); }
}));
$('clearTrip').onclick = async () => {
  if (!window.confirm('Clear all flights from Trip Builder?')) return;
  tb.search = { outbound: null, return: null };
  renderBuilder(await api('/api/trip-plan', { method: 'DELETE', body: {} }));
};

// Aviasales has little business/first data, so premium cabins default to the live Google check.
function syncGoogleDefault() {
  if (state.product === 'cash' && state.cashData?.google) $('useGoogle').checked = $('cabin').value !== 'economy';
}
$('cabin').addEventListener('change', syncGoogleDefault);

// Countries typed in the flight search become sensible city suggestions for hotels.
const COUNTRY_CITIES = {
  thailand: 'Bangkok, Phuket, Chiang Mai', japan: 'Tokyo, Kyoto, Osaka', italy: 'Rome, Florence, Venice', france: 'Paris, Nice',
  spain: 'Madrid, Barcelona', portugal: 'Lisbon, Porto', uk: 'London, Edinburgh', 'united kingdom': 'London, Edinburgh', england: 'London',
  greece: 'Athens, Santorini', vietnam: 'Hanoi, Ho Chi Minh City, Da Nang', indonesia: 'Bali, Jakarta', 'south korea': 'Seoul, Busan', korea: 'Seoul, Busan',
  australia: 'Sydney, Melbourne', mexico: 'Mexico City, Cancun', germany: 'Berlin, Munich', switzerland: 'Zurich, Geneva', europe: 'Paris, London, Rome',
  hawaii: 'Honolulu, Maui', uae: 'Dubai, Abu Dhabi', 'new zealand': 'Auckland, Queenstown', china: 'Shanghai, Beijing', india: 'Delhi, Mumbai'
};

// ---------- navigation ----------
function showView(name) {
  document.querySelectorAll('.nav').forEach(x => {
    const active = x.dataset.view === name;
    x.classList.toggle('active', active);
    if (x.dataset.view) {
      if (active) x.setAttribute('aria-current', 'page');
      else x.removeAttribute('aria-current');
    }
  });
  const more = document.querySelector('.nav-more');
  if (more) {
    const secondaryActive = [...more.querySelectorAll('[data-view]')].some(x => x.dataset.view === name);
    more.open = secondaryActive;
    more.querySelector('summary')?.classList.toggle('active', secondaryActive);
  }
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === `view-${name}`));
  if (name === 'history') loadHistory().catch(e => toast(e.message));
  if (name === 'builder') loadBuilder();
  if (name === 'system') { features.diagnostics?.refresh(); features.backup?.refresh(); }
}

// ---------- destination discovery ----------
let discovery = null;
const discoveryGuard = createGuard();
function discoveryQuery() {
  return {
    origins: $('discoverOrigins').value.trim(),
    destinations: $('discoverDestinations').value.split(',').map(x => x.trim()).filter(Boolean),
    departDate: $('discoverDepart').value, returnDate: $('discoverReturn').value || null,
    flexDays: Number($('discoverFlex').value), cabin: $('discoverCabin').value,
    travelers: Number($('discoverTravelers').value), rank: $('discoverRank').value,
    nonstopOnly: $('discoverNonstop').checked, preserveFlexible: $('discoverFlexible').checked
  };
}

function renderDiscovery(data, query) {
  const entries = [...(data.results || [])];
  const best = entry => entry.result?.recommended?.trip || null;
  entries.sort((a, b) => {
    const x = best(a), y = best(b);
    if (!x || !y) return Number(Boolean(y)) - Number(Boolean(x));
    const rank = { points: () => x.totalSourcePoints - y.totalSourcePoints, fees: () => (x.taxesUsd ?? Infinity) - (y.taxesUsd ?? Infinity), stops: () => (x.totalStops ?? Infinity) - (y.totalStops ?? Infinity), duration: () => (x.totalDurationMin ?? Infinity) - (y.totalDurationMin ?? Infinity) }[query.rank];
    return (rank ? rank() : x.effectiveCostUsd - y.effectiveCostUsd) || x.effectiveCostUsd - y.effectiveCostUsd;
  });
  const source = status => ({ fetched: 'Award data refreshed', 'recent-cache': 'Recent cached award data', 'not-configured': 'Manual awards only', error: 'Award data refresh failed; cached results may be stale', skipped: 'Local award data' }[status] || 'Award data status unknown');
  $('discoverResults').innerHTML = `<div class="resultsbar"><div><h2>Best options found</h2><p>These are the best matches returned by the selected data source, not an exhaustive list. Each destination is an alternative using your full saved wallet; points are not reserved. Availability can change. Alerts notify you when a matching trip can be funded with your current points.</p></div></div><div class="discovery-results">${entries.map(entry => {
    const r = entry.result, t = best(entry);
    const originalIndex = data.results.indexOf(entry);
    const warning = entry.error ? (entry.error.message || entry.error) : null;
    const reason = warning ? `Search failed: ${warning}` : r?.dataStatus?.api === 'error' && !r?.outbound?.length ? 'Award data could not be refreshed. Try again.' : r?.mode === 'no-inventory' ? 'No award space found for these dates.' : r?.mode === 'no-valid-pairs' ? 'No compatible outbound and return pair found.' : 'No trip was funded within this search. Check available flights and your points.';
    const legs = t?.legs?.map(l => {
      const age = Number.isFinite(l.ageHours) ? ` · captured ${l.ageHours < 1 ? 'less than 1 hour' : `${Math.round(l.ageHours)} hours`} ago` : '';
      const observed = l.observedAt || l.sourceUpdatedAt;
      const providerTime = observed && Number.isFinite(Date.parse(observed)) ? ` · provider updated ${new Date(observed).toLocaleString()}` : '';
      return `${esc(l.origin)} → ${esc(l.destination)} · ${esc(dateFmt(l.date))} · ${esc(l.programName || programLabel(l.program))}${esc(age + providerTime)}`;
    }).join('<br>') || '';
    const funding = t?.sources?.map(s => s.direct ? `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} already held` : `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} → ${fmt(s.targetPoints)} ${esc(programLabel(s.targetProgram))}`).join(' · ') || '';
    const tripQuality = t ? `<p class="muted">${t.totalDurationMin == null ? 'Total time unavailable' : `${dur(t.totalDurationMin)} total travel`}${t.totalStops == null ? '' : ` · ${t.totalStops} stop${t.totalStops === 1 ? '' : 's'}`}</p>` : '';
    const detail = t ? `<div class="discovery-price">${fmt(t.totalSourcePoints)} points <span>+ ${t.taxesEstimated ? '≈' : ''}${money(t.taxesUsd)} taxes &amp; fees${t.taxesEstimated ? ' (estimated or unknown)' : ''}</span></div><p>${legs}</p>${tripQuality}<p>${funding}</p><p>Effective cost: ${money(t.effectiveCostUsd)} for ${fmt(t.travelers)} traveler${t.travelers === 1 ? '' : 's'}</p>${warningsBox(t.warnings || [])}` : `<p>${esc(reason)}</p>`;
    const warnings = r ? [...(r.dataStatus?.warnings || []), ...(r.truncated ? [r.truncatedReason || 'Results were limited.'] : [])] : [];
    const badge = t ? 'FUNDABLE' : warning ? 'SEARCH FAILED' : 'NO FUNDED TRIP FOUND';
    return `<article class="card discovery-card"><div class="cardhead"><h3>${esc(entry.destination)}</h3><span class="tag ${t ? '' : 'muted'}">${badge}</span></div>${detail}<p class="muted">${esc(source(r?.dataStatus?.api))}</p>${warningsBox(warnings)}<div class="btnrow"><button class="btn small${t ? ' primary' : ''}" data-discover-action="view" data-index="${originalIndex}">View flights</button><button class="btn small" data-discover-action="watch" data-index="${originalIndex}"${r ? '' : ' disabled'}>Set alert</button></div></article>`;
  }).join('')}</div>`;
}

async function runDiscovery() {
  const query = discoveryQuery(), status = $('discoverStatus');
  if (!query.origins || !query.departDate || !query.destinations.length || query.destinations.length > 8) {
    status.textContent = 'Enter a departure city, a departure date and 1–8 destinations.';
    return;
  }
  const token = discoveryGuard.next();
  discovery = null;
  $('discoverResults').innerHTML = '';
  busy($('discoverSearch'), true, 'Comparing…');
  status.textContent = 'Checking award space and your points for each destination…';
  try {
    const result = await api('/api/search/destinations', { method: 'POST', body: query, signal: token.signal });
    if (!discoveryGuard.isCurrent(token)) return;
    discovery = { result, query };
    renderDiscovery(result, query);
    status.textContent = `Compared ${result.results.length} destination(s). Results depend on available award data.`;
    refreshHealth().catch(() => {});
  } catch (e) {
    if (!isAbort(e) && discoveryGuard.isCurrent(token)) status.textContent = `Search failed: ${e.message}`;
  } finally { if (discoveryGuard.isCurrent(token)) busy($('discoverSearch'), false); }
}

$('discoverSearch').addEventListener('click', runDiscovery);
$('discoverWallet').addEventListener('click', () => showView('wallet'));
function discoveryCostHint() {
  const count = discoveryQuery().destinations.length;
  const calls = count * ($('discoverReturn').value ? 6 : 3);
  $('discoverStatus').textContent = count > 0 && count <= 8
    ? `Up to ${calls} award data requests; cached searches can use fewer. Each option uses your saved points.`
    : 'Choose 1–8 destinations. Searches use your saved points.';
}
['discoverDestinations', 'discoverReturn'].forEach(id => $(id).addEventListener('input', discoveryCostHint));
$('discoverResults').addEventListener('click', async e => {
  const button = e.target.closest('[data-discover-action]');
  const entry = discovery?.result.results[Number(button?.dataset.index)];
  if (!button || !entry) return;
  const { destinations: _destinations, ...q } = discovery.query;
  q.destination = entry.destination;
  if (button.dataset.discoverAction === 'watch') {
    busy(button, true, 'Saving…');
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, title: `${q.origins} → ${q.destination} · ${q.cabin} · ${q.travelers} pax` } });
      state.alerts.unshift(a); renderAlerts(); renderKPIs();
      toast('Alert saved for a trip your current points can fund. Keep PointPilot running to check it.');
    } catch (err) { toast(err.message); }
    finally { busy(button, false); }
    return;
  }
  document.querySelector('button[data-product="flights"]').click();
  const type = document.querySelector(`input[name="tripType"][value="${q.returnDate ? 'round-trip' : 'one-way'}"]`);
  type.checked = true; type.dispatchEvent(new Event('change', { bubbles: true }));
  $('origins').value = q.origins; $('destination').value = q.destination;
  $('dateFrom').value = q.departDate; $('dateTo').value = q.returnDate || '';
  $('flex').value = String(q.flexDays); $('cabin').value = q.cabin;
  $('travelers').value = String(q.travelers); $('rank').value = q.rank;
  $('directOnly').checked = q.nonstopOnly; $('keepFlexible').checked = q.preserveFlexible;
  $('productHunt').value = '';
  showView('search');
  runSearch();
});

document.querySelectorAll('.nav[data-view]').forEach(b => { b.onclick = () => showView(b.dataset.view); });
desktop?.onNavigate?.(showView);

document.querySelectorAll('button[data-product]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('button[data-product]').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    const prev = state.product;
    if (prev !== b.dataset.product) cancelSearch();
    state.product = b.dataset.product;
    const hotels = state.product === 'hotels', cash = state.product === 'cash';
    // Hotels search by city; flights/cash keep their own destination text.
    if (hotels && prev !== 'hotels') {
      state.flightDestination = $('destination').value;
      const key = $('destination').value.trim().toLowerCase();
      $('destination').value = state.hotelDestination || COUNTRY_CITIES[key] || ($('destination').value.includes(',') ? '' : $('destination').value);
      $('flex').value = '0';
      api('/api/stay-plan').then(renderStayPlan).catch(() => {});
    } else if (!hotels && prev === 'hotels') {
      state.hotelDestination = $('destination').value;
      if (state.flightDestination != null) $('destination').value = state.flightDestination;
      $('stayPlan').hidden = true;
    }
    $('destinationLabel').textContent = hotels ? 'Cities (comma-separated)' : 'Destination';
    $('destination').placeholder = hotels ? 'Tokyo, Kyoto' : 'Thailand, Tokyo, BKK…';
    $('origins').disabled = hotels; $('directOnly').disabled = hotels; $('travelers').disabled = hotels;
    $('originsField').hidden = hotels; $('travelersField').hidden = hotels;
    $('cabin').innerHTML = hotels
      ? '<option value="any" selected>Any room</option><option value="standard">Standard</option><option value="suite">Suite</option>'
      : `<option ${cash ? '' : 'selected'} value="business">Business</option><option value="first">First</option><option value="premium">Premium Economy</option><option ${cash ? 'selected' : ''} value="economy">Economy</option>`;
    $('cabinLabel').textContent = hotels ? 'Room' : 'Cabin';
    $('rank').disabled = cash || hotels;
    $('rankField').hidden = cash || hotels;
    for (const option of $('rank').options) option.disabled = hotels && !['overall', 'points'].includes(option.value);
    if (hotels && !['overall', 'points'].includes($('rank').value)) $('rank').value = 'overall';
    $('keepFlexibleWrap').hidden = cash;
    $('productWrap').hidden = state.product !== 'flights';
    $('useGoogleWrap').hidden = !cash;
    syncGoogleDefault();
    $('searchBtn').lastChild.textContent = cash ? 'Search cash fares' : 'Search & optimize';
    $('dateFromLabel').textContent = hotels ? 'Check-in' : 'Departure date';
    $('dateToLabel').textContent = hotels ? 'Check-out' : 'Return date (optional)';
  };
});

$('searchBtn').onclick = runSearch;

// ---------- recent searches + Enter to search ----------
const RECENT_KEY = 'pointpilot.recentSearches';
const FIELDS = ['destination', 'origins', 'travelers', 'cabin', 'dateFrom', 'dateTo', 'flex', 'rank', 'productHunt'];
function readRecents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function saveRecent() {
  const entry = { product: state.product, ...Object.fromEntries(FIELDS.map(f => [f, $(f).value])) };
  const key = JSON.stringify(entry);
  const list = [entry, ...readRecents().filter(e => JSON.stringify(e) !== key)].slice(0, 6);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  renderRecents();
}
function renderRecents() {
  const list = readRecents();
  $('recents').hidden = !list.length;
  $('recents').innerHTML = list.length ? `Recent: ${list.map((e, i) => `<button data-recent="${i}" title="${esc(e.origins)} → ${esc(e.destination)}">${e.product === 'hotels' ? '🏨' : e.product === 'cash' ? '$' : '✈'} ${esc(e.product === 'hotels' ? e.destination : `${e.origins} → ${e.destination}`)} · ${esc(dayLabel(e.dateFrom))}${e.productHunt ? ` · ${esc(e.productHunt.split('|')[2])}` : ''}</button>`).join('')}` : '';
}
$('recents').addEventListener('click', e => {
  const b = e.target.closest('[data-recent]'); if (!b) return;
  const r = readRecents()[Number(b.dataset.recent)]; if (!r) return;
  document.querySelector(`button[data-product="${r.product || 'flights'}"]`)?.click();
  for (const f of FIELDS) if (r[f] != null && $(f)) $(f).value = r[f];
  runSearch();
});
document.querySelector('#view-search .searchbox').addEventListener('keydown', e => {
  if (e.target.closest('#itineraryRoot')) return; // the open-jaw / multi-city screen handles its own keys
  if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); if (!$('searchBtn').disabled) runSearch(); }
});

// ---------- feature screens (itinerary, readiness, backup, diagnostics) ----------
const features = {};
let tripType = 'round-trip';
let savedReturnDate = '';

/** One way / Round trip use the classic form; Open jaw / Multi-city swap in the itinerary screen. */
function applyTripType() {
  const flights = state.product === 'flights';
  const itinerary = flights && (tripType === 'open-jaw' || tripType === 'multi-city');
  $('tripTypeWrap').hidden = !flights;
  $('roomsWrap').hidden = state.product !== 'hotels';
  $('classicSearch').hidden = itinerary;
  $('itineraryRoot').hidden = !itinerary;
  $('resultsBar').hidden = itinerary;
  $('results').hidden = itinerary;
  if (itinerary) { cancelSearch(); features.itinerary.setMode(tripType); }
  const oneWay = flights && tripType === 'one-way';
  $('dateTo').disabled = oneWay;
  if (oneWay) {
    if ($('dateTo').value) savedReturnDate = $('dateTo').value;
    $('dateTo').value = '';
  } else if (flights && !itinerary) {
    const validSavedDate = savedReturnDate && $('dateFrom').value && savedReturnDate > $('dateFrom').value;
    if (validSavedDate) $('dateTo').value = savedReturnDate;
    else if (!$('dateTo').value && $('dateFrom').value) $('dateTo').value = addDays($('dateFrom').value, 12);
    savedReturnDate = '';
  }
}
document.querySelectorAll('input[name="tripType"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { tripType = r.value; applyTripType(); } }));
document.querySelectorAll('button[data-product]').forEach(b => b.addEventListener('click', applyTripType));

/** The saved trip or stays changed (or a restore finished): refresh what shows them and retire stale readiness. */
function onPlanChanged(detail) {
  if (detail && detail.readinessOnly) return;
  features.readiness?.invalidate();
  loadBuilder();
  api('/api/stay-plan').then(renderStayPlan).catch(() => {});
  if (detail && detail.segments) { toast('Itinerary saved to your Trip Builder.'); showView('builder'); }
}

/** After a restore every view that shows restored data is reloaded from the server. */
async function onDataRestored() {
  const [user, alerts] = await Promise.all([api('/api/user'), api('/api/alerts')]);
  state.user = user; state.alerts = alerts;
  renderWallet(); renderAlerts(); renderKPIs();
  await Promise.all([loadSettings(), refreshHealth()]).catch(() => {});
  features.diagnostics?.refresh();
}

function openReadiness(scope, trigger) {
  const slot = $(scope === 'stay' ? 'stayReadinessSlot' : 'tbReadinessSlot');
  slot.appendChild($('readinessRoot'));
  features.readiness.open(scope, trigger);
}
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-readiness]');
  if (b) openReadiness(b.dataset.readiness, b);
});
$('gotoBackup').onclick = () => { showView('system'); $('backupCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('backupHeading').focus(); };

function updateTableScrollCue(el) {
  const overflowing = el.scrollWidth > el.clientWidth + 1;
  const moreRight = overflowing && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  el.classList.toggle('has-overflow', overflowing);
  el.classList.toggle('has-more-right', moreRight);
  if (overflowing) {
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Scrollable data table; use the horizontal scroll to see more columns');
  } else {
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
  }
}
document.querySelectorAll('.tableScroll').forEach(el => {
  const update = () => updateTableScrollCue(el);
  el.addEventListener('scroll', update, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(update).observe(el);
  if (window.MutationObserver) new MutationObserver(update).observe(el, { childList: true, subtree: true, characterData: true });
  update();
});

if (window.PPFeatures) {
  const deps = { api, esc, safeUrl, createGuard, onPlanChanged, desktop, navigate: showView, onDataRestored };
  features.itinerary = window.PPFeatures.itinerary.mount({ root: $('itineraryRoot'), ...deps });
  features.readiness = window.PPFeatures.readiness.mount({ root: $('readinessRoot'), ...deps });
  features.backup = window.PPFeatures.backup.mount({ root: $('backupRoot'), ...deps });
  features.diagnostics = window.PPFeatures.diagnostics.mount({ root: $('diagnosticsRoot'), ...deps });
}
applyTripType();
renderRecents();
initDates();
discoveryCostHint();
load();
