import { between, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { airportMonthOps, airportMonthTraffic, airportScores } from "../db/schema.js";
import { SCORING_MODEL, scoreAirports, type AirportScoringInput } from "../services/scoring.js";
import { upsertBatched } from "./lib/db-helpers.js";
import { addMonths } from "./lib/months.js";

/** Scores every airport over the 12 months ending `end` and stores the result. */
export async function computeScores(end: string): Promise<number> {
  const start = addMonths(end, -11);
  const priorStart = addMonths(end, -23);
  const priorEnd = addMonths(end, -12);

  const traffic = await db
    .select({
      code: airportMonthTraffic.code,
      passengers: sql<number>`sum(${airportMonthTraffic.passengers})::float8`,
      seats: sql<number>`sum(${airportMonthTraffic.seats})::float8`,
    })
    .from(airportMonthTraffic)
    .where(between(airportMonthTraffic.month, start, end))
    .groupBy(airportMonthTraffic.code);

  const prior = await db
    .select({
      code: airportMonthTraffic.code,
      passengers: sql<number>`sum(${airportMonthTraffic.passengers})::float8`,
      months: sql<number>`count(*)::int`,
    })
    .from(airportMonthTraffic)
    .where(between(airportMonthTraffic.month, priorStart, priorEnd))
    .groupBy(airportMonthTraffic.code);

  const o = airportMonthOps;
  const ops = await db
    .select({
      code: o.code,
      arrivals: sql<number>`sum(${o.arrFlights})::float8`,
      arrDelayed15: sql<number>`sum(${o.arrDelayed15})::float8`,
      nasDelayMinutes: sql<number>`sum(${o.nasDelayMinutes})::float8`,
      taxiOutMinutes: sql<number>`sum(${o.taxiOutMinutes})::float8`,
      taxiOutCount: sql<number>`sum(${o.taxiOutCount})::float8`,
      depScheduled: sql<number>`sum(${o.depScheduled})::float8`,
      depCancelled: sql<number>`sum(${o.depCancelled})::float8`,
    })
    .from(o)
    .where(between(o.month, start, end))
    .groupBy(o.code);

  // Growth is only comparable when the prior year is complete.
  const priorByCode = new Map(prior.filter((p) => p.months === 12).map((p) => [p.code, p.passengers]));
  const opsByCode = new Map(ops.map(({ code, ...rest }) => [code, rest]));

  const inputs: AirportScoringInput[] = traffic.map((t) => ({
    code: t.code,
    passengers: t.passengers,
    seats: t.seats,
    passengersPrior: priorByCode.get(t.code) ?? null,
    ops: opsByCode.get(t.code) ?? null,
  }));

  const scores = scoreAirports(inputs);
  const computedAt = new Date();
  // Replace the whole version so airports that dropped out of the universe don't linger.
  await db.delete(airportScores).where(eq(airportScores.scoreVersion, SCORING_MODEL.version));
  await upsertBatched(
    airportScores,
    scores.map((s) => ({ ...s, scoreVersion: SCORING_MODEL.version, periodStart: start, periodEnd: end, computedAt })),
    [airportScores.code, airportScores.scoreVersion],
  );
  return scores.length;
}
