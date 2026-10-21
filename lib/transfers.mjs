// Transfer math for a single bank -> program edge: ratios, time-limited bonuses,
// minimums/increments and Marriott-style chunk bonuses.
import { programKind } from './programs.mjs';

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function bonusActive(edge, today = todayISO()) {
  if (!edge.bonusPct) return false;
  if (edge.bonusRolling && (!edge.bonusLastConfirmedAt || edge.bonusLastConfirmedAt.slice(0, 10) < today)) return false;
  return !edge.bonusEnds || edge.bonusEnds >= today;
}

/** Target points received per source point, including an active bonus. */
export function effectiveRatio(edge, today = todayISO()) {
  const [from, to] = edge.ratio;
  return (to / from) * (1 + (bonusActive(edge, today) ? edge.bonusPct : 0));
}

const DEFAULT_BANK = { minTransfer: 1000, increment: 1000 };

export function transferMeta(transfers, bank, edge = {}) {
  const b = transfers.banks?.[bank];
  return { ...DEFAULT_BANK, ...(typeof b === 'object' && b ? b : {}), ...edge };
}

// These official rules also correct legacy schema-2 files with a bank-wide bonus.
// https://www.marriott.com/en-gb/loyalty/redeem/travel/points-to-miles.mi
const MARRIOTT_EXCLUSIONS = new Set(['american', 'lifemiles', 'delta']);
export function chunkBonusFor(transfers, bank, program, edge) {
  if (bank === 'marriott' && MARRIOTT_EXCLUSIONS.has(program)) return null;
  if (Object.hasOwn(edge, 'chunkBonus')) return edge.chunkBonus || null;
  if (bank === 'marriott' && programKind(program) === 'airline') return { every: 60000, bonus: 5000 };
  return null;
}

/** Migrate old data and seed rules for routes newly added by the daily checker. */
export function applyPartnerRules(data) {
  if (data.banks?.marriott) delete data.banks.marriott.airlineChunkBonus;
  for (const [program, p] of Object.entries(data.programs || {})) {
    const edge = p.transfers?.marriott;
    if (!edge || programKind(program) !== 'airline') continue;
    if (MARRIOTT_EXCLUSIONS.has(program)) edge.chunkBonus = false;
    else if (!Object.hasOwn(edge, 'chunkBonus')) edge.chunkBonus = { every: 60000, bonus: 5000 };
  }
  return data;
}

/** Target points produced by transferring `source` points over this edge. */
export function targetFor(transfers, bank, program, edge, source, today) {
  if (source <= 0) return 0;
  let target = Math.floor(source * effectiveRatio(edge, today) + 1e-9);
  const chunk = chunkBonusFor(transfers, bank, program, edge);
  if (chunk) target += Math.floor(source / chunk.every) * chunk.bonus;
  return target;
}

const roundDown = (n, inc) => Math.floor(n / inc) * inc;

/**
 * Smallest valid transfer (respecting minimum and increment) that yields at least `targetNeeded`
 * points, capped by `available`. Returns { source, target } — target may be < targetNeeded when
 * the balance is insufficient — or null when no valid transfer is possible.
 */
export function planTransfer(transfers, bank, program, edge, targetNeeded, available, today) {
  const { minTransfer, increment } = transferMeta(transfers, bank, edge);
  if (!(Number.isFinite(increment) && increment > 0 && Number.isFinite(minTransfer) && minTransfer > 0 && Number.isFinite(available))) return null;
  const maxSource = roundDown(available, increment);
  if (targetNeeded <= 0 || !Number.isFinite(targetNeeded) || maxSource < minTransfer) return null;
  // Monotone binary search also handles chunk jumps without a balance-sized loop.
  let lo = Math.ceil(minTransfer / increment), hi = Math.floor(maxSource / increment);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (targetFor(transfers, bank, program, edge, mid * increment, today) >= targetNeeded) hi = mid;
    else lo = mid + 1;
  }
  const source = lo * increment;
  const target = targetFor(transfers, bank, program, edge, source, today);
  return target > 0 ? { source, target } : null;
}
