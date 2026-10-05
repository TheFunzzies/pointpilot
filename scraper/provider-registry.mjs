export const PROVIDERS = {
  american: {
    id: 'american',
    name: 'American Airlines AAdvantage',
    product: 'flight',
    mode: 'restricted',
    homepage: 'https://www.aa.com/booking/search/find-flights?awardBooking=true',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  united: {
    id: 'united',
    name: 'United MileagePlus',
    product: 'flight',
    mode: 'restricted',
    homepage: 'https://www.united.com/en/us/flights-search/book-a-flight',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  aeroplan: {
    id: 'aeroplan',
    name: 'Air Canada Aeroplan',
    product: 'flight',
    mode: 'restricted',
    homepage: 'https://www.aircanada.com/',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  flyingblue: {
    id: 'flyingblue',
    name: 'Air France-KLM Flying Blue',
    product: 'flight',
    mode: 'restricted',
    homepage: 'https://wwws.airfrance.us/',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  hyatt: {
    id: 'hyatt',
    name: 'World of Hyatt',
    product: 'hotel',
    mode: 'restricted',
    homepage: 'https://www.hyatt.com/',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  hilton: {
    id: 'hilton',
    name: 'Hilton Honors',
    product: 'hotel',
    mode: 'restricted',
    homepage: 'https://www.hilton.com/',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  marriott: {
    id: 'marriott',
    name: 'Marriott Bonvoy',
    product: 'hotel',
    mode: 'restricted',
    homepage: 'https://www.marriott.com/',
    notes: 'Direct automated collection is disabled by default; use an approved API/partnership or manual capture.'
  },
  demo_authorized: {
    id: 'demo_authorized',
    name: 'PointPilot Local Authorized Demo',
    product: 'flight',
    mode: 'authorized',
    homepage: 'http://localhost:3000/fixtures/awards.html',
    selectors: {
      result: '.award-card',
      origin: '[data-field="origin"]',
      destination: '[data-field="destination"]',
      date: '[data-field="date"]',
      program: '[data-field="program"]',
      cabin: '[data-field="cabin"]',
      points: '[data-field="points"]',
      taxes: '[data-field="taxes"]',
      seats: '[data-field="seats"]',
      airline: '[data-field="airline"]',
      flightNumbers: '[data-field="flightNumbers"]'
    }
  }
};

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, name: p.name, product: p.product, mode: p.mode,
    homepage: p.homepage, notes: p.notes || ''
  }));
}
