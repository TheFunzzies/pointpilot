'use strict';
// Open-jaw and multi-city itineraries: search each leg, pick one flight per leg, describe the ground moves
// between airports, evaluate the whole trip once, and save it to the Trip Builder.
// Mounted by app.js: PPFeatures.itinerary.mount({ root, api, esc, safeUrl, createGuard, onPlanChanged }).
// Wording rules: ground time is a "user estimate" (never a computed driving time); award legs are separate
// bookings unless stated otherwise; funding "not found" is not a proof of impossibility.
(function (root) {
  const Kit = root.PPKit;
  const LEG_CAP = 6;
  const MODES = { 'open-jaw': 'Open jaw', 'multi-city': 'Multi-city' };
  const CABINS = [['business', 'Business'], ['first', 'First'], ['premium', 'Premium Economy'], ['economy', 'Economy']];
  const FLEX = [0, 1, 2, 3, 5, 7];
  const ERRORS = {
    UNSUPPORTED_SCHEMA: 'This version of PointPilot does not support that itinerary format.',
    PLAN_CHANGED: 'The saved trip changed since you opened it. Reload it, then save again.',
    MULTICITY_PLAN: 'This trip has more than two legs, so it can only be edited here.',
    INVALID_INPUT: 'Some itinerary details are not valid.',
    INVALID_STAY_PLAN: 'Fix the saved stay plan before evaluating the trip.'
  };
  const FUNDING_TEXT = {
    funded: 'Your points can fund this itinerary.',
    unfunded: 'Your wallet has no points to cover this itinerary.',
    'search-limited': 'No funding plan was found within the supported search. This does not prove the trip is impossible: try adjusting your picks or transfer limits.',
    incomplete: 'Pick a flight for every leg to see funding.'
  };
  const TRANSITION_TYPES = { connection: 'Connection (same airport)', surface: 'Ground transfer between airports', stopover: 'Stopover (more than a day)' };
  const REMINDER = 'Allow time for baggage, security and immigration. Separately booked flights are not protected if the first one is late.';

  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  const addDaysISO = (iso, n) => { if (!isDate(iso)) return ''; const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const code = v => String(v ?? '').trim();

  // ---------- pure model ----------
  function blankLeg(id, prev) {
    return { id, origins: prev ? prev.destination : '', destination: '', departDate: prev && isDate(prev.departDate) ? addDaysISO(prev.departDate, 3) : '', flexDays: 0, cabin: prev ? prev.cabin : 'business', nonstopOnly: prev ? prev.nonstopOnly : false };
  }

  /** A leg id that no other leg uses, whatever ids a loaded plan brought with it. */
  function nextLegId(state) {
    const taken = new Set(state.legs.map(l => l.id));
    let n = Number(state.counter) || 0;
    do { n += 1; } while (taken.has(`leg${n}`));
    state.counter = n;
    return `leg${n}`;
  }

  function initialState(mode = 'open-jaw') {
    const state = {
      mode, travelers: 2, counter: 0,
      legs: [], openJaw: { ids: ['leg1', 'leg2'], leaveFrom: '', flyInto: '', flyHomeFrom: '', returnTo: '', departDate: '', returnDate: '', flexDays: 0, cabin: 'business', nonstopOnly: false },
      results: {}, picks: {}, shown: {}, transitions: {},
      searching: false, searchMessage: null, evalState: { phase: 'idle', result: null, error: null }, save: { phase: 'idle', message: null, error: null }, savedRevision: null, baseRevision: null, problems: []
    };
    if (mode === 'multi-city') { state.legs = [blankLeg(nextLegId(state)), blankLeg(nextLegId(state))]; state.legs[1].origins = ''; }
    return state;
  }

  /** The legs actually searched: open jaw is two explicit requests built from the five open-jaw fields. */
  function currentLegs(state) {
    if (state.mode !== 'open-jaw') return state.legs;
    const o = state.openJaw;
    const ids = o.ids || ['leg1', 'leg2'];
    return [
      { id: ids[0], ticketGroupId: (o.ticketGroups || [])[0] || null, origins: code(o.leaveFrom), destination: code(o.flyInto), departDate: o.departDate, flexDays: Number(o.flexDays) || 0, cabin: o.cabin, nonstopOnly: Boolean(o.nonstopOnly) },
      { id: ids[1], ticketGroupId: (o.ticketGroups || [])[1] || null, origins: code(o.flyHomeFrom), destination: code(o.returnTo) || code(o.leaveFrom), departDate: o.returnDate, flexDays: Number(o.flexDays) || 0, cabin: o.cabin, nonstopOnly: Boolean(o.nonstopOnly) }
    ];
  }

  /** Problems found before any request is sent. Each: { leg (id or null), field, message }. */
  function legProblems(state) {
    const problems = [];
    const legs = currentLegs(state);
    if (!(Number.isInteger(Number(state.travelers)) && state.travelers >= 1 && state.travelers <= 9)) problems.push({ leg: null, field: 'travelers', message: 'Travelers must be 1 to 9.' });
    if (state.mode === 'multi-city' && legs.length < 2) problems.push({ leg: null, field: 'legs', message: 'A multi-city trip needs at least two flights.' });
    if (legs.length > LEG_CAP) problems.push({ leg: null, field: 'legs', message: `At most ${LEG_CAP} flights are supported.` });
    legs.forEach((l, i) => {
      const where = state.mode === 'open-jaw' ? (i === 0 ? 'outbound' : 'return') : `flight ${i + 1}`;
      if (!l.origins) problems.push({ leg: l.id, field: state.mode === 'open-jaw' ? (i === 0 ? 'leaveFrom' : 'flyHomeFrom') : 'origins', message: `Enter where the ${where} leaves from.` });
      if (!l.destination) problems.push({ leg: l.id, field: state.mode === 'open-jaw' ? (i === 0 ? 'flyInto' : 'returnTo') : 'destination', message: `Enter where the ${where} goes.` });
      if (!isDate(l.departDate)) problems.push({ leg: l.id, field: state.mode === 'open-jaw' ? (i === 0 ? 'departDate' : 'returnDate') : 'departDate', message: `Enter a date for the ${where}.` });
      else if (i > 0 && isDate(legs[i - 1].departDate) && l.departDate < legs[i - 1].departDate) problems.push({ leg: l.id, field: state.mode === 'open-jaw' ? 'returnDate' : 'departDate', message: `The ${where} cannot be before the flight before it.` });
    });
    return problems;
  }

  const searchBody = (state, legs = currentLegs(state), mode = state.mode) => ({
    schemaVersion: 2, mode, travelers: Number(state.travelers),
    segments: legs.map(l => ({ id: l.id, origins: code(l.origins), destination: code(l.destination), departDate: l.departDate, flexDays: Number(l.flexDays) || 0, cabin: l.cabin, nonstopOnly: Boolean(l.nonstopOnly) }))
  });

  const pairKey = (a, b) => `${a}>${b}`;
  function adjacentPairs(state) { const legs = currentLegs(state); return legs.slice(1).map((l, i) => ({ from: legs[i], to: l, key: pairKey(legs[i].id, l.id) })); }
  const completePicks = state => currentLegs(state).every(l => state.picks[l.id]);

  /** Reordering or removing legs drops ground-move details that no longer join two adjacent legs. */
  function pruneTransitions(state) {
    const keep = new Set(adjacentPairs(state).map(p => p.key));
    for (const k of Object.keys(state.transitions)) if (!keep.has(k)) delete state.transitions[k];
    state.evalState = { phase: 'idle', result: null, error: null };
    state.save = { phase: 'idle', message: null, error: null };
  }

  function moveLeg(state, id, delta) {
    const i = state.legs.findIndex(l => l.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= state.legs.length) return false;
    [state.legs[i], state.legs[j]] = [state.legs[j], state.legs[i]];
    pruneTransitions(state);
    return true;
  }
  function removeLeg(state, id) {
    if (state.legs.length <= 2) return false;
    state.legs = state.legs.filter(l => l.id !== id);
    delete state.results[id]; delete state.picks[id]; delete state.shown[id];
    pruneTransitions(state);
    return true;
  }
  function addLeg(state) {
    if (state.legs.length >= LEG_CAP) return null;
    const leg = blankLeg(nextLegId(state), state.legs.at(-1));
    state.legs.push(leg);
    pruneTransitions(state); // a new leg changes the trip: any earlier evaluation no longer describes it
    return leg;
  }

  function actualAirports(state, pair) {
    const out = state.picks[pair.from.id], next = state.picks[pair.to.id];
    return { from: out ? out.destination : null, to: next ? next.origin : null };
  }

  /** Default ground-move details for a gap; the user edits them. Never invents a duration or cost. */
  function defaultTransition(state, pair) {
    const a = actualAirports(state, pair);
    const sameAirport = a.from && a.to && a.from === a.to;
    const days = isDate(pair.from.departDate) && isDate(pair.to.departDate) ? (Date.parse(pair.to.departDate) - Date.parse(pair.from.departDate)) / 86400000 : 0;
    return { type: sameAirport ? (days > 1 ? 'stopover' : 'connection') : (days > 1 ? 'stopover' : 'surface'), mode: 'road', durationMinutes: '', cost: '', bufferMinutes: sameAirport ? 120 : 180, ticketRelationship: 'separate', touched: false };
  }

  /** Transitions sent to the server: only gaps the user filled in; A derives the rest as unresolved gaps. */
  function transitionsBody(state) {
    const out = [];
    for (const pair of adjacentPairs(state)) {
      const t = state.transitions[pair.key];
      if (!t || !t.touched) continue;
      const minutes = t.durationMinutes === '' || t.durationMinutes == null ? null : Math.max(0, Math.round(Number(t.durationMinutes)));
      const cost = t.cost === '' || t.cost == null ? null : { currency: 'USD', value: Math.max(0, Number(t.cost)) };
      const entry = { fromSegmentId: pair.from.id, toSegmentId: pair.to.id, type: t.type, bufferMinutes: Math.max(0, Math.round(Number(t.bufferMinutes) || 0)), ticketRelationship: t.ticketRelationship === 'unknown' ? 'unknown' : 'separate' };
      entry.ground = t.type === 'connection' && minutes == null && cost == null ? null : { mode: ['rail', 'road', 'other'].includes(t.mode) ? t.mode : 'other', durationMinutes: Number.isFinite(minutes) ? minutes : null, cost: cost && Number.isFinite(cost.value) ? cost : null };
      out.push(entry);
    }
    return out;
  }

  function evaluateBody(state) {
    const legs = currentLegs(state);
    return { schemaVersion: 2, mode: state.mode, travelers: Number(state.travelers), segments: legs.map(l => ({ id: l.id, award: state.picks[l.id] })), transitions: transitionsBody(state) };
  }

  function saveBody(state, expectedRevision) {
    const legs = currentLegs(state);
    return {
      schemaVersion: 2, expectedRevision, mode: state.mode, travelers: Number(state.travelers),
      segments: legs.map(l => ({ id: l.id, ...(l.ticketGroupId ? { ticketGroupId: l.ticketGroupId } : {}), query: { origins: code(l.origins), destination: code(l.destination), departDate: l.departDate, flexDays: Number(l.flexDays) || 0, cabin: l.cabin, nonstopOnly: Boolean(l.nonstopOnly) }, award: state.picks[l.id] || null })),
      transitions: transitionsBody(state)
    };
  }

  // ---------- formatting ----------
  const t12 = hhmm => { if (!hhmm) return '—'; const [h, m] = String(hhmm).split(':').map(Number); if (!Number.isFinite(h)) return '—'; return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const dur = m => (m == null || !Number.isFinite(m) ? '—' : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
  const dayLabel = d => (isDate(d) ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '—');
  const money = n => (n == null || !Number.isFinite(Number(n)) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n)));
  const tag = (esc, text, cls = 'muted') => `<span class="tag ${cls}">${esc(text)}</span>`;

  function optionSummary(o, esc) {
    const f = o.flight;
    const route = f ? `${t12(f.depart && f.depart.time)} ${f.origin} → ${t12(f.arrive && f.arrive.time)} ${f.destination}${f.arriveDayOffset > 0 ? ` +${f.arriveDayOffset}` : ''}` : `${o.origin} → ${o.destination}`;
    const when = dayLabel((f && f.depart && f.depart.date) || o.date);
    const taxes = o.totalTaxes == null || o.taxesMissing ? 'taxes not reported' : `${money(o.totalTaxes)} taxes`;
    const meta = [f ? (f.stops === 0 ? 'Nonstop' : f.stops != null ? `${f.stops} stop${f.stops === 1 ? '' : 's'}` : '') : '', f ? dur(f.totalDurationMin) : '', f && f.flightNumbers ? f.flightNumbers.join(' / ') : '', o.remainingSeats != null ? `${o.remainingSeats} seat${o.remainingSeats === 1 ? '' : 's'} shown` : 'seat count unknown'].filter(Boolean);
    const age = o.dataSource === 'seats.aero' ? `provider data${o.ageHours != null ? `, ${o.ageHours < 1 ? '<1' : Math.round(o.ageHours)} h old` : ''}` : o.dataSource === 'manual' ? 'manual entry' : '';
    return `<span class="fk-opt-main"><strong>${esc(when)}</strong> · ${esc(route)}</span><span class="fk-opt-sub">${esc(meta.join(' · '))}</span><span class="fk-opt-sub">${esc(o.programName || o.program || '')} · ${esc(Kit.fmtInt(o.mileageCost))} pts per traveler · ${esc(taxes)}${age ? ` · ${esc(age)}` : ''}</span>`;
  }

  // ---------- views ----------
  function field(label, id, inner, extra = '') { return `<div${extra}><label for="${id}">${label}</label>${inner}</div>`; }

  function legForm(state, leg, index, esc) {
    const n = state.legs.length;
    const key = leg.id;
    const input = (name, label, value, attrs = '') => field(label, `${key}-${name}`, `<input id="${key}-${name}" data-field="${name}" data-leg="${esc(key)}" data-focus="${esc(key)}-${name}" value="${esc(value)}" autocomplete="off"${attrs}>`);
    return `<li class="card fk-leg" data-leg-card="${esc(key)}"><div class="cardhead"><h3>Flight ${index + 1}</h3><div class="btnrow" style="margin:0">
        <button type="button" class="btn small ghost" data-action="move-up" data-leg="${esc(key)}" data-focus="up-${esc(key)}" aria-label="Move flight ${index + 1} up"${index === 0 ? ' disabled' : ''}>Move up</button>
        <button type="button" class="btn small ghost" data-action="move-down" data-leg="${esc(key)}" data-focus="down-${esc(key)}" aria-label="Move flight ${index + 1} down"${index === n - 1 ? ' disabled' : ''}>Move down</button>
        <button type="button" class="btn small ghost" data-action="remove-leg" data-leg="${esc(key)}" data-focus="rm-${esc(key)}" aria-label="Remove flight ${index + 1}"${n <= 2 ? ' disabled title="A multi-city trip needs at least two flights"' : ''}>Remove</button></div></div>
      <div class="formgrid fk-grid">
        ${input('origins', 'From (airports, city or country)', leg.origins, ' placeholder="JFK, EWR or New York"')}
        ${input('destination', 'To', leg.destination, ' placeholder="LHR or London"')}
        ${input('departDate', 'Date', leg.departDate, ' type="date"')}
        ${field('Date flexibility', `${key}-flexDays`, `<select id="${key}-flexDays" data-field="flexDays" data-leg="${esc(key)}" data-focus="${esc(key)}-flexDays">${FLEX.map(d => `<option value="${d}"${Number(leg.flexDays) === d ? ' selected' : ''}>${d === 0 ? 'Exact' : `± ${d} days`}</option>`).join('')}</select>`)}
        ${field('Cabin', `${key}-cabin`, `<select id="${key}-cabin" data-field="cabin" data-leg="${esc(key)}" data-focus="${esc(key)}-cabin">${CABINS.map(([v, t]) => `<option value="${v}"${leg.cabin === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`)}
        <div class="fk-checkcell"><label class="check"><input type="checkbox" data-field="nonstopOnly" data-leg="${esc(key)}" data-focus="${esc(key)}-nonstopOnly"${leg.nonstopOnly ? ' checked' : ''}> Nonstop only</label></div>
      </div></li>`;
  }

  function openJawForm(state, esc) {
    const o = state.openJaw;
    const f = (name, label, value, attrs = '', help = '') => field(label, `oj-${name}`, `<input id="oj-${name}" data-field="oj-${name}" data-focus="oj-${name}" value="${esc(value)}" autocomplete="off"${attrs}${help ? ` aria-describedby="oj-${name}-help"` : ''}>${help ? `<small id="oj-${name}-help" class="muted">${esc(help)}</small>` : ''}`);
    return `<div class="card fk-leg"><div class="formgrid fk-grid">
        ${f('leaveFrom', 'Leaving from', o.leaveFrom, ' placeholder="JFK or New York"')}
        ${f('flyInto', 'Fly into', o.flyInto, ' placeholder="LHR or London"')}
        ${f('flyHomeFrom', 'Fly home from', o.flyHomeFrom, ' placeholder="CDG or Paris"', 'A different city or airport from where you arrive')}
        ${f('returnTo', 'Return to', o.returnTo, ' placeholder="Same as leaving from"')}
        ${f('departDate', 'Outbound date', o.departDate, ' type="date"')}
        ${f('returnDate', 'Return flight date', o.returnDate, ' type="date"')}
        ${field('Date flexibility', 'oj-flexDays', `<select id="oj-flexDays" data-field="oj-flexDays" data-focus="oj-flexDays">${FLEX.map(d => `<option value="${d}"${Number(o.flexDays) === d ? ' selected' : ''}>${d === 0 ? 'Exact' : `± ${d} days`}</option>`).join('')}</select>`)}
        ${field('Cabin', 'oj-cabin', `<select id="oj-cabin" data-field="oj-cabin" data-focus="oj-cabin">${CABINS.map(([v, t]) => `<option value="${v}"${o.cabin === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`)}
      </div><div class="chips"><label class="check"><input type="checkbox" data-field="oj-nonstopOnly" data-focus="oj-nonstopOnly"${o.nonstopOnly ? ' checked' : ''}> Nonstop only</label></div>
      <p class="muted fk-help">PointPilot searches two separate flights: ${esc(code(o.leaveFrom) || '…')} to ${esc(code(o.flyInto) || '…')}, and ${esc(code(o.flyHomeFrom) || '…')} to ${esc(code(o.returnTo) || code(o.leaveFrom) || '…')}. You arrange how to get between ${esc(code(o.flyInto) || 'the two')} and ${esc(code(o.flyHomeFrom) || 'cities')} yourself.</p></div>`;
  }

  function legResults(state, leg, index, esc, safeUrl) {
    const r = state.results[leg.id];
    const title = `${state.mode === 'open-jaw' ? (index === 0 ? 'Outbound' : 'Return') : `Flight ${index + 1}`}: ${leg.origins || '…'} → ${leg.destination || '…'}${isDate(leg.departDate) ? ` · ${dayLabel(leg.departDate)}` : ''}`;
    let body;
    if (!r || r.status === 'idle') body = '<p class="muted">Not searched yet.</p>';
    else if (r.status === 'loading') body = '<p class="muted" role="status">Searching this flight…</p>';
    else if (r.status === 'error') body = `<div class="fk-status error" role="alert">${esc(r.error?.message || 'This search failed.')} Other flights are not affected. <button type="button" class="btn small" data-action="retry-leg" data-leg="${esc(leg.id)}" data-focus="retry-${esc(leg.id)}">Search this flight again</button></div>`;
    else if (!r.options.length) body = `<div class="card empty"><strong>No award space found for this flight.</strong><p>Try more date flexibility, another cabin or nearby airports. You can still search the other flights.</p>${warn(r.dataStatus, esc)}<button type="button" class="btn small" data-action="retry-leg" data-leg="${esc(leg.id)}">Search again</button></div>`;
    else {
      const shown = state.shown[leg.id] || 10;
      const list = r.options.slice(0, shown);
      const picked = state.picks[leg.id];
      body = `${warn(r.dataStatus, esc)}${r.truncated ? `<div class="note" role="note">More results exist${r.truncatedReason ? `: ${esc(r.truncatedReason)}` : ''}. Narrow the dates or airports to see them.</div>` : ''}
        <fieldset class="fk-fieldset"><legend class="fk-sr">Choose a flight for ${esc(title)}</legend><ul class="fk-options">${list.map(o => {
          const link = safeUrl(o.bookingLinks && o.bookingLinks[0] && o.bookingLinks[0].url);
          return `<li class="fk-opt${picked && picked.id === o.id ? ' selected' : ''}"><label><input type="radio" name="pick-${esc(leg.id)}" value="${esc(o.id)}" data-field="pick" data-leg="${esc(leg.id)}" data-option="${esc(o.id)}"${picked && picked.id === o.id ? ' checked' : ''}> <span class="fk-opt-body">${optionSummary(o, esc)}</span></label>${link ? `<a class="fk-opt-link" href="${esc(link)}" target="_blank" rel="noreferrer">Program page ↗</a>` : ''}</li>`;
        }).join('')}</ul></fieldset>
        <p class="muted fk-help">${r.options.length > shown ? `Showing ${shown} of ${r.options.length}. <button type="button" class="btn small ghost" data-action="more" data-leg="${esc(leg.id)}">Show more</button>` : `${Kit.plural(r.options.length, 'option')}.`} Award seat counts and prices come from provider data that can lag the program.</p>`;
    }
    return `<section class="card fk-result" aria-labelledby="res-${esc(leg.id)}" aria-busy="${r && r.status === 'loading' ? 'true' : 'false'}"><h4 id="res-${esc(leg.id)}">${esc(title)}</h4>${body}</section>`;
  }

  const warn = (ds, esc) => (ds && ds.warnings && ds.warnings.length ? `<div class="warnbox"><ul>${[...new Set(ds.warnings)].map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '');

  function transitionEditor(state, pair, esc) {
    const t = state.transitions[pair.key] || defaultTransition(state, pair);
    const a = actualAirports(state, pair);
    const known = a.from && a.to;
    const k = pair.key;
    return `<li class="card fk-gap" data-gap="${esc(k)}"><h4>Between flight ${currentLegs(state).findIndex(l => l.id === pair.from.id) + 1} and flight ${currentLegs(state).findIndex(l => l.id === pair.to.id) + 1}</h4>
      <p>${known ? `You arrive at <strong>${esc(a.from)}</strong> and your next flight leaves from <strong>${esc(a.to)}</strong>${a.from === a.to ? '.' : ': different airports, so you need to get across yourself.'}` : 'Pick both flights to see the exact airports. Until then this gap is unresolved.'}</p>
      <div class="formgrid fk-grid">
        ${field('What happens here', `gap-type-${esc(k)}`, `<select id="gap-type-${esc(k)}" data-field="gap-type" data-gap="${esc(k)}" data-focus="gap-type-${esc(k)}">${Object.entries(TRANSITION_TYPES).map(([v, l]) => `<option value="${v}"${t.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
        ${field('How you get across', `gap-mode-${esc(k)}`, `<select id="gap-mode-${esc(k)}" data-field="gap-mode" data-gap="${esc(k)}" data-focus="gap-mode-${esc(k)}">${[['rail', 'Train'], ['road', 'Car, taxi or bus'], ['other', 'Other']].map(([v, l]) => `<option value="${v}"${t.mode === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
        ${field('Travel time in minutes (user estimate)', `gap-dur-${esc(k)}`, `<input id="gap-dur-${esc(k)}" type="number" min="0" max="525600" step="5" data-field="gap-duration" data-gap="${esc(k)}" data-focus="gap-dur-${esc(k)}" value="${esc(t.durationMinutes)}" aria-describedby="gap-dur-help-${esc(k)}"><small id="gap-dur-help-${esc(k)}" class="muted">${t.durationMinutes === '' ? 'Unknown: not entered. PointPilot does not guess driving times.' : 'Your own estimate.'}</small>`)}
        ${field('Cost in USD (optional)', `gap-cost-${esc(k)}`, `<input id="gap-cost-${esc(k)}" type="number" min="0" step="1" data-field="gap-cost" data-gap="${esc(k)}" data-focus="gap-cost-${esc(k)}" value="${esc(t.cost)}">`)}
        ${field('Buffer you want, in minutes', `gap-buf-${esc(k)}`, `<input id="gap-buf-${esc(k)}" type="number" min="0" max="10080" step="15" data-field="gap-buffer" data-gap="${esc(k)}" data-focus="gap-buf-${esc(k)}" value="${esc(t.bufferMinutes)}">`)}
        ${field('Tickets', `gap-tix-${esc(k)}`, `<select id="gap-tix-${esc(k)}" data-field="gap-tickets" data-gap="${esc(k)}" data-focus="gap-tix-${esc(k)}"><option value="separate"${t.ticketRelationship === 'separate' ? ' selected' : ''}>Separate bookings (not protected)</option><option value="unknown"${t.ticketRelationship === 'unknown' ? ' selected' : ''}>Not sure</option></select>`)}
      </div><p class="muted fk-help">${esc(REMINDER)} Your buffer is a planning input, not an official minimum connection time.</p></li>`;
  }

  function evaluationView(state, esc) {
    const e = state.evalState;
    const need = currentLegs(state).findIndex(l => !state.picks[l.id]);
    if (e.phase === 'loading') return '<p class="muted" role="status">Evaluating the whole trip…</p>';
    if (e.phase === 'error') return `<div class="fk-status error" role="alert">${esc(e.error)}</div>`;
    if (e.phase !== 'done' || !e.result) return need >= 0 ? `<p class="muted">Pick a flight for flight ${need + 1} to evaluate the whole trip.</p>` : '<p class="muted">Ready to evaluate. This checks the routing and timing, and funds all flights and your saved stays together once.</p>';
    const r = e.result;
    const t = r.trip;
    const risks = r.risks || [];
    const noTaxes = currentLegs(state).some(l => state.picks[l.id] && (state.picks[l.id].taxesMissing || state.picks[l.id].totalTaxes == null));
    return `<div class="fk-eval">${r.valid === false ? `<div class="warnbox" role="alert"><strong>These flights cannot be combined.</strong> ${esc(r.invalidReason || '')}</div>` : ''}
      ${risks.length ? `<h4>Timing and routing</h4><ul class="fk-risks">${risks.map(k => `<li>${tag(esc, String(k.severity || 'caution').toUpperCase(), k.severity === 'stop' ? 'warn' : 'muted')} ${esc(k.reason || k.code)}${k.actualAirports ? ` <span class="muted">(${esc(k.actualAirports.from || '?')} → ${esc(k.actualAirports.to || '?')}${k.gapMinutes != null ? `, gap ${esc(dur(k.gapMinutes))}` : ''}${k.requiredMinutes != null ? `, planned need ${esc(dur(k.requiredMinutes))}` : ''})</span>` : ''}</li>`).join('')}</ul>` : (r.valid ? '<p class="muted">No timing or routing problems found with the details you entered. Unknown ground times are not checked.</p>' : '')}
      <h4>Funding</h4><p>${esc(FUNDING_TEXT[r.fundingStatus] || '')}${r.reason && r.fundingStatus !== 'funded' && !FUNDING_TEXT[r.fundingStatus] ? ` ${esc(r.reason)}` : ''}</p>
      ${t ? `<div class="metrics"><div class="metric"><span>Points you would spend</span><b>${esc(Kit.fmtInt(t.totalSourcePoints))}</b></div><div class="metric"><span>Award points needed</span><b>${esc(Kit.fmtInt(t.totalTargetPoints))}</b></div><div class="metric"><span>Award taxes and fees</span><b>${esc(money(t.taxesUsd))}${noTaxes ? ' +' : ''}</b></div>${t.stays && t.stays.length ? `<div class="metric"><span>Saved stays included</span><b>${esc(String(t.stays.length))}</b></div>` : ''}</div>
        <div class="path">${(t.sources || []).map(s => `<span class="node">${s.direct ? `${esc(Kit.fmtInt(s.fromPoints))} ${esc(s.from)} (have)` : `${esc(Kit.fmtInt(s.fromPoints))} ${esc(s.from)} → ${esc(Kit.fmtInt(s.targetPoints))} ${esc(s.targetProgram)}`}</span>`).join('')}</div>${noTaxes ? '<p class="muted fk-help">Some award taxes were not reported, so the cash total is incomplete.</p>' : ''}${t.warnings && t.warnings.length ? `<div class="warnbox"><ul>${[...new Set(t.warnings)].map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}` : ''}</div>`;
  }

  function view(state, esc, safeUrl) {
    const legs = currentLegs(state);
    const problems = state.problems;
    const canEval = completePicks(state) && state.evalState.phase !== 'loading';
    const modeBadge = MODES[state.mode];
    return `<div class="fk-itin" aria-busy="${state.searching ? 'true' : 'false'}">
      <p class="muted fk-help">${esc(modeBadge)}: up to ${LEG_CAP} flights, each searched and funded on its own. Award legs can require separate bookings; PointPilot never implies a through-fare.</p>
      <div class="formgrid fk-grid">${field('Travelers', 'it-travelers', `<select id="it-travelers" data-field="travelers" data-focus="it-travelers">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<option${Number(state.travelers) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>`)}</div>
      ${state.mode === 'open-jaw' ? openJawForm(state, esc) : `<ol class="fk-legs" aria-label="Flights in order">${state.legs.map((l, i) => legForm(state, l, i, esc)).join('')}</ol>
        <div class="btnrow"><button type="button" class="btn" data-action="add-leg" data-focus="add-leg"${state.legs.length >= LEG_CAP ? ' disabled' : ''}>Add flight</button><span class="muted">${state.legs.length} of ${LEG_CAP} flights${state.legs.length >= LEG_CAP ? ' (the most supported)' : ''}</span></div>`}
      ${problems.length ? `<div class="fk-status error" role="alert"><ul>${problems.map(p => `<li>${esc(p.message)}</li>`).join('')}</ul></div>` : ''}
      <div class="searchfoot"><span role="status" aria-live="polite">${esc(state.searchMessage || '')}</span><button type="button" class="btn${canEval ? '' : ' primary'}" data-action="search" data-focus="it-search"${state.searching ? ' disabled' : ''}>${state.searching ? 'Searching…' : 'Search all flights'}</button></div>
      <div class="fk-results">${legs.map((l, i) => legResults(state, l, i, esc, safeUrl)).join('')}</div>
      ${adjacentPairs(state).some(p => state.picks[p.from.id] && state.picks[p.to.id]) ? `<h3 class="fk-sub">Getting between selected flights</h3><ul class="fk-gaps">${adjacentPairs(state).filter(p => state.picks[p.from.id] && state.picks[p.to.id]).map(p => transitionEditor(state, p, esc)).join('')}</ul>` : ''}
      <section class="card searchbox fk-evalcard" aria-labelledby="itEvalHead"><div class="cardhead"><h3 id="itEvalHead">Whole trip</h3><div class="btnrow" style="margin:0"><button type="button" class="btn${canEval ? ' primary' : ''}" data-action="evaluate" data-focus="it-eval"${canEval ? '' : ' disabled'}>Evaluate complete trip</button><button type="button" class="btn" data-action="save" data-focus="it-save"${state.save.phase === 'saving' ? ' disabled' : ''}>${completePicks(state) ? 'Save to Trip Builder' : 'Save draft'}</button><button type="button" class="btn ghost" data-action="load-saved" data-focus="it-load">Load saved trip</button></div></div>
        ${evaluationView(state, esc)}
        <div class="fk-status${state.save.error ? ' error' : ''}" role="${state.save.error ? 'alert' : 'status'}" aria-live="polite">${esc(state.save.error || state.save.message || '')}${state.save.conflict ? ' <button type="button" class="btn small" data-action="load-saved" data-focus="it-reload">Reload the saved trip</button>' : ''}</div></section>
    </div>`;
  }

  // ---------- Trip Builder timeline for open-jaw / multi-city plans ----------
  const TYPE_ORDER = { positioning: 0, award: 1, transition: 2, hotel: 3 };
  function timelineHtml(plan, esc, safeUrl, { skipPositioning = false } = {}) {
    const segments = plan.segments || [];
    const indexOf = id => segments.findIndex(s => s.id === id) + 1;
    const items = (Array.isArray(plan.timeline) ? plan.timeline : []).filter(x => !(skipPositioning && x.type === 'positioning'));
    const risks = Array.isArray(plan.risks) ? plan.risks : [];
    const riskFor = (from, to) => risks.filter(r => r.fromId === from && r.toId === to);
    const rows = items.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)) || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)).map(x => {
      const o = x.item || {};
      if (x.type === 'award') {
        const f = o.flight;
        const link = safeUrl(o.bookingLinks && o.bookingLinks[0] && o.bookingLinks[0].url);
        return `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card"><h4>Flight ${indexOf(x.segmentId) || ''} · ${esc(o.origin)} → ${esc(o.destination)} ${tag(esc, 'AWARD', 'brand')}</h4>
          <p>${esc(dayLabel((f && f.depart && f.depart.date) || o.date))}${f ? ` · ${esc(t12(f.depart && f.depart.time))} → ${esc(t12(f.arrive && f.arrive.time))} · ${esc(dur(f.totalDurationMin))} · ${esc((f.flightNumbers || []).join(' / '))}` : ''}</p>
          <p>${esc(Kit.fmtInt(o.mileageCost))} pts ${esc(o.programName || o.program)} per traveler × ${esc(String(plan.travelers))} · ${o.totalTaxes == null || o.taxesMissing ? tag(esc, 'TAXES NOT REPORTED', 'warn') : `${esc(money(o.totalTaxes))} taxes`}</p>
          <div class="btnrow" style="margin-top:4px">${link ? `<a class="btn small" href="${esc(link)}" target="_blank" rel="noreferrer">Booking page ↗</a>` : ''}<button type="button" class="btn small ghost" data-tb="remove-segment" data-id="${esc(x.segmentId)}" aria-label="Remove flight ${indexOf(x.segmentId) || ''} from the trip">Remove flight</button></div></div></div>`;
      }
      if (x.type === 'transition') {
        const g = o.ground;
        const rk = riskFor(o.fromSegmentId, o.toSegmentId);
        return `<div class="tl-item"><div class="tl-dot todo"><svg class="icon"><use href="#i-repeat"/></svg></div><div class="card tl-card"><h4>${esc(TRANSITION_TYPES[o.type] || 'Between flights')} · flight ${indexOf(o.fromSegmentId)} to ${indexOf(o.toSegmentId)}</h4>
          <p>${g ? `${esc(({ rail: 'Train', road: 'Car, taxi or bus', other: 'Other' })[g.mode] || 'Ground move')} · ${g.durationMinutes == null ? 'travel time not entered (unknown)' : `about ${esc(dur(g.durationMinutes))} (user estimate)`}${g.cost ? ` · ${esc(money(g.cost.value))} ${esc(g.cost.currency)}` : ''}` : 'No ground move entered: time between flights is unknown.'}</p>
          <p class="muted">Buffer ${esc(String(o.bufferMinutes ?? 0))} min · ${o.ticketRelationship === 'separate' ? 'separate tickets, not protected' : 'ticket protection unknown'}. ${esc(REMINDER)}</p>
          ${rk.map(r => `<p>${tag(esc, String(r.severity || 'caution').toUpperCase(), r.severity === 'stop' ? 'warn' : 'muted')} ${esc(r.reason)}</p>`).join('')}</div></div>`;
      }
      if (x.type === 'positioning') {
        return `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-plane"/></svg></div><div class="card tl-card"><h4>${o.direction === 'return' || x.direction === 'return' ? 'Flight home' : 'Flight to the start'} · ${esc(o.origin)} → ${esc(o.destination)}</h4><p>${o.kind === 'award' ? `${esc(Kit.fmtInt(o.mileageCost))} pts ${esc(o.programName || '')}` : `${esc(money(o.price))} cash`}</p></div></div>`;
      }
      if (x.type === 'hotel') {
        return `<div class="tl-item"><div class="tl-dot"><svg class="icon"><use href="#i-bed"/></svg></div><div class="card tl-card"><h4>${esc(o.name)}</h4><p>${esc(o.city || o.location || '')} · ${esc(dayLabel(o.checkIn))} → ${esc(dayLabel(o.checkOut))} · ${esc(Kit.fmtInt(o.totalPoints))} ${esc(o.programName || '')}</p></div></div>`;
      }
      return '';
    });
    const missing = segments.filter(s => !s.award);
    const header = `<div class="card tl-card fk-itin-head"><h4>${esc(MODES[plan.mode] || 'Itinerary')} · ${esc(Kit.plural(segments.length, 'flight'))}</h4><p class="muted">${esc(plan.complete ? 'Every flight has an award selected.' : `${Kit.plural(missing.length, 'flight')} still need${missing.length === 1 ? 's' : ''} an award selected.`)} Edit this trip under Trip Optimizer → ${esc(MODES[plan.mode] || 'Multi-city')}. Each award is booked separately.</p>${plan.invalidReason && plan.valid === false ? `<div class="warnbox" role="alert">${esc(plan.invalidReason)}</div>` : ''}</div>`;
    return header + rows.join('');
  }

  // ---------- mount ----------
  function mount({ root: host, api, esc, safeUrl, createGuard, onPlanChanged = () => {} }) {
    const state = initialState('open-jaw');
    const searchGuard = createGuard();
    const evalGuard = createGuard();
    const draw = () => Kit.renderInto(host, view(state, esc, safeUrl));
    const failure = e => ERRORS[e?.code] || Kit.errorMessage(e, ERRORS, 'Something went wrong.');
    const resetResults = () => { searchGuard.cancel(); evalGuard.cancel(); state.results = {}; state.picks = {}; state.shown = {}; state.searching = false; state.searchMessage = null; state.evalState = { phase: 'idle', result: null, error: null }; };

    function setMode(mode) {
      if (!MODES[mode] || mode === state.mode) return;
      const fresh = initialState(mode);
      fresh.travelers = state.travelers;
      fresh.baseRevision = state.baseRevision; // switching modes does not mean you have seen newer saved changes
      Object.assign(state, fresh);
      searchGuard.cancel(); evalGuard.cancel();
      draw();
    }

    async function runSearch(only) {
      const legs = currentLegs(state);
      state.problems = legProblems(state);
      const targets = only ? legs.filter(l => l.id === only) : legs;
      const relevant = state.problems.filter(p => p.leg === null || targets.some(l => l.id === p.leg));
      if (relevant.length) { state.problems = relevant; return draw(); }
      state.problems = [];
      const token = searchGuard.next();
      state.searching = true; state.searchMessage = only ? 'Searching this flight…' : 'Searching every flight…';
      for (const l of targets) state.results[l.id] = { status: 'loading', options: [] };
      if (!only) { state.picks = {}; state.shown = {}; }
      state.evalState = { phase: 'idle', result: null, error: null };
      draw();
      try {
        const body = only ? searchBody(state, targets, 'one-way') : searchBody(state);
        const r = await api('/api/search/trip', { method: 'POST', body, signal: token.signal });
        if (!searchGuard.isCurrent(token)) return;
        for (const seg of r.segments || []) {
          state.results[seg.id] = seg.error && !(seg.options || []).length
            ? { status: 'error', options: [], error: seg.error, dataStatus: seg.dataStatus }
            : { status: 'ready', options: seg.options || [], counts: seg.counts, dataStatus: seg.dataStatus, truncated: Boolean(seg.truncated), truncatedReason: seg.truncatedReason || null };
        }
        const failed = (r.segments || []).filter(s => s.error && !(s.options || []).length).length;
        state.searchMessage = failed ? `${Kit.plural(failed, 'flight')} could not be searched. The others are shown.` : 'Pick one flight for each leg, then evaluate the whole trip.';
      } catch (e) {
        if (!searchGuard.isCurrent(token) || e?.name === 'AbortError') return;
        for (const l of targets) state.results[l.id] = { status: 'error', options: [], error: { message: failure(e) } };
        state.searchMessage = 'Search failed.';
      }
      state.searching = false;
      draw();
    }

    async function evaluate() {
      if (!completePicks(state)) return;
      const token = evalGuard.next();
      state.evalState = { phase: 'loading', result: null, error: null }; draw();
      try {
        const result = await api('/api/trip/evaluate', { method: 'POST', body: evaluateBody(state), signal: token.signal });
        if (!evalGuard.isCurrent(token)) return;
        state.evalState = { phase: 'done', result, error: null };
      } catch (e) {
        if (!evalGuard.isCurrent(token) || e?.name === 'AbortError') return;
        state.evalState = { phase: 'error', result: null, error: failure(e) };
      }
      draw();
    }

    /** Remember which saved revision this screen is based on. Saving is only allowed against that revision. */
    async function captureBase() {
      try { const plan = await api('/api/trip-plan'); state.baseRevision = Number.isSafeInteger(plan.revision) ? plan.revision : 0; return true; }
      catch { return false; }
    }

    async function save() {
      state.problems = legProblems(state);
      if (state.problems.length) return draw();
      if (state.baseRevision == null && !(await captureBase())) {
        state.save = { phase: 'error', message: null, error: 'Could not check the saved trip. Try again in a moment.' };
        return draw();
      }
      state.save = { phase: 'saving', message: null, error: null }; draw();
      try {
        // The revision this screen was based on, not the newest one: a change made elsewhere must be surfaced, never overwritten.
        const saved = await api('/api/trip-plan/itinerary', { method: 'PUT', body: saveBody(state, state.baseRevision) });
        state.savedRevision = saved.revision ?? null;
        state.baseRevision = Number.isSafeInteger(saved.revision) ? saved.revision : state.baseRevision;
        state.save = { phase: 'saved', message: completePicks(state) ? 'Saved to your Trip Builder.' : 'Draft saved. Pick the remaining flights to complete it.', error: null };
        onPlanChanged(saved);
      } catch (e) {
        state.save = { phase: 'error', message: null, error: failure(e), conflict: e.code === 'PLAN_CHANGED' || e.status === 409 };
      }
      draw();
    }

    /** One saved segment as an editable leg. Nothing is dropped: a leg with no stored search is rebuilt from its award or left blank to complete. */
    function legFromSegment(seg, index) {
      const q = seg.query || {}, a = seg.award || {};
      return {
        id: seg.id || `leg${index + 1}`, ticketGroupId: seg.ticketGroupId || null,
        origins: q.origins ?? a.origin ?? '', destination: q.destination ?? a.destination ?? '', departDate: q.departDate ?? a.date ?? '',
        flexDays: q.flexDays ?? 0, cabin: q.cabin ?? a.cabin ?? 'business', nonstopOnly: Boolean(q.nonstopOnly)
      };
    }

    async function loadSaved() {
      try {
        const plan = await api('/api/trip-plan');
        const segs = plan.segments || [];
        if (!segs.length || !MODES[plan.mode]) { state.save = { phase: 'idle', message: 'No saved open-jaw or multi-city trip was found. Round trips and one-way trips are edited from the classic search.', error: null }; return draw(); }
        resetResults();
        state.baseRevision = Number.isSafeInteger(plan.revision) ? plan.revision : 0;
        state.travelers = plan.travelers || state.travelers;
        const legs = segs.map(legFromSegment);
        if (plan.mode === 'open-jaw' && segs.length === 2) {
          const [a, b] = legs;
          state.mode = 'open-jaw';
          state.openJaw = { ids: [a.id, b.id], ticketGroups: [a.ticketGroupId, b.ticketGroupId], leaveFrom: a.origins, flyInto: a.destination, flyHomeFrom: b.origins, returnTo: b.destination, departDate: a.departDate, returnDate: b.departDate, flexDays: a.flexDays, cabin: a.cabin, nonstopOnly: a.nonstopOnly };
        } else {
          state.mode = 'multi-city';
          state.legs = legs;
          state.counter = 0;
        }
        const loaded = currentLegs(state);
        state.transitions = {};
        segs.forEach((seg, i) => { if (seg.award) state.picks[loaded[i].id] = seg.award; });
        for (const t of plan.transitions || []) state.transitions[pairKey(t.fromSegmentId, t.toSegmentId)] = { type: t.type, mode: t.ground ? t.ground.mode : 'road', durationMinutes: t.ground && t.ground.durationMinutes != null ? t.ground.durationMinutes : '', cost: t.ground && t.ground.cost ? t.ground.cost.value : '', bufferMinutes: t.bufferMinutes, ticketRelationship: t.ticketRelationship || 'separate', touched: true };
        const incomplete = segs.filter(seg => !seg.query).length;
        state.save = { phase: 'idle', message: `Loaded your saved trip (${Kit.plural(segs.length, 'flight')}).${incomplete ? ` ${Kit.plural(incomplete, 'flight')} had no saved search details; check ${incomplete === 1 ? 'it' : 'them'} before saving.` : ''} Search again to change a flight.`, error: null };
        for (const l of loaded) if (state.picks[l.id]) state.results[l.id] = { status: 'ready', options: [state.picks[l.id]], dataStatus: null, truncated: false };
      } catch (e) { state.save = { phase: 'error', message: null, error: failure(e) }; }
      draw();
    }

    // ----- events -----
    const touchLegs = () => { state.problems = []; };
    const OJ = { 'oj-leaveFrom': 'leaveFrom', 'oj-flyInto': 'flyInto', 'oj-flyHomeFrom': 'flyHomeFrom', 'oj-returnTo': 'returnTo', 'oj-departDate': 'departDate', 'oj-returnDate': 'returnDate', 'oj-flexDays': 'flexDays', 'oj-cabin': 'cabin', 'oj-nonstopOnly': 'nonstopOnly' };
    const searchInputChanged = () => { /* Editing a search invalidates what was searched before it. */
      if (Object.keys(state.results).length || Object.keys(state.picks).length) { resetResults(); state.searchMessage = 'Search details changed: search again.'; }
    };

    host.addEventListener('click', ev => {
      const el = ev.target.closest && ev.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action, id = el.dataset.leg;
      if (a === 'search') return runSearch();
      if (a === 'retry-leg') return runSearch(id);
      if (a === 'evaluate') return evaluate();
      if (a === 'save') return save();
      if (a === 'load-saved') return loadSaved();
      if (a === 'more') { state.shown[id] = (state.shown[id] || 10) + 10; return draw(); }
      if (a === 'add-leg') { const leg = addLeg(state); touchLegs(); draw(); const input = leg && host.querySelector && host.querySelector(`[data-focus="${leg.id}-origins"]`); if (input) input.focus(); return; }
      if (a === 'remove-leg') { const idx = state.legs.findIndex(l => l.id === id); if (removeLeg(state, id)) { touchLegs(); draw(); const next = state.legs[Math.min(idx, state.legs.length - 1)]; const input = next && host.querySelector && host.querySelector(`[data-focus="${next.id}-origins"]`); if (input) input.focus(); } return; }
      if (a === 'move-up' || a === 'move-down') { const key = `${a === 'move-up' ? 'up' : 'down'}-${id}`; if (moveLeg(state, id, a === 'move-up' ? -1 : 1)) { draw(); const stay = host.querySelector && (host.querySelector(`[data-focus="${key}"]:not([disabled])`) || host.querySelector(`[data-focus="${a === 'move-up' ? 'down' : 'up'}-${id}"]`)); if (stay) stay.focus(); } }
    });

    host.addEventListener('input', ev => {
      const t = ev.target, f = t.dataset && t.dataset.field;
      if (!f) return;
      if (f in OJ) { state.openJaw[OJ[f]] = t.type === 'checkbox' ? t.checked : t.value; return searchInputChanged(); }
      if (t.dataset.leg && ['origins', 'destination', 'departDate'].includes(f)) { const leg = state.legs.find(l => l.id === t.dataset.leg); if (leg) { leg[f] = t.value; searchInputChanged(); } return; }
      if (f === 'gap-duration' || f === 'gap-cost' || f === 'gap-buffer') updateGap(t.dataset.gap, f === 'gap-duration' ? 'durationMinutes' : f === 'gap-cost' ? 'cost' : 'bufferMinutes', t.value, false);
    });

    function updateGap(key, prop, value, redraw) {
      const pair = adjacentPairs(state).find(p => p.key === key);
      if (!pair) return;
      const t = state.transitions[key] || defaultTransition(state, pair);
      t[prop] = value; t.touched = true;
      state.transitions[key] = t;
      state.evalState = { phase: 'idle', result: null, error: null };
      if (redraw) draw();
    }

    host.addEventListener('change', ev => {
      const t = ev.target, f = t.dataset && t.dataset.field;
      if (!f) return;
      if (f === 'travelers') { state.travelers = Number(t.value); return searchInputChanged(); }
      if (f in OJ) { state.openJaw[OJ[f]] = t.type === 'checkbox' ? t.checked : t.value; searchInputChanged(); return draw(); }
      if (t.dataset.leg && ['origins', 'destination', 'departDate'].includes(f)) { searchInputChanged(); return draw(); }
      if (t.dataset.leg && ['flexDays', 'cabin', 'nonstopOnly'].includes(f)) { const leg = state.legs.find(l => l.id === t.dataset.leg); if (leg) { leg[f] = f === 'nonstopOnly' ? t.checked : f === 'flexDays' ? Number(t.value) : t.value; searchInputChanged(); draw(); } return; }
      if (f === 'pick') {
        const r = state.results[t.dataset.leg];
        const option = r && r.options.find(o => o.id === t.dataset.option);
        if (option) { state.picks[t.dataset.leg] = option; state.evalState = { phase: 'idle', result: null, error: null }; for (const k of Object.keys(state.transitions)) if (k.split('>').includes(t.dataset.leg)) delete state.transitions[k]; draw(); }
        return;
      }
      if (f === 'gap-type') return updateGap(t.dataset.gap, 'type', t.value, true);
      if (f === 'gap-mode') return updateGap(t.dataset.gap, 'mode', t.value, true);
      if (f === 'gap-tickets') return updateGap(t.dataset.gap, 'ticketRelationship', t.value, true);
    });

    draw();
    captureBase();
    return {
      setMode,
      refresh: loadSaved,
      destroy() { searchGuard.cancel(); evalGuard.cancel(); host.innerHTML = ''; },
      get state() { return state; }
    };
  }

  root.PPFeatures = root.PPFeatures || {};
  root.PPFeatures.itinerary = { mount, view, initialState, timelineHtml, currentLegs, legProblems, searchBody, evaluateBody, saveBody, transitionsBody, moveLeg, removeLeg, addLeg, adjacentPairs, pruneTransitions, defaultTransition, optionSummary, LEG_CAP, ERRORS };
})(typeof window !== 'undefined' ? window : globalThis);
