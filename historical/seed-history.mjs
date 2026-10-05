import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { recordPriceObservation } from '../scraper/price-history.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(await readFile(path.join(root, 'price-history-seed.json'), 'utf8'));
for (const row of rows) await recordPriceObservation(row);
console.log(`Seeded/updated ${rows.length} historical benchmark observations.`);
