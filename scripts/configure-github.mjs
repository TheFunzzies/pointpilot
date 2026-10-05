import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const owner = process.argv[2] || process.env.POINTPILOT_GITHUB_OWNER;
const repo = process.argv[3] || process.env.POINTPILOT_GITHUB_REPO || 'pointpilot';

if (!owner) {
  console.error('Usage: npm run configure-github -- <github-owner> [repo]');
  console.error('Example: npm run configure-github -- yourusername pointpilot');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.repository = { type: 'git', url: `https://github.com/${owner}/${repo}.git` };
pkg.homepage = `https://github.com/${owner}/${repo}`;
pkg.build = pkg.build || {};
pkg.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release', publishAutoUpdate: true }];
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Configured PointPilot releases/updates for https://github.com/${owner}/${repo}`);
console.log('Commit this package.json change before creating the first release.');
