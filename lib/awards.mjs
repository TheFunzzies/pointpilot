// Local award inventory: rows fetched from seats.aero plus awards the user entered manually.
// Award space disappears quickly, so every row carries capturedAt and is aged out.
import { dataFile } from './paths.mjs';
import { readJson, updateJson } from './store.mjs';
import { programId, normalizeCabin } from './programs.mjs';
import { todayISO } from './transfers.mjs';

const FILE = () => dataFile('award-cache.json');
const HOUR = 3600 * 1000;
export const AGE_LIMITS = { apiHours: 24, manualHours: 24 * 14 };

const num = (v, d = null) => (v === null || v === undefined || v === '' ? d : Number.isFinite(Number(v)) ? Number(v) : d);

export function normalizeFlightAward(r) {
  const program = programId(r.program) || programId(r.source) || String(r.program || r.source || '').toLowerCase();
  const row = {
    product: 'flight',
    dataSource: r.dataSource || 'manual',
    program,
    origin: String(r.origin || '').trim().toUpperCase(),
    destination: String(r.destination || '').trim().toUpperCase(),
    date: String(r.date || '').slice(0, 10),
    cabin: normalizeCabin(r.cabin) || 'business',
    mileageCost: Math.round(num(r.mileageCost, 0)),   // per traveler
    totalTaxes: num(r.totalTaxes),                    // USD per traveler
    cashValue: num(r.cashValue) || null,              // USD per traveler
    remainingSeats: num(r.remainingSeats) || null,    // null = unknown
    direct: typeof r.direct === 'boolean' ? r.direct : null,
    airlines: r.airlines || null,
    flightNumbers: r.flightNumbers || null,
    capturedAt: r.capturedAt || new Date().toISOString(),
    sourceUpdatedAt: r.sourceUpdatedAt || null,
    sourceUrl: r.sourceUrl || null
  };
  row.id = r.id || `${row.dataSource}:${row.program}:${row.origin}-${row.destination}:${row.date}:${row.cabin}` +
    (row.dataSource === 'manual' ? `:${row.mileageCost}` : '');
  return row;
}

export function normalizeHotelAward(r) {
  const row = {
    product: 'hotel',
    dataSource: r.dataSource || 'manual',
    program: programId(r.program) || programId(r.provider) || String(r.program || '').toLowerCase(),
    name: String(r.name || '').trim(),
    location: String(r.location || '').trim(),
    checkIn: String(r.checkIn || '').slice(0, 10),
    roomType: String(r.roomType || 'standard').toLowerCase(),
    nightlyPoints: Math.round(num(r.nightlyPoints, 0)),
    cashValue: num(r.cashValue) || null,              // USD per night
    capturedAt: r.capturedAt || new Date().toISOString()
  };
  row.id = r.id || `${row.dataSource}:hotel:${row.program}:${row.name}:${row.checkIn}:${row.roomType}`.toLowerCase();
  return row;
}

function expired(row, now = Date.now(), today = todayISO()) {
  const date = row.product === 'hotel' ? row.checkIn : row.date;
  if (!date || date < today) return true;
  const ageH = (now - Date.parse(row.capturedAt || 0)) / HOUR;
  return ageH > (row.dataSource === 'manual' ? AGE_LIMITS.manualHours : AGE_LIMITS.apiHours) * 7;
}

/** Upsert rows; also drops past-dated and long-stale rows. */
export function saveAwards(rows) {
  return updateJson(FILE(), [], existing => {
    const map = new Map(existing.filter(r => !expired(r)).map(r => [r.id, r]));
    for (const r of rows) map.set(r.id, r);
    return [...map.values()];
  });
}

/** Replace all API rows for a searched route/window so space that vanished is removed too. */
export function replaceApiAwards({ dataSource, origins, destinations, start, end, cabin }, rows) {
  const o = new Set(origins), d = new Set(destinations);
  return updateJson(FILE(), [], existing => {
    const kept = existing.filter(r => !expired(r) && !(r.dataSource === dataSource && r.product === 'flight' &&
      o.has(r.origin) && d.has(r.destination) && r.cabin === cabin && r.date >= start && r.date <= end));
    return [...kept, ...rows];
  });
}

export async function queryFlights({ origins, destinations, start, end, cabin }, now = Date.now()) {
  const o = new Set(origins), d = new Set(destinations);
  const today = todayISO();
  const rows = await readJson(FILE(), []);
  return rows
    .filter(r => r.product !== 'hotel')
    .map(r => (r.program && r.cabin && r.capturedAt ? r : normalizeFlightAward(r)))
    .filter(r => o.has(r.origin) && d.has(r.destination) && r.cabin === cabin && r.date >= start && r.date <= end && r.date >= today && r.mileageCost > 0)
    .map(r => {
      const ageHours = (now - Date.parse(r.capturedAt)) / HOUR;
      const limit = r.dataSource === 'manual' ? AGE_LIMITS.manualHours : AGE_LIMITS.apiHours;
      return { ...r, ageHours: Math.round(ageHours * 10) / 10, stale: ageHours > limit };
    })
    .filter(r => !r.stale);
}

export async function queryHotels({ destination, start, end }) {
  const q = String(destination || '').toLowerCase().trim();
  const today = todayISO();
  const rows = await readJson(FILE(), []);
  return rows
    .filter(r => r.product === 'hotel')
    .map(r => (r.capturedAt && r.program ? r : normalizeHotelAward(r)))
    .filter(r => r.checkIn >= today && r.checkIn >= start && r.checkIn <= end &&
      (!q || r.location.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)));
}
