import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { airportScores, dataSources } from "../db/schema.js";
import { SCORING_MODEL } from "../services/scoring.js";

export type ScoreRow = typeof airportScores.$inferSelect;

/** All scores of the current model version, best first. The universe is small (~180 rows). */
export async function listScores(): Promise<ScoreRow[]> {
  return db
    .select()
    .from(airportScores)
    .where(eq(airportScores.scoreVersion, SCORING_MODEL.version))
    .orderBy(asc(airportScores.rank));
}

export async function listDataSources() {
  return db.select().from(dataSources);
}
