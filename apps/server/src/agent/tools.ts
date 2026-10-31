import { z } from "zod";
import {
  ToolInputError,
  compareAirports,
  getAirportProfile,
  getLiveStatusForLocation,
  getLongHaulShare,
  getMethodology,
  getUnmetDemandSignals,
  rankAirports,
  resolveAirport,
} from "../services/airport-analytics.js";
import { getNationwideLiveDelays } from "../services/live-status.js";
import { toolSchemas } from "./tool-schemas.js";

type Tool<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>) => Promise<unknown>;
};
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

export const TOOLS = [
  tool({
    name: "resolve_airport",
    description:
      "Map what the user typed (city, nickname, airport name, or code, e.g. 'LA', 'Santa Ana', 'John Wayne') to an IATA code. Call this before any other airport tool unless you already have a confirmed code. Returns alternatives and an ambiguity flag.",
    schema: toolSchemas.resolve_airport,
    handler: ({ query }) => resolveAirport(query),
  }),
  tool({
    name: "get_airport_profile",
    description:
      "12-month traffic (passengers, seats, load factor, growth, international share, freight), operations (delays, NAS delay, taxi times, cancellations, peak hour) and the opportunity score breakdown for one airport.",
    schema: toolSchemas.get_airport_profile,
    handler: ({ code }) => getAirportProfile(code),
  }),
  tool({
    name: "compare_airports",
    description:
      "Side-by-side traffic, operational congestion metrics (with percentile benchmarks against other airports) and opportunity scores for 2-6 airports. Use for 'compare X and Y' and congestion questions.",
    schema: toolSchemas.compare_airports,
    handler: ({ codes }) => compareAirports(codes),
  }),
  tool({
    name: "rank_airports",
    description:
      "Rank airports by the Terminal Expansion Opportunity Screening Score (or by one component), optionally within a region: a Census division ('New England'), Census region ('Northeast', 'Midwest', 'South', 'West'), a state ('Texas', 'TX'), or an informal/directional area ('north', 'east', 'east coast', 'west coast', 'gulf coast', 'southeast', 'southwest', 'northwest'). Pass the user's wording; the result includes the states used and the definition, which you must state for informal areas. Use for 'which airports are strong candidates' and 'best airport to invest in' questions.",
    schema: toolSchemas.rank_airports,
    handler: (args) => rankAirports(args),
  }),
  tool({
    name: "get_long_haul_share",
    description:
      "Share of an airport's departures that are long-haul, with the full distance distribution, plus international share and average distance from T-100. thresholdMiles must be an integer multiple of 250 between 250 and 2500 (BTS 250-mile distance bands); omit it for the 2500-mile default. State the definition you used.",
    schema: toolSchemas.get_long_haul_share,
    handler: ({ code, thresholdMiles }) => getLongHaulShare(code, thresholdMiles),
  }),
  tool({
    name: "get_unmet_demand_signals",
    description:
      "Indirect, rule-based signals of unmet demand for one airport (load factor, demand vs seat growth, NAS delay, arrival delays, schedule peaking), each benchmarked against other airports, with what each signal does and does not show.",
    schema: toolSchemas.get_unmet_demand_signals,
    handler: ({ code }) => getUnmetDemandSignals(code),
  }),
  tool({
    name: "get_live_airport_status",
    description:
      "Real-time FAA NAS status for a location. Pass the place as the user named it: an IATA code checks only that airport; a city or metro name ('LA', 'NYC') checks every commercial airport serving the area (do not call resolve_airport first). Returns a status per airport: delay_program_active, no_active_program_reported, data_unavailable, or request_failed, plus programs, restrictions, warnings and what the data cannot show. For all US airports use get_live_delays_nationwide. Context for 'right now' questions only.",
    schema: toolSchemas.get_live_airport_status,
    handler: ({ location }) => getLiveStatusForLocation(location),
  }),
  tool({
    name: "get_live_delays_nationwide",
    description:
      "Real-time FAA NAS status for ALL US airports in one call: every airport with an active ground stop, ground delay program, or arrival/departure delay, most severe first, plus closure notices. Use for 'which airport has the most delays now/today' questions; never ask the user to pick airports for this. FAA reports average delay minutes per program, not counts of delayed flights.",
    schema: toolSchemas.get_live_delays_nationwide,
    handler: ({ limit }) => getNationwideLiveDelays(limit),
  }),
  tool({
    name: "get_methodology",
    description:
      "How the opportunity score works (weights, percentile method, coverage levels), its limitations, the analysis period, and the data sources with their dates. Use when the user asks how scores are computed or where data comes from.",
    schema: toolSchemas.get_methodology,
    handler: () => getMethodology(),
  }),
];

export type ToolName = (typeof TOOLS)[number]["name"];

/**
 * OpenAI function-tool definitions generated from the zod schemas. Not `strict`: strict mode requires
 * every property to be required, which conflicts with optional arguments. Constraints in the JSON
 * Schema (min/max/multipleOf) are therefore guidance for the model; runTool enforces them.
 */
export const toolDefinitions = TOOLS.map((t) => {
  const { $schema: _, ...parameters } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  return { type: "function" as const, name: t.name, description: t.description, parameters, strict: false };
});

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Validates arguments and runs a tool. Errors come back as data so the model can recover (e.g. resolve a code first). */
export async function runTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { ok: false, error: `Unknown tool "${name}".` };
  const parsed = t.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${z.prettifyError(parsed.error)}` };
  try {
    return { ok: true, data: await (t.handler as (a: unknown) => Promise<unknown>)(parsed.data) };
  } catch (err) {
    if (err instanceof ToolInputError) return { ok: false, error: err.message };
    throw err;
  }
}
