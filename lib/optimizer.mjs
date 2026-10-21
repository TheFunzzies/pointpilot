// Portfolio-aware funding for a whole trip.
//
// Units used throughout:
//   points/mileageCost  per traveler, per leg (as programs price them)
//   taxes, cashValue    USD per traveler, per leg
//   cpp                 cents per point (user's valuation of each currency)
import { programId, programName, programKind } from './programs.mjs';
import { planTransfer, bonusActive, todayISO, targetFor, transferMeta, effectiveRatio, chunkBonusFor } from './transfers.mjs';

export const DEFAULT_PREFS = {
  defaultCpp: 1.5,          // value for currencies without a user-set cpp
  preserveFlexiblePoints: true,
  flexPremiumCpp: 0.25,     // extra cost per bank point when preserving flexible points
  maxTransfers: 3,          // distinct bank -> program transfers allowed for one trip
  maxTransferDays: 3,       // slower transfers are penalized (seat may disappear)
  slowTransferPenaltyCpp: 0.4,
  preferNonstop: false,
  nonstopPenaltyUsd: 75     // per connecting leg when preferNonstop is on
};

function wallet(balances) {
  const out = {};
  for (const b of balances || []) {
    const id = programId(b.code) || programId(b.program);
    if (!id) continue;
    const prev = out[id];
    out[id] = { id, balance: Math.max(0, Number(b.balance) || 0) + (prev?.balance || 0), cpp: Number.isFinite(Number(b.cpp)) && Number(b.cpp) > 0 ? Number(b.cpp) : prev?.cpp ?? null };
  }
  return out;
}

const cppOf = (w, id, prefs) => w[id]?.cpp ?? prefs.defaultCpp;

// Hard resource limits apply independently of wallet size or caller preferences.
export const FUNDING_LIMITS = Object.freeze({ programs: 32, sources: 32, nodes: 12000, amountsPerEdge: 128 });

/**
 * Decide which balances pay for each program's total requirement.
 * needs: { programId: targetPointsNeeded }
 * Returns null when the portfolio can't cover it.
 */
export function fundPrograms(needs, balances, transfers, prefsIn = {}, today = todayISO()) {
  const prefs = { ...DEFAULT_PREFS, ...prefsIn };
  const w = wallet(balances);
  const programs = Object.keys(needs).filter(p => needs[p] > 0);
  if (programs.length > FUNDING_LIMITS.programs || Object.keys(w).length > FUNDING_LIMITS.sources ||
      Object.values(needs).some(n => !Number.isSafeInteger(n) || n < 0)) return null;

  // 1. Miles already sitting in the target program are used first: they can't fund anything else.
  const direct = {};
  const remainingNeed = {};
  const left = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v.balance]));
  for (const p of programs) {
    direct[p] = Math.min(left[p] || 0, needs[p]);
    left[p] = (left[p] || 0) - direct[p];
    remainingNeed[p] = needs[p] - direct[p];
  }

  const unitCost = (bank, edge, ratio) => {
    let c = cppOf(w, bank, prefs);
    if (prefs.preserveFlexiblePoints && programKind(bank) === 'bank') c += prefs.flexPremiumCpp;
    if ((edge.days || 0) > prefs.maxTransferDays) c += prefs.slowTransferPenaltyCpp;
    return c / ratio;
  };

  // 2. Search actual rounded transfer amounts, reserving shared balances across programs.
  // Constrained programs go first. Capacity and optimistic cost bounds prune impossible or
  // more expensive branches; no permutations are created. Large searches return the best
  // verified plan found within the fixed budget, with an explicit warning.
  const pending = programs.filter(p => remainingNeed[p] > 0);
  const maxTransfers = Math.min(FUNDING_LIMITS.programs * FUNDING_LIMITS.sources,
    Math.max(0, Math.floor(Number(prefs.maxTransfers) || 0)));
  if (pending.length > maxTransfers) return null;
  const routes = Object.fromEntries(pending.map(p => [p, Object.entries(transfers.programs?.[p]?.transfers || {})
    .filter(([bank, edge]) => left[bank] > 0 && Array.isArray(edge.ratio) && edge.ratio.every(n => Number.isFinite(n) && n > 0))
    .map(([bank, edge]) => ({ bank, edge, price: unitCost(bank, edge, 1) / 100 }))]));
  const capacity = (p, r, avail) => planTransfer(transfers, r.bank, p, r.edge, Number.MAX_SAFE_INTEGER, avail[r.bank] || 0, today)?.target || 0;
  if (pending.some(p => routes[p].reduce((s, r) => s + capacity(p, r, left), 0) < remainingNeed[p])) return null;
  pending.sort((a, b) => routes[a].length - routes[b].length || remainingNeed[b] - remainingNeed[a]);
  const avail = { ...left }, moves = [];
  let best = null;
  let nodes = 0, limited = false;
  const optimisticCost = (p, need, edges) => {
    const prices = edges.filter(r => avail[r.bank] > 0).map(r => {
      const chunk = chunkBonusFor(transfers, r.bank, p, r.edge);
      return r.price / (effectiveRatio(r.edge, today) + (chunk ? chunk.bonus / chunk.every : 0));
    });
    return need * Math.min(...prices);
  };
  function visit(index, need, edges, edgeIndex, cost) {
    if (++nodes > FUNDING_LIMITS.nodes) { limited = true; return; }
    if (need <= 0) {
      index++;
      if (index === pending.length) {
        const count = moves.length;
        if (!best || cost < best.cost - 0.005 || (Math.abs(cost - best.cost) <= 0.005 && count < best.count)) best = { cost, moves: moves.slice(), count };
        return;
      }
      need = remainingNeed[pending[index]];
      edges = null;
      edgeIndex = 0;
    }
    const p = pending[index];
    if (moves.length + pending.length - index > maxTransfers) return;
    if (!edges) {
      // Compare real rounded cost, including minimums, increments and chunk bonuses.
      edges = routes[p].slice().sort((a, b) => {
        const pa = planTransfer(transfers, a.bank, p, a.edge, need, avail[a.bank], today);
        const pb = planTransfer(transfers, b.bank, p, b.edge, need, avail[b.bank], today);
        return (pa ? pa.source * a.price / Math.min(need, pa.target) : Infinity) -
          (pb ? pb.source * b.price / Math.min(need, pb.target) : Infinity);
      });
    }
    const rest = edges.slice(edgeIndex);
    if (rest.reduce((s, r) => s + capacity(p, r, avail), 0) < need) return;
    let lower = optimisticCost(p, need, rest);
    for (let j = index + 1; j < pending.length; j++) {
      const next = pending[j];
      if (routes[next].reduce((s, r) => s + capacity(next, r, avail), 0) < remainingNeed[next]) return;
      lower += optimisticCost(next, remainingNeed[next], routes[next]);
    }
    if (best && (cost + lower > best.cost + 0.005 ||
        (cost + lower >= best.cost - 0.005 && moves.length + pending.length - index >= best.count))) return;
    const route = edges[edgeIndex];
    if (!route) return;
    const { bank, edge, price } = route;
    const plan = planTransfer(transfers, bank, p, edge, need, avail[bank], today);
    if (plan) {
      const { minTransfer, increment } = transferMeta(transfers, bank, edge);
      // Smaller amounts cannot help if all later edges together leave a shortfall.
      const laterCapacity = edges.slice(edgeIndex + 1).reduce((s, r) => s + capacity(p, r, avail), 0);
      const required = planTransfer(transfers, bank, p, edge, Math.max(1, need - laterCapacity), avail[bank], today);
      const min = Math.max(Math.ceil(minTransfer / increment) * increment, required?.source || 0);
      const amounts = new Set([plan.source, min]);
      const steps = Math.round((plan.source - min) / increment);
      if (steps < FUNDING_LIMITS.amountsPerEdge) {
        for (let n = min; n <= plan.source; n += increment) amounts.add(n);
      } else {
        limited = true;
        // Include exact reservation boundaries for every later program sharing this source.
        for (let j = index + 1; j < pending.length; j++) {
          const next = pending[j], r = routes[next].find(r => r.bank === bank);
          const reserve = r && planTransfer(transfers, bank, next, r.edge, remainingNeed[next], avail[bank], today);
          if (reserve) amounts.add(Math.floor((avail[bank] - reserve.source) / increment) * increment);
        }
        const samples = FUNDING_LIMITS.amountsPerEdge - amounts.size;
        for (let n = 1; n <= samples; n++) amounts.add(min + Math.floor(steps * n / (samples + 1)) * increment);
      }
      for (const source of [...amounts].filter(n => n >= min && n <= plan.source).sort((a, b) => b - a)) {
        if (nodes >= FUNDING_LIMITS.nodes) { limited = true; break; }
        const target = targetFor(transfers, bank, p, edge, source, today);
        avail[bank] -= source;
        moves.push({ from: bank, fromPoints: source, targetProgram: p, targetPoints: target, ratio: edge.ratio, bonusPct: bonusActive(edge, today) ? edge.bonusPct : 0, bonusEnds: bonusActive(edge, today) ? edge.bonusEnds || null : null, days: edge.days || 0, unverified: Boolean(edge.unverified) });
        visit(index, need - target, edges, edgeIndex + 1, cost + source * price);
        moves.pop();
        avail[bank] += source;
      }
    }
    if (nodes < FUNDING_LIMITS.nodes) visit(index, need, edges, edgeIndex + 1, cost);
    else limited = true;
  }
  if (pending.length) visit(0, remainingNeed[pending[0]], null, 0, 0);
  if (!best && programs.some(p => remainingNeed[p] > 0)) return null;
  const chosenMoves = best?.moves || [];
  const distinctTransfers = chosenMoves.length;

  const sources = [
    ...programs.filter(p => direct[p] > 0).map(p => ({ from: p, fromPoints: direct[p], targetProgram: p, targetPoints: direct[p], direct: true })),
    ...chosenMoves
  ];
  const pointsCostUsd = sources.reduce((s, x) => s + x.fromPoints * cppOf(w, x.from, prefs) / 100, 0);
  const warnings = [];
  if (limited) warnings.push('Funding search reached its supported search limits; this valid plan may not be the cheapest available.');
  for (const m of chosenMoves) {
    if (m.days > prefs.maxTransferDays) warnings.push(`${programName(m.from)} → ${programName(m.targetProgram)} can take ~${m.days} days; the seat may be gone by then.`);
    if (m.unverified) warnings.push(`${programName(m.from)} → ${programName(m.targetProgram)} ratio is unverified — confirm before transferring.`);
    if (m.bonusEnds) warnings.push(`Uses a ${Math.round(m.bonusPct * 100)}% transfer bonus ending ${m.bonusEnds}.`);
  }
  return {
    sources,
    totalTargetPoints: Object.values(needs).reduce((s, n) => s + n, 0),
    totalSourcePoints: sources.reduce((s, x) => s + x.fromPoints, 0),
    overshootPoints: sources.reduce((s, x) => s + x.targetPoints, 0) - Object.values(needs).reduce((s, n) => s + n, 0),
    transfers: distinctTransfers,
    pointsCostUsd,
    warnings,
    fundingSearch: { limited, nodes, limits: FUNDING_LIMITS }
  };
}

/**
 * Evaluate a trip (one or more legs) for `travelers` people.
 * Each leg: { leg, program|source, mileageCost, totalTaxes (USD), cashValue (USD|null), direct, ... }
 */
export function evaluateTrip(legs, { travelers = 1, balances = [], transfers, prefs: prefsIn = {}, today = todayISO() }) {
  const prefs = { ...DEFAULT_PREFS, ...prefsIn };
  const pax = Math.max(1, Math.round(Number(travelers) || 1));
  const needs = {};
  for (const leg of legs) {
    const p = programId(leg.program) || programId(leg.source);
    const pts = Math.round(Number(leg.mileageCost));
    if (!p || !(pts > 0)) return null;
    needs[p] = (needs[p] || 0) + pts * pax;
  }
  const funding = fundPrograms(needs, balances, transfers, prefs, today);
  if (!funding) return null;

  const taxesUsd = legs.reduce((s, l) => s + (Number(l.totalTaxes) || 0), 0) * pax;
  const allCash = legs.every(l => Number(l.cashValue) > 0);
  const cashUsd = allCash ? legs.reduce((s, l) => s + Number(l.cashValue), 0) * pax : null;
  const effectiveCostUsd = funding.pointsCostUsd + taxesUsd;
  const cpp = cashUsd ? ((cashUsd - taxesUsd) / Math.max(1, funding.totalSourcePoints)) * 100 : null;
  const connecting = legs.filter(l => l.direct === false).length;
  const penaltyUsd = prefs.preferNonstop ? connecting * prefs.nonstopPenaltyUsd : 0;

  return {
    legs: legs.map(l => {
      const p = programId(l.program) || programId(l.source);
      return { ...l, program: p, programName: programName(p), pointsPerTraveler: Math.round(Number(l.mileageCost)), points: Math.round(Number(l.mileageCost)) * pax };
    }),
    travelers: pax,
    ...funding,
    taxesUsd,
    cashUsd,
    effectiveCostUsd,
    netValueUsd: cashUsd != null ? cashUsd - effectiveCostUsd : null,
    cpp,
    nonstopLegs: legs.length - connecting,
    score: -(effectiveCostUsd + penaltyUsd)
  };
}

export function rankTrips(trips, mode = 'overall') {
  const by = {
    overall: (a, b) => b.score - a.score,
    points: (a, b) => a.totalSourcePoints - b.totalSourcePoints || b.score - a.score,
    cpp: (a, b) => (b.cpp ?? -Infinity) - (a.cpp ?? -Infinity) || b.score - a.score,
    nonstop: (a, b) => b.nonstopLegs - a.nonstopLegs || b.score - a.score,
    seat: (a, b) => (b.seatScore ?? -1) - (a.seatScore ?? -1) || b.score - a.score,
    duration: (a, b) => (a.totalDurationMin ?? Infinity) - (b.totalDurationMin ?? Infinity) || b.score - a.score
  }[mode] || ((a, b) => b.score - a.score);
  return trips.slice().sort(by);
}

export function explainTrip(t) {
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const parts = t.sources.map(s => s.direct
    ? `${fmt(s.fromPoints)} ${programName(s.from)} miles you already have`
    : `${fmt(s.fromPoints)} ${programName(s.from)} → ${fmt(s.targetPoints)} ${programName(s.targetProgram)}`);
  let text = `For ${t.travelers} traveler${t.travelers > 1 ? 's' : ''}: ${parts.join('; ')}. Points valued at $${fmt(t.pointsCostUsd)} plus $${fmt(t.taxesUsd)} taxes/fees = $${fmt(t.effectiveCostUsd)} effective cost.`;
  if (t.cashUsd) text += ` Cash fare ≈ $${fmt(t.cashUsd)} (${t.cpp.toFixed(2)}¢/pt).`;
  if (t.overshootPoints > 0) text += ` Transfer increments leave ${fmt(t.overshootPoints)} extra points in the airline account.`;
  return text;
}
