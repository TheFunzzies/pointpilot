import fs from 'node:fs';
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
if(pkg.build?.publish?.[0]?.provider!=='github')throw Error('GitHub publisher is not configured');
if(pkg.build.publish[0].owner!=='TheFunzzies'||pkg.build.publish[0].repo!=='pointpilot')throw Error('Unexpected GitHub release target');
console.log(`Release configuration OK for ${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo} v${pkg.version}`);
