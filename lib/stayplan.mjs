// Stay planner: a saved, multi-hotel itinerary (e.g. Tokyo Dec 7–9, then Kyoto Dec 9–11).
// All stays are funded together, because they draw on the same wallet.
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { programId, programName } from './programs.mjs';
import { fundPrograms, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { loadUser } from './settings.mjs';

const FILE = () => dataFile('stay-plan.json');
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const bad = m => Object.assign(new Error(m), { status: 400 });

export async function addStay(b) {
  if (!b?.name) throw bad('Hotel name is required.');
  if (!isoDate(b.checkIn) || !isoDate(b.checkOut) || b.checkOut <= b.checkIn) throw bad('Valid check-in and check-out dates are required.');
  const program = programId(b.program) || String(b.program || '').toLowerCase();
  const nightlyPoints = Math.round(Number(b.nightlyPoints) || 0);
  if (!program || !(nightlyPoints > 0)) throw bad('Program and points per night are required.');
  const nights = nightsBetween(b.checkIn, b.checkOut);
  const stay = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: String(b.name).slice(0, 120), hotelId: b.hotelId || null,
    program, programName: programName(program),
    city: String(b.city || '').slice(0, 80), location: String(b.location || '').slice(0, 160),
    category: b.category ? String(b.category).slice(0, 20) : null,
    roomType: String(b.roomType || 'standard'),
    checkIn: b.checkIn, checkOut: b.checkOut, nights,
    nightlyPoints, totalPoints: nightlyPoints * nights,
    cashPerNight: Number(b.cashPerNight) > 0 ? Number(b.cashPerNight) : null,
    cashUsd: Number(b.cashPerNight) > 0 ? Number(b.cashPerNight) * nights : null,
    bookingUrl: /^https:\/\//i.test(String(b.bookingUrl || '')) ? b.bookingUrl : null,
    dataSource: b.dataSource || null,
    estimated: Boolean(b.estimated),
    addedAt: new Date().toISOString()
  };
  await updateJson(FILE(), { stays: [] }, plan => { plan.stays.push(stay); });
  return getPlan();
}

export async function removeStay(id) {
  await updateJson(FILE(), { stays: [] }, plan => { plan.stays = plan.stays.filter(s => s.id !== id); });
  return getPlan();
}

export async function clearPlan() {
  await updateJson(FILE(), { stays: [] }, () => ({ stays: [] }));
  return getPlan();
}

export async function getPlan() {
  const plan = await readJson(FILE(), { stays: [] });
  const stays = plan.stays.slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  const warnings = [];
  for (let i = 1; i < stays.length; i++) {
    const prev = stays[i - 1], cur = stays[i];
    if (cur.checkIn > prev.checkOut) warnings.push(`Gap: no hotel for ${nightsBetween(prev.checkOut, cur.checkIn)} night(s) between ${prev.checkOut} and ${cur.checkIn}.`);
    if (cur.checkIn < prev.checkOut) warnings.push(`Overlap: ${cur.name} starts ${cur.checkIn}, before ${prev.name} ends ${prev.checkOut}.`);
  }
  const needs = {};
  for (const s of stays) needs[s.program] = (needs[s.program] || 0) + s.totalPoints;
  const user = await loadUser();
  const funding = stays.length ? fundPrograms(needs, user.balances, transferData(), { ...DEFAULT_PREFS, ...(user.preferences || {}) }) : null;
  const allCash = stays.length && stays.every(s => s.cashUsd);
  const totalPoints = stays.reduce((s, x) => s + x.totalPoints, 0);
  return {
    stays,
    summary: {
      stays: stays.length,
      nights: stays.reduce((s, x) => s + x.nights, 0),
      start: stays[0]?.checkIn || null,
      end: stays.length ? stays.reduce((m, s) => (s.checkOut > m ? s.checkOut : m), stays[0].checkOut) : null,
      pointsByProgram: Object.entries(needs).map(([program, points]) => ({ program, programName: programName(program), points })),
      totalPoints,
      cashUsd: allCash ? stays.reduce((s, x) => s + x.cashUsd, 0) : null,
      cpp: allCash && totalPoints ? (stays.reduce((s, x) => s + x.cashUsd, 0) * 100) / totalPoints : null,
      nextCheckIn: stays.length ? stays[stays.length - 1].checkOut : null,
      funding,
      affordable: stays.length ? Boolean(funding) : null,
      warnings
    }
  };
}
