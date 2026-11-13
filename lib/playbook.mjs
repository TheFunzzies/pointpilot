// The playbook: points strategy that the major points sites repeat, matched to a search.
// reference/playbook.json holds the strategies (no fixed prices); live search supplies the numbers.
import { readFileSync } from 'node:fs';
import { referenceFile } from './paths.mjs';
import { describe } from './geo.mjs';
import { programId, programName } from './programs.mjs';
import { bonusActive } from './transfers.mjs';

const PLAYBOOK = JSON.parse(readFileSync(referenceFile('playbook.json'), 'utf8'));

const HAWAII = new Set(['HNL', 'OGG', 'KOA', 'LIH', 'ITO']);
const REGION_COUNTRIES = {
  japan: ['JP'],
  maldives: ['MV'],
  canada: ['CA'],
  mexico: ['MX'],
  oceania: ['AU', 'NZ', 'FJ', 'PF', 'NC', 'CK', 'WS', 'TO', 'VU', 'PG'],
  southasia: ['IN', 'LK', 'NP', 'BD', 'PK', 'BT'],
  middleeast: ['AE', 'QA', 'SA', 'OM', 'BH', 'KW', 'JO', 'IL', 'LB', 'TR', 'EG'],
  asia: ['CN', 'HK', 'MO', 'TW', 'KR', 'TH', 'VN', 'SG', 'MY', 'ID', 'PH', 'KH', 'LA', 'MM', 'BN', 'MN'],
  europe: ['GB', 'IE', 'FR', 'ES', 'PT', 'IT', 'DE', 'NL', 'BE', 'LU', 'CH', 'AT', 'DK', 'SE', 'NO', 'FI', 'IS', 'GR', 'HR', 'CZ', 'PL', 'HU', 'RO', 'BG', 'SI', 'SK', 'EE', 'LV', 'LT', 'MT', 'CY', 'RS', 'ME', 'AL', 'MK', 'BA', 'UA', 'MD', 'GE', 'AM', 'AZ'],
  southamerica: ['BR', 'AR', 'CL', 'PE', 'CO', 'EC', 'BO', 'UY', 'PY', 'VE', 'GY', 'SR'],
  centralamerica: ['CR', 'PA', 'GT', 'BZ', 'SV', 'HN', 'NI'],
  caribbean: ['BS', 'JM', 'DO', 'PR', 'CU', 'HT', 'BB', 'TT', 'LC', 'AG', 'KN', 'GD', 'VC', 'DM', 'AW', 'CW', 'SX', 'MF', 'BQ', 'KY', 'TC', 'VG', 'VI', 'BM', 'AI', 'GP', 'MQ', 'BL'],
  africa: ['ZA', 'KE', 'TZ', 'MA', 'ET', 'NG', 'GH', 'SN', 'RW', 'UG', 'NA', 'BW', 'ZM', 'ZW', 'MU', 'SC', 'MG', 'TN', 'DZ', 'CI', 'CM', 'AO', 'MZ']
};
const COUNTRY_REGION = new Map(Object.entries(REGION_COUNTRIES).flatMap(([region, list]) => list.map(c => [c, region])));

/** Regions a set of destination airports falls in, relative to where the trip starts. */
export function regionsFor(origins = [], destinations = []) {
  const home = new Set(origins.map(o => describe(o).countryCode).filter(Boolean));
  const out = new Set();
  for (const code of destinations) {
    const cc = describe(code).countryCode;
    if (HAWAII.has(String(code).toUpperCase())) out.add('hawaii');
    else if (cc && home.has(cc)) out.add('domestic');
    else if (COUNTRY_REGION.has(cc)) out.add(COUNTRY_REGION.get(cc));
  }
  return [...out];
}

/** Programs the wallet can pay with: held directly, or reachable by transfer from a held currency. */
export function reachablePrograms(balances = [], transfers = {}) {
  const held = new Set((balances || []).filter(b => Number(b.balance) > 0).map(b => programId(b.code) || programId(b.program)).filter(Boolean));
  const out = new Map(); // program -> [source ids]
  for (const id of held) out.set(id, [id]);
  for (const [program, def] of Object.entries(transfers.programs || {})) {
    const from = Object.keys(def.transfers || {}).filter(bank => held.has(bank));
    if (from.length) out.set(program, [...new Set([...(out.get(program) || []), ...from])]);
  }
  return out;
}

/** Time-limited transfer bonuses the wallet can use right now. */
export function activeBonuses(balances = [], transfers = {}, today) {
  const held = new Set((balances || []).filter(b => Number(b.balance) > 0).map(b => programId(b.code) || programId(b.program)).filter(Boolean));
  const out = [];
  for (const [program, def] of Object.entries(transfers.programs || {})) {
    for (const [bank, edge] of Object.entries(def.transfers || {})) {
      if (!held.has(bank) || !bonusActive(edge, today)) continue;
      out.push({ from: bank, fromName: transfers.banks?.[bank]?.name || programName(bank), to: program, toName: def.name || programName(program), bonusPct: Math.round(edge.bonusPct * 100), ends: edge.bonusRolling ? null : edge.bonusEnds || null });
    }
  }
  return out.sort((a, b) => b.bonusPct - a.bonusPct);
}

/**
 * Strategies that fit this search. Tips that need a program the wallet cannot reach are left out
 * (an empty wallet sees everything). Tips whose programs showed up in live results come first.
 */
export function adviceFor({ origins = [], destinations = [], cabin = 'economy', balances = [], transfers = {}, seenPrograms = [], limit = 4 } = {}) {
  const regions = regionsFor(origins, destinations);
  const reach = reachablePrograms(balances, transfers);
  const emptyWallet = reach.size === 0;
  const seen = new Set(seenPrograms);
  const name = id => transfers.banks?.[id]?.name || programName(id);
  const tips = PLAYBOOK.tips
    .filter(t => t.regions.some(r => regions.includes(r)) && t.cabins.includes(cabin))
    .map(t => {
      const usable = t.programs.filter(p => reach.has(p));
      if (t.programs.length && !usable.length && !emptyWallet) return null;
      const via = [...new Set(usable.flatMap(p => reach.get(p).filter(s => s !== p)))].map(name);
      return {
        id: t.id, title: t.title, text: t.text,
        programs: t.programs.map(p => ({ id: p, name: programName(p), reachable: reach.has(p) })),
        payWith: usable.length ? (via.length ? `Transfer from ${via.slice(0, 4).join(', ')}` : 'You already hold these miles') : null,
        live: t.programs.some(p => seen.has(p))
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.live) - Number(a.live))
    .slice(0, limit);
  return { regions, tips, rules: PLAYBOOK.rules, sources: PLAYBOOK.sources, lastUpdated: PLAYBOOK.lastUpdated };
}

export const playbook = () => PLAYBOOK;
