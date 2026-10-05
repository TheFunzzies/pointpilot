import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repoUrl = pkg.repository?.url || '';
if (!repoUrl.includes('github.com/')) throw new Error('GitHub repository is not configured. Run: npm run configure-github -- <owner> pointpilot');
if (pkg.build?.publish?.[0]?.provider !== 'github') throw new Error('electron-builder GitHub publisher is not configured.');
let branch = '';
try { branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf8' }).trim(); } catch {}
if (branch && branch !== 'main') console.warn(`Warning: current branch is ${branch}, release workflow expects tags pushed from the repository.`);
console.log(`Release configuration OK for ${repoUrl}`);
