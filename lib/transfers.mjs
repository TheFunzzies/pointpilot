// Transfer math for a single bank -> program edge: ratios, time-limited bonuses,
// minimums/increments and Marriott-style chunk bonuses.
import { programKind } from './programs.mjs';

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function bonusActive(edge, today = todayISO()) {
  if (!edge.bonusPct) return false;
  return !edge.bonusEnds || edge.bonusEnds >= today;
}

/** Target points received per source point, including an active bonus. */
export function effectiveRatio(edge, today = todayISO()) {
  const [from, to] = edge.ratio;
  return (to / from) * (1 + (bonusActive(edge, today) ? edge.bonusPct : 0));
}

const DEFAULT_BANK = { minTransfer: 1000, increment: 1000 };

function bankMeta(transfers, bank) {
  const b = transfers.banks?.[bank];
  return typeof b === 'object' && b ? { ...DEFAULT_BANK, ...b } : DEFAULT_BANK;
}

/** Target points produced by transferring `source` points over this edge. */
export function targetFor(transfers, bank, program, edge, source, today) {
  if (source <= 0) return 0;
  const meta = bankMeta(transfers, bank);
  let target = Math.floor(source * effectiveRatio(edge, today) + 1e-9);
  const chunk = meta.airlineChunkBonus;
  if (chunk && programKind(program) === 'airline') target += Math.floor(source / chunk.every) * chunk.bonus;
  return target;
}

const roundUp = (n, inc) => Math.ceil(n / inc) * inc;
const roundDown = (n, inc) => Math.floor(n / inc) * inc;

/**
 * Smallest valid transfer (respecting minimum and increment) that yields at least `targetNeeded`
 * points, capped by `available`. Returns { source, target } — target may be < targetNeeded when
 * the balance is insufficient — or null when no valid transfer is possible.
 */
export function planTransfer(transfers, bank, program, edge, targetNeeded, available, today) {
  const { minTransfer, increment } = bankMeta(transfers, bank);
  const maxSource = roundDown(available, increment);
  if (targetNeeded <= 0 || maxSource < minTransfer) return null;
  const ratio = effectiveRatio(edge, today);
  let source = Math.max(minTransfer, roundUp(Math.ceil(targetNeeded / ratio - 1e-9), increment));
  if (bankMeta(transfers, bank).airlineChunkBonus) {
    // Chunk bonuses can let a smaller transfer cover the need; step down while it still does.
    while (source - increment >= minTransfer && targetFor(transfers, bank, program, edge, source - increment, today) >= targetNeeded) source -= increment;
  }
  source = Math.min(source, maxSource);
  const target = targetFor(transfers, bank, program, edge, source, today);
  return target > 0 ? { source, target } : null;
}
