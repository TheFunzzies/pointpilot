function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function numberFromText(s) {
  const m = clean(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

export function normalizeAward(raw, providerId) {
  const points = numberFromText(raw.points);
  const taxes = numberFromText(raw.taxes);
  const seats = numberFromText(raw.seats);
  return {
    id: `${providerId}-${clean(raw.date)}-${clean(raw.origin)}-${clean(raw.destination)}-${clean(raw.program)}-${points}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    dataSource: `direct:${providerId}`,
    provider: providerId,
    source: providerId,
    product: raw.product || 'flight',
    origin: clean(raw.origin).toUpperCase(),
    destination: clean(raw.destination).toUpperCase(),
    date: clean(raw.date),
    program: clean(raw.program),
    cabin: clean(raw.cabin) || 'unknown',
    mileageCost: points,
    totalTaxes: taxes,
    remainingSeats: seats || null,
    airlines: clean(raw.airline),
    flightNumbers: clean(raw.flightNumbers),
    direct: Boolean(raw.direct),
    capturedAt: new Date().toISOString()
  };
}

export function normalizeHotel(raw, providerId) {
  const points = numberFromText(raw.nightlyPoints);
  const cash = numberFromText(raw.cashValue);
  return {
    id: `${providerId}-${clean(raw.checkIn)}-${clean(raw.name)}-${points}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    dataSource: `direct:${providerId}`,
    provider: providerId,
    source: providerId,
    product: 'hotel',
    name: clean(raw.name),
    location: clean(raw.location),
    program: clean(raw.program),
    checkIn: clean(raw.checkIn),
    nightlyPoints: points,
    cashValue: cash,
    cpp: points && cash ? (cash / points) * 100 : null,
    capturedAt: new Date().toISOString()
  };
}
