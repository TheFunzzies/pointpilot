'use strict';
const $ = id => document.getElementById(id);
const desktop = window.pointpilot || null;

const state = { product: 'flights', user: { balances: [], preferences: {} }, alerts: [], partners: null, programs: [], lastQuery: null };

// ---------- helpers ----------
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0));
const money = n => (n == null || !Number.isFinite(Number(n)) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n)));
const dateFmt = x => (x ? new Date(`${String(x).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const programLabel = id => state.programs.find(p => p.id === id)?.name || id;
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : null);

let toastTimer;
function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
  return payload;
}

function busy(button, on, label) {
  if (!button) return;
  if (on) { button._html = button.innerHTML; button.textContent = label || 'Working…'; button.disabled = true; }
  else { if (button._html != null) button.innerHTML = button._html; button.disabled = false; }
}

// ---------- boot ----------
function initDates() {
  const d = new Date(); d.setDate(d.getDate() + 150);
  const r = new Date(d); r.setDate(r.getDate() + 12);
  $('dateFrom').value = d.toISOString().slice(0, 10);
  $('dateTo').value = r.toISOString().slice(0, 10);
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
    await Promise.all([refreshHealth(), loadSettings(), loadProducts()]);
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
}

// ---------- wallet ----------
function renderKPIs() {
  const b = state.user.balances;
  $('kpiTotal').textContent = fmt(b.reduce((s, x) => s + Number(x.balance || 0), 0));
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
        <input type="number" min="0" step="1000" inputmode="numeric" aria-label="${esc(b.program)} balance" data-i="${i}" data-k="balance" value="${esc(b.balance)}">
        <input type="number" min="0" step="0.05" aria-label="${esc(b.program)} value in cents per point" data-i="${i}" data-k="cpp" value="${esc(b.cpp)}">
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

async function runSearch() {
  const msg = $('searchMessage');
  busy($('searchBtn'), true, 'Searching…');
  try {
    if (state.product === 'hotels') {
      msg.textContent = 'Searching hotel award space…';
      const q = currentHotelQuery();
      state.lastHotelQuery = q;
      const r = await api('/api/search/hotels', { method: 'POST', body: q });
      renderHotels(r); saveRecent();
      const src = { fetched: 'live rooms.aero data', 'recent-cache': 'rooms.aero data from the last hour', 'not-configured': 'manually entered hotels only', error: 'the local cache (rooms.aero failed)' }[r.dataStatus.api] || 'local data';
      msg.textContent = `${r.rows.length} hotel award(s) in ${r.query.destination} for ${r.nights} night(s), using ${src}.`;
      return;
    }
    if (state.product === 'cash') {
      msg.textContent = $('useGoogle').checked ? 'Checking cached fares and live Google Flights…' : 'Checking recent cash fares…';
      const q = { ...currentQuery(), useGoogle: $('useGoogle').checked };
      state.lastCashQuery = q;
      const r = await api('/api/cash/search', { method: 'POST', body: q });
      renderCash(r); saveRecent();
      msg.textContent = `${r.fares.length} fare(s) for ${r.query.origins.join(', ')} → ${r.query.destinations.join(', ')}${r.google ? ' · Google Flights checked' : ''}.`;
      return;
    }
    msg.textContent = 'Searching award space and optimizing against your points…';
    const q = currentQuery();
    state.lastQuery = q;
    const r = await api('/api/search/trip', { method: 'POST', body: q });
    renderFlightResults(r); saveRecent();
    const src = { fetched: 'live seats.aero data', 'recent-cache': 'seats.aero data from the last hour', 'not-configured': 'manually entered awards only', error: 'the local cache (seats.aero failed)', skipped: 'local data' }[r.dataStatus.api] || 'local data';
    msg.textContent = `Searched ${r.query.origins.join(', ')} → ${r.query.destinations.join(', ')} using ${src}.`;
  } catch (e) {
    msg.textContent = `Search failed: ${e.message}`;
  } finally { busy($('searchBtn'), false); }
}

function legLine(l) {
  const bits = [`${esc(l.origin)} → ${esc(l.destination)}`, dateFmt(l.date), `${fmt(l.pointsPerTraveler)} pts/person`];
  if (l.totalTaxes != null) bits.push(`${money(l.totalTaxes)} taxes/person`); else bits.push('taxes unknown');
  if (l.direct === true) bits.push('nonstop'); else if (l.direct === false) bits.push('connecting');
  if (l.airlines) bits.push(esc(l.airlines));
  return bits.join(' · ');
}

function sourceTag(l) {
  if (l.dataSource === 'seats.aero') return `<span class="tag">LIVE · ${l.ageHours < 1 ? '<1' : Math.round(l.ageHours)}h old</span>`;
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
  const apiWarn = warningsBox(r.dataStatus.warnings);
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
  $('results').innerHTML = warningsBox(r.dataStatus.warnings) + productHuntBanner(r) + `<div id="awSummary"></div>
    <div class="card filters" id="awFilters">
      <div><label for="fMaxPts">Max points / person</label><input id="fMaxPts" type="number" min="0" step="5000" placeholder="Any" style="width:120px"></div>
      <div><label for="fMaxHours">Max travel time</label><select id="fMaxHours"><option value="">Any</option><option value="10">10h</option><option value="14">14h</option><option value="18">18h</option><option value="22">22h</option><option value="26">26h</option><option value="32">32h</option></select></div>
      <div><label for="fStops">Stops</label><select id="fStops"><option value="">Any</option><option value="0">Nonstop</option><option value="1">1 stop or fewer</option></select></div>
      <div><label for="fDepart">Departs</label><select id="fDepart"><option value="">Any time</option><option value="0-6">Overnight (12–6 AM)</option><option value="6-12">Morning (6 AM–12 PM)</option><option value="12-18">Afternoon (12–6 PM)</option><option value="18-24">Evening (6 PM–12 AM)</option></select></div>
      <div><label for="fSeat">Seat quality</label><select id="fSeat"><option value="">Any</option><option value="3">Lie-flat or better</option><option value="4">Excellent (direct aisle)</option><option value="5">Top-tier suites only</option></select></div>
      <div><label for="fProgram">Program</label><select id="fProgram"><option value="">All programs</option>${programs.map(p => `<option value="${esc(p)}">${esc(programLabel(p))}</option>`).join('')}</select></div>
      <div><label for="fProduct">Seat product</label><select id="fProduct" style="max-width:240px"><option value="">Any</option>${cabinProducts.map(p => `<option value="${esc(p.key)}"${hunt?.key === p.key ? ' selected' : ''}>${esc(p.airline)}: ${esc(p.product)}</option>`).join('')}</select></div>
      <div><label for="fSort">Sort by</label><select id="fSort"><option value="points">Fewest points</option><option value="seat">Best seat</option><option value="duration">Shortest travel time</option><option value="depart">Departure time</option></select></div>
      <div><button class="btn small ghost" data-action="clear-filters">Clear filters</button></div>
    </div>
    <div class="picker ${hasReturn ? '' : 'single'}"><div class="picker-col" id="awCol-Outbound"></div>${hasReturn ? '<div class="picker-col" id="awCol-Return"></div>' : ''}</div>`;
  $('awFilters').addEventListener('input', () => { award.show = { Outbound: 25, Return: 25 }; renderColumns(); });
  renderColumns();
  renderAwardSummary();
  // Load the individual flights for the recommended days right away so times show immediately.
  (async () => {
    for (const leg of ['Outbound', 'Return']) if (award.day[leg]) await ensureExpanded(leg, award.day[leg]);
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
const SEAT_TIER = { 5: 'Top-tier suite', 4: 'Excellent lie-flat', 3: 'Lie-flat', 2: 'Older lie-flat', 1: 'Recliner', 0: 'Standard seat' };
const seatChip = p => (p && p.type ? `<span class="seatchip s${p.score ?? 0}" title="${esc(SEAT_TIER[p.score] || '')}: ${esc(p.detail || '')}${p.certainty === 'varies' ? ' (varies by aircraft)' : ''}">${p.score >= 3 ? '★'.repeat(p.score - 2) + ' ' : ''}${esc(p.type)}${p.certainty === 'varies' ? ' *' : ''}</span>` : '');
const dayLabel = d => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const optById = id => [...(award.r?.outbound || []), ...(award.r?.return || [])].find(o => o.id === id) || null;

function filteredOptions(leg) {
  const list = (leg === 'Outbound' ? award.r.outbound : award.r.return) || [];
  const v = id => $(id)?.value || '';
  const maxPts = Number(v('fMaxPts')) || 0, maxH = Number(v('fMaxHours')) || 0, stops = v('fStops'), dep = v('fDepart'), seat = Number(v('fSeat')) || 0, prog = v('fProgram'), sort = v('fSort') || 'points';
  const wantProduct = productOf(v('fProduct'));
  const out = list.filter(o => {
    const f = o.flight;
    if (maxPts && o.mileageCost > maxPts) return false;
    if (maxH && f && f.totalDurationMin > maxH * 60) return false;
    if (stops === '0' && !(f ? f.stops === 0 : o.direct === true)) return false;
    if (stops === '1' && f && f.stops > 1) return false;
    if (dep) { if (!f?.depart?.time) return false; const h = Number(f.depart.time.slice(0, 2)); const [a, b] = dep.split('-').map(Number); if (h < a || h >= b) return false; }
    if (seat && !((o.seatScore ?? -1) >= seat)) return false;
    if (prog && o.program !== prog) return false;
    if (wantProduct && !optHasProduct(o, wantProduct)) return false;
    return true;
  });
  const cmp = {
    points: (a, b) => a.mileageCost - b.mileageCost || (b.seatScore ?? -1) - (a.seatScore ?? -1),
    seat: (a, b) => (b.seatScore ?? -1) - (a.seatScore ?? -1) || a.mileageCost - b.mileageCost,
    duration: (a, b) => (a.flight?.totalDurationMin ?? Infinity) - (b.flight?.totalDurationMin ?? Infinity) || a.mileageCost - b.mileageCost,
    depart: (a, b) => String(a.flight?.departUtc || `${a.date}T99`).localeCompare(String(b.flight?.departUtc || `${b.date}T99`))
  }[sort];
  return out.sort(cmp);
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
  return `<div class="opt${selected ? ' selected' : ''}${conflict ? ' dim' : ''}" data-select="${esc(o.id)}" data-leg="${leg}">
    ${selected ? '<span class="check">✓ SELECTED</span>' : rec ? '<span class="check" style="background:var(--green)">RECOMMENDED</span>' : ''}
    <div class="row1"><div><div class="times">${f ? `${t12(f.depart?.time)} → ${t12(f.arrive?.time)}${plusDays(f.arriveDayOffset)}` : esc(dayLabel(o.date))}</div>
      <div class="meta">${f ? `${esc(dayLabel(f.depart?.date))} · ${dur(f.totalDurationMin)} · ${stopsTxt}` : `${esc(o.origin)} → ${esc(o.destination)}${stopsTxt ? ` · ${stopsTxt}` : ''} · flight times not available`}</div></div>
      <div class="pts">${fmt(o.mileageCost)}<div class="meta" style="font-weight:500">${taxText(o)} / person</div></div></div>
    <div class="meta2">${seatChip(f?.product)} ${f?.product?.aircraft ? `<span>${esc(f.product.aircraft)}</span>` : ''}<span>${esc(o.programName)}</span>${f ? `<span>${esc(f.airlines.join(', '))} ${esc(f.flightNumbers.join(' / '))}</span>` : (o.airlines ? `<span>${esc(o.airlines)}</span>` : '')}${o.remainingSeats ? `<span>${o.remainingSeats} seat(s)</span>` : ''}${o.history ? `<span class="history-badge" style="margin:0">${esc(o.history.label)}</span>` : ''}${sourceTag(o)}
      ${f || o.availabilityId ? `<button class="btn small ghost" data-action="opt-details" data-id="${esc(o.id)}">${open ? 'Hide details' : 'Flight details'}</button>` : ''}</div>
    ${award.r?.query.product && optHasProduct(o, award.r.query.product) ? `<div class="meta2"><span class="flag good">✓ ${esc(award.r.query.product.product)} on this flight</span></div>` : ''}
    ${flagsFor(o, leg) ? `<div class="meta2">${flagsFor(o, leg)}</div>` : ''}
    ${conflict ? `<div class="meta" style="color:var(--amber)">${esc(conflict)}</div>` : ''}
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
  const need = legList(leg).filter(o => dayKey(o) === day && !o.flight && o.availabilityId && !award.loading.has(o.id));
  if (!need.length) return;
  need.forEach(o => award.loading.add(o.id));
  try {
    const r = await api('/api/award/expand', { method: 'POST', body: { awards: need, leg, travelers: award.r.query.travelers } });
    const ids = new Set(need.map(o => o.id));
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
  } catch (e) { need.forEach(o => award.loading.delete(o.id)); toast(e.message); }
}

function renderColumns() {
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
      return `<button class="day${d === open ? ' open' : ''}" data-action="open-day" data-leg="${leg}" data-day="${esc(d)}">
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
      ${pinned}<div class="opts">${list.slice(0, award.show[leg]).map(o => optCard(o, leg)).join('') || (loading ? '' : '<div class="card empty">No flights match these filters on this day.</div>')}</div>
      ${list.length > award.show[leg] ? `<button class="btn small more" data-action="more" data-leg="${leg}">Show ${Math.min(25, list.length - award.show[leg])} more</button>` : ''}`;
    col.querySelectorAll('[data-load-trips]').forEach(el => loadTrips(el, el.dataset.loadTrips, el.dataset.cabin));
    upgradeSeatMaps(col);
  }
}

async function openDay(leg, day) {
  award.day[leg] = day;
  award.show[leg] = 25;
  renderColumns();
  await ensureExpanded(leg, day);
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
  box.innerHTML = `<div class="card summary-card"><div class="cardhead"><div><div class="eyebrow">Your trip${isRec ? ' · recommended' : ''}</div><h3 id="awHeadline">${out ? 'Calculating…' : 'Choose your flights'}</h3></div>
      ${!isRec && award.recIds.size ? '<button class="btn small" data-action="reset-rec">Back to recommended</button>' : ''}</div>
    <div class="summary-legs">${summaryLeg(out, 'Outbound')}${hasReturn ? summaryLeg(back, 'Return') : ''}</div>
    <div id="awFunding"></div><div id="cashCompare"></div>
    <div class="btnrow"><button class="btn primary" data-action="add-builder"${out ? '' : ' disabled'}><svg class="icon"><use href="#i-map"/></svg>Add to Trip Builder</button><button class="btn" data-action="compare-cash"${out ? '' : ' disabled'}><svg class="icon"><use href="#i-tag"/></svg>Compare with cash price</button><button class="btn" data-action="monitor-open"><svg class="icon"><use href="#i-bell"/></svg>Set an alert</button></div>
    <div id="awAlertPanel" class="note" hidden>
      <strong>Alert me when…</strong>
      <div class="btnrow" style="margin-top:8px">
        <select id="alertMode">
          ${out?.flight ? `<option value="exact">These exact flights (${esc([out, back].filter(Boolean).map(o => o.flight?.flightNumbers.join('/') || o.date).join(' + '))}) are available</option>
          <option value="similar" selected>These flights or similar: same day, ≤10% more points, same or better seat</option>` : ''}
          <option value="any"${out?.flight ? '' : ' selected'}>Any award on these dates fits my points</option>
        </select>
        <input id="alertMaxPts" class="inputnum" type="number" min="0" step="5000" placeholder="Max pts / person">
        <button class="btn primary small" data-action="monitor-create">Create alert</button>
      </div>
      <p class="muted" style="margin:6px 0 0;font-size:12px">Checked in the background (Data &amp; System → alert interval); you get a Windows notification when it matches or the price drops.</p>
    </div></div>`;
  if (!out) return;
  const seq = ++award.seq;
  const legs = [out, ...(hasReturn && back ? [back] : [])];
  try {
    const r = await api('/api/trip/evaluate', { method: 'POST', body: { legs, travelers: award.r.query.travelers, preserveFlexible: $('keepFlexible').checked } });
    if (seq !== award.seq) return;
    if (!r.affordable) { $('awHeadline').textContent = 'Not affordable with your points'; $('awFunding').innerHTML = `<div class="warnbox">${esc(r.reason)}</div>`; state.bestTrip = null; return; }
    const t = r.trip;
    state.bestTrip = t;
    $('awHeadline').textContent = `${fmt(t.totalSourcePoints)} points + ${money(t.taxesUsd)} for ${t.travelers} traveler${t.travelers > 1 ? 's' : ''}${hasReturn && !back ? ' (outbound only so far)' : ''}`;
    $('kpiScore').textContent = money(t.effectiveCostUsd);
    $('kpiHint').textContent = `${fmt(t.totalSourcePoints)} pts + ${money(t.taxesUsd)}`;
    const path = t.sources.map(s => `<span class="node">${s.direct ? `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} (have)` : `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} → ${fmt(s.targetPoints)} ${esc(programLabel(s.targetProgram))}${s.bonusPct ? ` (+${Math.round(s.bonusPct * 100)}%)` : ''}`}</span>`).join('');
    $('awFunding').innerHTML = `<div class="metrics" style="margin-top:12px"><div class="metric"><span>Award points needed</span><b>${fmt(t.totalTargetPoints)}</b></div><div class="metric"><span>Taxes &amp; fees${t.taxesEstimated ? ' (incl. estimate)' : ''}</span><b>${t.taxesEstimated ? '≈' : ''}${money(t.taxesUsd)}</b></div><div class="metric"><span>Effective cost</span><b>${money(t.effectiveCostUsd)}</b></div><div class="metric"><span id="valueMetricLabel">Value</span><b class="positive" id="valueMetric">${t.cpp ? `${t.cpp.toFixed(2)}¢/pt` : 'compare with cash ↓'}</b></div></div>
      <div class="path">${path}</div>${warningsBox(t.warnings)}`;
  } catch (e) { if (seq === award.seq) $('awFunding').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

async function addSelectionToBuilder() {
  const out = optById(award.sel.Outbound), back = award.r.query.back ? optById(award.sel.Return) : null;
  try {
    await api('/api/trip-plan/flights', { method: 'PUT', body: { outbound: out, return: back, travelers: award.r.query.travelers, cabin: award.r.query.cabin } });
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
  return {
    destination: $('destination').value.trim(), checkIn: $('dateFrom').value, checkOut: $('dateTo').value || null,
    flexDays: Number($('flex').value), roomType: $('cabin').value, rank: $('rank').value, preserveFlexible: $('keepFlexible').checked
  };
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
    <p class="links">Reviews &amp; awards: <a href="${esc(L.google)}" target="_blank" rel="noreferrer">Google</a> · <a href="${esc(L.tripadvisor)}" target="_blank" rel="noreferrer">TripAdvisor</a> · <a href="${esc(L.forbes)}" target="_blank" rel="noreferrer">Forbes Travel Guide</a> · <a href="${esc(L.michelin)}" target="_blank" rel="noreferrer">MICHELIN Guide</a>${h.info ? '' : ` · <button class="btn small ghost" data-action="hotel-info-one" data-i="${i}">Get star rating</button>`}</p>
    <div class="btnrow" style="margin-top:6px"><button class="btn small primary" data-action="add-stay" data-i="${i}"><svg class="icon"><use href="#i-plus"/></svg>Add to stay plan</button>${link ? `<a class="btn small" href="${esc(link)}" target="_blank" rel="noreferrer">View / book ↗</a>` : ''}</div>
  </div><div class="right"><span class="pts">${fmt(h.totalPoints)} pts</span><span class="subv">${fmt(h.nightlyPoints)}/night${h.cashUsd ? ` · cash ${money(h.cashUsd)} · ${h.cpp.toFixed(2)}¢/pt` : ''}</span>${h.effectiveCostUsd != null ? `<span class="subv">${money(h.effectiveCostUsd)} in points value</span>` : ''}</div></div>`;
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
  if (state.lastHotels !== r) { state.lastHotels = r; state.hotelRows = r.rows || []; }
  const minStars = Number(state.hotelMinStars || 0);
  const allRows = state.hotelRows;
  // Filtering keeps original indexes so "Add to stay plan" still points at the right hotel.
  const rows = allRows;
  const visible = h => !minStars || (h.info?.stars || 0) >= minStars;
  $('resultMeta').textContent = `${fmt(rows.length)} hotel award(s) in ${r.query.cities.join(', ')} · ${r.nights} night(s) · ${r.query.roomType === 'any' ? 'any room' : r.query.roomType}`;
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
      return `${r.cities.length > 1 ? `<div class="city-head"><h3>${esc(city)}</h3><span class="muted">${list.length} option(s)</span></div>` : ''}<div class="result-list">${list.slice(0, 20).map(x => hotelCard(x.h, x.i)).join('')}</div>`;
    }).join('');
    const monitorBtn = '<input id="hotelAlertMax" class="inputnum" type="number" min="0" step="1000" placeholder="Max pts/night" title="Optional: only alert at or below this many points per night"><button class="btn" data-action="monitor-hotel"><svg class="icon"><use href="#i-bell"/></svg>Monitor these stays</button>';
    const unknown = allRows.filter(h => !h.info).length;
    const programsByCity = new Set(allRows.filter(h => !h.info).map(h => `${h.city}|${h.program}`)).size;
    const toolbar = `<div class="card filters" style="margin-bottom:12px">
      <div><label for="hotelMinStars">Hotel class</label><select id="hotelMinStars"><option value="0">Any</option><option value="3"${minStars === 3 ? ' selected' : ''}>3-star+</option><option value="4"${minStars === 4 ? ' selected' : ''}>4-star+</option><option value="5"${minStars === 5 ? ' selected' : ''}>5-star only</option></select></div>
      ${unknown ? `<div><button class="btn small" data-action="hotel-info-all">Load star ratings &amp; reviews</button><span class="muted" style="font-size:12px;margin-left:6px">about ${programsByCity} SerpApi search${programsByCity === 1 ? '' : 'es'}, cached 60 days</span></div>` : '<div class="muted" style="font-size:12.5px">Ratings loaded (Google)</div>'}
      <div class="muted" style="font-size:12px">🔑 = MICHELIN Key hotel</div></div>`;
    const planNote = r.dataStatus.planNote ? `<div class="note">Payments below use what's left <strong>after the ${r.dataStatus.planNote.stays} stay${r.dataStatus.planNote.stays > 1 ? 's' : ''} already in your stay plan</strong> (${r.dataStatus.planNote.committed.map(c => `${fmt(c.points)} ${esc(programLabel(c.from))}`).join(', ')} committed).</div>` : '';
    $('results').innerHTML = warningsBox(r.dataStatus.warnings) + planNote + toolbar + compare + groups + `<div class="btnrow">${monitorBtn}</div>`;
    $('hotelMinStars').onchange = e => { state.hotelMinStars = Number(e.target.value); renderHotels(r); };
    return;
  }
  const monitorBtn = '<input id="hotelAlertMax" class="inputnum" type="number" min="0" step="1000" placeholder="Max pts/night" title="Optional: only alert at or below this many points per night"><button class="btn" data-action="monitor-hotel"><svg class="icon"><use href="#i-bell"/></svg>Monitor these stays</button>';
  const tip = r.dataStatus.api === 'not-configured' ? '<div class="note">Tip: your seats.aero key also unlocks live hotel search (rooms.aero). Add it under <em>Data &amp; System</em>.</div>' : '';
  $('results').innerHTML = `<div class="card empty"><strong>No hotel award space found in ${esc(r.query.cities.join(', '))} for these dates.</strong>Try nearby dates (date flexibility), a different city name, or a shorter stay.${warningsBox(r.dataStatus.warnings)}${tip}<div class="btnrow">${monitorBtn}<button class="btn" data-action="manual">Add a hotel award</button></div></div>`;
}

// ---------- stay planner ----------
async function addStayFromResult(i) {
  const h = state.hotelRows?.[i]; if (!h) return;
  try {
    const plan = await api('/api/stay-plan/stays', { method: 'POST', body: {
      name: h.name, hotelId: h.hotelId, program: h.program, city: h.city, location: h.location, category: h.category, roomType: h.roomType,
      checkIn: h.checkIn, checkOut: addDays(h.checkIn, h.nights), nightlyPoints: h.nightlyPoints, cashPerNight: h.cashValue,
      bookingUrl: h.bookingUrl, dataSource: h.dataSource, estimated: h.estimated
    } });
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
  if (!plan?.stays.length || state.product !== 'hotels') { el.hidden = true; return; }
  const s = plan.summary;
  const fundingPath = s.funding ? s.funding.sources.map(x => `<span class="node">${x.direct ? `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} (have)` : `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} → ${fmt(x.targetPoints)} ${esc(programLabel(x.targetProgram))}${x.bonusPct ? ` (+${Math.round(x.bonusPct * 100)}%)` : ''}`}</span>`).join('') : '';
  el.hidden = false;
  el.innerHTML = `<div class="card plan"><div class="cardhead"><div><div class="eyebrow">Stay plan</div><h3>${s.stays} hotel${s.stays > 1 ? 's' : ''} · ${s.nights} night${s.nights > 1 ? 's' : ''} · ${dateFmt(s.start)} → ${dateFmt(s.end)}</h3></div><button class="btn small ghost" data-plan="clear">Clear plan</button></div>
    <div class="plan-stays">${plan.stays.map((x, i) => `<div class="plan-stay"><span class="num">${i + 1}</span>
      <div><strong>${esc(x.name)}</strong> ${x.category ? `<span class="cat">${esc(x.programName.replace(/^World of /, ''))} Cat ${esc(x.category)}</span>` : ''}<small>${esc(x.city || x.location)} · ${dateFmt(x.checkIn)} → ${dateFmt(x.checkOut)} · ${x.nights} night(s) · ${esc(x.roomType)}${x.bookingUrl ? ` · <a href="${esc(x.bookingUrl)}" target="_blank" rel="noreferrer">book ↗</a>` : ''}</small></div>
      <div class="pts">${fmt(x.totalPoints)} ${esc(x.programName.replace(/^World of /, ''))}<small>${x.cashUsd ? `${money(x.cashUsd)} cash` : ''}</small></div>
      <button class="btn ghost icon-only" data-plan="remove" data-id="${esc(x.id)}" title="Remove"><svg class="icon"><use href="#i-x"/></svg></button></div>`).join('')}</div>
    <div class="metrics" style="margin-top:12px">
      <div class="metric"><span>Total points</span><b>${fmt(s.totalPoints)}</b></div>
      <div class="metric"><span>By program</span><b style="font-size:13px">${s.pointsByProgram.map(p => `${fmt(p.points)} ${esc(p.programName.replace(/^World of /, ''))}`).join(' · ')}</b></div>
      <div class="metric"><span>Cash price</span><b>${s.cashUsd ? money(s.cashUsd) : '—'}</b></div>
      <div class="metric"><span>Value</span><b class="positive">${s.cpp ? `${s.cpp.toFixed(2)}¢/pt` : '—'}</b></div></div>
    ${s.funding ? `<div class="path">${fundingPath}</div>` : '<div class="warnbox">Your current balances and transfer partners can\'t cover the whole plan.</div>'}
    ${warningsBox(s.warnings)}
    <div class="note">Next stay starts <strong>${dateFmt(s.nextCheckIn)}</strong>. Enter the next city above and search; dates are already set.</div></div>`;
}

$('stayPlan').addEventListener('click', async e => {
  const b = e.target.closest('[data-plan]'); if (!b) return;
  try {
    if (b.dataset.plan === 'remove') renderStayPlan(await api(`/api/stay-plan/stays/${b.dataset.id}`, { method: 'DELETE', body: {} }));
    if (b.dataset.plan === 'clear') renderStayPlan(await api('/api/stay-plan', { method: 'DELETE', body: {} }));
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

function fareCard(f, travelers) {
  const link = safeUrl(f.link);
  const stops = f.stops == null ? '' : f.stops === 0 ? 'nonstop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`;
  return `<div class="card result"><div>
    <h4>${esc(f.originName)} → ${esc(f.destinationName)} ${dealTag(f)} ${f.live ? '<span class="tag brand">LIVE · GOOGLE</span>' : '<span class="tag muted">RECENT · AVIASALES</span>'}</h4>
    <p>${esc(f.origin)} → ${esc(f.destination)} · ${dateFmt(f.departDate)}${f.returnDate ? ` – ${dateFmt(f.returnDate)}` : ' · one-way'}${stops ? ` · ${stops}` : ''}${f.airline || f.airlines ? ` · ${esc(f.airline || f.airlines)}` : ''}</p>
    ${f.usualPrice ? `<p>Usual price ≈ ${money(f.usualPrice)} (seen on ${f.baselineDays} days)</p>` : ''}
    ${link ? `<p><a href="${esc(link)}" target="_blank" rel="noreferrer">View on Aviasales ↗</a></p>` : ''}
  </div><div class="right"><span class="pts">${money(f.price)}</span><span class="subv">per person${travelers > 1 ? ` · ${money(f.total)} for ${travelers}` : ''}</span></div></div>`;
}

function renderCash(r) {
  const fares = r.fares || [];
  const t = r.query.travelers;
  $('resultMeta').textContent = `${fmt(fares.length)} cash fare(s) · ${r.query.cabin} · ${t} traveler${t > 1 ? 's' : ''}`;
  $('kpiScore').textContent = fares[0] ? money(fares[0].price) : '—';
  $('kpiHint').textContent = fares[0] ? 'cheapest per person' : 'no fares found';
  let google = '';
  if (r.google) {
    const i = r.google.insights;
    const g0 = r.google.fares[0];
    google = `<div class="card reco"><div class="cardhead"><div><div class="eyebrow">Live Google Flights · ${esc(r.query.cabin)}</div><h3>${g0 ? `${money(g0.price)} per person` : 'No live fares found'}${g0 && t > 1 ? ` · ${money(g0.total)} total` : ''}</h3></div>${safeUrl(r.google.url) ? `<a class="btn small" href="${esc(r.google.url)}" target="_blank" rel="noreferrer">Open in Google Flights ↗</a>` : ''}</div>
      ${i?.level ? `<div class="note"><strong>${esc(LEVEL_TEXT[i.level] || i.level)}.</strong>${i.typicalRange ? ` Typical: ${money(i.typicalRange[0])}–${money(i.typicalRange[1])}.` : ''}</div>` : ''}
      ${r.google.fares.length ? `<div class="result-list">${r.google.fares.slice(0, 5).map(f => `<div class="result card"><div><h4>${esc(f.airlines)}</h4><p>${esc(f.origin)} → ${esc(f.destination)} · ${f.stops === 0 ? 'nonstop' : `${f.stops} stop(s)`}${f.durationMin ? ` · ${Math.floor(f.durationMin / 60)}h ${f.durationMin % 60}m` : ''}</p></div><div class="right"><span class="pts">${money(f.price)}</span><span class="subv">per person</span></div></div>`).join('')}</div>` : ''}
    </div>`;
  }
  const alertForm = `<div class="card searchbox" style="margin-top:12px"><div class="cardhead"><div><h3>Set a price alert</h3><p>PointPilot checks this route in the background and notifies you when the price drops below your target or well below its usual price.</p></div></div>
    <div class="btnrow"><input id="cashTarget" class="inputnum" type="number" min="0" step="10" placeholder="Target $ / person" value="${fares[0] ? Math.max(0, Math.round(fares[0].price * 0.85 / 10) * 10) : ''}">
    <select id="cashDealPct"><option value="0">Only my target</option><option value="15">or 15% below usual</option><option value="20" selected>or 20% below usual</option><option value="30">or 30% below usual</option></select>
    <button class="btn primary" data-action="cash-alert"><svg class="icon"><use href="#i-bell"/></svg>Create price alert</button>
    <a class="btn" href="${esc(r.googleFlightsUrl)}" target="_blank" rel="noreferrer">Open in Google Flights ↗</a></div></div>`;
  const notConfigured = r.dataStatus.travelpayouts === 'not-configured';
  const list = fares.length ? `<div class="result-list">${fares.map(f => fareCard(f, t)).join('')}</div>`
    : r.google ? ''
    : notConfigured ? '<div class="card empty"><strong>Connect a cash fare source</strong>Add a free Travelpayouts token (and optionally a SerpApi key) under <em>Data &amp; System</em> to search cash fares and get price alerts.</div>'
    : '<div class="card empty"><strong>No recent fares found for these dates.</strong>Aviasales may not have cached prices for this route yet. Try ± more days, nearby airports, or a live Google check.</div>';
  const econRef = r.economyReference?.length ? `<div class="note"><strong>Economy fares for reference</strong> (recent Aviasales):<br>${r.economyReference.map(f => `${esc(f.origin)} → ${esc(f.destination)} ${dateFmt(f.departDate)}${f.returnDate ? ` – ${dateFmt(f.returnDate)}` : ''}: ${money(f.price)}`).join('<br>')}</div>` : '';
  const googleBanner = `<div class="card searchbox" style="margin-bottom:12px"><div class="cardhead"><div><h3>See every flight on Google Flights</h3><p>${esc(r.query.origins.join(', '))} → ${esc(r.query.destinations.join(', '))} · ${esc(r.query.cabin)} · ${dateFmt(r.query.out.start)}${r.query.back ? ` – ${dateFmt(r.query.back.end)}` : ''}, prefilled.</p></div><a class="btn primary" href="${esc(r.googleFlightsUrl)}" target="_blank" rel="noreferrer">Open Google Flights ↗</a></div></div>`;
  $('results').innerHTML = googleBanner + warningsBox(r.dataStatus.warnings) + google + list + econRef + alertForm;
}

async function compareCash() {
  const t = state.bestTrip; if (!t) return;
  const out = t.legs[0], back = t.legs[1];
  const box = $('cashCompare');
  box.innerHTML = '<div class="note">Looking up the cash price…</div>';
  try {
    const r = await api('/api/cash/itinerary', { method: 'POST', body: { origin: out.origin, destination: out.destination, departDate: out.date, returnDate: back?.date || null, cabin: out.cabin, travelers: t.travelers } });
    if (!r.available) { box.innerHTML = `<div class="note">${esc(r.reason || 'No cash price found for these dates.')} <a href="${esc(r.url)}" target="_blank" rel="noreferrer">Check Google Flights ↗</a></div>`; return; }
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
  } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

$('results').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  const action = btn?.dataset.action;
  // Award picker: clicking a flight card selects it (links, buttons and details don't).
  const card = e.target.closest('.opt[data-select]');
  if (card && !btn && !e.target.closest('a, .details')) {
    award.sel[card.dataset.leg] = card.dataset.select;
    // A new outbound can invalidate the chosen return; keep it but it will be flagged.
    renderColumns(); renderAwardSummary();
    return;
  }
  if (action === 'open-day') { openDay(btn.dataset.leg, btn.dataset.day); return; }
  if (action === 'opt-details') { const id = btn.dataset.id; award.open.has(id) ? award.open.delete(id) : award.open.add(id); renderColumns(); return; }
  if (action === 'more') { award.show[btn.dataset.leg] += 25; renderColumns(); return; }
  if (action === 'reset-rec') { const ids = award.r.recommended?.ids || []; award.sel = { Outbound: ids[0] || null, Return: ids[1] || null }; renderColumns(); renderAwardSummary(); return; }
  if (action === 'clear-filters') { ['fMaxPts', 'fMaxHours', 'fStops', 'fDepart', 'fSeat', 'fProgram', 'fProduct'].forEach(id => { $(id).value = ''; }); renderColumns(); return; }
  if (action === 'add-builder') { addSelectionToBuilder(); return; }
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
    const legs = [optById(award.sel.Outbound), award.r.query.back ? optById(award.sel.Return) : null].filter(Boolean);
    const track = mode === 'any' ? null : { mode, legs: legs.map(o => ({ leg: o.leg, date: o.flight?.depart?.date || o.date, flightNumbers: o.flight?.flightNumbers || [], program: o.program, programName: o.programName, mileageCost: o.mileageCost, seatScore: o.seatScore, product: o.flight?.product?.type || null })) };
    const title = track ? `${legs.map(o => o.flight?.flightNumbers.join('/') || o.date).join(' + ')}${mode === 'similar' ? ' or similar' : ''}` : `${q.destination} ${q.cabin} · ${q.travelers} pax`;
    try {
      const a = await api('/api/alerts', { method: 'POST', body: { ...q, track, maxPointsPerTraveler: max, title } });
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
    const last = a.lastResult ? `${a.lastResult.matches} match(es) · checked ${new Date(a.lastCheckedAt).toLocaleString()}` : 'Not checked yet';
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
    return `<div class="rowalert"><div><strong>${esc(a.title)}</strong>
      <div class="muted" style="font-size:11px">${desc}</div>
      <div class="muted" style="font-size:11px">${esc(last)}${a.lastResult?.best ? ` — ${esc(a.lastResult.best)}` : ''}</div></div>
      <div class="btnrow" style="margin:0"><button class="btn small" data-toggle="${esc(a.id)}" data-active="${a.active ? '1' : ''}">${a.active ? 'Pause' : 'Resume'}</button><button class="btn small" data-delete="${esc(a.id)}">Remove</button></div></div>`;
  }).join('');
}

$('alerts').addEventListener('click', async e => {
  const { toggle, delete: del, active } = e.target.dataset;
  try {
    if (del) { await api(`/api/alerts/${del}`, { method: 'DELETE', body: {} }); state.alerts = state.alerts.filter(a => a.id !== del); }
    if (toggle) { await api(`/api/alerts/${toggle}`, { method: 'PATCH', body: { active: !active } }); const a = state.alerts.find(x => x.id === toggle); if (a) a.active = !active; }
    renderAlerts(); renderKPIs();
  } catch (err) { toast(err.message); }
});

$('runMonitor').onclick = async () => {
  busy($('runMonitor'), true, 'Checking…');
  try {
    const r = await api('/api/monitor/run', { method: 'POST', body: {} });
    state.alerts = await api('/api/alerts'); renderAlerts();
    const fresh = r.results.filter(x => x.isNew).length;
    toast(`Checked ${r.alertsChecked} alert(s)${fresh ? ` — ${fresh} with new space!` : ''}`);
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
  if (open && desktop) { desktop.openProvider(open, url); toast('Search normally in the new window. Ctrl+Shift+S saves the page.'); }
});

$('saveManualAward').onclick = async () => {
  const direct = $('manualDirect').value;
  const payload = {
    program: $('manualProgram').value, origin: $('manualOrigin').value.trim().toUpperCase(), destination: $('manualDestination').value.trim().toUpperCase(),
    date: $('manualDate').value, cabin: $('manualCabin').value, mileageCost: Number($('manualPoints').value || 0),
    totalTaxes: $('manualTaxes').value === '' ? null : Number($('manualTaxes').value), cashValue: Number($('manualCash').value || 0) || null,
    remainingSeats: Number($('manualSeats').value || 0) || null, direct: direct === '' ? null : direct === 'true'
  };
  try { await api('/api/manual-award', { method: 'POST', body: payload }); $('manualMessage').textContent = 'Saved. It will appear in searches for 14 days and is part of price history.'; toast('Award saved'); }
  catch (e) { $('manualMessage').textContent = e.message; }
};
$('saveManualHotel').onclick = async () => {
  const payload = { program: $('manualHotelProgram').value, category: $('manualHotelCategory').value.trim() || null, name: $('manualHotelName').value.trim(), location: $('manualHotelLocation').value.trim(), checkIn: $('manualHotelDate').value, roomType: $('manualHotelRoomType').value, nightlyPoints: Number($('manualHotelPoints').value || 0), cashValue: Number($('manualHotelCash').value || 0) || null };
  try { await api('/api/manual-hotel', { method: 'POST', body: payload }); $('manualHotelMessage').textContent = 'Saved.'; toast('Hotel award saved'); }
  catch (e) { $('manualHotelMessage').textContent = e.message; }
};

// ---------- transfer partners ----------
const SOURCE_NAMES = { roame: 'Roame', upgradedpoints: 'Upgraded Points', tpg: 'The Points Guy' };
function renderPartners() {
  const d = state.partners; if (!d) return;
  const today = new Date().toISOString().slice(0, 10);
  const bankName = id => (typeof d.banks?.[id] === 'object' ? d.banks[id].name : d.banks?.[id]) || programLabel(id);
  const rows = [];
  for (const [target, p] of Object.entries(d.programs || {})) for (const [bank, e] of Object.entries(p.transfers || {})) {
    const bonusLive = e.bonusPct && (!e.bonusEnds || e.bonusEnds >= today);
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
  if (!$('dealAirports').value) $('dealAirports').value = s.homeAirports || $('origins').value;
  state.settings = s;
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
  $('dealTabs').querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.scope === dealScope); b.textContent = { all: `All (${all.length})`, international: `International (${intl})`, domestic: `Domestic (${all.length - intl})` }[b.dataset.scope]; });
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
  const need = p.needs[dir];
  if (!need) {
    // Say why there's no connecting flight instead of silently leaving the step out.
    const award = p.flights[dir];
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
      <span class="pos-price">${kind === 'award' ? `${fmt(o.mileageCost)} pts` : money(o.price)}</span>
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
  for (const [id, v] of [['tbHome', p.home.origin], ['tbReturnTo', p.home.returnTo], ['tbBufferOut', p.buffers.outboundHours], ['tbBufferBack', p.buffers.returnHours]]) if (document.activeElement !== $(id)) $(id).value = v ?? '';
  const out = p.flights.outbound, ret = p.flights.return;
  const awardItem = (o, dir) => o ? `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card">
      <h4>${dir === 'outbound' ? 'Outbound' : 'Return'} award · ${esc(o.programName)} ${seatChip(o.flight?.product)}</h4><p>${legDesc(o)}</p>
      <p>${fmt(o.mileageCost)} pts ${taxText(o)} per person × ${p.travelers} · ${esc(o.cabin)}${o.taxesMissing ? ' · <span class="flag">TAXES NOT REPORTED</span>' : ''}</p>
      <div class="btnrow" style="margin-top:4px">${bookLink(o)}<button class="btn small ghost" data-tb="remove-flight" data-dir="${dir}">Remove</button></div></div></div>`
    : `<div class="tl-item"><div class="tl-dot todo"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card"><h4>${dir === 'outbound' ? 'Outbound' : 'Return'} award flight</h4><p>Not chosen yet. Search in the Trip Optimizer, pick flights, then "Add to Trip Builder".</p><div class="btnrow" style="margin-top:4px"><button class="btn small" data-tb="goto" data-view="search">Open Trip Optimizer</button></div></div></div>`;
  const hotels = p.stays.length ? p.stays.map(s => `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-bed"/></svg></div><div class="card tl-card">
      <h4>${esc(s.name)} ${s.category ? `<span class="cat">${esc(s.programName.replace(/^World of /, ''))} Cat ${esc(s.category)}</span>` : ''}</h4>
      <p>${esc(s.city || s.location)} · ${dateFmt(s.checkIn)} → ${dateFmt(s.checkOut)} · ${s.nights} night(s) · ${fmt(s.totalPoints)} ${esc(s.programName)}</p></div></div>`).join('')
    : `<div class="tl-item"><div class="tl-dot todo"><svg class="icon"><use href="#i-bed"/></svg></div><div class="card tl-card"><h4>Hotels (optional)</h4><p>Build stays in the Trip Optimizer's Hotels tab with "Add to stay plan"; they appear here automatically.</p><div class="btnrow" style="margin-top:4px"><button class="btn small" data-tb="goto" data-view="search" data-product="hotels">Find hotels</button></div></div></div>`;
  $('tbTimeline').innerHTML = positioningSlot(p, 'outbound') + awardItem(out, 'outbound') + hotels + awardItem(ret, 'return') + positioningSlot(p, 'return');
  const s = p.summary;
  const path = s.funding ? s.funding.sources.map(x => `<span class="node">${x.direct ? `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} (have)` : `${fmt(x.fromPoints)} ${esc(programLabel(x.from))} → ${fmt(x.targetPoints)} ${esc(programLabel(x.targetProgram))}`}</span>`).join('') : '';
  $('tbSummary').innerHTML = `<div class="card plan" style="margin-top:0"><div class="eyebrow">Whole trip · ${p.travelers} traveler${p.travelers > 1 ? 's' : ''}</div>
    <h3 style="margin:4px 0 0">${fmt(s.totalPoints)} points + ${money(s.cashUsd)} cash</h3>
    <div class="note" style="margin-top:10px">${s.pointsByProgram.map(x => `${fmt(x.points)} ${esc(x.programName)}`).join('<br>') || 'Nothing added yet.'}</div>
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Cash = award taxes + positioning fares (all travelers). Hotel points are for one room.</p>
    ${s.affordable === false ? '<div class="warnbox">Your current balances and transfer partners can\'t cover the whole trip.</div>' : ''}
    ${path ? `<div class="path">${path}</div>` : ''}
    ${warningsBox(s.warnings)}</div>`;
}

$('view-builder').addEventListener('click', async e => {
  const b = e.target.closest('[data-tb]'); if (!b) return;
  const dir = b.dataset.dir;
  try {
    if (b.dataset.tb === 'goto') { showView(b.dataset.view); if (b.dataset.product) document.querySelector(`button[data-product="${b.dataset.product}"]`)?.click(); return; }
    if (b.dataset.tb === 'remove-flight') return renderBuilder(await api(`/api/trip-plan/flights/${dir}`, { method: 'DELETE', body: {} }));
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
$('clearTrip').onclick = async () => { tb.search = { outbound: null, return: null }; renderBuilder(await api('/api/trip-plan', { method: 'DELETE', body: {} })); };

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
  document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === `view-${name}`));
  if (name === 'history') loadHistory().catch(e => toast(e.message));
  if (name === 'builder') loadBuilder();
}
document.querySelectorAll('.nav').forEach(b => { b.onclick = () => showView(b.dataset.view); });
desktop?.onNavigate?.(showView);

document.querySelectorAll('button[data-product]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('button[data-product]').forEach(x => x.classList.toggle('active', x === b));
    const prev = state.product;
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
    $('cabin').innerHTML = hotels
      ? '<option value="any" selected>Any room</option><option value="standard">Standard</option><option value="suite">Suite</option>'
      : `<option ${cash ? '' : 'selected'} value="business">Business</option><option value="first">First</option><option value="premium">Premium Economy</option><option ${cash ? 'selected' : ''} value="economy">Economy</option>`;
    $('cabinLabel').textContent = hotels ? 'Room' : 'Cabin';
    $('rank').disabled = cash;
    $('rank').options[3].disabled = hotels;
    if (hotels && $('rank').value === 'nonstop') $('rank').value = 'overall';
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
  if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); runSearch(); }
});
renderRecents();
initDates();
load();
