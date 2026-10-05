import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REFERENCE_DIR = path.join(ROOT, 'reference');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// Resolved lazily so Electron (and tests) can set POINTPILOT_DATA_DIR before first use.
export function dataDir() {
  return process.env.POINTPILOT_DATA_DIR ? path.resolve(process.env.POINTPILOT_DATA_DIR) : path.join(ROOT, 'data');
}
export const dataFile = name => path.join(dataDir(), name);
export const referenceFile = name => path.join(REFERENCE_DIR, name);
