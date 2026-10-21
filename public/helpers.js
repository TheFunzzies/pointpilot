'use strict';
// Pure renderer helpers. Loaded as a classic script before app.js (exposes window.PPHelpers) and
// evaluated directly by tests/renderer-regressions.test.mjs, so keep it free of DOM access.
(function (root) {
  /** Request generations: only the newest request may write results. */
  function createGuard() {
    let gen = 0;
    let controller = null;
    return {
      /** Start a new request; aborts the previous one. */
      next() {
        gen += 1;
        if (controller) controller.abort();
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        return { gen, signal: controller?.signal };
      },
      /** Invalidate everything in flight without starting a new request. */
      cancel() { gen += 1; if (controller) controller.abort(); controller = null; },
      isCurrent(token) { return Boolean(token) && token.gen === gen; }
    };
  }

  /** Progressive "Show more" slicing with accurate counts. */
  function paginate(list, shown, step = 20) {
    const total = list.length;
    const count = Math.min(Math.max(Number(shown) || step, 0), total);
    return { items: list.slice(0, count), shown: count, total, remaining: total - count, nextStep: Math.min(step, total - count) };
  }

  /** Can this outbound/return pair be added to the Trip Builder? Server verdict and client chronology both count. */
  function pairAddability({ valid, invalidReason, clientConflict } = {}) {
    if (valid === false) return { ok: false, reason: invalidReason || 'These flights cannot be combined into one trip.' };
    if (clientConflict) return { ok: false, reason: clientConflict };
    return { ok: true, reason: null };
  }

  /** Keep only nonstop options when the original search was nonstop-only. */
  function nonstopFilter(options, directOnly) {
    if (!directOnly) return options;
    return options.filter(o => (o.flight ? o.flight.stops === 0 : o.direct !== false));
  }

  /** Body for /api/award/expand: carries the original search's nonstop constraint. */
  function expandBody({ awards, leg, travelers, directOnly }) {
    return { awards, leg, travelers, directOnly: Boolean(directOnly) };
  }

  /** How a monitor alert's last check should be presented. */
  function alertCheckState(a, runError) {
    const error = runError || (a.lastStatus === 'error' ? (a.lastError || 'Check failed') : null);
    if (error) return { kind: 'error', error, at: a.lastAttemptAt || a.lastCheckedAt || null };
    if (a.lastResult) return { kind: 'ok', matches: a.lastResult.matches, at: a.lastCheckedAt || a.lastAttemptAt || null };
    return { kind: 'none' };
  }

  /** Split a "Check all now" response into counts and an id→error map. */
  function summarizeRun(results) {
    const list = Array.isArray(results) ? results : [];
    const errors = {};
    for (const x of list) if (x && x.status === 'error') errors[x.id] = x.error || 'Check failed';
    return { total: list.length, failed: Object.keys(errors).length, fresh: list.filter(x => x && x.isNew).length, errors };
  }

  /** Text for the "more results exist" notice, or '' when the response was not truncated. */
  function truncationNotice(r) {
    if (!r || r.truncated !== true) return '';
    return r.truncatedReason ? `More results exist: ${r.truncatedReason}. Refine your search (dates, cabin, airports) to see them.` : 'More results exist than are shown. Refine your search (dates, cabin, airports) to see them.';
  }


  /** The awards a trip starts and ends with: the legacy pair when present, else the first and last canonical legs. */
  function tripEnds(p) {
    if (p.flights) return p.flights;
    const segs = p.segments || [];
    return { outbound: (segs[0] && segs[0].award) || null, return: segs.length > 1 ? (segs[segs.length - 1].award || null) : null };
  }

  /** Exact provenance a saved stay keeps (A.md / B.md / O2.md). Readiness checks and backups depend on it. */
  const STAY_PROVENANCE_KEYS = ['availabilityId', 'roomId', 'roomIdentity', 'pricedNights', 'pricedTotalPoints', 'pricedTotalCash', 'capturedAt', 'sourceUpdatedAt', 'observedAt', 'evidenceMethod', 'sourceUrl', 'totalTaxes', 'taxesMissing', 'taxesEstimate', 'taxesCurrency', 'feesMissing', 'feesEstimated', 'feesCurrency', 'awardFees'];
  /** The provenance fields a hotel search row actually has; nothing is invented or defaulted. */
  function stayProvenance(row) {
    const out = {};
    for (const key of STAY_PROVENANCE_KEYS) if (row && row[key] != null) out[key] = row[key];
    return out;
  }

  // ---------- group cash (O1): honest price wording ----------
  const GROUP_BASIS_LABEL = n => `Price returned for ${n} adults — basis unconfirmed`;
  const ONE_ADULT_LABEL = 'one-adult price × N — estimated, group availability not checked';

  /**
   * How to describe a cash fare. N=1 and fares without O1 metadata read exactly as before. For a group, a
   * price whose basis is unconfirmed is shown as returned, with its label, and is never presented as a
   * per-person or total claim. exact=false means: leave it out of savings and cents-per-point.
   */
  function fareQuote(f, travelers, money) {
    const n = Math.max(1, Number(travelers) || 1);
    const p = (f && f.pricing) || null;
    const unknownBasis = Boolean(p && p.amountBasis === 'unknown');
    const estimated = Boolean(p && p.estimated);
    const label = f && typeof f.pricingLabel === 'string' ? f.pricingLabel : '';
    const uncertain = n > 1 && (f.exactComparable === false || unknownBasis || estimated || Boolean(label));
    const oe = n > 1 && f.oneAdultEstimate && Number.isFinite(Number(f.oneAdultEstimate.amount)) ? f.oneAdultEstimate : null;
    const oneAdult = oe ? { amountText: money(oe.amount), label: oe.label || ONE_ADULT_LABEL } : null;
    const hasTotal = f.total != null && Number.isFinite(Number(f.total));
    if (!uncertain) return { uncertain: false, exact: true, price: f.price, caption: `per person${n > 1 && hasTotal ? ` · ${money(f.total)} for ${n}` : ''}`, label: '', oneAdult };
    if (unknownBasis || !estimated) return { uncertain: true, exact: false, price: f.price, caption: '', label: label || GROUP_BASIS_LABEL(n), oneAdult };
    return { uncertain: true, exact: false, price: f.price, caption: `per adult${hasTotal ? ` · ≈${money(f.total)} for ${n} (estimated)` : ''}`, label: label || ONE_ADULT_LABEL, oneAdult };
  }

  /**
   * Quote for the chosen fare of a cash comparison (/api/cash/itinerary). That response carries the returned
   * amount in pricing.amount (price/perTraveler/total are null for an unconfirmed group basis), so the amount,
   * the per-adult caption and any estimated group total all come from it, exactly as O1 specifies.
   */
  function comparisonQuote(r, travelers, money) {
    const amount = [r && r.pricing && r.pricing.amount, r && r.price, r && r.perTraveler, r && r.total].find(v => v != null && Number.isFinite(Number(v)));
    return fareQuote({ price: amount == null ? null : Number(amount), total: r.total, pricing: r.pricing, pricingLabel: r.pricingLabel, exactComparable: r.exactComparable, oneAdultEstimate: r.oneAdultEstimate }, travelers, money);
  }

  /** Savings and cents-per-point are only computed from exact prices. Older responses (undefined) are exact. */
  const isExactComparable = r => !r || r.exactComparable !== false;

  // ---------- multi-room hotels (O2) ----------
  const ROOM_LIMITS = { rooms: 4, adults: 8, children: 6, childAge: 17 };
  const DEFAULT_ROOM = { adults: 2, childrenText: '', roomType: 'standard' };

  /** "7, 3" -> [7, 3]; blank -> []; bad ages or more than six children -> an error message. */
  function parseChildAges(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: true, ages: [] };
    const parts = raw.split(/[\s,;]+/).filter(Boolean);
    if (parts.length > ROOM_LIMITS.children) return { ok: false, error: `At most ${ROOM_LIMITS.children} children per room.` };
    const ages = parts.map(Number);
    if (ages.some((a, i) => !/^\d{1,2}$/.test(parts[i]) || !Number.isInteger(a) || a < 0 || a > ROOM_LIMITS.childAge)) return { ok: false, error: `Child ages are whole numbers from 0 to ${ROOM_LIMITS.childAge}, such as "7, 3".` };
    return { ok: true, ages };
  }

  /** Room rows from the form -> the request. Nothing is ever split automatically; the default stays legacy. */
  function buildRooms(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > ROOM_LIMITS.rooms) return { ok: false, error: `Choose 1 to ${ROOM_LIMITS.rooms} rooms.` };
    const rooms = [];
    for (const [i, row] of rows.entries()) {
      const adults = Number(row.adults);
      if (!Number.isInteger(adults) || adults < 1 || adults > ROOM_LIMITS.adults) return { ok: false, error: `Room ${i + 1}: adults must be 1 to ${ROOM_LIMITS.adults}.` };
      const kids = parseChildAges(row.childrenText);
      if (!kids.ok) return { ok: false, error: `Room ${i + 1}: ${kids.error}` };
      if (!['standard', 'suite', 'any'].includes(row.roomType)) return { ok: false, error: `Room ${i + 1}: choose a room type.` };
      rooms.push({ adults, childrenAges: kids.ages, roomType: row.roomType });
    }
    const isDefault = rooms.length === 1 && rooms[0].adults === 2 && !rooms[0].childrenAges.length;
    return { ok: true, rooms, isDefault };
  }

  const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  /** Provider policy text can arrive HTML-escaped; undo only those five entities (the page escapes again when inserting). */
  const plainText = v => String(v ?? '').replace(/&(lt|gt|quot|#39|amp);/g, m => ENTITIES[m]);

  /** The lines a hotel row must show. Never says rooms are "available"; unknown stays unknown. */
  function roomSummary(h, fmt) {
    const R = h.roomEstimate && h.roomEstimate.rooms > 1 ? h.roomEstimate.rooms : 1;
    const lines = [];
    if (R > 1) {
      if (h.observedSingleRoomPoints != null) lines.push({ label: 'Observed award for one room', value: `${fmt(h.observedSingleRoomPoints)} pts` });
      lines.push({ label: h.roomEstimateLabel || `Estimated points for ${R} rooms`, value: `${fmt(h.estimatedPointsForRooms ?? h.totalPoints)} pts`, estimated: true });
    }
    const badges = [];
    if (R > 1 || h.inventoryStatus !== undefined) badges.push('Room inventory unknown');
    if (R > 1 || h.occupancyStatus !== undefined) badges.push(h.userEvidence ? 'Occupancy: user entered' : 'Occupancy unverified');
    // Unknown fees stay unknown: never shown as zero.
    if (h.feeStatus === 'unknown') badges.push('Award taxes and resort fees unknown');
    return { rooms: R, lines, badges, userEntered: Boolean(h.userEvidence) };
  }

  const isoDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  /** Program-confirmed details the user typed in. Everything is optional; filled items share one source and date. */
  function buildProgramEvidence(form, rooms) {
    const f = form || {};
    const source = String(f.source ?? '').trim(), date = String(f.date ?? '').trim();
    const blank = v => v === '' || v == null;
    const any = [f.roomCount, f.taxes, f.resortFee, f.cancellation].some(v => !blank(v)) || f.occupancyConfirmed || f.resortFeeWaived;
    if (!any) return { ok: true, evidence: null };
    if (!source || source.length > 120) return { ok: false, error: 'Say where you confirmed this (a short note, up to 120 characters).' };
    if (!isoDay(date)) return { ok: false, error: 'Enter the date you confirmed this.' };
    const currency = String(f.currency ?? 'USD').trim().toUpperCase();
    const amount = (v, what) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 1e7 ? { value: n } : { error: `${what} must be a number, 0 or more.` };
    };
    const ev = {};
    if (!blank(f.roomCount)) {
      const n = Number(f.roomCount);
      if (!Number.isInteger(n) || n < 1 || n > ROOM_LIMITS.rooms) return { ok: false, error: `Rooms confirmed must be a whole number from 1 to ${ROOM_LIMITS.rooms}.` };
      ev.roomCount = { value: n, source, date, currency: null };
    }
    if (f.occupancyConfirmed && Array.isArray(rooms) && rooms.length) ev.occupancy = { rooms, source, date, currency: null };
    if ((!blank(f.taxes) || !blank(f.resortFee)) && !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'Enter a three-letter currency code, such as USD.' };
    if (!blank(f.taxes)) {
      const t = amount(f.taxes, 'Taxes');
      if (t.error) return { ok: false, error: t.error };
      ev.taxes = { amount: t.value, source, date, currency };
    }
    if (!blank(f.resortFee) || f.resortFeeWaived) {
      let value = null;
      if (!blank(f.resortFee)) {
        const t = amount(f.resortFee, 'Resort fee');
        if (t.error) return { ok: false, error: t.error };
        value = t.value;
      }
      ev.resortFee = { amount: value, source, date, currency: /^[A-Z]{3}$/.test(currency) ? currency : null, waived: Boolean(f.resortFeeWaived) };
    }
    const text = String(f.cancellation ?? '').trim();
    if (text) {
      if (text.length > 500) return { ok: false, error: 'Cancellation notes are limited to 500 characters.' };
      ev.cancellation = { text, source, date, currency: null };
    }
    return { ok: true, evidence: Object.keys(ev).length ? ev : null };
  }

  const api = { createGuard, paginate, pairAddability, nonstopFilter, expandBody, alertCheckState, summarizeRun, truncationNotice, tripEnds, stayProvenance, STAY_PROVENANCE_KEYS, fareQuote, comparisonQuote, isExactComparable, parseChildAges, buildRooms, plainText, roomSummary, buildProgramEvidence, ROOM_LIMITS, DEFAULT_ROOM };
  root.PPHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
