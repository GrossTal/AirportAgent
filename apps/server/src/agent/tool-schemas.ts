/**
 * Argument schemas for the agent's tools. Kept free of database imports so they can be unit-tested
 * and converted to the JSON Schema sent to OpenAI. They are also the runtime validation in runTool.
 */
import { z } from "zod";

export const DISTANCE_BAND_MILES = 250; // BTS DistanceGroup width
export const DEFAULT_LONG_HAUL_MILES = 2500; // largest BTS band ("2,500 miles and over")

const code = z.string().regex(/^[A-Za-z0-9]{3}$/).transform((s) => s.toUpperCase()).describe("IATA airport code, e.g. SFO");

export const toolSchemas = {
  resolve_airport: z.object({ query: z.string().min(1).describe("Airport, city or nickname as the user wrote it") }),
  get_airport_profile: z.object({ code }),
  compare_airports: z.object({ codes: z.array(code).min(2).max(6) }),
  rank_airports: z.object({
    region: z.string().optional().describe("Region, division or state; omit for the whole US"),
    limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
    sortBy: z.enum(["score", "scale", "growth", "demandPressure", "congestion"]).optional().describe("Default 'score'"),
  }),
  get_long_haul_share: z.object({
    code,
    // multipleOf is expressible in JSON Schema, so the restriction also appears in the OpenAI tool definition.
    thresholdMiles: z
      .number()
      .int()
      .min(DISTANCE_BAND_MILES)
      .max(DEFAULT_LONG_HAUL_MILES)
      .multipleOf(DISTANCE_BAND_MILES, { message: `Must be a multiple of ${DISTANCE_BAND_MILES}` })
      .optional()
      .describe("Integer multiple of 250 between 250 and 2500 (BTS distance bands). Default 2500."),
  }),
  get_unmet_demand_signals: z.object({ code }),
  get_live_airport_status: z.object({
    location: z
      .string()
      .min(1)
      .describe("The place exactly as the user named it: an IATA code ('LAX'), a city or metro ('LA', 'NYC', 'Chicago'), or an airport name"),
  }),
  get_live_delays_nationwide: z.object({
    limit: z.number().int().min(1).max(30).optional().describe("How many airports to return, most severe first. Default 15."),
  }),
  get_methodology: z.object({}),
};
