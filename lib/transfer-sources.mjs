// Parsers for public transfer-partner tables, and a consensus check against our data.
//   Roame         https://roame.travel/transfer-partners-cheat-sheet         (program × bank grid, incl. live bonuses)
//   Upgraded Pts  https://upgradedpoints.com/travel/transfer-partner-tool-calculator/  (bank, partner, ratio, time)
//   The Points Guy https://thepointsguy.com/credit-cards/credit-card-transfer-partners/ (grid + TPG valuations)
// Used by scripts/check-transfers.mjs, which runs daily on GitHub (not on users' computers).
import { PROGRAMS } from './programs.mjs';

export const SOURCES = {
  roame: { name: 'Roame', url: 'https://roame.travel/transfer-partners-cheat-sheet' },
  upgradedpoints: { name: 'Upgraded Points', url: 'https://upgradedpoints.com/travel/transfer-partner-tool-calculator/' },
  tpg: { name: 'The Points Guy', url: 'https://thepointsguy.com/credit-cards/credit-card-transfer-partners/' }
};

// ---------- helpers ----------
const text = html => String(html).replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;| /g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
const tables = html => [...String(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r => [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => text(c[1]))));
const key = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

const ALIASES = Object.entries(PROGRAMS)
  .flatMap(([id, p]) => [id, p.name, ...p.aliases].map(a => [key(a), id]))
  .filter(([a]) => a.length >= 4)
  .sort((a, b) => b[0].length - a[0].length);

/** Map a program/bank name as written on a site to our program id, or null. */
export function matchProgram(name) {
  const n = key(String(name).replace(/\blogo\b/i, '').replace(/\*/g, ''));
  if (!n) return null;
  if (PROGRAMS[n.replace(/ /g, '')]) return n.replace(/ /g, '');           // short ids: "IHG", "ANA"
  if (/^ihg\b/.test(n)) return 'ihg';
  for (const [a, id] of ALIASES) if (n === a || n.startsWith(`${a} `) || n.endsWith(` ${a}`) || n.includes(` ${a} `)) return id;
  return null;
}

/** "1:1", "5:4", "1:1.6", "2:1.5", "25:12", "3:1*" -> [from, to] */
export function parseRatio(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** "Instant", "~1 day", "Up to 48 hours", "2-3 weeks", "Up to 5 days" -> days (number) or null */
export function parseDays(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/instant|immediate/.test(t)) return 0;
  const n = [...t.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
  const v = n.length ? Math.max(...n) : null;
  if (v == null) return null;
  if (/week/.test(t)) return Math.round(v * 7);
  if (/hour/.test(t)) return Math.ceil(v / 24);
  if (/day/.test(t)) return Math.round(v);
  return null;
}
const parseBonus = s => { const m = String(s || '').match(/\+\s*(\d{1,3})\s*%/); return m ? Number(m[1]) / 100 : 0; };

// ---------- parsers: return [{ program, bank, programName, bankName, ratio, days, bonusPct }] ----------
export function parseRoame(html) {
  const grid = tables(html).find(t => t.length > 10 && /airline\/program/i.test(t[0]?.[0] || ''));
  if (!grid) return [];
  const banks = grid[0].map(h => h.replace(/\blogo\b/i, '').trim());
  const out = [];
  for (const row of grid.slice(1)) {
    const programName = row[0];
    for (let c = 5; c < row.length; c++) {
      const ratio = parseRatio(row[c]);
      if (!ratio) continue;
      out.push({ programName, bankName: banks[c], ratio, days: parseDays(row[c].replace(/^[\d.:*\s]+/, '')), bonusPct: parseBonus(row[c]) });
    }
  }
  return out;
}

export function parseUpgradedPoints(html) {
  const t = tables(html).find(x => /flexible points/i.test(x[0]?.[0] || '') && /ratio/i.test((x[0] || []).join(' ')));
  if (!t) return [];
  return t.slice(1).map(r => ({ bankName: r[0], programName: r[1], ratio: parseRatio(r[2]), days: parseDays(r[3]), bonusPct: parseBonus(r.join(' ')) })).filter(x => x.ratio);
}

export function parseTPG(html) {
  const edges = [], valuations = {};
  for (const t of tables(html).filter(x => /transfer partner|loyalty program/i.test(x[0]?.[0] || '') && /valuation/i.test(x[0]?.[1] || ''))) {
    const banks = t[0];
    for (const row of t.slice(1)) {
      const programName = row[0];
      const cents = Number((row[1] || '').match(/(\d+(?:\.\d+)?)\s*cents?/)?.[1]);
      if (cents) valuations[programName] = cents;
      for (let c = 2; c < row.length; c++) {
        const ratio = parseRatio(row[c]);
        if (ratio) edges.push({ programName, bankName: banks[c], ratio, days: null, bonusPct: parseBonus(row[c]) });
      }
    }
  }
  return { edges, valuations };
}

/** Attach our program ids; returns { edges, unmatched: [names] }. */
export function resolveEdges(raw) {
  const unmatched = new Set();
  const edges = [];
  for (const e of raw) {
    const program = matchProgram(e.programName), bank = matchProgram(e.bankName);
    if (!program) unmatched.add(e.programName);
    if (!bank) unmatched.add(e.bankName);
    if (program && bank && program !== bank) edges.push({ ...e, program, bank });
  }
  return { edges, unmatched: [...unmatched] };
}

// ---------- consensus ----------
const eff = r => Math.round((r[1] / r[0]) * 10000) / 10000;
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Compare our transfer data with the sources.
 * - ≥2 sources agree with us                → edge marked verified (unverified flag removed)
 * - ≥2 sources agree on a different ratio   → ratio auto-corrected
 * - ≥2 sources list a route we don't have   → route added
 * - a live bonus on Roame or ≥2 sources     → bonus applied with a rolling 7-day end date (re-confirmed daily)
 * - we have a route no source lists         → flagged unverified for review
 * Returns { data, changes, conflicts, report }.
 */
export function reconcile(current, bySource, { today, valuations = {} }) {
  const data = structuredClone(current);
  const changes = [], conflicts = [];
  const sourcesOk = Object.entries(bySource).filter(([, edges]) => edges.length > 20).map(([s]) => s);
  const covered = (src, prog, bank) => bySource[src].some(e => e.program === prog) && bySource[src].some(e => e.bank === bank);
  const pairs = new Map();
  for (const [src, edges] of Object.entries(bySource)) for (const e of edges) {
    if (!data.banks[e.bank]) continue;                 // only currencies PointPilot tracks
    const k = `${e.program}|${e.bank}`;
    if (!pairs.has(k)) pairs.set(k, {});
    pairs.get(k)[src] = e;
  }
  const label = (p, b) => `${data.banks[b]?.name || b} → ${data.programs[p]?.name || p}`;

  for (const [k, seen] of pairs) {
    const [prog, bank] = k.split('|');
    const ours = data.programs[prog]?.transfers?.[bank];
    const votes = new Map();
    for (const [src, e] of Object.entries(seen)) { const v = eff(e.ratio); if (!votes.has(v)) votes.set(v, []); votes.get(v).push(src); }
    const [topVal, topSrcs] = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const srcRatio = seen[topSrcs[0]].ratio;
    // Sources that publish data for this currency and this program at all (TPG / Upgraded Points
    // don't cover hotel currencies like Hyatt or Accor, so Roame alone speaks for those).
    const coveringBoth = Object.keys(bySource).filter(s => covered(s, prog, bank));
    const unanimous = topSrcs.length >= 1 && topSrcs.length === coveringBoth.length;
    if (ours) {
      const ourVal = eff(ours.ratio);
      const agree = votes.get(ourVal) || [];
      if (agree.length >= 2 || (agree.length >= 1 && agree.length === Object.keys(seen).length && agree.length === coveringBoth.length)) {
        ours.verifiedBy = agree.sort();
        if (ours.unverified) { delete ours.unverified; changes.push(`Verified ${label(prog, bank)} ${ours.ratio.join(':')} (${agree.join(', ')})`); }
      } else if ((topSrcs.length >= 2 || unanimous) && topVal !== ourVal) {
        changes.push(`Corrected ${label(prog, bank)}: ${ours.ratio.join(':')} → ${srcRatio.join(':')} (${topSrcs.join(', ')})`);
        ours.ratio = srcRatio; ours.verifiedBy = topSrcs.sort(); delete ours.unverified;
      } else {
        const missing = coveringBoth.filter(s => !seen[s]);
        conflicts.push(`${label(prog, bank)}: ours ${ours.ratio.join(':')}; ${Object.entries(seen).map(([s, e]) => `${s} ${e.ratio.join(':')}`).join(', ')}${missing.length ? `; not listed by ${missing.join(', ')}` : ''}`);
      }
      if (ours.days == null) { const d = Object.values(seen).map(e => e.days).find(x => x != null); if (d != null) ours.days = d; }
    } else if (topSrcs.length >= 2 || unanimous) {
      if (!data.programs[prog]) data.programs[prog] = { name: PROGRAMS[prog]?.name || prog, kind: PROGRAMS[prog]?.kind || 'airline', transfers: {} };
      const days = Object.values(seen).map(e => e.days).find(x => x != null) ?? 0;
      data.programs[prog].transfers[bank] = { ratio: srcRatio, days, verifiedBy: topSrcs.sort() };
      changes.push(`Added ${label(prog, bank)} ${srcRatio.join(':')} (${topSrcs.join(', ')})`);
    } else {
      conflicts.push(`Only ${topSrcs.join(', ')} lists ${label(prog, bank)} ${srcRatio.join(':')}; not added`);
    }

    // Bonuses: Roame tracks them closely; accept Roame alone or any two sources.
    const target = data.programs[prog]?.transfers?.[bank];
    const bonusSrcs = Object.entries(seen).filter(([, e]) => e.bonusPct > 0);
    if (target && (bonusSrcs.some(([s]) => s === 'roame') || bonusSrcs.length >= 2)) {
      const pct = bonusSrcs[0][1].bonusPct;
      const confirmedEnd = target.bonusEnds && !target.bonusRolling && target.bonusEnds >= today;
      if (!confirmedEnd) {
        if (target.bonusPct !== pct) changes.push(`Bonus ${label(prog, bank)}: +${Math.round(pct * 100)}% (${bonusSrcs.map(([s]) => s).join(', ')})`);
        Object.assign(target, { bonusPct: pct, bonusEnds: addDays(today, 7), bonusRolling: true });
      }
    }
  }

  // Routes we list that no source lists, although the sources cover both the bank and the program.
  for (const [prog, p] of Object.entries(data.programs)) for (const [bank, e] of Object.entries(p.transfers || {})) {
    if (pairs.has(`${prog}|${bank}`)) continue;
    const coveredBy = sourcesOk.filter(s => covered(s, prog, bank));
    if (coveredBy.length >= 2 && !e.unverified) { e.unverified = true; delete e.verifiedBy; changes.push(`Flagged ${label(prog, bank)}: not listed by ${coveredBy.join(', ')}`); }
  }

  // TPG valuations (cents per point) for programs we know.
  const vals = {};
  for (const [name, cents] of Object.entries(valuations)) { const id = matchProgram(name); if (id) vals[id] = cents; }
  if (Object.keys(vals).length) data.valuations = { source: 'The Points Guy', cents: vals };

  data.verification = { checkedAt: today, sources: Object.fromEntries(Object.entries(bySource).map(([s, e]) => [s, e.length])) };
  if (changes.length) data.lastUpdated = today;
  return { data, changes, conflicts };
}
