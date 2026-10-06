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
  if (on) { button.dataset.label = button.textContent; button.textContent = label || 'Working…'; button.disabled = true; }
  else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
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
    await Promise.all([refreshHealth(), loadSettings()]);
  } catch (e) {
    $('statusPill').textContent = '● Backend error';
    toast(e.message);
  }
}

async function refreshHealth() {
  const h = await api('/api/health');
  const live = h.liveData === 'seats.aero';
  $('statusPill').textContent = live ? '● Live data: seats.aero' : '● Manual data only';
  $('modeLabel').textContent = live ? 'Live award data' : 'Manual data only';
  $('modeHint').textContent = live ? `Flights + hotels · ${h.apiCallsToday} flight / ${h.roomsCallsToday} hotel API calls today` : 'Add a seats.aero key in Data & System for live availability.';
  $('liveDot').style.background = live ? '#19835b' : '#e0a434';
  $('sysHistory').textContent = `${fmt(h.awardObservations)} observations`;
  $('sysTransfer').textContent = `Updated ${h.reference.lastUpdated} (${h.reference.origin})`;
  $('apiCalls').textContent = `${fmt(h.apiCallsToday)} flights · ${fmt(h.roomsCallsToday)} hotels`;
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

function renderWallet() {
  const rows = state.user.balances;
  $('walletTable').innerHTML = rows.map((b, i) => `<tr>
    <td><strong>${esc(b.program)}</strong><br><span class="muted">${esc(b.code)}</span></td>
    <td>${esc(b.type)}</td>
    <td><input class="inputnum" data-i="${i}" data-k="balance" type="number" min="0" value="${esc(b.balance)}"></td>
    <td><input class="inputnum" data-i="${i}" data-k="cpp" type="number" min="0" step="0.05" value="${esc(b.cpp)}"></td>
    <td><button class="btn small" data-remove="${i}">Remove</button></td></tr>`).join('');
  const have = new Set(rows.map(b => b.code));
  $('addProgram').innerHTML = state.programs.filter(p => !have.has(p.id)).map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.kind)})</option>`).join('');
  const prefs = { maxTransfers: 3, maxTransferDays: 3, defaultCpp: 1.5, preferNonstop: false, ...state.user.preferences };
  $('prefMaxTransfers').value = prefs.maxTransfers;
  $('prefMaxDays').value = prefs.maxTransferDays;
  $('prefDefaultCpp').value = prefs.defaultCpp;
  $('prefNonstop').value = String(Boolean(prefs.preferNonstop));
}

$('walletTable').addEventListener('input', e => {
  const t = e.target; if (!t.dataset.k) return;
  state.user.balances[Number(t.dataset.i)][t.dataset.k] = Number(t.value) || 0;
  renderKPIs();
});
$('walletTable').addEventListener('click', e => {
  const i = e.target.dataset.remove; if (i == null) return;
  state.user.balances.splice(Number(i), 1); renderWallet(); renderKPIs();
});
$('addProgramBtn').onclick = () => {
  const p = state.programs.find(x => x.id === $('addProgram').value); if (!p) return;
  state.user.balances.push({ program: p.name, code: p.id, type: p.kind, balance: 0, cpp: p.kind === 'hotel' ? 0.6 : 1.4, transferable: p.kind === 'bank' });
  renderWallet();
};
$('saveWallet').onclick = async () => {
  state.user.preferences = {
    ...state.user.preferences,
    maxTransfers: Math.max(1, Number($('prefMaxTransfers').value) || 3),
    maxTransferDays: Math.max(0, Number($('prefMaxDays').value) || 0),
    defaultCpp: Math.max(0, Number($('prefDefaultCpp').value) || 1.5),
    preferNonstop: $('prefNonstop').value === 'true'
  };
  try { state.user = await api('/api/user', { method: 'PUT', body: state.user }); renderWallet(); renderKPIs(); toast('Wallet saved'); }
  catch (e) { toast(e.message); }
};

// ---------- search ----------
function currentQuery() {
  return {
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
      renderHotels(r);
      const src = { fetched: 'live rooms.aero data', 'recent-cache': 'rooms.aero data from the last hour', 'not-configured': 'manually entered hotels only', error: 'the local cache (rooms.aero failed)' }[r.dataStatus.api] || 'local data';
      msg.textContent = `${r.rows.length} hotel award(s) in ${r.query.destination} for ${r.nights} night(s), using ${src}.`;
      return;
    }
    msg.textContent = 'Searching award space and optimizing against your points…';
    const q = currentQuery();
    state.lastQuery = q;
    const r = await api('/api/search/trip', { method: 'POST', body: q });
    renderFlightResults(r);
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
  const trips = r.trips || [];
  $('resultMeta').textContent = `${fmt(r.counts.outbound)} outbound · ${fmt(r.counts.return)} return awards · ${fmt(trips.length)} fundable option(s)`;
  const monitorBtn = '<button class="btn" data-action="monitor">🔔 Monitor this trip</button>';
  const manualBtn = '<button class="btn" data-action="manual">Add an award manually</button>';
  const apiWarn = warningsBox(r.dataStatus.warnings);
  if (!trips.length) {
    $('kpiScore').textContent = '—'; $('kpiHint').textContent = 'no fundable option';
    const why = {
      'no-inventory': 'No award space was found for these dates.',
      'no-valid-pairs': 'Outbound and return space exist, but no return is on or after an outbound date.',
      unaffordable: 'Award space exists, but your current balances and transfer partners can\'t cover it.'
    }[r.mode] || 'Nothing matched.';
    const tip = r.dataStatus.api === 'not-configured' ? '<div class="note">Tip: add a seats.aero API key under <em>Data &amp; System</em> to search live availability automatically.</div>' : '';
    $('results').innerHTML = `<div class="card empty"><strong>${esc(why)}</strong>${apiWarn}${rawAwardList('Cheapest outbound seen', r.cheapestOutbound)}${rawAwardList('Cheapest return seen', r.cheapestReturn)}${tip}<div class="btnrow">${monitorBtn}${manualBtn}</div></div>`;
    return;
  }
  const best = trips[0];
  $('kpiScore').textContent = money(best.effectiveCostUsd);
  $('kpiHint').textContent = `${fmt(best.totalSourcePoints)} pts + ${money(best.taxesUsd)}`;
  const path = best.sources.map(s => `<span class="node">${s.direct ? `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} (have)` : `${fmt(s.fromPoints)} ${esc(programLabel(s.from))} → ${fmt(s.targetPoints)} ${esc(programLabel(s.targetProgram))}${s.bonusPct ? ` (+${Math.round(s.bonusPct * 100)}%)` : ''}`}</span>`).join('');
  const legs = best.legs.map(l => `<div class="legbox"><h5>${esc(l.leg)} · ${esc(l.programName)} ${sourceTag(l)}</h5><p>${legLine(l)}</p>${l.history ? `<span class="history-badge">${esc(l.history.label)} · median ${fmt(l.history.median)}</span>` : ''}</div>`).join('');
  const rec = `<div class="card reco"><div class="cardhead"><div><div class="eyebrow">Recommended</div><h3>${fmt(best.totalSourcePoints)} points + ${money(best.taxesUsd)} for ${best.travelers} traveler${best.travelers > 1 ? 's' : ''}</h3></div></div>
    <div class="detailgrid">${legs}</div>
    <div class="metrics" style="margin-top:12px"><div class="metric"><span>Award points needed</span><b>${fmt(best.totalTargetPoints)}</b></div><div class="metric"><span>Taxes &amp; fees</span><b>${money(best.taxesUsd)}</b></div><div class="metric"><span>Effective cost</span><b>${money(best.effectiveCostUsd)}</b></div><div class="metric"><span>Value</span><b class="positive">${best.cpp ? `${best.cpp.toFixed(2)}¢/pt` : 'add cash fare'}</b></div></div>
    <div class="path">${path}</div><div class="note">${esc(best.explanation)}</div>${warningsBox([...best.warnings, ...r.dataStatus.warnings])}
    <div class="btnrow">${monitorBtn}</div></div>`;
  const others = trips.slice(1, 10).map(t => `<div class="card result"><div><h4>${t.legs.map(l => esc(l.programName)).join(' + ')}</h4><p>${t.legs.map(l => `${esc(l.leg)}: ${esc(l.origin)}→${esc(l.destination)} ${dateFmt(l.date)}${l.direct === true ? ' nonstop' : ''}`).join(' · ')}</p><p>${t.sources.filter(s => !s.direct).map(s => `${fmt(s.fromPoints)} ${esc(programLabel(s.from))}→${esc(programLabel(s.targetProgram))}`).join(', ') || 'Uses miles you already have'}</p></div><div class="right"><span class="pts">${fmt(t.totalSourcePoints)} pts + ${money(t.taxesUsd)}</span><span class="subv">${money(t.effectiveCostUsd)} effective${t.cpp ? ` · ${t.cpp.toFixed(2)}¢/pt` : ''}</span></div></div>`).join('');
  $('results').innerHTML = rec + `<div class="result-list">${others}</div>`;
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

function renderHotels(r) {
  const rows = r.rows || [];
  $('resultMeta').textContent = `${fmt(rows.length)} hotel award(s) · ${r.nights} night(s) · ${r.query.roomType === 'any' ? 'any room' : esc(r.query.roomType)}`;
  const best = rows.find(h => h.affordable);
  $('kpiScore').textContent = best ? `${fmt(best.totalPoints)} pts` : '—';
  $('kpiHint').textContent = best ? `${best.name}` : 'no affordable stay';
  const monitorBtn = '<input id="hotelAlertMax" class="inputnum" type="number" min="0" step="1000" placeholder="Max pts/night" title="Optional: only alert at or below this many points per night"><button class="btn" data-action="monitor-hotel">🔔 Monitor this stay</button>';
  const warn = warningsBox(r.dataStatus.warnings);
  if (!rows.length) {
    const tip = r.dataStatus.api === 'not-configured' ? '<div class="note">Tip: your seats.aero key also unlocks live hotel search (rooms.aero). Add it under <em>Data &amp; System</em>.</div>' : '';
    $('results').innerHTML = `<div class="card empty"><strong>No hotel award space found for these dates.</strong>${warn}${tip}<div class="btnrow">${monitorBtn}<button class="btn" data-action="manual">Add a hotel award</button></div></div>`;
    return;
  }
  const cards = rows.slice(0, 25).map(h => {
    const link = safeUrl(h.bookingUrl);
    return `<div class="card result"><div>
      <h4>${esc(h.name)} ${hotelTag(h)} ${h.affordable ? '' : '<span class="tag warn">NOT ENOUGH POINTS</span>'}${h.estimated ? ' <span class="tag warn">ESTIMATED</span>' : ''}</h4>
      <p>${esc(h.location)} · ${esc(h.programName)}${h.category ? ` · Cat ${esc(h.category)}` : ''} · ${esc(h.roomType)} · check-in ${dateFmt(h.checkIn)} · ${h.nights} night(s)</p>
      <p>${fundingText(h.funding) || 'Your balances and transfer partners can\'t cover this stay.'}</p>
      ${link ? `<p><a href="${esc(link)}" target="_blank" rel="noreferrer">View / book on ${esc(h.programName)} ↗</a></p>` : ''}
    </div><div class="right"><span class="pts">${fmt(h.totalPoints)} pts</span><span class="subv">${fmt(h.nightlyPoints)}/night${h.cashUsd ? ` · cash ${money(h.cashUsd)} · ${h.cpp.toFixed(2)}¢/pt` : ''}</span>${h.effectiveCostUsd != null ? `<span class="subv">${money(h.effectiveCostUsd)} in points value</span>` : ''}</div></div>`;
  }).join('');
  $('results').innerHTML = `${warn}<div class="result-list">${cards}</div><div class="btnrow">${monitorBtn}</div>`;
}

$('results').addEventListener('click', async e => {
  const action = e.target.dataset.action;
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
    const desc = a.kind === 'hotel'
      ? `🏨 ${esc(q.destination)} · ${esc(q.roomType)} room · ${dateFmt(q.checkIn)}${q.checkOut ? ` – ${dateFmt(q.checkOut)}` : ''} ± ${esc(q.flexDays)}d${q.maxPointsPerNight ? ` · ≤ ${fmt(q.maxPointsPerNight)} pts/night` : ''}`
      : `✈️ ${esc(q.origins)} → ${esc(q.destination)} · ${esc(q.cabin)} · ${esc(q.travelers)} pax · ${dateFmt(q.departDate)}${q.returnDate ? ` – ${dateFmt(q.returnDate)}` : ' (one-way)'} ± ${esc(q.flexDays)}d`;
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
  const payload = { program: $('manualHotelProgram').value, name: $('manualHotelName').value.trim(), location: $('manualHotelLocation').value.trim(), checkIn: $('manualHotelDate').value, roomType: $('manualHotelRoomType').value, nightlyPoints: Number($('manualHotelPoints').value || 0), cashValue: Number($('manualHotelCash').value || 0) || null };
  try { await api('/api/manual-hotel', { method: 'POST', body: payload }); $('manualHotelMessage').textContent = 'Saved.'; toast('Hotel award saved'); }
  catch (e) { $('manualHotelMessage').textContent = e.message; }
};

// ---------- transfer partners ----------
function renderPartners() {
  const d = state.partners; if (!d) return;
  const today = new Date().toISOString().slice(0, 10);
  const bankName = id => (typeof d.banks?.[id] === 'object' ? d.banks[id].name : d.banks?.[id]) || programLabel(id);
  const rows = [];
  for (const [target, p] of Object.entries(d.programs || {})) for (const [bank, e] of Object.entries(p.transfers || {})) {
    const bonusLive = e.bonusPct && (!e.bonusEnds || e.bonusEnds >= today);
    rows.push(`<tr><td>${esc(p.name)}</td><td>${esc(bankName(bank))}</td><td>${esc(e.ratio[0])}:${esc(e.ratio[1])}</td><td>${e.days ? `${esc(e.days)}d` : 'Instant'}</td><td>${bonusLive ? `${Math.round(e.bonusPct * 100)}% until ${esc(e.bonusEnds || '?')}` : '—'}</td><td>${e.unverified ? '<span class="tag warn">UNVERIFIED</span>' : '<span class="tag">OK</span>'}</td></tr>`);
  }
  $('partnerTable').innerHTML = rows.sort().join('');
  $('partnerMeta').textContent = `Data as of ${d.lastUpdated} (${d.status?.origin || 'bundled'}). ${d.note || ''}`;
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
}
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

// ---------- navigation ----------
function showView(name) {
  document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === `view-${name}`));
  if (name === 'history') loadHistory().catch(e => toast(e.message));
}
document.querySelectorAll('.nav').forEach(b => { b.onclick = () => showView(b.dataset.view); });
desktop?.onNavigate?.(showView);

document.querySelectorAll('button[data-product]').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('button[data-product]').forEach(x => x.classList.toggle('active', x === b));
    state.product = b.dataset.product;
    const hotels = state.product === 'hotels';
    $('origins').disabled = hotels; $('directOnly').disabled = hotels; $('travelers').disabled = hotels;
    $('cabin').innerHTML = hotels
      ? '<option value="any" selected>Any room</option><option value="standard">Standard</option><option value="suite">Suite</option>'
      : '<option selected value="business">Business</option><option value="first">First</option><option value="premium">Premium Economy</option><option value="economy">Economy</option>';
    $('cabinLabel').textContent = hotels ? 'Room' : 'Cabin';
    $('rank').options[3].disabled = hotels;
    if (hotels && $('rank').value === 'nonstop') $('rank').value = 'overall';
    $('dateFromLabel').textContent = hotels ? 'Check-in' : 'Departure date';
    $('dateToLabel').textContent = hotels ? 'Check-out' : 'Return date (optional)';
  };
});

$('searchBtn').onclick = runSearch;
initDates();
load();
