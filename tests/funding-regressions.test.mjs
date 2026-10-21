import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fundPrograms, FUNDING_LIMITS } from '../lib/optimizer.mjs';
import { targetFor, planTransfer } from '../lib/transfers.mjs';

const data = JSON.parse(readFileSync(new URL('../reference/transfer-partners.json', import.meta.url), 'utf8'));
const today = '2026-11-01';
const prefs = { preserveFlexiblePoints: false };

test('DOM-1: Marriott chunk bonus distinguishes eligible and excluded airline partners', () => {
  for (const p of ['american', 'lifemiles', 'delta', 'aeroplan']) {
    const edge = data.programs[p].transfers.marriott;
    assert.equal(targetFor(data, 'marriott', p, edge, 60000, today), p === 'aeroplan' ? 25000 : 20000, p);
    const legacy = { banks: { marriott: { minTransfer: 3000, increment: 3000, airlineChunkBonus: { every: 60000, bonus: 5000 } } } };
    assert.equal(targetFor(legacy, 'marriott', p, { ratio: [3, 1] }, 60000, today), p === 'aeroplan' ? 25000 : 20000, `legacy ${p}`);
    if (p !== 'aeroplan') assert.equal(fundPrograms({ [p]: 25000 }, [{ code: 'marriott', balance: 60000 }], data, prefs, today), null);
  }
});

test('DOM-1: edge-specific chunk rules and transfer increments override bank defaults', () => {
  const edge = { ratio: [3, 1], chunkBonus: { every: 60000, bonus: 10000 }, minTransfer: 3000, increment: 1000 };
  assert.deepEqual(planTransfer(data, 'marriott', 'united', edge, 30000, 100000, today), { source: 60000, target: 30000 });
  assert.equal(targetFor(data, 'marriott', 'aeroplan', { ...edge, chunkBonus: false }, 60000, today), 20000);
});

test('DOM-3: actual rounded cost selects Capital One over the nominally cheaper Chase', () => {
  const result = fundPrograms({ aeroplan: 1100 }, [{ code: 'chase', balance: 10000, cpp: 1 }, { code: 'capitalone', balance: 10000, cpp: 1.1 }], data, prefs, today);
  assert.ok(result);
  assert.equal(result.pointsCostUsd, 12.1);
  assert.deepEqual(result.sources.map(s => [s.from, s.fromPoints]), [['capitalone', 1100]]);
});

test('DOM-3: split transfers minimize rounded cost while reserving a shared source', () => {
  const graph = {
    banks: { chase: { minTransfer: 1000, increment: 1000 }, amex: { minTransfer: 1000, increment: 1000 } },
    programs: {
      aeroplan: { transfers: { chase: { ratio: [1, 1] }, amex: { ratio: [1, 1] } } },
      united: { transfers: { chase: { ratio: [1, 1] } } }
    }
  };
  const result = fundPrograms({ aeroplan: 4000, united: 2000 }, [{ code: 'chase', balance: 5000, cpp: 1 }, { code: 'amex', balance: 5000, cpp: 2 }], graph, prefs, today);
  assert.ok(result);
  assert.equal(result.pointsCostUsd, 70);
  assert.equal(result.sources.reduce((n, s) => n + (s.from === 'chase' ? s.fromPoints : 0), 0), 5000);
});

test('PERF-1: 12 funded and unfunded programs complete well below one second', () => {
  const programs = ['aeroplan', 'united', 'american', 'alaska', 'delta', 'flyingblue', 'ba', 'iberia', 'aerlingus', 'qatar', 'lifemiles', 'singapore'];
  const graph = { banks: { chase: { minTransfer: 1000, increment: 1000 }, amex: { minTransfer: 1000, increment: 1000 } }, programs: Object.fromEntries(programs.map(p => [p, { transfers: { chase: { ratio: [1, 1] }, amex: { ratio: [1, 1] } } }])) };
  const needs = Object.fromEntries(programs.map(p => [p, 1000]));
  const start = performance.now();
  const funded = fundPrograms(needs, [{ code: 'chase', balance: 20000, cpp: 1 }, { code: 'amex', balance: 20000, cpp: 2 }], graph, { ...prefs, maxTransfers: 12 }, today);
  assert.ok(funded);
  assert.equal(funded.pointsCostUsd, 120);
  assert.equal(fundPrograms(needs, [{ code: 'chase', balance: 20000 }], graph, prefs, today), null, 'transfer-count impossibility fails early');
  assert.equal(fundPrograms(needs, [{ code: 'chase', balance: 1000 }], graph, { ...prefs, maxTransfers: 12 }, today), null, 'shared balance impossibility is bounded');
  assert.ok(performance.now() - start < 500, '12-program scenarios should take less than 500ms');
  assert.ok(funded.fundingSearch.nodes <= FUNDING_LIMITS.nodes);
});

test('PERF-1: limits are explicit and bounded plans disclose incomplete cost search', () => {
  assert.equal(fundPrograms(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, 1])), [], data), null);
  const graph = { banks: { chase: { minTransfer: 1, increment: 1 }, amex: { minTransfer: 1, increment: 1 } }, programs: { aeroplan: { transfers: { chase: { ratio: [1, 1] }, amex: { ratio: [1, 1] } } } } };
  const result = fundPrograms({ aeroplan: 1000000 }, [{ code: 'chase', balance: 1000000, cpp: 1 }, { code: 'amex', balance: 1000000, cpp: 2 }], graph, prefs, today);
  assert.ok(result);
  assert.ok(result.fundingSearch.limited);
  assert.match(result.warnings.join(' '), /may not be the cheapest/);
  assert.ok(result.fundingSearch.nodes <= FUNDING_LIMITS.nodes + 1);
});

test('DOM-3: bounded solver matches an exhaustive oracle on small rounded portfolios', () => {
  let seed = 741;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let scenario = 0; scenario < 40; scenario++) {
    const bankNames = ['chase', 'amex'], programNames = ['aeroplan', 'united'];
    const graph = { banks: Object.fromEntries(bankNames.map(b => [b, { minTransfer: 2, increment: 1 }])), programs: {} };
    for (const p of programNames) graph.programs[p] = { transfers: Object.fromEntries(bankNames.map(b => [b, { ratio: [[1, 1], [2, 1], [1, 2]][random(3)], ...(random(2) ? { chunkBonus: { every: 4, bonus: 1 } } : {}) }])) };
    const balances = bankNames.map((b, i) => ({ code: b, balance: 2 + random(5), cpp: 1 + i }));
    const needs = Object.fromEntries(programNames.map(p => [p, 1 + random(7)]));
    const maxTransfers = 2 + random(3);
    let oracle = Infinity;
    for (let ca = 0; ca <= balances[0].balance; ca++) for (let cu = 0; cu <= balances[0].balance - ca; cu++) {
      for (let aa = 0; aa <= balances[1].balance; aa++) for (let au = 0; au <= balances[1].balance - aa; au++) {
        const values = [ca, cu, aa, au];
        if (values.some(n => n === 1) || values.filter(n => n > 0).length > maxTransfers) continue;
        const received = (p, c, a) => targetFor(graph, 'chase', p, graph.programs[p].transfers.chase, c, today) + targetFor(graph, 'amex', p, graph.programs[p].transfers.amex, a, today);
        if (received('aeroplan', ca, aa) < needs.aeroplan || received('united', cu, au) < needs.united) continue;
        oracle = Math.min(oracle, (ca + cu + 2 * (aa + au)) / 100);
      }
    }
    const actual = fundPrograms(needs, balances, graph, { ...prefs, maxTransfers }, today);
    if (oracle === Infinity) assert.equal(actual, null, `scenario ${scenario}`);
    else {
      assert.ok(actual, `scenario ${scenario}`);
      assert.ok(Math.abs(actual.pointsCostUsd - oracle) < 0.005, `scenario ${scenario}: got ${actual.pointsCostUsd}, expected ${oracle}`);
      assert.equal(actual.fundingSearch.limited, false);
    }
  }
});
