import { manualCapture } from './direct-scraper.mjs';

const providerId = process.argv[2];
if (!providerId) {
  console.error('Usage: npm run capture -- american');
  process.exit(1);
}

try {
  await manualCapture({ providerId });
} catch (e) {
  console.error(`Capture failed: ${e.message}`);
  process.exit(1);
}
