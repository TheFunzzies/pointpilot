import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = f => readFileSync(path.join(pub, f), 'utf8');

// helpers.js is a classic browser script; evaluate it against a bare global like the browser would.
const sandbox = { AbortController };
vm.createContext(sandbox);
vm.runInContext(read('helpers.js'), sandbox);
// Results cross a vm realm boundary; normalize plain data so deepStrictEqual compares structure only.
const raw = sandbox.PPHelpers;
const H = Object.fromEntries(Object.entries(raw).map(([k, fn]) => [k, k === 'createGuard' ? fn : (...a) => { const r = fn(...a); return r && typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r; }]));

test('helpers.js exposes the renderer helpers', () => {
  for (const k of ['createGuard', 'paginate', 'pairAddability', 'nonstopFilter', 'expandBody', 'alertCheckState', 'summarizeRun', 'truncationNotice']) assert.equal(typeof H[k], 'function', k);
});

// ---- BUG-5: stale responses ----
test('request guard: only the newest request is current and older ones are aborted', () => {
  const g = H.createGuard();
  const a = g.next();
  assert.equal(g.isCurrent(a), true);
  const b = g.next();
  assert.equal(g.isCurrent(a), false, 'older request must be ignored');
  assert.equal(a.signal.aborted, true, 'older request must be aborted');
  assert.equal(g.isCurrent(b), true);
  assert.equal(b.signal.aborted, false);
  g.cancel();
  assert.equal(g.isCurrent(b), false, 'cancel (product switch) invalidates in-flight work');
  assert.equal(b.signal.aborted, true);
  assert.equal(g.isCurrent(null), false);
});

test('slow old response cannot overwrite a newer one', async () => {
  const g = H.createGuard();
  const shown = [];
  const run = async (label, ms) => {
    const t = g.next();
    await new Promise(r => setTimeout(r, ms));
    if (g.isCurrent(t)) shown.push(label);
  };
  await Promise.all([run('slow-old', 30), run('fast-new', 5)]);
  assert.deepEqual(shown, ['fast-new']);
});

// ---- UX-2: hotel pagination ----
test('paginate reports accurate visible/total counts and steps', () => {
  const rows = Array.from({ length: 40 }, (_, i) => i);
  let p = H.paginate(rows, 20, 20);
  assert.deepEqual([p.items.length, p.shown, p.total, p.remaining, p.nextStep], [20, 20, 40, 20, 20]);
  p = H.paginate(rows, 40, 20);
  assert.deepEqual([p.items.length, p.remaining, p.nextStep], [40, 0, 0]);
  p = H.paginate(rows.slice(0, 25), 20, 20);
  assert.deepEqual([p.shown, p.remaining, p.nextStep], [20, 5, 5]);
  assert.equal(H.paginate([], 20, 20).total, 0);
  // Filtering first, then paginating, keeps counts truthful across pages.
  const filtered = rows.filter(n => n % 2 === 0);
  p = H.paginate(filtered, 20, 20);
  assert.equal(p.total, 20);
  assert.equal(p.remaining, 0);
});

// ---- DOM-4: pair validity ----
test('pairAddability blocks server-invalid pairs and client chronology conflicts', () => {
  assert.deepEqual(H.pairAddability({}), { ok: true, reason: null });
  assert.deepEqual(H.pairAddability({ valid: true }), { ok: true, reason: null });
  const bad = H.pairAddability({ valid: false, invalidReason: 'Return is before outbound' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'Return is before outbound');
  assert.equal(H.pairAddability({ valid: false }).ok, false);
  assert.ok(H.pairAddability({ valid: false }).reason.length > 0, 'a default reason is always shown');
  const client = H.pairAddability({ clientConflict: 'Leaves before your outbound flight lands' });
  assert.equal(client.ok, false);
  assert.match(client.reason, /before your outbound/);
  // Server verdict wins over a client message; either one blocks.
  assert.equal(H.pairAddability({ valid: false, invalidReason: 'x', clientConflict: 'y' }).reason, 'x');
});

// ---- BUG-4: nonstop expansion ----
test('expand request carries directOnly and results are filtered to nonstop', () => {
  assert.deepEqual(H.expandBody({ awards: [1], leg: 'Outbound', travelers: 2, directOnly: true }), { awards: [1], leg: 'Outbound', travelers: 2, directOnly: true });
  assert.equal(H.expandBody({ awards: [], leg: 'Return', travelers: 1 }).directOnly, false);
  const opts = [{ id: 'a', flight: { stops: 0 } }, { id: 'b', flight: { stops: 1 } }, { id: 'c', direct: true }, { id: 'd', direct: false }, { id: 'e' }];
  assert.deepEqual(H.nonstopFilter(opts, true).map(o => o.id), ['a', 'c', 'e']);
  assert.equal(H.nonstopFilter(opts, false).length, 5);
});

// ---- BUG-6: monitor failures ----
test('alertCheckState distinguishes a failed check from a no-match result', () => {
  assert.equal(H.alertCheckState({}).kind, 'none');
  assert.deepEqual(H.alertCheckState({ lastResult: { matches: 0 }, lastCheckedAt: 'T' }), { kind: 'ok', matches: 0, at: 'T' });
  const failed = H.alertCheckState({ lastStatus: 'error', lastError: 'HTTP 500', lastAttemptAt: 'T2', lastResult: { matches: 3 }, lastCheckedAt: 'T1' });
  assert.deepEqual(failed, { kind: 'error', error: 'HTTP 500', at: 'T2' });
  assert.equal(H.alertCheckState({ lastStatus: 'error' }).error, 'Check failed');
  assert.equal(H.alertCheckState({ lastStatus: 'ok', lastResult: { matches: 1 } }).kind, 'ok');
  assert.equal(H.alertCheckState({ lastResult: { matches: 1 } }, 'boom').kind, 'error', 'a manual-run error overrides the stored result');
});

test('summarizeRun surfaces per-alert errors', () => {
  const s = H.summarizeRun([{ id: 'a', status: 'ok', isNew: true }, { id: 'b', status: 'error', error: 'timeout' }, { id: 'c', status: 'error' }, { id: 'd' }]);
  assert.equal(s.total, 4);
  assert.equal(s.failed, 2);
  assert.equal(s.fresh, 1);
  assert.deepEqual(s.errors, { b: 'timeout', c: 'Check failed' });
  assert.deepEqual(H.summarizeRun(undefined), { total: 0, failed: 0, fresh: 0, errors: {} });
});

// ---- BUG-3: truncation ----
test('truncationNotice only appears when the response says it was truncated', () => {
  assert.equal(H.truncationNotice({}), '');
  assert.equal(H.truncationNotice({ truncated: false }), '');
  assert.equal(H.truncationNotice(null), '');
  assert.match(H.truncationNotice({ truncated: true }), /refine your search/i);
  assert.match(H.truncationNotice({ truncated: true, truncatedReason: 'capped at 25 per direction' }), /capped at 25 per direction/);
});

// ---- static checks on the shipped renderer files ----
const app = read('app.js');
const html = read('index.html');
const css = read('styles.css');

test('index.html respects the CSP and loads helpers before app.js', () => {
  assert.ok(html.indexOf('/helpers.js') > -1 && html.indexOf('/helpers.js') < html.indexOf('/app.js'));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline scripts');
  assert.doesNotMatch(html, /\son(click|change|input|load|error|submit|keydown)\s*=/i, 'no inline handlers');
  assert.doesNotMatch(app, /\son(click|change|input)=["']/i, 'no inline handlers in rendered markup');
});

test('UX-3: settings no longer use inline grid-column spans; mobile resets them', () => {
  assert.doesNotMatch(html, /grid-column\s*:\s*span/i);
  assert.match(css, /\.formgrid > \.span-2/);
  const mobile = css.slice(css.indexOf('@media (max-width: 680px)'));
  assert.match(mobile, /\.span-2[^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

test('UX-1: flights are chosen with native radios inside a radiogroup, and focus is preserved', () => {
  assert.match(app, /type="radio" class="opt-radio"/);
  assert.match(app, /role="radiogroup"/);
  assert.match(app, /<label for=/);
  assert.match(app, /keepFocus\(/);
  assert.match(app, /input\.opt-radio/);
});

test('BUG-5/BUG-4/DOM-8 wiring in app.js', () => {
  assert.match(app, /searchGuard\.next\(\)/);
  assert.match(app, /isCurrent\(token\)/);
  assert.match(app, /\$\('searchBtn'\)\.disabled\) runSearch\(\)/, 'Enter must not search while the button is disabled');
  assert.match(app, /if \(prev !== b\.dataset\.product\) cancelSearch\(\)/);
  assert.match(app, /expandBody\(\{ awards: need, leg, travelers: result\.query\.travelers, directOnly \}\)/);
  assert.match(app, /state\.bestTrip !== t/, 'compareCash must drop stale responses');
  // ESTIMATED badge is driven purely by the row's estimated field.
  assert.match(app, /\$\{h\.estimated \? ' <span class="tag warn">ESTIMATED<\/span>' : ''\}/);
});

test('DOM-6: unfunded stay plans are not described as having prior stays deducted', () => {
  assert.match(app, /pn?.unfunded || r.unfunded/);
  assert.match(app, /totalPoints: h.totalPoints/, "exact stay totals are sent when adding a stay");
  assert.match(app, /not fully fundable/);
});
