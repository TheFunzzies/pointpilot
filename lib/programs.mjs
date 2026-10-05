// Canonical loyalty-program IDs. Everything that enters PointPilot (manual entry, API
// results, wallet rows, transfer data) is normalized to these IDs so the optimizer can
// connect an award to the user's balances and to the transfer graph.
// IDs for airlines match seats.aero "Source" names where one exists.

export const PROGRAMS = {
  // Airlines
  aeroplan:       { name: 'Air Canada Aeroplan', kind: 'airline', aliases: ['air canada', 'ac'] },
  united:         { name: 'United MileagePlus', kind: 'airline', aliases: ['mileageplus', 'ua'] },
  american:       { name: 'American Airlines AAdvantage', kind: 'airline', aliases: ['aadvantage', 'american airlines', 'aa'] },
  alaska:         { name: 'Alaska Airlines Atmos Rewards', kind: 'airline', aliases: ['atmos', 'atmos rewards', 'alaska airlines', 'mileage plan', 'hawaiian', 'as'] },
  delta:          { name: 'Delta SkyMiles', kind: 'airline', aliases: ['skymiles', 'dl'] },
  flyingblue:     { name: 'Air France/KLM Flying Blue', kind: 'airline', aliases: ['flying blue', 'air france', 'klm', 'af', 'kl'] },
  ba:             { name: 'British Airways Executive Club', kind: 'airline', aliases: ['british airways', 'executive club', 'british'] },
  iberia:         { name: 'Iberia Plus', kind: 'airline', aliases: ['iberia plus', 'ib'] },
  aerlingus:      { name: 'Aer Lingus AerClub', kind: 'airline', aliases: ['aer lingus', 'aerclub', 'ei'] },
  qatar:          { name: 'Qatar Airways Privilege Club', kind: 'airline', aliases: ['privilege club', 'qatar airways', 'qr'] },
  lifemiles:      { name: 'Avianca LifeMiles', kind: 'airline', aliases: ['avianca', 'life miles', 'av'] },
  singapore:      { name: 'Singapore Airlines KrisFlyer', kind: 'airline', aliases: ['krisflyer', 'singapore airlines', 'sq'] },
  emirates:       { name: 'Emirates Skywards', kind: 'airline', aliases: ['skywards', 'ek'] },
  etihad:         { name: 'Etihad Guest', kind: 'airline', aliases: ['etihad guest', 'ey'] },
  virginatlantic: { name: 'Virgin Atlantic Flying Club', kind: 'airline', aliases: ['virgin atlantic', 'flying club', 'vs'] },
  cathay:         { name: 'Cathay Pacific Asia Miles', kind: 'airline', aliases: ['cathay pacific', 'asia miles', 'cx'] },
  jetblue:        { name: 'JetBlue TrueBlue', kind: 'airline', aliases: ['trueblue', 'b6'] },
  turkish:        { name: 'Turkish Airlines Miles&Smiles', kind: 'airline', aliases: ['turkish airlines', 'miles&smiles', 'miles and smiles', 'tk'] },
  ana:            { name: 'ANA Mileage Club', kind: 'airline', aliases: ['ana mileage club', 'all nippon', 'nh'] },
  jal:            { name: 'Japan Airlines Mileage Bank', kind: 'airline', aliases: ['japan airlines', 'mileage bank', 'jl'] },
  qantas:         { name: 'Qantas Frequent Flyer', kind: 'airline', aliases: ['qantas frequent flyer', 'qf'] },
  eva:            { name: 'EVA Air Infinity MileageLands', kind: 'airline', aliases: ['eva air', 'infinity mileagelands', 'br'] },
  thai:           { name: 'Thai Airways Royal Orchid Plus', kind: 'airline', aliases: ['thai airways', 'royal orchid plus', 'tg'] },
  southwest:      { name: 'Southwest Rapid Rewards', kind: 'airline', aliases: ['rapid rewards', 'wn'] },
  aeromexico:     { name: 'Aeromexico Rewards', kind: 'airline', aliases: ['club premier', 'aeromexico rewards', 'am'] },
  smiles:         { name: 'GOL Smiles', kind: 'airline', aliases: ['gol', 'gol smiles'] },
  azul:           { name: 'Azul Fidelidade', kind: 'airline', aliases: ['tudoazul', 'azul fidelidade'] },
  velocity:       { name: 'Virgin Australia Velocity', kind: 'airline', aliases: ['virgin australia', 'va'] },
  eurobonus:      { name: 'SAS EuroBonus', kind: 'airline', aliases: ['sas', 'sk'] },
  connectmiles:   { name: 'Copa ConnectMiles', kind: 'airline', aliases: ['copa', 'cm'] },
  ethiopian:      { name: 'Ethiopian ShebaMiles', kind: 'airline', aliases: ['shebamiles', 'et'] },
  saudia:         { name: 'Saudia AlFursan', kind: 'airline', aliases: ['alfursan', 'sv'] },
  finnair:        { name: 'Finnair Plus', kind: 'airline', aliases: ['finnair plus', 'ay'] },
  // Hotels
  hyatt:    { name: 'World of Hyatt', kind: 'hotel', aliases: ['world of hyatt'] },
  hilton:   { name: 'Hilton Honors', kind: 'hotel', aliases: ['hilton honors'] },
  marriott: { name: 'Marriott Bonvoy', kind: 'hotel', aliases: ['bonvoy', 'marriott bonvoy'] },
  ihg:      { name: 'IHG One Rewards', kind: 'hotel', aliases: ['ihg one rewards', 'intercontinental'] },
  choice:   { name: 'Choice Privileges', kind: 'hotel', aliases: ['choice privileges'] },
  wyndham:  { name: 'Wyndham Rewards', kind: 'hotel', aliases: ['wyndham rewards'] },
  accor:    { name: 'Accor Live Limitless', kind: 'hotel', aliases: ['accor live limitless'] },
  // Bank / flexible currencies
  amex:       { name: 'American Express Membership Rewards', kind: 'bank', aliases: ['amex mr', 'membership rewards', 'american express'] },
  chase:      { name: 'Chase Ultimate Rewards', kind: 'bank', aliases: ['chase ur', 'ultimate rewards'] },
  citi:       { name: 'Citi ThankYou', kind: 'bank', aliases: ['thankyou', 'citi thankyou'] },
  capitalone: { name: 'Capital One Miles', kind: 'bank', aliases: ['capital one', 'c1', 'venture'] },
  bilt:       { name: 'Bilt Rewards', kind: 'bank', aliases: ['bilt rewards'] },
  wellsfargo: { name: 'Wells Fargo Rewards', kind: 'bank', aliases: ['wells fargo', 'wf'] },
  brex:       { name: 'Brex Rewards', kind: 'bank', aliases: [] },
  ramp:       { name: 'Ramp Rewards', kind: 'bank', aliases: [] }
};

const key = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

const LOOKUP = new Map();
for (const [id, p] of Object.entries(PROGRAMS)) {
  for (const alias of [id, p.name, ...p.aliases]) LOOKUP.set(key(alias), id);
  LOOKUP.set(key(id).replace(/ /g, ''), id);
}

/** Map any user/API spelling ("Aeroplan", "Air Canada", "AC", "flying blue") to a canonical ID, or null. */
export function programId(input) {
  const k = key(input);
  if (!k) return null;
  return LOOKUP.get(k) ?? LOOKUP.get(k.replace(/ /g, '')) ?? null;
}

export function programName(id) { return PROGRAMS[id]?.name || id; }
export function programKind(id) { return PROGRAMS[id]?.kind || null; }

export function listPrograms(kind) {
  return Object.entries(PROGRAMS)
    .filter(([, p]) => !kind || p.kind === kind)
    .map(([id, p]) => ({ id, name: p.name, kind: p.kind }));
}

const CABINS = {
  economy: 'economy', y: 'economy', coach: 'economy', main: 'economy', 'main cabin': 'economy',
  premium: 'premium', w: 'premium', 'premium economy': 'premium', premiumeconomy: 'premium',
  business: 'business', j: 'business', c: 'business',
  first: 'first', f: 'first'
};
export function normalizeCabin(c) { return CABINS[key(c)] || null; }
export const CABIN_CODES = { economy: 'Y', premium: 'W', business: 'J', first: 'F' };
