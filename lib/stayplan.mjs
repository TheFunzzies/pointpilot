// Stay planner: a saved, multi-hotel itinerary (e.g. Tokyo Dec 7–9, then Kyoto Dec 9–11).
// All stays are funded together, because they draw on the same wallet.
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { programId, programName } from './programs.mjs';
import { fundPrograms, DEFAULT_PREFS } from './optimizer.mjs';
import { transferData } from './reference.mjs';
import { loadUser } from './settings.mjs';
import { isCalendarDate, parseFiniteNumber } from './validate.mjs';
import { programKind } from './programs.mjs';
import { normalizeStayPlan } from './itinerary.mjs';
import { ApiError } from './errors.mjs';
export { normalizeStayPlan } from './itinerary.mjs';

const FILE = () => dataFile('stay-plan.json');
const isoDate = isCalendarDate;
const nightsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const bad = m => new ApiError(m, 400, 'INVALID_INPUT');
const nextRevision = p => parseFiniteNumber(p.revision + 1, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, name: 'revision' });

export async function addStay(b) {
  if (!b?.name) throw bad('Hotel name is required.');
  if (!isoDate(b.checkIn) || !isoDate(b.checkOut) || b.checkOut <= b.checkIn) throw bad('Valid check-in and check-out dates are required.');
  const program = programId(b.program);
  if (programKind(program) !== 'hotel') throw bad('Choose a recognized hotel program.');
  const nightlyPoints = parseFiniteNumber(b.nightlyPoints, { min: 1, max: 1e9, integer: true, name: 'nightlyPoints' });
  const cashPerNight = b.cashPerNight == null || b.cashPerNight === '' ? null : parseFiniteNumber(b.cashPerNight, { min: 0, max: 1e7, name: 'cashPerNight' });
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
    nightlyPoints, totalPoints: b.totalPoints != null ? parseFiniteNumber(b.totalPoints, { min: 1, max: 1e10, integer: true, name: 'totalPoints' }) : nightlyPoints * nights,
    cashPerNight: b.rooms?.length > 1 ? null : cashPerNight,
    cashUsd: cashPerNight != null && !(b.rooms?.length > 1) ? cashPerNight * nights : null,
    bookingUrl: /^https:\/\//i.test(String(b.bookingUrl || '')) ? b.bookingUrl : null,
    dataSource: b.dataSource || null,
    estimated: Boolean(b.estimated),
    addedAt: new Date().toISOString()
  };
  for (const key of ['availabilityId','roomId','roomIdentity','pricedNights','pricedTotalPoints','pricedTotalCash','capturedAt','sourceUpdatedAt','observedAt','evidenceMethod','sourceUrl','totalTaxes','taxesMissing','taxesEstimate','taxesCurrency','feesMissing','feesEstimated','feesCurrency','awardFees']) if (b[key] != null) stay[key] = structuredClone(b[key]);
  stay.occupancySchemaVersion = 1;
  stay.rooms = b.rooms == null ? [{ adults: 2, childrenAges: [], roomType: stay.roomType === 'suite' ? 'suite' : 'standard' }] : structuredClone(b.rooms);
  stay.inventoryStatus = b.inventoryStatus || 'unknown';
  stay.occupancyStatus = b.occupancyStatus || 'unverified';
  stay.programEvidence = b.programEvidence == null ? null : structuredClone(b.programEvidence);
  await updateJson(FILE(), { stays: [] }, raw => {
    const plan = normalizeStayPlan(raw, { strict: false, allowOversizedLegacy: true });
    if (plan.stays.length >= 20) throw new ApiError('At most twenty stays are supported; remove a stay first.', 400, 'STAY_LIMIT');
    return normalizeStayPlan({ schemaVersion: 2, revision: nextRevision(plan), stays: [...plan.stays, stay] });
  });
  return getPlan();
}

export async function removeStay(id) {
  await updateJson(FILE(), { stays: [] }, raw => {
    const plan = normalizeStayPlan(raw, { strict: false, allowOversizedLegacy: true });
    return { schemaVersion: 2, revision: nextRevision(plan), stays: plan.stays.filter(s => s.id !== id) };
  });
  return getPlan();
}

export async function clearPlan() {
  await updateJson(FILE(), { stays: [] }, raw => ({ schemaVersion: 2, revision: nextRevision(normalizeStayPlan(raw, { strict: false, allowOversizedLegacy: true })), stays: [] }));
  return getPlan();
}

/**
 * Wallet balances left after paying for the stays already in the plan, so each new hotel card
 * shows what you could still afford. Returns { balances, committed: [{ from, points }], stays }.
 */
export async function balancesAfterPlan(user) {
  const plan = normalizeStayPlan(await readJson(FILE(), { stays: [] }), { strict: false, allowOversizedLegacy: true });
  if (plan.stays.length > 20 || plan.migrationWarnings?.length) return { balances: null, needs: {}, committed: [], stays: plan.stays.length, unfunded: true };
  if (!plan.stays.length) return { balances: user.balances, needs: {}, committed: [], stays: 0, unfunded: false };
  const needs = {};
  for (const s of plan.stays) needs[s.program] = (needs[s.program] || 0) + s.totalPoints;
  const funding = fundPrograms(needs, user.balances, transferData(), { ...DEFAULT_PREFS, ...(user.preferences || {}) });
  if (!funding) return { balances: null, needs, committed: [], stays: plan.stays.length, unfunded: true };
  const used = {};
  for (const s of funding.sources) used[s.from] = (used[s.from] || 0) + s.fromPoints;
  const ledger = new Map();
  for (const b of user.balances) {
    const id = programId(b.code) || b.code;
    const prev = ledger.get(id);
    ledger.set(id, { ...b, code: id, balance: (prev?.balance || 0) + Number(b.balance || 0) });
  }
  for (const [id, points] of Object.entries(used)) {
    const b = ledger.get(id);
    if (b) b.balance = Math.max(0, b.balance - points);
  }
  const credits = {};
  for (const source of funding.sources) credits[source.targetProgram] = (credits[source.targetProgram] || 0) + source.targetPoints;
  for (const [id, points] of Object.entries(credits)) {
    const residue = Math.max(0, points - (needs[id] || 0));
    if (!residue) continue;
    if (!ledger.has(id)) ledger.set(id, { code: id, balance: 0 });
    ledger.get(id).balance += residue;
  }
  return {
    balances: [...ledger.values()], needs, unfunded: false,
    committed: Object.entries(used).map(([from, points]) => ({ from, points })),
    stays: plan.stays.length
  };
}

export async function getPlan({ includeFunding = true } = {}) {
  const plan = normalizeStayPlan(await readJson(FILE(), { stays: [] }), { strict: false, allowOversizedLegacy: true });
  const stays = plan.stays.slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  const warnings = [...(plan.migrationWarnings || [])];
  for (let i = 1; i < stays.length; i++) {
    const prev = stays[i - 1], cur = stays[i];
    if (cur.checkIn > prev.checkOut) warnings.push(`Gap: no hotel for ${nightsBetween(prev.checkOut, cur.checkIn)} night(s) between ${prev.checkOut} and ${cur.checkIn}.`);
    if (cur.checkIn < prev.checkOut) warnings.push(`Overlap: ${cur.name} starts ${cur.checkIn}, before ${prev.name} ends ${prev.checkOut}.`);
  }
  const needs = {};
  for (const s of stays) needs[s.program] = (needs[s.program] || 0) + s.totalPoints;
  const user = await loadUser();
  const funding = includeFunding && stays.length && stays.length <= 20 && !plan.migrationWarnings?.length ? fundPrograms(needs, user.balances, transferData(), { ...DEFAULT_PREFS, ...(user.preferences || {}) }) : null;
  const allCash = stays.length && stays.every(s => s.cashUsd);
  const totalPoints = stays.reduce((s, x) => s + x.totalPoints, 0);
  return {
    schemaVersion: 2, revision: plan.revision, migrationWarnings: plan.migrationWarnings || [],
    stays,
    unfunded: Boolean(stays.length && !funding),
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
      unfunded: Boolean(stays.length && !funding),
      warnings
    }
  };
}
