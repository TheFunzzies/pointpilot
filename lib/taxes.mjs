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

/** { value, basis: 'route'|'program', count } or null when there is not enough history. */
export function estimateTaxes({ program, origin, destination, cabin }, history = []) {
  const p = programId(program) || program;
  const c = normalizeCabin(cabin);
  const seen = history.filter(h => h.program === p && Number(h.taxes) > 0 && (!c || !h.cabin || h.cabin === c) && h.product !== 'hotel');
  const route = seen.filter(h => h.origin === origin && h.destination === destination);
  const reverse = seen.filter(h => h.origin === destination && h.destination === origin);
  for (const [rows, basis] of [[route, 'route'], [reverse, 'route'], [seen, 'program']]) {
    if (rows.length >= 2) return { value: Math.round(median(rows.map(h => Number(h.taxes))) * 100) / 100, basis, count: rows.length };
  }
  return null;
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
