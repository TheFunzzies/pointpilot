import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dataFile, referenceFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { getSettings, loadUser } from './settings.mjs';
import { transferData } from './reference.mjs';
import { fundPrograms, DEFAULT_PREFS } from './optimizer.mjs';
import { bonusActive, transferMeta } from './transfers.mjs';
import { BOOKING_URLS } from './programs.mjs';
import { checkFlightAvailability } from './seatsaero.mjs';
import { getExactHotelAvailability, requestHotelRefresh } from './roomsaero.mjs';
import { ApiError } from './errors.mjs';
import { normalizeTripPlan, normalizeStayPlan } from './itinerary.mjs';
import { validateItinerary } from './validate.mjs';
import { assessTransitions } from './route-risk.mjs';

export const FRESHNESS_MS = 15 * 60000;
export const MANUAL_CODES = Object.freeze(['AVAILABILITY_UNVERIFIED', 'AVAILABILITY_CACHED', 'AVAILABILITY_NOT_FOUND', 'SEATS_UNKNOWN', 'ROOMS_UNKNOWN', 'FEES_UNKNOWN']);
const EMPTY = () => ({ schemaVersion: 1, reports: { trip: null, stay: null }, confirmations: [] });
const FILE = () => dataFile('booking-readiness.json');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k] ?? null]));
export const selectionFingerprint = s => hash(pick(s, ['id', 'program', 'origin', 'destination', 'date', 'cabin', 'mileageCost', 'totalTaxes', 'taxesMissing', 'taxesEstimate', 'taxesCurrency', 'flight', 'hotelId', 'availabilityId', 'roomIdentity', 'roomId', 'roomType', 'checkIn', 'checkOut', 'nights', 'pricedNights', 'pricedTotalPoints', 'totalPoints', 'estimated', 'awardFees', 'feesMissing', 'feesEstimated', 'feesCurrency', 'rooms', 'paymentKind', 'price', 'currency', 'pricing']));
export const planHashFor = ({ scope, trip, stay }) => hash({ scope, trip: scope === 'trip' ? trip : null, stay });
export const contextHashFor = ({ user, transfers, metadata }) => hash({ metadata: metadata || null, balances: (user?.balances || []).map(b => pick(b, ['code', 'program', 'balance', 'cpp'])), preferences: pick(user?.preferences, Object.keys(DEFAULT_PREFS)), transfers });
export const verdictFor = items => items.some(i => i.status === 'stop') ? 'Stop' : !items.length || items.some(i => i.status !== 'pass') ? 'Caution' : 'Go';
const evidenceAt = (at, source = 'Point Pilot', method = 'unsupported') => ({ method, requestedAt: at, observedAt: null, source, complete: false });
const item = (category, selectionId, status, code, message, evidence, details = {}) => ({ id: `${selectionId || 'plan'}:${code}`, category, selectionId: selectionId || null, status, code, message, evidence, details });

function selectionsOf({ scope, trip, stay }) {
  const flights = scope === 'trip' ? (trip.segments || []).filter(s => s.award).map(s => ({ ...s.award, selectionId: s.id, kind: 'flight' })) : [];
  const hotels = (stay.stays || []).map(s => ({ ...s, selectionId: s.id, kind: 'hotel' }));
  const positioning = scope === 'trip' ? Object.entries(trip.positioning || {}).filter(([, p]) => p).map(([direction, p]) => ({
    ...p, selectionId: `positioning-${direction}`, kind: 'flight', paymentKind: p.kind,
    date: p.date || p.departDate || p.departUtc?.slice(0, 10),
    flight: { departUtc: p.departUtc, arriveUtc: p.arriveUtc, flightNumbers: Array.isArray(p.flightNumbers) ? p.flightNumbers : String(p.flightNumbers || p.flightNumber || '').split(/[,\s]+/).filter(Boolean), ...p.flight }
  })) : [];
  return [...flights, ...positioning, ...hotels];
}
function validConfirmation(c, s, planHash, now) {
  return c.planHash === planHash && c.selectionId === s.selectionId && c.fingerprint === selectionFingerprint(s) && Number.isFinite(Date.parse(c.confirmedAt)) && Date.parse(c.confirmedAt) <= now && now - Date.parse(c.confirmedAt) < FRESHNESS_MS;
}
function applyConfirmations(items, confirmations, selections, planHash, now) {
  return items.map(i => {
    const s = selections.find(s => s.selectionId === i.selectionId);
    const c = s && confirmations.find(c => c.itemCode === i.code && validConfirmation(c, s, planHash, now));
    if (!c || i.status === 'stop' || !MANUAL_CODES.includes(i.code)) return i;
    return { ...i, status: 'pass', message: i.code === 'FEES_UNKNOWN' ? 'Award fees user confirmed at the program.' : 'User confirmed at the program; this is not API verification.', evidence: { method: 'manual', requestedAt: c.confirmedAt, observedAt: c.confirmedAt, source: c.sourceUrl, complete: true }, details: { ...i.details, userConfirmed: true, ...(c.amount ? { amount: c.amount } : {}) } };
  });
}

export function transferTimingItems({ funding, transfers, metadata = { transfers: [] }, now, departAt }) {
  const at = new Date(now).toISOString();
  const items = [];
  for (const s of funding?.sources || []) {
    if (s.direct) continue;
    const edge = transfers.programs?.[s.targetProgram]?.transfers?.[s.from] || {};
    const meta = transferMeta(transfers, s.from, edge);
    const curated = (metadata?.transfers || []).find(t => t.from === s.from && t.to === s.targetProgram);
    const fresh = curated && Number.isFinite(Date.parse(curated.verifiedAt)) && now - Date.parse(curated.verifiedAt) < 180 * 86400000;
    const hours = fresh ? curated.typicalMaxHours : Number.isFinite(edge.days) ? edge.days * 24 : null;
    const details = { from: s.from, to: s.targetProgram, typicalMaxHours: hours, estimated: true, minTransfer: meta.minTransfer, increment: meta.increment, sourceUrl: curated?.sourceUrl || null, verifiedAt: curated?.verifiedAt || null };
    items.push(item('transfers', null, 'caution', hours === null ? 'TRANSFER_TIME_UNKNOWN' : hours > 0 ? 'TRANSFER_DELAY' : 'TRANSFER_ESTIMATED_INSTANT', hours === null ? 'Transfer time is unknown. Confirm eligibility and posting time before transferring.' : `Transfer time is estimated (${hours === 0 ? 'instant' : `up to ${hours} hours`}); inventory can change before points arrive.`, evidenceAt(at, curated?.sourceUrl || 'Transfer reference'), details));
    if (departAt && hours != null && Date.parse(departAt) - now < hours * 3600000) items.push(item('transfers', null, 'caution', 'TRANSFER_BEFORE_DEPARTURE', 'The estimated transfer duration may extend past departure; confirm posting time.', evidenceAt(at)));
    if (edge.bonusPct && (!bonusActive(edge, at.slice(0, 10)) || edge.unverified)) items.push(item('transfers', null, 'caution', 'BONUS_UNCONFIRMED', 'Bonus is expired or unconfirmed; funding uses current verified transfer rules.', evidenceAt(at)));
    if (s.bonusPct && edge.bonusEnds) items.push(item('transfers', null, 'caution', 'BONUS_DEADLINE', 'Confirm bonus eligibility, initiation versus posting deadline, and cutoff timezone at the program.', evidenceAt(at), { bonusEnds: edge.bonusEnds, bonusDeadlineTimeZone: curated?.bonusDeadlineTimeZone || null }));
  }
  const refAt = Date.parse(transfers.updatedAt || transfers.lastUpdated);
  if (funding?.transfers && (!Number.isFinite(refAt) || now - refAt > 7 * 86400000)) items.push(item('transfers', null, 'caution', 'REFERENCE_STALE', 'Transfer reference is stale or has no verification timestamp.', evidenceAt(at)));
  if (funding?.fundingSearch?.limited) items.push(item('funding', null, 'caution', 'FUNDING_SEARCH_LIMITED', 'Funding search reached its limits; review the suggested transfers.', evidenceAt(at)));
  return items;
}

/** Pure policy. Provider results must already be matched to exact selected identity. */
export function buildReport({ scope, trip, stay, user, transfers, results = {}, confirmations = [], risks = [], validity = { valid: true }, metadata, now = Date.now() }) {
  const planHash = planHashFor({ scope, trip, stay });
  const contextHash = contextHashFor({ user, transfers, metadata });
  const at = new Date(now).toISOString();
  const items = [], needs = {};
  const selections = selectionsOf({ scope, trip, stay });
  const addNeed = (program, n) => { needs[program] = (needs[program] || 0) + n; };
  if (!validity.valid) items.push(item('connections', null, 'stop', 'INVALID_ITINERARY', 'The selected itinerary has invalid chronology or routing.', evidenceAt(at)));
  if (scope === 'trip' && (trip.segments || []).some(s => !s.award)) items.push(item('availability', null, 'unknown', 'INCOMPLETE_PLAN', 'Select a flight for every itinerary leg.', evidenceAt(at)));
  for (const risk of risks) items.push(item('connections', risk.toId, risk.severity === 'stop' ? 'stop' : 'caution', risk.code, String(risk.reason || 'Connection needs review.').slice(0, 500), evidenceAt(at), pick(risk, ['fromId', 'toId', 'actualAirports', 'gapMinutes', 'requiredMinutes'])));
  for (const s of selections) {
    const r = results[s.selectionId];
    const ev = r?.evidence || evidenceAt(at, s.dataSource || 'Program');
    const match = r?.match;
    const bookingUrl = BOOKING_URLS[s.program] || null;
    const det = { selectionFingerprint: selectionFingerprint(s), bookingUrl };
    const cash = s.paymentKind === 'cash';
    const roomCount = s.kind === 'hotel' && Array.isArray(s.rooms) ? s.rooms.length : 1;
    if (roomCount > 1) items.push(item('availability', s.selectionId, 'caution', 'MULTI_ROOM_ESTIMATE', 'Multi-room points are estimated from single-room prices; simultaneous room inventory is unknown.', ev, { rooms: roomCount, inventoryStatus: 'unknown', estimated: true }));
    if (r?.refreshQueued) items.push(item('availability', s.selectionId, 'caution', 'HOTEL_REFRESH_QUEUED', 'Hotel refresh is queued or new provider evidence has not arrived. This does not confirm bookability.', ev));
    if (r?.definitive && !match && ev.method === 'live' && ev.complete) items.push(item('availability', s.selectionId, 'stop', 'INVENTORY_GONE', 'The exact selected inventory is no longer available in a complete live check.', ev, det));
    else if (!match) items.push(item('availability', s.selectionId, 'unknown', r?.code === 'AVAILABILITY_NOT_FOUND' ? 'AVAILABILITY_NOT_FOUND' : 'AVAILABILITY_UNVERIFIED', r?.code === 'AVAILABILITY_NOT_FOUND' ? 'Exact selection not found in provider cache; this does not prove it is sold out.' : 'Availability is unverified. Refresh availability or confirm at the program.', ev, { ...det, providerCode: r?.code || 'UNSUPPORTED_CHECK' }));
    else items.push(item('availability', s.selectionId, ev.method === 'live' && ev.complete ? 'pass' : 'caution', ev.method === 'live' && ev.complete ? 'AVAILABILITY_VERIFIED' : 'AVAILABILITY_CACHED', ev.method === 'live' && ev.complete ? 'Exact selection matched a live provider check; booking is not guaranteed.' : 'Exact selection found in provider cache. Confirm availability at the program.', ev, det));
    if (!ev.complete && match) items.push(item('availability', s.selectionId, 'unknown', 'EVIDENCE_INCOMPLETE', 'Provider results were incomplete; refresh again.', ev));
    if (ev.method === 'cached' && (!ev.observedAt || !Number.isFinite(Date.parse(ev.observedAt)) || now - Date.parse(ev.observedAt) >= FRESHNESS_MS)) { const availability = items.find(i => i.selectionId === s.selectionId && i.category === 'availability'); if (availability) availability.details.stale = true; }
    const count = s.kind === 'flight' ? match ? match.remainingSeats : s.remainingSeats > 0 && s.remainingSeats < (trip.travelers || 1) ? s.remainingSeats : null : match?.remainingRooms;
    const required = s.kind === 'flight' ? trip.travelers || 1 : roomCount;
    items.push(item('availability', s.selectionId, count > 0 ? count < required ? 'stop' : 'pass' : 'unknown', count > 0 ? count < required ? 'INSUFFICIENT_SEATS' : 'COUNT_SUFFICIENT' : s.kind === 'flight' ? 'SEATS_UNKNOWN' : 'ROOMS_UNKNOWN', count > 0 ? count < required ? 'Known inventory is below the requested party size.' : 'Observed inventory count covers the requested party.' : 'Bookable inventory count is unknown; confirm at the program.', ev));
    const selectedPrice = cash ? s.price : s.kind === 'flight' ? s.mileageCost : s.totalPoints;
    if (cash || match && (s.kind === 'flight' ? match.mileageCost : match.totalPoints) == null) items.push(item('funding', s.selectionId, 'unknown', 'PRICE_UNVERIFIED', cash ? 'The saved cash positioning fare is a planning estimate; its current party price and availability are unverified.' : 'The exact selection has no current points price; funding uses the saved price for planning.', ev));
    const currentPrice = (cash ? null : s.kind === 'flight' ? match?.mileageCost : match?.totalPoints == null ? null : match.totalPoints * roomCount) ?? selectedPrice;
    if (currentPrice !== selectedPrice) items.push(item('funding', s.selectionId, 'caution', 'PRICE_CHANGED', 'The current points price differs from your selection. Review and accept it in the plan.', ev, { selectedPoints: selectedPrice, currentPoints: currentPrice }));
    if (!cash) {
      if (Number.isSafeInteger(currentPrice) && currentPrice > 0) addNeed(s.program, currentPrice * (s.kind === 'hotel' ? 1 : required));
      else items.push(item('funding', s.selectionId, 'stop', 'INVALID_PRICE', 'An exact valid points total is required.', ev));
    }
    const fee = cash ? null : s.kind === 'hotel' ? s.awardFees : match ? match.totalTaxes : s.totalTaxes;
    const currency = s.kind === 'hotel' ? s.feesCurrency : match?.taxesCurrency || s.taxesCurrency;
    if (s.kind === 'flight' && match?.totalTaxes != null && s.totalTaxes != null && match.totalTaxes !== s.totalTaxes) items.push(item('fees', s.selectionId, 'caution', 'FEES_CHANGED', 'Current award fees differ from your selection. Review and accept the current fees in the plan.', ev, { selectedAmount: s.totalTaxes, currentAmount: match.totalTaxes, currency: currency || 'USD' }));
    const missing = s.kind === 'hotel' ? s.feesMissing || s.feesEstimated : s.taxesMissing || s.taxesEstimate;
    const feeKnown = fee != null && typeof fee === 'number' && Number.isFinite(fee) && fee >= 0 && !missing && (!currency || currency === 'USD');
    items.push(item('fees', s.selectionId, feeKnown ? 'pass' : 'unknown', feeKnown ? 'FEES_KNOWN' : 'FEES_UNKNOWN', feeKnown ? 'Award fees recorded in USD.' : 'Award taxes or mandatory fees are missing, estimated, or not confirmed in USD.', ev, feeKnown ? { amount: { currency: 'USD', value: fee } } : {}));
    if (s.kind === 'flight') {
      const segments = s.flight?.segments || [];
      if (!s.flight?.departUtc || !s.flight?.arriveUtc) items.push(item('connections', s.selectionId, 'caution', 'FLIGHT_TIMING_UNKNOWN', 'Exact departure or arrival time is unknown.', evidenceAt(at)));
      if (s.flight?.departUtc && s.flight?.arriveUtc && Date.parse(s.flight.arriveUtc) <= Date.parse(s.flight.departUtc)) items.push(item('connections', s.selectionId, 'stop', 'FLIGHT_CHRONOLOGY', 'Arrival must follow departure.', evidenceAt(at)));
      for (let i = 1; i < segments.length; i++) {
        const a = segments[i - 1], b = segments[i];
        if (a.arriveUtc && b.departUtc && Date.parse(b.departUtc) <= Date.parse(a.arriveUtc)) items.push(item('connections', s.selectionId, 'stop', 'IMPOSSIBLE_CONNECTION', 'A connecting flight departs before the preceding flight arrives.', evidenceAt(at)));
        else if (!a.arriveUtc || !b.departUtc || a.destination !== b.origin) items.push(item('connections', s.selectionId, 'caution', 'CONNECTION_UNRESOLVED', 'A connection time or airport transfer needs confirmation.', evidenceAt(at)));
      }
    }
    if (s.estimated || s.kind === 'hotel' && (s.nights > 5 || s.pricedNights !== s.nights)) items.push(item('availability', s.selectionId, 'caution', 'STAY_EXTRAPOLATED', 'The selected stay uses an estimated or extrapolated price.', ev));
  }
  const fundingTransfers = structuredClone(transfers);
  for (const program of Object.values(fundingTransfers.programs || {})) for (const edge of Object.values(program.transfers || {})) if (edge.unverified) edge.bonusPct = 0;
  const funding = Object.keys(needs).length ? fundPrograms(needs, user.balances || [], fundingTransfers, user.preferences || {}, at.slice(0, 10)) : null;
  items.push(item('funding', null, funding ? 'pass' : 'stop', funding ? 'FUNDED' : 'FUNDING_SHORTFALL', funding ? 'Current wallet and transfer rules cover current points prices.' : 'Current wallet and verified transfer rules do not cover current points prices.', evidenceAt(at)));
  items.push(...transferTimingItems({ funding, transfers, metadata, now, departAt: selections.find(s => s.kind === 'flight')?.flight?.departUtc }));
  const confirmed = applyConfirmations(items, confirmations, selections, planHash, now).map((i, index) => ({ ...i, id: `${i.id}:${index}` }));
  const expiresAt = Math.min(now + FRESHNESS_MS, ...confirmed.filter(i => i.evidence.method === 'manual').map(i => Date.parse(i.evidence.observedAt) + FRESHNESS_MS));
  return { id: randomUUID(), scope, planHash, contextHash, checkedAt: at, expiresAt: new Date(expiresAt).toISOString(), verdict: verdictFor(confirmed), items: confirmed, sourceStatus: { complete: selections.every(s => results[s.selectionId]?.evidence?.complete === true), label: 'Refresh availability', disclaimer: 'Go means no detected blocker, not a booking guarantee.' } };
}

async function defaultContext(scope) {
  const [rawTrip, rawStay, user, settings] = await Promise.all([readJson(dataFile('trip-plan.json'), {}), readJson(dataFile('stay-plan.json'), { stays: [] }), loadUser(), getSettings()]);
  const trip = normalizeTripPlan(scope === 'trip' ? rawTrip : {}, { strict: false });
  const stay = normalizeStayPlan(rawStay, { strict: false });
  return { scope, trip, stay, user, settings, transfers: transferData(), metadata: JSON.parse(readFileSync(referenceFile('booking-readiness.json'), 'utf8')) };
}

export function createReadinessService(deps = {}) {
  const loadContext = deps.loadContext || defaultContext;
  const readState = deps.readState || (() => readJson(FILE(), EMPTY()));
  const mutateState = deps.mutateState || (fn => updateJson(FILE(), EMPTY(), fn));
  const now = deps.now || Date.now;
  const flightCheck = deps.flightCheck || checkFlightAvailability;
  const hotelCheck = deps.hotelCheck || getExactHotelAvailability;
  const refresh = deps.refresh || requestHotelRefresh;
  const active = new Map();
  const refreshActive = new Set();
  const refreshes = new Map();
  const assertCurrent = (ctx, expected) => {
    const ph = planHashFor(ctx);
    if (expected && expected !== ph) throw new ApiError('The saved plan changed. Check the current selection again.', 409, 'PLAN_CHANGED');
    return ph;
  };
  const current = (report, ctx) => Boolean(report && report.planHash === planHashFor(ctx) && report.contextHash === contextHashFor(ctx) && Date.parse(report.expiresAt) > now() && selectionsOf(ctx).every(s =>
    report.items.some(i => i.selectionId === s.selectionId && i.category === 'availability' && i.details?.selectionFingerprint === selectionFingerprint(s)) &&
    report.items.some(i => i.selectionId === s.selectionId && i.category === 'fees') &&
    (!(s.kind === 'hotel' && s.rooms?.length > 1) || report.items.some(i => i.selectionId === s.selectionId && i.code === 'MULTI_ROOM_ESTIMATE' && i.status === 'caution'))));
  async function get({ scope }) {
    const [ctx, state] = await Promise.all([loadContext(scope), readState()]);
    return { report: state.reports[scope], current: current(state.reports[scope], ctx), planHash: planHashFor(ctx) };
  }
  async function check({ scope, expectedPlanHash }) {
    const ctx = { ...await loadContext(scope), scope };
    const ph = assertCurrent(ctx, expectedPlanHash);
    const selections = selectionsOf(ctx);
    if (!selections.length) throw new ApiError('Choose flights or stays before checking readiness.', 409, 'EMPTY_PLAN');
    if (new Set(selections.map(s => s.selectionId)).size !== selections.length) throw new ApiError('Flight and stay selection IDs must be distinct.', 400, 'INVALID_SELECTION_IDS');
    if (scope === 'trip' && (ctx.trip.segments?.length || 0) > 6 || ctx.stay.stays.length > 20) throw new ApiError('Readiness supports six legs and twenty stays.', 400, 'PLAN_LIMIT');
    const key = hash([ph, contextHashFor(ctx)]);
    if (active.has(scope)) {
      if (active.get(scope).key !== key) throw new ApiError('A readiness check is already running.', 409, 'CHECK_IN_PROGRESS');
      return active.get(scope).promise;
    }
    const work = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.deadlineMs ?? 90000);
      const results = {};
      let index = 0;
      const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
      const worker = async () => {
        while (index < selections.length && !controller.signal.aborted) {
          const s = selections[index++];
          try {
            const args = { apiKey: ctx.settings?.seatsAeroApiKey, selection: s, travelers: ctx.trip.travelers || 1, signal: controller.signal, ...(deps.liveCapability || {}) };
            // Cash quote sources cannot verify exact ticketable inventory/fees. Keep that explicit
            // rather than passing a cash fare to an award adapter or trusting its saved amount.
            const operation = s.paymentKind === 'cash' ? Promise.resolve({ evidence: evidenceAt(new Date(now()).toISOString(), s.source || 'Cash fare source'), code: 'UNSUPPORTED_CHECK', match: null, definitive: false }) : s.kind === 'flight' ? flightCheck(args) : hotelCheck(args);
            const r = await Promise.race([operation, aborted]);
            if (r) {
              const pending = s.kind === 'hotel' && refreshes.get(s.hotelId);
              if (pending && pending.status !== 'completed') {
                const observed = Date.parse(r.evidence?.observedAt);
                if (Number.isFinite(observed) && observed >= Date.parse(pending.receipt.requestedAt) && (!pending.baseline || observed > Date.parse(pending.baseline))) pending.status = 'completed';
                else r.refreshQueued = true;
              }
              results[s.selectionId] = r;
            }
          } catch (e) {
            results[s.selectionId] = { evidence: evidenceAt(new Date(now()).toISOString(), s.dataSource || 'Program'), code: ['API_AUTH', 'API_RATE_LIMIT', 'NO_API_KEY'].includes(e.code) ? e.code : 'PROVIDER_FAILURE', match: null, definitive: false };
          }
        }
      };
      try {
        await Promise.all([worker(), worker()]);
        const after = { ...await loadContext(scope), scope };
        assertCurrent(after, ph);
        if (contextHashFor(after) !== contextHashFor(ctx)) throw new ApiError('Wallet or reference data changed. Run readiness again.', 409, 'PLAN_CHANGED');
        const state = await readState();
        const validity = scope === 'trip' ? validateItinerary(ctx.trip) : { valid: true };
        const risks = scope === 'trip' ? assessTransitions(ctx.trip).risks : [];
        const report = buildReport({ ...ctx, results, validity, risks, confirmations: state.confirmations, now: now() });
        await mutateState(s => { s.reports[scope] = report; s.confirmations = s.confirmations.filter(c => now() - Date.parse(c.confirmedAt) < FRESHNESS_MS).slice(-100); });
        return { report };
      } finally { clearTimeout(timer); controller.abort(); }
    };
    const promise = work();
    active.set(scope, { key, promise });
    try { return await promise; } finally { if (active.get(scope)?.promise === promise) active.delete(scope); }
  }
  async function confirm({ scope, planHash, selectionId, itemCode, sourceUrl, amount }) {
    const ctx = { ...await loadContext(scope), scope };
    assertCurrent(ctx, planHash);
    const selection = selectionsOf(ctx).find(s => s.selectionId === selectionId);
    const state = await readState();
    const report = state.reports[scope];
    if (!selection || !current(report, ctx) || !report.items.some(i => i.selectionId === selectionId && i.code === itemCode && i.status !== 'stop')) throw new ApiError('Run a current readiness check before confirming this item.', 409, 'PLAN_CHANGED');
    if (!MANUAL_CODES.includes(itemCode)) throw new ApiError('This item cannot be manually confirmed.', 400, 'BAD_INPUT');
    const confirmedAt = new Date(now()).toISOString();
    const confirmation = { scope, planHash, selectionId, itemCode, sourceUrl, ...(amount ? { amount } : {}), confirmedAt, fingerprint: selectionFingerprint(selection) };
    // Retain provider contradictions and all other unresolved items; acknowledgement never erases Stop.
    await mutateState(s => {
      if (s.reports[scope]?.id !== report.id) throw new ApiError('Readiness report changed.', 409, 'PLAN_CHANGED');
      s.confirmations = s.confirmations.filter(c => !(c.scope === scope && c.selectionId === selectionId && c.itemCode === itemCode) && now() - Date.parse(c.confirmedAt) < FRESHNESS_MS).concat(confirmation).slice(-100);
      report.items = applyConfirmations(report.items, s.confirmations, selectionsOf(ctx), planHash, now());
      report.verdict = verdictFor(report.items);
      s.reports[scope] = report;
    });
    return { report };
  }
  async function hotelRefresh({ scope, planHash, stayId }) {
    const ctx = { ...await loadContext(scope), scope };
    assertCurrent(ctx, planHash);
    const stay = ctx.stay.stays.find(s => s.id === stayId);
    if (!stay || stay.dataSource !== 'rooms.aero' || !stay.hotelId) throw new ApiError('An exact rooms.aero hotel selection is required.', 400, 'UNSUPPORTED_CHECK');
    if (refreshActive.has(stay.hotelId)) throw new ApiError('Hotel refresh is already requested.', 409, 'CHECK_IN_PROGRESS');
    refreshActive.add(stay.hotelId);
    try {
      const existing = refreshes.get(stay.hotelId);
      if (existing && now() - Date.parse(existing.receipt.requestedAt) < 86400000) return existing.receipt;
      const result = await refresh({ apiKey: ctx.settings?.seatsAeroApiKey, hotelId: stay.hotelId });
      refreshes.set(stay.hotelId, { receipt: result, checks: 0, baseline: stay.sourceUpdatedAt || null, status: 'queued' });
      if (refreshes.size > 20) refreshes.delete(refreshes.keys().next().value);
      await mutateState(s => { s.reports.trip = null; s.reports.stay = null; });
      return result;
    } finally { refreshActive.delete(stay.hotelId); }
  }
  async function hotelRefreshStatus({ scope, planHash, stayId }) {
    const ctx = { ...await loadContext(scope), scope };
    assertCurrent(ctx, planHash);
    const stay = ctx.stay.stays.find(s => s.id === stayId);
    if (!stay?.hotelId) throw new ApiError('An exact saved hotel is required.', 400, 'UNSUPPORTED_CHECK');
    const pending = refreshes.get(stay.hotelId);
    if (!pending || now() - Date.parse(pending.receipt.requestedAt) >= 86400000) return { status: 'unknown', requestedAt: pending?.receipt.requestedAt || null, nextCheckAfter: null, checksRemaining: 0 };
    const snapshot = () => ({ status: pending.status, requestedAt: pending.receipt.requestedAt, nextCheckAfter: pending.status === 'queued' && pending.checks < 3 ? pending.receipt.nextCheckAfter : null, checksRemaining: Math.max(0, 3 - pending.checks) });
    if (pending.status === 'completed' || pending.checks >= 3 || now() < Date.parse(pending.receipt.nextCheckAfter)) return snapshot();
    if (refreshActive.has(stay.hotelId)) return snapshot();
    refreshActive.add(stay.hotelId);
    try {
      pending.checks++;
      const result = await hotelCheck({ apiKey: ctx.settings?.seatsAeroApiKey, selection: stay, signal: AbortSignal.timeout(30000) });
      const observed = Date.parse(result.evidence?.observedAt);
      if (Number.isFinite(observed) && observed >= Date.parse(pending.receipt.requestedAt) && (!pending.baseline || observed > Date.parse(pending.baseline))) pending.status = 'completed';
      else if (pending.checks >= 3) pending.status = 'unknown';
      pending.receipt = { ...pending.receipt, nextCheckAfter: new Date(now() + 60000).toISOString() };
      return snapshot();
    } catch { if (pending.checks >= 3) pending.status = 'unknown'; return snapshot(); }
    finally { refreshActive.delete(stay.hotelId); }
  }
  return { check, get, confirm, hotelRefresh, hotelRefreshStatus };
}
