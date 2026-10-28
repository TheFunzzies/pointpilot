import { programId, programKind, programName } from './programs.mjs';
import { parseFiniteNumber } from './validate.mjs';

const badRequest = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_INPUT' }); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Estimate points to buy for the selected award legs. Only miles already in each airline
 * account reduce the buy quantity; transferable bank points are deliberately not counted. */
export function quotePointPurchases(input, { balances = [], offers = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!isObject(input) || Object.keys(input).some(key => !['legs', 'travelers'].includes(key))) badRequest('Choose the flights and traveler count for a purchase estimate.');
  if (!Array.isArray(input.legs) || input.legs.length < 1 || input.legs.length > 2) badRequest('A purchase estimate supports one or two award flights.');
  const travelers = parseFiniteNumber(input.travelers, { min: 1, max: 9, integer: true, name: 'travelers' });
  const needs = new Map();
  let taxesUsd = 0;
  let taxesComplete = true;
  for (const leg of input.legs) {
    if (!isObject(leg)) badRequest('Each selected flight must be an object.');
    const program = programId(leg.program || leg.source);
    if (!program || programKind(program) !== 'airline') badRequest('Each selected flight must use a supported airline points program.');
    const perTraveler = parseFiniteNumber(leg.mileageCost ?? leg.pointsPerTraveler, { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true, name: 'award points' });
    needs.set(program, (needs.get(program) || 0) + perTraveler * travelers);
    if (leg.totalTaxes == null) taxesComplete = false;
    else taxesUsd += parseFiniteNumber(leg.totalTaxes, { min: 0, max: 1000000, name: 'award taxes' }) * travelers;
  }
  const direct = new Map();
  for (const balance of balances) {
    const program = programId(balance.code || balance.program);
    if (program && programKind(program) === 'airline') direct.set(program, (direct.get(program) || 0) + Math.max(0, Number(balance.balance) || 0));
  }
  const activeOffer = new Map((Array.isArray(offers) ? offers : []).map(offer => [programId(offer.program), offer]));
  const byProgram = [...needs].map(([program, pointsNeeded]) => {
    const pointsOwned = direct.get(program) || 0;
    const pointsShort = Math.max(0, pointsNeeded - pointsOwned);
    const offer = activeOffer.get(program) || null;
    const expired = Boolean(offer?.offerEnds && offer.offerEnds < today);
    const pricePerPointCents = offer && !expired ? Number(offer.pricePerPointCents) : null;
    const minimum = Math.max(1, Number(offer?.minimumPurchase) || 1);
    const increment = Math.max(1, Number(offer?.purchaseIncrement) || 1);
    const pointsToBuy = pointsShort > 0 && pricePerPointCents != null
      ? Math.ceil(Math.max(pointsShort, minimum) / increment) * increment
      : 0;
    const purchaseCostUsd = pointsToBuy ? Math.round(pointsToBuy * pricePerPointCents) / 100 : null;
    return {
      program, programName: programName(program), pointsNeeded, pointsOwned,
      pointsShort, pointsToBuy, extraPoints: Math.max(0, pointsToBuy - pointsShort),
      pricePerPointCents, purchaseCostUsd, offerEnds: offer?.offerEnds || null,
      offerUrl: offer?.offerUrl || null, offerNotes: offer?.notes || '',
      status: !pointsShort ? 'covered' : !offer ? 'missing-offer' : expired ? 'expired' : 'priced'
    };
  });
  const priced = byProgram.filter(row => row.status === 'priced');
  return {
    travelers,
    taxesUsd: Math.round(taxesUsd * 100) / 100,
    taxesComplete,
    totalPointsNeeded: byProgram.reduce((sum, row) => sum + row.pointsNeeded, 0),
    totalPointsShort: byProgram.reduce((sum, row) => sum + row.pointsShort, 0),
    totalPointsToBuy: priced.reduce((sum, row) => sum + row.pointsToBuy, 0),
    purchaseCostUsd: byProgram.every(row => row.status === 'covered' || row.status === 'priced')
      ? Math.round(priced.reduce((sum, row) => sum + row.purchaseCostUsd, 0) * 100) / 100
      : null,
    byProgram
  };
}
