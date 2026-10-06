// Run in CI before publishing. Fails fast on the mistakes that break auto-updates.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = fs.existsSync('package-lock.json') ? JSON.parse(fs.readFileSync('package-lock.json', 'utf8')) : null;
const fail = msg => { console.error(`release:check failed: ${msg}`); process.exit(1); };

const pub = pkg.build?.publish?.[0];
if (pub?.provider !== 'github' || pub.owner !== 'TheFunzzies' || pub.repo !== 'pointpilot') fail('build.publish must target github TheFunzzies/pointpilot');
if (!lock || !lock.packages?.['node_modules/electron-updater']) fail('package-lock.json is missing or incomplete — run `npm install` and commit it');
if (lock.version !== pkg.version) fail(`package-lock.json version ${lock.version} != package.json ${pkg.version}`);

// GITHUB_REF_NAME is the pushed tag, e.g. v0.6.0. electron-updater compares the release
// version with the installed app version, so they must match exactly.
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${pkg.version}`) fail(`tag ${tag} does not match package.json version v${pkg.version}`);

for (const f of ['reference/transfer-partners.json', 'desktop/icon.ico', 'build/icon.ico']) if (!fs.existsSync(f)) fail(`missing ${f}`);

console.log(`Release configuration OK: ${pub.owner}/${pub.repo} v${pkg.version}${tag ? ` (tag ${tag})` : ''}`);
