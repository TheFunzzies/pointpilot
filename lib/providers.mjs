// Booking sites the user can open in PointPilot's capture browser to search manually.
// PointPilot never automates these sites; the user searches, then records what they saw.
import { programName } from './programs.mjs';

const SITES = [
  ['aeroplan', 'flight', 'https://www.aircanada.com/aeroplan/redeem/'],
  ['united', 'flight', 'https://www.united.com/en/us/book-flight/united-reservations'],
  ['american', 'flight', 'https://www.aa.com/booking/search/find-flights?awardBooking=true'],
  ['alaska', 'flight', 'https://www.alaskaair.com/'],
  ['delta', 'flight', 'https://www.delta.com/'],
  ['flyingblue', 'flight', 'https://wwws.airfrance.us/'],
  ['ba', 'flight', 'https://www.britishairways.com/'],
  ['qatar', 'flight', 'https://www.qatarairways.com/en-us/Privilege-Club/'],
  ['singapore', 'flight', 'https://www.singaporeair.com/en_UK/us/ppsclub-krisflyer/'],
  ['virginatlantic', 'flight', 'https://www.virginatlantic.com/'],
  ['lifemiles', 'flight', 'https://www.lifemiles.com/'],
  ['cathay', 'flight', 'https://www.cathaypacific.com/'],
  ['hyatt', 'hotel', 'https://www.hyatt.com/'],
  ['hilton', 'hotel', 'https://www.hilton.com/'],
  ['marriott', 'hotel', 'https://www.marriott.com/'],
  ['ihg', 'hotel', 'https://www.ihg.com/']
];

export function listProviders() {
  return SITES.map(([id, product, homepage]) => ({ id, name: programName(id), product, homepage }));
}

export function providerUrlAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SITES.some(([, , home]) => new URL(home).hostname.split('.').slice(-2).join('.') === u.hostname.split('.').slice(-2).join('.'));
  } catch { return false; }
}
