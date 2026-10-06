// Portfolio-aware funding for a whole trip.
//
// Units used throughout:
//   points/mileageCost  per traveler, per leg (as programs price them)
//   taxes, cashValue    USD per traveler, per leg
//   cpp                 cents per point (user's valuation of each currency)
import { programId, programName, programKind } from './programs.mjs';
import { planTransfer, bonusActive, todayISO } from './transfers.mjs';

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

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(p => [x, ...p]));
}

/**
 * Decide which balances pay for each program's total requirement.
 * needs: { programId: targetPointsNeeded }
 * Returns null when the portfolio can't cover it.
 */
export function fundPrograms(needs, balances, transfers, prefsIn = {}, today = todayISO()) {
  const prefs = { ...DEFAULT_PREFS, ...prefsIn };
  const w = wallet(balances);
  const programs = Object.keys(needs).filter(p => needs[p] > 0);

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

  // 2. Shared bank balances are allocated program by program. Trying every program order
  //    (≤ 24 for 4 programs) avoids the classic greedy failure where a cheap bank is spent on
  //    one program and the other program is left with no route at all.
  //    Two edge orderings are tried: cheapest-first, and "consolidate" (prefer one bank that can
  //    cover the whole remainder) which keeps the number of transfers down.
  let best = null;
  for (const strategy of ['cheapest', 'consolidate'])
  for (const order of permutations(programs.filter(p => remainingNeed[p] > 0))) {
    const avail = { ...left };
    const moves = [];
    let ok = true;
    for (const p of order) {
      let need = remainingNeed[p];
      const edges = Object.entries(transfers.programs?.[p]?.transfers || {})
        .map(([bank, edge]) => ({ bank, edge, ratio: (edge.ratio[1] / edge.ratio[0]) * (1 + (bonusActive(edge, today) ? edge.bonusPct : 0)) }))
        .filter(x => (avail[x.bank] || 0) > 0)
        .map(x => ({ ...x, cost: unitCost(x.bank, x.edge, x.ratio), capacity: avail[x.bank] * x.ratio }));
      if (strategy === 'cheapest') edges.sort((a, b) => a.cost - b.cost);
      else edges.sort((a, b) => ((b.capacity >= need) - (a.capacity >= need)) || (a.capacity >= need ? a.cost - b.cost : b.capacity - a.capacity));
      for (const { bank, edge } of edges) {
        if (need <= 0) break;
        const plan = planTransfer(transfers, bank, p, edge, need, avail[bank], today);
        if (!plan) continue;
        avail[bank] -= plan.source;
        need -= plan.target;
        moves.push({ from: bank, fromPoints: plan.source, targetProgram: p, targetPoints: plan.target, ratio: edge.ratio, bonusPct: bonusActive(edge, today) ? edge.bonusPct : 0, bonusEnds: bonusActive(edge, today) ? edge.bonusEnds || null : null, days: edge.days || 0, unverified: Boolean(edge.unverified) });
      }
      if (need > 0) { ok = false; break; }
    }
    if (!ok) continue;
    const count = new Set(moves.map(m => `${m.from}>${m.targetProgram}`)).size;
    if (count > prefs.maxTransfers) continue;
    const cost = moves.reduce((s, m) => s + m.fromPoints * unitCost(m.from, m, 1), 0) / 100;
    // Cheaper wins; on a (near) tie, fewer transfers wins.
    if (!best || cost < best.cost - 0.005 || (Math.abs(cost - best.cost) <= 0.005 && count < best.count)) best = { cost, moves, count };
  }
  if (!best && programs.some(p => remainingNeed[p] > 0)) return null;
  const moves = best?.moves || [];
  const distinctTransfers = new Set(moves.map(m => `${m.from}>${m.targetProgram}`)).size;

  const sources = [
    ...programs.filter(p => direct[p] > 0).map(p => ({ from: p, fromPoints: direct[p], targetProgram: p, targetPoints: direct[p], direct: true })),
    ...moves
  ];
  const pointsCostUsd = sources.reduce((s, x) => s + x.fromPoints * cppOf(w, x.from, prefs) / 100, 0);
  const warnings = [];
  for (const m of moves) {
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
    warnings
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
