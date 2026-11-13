// Opportunities: things worth acting on right now, independent of any one search.
//   bonus  — a time-limited transfer bonus from a currency the wallet holds
//   buy    — a saved buy-points offer priced well below what those points are worth
//   expiry — tracked points that expire within 90 days
// The monitor notifies once for each new bonus or good buy.
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { getSettings, loadUser } from './settings.mjs';
import { transferData } from './reference.mjs';
import { activeBonuses } from './playbook.mjs';
import { programId, programName } from './programs.mjs';
import { todayISO } from './transfers.mjs';

const FILE = () => dataFile('opportunities.json');
/** A buy offer is "good" at 20% below the points' value and "great" at 35% below. */
export const BUY_THRESHOLDS = Object.freeze({ good: 0.8, great: 0.65 });

export function valueCents(program, balances = [], transfers = {}, fallback = null) {
  const own = (balances || []).find(b => (programId(b.code) || programId(b.program)) === program);
  if (own && Number(own.cpp) > 0) return { cents: Number(own.cpp), source: 'your value' };
  const v = transfers.valuations?.cents?.[program];
  return v ? { cents: v, source: transfers.valuations.source || 'published valuation' } : fallback ? { cents: fallback, source: 'default value' } : null;
}

export function listOpportunities({ user, settings, transfers, today = todayISO() }) {
  const out = [];
  for (const b of activeBonuses(user.balances, transfers, today)) {
    out.push({ id: `bonus:${b.from}:${b.to}:${b.bonusPct}:${b.ends || 'open'}`, kind: 'bonus', notify: true, title: `${b.bonusPct}% transfer bonus: ${b.fromName} → ${b.toName}`,
      text: `${b.ends ? `Ends ${b.ends}. ` : ''}Every search already counts this bonus. Transfer only for a booking you have found; transfers cannot be reversed.`, ends: b.ends });
  }
  for (const o of settings.buyPointsOffers || []) {
    if (o.offerEnds && o.offerEnds < today) continue;
    const value = valueCents(o.program, user.balances, transfers);
    if (!value) continue;
    const ratio = o.pricePerPointCents / value.cents;
    const rating = ratio <= BUY_THRESHOLDS.great ? 'great' : ratio <= BUY_THRESHOLDS.good ? 'good' : 'poor';
    const pct = Math.round((1 - ratio) * 100);
    out.push({ id: `buy:${o.program}:${o.pricePerPointCents}:${o.offerEnds || 'open'}`, kind: 'buy', rating, notify: rating !== 'poor', url: o.offerUrl || null, ends: o.offerEnds || null,
      title: rating === 'poor' ? `Buying ${programName(o.program)} is not a deal` : `${rating === 'great' ? 'Great' : 'Good'} price to buy ${programName(o.program)}`,
      text: rating === 'poor'
        ? `${o.pricePerPointCents}¢ per point against a value of ${value.cents}¢ (${value.source}). Only buy to top up for a specific award.`
        : `${o.pricePerPointCents}¢ per point is ${pct}% below their ${value.cents}¢ value (${value.source})${o.offerEnds ? `, until ${o.offerEnds}` : ''}. Best used when you have an award in mind; programs can change prices without notice.` });
  }
  for (const e of settings.pointExpirations || []) {
    const days = Math.ceil((Date.parse(`${e.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    if (days < 0 || days > 90) continue;
    out.push({ id: `expiry:${e.id}`, kind: 'expiry', notify: false, title: `${Number(e.points).toLocaleString('en-US')} ${programName(e.program)} points expire in ${days} day${days === 1 ? '' : 's'}`, text: e.note || 'Use them, or check what activity extends them.', ends: e.expiresOn });
  }
  return out;
}

export async function currentOpportunities() {
  const [user, settings] = await Promise.all([loadUser(), getSettings()]);
  return { opportunities: listOpportunities({ user, settings, transfers: transferData() }) };
}

/** Notify once for each new transfer bonus or good buy-points price. Returns what was announced. */
export async function checkOpportunityAlerts(notifier, settings) {
  if (!notifier || settings.desktopNotifications === false) return [];
  const user = await loadUser();
  const items = listOpportunities({ user, settings, transfers: transferData() }).filter(o => o.notify);
  const seen = new Set((await readJson(FILE(), { notified: [] })).notified || []);
  const fresh = items.filter(o => !seen.has(o.id));
  if (!fresh.length) return [];
  await notifier({ title: fresh.length === 1 ? fresh[0].title : `${fresh.length} new points opportunities`, body: fresh.slice(0, 3).map(o => (fresh.length === 1 ? o.text : o.title)).join(' · ') });
  await updateJson(FILE(), { notified: [] }, s => ({ notified: [...fresh.map(o => o.id), ...(s.notified || [])].slice(0, 300) }));
  return fresh;
}
