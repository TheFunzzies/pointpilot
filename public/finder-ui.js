'use strict';
/* global api, esc, fmt, money, toast, busy, state, showView, renderAlerts, renderKPIs, safeUrl */
// Find a Trip: one form in, one recommendation out. Loaded after app.js and uses its helpers
// (api, esc, fmt, money, dateFmt, toast, busy, state, showView, renderAlerts, renderKPIs, safeUrl).
(function () {
  const el = id => document.getElementById(id);
  const guard = window.PPHelpers.createGuard();
  let last = null;      // last result
  let lastBody = null;  // request that produced it

  const TITLES = { points: 'All points', mixed: 'Points + cash', cash: 'Cash' };
  const iso = d => d.toISOString().slice(0, 10);

  function fillMonths() {
    const now = new Date();
    const opts = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      opts.push(`<option value="${iso(d).slice(0, 7)}"${i === 2 ? ' selected' : ''}>${d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}</option>`);
    }
    el('fdWhen').innerHTML = `${opts.join('')}<option value="custom">Specific dates…</option>`;
  }

  function windowFromForm() {
    const when = el('fdWhen').value;
    if (when === 'custom') return { earliest: el('fdEarliest').value, latest: el('fdLatest').value };
    const [y, m] = when.split('-').map(Number);
    return { earliest: `${when}-01`, latest: iso(new Date(Date.UTC(y, m, 0))) };
  }

  function requestBody() {
    const [nights, nightsFlex] = el('fdLength').value.split(':').map(Number);
    return {
      origins: el('fdOrigins').value.trim(), destination: el('fdDestination').value.trim(), ...windowFromForm(),
      tripType: nights ? 'round-trip' : 'one-way', ...(nights ? { nights, nightsFlex } : {}),
      cabin: el('fdCabin').value, travelers: Number(el('fdTravelers').value), nonstopOnly: el('fdNonstop').checked
    };
  }

  const dayFmt = x => (x ? new Date(`${x}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
  const link = (url, text) => (safeUrl(url) ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(text)} ↗</a>` : '');

  function legRow(l, travelers) {
    const route = `${esc(l.origin)} → ${esc(l.destination)}`;
    const stops = l.direct === true ? ' · nonstop' : l.direct === false ? ' · connecting' : '';
    if (l.pay === 'points') {
      const fees = l.taxesPerTraveler == null ? 'fees unknown' : `${l.taxesEstimated ? '≈' : ''}${money(l.taxesPerTraveler)} fees`;
      return `<div class="fd-leg"><span class="tag brand">POINTS</span><div><b>${esc(l.dir)} · ${route}</b> · ${esc(dayFmt(l.date))}${stops}<div class="muted">${esc(l.programName)} · ${fmt(l.pointsPerTraveler)} pts + ${fees}${travelers > 1 ? ' per person' : ''}${l.airlines ? ` · ${esc(l.airlines)}` : ''}${l.seats != null ? ` · ${esc(l.seats)} seat${l.seats === 1 ? '' : 's'} left` : ''}</div></div></div>`;
    }
    return `<div class="fd-leg"><span class="tag muted">CASH</span><div><b>${esc(l.dir)} · ${route}</b> · ${esc(dayFmt(l.date))}${l.returnDate ? ` – ${esc(dayFmt(l.returnDate))}` : ''}${stops}<div class="muted">${money(l.pricePerTraveler)}${travelers > 1 ? ' per person' : ''}${l.airlines ? ` · ${esc(l.airlines)}` : ''} · ${l.live ? 'live Google Flights price' : 'recently seen fare'}</div></div></div>`;
  }

  function optionCard(o, i, q) {
    const big = o.type === 'cash' ? money(o.cashUsd) : `${fmt(o.points)} pts <small>+ ${money(o.outOfPocketUsd)}</small>`;
    const plan = o.plan.length ? `<div class="fd-plan"><b>How to pay</b><ol>${o.plan.map(s => `<li>${s.direct ? `Use ${fmt(s.fromPoints)} ${esc(s.toName)} miles you already hold` : `Transfer ${fmt(s.fromPoints)} ${esc(s.fromName)} → ${fmt(s.toPoints)} ${esc(s.toName)}${s.bonusPct ? ` <span class="tag">+${esc(s.bonusPct)}% BONUS</span>` : ''}${s.days ? ` <span class="muted">(~${esc(s.days)} day${s.days === 1 ? '' : 's'})</span>` : ' <span class="muted">(usually instant)</span>'}`}</li>`).join('')}</ol></div>` : '';
    const seen = new Set();
    const links = o.legs.map(l => { if (!l.bookUrl || seen.has(l.bookUrl)) return ''; seen.add(l.bookUrl); return link(l.bookUrl, l.pay === 'points' ? `Book with ${l.programName}` : 'See on Google Flights'); }).join('');
    const sub = o.type === 'cash' ? (q.travelers > 1 ? `for ${q.travelers} travelers (estimate)` : 'total') : `worth about ${money(o.effectiveCostUsd)} all-in at your point values${o.cpp != null ? ` · ${o.cpp.toFixed(1)}¢/pt` : ''}`;
    return `<article class="card fd-opt${i === 0 ? ' best' : ''}"><div class="fd-opt-head"><h3>${esc(TITLES[o.type])}</h3>${i === 0 ? '<span class="tag">BEST VALUE</span>' : ''}</div>
      <div class="fd-big">${big}</div><div class="muted fd-sub">${esc(sub)}</div>
      ${o.legs.map(l => legRow(l, q.travelers)).join('')}${plan}
      ${o.warnings.length ? `<div class="fd-warn">${o.warnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
      <div class="btnrow">${links}</div></article>`;
  }

  function watchExists(q) {
    return state.alerts.find(a => a.kind === 'plan' && a.query?.destination === q.destinationText && a.query?.earliest === q.earliest && a.query?.latest === q.latest && a.query?.cabin === q.cabin);
  }

  function watchBlock(r) {
    const existing = watchExists(r.query);
    if (existing) return `<div class="fd-watch on"><b>🔔 Watching this trip.</b> PointPilot checks once a day and notifies you when a points option${existing.targetCashUsd ? ` or a fare under ${money(existing.targetCashUsd)} per person` : ''} appears. <button class="btn small ghost" data-fd="alerts">Manage alerts</button></div>`;
    return `<div class="fd-watch"><div><b>${r.watch.suggested ? 'No great option yet.' : 'Want something better?'}</b> PointPilot can check every day and notify you when a points option or a cheaper fare appears.</div>
      <div class="fd-watch-form"><label for="fdTarget">Alert me for cash under</label><input id="fdTarget" type="number" min="1" step="25" value="${esc(r.watch.targetCashUsd ?? '')}" placeholder="any"> <span class="muted">per person</span><button class="btn primary small" data-fd="watch">🔔 Watch this trip</button></div></div>`;
  }

  function render(r) {
    const q = r.query;
    const where = `${esc(q.originsText)} → ${esc(q.destinationLabel)}`;
    const tips = r.advice.tips.map(t => `<li><b>${esc(t.title)}.</b> ${esc(t.text)}${t.payWith ? ` <span class="muted">${esc(t.payWith)}.</span>` : ''}</li>`).join('');
    const insights = r.insights.map(i => `<li>${esc(i.text)}</li>`).join('');
    const alts = r.alternatives.length ? `<div class="card fd-know"><h3>Other dates on points</h3><ul class="fd-alts">${r.alternatives.map(a => `<li><b>${esc(dayFmt(a.depart))}${a.return ? ` – ${esc(dayFmt(a.return))}` : ''}</b> · ${fmt(a.points)} pts + ${money(a.outOfPocketUsd)} · ${esc([...new Set(a.legs.map(l => l.programName))].join(' + '))}</li>`).join('')}</ul></div>` : '';
    const notes = [
      ...(r.walletEmpty ? ['Add your point balances under <em>My Points</em> so PointPilot can work out what you can afford.'] : []),
      ...(r.dataStatus.api === 'not-configured' ? ['Add a seats.aero key under <em>Settings</em> to search live award space.'] : []),
      ...r.dataStatus.warnings.map(esc)
    ];
    el('fdResults').innerHTML = `
      <div class="card fd-verdict"><div class="muted">${where} · ${esc(dayFmt(q.earliest))} – ${esc(dayFmt(q.latest))} · ${q.tripType === 'one-way' ? 'one way' : `about ${esc(q.nights)} nights`} · ${esc(q.cabin)} · ${esc(q.travelers)} traveler${q.travelers > 1 ? 's' : ''}</div>
        <h2>${esc(r.summary.headline)}</h2><p>${esc(r.summary.detail)}</p>${watchBlock(r)}</div>
      ${notes.length ? `<div class="note">${notes.join('<br>')}</div>` : ''}
      <div class="fd-options n${r.options.length}">${r.options.map((o, i) => optionCard(o, i, q)).join('')}</div>
      ${alts}
      ${insights || tips ? `<div class="card fd-know"><h3>What to know for this trip</h3>${insights ? `<ul>${insights}</ul>` : ''}${tips ? `<ul>${tips}</ul>` : ''}<p class="muted">Strategy distilled from guidance published by ${esc(r.advice.sources.join(', '))}. Confirm details with the program before moving points.</p></div>` : ''}
      <p class="muted fd-meta">Checked ${fmt(r.counts.outbound + r.counts.return)} award options and ${fmt(r.counts.cashFares)} cached fares in ${(r.tookMs / 1000).toFixed(1)}s${r.dataStatus.googleCalls ? ` · ${r.dataStatus.googleCalls} live Google Flights check${r.dataStatus.googleCalls > 1 ? 's' : ''}` : ''}. <button class="btn small ghost" data-fd="advanced">Pick exact flights in Advanced Search</button></p>`;
  }

  async function createWatch(r, target, quiet) {
    if (watchExists(r.query)) return;
    const q = r.query;
    const alert = await api('/api/alerts', { method: 'POST', body: { kind: 'plan', origins: q.originsText, destination: q.destinationText, earliest: q.earliest, latest: q.latest, tripType: q.tripType, nights: q.nights || undefined, nightsFlex: q.nights ? q.nightsFlex : undefined, cabin: q.cabin, travelers: q.travelers, nonstopOnly: q.nonstopOnly, targetCashUsd: target || undefined,
      title: `${q.destinationLabel} · ${new Date(`${q.earliest}T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })} · ${q.cabin}` } });
    state.alerts.unshift(alert);
    renderAlerts(); renderKPIs();
    toast(quiet ? 'Nothing great yet — PointPilot will check daily and notify you.' : 'Watching this trip. You will be notified when a good option appears.');
  }

  async function run() {
    const body = requestBody();
    if (!body.destination) { el('fdMessage').textContent = 'Enter where you want to go.'; el('fdDestination').focus(); return; }
    const token = guard.next();
    busy(el('fdSearch'), true, 'Searching…');
    el('fdMessage').textContent = 'Checking award space, transfer options and cash fares…';
    try {
      const r = await api('/api/finder/search', { method: 'POST', body, signal: token.signal });
      if (!guard.isCurrent(token)) return;
      last = r; lastBody = body;
      try { localStorage.setItem('pp.finder', JSON.stringify(body)); } catch { /* storage unavailable */ }
      if (r.watch.suggested && el('fdAutoWatch').checked) await createWatch(r, r.watch.targetCashUsd, true).catch(e => toast(e.message));
      render(r);
      el('fdMessage').textContent = '';
    } catch (e) {
      if (e?.name === 'AbortError' || !guard.isCurrent(token)) return;
      el('fdMessage').textContent = e.message;
    } finally { if (guard.isCurrent(token)) busy(el('fdSearch'), false); }
  }

  el('fdResults').addEventListener('click', async e => {
    const action = e.target.closest('[data-fd]')?.dataset.fd;
    if (!action || !last) return;
    if (action === 'alerts') return showView('alerts');
    if (action === 'advanced') {
      el('destination').value = lastBody.destination; el('origins').value = last.query.originsText; el('cabin').value = last.query.cabin; el('travelers').value = String(last.query.travelers);
      el('dateFrom').value = last.best?.depart || last.query.earliest; el('dateTo').value = last.best?.return || '';
      return showView('search');
    }
    if (action === 'watch') {
      try { await createWatch(last, Number(el('fdTarget').value) || null, false); render(last); } catch (err) { toast(err.message); }
    }
  });
  el('fdSearch').onclick = run;
  el('view-finder').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('#fdOrigins, #fdDestination') && !document.querySelector('#placeSuggestList:not([hidden])')) run(); });
  el('fdWhen').onchange = () => { el('fdCustom').hidden = el('fdWhen').value !== 'custom'; };

  // ---------- boot ----------
  fillMonths();
  const start = new Date(); start.setDate(start.getDate() + 60);
  const end = new Date(start); end.setDate(end.getDate() + 30);
  el('fdEarliest').value = iso(start); el('fdLatest').value = iso(end);
  try {
    const saved = JSON.parse(localStorage.getItem('pp.finder') || 'null');
    if (saved) { el('fdOrigins').value = saved.origins || ''; el('fdCabin').value = saved.cabin || 'economy'; el('fdTravelers').value = String(saved.travelers || 1); }
  } catch { /* ignore */ }
  api('/api/settings').then(s => { if (!el('fdOrigins').value && s.homeAirports) el('fdOrigins').value = s.homeAirports; }).catch(() => {});
})();
