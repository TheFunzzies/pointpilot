let chromium = null;
async function getChromium() {
  if (chromium) return chromium;
  try { chromium = (await import('playwright')).chromium; return chromium; }
  catch { throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium'); }
}
import { getProvider } from './provider-registry.mjs';
import { normalizeAward, normalizeHotel } from './normalize.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(ROOT);
const CAPTURE_DIR = path.join(PROJECT_ROOT, 'data', 'captures');
const AUTHORIZED = new Set(String(process.env.AUTHORIZED_DIRECT_PROVIDERS || '').split(',').map(s => s.trim()).filter(Boolean));
const ENABLED = String(process.env.DIRECT_CONNECTORS_ENABLED || 'true').toLowerCase() !== 'false';
const HEADLESS = String(process.env.PLAYWRIGHT_HEADLESS || 'false').toLowerCase() === 'true';
const PROFILE_DIR = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(PROJECT_ROOT, 'data', 'browser-profile');

function challengeDetected(text) {
  return /(captcha|recaptcha|hcaptcha|access denied|verify you are human|unusual traffic|robot check|blocked)/i.test(text || '');
}

async function launch() {
  await fs.mkdir(CAPTURE_DIR, { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  return (await getChromium()).launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1440, height: 1000 }
  });
}

function assertAllowed(provider) {
  if (!ENABLED) throw new Error('Direct connectors are disabled by configuration.');
  if (provider.mode !== 'authorized') {
    const e = new Error(`${provider.name}: direct automation is disabled because this provider requires permission/approved access. Use manual capture or an approved API/partner feed.`);
    e.code = 'PROVIDER_RESTRICTED';
    throw e;
  }
  if (!AUTHORIZED.has(provider.id)) {
    const e = new Error(`${provider.name}: add the provider ID to AUTHORIZED_DIRECT_PROVIDERS only after you have authorization to automate it.`);
    e.code = 'PROVIDER_NOT_AUTHORIZED';
    throw e;
  }
}

export async function capturePage({ providerId, url }) {
  const provider = getProvider(providerId);
  const context = await launch();
  try {
    const page = await context.newPage();
    await page.goto(url || provider.homepage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText().catch(() => '');
    if (challengeDetected(text)) {
      const e = new Error(`${provider.name}: a CAPTCHA, access-denied, or bot-check page was detected. PointPilot will not attempt to bypass it.`);
      e.code = 'CHALLENGE_DETECTED';
      throw e;
    }
    const html = await page.content();
    const file = path.join(CAPTURE_DIR, `${provider.id}-${Date.now()}.html`);
    await fs.writeFile(file, html, 'utf8');
    return { provider: provider.id, file, title: await page.title(), url: page.url() };
  } finally {
    await context.close();
  }
}

export async function scrapeAuthorizedAwards({ providerId, url }) {
  const provider = getProvider(providerId);
  assertAllowed(provider);
  const context = await launch();
  try {
    const page = await context.newPage();
    await page.goto(url || provider.homepage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (challengeDetected(bodyText)) {
      const e = new Error(`${provider.name}: challenge detected; scrape stopped without bypass.`);
      e.code = 'CHALLENGE_DETECTED';
      throw e;
    }
    const s = provider.selectors;
    const results = await page.locator(s.result).evaluateAll((els, s) => els.map(el => {
      const q = key => el.querySelector(s[key])?.textContent || '';
      return {
        origin: q('origin'), destination: q('destination'), date: q('date'), program: q('program'),
        cabin: q('cabin'), points: q('points'), taxes: q('taxes'), seats: q('seats'),
        airline: q('airline'), flightNumbers: q('flightNumbers')
      };
    }), s);
    return results.map(r => provider.product === 'hotel' ? normalizeHotel(r, provider.id) : normalizeAward(r, provider.id));
  } finally {
    await context.close();
  }
}

export async function manualCapture({ providerId, url }) {
  const provider = getProvider(providerId);
  const context = await (await getChromium()).launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1440, height: 1000 }
  });
  try {
    const page = await context.newPage();
    await page.goto(url || provider.homepage, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`\n${provider.name} opened in a browser.`);
    console.log('Complete the normal search yourself in that browser window.');
    console.log('When the results page is visible, return here and press ENTER.');
    await new Promise(resolve => process.stdin.once('data', resolve));
    const text = await page.locator('body').innerText().catch(() => '');
    if (challengeDetected(text)) {
      throw new Error('A challenge/access-denied page was detected. Capture aborted.');
    }
    const html = await page.content();
    const file = path.join(CAPTURE_DIR, `${provider.id}-manual-${Date.now()}.html`);
    await fs.writeFile(file, html, 'utf8');
    console.log(`Saved browser capture: ${file}`);
    return file;
  } finally {
    await context.close();
    process.stdin.pause();
  }
}
