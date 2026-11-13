'use strict';
/* global api, esc, fmt, money, toast, busy, state, showView, renderAlerts, renderKPIs, safeUrl */
// Find a Trip: one form in, one recommendation out, for flights, hotels and "where can I go?".
// Loaded after app.js and uses its helpers.
(function () {
  const el = id => document.getElementById(id);
  const guard = window.PPHelpers.createGuard();
  let mode = 'flights';
  let last = null;      // last flight result
  let lastBody = null;  // request that produced it
  let lastHotels = null;

  const TITLES = { points: 'All points', positioned: 'Points from a bigger airport', mixed: 'Points + cash', buy: 'Buy miles + award', cash: 'Cash' };
  const MODES = {
    flights: { title: 'Where do you want to go?', intro: 'Tell PointPilot the place and a rough time. It checks award space, your transfer options and cash fares, then tells you the best way to pay.', button: 'Find the best way to go', dest: 'To', placeholder: 'Tokyo, Italy, LIS…' },
    hotels: { title: 'Where are you staying?', intro: 'PointPilot compares award rooms you can fund, points for some nights plus cash, and the cheapest well-rated cash rates.', button: 'Find the best stay', dest: 'City', placeholder: 'Tokyo, Paris, Maui…' },
    stopover: { title: 'Two places for the price of one', intro: 'Add a few nights in a second city on the way out. PointPilot builds the three flights from awards you can fund and shows what the extra city costs.', button: 'Build stopover trips', dest: 'To (main destination)', placeholder: 'Rome, Tokyo, Cape Town…' },
    explore: { title: 'Where can your points take you?', intro: 'Pick a time and PointPilot finds the destinations your points cover best, cheapest first.', button: 'Show me where I can go', dest: 'To', placeholder: '' }
  };
  const iso = d => d.toISOString().slice(0, 10);
  const dayFmt = x => (x ? new Date(`${x}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
  const shortDay = x => new Date(`${x}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const link = (url, text, cls = '') => (safeUrl(url) ? `<a class="btn small ${cls}" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(text)} ↗</a>` : '');

  function setMode(next) {
    mode = next;
    document.querySelectorAll('[data-fdmode]').forEach(b => { b.classList.toggle('active', b.dataset.fdmode === mode); b.setAttribute('aria-pressed', String(b.dataset.fdmode === mode)); });
    document.querySelectorAll('[data-fdfor]').forEach(x => { x.hidden = !x.dataset.fdfor.split(' ').includes(mode); });
    el('fdCustom').hidden = mode === 'hotels' || el('fdWhen').value !== 'custom';
    const m = MODES[mode];
    el('fdTitle').textContent = m.title; el('fdIntro').textContent = m.intro; el('fdSearchLabel').textContent = m.button;
    el('fdDestinationLabel').textContent = m.dest; el('fdDestination').placeholder = m.placeholder;
    el('fdOneWayOption').disabled = mode === 'stopover';
    if (mode === 'stopover' && el('fdLength').value === '0:0') el('fdLength').value = '7:2';
    el('fdMessage').textContent = '';
  }

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

  function tripBody() {
    const [nights, nightsFlex] = el('fdLength').value.split(':').map(Number);
    return { origins: el('fdOrigins').value.trim(), ...windowFromForm(), tripType: nights ? 'round-trip' : 'one-way', ...(nights ? { nights, nightsFlex } : {}),
      cabin: el('fdCabin').value, travelers: Number(el('fdTravelers').value), nonstopOnly: el('fdNonstop').checked };
  }

  // ---------- flights ----------
  function legRow(l, travelers) {
    const route = `${esc(l.origin)} → ${esc(l.destination)}`;
    const stops = l.direct === true ? ' · nonstop' : l.direct === false ? ' · connecting' : '';
    if (l.pay === 'points') {
      const fees = l.taxesPerTraveler == null ? 'fees unknown' : `${l.taxesEstimated ? '≈' : ''}${money(l.taxesPerTraveler)} fees`;
      return `<div class="fd-leg"><span class="tag brand">POINTS</span><div><b>${esc(l.dir)} · ${route}</b> · ${esc(dayFmt(l.date))}${stops}<div class="muted">${esc(l.programName)} · ${fmt(l.pointsPerTraveler)} pts + ${fees}${travelers > 1 ? ' per person' : ''}${l.airlines ? ` · ${esc(l.airlines)}` : ''}${l.seats != null ? ` · ${esc(l.seats)} seat${l.seats === 1 ? '' : 's'} left` : ''}</div></div></div>`;
    }
    return `<div class="fd-leg"><span class="tag muted">CASH</span><div><b>${esc(l.dir)} · ${route}</b> · ${esc(dayFmt(l.date))}${l.returnDate ? ` – ${esc(dayFmt(l.returnDate))}` : ''}${stops}<div class="muted">${money(l.pricePerTraveler)}${travelers > 1 ? ' per person' : ''}${l.airlines ? ` · ${esc(l.airlines)}` : ''} · ${l.live ? 'live Google Flights price' : l.assumed ? 'assumed, no recent fare found' : l.estimate ? 'cheapest recently seen that month' : 'recently seen fare'}</div></div></div>`;
  }

  function planHtml(plan) {
    if (!plan.length) return '';
    const step = s => (s.buy ? `Buy ${fmt(s.toPoints)} ${esc(s.toName)} miles at ${esc(s.priceCents)}¢ each (${money(s.costUsd)})`
      : s.direct ? `Use ${fmt(s.fromPoints)} ${esc(s.toName)} points you already hold`
        : `Transfer ${fmt(s.fromPoints)} ${esc(s.fromName)} → ${fmt(s.toPoints)} ${esc(s.toName)}${s.bonusPct ? ` <span class="tag">+${esc(s.bonusPct)}% BONUS</span>` : ''}${s.days ? ` <span class="muted">(~${esc(s.days)} day${s.days === 1 ? '' : 's'})</span>` : s.days === 0 ? ' <span class="muted">(usually instant)</span>' : ''}`);
    return `<div class="fd-plan"><b>How to pay</b><ol>${plan.map(s => `<li>${step(s)}</li>`).join('')}</ol></div>`;
  }

  function optionCard(o, i, q) {
    const big = o.type === 'cash' || o.type === 'buy' ? money(o.cashUsd) : `${fmt(o.points)} pts <small>+ ${money(o.outOfPocketUsd)}</small>`;
    const seen = new Set();
    const links = o.legs.map(l => { if (!l.bookUrl || seen.has(l.bookUrl)) return ''; seen.add(l.bookUrl); return link(l.bookUrl, l.pay === 'points' ? `Book with ${l.programName}` : 'See on Google Flights'); }).join('');
    const sub = o.type === 'cash' ? (q.travelers > 1 ? `for ${q.travelers} travelers (estimate)` : 'total') : o.type === 'buy' ? `buying ${fmt(o.pointsBought)} miles, fees included` : `worth about ${money(o.effectiveCostUsd)} all-in at your point values${o.cpp != null ? ` · ${o.cpp.toFixed(1)}¢/pt` : ''}`;
    return `<article class="card fd-opt${i === 0 ? ' best' : ''}"><div class="fd-opt-head"><h3>${esc(o.variant === 'lowfee' ? 'All points, lowest fees' : TITLES[o.type])}</h3>${i === 0 ? '<span class="tag">BEST VALUE</span>' : ''}</div>
      <div class="fd-big">${big}</div><div class="muted fd-sub">${esc(sub)}</div>
      ${o.legs.map(l => legRow(l, q.travelers)).join('')}${planHtml(o.plan)}
      ${o.warnings.length ? `<div class="fd-warn">${o.warnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
      <div class="btnrow">${links}${o.legs.some(l => l.pay === 'points') && o.type !== 'buy' ? `<button class="btn small ghost" data-fd="booked" data-opt="${i}" title="After you book, PointPilot checks daily and tells you if the points price drops">I booked this — watch for a lower price</button>` : ''}</div></article>`;
  }

  const watchExists = q => state.alerts.find(a => a.kind === 'plan' && a.query?.destination === q.destinationText && a.query?.earliest === q.earliest && a.query?.latest === q.latest && a.query?.cabin === q.cabin);

  function watchBlock(r) {
    const existing = watchExists(r.query);
    const explore = '<button class="btn small" data-fd="explore">Explore other destinations for these dates</button>';
    if (existing) return `<div class="fd-watch on"><div><b>🔔 Watching this trip.</b> PointPilot checks once a day and notifies you when a points option${existing.targetCashUsd ? ` or a fare under ${money(existing.targetCashUsd)} per person` : ''} appears.</div><div class="fd-watch-form"><button class="btn small ghost" data-fd="alerts">Manage alerts</button>${explore}</div></div>`;
    return `<div class="fd-watch"><div><b>${r.watch.suggested ? 'No great option yet.' : 'Want something better?'}</b> PointPilot can check every day and notify you when a points option or a cheaper fare appears.</div>
      <div class="fd-watch-form"><label for="fdTarget">Alert me for cash under</label><input id="fdTarget" type="number" min="1" step="25" value="${esc(r.watch.targetCashUsd ?? '')}" placeholder="any"> <span class="muted">per person</span><button class="btn primary small" data-fd="watch">🔔 Watch this trip</button>${explore}</div></div>`;
  }

  function strip(title, days) {
    if (days.length < 2) return '';
    const low = Math.min(...days.map(d => d.points));
    return `<div><div class="muted" style="font-size:12px;font-weight:600">${esc(title)}</div><div class="fd-strip">${days.map(d => `<div class="fd-day${d.points === low ? ' low' : ''}" title="${esc(d.program)} · ${money(d.feesUsd)} fees">${esc(shortDay(d.date))}<b>${d.points >= 1000 ? `${Math.round(d.points / 100) / 10}k` : fmt(d.points)}</b></div>`).join('')}</div></div>`;
  }

  function renderFlights(r) {
    const q = r.query;
    const tips = r.advice.tips.map(t => `<li><b>${esc(t.title)}.</b> ${esc(t.text)}${t.payWith ? ` <span class="muted">${esc(t.payWith)}.</span>` : ''}</li>`).join('');
    const insights = r.insights.map(i => `<li>${esc(i.text)}</li>`).join('');
    const cal = strip(q.tripType === 'one-way' ? 'Cheapest points by departure day' : 'Cheapest points outbound, by day', r.calendar.outbound) + strip('Cheapest points return, by day', r.calendar.return);
    const alts = r.alternatives.length ? `<div class="card fd-know"><h3>Other dates on points</h3><ul class="fd-alts">${r.alternatives.map(a => `<li><b>${esc(dayFmt(a.depart))}${a.return ? ` – ${esc(dayFmt(a.return))}` : ''}</b> · ${fmt(a.points)} pts + ${money(a.outOfPocketUsd)} · ${esc([...new Set(a.legs.map(l => l.programName))].join(' + '))}</li>`).join('')}</ul></div>` : '';
    const notes = [
      ...(r.walletEmpty ? ['Add your point balances under <em>My Points</em> so PointPilot can work out what you can afford.'] : []),
      ...(r.dataStatus.api === 'not-configured' ? ['Add a seats.aero key under <em>Settings</em> to search live award space.'] : []),
      ...r.dataStatus.warnings.map(esc)
    ];
    el('fdResults').innerHTML = `
      <div class="card fd-verdict"><div class="muted">${esc(q.originsText)} → ${esc(q.destinationLabel)} · ${esc(dayFmt(q.earliest))} – ${esc(dayFmt(q.latest))} · ${q.tripType === 'one-way' ? 'one way' : `about ${esc(q.nights)} nights`} · ${esc(q.cabin)} · ${esc(q.travelers)} traveler${q.travelers > 1 ? 's' : ''}</div>
        <h2>${esc(r.summary.headline)}</h2><p>${esc(r.summary.detail)}</p>${watchBlock(r)}</div>
      ${notes.length ? `<div class="note">${notes.join('<br>')}</div>` : ''}
      <div class="fd-options">${r.options.map((o, i) => optionCard(o, i, q)).join('')}</div>
      ${cal ? `<div class="card fd-know"><h3>Points prices across your dates</h3>${cal}<p class="muted">Total points for all travelers from your wallet, one way. Green is the cheapest day.</p></div>` : ''}
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

  async function runFlights(token) {
    const body = { ...tripBody(), destination: el('fdDestination').value.trim() };
    if (!body.destination) { el('fdMessage').textContent = 'Enter where you want to go.'; el('fdDestination').focus(); return; }
    el('fdMessage').textContent = 'Checking award space, transfer options and cash fares…';
    const r = await api('/api/finder/search', { method: 'POST', body, signal: token.signal });
    if (!guard.isCurrent(token)) return;
    last = r; lastBody = body;
    try { localStorage.setItem('pp.finder', JSON.stringify(body)); } catch { /* storage unavailable */ }
    if (r.watch.suggested && el('fdAutoWatch').checked) await createWatch(r, r.watch.targetCashUsd, true).catch(e => toast(e.message));
    renderFlights(r);
  }

  // ---------- explore ----------
  function renderExplore(r) {
    const q = r.query;
    const head = `<div class="card fd-verdict"><div class="muted">From ${esc(q.originsText)} · ${esc(dayFmt(q.earliest))} – ${esc(dayFmt(q.latest))} · ${q.tripType === 'one-way' ? 'one way' : `about ${esc(q.nights)} nights`} · ${esc(q.cabin)} · ${esc(q.travelers)} traveler${q.travelers > 1 ? 's' : ''}</div>
      <h2>${r.results.length ? `Your points reach ${r.results.length} of ${r.searched} destinations checked.` : 'No destination is bookable with your points in this window.'}</h2>
      <p>${r.results.length ? 'Cheapest first, counting your points at your own values plus fees. Pick one to see every way to pay.' : 'Try another month, a different region or cabin, or add balances under My Points.'}</p></div>`;
    const notes = [...(r.dataStatus.api === 'not-configured' ? ['Add a seats.aero key under <em>Settings</em> to search live award space.'] : []), ...r.dataStatus.warnings.map(esc)];
    el('fdResults').innerHTML = `${head}${notes.length ? `<div class="note">${notes.join('<br>')}</div>` : ''}
      <div class="fd-grid">${r.results.map((x, i) => `<button class="card fd-dest" data-dest="${esc(x.destination)}" data-i="${i}"><span class="muted">${esc(x.regionLabel)}</span><b>${esc(x.label)}</b>
        <span class="fd-big">${fmt(x.points)} pts <small>+ ${money(x.feesUsd)}</small></span>
        <span class="muted">${esc(shortDay(x.depart))}${x.return ? ` – ${esc(shortDay(x.return))}` : ''} · ${esc(x.programs.join(' + '))}${x.nonstop ? ' · nonstop' : ''}</span>
        ${x.cpp != null ? `<span><span class="tag${x.cpp >= 1.5 ? '' : ' muted'}">${x.cpp.toFixed(1)}¢/pt</span> <span class="muted">vs ${money(x.cashUsd)} cash</span></span>` : ''}</button>`).join('')}</div>
      <p class="muted fd-meta">Checked ${fmt(r.searched)} destinations in ${(r.tookMs / 1000).toFixed(1)}s${r.unfunded ? ` · ${r.unfunded} more have award seats your points cannot cover` : ''}.</p>`;
  }

  async function runExplore(token) {
    el('fdMessage').textContent = 'Checking award space across destinations… this can take 20 seconds.';
    const r = await api('/api/finder/explore', { method: 'POST', body: { ...tripBody(), region: el('fdRegion').value }, signal: token.signal });
    if (guard.isCurrent(token)) renderExplore(r);
  }

  // ---------- stopover ----------
  function renderStopover(r) {
    const q = r.query;
    const d = r.direct;
    const diff = x => (x.extraPoints == null ? '' : x.extraPoints <= 0 ? `<span class="tag">NO EXTRA POINTS</span>` : `<span class="tag muted">+${fmt(x.extraPoints)} pts vs. direct</span>`);
    const head = `<div class="card fd-verdict"><div class="muted">${esc(q.originsText)} → stopover → ${esc(q.destinationLabel)} · ${esc(dayFmt(q.earliest))} – ${esc(dayFmt(q.latest))} · ${esc(q.cabin)} · ${esc(q.travelers)} traveler${q.travelers > 1 ? 's' : ''}</div>
      <h2>${r.results.length ? `${r.results.length} stopover trip${r.results.length > 1 ? 's' : ''} your points can cover.` : 'No stopover trip is bookable with your points in this window.'}</h2>
      <p>${d ? `Going straight there and back costs ${fmt(d.points)} points + ${money(d.feesUsd)}. ` : 'No direct round trip on points was found to compare against. '}${r.results.length ? 'Each card adds a second city on the way out.' : 'Try another month, a named stopover city, or a different cabin.'}</p></div>`;
    const notes = [...(r.walletEmpty ? ['Add your point balances under <em>My Points</em> first.'] : []), ...(r.dataStatus.api === 'not-configured' ? ['Add a seats.aero key under <em>Settings</em> to search live award space.'] : []), ...r.dataStatus.warnings.map(esc)];
    el('fdResults').innerHTML = `${head}${notes.length ? `<div class="note">${notes.join('<br>')}</div>` : ''}
      <div class="fd-options">${r.results.map((x, i) => `<article class="card fd-opt${i === 0 ? ' best' : ''}"><div class="fd-opt-head"><h3>${esc(x.stopNights)} nights in ${esc(x.city)}, then ${esc(x.stayNights)} in ${esc(q.destinationLabel.split(',')[0])}</h3>${diff(x)}</div>
        <div class="fd-big">${fmt(x.points)} pts <small>+ ${money(x.feesUsd)}</small></div><div class="muted fd-sub">worth about ${money(x.effectiveCostUsd)} all-in at your point values${x.extraCostUsd != null ? ` · ${x.extraCostUsd <= 0 ? `${money(-x.extraCostUsd)} less` : `${money(x.extraCostUsd)} more`} than direct` : ''}</div>
        ${x.legs.map(l => legRow(l, q.travelers)).join('')}${planHtml(x.plan)}
        ${x.singleAward ? `<div class="note">${esc(x.singleAward)}</div>` : ''}
        ${x.warnings.length ? `<div class="fd-warn">${x.warnings.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
        <div class="btnrow">${[...new Map(x.legs.filter(l => l.bookUrl).map(l => [l.bookUrl, l])).values()].map(l => link(l.bookUrl, `Book with ${l.programName}`)).join('')}</div></article>`).join('')}</div>
      <p class="muted fd-meta">Checked ${fmt(r.searched)} stopover cit${r.searched === 1 ? 'y' : 'ies'} in ${(r.tookMs / 1000).toFixed(1)}s${r.unfunded ? ` · ${r.unfunded} more have seats your points cannot cover` : ''}. Each flight is a separate award: book the hardest-to-find seat first.</p>`;
  }

  async function runStopover(token) {
    const body = { ...tripBody(), destination: el('fdDestination').value.trim(), stopover: el('fdStopCity').value.trim() || undefined, stopNights: Number(el('fdStopNights').value) };
    delete body.tripType;
    if (!body.destination) { el('fdMessage').textContent = 'Enter your main destination.'; el('fdDestination').focus(); return; }
    el('fdMessage').textContent = 'Building stopover trips…';
    const r = await api('/api/finder/stopover', { method: 'POST', body, signal: token.signal });
    if (guard.isCurrent(token)) renderStopover(r);
  }

  // ---------- hotels ----------
  function hotelRow(h) {
    const stars = [h.stars ? `${h.stars}★` : '', h.rating ? `${h.rating.toFixed(1)} rating` : '', h.michelinKeys ? `${h.michelinKeys} MICHELIN Key${h.michelinKeys > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
    const tag = { points: '<span class="tag">USE POINTS</span>', mix: '<span class="tag brand">POINTS + CASH</span>', cash: '<span class="tag muted">PAY CASH</span>', short: '<span class="tag warn">NOT ENOUGH POINTS</span>' }[h.verdict];
    const why = h.verdict === 'points' ? (h.savingsUsd != null ? `Saves about ${money(h.savingsUsd)} against cash${h.cpp != null ? ` (${h.cpp.toFixed(1)}¢/pt)` : ''}` : 'No cash rate known to compare')
      : h.verdict === 'mix' ? `Points cover ${h.mix.pointsNights} of ${h.nights} nights (${fmt(h.mix.points)} pts)${h.mix.cashUsd != null ? `; the rest is about ${money(h.mix.cashUsd)}` : ''}`
        : h.verdict === 'cash' ? (h.affordable ? `Cash is cheaper than your points are worth here (${h.cpp != null ? `${h.cpp.toFixed(1)}¢/pt` : ''})` : 'Your points cannot cover this stay') : 'Your points cannot cover this stay';
    const pay = h.verdict === 'points' && h.plan.length ? `<div class="muted">${h.plan.map(s => (s.direct ? `Use ${fmt(s.fromPoints)} ${esc(s.toName)} points you hold` : `Transfer ${fmt(s.fromPoints)} ${esc(s.fromName)} → ${esc(s.toName)}`)).join(' · ')}</div>` : '';
    return `<div class="fd-hotel"><div><h4>${esc(h.name)} ${tag}</h4><div class="muted">${esc(h.programName)}${h.category ? ` · category ${esc(h.category)}` : ''}${stars ? ` · ${esc(stars)}` : ''} · ${esc(dayFmt(h.checkIn))} – ${esc(dayFmt(h.checkOut))}</div><div>${esc(why)}</div>${pay}</div>
      <div class="fd-price"><b>${fmt(h.points)} pts</b>${h.estimated ? 'estimated · ' : ''}${fmt(h.pointsPerNight)}/night${h.cashUsd != null ? `<br>or ${money(h.cashUsd)} cash` : ''}</div>
      <div class="btnrow">${link(h.bookUrl, `Book with ${h.programName}`)}${link(h.cashUrl, 'See cash rates')}</div></div>`;
  }

  function renderHotels(r) {
    const q = r.query;
    const watching = state.alerts.some(a => a.kind === 'hotel' && a.query?.destination === q.destination && a.query?.checkIn === q.checkIn);
    const notes = [...(r.walletEmpty ? ['Add your point balances under <em>My Points</em> so PointPilot can work out what you can afford.'] : []),
      ...(r.dataStatus.api === 'not-configured' ? ['Add a seats.aero key under <em>Settings</em> to search live award rooms.'] : []),
      ...(r.dataStatus.google === 'not-configured' ? ['Add a SerpApi key under <em>Settings</em> to compare cash rates.'] : []), ...r.dataStatus.warnings.map(esc)];
    const know = [...r.insights.map(esc), ...r.tips.map(t => `<b>${esc(t.title)}.</b> ${esc(t.text)}`)];
    el('fdResults').innerHTML = `
      <div class="card fd-verdict"><div class="muted">${esc(q.destination)} · ${esc(dayFmt(q.checkIn))} – ${esc(dayFmt(q.checkOut))} · ${esc(q.nights)} night${q.nights > 1 ? 's' : ''}${q.flexDays ? ` · ± ${esc(q.flexDays)} days` : ''} · one room</div>
        <h2>${esc(r.summary.headline)}</h2><p>${esc(r.summary.detail)}</p>
        <div class="fd-watch${watching ? ' on' : ''}">${watching ? '<div><b>🔔 Watching this stay.</b> You will be notified when an award room you can fund appears.</div><button class="btn small ghost" data-fd="alerts">Manage alerts</button>' : `<div><b>${r.watch.suggested ? 'No award room you can fund yet.' : 'Want a better rate?'}</b> PointPilot can keep checking and notify you when new award rooms appear.</div><button class="btn primary small" data-fd="watch-hotel">🔔 Watch this stay</button>`}</div></div>
      ${notes.length ? `<div class="note">${notes.join('<br>')}</div>` : ''}
      ${r.hotels.length ? `<div class="card fd-list"><h3>Award rooms, best value first</h3>${r.hotels.map(hotelRow).join('')}</div>` : ''}
      ${r.cashDeals.length ? `<div class="card fd-list"><h3>Cheapest well-rated cash stays</h3>${r.cashDeals.map(c => `<div class="fd-hotel"><div><h4>${esc(c.name)}</h4><div class="muted">${[c.stars ? `${c.stars}★` : '', c.rating ? `${c.rating.toFixed(1)} rating${c.reviews ? ` (${fmt(c.reviews)} reviews)` : ''}` : ''].filter(Boolean).map(esc).join(' · ')}</div></div><div class="fd-price"><b>${money(c.totalUsd)}</b>${money(c.perNightUsd)}/night</div><div class="btnrow">${link(c.url, 'See on Google Hotels')}</div></div>`).join('')}</div>` : ''}
      ${know.length ? `<div class="card fd-know"><h3>What to know for this stay</h3><ul>${know.map(k => `<li>${k}</li>`).join('')}</ul></div>` : ''}
      <p class="muted fd-meta">Checked ${fmt(r.counts.awardRooms)} award rooms and ${fmt(r.counts.cashOffers)} cash rates in ${(r.tookMs / 1000).toFixed(1)}s. Cash rates are Google's lowest for two adults and may exclude taxes.</p>`;
  }

  async function runHotels(token) {
    const body = { destination: el('fdDestination').value.trim(), checkIn: el('fdCheckIn').value, nights: Number(el('fdNights').value), flexDays: Number(el('fdHotelFlex').value) };
    if (!body.destination) { el('fdMessage').textContent = 'Enter a city.'; el('fdDestination').focus(); return; }
    el('fdMessage').textContent = 'Checking award rooms and cash rates…';
    const r = await api('/api/finder/hotels', { method: 'POST', body, signal: token.signal });
    if (!guard.isCurrent(token)) return;
    lastHotels = r;
    renderHotels(r);
  }

  // ---------- opportunities ----------
  async function loadOpportunities() {
    try {
      const { opportunities } = await api('/api/opportunities');
      const show = opportunities.filter(o => o.kind !== 'buy' || o.rating !== 'poor');
      if (!show.length) { el('fdOpps').innerHTML = ''; return; }
      const tag = o => (o.kind === 'bonus' ? '<span class="tag">BONUS</span>' : o.kind === 'buy' ? '<span class="tag brand">BUY POINTS</span>' : '<span class="tag warn">EXPIRING</span>');
      const row = o => `<div class="fd-opp">${tag(o)}<div><b>${esc(o.title)}</b><div class="muted">${esc(o.text)}</div></div></div>`;
      el('fdOpps').innerHTML = `<details class="card fd-opps"${show.length <= 2 ? ' open' : ''}><summary><b>${show.length} opportunit${show.length === 1 ? 'y' : 'ies'} for your points right now</b> <span class="muted">— transfer bonuses, buy-points prices and expiring points</span></summary>${show.map(row).join('')}<p class="muted" style="font-size:12px;margin:8px 0 0">You are notified once when a new one appears. Save a buy-points price under My Points and PointPilot rates it against what those points are worth.</p></details>`;
    } catch { /* optional panel */ }
  }

  // ---------- events ----------
  async function run() {
    const token = guard.next();
    busy(el('fdSearch'), true, 'Searching…');
    try {
      await { flights: runFlights, hotels: runHotels, explore: runExplore, stopover: runStopover }[mode](token);
      if (guard.isCurrent(token) && !/^Enter/.test(el('fdMessage').textContent)) el('fdMessage').textContent = '';
    } catch (e) {
      if (e?.name === 'AbortError' || !guard.isCurrent(token)) return;
      el('fdMessage').textContent = e.message;
    } finally { if (guard.isCurrent(token)) busy(el('fdSearch'), false); }
  }

  el('fdResults').addEventListener('click', async e => {
    const dest = e.target.closest('[data-dest]');
    if (dest) { el('fdDestination').value = dest.dataset.dest; setMode('flights'); window.scrollTo({ top: 0 }); return run(); }
    const action = e.target.closest('[data-fd]')?.dataset.fd;
    if (!action) return;
    if (action === 'alerts') return showView('alerts');
    if (action === 'explore') { setMode('explore'); window.scrollTo({ top: 0 }); return run(); }
    try {
      if (action === 'advanced' && last) {
        el('destination').value = lastBody.destination; el('origins').value = last.query.originsText; el('cabin').value = last.query.cabin; el('travelers').value = String(last.query.travelers);
        el('dateFrom').value = last.best?.depart || last.query.earliest; el('dateTo').value = last.best?.return || '';
        return showView('search');
      }
      if (action === 'booked' && last) {
        const o = last.options[Number(e.target.closest('[data-opt]').dataset.opt)];
        const legs = o.legs.filter(l => l.pay === 'points');
        for (const l of legs) {
          if (state.alerts.some(a => a.kind === 'rebook' && a.query?.origins === l.origin && a.query?.destination === l.destination && a.query?.departDate === l.date && a.program === l.program)) continue;
          state.alerts.unshift(await api('/api/alerts', { method: 'POST', body: { kind: 'rebook', program: l.program, origin: l.origin, destination: l.destination, date: l.date, cabin: last.query.cabin, travelers: last.query.travelers, paidPoints: l.pointsPerTraveler, paidTaxes: l.taxesPerTraveler || 0, title: `Booked ${l.origin}→${l.destination} ${shortDay(l.date)} · ${l.programName}` } }));
        }
        renderAlerts(); renderKPIs();
        return toast(`Watching ${legs.length} booked flight${legs.length > 1 ? 's' : ''}. You will be notified if the points price drops.`);
      }
      if (action === 'watch' && last) { await createWatch(last, Number(el('fdTarget').value) || null, false); renderFlights(last); }
      if (action === 'watch-hotel' && lastHotels) {
        const q = lastHotels.query;
        const alert = await api('/api/alerts', { method: 'POST', body: { kind: 'hotel', destination: q.destination, checkIn: q.checkIn, checkOut: q.checkOut, flexDays: q.flexDays, roomType: 'standard', title: `${q.destination} stay · ${shortDay(q.checkIn)}` } });
        state.alerts.unshift(alert); renderAlerts(); renderKPIs(); renderHotels(lastHotels);
        toast('Watching this stay.');
      }
    } catch (err) { toast(err.message); }
  });
  el('fdSearch').onclick = run;
  document.querySelectorAll('[data-fdmode]').forEach(b => { b.onclick = () => { setMode(b.dataset.fdmode); el('fdResults').innerHTML = ''; }; });
  el('view-finder').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('#fdOrigins, #fdDestination') && !document.querySelector('#placeSuggestList:not([hidden])')) run(); });
  el('fdWhen').onchange = () => { el('fdCustom').hidden = el('fdWhen').value !== 'custom'; };

  // ---------- boot ----------
  fillMonths();
  const start = new Date(); start.setDate(start.getDate() + 60);
  const end = new Date(start); end.setDate(end.getDate() + 30);
  el('fdEarliest').value = iso(start); el('fdLatest').value = iso(end); el('fdCheckIn').value = iso(start);
  try {
    const saved = JSON.parse(localStorage.getItem('pp.finder') || 'null');
    if (saved) { el('fdOrigins').value = saved.origins || ''; el('fdCabin').value = saved.cabin || 'economy'; el('fdTravelers').value = String(saved.travelers || 1); }
  } catch { /* ignore */ }
  setMode('flights');
  api('/api/settings').then(s => { if (!el('fdOrigins').value && s.homeAirports) el('fdOrigins').value = s.homeAirports; }).catch(() => {});
  loadOpportunities();
})();
