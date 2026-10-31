import { between, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { airportMonthTraffic, airports } from "../db/schema.js";

export type AirportRow = typeof airports.$inferSelect;
export type AirportWithVolume = AirportRow & { passengers: number };

export async function findAirports(codes: string[]): Promise<AirportRow[]> {
  if (!codes.length) return [];
  return db.select().from(airports).where(inArray(airports.code, codes));
}

/** Airports with passenger traffic in the window, with their passenger volume (for resolution and region lists). */
export async function listAirportsWithTraffic(start: string, end: string): Promise<AirportWithVolume[]> {
  const rows = await db
    .select({ airport: airports, passengers: sql<number>`sum(${airportMonthTraffic.passengers})::float8` })
    .from(airports)
    .innerJoin(airportMonthTraffic, eq(airportMonthTraffic.code, airports.code))
    .where(between(airportMonthTraffic.month, start, end))
    .groupBy(airports.code)
    .having(sql`sum(${airportMonthTraffic.passengers}) > 0`);
  return rows.map((r) => ({ ...r.airport, passengers: r.passengers }));
}
