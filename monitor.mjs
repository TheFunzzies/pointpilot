import { runMonitor } from './server.mjs';
const result = await runMonitor();
console.log(JSON.stringify(result, null, 2));
