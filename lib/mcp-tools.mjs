import { z } from 'zod';
import { searchTrip } from './search.mjs';
import { searchDestinations } from './destinations.mjs';
import { loadUser } from './settings.mjs';

const airportList = z.string().trim().min(3).max(1000);
const destination = z.string().trim().min(2).max(160);
const cabin = z.enum(['economy', 'premium', 'business', 'first']).default('business');
const commonSearch = {
  origins: airportList.describe('Origin cities or airport codes, comma separated.'),
  departDate: z.string().date().describe('Outbound departure date (YYYY-MM-DD).'),
  returnDate: z.string().date().optional().describe('Optional return date (YYYY-MM-DD).'),
  flexDays: z.number().int().min(0).max(14).default(0),
  cabin,
  travelers: z.number().int().min(1).max(9).default(1),
  nonstopOnly: z.boolean().default(false),
  preserveFlexible: z.boolean().default(true),
  rank: z.enum(['overall', 'points', 'fees', 'stops', 'cpp', 'nonstop', 'seat', 'duration']).default('overall')
};

const safeTrip = trip => ({
  destination: trip.destination,
  travelers: trip.travelers,
  totalSourcePoints: trip.totalSourcePoints,
  totalTargetPoints: trip.totalTargetPoints,
  taxesUsd: trip.taxesUsd,
  effectiveCostUsd: trip.effectiveCostUsd,
  cpp: trip.cpp,
  affordable: trip.affordable,
  fundingStatus: trip.fundingStatus,
  funding: trip.funding,
  legs: (trip.legs || []).map(leg => ({
    origin: leg.origin, destination: leg.destination, date: leg.date, program: leg.program,
    mileageCost: leg.mileageCost, totalTaxes: leg.totalTaxes, stops: leg.stops,
    totalDurationMin: leg.totalDurationMin, flightNumbers: leg.flightNumbers,
    operatingAirline: leg.operatingAirline, cabin: leg.cabin
  })),
  warnings: trip.warnings || []
});

function limitText(data) {
  const text = JSON.stringify(data);
  return text.length > 180_000 ? JSON.stringify({ truncated: true, preview: text.slice(0, 180_000) }) : text;
}

export const POINTPILOT_TOOLS = [
  {
    name: 'pointpilot_wallet',
    description: 'Read the saved balances by loyalty program. Balances are separate currencies and must not be added together as spendable points.',
    inputSchema: z.object({}),
    run: async (_args, deps = {}) => {
      const user = await (deps.loadUser || loadUser)();
      return { balances: user.balances.map(({ program, code, type, balance, cpp }) => ({ program, code, type, balance, cpp })), preferences: user.preferences };
    }
  },
  {
    name: 'pointpilot_search_cached_awards',
    description: 'Search saved/cached award inventory only. This never makes provider API calls. Results may be stale or incomplete; respect the returned freshness and warning fields.',
    inputSchema: z.object({ ...commonSearch, destination }),
    run: async (args, deps = {}) => {
      const result = await (deps.search || searchTrip)(args, { allowApi: false });
      return {
        mode: result.mode,
        query: result.query,
        freshness: result.dataStatus,
        warnings: result.dataStatus?.warnings || [],
        trips: (result.trips || []).slice(0, 10).map(safeTrip),
        truncation: result.truncation
      };
    }
  },
  {
    name: 'pointpilot_compare_destinations_cached',
    description: 'Compare up to eight destinations using saved/cached award inventory only. Each result is an alternative using the full saved wallet; points are not reserved. This never makes provider API calls.',
    inputSchema: z.object({ ...commonSearch, destinations: z.array(destination).min(1).max(8) }),
    run: async (args, deps = {}) => {
      const response = await (deps.searchDestinations || searchDestinations)(args, { allowApi: false });
      return {
        warnings: response.warnings,
        results: response.results.map(entry => ({
          destination: entry.destination,
          error: entry.error,
          mode: entry.result?.mode,
          freshness: entry.result?.dataStatus,
          warnings: entry.result?.dataStatus?.warnings || [],
          trips: (entry.result?.trips || []).slice(0, 3).map(safeTrip)
        }))
      };
    }
  }
];

export async function runPointPilotTool(name, args, deps) {
  const tool = POINTPILOT_TOOLS.find(item => item.name === name);
  if (!tool) throw new Error('Unknown PointPilot tool.');
  const input = tool.inputSchema.parse(args ?? {});
  return limitText(await tool.run(input, deps));
}
