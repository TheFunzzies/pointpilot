// Cross-checks reference/transfer-partners.json against Roame, Upgraded Points and The Points Guy.
//   node scripts/check-transfers.mjs          -> report only
//   node scripts/check-transfers.mjs --write  -> apply consensus changes + write the report
// Runs daily in .github/workflows/transfer-check.yml; installed apps pick up the result from main.
import { readFileSync, writeFileSync } from 'node:fs';
import { SOURCES, parseRoame, parseUpgradedPoints, parseTPG, resolveEdges, reconcile } from '../lib/transfer-sources.mjs';
import { validateTransferData } from '../lib/reference.mjs';

const FILE = new URL('../reference/transfer-partners.json', import.meta.url);
const REPORT = new URL('../reference/transfer-check.md', import.meta.url);
const write = process.argv.includes('--write');
const today = new Date().toISOString().slice(0, 10);

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PointPilot transfer check; +https://github.com/TheFunzzies/pointpilot)' }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

const bySource = {}, unmatched = {}, errors = {};
let valuations = {};
for (const [id, s] of Object.entries(SOURCES)) {
  try {
    const html = await get(s.url);
    const raw = id === 'roame' ? parseRoame(html) : id === 'upgradedpoints' ? parseUpgradedPoints(html) : (() => { const t = parseTPG(html); valuations = t.valuations; return t.edges; })();
    const r = resolveEdges(raw);
    if (r.edges.length < 20) throw new Error(`only ${r.edges.length} routes parsed — page layout may have changed`);
    bySource[id] = r.edges; unmatched[id] = r.unmatched;
  } catch (e) { errors[id] = e.message; }
}

const current = JSON.parse(readFileSync(FILE, 'utf8'));
if (Object.keys(bySource).length < 2) {
  console.error('Fewer than two sources available; nothing applied.', errors);
  process.exit(write ? 0 : 1);
}
const { data, changes, conflicts } = reconcile(current, bySource, { today, valuations });
const problem = validateTransferData(data);
if (problem) { console.error('Reconciled data failed validation:', problem); process.exit(1); }

const report = [
  `# Transfer partner check — ${today}`, '',
  `Sources: ${Object.entries(SOURCES).map(([id, s]) => `${s.name} (${bySource[id] ? `${bySource[id].length} routes` : `error: ${errors[id]}`})`).join(', ')}`, '',
  `## Changes applied (${changes.length})`, ...(changes.length ? changes.map(c => `- ${c}`) : ['- none']), '',
  `## Disagreements to review (${conflicts.length})`, ...(conflicts.length ? conflicts.map(c => `- ${c}`) : ['- none']), '',
  '## Names not mapped to a PointPilot program', ...Object.entries(unmatched).map(([s, n]) => `- ${s}: ${n.join(', ') || 'none'}`), ''
].join('\n');
console.log(report);
if (write) {
  writeFileSync(REPORT, report);
  if (changes.length || JSON.stringify(data.verification) !== JSON.stringify(current.verification)) writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`);
}
