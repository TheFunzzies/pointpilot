// Award taxes & carrier surcharges.
// seats.aero sometimes reports $0 or nothing for taxes, even for programs that add large surcharges
// (an international award always has at least some government taxes). When that happens PointPilot
// marks the taxes as missing and estimates them from taxes it has seen before for the same program —
// on the same route when possible, otherwise across the program.
import { programId, normalizeCabin } from './programs.mjs';

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

export function taxesMissing(value) {
  return !(Number(value) > 0);
}

// Flight observations with taxes, grouped by program and route (built once per history snapshot);
// program-wide medians are cached per cabin.
const INDEX = new WeakMap();
function programIndex(history) {
  let idx = INDEX.get(history);
  if (!idx) {
    idx = new Map();
    for (const h of history) {
      if (!(Number(h.taxes) > 0) || h.product === 'hotel') continue;
      if (!idx.has(h.program)) idx.set(h.program, { all: [], byRoute: new Map(), programMedian: new Map() });
      const g = idx.get(h.program);
      g.all.push(h);
      const k = `${h.origin}|${h.destination}`;
      if (!g.byRoute.has(k)) g.byRoute.set(k, []);
      g.byRoute.get(k).push(h);
    }
    INDEX.set(history, idx);
  }
  return idx;
}

const estimate = (rows, basis) => (rows.length >= 2 ? { value: Math.round(median(rows.map(h => Number(h.taxes))) * 100) / 100, basis, count: rows.length } : null);

/** { value, basis: 'route'|'program', count } or null when there is not enough history. */
export function estimateTaxes({ program, origin, destination, cabin }, history = []) {
  const p = programId(program) || program;
  const c = normalizeCabin(cabin);
  const g = programIndex(history).get(p);
  if (!g) return null;
  const inCabin = rows => (rows || []).filter(h => !c || !h.cabin || h.cabin === c);
  const byRoute = estimate(inCabin(g.byRoute.get(`${origin}|${destination}`)), 'route') || estimate(inCabin(g.byRoute.get(`${destination}|${origin}`)), 'route');
  if (byRoute) return byRoute;
  const key = c || '*';
  if (!g.programMedian.has(key)) g.programMedian.set(key, estimate(inCabin(g.all), 'program'));
  return g.programMedian.get(key);
}

/** Apply the missing-taxes rule to an award option in place; returns it. */
export function applyTaxes(option, history) {
  if (!taxesMissing(option.totalTaxes)) { option.taxesMissing = false; return option; }
  const est = estimateTaxes(option, history);
  option.reportedTaxes = option.totalTaxes ?? null;
  option.taxesMissing = true;
  option.taxesEstimate = est;
  option.totalTaxes = est ? est.value : null;   // used for costs; flagged "est." in the UI
  return option;
}
