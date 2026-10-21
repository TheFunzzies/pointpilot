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

  const api = { createGuard, paginate, pairAddability, nonstopFilter, expandBody, alertCheckState, summarizeRun, truncationNotice };
  root.PPHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
